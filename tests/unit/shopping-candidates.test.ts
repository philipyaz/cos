// Unit tests for the shopping-candidates engine (board/lib/shopping-candidates.ts) — the
// third-vertical twin of nutrition-status.ts / body-baseline.ts. Pure, deterministic,
// clock-free (today/from/to injected), so it runs headless under `node --test` with NO disk
// and NO clock. Every case below is pinned to a rule stated in plans/37-shopping-list-state.md
// §4, including the ONE documented false-positive the containment matcher accepts (rice ⊂
// "Rice vinegar") — asserted so the trade is recorded, not assumed.
//
// Inputs are deep-frozen before every call to pin purity: the engine must never mutate a
// caller's mealPlanEntries / pantryItems / shoppingItems array or row — only read them and
// build new output objects. A frozen-object mutation attempt throws (strict-mode arrays/
// objects), so an accidental `.push`/field-write on an input fails the test loudly.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/shopping-candidates.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeShoppingCandidates } from "../../board/lib/shopping-candidates.ts";
import type { MealPlanEntry, PantryItem, ShoppingItem } from "../../board/lib/types.ts";

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj as object)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

const meal = (over: Partial<MealPlanEntry>): MealPlanEntry => ({
  id: "MEAL-1",
  date: "2026-08-11",
  slot: "dinner",
  title: "Test meal",
  status: "planned",
  ingredients: [],
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

const pantryItem = (over: Partial<PantryItem>): PantryItem => ({
  id: "PANTRY-1",
  name: "x",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

const shoppingRow = (over: Partial<ShoppingItem>): ShoppingItem => ({
  id: "SHOP-1",
  name: "x",
  status: "needed",
  source: "manual",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

// A common window shared by most cases below: 2026-08-10 → 2026-08-16, today = the window start.
const WINDOW = { from: "2026-08-10", to: "2026-08-16", today: "2026-08-10" };

function compute(over: {
  mealPlanEntries?: MealPlanEntry[];
  pantryItems?: PantryItem[];
  shoppingItems?: ShoppingItem[];
  from?: string;
  to?: string;
  today?: string;
}) {
  return computeShoppingCandidates(
    deepFreeze({
      mealPlanEntries: over.mealPlanEntries ?? [],
      foodLogs: [],
      pantryItems: over.pantryItems ?? [],
      nutritionTargets: [],
      shoppingItems: over.shoppingItems ?? [],
      from: over.from ?? WINDOW.from,
      to: over.to ?? WINDOW.to,
      today: over.today ?? WINDOW.today,
    }),
  );
}

test("computeShoppingCandidates: empty store → no candidates, zero suppressed, never throws", () => {
  const r = compute({});
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 0, boughtInWindow: 0 });
  assert.deepEqual(r.window, { from: "2026-08-10", to: "2026-08-16" }, "the window is echoed back");
});

test("computeShoppingCandidates: a plan ingredient absent from the pantry is a candidate", () => {
  const r = compute({
    mealPlanEntries: [meal({ id: "MEAL-1", date: "2026-08-11", title: "Pancakes", ingredients: ["flour"] })],
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].name, "flour");
  assert.equal(r.candidates[0].source, "plan");
  assert.equal(r.candidates[0].sourceRef, "MEAL-1");
  assert.equal(r.candidates[0].inferred, false);
  assert.match(r.candidates[0].reason, /Pancakes/, "the reason names the meal");
  assert.match(r.candidates[0].reason, /2026-08-11/, "the reason names the date");
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 0, boughtInWindow: 0 });
});

test("computeShoppingCandidates: the same ingredient present in the pantry is suppressed (inPantry)", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Flour" })],
  });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 1, boughtInWindow: 0 });
});

test("computeShoppingCandidates: already on the list as 'needed' is suppressed (onList), any age", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    shoppingItems: [
      shoppingRow({ id: "SHOP-1", name: "flour", status: "needed", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }),
    ],
  });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.suppressed, { onList: 1, inPantry: 0, boughtInWindow: 0 });
});

test("computeShoppingCandidates: bought on/after the window start is suppressed (boughtInWindow)", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    shoppingItems: [shoppingRow({ id: "SHOP-1", name: "flour", status: "bought", boughtAt: "2026-08-10T09:00:00.000Z" })],
  });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 0, boughtInWindow: 1 });
});

test("computeShoppingCandidates: bought BEFORE the window start is NOT suppressed — a re-offer is correct", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    shoppingItems: [shoppingRow({ id: "SHOP-1", name: "flour", status: "bought", boughtAt: "2026-08-09T23:59:59.000Z" })],
  });
  assert.equal(r.candidates.length, 1, "bought before the window doesn't suppress — under-suppression is the right bias");
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 0, boughtInWindow: 0 });
});

test("computeShoppingCandidates: a fresh pantry row past its computed horizon is an INFERRED candidate, labelled", () => {
  const r = compute({
    // produce × fridge horizon is 7 days (nutrition-status.ts's FRESH_SHELF_LIFE_DAYS); 40 days old, no expiresAt.
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Spinach", category: "produce", location: "fridge", updatedAt: "2026-07-01T09:00:00.000Z" })],
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].name, "Spinach");
  assert.equal(r.candidates[0].source, "pantry");
  assert.equal(r.candidates[0].sourceRef, "PANTRY-1");
  assert.equal(r.candidates[0].inferred, true, "a freshness-horizon row is an INFERENCE, not a fact");
  assert.match(r.candidates[0].reason, /\(inferred — no printed date\)/, "ADR 0025 condition 4's label, verbatim");
});

test("computeShoppingCandidates: an expired pantry row is a FACT candidate (inferred: false)", () => {
  const r = compute({
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Yoghurt", expiresAt: "2026-08-01", updatedAt: "2026-08-01T09:00:00.000Z" })],
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].inferred, false, "a printed expiresAt is a fact, never an inference");
  assert.equal(r.candidates[0].reason, "expired 2026-08-01");
});

test("computeShoppingCandidates: a 'dismissed' list row suppresses nothing", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    shoppingItems: [shoppingRow({ id: "SHOP-1", name: "flour", status: "dismissed" })],
  });
  assert.equal(r.candidates.length, 1, "dismissed rows are inert — they never suppress a future candidate");
  assert.deepEqual(r.suppressed, { onList: 0, inPantry: 0, boughtInWindow: 0 });
});

test("computeShoppingCandidates: normalizePantryName composition — quantity-prefixed match, and accent-folding", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["2 eggs", "melange creole"] })],
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Eggs" }), pantryItem({ id: "PANTRY-2", name: "Mélange créole" })],
  });
  assert.deepEqual(r.candidates, [], "'2 eggs' matches pantry 'Eggs'; unaccented ingredient matches accented pantry name");
  assert.equal(r.suppressed.inPantry, 2);
});

test("computeShoppingCandidates: token-subset matching — a compound pantry product never suppresses the plain staple it contains", () => {
  // The bidirectional-substring matcher suppressed every one of these (cos#98 review F2):
  // planned staples reported "in pantry" because a compound product shared their letters.
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["rice", "eggs", "milk", "butter", "chicken", "salt", "cream", "tea"] })],
    pantryItems: [
      pantryItem({ id: "PANTRY-1", name: "Rice vinegar" }),
      pantryItem({ id: "PANTRY-2", name: "Eggplant" }),
      pantryItem({ id: "PANTRY-3", name: "Oat milk" }),
      pantryItem({ id: "PANTRY-4", name: "Peanut butter" }),
      pantryItem({ id: "PANTRY-5", name: "Chicken stock" }),
      pantryItem({ id: "PANTRY-6", name: "Salted butter" }),
      pantryItem({ id: "PANTRY-7", name: "Ice cream" }),
      pantryItem({ id: "PANTRY-8", name: "Steak" }),
    ],
  });
  assert.deepEqual(
    r.candidates.map((c) => c.name),
    ["rice", "eggs", "milk", "butter", "chicken", "salt", "cream", "tea"].sort(),
    "every plain staple is re-offered — none is swallowed by a compound product",
  );
  assert.equal(r.suppressed.inPantry, 0);
});

test("computeShoppingCandidates: a one-token pantry row still suppresses the compound line that contains it (row ⊆ line)", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["olive oil", "2 eggs"] })],
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Oil" }), pantryItem({ id: "PANTRY-2", name: "Eggs" })],
  });
  assert.deepEqual(r.candidates, [], "pantry 'Oil' covers planned 'olive oil'; 'Eggs' covers '2 eggs'");
  assert.equal(r.suppressed.inPantry, 2);
});

test("computeShoppingCandidates: EXPIRED stock is not stock — a planned ingredient whose only pantry row is expired stays a candidate (cos#98 review F1)", () => {
  const r = compute({
    mealPlanEntries: [meal({ id: "MEAL-1", title: "Sunday spinach pie", date: "2026-08-11", ingredients: ["spinach"] })],
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Spinach", category: "produce", location: "fridge", expiresAt: "2026-08-01", updatedAt: "2026-08-01T09:00:00.000Z" })],
  });
  assert.equal(r.candidates.length, 1, "the Friday headline scenario: expired spinach in the fridge + spinach on Sunday's plan → ONE candidate, not zero");
  assert.equal(r.candidates[0].source, "plan", "pinned: the plan side names the meal that needs it (first writer wins on the shared name key)");
  assert.equal(r.suppressed.inPantry, 0, "an expired row is not 'in pantry'");
});

test("computeShoppingCandidates: a pantry row likely past its freshness horizon is not stock either (inferred — still a candidate)", () => {
  const r = compute({
    mealPlanEntries: [meal({ id: "MEAL-1", title: "Salad", date: "2026-08-11", ingredients: ["spinach"] })],
    // produce × fridge horizon is 7 days; 40 days old, no expiresAt → likelyPastHorizon.
    pantryItems: [pantryItem({ id: "PANTRY-1", name: "Spinach", category: "produce", location: "fridge", updatedAt: "2026-07-01T09:00:00.000Z" })],
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.suppressed.inPantry, 0);
});

test("computeShoppingCandidates: boughtInWindow is bounded on BOTH ends — a row bought after `to` does not count", () => {
  const r = compute({
    mealPlanEntries: [meal({ ingredients: ["flour"] })],
    shoppingItems: [shoppingRow({ id: "SHOP-1", name: "flour", status: "bought", boughtAt: "2026-12-25T10:00:00.000Z" })],
    from: "2026-08-10",
    to: "2026-08-16",
  });
  assert.equal(r.candidates.length, 1, "a December purchase is not 'bought this window' for an August window");
  assert.equal(r.suppressed.boughtInWindow, 0);
});

test("computeShoppingCandidates: the same ingredient across two meals dedupes to ONE candidate, attributed to the earlier meal", () => {
  const r = compute({
    mealPlanEntries: [
      meal({ id: "MEAL-2", date: "2026-08-14", title: "Later meal", ingredients: ["flour"] }),
      meal({ id: "MEAL-1", date: "2026-08-11", title: "Earlier meal", ingredients: ["flour"] }),
    ],
  });
  assert.equal(r.candidates.length, 1, "deduped to one candidate despite two meals naming it");
  assert.equal(r.candidates[0].sourceRef, "MEAL-1", "attributed to the earlier meal by date, regardless of array order");
});

test("computeShoppingCandidates: a 'cooked' or 'skipped' meal contributes no plan-side candidates", () => {
  const r = compute({
    mealPlanEntries: [
      meal({ id: "MEAL-1", date: "2026-08-11", status: "cooked", ingredients: ["flour"] }),
      meal({ id: "MEAL-2", date: "2026-08-12", status: "skipped", ingredients: ["sugar"] }),
    ],
  });
  assert.deepEqual(r.candidates, [], "only 'planned' meals are read for plan-side candidates");
});

test("computeShoppingCandidates: a planned meal outside [from, to] contributes no candidates", () => {
  const r = compute({
    mealPlanEntries: [
      meal({ id: "MEAL-1", date: "2026-08-09", ingredients: ["flour"] }), // one day before the window
      meal({ id: "MEAL-2", date: "2026-08-17", ingredients: ["sugar"] }), // one day after the window
    ],
  });
  assert.deepEqual(r.candidates, [], "both meals fall outside [from, to]");
});
