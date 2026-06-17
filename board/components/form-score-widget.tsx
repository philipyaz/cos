"use client";

// The shared daily form-score ("readiness") widget, rendered on the overview (/fitness) and
// the health (/fitness/health) pages. Like AddonsView, it is SELF-CONTAINED and LIVE: it
// fetches its own form score and subscribes to the board's SSE version stream via
// useLiveBoard, so a fresh health push (an Apple Watch sync, a workout log) re-runs the score
// without a reload. It takes NO props — both host pages render <FormScoreWidget /> — so its
// version cursor lives entirely inside it.

import { useRef, useState } from "react";
import { getFormScore, type FormScoreResponse } from "@/lib/fitness-client";
import { useLiveBoard } from "@/lib/use-live-board";

const COLOR_MAP: Record<string, { ring: string; text: string; badge: string }> = {
  green: {
    ring: "border-emerald-300 bg-emerald-50",
    text: "text-emerald-600",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  amber: {
    ring: "border-amber-300 bg-amber-50",
    text: "text-amber-600",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
  },
  // Canonical bad/danger tone is rose (matching the nutrition surfaces' rose-500), not red.
  // The score-helper emits color: "red" for the low/insufficient tiers — we map that key here.
  red: {
    ring: "border-rose-300 bg-rose-50",
    text: "text-rose-600",
    badge: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

const BREAKDOWN_LABELS: {
  key: keyof FormScoreResponse["breakdown"];
  label: string;
  weight: string;
}[] = [
  { key: "hrv", label: "HRV", weight: "30%" },
  { key: "sleep", label: "Sleep", weight: "30%" },
  { key: "resting_hr", label: "Resting HR", weight: "20%" },
  { key: "load", label: "Load", weight: "20%" },
];

function barColor(v: number): string {
  if (v >= 75) return "bg-emerald-400";
  if (v >= 50) return "bg-amber-400";
  return "bg-rose-400";
}

// Human-readable tier name for a per-metric value, mirroring barColor's thresholds — used in
// the bars' title/aria-label so the tier (conveyed otherwise only by fill color + width) is
// available to screen readers and on hover.
function barTier(v: number): string {
  if (v >= 75) return "good";
  if (v >= 50) return "moderate";
  return "low";
}

export function FormScoreWidget() {
  // Last-known score (null until the first fetch resolves) + a one-shot loading flag for the
  // initial skeleton. The board version we last reconciled to lives in a ref so the SSE
  // callback always compares against the freshest value (mirrors the view surfaces). Seeded
  // to 0 (NOT a real version) so the SSE `hello` on connect always passes useLiveBoard's
  // `v > lastVersion` guard and fetches the authoritative score on mount.
  const [data, setData] = useState<FormScoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const lastVersion = useRef<number>(0);

  // Refetch today's form score and reseed, advancing lastVersion to the version the payload
  // was computed against. A throw just leaves the last-known score in place — the next change
  // event retries — so a transient failure never blanks the widget.
  const refetch = async (): Promise<void> => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res = await getFormScore(today);
      setData(res);
      if (typeof res.version === "number") lastVersion.current = res.version;
    } catch {
      // Non-critical: keep the last-known score; the next change event retries.
    } finally {
      setLoading(false);
    }
  };

  useLiveBoard(lastVersion, refetch);

  if (loading) {
    return (
      <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
        <div className="h-20 rounded-md bg-ink-50 animate-pulse" />
      </div>
    );
  }

  if (!data) return null;

  const palette = COLOR_MAP[data.color] ?? COLOR_MAP.amber;

  return (
    <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
      <div className="flex gap-5 items-start">
        {/* Score circle */}
        <div
          className={`w-20 h-20 shrink-0 rounded-2xl border-2 flex flex-col items-center justify-center ${palette.ring}`}
        >
          <span className={`text-[28px] font-bold leading-none tabular-nums ${palette.text}`}>
            {data.score}
          </span>
          <span className="text-[10px] font-medium text-ink-400 mt-0.5">/ 100</span>
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
              Form score
            </p>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${palette.badge}`}>
              {data.level}
            </span>
          </div>

          {/* Breakdown bars. Each bar conveys its tier by fill color + width (and the numeric
              value beside it); the per-metric title/aria-label names the metric, value, and
              tier so the tier isn't color-only — without claiming progressbar semantics. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-2.5">
            {BREAKDOWN_LABELS.map(({ key, label, weight }) => {
              const v = data.breakdown[key];
              const desc = `${label}: ${v} of 100 (${barTier(v)})`;
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-500 w-16 shrink-0">{label}</span>
                  <div
                    className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden"
                    title={desc}
                    aria-label={desc}
                  >
                    <div
                      className={`h-full rounded-full transition-all ${barColor(v)}`}
                      style={{ width: `${v}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-ink-500 tabular-nums w-7 text-right">
                    {v}
                  </span>
                  <span className="text-[9px] text-ink-300">{weight}</span>
                </div>
              );
            })}
          </div>

          {/* Recommendation */}
          <p className="text-[12px] text-ink-600 leading-relaxed">{data.recommendation}</p>
        </div>
      </div>
    </div>
  );
}
