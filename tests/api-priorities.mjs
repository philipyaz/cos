#!/usr/bin/env node
// api-priorities.mjs — end-to-end lifecycle test of the priorities HTTP API (v7).
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path (board/app/api/
// priorities/**) against a RUNNING board and asserts the priorities contract end-
// to-end. "Priorities" are TWO complementary mechanisms over the existing board:
//   (1) STAR a node — a favorite/pin toggle on ANY case/workstream/initiative (all
//       three tiers are CaseRecords in one id space; PATCH /api/cases/{id} { starred });
//   (2) PRIORITY NOTES — free-text "what matters most right now" items in db.priorities
//       (PriorityNote in board/lib/types.ts — lighter than a Reminder: no status/link/
//       tasks/labels). The GET surfaces BOTH in one call:
//   • create note { text } → 201; id matches PRI-<n>; db.version increments
//   • GET /api/priorities    → 200, `priorities` is an array carrying the created id,
//                              AND a `starred` array (the favorited nodes)
//   • PATCH text + position   → 200, both persist on a re-GET, version bumps
//   • star a REAL case        → PATCH /api/cases/{id} { starred:true } → GET /api/priorities
//                              `starred` lists it; { starred:false } removes it again
//   • validation              → missing text → 400, non-number position → 400,
//                              PATCH unknown PRI → 404, DELETE unknown PRI → 404
//   • DELETE                  → 200; the id no longer appears in GET /api/priorities
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero) — db.priorities lives in cases.json
// alongside the cases (and CaseRecord.starred too). Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-priorities.mjs    # CRM_BASE_URL defaults to http://localhost:3000
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

// all priority notes currently on the board
const listPriorities = async () => (await GET("/api/priorities")).body.priorities || [];
const priorityIds = (priorities) => new Set(priorities.map((p) => p.id));

const PRI_ID_RE = /^PRI-\d+$/;

async function main() {
  console.log(`api-priorities · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.priorities + the
  // CaseRecord.starred flags both live in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // create note { text } → 201, PRI-<n> id, version increments
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/priorities")).body.version;
    check(typeof v0 === "number", `GET /api/priorities returns a numeric version (${v0})`);

    const marker = `apipri-${Date.now()}`;
    const created = await POST("/api/priorities", { text: `ship the v7 release ${marker}` });
    check(created.status === 201, `POST /api/priorities → 201 (got ${created.status})`);
    const pri = created.body.priority;
    check(!!pri?.id, `create returned a priority id (${pri?.id})`);
    check(PRI_ID_RE.test(pri?.id || ""), `priority id matches PRI-<n> (${pri?.id})`);
    check(pri?.text === `ship the v7 release ${marker}`, "created note persisted text");
    // Contract: every mutation response carries the NEW db.version (post-write).
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    // Independently: the persisted version must have advanced (a re-read sees more).
    const vAfterCreate = (await GET("/api/priorities")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const priId = pri.id;

    // ----------------------------------------------------------------------
    // GET /api/priorities → a `priorities` array containing it AND a `starred` array
    // ----------------------------------------------------------------------
    const listed = await GET("/api/priorities");
    check(listed.status === 200, `GET /api/priorities → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.priorities), "GET /api/priorities returns a priorities array");
    check(priorityIds(listed.body.priorities).has(priId), "the created note is in the priorities list");
    check(Array.isArray(listed.body.starred), "GET /api/priorities returns a starred array");

    // ----------------------------------------------------------------------
    // PATCH text + position → 200, both persist on a re-GET, version bumps
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/priorities")).body.version;
    const newText = `ship v7 THIS week ${marker}`;
    const patched = await PATCH(`/api/priorities/${encodeURIComponent(priId)}`, {
      text: newText,
      position: 3,
    });
    check(patched.status === 200, `PATCH /api/priorities/:id → 200 (got ${patched.status})`);
    check(patched.body.priority?.text === newText, "PATCH response reflects the new text");
    check(patched.body.priority?.position === 3, "PATCH response reflects the new position");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await listPriorities()).find((p) => p.id === priId);
    check(reread?.text === newText, "re-GET shows the persisted new text");
    check(reread?.position === 3, "re-GET shows the persisted new position");

    // ----------------------------------------------------------------------
    // STAR flow → PATCH a star onto a REAL existing case; GET `starred` lists it,
    //             then { starred:false } removes it from `starred`. (Starring needs
    //             NO route change: applyCaseUpdate handles `starred` on the case.)
    // ----------------------------------------------------------------------
    const realCases = (await GET("/api/cases")).body.cases || [];
    check(realCases.length > 0, `GET /api/cases returned at least one case (${realCases.length})`);
    const starCaseId = realCases[0]?.id;

    const starOn = await PATCH(`/api/cases/${encodeURIComponent(starCaseId)}`, { starred: true });
    check(starOn.status === 200, `PATCH /api/cases/:id { starred:true } → 200 (got ${starOn.status})`);
    const afterStar = await GET("/api/priorities");
    check(
      Array.isArray(afterStar.body.starred) &&
        afterStar.body.starred.some((c) => c.id === starCaseId),
      "GET /api/priorities `starred` lists the starred case",
    );

    const starOff = await PATCH(`/api/cases/${encodeURIComponent(starCaseId)}`, { starred: false });
    check(starOff.status === 200, `PATCH /api/cases/:id { starred:false } → 200 (got ${starOff.status})`);
    const afterUnstar = await GET("/api/priorities");
    check(
      Array.isArray(afterUnstar.body.starred) &&
        !afterUnstar.body.starred.some((c) => c.id === starCaseId),
      "after unstar the case drops from GET /api/priorities `starred`",
    );

    // ----------------------------------------------------------------------
    // validation → 400s / 404s
    // ----------------------------------------------------------------------
    const noText = await POST("/api/priorities", { position: 1 });
    check(noText.status === 400, `POST missing text → 400 (got ${noText.status})`);

    const emptyText = await POST("/api/priorities", { text: "   " });
    check(emptyText.status === 400, `POST blank text → 400 (got ${emptyText.status})`);

    const badPosition = await POST("/api/priorities", {
      text: `bad-position ${marker}`,
      position: "soon",
    });
    check(badPosition.status === 400, `POST position:"soon" (non-number) → 400 (got ${badPosition.status})`);

    const patchUnknown = await PATCH(`/api/priorities/PRI-99999`, { text: "ghost" });
    check(patchUnknown.status === 404, `PATCH unknown PRI-99999 → 404 (got ${patchUnknown.status})`);

    const deleteUnknown = await DELETE(`/api/priorities/PRI-99999`);
    check(deleteUnknown.status === 404, `DELETE unknown PRI-99999 → 404 (got ${deleteUnknown.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET /api/priorities
    // ----------------------------------------------------------------------
    const before = priorityIds(await listPriorities());
    check(before.has(priId), "seed note is in the list before delete");
    const del = await DELETE(`/api/priorities/${encodeURIComponent(priId)}`);
    check(del.status === 200, `DELETE /api/priorities/:id → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE response carries { ok:true }");
    const afterDel = priorityIds(await listPriorities());
    check(!afterDel.has(priId), "deleted note drops from GET /api/priorities");
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} priority check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — priorities API holds (create/list/patch text+position/star/unstar/validate/delete).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
