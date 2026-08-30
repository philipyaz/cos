#!/usr/bin/env node
// api-nutrition-shelf-life.mjs — the v18 pantry LIFECYCLE + computed freshness-horizon contract.
//
// Plain Node (ESM), zero deps. Proves GET /api/nutrition/status's `pantryLifecycle` field end-to-end
// against a RUNNING board: the field is present and typed (works on an empty store); a routine sweep
// classifies fresh/staple/spice rows correctly from `category`+`location` alone; a fresh row aged past
// its class's shelf life (via STORE-FILE surgery — the API never lets a test set `updatedAt`, and the
// board re-reads the file per request, so surgery between requests is the only way to age a row) shows
// up in `likelyPastHorizon` with the right `horizonDays`, while a same-aged spice/staple never does
// (excluded at any age); and no write path ever PERSISTS a lifecycle/horizon field or an estimated
// `expiresAt` — the engine only ever computes this on read (ADR 0017), and `schemaVersion` proves it
// (this feature ships no migration). Synthetic fixture data only.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero). The horizon-firing
// and nothing-persisted checks additionally need FILE access to the store the running board reads from
// (to rewrite `updatedAt` and to inspect what actually got written) — exactly the class of thing
// api-schema-guard.mjs already does. Without `COS_BOARD_DATA` those checks SKIP rather than guess a path
// and touch the wrong (possibly live) store; run.sh always passes it, pointed at the throwaway sandbox.
//
// Requires a running board:
//   cd board && npm run dev
//   COS_BOARD_DATA=board/data/cases.json node tests/api-nutrition-shelf-life.mjs
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (the RUNNING board's cases.json — file-surgery steps
// SKIP if unset).
import { promises as fs } from "node:fs";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DATA_FILE = process.env.COS_BOARD_DATA || "";

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

// Local calendar-day helpers (mirror board/lib/nutrition-format.ts's toISODay/addDays — the test can't
// import app code, so the idiom is duplicated here, not the value).
const todayISODay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function addDaysToISODay(day, n) {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const KNOWN_PANTRY_KEYS = new Set([
  "id", "name", "quantity", "unit", "category", "location", "expiresAt", "lowStock", "note",
  "createdAt", "updatedAt",
]);

async function main() {
  console.log(`api-nutrition-shelf-life · board=${BASE}${DATA_FILE ? ` · store=${DATA_FILE}` : ""}`);
  const today = todayISODay();

  const snapshot = DATA_FILE ? await fs.readFile(DATA_FILE, "utf8") : null;

  try {
    // ----------------------------------------------------------------------
    // 1. Shape: pantryLifecycle present + typed. Works on the empty sandbox store. Record
    // the store file's schemaVersion now, for the "nothing persisted" check in step 5.
    // ----------------------------------------------------------------------
    const initial = await GET("/api/nutrition/status");
    check(initial.status === 200, `GET /api/nutrition/status → 200 (got ${initial.status})`);
    const s0 = initial.body;
    const lc0 = s0.pantryLifecycle;
    check(typeof lc0?.fresh?.count === "number", "pantryLifecycle.fresh.count is a number");
    check(Array.isArray(lc0?.fresh?.ids), "pantryLifecycle.fresh.ids is an array");
    check(typeof lc0?.likelyPastHorizon?.count === "number", "pantryLifecycle.likelyPastHorizon.count is a number");
    check(Array.isArray(lc0?.likelyPastHorizon?.items), "pantryLifecycle.likelyPastHorizon.items is an array");
    check(typeof lc0?.excluded?.spices === "number", "pantryLifecycle.excluded.spices is a number");
    check(typeof lc0?.excluded?.staples === "number", "pantryLifecycle.excluded.staples is a number");

    let initialSchemaVersion = null;
    let codeSchemaVersion = null;
    if (DATA_FILE) {
      initialSchemaVersion = JSON.parse(snapshot).schemaVersion;
      check(typeof initialSchemaVersion === "number", `store file has a numeric schemaVersion (got ${initialSchemaVersion})`);
      // The code's SCHEMA_VERSION, from /api/healthz. The sandbox store is the seeded fixture
      // (an OLDER schemaVersion by design — run.sh restores it before every net-zero step), so
      // the first write of this run stamps the code's version on disk: "unchanged" must be
      // asserted against the CODE's version, not the pre-write file, or the check reads the
      // migrate-on-read stamp as a migration this feature shipped.
      const hz = await GET("/api/healthz");
      codeSchemaVersion = hz.body?.schemaVersion;
      check(typeof codeSchemaVersion === "number", `healthz reports the code's schemaVersion (got ${codeSchemaVersion})`);
    } else {
      console.log("  SKIP: COS_BOARD_DATA not set — schemaVersion baseline / file-surgery checks below will skip.");
    }

    const pantryList = await GET("/api/nutrition/pantry");
    if ((pantryList.body.items ?? []).length === 0) {
      check(lc0.fresh.count === 0, "empty store: pantryLifecycle.fresh.count === 0");
      check(lc0.likelyPastHorizon.count === 0, "empty store: pantryLifecycle.likelyPastHorizon.count === 0");
      check(lc0.excluded.spices === 0, "empty store: pantryLifecycle.excluded.spices === 0");
      check(lc0.excluded.staples === 0, "empty store: pantryLifecycle.excluded.staples === 0");
    } else {
      console.log("  (store not empty — skipping the empty-store zeroes; every later check is relative)");
    }
    const baselineExpired = s0.expiredPantryItems.count;
    const baselineStale = s0.stalePlannedMeals.count;
    const baselinePastHorizon = lc0.likelyPastHorizon.count;

    // ----------------------------------------------------------------------
    // 2. All-quiet fixture: a clean surface yields zero actionable signals.
    // ----------------------------------------------------------------------
    const enableAddon = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enableAddon.status === 200, `PATCH enable nutrition add-on → 200 (got ${enableAddon.status})`);

    const quietProduce = await POST("/api/nutrition/pantry", {
      name: "Fixture quiet spinach",
      category: "produce",
      location: "fridge",
    });
    check(quietProduce.status === 201, `seed quiet produce×fridge item → 201 (got ${quietProduce.status})`);
    const fridgeProduceId = quietProduce.body.item?.id; // reused in step 4 — produce×fridge, horizon 7d

    const quietLog = await POST("/api/nutrition/log", {
      date: today,
      slot: "lunch",
      description: "Fixture quiet lunch",
      calories: 500,
    });
    check(quietLog.status === 201, `seed today's food log → 201 (got ${quietLog.status})`);

    const quietTargets = await POST("/api/nutrition/targets", {
      periodKey: today,
      payload: { daily_calories: 2000 },
    });
    check(
      quietTargets.status === 200 || quietTargets.status === 201,
      `seed today's nutrition targets → 200/201 (got ${quietTargets.status})`,
    );

    const afterQuiet = await GET("/api/nutrition/status");
    const sQuiet = afterQuiet.body;
    check(
      sQuiet.stalePlannedMeals.count === baselineStale,
      `all-quiet: stalePlannedMeals.count unchanged (no meal plan entries seeded) (baseline ${baselineStale}, got ${sQuiet.stalePlannedMeals.count})`,
    );
    check(
      sQuiet.pantryLifecycle.likelyPastHorizon.count === baselinePastHorizon,
      `all-quiet: likelyPastHorizon.count unchanged — a fresh item just written is not past its horizon (baseline ${baselinePastHorizon}, got ${sQuiet.pantryLifecycle.likelyPastHorizon.count})`,
    );
    check(
      sQuiet.expiredPantryItems.count === baselineExpired,
      `all-quiet: expiredPantryItems.count unchanged (baseline ${baselineExpired}, got ${sQuiet.expiredPantryItems.count})`,
    );
    check(sQuiet.daysSinceLastFoodLog === 0, `all-quiet: daysSinceLastFoodLog === 0 (got ${sQuiet.daysSinceLastFoodLog})`);
    check(sQuiet.hasNutritionTargets === true, "all-quiet: hasNutritionTargets is true after saving one for today");

    // ----------------------------------------------------------------------
    // 3. Scoping fixture: the fresh/staple/spice split, mirroring the live proportions.
    // Baseline is `sQuiet.pantryLifecycle` (right before these 4 items land), so the deltas
    // below are attributable ONLY to what this step seeds.
    // ----------------------------------------------------------------------
    const scopingBaseline = sQuiet.pantryLifecycle;

    const spice = await POST("/api/nutrition/pantry", {
      name: "Fixture paprika",
      category: "spice",
      location: "pantry",
    });
    check(spice.status === 201, `seed spice×pantry → 201 (got ${spice.status})`);
    const spiceId = spice.body.item?.id;

    const staple = await POST("/api/nutrition/pantry", {
      name: "Fixture tinned beans",
      category: "pantry",
      location: "pantry",
    });
    check(staple.status === 201, `seed pantry×pantry staple → 201 (got ${staple.status})`);
    const stapleId = staple.body.item?.id;

    const jar = await POST("/api/nutrition/pantry", {
      name: "Fixture opened sauce jar",
      category: "pantry",
      location: "fridge",
    });
    check(jar.status === 201, `seed pantry×fridge jar → 201 (got ${jar.status})`);
    const jarId = jar.body.item?.id;

    const noLocationProduce = await POST("/api/nutrition/pantry", {
      name: "Fixture onions",
      category: "produce",
    });
    check(noLocationProduce.status === 201, `seed produce with no location → 201 (got ${noLocationProduce.status})`);
    const noLocationProduceId = noLocationProduce.body.item?.id;

    const afterScoping = await GET("/api/nutrition/status");
    const lcScoping = afterScoping.body.pantryLifecycle;

    check(
      lcScoping.fresh.ids.includes(jarId) && lcScoping.fresh.ids.includes(noLocationProduceId),
      "scoping: fresh.ids contains the pantry×fridge jar AND the no-location produce item",
    );
    check(
      !lcScoping.fresh.ids.includes(spiceId) && !lcScoping.fresh.ids.includes(stapleId),
      "scoping: fresh.ids contains neither the spice nor the staple",
    );
    check(
      lcScoping.fresh.count === scopingBaseline.fresh.count + 2,
      `scoping: fresh.count is baseline+2 (the jar + the no-location produce) (baseline ${scopingBaseline.fresh.count}, got ${lcScoping.fresh.count})`,
    );
    check(
      lcScoping.excluded.spices === scopingBaseline.excluded.spices + 1,
      `scoping: excluded.spices is baseline+1 (baseline ${scopingBaseline.excluded.spices}, got ${lcScoping.excluded.spices})`,
    );
    check(
      lcScoping.excluded.staples === scopingBaseline.excluded.staples + 1,
      `scoping: excluded.staples is baseline+1 (baseline ${scopingBaseline.excluded.staples}, got ${lcScoping.excluded.staples})`,
    );
    const scopingDelta =
      (lcScoping.fresh.count - scopingBaseline.fresh.count) +
      (lcScoping.excluded.spices - scopingBaseline.excluded.spices) +
      (lcScoping.excluded.staples - scopingBaseline.excluded.staples);
    check(scopingDelta === 4, `scoping: fresh + spices + staples deltas account for all 4 seeded items (got ${scopingDelta})`);

    // ----------------------------------------------------------------------
    // 4. The horizon fires — needs FILE access to age rows between requests.
    // ----------------------------------------------------------------------
    if (DATA_FILE) {
      const agedDay = addDaysToISODay(today, -30);
      const agedISO = `${agedDay}T09:00:00.000Z`;

      const raw = await fs.readFile(DATA_FILE, "utf8");
      const store = JSON.parse(raw);
      let aged = 0;
      for (const item of store.pantryItems ?? []) {
        if (item.id === fridgeProduceId || item.id === spiceId || item.id === stapleId) {
          item.updatedAt = agedISO;
          aged++;
        }
      }
      check(aged === 3, `store-file surgery: aged exactly 3 rows (produce×fridge + spice + staple), got ${aged}`);
      await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");

      const afterAging = await GET("/api/nutrition/status");
      const lcAged = afterAging.body.pantryLifecycle;
      const firedProduce = lcAged.likelyPastHorizon.items.find((i) => i.id === fridgeProduceId);
      check(!!firedProduce, "horizon fires: the aged produce×fridge item appears in likelyPastHorizon");
      check(firedProduce?.ageDays === 30, `horizon fires: ageDays === 30 (got ${firedProduce?.ageDays})`);
      check(
        firedProduce?.horizonDays === 7,
        `horizon fires: horizonDays === 7 — the produce×fridge class (got ${firedProduce?.horizonDays})`,
      );
      check(
        !lcAged.likelyPastHorizon.items.some((i) => i.id === spiceId),
        "horizon fires: the same-aged spice does NOT appear (excluded at any age)",
      );
      check(
        !lcAged.likelyPastHorizon.items.some((i) => i.id === stapleId),
        "horizon fires: the same-aged staple does NOT appear (no horizon for staples)",
      );
    } else {
      console.log("  SKIP: horizon-firing check needs COS_BOARD_DATA (store-file surgery) — not set.");
    }

    // ----------------------------------------------------------------------
    // 5. Nothing persisted: reconcile writes no estimate, and no computed field leaks to storage.
    // ----------------------------------------------------------------------
    const reconcile = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture reconciled item", category: "produce", location: "fridge" }],
    });
    check(reconcile.status === 200, `POST pantry/reconcile (no expiresAt) → 200 (got ${reconcile.status})`);
    const reconciledId = reconcile.body.added?.[0]?.id;

    if (DATA_FILE) {
      const rawAfter = await fs.readFile(DATA_FILE, "utf8");
      const storeAfter = JSON.parse(rawAfter);

      const reconciledItem = (storeAfter.pantryItems ?? []).find((p) => p.id === reconciledId);
      check(
        !!reconciledItem && !("expiresAt" in reconciledItem),
        `reconciled item ${reconciledId} carries no expiresAt (none was given, none was guessed)`,
      );
      for (const id of [fridgeProduceId, spiceId, stapleId, jarId, noLocationProduceId]) {
        const it = (storeAfter.pantryItems ?? []).find((p) => p.id === id);
        check(!!it && !("expiresAt" in it), `seeded item ${id} still carries no expiresAt it wasn't given`);
      }

      let allClean = true;
      for (const item of storeAfter.pantryItems ?? []) {
        if (Object.keys(item).some((k) => !KNOWN_PANTRY_KEYS.has(k))) allClean = false;
      }
      check(allClean, "no pantry item anywhere carries a computed lifecycle/horizon/freshness key");

      check(
        storeAfter.schemaVersion === codeSchemaVersion,
        `store schemaVersion is the code's SCHEMA_VERSION (seed ${initialSchemaVersion} → ${storeAfter.schemaVersion}, code ${codeSchemaVersion}) — this feature ships no migration of its own`,
      );
    } else {
      console.log("  SKIP: nothing-persisted file checks need COS_BOARD_DATA — not set.");
    }
  } finally {
    if (DATA_FILE && snapshot != null) {
      await fs.writeFile(DATA_FILE, snapshot, "utf8");
      console.log("  ↩ restored the store to its pre-test state");
    }
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — pantryLifecycle scopes fresh/staple/spice correctly and the computed horizon is never persisted.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
