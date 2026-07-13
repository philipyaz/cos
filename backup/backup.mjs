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
import { REPO_ROOT, DEFAULT_REPO_ROOT, BACKUP_REPO, EXPECTED_BACKUP_REPO, SCOPE, VAULT_SCOPE_PATH, DEVICE_ID } from "./config.mjs";
import { encrypt, decrypt } from "./lib/crypto.mjs";
import { resolveKey } from "./lib/key.mjs";
import { deviceManifestPath, readAllManifests, MANIFESTS_DIR } from "./lib/manifests.mjs";
import { firstLine } from "./lib/util.mjs";

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
  if (process.env.COS_BACKUP_ALLOW_NONDEFAULT === "1") return;
  if (BACKUP_REPO !== EXPECTED_BACKUP_REPO) {
    log(
      `refusing to run: BACKUP_REPO is ${BACKUP_REPO}, not the expected ${EXPECTED_BACKUP_REPO} ` +
        `(config/cos.env BACKUP_REPO, or the ~/.cos-backups default). ` +
        `Set COS_BACKUP_ALLOW_NONDEFAULT=1 only for a deliberate disposable-repo test.`,
    );
    process.exit(1);
  }
  // Same posture for the source side: an overridden repo ROOT (COS_BACKUP_REPO_ROOT)
  // means we'd snapshot a synthetic tree as if it were the live stores.
  if (REPO_ROOT !== DEFAULT_REPO_ROOT) {
    log(
      `refusing to run: COS_BACKUP_REPO_ROOT overrides the repo root (${REPO_ROOT}). ` +
        `Set COS_BACKUP_ALLOW_NONDEFAULT=1 only for a deliberate sandbox test.`,
    );
    process.exit(1);
  }
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

// Converge with the remote BEFORE producing: fetch + rebase local onto upstream.
// Without this, one rejected push left the clone diverged FOREVER (every later
// run committed on the diverged branch and exit-2'd again) — and a second
// producer guarantees divergence. Snapshot files are unique-named and manifests
// are per-device, so a rebase has no legitimate conflicts; anything unexpected
// aborts the rebase and proceeds un-rebased (the push then fails loudly, exit 2,
// rather than this run guessing at a resolution). Offline is fine: fetch fails,
// we proceed, the push degrades to the usual benign exit 2.
// NOTE (multi-device PR 3): when the HUB.json lease lands it gets its OWN push
// discipline (commit only the lease, --force-with-lease pinned to the fetched
// ref, conflict = abort) — this generic rebase must never resolve a lease
// conflict; keep HUB.json out of any -X strategy here.
function syncWithRemote() {
  try {
    sh("git", ["-C", BACKUP_REPO, "fetch", "origin"]);
  } catch (e) {
    log("WARN fetch failed (offline?) — proceeding; a push may fail benignly:", firstLine(e));
    return false;
  }
  let upstream;
  try {
    upstream = sh("git", ["-C", BACKUP_REPO, "rev-parse", "--abbrev-ref", "@{u}"]).trim();
  } catch {
    return true; // fetched, but no upstream configured — nothing to converge with
  }
  try {
    sh("git", ["-C", BACKUP_REPO, "rebase", upstream]);
  } catch (e) {
    try {
      sh("git", ["-C", BACKUP_REPO, "rebase", "--abort"]);
    } catch {
      /* no rebase in progress */
    }
    // A conflict here is almost certainly a pre-upgrade divergence on the legacy
    // shared MANIFEST.json (per-device manifests + unique snapshot names cannot
    // conflict). We never auto-resolve — see backup-recovery SKILL.md §7
    // ("Diverged backup repo") for the manual reconcile.
    log(`WARN rebase onto ${upstream} failed — proceeding un-rebased; the push may fail (exit 2):`, firstLine(e));
  }
  return true;
}

// Producer admission: before THIS MACHINE first produces into the archive, prove
// the locally-resolved key can decrypt the newest existing snapshot. A machine
// provisioned with a WRONG key would otherwise produce happily for months and
// the split archive would surface only at restore time — the worst moment.
//
// Admission is recorded MACHINE-LOCALLY (.backup.admitted in the clone,
// gitignored, holding a key fingerprint) — never inferred from the shared
// manifests: a deviceId is hostname-derived until PR 3 and a replacement Mac
// often inherits its predecessor's computer name, so "my manifest already has
// entries" proves nothing about MY key. A changed key (rotation) invalidates the
// marker and re-verifies.
const ADMITTED_MARKER = path.join(BACKUP_REPO, ".backup.admitted");
const keyFingerprint = (key) =>
  crypto.createHash("sha256").update(`cos-admission:${key}`).digest("hex").slice(0, 32);

function assertProducerAdmission(key, fetchOk) {
  const fp = keyFingerprint(key);
  try {
    if (fs.readFileSync(ADMITTED_MARKER, "utf8").trim() === fp) return; // admitted with THIS key
  } catch {
    /* no marker yet */
  }

  const all = readAllManifests(BACKUP_REPO);
  if (all.length === 0) {
    // The working tree sees no history — but "founder" is only safe when we can
    // PROVE the archive is genuinely empty. A fetch that succeeded without
    // integrating (no upstream, unborn HEAD, aborted rebase) or an offline
    // first run against a configured remote must fail closed, not found a
    // second archive over an existing one.
    let hasRemote = false;
    try {
      hasRemote = sh("git", ["-C", BACKUP_REPO, "remote"]).trim() !== "";
    } catch {
      /* not a repo — the .git check in runBackup already threw */
    }
    if (hasRemote) {
      if (!fetchOk) {
        throw new Error(
          `producer admission: cannot verify the remote archive is empty (fetch failed) — ` +
            `refusing to found a new archive blind. Reconnect and re-run.`,
        );
      }
      const refs = sh("git", ["-C", BACKUP_REPO, "for-each-ref", "refs/remotes/origin", "--format=%(refname)"])
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((r) => !r.endsWith("/HEAD"));
      for (const ref of refs) {
        const names = sh("git", ["-C", BACKUP_REPO, "ls-tree", "-r", "--name-only", ref]).split("\n");
        if (names.some((n) => n.startsWith("snapshots/"))) {
          throw new Error(
            `producer admission: the remote (${ref}) already holds snapshots that this clone has not ` +
              `integrated — reconcile the clone first (git rebase / re-clone), then re-run.`,
          );
        }
      }
    }
    log(`producer admission: archive is empty — device ${DEVICE_ID} founds it`);
  } else {
    const newest = all[0];
    const snapPath = path.join(BACKUP_REPO, String(newest.file ?? ""));
    if (!newest.file || !fs.existsSync(snapPath)) {
      throw new Error(
        `producer admission: the newest manifest entry (${newest.file ?? "?"}) is missing locally — ` +
          `fetch/pull the backup repo first (offline first-join is refused, fail-closed).`,
      );
    }
    try {
      decrypt(fs.readFileSync(snapPath), key);
    } catch {
      throw new Error(
        `producer admission FAILED: this machine's key cannot decrypt the newest existing snapshot ` +
          `(${newest.file}). Provision the SAME recovery key as the existing producer ` +
          `(backup-recovery skill §2, the COS_BACKUP_KEY path) — do NOT mint a new key: a second key ` +
          `silently splits the archive into two mutually-unrestorable halves.`,
      );
    }
    log(`producer admission: decrypt-verified ${newest.file} with the local key ✓ (device ${DEVICE_ID} joins the archive)`);
  }
  fs.writeFileSync(ADMITTED_MARKER, fp + "\n");
}

function runBackup() {
  const key = resolveKey(); // throws with guidance if missing

  if (!fs.existsSync(path.join(BACKUP_REPO, ".git"))) {
    throw new Error(
      `Backup repo not initialised at ${BACKUP_REPO}. Run the /backup-recovery skill (setup) first.`,
    );
  }

  // Converge with the remote first so the admission check (and the manifest we
  // append to) sees the freshest view of the archive.
  const fetchOk = syncWithRemote();
  assertProducerAdmission(key, fetchOk);

  // Load this device's manifest BEFORE the expensive tar/encrypt work, with
  // corruption recovery: a present-but-unparseable file must NEVER be silently
  // replaced by a fresh single-entry manifest (that would drop this device's
  // whole snapshot catalog from restore --list and the board history). Recover
  // from git HEAD, or refuse.
  const manPath = deviceManifestPath(BACKUP_REPO, DEVICE_ID);
  let man = { backups: [] };
  if (fs.existsSync(manPath)) {
    try {
      const wire = JSON.parse(fs.readFileSync(manPath, "utf8"));
      if (!wire || !Array.isArray(wire.backups)) throw new Error("manifest has no backups[] array");
      man = wire;
    } catch (parseErr) {
      let recovered = null;
      try {
        const wire = JSON.parse(sh("git", ["-C", BACKUP_REPO, "show", `HEAD:${MANIFESTS_DIR}/${DEVICE_ID}.json`]));
        if (wire && Array.isArray(wire.backups)) recovered = wire;
      } catch {
        /* never committed / also unreadable */
      }
      if (!recovered) {
        throw new Error(
          `manifests/${DEVICE_ID}.json exists but is unparseable (${firstLine(parseErr)}) and could not be ` +
            `recovered from git HEAD — refusing to overwrite this device's snapshot catalog. Fix or remove it manually.`,
        );
      }
      man = recovered;
      log(`WARN: manifests/${DEVICE_ID}.json was corrupt on disk — recovered ${recovered.backups.length} entries from git HEAD`);
    }
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

  // 4) manifest (newest-first), with integrity sha for restore-time verification.
  // PER-DEVICE: this producer appends ONLY to manifests/<DEVICE_ID>.json (loaded
  // with corruption recovery above) — the single shared MANIFEST.json was the one
  // merge-conflict-prone file once a second machine produced (it is still READ by
  // restore/status for old snapshots, but never written again). Entries also
  // record the deviceId, the vault scope path (restore.mjs consumes it as the
  // authoritative vault-source path when mapping onto a machine with a different
  // VAULT_NAME), and the board store's raw schemaVersion at snapshot time (the
  // hub-handover promote precondition reads it; see docs/reference/migration.md).
  // The write is ATOMIC (tmp + rename) so a crash mid-write can't corrupt the catalog.
  fs.mkdirSync(path.join(BACKUP_REPO, MANIFESTS_DIR), { recursive: true });
  let schemaVersion = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "board/data/cases.json"), "utf8")).schemaVersion;
    if (typeof v === "number") schemaVersion = v;
  } catch {
    /* no readable store in scope — leave null */
  }
  man.backups.unshift({
    file: `snapshots/${fname}`,
    date,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    deviceId: DEVICE_ID,
    scope: present,
    vaultPath: present.includes(VAULT_SCOPE_PATH) ? VAULT_SCOPE_PATH : null,
    schemaVersion,
    plaintextSha256: sha,
    plaintextBytes: tarball.length,
    encBytes: blob.length,
  });
  const manTmp = `${manPath}.${process.pid}.tmp`;
  fs.writeFileSync(manTmp, JSON.stringify(man, null, 2));
  fs.renameSync(manTmp, manPath);

  // 5) commit + push (history = immutable off-site record)
  // The single-flight lock AND the machine-local admission marker live INSIDE this
  // repo dir, so keep them out of git: ensure .gitignore entries, and untrack them
  // if an earlier run committed one (idempotent, quiet, no error when absent).
  // Otherwise `git add -A` below would commit them into every snapshot. The
  // .gitignore itself IS committed (once).
  const giPath = path.join(BACKUP_REPO, ".gitignore");
  let gi = "";
  try {
    gi = fs.readFileSync(giPath, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  for (const entry of [".backup.lock", ".backup.admitted"]) {
    if (!gi.split(/\r?\n/).includes(entry)) {
      gi = (gi && !gi.endsWith("\n") ? gi + "\n" : gi) + entry + "\n";
      fs.writeFileSync(giPath, gi);
    }
    try {
      sh("git", ["-C", BACKUP_REPO, "rm", "--cached", "--ignore-unmatch", "-q", entry]);
    } catch {
      /* not tracked — nothing to untrack */
    }
  }

  sh("git", ["-C", BACKUP_REPO, "add", "-A"]);
  sh("git", ["-C", BACKUP_REPO, "commit", "-m", `backup ${stamp} · ${present.length} stores · ${(blob.length / 1024).toFixed(0)}KB · ${DEVICE_ID}`]);
  // Push, and on a rejection (another producer pushed while THIS run was
  // archiving) converge once and retry — snapshot files are unique-named and the
  // manifest is per-device, so the rebase is conflict-free by construction. When
  // the PRE-RUN fetch already failed we're offline: skip the pointless converge +
  // second push and go straight to the benign exit 2.
  try {
    sh("git", ["-C", BACKUP_REPO, "push", "origin", "HEAD"]);
    log("pushed to remote ✓");
  } catch (e) {
    if (!fetchOk) {
      log("WARN push failed (offline) — committed LOCALLY only:", firstLine(e));
      process.exitCode = 2;
    } else {
      log("push rejected/failed — converging with remote and retrying once:", firstLine(e));
      syncWithRemote();
      try {
        sh("git", ["-C", BACKUP_REPO, "push", "origin", "HEAD"]);
        log("pushed to remote after converge ✓");
      } catch (e2) {
        log("WARN push failed — committed LOCALLY only:", firstLine(e2));
        process.exitCode = 2;
      }
    }
  }
  log(`backup OK: ${fname} (${(blob.length / 1024).toFixed(0)}KB, sha256 ${sha.slice(0, 12)}…)`);
}

main();
