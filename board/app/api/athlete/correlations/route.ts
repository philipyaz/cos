import { NextResponse, type NextRequest } from "next/server";
import { listEntries } from "@/lib/health-store";

export const dynamic = "force-dynamic";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

export async function GET(req: NextRequest) {
  const daysParam = req.nextUrl.searchParams.get("days")?.trim();
  const days = daysParam ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 7 || days > 365) {
    return NextResponse.json(
      { error: "days must be between 7 and 365." },
      { status: 400 },
    );
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

  // Group workouts by date
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

  // Group sleep by date
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

  // Deep sleep correlation too
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
