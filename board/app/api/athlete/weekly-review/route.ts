import { NextResponse } from "next/server";
import { listEntries } from "@/lib/health-store";
import { readDB } from "@/lib/store";
import {
  readAthlete, readApiKey, callClaude,
  isoWeek, formatDate, last7DaysFrom,
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

  // Health data — last 7 days
  const fromISO = last7DaysFrom();
  const [workouts, sleepData, hrvData, stepsData, restingHrData] = await Promise.all([
    listEntries({ type: "workout", from: fromISO, limit: 50 }),
    listEntries({ type: "sleep", from: fromISO, limit: 14 }),
    listEntries({ type: "hrv", from: fromISO, limit: 14 }),
    listEntries({ type: "steps", from: fromISO, limit: 14 }),
    listEntries({ type: "resting_hr", from: fromISO, limit: 14 }),
  ]);

  const health = {
    workouts: workouts.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      activity: e.data.activity,
      duration_min: e.data.duration_min,
      distance_km: e.data.distance_km,
      avg_hr: e.data.avg_hr,
      calories: e.data.calories,
    })),
    sleep: sleepData.entries.map((e) => {
      const meta = e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>) : {};
      return {
        date: e.ts.slice(0, 10),
        duration_hours: e.data.value,
        deep_hours: meta.deep,
        rem_hours: meta.rem,
      };
    }),
    hrv: hrvData.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      avg_ms: e.data.value ?? e.data.avg_ms,
    })),
    steps: stepsData.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      count: e.data.value ?? e.data.count,
    })),
    resting_hr: restingHrData.entries.map((e) => ({
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

  return NextResponse.json({ review: result.json });
}
