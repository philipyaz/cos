import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { computeNutritionStatus } from "@/lib/nutrition-status";
import { toISODay } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// GET /api/nutrition/status — the deterministic RECONCILIATION status (stale/provable meal-plan
// entries, food-log/pantry/targets recency) — computed, never stored. Mirrors /api/body/status
// exactly: force-dynamic, GET only, no params, UNGATED (a read — works with the add-on disabled
// and on a spoke), the clock is read HERE ONCE and passed into the pure engine, no mutate().
export async function GET() {
  const db = await readDB();
  const today = toISODay(new Date());
  const status = computeNutritionStatus({
    mealPlanEntries: db.mealPlanEntries ?? [],
    foodLogs: db.foodLogs ?? [],
    pantryItems: db.pantryItems ?? [],
    nutritionTargets: db.nutritionTargets ?? [],
    today,
  });
  return NextResponse.json({ ...status, today, version: db.version });
}
