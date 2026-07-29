// The deterministic RECONCILIATION status for the nutrition add-on — the second-vertical twin of
// body-baseline.ts / bodyBaseline(). It answers "how stale is the meal plan, and what's provably
// done" from records ALREADY on the store: nothing here is stored, nothing calls an LLM (ADR 0001 —
// this is the same server-side-arithmetic carve-out as the correlations stats). What to DO about the
// numbers — auto-close the proven set, batch the rest into one question — is the `/nutrition-chef`
// skill's job; this module only computes.
//
// Pure, I/O-free, clock-free: the caller (the route) passes `today` as a "YYYY-MM-DD" string — the
// one seam where the clock is read, exactly like bodyBaseline.

import type { FoodLogEntry, MealPlanEntry, NutritionTargetArtifact, PantryItem } from "./types";
import { wholeDaysBetween } from "./staleness";

// True when `text` (typically a FoodLogEntry.description) names `mealId` (e.g. "MEAL-12") with a
// DIGIT BOUNDARY immediately after it — so "MEAL-1" never matches inside "MEAL-10". Exported so the
// provable-match rule is independently unit-testable (this is the one thing a live-API test can't
// reliably exercise, since minted ids aren't controllable to exactly "MEAL-1"/"MEAL-10").
export function mealIdNamedIn(text: string, mealId: string): boolean {
  const escaped = mealId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?!\\d)`).test(text);
}

export interface NutritionStatus {
  stalePlannedMeals: { count: number; oldestDate: string | null; oldestAgeDays: number | null; ids: string[] };
  provablyCooked: { count: number; matches: { mealId: string; foodLogId: string }[] };
  daysSinceLastFoodLog: number | null;
  daysSinceLastPantryWrite: number | null;
  expiredPantryItems: { count: number; ids: string[] };
  hasNutritionTargets: boolean;
  daysSinceLastTargets: number | null;
}

// Compute the reconciliation status. ALWAYS resolvable: empty arrays → zero counts, null dates/ages,
// hasNutritionTargets:false — never throws.
export function computeNutritionStatus(input: {
  mealPlanEntries: MealPlanEntry[];
  foodLogs: FoodLogEntry[];
  pantryItems: PantryItem[];
  nutritionTargets: NutritionTargetArtifact[];
  today: string;
}): NutritionStatus {
  const { mealPlanEntries, foodLogs, pantryItems, nutritionTargets, today } = input;

  // ── stale planned meals: still "planned", dated strictly before today (ISO days sort lexically,
  // so a plain string compare is exact — the same idiom the pantry route's expiringBefore uses). ──
  const stale = mealPlanEntries
    .filter((m) => m.status === "planned" && m.date < today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const oldestDate = stale.length ? stale[0].date : null;
  const oldestAgeDays = oldestDate != null ? wholeDaysBetween(oldestDate, today) : null;

  // ── provable subset: a food log on the SAME date + slot naming the meal's id. One row per meal
  // (first match by array order) even when several logs would match — never double-counted. ──
  const matches: { mealId: string; foodLogId: string }[] = [];
  for (const meal of stale) {
    const proof = foodLogs.find(
      (f) => f.date === meal.date && f.slot === meal.slot && mealIdNamedIn(f.description, meal.id),
    );
    if (proof) matches.push({ mealId: meal.id, foodLogId: proof.id });
  }

  // ── recency signals: food log / pantry-write / targets ──────────────────────────────────────────
  const lastFoodLogDate = foodLogs.reduce<string | null>(
    (max, f) => (max == null || f.date > max ? f.date : max),
    null,
  );
  const daysSinceLastFoodLog = lastFoodLogDate != null ? wholeDaysBetween(lastFoodLogDate, today) : null;

  // PantryItem.updatedAt is a full ISO datetime; take the calendar day before diffing.
  const lastPantryWriteDay = pantryItems.reduce<string | null>((max, p) => {
    const day = p.updatedAt.slice(0, 10);
    return max == null || day > max ? day : max;
  }, null);
  const daysSinceLastPantryWrite =
    lastPantryWriteDay != null ? wholeDaysBetween(lastPantryWriteDay, today) : null;

  const expiredIds = pantryItems.filter((p) => p.expiresAt != null && p.expiresAt < today).map((p) => p.id);

  const lastTargetsPeriod = nutritionTargets.reduce<string | null>(
    (max, t) => (max == null || t.periodKey > max ? t.periodKey : max),
    null,
  );

  return {
    stalePlannedMeals: { count: stale.length, oldestDate, oldestAgeDays, ids: stale.map((m) => m.id) },
    provablyCooked: { count: matches.length, matches },
    daysSinceLastFoodLog,
    daysSinceLastPantryWrite,
    expiredPantryItems: { count: expiredIds.length, ids: expiredIds },
    hasNutritionTargets: nutritionTargets.length > 0,
    daysSinceLastTargets: lastTargetsPeriod != null ? wholeDaysBetween(lastTargetsPeriod, today) : null,
  };
}
