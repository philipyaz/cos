// Unit tests for board/lib/nutrition-format.ts's groupShoppingByCategory — the shopping-list
// UI's pure category-grouping helper (cos-ops#38). Mirrors pantry-view.tsx's local
// groupByCategory, generalised to ShoppingItem + VALID_SHOPPING_CATEGORY, but lives in a lib
// module (not the .tsx) specifically so this file can import it under the type-stripping
// `node --test` runner. Display LABELS are a component concern and are NOT tested here — only
// the bucket keys, the fixed aisle order, the uncategorized-last rule, per-group counts, and the
// case-insensitive name sort within a group. Synthetic fixture names only.
//
// Run from the repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/shopping-grouping.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { groupShoppingByCategory } from "../../board/lib/nutrition-format.ts";
import type { ShoppingItem } from "../../board/lib/types.ts";

const item = (over: Partial<ShoppingItem>): ShoppingItem => ({
  id: "SHOP-1",
  name: "x",
  status: "needed",
  source: "manual",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

test("groupShoppingByCategory", async (t) => {
  await t.test("empty input → []", () => {
    assert.deepStrictEqual(groupShoppingByCategory([]), []);
  });

  await t.test("group keys come out in VALID_SHOPPING_CATEGORY order, filtered to non-empty", () => {
    const items = [
      item({ id: "SHOP-1", name: "Bananas", category: "produce" }),
      item({ id: "SHOP-2", name: "AA batteries", category: "household" }), // non-food, deliberate
      item({ id: "SHOP-3", name: "Toothpaste", category: "personal-care" }),
    ];
    const groups = groupShoppingByCategory(items);
    // produce < household < personal-care in VALID_SHOPPING_CATEGORY order; the categories no
    // item held (protein/dairy/bakery/frozen/pantry/other) never appear — filtered to non-empty,
    // not the full 9-category spread.
    assert.deepStrictEqual(groups.map((g) => g.key), ["produce", "household", "personal-care"]);
  });

  await t.test("uncategorized (no category at all) sorts LAST, after every real category", () => {
    const items = [
      item({ id: "SHOP-1", name: "Mystery item" }), // category left unset, deliberately
      item({ id: "SHOP-2", name: "AA batteries", category: "household" }),
      item({ id: "SHOP-3", name: "Bananas", category: "produce" }),
    ];
    const groups = groupShoppingByCategory(items);
    assert.deepStrictEqual(groups.map((g) => g.key), ["produce", "household", "uncategorized"]);
    assert.equal(groups.at(-1)?.key, "uncategorized");
  });

  await t.test("per-group item counts are exact when several items share a category", () => {
    const items = [
      item({ id: "SHOP-1", name: "Bananas", category: "produce" }),
      item({ id: "SHOP-2", name: "Apples", category: "produce" }),
      item({ id: "SHOP-3", name: "Carrots", category: "produce" }),
      item({ id: "SHOP-4", name: "AA batteries", category: "household" }),
    ];
    const groups = groupShoppingByCategory(items);
    const produce = groups.find((g) => g.key === "produce");
    const household = groups.find((g) => g.key === "household");
    assert.equal(produce?.items.length, 3);
    assert.equal(household?.items.length, 1);
  });

  await t.test("names sort case-insensitively within a group", () => {
    const items = [
      item({ id: "SHOP-1", name: "zucchini", category: "produce" }),
      item({ id: "SHOP-2", name: "Apples", category: "produce" }),
      item({ id: "SHOP-3", name: "banana", category: "produce" }),
    ];
    const groups = groupShoppingByCategory(items);
    const produce = groups.find((g) => g.key === "produce");
    assert.deepStrictEqual(
      produce?.items.map((i) => i.name),
      ["Apples", "banana", "zucchini"],
    );
  });
});
