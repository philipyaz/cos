#!/usr/bin/env node
// tests/upgrade-check.mjs — the post-pull planner (scripts/upgrade-check.mjs) is a pure
// function over the diff + the manifest; pin the path → step mapping so a refactor cannot
// silently drop a step (the whole point of the script is that every one of these is a
// SILENT no-op when forgotten — a stale board build, a bridge on old code, a bundle Cowork
// never re-received, a scheduled trigger nobody created). Hermetic: no board, no launchd,
// no config; the CLI smoke test builds a throwaway git repo in $TMPDIR.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planUpgrade, diffAutomation, newEnvKeys, envKeys, parseSchemaVersion, entrySourceDir, parseToolNames, runCli } from "../scripts/upgrade-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed++; };

// ── a synthetic manifest in the resolved shape service-manifest.mjs returns ──────────────
const R = "/fake/repo";
const manifest = [
  { name: "board", kind: "bridge", label: "com.chiefofstaff.mcp-board", stdio: ["/usr/bin/node", `${R}/mcp/board-server/server.mjs`], roles: ["hub", "spoke"], schedule: null },
  { name: "vault", kind: "bridge", label: "com.chiefofstaff.mcp-vault", stdio: ["/usr/bin/node", `${R}/mcp/vault-server/server.mjs`], roles: ["hub"], schedule: null },
  { name: "guardsvc", kind: "sidecar", label: "com.chiefofstaff.mcp-guardsvc", dir: `${R}/guard`, roles: ["hub"], schedule: null },
  { name: "boardapp", kind: "sidecar", label: "com.chiefofstaff.mcp-boardapp", exec: ["/usr/bin/node", `${R}/scripts/boardapp-run.mjs`], roles: ["hub"], schedule: null },
  { name: "backup", kind: "runner", label: "com.chiefofstaff.backup", exec: ["/usr/bin/node", `${R}/backup/backup.mjs`], roles: ["hub"], schedule: { hour: 3, minute: 30 } },
  { name: "whatsappbridge", kind: "sidecar", label: "com.chiefofstaff.mcp-whatsappbridge", exec: ["/Users/x/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge"], roles: ["hub"], schedule: null },
];
const allInstalled = new Set(manifest.map((e) => e.label));
const base = {
  fromSchema: 15, toSchema: 15, storeSchema: 15, role: "hub", manifest, installedLabels: allInstalled,
  changedBundles: [], automation: { added: [], changed: [], removed: [] }, newCosEnvKeys: [], newSecretKeys: [], repoRoot: R, uid: 501,
};
const plan = (over) => planUpgrade({ ...base, ...over });
const ids = (p) => p.steps.map((s) => s.id);

console.log("upgrade-check · helpers");
check(parseSchemaVersion("x\nexport const SCHEMA_VERSION = 17; // y\n") === 17, "parseSchemaVersion reads the exported constant");
check(parseSchemaVersion(null) === null, "parseSchemaVersion → null when absent");
check(envKeys('# c\nA="1"\nexport B=2\n  C=\nA=dup\n').join(",") === "A,B,C", "envKeys: ordered, unique, export-tolerant, comments skipped");
check(newEnvKeys("A=1\n", "A=1\nB=2\nC=3\n", "C=set\n").join(",") === "B", "newEnvKeys: added keys minus those already in the live file");
check(entrySourceDir(manifest[0], R) === "mcp/board-server", "entrySourceDir: a bridge → its server dir from stdio");
check(entrySourceDir(manifest[2], R) === "guard", "entrySourceDir: a uvicorn sidecar → its dir");
check(entrySourceDir(manifest[5], R) === null, "entrySourceDir: an external exec (outside the repo) → null");
check(parseToolNames('const T = [\n  {\n    name: "list_x",\n  },\n  { name: "add_x" },\n];\n// name: "not_a_tool"\n  name: "zz_last"').join(",") === "add_x,list_x,zz_last", "parseToolNames: line-leading name: declarations, sorted, comments ignored");

console.log("upgrade-check · automation diff");
const au = diffAutomation(
  JSON.stringify({ a: { class: "scheduled", schedules: [{ trigger: "Run /a", cadence: "daily" }] }, b: { class: "scheduled", schedules: [{ trigger: "Run /b", cadence: "weekly" }] } }),
  JSON.stringify({ a: { class: "scheduled", schedules: [{ trigger: "Run /a", cadence: "hourly" }] }, c: { class: "scheduled", schedules: [{ trigger: "Run /c", cadence: "Friday" }] } }),
);
check(au.added.length === 1 && au.added[0].trigger === "Run /c", "a new trigger is 'added'");
check(au.changed.length === 1 && au.changed[0].was.cadence === "daily", "a cadence change on the same trigger is 'changed' (with the old value)");
check(au.removed.length === 1 && au.removed[0].trigger === "Run /b", "a dropped trigger is 'removed'");
check(diffAutomation(null, "not json").added.length === 0, "unparseable / absent catalog → empty diff, no throw");

console.log("upgrade-check · planner");
check(plan({ changedPaths: [] }).steps.length === 0, "no changed paths → no steps");

const p1 = plan({ changedPaths: ["mcp/board-server/server.mjs", "mcp/board-server/README.md"] });
check(ids(p1).includes("restart-board") && !ids(p1).includes("restart-vault"), "a change under a bridge's server dir restarts THAT bridge only");
check(p1.steps.find((s) => s.id === "restart-board").command === "launchctl kickstart -k gui/501/com.chiefofstaff.mcp-board", "the restart is a kickstart -k of the manifest label (not a plain kickstart)");
check(ids(p1).includes("cowork-restart"), "server code changed → Cowork must be restarted (long-lived stdio child)");
check(ids(p1).includes("spokes"), "on a hub, an mcp/ change reminds you to upgrade the spokes second");
check(!ids(p1).includes("backup") && !ids(p1).includes("board-rebuild"), "a server-only change does not touch the board or the store");

const p1s = plan({ changedPaths: ["mcp/board-server/server.mjs", "mcp/vault-server/server.mjs"], role: "spoke", storeSchema: null });
check(ids(p1s).includes("restart-board") && !ids(p1s).includes("restart-vault"), "on a spoke only spoke-capable services restart (vault is hub-only)");
check(ids(p1s).includes("hub-first") && !ids(p1s).includes("spokes"), "a spoke is told to confirm the hub is ahead first");

const p2 = plan({ changedPaths: ["packages/mcp-kit/index.mjs"] });
check(ids(p2).includes("restart-board") && ids(p2).includes("restart-vault") && !ids(p2).includes("restart-guardsvc"), "a shared mcp-kit change restarts every bridge, not the sidecars");

const notInstalled = new Set([...allInstalled].filter((l) => l !== "com.chiefofstaff.mcp-vault"));
const p3 = plan({ changedPaths: ["mcp/vault-server/server.mjs"], installedLabels: notInstalled });
check(!ids(p3).includes("restart-vault"), "a service whose plist is not installed on this machine is not restarted");

const p4 = plan({ changedPaths: ["board/lib/selectors.ts", "board/app/page.tsx"] });
check(ids(p4).includes("backup") && ids(p4).indexOf("backup") < ids(p4).indexOf("board-rebuild"), "a board change → backup FIRST, then rebuild");
check(/kickstart -k gui\/501\/com\.chiefofstaff\.mcp-boardapp$/.test(p4.steps.find((s) => s.id === "board-rebuild").command), "with boardapp installed the rebuild ends in its kickstart -k (after a bootstrap)");
check(ids(p4).includes("board-stop") && ids(p4).indexOf("board-stop") < ids(p4).indexOf("board-rebuild") && ids(p4).indexOf("backup") < ids(p4).indexOf("board-stop"), "a board change on a hub with boardapp: backup → STOP the board (freeze) → … → rebuild");
check(ids(p4).includes("pause-routines") && ids(p4)[ids(p4).length - 1] === "verify" && ids(p4)[ids(p4).length - 2] === "resume-routines", "the routines are paused early and resumed right before verify");
check(!ids(plan({ changedPaths: ["board/lib/selectors.ts"], installedLabels: new Set() })).includes("board-stop"), "no boardapp LaunchAgent → no bootout step");
check(!ids(plan({ changedPaths: ["board/lib/selectors.ts"], role: "spoke", storeSchema: null })).includes("pause-routines"), "a spoke never pauses routines (they live where the board is)");
check(!ids(p4).includes("schema"), "no schema bump → no schema step");
const p4d = plan({ changedPaths: ["board/lib/selectors.ts"], installedLabels: new Set() });
check(p4d.steps.find((s) => s.id === "board-rebuild").kind === "manual" && /next dev/.test(p4d.steps.find((s) => s.id === "board-rebuild").manual), "without boardapp the rebuild is a manual dev/prod instruction that names the next-build-vs-dev trap");
check(p4d.steps.find((s) => s.id === "backup").kind === "manual", "without the backup agent the backup step is manual, never skipped");

const p5 = plan({ changedPaths: ["board/lib/types.ts", "board/lib/store.ts"], fromSchema: 15, toSchema: 17, storeSchema: 15 });
check(ids(p5).includes("schema") && /15 → 17/.test(p5.steps.find((s) => s.id === "schema").title), "a schema bump is stated with both versions");
check(ids(p5).indexOf("backup") === 0, "a schema bump puts the backup first");
check(p5.blockers.length === 0, "store ≤ code → no blocker");
const p5s = plan({ changedPaths: ["board/lib/types.ts"], fromSchema: 15, toSchema: 17, storeSchema: 15, role: "spoke" });
check(!ids(p5s).includes("schema") && !ids(p5s).includes("backup") && !ids(p5s).includes("board-rebuild"), "a spoke gets no store/board steps at all");

const p6 = plan({ changedPaths: ["board/lib/types.ts"], fromSchema: 17, toSchema: 15, storeSchema: 17 });
check(p6.blockers.length === 1 && /DOWNGRADE/.test(p6.blockers[0]), "store NEWER than the target code → a BLOCKER naming the downgrade");

const p7 = plan({ changedPaths: ["board/.claude/skill-bundles/nutrition-chef.zip", "board/.claude/skills/nutrition-chef/SKILL.md"], changedBundles: ["board/.claude/skill-bundles/nutrition-chef.zip"] });
check(ids(p7).includes("bundles") && p7.steps.find((s) => s.id === "bundles").kind === "manual", "a rebuilt bundle is a MANUAL Cowork upload step");
check(!ids(p7).includes("board-rebuild") && !ids(p7).includes("bundles-stale"), "a skill-only change does not rebuild the board, and is not 'stale' when its zip moved too");
const p7b = plan({ changedPaths: ["board/.claude/skills/nutrition-chef/SKILL.md"] });
check(ids(p7b).includes("bundles-stale"), "skill source changed without its bundle → flagged stale");

const p8 = plan({ changedPaths: ["board/.claude/skills/automation.json"], automation: { added: [{ trigger: "Run /x", cadence: "weekly", skill: "x", cls: "scheduled" }], changed: [], removed: [] } });
check(ids(p8).includes("automation") && /CREATE\s+"Run \/x"/.test(p8.steps.find((s) => s.id === "automation").manual), "a new scheduled trigger becomes a CREATE line");

const p9 = plan({ changedPaths: ["mcp/board-server/board.service.json", "mcp/board-server/server.mjs"] });
check(ids(p9).includes("services-regenerate") && !ids(p9).includes("restart-board"), "a descriptor change → gen-launchd --install, which supersedes the per-service kickstart");
check(p9.steps.find((s) => s.id === "services-regenerate").command === "node scripts/gen-launchd.mjs --install board vault guardsvc boardapp backup whatsappbridge", "the regenerate names exactly the INSTALLED services for this role (never --all)");
check(plan({ changedPaths: ["mcp/board-server/board.service.json"], role: "spoke", storeSchema: null }).steps.find((s) => s.id === "services-regenerate").command === "node scripts/gen-launchd.mjs --install board", "on a spoke only the spoke-capable installed services are named");

const pd = plan({ changedPaths: ["mcp/board-server/server.mjs"], toolDelta: { board: { added: ["list_triage_decisions", "record_triage_decision"], removed: [] } } });
check(/tools gained: list_triage_decisions, record_triage_decision/.test(pd.steps.find((s) => s.id === "restart-board").title), "a restart step names the tools the server gained in the range");

const pa = plan({ changedPaths: ["board/lib/addons.ts"], addonsEnabled: ["nutrition", "body"], manifest: [...manifest, { name: "nutrition", kind: "bridge", label: "com.chiefofstaff.mcp-nutrition", stdio: ["/usr/bin/node", `${R}/mcp/nutrition-server/server.mjs`], roles: ["hub", "spoke"], schedule: null }, { name: "body", kind: "bridge", label: "com.chiefofstaff.mcp-body", stdio: ["/usr/bin/node", `${R}/mcp/body-server/server.mjs`], roles: ["hub", "spoke"], schedule: null }], installedLabels: new Set([...allInstalled, "com.chiefofstaff.mcp-nutrition"]) });
check(ids(pa).includes("addon-unwired") && /body/.test(pa.steps.find((s) => s.id === "addon-unwired").title) && !/nutrition/.test(pa.steps.find((s) => s.id === "addon-unwired").title), "an ENABLED add-on with no bridge plist here is flagged (body), a wired one is not (nutrition)");
check(!ids(plan({ changedPaths: ["board/lib/addons.ts"], addonsEnabled: ["body"], role: "spoke", storeSchema: null })).includes("addon-unwired"), "the add-on wiring probe is hub-only (a spoke has no store to read settings from)");

const hashes = { "board/.claude/skill-bundles/a.zip": "aaa", "board/.claude/skill-bundles/b.zip": "bbb", "board/.claude/skill-bundles/c.zip": "ccc" };
const pr = plan({ changedPaths: ["board/.claude/skill-bundles/a.zip"], changedBundles: ["board/.claude/skill-bundles/a.zip"], receipt: { a: "aaa", b: "old", c: "ccc" }, bundleHashes: hashes });
check(pr.steps.find((s) => s.id === "bundles").paths.join(",") === "board/.claude/skill-bundles/b.zip", "with a receipt the upload list is hash drift (b changed since it was marked; a is current even though it is in the git range)");
check(/mark-skill-uploaded\.mjs b$/m.test(pr.steps.find((s) => s.id === "bundles").manual), "…and the step ends with the exact mark-skill-uploaded command");
const pr2 = plan({ changedPaths: ["board/.claude/skill-bundles/a.zip"], changedBundles: ["board/.claude/skill-bundles/a.zip"], receipt: { a: "aaa", b: "bbb", c: "ccc" }, bundleHashes: hashes });
check(!ids(pr2).includes("bundles"), "a receipt that matches every zip → nothing to upload, even when the git range touched a bundle");
check(ids(p9).includes("cowork-config"), "a descriptor change → regenerate the Cowork config too");

const p10 = plan({ changedPaths: ["config/cos.env.example", "config/secrets.env.example"], newCosEnvKeys: ["NEW_PORT"], newSecretKeys: ["NEW_KEY"] });
check(ids(p10).includes("config-cos-env") && /NEW_PORT/.test(p10.steps.find((s) => s.id === "config-cos-env").title), "a new cos.env key is a manual step naming the key");
check(ids(p10).includes("config-secrets") && ids(p10).includes("cowork-config"), "a new secret → manual add + regenerate the Cowork snapshot");
check(!JSON.stringify(p10).includes("NEW_KEY=") , "secret VALUES never appear (only key names)");

const p11 = plan({ changedPaths: ["package-lock.json", "board/package-lock.json", ".mcp.json", "docs/index.md", ".claude/skills/cos-setup/SKILL.md"] });
check(ids(p11).includes("deps-root") && ids(p11).includes("deps-board"), "lockfile changes → npm install steps");
check(ids(p11).includes("claude-code-restart"), ".mcp.json change → restart Claude Code sessions");
check(ids(p11).includes("docs") && ids(p11).includes("root-skills"), "docs + root skills are informational");
check(ids(p11)[ids(p11).length - 1] === "verify", "every non-empty plan ends with the verify step");
check(plan({ changedPaths: ["backup/backup.mjs"] }).steps.every((s) => s.id !== "restart-backup"), "a scheduled runner is never kickstarted (it would fire now)");

// ── CLI smoke test on a throwaway git repo ────────────────────────────────────────────────
console.log("upgrade-check · CLI (throwaway git repo)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cos-upgrade-check-"));
const g = (...a) => execFileSync("git", ["-C", tmp, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
try {
  g("init", "-q");
  w("board/lib/types.ts", "export const SCHEMA_VERSION = 15;\n");
  w("config/cos.env.example", "BOARD_PORT=3000\n");
  w("board/.claude/skills/automation.json", JSON.stringify({ a: { class: "scheduled", schedules: [{ trigger: "Run /a", cadence: "daily" }] } }));
  w("mcp/board-server/server.mjs", "// v1\n");
  g("add", "-A"); g("commit", "-q", "-m", "one");
  const from = g("rev-parse", "HEAD");
  w("board/lib/types.ts", "export const SCHEMA_VERSION = 17;\n");
  w("board/lib/store.ts", "// migrate\n");
  w("config/cos.env.example", "BOARD_PORT=3000\nNEW_BRIDGE_PORT=8099\n");
  w("board/.claude/skills/automation.json", JSON.stringify({ a: { class: "scheduled", schedules: [{ trigger: "Run /a", cadence: "daily" }, { trigger: "Run /a weekly lens", cadence: "weekly" }] } }));
  w("mcp/board-server/server.mjs", "// v2\n");
  w("board/.claude/skill-bundles/a.zip", "zip");
  g("add", "-A"); g("commit", "-q", "-m", "two");
  const to = g("rev-parse", "HEAD");
  w("board/data/cases.json", JSON.stringify({ schemaVersion: 15 }));
  const la = path.join(tmp, "LaunchAgents"); fs.mkdirSync(la); fs.writeFileSync(path.join(la, "com.chiefofstaff.mcp-board.plist"), "");
  const mf = path.join(tmp, "manifest.json");
  fs.writeFileSync(mf, JSON.stringify([{ name: "board", kind: "bridge", label: "com.chiefofstaff.mcp-board", stdio: ["/usr/bin/node", `${tmp}/mcp/board-server/server.mjs`], roles: ["hub", "spoke"], schedule: null }]));
  let buf = "";
  const code = await runCli(["--repo", tmp, "--from", from, "--to", to, "--json", "--launch-agents", la, "--manifest", mf, "--role", "hub"], { write: (s) => { buf += s; } });
  const rep = JSON.parse(buf);
  check(code === 0, `CLI exits 0 (got ${code})`);
  check(rep.fromSchema === 15 && rep.toSchema === 17 && rep.storeSchema === 15, `CLI reads SCHEMA_VERSION at both refs + the store (got ${rep.fromSchema}/${rep.toSchema}/${rep.storeSchema})`);
  const rids = rep.steps.map((s) => s.id);
  check(rids.includes("restart-board") && rids.includes("schema") && rids.includes("bundles") && rids.includes("automation") && rids.includes("config-cos-env"), `CLI derives restart/schema/bundle/automation/config steps (got ${rids.join(",")})`);
  check(/NEW_BRIDGE_PORT/.test(rep.steps.find((s) => s.id === "config-cos-env").title), "CLI diffs cos.env.example keys between the refs");
  check(/Run \/a weekly lens/.test(rep.steps.find((s) => s.id === "automation").manual), "CLI diffs automation.json between the refs");
  check(rep.steps.find((s) => s.id === "backup").kind === "manual", "no backup agent in the fake LaunchAgents → manual backup step");
  // ORIG_HEAD default: simulate a pull by resetting back and forward.
  g("update-ref", "ORIG_HEAD", from);
  buf = "";
  const code2 = await runCli(["--repo", tmp, "--json", "--launch-agents", la, "--manifest", "none", "--role", "hub"], { write: (s) => { buf += s; } });
  const rep2 = JSON.parse(buf);
  check(code2 === 0 && rep2.from === from && rep2.notes.some((n) => /ORIG_HEAD/.test(n)), "--from defaults to ORIG_HEAD right after a pull (and says so)");
  // Strict mode + a store newer than the target.
  w("board/data/cases.json", JSON.stringify({ schemaVersion: 18 }));
  buf = "";
  const code3 = await runCli(["--repo", tmp, "--from", from, "--to", to, "--json", "--strict", "--launch-agents", la, "--manifest", "none", "--role", "hub"], { write: (s) => { buf += s; } });
  check(code3 === 2 && JSON.parse(buf).blockers.length === 1, "--strict exits 2 when the store is newer than the code (a downgrade)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── repo contract: the schema ledger names the current version ───────────────────────────
// Two PRs once claimed the same SCHEMA_VERSION; the guard compares numbers only, so nothing in
// CI saw it. The ledger entry is the one place a bump has to be WRITTEN DOWN, and this makes a
// missing entry (or a duplicate number that never got its own line) red.
console.log("upgrade-check · schema ledger contract");
const codeSchema = parseSchemaVersion(fs.readFileSync(path.join(REPO, "board", "lib", "types.ts"), "utf8"));
const ledger = fs.readFileSync(path.join(REPO, "docs", "reference", "migration.md"), "utf8");
check(typeof codeSchema === "number", `board/lib/types.ts exports SCHEMA_VERSION (got ${codeSchema})`);
check(
  new RegExp(`\\*\\*v${codeSchema - 1} → v${codeSchema} — `).test(ledger),
  `docs/reference/migration.md has a "v${codeSchema - 1} → v${codeSchema} — …" ledger entry for the current SCHEMA_VERSION (a bump without its ledger line is red here)`,
);

console.log(failed ? `\nFAIL — ${failed} upgrade-check check(s) failed.` : "\nPASS — upgrade-check: planner + CLI + ledger contract.");
process.exit(failed ? 1 : 0);
