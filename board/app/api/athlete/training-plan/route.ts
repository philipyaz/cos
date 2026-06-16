import { NextResponse } from "next/server";
import { listEntries } from "@/lib/health-store";
import {
  readAthlete, readApiKey, callClaude,
  isoWeek, formatDate, last7DaysFrom,
} from "@/lib/athlete-ai";

export const dynamic = "force-dynamic";

const DAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildSystemPrompt(
  profile: Record<string, unknown>,
  healthSummary: Record<string, unknown>,
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

  const monday = nextMonday();
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { date: formatDate(d), day: DAYS_FR[i] };
  });

  return `Tu es un coach sportif expert en planification d'entrainement.
Tu generes un plan d'entrainement hebdomadaire personnalise au format JSON.

# Profil athlete
${JSON.stringify(profile, null, 2)}

# Date actuelle : ${today}
${goalDate ? `# Date objectif : ${goalDate} (${daysLeft})` : "# Pas de date objectif definie"}

# Historique des 7 derniers jours (donnees Apple Watch)
${JSON.stringify(healthSummary, null, 2)}

# Semaine a planifier
${JSON.stringify(weekDates, null, 2)}

# Regles
- Respecte les contraintes : sports disponibles, equipement, jours dispo (${profile.daysPerWeek ?? "non precise"}), duree max seance (${profile.maxSessionMinutes ?? "non precisee"} min).
- Si les jours dispo < 7, les jours restants sont repos ou recuperation active.
- Adapte l'intensite selon l'etat de recuperation (HRV, sommeil, charge recente).
- Evalue recovery_status : "good" si HRV stable/eleve + bon sommeil, "moderate" si moyen, "poor" si HRV bas ou mauvais sommeil.
- Le champ "zones" decrit les zones d'effort (Z1-Z5) ou RPE.
- Privilegie la progression douce et la prevention des blessures.
- Pour un objectif triathlon, alterne les 3 disciplines.
- Pour perte de poids, favorise les seances longues moderees + HIIT court.

# Format de reponse
Reponds UNIQUEMENT avec un objet JSON valide, sans texte avant/apres, sans markdown :
{
  "week": "${isoWeek(monday)}",
  "generated_at": "<ISO timestamp>",
  "recovery_status": "good|moderate|poor",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "day": "Lundi|Mardi|...",
      "type": "entrainement|repos|recuperation active",
      "sport": "<nom du sport ou Repos>",
      "duration_min": <number>,
      "intensity": "legere|moderee|intense",
      "description": "<description detaillee de la seance>",
      "zones": "<zones d'effort ou RPE>"
    }
  ],
  "weekly_notes": "<resume et conseils pour la semaine>"
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

  const fromISO = last7DaysFrom();
  const [workouts, sleep, hrv] = await Promise.all([
    listEntries({ type: "workout", from: fromISO, limit: 50 }),
    listEntries({ type: "sleep", from: fromISO, limit: 14 }),
    listEntries({ type: "hrv", from: fromISO, limit: 14 }),
  ]);

  const healthSummary = {
    workouts: workouts.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      activity: e.data.activity,
      duration_min: e.data.duration_min,
      distance_km: e.data.distance_km,
      avg_hr: e.data.avg_hr,
      calories: e.data.calories,
    })),
    sleep: sleep.entries.map((e) => {
      const meta = e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>) : {};
      return {
        date: e.ts.slice(0, 10),
        duration_hours: e.data.value,
        deep: meta.deep,
        rem: meta.rem,
      };
    }),
    hrv: hrv.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      avg_ms: e.data.value ?? e.data.avg_ms,
    })),
  };

  const today = formatDate(new Date());
  const systemPrompt = buildSystemPrompt(profile, healthSummary, today);
  const result = await callClaude(apiKey, systemPrompt, "Genere le plan d'entrainement pour la semaine prochaine.");

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  return NextResponse.json({ plan: result.json });
}
