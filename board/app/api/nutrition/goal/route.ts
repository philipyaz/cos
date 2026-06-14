import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  getNutritionGoal,
  setNutritionGoal,
  applyGoalPatch,
  NotFoundError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_ACTIVITY_LEVEL,
  VALID_BIOLOGICAL_SEX,
  type ActivityLevel,
  type BiologicalSex,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/goal — the goal/profile SINGLETON (db.nutritionGoal), or null when
// none is set yet. READS ARE UNGATED: a disabled add-on's data stays viewable.
export async function GET() {
  const db = await readDB();
  return NextResponse.json({ goal: getNutritionGoal(db) ?? null, version: db.version });
}

// PUT /api/nutrition/goal — CREATE-OR-REPLACE the singleton. All physiological fields are
// required (sex/age/heightCm/activity/targetWeightKg); rateKgPerWeek (default 0.5) and
// weightUnit (default "kg") are optional. Shape-validated outside the lock (400 on bad
// shape). GATED: setNutritionGoal runs inside the lock asserting the add-on is enabled
// (a disabled add-on → NotFoundError → 404 via storeErrorToResponse).
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!VALID_BIOLOGICAL_SEX.includes(body.sex)) {
    return NextResponse.json(
      { error: `Field 'sex' is required, one of: ${VALID_BIOLOGICAL_SEX.join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.age !== "number" || !Number.isFinite(body.age) || body.age <= 0) {
    return NextResponse.json({ error: "Field 'age' is required as a number greater than 0." }, { status: 400 });
  }
  if (typeof body.heightCm !== "number" || !Number.isFinite(body.heightCm) || body.heightCm <= 0) {
    return NextResponse.json({ error: "Field 'heightCm' is required as a number greater than 0." }, { status: 400 });
  }
  if (!VALID_ACTIVITY_LEVEL.includes(body.activity)) {
    return NextResponse.json(
      { error: `Field 'activity' is required, one of: ${VALID_ACTIVITY_LEVEL.join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.targetWeightKg !== "number" || !Number.isFinite(body.targetWeightKg) || body.targetWeightKg <= 0) {
    return NextResponse.json({ error: "Field 'targetWeightKg' is required as a number greater than 0." }, { status: 400 });
  }
  if ("rateKgPerWeek" in body && body.rateKgPerWeek != null && (typeof body.rateKgPerWeek !== "number" || !Number.isFinite(body.rateKgPerWeek) || body.rateKgPerWeek <= 0)) {
    return NextResponse.json({ error: "'rateKgPerWeek' must be a number greater than 0." }, { status: 400 });
  }
  if ("weightUnit" in body && body.weightUnit != null && body.weightUnit !== "kg" && body.weightUnit !== "lb") {
    return NextResponse.json({ error: "'weightUnit' must be 'kg' or 'lb'." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). The goal links to no case, so
  // there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);

  try {
    const { goal, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const goal = setNutritionGoal(db, {
        sex: body.sex as BiologicalSex,
        age: body.age as number,
        heightCm: body.heightCm as number,
        activity: body.activity as ActivityLevel,
        targetWeightKg: body.targetWeightKg as number,
        rateKgPerWeek:
          typeof body.rateKgPerWeek === "number" && Number.isFinite(body.rateKgPerWeek)
            ? (body.rateKgPerWeek as number)
            : undefined,
        weightUnit: body.weightUnit === "lb" ? "lb" : body.weightUnit === "kg" ? "kg" : undefined,
      });
      return { goal, version: db.version };
    });
    return NextResponse.json({ goal, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// PATCH /api/nutrition/goal — partial update of the EXISTING goal singleton via
// applyGoalPatch (present-keys-only). 404s when no goal is set yet (there is nothing to
// patch — set one with PUT first). Shape-validated outside the lock (400 on bad shape).
// GATED: asserts the add-on is enabled inside the lock (disabled → 404).
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Body-shape validation (no DB needed) → fast 400s, outside the lock.
  if ("sex" in body && !VALID_BIOLOGICAL_SEX.includes(body.sex)) {
    return NextResponse.json(
      { error: `'sex' must be one of: ${VALID_BIOLOGICAL_SEX.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("age" in body && (typeof body.age !== "number" || !Number.isFinite(body.age) || body.age <= 0)) {
    return NextResponse.json({ error: "'age' must be a number greater than 0." }, { status: 400 });
  }
  if ("heightCm" in body && (typeof body.heightCm !== "number" || !Number.isFinite(body.heightCm) || body.heightCm <= 0)) {
    return NextResponse.json({ error: "'heightCm' must be a number greater than 0." }, { status: 400 });
  }
  if ("activity" in body && !VALID_ACTIVITY_LEVEL.includes(body.activity)) {
    return NextResponse.json(
      { error: `'activity' must be one of: ${VALID_ACTIVITY_LEVEL.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("targetWeightKg" in body && (typeof body.targetWeightKg !== "number" || !Number.isFinite(body.targetWeightKg) || body.targetWeightKg <= 0)) {
    return NextResponse.json({ error: "'targetWeightKg' must be a number greater than 0." }, { status: 400 });
  }
  if ("rateKgPerWeek" in body && (typeof body.rateKgPerWeek !== "number" || !Number.isFinite(body.rateKgPerWeek) || body.rateKgPerWeek <= 0)) {
    return NextResponse.json({ error: "'rateKgPerWeek' must be a number greater than 0." }, { status: 400 });
  }
  if ("weightUnit" in body && body.weightUnit !== "kg" && body.weightUnit !== "lb") {
    return NextResponse.json({ error: "'weightUnit' must be 'kg' or 'lb'." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). The goal links to no case, so
  // there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);

  // find + gate + patch + write as one critical section. No goal yet → 404 (PUT one first).
  try {
    const { goal, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = getNutritionGoal(db);
      if (!rec) throw new NotFoundError("No nutrition goal set yet");
      applyGoalPatch(rec, body);
      return { goal: rec, version: db.version };
    });
    return NextResponse.json({ goal, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
