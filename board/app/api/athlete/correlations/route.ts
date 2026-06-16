import { NextResponse, type NextRequest } from "next/server";
import { listEntries } from "@/lib/health";
import { pearson, linearRegression } from "@/lib/athlete-correlations";

export const dynamic = "force-dynamic";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// GET /api/athlete/correlations?days=N — correlate per-day sleep against workout performance
// (calories per minute) over the last N days, reading the CANONICAL health taxonomy via
// listEntries (workout data.duration_min/calories, sleep_night data.value + data.metadata.deep).
export async function GET(req: NextRequest) {
  const daysParam = req.nextUrl.searchParams.get("days")?.trim();
  const days = daysParam ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 7 || days > 365) {
    return NextResponse.json({ error: "days must be between 7 and 365." }, { status: 400 });
  }

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  const fromDate = fmtDate(from);
  const toDate = fmtDate(new Date(today.getTime() + 86400000));

  const [workoutsRes, sleepRes] = await Promise.all([
    listEntries({ type: "workout", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "sleep_night", from: fromDate, to: toDate, limit: 0 }),
  ]);

  const inRange = (e: { ts: string }) => e.ts >= fromDate && e.ts < toDate + "T";

  // Group workouts by date (aggregate calories + minutes per day)
  const workoutsByDate: Record<string, { totalCal: number; totalMin: number }> = {};
  for (const e of workoutsRes.entries.filter(inRange)) {
    const date = e.ts.slice(0, 10);
    const cal = num(e.data.calories) ?? 0;
    const dur = num(e.data.duration_min) ?? 0;
    if (dur <= 0) continue;
    const existing = workoutsByDate[date];
    if (existing) {
      existing.totalCal += cal;
      existing.totalMin += dur;
    } else {
      workoutsByDate[date] = { totalCal: cal, totalMin: dur };
    }
  }

  // Group sleep by date (value = total hours; metadata.deep = deep hours)
  const sleepByDate: Record<string, { total_h: number; deep_h: number | null }> = {};
  for (const e of sleepRes.entries.filter(inRange)) {
    const date = e.ts.slice(0, 10);
    const total = num(e.data.value);
    if (total == null) continue;
    const meta = e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>) : {};
    sleepByDate[date] = { total_h: total, deep_h: num(meta.deep) };
  }

  // Match days with both workout and sleep
  const dataPoints: {
    date: string;
    sleep_h: number;
    deep_h: number | null;
    performance: number;
    calories: number;
    duration_min: number;
  }[] = [];

  for (const date of Object.keys(workoutsByDate)) {
    const sleep = sleepByDate[date];
    if (!sleep) continue;
    const w = workoutsByDate[date];
    const perf = w.totalMin > 0 ? w.totalCal / w.totalMin : 0;
    dataPoints.push({
      date,
      sleep_h: sleep.total_h,
      deep_h: sleep.deep_h,
      performance: Math.round(perf * 100) / 100,
      calories: w.totalCal,
      duration_min: w.totalMin,
    });
  }

  dataPoints.sort((a, b) => a.date.localeCompare(b.date));

  const sleepVals = dataPoints.map((p) => p.sleep_h);
  const perfVals = dataPoints.map((p) => p.performance);
  const r = pearson(sleepVals, perfVals);
  const regression = linearRegression(sleepVals, perfVals);

  // Deep-sleep correlation (only days that recorded deep sleep)
  const deepPoints = dataPoints.filter((p) => p.deep_h != null);
  const deepVals = deepPoints.map((p) => p.deep_h!);
  const deepPerfVals = deepPoints.map((p) => p.performance);
  const rDeep = pearson(deepVals, deepPerfVals);

  return NextResponse.json({
    days,
    data_points: dataPoints.length,
    correlation: {
      sleep_vs_performance: r != null ? Math.round(r * 1000) / 1000 : null,
      deep_sleep_vs_performance: rDeep != null ? Math.round(rDeep * 1000) / 1000 : null,
    },
    regression: regression ? {
      slope: Math.round(regression.slope * 1000) / 1000,
      intercept: Math.round(regression.intercept * 1000) / 1000,
    } : null,
    points: dataPoints,
  });
}
