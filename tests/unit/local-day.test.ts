// Zone-pinned tests for the timestamp→local-day derivation seam (cos-ops#77) — the ONE thing
// tests/unit/staleness.test.ts and tests/unit/nutrition-status.test.ts / shopping-candidates.test.ts
// deliberately do NOT cover, because CI runs in UTC, where the local frame (toISODay) and the UTC
// frame (`.slice(0, 10)`) agree by construction — a fixture pinned to a UTC instant can never
// discriminate the bug this file exists to catch.
//
// Node 26.5.0 resolves `node --test`'s `--test-isolation=process` per FILE, not per whole run —
// `tests/run.sh`'s `[1]` step (`node --test tests/unit/*.test.ts`) spawns one child process per
// `tests/unit/*.test.ts`, so a `process.env.TZ` set in THIS file cannot leak into a sibling unit
// file. Still, to stay order-independent WITHIN this file, every test below sets the TZ it needs
// as ITS OWN FIRST LINE rather than relying on a module-top assignment — ESM hoists imports above
// any top-level statement anyway, and none of the imported modules constructs a `Date` at module
// init, so a runtime `process.env.TZ` write is honored at every subsequent `Date`/`new Date()`
// call (Node >= 16) regardless of where in the file it's assigned.
//
// Every scenario below pins a FIXED timestamp + an injected `today` — never wall-clock `now`. At
// UTC+14 the local and UTC days AGREE for 10 hours of every UTC day (00:00–10:00Z), so a
// "write now, assert mismatch" test would be flaky-green; a pinned fixture is deterministic-red
// on `main` at any hour, in any CI zone.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/local-day.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { localDayOf } from "../../board/lib/staleness.ts";
import { computeNutritionStatus } from "../../board/lib/nutrition-status.ts";
import { computeShoppingCandidates } from "../../board/lib/shopping-candidates.ts";
import type { MealPlanEntry, PantryItem, ShoppingItem } from "../../board/lib/types.ts";

const pantryItem = (over: Partial<PantryItem>): PantryItem => ({
  id: "PANTRY-1",
  name: "x",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

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

const shoppingRow = (over: Partial<ShoppingItem>): ShoppingItem => ({
  id: "SHOP-1",
  name: "x",
  status: "needed",
  source: "manual",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

// a. THE TZ PROBE — if the runtime doesn't honor `process.env.TZ`, every other test below fails
// loudly on a value mismatch (no vacuous-pass path, ADR 0014), but this one names the mechanism
// directly so a platform that ignores runtime TZ (e.g. the Windows CRT) reads as ITS OWN failure.
test("TZ probe: Pacific/Kiritimati (UTC+14) shifts a UTC evening instant to the next local day", () => {
  process.env.TZ = "Pacific/Kiritimati";
  assert.equal(new Date("2026-07-26T12:00:00.000Z").getDate(), 27);
});

// b. localDayOf derives the LOCAL day, not the UTC day, for a real instant.
test("localDayOf: a UTC-midday instant lands on the NEXT local day at UTC+14", () => {
  process.env.TZ = "Pacific/Kiritimati";
  assert.equal(localDayOf("2026-07-26T12:00:00.000Z"), "2026-07-27", "the UTC slice would say 2026-07-26");
});

// c. Bare-"YYYY-MM-DD" pass-through guard, pinned WEST of UTC (Etc/GMT+5 = fixed UTC−5, no DST;
// note the POSIX Etc/GMT sign inversion) — the direction where a naive `new Date(day)` re-parse
// would shift the day WEST, which the UTC+14 probe above can't discriminate.
test("localDayOf: a bare YYYY-MM-DD day passes through unchanged; a real instant still shifts west", () => {
  process.env.TZ = "Etc/GMT+5";
  assert.equal(new Date("2026-07-21T02:00:00.000Z").getDate(), 20, "TZ pin re-probe: UTC 02:00 is still the 20th at UTC−5");
  assert.equal(localDayOf("2026-07-21"), "2026-07-21", "a bare day is already a calendar day — guardless code would say 2026-07-20");
  assert.equal(localDayOf("2026-07-21T01:30:00.000Z"), "2026-07-20", "a real instant DOES shift west of UTC");
});

// d. AC 6's minimum + the `:158` freshness-horizon twin, one scenario: a pantry write "now" reads
// daysSinceLastPantryWrite === 0, and a fresh row exactly AT its horizon is not yet PAST it — both
// computed in the route's frame instead of the UTC slice's.
test("computeNutritionStatus: pantry-day derivation matches the route's local `today` at UTC+14", () => {
  process.env.TZ = "Pacific/Kiritimati";
  const s = computeNutritionStatus({
    mealPlanEntries: [],
    foodLogs: [],
    pantryItems: [
      pantryItem({ id: "PANTRY-NOW", updatedAt: "2026-07-26T12:00:00.000Z" }), // local day = today
      pantryItem({
        id: "PANTRY-EDGE",
        category: "produce",
        location: "fridge",
        updatedAt: "2026-07-19T12:00:00.000Z", // local day 2026-07-20 — exactly 7 days before today
      }),
    ],
    nutritionTargets: [],
    today: "2026-07-27",
  });
  assert.equal(s.daysSinceLastPantryWrite, 0, "a pantry row written 'now' is 0 days old in the SAME frame as today");
  assert.equal(
    s.pantryLifecycle.likelyPastHorizon.count,
    0,
    "produce×fridge's 7-day horizon is AT, not past, when the age is computed in the local frame",
  );
});

// e. AC 3's window: a purchase made the UTC day before the window, whose LOCAL day is the window
// start, must suppress the re-offer — the shopping-candidates twin of test d.
test("computeShoppingCandidates: a purchase's window membership is judged in the local frame at UTC+14", () => {
  process.env.TZ = "Pacific/Kiritimati";
  const r = computeShoppingCandidates({
    mealPlanEntries: [meal({ ingredients: ["flour"], date: "2026-08-11" })],
    foodLogs: [],
    pantryItems: [],
    nutritionTargets: [],
    shoppingItems: [
      shoppingRow({ id: "SHOP-1", name: "flour", status: "bought", boughtAt: "2026-08-09T12:00:00.000Z" }),
    ],
    from: "2026-08-10",
    to: "2026-08-16",
    today: "2026-08-10",
  });
  assert.equal(r.candidates.length, 0, "the local day of the purchase is the window start — it suppresses");
  assert.equal(r.suppressed.boughtInWindow, 1);
});
