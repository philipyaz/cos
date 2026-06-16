import { NextResponse } from "next/server";
import { listEntries } from "@/lib/health-store";
import {
  readAthlete, readApiKey, callClaude, formatDate,
} from "@/lib/athlete-ai";

export const dynamic = "force-dynamic";

function nextDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

  const today = formatDate(new Date());
  const to = nextDate(today);
  const d2 = new Date(today + "T00:00:00Z");
  d2.setUTCDate(d2.getUTCDate() - 2);
  const from48h = formatDate(d2);

  // Fetch form-score for today (internal API call via same host)
  let formScore: Record<string, unknown> = {};
  try {
    const boardUrl = process.env.BOARD_URL || "http://localhost:3000";
    const fsRes = await fetch(`${boardUrl}/api/athlete/form-score?date=${today}`);
    if (fsRes.ok) formScore = await fsRes.json();
  } catch {}

  // Last 48h workouts + last night sleep
  const inRange = (from: string, toD: string) => (e: { ts: string }) =>
    e.ts >= from && e.ts < toD + "T";

  const [workoutsRes, sleepRes] = await Promise.all([
    listEntries({ type: "workout", from: from48h, to, limit: 0 }),
    listEntries({ type: "sleep_night", from: from48h, to, limit: 0 }),
  ]);

  const workouts = workoutsRes.entries.filter(inRange(from48h, to)).map((e) => ({
    date: e.ts.slice(0, 10),
    activity: e.data.activity,
    duration_min: num(e.data.duration_min),
    calories: num(e.data.calories),
    avg_hr: num(e.data.avg_hr),
  }));

  const sleepEntries = sleepRes.entries.filter(inRange(from48h, to));
  const lastSleep = sleepEntries.length > 0 ? (() => {
    const e = sleepEntries[0]; // newest first
    const meta = e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>) : {};
    return {
      date: e.ts.slice(0, 10),
      total_h: num(e.data.value),
      deep_h: num(meta.deep),
      rem_h: num(meta.rem),
    };
  })() : null;

  const systemPrompt = `Tu es un coach sportif expert. Tu analyses l'etat de forme actuel de l'athlete
pour generer un brief pre-entrainement au format JSON.

# Profil athlete
${JSON.stringify(profile, null, 2)}

# Score de forme du jour
${JSON.stringify(formScore, null, 2)}

# Workouts des 48 dernieres heures
${JSON.stringify(workouts, null, 2)}

# Sommeil derniere nuit
${JSON.stringify(lastSleep, null, 2)}

# Date actuelle : ${today}

# Regles
- readiness : "pret" si score >= 70 et bon sommeil, "prudent" si score 40-70 ou sommeil moyen, "repos recommande" si score < 40 ou tres mauvais sommeil.
- recommended_session : propose un sport/duree/intensite adaptes a l'etat actuel. Base-toi sur les sports du profil.
- warnings : liste les points de vigilance (fatigue, manque de sommeil, charge recente elevee).
- green_lights : liste les indicateurs positifs.
- one_liner : une phrase courte motivante ou de prudence selon l'etat.

# Format de reponse
Reponds UNIQUEMENT avec un objet JSON valide, sans texte avant/apres, sans markdown :
{
  "readiness": "pret|prudent|repos recommande",
  "form_score": <number 0-100>,
  "recommended_session": {
    "sport": "<nom du sport>",
    "duration_min": <number>,
    "intensity": "legere|moderee|intense",
    "description": "<description de la seance recommandee>"
  },
  "warnings": ["..."],
  "green_lights": ["..."],
  "one_liner": "<phrase courte>"
}`;

  const result = await callClaude(apiKey, systemPrompt, "Analyse ma forme actuelle et genere le brief pre-entrainement.");

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  return NextResponse.json({ brief: result.json });
}
