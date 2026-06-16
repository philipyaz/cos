// Pure "form score" (daily readiness) computation for the athlete surface. It reads the
// CANONICAL health-entry taxonomy (board/lib/types.ts) via listEntries from @/lib/health —
// hrv carries data.value=ms (type "hrv", NOT "heart_rate_variability"), resting_hr data.value=bpm,
// sleep_night data.value=hours + data.metadata.deep, workouts data.duration_min. The four
// sub-scorers each return 0..100; the overall is their weighted blend. No HTTP, no console.log:
// the form-score route is a thin GET over computeFormScore, and the weekly-review +
// pre-workout-brief routes call computeFormScore IN-PROCESS (no loopback fetch).

import { listEntries } from "./health";

export interface FormScoreBreakdown {
  hrv: number;
  sleep: number;
  resting_hr: number;
  load: number;
}

export interface FormScore {
  date: string;
  score: number;
  level: string;
  color: string;
  breakdown: FormScoreBreakdown;
  recommendation: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

const onDate = (d: string) => (e: { ts: string }) => e.ts === d || e.ts.startsWith(d + "T");
const inRange = (from: string, to: string) => (e: { ts: string }) =>
  e.ts >= from && (e.ts < to || e.ts.startsWith(to.slice(0, -1)));

function mean(vals: number[]): number | null {
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : null;
}

// ── sub-scorers (each 0..100; 50 == neutral / no data) ─────────────────────────

export function scoreHRV(todayHRV: number | null, baseline: number | null): number {
  if (todayHRV == null || baseline == null || baseline === 0) return 50;
  return clamp((todayHRV / baseline) * 100);
}

export function scoreSleep(totalH: number | null, deepH: number | null): number {
  if (totalH == null) return 50;
  let s: number;
  if (totalH <= 6) s = 0;
  else if (totalH >= 8) s = 100;
  else s = ((totalH - 6) / 2) * 100;

  if (deepH != null) {
    if (deepH >= 1.5) s += 10;
    else if (deepH < 0.3) s -= 10;
  }
  return clamp(s);
}

export function scoreRestingHR(todayBPM: number | null, baseline: number | null): number {
  if (todayBPM == null || baseline == null || todayBPM === 0) return 50;
  return clamp((baseline / todayBPM) * 100);
}

export function scoreLoad(totalMin: number): number {
  if (totalMin < 60) return 100;
  if (totalMin <= 180) return 75;
  if (totalMin <= 360) return 50;
  return 25;
}

function overallLevel(score: number): { level: string; color: string } {
  if (score >= 75) return { level: "good", color: "green" };
  if (score >= 50) return { level: "moderate", color: "amber" };
  if (score >= 30) return { level: "low", color: "red" };
  return { level: "insufficient", color: "red" };
}

function recommendation(score: number, b: FormScoreBreakdown): string {
  if (score >= 80) return "Excellent form. A good day for an intense session or a performance test.";
  if (score >= 65) return "Good overall form. Train as normal — no restrictions.";
  if (b.sleep < 40) return "Insufficient sleep. Favor a light session or rest.";
  if (b.hrv < 40) return "Low HRV — a sign of accumulated fatigue. A light session is recommended.";
  if (b.load < 40) return "High training load over recent days. An active recovery day is advised.";
  if (score >= 50) return "Moderate form. A moderate-intensity session is recommended.";
  return "Low form. Rest or active recovery is strongly recommended.";
}

// ── the computation (in-process; reads the canonical taxonomy) ─────────────────

/**
 * Compute the daily form score for `date` ("YYYY-MM-DD"). Pulls a 7-day window for the HRV /
 * resting-HR baselines + the target-day sleep, and a 3-day (J-3..J-1) window for training load.
 * All reads go through listEntries (the ungated health read) using CANONICAL types + data.value.
 */
export async function computeFormScore(date: string): Promise<FormScore> {
  const d7 = new Date(date + "T00:00:00Z");
  d7.setUTCDate(d7.getUTCDate() - 7);
  const from7 = fmtDate(d7);

  const d3 = new Date(date + "T00:00:00Z");
  d3.setUTCDate(d3.getUTCDate() - 3);
  const from3 = fmtDate(d3);

  const to = nextDate(date);

  const [hrvAll, sleepAll, restingHrAll, workoutsRecent] = await Promise.all([
    listEntries({ type: "hrv", from: from7, to, limit: 0 }),
    listEntries({ type: "sleep_night", from: from7, to, limit: 0 }),
    listEntries({ type: "resting_hr", from: from7, to, limit: 0 }),
    listEntries({ type: "workout", from: from3, to: date, limit: 0 }), // J-3..J-1 (exclude target)
  ]);

  // ── HRV ──
  const hrvEntries = hrvAll.entries.filter(inRange(from7, to));
  const hrvBaseline = mean(
    hrvEntries.map((e) => num(e.data.value)).filter((n): n is number => n != null),
  );
  const hrvDayVal = mean(
    hrvEntries.filter(onDate(date)).map((e) => num(e.data.value)).filter((n): n is number => n != null),
  );

  // ── Sleep (target day) ──
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
  const restingBaseline = mean(
    restingEntries.map((e) => num(e.data.value)).filter((n): n is number => n != null),
  );
  const restingDayVal = mean(
    restingEntries.filter(onDate(date)).map((e) => num(e.data.value)).filter((n): n is number => n != null),
  );

  // ── Training load (J-1, J-2, J-3) ──
  const loadEntries = workoutsRecent.entries.filter(inRange(from3, date));
  const loadMin = loadEntries.reduce((s, e) => s + (num(e.data.duration_min) ?? 0), 0);

  const breakdown: FormScoreBreakdown = {
    hrv: scoreHRV(hrvDayVal, hrvBaseline),
    sleep: scoreSleep(totalSleepH, deepH),
    resting_hr: scoreRestingHR(restingDayVal, restingBaseline),
    load: scoreLoad(loadMin),
  };

  const score = clamp(
    breakdown.hrv * 0.3 + breakdown.sleep * 0.3 + breakdown.resting_hr * 0.2 + breakdown.load * 0.2,
  );
  const { level, color } = overallLevel(score);

  return { date, score, level, color, breakdown, recommendation: recommendation(score, breakdown) };
}
