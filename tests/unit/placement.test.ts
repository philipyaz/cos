// Unit tests for the calendar PLACEMENT engine (board/lib/placement.ts) — pure, clock-injected,
// no disk / no network, so it runs headless under `node --test`. Covers what an HTTP-level test
// can't reliably pin: exact gap arithmetic, window-preference order, and the same-call stacking
// guard (minted event ids in a running board aren't controllable enough to prove these).
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/placement.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { planPlacement, DEFAULT_WORKING_HOURS } from "../../board/lib/placement.ts";
import type { PlacementRequest, WorkingHours } from "../../board/lib/placement.ts";
import type { CalendarEvent } from "../../board/lib/types.ts";

const TODAY = "2026-01-01"; // fixed reference "now" for every test below

function req(over: Partial<PlacementRequest> & { key: string; date: string }): PlacementRequest {
  return {
    durationMin: 60,
    windows: [{ start: "09:00", end: "17:00" }],
    title: "Session",
    description: "desc",
    ...over,
  };
}

function event(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: "Event",
    date: "2026-02-02",
    allDay: false,
    createdAt: "x",
    updatedAt: "x",
    ...over,
  };
}

test("planPlacement: existingEventId ALWAYS updates — never touches date/time, even on a past day", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2020-01-01", existingEventId: "EVT-5", title: "New title", description: "New desc" })],
    events: [],
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "update", key: "1", eventId: "EVT-5", title: "New title", description: "New desc" }]);
});

test("planPlacement: a past day with NO receipt is skipped, reason 'past'", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2020-01-01" })],
    events: [],
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "skip", key: "1", date: "2020-01-01", reason: "past" }]);
});

test("planPlacement: a request dated TODAY is not treated as past", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: TODAY, windows: [{ start: "09:00", end: "10:00" }] })],
    events: [],
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
});

test("planPlacement: places in the EARLIEST free gap, not a later larger one", () => {
  // window 09:00-17:00; busy 10:00-11:00 -> gaps [09:00-10:00](60m), [11:00-17:00](360m). A
  // 60m request fits the FIRST gap and must start there, not skip ahead to the roomier one.
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "17:00" }] })],
    events: [event({ id: "EVT-1", startTime: "10:00", endTime: "11:00" })],
    today: TODAY,
  });
  assert.deepEqual(ops, [
    { op: "create", key: "1", date: "2026-02-02", startTime: "09:00", endTime: "10:00", title: "Session", description: "desc" },
  ]);
});

test("planPlacement: window PREFERENCE ORDER — falls through to the second window only when the first has no fit", () => {
  const ops = planPlacement({
    requests: [req({
      key: "1", date: "2026-02-02", durationMin: 60,
      windows: [{ start: "18:00", end: "19:00" }, { start: "06:00", end: "09:00" }],
    })],
    events: [event({ id: "EVT-1", startTime: "18:00", endTime: "19:00" })], // fills the evening window
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "06:00", "falls through to the morning window");
});

test("planPlacement: window PREFERENCE ORDER — the first window wins even when a later one has more room", () => {
  const ops = planPlacement({
    requests: [req({
      key: "1", date: "2026-02-02", durationMin: 30,
      windows: [{ start: "18:00", end: "18:30" }, { start: "06:00", end: "12:00" }],
    })],
    events: [],
    today: TODAY,
  });
  assert.equal((ops[0] as { startTime: string }).startTime, "18:00", "the first window is tried first and already fits");
});

test("planPlacement: 'no_free_slot' when every candidate window is fully busy", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "10:00" }] })],
    events: [event({ id: "EVT-1", startTime: "09:00", endTime: "10:00" })],
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "skip", key: "1", date: "2026-02-02", reason: "no_free_slot" }]);
});

test("planPlacement: caller-supplied busyWindows are honored — no conflicting event exists at all", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "12:00" }] })],
    events: [], // the board's own events carry NO conflict whatsoever
    busyWindows: [{ date: "2026-02-02", start: "09:00", end: "10:30" }],
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "10:30", "only busyWindows explains this shift");
});

test("planPlacement: no busyWindows passed at all === today's board-only behaviour (the additive default)", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "11:00" }] })],
    events: [],
    today: TODAY,
  });
  assert.equal((ops[0] as { startTime: string }).startTime, "09:00");
});

test("planPlacement: two requests on the same day/window don't stack — the second sees the first's create", () => {
  const ops = planPlacement({
    requests: [
      req({ key: "a", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "11:00" }] }),
      req({ key: "b", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "11:00" }] }),
    ],
    events: [],
    today: TODAY,
  });
  assert.equal((ops[0] as { startTime: string }).startTime, "09:00");
  assert.equal((ops[1] as { startTime: string }).startTime, "10:00", "pushed after the first request's freshly-placed hour");
});

test("planPlacement: an event missing endTime occupies a DEFAULT 60 minutes for busy-set purposes", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 30, windows: [{ start: "09:00", end: "10:30" }] })],
    events: [event({ id: "EVT-1", startTime: "09:00", endTime: undefined })], // no endTime at all
    today: TODAY,
  });
  // busy occupies 09:00-10:00 (the 60m default); the only remaining 30m gap is 10:00-10:30.
  assert.equal((ops[0] as { startTime: string }).startTime, "10:00");
});

test("planPlacement: an all-day event never blocks placement", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "09:00", end: "10:00" }] })],
    events: [event({ id: "EVT-1", allDay: true, startTime: undefined })],
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "09:00");
});

// ── ops#25 — the working-hours policy (2026-02-02 is a Monday; 2026-02-07/08 are Sat/Sun) ──

test("planPlacement: no policy at all means NO working-hours protection — additive-only", () => {
  // The same lunch window the "margins" test below finds fully protected — with no policy
  // supplied, it simply places. This is the concrete proof step-1 callers are unaffected.
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 30, windows: [{ start: "12:00", end: "13:00" }] })],
    events: [],
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "12:00");
});

test("planPlacement (margins policy): a weekday window ENTIRELY inside working hours is never usable — skip reason outside_working_hours, not no_free_slot", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02" /* Monday */, durationMin: 30, windows: [{ start: "12:00", end: "13:00" }] })],
    events: [], // no real conflict at all — the policy alone explains the skip
    policy: { mode: "margins", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "skip", key: "1", date: "2026-02-02", reason: "outside_working_hours" }]);
});

test("planPlacement (margins policy): the SAME lunch window on a weekend is unprotected — it places", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-07" /* Saturday */, durationMin: 30, windows: [{ start: "12:00", end: "13:00" }] })],
    events: [],
    policy: { mode: "margins", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "12:00");
});

test("planPlacement (margins policy): a fully-busy evening margin falls through to the morning margin — the margins themselves sit outside working hours", () => {
  const ops = planPlacement({
    requests: [req({
      key: "1", date: "2026-02-02", durationMin: 60,
      windows: [{ start: "18:00", end: "21:30" }, { start: "06:30", end: "09:00" }],
    })],
    events: [event({ id: "EVT-1", startTime: "18:00", endTime: "21:30" })],
    policy: { mode: "margins", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "06:30", "falls through to the morning margin, untouched by working-hours protection");
});

test("planPlacement (margins policy): both margins fully booked by REAL events ⇒ no_free_slot, never outside_working_hours", () => {
  const ops = planPlacement({
    requests: [req({
      key: "1", date: "2026-02-02", durationMin: 60,
      windows: [{ start: "18:00", end: "21:30" }, { start: "06:30", end: "09:00" }],
    })],
    events: [
      event({ id: "EVT-1", startTime: "18:00", endTime: "21:30" }),
      event({ id: "EVT-2", startTime: "06:30", endTime: "09:00" }),
    ],
    policy: { mode: "margins", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "skip", key: "1", date: "2026-02-02", reason: "no_free_slot" }]);
});

test("planPlacement (within policy): a candidate window is CLAMPED to the working window, not just checked against it", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-02", durationMin: 60, windows: [{ start: "08:00", end: "19:00" }] })],
    events: [],
    policy: { mode: "within", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.equal(ops[0].op, "create");
  assert.equal((ops[0] as { startTime: string }).startTime, "09:00", "clamped to the working window's start, not the request window's own 08:00");
  assert.equal((ops[0] as { endTime: string }).endTime, "10:00");
});

test("planPlacement (within policy): a Saturday request is refused outright — outside_working_hours", () => {
  const ops = planPlacement({
    requests: [req({ key: "1", date: "2026-02-07" /* Saturday */, durationMin: 60, windows: [{ start: "09:00", end: "17:00" }] })],
    events: [],
    policy: { mode: "within", workingHours: DEFAULT_WORKING_HOURS },
    today: TODAY,
  });
  assert.deepEqual(ops, [{ op: "skip", key: "1", date: "2026-02-07", reason: "outside_working_hours" }]);
});

test("planPlacement (within policy): a CUSTOM workingHours is respected, not the shipped default", () => {
  const weekendOnly: WorkingHours = { days: [6], start: "10:00", end: "14:00" }; // Saturday-only, 10:00-14:00

  const onCustomDay = planPlacement({
    requests: [req({ key: "1", date: "2026-02-07" /* Saturday */, durationMin: 60, windows: [{ start: "09:00", end: "18:00" }] })],
    events: [],
    policy: { mode: "within", workingHours: weekendOnly },
    today: TODAY,
  });
  assert.equal(onCustomDay[0].op, "create");
  assert.equal((onCustomDay[0] as { startTime: string }).startTime, "10:00", "clamped to the CUSTOM working window, not DEFAULT_WORKING_HOURS");

  const offCustomDay = planPlacement({
    requests: [req({ key: "2", date: "2026-02-02" /* Monday — not in the custom days */, durationMin: 60, windows: [{ start: "09:00", end: "18:00" }] })],
    events: [],
    policy: { mode: "within", workingHours: weekendOnly },
    today: TODAY,
  });
  assert.deepEqual(offCustomDay, [{ op: "skip", key: "2", date: "2026-02-02", reason: "outside_working_hours" }]);
});
