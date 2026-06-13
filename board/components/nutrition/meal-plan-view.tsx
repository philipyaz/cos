"use client";

// The Meal Plan surface — a lightweight, read-focused agenda over db.mealPlanEntries, the
// close twin of the Food Log surface. SSR seeds the entries list and the board version
// into local state; a live SSE subscription (useLiveBoard → subscribeToBoard) refetches
// whenever the board version advances past what we last saw (mirrors food-log-view), so an
// agent planning a meal via the nutrition MCP lands here without a reload.
//
// A MealPlanEntry is "what I plan to cook/eat" — a day + slot + title, with an optional
// recipe, ingredients, servings, SOFT refs to pantry items, and an optional link to a
// calendar event. Entries are an UPCOMING AGENDA: grouped BY DAY (soonest day first,
// from today onward — past days are folded away), and within a day they sort by meal slot
// (breakfast → lunch → dinner → snack). Each entry carries a planned/cooked/skipped status
// chip. Planning / editing entries is done by the agent via the nutrition MCP (this
// Phase-3 surface is the human's at-a-glance read of the plan).

import { useMemo, useRef, useState } from "react";
import type { MealPlanEntry, MealSlot, MealPlanStatus } from "@/lib/types";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconMealPlan } from "@/components/icons";

// Slot display rank + label — within a day, entries read in meal order, not insert order.
const SLOT_RANK: Record<MealSlot, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

// The planned/cooked/skipped lifecycle → a tinted chip. Full literal Tailwind strings per
// status (no runtime concat) so the content scanner emits them.
const STATUS_CHIP: Record<MealPlanStatus, string> = {
  planned: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  cooked: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  skipped: "bg-ink-100 text-ink-500 ring-1 ring-ink-200",
};
const STATUS_LABEL: Record<MealPlanStatus, string> = {
  planned: "Planned",
  cooked: "Cooked",
  skipped: "Skipped",
};

export function MealPlanView({
  now,
  entries: initialEntries,
  version,
}: {
  now: string;
  entries: MealPlanEntry[];
  version?: number;
}) {
  // Live entries list, seeded from SSR. The board version we last reconciled to — a ref
  // so the SSE callback always compares against the freshest value (mirrors food-log).
  const [entries, setEntries] = useState<MealPlanEntry[]>(initialEntries);
  const lastVersion = useRef<number>(version ?? 0);

  // Fixed clock — parsed ONCE from the SSR `now` prop. It both marks the "Today" header
  // and sets the agenda's lower bound (we show today onward; past days are folded away).
  // Never `new Date()` during render, so SSR and the first client render agree (no
  // hydration drift); the day strings themselves are plain ISO days.
  const today = useMemo(() => toISODay(new Date(now)), [now]);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full meal-plan list and replace state, advancing lastVersion. There is no
  // dedicated /api/nutrition/plan list client fn, but a meal-plan write bumps db.version →
  // SSE → we re-read the entries directly from the plan route (mirrors food-log-view).
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetch("/api/nutrition/plan");
      if (!res.ok) return; // a disabled/erroring read leaves the last-known list in place
      const data = (await res.json()) as { entries?: MealPlanEntry[]; version?: number };
      if (Array.isArray(data.entries)) setEntries(data.entries);
      if (typeof data.version === "number") lastVersion.current = data.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known entries in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // Group entries into the UPCOMING agenda: today onward, soonest day first, each day's
  // entries sorted by meal slot. Recomputed whenever the live list (or the clock) changes.
  const days = useMemo(() => groupUpcoming(entries, today), [entries, today]);
  const hasAny = entries.length > 0;
  const hasUpcoming = days.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left; meals are planned by the agent via the MCP. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Meal Plan</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {!hasUpcoming ? (
            <EmptyState hadPast={hasAny} />
          ) : (
            days.map(({ date, items }) => (
              <section key={date}>
                {/* Day header — the date (today is flagged) + a planned-meal count. */}
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                    {formatDay(date)}
                  </h2>
                  {date === today && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600">
                      Today
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-ink-400 tabular-nums">
                    {items.length} {items.length === 1 ? "meal" : "meals"}
                  </span>
                </div>
                <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                  {items.map((e) => (
                    <MealPlanRow key={e.id} entry={e} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// One meal-plan row: the meal slot, the title, an optional recipe snippet + note beneath,
// a count of linked pantry items (SOFT refs — rendered gracefully whether or not the
// referenced items still exist), a small "on calendar" indicator when eventId is set, and
// the planned/cooked/skipped status chip. Read-only — entries are written by the agent.
function MealPlanRow({ entry }: { entry: MealPlanEntry }) {
  const pantryCount = entry.pantryItemIds?.length ?? 0;
  const onCalendar = typeof entry.eventId === "string" && entry.eventId.trim() !== "";
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      {/* Slot chip — fixed-width so the titles align down the column. */}
      <span className="shrink-0 mt-px w-[68px] text-[11px] text-ink-500 font-medium">
        {SLOT_LABEL[entry.slot]}
      </span>

      {/* Title + (optional) recipe snippet / note beneath. */}
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-ink-900">{entry.title}</span>
        {entry.recipe && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 truncate" title={entry.recipe}>
            {entry.recipe}
          </span>
        )}
        {entry.note && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 italic">{entry.note}</span>
        )}
        {/* Soft-ref pantry count + the on-calendar marker, rendered only when present. */}
        {(pantryCount > 0 || onCalendar) && (
          <span className="mt-1 inline-flex items-center gap-1.5">
            {pantryCount > 0 && (
              <span
                className="text-[10.5px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-100"
                title={`${pantryCount} linked pantry ${pantryCount === 1 ? "item" : "items"}`}
              >
                {pantryCount} pantry {pantryCount === 1 ? "item" : "items"}
              </span>
            )}
            {onCalendar && (
              <span
                className="text-[10.5px] px-1.5 py-0.5 rounded-full font-medium bg-violet-50 text-violet-700 ring-1 ring-violet-200"
                title="Linked to a calendar event"
              >
                On calendar
              </span>
            )}
          </span>
        )}
      </span>

      {/* Status — planned / cooked / skipped. */}
      <span
        className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_CHIP[entry.status]}`}
        title={`Status: ${STATUS_LABEL[entry.status]}`}
      >
        {STATUS_LABEL[entry.status]}
      </span>
    </div>
  );
}

// The friendly empty state — shown when there is nothing upcoming to plan. `hadPast` tells
// the human their plan is not empty, just all in the past (so the agenda looks bare).
function EmptyState({ hadPast }: { hadPast: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconMealPlan className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">
        {hadPast ? "Nothing planned ahead" : "No meals planned yet"}
      </p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">
        Ask your chief of staff to plan meals from what is in your pantry — &ldquo;plan a
        stir-fry for dinner tomorrow using the chicken and peppers&rdquo; — and the week
        ahead fills in here, grouped by day and meal.
      </p>
    </div>
  );
}

// ── Local helpers ────────────────────────────────────────────────────────────
// A grouped day with its slot-sorted entries. Days sort soonest-first by their ISO day
// string (ISO days sort lexically), entries within a day by meal slot.
type DayGroup = { date: string; items: MealPlanEntry[] };

// Build the UPCOMING agenda: keep only entries on `today` or later, group by day, sort the
// days ascending (soonest first) and each day's entries by meal slot. Past days are folded
// away so the surface reads as a forward-looking plan, not a log.
function groupUpcoming(entries: MealPlanEntry[], today: string): DayGroup[] {
  const byDay = new Map<string, MealPlanEntry[]>();
  for (const e of entries) {
    if (e.date < today) continue; // fold away past days — this is an agenda, not a log
    const bucket = byDay.get(e.date);
    if (bucket) bucket.push(e);
    else byDay.set(e.date, [e]);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) // soonest day first
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => SLOT_RANK[a.slot] - SLOT_RANK[b.slot]),
    }));
}

// "YYYY-MM-DD" for a Date in LOCAL time — used to mark which grouped day is today and to
// set the agenda's lower bound.
function toISODay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// A readable, DETERMINISTIC day header from a bare "YYYY-MM-DD" string. We format from
// the string parts (not new Date(iso), which would parse as UTC midnight and could shift
// the day in a behind-UTC timezone, drifting between SSR and client). "MMM D, YYYY".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}
