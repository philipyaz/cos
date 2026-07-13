#!/usr/bin/env node
// backup-hardening.mjs — hermetic end-to-end test of the multi-producer backup
// pipeline (backup/backup.mjs + backup/restore.mjs). NO board, NO Keychain, NO
// network, NO live data: everything runs in a mktemp sandbox — a synthetic
// repo-root skeleton (COS_BACKUP_REPO_ROOT), a local BARE git repo as the
// "remote", per-device clones (COS_BACKUP_REPO + COS_BACKUP_ALLOW_NONDEFAULT=1,
// the documented disposable-repo escape hatch), COS_BACKUP_KEY for the key, and
// HOME pointed into the sandbox so the pre-restore snapshot never touches the
// real ~/cos-recovery.
//
// Asserts the PR-2 hardening contract:
//   • per-device manifests: producer A writes ONLY manifests/<deviceId>.json
//     (deviceId + schemaVersion + vaultPath recorded); no MANIFEST.json minted;
//   • fetch-before-push: a producer whose clone is BEHIND the remote (another
//     device pushed) converges and pushes cleanly (exit 0, not the old
//     permanent exit-2 divergence);
//   • producer admission: a second device with the SAME key joins; a device
//     with a WRONG key is REFUSED before it can split the archive;
//   • restore reads the UNION of all manifests (--list shows every producer);
//   • restore hard-fails on an unreachable remote (stale clone must not pick
//     "latest") unless --stale-ok;
//   • restore --apply REFUSES while anything answers on BOARD_URL
//     (--allow-live-board overrides);
//   • cross-machine apply: the snapshot's vault (vault/test-vault-a) lands in
//     the LOCAL vault name (vault/test-vault-b), the producer's
//     .cos/jobs.json worker queue is STRIPPED, and config/settings.json keeps
//     this machine's obsidianVaultId/obsidianVaultName while restoring the rest.
//
// Run directly (node tests/backup-hardening.mjs) or via tests/run.sh step [13e].
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COS_ROOT = path.resolve(HERE, "..");
const BACKUP_MJS = path.join(COS_ROOT, "backup", "backup.mjs");
const RESTORE_MJS = path.join(COS_ROOT, "backup", "restore.mjs");

const KEY = "test-recovery-key-not-a-real-secret";

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const git = (repo, ...a) => sh("git", ["-C", repo, ...a]);

// Run a backup/restore script with a per-device env; capture exit code + output.
// ASYNC (execFile, not execFileSync): the live-board scenario needs THIS process's
// event loop free so its http server can actually answer the child's probe.
function runScript(script, { repoRoot, backupRepo, deviceId, vaultName, key = KEY, extraEnv = {}, argv = [] }) {
  const env = {
    ...process.env,
    COS_BACKUP_REPO_ROOT: repoRoot,
    COS_BACKUP_REPO: backupRepo,
    COS_BACKUP_ALLOW_NONDEFAULT: "1",
    COS_BACKUP_KEY: key,
    COS_DEVICE_ID: deviceId,
    VAULT_NAME: vaultName,
    HOME: path.join(TMP, "home"), // pre-restore snapshots land in the sandbox
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile("node", [script, ...argv], { env, cwd: COS_ROOT, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        resolve({ code: typeof err.code === "number" ? err.code : 1, out: `${stdout ?? ""}${stderr ?? ""}` });
      } else {
        resolve({ code: 0, out: `${stdout ?? ""}${stderr ?? ""}` });
      }
    });
  });
}

// A synthetic machine root: the stores backup.mjs scopes, nothing else.
function makeRoot(dir, { vaultName, obsidianVaultId }) {
  fs.mkdirSync(path.join(dir, "board", "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "board", "data", "cases.json"),
    JSON.stringify({ schemaVersion: 14, version: 5, cases: [], messages: [] }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "settings.json"),
    JSON.stringify({ principalEmail: "owner@example.com", obsidianVaultId, obsidianVaultName: vaultName }, null, 2),
  );
  const vault = path.join(dir, "vault", vaultName);
  fs.mkdirSync(path.join(vault, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(vault, "wiki", "note.md"), "# knowledge survives machines\n");
  fs.mkdirSync(path.join(vault, ".cos"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, ".cos", "jobs.json"),
    JSON.stringify({ jobs: [{ id: "J-1", status: "working", pid: 4242 }] }, null, 2),
  );
}

// Clone the bare remote as one device's backup repo, with a usable git identity
// and an upstream (mirrors the skill's §1.2 seed).
function cloneBackupRepo(dir) {
  sh("git", ["clone", "--quiet", REMOTE, dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "backup-hardening-test");
  return dir;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cos-backup-hardening-"));
const REMOTE = path.join(TMP, "remote.git");

async function main() {
  console.log(`backup-hardening · sandbox=${TMP}`);
  fs.mkdirSync(path.join(TMP, "home"), { recursive: true });

  // ── the "GitHub" remote + the founding producer's clone ─────────────────────
  sh("git", ["init", "--quiet", "--bare", REMOTE]);
  const repoA = cloneBackupRepo(path.join(TMP, "backupA"));
  fs.writeFileSync(path.join(repoA, "README.md"), "# test archive\n");
  git(repoA, "add", "-A");
  git(repoA, "commit", "-q", "-m", "init");
  git(repoA, "push", "-q", "-u", "origin", "HEAD");

  const rootA = path.join(TMP, "rootA");
  makeRoot(rootA, { vaultName: "test-vault-a", obsidianVaultId: "OBSIDIAN-A" });
  const devA = { repoRoot: rootA, backupRepo: repoA, deviceId: "device-a", vaultName: "test-vault-a" };

  // ── [1] founding backup: per-device manifest, deviceId + schemaVersion ──────
  let r = await runScript(BACKUP_MJS, devA);
  check(r.code === 0, `device A first backup exits 0 (got ${r.code})`);
  const manAPath = path.join(repoA, "manifests", "device-a.json");
  check(fs.existsSync(manAPath), "manifests/device-a.json written");
  check(!fs.existsSync(path.join(repoA, "MANIFEST.json")), "no legacy MANIFEST.json minted");
  const manA = JSON.parse(fs.readFileSync(manAPath, "utf8"));
  const e0 = manA.backups?.[0] ?? {};
  check(e0.deviceId === "device-a", `entry records deviceId (got ${JSON.stringify(e0.deviceId)})`);
  check(e0.schemaVersion === 14, `entry records the store's schemaVersion 14 (got ${e0.schemaVersion})`);
  check(e0.vaultPath === "vault/test-vault-a", `entry records vaultPath (got ${JSON.stringify(e0.vaultPath)})`);
  const pushedClean = git(repoA, "rev-list", "--left-right", "--count", "HEAD...@{u}").trim();
  check(pushedClean === "0\t0", `device A is in sync with the remote after push (got "${pushedClean}")`);
  // The machine-local admission marker exists and never enters git.
  check(fs.existsSync(path.join(repoA, ".backup.admitted")), "machine-local admission marker written");
  const statusA = git(repoA, "status", "--porcelain");
  check(!/\.backup\.admitted/.test(statusA), "the admission marker is gitignored (never committed)");

  // ── [2] second producer, SAME key: admission passes, manifests coexist ──────
  const repoB = cloneBackupRepo(path.join(TMP, "backupB"));
  const rootB = path.join(TMP, "rootB");
  makeRoot(rootB, { vaultName: "test-vault-b", obsidianVaultId: "OBSIDIAN-B" });
  const devB = { repoRoot: rootB, backupRepo: repoB, deviceId: "device-b", vaultName: "test-vault-b" };
  r = await runScript(BACKUP_MJS, devB);
  check(r.code === 0, `device B (same key) is admitted and backs up (exit ${r.code})`);
  check(/producer admission: decrypt-verified/.test(r.out), "admission decrypt-verified A's newest snapshot");
  check(fs.existsSync(path.join(repoB, "manifests", "device-b.json")), "manifests/device-b.json written");

  // ── [3] fetch-before-push: A's stale clone converges instead of exit-2 ──────
  // B's push above moved the remote; A's clone is now BEHIND. The old pipeline
  // would commit on the stale branch and fail the push forever (exit 2).
  r = await runScript(BACKUP_MJS, devA);
  check(r.code === 0, `device A backs up from a BEHIND clone with exit 0 (got ${r.code}) — no permanent divergence`);
  const logA = git(repoA, "log", "--oneline", "-5");
  check(fs.readdirSync(path.join(repoA, "snapshots")).length >= 2, "A's clone holds its own snapshots");
  check(fs.existsSync(path.join(repoA, "manifests", "device-b.json")), `A's clone gained B's manifest via the pre-run fetch (log: ${logA.split("\n")[0]})`);

  // ── [4] WRONG key: producer admission refuses before the archive splits ─────
  const repoC = cloneBackupRepo(path.join(TMP, "backupC"));
  const rootC = path.join(TMP, "rootC");
  makeRoot(rootC, { vaultName: "test-vault-c", obsidianVaultId: "OBSIDIAN-C" });
  r = await runScript(BACKUP_MJS, { repoRoot: rootC, backupRepo: repoC, deviceId: "device-c", vaultName: "test-vault-c", key: "the-wrong-key" });
  check(r.code !== 0, `wrong-key producer is refused (exit ${r.code})`);
  check(/producer admission FAILED/.test(r.out), "refusal names producer admission + the fix");
  check(!fs.existsSync(path.join(repoC, "manifests", "device-c.json")), "no manifest written for the refused producer");

  // ── [4b] deviceId COLLISION cannot bypass admission: a replacement machine that
  // inherits device A's id (the hostname-fallback hazard) but holds a wrong key is
  // still refused — admission keys on the machine-local marker, not the shared manifest.
  const repoC2 = cloneBackupRepo(path.join(TMP, "backupC2"));
  r = await runScript(BACKUP_MJS, { repoRoot: rootC, backupRepo: repoC2, deviceId: "device-a", vaultName: "test-vault-c", key: "the-wrong-key" });
  check(r.code !== 0 && /producer admission FAILED/.test(r.out), `a colliding deviceId with a wrong key is still refused (exit ${r.code})`);

  // ── [4c] corrupt own manifest: recovered from git HEAD, catalog never clobbered ─
  const preCorrupt = JSON.parse(fs.readFileSync(manAPath, "utf8")).backups.length;
  fs.writeFileSync(manAPath, "{ this is not json");
  r = await runScript(BACKUP_MJS, devA);
  check(r.code === 0, `backup over a corrupt own manifest exits 0 (got ${r.code})`);
  check(/recovered .* from git HEAD|recovered \d+ entries/.test(r.out), "corruption recovered from git HEAD (logged)");
  const postCorrupt = JSON.parse(fs.readFileSync(manAPath, "utf8")).backups.length;
  check(postCorrupt === preCorrupt + 1, `catalog preserved: ${preCorrupt}+1 entries after recovery (got ${postCorrupt})`);

  // ── [5] restore --list reads the UNION of every producer's manifest ─────────
  const repoR = cloneBackupRepo(path.join(TMP, "backupRestore"));
  const rootR = path.join(TMP, "rootR");
  makeRoot(rootR, { vaultName: "test-vault-b", obsidianVaultId: "OBSIDIAN-LIVE" });
  const devR = { repoRoot: rootR, backupRepo: repoR, deviceId: "device-r", vaultName: "test-vault-b" };
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--list"] });
  check(r.code === 0, `restore --list exits 0 (got ${r.code})`);
  check(/device-a/.test(r.out) && /device-b/.test(r.out), "--list shows snapshots from BOTH producers");
  check(/schema v14/.test(r.out), "--list surfaces the recorded schemaVersion");

  // ── [5b] device-scoped selection: "latest" means THIS device's latest ────────
  r = await runScript(RESTORE_MJS, { ...devR, argv: [] });
  check(r.code !== 0 && /no snapshots from THIS device/.test(r.out), "plain restore on a device with no snapshots refuses and names --device/--any-device");
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--device", "device-b"] });
  check(r.code === 0 && /from device-b/.test(r.out) && /DRY RUN/.test(r.out), "--device device-b selects that producer's snapshot");

  // ── [6] stale-clone guard: unreachable remote hard-fails; --list degrades ────
  git(repoR, "remote", "set-url", "origin", path.join(TMP, "nonexistent.git"));
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--any-device"] });
  check(r.code !== 0, `restore against an unreachable remote is refused (exit ${r.code})`);
  check(/cannot reach the backup remote/.test(r.out), "refusal explains the stale-clone hazard");
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--list"] });
  check(r.code === 0 && /WARN: could not sync/.test(r.out) && /device-a/.test(r.out), "--list degrades to the LOCAL view with a staleness warning");
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--stale-ok", "--any-device"] });
  check(r.code === 0 && /DRY RUN/.test(r.out), "--stale-ok dry-run verifies from the local view");
  git(repoR, "remote", "set-url", "origin", REMOTE);

  // ── [7] live-board guard: anything answering on BOARD_URL blocks --apply ────
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const boardUrl = `http://127.0.0.1:${server.address().port}`;
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--apply", "--any-device"], extraEnv: { BOARD_URL: boardUrl } });
  check(r.code !== 0, `--apply with a live board is refused (exit ${r.code})`);
  check(/ANSWERED an HTTP request/.test(r.out), "refusal names the live board + the fix");
  await new Promise((resolve) => server.close(resolve));

  // A malformed BOARD_URL is a loud config error, never a skipped guard.
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--apply", "--any-device"], extraEnv: { BOARD_URL: "localhost:3000" } });
  check(r.code !== 0 && /not a valid http/.test(r.out), "a scheme-less BOARD_URL refuses instead of skipping the guard");

  // ── [8] cross-machine --apply: vault mapping, jobs.json strip, settings merge ─
  // rootR is "machine B": local vault name test-vault-b, its own Obsidian identity.
  // The latest snapshot is device A's (vault/test-vault-a inside the archive).
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--apply", "--any-device"], extraEnv: { BOARD_URL: boardUrl } });
  check(r.code === 0, `--apply succeeds once nothing answers on BOARD_URL (exit ${r.code})`);
  check(
    fs.existsSync(path.join(rootR, "vault", "test-vault-b", "wiki", "note.md")),
    "snapshot vault content landed in the LOCAL vault name (test-vault-a → test-vault-b)",
  );
  check(!fs.existsSync(path.join(rootR, "vault", "test-vault-a")), "the producer's vault name was NOT recreated locally");
  check(
    !fs.existsSync(path.join(rootR, "vault", "test-vault-b", ".cos", "jobs.json")),
    "the producer's .cos/jobs.json worker queue was stripped",
  );
  const settings = JSON.parse(fs.readFileSync(path.join(rootR, "config", "settings.json"), "utf8"));
  check(settings.obsidianVaultId === "OBSIDIAN-LIVE", `machine-local obsidianVaultId preserved (got ${JSON.stringify(settings.obsidianVaultId)})`);
  check(settings.principalEmail === "owner@example.com", "shared settings keys restored from the snapshot");
  const cases = JSON.parse(fs.readFileSync(path.join(rootR, "board", "data", "cases.json"), "utf8"));
  check(cases.schemaVersion === 14, "board store restored");
  const preRestore = path.join(TMP, "home", "cos-recovery");
  check(fs.existsSync(preRestore), "pre-restore snapshot landed under the sandboxed $HOME/cos-recovery");

  if (failures > 0) {
    console.error(`backup-hardening: ${failures} check(s) failed (sandbox kept at ${TMP})`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("backup-hardening: all checks passed");
}

main().catch((e) => {
  console.error("backup-hardening: fatal", e);
  console.error(`(sandbox kept at ${TMP})`);
  process.exit(1);
});
