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
  events: CalendarEvent[]; // the board's own events; only TIMED ones (!allDay && startTime) are busy
  busyWindows?: BusyWindow[]; // caller-supplied, used-and-discarded; default [] === today's board-only behaviour
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
      const fromEvents = eventsForDay(input.events, date)
        .filter((e) => !e.allDay && e.startTime)
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
    let placed = false;
    for (const window of req.windows) {
      const gap = freeGaps(window, busyFor(req.date)).find((g) => g.end - g.start >= req.durationMin);
      if (!gap) continue;
      const startTime = toHHMM(gap.start);
      const endTime = toHHMM(gap.start + req.durationMin);
      ops.push({ op: "create", key: req.key, date: req.date, startTime, endTime, title: req.title, description: req.description });
      busyFor(req.date).push({ start: gap.start, end: gap.start + req.durationMin });
      placed = true;
      break;
    }
    if (!placed) {
      ops.push({ op: "skip", key: req.key, date: req.date, reason: "no_free_slot" });
    }
  }

  return ops;
}
