#!/usr/bin/env node
// Recover stores from the encrypted backup repo. SAFE BY DEFAULT:
//   - verifies the GCM auth tag (tamper/wrong-key detection) AND the sha256 vs the
//     manifest AND that every restored *.json parses, BEFORE touching anything;
//   - REFUSES to run --apply while a live board answers on BOARD_URL — an in-flight
//     mutate() would serialize its stale in-memory state right back over the
//     freshly-restored file (--allow-live-board overrides, for the brave);
//   - hard-fails when the backup repo can't be synced with its remote — a stale
//     clone must never silently promote old state (--stale-ok overrides, for
//     offline disaster recovery);
//   - dry-run unless you pass --apply;
//   - on --apply, snapshots the CURRENT live state to ~/cos-recovery/pre-restore-*
//     before overwriting, so a restore is itself reversible.
//
// Cross-machine restores are ROLE-AWARE:
//   - a snapshot's vault (vault/<producer-name>) is restored INTO this machine's
//     configured vault (config/cos.env VAULT_NAME) — the name is mapped, so a
//     Mac-Mini restore of a MacBook snapshot lands in the right directory;
//   - vault/<name>/.cos/jobs.json (the vault-worker queue: claimed pids, jobs) is
//     STRIPPED from the stage — the restoring machine's runner must not "requeue
//     jobs orphaned by a crash" and re-run an ingest that already landed;
//   - config/settings.json keeps this machine's Obsidian identity
//     (obsidianVaultId/obsidianVaultName survive; everything else is restored).
//
// Usage:
//   node backup/restore.mjs                 # verify the LATEST backup (dry run)
//   node backup/restore.mjs --date 2026-06-06
//   node backup/restore.mjs --apply         # actually restore the latest
//   node backup/restore.mjs --list          # list available backups (all devices)
//   flags: --stale-ok (skip the remote-sync requirement), --allow-live-board
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, BACKUP_REPO, BOARD_URL, VAULT_SCOPE_PATH, VAULT_NAME_CONFIGURED, DEVICE_ID } from "./config.mjs";
import { decrypt } from "./lib/crypto.mjs";
import { resolveKey } from "./lib/key.mjs";
import { readAllManifests } from "./lib/manifests.mjs";
import { firstLine, acquireRepoLock, releaseRepoLock } from "./lib/util.mjs";

const log = (...a) => console.log(...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// Machine-local keys of config/settings.json that a cross-machine restore must
// NOT import from the snapshot: the Obsidian registration is per-machine (the
// producer's vault id would make every obsidian:// deep-link open the WRONG
// vault). The CONCEPT is owned by board/lib/vault-config.ts (which reads these
// keys) — keep this list in lockstep when a machine-local settings key is added
// there; vault-config.ts's header carries the reciprocal pointer.
const SETTINGS_MACHINE_KEYS = ["obsidianVaultId", "obsidianVaultName"];

// Merge-restore config/settings.json, preserving this machine's keys. Returns
// true on success; false (with a LOUD warning — this is a guard, not cosmetics)
// so the caller falls back to the verbatim copy.
function mergeSettings(src, dst) {
  try {
    const restored = JSON.parse(fs.readFileSync(src, "utf8"));
    const live = JSON.parse(fs.readFileSync(dst, "utf8"));
    for (const k of SETTINGS_MACHINE_KEYS) {
      if (live[k] !== undefined) restored[k] = live[k];
    }
    fs.writeFileSync(dst, JSON.stringify(restored, null, 2) + "\n");
    log(`restored config/settings.json (kept this machine's ${SETTINGS_MACHINE_KEYS.join("/")})`);
    return true;
  } catch (e) {
    log(
      `WARN: could not merge config/settings.json (${firstLine(e)}) — restoring it VERBATIM; ` +
        `this machine's ${SETTINGS_MACHINE_KEYS.join("/")} were NOT preserved (re-run setup-vault §register if Obsidian deep-links open the wrong vault).`,
    );
    return false;
  }
}

// Sync the local clone with its remote, HARD-FAILING when that isn't possible —
// under multi-device the backup repo is the handover conveyor, and "latest" read
// off a stale clone silently promotes old state. `--stale-ok` is the explicit
// offline-DR escape hatch. Being AHEAD of upstream (unpushed local snapshots on
// the producer itself) is fine; being behind fast-forwards; a divergence is a
// real conflict the user must reconcile.
function syncOrDie() {
  if (flag("--stale-ok")) {
    log("WARN: --stale-ok — skipping the remote-sync requirement (offline DR mode).");
    return;
  }
  let hasRemote = false;
  try {
    hasRemote = sh("git", ["-C", BACKUP_REPO, "remote"]).trim() !== "";
  } catch {
    /* not a git repo — caught by the .git check in loadEntries */
  }
  if (!hasRemote) {
    log("note: backup repo has no remote — local-only archive, nothing to sync.");
    return;
  }
  try {
    sh("git", ["-C", BACKUP_REPO, "fetch", "origin"]);
  } catch (e) {
    throw new Error(
      `cannot reach the backup remote (${String(e.message).split("\n")[0]}). ` +
        `A stale clone must not choose "latest" — reconnect, or re-run with --stale-ok for offline disaster recovery.`,
    );
  }
  let upstream;
  try {
    upstream = sh("git", ["-C", BACKUP_REPO, "rev-parse", "--abbrev-ref", "@{u}"]).trim();
  } catch {
    log("note: no upstream configured for the current branch — using the local view.");
    return;
  }
  const counts = sh("git", ["-C", BACKUP_REPO, "rev-list", "--left-right", "--count", `HEAD...${upstream}`])
    .trim()
    .match(/^(\d+)\s+(\d+)$/);
  const ahead = counts ? Number(counts[1]) : 0;
  const behind = counts ? Number(counts[2]) : 0;
  if (behind === 0) return; // up to date (or ahead-only: local unpushed snapshots — fine)
  if (ahead === 0) {
    sh("git", ["-C", BACKUP_REPO, "merge", "--ff-only", upstream]);
    log(`fast-forwarded ${behind} commit(s) from ${upstream} ✓`);
    return;
  }
  throw new Error(
    `backup repo has DIVERGED from ${upstream} (${ahead} ahead / ${behind} behind) — ` +
      `reconcile it first (backup-recovery skill §7 "Diverged backup repo"), ` +
      `or --stale-ok to restore from the local view.`,
  );
}

function loadEntries() {
  if (!fs.existsSync(path.join(BACKUP_REPO, ".git"))) throw new Error(`Backup repo missing at ${BACKUP_REPO}.`);
  if (flag("--list")) {
    // Listing is a read-only DISCOVERY command: degrade to the local view with a
    // loud staleness warning instead of hard-failing offline. The hard gate stays
    // on the restore-selection paths, where a stale "latest" costs real data.
    try {
      syncOrDie();
    } catch (e) {
      log(`WARN: could not sync with the remote (${firstLine(e)}) — listing the LOCAL view, which may be stale.`);
    }
  } else {
    syncOrDie();
  }
  const entries = readAllManifests(BACKUP_REPO);
  if (entries.length === 0) throw new Error("no backups listed in any manifest.");
  return entries;
}

// A live board holds the whole store in memory and writes it back on every
// mutate — restoring under it is a silent full revert waiting to happen. The
// probe is FAIL-CLOSED: any HTTP response means a board is serving; a timeout
// means something ACCEPTED the connection and never answered (a busy or wedged
// board still holds the store in memory); ONLY a provable connection-level
// refusal (ECONNREFUSED and friends) — or an explicit override — lets the
// restore proceed. Everything else, including an unexpected probe error, refuses.
const SAFE_PROBE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EADDRNOTAVAIL"]);

function probeErrorCodes(e) {
  const codes = [];
  const cause = e && typeof e === "object" ? e.cause : undefined;
  if (cause && typeof cause === "object") {
    if (typeof cause.code === "string") codes.push(cause.code);
    // Happy-eyeballs failures surface as an AggregateError of per-address errors.
    if (Array.isArray(cause.errors)) {
      for (const sub of cause.errors) if (sub && typeof sub.code === "string") codes.push(sub.code);
    }
  }
  return codes;
}

async function assertNoLiveBoard() {
  if (flag("--allow-live-board")) {
    log("WARN: --allow-live-board — skipping the live-board guard. An in-flight write can clobber this restore.");
    return;
  }
  // A malformed BOARD_URL must be a loud config error, not a skipped guard.
  let base;
  try {
    base = new URL(BOARD_URL);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    throw new Error(
      `BOARD_URL (${BOARD_URL}) is not a valid http(s) URL — fix config/cos.env (or the BOARD_URL env) ` +
        `so the live-board guard can probe it. (--allow-live-board overrides.)`,
    );
  }
  let reason = null; // null = provably free; a string = why we consider it live
  try {
    await fetch(new URL("/api/cases", base), { signal: AbortSignal.timeout(1500) });
    reason = "it ANSWERED an HTTP request";
  } catch (e) {
    const codes = probeErrorCodes(e);
    if (codes.length > 0 && codes.every((c) => SAFE_PROBE_CODES.has(c))) {
      reason = null; // connection refused/unreachable on every address — the port is free
    } else {
      const name = e && typeof e === "object" && "name" in e ? String(e.name) : "unknown";
      reason =
        name === "TimeoutError" || name === "AbortError"
          ? "something ACCEPTED the connection but never answered (a busy or wedged board)"
          : `the probe failed ambiguously (${name}${codes.length ? `: ${codes.join(",")}` : ""}) — refusing fail-closed`;
    }
  }
  if (reason !== null) {
    throw new Error(
      `refusing --apply: a board may be live on ${BOARD_URL} — ${reason}. Stop it first (quit \`next dev\` / ` +
        `launchctl bootout), then re-run. Restoring under a live board lets an in-flight write clobber ` +
        `the restored file. (--allow-live-board overrides.)`,
    );
  }
}

// The code's SCHEMA_VERSION, scraped tolerantly from board/lib/types.ts (this
// .mjs cannot import the TS module). Used only for a WARNING — the store's own
// fail-closed guard (SchemaAheadError) is the real protection if a newer-schema
// snapshot is restored under older code.
function codeSchemaVersion() {
  try {
    const m = fs
      .readFileSync(path.join(REPO_ROOT, "board/lib/types.ts"), "utf8")
      .match(/export const SCHEMA_VERSION\s*(?::\s*number\s*)?=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const entries = loadEntries();
  if (flag("--list")) {
    log("available backups (newest first, all devices):");
    entries.forEach((b) =>
      log(
        `  ${b.date}  ${b.file}  ${(Number(b.encBytes ?? 0) / 1024).toFixed(0)}KB  ` +
          `${b.deviceId ?? b.host ?? "?"}${b.schemaVersion != null ? `  schema v${b.schemaVersion}` : ""}`,
      ),
    );
    return;
  }

  // Selection is DEVICE-SCOPED by default: "latest" means THIS machine's latest —
  // in a shared multi-device archive, blindly taking the global newest would
  // restore the OTHER machine's stores over this one's. Restoring another
  // producer's snapshot (the disaster-recovery / hub-handover flow) is explicit:
  // --device <id> picks a producer, --any-device takes the global newest.
  const producerOf = (b) => b.deviceId ?? b.host ?? "?";
  const isLocal = (b) => b.deviceId === DEVICE_ID || (!b.deviceId && b.host === os.hostname());
  const deviceArg = opt("--device");
  let pool = entries;
  if (deviceArg) {
    pool = entries.filter((b) => producerOf(b) === deviceArg);
    if (pool.length === 0) {
      throw new Error(
        `no snapshots from device "${deviceArg}". Producers in this archive: ` +
          `${[...new Set(entries.map(producerOf))].join(", ")} (see --list).`,
      );
    }
  } else if (!flag("--any-device")) {
    pool = entries.filter(isLocal);
    if (pool.length === 0) {
      throw new Error(
        `no snapshots from THIS device (${DEVICE_ID}) in the archive. Producers: ` +
          `${[...new Set(entries.map(producerOf))].join(", ")} — restoring another machine's snapshot ` +
          `is a cross-machine restore: pick one with --device <id>, or --any-device for the global newest.`,
      );
    }
  }

  const key = resolveKey();
  const dateArg = opt("--date");
  const entry = !dateArg ? pool[0] : pool.find((b) => String(b.file).includes(dateArg) || b.date === dateArg);
  if (!entry) throw new Error(`No backup matching ${dateArg || "(latest)"} in the selected device scope. Try --list.`);
  log(`selected: ${entry.file}  (${entry.date}, ${entry.scope.length} stores, from ${producerOf(entry)})`);

  const codeSchema = codeSchemaVersion();
  if (typeof entry.schemaVersion === "number" && codeSchema !== null && entry.schemaVersion > codeSchema) {
    log(
      `WARN: this snapshot's board store is schema v${entry.schemaVersion} but THIS checkout's code is v${codeSchema} — ` +
        `after restoring, the board will refuse writes (SchemaAheadError) until you git pull. ` +
        `Prefer restoring on a checkout whose code is >= the snapshot's schema.`,
    );
  } else if (typeof entry.schemaVersion === "number" && codeSchema === null) {
    log("note: could not read the code's SCHEMA_VERSION from board/lib/types.ts — skipping the newer-schema check.");
  }

  // verify: auth tag → sha256 → JSON parse, all before touching live data
  const blob = fs.readFileSync(path.join(BACKUP_REPO, entry.file));
  const tarball = decrypt(blob, key); // THROWS on wrong key / tamper
  const sha = crypto.createHash("sha256").update(tarball).digest("hex");
  if (sha !== entry.plaintextSha256) {
    throw new Error(`Integrity FAIL: sha256 ${sha.slice(0, 12)} != manifest ${entry.plaintextSha256.slice(0, 12)}`);
  }
  log("auth tag OK ✓   sha256 OK ✓");

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cos-restore-"));
  const tmpTar = path.join(stage, "b.tgz");
  fs.writeFileSync(tmpTar, tarball);
  sh("/usr/bin/tar", ["xzf", tmpTar, "-C", stage]);
  fs.rmSync(tmpTar, { force: true });
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        try {
          JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
          bad.push(p);
        }
      }
    }
  })(stage);
  if (bad.length) throw new Error("restored JSON invalid: " + bad.join(", "));

  // Strip the vault-worker queue from the stage: jobs.json carries claimed pids
  // and queued/working jobs from the PRODUCER machine — restored verbatim, the
  // new machine's runner would "requeue jobs orphaned by a crash" and re-run
  // Agent-SDK ingests that already landed.
  const stagedVaults = path.join(stage, "vault");
  if (fs.existsSync(stagedVaults)) {
    for (const name of fs.readdirSync(stagedVaults)) {
      const jobs = path.join(stagedVaults, name, ".cos", "jobs.json");
      if (fs.existsSync(jobs)) {
        fs.rmSync(jobs, { force: true });
        log(`stripped vault/${name}/.cos/jobs.json (producer's worker queue — never restored)`);
      }
    }
  }
  log(`JSON-verified ✓   extracted to ${stage}`);

  // Map each archived path to its DESTINATION path on THIS machine: the vault is
  // restored into the locally-configured VAULT_NAME even when the snapshot was
  // produced under a different name (the live my-personal-thoughts-vault gotcha).
  // entry.vaultPath (recorded by backup.mjs) is the authoritative vault-source
  // path; the startsWith scan is the fallback for legacy entries. The mapping
  // only applies when a vault name is actually CONFIGURED here — on a fresh DR
  // machine with no cos.env yet, VAULT_SCOPE_PATH is a silent legacy default and
  // renaming the snapshot's correctly-named vault into it would misfile it.
  const isVaultSrc = (rel) => (entry.vaultPath ? rel === entry.vaultPath : rel.startsWith("vault/"));
  const mappings = entry.scope
    .map((rel) => {
      const destRel = VAULT_NAME_CONFIGURED && isVaultSrc(rel) && rel !== VAULT_SCOPE_PATH ? VAULT_SCOPE_PATH : rel;
      return { srcRel: rel, destRel };
    })
    .filter(({ srcRel }) => fs.existsSync(path.join(stage, srcRel)));
  for (const { srcRel, destRel } of mappings) {
    if (srcRel !== destRel) log(`vault mapping: snapshot ${srcRel} → local ${destRel} (config/cos.env VAULT_NAME)`);
    else if (isVaultSrc(srcRel) && !VAULT_NAME_CONFIGURED && srcRel !== VAULT_SCOPE_PATH) {
      log(`note: no VAULT_NAME configured on this machine — restoring the vault verbatim as ${srcRel} (run setup-vault, or set VAULT_NAME, to map it).`);
    }
  }

  if (!flag("--apply")) {
    // The stage is deliberately LEFT on disk (tmpdir) so a dry run can be inspected.
    log("\nDRY RUN — verified only, nothing written. Re-run with --apply to restore over live data.");
    log("(A pre-restore snapshot of your current live state is taken automatically on --apply.)");
    return;
  }

  // The live-board guard runs HERE — after verification, immediately before the
  // pre-restore snapshot + copy, so the whole mutating window is covered.
  await assertNoLiveBoard();

  // snapshot CURRENT live state first (restore is reversible) — the DESTINATION
  // paths (what this apply will overwrite), not the producer's paths.
  const safe = path.join(os.homedir(), "cos-recovery", "pre-restore-" + new Date().toISOString().replace(/[:.]/g, "-"));
  for (const { destRel } of mappings) {
    const live = path.join(REPO_ROOT, destRel);
    if (fs.existsSync(live)) {
      const dst = path.join(safe, destRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      sh("/bin/cp", ["-R", live, dst]);
    }
  }
  log("current live state snapshotted → " + safe);

  for (const { srcRel, destRel } of mappings) {
    const src = path.join(stage, srcRel);
    const dst = path.join(REPO_ROOT, destRel);

    // config/settings.json is a MIXED-scope file: shared prefs ride the snapshot,
    // but the Obsidian registration is machine-local — preserve this machine's.
    if (destRel === "config/settings.json" && fs.existsSync(dst) && mergeSettings(src, dst)) continue;

    if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    sh("/bin/cp", ["-R", src, dst]);
    log("restored " + destRel + (srcRel !== destRel ? `  (from snapshot ${srcRel})` : ""));
  }
  fs.rmSync(stage, { recursive: true, force: true });
  log("\n✅ restore complete. Restart services: launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-* and your board dev server.");
}

// Hold the SAME single-flight lock backup.mjs uses: even a "read-only" run
// mutates the clone (fetch / ff-merge in syncOrDie) and must never interleave
// with a concurrent backup run's rebase/commit/push on the same repo.
async function lockedMain() {
  const canLock = fs.existsSync(BACKUP_REPO);
  if (canLock && !acquireRepoLock(BACKUP_REPO)) {
    throw new Error("a backup run is in progress on this repo (.backup.lock held) — retry in a minute.");
  }
  try {
    await main();
  } finally {
    if (canLock) releaseRepoLock(BACKUP_REPO);
  }
}

lockedMain().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
