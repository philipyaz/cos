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
// Asserts the hardening + HUB-lease contract (multi-device PRs 2 + 3). The
// archive is SINGLE-PRODUCER by lease: exactly one machine (the hub) produces;
// a second machine joins the archive but is lease-refused (exit 4) until it
// legitimately takes over a stale lease — the modeled hub handover.
//   • per-device manifests: a producer writes ONLY manifests/<deviceId>.json
//     (deviceId + schemaVersion + vaultPath recorded); no MANIFEST.json minted;
//     a corrupt manifest is recovered from git HEAD, never clobbered;
//   • HUB.json lease: the founder claims it; a FRESH lease held elsewhere makes
//     a producer QUARANTINE its state once (orphan/<id>-<ts>.enc) and exit 4;
//     a STALE lease (>26h) is claimed with an epoch bump; the demoted old hub
//     orphans + exits 4 (and its clone converged with the remote to learn it);
//   • producer admission: same key joins (decrypt-verify); a WRONG key is
//     refused — even under a COLLIDING deviceId (the marker is machine-local);
//   • a SPOKE never produces (COS_DEVICE_ROLE=spoke → exit 1);
//   • restore reads the UNION of all manifests; selection is DEVICE-SCOPED
//     (--device / --any-device for cross-machine); orphans are NOT in the catalog;
//   • restore hard-fails on an unreachable remote (--stale-ok escapes; --list
//     degrades to the local view with a warning);
//   • restore --apply REFUSES while anything answers on BOARD_URL (fail-closed,
//     incl. a scheme-less URL; --allow-live-board overrides);
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
  // The founder claimed the hub lease.
  const lease1 = JSON.parse(fs.readFileSync(path.join(repoA, "HUB.json"), "utf8"));
  check(lease1.deviceId === "device-a" && lease1.epoch === 1, `founder claimed the HUB lease (holder ${lease1.deviceId}, epoch ${lease1.epoch})`);

  // ── [1c] corrupt own manifest: recovered from git HEAD, catalog never clobbered ─
  const preCorrupt = JSON.parse(fs.readFileSync(manAPath, "utf8")).backups.length;
  fs.writeFileSync(manAPath, "{ this is not json");
  r = await runScript(BACKUP_MJS, devA);
  check(r.code === 0, `backup over a corrupt own manifest exits 0 (got ${r.code})`);
  check(/recovered .* from git HEAD|recovered \d+ entries/.test(r.out), "corruption recovered from git HEAD (logged)");
  const postCorrupt = JSON.parse(fs.readFileSync(manAPath, "utf8")).backups.length;
  check(postCorrupt === preCorrupt + 1, `catalog preserved: ${preCorrupt}+1 entries after recovery (got ${postCorrupt})`);

  // ── [2] second machine, SAME key: ADMITTED to the archive but LEASE-refused —
  // A holds a fresh lease, so B quarantines its state once and exits 4.
  const repoB = cloneBackupRepo(path.join(TMP, "backupB"));
  const rootB = path.join(TMP, "rootB");
  makeRoot(rootB, { vaultName: "test-vault-b", obsidianVaultId: "OBSIDIAN-B" });
  const devB = { repoRoot: rootB, backupRepo: repoB, deviceId: "device-b", vaultName: "test-vault-b" };
  r = await runScript(BACKUP_MJS, devB);
  check(r.code === 4, `device B (same key) is admitted but lease-refused (exit ${r.code})`);
  check(/producer admission: decrypt-verified/.test(r.out), "admission decrypt-verified A's newest snapshot");
  check(/LEASE HELD ELSEWHERE/.test(r.out), "the refusal names the lease holder");
  const orphansB = fs.existsSync(path.join(repoB, "orphan")) ? fs.readdirSync(path.join(repoB, "orphan")).filter((f) => f.startsWith("device-b-")) : [];
  check(orphansB.length === 1, `B's stray state was quarantined once (orphan/${orphansB[0] ?? "MISSING"})`);
  check(!fs.existsSync(path.join(repoB, "manifests", "device-b.json")), "no manifest entry for the lease-refused producer");
  check(fs.existsSync(path.join(repoB, ".backup.orphaned")), "machine-local orphaned marker written");

  // ── [2b] a second lease-refused run stays QUIET: exit 4, no second orphan ────
  r = await runScript(BACKUP_MJS, devB);
  check(r.code === 4, `repeat run on the demoted machine exits 4 (got ${r.code})`);
  const orphansB2 = fs.readdirSync(path.join(repoB, "orphan")).filter((f) => f.startsWith("device-b-"));
  check(orphansB2.length === 1, "no re-orphaning on subsequent runs (still exactly one quarantine)");

  // ── [2c] --claim FORCE-takes A's still-FRESH lease (the hub-handover takeover) ─
  // Without --claim, B is refused while A's lease is fresh (exit 4, proven above).
  // WITH --claim, B force-takes the FRESH lease (epoch bump) and produces — the exact
  // cutover step hub-handover prescribes. Self-contained: it hands the lease back to A
  // afterwards so the [3] natural-stale-takeover baseline (A holds it) is preserved.
  const aEpoch = JSON.parse(fs.readFileSync(path.join(repoB, "HUB.json"), "utf8")).epoch;
  r = await runScript(BACKUP_MJS, { ...devB, argv: ["--claim"] });
  check(r.code === 0, `device B --claim force-takes the FRESH lease and produces (exit ${r.code})`);
  check(/FORCED takeover \(--claim\)/.test(r.out), "the forced takeover is logged");
  const forced = JSON.parse(fs.readFileSync(path.join(repoB, "HUB.json"), "utf8"));
  check(forced.deviceId === "device-b" && forced.epoch === aEpoch + 1, `lease now held by device-b, epoch bumped (${aEpoch}→${forced.epoch})`);
  // The old hub A, run once now, sees B's fresh lease → exit 4 (the digest-discipline
  // safety net is reachable ONLY because B actually holds the lease — the review's point).
  r = await runScript(BACKUP_MJS, devA);
  check(r.code === 4, `the old hub A stands down (exit ${r.code}) — exit-4 safety net reachable post-claim`);
  // Hand the lease back to A (--claim from A's clone) so [3] starts from "A holds it".
  r = await runScript(BACKUP_MJS, { ...devA, argv: ["--claim"] });
  check(r.code === 0, "A reclaims the lease to restore the [3] baseline");
  await runScript(BACKUP_MJS, { ...devB }); // B converges (sees A's fresh lease → exit 4), leaving repoB current

  // ── [3] the NATURAL HANDOVER: A's lease goes stale (>26h), B claims it (no --claim) ──
  // Stale-ify by rewriting HUB.json's renewedAt 30h into the past and pushing.
  const staleBase = JSON.parse(fs.readFileSync(path.join(repoB, "HUB.json"), "utf8"));
  const staleLease = { ...staleBase, renewedAt: new Date(Date.now() - 30 * 3600_000).toISOString() };
  fs.writeFileSync(path.join(repoB, "HUB.json"), JSON.stringify(staleLease, null, 2) + "\n");
  git(repoB, "add", "HUB.json");
  git(repoB, "commit", "-q", "-m", "test: stale-ify the lease");
  git(repoB, "push", "-q", "origin", "HEAD");

  r = await runScript(BACKUP_MJS, devB);
  check(r.code === 0, `device B claims the STALE lease and produces (exit ${r.code})`);
  check(/taking over a STALE lease/.test(r.out), "the natural (non-forced) takeover is logged");
  const lease2 = JSON.parse(fs.readFileSync(path.join(repoB, "HUB.json"), "utf8"));
  check(lease2.deviceId === "device-b" && lease2.epoch === staleBase.epoch + 1, `lease now held by device-b, epoch bumped (${staleBase.epoch}→${lease2.epoch})`);
  check(!fs.existsSync(path.join(repoB, ".backup.orphaned")), "the orphaned marker cleared on re-admission as hub");
  check(fs.existsSync(path.join(repoB, "manifests", "device-b.json")), "manifests/device-b.json written by the new hub");

  // ── [4] the DEMOTED old hub: converges, sees B's fresh lease, orphans, exit 4 ─
  r = await runScript(BACKUP_MJS, devA);
  check(r.code === 4, `the demoted old hub exits 4 (got ${r.code})`);
  const orphansA = fs.existsSync(path.join(repoA, "orphan")) ? fs.readdirSync(path.join(repoA, "orphan")).filter((f) => f.startsWith("device-a-")) : [];
  // >= 1 (not == 1): [2c] already exercised one A demotion cycle, so A has orphaned
  // once per stand-down. The point here is that a demoted hub quarantines its state.
  check(orphansA.length >= 1, `the old hub quarantined its stray state (${orphansA.length} orphan(s))`);
  check(fs.existsSync(path.join(repoA, "manifests", "device-b.json")), "A's clone converged with the remote (gained B's manifest) before deciding");

  // ── [5] WRONG key: producer admission refuses before the archive splits ─────
  const repoC = cloneBackupRepo(path.join(TMP, "backupC"));
  const rootC = path.join(TMP, "rootC");
  makeRoot(rootC, { vaultName: "test-vault-c", obsidianVaultId: "OBSIDIAN-C" });
  r = await runScript(BACKUP_MJS, { repoRoot: rootC, backupRepo: repoC, deviceId: "device-c", vaultName: "test-vault-c", key: "the-wrong-key" });
  check(r.code !== 0, `wrong-key producer is refused (exit ${r.code})`);
  check(/producer admission FAILED/.test(r.out), "refusal names producer admission + the fix");
  check(!fs.existsSync(path.join(repoC, "manifests", "device-c.json")), "no manifest written for the refused producer");

  // ── [5b] deviceId COLLISION cannot bypass admission: a replacement machine that
  // inherits device A's id (the hostname-fallback hazard) but holds a wrong key is
  // still refused — admission keys on the machine-local marker, not the shared manifest.
  const repoC2 = cloneBackupRepo(path.join(TMP, "backupC2"));
  r = await runScript(BACKUP_MJS, { repoRoot: rootC, backupRepo: repoC2, deviceId: "device-a", vaultName: "test-vault-c", key: "the-wrong-key" });
  check(r.code !== 0 && /producer admission FAILED/.test(r.out), `a colliding deviceId with a wrong key is still refused (exit ${r.code})`);

  // ── [5c] a SPOKE never produces ───────────────────────────────────────────────
  r = await runScript(BACKUP_MJS, { ...devB, extraEnv: { COS_DEVICE_ROLE: "spoke" } });
  check(r.code === 1 && /SPOKE/.test(r.out), `role=spoke is refused outright (exit ${r.code})`);

  // ── [5d] the lease NEVER force-clobbers remote history from a diverged clone ──
  // The former CAS force-push discarded remote-only snapshot commits. Reproduce a
  // divergence: device-b (the current hub) commits a stray local commit that is NOT
  // on the remote, while the remote gains a new commit from elsewhere; a renew/claim
  // run must converge or exit 2 — NEVER drop the remote's commit.
  const remoteHeadBefore = git(repoB, "rev-parse", "origin/HEAD").trim();
  const remoteCountBefore = Number(git(repoB, "rev-list", "--count", "origin/HEAD").trim());
  // Another clone pushes a commit to the remote (a snapshot device-b hasn't seen).
  const repoOther = cloneBackupRepo(path.join(TMP, "backupOther"));
  fs.writeFileSync(path.join(repoOther, "snapshots", "cos-backup-other.enc"), "x");
  git(repoOther, "add", "-A");
  git(repoOther, "commit", "-q", "-m", "other: a snapshot device-b has not seen");
  git(repoOther, "push", "-q", "origin", "HEAD");
  const otherSha = git(repoOther, "rev-parse", "HEAD").trim();
  // device-b makes a stray unpushed local commit → its clone is now diverged.
  fs.writeFileSync(path.join(repoB, "stray.txt"), "diverge");
  git(repoB, "add", "-A");
  git(repoB, "commit", "-q", "-m", "b: stray local commit (unpushed)");
  // A backup run from the diverged clone (it will try to renew/claim + snapshot).
  r = await runScript(BACKUP_MJS, devB);
  const remoteHasOther = git(repoB, "branch", "-r", "--contains", otherSha).trim() !== "";
  check(remoteHasOther, `the remote still contains the other clone's commit after a diverged run (exit ${r.code}) — no force-clobber`);
  const remoteCountAfter = Number(git(repoOther, "rev-list", "--count", "origin/HEAD").trim());
  check(remoteCountAfter >= remoteCountBefore + 1, `remote history only GREW (${remoteCountBefore}→${remoteCountAfter}), never rewound`);
  check(remoteHeadBefore !== git(repoOther, "rev-parse", "origin/HEAD").trim() || remoteCountAfter > remoteCountBefore, "remote head advanced, not replaced");

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
  // rootR is a machine with local vault name test-vault-b and its own Obsidian
  // identity, explicitly restoring DEVICE A's newest snapshot (vault/test-vault-a
  // inside the archive) — the cross-machine flow.
  r = await runScript(RESTORE_MJS, { ...devR, argv: ["--apply", "--device", "device-a"], extraEnv: { BOARD_URL: boardUrl } });
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
