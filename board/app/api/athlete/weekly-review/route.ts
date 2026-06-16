import { NextResponse } from "next/server";
import { listEntries, getProfile } from "@/lib/health";
import { readDB } from "@/lib/store";
import { computeFormScore } from "@/lib/athlete-score";
import { readApiKey, callClaude, isoWeek, formatDate } from "@/lib/athlete-ai";

export const dynamic = "force-dynamic";

const STABLE_SYSTEM = `You are an expert sports coach and nutritionist.
You produce a complete, personalized weekly review as structured data.

Rules:
- Compute metrics from the raw data provided.
- overall_score (0-100): a global score considering training, sleep, recovery, and nutrition.
- training.vs_plan: compare actual load to the profile goals (days/week, sports).
- sleep.quality_trend: "improving" / "stable" / "declining" based on the week's evolution.
- recovery.fatigue_level: "low" / "moderate" / "high" based on HRV and resting HR.
- recommendations: 3 to 5 concrete, actionable tips for the coming week.
- If data is missing (0 entries), note it and base your analysis on what is available.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    week: { type: "string" },
    generated_at: { type: "string", description: "ISO timestamp" },
    overall_score: { type: "number" },
    summary: { type: "string", description: "short 2-3 sentence summary" },
    training: {
      type: "object",
      properties: {
        sessions_done: { type: "number" },
        total_volume_min: { type: "number" },
        total_distance_km: { type: "number" },
        sports_breakdown: { type: "object", additionalProperties: { type: "number" } },
        vs_plan: { type: "string" },
        highlights: { type: "array", items: { type: "string" } },
      },
      required: ["sessions_done", "total_volume_min", "vs_plan"],
    },
    sleep: {
      type: "object",
      properties: {
        avg_duration_h: { type: "number" },
        avg_deep_h: { type: "number" },
        avg_rem_h: { type: "number" },
        quality_trend: { type: "string", enum: ["improving", "stable", "declining"] },
        notes: { type: "string" },
      },
      required: ["quality_trend", "notes"],
    },
    recovery: {
      type: "object",
      properties: {
        avg_hrv: { type: "number" },
        avg_resting_hr: { type: "number" },
        fatigue_level: { type: "string", enum: ["low", "moderate", "high"] },
        notes: { type: "string" },
      },
      required: ["fatigue_level", "notes"],
    },
    nutrition: {
      type: "object",
      properties: {
        days_logged: { type: "number" },
        avg_calories: { type: "number" },
        notes: { type: "string" },
      },
      required: ["notes"],
    },
    recommendations: { type: "array", items: { type: "string" } },
    next_week_focus: { type: "string" },
  },
  required: ["week", "generated_at", "overall_score", "summary", "training", "sleep", "recovery", "recommendations", "next_week_focus"],
};

export async function GET() {
  const apiKey = await readApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured (config/secrets.env)." },
      { status: 500 },
    );
  }

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "No athlete profile found. Save your profile first at /athlete." },
      { status: 404 },
    );
  }

  // Health data — last 7 days. Date-only boundaries so the filter handles both date-only and
  // full-ISO ts. Canonical types: sleep_night, hrv (NOT "heart_rate_variability"), steps,
  // resting_hr, workout.
  const fromDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })());
  const toDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })());

  const [workouts, sleepData, hrvData, stepsData, restingHrData] = await Promise.all([
    listEntries({ type: "workout", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "sleep_night", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "hrv", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "steps", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "resting_hr", from: fromDate, to: toDate, limit: 0 }),
  ]);

  const inRange = (e: { ts: string }) => e.ts >= fromDate && e.ts < toDate + "T";

  const health = {
    workouts: workouts.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      activity: e.data.activity,
      duration_min: e.data.duration_min,
      distance_km: e.data.distance_km,
      avg_hr: e.data.avg_hr,
      calories: e.data.calories,
    })),
    sleep: sleepData.entries.filter(inRange).map((e) => {
      const meta = e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>) : {};
      return {
        date: e.ts.slice(0, 10),
        duration_hours: e.data.value,
        deep_hours: meta.deep,
        rem_hours: meta.rem,
      };
    }),
    hrv: hrvData.entries.filter(inRange).map((e) => ({ date: e.ts.slice(0, 10), avg_ms: e.data.value })),
    steps: stepsData.entries.filter(inRange).map((e) => ({ date: e.ts.slice(0, 10), count: e.data.value })),
    resting_hr: restingHrData.entries.filter(inRange).map((e) => ({ date: e.ts.slice(0, 10), bpm: e.data.value })),
  };

  // Food logs — last 7 days (the SOFT nutrition dependency: graceful ?? [] + date filter, NOT
  // gated on isAddonEnabled — a disabled nutrition add-on's logs simply read empty).
  const sevenDaysAgoDate = fromDate;
  let nutrition: Record<string, unknown> = { foodLogs: [] };
  try {
    const db = await readDB();
    const logs = (db.foodLogs ?? []).filter((f) => f.date >= sevenDaysAgoDate);
    nutrition = {
      foodLogs: logs.map((f) => ({
        date: f.date,
        slot: f.slot,
        description: f.description,
        calories: f.calories,
        protein: f.protein,
        carbs: f.carbs,
        fat: f.fat,
      })),
    };
  } catch {}

  const today = formatDate(new Date());
  const week = isoWeek(new Date());
  const goalDate = profile.goalDate || undefined;
  let daysLeft = "";
  if (goalDate) {
    const diff = Math.ceil((new Date(goalDate).getTime() - new Date(today).getTime()) / 86400000);
    daysLeft = diff > 0 ? `${diff} days remaining` : "Goal date passed";
  }

  const volatileSystem = `# Athlete profile
${JSON.stringify(profile, null, 2)}

# Current date: ${today}
# Week analyzed: ${week}
${goalDate ? `# Goal date: ${goalDate} (${daysLeft})` : "# No goal date set"}

# Training data, last 7 days (Apple Watch)
${JSON.stringify(health, null, 2)}

# Nutrition data, last 7 days (food logs)
${JSON.stringify(nutrition, null, 2)}

# Use ISO week ${week} for the "week" field.`;

  const result = await callClaude({
    apiKey,
    stableSystem: STABLE_SYSTEM,
    volatileSystem,
    userMessage: "Generate the complete review for the past week.",
    toolName: "submit_weekly_review",
    toolDescription: "Submit the complete weekly review.",
    schema: REVIEW_SCHEMA,
  });

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  // Daily form scores for the past 7 days — computed IN-PROCESS (no loopback fetch to
  // /api/athlete/form-score).
  const dates: string[] = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
  }

  const scores: number[] = [];
  const scoreResults = await Promise.allSettled(dates.map((d) => computeFormScore(d)));
  for (const r of scoreResults) {
    if (r.status === "fulfilled" && r.value?.score != null) scores.push(r.value.score);
  }

  const avgFormScore = scores.length > 0
    ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    : null;

  let formTrend: string | null = null;
  if (scores.length >= 4) {
    const half = Math.floor(scores.length / 2);
    const avgFirst = scores.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const avgSecond = scores.slice(half).reduce((s, v) => s + v, 0) / (scores.length - half);
    const diff = avgSecond - avgFirst;
    formTrend = diff > 5 ? "improving" : diff < -5 ? "declining" : "stable";
  }

  const review = {
    ...(result.json as Record<string, unknown>),
    avg_form_score: avgFormScore,
    form_trend: formTrend,
  };

  return NextResponse.json({ review });
}
