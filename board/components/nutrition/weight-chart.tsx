// The weight-vs-intake chart — a hand-rolled inline SVG (no chart library; house rule)
// that overlays two series for the last ~14 days onto ONE frame:
//   • per-day CALORIE bars, colored by adherence status (green on_track, amber over,
//     rose well_over, slate for under/neutral), with a horizontal DASHED target line, and
//   • the smoothed WEIGHT-TREND polyline on a SECONDARY (right) axis.
// It is fully DETERMINISTIC — it takes its data + `today` as props and never calls
// new Date() (so SSR and the first client render agree). It degrades gracefully: with no
// calorie days AND fewer than 2 weigh-ins it renders nothing (the caller hides it); with
// a single weigh-in it draws a dot instead of a line; the bars and the trend each scale
// independently so either can be missing.
//
// The two scales are intentionally independent: calories map to the LEFT/bottom (bars
// grow up from the baseline), weight to the RIGHT (the polyline floats over the bars).
// Both are padded so the extremes don't touch the frame. All geometry is computed in a
// fixed VIEWBOX and the SVG scales to its container via width/height 100%.

import type { WeightEntry } from "@/lib/types";
import type { DayAdherence, AdherenceStatus } from "@/lib/nutrition-targets";

// Fixed drawing surface (viewBox units; the SVG itself is responsive). Generous left/right
// gutters leave room for the two axes' tick labels; the bottom gutter holds the day ticks.
const VB_W = 520;
const VB_H = 180;
const PAD_L = 36; // left gutter — calorie (kcal) axis ticks
const PAD_R = 34; // right gutter — weight (kg) axis ticks
const PAD_T = 12;
const PAD_B = 22; // bottom gutter — day ticks
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;

// Per-status bar fill (literal Tailwind-palette hexes so the SVG fills are deterministic
// and match the chips elsewhere: emerald-500 / amber-400 / rose-500 / slate-300).
const BAR_FILL: Record<AdherenceStatus, string> = {
  under: "#cbd5e1", // slate-300 — well under target (neutral, not a "win" nor a problem)
  on_track: "#10b981", // emerald-500
  over: "#fbbf24", // amber-400
  well_over: "#f43f5e", // rose-500
};

// One chart-ready day: its calorie total + adherence status (for the bar color) joined to
// that day's smoothed weight trend (for the polyline). Either side may be absent.
type ChartDay = {
  date: string;
  calories: number | null;
  status: AdherenceStatus | null;
  trendKg: number | null;
};

export function WeightChart({
  weights,
  adherence,
  today,
  windowDays = 14,
}: {
  weights: WeightEntry[]; // the full weigh-in series (any order); we window + sort here
  adherence: DayAdherence[]; // per-day calorie totals + status (from the targets envelope)
  today: string; // "YYYY-MM-DD" — the right edge of the window (no clock in render)
  windowDays?: number;
}) {
  // Build the contiguous day axis [today − (windowDays − 1) … today], then join each day to
  // its calorie total/status and its EWMA trend weight. The trend is computed incrementally
  // over the whole series so each day reflects all weigh-ins up to and including it.
  const days = buildChartDays(weights, adherence, today, windowDays);

  // Decide what we can actually draw. Bars need at least one day with a calorie total; the
  // trend line needs at least one day with a trend weight (a single point renders as a dot).
  const calDays = days.filter((d) => d.calories != null);
  const trendDays = days.filter((d) => d.trendKg != null);
  const hasBars = calDays.length > 0;
  const hasTrend = trendDays.length > 0;

  // Nothing to show — the panel hides the chart in this case, but guard here too so the
  // component is safe to render unconditionally.
  if (!hasBars && trendDays.length < 1) {
    return null;
  }

  // ── Calorie (left) scale ──────────────────────────────────────────────────────
  // Bars grow up from the baseline. The top of the scale is the max of the day totals and
  // the target line, padded ~12% so a max-day bar (or the target) doesn't kiss the frame.
  const maxCal = Math.max(0, ...calDays.map((d) => d.calories ?? 0));
  // The target line: take the first non-zero target seen (it's the same for every day).
  const targetCal = adherence.find((a) => a.target > 0)?.target ?? 0;
  const calTop = Math.max(maxCal, targetCal) * 1.12 || 1; // avoid a zero-height scale
  const calY = (kcal: number): number => PAD_T + PLOT_H - (kcal / calTop) * PLOT_H;

  // ── Weight (right) scale ──────────────────────────────────────────────────────
  // The trend polyline floats on its own min→max range, padded so a flat series still has
  // a visible band. With a single trend point we centre it (a flat half-height line).
  const trendVals = trendDays.map((d) => d.trendKg as number);
  const wMinRaw = Math.min(...trendVals);
  const wMaxRaw = Math.max(...trendVals);
  const wSpan = wMaxRaw - wMinRaw;
  const wPad = wSpan > 0 ? wSpan * 0.25 : 1; // pad flat series so the line isn't on the edge
  const wMin = wMinRaw - wPad;
  const wMax = wMaxRaw + wPad;
  const weightY = (kg: number): number =>
    wMax === wMin ? PAD_T + PLOT_H / 2 : PAD_T + PLOT_H - ((kg - wMin) / (wMax - wMin)) * PLOT_H;

  // X positions: each day gets an equal column; bars centre in their column with a small gap.
  const n = days.length;
  const colW = PLOT_W / n;
  const barW = Math.max(2, colW * 0.62);
  const colX = (i: number): number => PAD_L + colW * i + colW / 2; // column centre

  // The trend polyline points (only the days that HAVE a trend, in order). Each point
  // carries its kg value so the dot tooltip reads it directly (no back-lookup).
  const trendPts = days
    .map((d, i) => (d.trendKg != null ? { x: colX(i), y: weightY(d.trendKg), kg: d.trendKg } : null))
    .filter((p): p is { x: number; y: number; kg: number } => p !== null);
  const trendPath = trendPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  // Axis tick labels — calorie axis shows 0 / target / top; weight axis shows min / max.
  const baselineY = PAD_T + PLOT_H;

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Daily calories versus weight trend over the last two weeks"
        preserveAspectRatio="none"
      >
        {/* Baseline (calorie zero / chart floor). */}
        <line x1={PAD_L} y1={baselineY} x2={PAD_L + PLOT_W} y2={baselineY} stroke="#e2e8f0" strokeWidth={1} />

        {/* Calorie bars — one per day with a logged total, colored by adherence status. */}
        {hasBars &&
          days.map((d, i) =>
            d.calories != null ? (
              <rect
                key={`bar-${d.date}`}
                x={colX(i) - barW / 2}
                y={calY(d.calories)}
                width={barW}
                height={Math.max(0, baselineY - calY(d.calories))}
                rx={1.5}
                fill={d.status ? BAR_FILL[d.status] : BAR_FILL.under}
                opacity={0.9}
              >
                <title>{`${d.date}: ${Math.round(d.calories)} kcal`}</title>
              </rect>
            ) : null,
          )}

        {/* Dashed TARGET line across the calorie scale (only when a target exists). */}
        {targetCal > 0 && (
          <>
            <line
              x1={PAD_L}
              y1={calY(targetCal)}
              x2={PAD_L + PLOT_W}
              y2={calY(targetCal)}
              stroke="#64748b"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text x={PAD_L - 4} y={calY(targetCal) + 3} textAnchor="end" fill="#8a909c" style={{ fontSize: 9 }}>
              {Math.round(targetCal)}
            </text>
          </>
        )}

        {/* Calorie axis: 0 at the baseline, the scale top label. */}
        <text x={PAD_L - 4} y={baselineY + 3} textAnchor="end" fill="#b0b5be" style={{ fontSize: 9 }}>
          0
        </text>

        {/* Weight-trend overlay — polyline (≥2 points) or a single dot (1 point). */}
        {hasTrend && trendPts.length >= 2 && (
          <path d={trendPath} fill="none" stroke="#6366f1" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        )}
        {hasTrend &&
          trendPts.map((p, i) => (
            <circle key={`wp-${i}`} cx={p.x} cy={p.y} r={1.9} fill="#6366f1">
              <title>{`${p.kg.toFixed(1)} kg`}</title>
            </circle>
          ))}

        {/* Weight (right) axis tick labels — the trend's min and max in kg. */}
        {hasTrend && (
          <>
            <text x={PAD_L + PLOT_W + 4} y={weightY(wMaxRaw) + 3} textAnchor="start" fill="#818cf8" style={{ fontSize: 9 }}>
              {wMaxRaw.toFixed(1)}
            </text>
            <text x={PAD_L + PLOT_W + 4} y={weightY(wMinRaw) + 3} textAnchor="start" fill="#818cf8" style={{ fontSize: 9 }}>
              {wMinRaw.toFixed(1)}
            </text>
          </>
        )}

        {/* Day ticks — label the first, middle, and last day of the window (D-of-month). */}
        {[0, Math.floor(n / 2), n - 1].map((i) => (
          <text key={`xt-${i}`} x={colX(i)} y={VB_H - 6} textAnchor="middle" fill="#b0b5be" style={{ fontSize: 9 }}>
            {dayOfMonth(days[i].date)}
          </text>
        ))}
      </svg>

      {/* Legend — the bar colors + the two overlays, so the dual scale reads clearly. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-ink-400">
        <LegendSwatch color="#10b981" label="On track" />
        <LegendSwatch color="#fbbf24" label="Over" />
        <LegendSwatch color="#f43f5e" label="Well over" />
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-0 border-t border-dashed border-ink-400" aria-hidden />
          <span>Target</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-[1.5px]" style={{ backgroundColor: "#6366f1" }} aria-hidden />
          <span>Weight trend (kg)</span>
        </span>
      </div>
    </div>
  );
}

// A small color square + label for the legend.
function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

// ── Local helpers (deterministic; mirror the engine's UTC-noon day arithmetic) ───
// Build the contiguous day axis [today − (windowDays − 1) … today] and join each day to
// its calorie total/status (from adherence) and its EWMA trend weight (computed over the
// whole series up to that day, so the in-window trend reflects all prior weigh-ins).
function buildChartDays(
  weights: WeightEntry[],
  adherence: DayAdherence[],
  today: string,
  windowDays: number,
): ChartDay[] {
  const from = addDays(today, -(windowDays - 1));

  // Calorie totals/status keyed by day (adherence already has one row per logged day).
  const calByDay = new Map<string, DayAdherence>();
  for (const a of adherence) calByDay.set(a.date, a);

  // EWMA trend over the WHOLE series (ascending), recording the running ema at each weigh-in
  // day so a day in the window picks up the trend value as of that day's most recent weigh-in.
  const sorted = [...weights].filter((w) => w.date <= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const EWMA_ALPHA = 0.25; // mirrors the engine's smoothing factor (kept local to stay I/O-free)
  const emaByDay = new Map<string, number>();
  let ema: number | null = null;
  for (const w of sorted) {
    ema = ema == null ? w.weightKg : EWMA_ALPHA * w.weightKg + (1 - EWMA_ALPHA) * ema;
    emaByDay.set(w.date, ema); // a same-day re-weigh overwrites with the later ema (fine)
  }

  // Walk the window day by day, carrying the last-known ema forward (so a day with no
  // weigh-in still floats on the most recent trend value, giving a continuous line).
  const out: ChartDay[] = [];
  let carriedEma: number | null = null;
  // Seed carriedEma with the last ema strictly BEFORE the window, so the line starts mid-air
  // rather than null when the first weigh-in predates the window.
  for (const w of sorted) {
    if (w.date < from) carriedEma = emaByDay.get(w.date) ?? carriedEma;
    else break;
  }
  let cursor = from;
  for (let i = 0; i < windowDays; i++) {
    if (emaByDay.has(cursor)) carriedEma = emaByDay.get(cursor) as number;
    const cal = calByDay.get(cursor);
    out.push({
      date: cursor,
      calories: cal ? cal.calories : null,
      status: cal ? cal.status : null,
      trendKg: carriedEma,
    });
    cursor = addDays(cursor, 1);
  }
  return out;
}

// "YYYY-MM-DD" + n days, UTC-noon anchored (no DST off-by-one) — mirrors nutrition-targets.
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// The day-of-month for an x-axis tick, read straight from the "YYYY-MM-DD" string parts
// (no Date parse — deterministic and timezone-proof).
function dayOfMonth(iso: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(iso);
  return m ? String(Number(m[1])) : iso;
}
