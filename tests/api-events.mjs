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
//   • place (cos-ops#24)           → the engine-backed placement mode: earliest free
//                                   gap, overlap-safe against a seeded event AND a
//                                   just-placed one in the same run; 409 no_free_slot
//                                   on a fully-busy window; policy:"within" 409s a
//                                   non-working day (outside_working_hours); busyWindows
//                                   is honoured but NEVER persisted (quote-bound sentinel
//                                   check); explicit-times-vs-place and durationMin/
//                                   window-shape 400s. Every assertion runs against a day
//                                   PROVEN clean first (GET'd empty), never a hardcoded
//                                   date — the live store is not empty.
//   • status (cos-ops#47)          → PATCH accepts confirmed/tentative/cancelled and
//                                   rejects anything else (400); it round-trips through
//                                   a re-GET and the list; a cancelled event's own slot
//                                   is offered again by `place` — engine-through-route,
//                                   end-to-end; and a stdio JSON-RPC round trip against
//                                   the calendar MCP server proves update_event/get_event/
//                                   list_events all surface the value (never just that
//                                   something changed) and pre-validate a bad status
//                                   before the HTTP hop. The MCP sub-section degrades to
//                                   a SKIP (not a failure) when its deps aren't installed.
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero) — db.events lives in cases.json
// alongside the cases. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-events.mjs        # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");
const CALENDAR_SERVER = path.join(HERE, "..", "mcp", "calendar-server", "server.mjs");

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

// --- stdio JSON-RPC client (lifted verbatim from tests/api-vault.mjs — same framing) --------
// Speaks newline-delimited JSON-RPC over the child's stdin/stdout, exactly like the calendar
// MCP's own StdioServerTransport frames it: one JSON object per line on stdout; the server's
// ready banner + logs go to stderr, so stdout is a clean JSON-RPC channel.
function makeClient(child) {
  let nextId = 1;
  const pending = new Map();
  let buf = "";

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON line on stdout
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(payload);
      // Per-request guard so a hung server can't wedge the suite.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timed out waiting for response to ${method}`));
        }
      }, 15000);
    });
  };

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return { request, notify };
}

// Pull the flat text out of an MCP tool result's content array.
const resultText = (r) =>
  (r?.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");

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
    // PATCH status (cos-ops#47) → 200, persisted, round-trips through the list
    // ----------------------------------------------------------------------
    const patchedTentative = await PATCH(`/api/events/${encodeURIComponent(evtId)}`, {
      status: "tentative",
    });
    check(patchedTentative.status === 200, `PATCH { status: "tentative" } → 200 (got ${patchedTentative.status})`);
    check(patchedTentative.body.event?.status === "tentative", "PATCH response reflects status:tentative");
    const rereadTentative = (await GET(`/api/events/${encodeURIComponent(evtId)}`)).body.event;
    check(rereadTentative?.status === "tentative", "re-GET shows the persisted status:tentative");
    const listedTentative = await GET("/api/events");
    check(
      (listedTentative.body.events || []).find((e) => e.id === evtId)?.status === "tentative",
      "GET /api/events list carries status:tentative on that id (raw passthrough)",
    );

    const patchedCancelled = await PATCH(`/api/events/${encodeURIComponent(evtId)}`, {
      status: "cancelled",
    });
    check(patchedCancelled.status === 200, `PATCH { status: "cancelled" } → 200 (got ${patchedCancelled.status})`);
    const rereadCancelled = (await GET(`/api/events/${encodeURIComponent(evtId)}`)).body.event;
    check(rereadCancelled?.status === "cancelled", "re-GET shows the persisted status:cancelled");

    const badStatus = await PATCH(`/api/events/${encodeURIComponent(evtId)}`, {
      status: "nonsense",
    });
    check(badStatus.status === 400, `PATCH { status: "nonsense" } → 400 (got ${badStatus.status})`);
    check(
      /status/i.test(badStatus.body.error || ""),
      `the bad-status error mentions 'status' ("${badStatus.body.error}")`,
    );

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

    // ----------------------------------------------------------------------
    // place (cos-ops#24) — the engine-backed placement mode. `place` replaces
    // startTime/endTime with { durationMin, windows, busyWindows?, policy? } and lets
    // the board find the earliest free gap. The live store is not empty, so every
    // assertion below runs against a day PROVEN clean first, never a hardcoded date.
    // ----------------------------------------------------------------------
    const isWeekend = (dayISO) => {
      const [y, mo, d] = dayISO.split("-").map(Number);
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun..6=Sat
      return dow === 0 || dow === 6;
    };
    const isoWeekday = (dayISO) => {
      const [y, mo, d] = dayISO.split("-").map(Number);
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      return dow === 0 ? 7 : dow; // Mon=1..Sun=7
    };
    const addDaysISO = (dayISO, n) => {
      const [y, mo, d] = dayISO.split("-").map(Number);
      return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
    };
    async function findCleanWeekday(startDay) {
      let day = startDay;
      for (let i = 0; i < 60; i++) {
        if (!isWeekend(day)) {
          const win = await GET(`/api/events?from=${day}&to=${addDaysISO(day, 1)}`);
          if ((win.body.events || []).length === 0) return day;
        }
        day = addDaysISO(day, 1);
      }
      throw new Error(`Could not find a clean weekday within 60 days of ${startDay}.`);
    }

    const todayDay = new Date().toISOString().slice(0, 10);
    const cleanDay = await findCleanWeekday(addDaysISO(todayDay, 300));
    // The enclosing week's Saturday — a non-working day under DEFAULT_WORKING_HOURS,
    // regardless of whether it happens to carry other events (policy:"within" refuses
    // it outright, before any free-gap search).
    const saturday = addDaysISO(cleanDay, 6 - isoWeekday(cleanDay));

    // -- 2. Placed create: earliest gap, overlap-safe against a seeded event AND a
    // just-placed one in the SAME call sequence. --------------------------------
    const seeded = await POST("/api/events", {
      title: `place-seed ${marker}`,
      date: cleanDay,
      allDay: false,
      startTime: "10:00",
      endTime: "11:00",
    });
    check(seeded.status === 201, `place: seed an explicit 10:00-11:00 event → 201 (got ${seeded.status})`);
    const seededEvtId = seeded.body.event?.id;

    const placed1 = await POST("/api/events", {
      title: `place-1 ${marker}`,
      date: cleanDay,
      place: { durationMin: 60, windows: [{ start: "09:00", end: "12:00" }] },
    });
    check(placed1.status === 201, `place: first create → 201 (got ${placed1.status})`);
    check(
      placed1.body.event?.startTime === "09:00" && placed1.body.event?.endTime === "10:00",
      `place: lands in the earliest free gap, 09:00-10:00 (got ${placed1.body.event?.startTime}-${placed1.body.event?.endTime})`,
    );
    check(placed1.body.event?.allDay === false, "place: the placed event has allDay:false");
    const placed1EvtId = placed1.body.event?.id;

    const placed2 = await POST("/api/events", {
      title: `place-2 ${marker}`,
      date: cleanDay,
      place: { durationMin: 60, windows: [{ start: "09:00", end: "12:00" }] },
    });
    check(placed2.status === 201, `place: a second identical create → 201 (got ${placed2.status})`);
    check(
      placed2.body.event?.startTime === "11:00" && placed2.body.event?.endTime === "12:00",
      `place: overlap-safe against BOTH the seeded and the just-placed event, lands 11:00-12:00 (got ${placed2.body.event?.startTime}-${placed2.body.event?.endTime})`,
    );
    const placed2EvtId = placed2.body.event?.id;

    // -- 3. 409 no_free_slot: a window that is entirely busy skips, nothing is created. --
    const full = await POST("/api/events", {
      title: `place-full ${marker}`,
      date: cleanDay,
      place: { durationMin: 60, windows: [{ start: "10:00", end: "11:00" }] },
    });
    check(full.status === 409, `place: a fully-busy window → 409 (got ${full.status})`);
    check(full.body.reason === "no_free_slot", `place: reason is "no_free_slot" (got ${full.body.reason})`);
    const afterFull = await GET(`/api/events?from=${cleanDay}&to=${addDaysISO(cleanDay, 1)}`);
    check(
      (afterFull.body.events || []).length === 3,
      `place: the 409 created nothing — still exactly 3 events that day (got ${(afterFull.body.events || []).length})`,
    );

    // -- 4. `within` refuses a non-working day outright (live settings.workingHours is
    // absent, so the engine default Mon-Fri applies — assert on the reason, not hours). --
    const satPlace = await POST("/api/events", {
      title: `place-saturday ${marker}`,
      date: saturday,
      place: { durationMin: 60, windows: [{ start: "09:00", end: "17:00" }], policy: "within" },
    });
    check(satPlace.status === 409, `place: policy "within" on a Saturday → 409 (got ${satPlace.status})`);
    check(
      satPlace.body.reason === "outside_working_hours",
      `place: reason is "outside_working_hours" (got ${satPlace.body.reason})`,
    );

    // -- 5. busyWindows honoured and NEVER persisted (a fresh clean day, so the only
    // busy time in play is the one this call supplies). ---------------------------
    const cleanDay2 = await findCleanWeekday(addDaysISO(cleanDay, 1));
    const busyPlaced = await POST("/api/events", {
      title: `place-busywindows ${marker}`,
      date: cleanDay2,
      place: {
        durationMin: 60,
        windows: [{ start: "09:00", end: "12:00" }],
        busyWindows: [{ date: cleanDay2, start: "07:53", end: "10:30" }],
      },
    });
    check(busyPlaced.status === 201, `place: busyWindows create → 201 (got ${busyPlaced.status})`);
    check(
      busyPlaced.body.event?.startTime === "10:30",
      `place: the busy window pushes placement past it, to 10:30 (got ${busyPlaced.body.event?.startTime})`,
    );
    const busyPlacedEvtId = busyPlaced.body.event?.id;

    // Quote-bound sentinel (ADR 0021 / cos#81's trap): a bare 07:53 collides with any
    // ISO timestamp minted during this run (e.g. "...T07:53:12.345Z"); '"07:53"' matches
    // only a complete JSON string value, so it proves the busy INPUT was never written.
    const rawStore = await fs.readFile(DATA_FILE, "utf8");
    check(rawStore.includes('"10:30"'), "place: the placed 10:30 startTime IS persisted");
    check(!rawStore.includes('"07:53"'), "place: the busyWindows input is NEVER persisted anywhere in the store");

    // -- 6. Validation 400s. -------------------------------------------------------
    const placeAndStart = await POST("/api/events", {
      title: `place-and-start ${marker}`,
      date: cleanDay2,
      startTime: "09:00",
      place: { durationMin: 60, windows: [{ start: "09:00", end: "12:00" }] },
    });
    check(placeAndStart.status === 400, `place: explicit startTime + place → 400 (got ${placeAndStart.status})`);

    const placeAndAllDay = await POST("/api/events", {
      title: `place-and-allday ${marker}`,
      date: cleanDay2,
      allDay: true,
      place: { durationMin: 60, windows: [{ start: "09:00", end: "12:00" }] },
    });
    check(placeAndAllDay.status === 400, `place: allDay:true + place → 400 (got ${placeAndAllDay.status})`);

    const badDuration = await POST("/api/events", {
      title: `place-bad-duration ${marker}`,
      date: cleanDay2,
      place: { durationMin: 10, windows: [{ start: "09:00", end: "12:00" }] },
    });
    check(badDuration.status === 400, `place: durationMin outside [15,240] → 400 (got ${badDuration.status})`);

    const badWindow = await POST("/api/events", {
      title: `place-bad-window ${marker}`,
      date: cleanDay2,
      place: { durationMin: 60, windows: [{ start: "12:00", end: "09:00" }] },
    });
    check(badWindow.status === 400, `place: window start >= end → 400 (got ${badWindow.status})`);

    // -- 7. cos-ops#47 — a cancelled event's slot is offered again: engine-through-route,
    // end-to-end. A fresh clean weekday so this is independent of the busy-set left by the
    // steps above. -------------------------------------------------------------------------
    const cleanDay3 = await findCleanWeekday(addDaysISO(cleanDay2, 1));
    const cancelSeed = await POST("/api/events", {
      title: `place-cancel-seed ${marker}`,
      date: cleanDay3,
      allDay: false,
      startTime: "10:00",
      endTime: "11:00",
    });
    check(cancelSeed.status === 201, `place: seed a 10:00-11:00 event to cancel → 201 (got ${cancelSeed.status})`);
    const cancelSeedEvtId = cancelSeed.body.event?.id;
    const cancelPatch = await PATCH(`/api/events/${encodeURIComponent(cancelSeedEvtId)}`, {
      status: "cancelled",
    });
    check(cancelPatch.status === 200, `place: cancel the seed → 200 (got ${cancelPatch.status})`);
    const placedOverCancelled = await POST("/api/events", {
      title: `place-over-cancelled ${marker}`,
      date: cleanDay3,
      place: { durationMin: 60, windows: [{ start: "10:00", end: "11:00" }] },
    });
    check(
      placedOverCancelled.status === 201,
      `place: a cancelled meeting's slot is offered again — end-to-end (got ${placedOverCancelled.status})`,
    );
    check(
      placedOverCancelled.body.event?.startTime === "10:00",
      `place: lands at 10:00, the cancelled event's own slot (got ${placedOverCancelled.body.event?.startTime})`,
    );
    const placedOverCancelledEvtId = placedOverCancelled.body.event?.id;

    // Cleanup: the snapshot restore below backstops regardless, but tidy exit is cheap.
    for (const id of [
      seededEvtId, placed1EvtId, placed2EvtId, busyPlacedEvtId, cancelSeedEvtId, placedOverCancelledEvtId,
    ].filter(Boolean)) {
      await DELETE(`/api/events/${encodeURIComponent(id)}`);
    }

    // ----------------------------------------------------------------------
    // MCP half (cos-ops#47) — a stdio JSON-RPC round trip against the calendar server itself,
    // proving status renders (not just "something changed") and pre-validates before the HTTP
    // hop. Lifted mechanics from tests/api-vault.mjs: the early-exit race degrades this WHOLE
    // sub-section to a SKIP (not a failure) when @modelcontextprotocol/sdk isn't installed —
    // CI always exercises it (npm ci runs at the repo root); the HTTP checks above already
    // counted regardless. The child is killed in ITS OWN try/finally, nested inside this
    // function's outer try — so it is reaped BEFORE the outer `finally`'s snapshot restore
    // below ever runs, and a late child write can never land on a restored store.
    // ----------------------------------------------------------------------
    const mcpEnv = { ...process.env, CRM_BASE_URL: BASE };
    const mcpChild = spawn(process.execPath, [CALENDAR_SERVER], { env: mcpEnv, stdio: ["pipe", "pipe", "pipe"] });
    let mcpStderr = "";
    mcpChild.stderr.on("data", (d) => (mcpStderr += d.toString("utf8")));
    const mcpExited = new Promise((resolve) => mcpChild.on("exit", (code) => resolve(code)));
    const mcpEarlyExit = await Promise.race([mcpExited, new Promise((r) => setTimeout(() => r(null), 2500))]);
    if (mcpEarlyExit !== null) {
      if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(mcpStderr)) {
        console.log(
          "\nSKIP (calendar MCP deps not installed — npm install at the repo root) — skipping the calendar MCP sub-section only.",
        );
      } else {
        failures++;
        console.error(`\n✗ calendar MCP server exited early (code ${mcpEarlyExit}):\n${mcpStderr}`);
      }
    } else {
      const mcpClient = makeClient(mcpChild);
      try {
        const init = await mcpClient.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "api-events-test", version: "1.0.0" },
        });
        check(
          init?.serverInfo?.name === "calendar",
          `MCP initialize → serverInfo.name === "calendar" (got '${init?.serverInfo?.name}')`,
        );
        mcpClient.notify("notifications/initialized", {});

        const mcpSeed = await POST("/api/events", {
          title: `mcp-status ${marker}`,
          date: "2026-06-25",
          allDay: false,
          startTime: "15:00",
          endTime: "16:00",
        });
        check(mcpSeed.status === 201, `MCP: seed an event over HTTP → 201 (got ${mcpSeed.status})`);
        const mcpEvtId = mcpSeed.body.event?.id;

        const mcpUpdate = await mcpClient.request("tools/call", {
          name: "update_event",
          arguments: { id: mcpEvtId, status: "tentative" },
        });
        check(mcpUpdate?.isError !== true, "MCP: update_event { status: 'tentative' } is not an error");
        check(
          resultText(mcpUpdate).includes("Status: tentative"),
          `MCP: update_event's result echoes the new VALUE, "Status: tentative" (got "${resultText(mcpUpdate)}")`,
        );

        const mcpReGet = await GET(`/api/events/${encodeURIComponent(mcpEvtId)}`);
        check(
          mcpReGet.body.event?.status === "tentative",
          "MCP: the HTTP re-GET shows status:tentative — the MCP write round-trips through the API",
        );

        const mcpGetEvent = await mcpClient.request("tools/call", {
          name: "get_event",
          arguments: { id: mcpEvtId },
        });
        check(
          resultText(mcpGetEvent).includes("Status: tentative"),
          `MCP: get_event renders "Status: tentative" (got "${resultText(mcpGetEvent)}")`,
        );

        const mcpList = await mcpClient.request("tools/call", {
          name: "list_events",
          arguments: { from: "2026-06-25", to: "2026-06-26" },
        });
        check(
          resultText(mcpList).includes("[tentative]"),
          `MCP: list_events carries the "[tentative]" marker on that event's line (got "${resultText(mcpList)}")`,
        );

        const mcpBadStatus = await mcpClient.request("tools/call", {
          name: "update_event",
          arguments: { id: mcpEvtId, status: "bogus" },
        });
        check(mcpBadStatus?.isError === true, "MCP: update_event { status: 'bogus' } is a tool error (pre-hop validation)");
        check(
          /status/i.test(resultText(mcpBadStatus)),
          `MCP: the bad-status tool error names 'status' (got "${resultText(mcpBadStatus)}")`,
        );

        await DELETE(`/api/events/${encodeURIComponent(mcpEvtId)}`);
      } finally {
        mcpChild.stdin.end();
        mcpChild.kill();
      }
    }
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} calendar-event check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — v4 calendar-events API holds (create/list/filter/patch/link/validate/delete, " +
      "place: earliest-gap/overlap/409-reasons/busyWindows-not-persisted/validation, " +
      "status: HTTP round-trip/validation/engine-through-route/MCP round-trip).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
