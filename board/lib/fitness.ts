// The "fitness" add-on's data API — Apple Watch health time-series, folded onto the CORE
// store (db.healthEntries in cases.json) exactly like the nutrition add-on's arrays. This
// REPLACES the old standalone data/health.json store: every write rides the board's single
// serialized mutate() chokepoint + version counter, so health data inherits SSE live-update,
// the encrypted off-site backup, and actor attribution for free (the whole point of the
// add-on framework — see docs/architecture/addons.md).
//
// THE GATE (writes close, reads stay open): pushEntries/deleteEntries/setProfile call
// assertAddonEnabled(db,"fitness") INSIDE mutate() — a disabled add-on throws NotFoundError
// → 404, atomically with the write. listEntries/summarize/trends/getProfile are ungated
// reads, so a disabled add-on's data stays fully readable.
//
// TAXONOMY: this module reads the canonical health-entry taxonomy (board/lib/types.ts
// HealthEntryType + the data.value/data.metadata shape the ingest route produces). The
// aggregators below MUST stay in lockstep with what board/app/api/fitness/push writes.

import { mutate, readDB, setAthleteProfile } from "./store";
import { assertAddonEnabled } from "./addons";
import type { HealthEntry, AthleteProfile } from "./types";

const HEALTH_ADDON_ID = "fitness";
const RETENTION_DAYS = 90;

// ── Writes (gated) ────────────────────────────────────────────────────────────

/**
 * Push entries (dedup by id), purge entries older than RETENTION_DAYS, return stats.
 * GATED: throws NotFoundError (→ 404) when the "fitness" add-on is disabled. The caller
 * (the push route) supplies entries already in canonical {id,ts,type,data} shape.
 */
export async function pushEntries(incoming: HealthEntry[]): Promise<{
  accepted: number;
  duplicates: number;
  purged: number;
  total: number;
  version: number;
}> {
  return mutate((db) => {
    assertAddonEnabled(db, HEALTH_ADDON_ID);
    if (!db.healthEntries) db.healthEntries = [];
    const existingIds = new Set(db.healthEntries.map((e) => e.id));
    const now = new Date().toISOString();

    let accepted = 0;
    let duplicates = 0;
    for (const entry of incoming) {
      if (existingIds.has(entry.id)) {
        duplicates++;
        continue;
      }
      existingIds.add(entry.id);
      db.healthEntries.push({ ...entry, pushedAt: now });
      accepted++;
    }

    // Retention purge — compare DATE-ONLY against a date-only cutoff so a date-only ts
    // ("2026-06-16") and a full-ISO ts ("2026-06-16T...") are both handled correctly (the
    // old full-ISO cutoff was off by a day for date-only entries).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    const before = db.healthEntries.length;
    db.healthEntries = db.healthEntries.filter((e) => e.ts.slice(0, 10) >= cutoffDay);
    const purged = before - db.healthEntries.length;

    return { accepted, duplicates, purged, total: db.healthEntries.length, version: db.version };
  });
}

/** Delete entries by ids and/or date range. GATED (disabled add-on → 404). */
export async function deleteEntries(opts: {
  ids?: string[];
  from?: string;
  to?: string;
}): Promise<{ deleted: number; remaining: number; version: number }> {
  return mutate((db) => {
    assertAddonEnabled(db, HEALTH_ADDON_ID);
    if (!db.healthEntries) db.healthEntries = [];
    const idSet = opts.ids ? new Set(opts.ids) : null;
    const before = db.healthEntries.length;
    db.healthEntries = db.healthEntries.filter((e) => {
      if (idSet && idSet.has(e.id)) return false;
      if (opts.from && opts.to && e.ts >= opts.from && e.ts < opts.to) return false;
      if (opts.from && !opts.to && e.ts >= opts.from) return false;
      if (!opts.from && opts.to && e.ts < opts.to) return false;
      return true;
    });
    return {
      deleted: before - db.healthEntries.length,
      remaining: db.healthEntries.length,
      version: db.version,
    };
  });
}

// ── Reads (ungated) ───────────────────────────────────────────────────────────

/** Read entries with optional filters. Returns newest-first. limit<=0 means no limit. */
export async function listEntries(opts: {
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<{ entries: HealthEntry[]; total: number }> {
  const db = await readDB();
  let entries = db.healthEntries ?? [];

  if (opts.type) entries = entries.filter((e) => e.type === opts.type);
  if (opts.from) entries = entries.filter((e) => e.ts >= opts.from!);
  if (opts.to) entries = entries.filter((e) => e.ts < opts.to!);

  entries = [...entries].sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));

  const total = entries.length;
  const limit = opts.limit ?? 100;
  if (limit > 0) entries = entries.slice(0, limit);

  return { entries, total };
}

/**
 * Aggregate summary for a date or date range. Reads the CANONICAL taxonomy: per-day metric
 * aggregates live in data.value (hrv=ms, resting_hr=bpm, steps=count, vo2max=mL/kg/min),
 * sleep_night carries data.value=hours + data.metadata.{deep,rem}, workouts carry the rich
 * data.* shape. Output field names are the contract consumed by the MCP report + the UI.
 */
export async function summarize(opts: {
  date?: string;
  from?: string;
  to?: string;
}): Promise<Record<string, unknown>> {
  const db = await readDB();
  let entries = db.healthEntries ?? [];

  if (opts.date) {
    entries = entries.filter((e) => e.ts.slice(0, 10) === opts.date);
  } else {
    if (opts.from) entries = entries.filter((e) => e.ts >= opts.from!);
    if (opts.to) entries = entries.filter((e) => e.ts < opts.to!);
  }

  const byType = groupByType(entries);
  const result: Record<string, unknown> = {};

  const nights = byType.sleep_night ?? [];
  if (nights.length) {
    result.sleep = {
      count: nights.length,
      avg_hours: avg(nights, (e) => num(e.data.value)),
      avg_deep_hours: avg(nights, (e) => num(meta(e).deep)),
      avg_rem_hours: avg(nights, (e) => num(meta(e).rem)),
    };
  }

  if (byType.hrv?.length) {
    result.hrv = { count: byType.hrv.length, avg_ms: avg(byType.hrv, (e) => num(e.data.value)) };
  }

  if (byType.resting_hr?.length) {
    result.resting_hr = {
      count: byType.resting_hr.length,
      avg_bpm: avg(byType.resting_hr, (e) => num(e.data.value)),
    };
  }

  if (byType.steps?.length) {
    const counts = nums(byType.steps, (e) => num(e.data.value));
    result.steps = {
      days: byType.steps.length,
      total: counts.reduce((s, n) => s + n, 0),
      avg_per_day: counts.length ? counts.reduce((s, n) => s + n, 0) / counts.length : null,
    };
  }

  if (byType.vo2max?.length) {
    const sorted = [...byType.vo2max].sort((a, b) => (a.ts > b.ts ? -1 : 1));
    result.vo2max = { count: byType.vo2max.length, latest: num(sorted[0].data.value) };
  }

  if (byType.workout?.length) {
    const items = byType.workout;
    const durations = nums(items, (e) => num(e.data.duration_min));
    const cals = nums(items, (e) => num(e.data.calories));
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

/** Per-day trends over the last N days, reading the canonical taxonomy (see summarize). */
export async function trends(opts: { days?: number; type?: string }): Promise<Record<string, unknown>> {
  const days = opts.days ?? 7;
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);

  const db = await readDB();
  let entries = (db.healthEntries ?? []).filter((e) => {
    const day = e.ts.slice(0, 10);
    return day >= fromDay && day <= toDay;
  });
  if (opts.type) entries = entries.filter((e) => e.type === opts.type);

  const byDay = new Map<string, HealthEntry[]>();
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(e);
    byDay.set(day, arr);
  }

  const daily: Record<string, Record<string, unknown>> = {};
  for (const day of [...byDay.keys()].sort()) {
    const byType = groupByType(byDay.get(day)!);
    const d: Record<string, unknown> = {};
    if (byType.sleep_night?.length) d.sleep_hours = avg(byType.sleep_night, (e) => num(e.data.value));
    if (byType.hrv?.length) d.hrv_ms = avg(byType.hrv, (e) => num(e.data.value));
    if (byType.resting_hr?.length) d.resting_hr_bpm = avg(byType.resting_hr, (e) => num(e.data.value));
    if (byType.steps?.length) d.steps = nums(byType.steps, (e) => num(e.data.value)).reduce((s, n) => s + n, 0);
    if (byType.vo2max?.length) {
      const sorted = [...byType.vo2max].sort((a, b) => (a.ts > b.ts ? -1 : 1));
      d.vo2max = num(sorted[0].data.value);
    }
    if (byType.workout?.length) {
      d.workout_count = byType.workout.length;
      d.workout_duration_min = nums(byType.workout, (e) => num(e.data.duration_min)).reduce((s, n) => s + n, 0);
    }
    daily[day] = d;
  }

  return { days, from: fromDay, to: toDay, daily };
}

// ── Athlete profile singleton ──────────────────────────────────────────────────

/** Read the athlete profile singleton, or null when none is set. Ungated. */
export async function getProfile(): Promise<AthleteProfile | null> {
  const db = await readDB();
  return db.athleteProfile ?? null;
}

/**
 * Create-or-replace the athlete profile singleton. GATED (disabled add-on → 404). The
 * caller (the fitness profile route) supplies already-validated/coerced fields; the store helper
 * stamps the sticky createdAt + updatedAt.
 */
export async function setProfile(
  input: Omit<AthleteProfile, "createdAt" | "updatedAt">,
): Promise<{ profile: AthleteProfile; version: number }> {
  return mutate((db) => {
    assertAddonEnabled(db, HEALTH_ADDON_ID);
    const profile = setAthleteProfile(db, input);
    return { profile, version: db.version };
  });
}

// ── Utilities ───────────────────────────────────────────────────────────────

function groupByType(entries: HealthEntry[]): Record<string, HealthEntry[]> {
  const byType: Record<string, HealthEntry[]> = {};
  for (const e of entries) (byType[e.type] ??= []).push(e);
  return byType;
}

function meta(e: HealthEntry): Record<string, unknown> {
  return e.data.metadata && typeof e.data.metadata === "object"
    ? (e.data.metadata as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nums(items: HealthEntry[], extract: (e: HealthEntry) => number | null): number[] {
  return items.map(extract).filter((n): n is number => n != null);
}

function avg(items: HealthEntry[], extract: (e: HealthEntry) => number | null): number | null {
  const vals = nums(items, extract);
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : null;
}
