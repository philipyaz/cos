// The deterministic RECONCILIATION status for the nutrition add-on — the second-vertical twin of
// body-baseline.ts / bodyBaseline(). It answers "how stale is the meal plan, and what's provably
// done" from records ALREADY on the store: nothing here is stored, nothing calls an LLM (ADR 0001 —
// this is the same server-side-arithmetic carve-out as the correlations stats). What to DO about the
// numbers — auto-close the proven set, batch the rest into one question, scope reconciliation by
// lifecycle — is the `/nutrition-chef` skill's job; this module only computes. That includes
// `pantryLifecycle`: a fresh/staple/spice classification of every pantry row (from `category` +
// `location`, both already stored) plus a computed freshness horizon for the fresh class — never
// persisted, recomputed on every read (ADR 0017), the same discipline as everything else here.
//
// Pure, I/O-free, clock-free: the caller (the route) passes `today` as a "YYYY-MM-DD" string — the
// one seam where the clock is read, exactly like bodyBaseline.

import type { FoodLogEntry, MealPlanEntry, NutritionTargetArtifact, PantryCategory, PantryItem, PantryLocation } from "./types";
import { wholeDaysBetween } from "./nutrition-format";

// True when `text` (typically a FoodLogEntry.description) names `mealId` (e.g. "MEAL-12") with a
// DIGIT BOUNDARY immediately after it — so "MEAL-1" never matches inside "MEAL-10". Exported so the
// provable-match rule is independently unit-testable (this is the one thing a live-API test can't
// reliably exercise, since minted ids aren't controllable to exactly "MEAL-1"/"MEAL-10").
export function mealIdNamedIn(text: string, mealId: string): boolean {
  const escaped = mealId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?!\\d)`).test(text);
}

// ── Pantry lifecycle classification — fresh / staple / spice, from category + location alone ────
// Nothing new is captured: every pantry row already carries `category`/`location`, so this is a
// pure re-read of state that exists, never a new stored field (ADR 0017). "fresh" is the routine
// reconciliation scope; "staple" and "spice" are counted OUT of it (see the skill for the rules).
export type PantryLifecycleClass = "fresh" | "staple" | "spice";

export function pantryLifecycleClass(p: Pick<PantryItem, "category" | "location">): PantryLifecycleClass {
  if (p.category === "spice") return "spice";
  if (p.category === "frozen" || p.location === "freezer") return "staple";
  if (p.location === "fridge") return "fresh";
  if (p.category === "produce" || p.category === "dairy") return "fresh";
  return "staple"; // neither field says "fresh" — a wrong "fresh" costs attention; default conservative.
}

// Conservative typical shelf lives (days) for the FRESH class, keyed category → location. Bias
// short: a horizon that fires early costs one glance; late costs trust. Tuning is one edit here —
// these are never persisted, only used to compute `likelyPastHorizon` fresh on every read.
export const FRESH_SHELF_LIFE_DAYS: Partial<Record<PantryCategory, Partial<Record<PantryLocation, number>>>> = {
  produce: { fridge: 7, pantry: 14 },
  dairy: { fridge: 10 },
  protein: { fridge: 3 },
  grain: { fridge: 7 },
  pantry: { fridge: 60 }, // opened jars/sauces kept chilled — long, so they don't nag
  other: { fridge: 7 },
};
export const DEFAULT_FRESH_HORIZON_DAYS = 14;

// The freshness horizon (days) for a fresh-class row — null for staple/spice (they carry no
// horizon at all, by design: they are out of the routine sweep, so there is nothing to infer).
export function freshnessHorizonDays(p: Pick<PantryItem, "category" | "location">): number | null {
  if (pantryLifecycleClass(p) !== "fresh") return null;
  const byCategory = p.category ? FRESH_SHELF_LIFE_DAYS[p.category] : undefined;
  const byLocation = p.location ? byCategory?.[p.location] : undefined;
  return byLocation ?? DEFAULT_FRESH_HORIZON_DAYS;
}

export interface NutritionStatus {
  stalePlannedMeals: { count: number; oldestDate: string | null; oldestAgeDays: number | null; ids: string[] };
  provablyCooked: { count: number; matches: { mealId: string; foodLogId: string }[] };
  daysSinceLastFoodLog: number | null;
  daysSinceLastPantryWrite: number | null;
  expiredPantryItems: { count: number; ids: string[] };
  pantryLifecycle: {
    fresh: { count: number; ids: string[] }; // the routine reconciliation scope
    likelyPastHorizon: { count: number; items: { id: string; ageDays: number; horizonDays: number }[] };
    excluded: { spices: number; staples: number }; // counted OUT of the routine sweep
  };
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

  // ── pantry lifecycle: fresh/staple/spice scoping + the computed freshness horizon ─────────────
  // A read `expiresAt` always wins over the computed horizon — an item that carries one is already
  // owned by the fact path above (`expiredIds`), so it is excluded from the INFERENCE here, even
  // when it's old. Staple/spice rows carry no horizon at all; only "fresh" rows are ever inferred.
  const freshIds: string[] = [];
  const pastHorizon: { id: string; ageDays: number; horizonDays: number }[] = [];
  let spiceCount = 0;
  let stapleCount = 0;
  for (const p of pantryItems) {
    const cls = pantryLifecycleClass(p);
    if (cls === "spice") {
      spiceCount++;
      continue;
    }
    if (cls === "staple") {
      stapleCount++;
      continue;
    }
    freshIds.push(p.id);
    if (p.expiresAt != null) continue;
    const horizonDays = freshnessHorizonDays(p);
    if (horizonDays == null) continue;
    const ageDays = wholeDaysBetween(p.updatedAt.slice(0, 10), today);
    if (ageDays > horizonDays) pastHorizon.push({ id: p.id, ageDays, horizonDays });
  }

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
    pantryLifecycle: {
      fresh: { count: freshIds.length, ids: freshIds },
      likelyPastHorizon: { count: pastHorizon.length, items: pastHorizon },
      excluded: { spices: spiceCount, staples: stapleCount },
    },
    hasNutritionTargets: nutritionTargets.length > 0,
    daysSinceLastTargets: lastTargetsPeriod != null ? wholeDaysBetween(lastTargetsPeriod, today) : null,
  };
}
