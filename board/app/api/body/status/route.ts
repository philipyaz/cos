import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { bodyBaseline } from "@/lib/body-baseline";
import { toISODay } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// GET /api/body/status — the deterministic physiology BASELINE (BMR / TDEE / measured-TDEE /
// weight trend / BMI / age / FFM / waist) plus the raw profile + objective. This is the single
// place the clock turns DOB → age (today is read HERE and passed into the pure engine). It serves
// FACTS only — NO calorie/macro recommendation (that is the agent-authored nutrition-targets
// artifact). UNGATED: the baseline resolves even when "body" is disabled-but-synthesized.
//
// The measured-TDEE leg reads db.foodLogs cross-add-on with `?? []` (a READ, never gated on
// isAddonEnabled("nutrition")) — falls back to estimated when nutrition is off / thin.
export async function GET() {
  const db = await readDB();
  const today = toISODay(new Date());
  const baseline = bodyBaseline({
    profile: db.bodyProfile ?? null,
    objective: db.bodyObjective ?? null,
    weights: db.weights ?? [],
    foodLogs: db.foodLogs ?? [],
    today,
  });
  return NextResponse.json({
    baseline,
    profile: db.bodyProfile ?? null,
    objective: db.bodyObjective ?? null,
    today,
    version: db.version,
  });
}
