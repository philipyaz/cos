"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/topbar";
import { FormScoreWidget } from "@/components/form-score-widget";

// ── Types (mirror HealthEntry from @/lib/types) ─────────────────────────────

interface HealthEntry {
  id: string;
  ts: string;
  type: string;
  data: Record<string, unknown>;
  pushedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

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

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchHealthData(): Promise<{ entries: HealthEntry[]; total: number }> {
  const res = await fetch("/api/health/data?limit=500");
  if (!res.ok) return { entries: [], total: 0 };
  return res.json();
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
                <td className="px-3 py-2 text-ink-600 whitespace-nowrap">
                  {fmtDate(e.ts)} {fmtTime(e.ts)}
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
                  <td className="px-3 py-2 text-ink-600 whitespace-nowrap">{fmtDate(e.ts)}</td>
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
                <td className="px-3 py-2 text-ink-600 whitespace-nowrap">{fmtDate(e.ts)}</td>
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
      sub: fmtDate(latest.ts),
    });
  }

  if (restingHr.length > 0) {
    const latest = restingHr[0];
    const v = extractQty(latest, "value", "bpm");
    cards.push({
      label: "Resting HR",
      value: v != null ? `${num(v)} bpm` : "—",
      sub: fmtDate(latest.ts),
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
      sub: fmtDate(latest.ts),
    });
  }

  if (vo2max.length > 0) {
    const latest = vo2max[0];
    const v = extractQty(latest, "value");
    cards.push({
      label: "VO2 Max",
      value: v != null ? `${num(v)} mL/kg/min` : "—",
      sub: fmtDate(latest.ts),
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

// ── Page ────────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const [entries, setEntries] = useState<HealthEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHealthData().then((r) => {
      setEntries(r.entries);
      setTotal(r.total);
      setLoading(false);
    });
  }, []);

  return (
    <>
      <TopBar crumbs={["Cos", "Health"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        {loading ? (
          <p className="text-[13px] text-ink-400">Loading health data...</p>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-ink-100 bg-white p-6 text-center shadow-card">
            <p className="text-[13px] text-ink-500">
              No health data yet. Push data from your Apple Watch via the{" "}
              <code className="px-1 py-0.5 rounded bg-ink-50 text-ink-700 text-[12px]">
                POST /api/health/push
              </code>{" "}
              endpoint.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <h1 className="text-[15px] font-semibold text-ink-900">Health Dashboard</h1>
              <span className="text-[12px] text-ink-400">{total} entries</span>
            </div>

            <FormScoreWidget />

            <MetricCards
              hrv={byGroup(entries, "hrv")}
              steps={byGroup(entries, "steps")}
              vo2max={byGroup(entries, "vo2max")}
              restingHr={byGroup(entries, "resting_hr")}
            />
            <WorkoutsSection entries={entries.filter((e) => e.type === "workout" && typeof e.data.activity === "string")} />
            <SleepSection entries={byGroup(entries, "sleep")} />
            <NapSection entries={byGroup(entries, "sleep_nap")} />
          </>
        )}
      </main>
    </>
  );
}
