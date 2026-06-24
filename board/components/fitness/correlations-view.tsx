"use client";

// The Sleep / Performance correlation surface — now STATEFUL. The route is PURE COMPUTE
// (Pearson's r sleep-vs-performance + deep-sleep-vs-performance, a linear regression over the
// health time-series) and best-effort persists each report on db.coachingArtifacts keyed by
// the analysed window ("<from>_<to>"). The human picks a lookback window and hits "Analyze";
// GET /api/fitness/correlations?days=N computes + persists, and the shared <ArtifactFeed>
// refetches the kind="correlations" history — newest by default, page-back rail. This view
// owns only the per-item presentation (stats cards, SVG scatter plot, data table) + the days
// select (hosted as the feed's headerExtra, since it parameterizes the generate GET).

import { useState } from "react";
import { IconRunner } from "@/components/icons";
import { ArtifactFeed } from "@/components/fitness/artifact-feed";

interface DataPoint {
  date: string;
  sleep_h: number;
  deep_h: number | null;
  performance: number;
  calories: number;
  duration_min: number;
}

interface CorrelationData {
  days: number;
  data_points: number;
  from?: string;
  to?: string;
  correlation: {
    sleep_vs_performance: number | null;
    deep_sleep_vs_performance: number | null;
  };
  regression: { slope: number; intercept: number } | null;
  points: DataPoint[];
}

// A correlation coefficient → a labelled strength + a hue + an accessible description.
// The strength bands are the conventional Pearson cutoffs (|r| ≥ 0.7 strong, ≥ 0.4
// moderate, else weak). CRUCIAL (finding L5): a "Strong" positive and a "Strong" negative
// must NOT be distinguished by green-vs-rose hue ALONE — colour-blind / monochrome readers
// would see the same word. So we append the SIGNED direction to the text ("Strong positive"
// / "Strong negative") and carry a full sentence in `title` for the title/aria tooltip.
function corrLabel(r: number | null): { text: string; cls: string; title: string } {
  if (r == null) {
    return {
      text: "Insufficient",
      cls: "text-ink-400",
      title: "Not enough overlapping days to compute a correlation.",
    };
  }
  const abs = Math.abs(r);
  const sign = r > 0 ? "positive" : r < 0 ? "negative" : "none";
  const dir = r > 0 ? " positive" : r < 0 ? " negative" : "";
  const strength = abs >= 0.7 ? "Strong" : abs >= 0.4 ? "Moderate" : "Weak";
  // Hue: strong tracks direction (emerald/rose), moderate is amber, weak is muted ink — but
  // the WORD always carries the sign too, so hue is reinforcement, never the sole signal.
  const cls =
    abs >= 0.7
      ? r > 0
        ? "text-emerald-600"
        : "text-rose-600"
      : abs >= 0.4
        ? "text-amber-600"
        : "text-ink-500";
  const more =
    sign === "none"
      ? "no linear relationship"
      : `more sleep tracks ${sign === "positive" ? "higher" : "lower"} performance`;
  return {
    text: `${strength}${dir}`,
    cls,
    title: `${strength}${dir ? `,${dir}` : ""} correlation (r = ${r.toFixed(3)}) — ${more}.`,
  };
}

// ── SVG Scatter Plot ─────────────────────────────────────────────────────────

const PLOT_W = 600;
const PLOT_H = 360;
const PAD = { top: 20, right: 30, bottom: 40, left: 50 };
const W = PLOT_W - PAD.left - PAD.right;
const H = PLOT_H - PAD.top - PAD.bottom;

function ScatterPlot({
  points,
  regression,
  r,
}: {
  points: DataPoint[];
  regression: { slope: number; intercept: number } | null;
  r: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const xs = points.map((p) => p.sleep_h);
  const ys = points.map((p) => p.performance);
  const xMin = Math.floor(Math.min(...xs) - 0.5);
  const xMax = Math.ceil(Math.max(...xs) + 0.5);
  const yMin = Math.floor(Math.min(...ys) * 0.9);
  const yMax = Math.ceil(Math.max(...ys) * 1.1);

  const sx = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * W;
  const sy = (v: number) => PAD.top + H - ((v - yMin) / (yMax - yMin)) * H;

  // Axis ticks
  const xTicks: number[] = [];
  for (let t = Math.ceil(xMin); t <= Math.floor(xMax); t++) xTicks.push(t);
  const yStep = Math.max(1, Math.round((yMax - yMin) / 5));
  const yTicks: number[] = [];
  for (let t = Math.ceil(yMin / yStep) * yStep; t <= yMax; t += yStep) yTicks.push(t);

  // Regression line
  let regLine: string | null = null;
  if (regression) {
    const y1 = regression.slope * xMin + regression.intercept;
    const y2 = regression.slope * xMax + regression.intercept;
    regLine = `M${sx(xMin)},${sy(y1)} L${sx(xMax)},${sy(y2)}`;
  }

  return (
    <svg viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} className="w-full max-w-[600px]">
      {/* Grid lines */}
      {yTicks.map((t) => (
        <line key={`yg-${t}`} x1={PAD.left} x2={PAD.left + W} y1={sy(t)} y2={sy(t)}
          stroke="#e5e5e5" strokeWidth="1" />
      ))}

      {/* Axes */}
      <line x1={PAD.left} x2={PAD.left + W} y1={PAD.top + H} y2={PAD.top + H}
        stroke="#a3a3a3" strokeWidth="1" />
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + H}
        stroke="#a3a3a3" strokeWidth="1" />

      {/* X axis ticks + labels */}
      {xTicks.map((t) => (
        <g key={`xt-${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={PAD.top + H} y2={PAD.top + H + 4} stroke="#a3a3a3" strokeWidth="1" />
          <text x={sx(t)} y={PAD.top + H + 16} textAnchor="middle" fontSize="10" fill="#737373">{t}h</text>
        </g>
      ))}
      <text x={PAD.left + W / 2} y={PLOT_H - 4} textAnchor="middle" fontSize="11" fill="#525252">
        Sleep (hours)
      </text>

      {/* Y axis ticks + labels */}
      {yTicks.map((t) => (
        <g key={`yt-${t}`}>
          <line x1={PAD.left - 4} x2={PAD.left} y1={sy(t)} y2={sy(t)} stroke="#a3a3a3" strokeWidth="1" />
          <text x={PAD.left - 8} y={sy(t) + 3} textAnchor="end" fontSize="10" fill="#737373">{t}</text>
        </g>
      ))}
      <text x={14} y={PAD.top + H / 2} textAnchor="middle" fontSize="11" fill="#525252"
        transform={`rotate(-90, 14, ${PAD.top + H / 2})`}>
        Performance (kcal/min)
      </text>

      {/* Regression line */}
      {regLine && (
        <path d={regLine} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeDasharray="6,4" opacity="0.6" />
      )}

      {/* Data points */}
      {points.map((p, i) => (
        <g key={i}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
        >
          <circle
            cx={sx(p.sleep_h)} cy={sy(p.performance)} r={hover === i ? 6 : 4}
            fill={hover === i ? "#8b5cf6" : "#6366f1"} opacity={hover === i ? 1 : 0.7}
            stroke="white" strokeWidth="1.5"
            className="transition-all cursor-pointer"
          />
          {hover === i && (
            <g>
              <rect
                x={sx(p.sleep_h) - 60} y={sy(p.performance) - 42}
                width="120" height="34" rx="4"
                fill="#1a1a1a" opacity="0.9"
              />
              <text x={sx(p.sleep_h)} y={sy(p.performance) - 28}
                textAnchor="middle" fontSize="10" fill="white" fontWeight="500">
                {p.date}
              </text>
              <text x={sx(p.sleep_h)} y={sy(p.performance) - 15}
                textAnchor="middle" fontSize="9" fill="#d4d4d4">
                {p.sleep_h.toFixed(1)}h sleep | {p.performance.toFixed(1)} kcal/min
              </text>
            </g>
          )}
        </g>
      ))}

      {/* R value */}
      {r != null && (
        <text x={PAD.left + W - 4} y={PAD.top + 14} textAnchor="end" fontSize="11" fill="#8b5cf6" fontWeight="600">
          r = {r.toFixed(3)}
        </text>
      )}
    </svg>
  );
}

// ── Per-item render (reads a persisted correlation report off the artifact payload) ─────────

function renderReport(payload: Record<string, unknown>) {
  const data = payload as unknown as CorrelationData;
  const points = Array.isArray(data.points) ? data.points : [];

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Days analyzed" value={String(data.data_points)} />
        <StatCard label="Sleep correlation" value={
          data.correlation.sleep_vs_performance != null
            ? `r = ${data.correlation.sleep_vs_performance.toFixed(3)}`
            : "N/A"
        }>
          <CorrLabel r={data.correlation.sleep_vs_performance} />
        </StatCard>
        <StatCard label="Deep sleep correlation" value={
          data.correlation.deep_sleep_vs_performance != null
            ? `r = ${data.correlation.deep_sleep_vs_performance.toFixed(3)}`
            : "N/A"
        }>
          <CorrLabel r={data.correlation.deep_sleep_vs_performance} />
        </StatCard>
        {data.regression && (
          <StatCard label="Trend" value={
            data.regression.slope > 0 ? "Positive" : data.regression.slope < 0 ? "Negative" : "Neutral"
          }>
            <span className="text-[11px] text-ink-400">
              {data.regression.slope > 0 ? "+" : ""}{data.regression.slope.toFixed(2)} kcal/min per hour
            </span>
          </StatCard>
        )}
      </div>

      {/* Scatter plot */}
      {points.length >= 3 ? (
        <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400 mb-3">
            Scatter plot
          </p>
          <ScatterPlot
            points={points}
            regression={data.regression}
            r={data.correlation.sleep_vs_performance}
          />
        </div>
      ) : (
        <EmptyState
          title="Not enough data to chart"
          body="The scatter plot needs at least 3 days with both a logged workout and a sleep figure. Keep logging and check back."
        />
      )}

      {/* Data table */}
      {points.length > 0 && (
        <div className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50 text-ink-500">
                <th className="text-left px-3 py-2 font-medium">Date</th>
                <th className="text-right px-3 py-2 font-medium">Sleep</th>
                <th className="text-right px-3 py-2 font-medium">Deep</th>
                <th className="text-right px-3 py-2 font-medium">Perf (kcal/min)</th>
                <th className="text-right px-3 py-2 font-medium">Calories</th>
                <th className="text-right px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {points.map((p) => (
                <tr key={p.date} className="hover:bg-ink-50/50 transition">
                  <td className="px-3 py-2 text-ink-600">{p.date}</td>
                  <td className="px-3 py-2 text-right text-ink-900 tabular-nums font-medium">
                    {p.sleep_h.toFixed(1)}h
                  </td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                    {p.deep_h != null ? `${p.deep_h.toFixed(1)}h` : "--"}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-900 tabular-nums font-medium">
                    {p.performance.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                    {p.calories} kcal
                  </td>
                  <td className="px-3 py-2 text-right text-ink-700 tabular-nums">
                    {p.duration_min} min
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── View ──────────────────────────────────────────────────────────────────────

export function CorrelationsView() {
  // The lookback window lives here (NOT in the feed) — it parameterizes the generate GET. The
  // feed hosts it as headerExtra so it sits beside the "Analyze" button. Persisted reports are
  // the history; re-analysing the SAME window upserts (no duplicate report per window).
  const [days, setDays] = useState(30);

  const run = async () => {
    const res = await fetch(`/api/fitness/correlations?days=${days}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Error");
  };

  const daysSelect = (
    <select
      value={days}
      onChange={(e) => setDays(Number(e.target.value))}
      className="rounded-md border border-ink-200 bg-white px-2 py-1.5 text-[13px] text-ink-700"
    >
      <option value={14}>14 days</option>
      <option value={30}>30 days</option>
      <option value={60}>60 days</option>
      <option value={90}>90 days</option>
    </select>
  );

  return (
    <ArtifactFeed
      kind="correlations"
      title="Sleep / Performance correlation"
      generate={{ run, label: "Analyze" }}
      emptyHint="Analyze the correlation between your sleep and your training performance over the selected period — pick a window above and hit Analyze."
      renderItem={renderReport}
      headerExtra={daysSelect}
    />
  );
}

// The signed correlation-strength label — the WORD carries the direction (finding L5), and
// the title/aria-label spell out the full sentence, so the meaning never rides on hue alone.
function CorrLabel({ r }: { r: number | null }) {
  const c = corrLabel(r);
  return (
    <span className={`text-[11px] font-medium ${c.cls}`} title={c.title} aria-label={c.title}>
      {c.text}
    </span>
  );
}

function StatCard({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</p>
      <p className="mt-1 text-[18px] font-semibold text-ink-900 tabular-nums leading-tight">{value}</p>
      {children}
    </div>
  );
}

// The dashed empty / insufficient-data state (finding L3) — the shared recipe used across
// the board (mirrors the nutrition Food Log EmptyState): a dashed border, a muted glyph, a
// short title + body. Used here for the "not enough data to chart" case inside a report.
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconRunner className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">{title}</p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">{body}</p>
    </div>
  );
}
