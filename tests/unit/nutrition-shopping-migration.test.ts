// Unit tests for the v15 → v16 migration that adds the persistent shopping list:
// db.shoppingItems (ShoppingItem[]) — cos-ops#37. v16 is PURELY ADDITIVE — an old v15 file
// reads unchanged, with NO shoppingItems key synthesized (no backfill, no synthesis: unlike
// v14's nutritionGoal→bodyProfile/bodyObjective transform, this migration is a bare carry-
// forward, exactly like db.pantryItems). Also covers the store-helper half of the AC:
// applyShoppingItemUpdate's boughtAt stamping rule (flip to "bought" stamps it; any other
// valid status — or an update that never touches status — leaves it cleared/untouched).
//
// Scope: migrate() called DIRECTLY (a pure function — no disk I/O), plus
// applyShoppingItemUpdate called directly on an in-memory record. Neither touches
// board/data/cases.json; COS_DATA_DIR still points at a throwaway dir before import, matching
// the sibling migration tests' safety discipline even though this file never reads/writes it.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/nutrition-shopping-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import time. migrate()
// and applyShoppingItemUpdate are pure (no disk I/O either way), but point DATA_DIR at a
// throwaway dir anyway, matching the sibling migration tests — the real board/data is never at
// risk. The cache-busting `?shopmig` query forces a fresh module instance; the ts-resolve hook
// leaves the specifier alone (its pathname still ends in .ts → type-stripping applies).
const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-nut-shop-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?shopmig");

// A v15 store WITH the pre-v16 nutrition state but WITHOUT db.shoppingItems — the realistic
// "old file" a v16 binary reads.
const V15_FIXTURE = {
  schemaVersion: 15,
  version: 3175,
  cases: [{ id: "CASE-1", title: "Pre-v16 case", status: "todo", domain: "work", tasks: [], messageIds: [] }],
  messages: [],
  events: [],
  reminders: [],
  priorities: [],
  foodLogs: [],
  pantryItems: [
    {
      id: "PANTRY-1",
      name: "Olive oil",
      category: "pantry",
      createdAt: "2026-08-01T07:00:00.000Z",
      updatedAt: "2026-08-01T07:00:00.000Z",
    },
  ],
  mealPlanEntries: [],
  nutritionTargets: [],
  settings: { autoSync: false, addons: { nutrition: { enabled: true, installedAt: "2026-06-13T11:00:00.000Z" } } },
};

test("migrate(): a v15 object without shoppingItems reads clean as v16 — NO key synthesized (no backfill)", () => {
  const db = store.migrate(V15_FIXTURE);

  assert.equal(db.schemaVersion, SCHEMA_VERSION, "schemaVersion stamped to v16");
  assert.equal(db.version, 3175, "the monotonic version is preserved through migration");
  assert.equal(db.shoppingItems, undefined, "no shoppingItems key is synthesized — absent stays absent");
  // The pre-existing v15 state rides through untouched (the additive guarantee).
  assert.equal(db.pantryItems?.length, 1, "the v15 pantry row survives the v16 read");
  assert.equal(db.pantryItems?.[0]?.id, "PANTRY-1");
  assert.equal(db.settings?.addons?.nutrition?.enabled, true, "settings.addons rides through untouched");
  assert.equal(db.cases[0]?.id, "CASE-1", "the pre-v16 case survives");
});

test("migrate(): an object WITH shoppingItems carries the array forward verbatim", () => {
  const withRows = {
    ...V15_FIXTURE,
    shoppingItems: [
      {
        id: "SHOP-1",
        name: "AA batteries",
        category: "household",
        status: "needed",
        source: "manual",
        createdAt: "2026-08-06T09:00:00.000Z",
        updatedAt: "2026-08-06T09:00:00.000Z",
      },
      {
        id: "SHOP-2",
        name: "Milk",
        category: "dairy",
        status: "bought",
        source: "plan",
        sourceRef: "MEAL-12",
        boughtAt: "2026-08-05T18:00:00.000Z",
        createdAt: "2026-08-04T09:00:00.000Z",
        updatedAt: "2026-08-05T18:00:00.000Z",
      },
    ],
  };

  const db = store.migrate(withRows);

  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.shoppingItems?.length, 2, "both shopping rows survive the migration");
  assert.equal(db.shoppingItems?.[0]?.id, "SHOP-1");
  assert.equal(db.shoppingItems?.[0]?.category, "household", "the non-food category rides through");
  assert.equal(db.shoppingItems?.[1]?.id, "SHOP-2");
  assert.equal(db.shoppingItems?.[1]?.status, "bought");
  assert.equal(
    db.shoppingItems?.[1]?.boughtAt,
    "2026-08-05T18:00:00.000Z",
    "a pre-set boughtAt rides through verbatim — migrate() never stamps",
  );
  assert.equal(db.shoppingItems?.[1]?.sourceRef, "MEAL-12", "the soft sourceRef rides through");
});

test("applyShoppingItemUpdate: flipping status to 'bought' stamps boughtAt; any other valid status clears it", () => {
  const rec = {
    id: "SHOP-9",
    name: "Flour",
    status: "needed" as const,
    source: "manual" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  store.applyShoppingItemUpdate(rec, { status: "bought" });
  assert.equal(rec.status, "bought");
  assert.equal(typeof rec.boughtAt, "string", "boughtAt is stamped (server-side) when status flips to bought");
  assert.ok(rec.boughtAt && !Number.isNaN(Date.parse(rec.boughtAt)), "boughtAt is a valid ISO timestamp");

  store.applyShoppingItemUpdate(rec, { status: "needed" });
  assert.equal(rec.status, "needed");
  assert.equal(rec.boughtAt, undefined, "boughtAt clears when status flips away from bought");

  // Re-bought, then dismissed — dismissed also clears boughtAt.
  store.applyShoppingItemUpdate(rec, { status: "bought" });
  assert.equal(typeof rec.boughtAt, "string");
  store.applyShoppingItemUpdate(rec, { status: "dismissed" });
  assert.equal(rec.status, "dismissed");
  assert.equal(rec.boughtAt, undefined, "boughtAt also clears on dismissed");

  // An idempotent retry (a timed-out bridge call re-sent, a double tap) must not move the
  // purchase date forward: "bought" → "bought" keeps the original stamp.
  store.applyShoppingItemUpdate(rec, { status: "bought" });
  const firstStamp = rec.boughtAt;
  store.applyShoppingItemUpdate(rec, { status: "bought" });
  assert.equal(rec.boughtAt, firstStamp, "re-sending status:'bought' keeps the original boughtAt");
  store.applyShoppingItemUpdate(rec, { status: "needed" });

  // boughtAt is server-stamped ONLY — a patch trying to set it directly is ignored (an update
  // that never touches `status` leaves the existing boughtAt exactly as it was).
  store.applyShoppingItemUpdate(rec, { boughtAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(rec.boughtAt, undefined, "a patch cannot set boughtAt directly — it stays unset outside a status flip");
});
