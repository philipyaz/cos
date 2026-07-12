// Unit tests for the v9 → v10 migration that adds the Nutrition weight-loss vertical:
// db.weights (WeightEntry[]) and db.nutritionGoal (a SINGLETON NutritionGoal object, NOT
// an array). v10 is PURELY ADDITIVE — an old v9 file reads unchanged, with weights
// defaulting to [] and nutritionGoal staying absent (no goal === undefined) until the
// first PUT. The sibling nutrition-migration.test.ts covers the v8→v9 add (the foodLogs/
// pantryItems/mealPlanEntries arrays + settings.addons); this one covers ONLY the v10 pair.
//
// Scope: the DISK read path (readDB → parseAndMigrate / migrate), where the new state is
// defaulted/carried for downstream code. Drives an ISOLATED throwaway COS_DATA_DIR
// (os.mkdtemp) exactly like nutrition-migration.test.ts — the real board/data file is never
// read or written. Asserts:
//   • a v9 fixture (no weights, no nutritionGoal) reads clean as v10 with db.weights
//     defaulting to [] and db.nutritionGoal staying ABSENT (a singleton, not invented);
//   • a v10 fixture (weights populated + a nutritionGoal singleton) round-trips — readDB
//     preserves the weigh-in series AND the goal object;
//   • the existing v9 data (foodLogs/pantryItems/mealPlanEntries + settings.addons) still
//     rides through untouched alongside the v10 additions (the additive guarantee).
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/nutrition-weight-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import time.
// Point it at a throwaway dir BEFORE the dynamic import so DATA_FILE lands inside the
// sandbox (the real board/data is never touched). The cache-busting `?wtmig` query forces
// a fresh module instance whose DATA_DIR re-reads the env; the ts-resolve hook leaves the
// specifier alone (its pathname still ends in .ts → type-stripping applies).
const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-nut-wt-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?wtmig");
const DATA_FILE = store.DATA_FILE as string;

// Seed cases.json (and clear any .bak) so each case starts clean.
async function seed(raw: string): Promise<void> {
  await fsp.mkdir(DISK_DIR, { recursive: true });
  await fsp.writeFile(DATA_FILE, raw, "utf8");
  await fsp.rm(`${DATA_FILE}.bak`, { force: true });
}

// A v9 store WITH the v9 nutrition arrays + settings.addons but WITHOUT the v10 pair (no
// db.weights, no db.nutritionGoal) — the realistic "old file" a v10 binary will read.
const V9_FIXTURE = {
  schemaVersion: 9,
  version: 21,
  cases: [{ id: "CASE-1", title: "Pre-v10 case", status: "todo", domain: "work", tasks: [], messageIds: [] }],
  messages: [],
  events: [],
  reminders: [],
  priorities: [],
  foodLogs: [
    {
      id: "FOOD-1",
      date: "2026-06-13",
      slot: "lunch",
      description: "Chicken salad",
      calories: 420,
      estimated: true,
      createdAt: "2026-06-13T12:00:00.000Z",
      updatedAt: "2026-06-13T12:00:00.000Z",
    },
  ],
  pantryItems: [],
  mealPlanEntries: [],
  settings: { autoSync: false, addons: { nutrition: { enabled: true, installedAt: "2026-06-13T11:00:00.000Z" } } },
};

test("migration: a v9 fixture (no weights / no nutritionGoal) reads clean as v10 — weights default to [], goal stays absent", async () => {
  await seed(JSON.stringify(V9_FIXTURE, null, 2));

  const db = await store.readDB();

  assert.equal(db.schemaVersion, SCHEMA_VERSION, "schemaVersion stamped to v10 on read");
  assert.equal(db.version, 21, "the monotonic version is preserved through migration");
  // The v10 additions: weights defaults to []; the goal singleton is NOT invented.
  assert.deepEqual(db.weights, [], "db.weights defaults to [] on a v9 file");
  assert.equal(db.nutritionGoal, undefined, "db.nutritionGoal stays absent (a singleton, set on first PUT)");
  // The pre-existing v9 state rides through untouched (the additive guarantee).
  assert.equal(db.foodLogs?.length, 1, "the v9 food-log entry survives the v10 read");
  assert.equal(db.foodLogs?.[0]?.id, "FOOD-1");
  assert.deepEqual(db.pantryItems, [], "the v9 pantry array rides through");
  assert.deepEqual(db.mealPlanEntries, [], "the v9 meal-plan array rides through");
  assert.equal(db.settings?.addons?.nutrition?.enabled, true, "settings.addons rides through untouched");
  assert.equal(db.cases[0]?.id, "CASE-1", "the pre-v10 case survives");
});

test("migration: a v10 fixture migrates to v14 — weights survive (re-homed), the legacy goal becomes bodyProfile+bodyObjective, nutritionGoal is dropped", async () => {
  const v10 = {
    schemaVersion: 10,
    version: 42,
    cases: [],
    messages: [],
    events: [],
    reminders: [],
    priorities: [],
    foodLogs: [],
    pantryItems: [],
    mealPlanEntries: [],
    weights: [
      {
        id: "WEIGHT-1",
        date: "2026-06-01",
        weightKg: 90.5,
        note: "morning",
        createdAt: "2026-06-01T07:00:00.000Z",
        updatedAt: "2026-06-01T07:00:00.000Z",
      },
      {
        id: "WEIGHT-2",
        date: "2026-06-14",
        weightKg: 89.2,
        createdAt: "2026-06-14T07:00:00.000Z",
        updatedAt: "2026-06-14T07:00:00.000Z",
      },
    ],
    nutritionGoal: {
      sex: "male",
      age: 35,
      heightCm: 180,
      activity: "moderate",
      targetWeightKg: 80,
      rateKgPerWeek: 0.5,
      weightUnit: "kg",
      createdAt: "2026-06-01T07:00:00.000Z",
      updatedAt: "2026-06-01T07:00:00.000Z",
    },
    settings: { autoSync: false },
  };
  await seed(JSON.stringify(v10, null, 2));

  const db = await store.readDB();

  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.version, 42, "version preserved through the v14 migration");
  // The weigh-in series survives in order with its fields intact (re-homed to the body add-on,
  // manifest-only — same key, same rows).
  assert.equal(db.weights?.length, 2, "both weigh-ins survive the migration");
  assert.equal(db.weights?.[0]?.id, "WEIGHT-1");
  assert.equal(db.weights?.[0]?.weightKg, 90.5, "canonical kg preserved");
  assert.equal(db.weights?.[0]?.note, "morning", "the optional note rides through");
  assert.equal(db.weights?.[1]?.id, "WEIGHT-2");
  // The legacy nutritionGoal is NO LONGER carried forward — it is the source the v14 synthesis
  // transforms, then dropped on the next write (downgrade-safe on read).
  assert.equal(db.nutritionGoal, undefined, "legacy nutritionGoal is dropped post-v14 (transformed)");
  // bodyProfile synthesized: sex/heightCm copied, DOB FABRICATED from age=35 via the frozen 2026 anchor.
  assert.ok(db.bodyProfile && typeof db.bodyProfile === "object", "bodyProfile synthesized from the legacy goal");
  assert.equal(db.bodyProfile?.sex, "male");
  assert.equal(db.bodyProfile?.heightCm, 180, "the BMR/BMI height input survives");
  assert.equal(db.bodyProfile?.dateOfBirth, "1991-01-01", "DOB fabricated clock-free: 2026 − 35 = 1991");
  assert.equal(db.bodyProfile?.trainingStatus, "novice", "no athlete level present → novice default");
  assert.equal(db.bodyProfile?.resistanceTrains, false, "no strength sports → resistanceTrains false");
  assert.equal(db.bodyProfile?.weightUnit, "kg", "the display-unit preference is re-homed onto bodyProfile");
  // bodyObjective synthesized: activity copied, target carried, the goal becomes FREE-TEXT prose.
  assert.ok(db.bodyObjective && typeof db.bodyObjective === "object", "bodyObjective synthesized from the legacy goal");
  assert.equal(db.bodyObjective?.activity, "moderate", "the TDEE activity multiplier is carried onto the objective");
  assert.equal(db.bodyObjective?.targetWeightKg, 80, "the target-weight anchor survives");
  assert.equal(db.bodyObjective?.targetDate, null);
  assert.match(db.bodyObjective?.goalText ?? "", /Lose weight/, "the legacy loss goal becomes free-text goalText");
});
