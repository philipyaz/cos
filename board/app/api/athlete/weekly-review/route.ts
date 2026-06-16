import { NextResponse } from "next/server";
import { listEntries } from "@/lib/health-store";
import { readDB } from "@/lib/store";
import {
  readAthlete, readApiKey, callClaude,
  isoWeek, formatDate,
} from "@/lib/athlete-ai";

export const dynamic = "force-dynamic";

function buildSystemPrompt(
  profile: Record<string, unknown>,
  health: Record<string, unknown>,
  nutrition: Record<string, unknown>,
  today: string,
): string {
  const goalDate = profile.goalDate as string | undefined;
  let daysLeft = "";
  if (goalDate) {
    const diff = Math.ceil(
      (new Date(goalDate).getTime() - new Date(today).getTime()) / 86400000,
    );
    daysLeft = diff > 0 ? `${diff} jours restants` : "Date objectif depassee";
  }

  const now = new Date();
  const week = isoWeek(now);

  return `Tu es un coach sportif et nutritionniste expert.
Tu generes un bilan hebdomadaire complet et personnalise au format JSON.

# Profil athlete
${JSON.stringify(profile, null, 2)}

# Date actuelle : ${today}
# Semaine analysee : ${week}
${goalDate ? `# Date objectif : ${goalDate} (${daysLeft})` : "# Pas de date objectif definie"}

# Donnees d'entrainement des 7 derniers jours (Apple Watch)
${JSON.stringify(health, null, 2)}

# Donnees nutritionnelles des 7 derniers jours (food logs)
${JSON.stringify(nutrition, null, 2)}

# Regles
- Calcule les metriques a partir des donnees brutes fournies.
- overall_score (0-100) : note globale considerant entrainement, sommeil, recuperation, nutrition.
- training.vs_plan : compare la charge reelle aux objectifs du profil (jours/semaine, sports).
- sleep.quality_trend : "en hausse" / "stable" / "en baisse" selon l'evolution sur la semaine.
- recovery.fatigue_level : "faible" / "moderee" / "elevee" selon HRV et FC repos.
- recommendations : 3 a 5 conseils concrets et actionables pour la semaine prochaine.
- Si des donnees manquent (0 entries), note-le et base ton analyse sur ce qui est disponible.

# Format de reponse
Reponds UNIQUEMENT avec un objet JSON valide, sans texte avant/apres, sans markdown :
{
  "week": "${week}",
  "generated_at": "<ISO timestamp>",
  "overall_score": <0-100>,
  "summary": "<texte court 2-3 phrases>",
  "training": {
    "sessions_done": <number>,
    "total_volume_min": <number>,
    "total_distance_km": <number>,
    "sports_breakdown": { "<sport>": <minutes>, ... },
    "vs_plan": "<commentaire>",
    "highlights": ["..."]
  },
  "sleep": {
    "avg_duration_h": <number>,
    "avg_deep_h": <number>,
    "avg_rem_h": <number>,
    "quality_trend": "en hausse|stable|en baisse",
    "notes": "..."
  },
  "recovery": {
    "avg_hrv": <number>,
    "avg_resting_hr": <number>,
    "fatigue_level": "faible|moderee|elevee",
    "notes": "..."
  },
  "nutrition": {
    "days_logged": <number>,
    "avg_calories": <number>,
    "notes": "..."
  },
  "recommendations": ["...", "...", "..."],
  "next_week_focus": "..."
}`;
}

export async function GET() {
  const apiKey = await readApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured (config/secrets.env)." },
      { status: 500 },
    );
  }

  const profile = await readAthlete();
  if (!profile) {
    return NextResponse.json(
      { error: "No athlete profile found. Save your profile first at /athlete." },
      { status: 404 },
    );
  }

  // Health data — last 7 days.
  // Use date-only boundaries (YYYY-MM-DD) so the string-compare pre-filter in
  // listEntries works for BOTH date-only ts ("2026-06-09") and full ISO ts
  // ("2026-06-09T..."). Same approach as daily-summary.
  const fromDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })());
  const toDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })());

  // Type names must match what's actually stored in health.json:
  //   sleep_night (not "sleep"), heart_rate_variability (not "hrv"),
  //   steps, resting_hr, workout.
  const [workouts, sleepData, hrvData, stepsData, restingHrData] = await Promise.all([
    listEntries({ type: "workout", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "sleep_night", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "heart_rate_variability", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "steps", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "resting_hr", from: fromDate, to: toDate, limit: 0 }),
  ]);

  // Post-filter: keep only entries whose ts starts with a date in the range
  const inRange = (e: { ts: string }) => e.ts >= fromDate && e.ts < toDate + "T";

  console.log(
    `[weekly-review] range ${fromDate}..${toDate} | workout: ${workouts.entries.filter(inRange).length}, sleep_night: ${sleepData.entries.filter(inRange).length}, hrv: ${hrvData.entries.filter(inRange).length}, steps: ${stepsData.entries.filter(inRange).length}, resting_hr: ${restingHrData.entries.filter(inRange).length}`,
  );

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
    hrv: hrvData.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      avg_ms: e.data.value ?? e.data.avg_ms,
    })),
    steps: stepsData.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      count: e.data.value ?? e.data.count,
    })),
    resting_hr: restingHrData.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      bpm: e.data.value ?? e.data.bpm,
    })),
  };

  // Food logs — last 7 days from cases.json
  const sevenDaysAgoDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })());
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
  const systemPrompt = buildSystemPrompt(profile, health, nutrition, today);
  const result = await callClaude(apiKey, systemPrompt, "Genere le bilan complet de la semaine ecoulee.");

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  // Compute daily form scores for the 7 days
  const boardUrl = process.env.BOARD_URL || "http://localhost:3000";
  const dates: string[] = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
  }

  const scores: number[] = [];
  const scoreResults = await Promise.allSettled(
    dates.map((d) =>
      fetch(`${boardUrl}/api/athlete/form-score?date=${d}`)
        .then((r) => (r.ok ? r.json() : null)),
    ),
  );
  for (const r of scoreResults) {
    if (r.status === "fulfilled" && r.value?.score != null) {
      scores.push(r.value.score);
    }
  }

  const avgFormScore = scores.length > 0
    ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    : null;

  let formTrend: string | null = null;
  if (scores.length >= 4) {
    const half = Math.floor(scores.length / 2);
    const firstHalf = scores.slice(0, half);
    const secondHalf = scores.slice(half);
    const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    const diff = avgSecond - avgFirst;
    if (diff > 5) formTrend = "hausse";
    else if (diff < -5) formTrend = "baisse";
    else formTrend = "stable";
  }

  const review = {
    ...(result.json as Record<string, unknown>),
    avg_form_score: avgFormScore,
    form_trend: formTrend,
  };

  return NextResponse.json({ review });
}
