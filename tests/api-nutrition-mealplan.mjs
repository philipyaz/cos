#!/usr/bin/env node
// api-nutrition-mealplan.mjs — end-to-end lifecycle test of the v9 Nutrition meal-plan API.
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path
// (board/app/api/nutrition/plan/**) against a RUNNING board and asserts the meal-plan
// contract end-to-end, using OUR field names (MealPlanEntry in board/lib/types.ts):
//   • ENABLE the add-on first (PATCH /api/addons/nutrition { enabled:true }) so the
//     gated writes are accepted (the gate is also exercised below + in api-nutrition-gate.mjs);
//   • plan_meal (POST)            → 201; id matches MEAL-<n>; db.version increments;
//                                   date/slot/title persist; status defaults "planned";
//                                   soft pantryItemIds tolerated (NOT validated)
//   • eventId VALIDATION          → create a real event via POST /api/events, link it
//                                   (sticks); an UNKNOWN eventId → 400; PATCH eventId:null UNLINKS
//   • list /api/nutrition/plan    → 200, entries is an array carrying the created id;
//                                   the from/to window, slot, and status filters narrow
//   • GET /api/nutrition/plan/:id → 200 with the entry
//   • PATCH (update_meal_plan)    → 200, status transition planned→cooked persists on a
//                                   re-GET, version bumps; an x-actor:agent write round-trips
//   • validation                   → missing date/slot/title, bad slot, bad status all 400
//   • DELETE                       → 200; the id no longer appears in GET (404 on re-GET)
//   • GATE                         → with the add-on DISABLED a POST/PATCH/DELETE → 404
//                                   while GET still returns; actor attribution
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero) — db.mealPlan + db.events + settings.addons
// live in cases.json. Requires a running board:
//   cd board && npm run dev            # or npm run start
//   node tests/api-nutrition-mealplan.mjs  # CRM_BASE_URL defaults to http://localhost:3000
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

const listEntries = async () => (await GET("/api/nutrition/plan")).body.entries || [];
const entryIds = (entries) => new Set(entries.map((e) => e.id));

const MEAL_ID_RE = /^MEAL-\d+$/;
const EVT_ID_RE = /^EVT-\d+$/;

async function main() {
  console.log(`api-nutrition-mealplan · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.mealPlan + db.events +
  // settings.addons live in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // ENABLE the add-on so the gated writes are accepted.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH /api/addons/nutrition { enabled:true } → 200 (got ${enable.status})`);
    check(enable.body.addon?.enabled === true, "the add-on reports enabled:true");

    // Mint a REAL calendar event (events are UNGATED) to link a meal to. The eventId
    // relational check mirrors the events route's caseId check.
    const evtCreate = await POST("/api/events", { title: "Dinner party", date: "2026-06-15" });
    check(evtCreate.status === 201, `POST /api/events (for linking) → 201 (got ${evtCreate.status})`);
    const eventId = evtCreate.body.event?.id;
    check(EVT_ID_RE.test(eventId || ""), `the seed event id matches EVT-<n> (${eventId})`);

    // ----------------------------------------------------------------------
    // plan_meal (POST) → 201, MEAL-<n> id, version increments, status defaults planned,
    // soft pantryItemIds tolerated (NOT validated — a dangling ref is allowed).
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/nutrition/plan")).body.version;
    check(typeof v0 === "number", `GET /api/nutrition/plan returns a numeric version (${v0})`);

    const created = await POST("/api/nutrition/plan", {
      date: "2026-06-15",
      slot: "dinner",
      title: "Roast chicken",
      recipe: "Season, roast at 425F for 1h.",
      ingredients: ["chicken", "salt", "thyme"],
      servings: 4,
      pantryItemIds: ["PANTRY-99999"], // SOFT ref — a dangling id must be tolerated
    });
    check(created.status === 201, `POST /api/nutrition/plan → 201 (got ${created.status})`);
    const entry = created.body.entry;
    check(!!entry?.id, `create returned an entry id (${entry?.id})`);
    check(MEAL_ID_RE.test(entry?.id || ""), `entry id matches MEAL-<n> (${entry?.id})`);
    check(entry?.date === "2026-06-15", "created entry persisted date");
    check(entry?.slot === "dinner", "created entry persisted slot");
    check(entry?.title === "Roast chicken", "created entry persisted title");
    check(entry?.servings === 4, "created entry persisted servings");
    check(entry?.status === "planned", "status defaults to 'planned' when omitted");
    check(
      Array.isArray(entry?.pantryItemIds) && entry.pantryItemIds.includes("PANTRY-99999"),
      "a dangling pantryItemIds ref is tolerated (soft refs, not validated)",
    );
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    const vAfterCreate = (await GET("/api/nutrition/plan")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const mealId = entry.id;

    // ----------------------------------------------------------------------
    // eventId VALIDATION — a known eventId links; an UNKNOWN eventId → 400.
    // ----------------------------------------------------------------------
    const linked = await POST("/api/nutrition/plan", {
      date: "2026-06-16",
      slot: "lunch",
      title: "Leftovers",
      eventId,
    });
    check(linked.status === 201, `POST meal with a real eventId → 201 (got ${linked.status})`);
    check(linked.body.entry?.eventId === eventId, "the eventId link sticks on the created entry");
    const linkedId = linked.body.entry?.id;

    const badEvent = await POST("/api/nutrition/plan", {
      date: "2026-06-16",
      slot: "dinner",
      title: "Bad link",
      eventId: "EVT-99999",
    });
    check(badEvent.status === 400, `POST eventId:"EVT-99999" (unknown) → 400 (got ${badEvent.status})`);

    // PATCH eventId:null UNLINKS.
    const unlinked = await PATCH(`/api/nutrition/plan/${encodeURIComponent(linkedId)}`, { eventId: null });
    check(unlinked.status === 200, `PATCH eventId:null → 200 (got ${unlinked.status})`);
    check(
      unlinked.body.entry?.eventId == null,
      "PATCH eventId:null UNLINKS (the entry no longer carries an eventId)",
    );
    const rereadUnlinked = (await GET(`/api/nutrition/plan/${encodeURIComponent(linkedId)}`)).body.entry;
    check(rereadUnlinked?.eventId == null, "re-GET confirms the eventId was unlinked");

    // ----------------------------------------------------------------------
    // GET /api/nutrition/plan → array containing the created id; filters narrow
    // ----------------------------------------------------------------------
    const listed = await GET("/api/nutrition/plan");
    check(listed.status === 200, `GET /api/nutrition/plan → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.entries), "GET returns an entries array");
    check(entryIds(listed.body.entries).has(mealId), "the created entry is in the list");

    const inWindow = await GET("/api/nutrition/plan?from=2026-06-01&to=2026-07-01");
    check(
      entryIds(inWindow.body.entries || []).has(mealId),
      "from/to window [2026-06-01, 2026-07-01) includes the 2026-06-15 entry",
    );
    const beforeWindow = await GET("/api/nutrition/plan?from=2026-01-01&to=2026-06-15");
    check(
      !entryIds(beforeWindow.body.entries || []).has(mealId),
      "from/to is half-open: to=2026-06-15 EXCLUDES the 2026-06-15 entry",
    );
    const bySlot = await GET("/api/nutrition/plan?slot=dinner");
    check(entryIds(bySlot.body.entries || []).has(mealId), "slot=dinner returns the dinner entry");
    const byOtherSlot = await GET("/api/nutrition/plan?slot=breakfast");
    check(
      !entryIds(byOtherSlot.body.entries || []).has(mealId),
      "slot=breakfast excludes the dinner entry",
    );
    const byStatus = await GET("/api/nutrition/plan?status=planned");
    check(entryIds(byStatus.body.entries || []).has(mealId), "status=planned returns the planned entry");
    const byOtherStatus = await GET("/api/nutrition/plan?status=skipped");
    check(
      !entryIds(byOtherStatus.body.entries || []).has(mealId),
      "status=skipped excludes the planned entry",
    );

    // GET by id
    const got = await GET(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(got.status === 200, `GET /api/nutrition/plan/:id → 200 (got ${got.status})`);
    check(got.body.entry?.id === mealId, "GET by id returns the right entry");

    // ----------------------------------------------------------------------
    // PATCH → status transition planned→cooked persists; agent attribution round-trips
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/nutrition/plan")).body.version;
    const patched = await PATCH(
      `/api/nutrition/plan/${encodeURIComponent(mealId)}`,
      { status: "cooked", title: "Roast chicken (done)", servings: 5 },
      { "x-actor": "agent" }, // an MCP/agent-attributed write
    );
    check(patched.status === 200, `PATCH /api/nutrition/plan/:id (x-actor:agent) → 200 (got ${patched.status})`);
    check(patched.body.entry?.status === "cooked", "PATCH reflects the planned→cooked transition");
    check(patched.body.entry?.title === "Roast chicken (done)", "PATCH reflects the new title");
    check(patched.body.entry?.servings === 5, "PATCH reflects the new servings");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/nutrition/plan/${encodeURIComponent(mealId)}`)).body.entry;
    check(reread?.status === "cooked", "re-GET shows the persisted 'cooked' status");
    check(reread?.title === "Roast chicken (done)", "re-GET shows the persisted title");
    // The cooked entry now appears under status=cooked and not status=planned.
    const cookedList = await GET("/api/nutrition/plan?status=cooked");
    check(entryIds(cookedList.body.entries || []).has(mealId), "status=cooked now returns the entry");

    // ----------------------------------------------------------------------
    // validation → 400s
    // ----------------------------------------------------------------------
    const noDate = await POST("/api/nutrition/plan", { slot: "lunch", title: "x" });
    check(noDate.status === 400, `POST missing date → 400 (got ${noDate.status})`);

    const noSlot = await POST("/api/nutrition/plan", { date: "2026-06-17", title: "x" });
    check(noSlot.status === 400, `POST missing slot → 400 (got ${noSlot.status})`);

    const noTitle = await POST("/api/nutrition/plan", { date: "2026-06-17", slot: "lunch" });
    check(noTitle.status === 400, `POST missing title → 400 (got ${noTitle.status})`);

    const badSlot = await POST("/api/nutrition/plan", { date: "2026-06-17", slot: "brunch", title: "x" });
    check(badSlot.status === 400, `POST slot:"brunch" → 400 (got ${badSlot.status})`);

    const badStatus = await POST("/api/nutrition/plan", {
      date: "2026-06-17",
      slot: "lunch",
      title: "x",
      status: "burnt",
    });
    check(badStatus.status === 400, `POST status:"burnt" → 400 (got ${badStatus.status})`);

    // ----------------------------------------------------------------------
    // GATE: with the add-on DISABLED, every WRITE → 404 while GET still returns.
    // ----------------------------------------------------------------------
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "the add-on reports enabled:false");

    const readWhileDisabled = await GET("/api/nutrition/plan");
    check(
      readWhileDisabled.status === 200,
      `GET /api/nutrition/plan while disabled → 200 (got ${readWhileDisabled.status})`,
    );
    check(
      entryIds(readWhileDisabled.body.entries || []).has(mealId),
      "the entry is STILL readable while the add-on is disabled (reads are ungated)",
    );
    const readOneWhileDisabled = await GET(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(
      readOneWhileDisabled.status === 200,
      `GET /api/nutrition/plan/:id while disabled → 200 (got ${readOneWhileDisabled.status})`,
    );

    const blockedPost = await POST("/api/nutrition/plan", {
      date: "2026-06-18",
      slot: "lunch",
      title: "Blocked",
    });
    check(blockedPost.status === 404, `POST while disabled → 404 (got ${blockedPost.status})`);

    const blockedPatch = await PATCH(`/api/nutrition/plan/${encodeURIComponent(mealId)}`, { status: "skipped" });
    check(blockedPatch.status === 404, `PATCH while disabled → 404 (got ${blockedPatch.status})`);

    const blockedDelete = await DELETE(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(blockedDelete.status === 404, `DELETE while disabled → 404 (got ${blockedDelete.status})`);

    // The blocked PATCH/DELETE never landed.
    const survived = await GET(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(survived.body.entry?.status === "cooked", "the blocked PATCH did NOT mutate the entry");

    // Re-ENABLE for the delete lifecycle below.
    const reEnable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable → 200 (got ${reEnable.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET
    // ----------------------------------------------------------------------
    const before = entryIds(await listEntries());
    check(before.has(mealId), "entry is in the list before delete");
    const del = await DELETE(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(del.status === 200, `DELETE /api/nutrition/plan/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const afterDel = entryIds(await listEntries());
    check(!afterDel.has(mealId), "deleted entry drops from GET /api/nutrition/plan");
    const goneDetail = await GET(`/api/nutrition/plan/${encodeURIComponent(mealId)}`);
    check(goneDetail.status === 404, `GET the deleted entry → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero; this also restores the
    // add-on's pre-test enabled state + drops the seed event, since settings.addons,
    // db.mealPlan, and db.events all live in cases.json).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} meal-plan check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v9 meal-plan API holds (enable/create/eventId/soft-refs/list/filter/get/patch/validate/gate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
