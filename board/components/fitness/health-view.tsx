"use client";

// The Health dashboard surface — a read-focused view over db.healthEntries, the Apple-Watch
// health time-series of the Fitness add-on (the twin of the Food Log surface). SSR seeds the
// entries + the board version into local state; a live SSE subscription (useLiveBoard →
// subscribeToBoard) refetches whenever the board version advances past what we last saw, so
// an agent pushing health data via the fitness MCP lands here without a reload.
//
// A HealthEntry is one measurement — a workout (full-ISO ts), or a per-day metric / sleep
// aggregate (a bare "YYYY-MM-DD" ts). The view projects entries into sections: the latest
// metric cards, the workouts table, the sleep table, and the naps table. Pushing entries is
// done by the agent via the fitness MCP (this surface is the human's at-a-glance read).

import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthEntry } from "@/lib/types";
import { useLiveBoard } from "@/lib/use-live-board";
import { getFitnessData } from "@/lib/fitness-client";
import { formatDay, formatTimestampDay, formatTime } from "@/lib/fitness-format";
import { IconHeart, IconWarning } from "@/components/icons";
import { FormScoreWidget } from "@/components/form-score-widget";

// ── Date helpers ──────────────────────────────────────────────────────────────
// Workout rows carry a FULL ISO ts (it has its own offset) → formatTimestampDay/formatTime
// from lib/fitness-format parse it unambiguously. The sleep/nap/metric rows carry a BARE
// "YYYY-MM-DD" ts → formatDay (parts-based, NO new Date), so a behind-UTC viewer never sees
// a day-shifted date. (Previously both went through new Date(iso), shifting the bare days.)

function fmtDuration(min: unknown): string {
  if (typeof min !== "number") return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}` : `${m}min`;
}

/** Format hours (e.g. 7.27) as "7h16". */
function fmtHours(hrs: unknown): string {
  if (typeof hrs !== "number" || !Number.isFinite(hrs)) return "—";
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}` : `${m}min`;
}

function num(v: unknown): string {
  if (typeof v !== "number") return "—";
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}

// ── Type matching ────────────────────────────────────────────────────────────
// The push route canonicalizes every known HAE metric to the short types in
// VALID_HEALTH_ENTRY_TYPE (hrv, resting_hr, steps, sleep_night, sleep_nap, vo2max,
// workout) and stores those — only UNMAPPED metric names are kept verbatim. So the
// canonical type is the primary key here; we keep the raw HAE aliases too in case a
// legacy / unmapped export slipped a raw name through.

const TYPE_GROUPS: Record<string, string[]> = {
  hrv:        ["hrv", "heart_rate_variability", "heart_rate_variability_sdnn", "hrv_sdnn"],
  resting_hr: ["resting_hr", "resting_heart_rate"],
  steps:      ["steps", "step_count"],
  sleep:      ["sleep_night", "sleep", "sleep_analysis"],
  sleep_nap:  ["sleep_nap"],
  vo2max:     ["vo2max", "vo2_max"],
  workout:    ["workout"],
};

function byGroup(entries: HealthEntry[], group: string): HealthEntry[] {
  const types = TYPE_GROUPS[group] ?? [group];
  return entries.filter((e) => types.includes(e.type));
}

// Extract the "headline number" from an entry. The canonical taxonomy carries the
// per-day metric aggregate in data.value (hrv=ms, resting_hr=bpm, steps=count,
// vo2max=mL/kg/min); the trailing keys are legacy fallbacks for any pre-canonical
// shape. Returns the first finite number found, or undefined.
function extractQty(e: HealthEntry, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = e.data[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

// ── View ────────────────────────────────────────────────────────────────────

export function HealthView({
  entries: initialEntries,
  total: initialTotal,
  version,
}: {
  entries: HealthEntry[];
  total: number;
  version?: number;
}) {
  // Live entries list + total, seeded from SSR. The board version we last reconciled to — a
  // ref so the SSE callback always compares against the freshest value (mirrors the views).
  const [entries, setEntries] = useState<HealthEntry[]>(initialEntries);
  const [total, setTotal] = useState<number>(initialTotal);
  const lastVersion = useRef<number>(version ?? 0);

  // A surfaced INITIAL-LOAD failure. The dashboard is SSR-seeded, so in the normal flow
  // there is no client fetch to fail and this stays null. The ONE place it can fire is the
  // verification fetch below: when the SSR seed is empty we re-read once to tell a genuine
  // zero-entry log apart from a 500/network failure that would otherwise masquerade as
  // "no data yet" — a throw there shows the rose role="alert" banner instead of the cheerful
  // empty card. A failed live REFETCH (M1) NEVER touches this — it stays silent / keeps
  // last-known, mirroring the addons-view posture (refetch failures silent, flips show).
  const [error, setError] = useState<string | null>(null);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full health time-series (same 500-row cap as the SSR seed) and advance
  // lastVersion. getFitnessData throws on a non-2xx; a failed refetch is NON-CRITICAL — it
  // just leaves the last-known entries in place (no banner, no flicker), so a transient
  // 500/network blip never wipes the dashboard to its empty state. `surface` controls
  // whether a failure is shown (the empty-seed verification) or swallowed (live refetch).
  const refetch = async (surface = false): Promise<void> => {
    try {
      const res = await getFitnessData({ limit: 500 });
      setEntries(res.entries);
      setTotal(res.total);
      lastVersion.current = res.version ?? lastVersion.current;
      setError(null);
    } catch (e) {
      if (surface) {
        // The initial load genuinely failed — surface it rather than render "no data yet".
        setError(e instanceof Error ? e.message : "Health data couldn't be loaded.");
      }
      // Live refetch (surface=false): non-critical — keep last-known; the next event retries.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // Initial-load verification — ONLY when the SSR seed is empty. A non-empty seed is already
  // authoritative (no client fetch, the banner stays dormant). An empty seed is ambiguous:
  // a genuinely empty log vs. a seed that couldn't be read. We re-read once with surface=true
  // so a failure shows the banner (M6) while a true zero-entry response keeps the empty card.
  // Mount-once; `entries.length === 0` is evaluated at mount (the SSR seed), not re-run later.
  useEffect(() => {
    if (initialEntries.length === 0) void refetch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dashboard sections, derived from the live list. Recomputed only when entries change.
  const sections = useMemo(
    () => ({
      hrv: byGroup(entries, "hrv"),
      steps: byGroup(entries, "steps"),
      vo2max: byGroup(entries, "vo2max"),
      restingHr: byGroup(entries, "resting_hr"),
      workouts: entries.filter((e) => e.type === "workout" && typeof e.data.activity === "string"),
      sleep: byGroup(entries, "sleep"),
      naps: byGroup(entries, "sleep_nap"),
    }),
    [entries],
  );
  const hasAny = entries.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      {/* Initial-load failure — the rose role="alert" banner (mirrors addons-view). In the
          normal SSR-seeded flow this never renders; live refetch failures stay silent. */}
      {error ? (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
          <IconWarning className="w-4 h-4 mt-px shrink-0 text-rose-500" />
          <span className="flex-1">{error}</span>
        </div>
      ) : !hasAny ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold text-ink-900">Health Dashboard</h1>
            <span className="text-[12px] text-ink-400 tabular-nums">{total} entries</span>
          </div>

          <FormScoreWidget />

          <MetricCards
            hrv={sections.hrv}
            steps={sections.steps}
            vo2max={sections.vo2max}
            restingHr={sections.restingHr}
          />
          <WorkoutsSection entries={sections.workouts} />
          <SleepSection entries={sections.sleep} />
          <NapSection entries={sections.naps} />
        </>
      )}
    </div>
  );
}

// ── Section components ──────────────────────────────────────────────────────

function WorkoutsSection({ entries }: { entries: HealthEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink-900 mb-2">Workouts</h2>
      <div className="overflow-x-auto rounded-lg border border-ink-100">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-ink-100 bg-ink-50 text-ink-500">
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Activity</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
              <th className="text-right px-3 py-2 font-medium">Distance</th>
              <th className="text-right px-3 py-2 font-medium">Avg HR</th>
              <th className="text-right px-3 py-2 font-medium">Calories</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-ink-50/50 transition">
                {/* Workout ts is a FULL ISO instant — format with the timestamp helpers (no shift). */}
                <td className="px-3 py-2 text-ink-600 whitespace-nowrap">
                  {formatTimestampDay(e.ts)} {formatTime(e.ts)}
                </td>
                <td className="px-3 py-2 text-ink-900 font-medium">{String(e.data.activity ?? "—")}</td>
                <td className="px-3 py-2 text-right text-ink-700 tabular-nums">{fmtDuration(e.data.duration_min)}</td>
                <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                  {typeof e.data.distance_km === "number" ? `${num(e.data.distance_km)} km` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                  {typeof e.data.avg_hr === "number" ? `${num(e.data.avg_hr)} bpm` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                  {typeof e.data.calories === "number" ? `${num(e.data.calories)} kcal` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SleepSection({ entries }: { entries: HealthEntry[] }) {
  if (entries.length === 0) return null;

  // Metadata lives at data.metadata (sleep stages in hours from HAE).
  const meta = (e: HealthEntry) => (e.data.metadata ?? {}) as Record<string, unknown>;

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink-900 mb-2">Sleep</h2>
      <div className="overflow-x-auto rounded-lg border border-ink-100">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-ink-100 bg-ink-50 text-ink-500">
              <th className="text-left px-3 py-2 font-medium">Night</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
              <th className="text-right px-3 py-2 font-medium">Deep</th>
              <th className="text-right px-3 py-2 font-medium">REM</th>
              <th className="text-right px-3 py-2 font-medium">Core</th>
              <th className="text-right px-3 py-2 font-medium">Awake</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {entries.map((e) => {
              const m = meta(e);
              // value = totalSleep in hours
              const dur = extractQty(e, "value");
              return (
                <tr key={e.id} className="hover:bg-ink-50/50 transition">
                  {/* Sleep ts is a BARE "YYYY-MM-DD" — formatDay (no new Date, no UTC shift). */}
                  <td className="px-3 py-2 text-ink-600 whitespace-nowrap">{formatDay(e.ts)}</td>
                  <td className="px-3 py-2 text-right text-ink-900 font-medium tabular-nums">
                    {fmtHours(dur)}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">{fmtHours(m.deep)}</td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">{fmtHours(m.rem)}</td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">{fmtHours(m.core)}</td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">{fmtHours(m.awake)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NapSection({ entries }: { entries: HealthEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink-900 mb-2">Naps</h2>
      <div className="overflow-x-auto rounded-lg border border-ink-100">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-ink-100 bg-ink-50 text-ink-500">
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-ink-50/50 transition">
                {/* Nap ts is a BARE "YYYY-MM-DD" — formatDay (no new Date, no UTC shift). */}
                <td className="px-3 py-2 text-ink-600 whitespace-nowrap">{formatDay(e.ts)}</td>
                <td className="px-3 py-2 text-right text-ink-900 font-medium tabular-nums">
                  {fmtHours(extractQty(e, "value"))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricCards({ hrv, steps, vo2max, restingHr }: {
  hrv: HealthEntry[];
  steps: HealthEntry[];
  vo2max: HealthEntry[];
  restingHr: HealthEntry[];
}) {
  const cards: { label: string; value: string; sub: string }[] = [];

  if (hrv.length > 0) {
    const latest = hrv[0];
    const v = extractQty(latest, "value", "avg_ms");
    cards.push({
      label: "HRV",
      value: v != null ? `${num(v)} ms` : "—",
      sub: formatDay(latest.ts),
    });
  }

  if (restingHr.length > 0) {
    const latest = restingHr[0];
    const v = extractQty(latest, "value", "bpm");
    cards.push({
      label: "Resting HR",
      value: v != null ? `${num(v)} bpm` : "—",
      sub: formatDay(latest.ts),
    });
  }

  if (steps.length > 0) {
    // Show today's steps; fall back to yesterday if no data today.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const todayEntry = steps.find((e) => e.ts === today);
    const latest = todayEntry ?? steps.find((e) => e.ts === yesterday) ?? steps[0];
    const v = extractQty(latest, "value", "count");
    cards.push({
      label: "Steps",
      value: v != null ? Math.round(v).toLocaleString() : "—",
      sub: formatDay(latest.ts),
    });
  }

  if (vo2max.length > 0) {
    const latest = vo2max[0];
    const v = extractQty(latest, "value");
    cards.push({
      label: "VO2 Max",
      value: v != null ? `${num(v)} mL/kg/min` : "—",
      sub: formatDay(latest.ts),
    });
  }

  if (cards.length === 0) return null;

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink-900 mb-2">Latest Metrics</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{c.label}</p>
            <p className="mt-1 text-[20px] font-semibold text-ink-900 tabular-nums leading-tight">{c.value}</p>
            <p className="mt-0.5 text-[11px] text-ink-400">{c.sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// The friendly empty state — shown ONLY on a genuine zero-entry response (a load failure
// shows the rose banner above instead). The dashed EmptyState recipe (mirrors the Food
// Log surface): a muted glyph, a headline, and a chief-of-staff-voiced prompt — no raw
// endpoint copy (the human asks their chief of staff; they don't POST to a route).
function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconHeart className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">No health data yet</p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">
        Once your Apple Watch metrics sync — workouts, sleep, HRV, steps — they appear here,
        with your latest readings up top and the full history below.
      </p>
    </div>
  );
}
