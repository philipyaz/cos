#!/usr/bin/env node
// api-nutrition-pantry.mjs — end-to-end lifecycle test of the v9 Nutrition pantry API.
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path
// (board/app/api/nutrition/pantry/**) against a RUNNING board and asserts the pantry
// contract end-to-end, using OUR field names (PantryItem in board/lib/types.ts):
//   • ENABLE the add-on first (PATCH /api/addons/nutrition { enabled:true }) so the
//     gated writes are accepted (the gate contract itself is exercised separately
//     below + in api-nutrition-gate.mjs);
//   • add_pantry_item (POST)      → 201; id matches PANTRY-<n>; db.version increments;
//                                   name + quantity/unit/category/location/expiresAt persist
//   • list /api/nutrition/pantry  → 200, items is an array carrying the created id;
//                                   the category/location/expiringBefore/lowStock filters narrow
//   • GET /api/nutrition/pantry/:id → 200 with the item
//   • PATCH (update_pantry_item)  → 200, persisted on a re-GET, version bumps; an
//                                   agent-attributed (x-actor:agent) write round-trips
//   • validation                  → missing name, bad category, bad location,
//                                   non-number quantity, non-boolean lowStock all 400
//   • DELETE                       → 200; the id no longer appears in GET (404 on re-GET)
//   • GATE                         → with the add-on DISABLED a POST/PATCH/DELETE → 404
//                                   while GET still returns; actor attribution
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero) — db.pantry + settings.addons live in
// cases.json. Requires a running board:
//   cd board && npm run dev            # or npm run start
//   node tests/api-nutrition-pantry.mjs   # CRM_BASE_URL defaults to http://localhost:3000
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

const listItems = async () => (await GET("/api/nutrition/pantry")).body.items || [];
const itemIds = (items) => new Set(items.map((i) => i.id));

const PANTRY_ID_RE = /^PANTRY-\d+$/;

async function main() {
  console.log(`api-nutrition-pantry · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.pantry + settings.addons
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
    // add_pantry_item (POST) → 201, PANTRY-<n> id, version increments, fields persist
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/nutrition/pantry")).body.version;
    check(typeof v0 === "number", `GET /api/nutrition/pantry returns a numeric version (${v0})`);

    const created = await POST("/api/nutrition/pantry", {
      name: "Chicken breast",
      quantity: 2,
      unit: "lb",
      category: "protein",
      location: "freezer",
      expiresAt: "2026-06-20",
      lowStock: false,
      note: "for the week",
    });
    check(created.status === 201, `POST /api/nutrition/pantry → 201 (got ${created.status})`);
    const item = created.body.item;
    check(!!item?.id, `create returned an item id (${item?.id})`);
    check(PANTRY_ID_RE.test(item?.id || ""), `item id matches PANTRY-<n> (${item?.id})`);
    check(item?.name === "Chicken breast", "created item persisted name");
    check(item?.quantity === 2, "created item persisted quantity");
    check(item?.unit === "lb", "created item persisted unit");
    check(item?.category === "protein", "created item persisted category");
    check(item?.location === "freezer", "created item persisted location");
    check(item?.expiresAt === "2026-06-20", "created item persisted expiresAt");
    check(item?.lowStock === false, "created item persisted lowStock:false");
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    const vAfterCreate = (await GET("/api/nutrition/pantry")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const pantryId = item.id;

    // A second item with different facets, to make the filters discriminate.
    const created2 = await POST("/api/nutrition/pantry", {
      name: "Spinach",
      quantity: 1,
      unit: "bag",
      category: "produce",
      location: "fridge",
      expiresAt: "2026-06-15",
      lowStock: true,
    });
    check(created2.status === 201, `POST second pantry item → 201 (got ${created2.status})`);
    const pantryId2 = created2.body.item?.id;

    // ----------------------------------------------------------------------
    // GET /api/nutrition/pantry → array containing the created id; filters narrow
    // ----------------------------------------------------------------------
    const listed = await GET("/api/nutrition/pantry");
    check(listed.status === 200, `GET /api/nutrition/pantry → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.items), "GET returns an items array");
    check(itemIds(listed.body.items).has(pantryId), "the created item is in the list");

    const byCategory = await GET("/api/nutrition/pantry?category=protein");
    check(itemIds(byCategory.body.items || []).has(pantryId), "category=protein returns the protein item");
    check(
      !itemIds(byCategory.body.items || []).has(pantryId2),
      "category=protein excludes the produce item",
    );

    const byLocation = await GET("/api/nutrition/pantry?location=freezer");
    check(itemIds(byLocation.body.items || []).has(pantryId), "location=freezer returns the freezer item");
    check(
      !itemIds(byLocation.body.items || []).has(pantryId2),
      "location=freezer excludes the fridge item",
    );

    // expiringBefore filters items whose expiresAt < the given day (half-open).
    const expiring = await GET("/api/nutrition/pantry?expiringBefore=2026-06-16");
    check(
      itemIds(expiring.body.items || []).has(pantryId2),
      "expiringBefore=2026-06-16 includes the 2026-06-15 item",
    );
    check(
      !itemIds(expiring.body.items || []).has(pantryId),
      "expiringBefore=2026-06-16 excludes the 2026-06-20 item",
    );
    const expiringTight = await GET("/api/nutrition/pantry?expiringBefore=2026-06-15");
    check(
      !itemIds(expiringTight.body.items || []).has(pantryId2),
      "expiringBefore is half-open: =2026-06-15 EXCLUDES the 2026-06-15 item",
    );

    const lowOnly = await GET("/api/nutrition/pantry?lowStock=true");
    check(itemIds(lowOnly.body.items || []).has(pantryId2), "lowStock=true returns the low-stock item");
    check(
      !itemIds(lowOnly.body.items || []).has(pantryId),
      "lowStock=true excludes the well-stocked item",
    );

    // GET by id
    const got = await GET(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(got.status === 200, `GET /api/nutrition/pantry/:id → 200 (got ${got.status})`);
    check(got.body.item?.id === pantryId, "GET by id returns the right item");

    // ----------------------------------------------------------------------
    // PATCH → 200, persisted on a re-GET, version bumps; agent attribution round-trips
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/nutrition/pantry")).body.version;
    const patched = await PATCH(
      `/api/nutrition/pantry/${encodeURIComponent(pantryId)}`,
      { quantity: 1, lowStock: true, note: "running low" },
      { "x-actor": "agent" }, // an MCP/agent-attributed write
    );
    check(patched.status === 200, `PATCH /api/nutrition/pantry/:id (x-actor:agent) → 200 (got ${patched.status})`);
    check(patched.body.item?.quantity === 1, "PATCH reflects the new quantity");
    check(patched.body.item?.lowStock === true, "PATCH reflects the new lowStock flag");
    check(patched.body.item?.note === "running low", "PATCH reflects the new note");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`)).body.item;
    check(reread?.quantity === 1, "re-GET shows the persisted quantity");
    check(reread?.lowStock === true, "re-GET shows the persisted lowStock flag");

    // ----------------------------------------------------------------------
    // validation → 400s
    // ----------------------------------------------------------------------
    const noName = await POST("/api/nutrition/pantry", { quantity: 1, category: "produce" });
    check(noName.status === 400, `POST missing name → 400 (got ${noName.status})`);

    const emptyName = await POST("/api/nutrition/pantry", { name: "   " });
    check(emptyName.status === 400, `POST blank name → 400 (got ${emptyName.status})`);

    const badCategory = await POST("/api/nutrition/pantry", { name: "Mystery", category: "snacks" });
    check(badCategory.status === 400, `POST category:"snacks" → 400 (got ${badCategory.status})`);

    const badLocation = await POST("/api/nutrition/pantry", { name: "Mystery", location: "cupboard" });
    check(badLocation.status === 400, `POST location:"cupboard" → 400 (got ${badLocation.status})`);

    const badQuantity = await POST("/api/nutrition/pantry", { name: "Mystery", quantity: "lots" });
    check(badQuantity.status === 400, `POST quantity:"lots" → 400 (got ${badQuantity.status})`);

    const badLowStock = await POST("/api/nutrition/pantry", { name: "Mystery", lowStock: "yes" });
    check(badLowStock.status === 400, `POST lowStock:"yes" → 400 (got ${badLowStock.status})`);

    const badExpires = await POST("/api/nutrition/pantry", { name: "Mystery", expiresAt: "soon" });
    check(badExpires.status === 400, `POST expiresAt:"soon" → 400 (got ${badExpires.status})`);

    // ----------------------------------------------------------------------
    // GATE: with the add-on DISABLED, every WRITE → 404 while GET still returns.
    // ----------------------------------------------------------------------
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "the add-on reports enabled:false");

    const readWhileDisabled = await GET("/api/nutrition/pantry");
    check(
      readWhileDisabled.status === 200,
      `GET /api/nutrition/pantry while disabled → 200 (got ${readWhileDisabled.status})`,
    );
    check(
      itemIds(readWhileDisabled.body.items || []).has(pantryId),
      "the item is STILL readable while the add-on is disabled (reads are ungated)",
    );
    const readOneWhileDisabled = await GET(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(
      readOneWhileDisabled.status === 200,
      `GET /api/nutrition/pantry/:id while disabled → 200 (got ${readOneWhileDisabled.status})`,
    );

    const blockedPost = await POST("/api/nutrition/pantry", { name: "Blocked" });
    check(blockedPost.status === 404, `POST while disabled → 404 (got ${blockedPost.status})`);

    const blockedPatch = await PATCH(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`, { quantity: 9 });
    check(blockedPatch.status === 404, `PATCH while disabled → 404 (got ${blockedPatch.status})`);

    const blockedDelete = await DELETE(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(blockedDelete.status === 404, `DELETE while disabled → 404 (got ${blockedDelete.status})`);

    // The blocked PATCH/DELETE never landed.
    const survived = await GET(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(survived.body.item?.quantity === 1, "the blocked PATCH did NOT mutate the item");

    // Re-ENABLE for the delete lifecycle below.
    const reEnable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable → 200 (got ${reEnable.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET
    // ----------------------------------------------------------------------
    const before = itemIds(await listItems());
    check(before.has(pantryId), "item is in the list before delete");
    const del = await DELETE(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(del.status === 200, `DELETE /api/nutrition/pantry/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const afterDel = itemIds(await listItems());
    check(!afterDel.has(pantryId), "deleted item drops from GET /api/nutrition/pantry");
    const goneDetail = await GET(`/api/nutrition/pantry/${encodeURIComponent(pantryId)}`);
    check(goneDetail.status === 404, `GET the deleted item → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero; this also restores the
    // add-on's pre-test enabled state, since settings.addons lives in cases.json).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} pantry check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v9 pantry API holds (enable/create/list/filter/get/patch/validate/gate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
