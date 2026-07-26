// Unit tests for the nutrition RECONCILIATION status engine (board/lib/nutrition-status.ts) — the
// second-vertical twin of body-baseline.ts. Pure, deterministic, clock-free (today injected), so it
// runs headless under `node --test` with NO disk and NO clock. Covers the one thing the live-API test
// (tests/api-nutrition-status.mjs) can't reliably exercise: the digit-boundary proof matcher against
// CONTROLLED ids like "MEAL-1"/"MEAL-10" (minted ids in a running board aren't pinned to exact values).
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/nutrition-status.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNutritionStatus, mealIdNamedIn } from "../../board/lib/nutrition-status.ts";
import type { FoodLogEntry, MealPlanEntry, NutritionTargetArtifact, PantryItem } from "../../board/lib/types.ts";

test("mealIdNamedIn: digit-boundary — MEAL-1 never matches inside MEAL-10", () => {
  assert.equal(mealIdNamedIn("MEAL-1 — sheet-pan fish", "MEAL-1"), true, "exact id, end of match region");
  assert.equal(mealIdNamedIn("MEAL-10 — sheet-pan fish", "MEAL-1"), false, "MEAL-1 must not match inside MEAL-10");
  assert.equal(mealIdNamedIn("MEAL-10 — sheet-pan fish", "MEAL-10"), true, "MEAL-10 matches itself");
  assert.equal(mealIdNamedIn("no id here", "MEAL-1"), false);
  assert.equal(mealIdNamedIn("cf. MEAL-1.", "MEAL-1"), true, "a trailing non-digit (period) is a valid boundary");
});

const meal = (over: Partial<MealPlanEntry>): MealPlanEntry => ({
  id: "MEAL-1",
  date: "2020-01-01",
  slot: "dinner",
  title: "x",
  status: "planned",
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

const foodLog = (over: Partial<FoodLogEntry>): FoodLogEntry => ({
  id: "FOOD-1",
  date: "2020-01-01",
  slot: "dinner",
  description: "x",
  calories: 500,
  estimated: true,
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

const pantryItem = (over: Partial<PantryItem>): PantryItem => ({
  id: "PANTRY-1",
  name: "x",
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

const target = (over: Partial<NutritionTargetArtifact>): NutritionTargetArtifact => ({
  id: "NTARGET-1",
  kind: "daily_targets",
  periodKey: "2020-01-01",
  source: "agent",
  payload: { daily_calories: 2000 },
  generatedAt: "x",
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

test("computeNutritionStatus: empty store → zero counts, null ages, no targets, never throws", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [], foodLogs: [], pantryItems: [], nutritionTargets: [], today: "2026-07-26",
  });
  assert.deepEqual(s.stalePlannedMeals, { count: 0, oldestDate: null, oldestAgeDays: null, ids: [] });
  assert.deepEqual(s.provablyCooked, { count: 0, matches: [] });
  assert.equal(s.daysSinceLastFoodLog, null);
  assert.equal(s.daysSinceLastPantryWrite, null);
  assert.deepEqual(s.expiredPantryItems, { count: 0, ids: [] });
  assert.equal(s.hasNutritionTargets, false);
  assert.equal(s.daysSinceLastTargets, null);
});

test("computeNutritionStatus: stale vs future — only past-dated planned entries count", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [
      meal({ id: "MEAL-1", date: "2020-01-10" }), // stale (oldest)
      meal({ id: "MEAL-2", date: "2020-01-20" }), // stale
      meal({ id: "MEAL-3", date: "2099-01-01" }), // future — excluded
      meal({ id: "MEAL-4", date: "2020-01-05", status: "cooked" }), // already resolved — excluded
    ],
    foodLogs: [], pantryItems: [], nutritionTargets: [], today: "2026-07-26",
  });
  assert.equal(s.stalePlannedMeals.count, 2);
  assert.deepEqual(new Set(s.stalePlannedMeals.ids), new Set(["MEAL-1", "MEAL-2"]));
  assert.equal(s.stalePlannedMeals.oldestDate, "2020-01-10", "the earlier of the two stale dates");
  assert.ok(s.stalePlannedMeals.oldestAgeDays! > 1000);
});

test("computeNutritionStatus: provable match requires same date+slot+id; wrong-id/wrong-date don't prove", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [
      meal({ id: "MEAL-1", date: "2020-01-02", slot: "dinner" }), // proven
      meal({ id: "MEAL-2", date: "2020-01-03", slot: "lunch" }), // NOT proven (decoy names MEAL-1)
    ],
    foodLogs: [
      foodLog({ id: "FOOD-1", date: "2020-01-02", slot: "dinner", description: "MEAL-1 — eaten" }),
      // decoy: right date+slot for MEAL-2, but names MEAL-1 — must not prove MEAL-2.
      foodLog({ id: "FOOD-2", date: "2020-01-03", slot: "lunch", description: "MEAL-1 — decoy" }),
    ],
    pantryItems: [], nutritionTargets: [], today: "2026-07-26",
  });
  assert.equal(s.stalePlannedMeals.count, 2, "both meals are still in the superset");
  assert.equal(s.provablyCooked.count, 1, "only MEAL-1 is proven");
  assert.deepEqual(s.provablyCooked.matches, [{ mealId: "MEAL-1", foodLogId: "FOOD-1" }]);
});

test("computeNutritionStatus: a meal proven by two logs is counted once (first match wins)", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [meal({ id: "MEAL-1", date: "2020-01-02", slot: "dinner" })],
    foodLogs: [
      foodLog({ id: "FOOD-1", date: "2020-01-02", slot: "dinner", description: "MEAL-1 — first" }),
      foodLog({ id: "FOOD-2", date: "2020-01-02", slot: "dinner", description: "MEAL-1 — second" }),
    ],
    pantryItems: [], nutritionTargets: [], today: "2026-07-26",
  });
  assert.equal(s.provablyCooked.count, 1, "never double-counted");
  assert.equal(s.provablyCooked.matches[0].foodLogId, "FOOD-1", "first match by array order");
});

test("computeNutritionStatus: daysSinceLastFoodLog is the gap to the newest logged day", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [],
    foodLogs: [foodLog({ date: "2026-06-23" }), foodLog({ id: "FOOD-2", date: "2026-06-01" })],
    pantryItems: [], nutritionTargets: [], today: "2026-07-26",
  });
  assert.equal(s.daysSinceLastFoodLog, 33, "gap to the NEWEST log (2026-06-23), not the oldest");
});

test("computeNutritionStatus: pantry — expired items + calendar-day write recency", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [], foodLogs: [],
    pantryItems: [
      pantryItem({ id: "PANTRY-1", expiresAt: "2020-01-01", updatedAt: "2026-07-26T09:00:00.000Z" }),
      pantryItem({ id: "PANTRY-2", expiresAt: "2099-01-01", updatedAt: "2026-07-01T00:00:00.000Z" }),
    ],
    nutritionTargets: [], today: "2026-07-26",
  });
  assert.deepEqual(s.expiredPantryItems, { count: 1, ids: ["PANTRY-1"] });
  assert.equal(s.daysSinceLastPantryWrite, 0, "the newest write (today) → 0, from the FULL updatedAt datetime");
});

test("computeNutritionStatus: hasNutritionTargets + daysSinceLastTargets from max(periodKey)", () => {
  const s = computeNutritionStatus({
    mealPlanEntries: [], foodLogs: [], pantryItems: [],
    nutritionTargets: [target({ periodKey: "2020-01-05" }), target({ id: "NTARGET-2", periodKey: "2020-01-10" })],
    today: "2026-07-26",
  });
  assert.equal(s.hasNutritionTargets, true);
  assert.ok(s.daysSinceLastTargets! > 1000, "gap from the NEWEST periodKey (2020-01-10)");
});
