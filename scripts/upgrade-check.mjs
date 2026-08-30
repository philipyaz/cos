#!/usr/bin/env node
// scripts/upgrade-check.mjs — "what does THIS pull change for THIS machine?"
//
// A deterministic, key-free planner for upgrading an EXISTING Cos install. Given a git
// range (the commit this machine was running → the commit it just pulled), it derives
// the ordered post-pull checklist from the paths that changed, the service manifest,
// and read-only reads of the live store / config — and prints it as a checklist
// (default) or JSON (--json). It never mutates anything: it does not pull, install,
// restart, or write. The `cos-upgrade` skill runs it and applies the [auto] steps.
//
//   node scripts/upgrade-check.mjs                    # from = ORIG_HEAD (right after `git pull`), else the
//                                                     # commit the production board was built from
//   node scripts/upgrade-check.mjs --from v0.1.0      # any ref; --to defaults to HEAD
//   node scripts/upgrade-check.mjs --json             # machine-readable (the skill consumes this)
//   node scripts/upgrade-check.mjs --strict           # exit 2 on a BLOCKER (e.g. the store is NEWER than the code)
//
// Why this exists: after a pull, the store migrates itself (migrate-on-read, fail-closed the
// other way — docs/reference/migration.md), but NOTHING ELSE does — the production board keeps
// serving the old build until the boardapp LaunchAgent is kickstarted, a launchd bridge keeps its
// long-lived stdio child on the old server code, Cowork keeps the skill bundle it was given at
// upload time, and a new scheduled trigger in automation.json runs nowhere until someone creates
// it. Each of those is a silent no-op, not an error. This script turns the diff into the list.
//
// Cowork cannot be read back (ADR 0020), so bundle drift is made COMPUTABLE by a local receipt:
// `scripts/mark-skill-uploaded.mjs` records the sha256 of each zip you uploaded into
// mcp/logs/.cowork-skills-uploaded.json (gitignored, per machine); when the receipt exists the
// upload list is "every zip whose hash differs from its receipt", regardless of how many pulls ago
// it changed. Without a receipt the list falls back to the git range.
//
// Mapping (path → step) is the manifest's, not a hardcoded table: a bridge's source dir comes
// from its descriptor's `stdio` command, a uvicorn sidecar's from `dir`, an exec runner's from
// `exec`. Only the two repo-shaped rules live here: any change under board/ (outside .claude/
// and data/) means the board must be rebuilt, and any change under packages/mcp-kit/ means every
// bridge must restart (they all embed it).
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCRIPT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

/** `export const SCHEMA_VERSION = 15;` → 15 (null when absent). */
export function parseSchemaVersion(typesSource) {
  const m = /export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)/.exec(typesSource || "");
  return m ? Number(m[1]) : null;
}

/** The KEY=... names declared in an env(.example) file, in order of first appearance. */
export function envKeys(text) {
  const keys = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/** Keys present in `after` but not in `before`, minus those already set in `live`. */
export function newEnvKeys(beforeText, afterText, liveText) {
  const before = new Set(envKeys(beforeText));
  const live = new Set(envKeys(liveText));
  return envKeys(afterText).filter((k) => !before.has(k) && !live.has(k));
}

/**
 * automation.json at two refs → the scheduled triggers that are new or changed.
 * A trigger is identified by its `trigger` string; a cadence or class change on the same
 * trigger is "changed" (the Cowork scheduled task has to be edited, not just created).
 */
export function diffAutomation(beforeJson, afterJson) {
  const parse = (t) => {
    try { return t ? JSON.parse(t) : {}; } catch { return {}; }
  };
  const before = parse(beforeJson);
  const after = parse(afterJson);
  const flat = (obj) => {
    const out = new Map();
    for (const [skill, spec] of Object.entries(obj || {})) {
      for (const s of spec?.schedules || []) {
        if (s && typeof s.trigger === "string") out.set(s.trigger, { skill, cadence: s.cadence ?? null, cls: spec.class ?? null });
      }
    }
    return out;
  };
  const b = flat(before);
  const a = flat(after);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [trigger, spec] of a) {
    const prev = b.get(trigger);
    if (!prev) added.push({ trigger, ...spec });
    else if (prev.cadence !== spec.cadence || prev.cls !== spec.cls) changed.push({ trigger, ...spec, was: prev });
  }
  for (const [trigger, spec] of b) if (!a.has(trigger)) removed.push({ trigger, ...spec });
  return { added, changed, removed };
}

/** Repo-relative dir a manifest entry's SOURCE lives in (null when it is outside the repo). */
export function entrySourceDir(entry, repoRoot) {
  const candidates = [];
  if (Array.isArray(entry.stdio)) candidates.push(...entry.stdio.slice(1));
  if (entry.dir) candidates.push(entry.dir);
  if (Array.isArray(entry.exec)) candidates.push(...entry.exec);
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const abs = path.resolve(c);
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    // a file → its directory; a dir → itself
    const dir = /\.(mjs|cjs|js|py|sh)$/.test(rel) ? path.dirname(rel) : rel;
    return dir.split(path.sep).join("/");
  }
  return null;
}

/** MCP tool names declared in a server source (`name: "tool_name"` at the start of a line). */
export function parseToolNames(source) {
  const out = new Set();
  for (const m of (source || "").matchAll(/^\s*\{?\s*name:\s*"([a-z][a-z0-9_]*)"/gm)) out.add(m[1]);
  return [...out].sort();
}

const under = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
const any = (paths, pred) => paths.some(pred);

/**
 * The planner. Pure: every input is data; the CLI gathers it. Returns ordered steps.
 * @param {object} i
 * @param {string[]} i.changedPaths   repo-relative paths changed in from..to
 * @param {number|null} i.fromSchema  SCHEMA_VERSION at `from`
 * @param {number|null} i.toSchema    SCHEMA_VERSION at `to`
 * @param {number|null} i.storeSchema the live store's on-disk schemaVersion (null: no store here)
 * @param {'hub'|'spoke'} i.role
 * @param {Array} i.manifest          resolved service entries (name, kind, label, stdio/dir/exec, roles, schedule)
 * @param {Set<string>} i.installedLabels  launchd labels whose plist is installed on this machine
 * @param {string[]} i.changedBundles  board/.claude/skill-bundles/*.zip paths that changed
 * @param {object} i.automation       {added, changed, removed} from diffAutomation
 * @param {string[]} i.newCosEnvKeys   keys added to cos.env.example and missing from the live cos.env
 * @param {string[]} i.newSecretKeys   keys added to secrets.env.example and missing from the live secrets.env
 * @param {string} i.repoRoot
 * @param {number|null} [i.uid]
 * @param {string[]} [i.addonsEnabled]   add-on ids enabled in the live store's settings (hub)
 * @param {Object<string,{added:string[],removed:string[]}>} [i.toolDelta]  per server name, tools gained/lost in the range
 * @param {Object<string,string>|null} [i.receipt]  skill → sha256 of the zip last marked uploaded (null: no receipt)
 * @param {Object<string,string>} [i.bundleHashes]  zip path → sha256 at `to`
 */
export function planUpgrade(i) {
  const P = i.changedPaths;
  const steps = [];
  const uid = i.uid ?? "$(id -u)";
  const kick = (label) => `launchctl kickstart -k gui/${uid}/${label}`;
  const isHub = i.role !== "spoke";
  const push = (s) => steps.push(s);

  // 0. Nothing changed at all.
  if (P.length === 0) {
    return { steps: [], blockers: [], summary: "no changes in range — nothing to do." };
  }

  const boardChanged = any(P, (p) => under(p, "board") && !under(p, "board/.claude") && !under(p, "board/data"));
  const storeCodeChanged = any(P, (p) => p === "board/lib/store.ts" || p === "board/lib/types.ts");
  const schemaBump = i.fromSchema != null && i.toSchema != null && i.toSchema > i.fromSchema;
  const blockers = [];

  // 1. Schema safety FIRST — the one irreversible direction.
  if (i.storeSchema != null && i.toSchema != null && i.storeSchema > i.toSchema) {
    blockers.push(
      `the live store is schemaVersion ${i.storeSchema} but the code you are moving to is SCHEMA_VERSION ${i.toSchema}: ` +
        `that is a DOWNGRADE. A board older than its store refuses every write (SchemaAheadError → 503) and would ` +
        `silently drop the newer collections if it could write. Move to a commit whose SCHEMA_VERSION ≥ ${i.storeSchema}.`,
    );
  }

  // 2. Backup before anything touches the store (hub only; a spoke has no store).
  if (isHub && (schemaBump || storeCodeChanged || boardChanged)) {
    const backupInstalled = i.installedLabels.has("com.chiefofstaff.backup");
    push({
      id: "backup",
      kind: backupInstalled ? "auto" : "manual",
      appliesTo: "hub",
      title: "Take an on-demand backup before the store is touched",
      command: backupInstalled ? "node backup/backup.mjs" : null,
      why: schemaBump
        ? `the store will migrate ${i.storeSchema ?? i.fromSchema} → ${i.toSchema} on the first read after the restart; the snapshot is the only way back to the pre-upgrade shape`
        : "board code changed; a pre-upgrade snapshot is the rollback point",
      manual: backupInstalled ? null : "backup-recovery is not set up on this machine — copy board/data/cases.json somewhere safe by hand (or run /backup-recovery first).",
      paths: [],
    });
  }

  // 2b. Pause the scheduled routines for the window (hub): a sweep that fires while the board is
  //     rebuilding, or that runs an OLD bundle against a NEW API, fails halfway after writing.
  const lockChanged = P.includes("package-lock.json") || P.includes("package.json") || P.includes("board/package-lock.json") || P.includes("board/package.json");
  const cowarkSurfaceChanged = i.changedBundles.length > 0 || P.includes("board/.claude/skills/automation.json") || any(P, (p) => under(p, "board/app/api"));
  const boardappInstalled = i.installedLabels.has("com.chiefofstaff.mcp-boardapp");
  if (isHub && (boardChanged || cowarkSurfaceChanged)) {
    push({
      id: "pause-routines",
      kind: "manual",
      appliesTo: "hub",
      title: "Pause the Cowork scheduled tasks for the upgrade window",
      manual: "Cowork → Scheduled Tasks → pause every Cos task; resume them at the end (the last step reminds you). A sweep that fires mid-rebuild, or runs last month's bundle against the new API, fails halfway — after it has already written something.",
      why: boardChanged ? "the board is about to be rebuilt" : "the skill bundles / scheduled catalog / API changed",
      paths: [],
    });
  }

  // 2c. Freeze the production board BEFORE deps + build (hub with boardapp): no write lands between
  //     the snapshot and the new code, `npm install` never runs under a live `next start`, and a
  //     build attempted before deps land cannot poison .next/COS_BUILD_FAILED for this commit.
  if (isHub && boardappInstalled && (boardChanged || lockChanged)) {
    push({
      id: "board-stop",
      kind: "auto",
      appliesTo: "hub",
      title: "Stop the production board (freeze) before installing or building anything",
      command: `launchctl bootout gui/${uid}/com.chiefofstaff.mcp-boardapp 2>/dev/null; true`,
      why: "the boardapp LaunchAgent is KeepAlive — bootout is the only clean stop; tailscale serve 502s until the board is back (expected). Also quit any hand-run `next dev` on the board port.",
      paths: [],
    });
  }

  // 3. Dependencies.
  if (P.includes("package-lock.json") || P.includes("package.json")) {
    push({ id: "deps-root", kind: "auto", appliesTo: "both", title: "Install root workspace deps (the mcp/*-server packages)", command: "npm install", why: "package-lock.json changed", paths: ["package-lock.json"] });
  }
  if (P.includes("board/package-lock.json") || P.includes("board/package.json")) {
    push({ id: "deps-board", kind: "auto", appliesTo: "hub", title: "Install board deps", command: "(cd board && npm install)", why: "board/package-lock.json changed", paths: ["board/package-lock.json"] });
  }

  // 4. Service definitions changed → re-render + reload every plist (supersedes per-service kicks).
  const serviceDefPaths = ["mcp/service-manifest.mjs", "scripts/gen-launchd.mjs", "scripts/loopback-bind.cjs", "scripts/boardapp-run.mjs", "mcp/ensure-bridges.sh", "mcp/ensure-bridges.mjs"];
  const descriptorsChanged = P.filter((p) => p.endsWith(".service.json") || serviceDefPaths.includes(p));
  const regenerate = descriptorsChanged.length > 0;
  const installedNames = i.manifest.filter((e) => e.roles?.includes(i.role) && i.installedLabels.has(e.label)).map((e) => e.name);
  if (regenerate) {
    push({
      id: "services-regenerate",
      kind: "auto",
      appliesTo: "both",
      title: "Re-render + reload the launchd services that are INSTALLED here (bootout → bootstrap → kickstart -k)",
      command: installedNames.length
        ? `node scripts/gen-launchd.mjs --install ${installedNames.join(" ")}`
        : "node scripts/gen-launchd.mjs --install   # core only; add the names of the add-on services you have set up",
      manual: null,
      why: `service definitions changed: ${descriptorsChanged.join(", ")}. Never \`--all\` here — it renders plists for add-ons this machine never set up, which crash-loop under KeepAlive.`,
      paths: descriptorsChanged,
    });
  }

  // 5. Per-service restarts, derived from the manifest.
  const kitChanged = any(P, (p) => under(p, "packages/mcp-kit"));
  const restarted = [];
  for (const e of i.manifest) {
    if (!e.roles?.includes(i.role)) continue;
    if (e.name === "boardapp" || e.name === "backup") continue; // handled below / never kicked (scheduled)
    if (e.schedule) continue; // a scheduled runner runs its new code at its next hour; kickstart would FIRE it
    const dir = entrySourceDir(e, i.repoRoot);
    const hit = (dir && any(P, (p) => under(p, dir))) || (e.kind === "bridge" && kitChanged);
    if (!hit) continue;
    if (!i.installedLabels.has(e.label)) continue; // not wired on this machine — nothing to restart
    restarted.push(e.name);
    if (regenerate) continue; // gen-launchd --install already kickstarts every installed service
    const delta = i.toolDelta?.[e.name];
    const deltaText = delta && (delta.added.length || delta.removed.length)
      ? ` — tools ${delta.added.length ? `gained: ${delta.added.join(", ")}` : ""}${delta.added.length && delta.removed.length ? "; " : ""}${delta.removed.length ? `removed: ${delta.removed.join(", ")}` : ""}`
      : "";
    push({
      id: `restart-${e.name}`,
      kind: "auto",
      appliesTo: e.roles.length === 1 ? e.roles[0] : "both",
      title: `Restart ${e.kind} "${e.name}" (${e.label})${deltaText}`,
      command: kick(e.label),
      why: (dir && any(P, (p) => under(p, dir)) ? `${dir}/ changed` : "packages/mcp-kit/ changed (every bridge embeds it)") +
        (e.kind === "bridge"
          ? ". A supergateway bridge spawns a fresh child per request, so the kick mainly reaps idle pre-pull children; the STALE part is each open Claude Code session's cached tool list — start a new session (or /mcp → reconnect) after this."
          : ". A long-lived runner/sidecar serves the old code until its process restarts (a uv sidecar re-syncs its venv on start)."),
      paths: P.filter((p) => (dir && under(p, dir)) || under(p, "packages/mcp-kit")),
    });
  }

  // 6. The board itself (hub only).
  if (isHub && boardChanged) {
    const boardappInstalled = i.installedLabels.has("com.chiefofstaff.mcp-boardapp");
    push({
      id: "board-rebuild",
      kind: boardappInstalled ? "auto" : "manual",
      appliesTo: "hub",
      title: boardappInstalled
        ? "Rebuild + restart the production board (boardapp rebuilds when the checked-out commit moved)"
        : "Rebuild + restart the board",
      command: boardappInstalled
        ? `launchctl bootstrap gui/${uid} "$HOME/Library/LaunchAgents/com.chiefofstaff.mcp-boardapp.plist" 2>/dev/null; ${kick("com.chiefofstaff.mcp-boardapp")}`
        : null,
      manual: boardappInstalled
        ? "boardapp-run.mjs rebuilds only when HEAD differs from board/.next/COS_BUILT_COMMIT. If the build fails it writes board/.next/COS_BUILD_FAILED and will NOT retry on this commit: fix the cause (usually a missed npm install), `rm board/.next/COS_BUILD_FAILED`, kick again. Read mcp/logs/boardapp.err.log."
        : "no boardapp LaunchAgent here: restart your `npm run dev`, or for a manual production board run `(cd board && npm run build && npm run start)` — NEVER `next build` while a `next dev` is running (they share .next).",
      why: schemaBump
        ? `board code changed and SCHEMA_VERSION ${i.fromSchema} → ${i.toSchema}: the running build cannot even read the new shape correctly`
        : "board code changed; the running build is stale",
      paths: P.filter((p) => under(p, "board") && !under(p, "board/.claude") && !under(p, "board/data")).slice(0, 12),
    });
  }

  // 7. Schema — what happens, and the one rule afterwards (hub only: a spoke has no store).
  if (isHub && schemaBump) {
    push({
      id: "schema",
      kind: "info",
      appliesTo: "hub",
      title: `Store schema ${i.fromSchema} → ${i.toSchema}: migrates on the first read after the board restarts; the first write stamps v${i.toSchema}`,
      why:
        (i.storeSchema != null ? `live store is at v${i.storeSchema} now. ` : "") +
        `Additive migrate-on-read (board/lib/store.ts migrate()) — no script to run. AFTER the first write, never run a board built from code older than v${i.toSchema} against this store (it fails closed: 503 store-newer-than-code), and restore a backup snapshot only onto a checkout whose SCHEMA_VERSION ≥ the snapshot's (\`node backup/restore.mjs --list\` prints each snapshot's schema; restore.mjs only WARNs). See docs/reference/migration.md for the per-version ledger.`,
      paths: ["board/lib/types.ts", "board/lib/store.ts"].filter((p) => P.includes(p)),
    });
  }

  // 8. Config keys.
  if (i.newCosEnvKeys.length) {
    push({
      id: "config-cos-env",
      kind: "manual",
      appliesTo: "both",
      title: `Add ${i.newCosEnvKeys.length} new key(s) to config/cos.env: ${i.newCosEnvKeys.join(", ")}`,
      manual: "copy each key's block from config/cos.env.example (defaults are documented there); the generators (gen-launchd, gen-cowork-config) read cos.env, so do this BEFORE re-rendering services.",
      why: "config/cos.env.example gained keys that your gitignored config/cos.env does not have",
      paths: ["config/cos.env.example"],
    });
  }
  if (i.newSecretKeys.length) {
    push({
      id: "config-secrets",
      kind: "manual",
      appliesTo: "hub",
      title: `Add ${i.newSecretKeys.length} new secret(s) to config/secrets.env: ${i.newSecretKeys.join(", ")}`,
      manual: "then re-run `node scripts/gen-cowork-config.mjs` — Cowork holds an inlined COPY of every secret (mcp/CLAUDE.md), Claude Code re-reads secrets.env per bridge start.",
      why: "config/secrets.env.example gained keys",
      paths: ["config/secrets.env.example"],
    });
  }

  // 8b. Add-on wiring (hub): an add-on the store says is ENABLED but whose bridge was never set up
  //     here has a nav + an API and no agent path (the invisible step cos-ops#35 closed for new
  //     installs; existing installs that enabled nutrition/fitness before body auto-enabled are
  //     the classic case). Detected from the store's settings + the installed plists.
  if (isHub && i.addonsEnabled?.length) {
    const unwired = i.addonsEnabled.filter((id) => i.manifest.some((e) => e.name === id) && !i.installedLabels.has(`com.chiefofstaff.mcp-${id}`));
    if (unwired.length) {
      push({
        id: "addon-unwired",
        kind: "manual",
        appliesTo: "hub",
        title: `Enabled add-on(s) with no bridge on this machine: ${unwired.join(", ")}`,
        manual: unwired.map((id) => `run /${id}-mcp-setup (wires the :${id} bridge + the Cowork entry)`).join("\n"),
        why: "the board serves the add-on's nav + API, but no agent here can reach it — a scheduled skill that touches it fails mid-run with no error at setup time",
        paths: [],
      });
    }
  }

  // 9. Client wiring: .mcp.json (Claude Code) and the Cowork config.
  const mcpJsonChanged = P.includes(".mcp.json") || P.includes("scripts/gen-mcp-json.mjs");
  const coworkGenChanged = P.includes("scripts/gen-cowork-config.mjs") || regenerate || i.newSecretKeys.length > 0;
  if (coworkGenChanged) {
    push({
      id: "cowork-config",
      kind: "auto",
      appliesTo: "both",
      title: "Regenerate the Cowork MCP config (claude_desktop_config.json entries are an early-bound snapshot)",
      command: "node scripts/gen-cowork-config.mjs",
      why: "the generator, a service descriptor, or a secret changed",
      paths: P.filter((p) => p === "scripts/gen-cowork-config.mjs" || p.endsWith(".service.json")),
    });
  }
  if (mcpJsonChanged) {
    push({ id: "claude-code-restart", kind: "manual", appliesTo: "both", title: "Restart open Claude Code sessions (they read .mcp.json at start)", manual: "quit the session and start a new one in the repo", why: ".mcp.json changed", paths: [".mcp.json"] });
  }
  if (restarted.length || coworkGenChanged) {
    push({
      id: "cowork-restart",
      kind: "manual",
      appliesTo: "both",
      title: "Quit and reopen Claude Cowork Desktop",
      manual: "Cowork spawns each MCP server as ONE long-lived stdio child at launch — it keeps running the old server code until the app restarts.",
      why: restarted.length ? `server code changed for: ${restarted.join(", ")}` : "the Cowork MCP config was regenerated",
      paths: [],
    });
  }

  // 10. Operator skill bundles — the silent no-op. With a receipt (scripts/mark-skill-uploaded.mjs)
  //     the list is every zip whose hash differs from what was last uploaded on THIS machine —
  //     independent of how many pulls ago it changed; without one, the git range.
  const skillOf = (zip) => zip.replace(/^.*\//, "").replace(/\.zip$/, "");
  let toUpload = i.changedBundles.slice();
  let uploadWhy = "Cowork installs a skill from the .zip you upload, not from the repo — a rebuilt bundle changes nothing there until re-uploaded (CLAUDE.md). Until then the scheduled sweep runs LAST version's procedure, silently.";
  if (i.receipt && i.bundleHashes) {
    toUpload = Object.entries(i.bundleHashes)
      .filter(([zip, sha]) => i.receipt[skillOf(zip)] !== sha)
      .map(([zip]) => zip)
      .sort();
    uploadWhy += " This list comes from your upload receipt (mcp/logs/.cowork-skills-uploaded.json): every bundle whose bytes differ from what you last marked as uploaded here.";
  } else if (toUpload.length) {
    uploadWhy += " No upload receipt exists on this machine, so this is the git-range list; after uploading, run `node scripts/mark-skill-uploaded.mjs --all` once so future upgrades can compute the exact drift.";
  }
  if (toUpload.length) {
    push({
      id: "bundles",
      kind: "manual",
      appliesTo: "both",
      title: `Upload ${toUpload.length} skill bundle(s) in Cowork → Settings → Capabilities → Skills (replace the installed copy)`,
      manual: toUpload.map((z) => `upload ${z}`).join("\n") + `\nthen: node scripts/mark-skill-uploaded.mjs ${toUpload.map(skillOf).join(" ")}`,
      why: uploadWhy,
      paths: toUpload,
    });
  }
  const skillSrcChanged = P.filter((p) => under(p, "board/.claude/skills") && !p.endsWith("/README.md") && p !== "board/.claude/skills/automation.json");
  if (skillSrcChanged.length && !i.changedBundles.length) {
    push({ id: "bundles-stale", kind: "manual", appliesTo: "both", title: "Operator skill source changed but no bundle did — the bundles are stale", manual: "run `node scripts/pack-skills.mjs` and commit (CI's `--check` should have caught this)", why: skillSrcChanged.slice(0, 5).join(", "), paths: skillSrcChanged });
  }

  // 11. Scheduled tasks.
  const au = i.automation;
  if (au.added.length || au.changed.length || au.removed.length) {
    const lines = [
      ...au.added.map((s) => `CREATE  "${s.trigger}"  (cadence ${s.cadence ?? "—"}; skill ${s.skill})`),
      ...au.changed.map((s) => `EDIT    "${s.trigger}"  → cadence ${s.cadence ?? "—"} (was ${s.was.cadence ?? "—"})`),
      ...au.removed.map((s) => `DELETE  "${s.trigger}"  (no longer catalogued)`),
    ];
    push({
      id: "automation",
      kind: "manual",
      appliesTo: "both",
      title: `Update ${lines.length} Cowork scheduled task(s) (board/.claude/skills/automation.json changed)`,
      manual: lines.join("\n"),
      why: "a scheduled trigger the catalog lists runs nowhere until you create it in Cowork's Scheduled Tasks",
      paths: ["board/.claude/skills/automation.json"],
    });
  }

  // 12. Root (setup) skills are read live by Claude Code.
  const rootSkills = P.filter((p) => under(p, ".claude/skills"));
  if (rootSkills.length) {
    const names = [...new Set(rootSkills.map((p) => p.split("/")[2]).filter(Boolean))];
    push({ id: "root-skills", kind: "info", appliesTo: "both", title: `Setup skills changed (${names.join(", ")}) — Claude Code reads them live, nothing to install`, why: "Cowork never sees .claude/skills/ — by design (CLAUDE.md)", paths: rootSkills.slice(0, 8) });
  }

  // 13. Spokes follow the hub.
  const mcpChanged = any(P, (p) => under(p, "mcp") || under(p, "packages/mcp-kit"));
  if (isHub && mcpChanged) {
    push({ id: "spokes", kind: "info", appliesTo: "hub", title: "Then upgrade every spoke — hub FIRST, spokes second", why: "a spoke's MCP wrappers are this same mcp/*-server code pointed at the hub; a wrapper newer than the hub calls routes the hub does not have yet (404), an older one simply lacks the new tools. On each spoke: git pull, then run this script there (it restarts only the spoke-capable bridges).", paths: [] });
  }
  if (!isHub) {
    push({ id: "hub-first", kind: "manual", appliesTo: "spoke", title: "Confirm the HUB is already on ≥ this commit before restarting the wrappers here", manual: 'curl -s "$BOARD_URL/api/healthz" — compare appVersion / schemaVersion with this checkout (package.json version, board/lib/types.ts SCHEMA_VERSION)', why: "a spoke never runs a board or a store; its wrappers must not run ahead of the hub's API", paths: [] });
  }

  // 14. Docs site (maintainer-only).
  if (any(P, (p) => under(p, "docs") || p === "mkdocs.yml")) {
    push({ id: "docs", kind: "info", appliesTo: "both", title: "Docs changed — the MkDocs site is deployed manually (maintainer): gh workflow run docs.yml", why: "docs/ or mkdocs.yml changed; nothing to do on a user machine", paths: [] });
  }

  // 15. Resume the routines paused at the start.
  if (steps.some((s) => s.id === "pause-routines")) {
    push({ id: "resume-routines", kind: "manual", appliesTo: "hub", title: "Resume the Cowork scheduled tasks you paused", manual: "Cowork → Scheduled Tasks → resume every Cos task (after the bundles are uploaded and Cowork was restarted)", why: "paused for the upgrade window", paths: [] });
  }

  // 16. Verify.
  push({
    id: "verify",
    kind: "auto",
    appliesTo: "both",
    title: "Verify",
    command: isHub
      ? 'curl -s "$BOARD_URL/api/healthz"   # schemaVersion == the code\'s, diskSchemaVersion <= it, degradedRead:false; then: sh mcp/ensure-bridges.sh'
      : "sh mcp/ensure-bridges.sh   # every spoke-capable bridge answers on its port",
    why: "healthz reports the running build's SCHEMA_VERSION + appVersion and the store's on-disk schema; ensure-bridges probes every installed service",
    paths: [],
  });

  return {
    steps,
    blockers,
    summary: `${steps.filter((s) => s.kind === "auto").length} automatable step(s), ${steps.filter((s) => s.kind === "manual").length} manual, ${steps.filter((s) => s.kind === "info").length} informational${blockers.length ? `, ${blockers.length} BLOCKER(S)` : ""}.`,
  };
}

// ── CLI (gathers the inputs; never mutates) ───────────────────────────────────────────────────

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitShow(repo, ref, file) {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
function readIf(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const o = { json: false, strict: false, from: null, to: "HEAD", repo: null, store: null, launchAgents: null, manifest: undefined, role: null };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const next = () => argv[++k];
    if (a === "--json") o.json = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--from") o.from = next();
    else if (a === "--to") o.to = next();
    else if (a === "--repo") o.repo = next();
    else if (a === "--store") o.store = next();
    else if (a === "--launch-agents") o.launchAgents = next();
    else if (a === "--manifest") o.manifest = next(); // a JSON file (tests) or "none"
    else if (a === "--role") o.role = next();
    else if (a === "-h" || a === "--help") { o.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function usage() {
  return [
    "usage: node scripts/upgrade-check.mjs [--from <ref>] [--to <ref>] [--json] [--strict]",
    "       --from defaults to ORIG_HEAD (set by `git pull`), else board/.next/COS_BUILT_COMMIT (the",
    "       commit the production board was built from). --to defaults to HEAD.",
    "       Test/advanced: --repo <dir> --store <cases.json> --launch-agents <dir> --manifest <json|none> --role hub|spoke",
  ].join("\n");
}

async function gatherManifest(repo, opt) {
  if (opt === "none") return { entries: [], note: "manifest skipped (--manifest none)" };
  if (opt) return { entries: JSON.parse(fs.readFileSync(opt, "utf8")), note: `manifest from ${opt}` };
  try {
    const mod = await import(path.join(repo, "mcp", "service-manifest.mjs"));
    return { entries: mod.getManifest(), note: null };
  } catch (e) {
    return { entries: [], note: `service manifest unavailable (${String(e.message || e).split("\n")[0]}) — per-service restarts not derived; run \`node scripts/gen-launchd.mjs --install\` after the pull` };
  }
}

function resolveFrom(repo, o, notes) {
  if (o.from) return o.from;
  const head = git(repo, ["rev-parse", "HEAD"]);
  const tryRef = (ref, label) => {
    try {
      const sha = git(repo, ["rev-parse", "--verify", "--quiet", ref]);
      if (sha && sha !== head) { notes.push(`--from defaulted to ${label} (${sha.slice(0, 7)})`); return sha; }
    } catch { /* absent */ }
    return null;
  };
  return tryRef("ORIG_HEAD", "ORIG_HEAD — the pre-pull commit") || (() => {
    const built = readIf(path.join(repo, "board", ".next", "COS_BUILT_COMMIT"));
    return built ? tryRef(built.trim(), "board/.next/COS_BUILT_COMMIT — what the production board is running") : null;
  })();
}

export async function runCli(argv, out = process.stdout) {
  const o = parseArgs(argv);
  if (o.help) { out.write(usage() + "\n"); return 0; }
  const repo = o.repo ? path.resolve(o.repo) : SCRIPT_REPO_ROOT;
  const notes = [];
  const from = resolveFrom(repo, o, notes);
  if (!from) {
    out.write("cannot pick a --from commit: no ORIG_HEAD (run this right after `git pull`) and no board/.next/COS_BUILT_COMMIT.\n" + usage() + "\n");
    return 1;
  }
  const to = o.to;
  const fromSha = git(repo, ["rev-parse", from]);
  const toSha = git(repo, ["rev-parse", to]);
  const changedPaths = fromSha === toSha ? [] : git(repo, ["diff", "--name-only", `${fromSha}..${toSha}`]).split("\n").filter(Boolean);

  const fromSchema = parseSchemaVersion(gitShow(repo, fromSha, "board/lib/types.ts"));
  const toSchema = parseSchemaVersion(gitShow(repo, toSha, "board/lib/types.ts"));

  // Live store (read-only; only the top-level number is needed).
  const storePath = o.store || path.join(process.env.COS_DATA_DIR || path.join(repo, "board", "data"), "cases.json");
  let storeSchema = null;
  let addonsEnabled = [];
  const storeText = readIf(storePath);
  if (storeText) {
    try {
      const parsed = JSON.parse(storeText);
      const v = parsed.schemaVersion;
      storeSchema = typeof v === "number" ? v : 0;
      const addons = parsed.settings?.addons;
      if (addons && typeof addons === "object") addonsEnabled = Object.entries(addons).filter(([, a]) => a && a.enabled === true).map(([id]) => id);
    } catch { notes.push(`could not parse ${storePath}`); }
  }

  // Role: explicit → env → loader (never throws here).
  let role = o.role || process.env.COS_DEVICE_ROLE || null;
  if (!role) {
    try {
      const mod = await import(path.join(repo, "mcp", "service-manifest.mjs"));
      role = mod.currentRole();
    } catch { role = "hub"; notes.push("device role defaulted to hub (config loader unavailable)"); }
  }
  role = role === "spoke" ? "spoke" : "hub";

  const { entries: manifest, note: mnote } = await gatherManifest(repo, o.manifest);
  if (mnote) notes.push(mnote);
  const laDir = o.launchAgents || process.env.LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");
  const installedLabels = new Set();
  try {
    for (const f of fs.readdirSync(laDir)) if (f.endsWith(".plist")) installedLabels.add(f.slice(0, -".plist".length));
  } catch { /* no LaunchAgents dir (Windows / fresh machine) */ }

  const changedBundles = changedPaths.filter((p) => p.startsWith("board/.claude/skill-bundles/") && p.endsWith(".zip"));

  // Per-server tool inventory delta (parsed from the declarations at both refs).
  const toolDelta = {};
  for (const e of manifest) {
    const dir = entrySourceDir(e, repo);
    if (!dir || !changedPaths.some((p) => p.startsWith(dir + "/"))) continue;
    const names = (ref) => parseToolNames([`${dir}/server.mjs`, `${dir}/tools.mjs`].map((f) => gitShow(repo, ref, f) || "").join("\n"));
    const before = new Set(names(fromSha));
    const after = new Set(names(toSha));
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    if (added.length || removed.length) toolDelta[e.name] = { added, removed };
  }

  // Cowork upload receipt (per machine) + the committed bundle hashes at `to`.
  const receiptPath = path.join(repo, "mcp", "logs", ".cowork-skills-uploaded.json");
  let receipt = null;
  const receiptText = readIf(receiptPath);
  if (receiptText) {
    try {
      const r = JSON.parse(receiptText);
      receipt = Object.fromEntries(Object.entries(r.skills || {}).map(([k, v]) => [k, v.sha256]));
    } catch { notes.push(`could not parse ${receiptPath} — ignoring the upload receipt`); }
  }
  const bundleHashes = {};
  try {
    const dirList = git(repo, ["ls-tree", "--name-only", toSha, "board/.claude/skill-bundles/"]).split("\n").filter((f) => f.endsWith(".zip"));
    for (const f of dirList) {
      const blob = execFileSync("git", ["-C", repo, "show", `${toSha}:${f}`], { stdio: ["ignore", "pipe", "ignore"] });
      bundleHashes[f] = crypto.createHash("sha256").update(blob).digest("hex");
    }
  } catch { /* no bundles at this ref */ }
  const automation = diffAutomation(gitShow(repo, fromSha, "board/.claude/skills/automation.json"), gitShow(repo, toSha, "board/.claude/skills/automation.json"));
  const newCosEnvKeys = newEnvKeys(gitShow(repo, fromSha, "config/cos.env.example"), gitShow(repo, toSha, "config/cos.env.example"), readIf(path.join(repo, "config", "cos.env")));
  const newSecretKeys = newEnvKeys(gitShow(repo, fromSha, "config/secrets.env.example"), gitShow(repo, toSha, "config/secrets.env.example"), readIf(path.join(repo, "config", "secrets.env")));

  const plan = planUpgrade({ changedPaths, fromSchema, toSchema, storeSchema, role, manifest, installedLabels, changedBundles, automation, newCosEnvKeys, newSecretKeys, repoRoot: repo, uid: process.getuid ? process.getuid() : null, addonsEnabled, toolDelta, receipt, bundleHashes });
  const report = { from: fromSha, to: toSha, role, fromSchema, toSchema, storeSchema, changedPathCount: changedPaths.length, notes, ...plan };

  if (o.json) {
    out.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    out.write(`cos upgrade-check · ${fromSha.slice(0, 7)} → ${toSha.slice(0, 7)} · role=${role} · ${changedPaths.length} path(s) changed · schema ${fromSchema ?? "?"} → ${toSchema ?? "?"}${storeSchema != null ? ` (store on disk: ${storeSchema})` : ""}\n`);
    for (const n of notes) out.write(`  note: ${n}\n`);
    for (const b of plan.blockers) out.write(`\n  BLOCKER: ${b}\n`);
    let k = 0;
    for (const s of plan.steps) {
      k++;
      const tag = s.kind === "auto" ? "[auto]  " : s.kind === "manual" ? "[manual]" : "[info]  ";
      out.write(`\n${String(k).padStart(2)}. ${tag} ${s.title}\n`);
      if (s.command) out.write(`      $ ${s.command}\n`);
      if (s.manual) for (const line of s.manual.split("\n")) out.write(`      → ${line}\n`);
      out.write(`      why: ${s.why}\n`);
    }
    out.write(`\n${plan.summary}\n`);
  }
  return o.strict && plan.blockers.length ? 2 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[upgrade-check] ${e.message}`); process.exit(1); });
}
