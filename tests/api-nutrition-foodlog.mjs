#!/usr/bin/env node
// api-nutrition-foodlog.mjs — end-to-end lifecycle test of the v9 Nutrition food-log API.
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path
// (board/app/api/nutrition/log/**) against a RUNNING board and asserts the food-log
// contract end-to-end, using OUR field names (FoodLogEntry in board/lib/types.ts):
//   • ENABLE the add-on first (PATCH /api/addons/nutrition { enabled:true }) so the
//     gated writes are accepted (the gate contract itself is exercised separately in
//     api-nutrition-gate.mjs);
//   • log_food (POST)             → 201; id matches FOOD-<n>; db.version increments;
//                                   estimated defaults true; macros + health persist
//   • list /api/nutrition/log     → 200, entries is an array carrying the created id;
//                                   the from/to window, slot, and date filters narrow
//   • GET /api/nutrition/log/:id  → 200 with the entry
//   • PATCH (update_food_log)      → 200, persisted on a re-GET, version bumps; an
//                                   agent-attributed (x-actor:agent) write round-trips
//   • validation                   → missing date/slot/description, non-number calories,
//                                   bad slot, bad health all 400
//   • DELETE                       → 200; the id no longer appears in GET (404 on re-GET)
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero) — db.foodLogs + settings.addons live in
// cases.json. Requires a running board:
//   cd board && npm run dev            # or npm run start
//   node tests/api-nutrition-foodlog.mjs   # CRM_BASE_URL defaults to http://localhost:3000
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

const listEntries = async () => (await GET("/api/nutrition/log")).body.entries || [];
const entryIds = (entries) => new Set(entries.map((e) => e.id));

const FOOD_ID_RE = /^FOOD-\d+$/;

async function main() {
  console.log(`api-nutrition-foodlog · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.foodLogs + settings.addons
  // live in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // ENABLE the add-on so the gated writes are accepted.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH /api/addons/nutrition { enabled:true } → 200 (got ${enable.status})`);
    check(enable.body.addon?.enabled === true, "the add-on reports enabled:true");

    // ----------------------------------------------------------------------
    // log_food (POST) → 201, FOOD-<n> id, version increments, estimated defaults true
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/nutrition/log")).body.version;
    check(typeof v0 === "number", `GET /api/nutrition/log returns a numeric version (${v0})`);

    const created = await POST("/api/nutrition/log", {
      date: "2026-06-15",
      slot: "breakfast",
      description: "Oatmeal with berries",
      items: ["1 cup oats", "blueberries"],
      calories: 350,
      protein: 12,
      carbs: 60,
      fat: 6,
      health: "green",
    });
    check(created.status === 201, `POST /api/nutrition/log → 201 (got ${created.status})`);
    const entry = created.body.entry;
    check(!!entry?.id, `create returned an entry id (${entry?.id})`);
    check(FOOD_ID_RE.test(entry?.id || ""), `entry id matches FOOD-<n> (${entry?.id})`);
    check(entry?.date === "2026-06-15", "created entry persisted date");
    check(entry?.slot === "breakfast", "created entry persisted slot");
    check(entry?.calories === 350, "created entry persisted calories");
    check(entry?.protein === 12 && entry?.carbs === 60 && entry?.fat === 6, "macros persisted");
    check(entry?.health === "green", "health flag persisted");
    check(entry?.estimated === true, "estimated defaults to true when omitted");
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    const vAfterCreate = (await GET("/api/nutrition/log")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const foodId = entry.id;

    // ----------------------------------------------------------------------
    // GET /api/nutrition/log → array containing the created id; filters narrow
    // ----------------------------------------------------------------------
    const listed = await GET("/api/nutrition/log");
    check(listed.status === 200, `GET /api/nutrition/log → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.entries), "GET returns an entries array");
    check(entryIds(listed.body.entries).has(foodId), "the created entry is in the list");

    const inWindow = await GET("/api/nutrition/log?from=2026-06-01&to=2026-07-01");
    check(
      entryIds(inWindow.body.entries || []).has(foodId),
      "from/to window [2026-06-01, 2026-07-01) includes the 2026-06-15 entry",
    );
    const beforeWindow = await GET("/api/nutrition/log?from=2026-01-01&to=2026-06-15");
    check(
      !entryIds(beforeWindow.body.entries || []).has(foodId),
      "from/to is half-open: to=2026-06-15 EXCLUDES the 2026-06-15 entry",
    );
    const bySlot = await GET("/api/nutrition/log?slot=breakfast");
    check(entryIds(bySlot.body.entries || []).has(foodId), "slot=breakfast returns the entry");
    const byOtherSlot = await GET("/api/nutrition/log?slot=dinner");
    check(!entryIds(byOtherSlot.body.entries || []).has(foodId), "slot=dinner excludes the breakfast entry");
    const byDate = await GET("/api/nutrition/log?date=2026-06-15");
    check(entryIds(byDate.body.entries || []).has(foodId), "date=2026-06-15 returns the entry");
    const byOtherDate = await GET("/api/nutrition/log?date=2026-06-16");
    check(!entryIds(byOtherDate.body.entries || []).has(foodId), "date=2026-06-16 excludes the entry");

    // GET by id
    const got = await GET(`/api/nutrition/log/${encodeURIComponent(foodId)}`);
    check(got.status === 200, `GET /api/nutrition/log/:id → 200 (got ${got.status})`);
    check(got.body.entry?.id === foodId, "GET by id returns the right entry");

    // ----------------------------------------------------------------------
    // PATCH → 200, persisted on a re-GET, version bumps; agent attribution round-trips
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/nutrition/log")).body.version;
    const patched = await PATCH(
      `/api/nutrition/log/${encodeURIComponent(foodId)}`,
      { description: "Oatmeal with banana", calories: 380, health: "amber" },
      { "x-actor": "agent" }, // an MCP/agent-attributed write
    );
    check(patched.status === 200, `PATCH /api/nutrition/log/:id (x-actor:agent) → 200 (got ${patched.status})`);
    check(patched.body.entry?.description === "Oatmeal with banana", "PATCH reflects the new description");
    check(patched.body.entry?.calories === 380, "PATCH reflects the new calories");
    check(patched.body.entry?.health === "amber", "PATCH reflects the new health flag");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/nutrition/log/${encodeURIComponent(foodId)}`)).body.entry;
    check(reread?.description === "Oatmeal with banana", "re-GET shows the persisted description");
    check(reread?.calories === 380, "re-GET shows the persisted calories");

    // ----------------------------------------------------------------------
    // validation → 400s
    // ----------------------------------------------------------------------
    const noDate = await POST("/api/nutrition/log", { slot: "lunch", description: "x", calories: 100 });
    check(noDate.status === 400, `POST missing date → 400 (got ${noDate.status})`);

    const noSlot = await POST("/api/nutrition/log", { date: "2026-06-16", description: "x", calories: 100 });
    check(noSlot.status === 400, `POST missing slot → 400 (got ${noSlot.status})`);

    const noDesc = await POST("/api/nutrition/log", { date: "2026-06-16", slot: "lunch", calories: 100 });
    check(noDesc.status === 400, `POST missing description → 400 (got ${noDesc.status})`);

    const badCalories = await POST("/api/nutrition/log", {
      date: "2026-06-16",
      slot: "lunch",
      description: "x",
      calories: "lots",
    });
    check(badCalories.status === 400, `POST calories:"lots" → 400 (got ${badCalories.status})`);

    const badSlot = await POST("/api/nutrition/log", {
      date: "2026-06-16",
      slot: "brunch",
      description: "x",
      calories: 100,
    });
    check(badSlot.status === 400, `POST slot:"brunch" → 400 (got ${badSlot.status})`);

    const badHealth = await POST("/api/nutrition/log", {
      date: "2026-06-16",
      slot: "lunch",
      description: "x",
      calories: 100,
      health: "purple",
    });
    check(badHealth.status === 400, `POST health:"purple" → 400 (got ${badHealth.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET
    // ----------------------------------------------------------------------
    const before = entryIds(await listEntries());
    check(before.has(foodId), "entry is in the list before delete");
    const del = await DELETE(`/api/nutrition/log/${encodeURIComponent(foodId)}`);
    check(del.status === 200, `DELETE /api/nutrition/log/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const afterDel = entryIds(await listEntries());
    check(!afterDel.has(foodId), "deleted entry drops from GET /api/nutrition/log");
    const goneDetail = await GET(`/api/nutrition/log/${encodeURIComponent(foodId)}`);
    check(goneDetail.status === 404, `GET the deleted entry → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero; this also restores the
    // add-on's pre-test enabled state, since settings.addons lives in cases.json).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} food-log check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v9 food-log API holds (enable/create/list/filter/get/patch/validate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
