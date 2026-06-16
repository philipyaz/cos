import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listEntries } from "@/lib/health-store";

export const dynamic = "force-dynamic";

// ── Read athlete profile ────────────────────────────────────────────────────

const DATA_DIR = process.env.COS_DATA_DIR || path.join(process.cwd(), "data");
const ATHLETE_FILE = path.join(DATA_DIR, "athlete.json");

async function readAthlete(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(ATHLETE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// ── Read Anthropic API key from config/secrets.env ──────────────────────────

async function readApiKey(): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "..", "config", "secrets.env"),
      "utf8",
    );
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^ANTHROPIC_API_KEY=(.*)$/);
      if (m) {
        let v = m[1] ?? "";
        if (
          v.length >= 2 &&
          ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'")))
        )
          v = v.slice(1, -1);
        v = v.trim();
        if (v && !v.toLowerCase().includes("xxxx") && !v.toLowerCase().startsWith("your"))
          return v;
      }
    }
  } catch {}
  // Fallback: env var (e.g. from .env.local or process env)
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function isoWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Build the Claude prompt ─────────────────────────────────────────────────

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

// ── GET handler ─────────────────────────────────────────────────────────────

export async function GET() {
  // 1. Read API key
  const apiKey = await readApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured (config/secrets.env)." },
      { status: 500 },
    );
  }

  // 2. Read athlete profile
  const profile = await readAthlete();
  if (!profile) {
    return NextResponse.json(
      { error: "No athlete profile found. Save your profile first at /athlete." },
      { status: 404 },
    );
  }

  // 3. Fetch last 7 days of health data
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fromISO = sevenDaysAgo.toISOString();

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
    sleep: sleep.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      duration_hours: e.data.value,
      deep: e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>).deep
        : undefined,
      rem: e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>).rem
        : undefined,
    })),
    hrv: hrv.entries.map((e) => ({
      date: e.ts.slice(0, 10),
      avg_ms: e.data.value ?? e.data.avg_ms,
    })),
  };

  const today = formatDate(now);
  const systemPrompt = buildSystemPrompt(profile, healthSummary, today);

  // 4. Call Anthropic API
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: "Genere le plan d'entrainement pour la semaine prochaine.",
          },
        ],
        system: systemPrompt,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      return NextResponse.json(
        { error: `Anthropic API error (${res.status}): ${err}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const text: string =
      data.content?.[0]?.text ?? "";

    // Parse the JSON from Claude's response
    // Strip potential markdown fences
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse training plan JSON from LLM response.", raw: text },
        { status: 502 },
      );
    }

    return NextResponse.json({ plan });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to call Anthropic API: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
