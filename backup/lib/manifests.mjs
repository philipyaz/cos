// Per-device manifest layer. Each producer writes ONLY its own
// manifests/<deviceId>.json ({ backups: [...] }, newest-first) so two machines
// backing up into the same repo can never conflict on a shared manifest file —
// the single MANIFEST.json was the one merge-conflict-prone path (unique-named
// snapshots never collide; one shared unshifted array always did). The legacy
// MANIFEST.json is still READ (old snapshots stay restorable) but no longer
// written. Zero dependencies; shared by backup.mjs, restore.mjs (and mirrored,
// not imported, by board/lib/backup-status.ts — the .mjs/.ts sides can't
// cross-import, same as config.mjs's cos.env reader).
import fs from "node:fs";
import path from "node:path";

export const MANIFESTS_DIR = "manifests";

export function deviceManifestPath(repoDir, deviceId) {
  return path.join(repoDir, MANIFESTS_DIR, `${deviceId}.json`);
}

// Read ONE manifest file into { backups: [...] }; tolerant of a missing or
// garbage file (→ empty) so a half-written manifest never blocks a backup.
export function readManifestFile(file) {
  try {
    const wire = JSON.parse(fs.readFileSync(file, "utf8"));
    return wire && Array.isArray(wire.backups) ? { backups: wire.backups } : { backups: [] };
  } catch {
    return { backups: [] };
  }
}

// The union view: every manifests/*.json plus the legacy MANIFEST.json, merged
// and sorted newest-first by createdAt (each file is already newest-first, but
// the MERGE needs the sort). This is what restore's "latest" and the board's
// /backups feed read — one snapshot catalog across all producers.
export function readAllManifests(repoDir) {
  const entries = [];
  const dir = path.join(repoDir, MANIFESTS_DIR);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      entries.push(...readManifestFile(path.join(dir, name)).backups);
    }
  } catch {
    /* no manifests/ dir yet */
  }
  entries.push(...readManifestFile(path.join(repoDir, "MANIFEST.json")).backups);
  return entries.sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")));
}
