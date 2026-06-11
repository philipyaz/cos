#!/usr/bin/env node
// api-events.mjs — end-to-end lifecycle test of the v4 calendar-events HTTP API.
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path (board/app/api/events/**)
// against a RUNNING board and asserts the v4 calendar-event contract end-to-end,
// using OUR field names (CalendarEvent in board/lib/types.ts):
//   • create_event (allDay)       → 201; id matches EVT-<n>; db.version increments
//   • list /api/events            → 200, events is an array carrying the created id;
//                                   the from/to and caseId filters narrow correctly
//   • PATCH title/description      → 200, persisted on a re-GET, version bumps
//   • link to a REAL case          → 201; the link sticks; the case GET lists the
//                                   event in its `events` array
//   • validation                   → bad caseId / missing title / bad date / bad
//                                   HH:MM startTime all 400 (with the right field)
//   • DELETE                       → 200; the id no longer appears in GET /api/events
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero) — db.events lives in cases.json
// alongside the cases. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-events.mjs        # CRM_BASE_URL defaults to http://localhost:3000
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

// all calendar events currently on the board
const listEvents = async () => (await GET("/api/events")).body.events || [];
const eventIds = (events) => new Set(events.map((e) => e.id));

const EVT_ID_RE = /^EVT-\d+$/;

async function main() {
  console.log(`api-events · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.events lives in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // create_event (allDay) → 201, EVT-<n> id, version increments
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/events")).body.version;
    check(typeof v0 === "number", `GET /api/events returns a numeric version (${v0})`);

    const marker = `apievents-${Date.now()}`;
    const created = await POST("/api/events", {
      title: `API events ${marker}`,
      date: "2026-06-15",
      allDay: true,
      description: `seed event ${marker}`,
    });
    check(created.status === 201, `POST /api/events → 201 (got ${created.status})`);
    const evt = created.body.event;
    check(!!evt?.id, `create returned an event id (${evt?.id})`);
    check(EVT_ID_RE.test(evt?.id || ""), `event id matches EVT-<n> (${evt?.id})`);
    check(evt?.date === "2026-06-15", "created event persisted date");
    check(evt?.allDay === true, "created event persisted allDay:true");
    // Contract: every mutation response carries the NEW db.version (post-write).
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    // Independently: the persisted version must have advanced (a re-read sees more).
    const vAfterCreate = (await GET("/api/events")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const evtId = evt.id;

    // ----------------------------------------------------------------------
    // GET /api/events → array containing the created id
    // ----------------------------------------------------------------------
    const listed = await GET("/api/events");
    check(listed.status === 200, `GET /api/events → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.events), "GET /api/events returns an events array");
    check(eventIds(listed.body.events).has(evtId), "the created event is in the list");

    // from/to window filters on e.date — the half-open interval [from, to).
    const inWindow = await GET("/api/events?from=2026-06-01&to=2026-07-01");
    check(
      eventIds(inWindow.body.events || []).has(evtId),
      "from/to window [2026-06-01, 2026-07-01) includes the 2026-06-15 event",
    );
    const beforeWindow = await GET("/api/events?from=2026-01-01&to=2026-06-15");
    check(
      !eventIds(beforeWindow.body.events || []).has(evtId),
      "from/to is half-open: to=2026-06-15 EXCLUDES the 2026-06-15 event",
    );
    const afterWindow = await GET("/api/events?from=2026-06-16&to=2026-07-01");
    check(
      !eventIds(afterWindow.body.events || []).has(evtId),
      "from=2026-06-16 excludes the earlier 2026-06-15 event",
    );

    // ----------------------------------------------------------------------
    // PATCH title/description → 200, persisted on a re-GET, version bumps
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/events")).body.version;
    const newTitle = `API events PATCHED ${marker}`;
    const newDesc = `patched description ${marker}`;
    const patched = await PATCH(`/api/events/${encodeURIComponent(evtId)}`, {
      title: newTitle,
      description: newDesc,
    });
    check(patched.status === 200, `PATCH /api/events/:id → 200 (got ${patched.status})`);
    check(patched.body.event?.title === newTitle, "PATCH response reflects the new title");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/events/${encodeURIComponent(evtId)}`)).body.event;
    check(reread?.title === newTitle, "re-GET shows the persisted new title");
    check(reread?.description === newDesc, "re-GET shows the persisted new description");

    // ----------------------------------------------------------------------
    // link flow → create an event with caseId on a REAL existing case
    // ----------------------------------------------------------------------
    const realCases = (await GET("/api/cases")).body.cases || [];
    check(realCases.length > 0, `GET /api/cases returned at least one case (${realCases.length})`);
    const linkCaseId = realCases[0]?.id;

    const linked = await POST("/api/events", {
      title: `API events linked ${marker}`,
      date: "2026-06-20",
      caseId: linkCaseId,
    });
    check(linked.status === 201, `POST linked event → 201 (got ${linked.status})`);
    const linkedId = linked.body.event?.id;
    check(linked.body.event?.caseId === linkCaseId, "the caseId link sticks on the created event");

    // caseId filter narrows to the linked event.
    const byCase = await GET(`/api/events?caseId=${encodeURIComponent(linkCaseId)}`);
    check(
      eventIds(byCase.body.events || []).has(linkedId),
      "caseId filter returns the linked event",
    );
    check(
      !eventIds(byCase.body.events || []).has(evtId),
      "caseId filter excludes the unlinked seed event",
    );

    // The case GET surfaces the event in its `events` array (caseId is the SOT).
    const caseDetail = (await GET(`/api/cases/${encodeURIComponent(linkCaseId)}`)).body;
    check(
      Array.isArray(caseDetail.events) && caseDetail.events.some((e) => e.id === linkedId),
      "the linked case GET lists the event in its `events` array",
    );

    // ----------------------------------------------------------------------
    // validation → 400s with the right field
    // ----------------------------------------------------------------------
    const badCase = await POST("/api/events", {
      title: `bad-case ${marker}`,
      date: "2026-06-21",
      caseId: "CASE-99999",
    });
    check(badCase.status === 400, `POST caseId:"CASE-99999" → 400 (got ${badCase.status})`);
    check(
      /case/i.test(badCase.body.error || ""),
      `the bad-caseId error mentions the case ("${badCase.body.error}")`,
    );

    const noTitle = await POST("/api/events", { date: "2026-06-22" });
    check(noTitle.status === 400, `POST missing title → 400 (got ${noTitle.status})`);

    const badDate = await POST("/api/events", { title: `bad-date ${marker}`, date: "nonsense" });
    check(badDate.status === 400, `POST date:"nonsense" → 400 (got ${badDate.status})`);

    const badTime = await POST("/api/events", {
      title: `bad-time ${marker}`,
      date: "2026-06-23",
      allDay: false,
      startTime: "9am",
    });
    check(badTime.status === 400, `POST { allDay:false, startTime:"9am" } → 400 (got ${badTime.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET /api/events
    // ----------------------------------------------------------------------
    const before = eventIds(await listEvents());
    check(before.has(evtId), "seed event is in the list before delete");
    const del = await DELETE(`/api/events/${encodeURIComponent(evtId)}`);
    check(del.status === 200, `DELETE /api/events/:id → 200 (got ${del.status})`);
    const afterDel = eventIds(await listEvents());
    check(!afterDel.has(evtId), "deleted event drops from GET /api/events");
    const goneDetail = await GET(`/api/events/${encodeURIComponent(evtId)}`);
    check(goneDetail.status === 404, `GET the deleted event → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} calendar-event check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v4 calendar-events API holds (create/list/filter/patch/link/validate/delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
