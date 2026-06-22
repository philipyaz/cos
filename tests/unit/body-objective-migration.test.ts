// Unit tests for the v13 → v14 migration that introduces the "body" add-on. The migration
// SYNTHESIZES db.bodyProfile + db.bodyObjective from the legacy db.nutritionGoal (+ the v12
// db.athleteProfile for the deduped training level), then STOPS carrying nutritionGoal forward.
// It must be: CLOCK-FREE (frozen anchors, never new Date()), IDEMPOTENT (a v14 file's existing
// singletons are taken verbatim, never re-synthesized), ADDITIVE (db.weights + every other array
// rides through untouched), and TOTAL (no legacy goal → no synthesis, never a throw).
//
// Scope: the DISK read path (readDB → migrate), driving an ISOLATED throwaway COS_DATA_DIR exactly
// like nutrition-weight-migration.test.ts — the real board/data file is never touched.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/body-objective-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-body-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?bodymig");
const DATA_FILE = store.DATA_FILE as string;

async function seed(raw: string): Promise<void> {
  await fsp.mkdir(DISK_DIR, { recursive: true });
  await fsp.writeFile(DATA_FILE, raw, "utf8");
  await fsp.rm(`${DATA_FILE}.bak`, { force: true });
}

const baseV13 = {
  schemaVersion: 13,
  version: 7,
  cases: [],
  messages: [],
  events: [],
  reminders: [],
  priorities: [],
  foodLogs: [],
  pantryItems: [],
  mealPlanEntries: [],
  weights: [],
  settings: { autoSync: false, addons: { nutrition: { enabled: true } } },
};

test("v13→v14: full goal + athlete profile → bodyProfile (level-mapped, RT-derived) + bodyObjective", async () => {
  await seed(
    JSON.stringify({
      ...baseV13,
      nutritionGoal: {
        sex: "female",
        age: 41,
        heightCm: 165,
        activity: "light",
        targetWeightKg: 62,
        rateKgPerWeek: 0.75,
        weightUnit: "lb",
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-03-04T00:00:00.000Z",
      },
      athleteProfile: {
        goal: "general_fitness",
        level: "advanced",
        sports: ["strength_training", "running"],
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      },
    }),
  );

  const db = await store.readDB();
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.nutritionGoal, undefined, "legacy goal dropped (transformed)");

  // bodyProfile — identity copied, DOB fabricated (2026 − 41 = 1985), level "advanced" passes
  // through, strength_training in sports → resistanceTrains true, lb preference re-homed.
  assert.equal(db.bodyProfile?.sex, "female");
  assert.equal(db.bodyProfile?.heightCm, 165);
  assert.equal(db.bodyProfile?.dateOfBirth, "1985-01-01", "2026 − 41 = 1985 (clock-free)");
  assert.equal(db.bodyProfile?.trainingStatus, "advanced");
  assert.equal(db.bodyProfile?.resistanceTrains, true, "strength_training in sports → lifts");
  assert.equal(db.bodyProfile?.weightUnit, "lb");
  assert.equal(db.bodyProfile?.createdAt, "2025-01-02T00:00:00.000Z", "legacy createdAt carried (no clock)");

  // bodyObjective — activity + target + abs(rate inside prose), free-text goalText.
  assert.equal(db.bodyObjective?.activity, "light");
  assert.equal(db.bodyObjective?.targetWeightKg, 62);
  assert.equal(db.bodyObjective?.targetDate, null);
  assert.match(db.bodyObjective?.goalText ?? "", /62 kg/, "target reflected in prose");
  assert.match(db.bodyObjective?.goalText ?? "", /0\.75 kg per week/, "rate reflected in prose");
});

test("v13→v14: athlete level 'beginner' maps to 'novice'", async () => {
  await seed(
    JSON.stringify({
      ...baseV13,
      nutritionGoal: { sex: "male", age: 30, heightCm: 175, activity: "moderate", targetWeightKg: 72, rateKgPerWeek: 0.5 },
      athleteProfile: { goal: "running", level: "beginner", sports: ["running"] },
    }),
  );
  const db = await store.readDB();
  assert.equal(db.bodyProfile?.trainingStatus, "novice", "'beginner' → 'novice'");
  assert.equal(db.bodyProfile?.resistanceTrains, false, "running only → not a lifter");
});

test("v13→v14: IDEMPOTENT — an existing v14 bodyProfile/bodyObjective is taken verbatim, never re-synthesized", async () => {
  await seed(
    JSON.stringify({
      ...baseV13,
      schemaVersion: 14,
      // A legacy goal is present, but the v14 singletons already exist → synthesis must NOT overwrite them.
      nutritionGoal: { sex: "male", age: 30, heightCm: 175, activity: "moderate", targetWeightKg: 72, rateKgPerWeek: 0.5 },
      bodyProfile: {
        sex: "male", dateOfBirth: "1990-07-15", heightCm: 181, trainingStatus: "intermediate",
        resistanceTrains: true, weightUnit: "kg", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
      },
      bodyObjective: {
        goalText: "Lean recomposition — hold ~80 kg, drop body fat, keep my deadlift.", targetWeightKg: null,
        targetDate: "2026-12-31", activity: "very_active", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
      },
    }),
  );
  const db = await store.readDB();
  assert.equal(db.bodyProfile?.dateOfBirth, "1990-07-15", "existing DOB untouched (not re-fabricated from age)");
  assert.equal(db.bodyProfile?.trainingStatus, "intermediate");
  assert.equal(db.bodyObjective?.goalText, "Lean recomposition — hold ~80 kg, drop body fat, keep my deadlift.", "custom goalText preserved");
  assert.equal(db.bodyObjective?.targetWeightKg, null, "explicit null target preserved (recomp)");
  assert.equal(db.bodyObjective?.activity, "very_active");
});

test("v13→v14: TOTAL — no legacy goal → no synthesis, no throw (body enabled-but-empty)", async () => {
  await seed(JSON.stringify({ ...baseV13, weights: [{ id: "WEIGHT-1", date: "2026-06-01", weightKg: 70, createdAt: "x", updatedAt: "x" }] }));
  const db = await store.readDB();
  assert.equal(db.bodyProfile, undefined, "no goal → no bodyProfile invented");
  assert.equal(db.bodyObjective, undefined, "no goal → no bodyObjective invented");
  assert.equal(db.weights?.length, 1, "weights still ride through (additive)");
  assert.deepEqual(db.nutritionTargets, [], "nutritionTargets defaults to []");
});

test("v13→v14: CLOCK-FREE + deterministic — two reads of the same fixture produce identical singletons", async () => {
  const fixture = JSON.stringify({
    ...baseV13,
    nutritionGoal: { sex: "male", age: 28, heightCm: 178, activity: "moderate", targetWeightKg: 75, rateKgPerWeek: 0.5 },
  });
  await seed(fixture);
  const a = await store.readDB();
  await seed(fixture);
  const b = await store.readDB();
  assert.deepEqual(a.bodyProfile, b.bodyProfile, "bodyProfile is deterministic across reads (no clock)");
  assert.deepEqual(a.bodyObjective, b.bodyObjective, "bodyObjective is deterministic across reads (no clock)");
  assert.equal(a.bodyProfile?.dateOfBirth, "1998-01-01", "2026 − 28 = 1998");
});
