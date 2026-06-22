import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, getBodyProfile, setBodyProfile, applyBodyProfilePatch, NotFoundError } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import { VALID_BIOLOGICAL_SEX, VALID_TRAINING_STATUS, type BiologicalSex, type TrainingStatus, type BodyProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/body/profile — the body-identity singleton (sex/DOB/height/trainingStatus/
// resistanceTrains/weightUnit), or { profile: null }. UNGATED (frozen-but-readable).
export async function GET() {
  const db = await readDB();
  return NextResponse.json({ profile: db.bodyProfile ?? null, version: db.version });
}

// PUT /api/body/profile — create-or-replace the identity singleton. Validates the enums + DOB
// shape, then writes via setBodyProfile (GATED inside mutate). createdAt is sticky.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!VALID_BIOLOGICAL_SEX.includes(body.sex)) {
    return NextResponse.json({ error: `'sex' must be one of: ${VALID_BIOLOGICAL_SEX.join(", ")}.` }, { status: 400 });
  }
  if (!isISODate(body.dateOfBirth)) {
    return NextResponse.json({ error: "'dateOfBirth' is required as YYYY-MM-DD." }, { status: 400 });
  }
  if (typeof body.heightCm !== "number" || !Number.isFinite(body.heightCm) || body.heightCm <= 0) {
    return NextResponse.json({ error: "'heightCm' must be a number greater than 0." }, { status: 400 });
  }
  if (!VALID_TRAINING_STATUS.includes(body.trainingStatus)) {
    return NextResponse.json({ error: `'trainingStatus' must be one of: ${VALID_TRAINING_STATUS.join(", ")}.` }, { status: 400 });
  }
  if ("weightUnit" in body && body.weightUnit != null && body.weightUnit !== "kg" && body.weightUnit !== "lb") {
    return NextResponse.json({ error: "'weightUnit' must be 'kg' or 'lb'." }, { status: 400 });
  }

  resolveActor(req, body);
  const input: Omit<BodyProfile, "createdAt" | "updatedAt"> = {
    sex: body.sex as BiologicalSex,
    dateOfBirth: body.dateOfBirth as string,
    heightCm: body.heightCm as number,
    trainingStatus: body.trainingStatus as TrainingStatus,
    resistanceTrains: Boolean(body.resistanceTrains),
    weightUnit: body.weightUnit === "lb" ? "lb" : "kg",
  };

  try {
    const { profile, version } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      return { profile: setBodyProfile(db, input), version: db.version };
    });
    return NextResponse.json({ profile, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// PATCH /api/body/profile — partial update of the EXISTING profile (404 when none set yet).
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if ("dateOfBirth" in body && !isISODate(body.dateOfBirth)) {
    return NextResponse.json({ error: "'dateOfBirth' must be YYYY-MM-DD." }, { status: 400 });
  }
  resolveActor(req, body);

  try {
    const { profile, version } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      const rec = getBodyProfile(db);
      if (!rec) throw new NotFoundError("No body profile set — use PUT to create one.");
      return { profile: applyBodyProfilePatch(rec, body), version: db.version };
    });
    return NextResponse.json({ profile, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
