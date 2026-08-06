#!/usr/bin/env node
// api-nutrition-shopping.mjs — end-to-end lifecycle test of the v16 shopping-list API
// (cos-ops#37): the persistent list (board/app/api/nutrition/shopping/**) AND the computed
// candidates read (board/app/api/nutrition/shopping/candidates/**).
//
// Plain Node (ESM), zero deps. Clones api-nutrition-status.mjs's harness (snapshot/restore,
// RELATIVE assertions — this may run against a dev board that already has data, so nothing
// here assumes an empty store). Synthetic fixtures only. Proves:
//   • ENABLE the add-on, then POST a `household` NON-FOOD item ("AA batteries") → 201
//     SHOP-<n>; GET the list (unfiltered) contains it; GET by id returns it.
//   • PATCH status:"bought" → 200, stamps `boughtAt`; PATCH status:"needed" → clears it.
//   • PATCH with a deliberately-wrong `expectedVersion` → 409.
//   • POST with a dangling `sourceRef` ("MEAL-999999") → 201 fine, reads fine (a SOFT ref,
//     never validated relationally — exactly like MealPlanEntry.pantryItemIds).
//   • Candidates: a planned in-window meal naming an INVENTED ingredient yields it as a
//     plan-side candidate; adding that ingredient to the list as "needed" suppresses it on
//     the next candidates read; two back-to-back candidate GETs return the SAME `version`
//     (the read persists nothing — ADR 0017).
//   • GATE: add-on DISABLED → POST 404, GET 200 (ungated read).
//   • DELETE → 200; the id no longer appears in GET (404 on re-GET).
// Plus an in-file static route-vs-tool check (the api-fitness-plan-outcome.mjs
// checkRouteVsTool mechanic — no HTTP needed): mcp/nutrition-server/server.mjs references
// /api/nutrition/shopping and shopping/candidates. That check ALSO lives, unconditionally, in
// the always-run tests/shopping-list-consumers.mjs — this copy exists to satisfy the issue's
// own naming of this file; the always-run copy is the real enforcement (ADR 0014: this whole
// api test SKIPs silently without a running board).
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero — db.
// shoppingItems + db.mealPlanEntries + settings.addons all live in cases.json). Requires a
// running board:
//   cd board && npm run dev
//   node tests/api-nutrition-shopping.mjs    # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs, readFileSync } from "node:fs";
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
const POST = (p, b, h) => api("POST", p, b, h);
const PATCH = (p, b, h) => api("PATCH", p, b, h);
const DELETE = (p) => api("DELETE", p);

const SHOP_ID_RE = /^SHOP-\d+$/;

// Today, local calendar day — mirrors board/lib/nutrition-format.ts's toISODay exactly, so a
// meal dated TODAY always falls inside a `from=TODAY&to=TODAY` candidates window regardless of
// the machine's timezone.
function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const TODAY = isoDay(new Date());

// A nonsense token vanishingly unlikely to collide with any real pantry/shopping name on a
// dev board that already has data (RELATIVE assertions — this test may not own an empty store).
const INVENTED_INGREDIENT = "zzz-fixture-ingredient-9182";

// ── in-file static route-vs-tool check (the api-fitness-plan-outcome.mjs checkRouteVsTool
// mechanic) — no HTTP needed for this one. ──────────────────────────────────────────────────
function checkRouteVsTool() {
  const serverSrc = readFileSync(path.join(HERE, "..", "mcp", "nutrition-server", "server.mjs"), "utf8");
  check(serverSrc.includes("/api/nutrition/shopping"), "mcp/nutrition-server/server.mjs references /api/nutrition/shopping");
  check(serverSrc.includes("shopping/candidates"), "mcp/nutrition-server/server.mjs references shopping/candidates");
}

async function main() {
  console.log(`api-nutrition-shopping · board=${BASE}`);

  checkRouteVsTool();

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // ENABLE the add-on so the gated writes are accepted.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH /api/addons/nutrition { enabled:true } → 200 (got ${enable.status})`);

    // ----------------------------------------------------------------------
    // add_shopping_item (POST) → 201, SHOP-<n> id, a NON-FOOD category round-trips
    // ----------------------------------------------------------------------
    const created = await POST("/api/nutrition/shopping", {
      name: "AA batteries",
      category: "household",
      quantity: 4,
    });
    check(created.status === 201, `POST /api/nutrition/shopping (household item) → 201 (got ${created.status})`);
    const item = created.body.item;
    check(!!item?.id, `create returned an item id (${item?.id})`);
    check(SHOP_ID_RE.test(item?.id || ""), `item id matches SHOP-<n> (${item?.id})`);
    check(item?.name === "AA batteries", "created item persisted name");
    check(item?.category === "household", "created item persisted the NON-FOOD category");
    check(item?.status === "needed", "created item defaults status to 'needed'");
    check(item?.source === "manual", "created item defaults source to 'manual'");
    check(item?.boughtAt === undefined, "a 'needed' item carries no boughtAt");
    const shopId = item.id;

    // GET the list (unfiltered — the HTTP route defaults to ALL rows) contains it.
    const listed = await GET("/api/nutrition/shopping");
    check(listed.status === 200, `GET /api/nutrition/shopping → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.items), "GET returns an items array");
    check(
      (listed.body.items || []).some((x) => x.id === shopId),
      "the created household item is in the unfiltered list",
    );

    // GET by id.
    const got = await GET(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`);
    check(got.status === 200, `GET /api/nutrition/shopping/:id → 200 (got ${got.status})`);
    check(got.body.item?.id === shopId, "GET by id returns the right item");

    // ----------------------------------------------------------------------
    // PATCH status:"bought" stamps boughtAt; PATCH status:"needed" clears it
    // ----------------------------------------------------------------------
    const bought = await PATCH(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`, { status: "bought" });
    check(bought.status === 200, `PATCH status:"bought" → 200 (got ${bought.status})`);
    check(bought.body.item?.status === "bought", "PATCH reflects status:bought");
    check(typeof bought.body.item?.boughtAt === "string", "PATCH stamps boughtAt when status flips to bought");

    const backToNeeded = await PATCH(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`, { status: "needed" });
    check(backToNeeded.status === 200, `PATCH status:"needed" → 200 (got ${backToNeeded.status})`);
    check(backToNeeded.body.item?.status === "needed", "PATCH reflects status:needed");
    check(backToNeeded.body.item?.boughtAt === undefined, "boughtAt clears when status flips away from bought");

    // ----------------------------------------------------------------------
    // PATCH with a deliberately-wrong expectedVersion → 409
    // ----------------------------------------------------------------------
    const conflict = await PATCH(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`, {
      note: "should not land",
      expectedVersion: -1, // never a legitimate version — guaranteed stale regardless of board state
    });
    check(conflict.status === 409, `PATCH with a stale expectedVersion → 409 (got ${conflict.status})`);

    // ----------------------------------------------------------------------
    // POST with a dangling sourceRef → 201 fine, reads fine (a SOFT ref, never validated)
    // ----------------------------------------------------------------------
    const dangling = await POST("/api/nutrition/shopping", {
      name: "Fixture dangling-ref item",
      sourceRef: "MEAL-999999",
    });
    check(dangling.status === 201, `POST with a dangling sourceRef → 201 (got ${dangling.status})`);
    check(dangling.body.item?.sourceRef === "MEAL-999999", "the dangling sourceRef persists as given");
    const danglingId = dangling.body.item?.id;
    const danglingRead = await GET(`/api/nutrition/shopping/${encodeURIComponent(danglingId)}`);
    check(
      danglingRead.status === 200,
      `GET the dangling-ref item → 200, no error on the dangling ref (got ${danglingRead.status})`,
    );

    // ----------------------------------------------------------------------
    // Candidates: an invented ingredient in a planned in-window meal appears; adding it to
    // the list suppresses it; two back-to-back reads persist nothing.
    // ----------------------------------------------------------------------
    const meal = await POST("/api/nutrition/plan", {
      date: TODAY,
      slot: "dinner",
      title: "Fixture candidate meal",
      ingredients: [INVENTED_INGREDIENT],
    });
    check(meal.status === 201, `seed a planned meal for TODAY → 201 (got ${meal.status})`);
    const mealId = meal.body.entry?.id;

    const cand1 = await GET(`/api/nutrition/shopping/candidates?from=${TODAY}&to=${TODAY}`);
    check(cand1.status === 200, `GET /api/nutrition/shopping/candidates → 200 (got ${cand1.status})`);
    check(cand1.body.window?.from === TODAY && cand1.body.window?.to === TODAY, "the window is echoed back");
    const foundCandidate = (cand1.body.candidates || []).find((c) => c.name === INVENTED_INGREDIENT);
    check(!!foundCandidate, "the invented ingredient surfaces as a plan-side candidate");
    check(foundCandidate?.source === "plan", "the candidate's source is 'plan'");
    check(foundCandidate?.sourceRef === mealId, "the candidate's sourceRef names the seeded meal");
    check(foundCandidate?.inferred === false, "a plan-side candidate is never marked inferred");

    const addCandidate = await POST("/api/nutrition/shopping", {
      name: INVENTED_INGREDIENT,
      source: "plan",
      sourceRef: mealId,
    });
    check(addCandidate.status === 201, `add the candidate to the list → 201 (got ${addCandidate.status})`);

    const cand2 = await GET(`/api/nutrition/shopping/candidates?from=${TODAY}&to=${TODAY}`);
    check(
      !(cand2.body.candidates || []).some((c) => c.name === INVENTED_INGREDIENT),
      "once on the list as 'needed', the same ingredient is suppressed on the next candidates read",
    );
    check(cand2.body.suppressed?.onList >= 1, "suppressed.onList counts it (relative — >= 1)");

    // Idempotence: two back-to-back reads (no write in between) return the SAME version.
    const cand3 = await GET(`/api/nutrition/shopping/candidates?from=${TODAY}&to=${TODAY}`);
    check(typeof cand2.body.version === "number", "candidates response carries a numeric version");
    check(
      cand2.body.version === cand3.body.version,
      `two back-to-back candidate GETs return the SAME version (${cand2.body.version} === ${cand3.body.version}) — persists nothing`,
    );

    // ----------------------------------------------------------------------
    // GATE: with the add-on DISABLED, POST → 404 while GET stays 200 (ungated).
    // ----------------------------------------------------------------------
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);

    const blockedPost = await POST("/api/nutrition/shopping", { name: "Blocked" });
    check(blockedPost.status === 404, `POST while disabled → 404 (got ${blockedPost.status})`);

    const readWhileDisabled = await GET("/api/nutrition/shopping");
    check(
      readWhileDisabled.status === 200,
      `GET /api/nutrition/shopping while disabled → 200 (got ${readWhileDisabled.status})`,
    );
    const candidatesWhileDisabled = await GET(`/api/nutrition/shopping/candidates?from=${TODAY}&to=${TODAY}`);
    check(
      candidatesWhileDisabled.status === 200,
      `GET .../candidates while disabled → 200 (got ${candidatesWhileDisabled.status})`,
    );

    // Re-ENABLE for the delete lifecycle below.
    const reEnable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable → 200 (got ${reEnable.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET (404 on re-GET)
    // ----------------------------------------------------------------------
    const del = await DELETE(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`);
    check(del.status === 200, `DELETE /api/nutrition/shopping/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE returns { ok:true }");
    const goneList = await GET("/api/nutrition/shopping");
    check(
      !(goneList.body.items || []).some((x) => x.id === shopId),
      "the deleted item drops from GET /api/nutrition/shopping",
    );
    const goneDetail = await GET(`/api/nutrition/shopping/${encodeURIComponent(shopId)}`);
    check(goneDetail.status === 404, `GET the deleted item → 404 (got ${goneDetail.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — the v16 shopping list + candidates API hold (create/list/get/patch/gate/delete + candidates suppression + idempotence).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
