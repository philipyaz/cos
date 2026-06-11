"use client";

// The Calendar surface — a month grid over db.events. SSR seeds the events list
// and the board version into local state; a live SSE subscription (subscribeToBoard)
// refetches whenever the board version advances past what we last saw (mirrors
// board-view / inbox-view), so an agent or another tab adding an event lands here
// without a reload.
//
// Reads pure projections from selectors (monthGrid, eventsForDay) and routes every
// mutation through the EventDrawer (board-client createEvent/updateEvent/deleteEvent).
// Clicking an empty part of a day opens the composer prefilled to that day; clicking
// an event chip opens the editor for it. A chip is coloured by its linked case's lane
// when caseId is set, else by a neutral work/life tone.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CalendarEvent, CaseRecord } from "@/lib/types";
import { LANES } from "@/lib/types";
import { monthGrid, eventsForDay, todayISO } from "@/lib/selectors";
import { fetchEvents } from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconChevronRight, IconPlus } from "@/components/icons";
import { EventDrawer } from "./event-drawer";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// What the drawer is doing: composing a new event on a day, or editing one.
type Compose = { mode: "create"; date: string } | { mode: "edit"; event: CalendarEvent };

export function CalendarView({
  now,
  events: initialEvents,
  cases,
  version,
}: {
  now: string;
  events: CalendarEvent[];
  cases: CaseRecord[];
  version?: number;
}) {
  // Live events list, seeded from SSR. The board version we last reconciled to —
  // a ref so the SSE callback always compares against the freshest value.
  const [events, setEvents] = useState<CalendarEvent[]>(initialEvents);
  const lastVersion = useRef<number>(version ?? 0);

  // Fixed clock — parsed ONCE from the SSR `now` prop. Seeds the displayed month, the
  // today-highlight, and the initial year/monthIndex state, so all three are identical
  // across SSR and hydration (no near-midnight drift). Never `new Date()` during render.
  const today = useMemo(() => new Date(now), [now]);

  // The viewed month, seeded from today. monthIndex is 0-based (Date semantics).
  const [year, setYear] = useState(today.getUTCFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getUTCMonth());

  // Drawer state — null when closed.
  const [compose, setCompose] = useState<Compose | null>(null);

  const todayKey = todayISO(today);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full event list and replace state, advancing lastVersion. Pulls
  // every event (the month math is client-side, so no range filter is needed).
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchEvents();
      setEvents(res.events);
      lastVersion.current = res.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known events in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // ── Deep-link (?event=<id>) ─────────────────────────────────────────────────
  // Opened from the Activity feed (and anywhere else): if the URL names an event,
  // navigate the month grid to that event's day, then open it in the drawer in edit
  // mode. A one-time entry condition resolved against the SSR-seeded `events`. The
  // event's date is "YYYY-MM-DD" (UTC-anchored), parsed as a UTC instant so the
  // derived year/monthIndex match the view's getUTCFullYear()/getUTCMonth() seeding.
  const searchParams = useSearchParams();
  useEffect(() => {
    const id = searchParams.get("event");
    if (!id) return;
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    const d = new Date(`${ev.date}T00:00:00.000Z`);
    setYear(d.getUTCFullYear());
    setMonthIndex(d.getUTCMonth());
    setCompose({ mode: "edit", event: ev });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Month navigation ────────────────────────────────────────────────────────
  const goPrev = (): void => {
    if (monthIndex === 0) {
      setMonthIndex(11);
      setYear((y) => y - 1);
    } else {
      setMonthIndex((m) => m - 1);
    }
  };
  const goNext = (): void => {
    if (monthIndex === 11) {
      setMonthIndex(0);
      setYear((y) => y + 1);
    } else {
      setMonthIndex((m) => m + 1);
    }
  };
  const goToday = (): void => {
    setYear(today.getUTCFullYear());
    setMonthIndex(today.getUTCMonth());
  };

  const weeks = monthGrid(year, monthIndex);

  // After any successful create/update/delete, refetch + close the drawer.
  const onSaved = (): void => {
    void refetch();
    setCompose(null);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — month nav on the left, New appointment on the right. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={goPrev}
            aria-label="Previous month"
            className="text-[12px] text-ink-600 hover:text-ink-900 w-7 h-7 grid place-items-center rounded-md border border-ink-200 hover:bg-ink-50 transition"
          >
            <IconChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
          <span className="text-[13px] font-semibold text-ink-900 min-w-[140px] text-center tabular-nums">
            {MONTHS[monthIndex]} {year}
          </span>
          <button
            onClick={goNext}
            aria-label="Next month"
            className="text-[12px] text-ink-600 hover:text-ink-900 w-7 h-7 grid place-items-center rounded-md border border-ink-200 hover:bg-ink-50 transition"
          >
            <IconChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={goToday}
            className="ml-1.5 text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-ink-50 transition"
          >
            Today
          </button>
        </div>

        <button
          onClick={() => setCompose({ mode: "create", date: todayKey })}
          className="ml-auto inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
        >
          <IconPlus className="w-3.5 h-3.5" />
          New appointment
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] mx-auto">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-px mb-px">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="text-[11px] uppercase tracking-wide text-ink-400 font-medium px-2 py-1.5 text-center"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Weeks */}
          <div className="grid grid-cols-7 gap-px bg-ink-100 rounded-lg overflow-hidden border border-ink-100">
            {weeks.flat().map((cell) => {
              const dayEvents = eventsForDay(events, cell.date);
              const isToday = cell.date === todayKey;
              return (
                <DayCell
                  key={cell.date}
                  date={cell.date}
                  day={cell.day}
                  inMonth={cell.inMonth}
                  isToday={isToday}
                  events={dayEvents}
                  cases={cases}
                  onCompose={() => setCompose({ mode: "create", date: cell.date })}
                  onOpenEvent={(ev) => setCompose({ mode: "edit", event: ev })}
                />
              );
            })}
          </div>
        </div>
      </div>

      {compose && (
        <EventDrawer
          event={compose.mode === "edit" ? compose.event : null}
          date={compose.mode === "create" ? compose.date : compose.event.date}
          cases={cases}
          onSaved={onSaved}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

// One day cell — the day number (muted out-of-month, ringed today) and its events
// as compact chips. Clicking empty space composes a new event on that day; the
// chips stop propagation and open the editor instead.
function DayCell({
  date,
  day,
  inMonth,
  isToday,
  events,
  cases,
  onCompose,
  onOpenEvent,
}: {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  events: CalendarEvent[];
  cases: CaseRecord[];
  onCompose: () => void;
  onOpenEvent: (ev: CalendarEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onCompose}
      aria-label={`Add an appointment on ${date}`}
      className={`group relative min-h-[112px] text-left p-1.5 flex flex-col gap-1 transition ${
        inMonth ? "bg-white hover:bg-ink-50/60" : "bg-ink-50/50 hover:bg-ink-50"
      }`}
    >
      <div className="flex items-center">
        <span
          className={`text-[12px] tabular-nums grid place-items-center w-5 h-5 rounded-full ${
            isToday
              ? "bg-ink-900 text-white font-semibold"
              : inMonth
                ? "text-ink-700"
                : "text-ink-300"
          }`}
        >
          {day}
        </span>
        {/* A subtle add-affordance that surfaces on hover. */}
        <IconPlus className="w-3 h-3 ml-auto text-ink-300 opacity-0 group-hover:opacity-100 transition" />
      </div>

      <div className="flex flex-col gap-0.5">
        {events.map((ev) => (
          <EventChip
            key={ev.id}
            event={ev}
            cases={cases}
            onOpen={() => onOpenEvent(ev)}
          />
        ))}
      </div>
    </button>
  );
}

// A compact event chip. All-day events render full-width; timed events are
// prefixed with their start time. Colour: when linked to a case, the case's lane
// dot tints the chip; otherwise a neutral work/life tone (indigo/emerald) keyed by
// the event's advisory domain.
function EventChip({
  event,
  cases,
  onOpen,
}: {
  event: CalendarEvent;
  cases: CaseRecord[];
  onOpen: () => void;
}) {
  const linked = event.caseId ? cases.find((c) => c.id === event.caseId) ?? null : null;
  const lane = linked ? LANES.find((l) => l.key === linked.status) ?? null : null;

  // Linked → tint by lane (a soft chip + the lane dot). Unlinked → neutral domain
  // tone (life = emerald, anything else = indigo), matching the domain chips.
  const tone = lane
    ? "bg-ink-50 text-ink-700 ring-1 ring-ink-100"
    : event.domain === "life"
      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
      : "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100";

  return (
    <span
      role="button"
      tabIndex={0}
      title={`${event.title}${event.location ? ` · ${event.location}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] leading-tight truncate cursor-pointer hover:brightness-95 transition ${tone}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${lane ? lane.dotClass : "bg-current opacity-60"}`}
        aria-hidden
      />
      {!event.allDay && event.startTime && (
        <span className="tabular-nums shrink-0 font-medium">{event.startTime}</span>
      )}
      <span className="truncate">{event.title}</span>
    </span>
  );
}
