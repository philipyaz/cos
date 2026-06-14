import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { computeNutritionTargets } from "@/lib/nutrition-targets";

export const dynamic = "force-dynamic";

// The server-LOCAL calendar day as "YYYY-MM-DD". The engine is clockless (it takes `today`
// as a string), so the ONLY clock read in the whole feature lives here. We use the local
// date parts (not toISOString, which is UTC) so "today" matches the user's wall-calendar.
function localToday(): string {
  const now = new Date();
  const yy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

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
    today: localToday(),
  });
  return NextResponse.json({ targets, version: db.version });
}
