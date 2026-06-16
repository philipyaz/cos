import { NextResponse, type NextRequest } from "next/server";
import { getProfile, setProfile } from "@/lib/health";
import { storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import {
  VALID_ATHLETE_GOAL,
  VALID_ATHLETE_LEVEL,
  VALID_ATHLETE_SPORT,
  VALID_ATHLETE_EQUIPMENT,
  type AthleteGoal,
  type AthleteLevel,
  type AthleteProfile,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/athlete — the athlete training-profile singleton, read from the store (cases.json),
// or { profile: null } when none is set. Ungated.
export async function GET() {
  const profile = await getProfile();
  return NextResponse.json({ profile });
}

const posIntOrNull = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;

const posNumOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

// POST /api/athlete — create-or-replace the profile singleton. Validates against the ENGLISH
// enums single-sourced in @/lib/types, then writes via setProfile (GATED inside mutate). The
// store stamps the sticky createdAt + updatedAt.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  if (!VALID_ATHLETE_GOAL.includes(body.goal)) {
    return NextResponse.json(
      { error: `'goal' must be one of: ${VALID_ATHLETE_GOAL.join(", ")}.` },
      { status: 400 },
    );
  }
  if (!VALID_ATHLETE_LEVEL.includes(body.level)) {
    return NextResponse.json(
      { error: `'level' must be one of: ${VALID_ATHLETE_LEVEL.join(", ")}.` },
      { status: 400 },
    );
  }
  if ("goalDate" in body && body.goalDate !== "" && body.goalDate != null && !isISODate(body.goalDate)) {
    return NextResponse.json(
      { error: "'goalDate' must be YYYY-MM-DD or an empty string." },
      { status: 400 },
    );
  }

  const sports = Array.isArray(body.sports)
    ? body.sports.filter((s: unknown): s is string => typeof s === "string" && VALID_ATHLETE_SPORT.includes(s))
    : [];
  const equipment = Array.isArray(body.equipment)
    ? body.equipment.filter((e: unknown): e is string => typeof e === "string" && VALID_ATHLETE_EQUIPMENT.includes(e))
    : [];

  const input: Omit<AthleteProfile, "createdAt" | "updatedAt"> = {
    goal: body.goal as AthleteGoal,
    goalDate: isISODate(body.goalDate) ? body.goalDate : "",
    level: body.level as AthleteLevel,
    currentWeightKg: posNumOrNull(body.currentWeightKg),
    targetWeightKg: posNumOrNull(body.targetWeightKg),
    daysPerWeek: posIntOrNull(body.daysPerWeek, 1, 7),
    maxSessionMinutes: posNumOrNull(body.maxSessionMinutes) != null ? Math.round(body.maxSessionMinutes) : null,
    sports,
    equipment,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : "",
  };

  try {
    const { profile, version } = await setProfile(input);
    return NextResponse.json({ profile, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
