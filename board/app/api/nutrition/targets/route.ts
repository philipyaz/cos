import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { computeNutritionTargets } from "@/lib/nutrition-targets";
import { toISODay } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// GET /api/nutrition/targets — the render-ready weight-loss targets envelope, computed over
// the goal singleton + the weigh-in series + the food log via the pure engine. READ-ONLY and
// UNGATED: the projection is informational and ALWAYS resolvable (a disabled add-on — or a
// missing goal/weight — still returns a "needs configuration" envelope with the
// not-medical-advice note), so a disabled add-on's view stays visible.
export async function GET() {
  const db = await readDB();
  const targets = computeNutritionTargets({
    goal: db.nutritionGoal ?? null,
    weights: db.weights ?? [],
    foodLogs: db.foodLogs ?? [],
    // The server-LOCAL "YYYY-MM-DD" — the engine is clockless (takes `today` as a string),
    // so this is the only clock read; local parts (not UTC) match the user's wall-calendar.
    today: toISODay(new Date()),
  });
  return NextResponse.json({ targets, version: db.version });
}
