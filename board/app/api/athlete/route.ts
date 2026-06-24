import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const ATHLETE_FILE = path.join(
  process.env.COS_DATA_DIR || path.join(process.cwd(), "data"),
  "athlete.json",
);

export interface AthleteProfile {
  goal: string;
  goalDate: string;
  level: string;
  currentWeight: number | null;
  targetWeight: number | null;
  daysPerWeek: number | null;
  maxSessionMinutes: number | null;
  sports: string[];
  equipment: string[];
  notes: string;
  updatedAt: string;
}

const VALID_GOALS = [
  "perte_de_poids",
  "triathlon_sprint",
  "triathlon_olympique",
  "cyclisme",
  "natation",
  "course_a_pied",
  "forme_generale",
];

const VALID_LEVELS = ["debutant", "intermediaire", "avance"];

const VALID_SPORTS = [
  // Cardio
  "velo_exterieur", "velo_interieur", "course_a_pied", "marche",
  "natation_piscine", "natation_eau_libre", "aviron",
  "ski_alpin", "ski_de_fond", "snowboard", "randonnee",
  "escalade", "surf", "kayak",
  // Force / Flex
  "musculation", "hiit", "yoga", "pilates", "danse",
  "arts_martiaux", "boxe", "crossfit", "stretching",
  // Autres
  "tennis", "padel", "football", "basketball", "cyclisme_indoor_zwift",
];

const VALID_EQUIPMENT = [
  "velo_route", "velo_home_trainer", "barre_traction", "halteres",
  "kettlebell", "elastiques", "tapis_de_course", "rameur",
  "velo_elliptique", "corde_a_sauter", "poids_du_corps",
  "acces_piscine", "acces_salle",
];

async function readAthlete(): Promise<AthleteProfile | null> {
  try {
    const raw = await fs.readFile(ATHLETE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeAthlete(data: AthleteProfile): Promise<void> {
  await fs.mkdir(path.dirname(ATHLETE_FILE), { recursive: true });
  const tmp = `${ATHLETE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, ATHLETE_FILE);
}

export async function GET() {
  const profile = await readAthlete();
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const goal = VALID_GOALS.includes(body.goal) ? body.goal : "forme_generale";
  const level = VALID_LEVELS.includes(body.level) ? body.level : "debutant";
  const sports = Array.isArray(body.sports)
    ? body.sports.filter((s: unknown) => typeof s === "string" && VALID_SPORTS.includes(s))
    : [];
  const equipment = Array.isArray(body.equipment)
    ? body.equipment.filter((e: unknown) => typeof e === "string" && VALID_EQUIPMENT.includes(e))
    : [];

  const profile: AthleteProfile = {
    goal,
    goalDate: typeof body.goalDate === "string" ? body.goalDate : "",
    level,
    currentWeight:
      typeof body.currentWeight === "number" && body.currentWeight > 0
        ? body.currentWeight
        : null,
    targetWeight:
      typeof body.targetWeight === "number" && body.targetWeight > 0
        ? body.targetWeight
        : null,
    daysPerWeek:
      typeof body.daysPerWeek === "number" &&
      body.daysPerWeek >= 1 &&
      body.daysPerWeek <= 7
        ? Math.round(body.daysPerWeek)
        : null,
    maxSessionMinutes:
      typeof body.maxSessionMinutes === "number" && body.maxSessionMinutes > 0
        ? Math.round(body.maxSessionMinutes)
        : null,
    sports,
    equipment,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : "",
    updatedAt: new Date().toISOString(),
  };

  await writeAthlete(profile);
  return NextResponse.json({ profile }, { status: 200 });
}
