// The calendar PLACEMENT engine — pure, no I/O, clock injected (the ADR 0017 shape:
// pure engine + thin route + MCP tool + api test + unit test). Given a list of things
// that want a slot (a training session, a planned dinner), the board's own timed events,
// and an optional caller-supplied busy set, it decides create / update / skip for each —
// never double-booking, never inventing a slot outside the given candidate windows.
//
// This is the reusable primitive PRODUCT's A1 exit signal asks for ("slot proposals are
// overlap-safe"). It does NOT decide *where* the candidate windows are (that's the
// caller's job — see the push routes) and does NOT read any external calendar itself —
// `busyWindows` is a per-call parameter the agent supplies from the user's own calendar
// connector and the engine only ever uses-and-discards it (ADR 0001's division of labour
// applied to data: the board never persists another calendar's content).
//
// All times are naive "HH:MM" strings on naive "YYYY-MM-DD" days — the store's own
// convention. Busy-set lookups consume the existing pure calendar projections in
// selectors.ts (todayISO / eventsForDay) rather than minting a second day/weekday
// derivation.

import type { CalendarEvent } from "./types";
import { eventsForDay } from "./selectors";

export interface BusyWindow {
  date: string; // "YYYY-MM-DD"
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface CandidateWindow {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

// The working-hours / protected-window preference (mirrors Settings.workingHours in
// types.ts — declared separately here, not imported, so this leaf module never depends
// on types.ts beyond CalendarEvent). ISO weekday numbers: Mon=1 … Sun=7.
export interface WorkingHours {
  days: number[];
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

// The shipped default (ops#25): Mon-Fri 09:00-18:00, so the preference needs no setup
// step. Callers resolve `db.settings?.workingHours ?? DEFAULT_WORKING_HOURS`.
export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

// How a caller wants the working window enforced:
//  - "margins" (this unit's callers — training/meal placements): on a working day the
//    working window is PROTECTED — added to the busy set, so life placements never land
//    inside it. Non-working days are unprotected.
//  - "within" (a future work-placement caller, e.g. ops#24): candidate windows are
//    CLAMPED to the working window; a non-working day refuses the request outright.
// No policy at all ⇒ today's board-only behaviour (busyWindows/events only) — additive.
export interface PlacementPolicy {
  mode: "margins" | "within";
  workingHours: WorkingHours;
}

export interface PlacementRequest {
  key: string; // opaque — day index or MEAL-id; echoed back on the resulting op
  date: string; // "YYYY-MM-DD"
  durationMin: number;
  windows: CandidateWindow[]; // candidate windows, in PREFERENCE order — the caller resolves these
  title: string;
  description: string;
  existingEventId?: string; // the receipt, ONLY when the caller has proven it points at a LIVE event
}

export type PlacementOp =
  | { op: "create"; key: string; date: string; startTime: string; endTime: string; title: string; description: string }
  | { op: "update"; key: string; eventId: string; title: string; description: string }
  | { op: "skip"; key: string; date: string; reason: "past" | "no_free_slot" | "outside_working_hours" };

// Minutes-since-midnight interval — the internal unit every window/busy computation reduces to.
interface Interval {
  start: number;
  end: number;
}

// An event with no endTime is treated as occupying this long, for busy-set purposes only
// (mirrors the board's own "no end time recorded" convention elsewhere).
const DEFAULT_EVENT_DURATION_MIN = 60;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ISO weekday (Mon=1 … Sun=7) for a naive "YYYY-MM-DD" day — the same TZ-independent
// Date.UTC-parse idiom the push routes use for their own weekend checks.
function isoWeekday(dateISO: string): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  const sundayZero = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return sundayZero === 0 ? 7 : sundayZero;
}

function isWorkingDay(dateISO: string, wh: WorkingHours): boolean {
  return wh.days.includes(isoWeekday(dateISO));
}

// The part of `window` that falls inside the working window, or null when they don't
// overlap at all ("within" mode clamps a candidate window to this).
function intersectWorkingHours(window: CandidateWindow, wh: WorkingHours): CandidateWindow | null {
  const start = Math.max(toMinutes(window.start), toMinutes(wh.start));
  const end = Math.min(toMinutes(window.end), toMinutes(wh.end));
  return start < end ? { start: toHHMM(start), end: toHHMM(end) } : null;
}

// True when `window` never pokes outside the working window at all — the "margins"-mode
// case where the window can NEVER be used on a protected day, regardless of real events
// (a weekday lunch inside 09:00-18:00), as opposed to one only partly protected.
function isFullyInsideWorkingHours(window: CandidateWindow, wh: WorkingHours): boolean {
  return toMinutes(window.start) >= toMinutes(wh.start) && toMinutes(window.end) <= toMinutes(wh.end);
}

// Sort-and-merge overlapping/touching intervals into the minimal covering set.
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// The free gaps inside `window` once the (merged) busy intervals are subtracted —
// clipped to the window's own bounds, left to right.
function freeGaps(window: CandidateWindow, busy: Interval[]): Interval[] {
  const wStart = toMinutes(window.start);
  const wEnd = toMinutes(window.end);
  const relevant = mergeIntervals(busy.filter((b) => b.end > wStart && b.start < wEnd));

  const gaps: Interval[] = [];
  let cursor = wStart;
  for (const b of relevant) {
    const bStart = Math.max(b.start, wStart);
    const bEnd = Math.min(b.end, wEnd);
    if (bStart > cursor) gaps.push({ start: cursor, end: bStart });
    cursor = Math.max(cursor, bEnd);
  }
  if (cursor < wEnd) gaps.push({ start: cursor, end: wEnd });
  return gaps;
}

// Decide create/update/skip for every request. Requests are processed IN ORDER, and a
// "create" grows the busy set for its date immediately — so two requests landing on the
// same evening never stack (the second sees the first's freshly-placed interval).
export function planPlacement(input: {
  requests: PlacementRequest[];
  events: CalendarEvent[]; // the board's own events; only TIMED ones (!allDay && startTime) are busy, and never a cancelled one
  busyWindows?: BusyWindow[]; // caller-supplied, used-and-discarded; default [] === today's board-only behaviour
  policy?: PlacementPolicy; // the working-hours preference; absent === today's behaviour (additive)
  today: string; // "YYYY-MM-DD" — the injected clock
}): PlacementOp[] {
  const busyWindows = input.busyWindows ?? [];
  const ops: PlacementOp[] = [];

  // Busy-by-date, lazily seeded from the board's own timed events + the caller's busy
  // windows, then grown in place as this call places new events (see loop below).
  const busyByDate = new Map<string, Interval[]>();
  const busyFor = (date: string): Interval[] => {
    let busy = busyByDate.get(date);
    if (!busy) {
      // A cancelled event never blocks — it stays on the calendar as the record but is no
      // longer a real claim on the time. A tentative one (and an absent status ≡ confirmed)
      // still does: a hold is a real claim on the time — a one-word reversal here if Philip
      // ever wants holds to read as free.
      const fromEvents = eventsForDay(input.events, date)
        .filter((e) => !e.allDay && e.startTime && e.status !== "cancelled")
        .map((e) => {
          const start = toMinutes(e.startTime as string);
          const end = e.endTime ? toMinutes(e.endTime) : start + DEFAULT_EVENT_DURATION_MIN;
          return { start, end };
        });
      const fromBusyWindows = busyWindows
        .filter((w) => w.date === date)
        .map((w) => ({ start: toMinutes(w.start), end: toMinutes(w.end) }));
      busy = [...fromEvents, ...fromBusyWindows];
      busyByDate.set(date, busy);
    }
    return busy;
  };

  for (const req of input.requests) {
    // Rule 1 — receipt first: an existingEventId (already proven live by the caller)
    // ALWAYS updates, never a skip/create, and NEVER touches date/startTime/endTime —
    // human placement wins, content refreshes.
    if (req.existingEventId) {
      ops.push({ op: "update", key: req.key, eventId: req.existingEventId, title: req.title, description: req.description });
      continue;
    }

    // Rule 2 — a past day with no live receipt is never placed.
    if (req.date < input.today) {
      ops.push({ op: "skip", key: req.key, date: req.date, reason: "past" });
      continue;
    }

    // Rule 4/5 — walk the candidate windows in the caller's preference order; within
    // each, take the earliest gap that fits. Never falls back outside the given windows.
    // A `policy` reshapes each window BEFORE the free-gap search: "margins" protects a
    // working day's working window (added to the busy set; a window entirely inside it
    // is never usable at all); "within" clamps every window to the working window and
    // refuses a non-working day outright. `sawUsableWindow` records whether ANY window
    // was ever allowed to be searched, so the skip reason below can tell "never allowed"
    // (outside_working_hours) apart from "allowed, but real congestion ate it" (no_free_slot).
    const policy = input.policy;
    let placed = false;
    let sawUsableWindow = false;
    for (const window of req.windows) {
      let searchWindow = window;
      let busy = busyFor(req.date);

      if (policy && policy.mode === "within") {
        const wh = policy.workingHours;
        if (!isWorkingDay(req.date, wh)) continue;
        const clipped = intersectWorkingHours(window, wh);
        if (!clipped) continue;
        searchWindow = clipped;
      } else if (policy && policy.mode === "margins" && isWorkingDay(req.date, policy.workingHours)) {
        const wh = policy.workingHours;
        if (isFullyInsideWorkingHours(window, wh)) continue;
        busy = [...busy, { start: toMinutes(wh.start), end: toMinutes(wh.end) }];
      }

      sawUsableWindow = true;
      const gap = freeGaps(searchWindow, busy).find((g) => g.end - g.start >= req.durationMin);
      if (!gap) continue;
      const startTime = toHHMM(gap.start);
      const endTime = toHHMM(gap.start + req.durationMin);
      ops.push({ op: "create", key: req.key, date: req.date, startTime, endTime, title: req.title, description: req.description });
      busyFor(req.date).push({ start: gap.start, end: gap.start + req.durationMin });
      placed = true;
      break;
    }
    if (!placed) {
      const reason = policy && !sawUsableWindow ? "outside_working_hours" : "no_free_slot";
      ops.push({ op: "skip", key: req.key, date: req.date, reason });
    }
  }

  return ops;
}
