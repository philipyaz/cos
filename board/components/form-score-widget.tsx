"use client";

import { useEffect, useState } from "react";

interface FormScore {
  date: string;
  score: number;
  level: string;
  color: string;
  breakdown: { hrv: number; sleep: number; resting_hr: number; load: number };
  recommendation: string;
}

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
  red: {
    ring: "border-red-300 bg-red-50",
    text: "text-red-600",
    badge: "bg-red-50 text-red-700 border-red-200",
  },
};

const BREAKDOWN_LABELS: { key: keyof FormScore["breakdown"]; label: string; weight: string }[] = [
  { key: "hrv", label: "HRV", weight: "30%" },
  { key: "sleep", label: "Sleep", weight: "30%" },
  { key: "resting_hr", label: "Resting HR", weight: "20%" },
  { key: "load", label: "Load", weight: "20%" },
];

function barColor(v: number): string {
  if (v >= 75) return "bg-emerald-400";
  if (v >= 50) return "bg-amber-400";
  return "bg-red-400";
}

export function FormScoreWidget() {
  const [data, setData] = useState<FormScore | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    fetch(`/api/fitness/form-score?date=${today}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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

          {/* Breakdown bars */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-2.5">
            {BREAKDOWN_LABELS.map(({ key, label, weight }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-[11px] text-ink-500 w-16 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${barColor(data.breakdown[key])}`}
                    style={{ width: `${data.breakdown[key]}%` }}
                  />
                </div>
                <span className="text-[11px] text-ink-500 tabular-nums w-7 text-right">
                  {data.breakdown[key]}
                </span>
                <span className="text-[9px] text-ink-300">{weight}</span>
              </div>
            ))}
          </div>

          {/* Recommendation */}
          <p className="text-[12px] text-ink-600 leading-relaxed">{data.recommendation}</p>
        </div>
      </div>
    </div>
  );
}
