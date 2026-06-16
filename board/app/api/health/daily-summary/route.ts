import { NextResponse, type NextRequest } from "next/server";
import { listEntries } from "@/lib/health";
import { readDB } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/health/daily-summary?date=YYYY-MM-DD
// Aggregates health data (workouts, sleep, HRV, resting HR, steps) and nutrition
// food logs — both folded into cases.json — into a single response.
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date")?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "Query param 'date' is required as YYYY-MM-DD." },
      { status: 400 },
    );
  }

  // Fetch health entries for the day. Use from/to as a broad pre-filter, then
  // tighten with startsWith — entries may have ts = "YYYY-MM-DD" (date-only,
  // e.g. sleep_night, resting_hr, steps) or ts = "YYYY-MM-DDT..." (full ISO,
  // e.g. workouts). The string-compare pre-filter covers both, but the
  // startsWith pass makes intent explicit and guards against edge cases.
  const nextDay = nextDate(date);
  const { entries: rawEntries } = await listEntries({
    from: date,
    to: nextDay,
    limit: 0, // no limit
  });
  const healthEntries = rawEntries.filter(
    (e) => e.ts === date || e.ts.startsWith(date + "T"),
  );

  // Group by type
  const byType: Record<string, typeof healthEntries> = {};
  for (const e of healthEntries) {
    (byType[e.type] ??= []).push(e);
  }

  // ── Workouts (exclude entries without activity, e.g. apple_exercise_time) ──
  const workoutEntries = (byType["workout"] ?? []).filter((e) => e.data.activity);
  const workouts = workoutEntries.map((e) => ({
    id: e.id,
    ts: e.ts,
    activity: e.data.activity,
    duration_min: num(e.data.duration_min),
    calories: num(e.data.calories),
    avg_hr: num(e.data.avg_hr),
    distance_km: num(e.data.distance_km),
  }));
  const totalWorkoutCalories = workouts.reduce(
    (s, w) => s + (w.calories ?? 0),
    0,
  );

  // ── Sleep ──
  const nightEntries = byType["sleep_night"] ?? [];
  const napEntries = byType["sleep_nap"] ?? [];
  const night =
    nightEntries.length > 0
      ? buildSleep(nightEntries[nightEntries.length - 1])
      : null;
  const naps = napEntries.map(buildSleep);

  // ── Metrics ──
  const hrvEntries = byType["hrv"] ?? [];
  const restingHrEntries = byType["resting_hr"] ?? [];
  const stepsEntries = byType["steps"] ?? [];

  const hrv =
    hrvEntries.length > 0
      ? avgNum(hrvEntries.map((e) => num(e.data.value)))
      : null;
  const restingHR =
    restingHrEntries.length > 0
      ? avgNum(restingHrEntries.map((e) => num(e.data.value)))
      : null;
  const steps =
    stepsEntries.length > 0
      ? stepsEntries.reduce((s, e) => s + (num(e.data.value) ?? 0), 0)
      : null;

  // ── Nutrition (food logs from cases.json) ──
  const db = await readDB();
  const foodLogs = (db.foodLogs ?? []).filter((f) => f.date === date);
  const totals = {
    calories: foodLogs.reduce((s, f) => s + (f.calories ?? 0), 0),
    protein: foodLogs.reduce((s, f) => s + (f.protein ?? 0), 0),
    carbs: foodLogs.reduce((s, f) => s + (f.carbs ?? 0), 0),
    fat: foodLogs.reduce((s, f) => s + (f.fat ?? 0), 0),
  };

  return NextResponse.json({
    date,
    workouts,
    sleep: { night, naps },
    metrics: { hrv, restingHR, steps },
    nutrition: {
      logs: foodLogs,
      totals,
      balance: totalWorkoutCalories - totals.calories,
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function avgNum(vals: (number | null)[]): number | null {
  const finite = vals.filter((n) => n != null) as number[];
  return finite.length
    ? Math.round((finite.reduce((s, n) => s + n, 0) / finite.length) * 100) /
        100
    : null;
}

function buildSleep(e: { id: string; ts: string; data: Record<string, unknown> }) {
  const meta =
    e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>)
      : {};
  return {
    id: e.id,
    ts: e.ts,
    totalSleep_h: num(e.data.value),
    deep_h: num(meta.deep),
    rem_h: num(meta.rem),
    core_h: num(meta.core),
    awake_h: num(meta.awake),
    sleepStart: meta.sleepStart ?? null,
    sleepEnd: meta.sleepEnd ?? null,
  };
}
