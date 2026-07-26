#!/usr/bin/env node
// api-nutrition-status.mjs — the v14 nutrition RECONCILIATION status contract.
//
// Plain Node (ESM), zero deps. Proves GET /api/nutrition/status end-to-end against a RUNNING
// board: all seven fields are present and typed; an empty store returns zeroes/nulls/false
// (asserted only after observing the store is actually empty — trap: this test can also run
// standalone against a dev board that already has data, so every other assertion is RELATIVE);
// a past-dated `planned` meal-plan entry with a same-date/same-slot food log naming its MEAL-<n>
// id is counted in `provablyCooked` and NOT double-counted; a decoy log at the same date+slot
// naming the WRONG meal id does not prove that meal; a future-dated `planned` entry is counted in
// neither `stalePlannedMeals` nor `provablyCooked`; an expired pantry item is surfaced; a fresh
// nutrition-targets save flips `hasNutritionTargets`; and the read stays 200 with the add-on
// DISABLED (ungated). Synthetic fixture data only.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero — the meal
// plan / food log / pantry / nutritionTargets / settings.addons all live in cases.json).
// Requires a running board:
//   cd board && npm run dev
//   node tests/api-nutrition-status.mjs    # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};

const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

async function main() {
  console.log(`api-nutrition-status · board=${BASE}`);

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // 1. The route resolves, with all seven fields present and typed.
    // ----------------------------------------------------------------------
    const initial = await GET("/api/nutrition/status");
    check(initial.status === 200, `GET /api/nutrition/status → 200 (got ${initial.status})`);
    const s0 = initial.body;

    check(typeof s0.stalePlannedMeals?.count === "number", "stalePlannedMeals.count is a number");
    check("oldestDate" in (s0.stalePlannedMeals ?? {}), "stalePlannedMeals.oldestDate present");
    check("oldestAgeDays" in (s0.stalePlannedMeals ?? {}), "stalePlannedMeals.oldestAgeDays present");
    check(Array.isArray(s0.stalePlannedMeals?.ids), "stalePlannedMeals.ids is an array");
    check(typeof s0.provablyCooked?.count === "number", "provablyCooked.count is a number");
    check(Array.isArray(s0.provablyCooked?.matches), "provablyCooked.matches is an array");
    check("daysSinceLastFoodLog" in s0, "daysSinceLastFoodLog present");
    check("daysSinceLastPantryWrite" in s0, "daysSinceLastPantryWrite present");
    check(typeof s0.expiredPantryItems?.count === "number", "expiredPantryItems.count is a number");
    check(Array.isArray(s0.expiredPantryItems?.ids), "expiredPantryItems.ids is an array");
    check(typeof s0.hasNutritionTargets === "boolean", "hasNutritionTargets is a boolean");
    check("daysSinceLastTargets" in s0, "daysSinceLastTargets present");
    check(typeof s0.version === "number", "version is present");

    // ----------------------------------------------------------------------
    // 2. Empty-store zeroes — asserted ONLY after observing the three lists are
    // actually empty (always true in the CI sandbox; NOT assumed on a standalone
    // run against a dev board that already has data — trap 6).
    // ----------------------------------------------------------------------
    const [logList, pantryList, planList] = await Promise.all([
      GET("/api/nutrition/log"),
      GET("/api/nutrition/pantry"),
      GET("/api/nutrition/plan"),
    ]);
    const storeEmpty =
      (logList.body.entries ?? []).length === 0 &&
      (pantryList.body.items ?? []).length === 0 &&
      (planList.body.entries ?? []).length === 0;

    if (storeEmpty) {
      check(s0.stalePlannedMeals.count === 0, "empty store: stalePlannedMeals.count === 0");
      check(s0.stalePlannedMeals.oldestDate === null, "empty store: oldestDate === null");
      check(s0.stalePlannedMeals.oldestAgeDays === null, "empty store: oldestAgeDays === null");
      check(s0.provablyCooked.count === 0, "empty store: provablyCooked.count === 0");
      check(s0.daysSinceLastFoodLog === null, "empty store: daysSinceLastFoodLog === null");
      check(s0.daysSinceLastPantryWrite === null, "empty store: daysSinceLastPantryWrite === null");
      check(s0.expiredPantryItems.count === 0, "empty store: expiredPantryItems.count === 0");
      check(s0.hasNutritionTargets === false, "empty store: hasNutritionTargets === false");
      check(s0.daysSinceLastTargets === null, "empty store: daysSinceLastTargets === null");
    } else {
      console.log("  (store not empty — skipping the zeroes assertions; every later check is relative)");
    }
    const baseStaleCount = s0.stalePlannedMeals.count;

    // ----------------------------------------------------------------------
    // 3. Enable the add-on and seed synthetic fixtures via the API.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH enable → 200 (got ${enable.status})`);

    const mealA = await POST("/api/nutrition/plan", {
      date: "2020-01-02",
      slot: "dinner",
      title: "Fixture meal A",
    });
    check(mealA.status === 201, `seed meal A → 201 (got ${mealA.status})`);
    const mealAId = mealA.body.entry?.id;

    const logA = await POST("/api/nutrition/log", {
      date: "2020-01-02",
      slot: "dinner",
      description: `${mealAId} — fixture meal A eaten`,
      calories: 500,
    });
    check(logA.status === 201, `seed food log naming meal A → 201 (got ${logA.status})`);
    const logAId = logA.body.entry?.id;

    const mealB = await POST("/api/nutrition/plan", {
      date: "2020-01-03",
      slot: "lunch",
      title: "Fixture meal B",
    });
    check(mealB.status === 201, `seed meal B → 201 (got ${mealB.status})`);
    const mealBId = mealB.body.entry?.id;

    // Decoy: right date+slot for meal B, but names meal A — wrong-id must not prove B,
    // and (being a different date+slot from A) must not double-prove A either.
    const decoy = await POST("/api/nutrition/log", {
      date: "2020-01-03",
      slot: "lunch",
      description: `${mealAId} — decoy naming the wrong meal`,
      calories: 400,
    });
    check(decoy.status === 201, `seed decoy food log → 201 (got ${decoy.status})`);

    const mealC = await POST("/api/nutrition/plan", {
      date: "2099-01-01",
      slot: "dinner",
      title: "Fixture meal C",
    });
    check(mealC.status === 201, `seed future meal C → 201 (got ${mealC.status})`);
    const mealCId = mealC.body.entry?.id;

    const pantry = await POST("/api/nutrition/pantry", {
      name: "Fixture pickles",
      expiresAt: "2020-01-01",
    });
    check(pantry.status === 201, `seed expired pantry item → 201 (got ${pantry.status})`);
    const pantryId = pantry.body.item?.id;

    const targets = await POST("/api/nutrition/targets", {
      periodKey: "2020-01-05",
      payload: { daily_calories: 2000 },
    });
    check(
      targets.status === 200 || targets.status === 201,
      `seed nutrition targets → 200/201 (got ${targets.status})`,
    );

    // ----------------------------------------------------------------------
    // 4. Assert against a fresh read.
    // ----------------------------------------------------------------------
    const after = await GET("/api/nutrition/status");
    check(after.status === 200, `GET /api/nutrition/status (after seed) → 200 (got ${after.status})`);
    const s1 = after.body;

    check(
      s1.stalePlannedMeals.count === baseStaleCount + 2,
      `stalePlannedMeals.count is baseline+2 (baseline ${baseStaleCount}, got ${s1.stalePlannedMeals.count})`,
    );
    check(
      s1.stalePlannedMeals.ids.includes(mealAId) && s1.stalePlannedMeals.ids.includes(mealBId),
      "stalePlannedMeals.ids contains meal A and meal B",
    );
    check(!s1.stalePlannedMeals.ids.includes(mealCId), "stalePlannedMeals.ids does NOT contain the future meal C");

    const provenA = s1.provablyCooked.matches.filter((m) => m.mealId === mealAId);
    check(provenA.length === 1, `provablyCooked has exactly ONE row for meal A (got ${provenA.length})`);
    check(provenA[0]?.foodLogId === logAId, "the provable match for meal A pairs the seeded FOOD id");
    check(
      !s1.provablyCooked.matches.some((m) => m.mealId === mealBId),
      "NO row for meal B (the decoy names the wrong id)",
    );

    if (storeEmpty) {
      check(
        s1.daysSinceLastFoodLog > 1000,
        `daysSinceLastFoodLog > 1000 on the empty-store path (got ${s1.daysSinceLastFoodLog})`,
      );
      check(
        s1.daysSinceLastTargets > 1000,
        `daysSinceLastTargets > 1000 on the empty-store path (got ${s1.daysSinceLastTargets})`,
      );
    } else {
      check(s1.daysSinceLastFoodLog >= 0, `daysSinceLastFoodLog >= 0 (got ${s1.daysSinceLastFoodLog})`);
      check(s1.daysSinceLastTargets >= 0, `daysSinceLastTargets >= 0 (got ${s1.daysSinceLastTargets})`);
    }

    check(s1.expiredPantryItems.ids.includes(pantryId), "expiredPantryItems.ids contains the fixture pantry id");
    check(
      s1.daysSinceLastPantryWrite === 0,
      `daysSinceLastPantryWrite === 0 just after writing it (got ${s1.daysSinceLastPantryWrite})`,
    );

    check(s1.hasNutritionTargets === true, "hasNutritionTargets is true after saving one");

    // ----------------------------------------------------------------------
    // 5. Disable the add-on → the read stays 200 (ungated).
    // ----------------------------------------------------------------------
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);

    const afterDisable = await GET("/api/nutrition/status");
    check(
      afterDisable.status === 200,
      `GET /api/nutrition/status while disabled → 200 (got ${afterDisable.status}) — ungated read`,
    );
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — /api/nutrition/status computes stale/provable meals, recency, and expiry correctly.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
