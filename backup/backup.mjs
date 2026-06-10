#!/usr/bin/env node
// Daily backup: archive the live stores → AES-256-GCM encrypt → commit + push to
// the PRIVATE GitHub backup repo. Git history is the immutable, off-site, versioned
// record (you cannot silently overwrite the past — that was the whole failure mode).
//
// Run by the launchd job (backup/deploy/com.chiefofstaff.backup.plist.template) or
// by hand:  node backup/backup.mjs   (also: the /backup-recovery skill, "backup now").
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, BACKUP_REPO, EXPECTED_BACKUP_REPO, SCOPE, VAULT_SCOPE_PATH } from "./config.mjs";
import { encrypt } from "./lib/crypto.mjs";
import { resolveKey } from "./lib/key.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

// Single-flight lock: serializes the THREE callers of this script — the launchd
// 03:30 agent, the board's manual "Back up now", and the board's opportunistic
// top-up — so two runs can never interleave a git add/commit/push on the same repo.
// `wx` is an atomic create-or-fail; a lock older than this is considered orphaned
// (a crashed/killed run) and reclaimed. Kept inside backup.mjs because launchd runs
// this file DIRECTLY, never through any board code — the board-side gate cannot
// serialize against the cron run, only this lock can.
const LOCK_PATH = path.join(BACKUP_REPO, ".backup.lock");
const LOCK_STALE_MS = 120_000;

// Fail-CLOSED sandbox/identity guard. The real off-site backup repo is the one
// configured in config/cos.env (BACKUP_REPO), defaulting to ~/.cos-backups; anything
// else (a test sandbox, a COS_BACKUP_REPO override) must NOT trigger a real encrypted
// snapshot + push. EXPECTED_BACKUP_REPO is config-derived so a user who relocates the
// repo in cos.env is still allowed; a COS_BACKUP_REPO=/tmp override makes the effective
// repo differ from EXPECTED and is refused. An explicit escape hatch
// (COS_BACKUP_ALLOW_NONDEFAULT=1) is reserved for tests that deliberately point at a
// disposable repo. This makes an accidental test-context invocation inert.
function assertDefaultRepoOrRefuse() {
  if (BACKUP_REPO === EXPECTED_BACKUP_REPO) return;
  if (process.env.COS_BACKUP_ALLOW_NONDEFAULT === "1") return;
  log(
    `refusing to run: BACKUP_REPO is ${BACKUP_REPO}, not the expected ${EXPECTED_BACKUP_REPO} ` +
      `(config/cos.env BACKUP_REPO, or the ~/.cos-backups default). ` +
      `Set COS_BACKUP_ALLOW_NONDEFAULT=1 only for a deliberate disposable-repo test.`,
  );
  process.exit(1);
}

function main() {
  // Identity gate FIRST — before we touch the keychain, the repo, or any store.
  assertDefaultRepoOrRefuse();

  // Acquire the single-flight lock. Reclaim it if it's orphaned (older than 120s),
  // otherwise another run owns it — log + exit with code 3 ("busy"). Code 3 is a BENIGN
  // skip, NOT a failure: a duplicate run that collided with an in-flight one did nothing
  // wrong. The board run-gate maps exit 3 -> skipped:'busy', and the board's health view
  // treats a (rare) launchd 03:30 lock-skip as benign. The whole body runs inside a
  // finally that releases the lock so a throw can't leave it wedged.
  let haveLock = false;
  try {
    fs.openSync(LOCK_PATH, "wx");
    haveLock = true;
  } catch (e) {
    if (e && e.code === "EEXIST") {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(LOCK_PATH).mtimeMs;
      } catch {
        /* lock vanished between open and stat — treat as reclaimable */
      }
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        // Orphaned lock from a crashed run — reclaim it.
        log("reclaiming stale backup lock (older than 120s)");
        try {
          fs.rmSync(LOCK_PATH, { force: true });
          fs.openSync(LOCK_PATH, "wx");
          haveLock = true;
        } catch {
          log("another backup in progress, skipping");
          process.exitCode = 3; // busy: lock held by a live run — a benign skip, not a failure
          return;
        }
      } else {
        log("another backup in progress, skipping");
        process.exitCode = 3; // busy: lock held by a live run — a benign skip, not a failure
        return;
      }
    } else {
      throw e;
    }
  }

  try {
    runBackup();
  } finally {
    if (haveLock) fs.rmSync(LOCK_PATH, { force: true });
  }
}

function runBackup() {
  const key = resolveKey(); // throws with guidance if missing

  if (!fs.existsSync(path.join(BACKUP_REPO, ".git"))) {
    throw new Error(
      `Backup repo not initialised at ${BACKUP_REPO}. Run the /backup-recovery skill (setup) first.`,
    );
  }

  const present = SCOPE.filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
  if (present.length === 0) throw new Error("nothing in scope exists — refusing to write an empty backup");
  // Loudly flag a configured-but-missing vault. Resolving the vault from VAULT_NAME exists
  // precisely so the ACTIVE vault is never SILENTLY dropped — if it's not on disk, say so
  // (the line shows up in backup.out.log + the /backups log tails) rather than omitting it
  // quietly. We still back up everything else that IS present.
  if (!present.includes(VAULT_SCOPE_PATH)) {
    log(`WARN: configured vault ${VAULT_SCOPE_PATH} not found under the repo — it is NOT in this snapshot. Check config/cos.env VAULT_NAME.`);
  }
  log("scope:", present.join(", "));

  // 1) gzip-tar the scope (deterministic-ish; content is what matters)
  const tmpTar = path.join(os.tmpdir(), `cos-backup-${process.pid}.tgz`);
  sh("/usr/bin/tar", ["czf", tmpTar, "-C", REPO_ROOT, ...present]);
  const tarball = fs.readFileSync(tmpTar);
  fs.rmSync(tmpTar, { force: true });
  const sha = crypto.createHash("sha256").update(tarball).digest("hex");

  // 2) encrypt
  const blob = encrypt(tarball, key);

  // 3) write into the backup repo (timestamped; one file per run, never overwritten)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const date = stamp.slice(0, 10);
  const snapDir = path.join(BACKUP_REPO, "snapshots");
  fs.mkdirSync(snapDir, { recursive: true });
  const fname = `cos-backup-${stamp}.enc`;
  fs.writeFileSync(path.join(snapDir, fname), blob);

  // 4) manifest (newest-first), with integrity sha for restore-time verification
  const manPath = path.join(BACKUP_REPO, "MANIFEST.json");
  let man = { backups: [] };
  try {
    man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  } catch {
    /* first run */
  }
  man.backups.unshift({
    file: `snapshots/${fname}`,
    date,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    scope: present,
    plaintextSha256: sha,
    plaintextBytes: tarball.length,
    encBytes: blob.length,
  });
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2));

  // 5) commit + push (history = immutable off-site record)
  // The single-flight lock lives INSIDE this repo dir, so keep it out of git: ensure a
  // .gitignore entry, and untrack it if an earlier run committed it (idempotent, quiet,
  // no error when absent). Otherwise `git add -A` below would commit .backup.lock into
  // every snapshot. The .gitignore itself IS committed (once).
  const giPath = path.join(BACKUP_REPO, ".gitignore");
  let gi = "";
  try {
    gi = fs.readFileSync(giPath, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (!gi.split(/\r?\n/).includes(".backup.lock")) {
    fs.writeFileSync(giPath, (gi && !gi.endsWith("\n") ? gi + "\n" : gi) + ".backup.lock\n");
  }
  try {
    sh("git", ["-C", BACKUP_REPO, "rm", "--cached", "--ignore-unmatch", "-q", ".backup.lock"]);
  } catch {
    /* not tracked — nothing to untrack */
  }

  sh("git", ["-C", BACKUP_REPO, "add", "-A"]);
  sh("git", ["-C", BACKUP_REPO, "commit", "-m", `backup ${stamp} · ${present.length} stores · ${(blob.length / 1024).toFixed(0)}KB`]);
  try {
    sh("git", ["-C", BACKUP_REPO, "push", "origin", "HEAD"]);
    log("pushed to remote ✓");
  } catch (e) {
    log("WARN push failed — committed LOCALLY only:", String(e.message).split("\n")[0]);
    process.exitCode = 2;
  }
  log(`backup OK: ${fname} (${(blob.length / 1024).toFixed(0)}KB, sha256 ${sha.slice(0, 12)}…)`);
}

main();
