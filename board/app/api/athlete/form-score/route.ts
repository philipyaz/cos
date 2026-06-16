import { NextResponse, type NextRequest } from "next/server";
import { listEntries } from "@/lib/health-store";

export const dynamic = "force-dynamic";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ── Score computation ────────────────────────────────────────────────────────

function scoreHRV(todayHRV: number | null, baseline: number | null): number {
  if (todayHRV == null || baseline == null || baseline === 0) return 50; // neutral if no data
  return clamp((todayHRV / baseline) * 100);
}

function scoreSleep(totalH: number | null, deepH: number | null): number {
  // Total sleep: <6h → 0, 8h → 100, linear
  let s: number;
  if (totalH == null) return 50; // neutral
  if (totalH <= 6) s = 0;
  else if (totalH >= 8) s = 100;
  else s = ((totalH - 6) / 2) * 100;

  // Deep sleep bonus/malus
  if (deepH != null) {
    if (deepH >= 1.5) s += 10;
    else if (deepH < 0.3) s -= 10;
  }

  return clamp(s);
}

function scoreRestingHR(todayBPM: number | null, baseline: number | null): number {
  if (todayBPM == null || baseline == null || todayBPM === 0) return 50;
  return clamp((baseline / todayBPM) * 100);
}

function scoreLoad(totalMin: number): number {
  if (totalMin < 60) return 100;
  if (totalMin <= 180) return 75;
  if (totalMin <= 360) return 50;
  return 25;
}

function overallLevel(score: number): { level: string; color: string } {
  if (score >= 75) return { level: "bon", color: "green" };
  if (score >= 50) return { level: "modere", color: "amber" };
  if (score >= 30) return { level: "faible", color: "red" };
  return { level: "insuffisant", color: "red" };
}

function recommendation(score: number, breakdown: { hrv: number; sleep: number; resting_hr: number; load: number }): string {
  if (score >= 80) return "Forme excellente. Bon moment pour une seance intense ou un test de performance.";
  if (score >= 65) return "Bonne forme generale. Entrainement normal, pas de restriction.";
  if (breakdown.sleep < 40) return "Sommeil insuffisant. Privilegiez une seance legere ou du repos.";
  if (breakdown.hrv < 40) return "HRV bas, signe de fatigue accumulee. Seance legere recommandee.";
  if (breakdown.load < 40) return "Charge elevee ces derniers jours. Journee de recuperation active conseillee.";
  if (score >= 50) return "Forme moderee. Seance a intensite moderee recommandee.";
  return "Forme basse. Repos ou recuperation active fortement recommandes.";
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date")?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "Query param 'date' is required as YYYY-MM-DD." },
      { status: 400 },
    );
  }

  // Date ranges: 7-day lookback for baselines, 3-day lookback for training load
  const d7 = new Date(date + "T00:00:00Z");
  d7.setUTCDate(d7.getUTCDate() - 7);
  const from7 = fmtDate(d7);

  const d3 = new Date(date + "T00:00:00Z");
  d3.setUTCDate(d3.getUTCDate() - 3);
  const from3 = fmtDate(d3);

  const to = nextDate(date);

  // Fetch all needed data in parallel
  const [hrvAll, sleepAll, restingHrAll, workoutsRecent] = await Promise.all([
    listEntries({ type: "heart_rate_variability", from: from7, to, limit: 0 }),
    listEntries({ type: "sleep_night", from: from7, to, limit: 0 }),
    listEntries({ type: "resting_hr", from: from7, to, limit: 0 }),
    listEntries({ type: "workout", from: from3, to: date, limit: 0 }), // J-3 to J-1 (exclude target date)
  ]);

  // Filter entries that match the date range (handles date-only vs ISO timestamps)
  const inRange = (from: string, toD: string) => (e: { ts: string }) =>
    e.ts >= from && (e.ts < toD || e.ts.startsWith(toD.slice(0, -1)));
  const onDate = (d: string) => (e: { ts: string }) =>
    e.ts === d || e.ts.startsWith(d + "T");

  // ── HRV ──
  const hrvEntries = hrvAll.entries.filter(inRange(from7, to));
  const hrvValues = hrvEntries.map((e) => num(e.data.value) ?? num(e.data.avg_ms)).filter((n) => n != null) as number[];
  const hrvToday = hrvEntries.filter(onDate(date)).map((e) => num(e.data.value) ?? num(e.data.avg_ms)).filter((n) => n != null) as number[];
  const hrvBaseline = hrvValues.length > 0 ? hrvValues.reduce((s, n) => s + n, 0) / hrvValues.length : null;
  const hrvDayVal = hrvToday.length > 0 ? hrvToday.reduce((s, n) => s + n, 0) / hrvToday.length : null;

  // ── Sleep ──
  const sleepToday = sleepAll.entries.filter(onDate(date));
  let totalSleepH: number | null = null;
  let deepH: number | null = null;
  if (sleepToday.length > 0) {
    const e = sleepToday[0];
    totalSleepH = num(e.data.value);
    const meta = e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>) : {};
    deepH = num(meta.deep);
  }

  // ── Resting HR ──
  const restingEntries = restingHrAll.entries.filter(inRange(from7, to));
  const restingValues = restingEntries.map((e) => num(e.data.value) ?? num(e.data.bpm)).filter((n) => n != null) as number[];
  const restingToday = restingEntries.filter(onDate(date)).map((e) => num(e.data.value) ?? num(e.data.bpm)).filter((n) => n != null) as number[];
  const restingBaseline = restingValues.length > 0 ? restingValues.reduce((s, n) => s + n, 0) / restingValues.length : null;
  const restingDayVal = restingToday.length > 0 ? restingToday.reduce((s, n) => s + n, 0) / restingToday.length : null;

  // ── Training load (J-1, J-2, J-3) ──
  const loadEntries = workoutsRecent.entries.filter(inRange(from3, date));
  const loadMin = loadEntries.reduce((s, e) => {
    const dur = num(e.data.duration_min);
    return s + (dur ?? 0);
  }, 0);

  // ── Compute scores ──
  const bkHrv = scoreHRV(hrvDayVal, hrvBaseline);
  const bkSleep = scoreSleep(totalSleepH, deepH);
  const bkResting = scoreRestingHR(restingDayVal, restingBaseline);
  const bkLoad = scoreLoad(loadMin);

  const overall = clamp(
    bkHrv * 0.3 + bkSleep * 0.3 + bkResting * 0.2 + bkLoad * 0.2,
  );

  const { level, color } = overallLevel(overall);
  const breakdown = { hrv: bkHrv, sleep: bkSleep, resting_hr: bkResting, load: bkLoad };

  console.log(
    `[form-score] date=${date} | score=${overall} (hrv=${bkHrv} sleep=${bkSleep} rhr=${bkResting} load=${bkLoad}) | hrvDay=${hrvDayVal?.toFixed(1)} hrvBase=${hrvBaseline?.toFixed(1)} sleepH=${totalSleepH} deepH=${deepH} rhrDay=${restingDayVal?.toFixed(1)} rhrBase=${restingBaseline?.toFixed(1)} loadMin=${loadMin}`,
  );

  return NextResponse.json({
    date,
    score: overall,
    level,
    color,
    breakdown,
    recommendation: recommendation(overall, breakdown),
  });
}
