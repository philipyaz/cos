#!/usr/bin/env node
// api-nutrition-weight.mjs — end-to-end lifecycle test of the v10 Nutrition weight-loss API:
// the weigh-in series (/api/nutrition/weight), the goal singleton (/api/nutrition/goal), and
// the derived targets envelope (/api/nutrition/targets).
//
// Plain Node (ESM), zero deps. Drives the mutation paths against a RUNNING board and asserts
// the v10 contract end-to-end, using OUR field names (WeightEntry / NutritionGoal /
// NutritionTargets in board/lib/types.ts + board/lib/nutrition-targets.ts):
//   • ENABLE the add-on first (PATCH /api/addons/nutrition { enabled:true }) so the gated
//     writes are accepted (the gate is also exercised at the end, below);
//   • log_weight (POST /weight)   → 201; id matches WEIGHT-<n>; db.version increments;
//                                   weightKg + note persist;
//   • UPSERT BY DAY                → a SECOND POST for the SAME date is an UPDATE: 200,
//                                   created:false, the SAME id, the new weightKg/note;
//   • lb → kg at the boundary      → a weightLb-only POST stores canonical kg
//                                   (weightLb × 0.45359237);
//   • list /api/nutrition/weight   → 200, weights is an array (ASC by date) carrying the id,
//                                   one entry per upserted day; the from/to window narrows;
//   • GET /weight/:id              → 200 with the entry;
//   • PATCH (x-actor:agent)        → 200, persisted on a re-GET, version bumps;
//   • goal: PUT then GET           → upsert the singleton; GET returns it;
//   • targets: GET /targets        → a CONFIGURED envelope (goal + a weigh-in) with a numeric
//                                   dailyCalorieTarget + P/F/C macros + the always-on
//                                   not-medical-advice flag;
//   • validation                   → missing date, neither weightKg nor weightLb, bad goal
//                                   (bad sex/activity, non-positive numerics) all 400;
//   • GATE                         → with the add-on DISABLED a POST /weight + PUT /goal → 404
//                                   while GET /weight + GET /goal + GET /targets stay 200;
//   • DELETE                       → 200; the id no longer appears in GET (404 on re-GET).
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live board
// is left EXACTLY as found (net-zero) — db.weights + db.nutritionGoal + settings.addons live
// in cases.json. Requires a running board:
//   cd board && npm run dev            # or npm run start
//   node tests/api-nutrition-weight.mjs   # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

// --- tiny check harness ------------------------------------------------------
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- fetch helpers -----------------------------------------------------------
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
const POST = (p, b, h) => api("POST", p, b, h);
const PUT = (p, b, h) => api("PUT", p, b, h);
const PATCH = (p, b, h) => api("PATCH", p, b, h);
const DELETE = (p) => api("DELETE", p);

const listWeights = async () => (await GET("/api/nutrition/weight")).body.weights || [];
const weightIds = (weights) => new Set(weights.map((w) => w.id));

const WEIGHT_ID_RE = /^WEIGHT-\d+$/;
const LB_TO_KG = 0.45359237; // the canonical pound→kilogram factor (mirrors the route boundary)

async function main() {
  console.log(`api-nutrition-weight · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.weights + db.nutritionGoal +
  // settings.addons live in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // ENABLE the add-on so the gated writes are accepted.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH /api/addons/nutrition { enabled:true } → 200 (got ${enable.status})`);
    check(enable.body.addon?.enabled === true, "the add-on reports enabled:true");

    // ----------------------------------------------------------------------
    // log_weight (POST) → 201, WEIGHT-<n> id, version increments, fields persist
    // NB: the weigh-in dates below are deliberately HISTORICAL (2019-03-xx) so the
    // "new day → 201 created" assertions can't collide with a real weigh-in the live
    // board may already hold for today (the upsert-by-day would otherwise return 200).
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/nutrition/weight")).body.version;
    check(typeof v0 === "number", `GET /api/nutrition/weight returns a numeric version (${v0})`);

    const created = await POST("/api/nutrition/weight", {
      date: "2019-03-10",
      weightKg: 90,
      note: "morning",
    });
    check(created.status === 201, `POST /api/nutrition/weight (new day) → 201 (got ${created.status})`);
    const entry = created.body.entry;
    check(!!entry?.id, `create returned an entry id (${entry?.id})`);
    check(WEIGHT_ID_RE.test(entry?.id || ""), `entry id matches WEIGHT-<n> (${entry?.id})`);
    check(entry?.date === "2019-03-10", "created entry persisted date");
    check(entry?.weightKg === 90, "created entry persisted weightKg");
    check(entry?.note === "morning", "created entry persisted note");
    check(created.body.created === true, "create response reports created:true");
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    const weightId = entry.id;

    // ----------------------------------------------------------------------
    // UPSERT BY DAY: a SECOND POST for the SAME date UPDATES (200, created:false, same id)
    // ----------------------------------------------------------------------
    const vBeforeUpsert = (await GET("/api/nutrition/weight")).body.version;
    const upsert = await POST("/api/nutrition/weight", {
      date: "2019-03-10",
      weightKg: 89.4,
      note: "re-weighed",
    });
    check(upsert.status === 200, `POST same date again → 200 update (got ${upsert.status})`);
    check(upsert.body.created === false, "the re-POST reports created:false (an update, not an insert)");
    check(upsert.body.entry?.id === weightId, "the upsert kept the SAME WEIGHT id (one point per day)");
    check(upsert.body.entry?.weightKg === 89.4, "the upsert applied the new weightKg");
    check(upsert.body.entry?.note === "re-weighed", "the upsert applied the new note");
    check(
      typeof upsert.body.version === "number" && upsert.body.version > vBeforeUpsert,
      `the upsert bumped the version (${vBeforeUpsert} → ${upsert.body.version})`,
    );

    // The list now carries exactly ONE entry for that day (the upsert did not append).
    const afterUpsert = await listWeights();
    const sameDay = afterUpsert.filter((w) => w.date === "2019-03-10");
    check(sameDay.length === 1, "exactly one weigh-in exists for the upserted day");
    check(sameDay[0]?.weightKg === 89.4, "…carrying the upserted weightKg");

    // ----------------------------------------------------------------------
    // lb → kg at the boundary: a weightLb-only POST stores canonical kilograms
    // ----------------------------------------------------------------------
    const lbCreated = await POST("/api/nutrition/weight", { date: "2019-03-14", weightLb: 200 });
    check(lbCreated.status === 201, `POST weightLb-only (new day) → 201 (got ${lbCreated.status})`);
    const expectedKg = 200 * LB_TO_KG;
    check(
      Math.abs((lbCreated.body.entry?.weightKg ?? 0) - expectedKg) < 1e-6,
      `weightLb:200 stored as canonical kg (≈${expectedKg.toFixed(4)}, got ${lbCreated.body.entry?.weightKg})`,
    );
    const lbWeightId = lbCreated.body.entry?.id;

    // ----------------------------------------------------------------------
    // GET /api/nutrition/weight → array (ASC by date) containing the ids; window narrows
    // ----------------------------------------------------------------------
    const listed = await GET("/api/nutrition/weight");
    check(listed.status === 200, `GET /api/nutrition/weight → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.weights), "GET returns a weights array");
    check(weightIds(listed.body.weights).has(weightId), "the created entry is in the list");
    // ASC by date: the 06-10 entry sorts before the 06-14 entry.
    const dates = listed.body.weights.map((w) => w.date);
    const i10 = dates.indexOf("2019-03-10");
    const i14 = dates.indexOf("2019-03-14");
    check(i10 !== -1 && i14 !== -1 && i10 < i14, "the list is sorted ASC by date");

    const inWindow = await GET("/api/nutrition/weight?from=2019-03-01&to=2019-03-12");
    check(
      weightIds(inWindow.body.weights || []).has(weightId),
      "from/to window [2019-03-01, 2019-03-12) includes the 2019-03-10 entry",
    );
    check(
      !weightIds(inWindow.body.weights || []).has(lbWeightId),
      "from/to window [2019-03-01, 2019-03-12) EXCLUDES the 2019-03-14 entry",
    );
    const tightWindow = await GET("/api/nutrition/weight?from=2019-03-01&to=2019-03-10");
    check(
      !weightIds(tightWindow.body.weights || []).has(weightId),
      "from/to is half-open: to=2019-03-10 EXCLUDES the 2019-03-10 entry",
    );

    // GET by id
    const got = await GET(`/api/nutrition/weight/${encodeURIComponent(weightId)}`);
    check(got.status === 200, `GET /api/nutrition/weight/:id → 200 (got ${got.status})`);
    check(got.body.entry?.id === weightId, "GET by id returns the right entry");

    // ----------------------------------------------------------------------
    // PATCH → 200, persisted on a re-GET, version bumps; agent attribution round-trips
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/nutrition/weight")).body.version;
    const patched = await PATCH(
      `/api/nutrition/weight/${encodeURIComponent(weightId)}`,
      { weightKg: 89.1, note: "after coffee" },
      { "x-actor": "agent" }, // an MCP/agent-attributed write
    );
    check(patched.status === 200, `PATCH /api/nutrition/weight/:id (x-actor:agent) → 200 (got ${patched.status})`);
    check(patched.body.entry?.weightKg === 89.1, "PATCH reflects the new weightKg");
    check(patched.body.entry?.note === "after coffee", "PATCH reflects the new note");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/nutrition/weight/${encodeURIComponent(weightId)}`)).body.entry;
    check(reread?.weightKg === 89.1, "re-GET shows the persisted weightKg");

    // ----------------------------------------------------------------------
    // goal: PUT (upsert the singleton) then GET
    // ----------------------------------------------------------------------
    const goalPut = await PUT("/api/nutrition/goal", {
      sex: "male",
      age: 35,
      heightCm: 180,
      activity: "moderate",
      targetWeightKg: 80,
      rateKgPerWeek: 0.5,
      weightUnit: "kg",
    });
    check(goalPut.status === 200, `PUT /api/nutrition/goal → 200 (got ${goalPut.status})`);
    check(goalPut.body.goal?.sex === "male", "PUT goal persisted sex");
    check(goalPut.body.goal?.heightCm === 180, "PUT goal persisted heightCm");
    check(goalPut.body.goal?.targetWeightKg === 80, "PUT goal persisted targetWeightKg");
    check(goalPut.body.goal?.rateKgPerWeek === 0.5, "PUT goal persisted rateKgPerWeek");

    const goalGet = await GET("/api/nutrition/goal");
    check(goalGet.status === 200, `GET /api/nutrition/goal → 200 (got ${goalGet.status})`);
    check(goalGet.body.goal?.activity === "moderate", "GET goal returns the persisted singleton");

    // ----------------------------------------------------------------------
    // targets: GET /targets → a CONFIGURED envelope with a numeric target + macros + flag
    // ----------------------------------------------------------------------
    const targets = await GET("/api/nutrition/targets");
    check(targets.status === 200, `GET /api/nutrition/targets → 200 (got ${targets.status})`);
    const env = targets.body.targets;
    check(!!env, "targets returns an envelope");
    check(env?.configured === true, "the envelope is configured (goal + a current weigh-in exist)");
    check(typeof env?.dailyCalorieTarget === "number", `dailyCalorieTarget is numeric (${env?.dailyCalorieTarget})`);
    check(
      env?.macros && typeof env.macros.proteinG === "number" && typeof env.macros.fatG === "number" && typeof env.macros.carbsG === "number",
      "macros carries numeric P/F/C grams",
    );
    check(env?.notMedicalAdvice === true, "the envelope carries the not-medical-advice marker");
    check(
      Array.isArray(env?.flags) && env.flags.some((f) => f.id === "not-medical-advice"),
      "the always-on not-medical-advice flag is present",
    );

    // ----------------------------------------------------------------------
    // validation → 400s (weight + goal)
    // ----------------------------------------------------------------------
    const noDate = await POST("/api/nutrition/weight", { weightKg: 90 });
    check(noDate.status === 400, `POST weight missing date → 400 (got ${noDate.status})`);

    const noWeight = await POST("/api/nutrition/weight", { date: "2019-03-11" });
    check(noWeight.status === 400, `POST weight with neither weightKg nor weightLb → 400 (got ${noWeight.status})`);

    const badGoalSex = await PUT("/api/nutrition/goal", {
      sex: "other",
      age: 35,
      heightCm: 180,
      activity: "moderate",
      targetWeightKg: 80,
    });
    check(badGoalSex.status === 400, `PUT goal sex:"other" → 400 (got ${badGoalSex.status})`);

    const badGoalActivity = await PUT("/api/nutrition/goal", {
      sex: "male",
      age: 35,
      heightCm: 180,
      activity: "olympic",
      targetWeightKg: 80,
    });
    check(badGoalActivity.status === 400, `PUT goal activity:"olympic" → 400 (got ${badGoalActivity.status})`);

    const badGoalAge = await PUT("/api/nutrition/goal", {
      sex: "male",
      age: 0,
      heightCm: 180,
      activity: "moderate",
      targetWeightKg: 80,
    });
    check(badGoalAge.status === 400, `PUT goal age:0 → 400 (got ${badGoalAge.status})`);

    // ----------------------------------------------------------------------
    // GATE: with the add-on DISABLED, WRITES → 404 while GETs still return.
    // ----------------------------------------------------------------------
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "the add-on reports enabled:false");

    const readWhileDisabled = await GET("/api/nutrition/weight");
    check(
      readWhileDisabled.status === 200,
      `GET /api/nutrition/weight while disabled → 200 (got ${readWhileDisabled.status})`,
    );
    check(
      weightIds(readWhileDisabled.body.weights || []).has(weightId),
      "the entry is STILL readable while the add-on is disabled (reads are ungated)",
    );
    const goalWhileDisabled = await GET("/api/nutrition/goal");
    check(goalWhileDisabled.status === 200, `GET /api/nutrition/goal while disabled → 200 (got ${goalWhileDisabled.status})`);
    const targetsWhileDisabled = await GET("/api/nutrition/targets");
    check(
      targetsWhileDisabled.status === 200,
      `GET /api/nutrition/targets while disabled → 200 (got ${targetsWhileDisabled.status})`,
    );

    const blockedPost = await POST("/api/nutrition/weight", { date: "2019-03-12", weightKg: 88 });
    check(blockedPost.status === 404, `POST weight while disabled → 404 (got ${blockedPost.status})`);
    const blockedGoal = await PUT("/api/nutrition/goal", {
      sex: "female",
      age: 30,
      heightCm: 165,
      activity: "light",
      targetWeightKg: 60,
    });
    check(blockedGoal.status === 404, `PUT goal while disabled → 404 (got ${blockedGoal.status})`);

    // The blocked POST never landed.
    const survived = await GET("/api/nutrition/weight");
    check(
      !weightIds(survived.body.weights || []).has(undefined) &&
        !(survived.body.weights || []).some((w) => w.date === "2019-03-12"),
      "the blocked POST did NOT append a new weigh-in",
    );

    // Re-ENABLE for the delete lifecycle below.
    const reEnable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable → 200 (got ${reEnable.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET
    // ----------------------------------------------------------------------
    const before = weightIds(await listWeights());
    check(before.has(weightId), "entry is in the list before delete");
    const del = await DELETE(`/api/nutrition/weight/${encodeURIComponent(weightId)}`);
    check(del.status === 200, `DELETE /api/nutrition/weight/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const afterDel = weightIds(await listWeights());
    check(!afterDel.has(weightId), "deleted entry drops from GET /api/nutrition/weight");
    const goneDetail = await GET(`/api/nutrition/weight/${encodeURIComponent(weightId)}`);
    check(goneDetail.status === 404, `GET the deleted entry → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero; this also restores the
    // add-on's pre-test enabled state + any pre-existing goal/weights, since they all live
    // in cases.json).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} weight check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v10 weight API holds (enable/create/upsert/lb→kg/list/window/get/patch/goal/targets/validate/gate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
