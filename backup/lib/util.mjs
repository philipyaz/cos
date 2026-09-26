// Tiny shared helpers for the backup scripts (backup.mjs + restore.mjs).
import fs from "node:fs";
import path from "node:path";

// First line of an error's message — for one-line WARN logs.
export const firstLine = (e) => String(e && e.message ? e.message : e).split("\n")[0];

// The single-flight lock BOTH scripts must hold before touching the backup repo
// (fetch/rebase/commit/push in backup.mjs; fetch/ff-merge in restore.mjs). `wx`
// is an atomic create-or-fail; a lock older than staleMs is an orphaned crash
// and is reclaimed. Returns 'acquired' (took a free lock), 'reclaimed' (replaced
// a stale one), or 'busy' (a live run owns it — or something unremovable, e.g. a
// directory, sits at the lock path). Two things about this file are load-bearing
// beyond it, and tests/backup-hardening.mjs [0] pins both: the '.backup.lock'
// NAME (backup.mjs keeps a .gitignore entry for it in every archive) and the
// 120s default (backup.mjs's reclaim log line and the backup docs narrate it)
// — change either only together with its twin.
export function acquireRepoLock(repoDir, staleMs = 120_000) {
  const lockPath = path.join(repoDir, ".backup.lock");
  try {
    fs.openSync(lockPath, "wx");
    return "acquired";
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(lockPath).mtimeMs;
    } catch {
      /* lock vanished between open and stat — treat as reclaimable */
    }
    if (Date.now() - mtimeMs > staleMs) {
      try {
        fs.rmSync(lockPath, { force: true });
        fs.openSync(lockPath, "wx");
        return "reclaimed";
      } catch {
        return "busy";
      }
    }
    return "busy";
  }
}

export function releaseRepoLock(repoDir) {
  fs.rmSync(path.join(repoDir, ".backup.lock"), { force: true });
}
