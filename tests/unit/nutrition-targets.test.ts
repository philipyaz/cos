// Unit tests for the weight-loss TARGETS ENGINE (board/lib/nutrition-targets.ts) — the
// pure, I/O-free projection that turns the goal/profile + weigh-in series + food log into
// the render-ready "how am I doing" envelope. The engine is deterministic given its inputs
// (no clock — `today` is passed in), so this suite drives the REAL exported functions on
// in-memory fixtures, never touching disk or a clock. It is the sibling of
// selectors.test.ts / store.test.ts: pure logic, run headless under `node --test`.
//
// What it asserts (against the ACTUAL implementation, not a re-derivation):
//   • the memo WORKED EXAMPLE — male/35y/180cm/90kg, target 80kg, moderate, rate 0.5 →
//     BMR 1855, TDEE 2875, deficit ~550, dailyCalorieTarget ~2325, fatG 72 (these are the
//     unambiguous physiology numbers, so they are hard-coded as the fixture's expectation);
//   • the RATE CAP — an over-aggressive requested rate (2.0 kg/wk on a 70 kg person) is
//     clamped to ~0.7 kg/wk (1% of body weight) and emits a "rate-capped" warn;
//   • the DEFICIT CAP / FLOOR — a small, low-TDEE profile whose rate-implied deficit blows
//     past 25% of maintenance (and the per-sex floor) is clamped and emits "deficit-capped";
//   • the BMI guardrail — a sub-18.5 BMI target emits "target-below-bmi";
//   • the ALWAYS-ON not-medical-advice info flag is present in EVERY envelope;
//   • per-day ADHERENCE statuses (on_track / over / well_over / under) classify correctly,
//     newest-first;
//   • the MEASURED-TDEE feedback loop — null with too few logged days, a sensible number
//     (basis="measured") with a full window;
//   • the "needs configuration" envelope still resolves (nulls + the info flag) with no goal.
//
// Run from repo root (same invocation as nutrition-migration.test.ts):
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/nutrition-targets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mifflinStJeorBMR,
  tdeeFromBMR,
  bmi,
  weightTrendKg,
  measuredTdee,
  macroTargets,
  computeNutritionTargets,
  KCAL_PER_KG,
  MEASURED_MIN_DAYS,
} from "../../board/lib/nutrition-targets.ts";
import type { NutritionGoal, WeightEntry, FoodLogEntry } from "../../board/lib/types.ts";

const TODAY = "2026-06-14"; // the fixed "today" every case computes against

// ── Tiny fixture builders (keep the cases terse + obviously-correct) ────────────
// A weigh-in on a day. The store stamps createdAt/updatedAt; the engine ignores them, so a
// constant timestamp keeps the fixtures readable.
const TS = "2026-06-14T12:00:00.000Z";
const weight = (date: string, weightKg: number): WeightEntry => ({
  id: `WEIGHT-${date}`,
  date,
  weightKg,
  createdAt: TS,
  updatedAt: TS,
});
// A food-log entry — only `date` + `calories` matter to the engine, the rest is filler.
const food = (date: string, calories: number): FoodLogEntry => ({
  id: `FOOD-${date}`,
  date,
  slot: "lunch",
  description: "fixture meal",
  calories,
  estimated: true,
  createdAt: TS,
  updatedAt: TS,
});
// A complete goal with sensible defaults; spread in per-case overrides.
const goalOf = (over: Partial<NutritionGoal> = {}): NutritionGoal => ({
  sex: "male",
  age: 35,
  heightCm: 180,
  activity: "moderate",
  targetWeightKg: 80,
  rateKgPerWeek: 0.5,
  weightUnit: "kg",
  createdAt: TS,
  updatedAt: TS,
  ...over,
});

// Does the flags array carry a flag with this id?
const hasFlag = (flags: { id: string }[], id: string): boolean => flags.some((f) => f.id === id);

// ── The pure physiology helpers (the unambiguous numbers) ───────────────────────
test("mifflinStJeorBMR + tdeeFromBMR: the memo's male/35/180/90 → BMR 1855, moderate TDEE 2875", () => {
  const bmr = mifflinStJeorBMR({ sex: "male", weightKg: 90, heightCm: 180, age: 35 });
  assert.equal(bmr, 1855, "Mifflin-St Jeor BMR (10*90 + 6.25*180 - 5*35 + 5)");
  // The female constant is −161; flip just the sex to confirm the sign of the term.
  const bmrFemale = mifflinStJeorBMR({ sex: "female", weightKg: 90, heightCm: 180, age: 35 });
  assert.equal(bmrFemale, 1855 - 166, "the female BMR is 166 lower (the +5 → −161 swing)");
  assert.equal(Math.round(tdeeFromBMR(bmr, "moderate")), 2875, "TDEE = BMR × 1.55 (moderate)");
});

test("bmi: a normal/underweight pair classifies around the 18.5 threshold", () => {
  assert.equal(Math.round(bmi(80, 180) * 10) / 10, 24.7, "80 kg @ 180 cm ≈ 24.7 (healthy)");
  assert.ok(bmi(58, 180) < 18.5, "58 kg @ 180 cm is below the 18.5 healthy floor");
});

test("macroTargets: protein-first split for the worked example (fat floor → 72 g)", () => {
  // calorieTarget 2325, current 90, target 80. proteinG = round(1.8*min(90, 85)) = 153;
  // fatG = max(round(0.8*90)=72, round(0.20*2325/9)=52) = 72; carbs = remainder.
  const m = macroTargets({ calorieTarget: 2325, currentWeightKg: 90, targetWeightKg: 80 });
  assert.equal(m.proteinG, 153, "protein biased to min(current, target+5) → 1.8 × 85");
  assert.equal(m.fatG, 72, "fat = max(0.8×current, 20%-of-kcal floor) → 72 g");
  // carbs are whatever calories remain after protein (4) + fat (9): (2325 − 612 − 648)/4.
  assert.equal(m.carbsG, Math.round((2325 - 153 * 4 - 72 * 9) / 4), "carbs are the kcal remainder");
});

// ── weightTrendKg (EWMA) ────────────────────────────────────────────────────────
test("weightTrendKg: null with no in-range weights; seeded to the first weight; smooths toward the latest", () => {
  assert.equal(weightTrendKg([], TODAY), null, "no entries → null");
  assert.equal(weightTrendKg([weight("2026-06-01", 90)], TODAY), 90, "a single weight = itself (EWMA seed)");
  // Two points: ema = 0.25*last + 0.75*first → between the two, nearer the seed (alpha=0.25).
  const trend = weightTrendKg([weight("2026-06-01", 90), weight("2026-06-08", 86)], TODAY);
  assert.ok(trend !== null && trend > 88 && trend < 90, "the EWMA trend lags the latest (water-weight damping)");
  // Future-dated weigh-ins (date > today) are excluded.
  assert.equal(weightTrendKg([weight("2026-07-01", 70)], TODAY), null, "a weigh-in after `today` is out of range");
});

// ── measuredTdee (the feedback loop) ────────────────────────────────────────────
test("measuredTdee: null when fewer than MEASURED_MIN_DAYS are logged", () => {
  // MEASURED_MIN_DAYS−1 logged days over the window, even with a valid weight span → null.
  const days: FoodLogEntry[] = [];
  for (let d = 1; d <= MEASURED_MIN_DAYS - 1; d++) days.push(food(`2026-06-${String(d).padStart(2, "0")}`, 2000));
  const weights = [weight("2026-06-01", 90), weight("2026-06-14", 89)];
  assert.equal(days.length, MEASURED_MIN_DAYS - 1, "one short of the logged-day minimum");
  assert.equal(measuredTdee(days, weights, TODAY), null, "below the 10-day logged minimum → null");
});

test("measuredTdee: a full window (14 logged days, 13-day weight span, 1 kg lost) → ~2592 kcal", () => {
  // 14 days of 2000 kcal across [2026-06-01 .. 2026-06-14] (the window for today=06-14), plus
  // two weigh-ins spanning the whole window losing exactly 1.0 kg.
  const days: FoodLogEntry[] = [];
  for (let d = 1; d <= 14; d++) days.push(food(`2026-06-${String(d).padStart(2, "0")}`, 2000));
  const weights = [weight("2026-06-01", 90.0), weight("2026-06-14", 89.0)];
  // measured = round(2000 − (−1.0 × 7700) / 13) = 2000 + 592 = 2592 (lost weight ⇒ true TDEE higher).
  assert.equal(measuredTdee(days, weights, TODAY), Math.round(2000 + (1.0 * KCAL_PER_KG) / 13), "feedback-loop TDEE");
  assert.equal(measuredTdee(days, weights, TODAY), 2592, "the concrete number for this fixture");
});

// ── computeNutritionTargets: the memo worked example ────────────────────────────
test("computeNutritionTargets: the memo example (male/35/180/90→80, moderate, 0.5) resolves the headline numbers", () => {
  const t = computeNutritionTargets({
    goal: goalOf(),
    weights: [weight("2026-06-14", 90)], // one weigh-in today → no measured TDEE (estimated basis)
    foodLogs: [],
    today: TODAY,
  });
  assert.equal(t.configured, true, "goal + a current weight → configured");
  assert.deepEqual(t.needs, [], "nothing left to configure");
  assert.equal(t.currentWeightKg, 90, "the latest weigh-in is the current weight");
  assert.equal(t.bmrKcal, 1855, "BMR 1855 (the memo)");
  assert.equal(t.tdeeKcal, 2875, "estimated TDEE 2875 (the memo)");
  assert.equal(t.measuredTdeeKcal, null, "no measured TDEE with a single weigh-in + no logs");
  assert.equal(t.basis, "estimated", "basis falls back to the formula estimate");
  assert.equal(t.dailyCalorieTarget, 2325, "daily target 2325 (the memo)");
  assert.equal(t.deficitKcal, 550, "effective deficit ~550 (0.5 kg/wk × 7700 / 7)");
  assert.equal(t.rateKgPerWeek, 0.5, "0.5 kg/wk was within the cap → unchanged");
  assert.equal(t.macros?.fatG, 72, "fatG 72 (the memo)");
  assert.equal(t.targetWeightKg, 80, "target weight echoed");
  assert.equal(t.notMedicalAdvice, true, "the literal not-medical-advice marker");
  // The only flag in this clean case is the always-on info note (no safety clamp tripped).
  assert.equal(t.flags.length, 1, "no safety warn fired for the in-bounds memo example");
  assert.ok(hasFlag(t.flags, "not-medical-advice"), "the not-medical-advice info flag is present");
  assert.equal(t.flags[0]?.level, "info", "…and it leads as an info-level flag");
});

// ── the always-on info flag, in EVERY shape (incl. unconfigured) ────────────────
test("computeNutritionTargets: the not-medical-advice flag is present even with NO goal/weight (needs-config envelope)", () => {
  const t = computeNutritionTargets({ goal: null, weights: [], foodLogs: [], today: TODAY });
  assert.equal(t.configured, false, "no goal and no weight → not configured");
  assert.deepEqual(t.needs, ["goal", "weight"], "both pieces are flagged as needed");
  assert.equal(t.dailyCalorieTarget, null, "no numeric target without a goal");
  assert.equal(t.bmrKcal, null, "no BMR without a goal + weight");
  assert.equal(t.notMedicalAdvice, true, "the marker is still set");
  assert.ok(hasFlag(t.flags, "not-medical-advice"), "the not-medical-advice flag ALWAYS resolves");
});

// ── the rate cap ────────────────────────────────────────────────────────────────
test("computeNutritionTargets: an over-aggressive rate (2.0 kg/wk on 70 kg) is capped to ~0.7 and flags rate-capped", () => {
  const t = computeNutritionTargets({
    goal: goalOf({ rateKgPerWeek: 2.0, targetWeightKg: 65 }), // 65 kg @ 180 cm ≈ 20.1 BMI → no BMI flag
    weights: [weight("2026-06-14", 70)],
    foodLogs: [],
    today: TODAY,
  });
  // rateCap = min(1.0, 70 × 0.01 = 0.7) → 0.7; the envelope carries the EFFECTIVE rate.
  assert.equal(t.rateKgPerWeek, 0.7, "the effective rate is clamped to 1% of body weight (0.7 kg/wk)");
  assert.ok(hasFlag(t.flags, "rate-capped"), "a rate-capped warn fires");
  const flag = t.flags.find((f) => f.id === "rate-capped");
  assert.equal(flag?.level, "warn", "rate-capped is a warn");
  assert.match(flag?.message ?? "", /0\.7/, "the warn states the capped rate (0.7)");
  // The BMI target is healthy here, so target-below-bmi must NOT fire.
  assert.equal(hasFlag(t.flags, "target-below-bmi"), false, "no BMI warn for a healthy target");
});

// ── the deficit cap / floor ─────────────────────────────────────────────────────
test("computeNutritionTargets: a low-TDEE profile whose deficit blows past 25%/floor flags deficit-capped", () => {
  // female/30/160/50 sedentary: TDEE ≈ 1427. rate 0.5 → implied deficit 550 > 25%×1427 (357)
  // AND the floored target (1200) bites. Target 48 kg @ 160 cm ≈ 18.75 BMI → above 18.5 (no BMI flag).
  const t = computeNutritionTargets({
    goal: goalOf({ sex: "female", age: 30, heightCm: 160, activity: "sedentary", targetWeightKg: 48, rateKgPerWeek: 0.5 }),
    weights: [weight("2026-06-14", 50)],
    foodLogs: [],
    today: TODAY,
  });
  assert.equal(t.tdeeKcal, 1427, "estimated TDEE for the small sedentary profile");
  assert.equal(t.dailyCalorieTarget, 1200, "the target is held at the female 1200 floor");
  assert.ok(hasFlag(t.flags, "deficit-capped"), "a deficit-capped warn fires (25% cap + floor bit)");
  const flag = t.flags.find((f) => f.id === "deficit-capped");
  assert.equal(flag?.level, "warn", "deficit-capped is a warn");
  // rate 0.5 ≤ cap (min(1.0, 50×0.01=0.5)) → NOT rate-capped; isolate the deficit flag.
  assert.equal(hasFlag(t.flags, "rate-capped"), false, "the rate itself was within the cap → no rate-capped");
});

// ── the BMI-target guardrail ────────────────────────────────────────────────────
test("computeNutritionTargets: a sub-18.5 BMI target flags target-below-bmi", () => {
  // 58 kg @ 180 cm ≈ 17.9 BMI (< 18.5). current 90 kg keeps the rate uncapped (90×0.01=0.9 ≥ 0.5).
  const t = computeNutritionTargets({
    goal: goalOf({ targetWeightKg: 58 }),
    weights: [weight("2026-06-14", 90)],
    foodLogs: [],
    today: TODAY,
  });
  assert.ok(t.bmiTarget !== null && t.bmiTarget < 18.5, "the target BMI is below the healthy floor");
  assert.ok(hasFlag(t.flags, "target-below-bmi"), "a target-below-bmi warn fires");
  assert.equal(t.flags.find((f) => f.id === "target-below-bmi")?.level, "warn", "it is a warn");
});

// ── per-day adherence classification ────────────────────────────────────────────
test("computeNutritionTargets: adherence statuses classify each day vs the target, newest first", () => {
  // dailyCalorieTarget for the memo profile is 2325. Build days that land in each band:
  //   under     ≤ 0.6×2325 = 1395   → 1000
  //   on_track  ≤ 2325               → 2300
  //   over       ≤ 1.15×2325 = 2674  → 2600
  //   well_over  > 2674              → 3200
  const t = computeNutritionTargets({
    goal: goalOf(),
    weights: [weight("2026-06-14", 90)],
    foodLogs: [
      food("2026-06-10", 1000), // under
      food("2026-06-11", 2300), // on_track
      food("2026-06-12", 2600), // over
      food("2026-06-13", 3200), // well_over
    ],
    today: TODAY,
  });
  assert.equal(t.dailyCalorieTarget, 2325, "the target the days are judged against");
  // Newest first → 06-13, 06-12, 06-11, 06-10.
  assert.deepEqual(
    t.adherence.map((d) => [d.date, d.status]),
    [
      ["2026-06-13", "well_over"],
      ["2026-06-12", "over"],
      ["2026-06-11", "on_track"],
      ["2026-06-10", "under"],
    ],
    "each day is classified into its band, newest first",
  );
  // deltaKcal is calories − target (signed).
  const over = t.adherence.find((d) => d.date === "2026-06-12");
  assert.equal(over?.deltaKcal, 2600 - 2325, "deltaKcal is the signed gap to target");
  // Same-day multiple logs are summed into one adherence row.
  const t2 = computeNutritionTargets({
    goal: goalOf(),
    weights: [weight("2026-06-14", 90)],
    foodLogs: [food("2026-06-13", 1500), food("2026-06-13", 1000)],
    today: TODAY,
  });
  assert.equal(t2.adherence.length, 1, "two logs on one day collapse to a single adherence row");
  assert.equal(t2.adherence[0]?.calories, 2500, "…with the day's calories summed");
});

// ── today's running tally ───────────────────────────────────────────────────────
test("computeNutritionTargets: todayCalories sums today's logs and todayRemaining nets them off the target", () => {
  const t = computeNutritionTargets({
    goal: goalOf(),
    weights: [weight("2026-06-14", 90)],
    foodLogs: [food(TODAY, 800), food(TODAY, 700), food("2026-06-13", 5000)],
    today: TODAY,
  });
  assert.equal(t.todayCalories, 1500, "only today's logs count toward todayCalories");
  assert.equal(t.todayRemaining, 2325 - 1500, "todayRemaining = dailyCalorieTarget − todayCalories");
});

// ── the measured basis flips the engine end-to-end ──────────────────────────────
test("computeNutritionTargets: a full feedback-window flips basis to 'measured' and drives the deficit off it", () => {
  const days: FoodLogEntry[] = [];
  for (let d = 1; d <= 14; d++) days.push(food(`2026-06-${String(d).padStart(2, "0")}`, 2000));
  const weights = [weight("2026-06-01", 90.0), weight("2026-06-14", 89.0)];
  const t = computeNutritionTargets({ goal: goalOf(), weights, foodLogs: days, today: TODAY });
  assert.equal(t.measuredTdeeKcal, 2592, "the measured TDEE from the feedback loop");
  assert.equal(t.basis, "measured", "with enough data the engine prefers the measured basis");
  // The deficit is now taken off the MEASURED 2592, not the formula 2875.
  assert.equal(t.deficitKcal, 550, "0.5 kg/wk → a 550 kcal deficit off the measured maintenance");
  assert.equal(t.dailyCalorieTarget, 2592 - 550, "daily target = measured TDEE − the deficit");
});
