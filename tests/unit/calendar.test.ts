// Unit tests for the calendar-event selectors (v4): the pure projection layer over
// a flat CalendarEvent[] (eventsByCaseId, eventsForDay, eventsByDateRange,
// upcomingEvents, monthGrid, todayISO). Pure / in-memory — nothing reads
// board/data; every time-relative helper takes a FIXED `now` so the suite is
// deterministic. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/calendar.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventsByCaseId,
  eventsForDay,
  eventsByDateRange,
  upcomingEvents,
  monthGrid,
  todayISO,
} from "../../board/lib/selectors.ts";
import type { CalendarEvent } from "../../board/lib/types.ts";

// In-memory fixture builder (no store reads). Defaults make an all-day event with
// no case link; `over` pins the fields a given test cares about.
let seq = 0;
function evt(over: Partial<CalendarEvent> & { date: string }): CalendarEvent {
  seq += 1;
  return {
    id: `EVT-${seq}`,
    title: `event ${seq}`,
    allDay: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// ── eventsByCaseId ──────────────────────────────────────────────────────────────
test("eventsByCaseId — filters by caseId (the case<->event link source of truth)", () => {
  const events = [
    evt({ date: "2026-06-01", caseId: "CASE-1" }),
    evt({ date: "2026-06-02", caseId: "CASE-2" }),
    evt({ date: "2026-06-03", caseId: "CASE-1" }),
    evt({ date: "2026-06-04" }), // unlinked
  ];
  assert.deepEqual(
    eventsByCaseId(events, "CASE-1").map((e) => e.date),
    ["2026-06-01", "2026-06-03"],
  );
  assert.deepEqual(eventsByCaseId(events, "CASE-2").map((e) => e.date), ["2026-06-02"]);
  assert.deepEqual(eventsByCaseId(events, "CASE-404"), []); // none linked
});

// ── eventsForDay ────────────────────────────────────────────────────────────────
test("eventsForDay — only that day, all-day first then by startTime ascending", () => {
  const events = [
    evt({ id: "EVT-A", date: "2026-06-15", allDay: false, startTime: "14:00" }),
    evt({ id: "EVT-B", date: "2026-06-15", allDay: true }),
    evt({ id: "EVT-C", date: "2026-06-15", allDay: false, startTime: "09:30" }),
    evt({ id: "EVT-OTHER", date: "2026-06-16", allDay: false, startTime: "08:00" }),
  ];
  const day = eventsForDay(events, "2026-06-15");
  // Other-day event excluded; all-day sorts first, then 09:30 then 14:00.
  assert.deepEqual(day.map((e) => e.id), ["EVT-B", "EVT-C", "EVT-A"]);
});

test("eventsForDay — empty for a day with no events", () => {
  const events = [evt({ date: "2026-06-15" })];
  assert.deepEqual(eventsForDay(events, "2026-06-20"), []);
});

// ── eventsByDateRange ───────────────────────────────────────────────────────────
test("eventsByDateRange — half-open [start, end): start inclusive, end exclusive", () => {
  const events = [
    evt({ id: "EVT-1", date: "2026-06-01" }),
    evt({ id: "EVT-2", date: "2026-06-10" }),
    evt({ id: "EVT-3", date: "2026-06-15" }), // == end → excluded
    evt({ id: "EVT-4", date: "2026-05-31" }), // before start → excluded
  ];
  const out = eventsByDateRange(events, "2026-06-01", "2026-06-15");
  assert.deepEqual(out.map((e) => e.id), ["EVT-1", "EVT-2"]);
});

test("eventsByDateRange — sorts by date then startTime (all-day/time-less first)", () => {
  const events = [
    evt({ id: "EVT-LATE", date: "2026-06-02", allDay: false, startTime: "17:00" }),
    evt({ id: "EVT-EARLY", date: "2026-06-02", allDay: false, startTime: "08:00" }),
    evt({ id: "EVT-ALLDAY", date: "2026-06-02", allDay: true }),
    evt({ id: "EVT-FIRSTDAY", date: "2026-06-01", allDay: false, startTime: "23:00" }),
  ];
  const out = eventsByDateRange(events, "2026-06-01", "2026-06-03");
  // Day 06-01 first (despite late time), then 06-02 all-day, 08:00, 17:00.
  assert.deepEqual(out.map((e) => e.id), ["EVT-FIRSTDAY", "EVT-ALLDAY", "EVT-EARLY", "EVT-LATE"]);
});

// ── upcomingEvents ──────────────────────────────────────────────────────────────
test("upcomingEvents — windows [today, today+daysAhead] inclusive with a FIXED now", () => {
  // Fixed now = 2026-06-10 (UTC). A 7-day window covers 2026-06-10 .. 2026-06-17.
  const now = new Date("2026-06-10T12:00:00.000Z");
  const events = [
    evt({ id: "EVT-PAST", date: "2026-06-09" }), // yesterday → excluded
    evt({ id: "EVT-TODAY", date: "2026-06-10" }), // today → included (near edge)
    evt({ id: "EVT-MID", date: "2026-06-14" }),
    evt({ id: "EVT-EDGE", date: "2026-06-17" }), // today+7 → included (far edge)
    evt({ id: "EVT-FAR", date: "2026-06-18" }), // day 8 → excluded
  ];
  const out = upcomingEvents(events, 7, now);
  assert.deepEqual(out.map((e) => e.id), ["EVT-TODAY", "EVT-MID", "EVT-EDGE"]);
});

test("upcomingEvents — daysAhead 0 is just today; the past is excluded", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");
  const events = [
    evt({ id: "EVT-Y", date: "2026-06-09" }),
    evt({ id: "EVT-T", date: "2026-06-10" }),
    evt({ id: "EVT-TM", date: "2026-06-11" }),
  ];
  assert.deepEqual(upcomingEvents(events, 0, now).map((e) => e.id), ["EVT-T"]);
});

// ── monthGrid ───────────────────────────────────────────────────────────────────
test("monthGrid — whole 7-cell weeks with correct inMonth flags (June 2026, Mon start)", () => {
  // June 1, 2026 is a Monday, so a Monday-start grid begins exactly on the 1st: 30
  // days → 5 whole weeks of 7 (no leading pad; trailing pad into July).
  const grid = monthGrid(2026, 5); // monthIndex 5 = June, weekStartsOn defaults to 1 (Mon)
  assert.equal(grid.length, 5, "5 weeks");
  assert.ok(grid.every((week) => week.length === 7), "every week has 7 cells");

  const flat = grid.flat();
  assert.equal(flat.length, 35, "35 cells total");
  assert.equal(flat.filter((c) => c.inMonth).length, 30, "30 in-month cells (June has 30 days)");

  // First cell is June 1 (in month); last cell trails into July (out of month).
  assert.deepEqual(grid[0][0], { date: "2026-06-01", inMonth: true, day: 1 });
  assert.deepEqual(grid[4][6], { date: "2026-07-05", inMonth: false, day: 5 });
});

test("monthGrid — leading pad from the previous month when the 1st isn't the week start", () => {
  // Feb 1, 2026 is a Sunday; a Monday-start grid pads 6 leading days from January.
  const grid = monthGrid(2026, 1); // February
  assert.ok(grid.every((week) => week.length === 7), "every week has 7 cells");
  // The grid opens on the preceding Monday (2026-01-26), out of month.
  assert.deepEqual(grid[0][0], { date: "2026-01-26", inMonth: false, day: 26 });
  assert.equal(grid.flat().filter((c) => c.inMonth).length, 28, "28 in-month cells (Feb 2026)");
});

test("monthGrid — weekStartsOn 0 (Sunday) shifts the leading pad", () => {
  // June 1, 2026 is a Monday; a SUNDAY-start grid pads exactly one leading day
  // (the preceding Sunday, 2026-05-31).
  const grid = monthGrid(2026, 5, 0);
  assert.ok(grid.every((week) => week.length === 7), "every week has 7 cells");
  assert.deepEqual(grid[0][0], { date: "2026-05-31", inMonth: false, day: 31 });
  assert.equal(grid.flat().filter((c) => c.inMonth).length, 30, "still 30 in-month cells");
});

// ── todayISO ────────────────────────────────────────────────────────────────────
test("todayISO — UTC 'YYYY-MM-DD' for a fixed now (zero-padded)", () => {
  assert.equal(todayISO(new Date("2026-06-10T12:00:00.000Z")), "2026-06-10");
  // A late-UTC instant still reports its UTC calendar day (no local drift).
  assert.equal(todayISO(new Date("2026-01-05T23:59:59.000Z")), "2026-01-05");
  // Month/day are zero-padded.
  assert.equal(todayISO(new Date("2026-03-09T00:00:00.000Z")), "2026-03-09");
});
