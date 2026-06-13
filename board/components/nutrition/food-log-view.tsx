"use client";

// The Food Log surface — a lightweight, read-focused list over db.foodLogs, the close
// twin of the Reminders surface. SSR seeds the entries list and the board version into
// local state; a live SSE subscription (useLiveBoard → subscribeToBoard) refetches
// whenever the board version advances past what we last saw (mirrors reminders-view),
// so an agent logging a meal via the nutrition MCP lands here without a reload.
//
// A FoodLogEntry is "what I ate" — a day + slot + description, with calories, optional
// macros, and an optional green/amber/red health flag. Entries are GROUPED BY DAY
// (newest day first); each day header carries a calorie + macro ROLLUP, and within a
// day the entries sort by meal slot (breakfast → lunch → dinner → snack). Logging /
// editing entries is done by the agent via the nutrition MCP (this Phase-1 surface is
// the human's at-a-glance read of the log); future phases layer compose UI on top.

import { useMemo, useRef, useState } from "react";
import type { FoodLogEntry, MealSlot, HealthRating } from "@/lib/types";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconChef } from "@/components/icons";

// Slot display rank + label — within a day, entries read in meal order, not insert order.
const SLOT_RANK: Record<MealSlot, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

// The green/amber/red health flag → a tinted chip. Full literal Tailwind strings per
// rating (no runtime concat) so the content scanner emits them.
const HEALTH_CHIP: Record<HealthRating, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};
const HEALTH_LABEL: Record<HealthRating, string> = { green: "Healthy", amber: "OK", red: "Indulgent" };

// One day's rollup — total calories + summed macros (macros only counted where present).
type DayRollup = { calories: number; protein: number; carbs: number; fat: number };

export function FoodLogView({
  now,
  entries: initialEntries,
  version,
}: {
  now: string;
  entries: FoodLogEntry[];
  version?: number;
}) {
  // Live entries list, seeded from SSR. The board version we last reconciled to — a ref
  // so the SSE callback always compares against the freshest value (mirrors reminders).
  const [entries, setEntries] = useState<FoodLogEntry[]>(initialEntries);
  const lastVersion = useRef<number>(version ?? 0);

  // Fixed clock — parsed ONCE from the SSR `now` prop, used only to mark "Today" on the
  // matching day header. Never `new Date()` during render, so SSR and the first client
  // render agree (no hydration drift); the day strings themselves are plain ISO days.
  const today = useMemo(() => toISODay(new Date(now)), [now]);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full food-log list and replace state, advancing lastVersion. There is no
  // dedicated /api/nutrition/log list client fn, but the addons GET carries the version;
  // a food-log write bumps db.version → SSE → we re-read the entries from the log route.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetch("/api/nutrition/log");
      if (!res.ok) return; // a disabled/erroring read leaves the last-known list in place
      const data = (await res.json()) as { entries?: FoodLogEntry[]; version?: number };
      if (Array.isArray(data.entries)) setEntries(data.entries);
      if (typeof data.version === "number") lastVersion.current = data.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known entries in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // Group entries by day (newest day first), each day's entries sorted by meal slot, and
  // compute the per-day calorie/macro rollup. Recomputed whenever the live list changes.
  const days = useMemo(() => groupByDay(entries), [entries]);
  const hasAny = entries.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left; entries are logged by the agent via the MCP. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Food Log</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {!hasAny ? (
            <EmptyState />
          ) : (
            days.map(({ date, items, rollup }) => (
              <section key={date}>
                {/* Day header — the date (today is flagged) + the calorie/macro rollup. */}
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                    {formatDay(date)}
                  </h2>
                  {date === today && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600">
                      Today
                    </span>
                  )}
                  <span className="ml-auto">
                    <DayRollupChips rollup={rollup} />
                  </span>
                </div>
                <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                  {items.map((e) => (
                    <FoodLogRow key={e.id} entry={e} />
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

// The day's rollup chips — total calories, then any present macros. Calories always
// show; a macro chip appears only when that macro summed to a non-zero value.
function DayRollupChips({ rollup }: { rollup: DayRollup }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700"
        title="Total calories logged this day"
      >
        {Math.round(rollup.calories)} kcal
      </span>
      {rollup.protein > 0 && <MacroChip label="P" grams={rollup.protein} />}
      {rollup.carbs > 0 && <MacroChip label="C" grams={rollup.carbs} />}
      {rollup.fat > 0 && <MacroChip label="F" grams={rollup.fat} />}
    </span>
  );
}

function MacroChip({ label, grams }: { label: string; grams: number }) {
  return (
    <span className="text-[10.5px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-100">
      {label} {Math.round(grams)}g
    </span>
  );
}

// One food-log row: the meal slot, the description, optional itemised components, a
// calorie figure (with an "est." hint when the count is a guess), the optional macros,
// and the optional health flag. Read-only — entries are written by the agent via the MCP.
function FoodLogRow({ entry }: { entry: FoodLogEntry }) {
  const items = entry.items ?? [];
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      {/* Slot chip — fixed-width so the descriptions align down the column. */}
      <span className="shrink-0 mt-px w-[68px] text-[11px] text-ink-500 font-medium">
        {SLOT_LABEL[entry.slot]}
      </span>

      {/* Description + (optional) itemised components beneath. */}
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-ink-900">{entry.description}</span>
        {items.length > 0 && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 truncate" title={items.join(", ")}>
            {items.join(", ")}
          </span>
        )}
        {entry.note && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 italic">{entry.note}</span>
        )}
      </span>

      {/* Health flag — optional green/amber/red. */}
      {entry.health && (
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${HEALTH_CHIP[entry.health]}`}
          title={`Health flag: ${HEALTH_LABEL[entry.health]}`}
        >
          {HEALTH_LABEL[entry.health]}
        </span>
      )}

      {/* Macros — shown only when present. */}
      {(entry.protein !== undefined || entry.carbs !== undefined || entry.fat !== undefined) && (
        <span className="shrink-0 inline-flex items-center gap-1">
          {entry.protein !== undefined && <MacroChip label="P" grams={entry.protein} />}
          {entry.carbs !== undefined && <MacroChip label="C" grams={entry.carbs} />}
          {entry.fat !== undefined && <MacroChip label="F" grams={entry.fat} />}
        </span>
      )}

      {/* Calories — the headline figure. "est." marks a guessed (not measured) count. */}
      <span
        className="shrink-0 text-[11.5px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700"
        title={entry.estimated ? "Estimated calorie count" : "Measured calorie count"}
      >
        {Math.round(entry.calories)} kcal{entry.estimated ? " · est." : ""}
      </span>
    </div>
  );
}

// The friendly empty state — shown when there are no food-log entries at all.
function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconChef className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">No meals logged yet</p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">
        Ask your chief of staff to log what you eat — &ldquo;log a chicken salad for lunch,
        ~450 calories&rdquo; — and entries appear here, grouped by day with a calorie rollup.
      </p>
    </div>
  );
}

// ── Local helpers ────────────────────────────────────────────────────────────
// A grouped day with its sorted entries and rollup. Days sort newest-first by their ISO
// day string (ISO days sort lexically), entries within a day by meal slot.
type DayGroup = { date: string; items: FoodLogEntry[]; rollup: DayRollup };

function groupByDay(entries: FoodLogEntry[]): DayGroup[] {
  const byDay = new Map<string, FoodLogEntry[]>();
  for (const e of entries) {
    const bucket = byDay.get(e.date);
    if (bucket) bucket.push(e);
    else byDay.set(e.date, [e]);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // newest day first
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => SLOT_RANK[a.slot] - SLOT_RANK[b.slot]),
      rollup: items.reduce<DayRollup>(
        (acc, e) => ({
          calories: acc.calories + (Number.isFinite(e.calories) ? e.calories : 0),
          protein: acc.protein + (e.protein ?? 0),
          carbs: acc.carbs + (e.carbs ?? 0),
          fat: acc.fat + (e.fat ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      ),
    }));
}

// "YYYY-MM-DD" for a Date in LOCAL time — used only to mark which grouped day is today.
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
