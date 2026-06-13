// Unit tests for the v8 → v9 migration that adds the Nutrition & Chef add-on data
// arrays (db.foodLogs / db.pantryItems / db.mealPlanEntries) and Settings.addons.
//
// Scope: the DISK read path (readDB → parseAndMigrate), which is where the new arrays
// are defaulted to [] for downstream code. Drives an ISOLATED throwaway COS_DATA_DIR
// (os.mkdtemp) exactly like the disk-path section of store.test.ts — the real
// board/data file is never read or written. Asserts:
//   • a v8 fixture (no nutrition arrays, no settings.addons) reads clean as v9 with the
//     three arrays defaulting to [] and the opaque settings carried through untouched;
//   • a v9 fixture (nutrition arrays populated, settings.addons present) round-trips —
//     readDB preserves the entries and the per-add-on enabled flag;
//   • a corrupt cases.json still recovers from a good v8 .bak (the fail-safe tenet).
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/nutrition-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import time.
// Point it at a throwaway dir BEFORE the dynamic import so DATA_FILE lands inside the
// sandbox (the real board/data is never touched). The cache-busting `?nutmig` query
// forces a fresh module instance whose DATA_DIR re-reads the env; the ts-resolve hook
// leaves the specifier alone (its pathname still ends in .ts → type-stripping applies).
const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-nut-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?nutmig");
const DATA_FILE = store.DATA_FILE as string;

// Seed cases.json (and clear any .bak) so each case starts clean.
async function seed(raw: string): Promise<void> {
  await fsp.mkdir(DISK_DIR, { recursive: true });
  await fsp.writeFile(DATA_FILE, raw, "utf8");
  await fsp.rm(`${DATA_FILE}.bak`, { force: true });
}

// A minimal v8 store: NO nutrition arrays, NO settings.addons. The events/reminders/
// priorities arrays exist (they predate v9); settings carries an unrelated flag.
const V8_FIXTURE = {
  schemaVersion: 8,
  version: 12,
  cases: [{ id: "CASE-1", title: "Pre-v9 case", status: "todo", domain: "work", tasks: [], messageIds: [] }],
  messages: [],
  events: [],
  reminders: [],
  priorities: [],
  settings: { autoSync: false, theme: "dark" },
};

test("migration: a v8 fixture (no nutrition arrays / no settings.addons) reads clean as v9 with arrays defaulting to []", async () => {
  await seed(JSON.stringify(V8_FIXTURE, null, 2));

  const db = await store.readDB();

  assert.equal(db.schemaVersion, SCHEMA_VERSION, "schemaVersion stamped to v9 on read");
  assert.equal(db.version, 12, "the monotonic version is preserved through migration");
  assert.deepEqual(db.foodLogs, [], "db.foodLogs defaults to []");
  assert.deepEqual(db.pantryItems, [], "db.pantryItems defaults to []");
  assert.deepEqual(db.mealPlanEntries, [], "db.mealPlanEntries defaults to []");
  // The old cases read unchanged; the opaque settings ride through untouched.
  assert.equal(db.cases.length, 1, "the pre-v9 case survives the migration");
  assert.equal(db.cases[0].id, "CASE-1");
  assert.equal(db.settings?.theme, "dark", "the unrelated settings flag is carried through");
  assert.equal(db.settings?.addons, undefined, "no settings.addons is invented on read");
});

test("migration: a v9 fixture round-trips — nutrition entries + settings.addons survive readDB", async () => {
  const v9 = {
    schemaVersion: SCHEMA_VERSION,
    version: 30,
    cases: [],
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
    pantryItems: [
      {
        id: "PANTRY-1",
        name: "Olive oil",
        createdAt: "2026-06-13T12:00:00.000Z",
        updatedAt: "2026-06-13T12:00:00.000Z",
      },
    ],
    mealPlanEntries: [
      {
        id: "MEAL-1",
        date: "2026-06-14",
        slot: "dinner",
        title: "Pasta night",
        status: "planned",
        createdAt: "2026-06-13T12:00:00.000Z",
        updatedAt: "2026-06-13T12:00:00.000Z",
      },
    ],
    settings: { autoSync: false, addons: { nutrition: { enabled: true, installedAt: "2026-06-13T11:00:00.000Z" } } },
  };
  await seed(JSON.stringify(v9, null, 2));

  const db = await store.readDB();

  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.version, 30, "version preserved on a v9 round-trip");
  assert.equal(db.foodLogs?.length, 1, "the food-log entry survives the round-trip");
  assert.equal(db.foodLogs?.[0]?.id, "FOOD-1");
  assert.equal(db.foodLogs?.[0]?.calories, 420);
  assert.equal(db.pantryItems?.length, 1, "the pantry item survives the round-trip");
  assert.equal(db.mealPlanEntries?.length, 1, "the meal-plan entry survives the round-trip");
  assert.equal(
    db.settings?.addons?.nutrition?.enabled,
    true,
    "the per-add-on enabled flag rides through db.settings untouched",
  );
  assert.equal(db.settings?.addons?.nutrition?.installedAt, "2026-06-13T11:00:00.000Z");
});

test("migration: a corrupt cases.json still recovers a v8 store from a good .bak (and defaults the v9 arrays)", async () => {
  await seed(JSON.stringify(V8_FIXTURE, null, 2));
  // Write a GOOD v8 .bak alongside, then corrupt the live file.
  await fsp.writeFile(`${DATA_FILE}.bak`, JSON.stringify(V8_FIXTURE, null, 2), "utf8");
  await fsp.writeFile(DATA_FILE, "{ this is not json", "utf8");

  const db = await store.readDB();

  assert.equal(db.version, 12, "recovered the previous good version from the v8 .bak");
  assert.equal(db.cases[0]?.id, "CASE-1", "recovered the .bak's case");
  assert.deepEqual(db.foodLogs, [], "the recovered store still defaults the v9 nutrition arrays to []");
  assert.deepEqual(db.pantryItems, []);
  assert.deepEqual(db.mealPlanEntries, []);
});
