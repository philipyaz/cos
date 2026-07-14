// The HUB.json lease — the archive-level record of WHICH machine is the hub
// (the one producer). A tiny PLAINTEXT file in the otherwise-encrypted backup
// repo: { deviceId, host, epoch, renewedAt }. Deliberately plaintext so any
// clone (and the board's /api/healthz) can read who the hub is without the key.
//
// Semantics:
//   - the holder renews on every backup run (renewedAt bumps; epoch unchanged);
//   - a lease is STALE after 26h without renewal (daily runs + top-ups renew
//     far more often) — a stale or absent lease is claimable (epoch + 1);
//   - a FRESH lease held by another device means THIS machine must not produce
//     (backup.mjs exits 4 after quarantining its stray state once);
//   - a forced takeover (`backup.mjs --claim`, the hub-handover ceremony) claims the
//     lease with an epoch bump even when the current lease is still fresh.
//
// The lease has its OWN push discipline (see backup.mjs claimOrRenewLease):
// commit ONLY HUB.json, push --force-with-lease pinned to the fetched remote
// ref — a git-level compare-and-swap. The generic snapshot rebase never touches
// it; a conflict on HUB.json means the CAS lost, never something to auto-merge.
//
// MIRRORED (not imported) by board/lib/backup-status.ts readHubLease() — the
// .ts side cannot import this .mjs (outside the Next root).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LEASE_FILE = "HUB.json";
export const LEASE_STALE_HOURS = 26;

export function leasePath(repoDir) {
  return path.join(repoDir, LEASE_FILE);
}

// The ONE shape-validate + normalize for a parsed lease object — the single source
// of lease field semantics. Returns null on a missing/garbage shape. Every reader
// (readLease here, backup.mjs's git-show reads, board/lib/backup-status.ts's mirror)
// funnels through this so they can never disagree.
export function coerceLease(raw) {
  if (!raw || typeof raw.deviceId !== "string" || typeof raw.renewedAt !== "string") return null;
  return {
    deviceId: raw.deviceId,
    host: typeof raw.host === "string" ? raw.host : null,
    epoch: typeof raw.epoch === "number" ? raw.epoch : 0,
    renewedAt: raw.renewedAt,
  };
}

// Tolerant read: null when absent/garbage (the tripwires simply aren't armed yet).
export function readLease(repoDir) {
  try {
    return coerceLease(JSON.parse(fs.readFileSync(leasePath(repoDir), "utf8")));
  } catch {
    return null;
  }
}

export function leaseIsStale(lease, staleHours = LEASE_STALE_HOURS) {
  const t = new Date(lease.renewedAt).getTime();
  return !Number.isFinite(t) || Date.now() - t > staleHours * 3600_000;
}

// Write the lease file (the caller owns the commit + CAS push).
export function writeLease(repoDir, { deviceId, epoch }) {
  const lease = { deviceId, host: os.hostname(), epoch, renewedAt: new Date().toISOString() };
  fs.writeFileSync(leasePath(repoDir), JSON.stringify(lease, null, 2) + "\n");
  return lease;
}
