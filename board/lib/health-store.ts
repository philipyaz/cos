// Standalone JSON store for Apple Watch HealthKit data. Deliberately separate
// from the core cases.json store — health data is high-volume time-series that
// doesn't belong in the board's main mutate() lock. The file lives at
// data/health.json next to cases.json.
//
// Shape: { entries: HealthEntry[], version: number }
// Retention: 90 days — auto-purged on every push.

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.COS_DATA_DIR || path.join(process.cwd(), "data");
const HEALTH_FILE = path.join(DATA_DIR, "health.json");
const RETENTION_DAYS = 90;

// ── Types ───────────────────────────────────────────────────────────────────

export const VALID_HEALTH_TYPES = [
  "sleep", "hrv", "steps", "workout", "vo2max", "resting_hr",
] as const;
export type HealthType = (typeof VALID_HEALTH_TYPES)[number];

export interface HealthEntry {
  id: string;
  ts: string;           // ISO-8601 timestamp
  type: HealthType;
  data: Record<string, unknown>;
  pushedAt: string;      // ISO-8601 — when the entry was received
}

interface HealthDB {
  entries: HealthEntry[];
  version: number;
}

// ── File I/O ────────────────────────────────────────────────────────────────

async function readHealthDB(): Promise<HealthDB> {
  try {
    const raw = await fs.readFile(HEALTH_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      version: typeof parsed.version === "number" ? parsed.version : 0,
    };
  } catch {
    return { entries: [], version: 0 };
  }
}

async function writeHealthDB(db: HealthDB): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = HEALTH_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmp, HEALTH_FILE);
}

// Simple file-level lock to serialize writes (no concurrent push races).
let writeLock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Push entries (dedup by id), purge entries older than 90 days, return stats. */
export async function pushEntries(incoming: HealthEntry[]): Promise<{
  accepted: number;
  duplicates: number;
  purged: number;
  total: number;
  version: number;
}> {
  return withLock(async () => {
    const db = await readHealthDB();
    const existingIds = new Set(db.entries.map((e) => e.id));

    let accepted = 0;
    let duplicates = 0;
    const now = new Date().toISOString();

    for (const entry of incoming) {
      if (existingIds.has(entry.id)) {
        duplicates++;
        continue;
      }
      existingIds.add(entry.id);
      db.entries.push({ ...entry, pushedAt: now });
      accepted++;
    }

    // Purge entries older than 90 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffISO = cutoff.toISOString();
    const beforeCount = db.entries.length;
    db.entries = db.entries.filter((e) => e.ts >= cutoffISO);
    const purged = beforeCount - db.entries.length;

    db.version++;
    await writeHealthDB(db);

    return { accepted, duplicates, purged, total: db.entries.length, version: db.version };
  });
}

/** Read entries with optional filters. Returns newest-first. */
export async function listEntries(opts: {
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<{ entries: HealthEntry[]; total: number }> {
  const db = await readHealthDB();
  let entries = db.entries;

  if (opts.type) entries = entries.filter((e) => e.type === opts.type);
  if (opts.from) entries = entries.filter((e) => e.ts >= opts.from!);
  if (opts.to) entries = entries.filter((e) => e.ts < opts.to!);

  // Sort newest-first
  entries = [...entries].sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));

  const total = entries.length;
  const limit = opts.limit ?? 100;
  if (limit > 0) entries = entries.slice(0, limit);

  return { entries, total };
}

/** Delete entries by IDs and/or date range. Returns count deleted. */
export async function deleteEntries(opts: {
  ids?: string[];
  from?: string;
  to?: string;
}): Promise<{ deleted: number; remaining: number; version: number }> {
  return withLock(async () => {
    const db = await readHealthDB();
    const idSet = opts.ids ? new Set(opts.ids) : null;
    const before = db.entries.length;

    db.entries = db.entries.filter((e) => {
      if (idSet && idSet.has(e.id)) return false;
      if (opts.from && opts.to && e.ts >= opts.from && e.ts < opts.to) return false;
      if (opts.from && !opts.to && e.ts >= opts.from) return false;
      if (!opts.from && opts.to && e.ts < opts.to) return false;
      return true;
    });

    db.version++;
    await writeHealthDB(db);

    return { deleted: before - db.entries.length, remaining: db.entries.length, version: db.version };
  });
}

/** Aggregate summary for a date or date range. */
export async function summarize(opts: {
  date?: string;
  from?: string;
  to?: string;
}): Promise<Record<string, unknown>> {
  const db = await readHealthDB();
  let entries = db.entries;

  // Filter by date range
  if (opts.date) {
    entries = entries.filter((e) => e.ts.startsWith(opts.date!));
  } else {
    if (opts.from) entries = entries.filter((e) => e.ts >= opts.from!);
    if (opts.to) entries = entries.filter((e) => e.ts < opts.to!);
  }

  const byType: Record<string, HealthEntry[]> = {};
  for (const e of entries) {
    (byType[e.type] ??= []).push(e);
  }

  const result: Record<string, unknown> = {};

  if (byType.sleep?.length) {
    const items = byType.sleep;
    result.sleep = {
      count: items.length,
      avg_duration_min: avg(items, (e) => num(e.data.duration_min)),
      avg_deep_min: avg(items, (e) => num(e.data.deep_min)),
      avg_rem_min: avg(items, (e) => num(e.data.rem_min)),
    };
  }

  if (byType.hrv?.length) {
    const items = byType.hrv;
    result.hrv = {
      count: items.length,
      avg_ms: avg(items, (e) => num(e.data.avg_ms)),
    };
  }

  if (byType.resting_hr?.length) {
    const items = byType.resting_hr;
    result.resting_hr = {
      count: items.length,
      avg_bpm: avg(items, (e) => num(e.data.bpm)),
    };
  }

  if (byType.steps?.length) {
    const items = byType.steps;
    const counts = items.map((e) => num(e.data.count)).filter((n) => n != null) as number[];
    result.steps = {
      count: items.length,
      total_count: counts.reduce((s, n) => s + n, 0),
      avg_count: counts.length ? counts.reduce((s, n) => s + n, 0) / counts.length : null,
    };
  }

  if (byType.vo2max?.length) {
    const items = byType.vo2max;
    const sorted = [...items].sort((a, b) => (a.ts > b.ts ? -1 : 1));
    result.vo2max = {
      count: items.length,
      latest_value: num(sorted[0].data.value),
    };
  }

  if (byType.workout?.length) {
    const items = byType.workout;
    const durations = items.map((e) => num(e.data.duration_min)).filter((n) => n != null) as number[];
    const cals = items.map((e) => num(e.data.calories)).filter((n) => n != null) as number[];
    const activities: Record<string, number> = {};
    for (const e of items) {
      const a = String(e.data.activity ?? "unknown");
      activities[a] = (activities[a] ?? 0) + 1;
    }
    result.workout = {
      count: items.length,
      total_duration_min: durations.reduce((s, n) => s + n, 0),
      total_calories: cals.reduce((s, n) => s + n, 0),
      activities,
    };
  }

  return result;
}

/** Compute daily trends over the last N days. */
export async function trends(opts: {
  days?: number;
  type?: string;
}): Promise<Record<string, unknown>> {
  const days = opts.days ?? 7;
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  const db = await readHealthDB();
  let entries = db.entries.filter((e) => e.ts >= fromISO && e.ts < toISO);
  if (opts.type) entries = entries.filter((e) => e.type === opts.type);

  // Group by day
  const byDay: Record<string, HealthEntry[]> = {};
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    (byDay[day] ??= []).push(e);
  }

  const dailyData: Record<string, Record<string, unknown>> = {};
  const sortedDays = Object.keys(byDay).sort();

  for (const day of sortedDays) {
    const dayEntries = byDay[day];
    const byType: Record<string, HealthEntry[]> = {};
    for (const e of dayEntries) {
      (byType[e.type] ??= []).push(e);
    }

    const daySummary: Record<string, unknown> = {};
    if (byType.sleep?.length) daySummary.sleep_duration_min = avg(byType.sleep, (e) => num(e.data.duration_min));
    if (byType.hrv?.length) daySummary.hrv_avg_ms = avg(byType.hrv, (e) => num(e.data.avg_ms));
    if (byType.resting_hr?.length) daySummary.resting_hr_bpm = avg(byType.resting_hr, (e) => num(e.data.bpm));
    if (byType.steps?.length) {
      const counts = byType.steps.map((e) => num(e.data.count)).filter((n) => n != null) as number[];
      daySummary.steps_count = counts.reduce((s, n) => s + n, 0);
    }
    if (byType.vo2max?.length) {
      const sorted = [...byType.vo2max].sort((a, b) => (a.ts > b.ts ? -1 : 1));
      daySummary.vo2max_value = num(sorted[0].data.value);
    }
    if (byType.workout?.length) {
      daySummary.workout_count = byType.workout.length;
      const durations = byType.workout.map((e) => num(e.data.duration_min)).filter((n) => n != null) as number[];
      daySummary.workout_duration_min = durations.reduce((s, n) => s + n, 0);
    }

    dailyData[day] = daySummary;
  }

  return { days, from: fromISO.slice(0, 10), to: toISO.slice(0, 10), daily: dailyData };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function avg(items: HealthEntry[], extract: (e: HealthEntry) => number | null): number | null {
  const vals = items.map(extract).filter((n) => n != null) as number[];
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : null;
}
