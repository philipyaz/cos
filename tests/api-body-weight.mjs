#!/usr/bin/env node
// api-body-weight.mjs — end-to-end lifecycle test of the v14 body weigh-in series
// (/api/body/weight[/:id]). This is the successor to the retired api-nutrition-weight.mjs:
// in v14 the weigh-in series moved from the Nutrition add-on to the foundational "body"
// add-on (which now owns identity + weight + the free-text objective), and the derived
// weight-loss goal/targets engine was retired (targets are now agent-authored — see
// api-nutrition-diet-profile.mjs). The GATE contract for body lives in api-body-gate.mjs;
// this test is the pure WEIGHT lifecycle against the WeightEntry surface in board/lib/store.ts.
//
// Plain Node (ESM), zero deps. Drives the mutation paths against a RUNNING board with the
// "body" add-on ENABLED, using OUR field names (WeightEntry in board/lib/types.ts):
//   • ENABLE body first (PATCH /api/addons/body { enabled:true }) so the gated writes land;
//   • create (POST /weight)        → 201; id matches WEIGHT-<n>; db.version increments;
//                                    weightKg + note persist; created:true;
//   • body-composition (v14)       → a POST carrying bodyFatPct persists it (the new
//                                    WeightEntry optionals leanMassKg/waistCm ride the same path);
//   • UPSERT BY DAY                 → a SECOND POST for the SAME date is an UPDATE: 200,
//                                    created:false, the SAME id, the new weightKg/note, and
//                                    exactly one entry survives for that day;
//   • lb → kg at the boundary      → a weightLb-only POST stores canonical kg (× 0.45359237);
//   • list /api/body/weight        → 200, weights is an array (ASC by date) carrying the id;
//                                    the from/to window is half-open [from, to);
//   • GET /weight/:id              → 200 with the entry;
//   • PATCH (x-actor:agent)        → 200, persisted on a re-GET, version bumps;
//   • validation                   → missing date, neither weightKg nor weightLb, BOTH
//                                    weightKg AND weightLb (exactly-one), out-of-range
//                                    bodyFatPct all 400;
//   • DELETE                       → 200 { ok:true }; the id no longer appears in GET
//                                    (404 on re-GET).
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live board
// is left EXACTLY as found (net-zero) — db.weights + settings.addons live in cases.json.
// Requires a running board:
//   cd board && npm run dev            # or npm run start
//   node tests/api-body-weight.mjs     # CRM_BASE_URL defaults to http://localhost:3000
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
const PATCH = (p, b, h) => api("PATCH", p, b, h);
const DELETE = (p) => api("DELETE", p);

const listWeights = async () => (await GET("/api/body/weight")).body.weights || [];
const weightIds = (weights) => new Set(weights.map((w) => w.id));

const WEIGHT_ID_RE = /^WEIGHT-\d+$/;
const LB_TO_KG = 0.45359237; // the canonical pound→kilogram factor (mirrors the route boundary)

async function main() {
  console.log(`api-body-weight · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.weights + settings.addons live
  // in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // ENABLE the body add-on so the gated writes are accepted. (body is a
    // PROVIDER with no dependencies, so this is a clean direct enable — the
    // cascade + 409-disable guard are exercised in api-body-gate.mjs.)
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/body", { enabled: true });
    check(enable.status === 200, `PATCH /api/addons/body { enabled:true } → 200 (got ${enable.status})`);
    check(enable.body.addon?.enabled === true, "the body add-on reports enabled:true");

    // ----------------------------------------------------------------------
    // create (POST) → 201, WEIGHT-<n> id, version increments, fields persist
    // NB: the weigh-in dates below are deliberately HISTORICAL (2019-03-xx) so the
    // "new day → 201 created" assertions can't collide with a real weigh-in the live
    // board may already hold for today (the upsert-by-day would otherwise return 200).
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/body/weight")).body.version;
    check(typeof v0 === "number", `GET /api/body/weight returns a numeric version (${v0})`);

    const created = await POST("/api/body/weight", {
      date: "2019-03-10",
      weightKg: 90,
      note: "morning",
    });
    check(created.status === 201, `POST /api/body/weight (new day) → 201 (got ${created.status})`);
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
    // body-composition (v14): a POST carrying bodyFatPct persists it (the new
    // WeightEntry optionals — leanMassKg / waistCm ride the same validated path).
    // ----------------------------------------------------------------------
    const comp = await POST("/api/body/weight", { date: "2019-03-12", weightKg: 88, bodyFatPct: 18.5 });
    check(comp.status === 201, `POST /api/body/weight with bodyFatPct (new day) → 201 (got ${comp.status})`);
    check(comp.body.entry?.bodyFatPct === 18.5, "the v14 body-composition bodyFatPct persisted");
    const compId = comp.body.entry?.id;

    // ----------------------------------------------------------------------
    // UPSERT BY DAY: a SECOND POST for the SAME date UPDATES (200, created:false, same id)
    // ----------------------------------------------------------------------
    const vBeforeUpsert = (await GET("/api/body/weight")).body.version;
    const upsert = await POST("/api/body/weight", {
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
    const lbCreated = await POST("/api/body/weight", { date: "2019-03-14", weightLb: 200 });
    check(lbCreated.status === 201, `POST weightLb-only (new day) → 201 (got ${lbCreated.status})`);
    const expectedKg = 200 * LB_TO_KG;
    check(
      Math.abs((lbCreated.body.entry?.weightKg ?? 0) - expectedKg) < 1e-6,
      `weightLb:200 stored as canonical kg (≈${expectedKg.toFixed(4)}, got ${lbCreated.body.entry?.weightKg})`,
    );
    const lbWeightId = lbCreated.body.entry?.id;

    // ----------------------------------------------------------------------
    // GET /api/body/weight → array (ASC by date) containing the ids; window narrows
    // ----------------------------------------------------------------------
    const listed = await GET("/api/body/weight");
    check(listed.status === 200, `GET /api/body/weight → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.weights), "GET returns a weights array");
    check(weightIds(listed.body.weights).has(weightId), "the created entry is in the list");
    // ASC by date: the 03-10 entry sorts before the 03-14 entry.
    const dates = listed.body.weights.map((w) => w.date);
    const i10 = dates.indexOf("2019-03-10");
    const i14 = dates.indexOf("2019-03-14");
    check(i10 !== -1 && i14 !== -1 && i10 < i14, "the list is sorted ASC by date");

    const inWindow = await GET("/api/body/weight?from=2019-03-01&to=2019-03-12");
    check(
      weightIds(inWindow.body.weights || []).has(weightId),
      "from/to window [2019-03-01, 2019-03-12) includes the 2019-03-10 entry",
    );
    check(
      !weightIds(inWindow.body.weights || []).has(lbWeightId),
      "from/to window [2019-03-01, 2019-03-12) EXCLUDES the 2019-03-14 entry",
    );
    const tightWindow = await GET("/api/body/weight?from=2019-03-01&to=2019-03-10");
    check(
      !weightIds(tightWindow.body.weights || []).has(weightId),
      "from/to is half-open: to=2019-03-10 EXCLUDES the 2019-03-10 entry",
    );

    // GET by id
    const got = await GET(`/api/body/weight/${encodeURIComponent(weightId)}`);
    check(got.status === 200, `GET /api/body/weight/:id → 200 (got ${got.status})`);
    check(got.body.entry?.id === weightId, "GET by id returns the right entry");

    // ----------------------------------------------------------------------
    // PATCH → 200, persisted on a re-GET, version bumps; agent attribution round-trips
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/body/weight")).body.version;
    const patched = await PATCH(
      `/api/body/weight/${encodeURIComponent(weightId)}`,
      { weightKg: 89.1, note: "after coffee" },
      { "x-actor": "agent" }, // an MCP/agent-attributed write
    );
    check(patched.status === 200, `PATCH /api/body/weight/:id (x-actor:agent) → 200 (got ${patched.status})`);
    check(patched.body.entry?.weightKg === 89.1, "PATCH reflects the new weightKg");
    check(patched.body.entry?.note === "after coffee", "PATCH reflects the new note");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/body/weight/${encodeURIComponent(weightId)}`)).body.entry;
    check(reread?.weightKg === 89.1, "re-GET shows the persisted weightKg");

    // ----------------------------------------------------------------------
    // validation → 400s
    // ----------------------------------------------------------------------
    const noDate = await POST("/api/body/weight", { weightKg: 90 });
    check(noDate.status === 400, `POST weight missing date → 400 (got ${noDate.status})`);

    const noWeight = await POST("/api/body/weight", { date: "2019-03-11" });
    check(noWeight.status === 400, `POST weight with neither weightKg nor weightLb → 400 (got ${noWeight.status})`);

    const bothWeights = await POST("/api/body/weight", { date: "2019-03-11", weightKg: 88, weightLb: 194 });
    check(bothWeights.status === 400, `POST weight with BOTH weightKg and weightLb → 400 (exactly-one) (got ${bothWeights.status})`);

    const badComp = await POST("/api/body/weight", { date: "2019-03-11", weightKg: 88, bodyFatPct: 1 });
    check(badComp.status === 400, `POST weight with out-of-range bodyFatPct:1 → 400 (got ${badComp.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET
    // ----------------------------------------------------------------------
    const before = weightIds(await listWeights());
    check(before.has(weightId), "entry is in the list before delete");
    const del = await DELETE(`/api/body/weight/${encodeURIComponent(weightId)}`);
    check(del.status === 200, `DELETE /api/body/weight/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const afterDel = weightIds(await listWeights());
    check(!afterDel.has(weightId), "deleted entry drops from GET /api/body/weight");
    const goneDetail = await GET(`/api/body/weight/${encodeURIComponent(weightId)}`);
    check(goneDetail.status === 404, `GET the deleted entry → 404 (got ${goneDetail.status})`);
    // the body-comp entry is untouched by the delete of a different id.
    check(afterDel.has(compId), "the unrelated body-comp entry survived the delete");
  } finally {
    // Restore — leave the live board exactly as found (net-zero; this also restores the
    // add-on's pre-test enabled state + any pre-existing weights, since they all live in
    // cases.json).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} weight check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v14 body weight API holds (enable/create/body-comp/upsert/lb→kg/list/window/get/patch/validate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
