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

import { planPlacement } from "../../board/lib/placement.ts";
import type { PlacementRequest } from "../../board/lib/placement.ts";
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
