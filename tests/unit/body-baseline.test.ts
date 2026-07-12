// Unit tests for the PHYSIOLOGY BASELINE (board/lib/body-baseline.ts) — the uncontested-facts-only
// successor to the retired weight-loss engine. Pure, deterministic, clock-free (today injected), so
// it runs headless under `node --test` with NO disk and NO clock (sibling of the deleted
// nutrition-targets.test.ts). It asserts the FACTS (BMR/TDEE/BMI/age/trend/FFM/waist) and the ONE
// surviving safety warn (lowCalorieWarn) — and proves the baseline REFUSES to compute a recommendation
// (there is no calorie/macro target field on BodyBaseline; that is the agent's job).
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/body-baseline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ageFromDOB,
  mifflinStJeorBMR,
  tdeeFromBMR,
  bmi,
  weightTrendKg,
  currentWeightKg,
  fatFreeMassKg,
  latestWaistCm,
  lowCalorieWarn,
  bodyBaseline,
  CALORIE_FLOOR,
} from "../../board/lib/body-baseline.ts";
import type { BodyObjective, BodyProfile, WeightEntry } from "../../board/lib/types.ts";

const approx = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("ageFromDOB: whole years, with the birthday-not-yet-reached edge", () => {
  assert.equal(ageFromDOB("1991-01-01", "2026-06-21"), 35);
  assert.equal(ageFromDOB("1991-12-31", "2026-06-21"), 34, "birthday later this year → 34");
  assert.equal(ageFromDOB("1991-06-21", "2026-06-21"), 35, "birthday today → 35");
  assert.equal(ageFromDOB("not-a-date", "2026-06-21"), null);
});

test("mifflinStJeorBMR / tdeeFromBMR / bmi: the clinical-standard numbers", () => {
  // 28y male, 178cm, 75kg → 10·75 + 6.25·178 − 5·28 + 5 = 1727.5
  assert.equal(mifflinStJeorBMR({ sex: "male", weightKg: 75, heightCm: 178, age: 28 }), 1727.5);
  // female subtracts 161 instead of adding 5
  assert.equal(mifflinStJeorBMR({ sex: "female", weightKg: 75, heightCm: 178, age: 28 }), 1727.5 - 166);
  approx(tdeeFromBMR(1727.5, "moderate"), 2677.625); // ×1.55
  approx(bmi(75, 178), 23.6712);
});

test("currentWeightKg + weightTrendKg: latest raw vs EWMA-smoothed trend", () => {
  const weights: WeightEntry[] = [
    { id: "W1", date: "2026-06-01", weightKg: 80, createdAt: "x", updatedAt: "x" },
    { id: "W2", date: "2026-06-08", weightKg: 79, createdAt: "x", updatedAt: "x" },
    { id: "W3", date: "2026-06-15", weightKg: 78, createdAt: "x", updatedAt: "x" },
  ];
  assert.equal(currentWeightKg(weights, "2026-06-21"), 78, "latest on/before today");
  assert.equal(currentWeightKg(weights, "2026-06-05"), 80, "respects the as-of day");
  // EWMA seed 80 → 0.25·79+0.75·80 = 79.75 → 0.25·78+0.75·79.75 = 79.3125
  approx(weightTrendKg(weights, "2026-06-21")!, 79.3125);
  assert.equal(weightTrendKg([], "2026-06-21"), null, "empty series → null");
});

test("fatFreeMassKg: prefers measured leanMassKg, else derives from bodyFatPct", () => {
  const measured: WeightEntry[] = [{ id: "W1", date: "2026-06-01", weightKg: 80, leanMassKg: 58, createdAt: "x", updatedAt: "x" }];
  assert.equal(fatFreeMassKg(measured, "2026-06-21"), 58, "measured FFM wins");
  const derived: WeightEntry[] = [{ id: "W1", date: "2026-06-01", weightKg: 80, bodyFatPct: 25, createdAt: "x", updatedAt: "x" }];
  assert.equal(fatFreeMassKg(derived, "2026-06-21"), 60, "80 × (1 − 0.25) = 60");
  const none: WeightEntry[] = [{ id: "W1", date: "2026-06-01", weightKg: 80, createdAt: "x", updatedAt: "x" }];
  assert.equal(fatFreeMassKg(none, "2026-06-21"), null, "no comp signal → null");
});

test("latestWaistCm: newest waist reading, or null", () => {
  const weights: WeightEntry[] = [
    { id: "W1", date: "2026-06-01", weightKg: 80, waistCm: 92, createdAt: "x", updatedAt: "x" },
    { id: "W2", date: "2026-06-15", weightKg: 79, waistCm: 90, createdAt: "x", updatedAt: "x" },
    { id: "W3", date: "2026-06-20", weightKg: 79, createdAt: "x", updatedAt: "x" }, // no waist this day
  ];
  assert.equal(latestWaistCm(weights, "2026-06-21"), 90, "newest day WITH a waist reading");
  assert.equal(latestWaistCm([], "2026-06-21"), null);
});

test("lowCalorieWarn: the one surviving safety guard — a warn below the sex floor, null above", () => {
  assert.equal(CALORIE_FLOOR.male, 1500);
  assert.equal(CALORIE_FLOOR.female, 1200);
  assert.equal(lowCalorieWarn(1600, "male"), null, "at/above floor → no warn");
  const w = lowCalorieWarn(1400, "male");
  assert.ok(w && w.level === "warn" && w.id === "low-calorie", "below floor → a warn flag");
  assert.ok(lowCalorieWarn(1100, "female"), "1100 < 1200 → warn for women");
  assert.equal(lowCalorieWarn(1300, "female"), null, "1300 ≥ 1200 → ok for women");
});

test("bodyBaseline: full facts when configured; NO recommendation field exists", () => {
  const profile: BodyProfile = {
    sex: "male", dateOfBirth: "1991-06-21", heightCm: 178, trainingStatus: "intermediate",
    resistanceTrains: true, weightUnit: "kg", createdAt: "x", updatedAt: "x",
  };
  const objective: BodyObjective = { goalText: "lean out", targetWeightKg: 72, targetDate: null, activity: "moderate", createdAt: "x", updatedAt: "x" };
  const weights: WeightEntry[] = [{ id: "W1", date: "2026-06-01", weightKg: 75, bodyFatPct: 20, createdAt: "x", updatedAt: "x" }];

  const b = bodyBaseline({ profile, objective, weights, foodLogs: [], today: "2026-06-21" });
  assert.equal(b.configured, true);
  assert.deepEqual(b.needs, []);
  assert.equal(b.ageYears, 35);
  assert.equal(b.currentWeightKg, 75);
  // BMR with age 35: 10·75 + 6.25·178 − 5·35 + 5 = 1692.5 → 1693 rounded
  assert.equal(b.bmrKcal, 1693);
  assert.equal(b.tdeeKcal, Math.round(1692.5 * 1.55)); // 2623
  assert.equal(b.basis, "estimated", "no measured loop with one weigh-in / no food logs");
  assert.equal(b.ffmKg, 60, "75 × 0.8");
  assert.equal(b.bmiCurrent, 23.7, "BMI rounded to 1 dp in the envelope");
  assert.equal(b.notMedicalAdvice, true);
  // The acid test: the baseline is FACTS only — it exposes no calorie/macro recommendation.
  assert.equal("dailyCalorieTarget" in b, false, "no recommendation field (that is the agent's job)");
  assert.equal("macros" in b, false);
});

test("bodyBaseline: cold-start lists exactly what is missing", () => {
  const b = bodyBaseline({ profile: null, objective: null, weights: [], foodLogs: [], today: "2026-06-21" });
  assert.equal(b.configured, false);
  assert.deepEqual(b.needs.sort(), ["objective", "profile", "weight"]);
  assert.equal(b.bmrKcal, null);
  assert.equal(b.tdeeKcal, null);
  assert.equal(b.ageYears, null);
});
