"use client";

// The Food Log surface — a lightweight, read-focused list over db.foodLogs. SSR seeds the entries +
// the body-objective panel inputs; a live SSE subscription refetches whenever the board version
// advances, so an agent logging a meal / saving targets via MCP lands here without a reload.
//
// Entries are GROUPED BY DAY (newest first) with a per-day calorie + macro rollup; within a day they
// sort by meal slot. The v14 ObjectivePanel sits above the log (the free-text goal + the physiology
// baseline + the agent-authored daily targets). Per-day adherence chips were dropped in v14 (no
// per-day target history without re-introducing rules in code).

import { useMemo, useRef, useState } from "react";
import type { FoodLogEntry, MealSlot, HealthRating, WeightEntry, BodyObjective, NutritionTargetArtifact } from "@/lib/types";
import type { BodyBaseline } from "@/lib/body-baseline";
import { useLiveBoard } from "@/lib/use-live-board";
import { listWeights, getBodyStatus } from "@/lib/body-client";
import { getLatestNutritionTarget } from "@/lib/nutrition-client";
import { toISODay, formatDay } from "@/lib/nutrition-format";
import { IconChef } from "@/components/icons";
import { ObjectivePanel } from "./objective-panel";

const SLOT_RANK: Record<MealSlot, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
const SLOT_LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

const HEALTH_CHIP: Record<HealthRating, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};
const HEALTH_LABEL: Record<HealthRating, string> = { green: "Healthy", amber: "OK", red: "Indulgent" };

type DayRollup = { calories: number; protein: number; carbs: number; fat: number };

export function FoodLogView({
  now,
  entries: initialEntries,
  version,
  objective: initialObjective,
  baseline: initialBaseline,
  latestTarget: initialLatestTarget,
  weights: initialWeights,
  unit: initialUnit,
  sex: initialSex,
}: {
  now: string;
  entries: FoodLogEntry[];
  version?: number;
  // The v14 body-objective panel's SSR seed.
  objective: BodyObjective | null;
  baseline: BodyBaseline;
  latestTarget: NutritionTargetArtifact | null;
  weights: WeightEntry[];
  unit: "kg" | "lb";
  sex?: "male" | "female";
}) {
  const [entries, setEntries] = useState<FoodLogEntry[]>(initialEntries);
  const lastVersion = useRef<number>(version ?? 0);

  const [objective, setObjective] = useState<BodyObjective | null>(initialObjective);
  const [baseline, setBaseline] = useState<BodyBaseline>(initialBaseline);
  const [latestTarget, setLatestTarget] = useState<NutritionTargetArtifact | null>(initialLatestTarget);
  const [weights, setWeights] = useState<WeightEntry[]>(initialWeights);
  const [unit, setUnit] = useState<"kg" | "lb">(initialUnit);
  const [sex, setSex] = useState<"male" | "female" | undefined>(initialSex);

  const today = useMemo(() => toISODay(new Date(now)), [now]);

  // Refetch the food-log list AND the body-objective panel inputs on every bump (a meal log, a
  // weigh-in, a goal edit, or an agent saving targets all advance db.version → SSE → here). The
  // body reads are ungated, so they resolve even on a disabled add-on.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetch("/api/nutrition/log");
      if (res.ok) {
        const data = (await res.json()) as { entries?: FoodLogEntry[]; version?: number };
        if (Array.isArray(data.entries)) setEntries(data.entries);
        if (typeof data.version === "number") lastVersion.current = data.version;
      }
    } catch {
      // non-critical
    }
    const [sRes, tRes, wRes] = await Promise.allSettled([getBodyStatus(), getLatestNutritionTarget(), listWeights()]);
    if (sRes.status === "fulfilled") {
      setBaseline(sRes.value.baseline);
      setObjective(sRes.value.objective);
      setUnit(sRes.value.profile?.weightUnit ?? "kg");
      setSex(sRes.value.profile?.sex);
    }
    if (tRes.status === "fulfilled") setLatestTarget(tRes.value.artifact);
    if (wRes.status === "fulfilled") setWeights(wRes.value.weights);
  };

  useLiveBoard(lastVersion, refetch);

  const days = useMemo(() => groupByDay(entries), [entries]);
  const hasAny = entries.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Food Log</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {/* The v14 body-objective panel — always rendered (the baseline always resolves); shows its
              own cold-start when no objective is set. Its writes bump db.version → our refetch. */}
          <ObjectivePanel
            objective={objective}
            baseline={baseline}
            latestTarget={latestTarget}
            weights={weights}
            today={today}
            unit={unit}
            sex={sex}
            onMutated={refetch}
          />

          {!hasAny ? (
            <EmptyState />
          ) : (
            days.map(({ date, items, rollup }) => (
              <section key={date}>
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">{formatDay(date)}</h2>
                  {date === today && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600">Today</span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1.5">
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

function DayRollupChips({ rollup }: { rollup: DayRollup }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700" title="Total calories logged this day">
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

function FoodLogRow({ entry }: { entry: FoodLogEntry }) {
  const items = entry.items ?? [];
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span className="shrink-0 mt-px w-[68px] text-[11px] text-ink-500 font-medium">{SLOT_LABEL[entry.slot]}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-ink-900">{entry.description}</span>
        {items.length > 0 && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 truncate" title={items.join(", ")}>
            {items.join(", ")}
          </span>
        )}
        {entry.note && <span className="block mt-0.5 text-[11.5px] text-ink-400 italic">{entry.note}</span>}
      </span>
      {entry.health && (
        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${HEALTH_CHIP[entry.health]}`} title={`Health flag: ${HEALTH_LABEL[entry.health]}`}>
          {HEALTH_LABEL[entry.health]}
        </span>
      )}
      {(entry.protein !== undefined || entry.carbs !== undefined || entry.fat !== undefined) && (
        <span className="shrink-0 inline-flex items-center gap-1">
          {entry.protein !== undefined && <MacroChip label="P" grams={entry.protein} />}
          {entry.carbs !== undefined && <MacroChip label="C" grams={entry.carbs} />}
          {entry.fat !== undefined && <MacroChip label="F" grams={entry.fat} />}
        </span>
      )}
      <span className="shrink-0 text-[11.5px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700" title={entry.estimated ? "Estimated calorie count" : "Measured calorie count"}>
        {Math.round(entry.calories)} kcal{entry.estimated ? " · est." : ""}
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconChef className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">No meals logged yet</p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">
        Ask your chief of staff to log what you eat — &ldquo;log a chicken salad for lunch, ~450 calories&rdquo; —
        and entries appear here, grouped by day with a calorie rollup.
      </p>
    </div>
  );
}

type DayGroup = { date: string; items: FoodLogEntry[]; rollup: DayRollup };

function groupByDay(entries: FoodLogEntry[]): DayGroup[] {
  const byDay = new Map<string, FoodLogEntry[]>();
  for (const e of entries) {
    const bucket = byDay.get(e.date);
    if (bucket) bucket.push(e);
    else byDay.set(e.date, [e]);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
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
