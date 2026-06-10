// Resolve the TRASH RETENTION WINDOW — how long a soft-deleted (archivedAt) case
// lingers in Trash before the lazy retention sweep purges it permanently. Server-only
// (reads env + the repo config file). Priority:
//   1. COS_TRASH_RETENTION_DAYS env (parsed int), else
//   2. config/settings.json `trashRetentionDays` (repo root), else
//   3. 30.
// A value <= 0 DISABLES the sweep (escape hatch for tests / "never auto-purge"). The
// result is cached after the first resolve (config is static per process); mirrors
// lib/principal.ts exactly.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_DAYS = 30;
// How long a done/dismissed reminder lingers on the Reminders surface before the
// auto-sweep SOFT-deletes it (moves it to Trash). Distinct from the Trash purge
// window above: a reminder is archived after this many days, then purged from Trash
// after `trashRetentionDays` like any soft-deleted case.
const DEFAULT_REMINDER_AUTODELETE_DAYS = 7;
let cached: number | undefined;
let cachedReminder: number | undefined;

export function resolveTrashRetentionDays(): number {
  if (cached !== undefined) return cached;
  cached = readNumberSetting("COS_TRASH_RETENTION_DAYS", "trashRetentionDays", DEFAULT_DAYS);
  return cached;
}

export function resolveReminderAutoDeleteDays(): number {
  if (cachedReminder !== undefined) return cachedReminder;
  cachedReminder = readNumberSetting(
    "COS_REMINDER_AUTODELETE_DAYS",
    "reminderAutoDeleteDays",
    DEFAULT_REMINDER_AUTODELETE_DAYS,
  );
  return cachedReminder;
}

// Resolve a numeric setting: env (parsed int) → config/settings.json key → fallback.
function readNumberSetting(envKey: string, settingKey: string, fallback: number): number {
  const env = process.env[envKey];
  if (typeof env === "string" && env.trim() !== "") {
    const n = parseInt(env.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  // config/settings.json sits at the REPO ROOT — one level above the board's cwd
  // (where store.ts resolves data/cases.json from). Tolerate a missing/bad file.
  try {
    const p = path.join(process.cwd(), "..", "config", "settings.json");
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = j[settingKey];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {
    // no config / not readable / bad JSON ⇒ fall through to the default.
  }
  return fallback;
}

// Test/maintenance escape hatch: drop the memoized values so a later resolve re-reads
// env + config (used by unit tests that set the env vars between cases).
export function _resetRetentionCache(): void {
  cached = undefined;
  cachedReminder = undefined;
}
