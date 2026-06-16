import { NextResponse, type NextRequest } from "next/server";
import { summarize } from "@/lib/fitness";

export const dynamic = "force-dynamic";

// GET /api/fitness/report?days=N — compose a human-readable Markdown health report
// (for vault ingestion) from the canonical summarize() OUTPUT SHAPE. This is the
// MCP-facing surface: the fitness MCP's ingest_health_to_vault tool fetches this and
// forwards it verbatim — all report COMPOSITION lives here, not in the MCP. Reads are
// ungated (no token needed).
//
// summarize() shape consumed here:
//   sleep?:{count,avg_hours,avg_deep_hours,avg_rem_hours}
//   hrv?:{count,avg_ms}  resting_hr?:{count,avg_bpm}
//   steps?:{days,total,avg_per_day}  vo2max?:{count,latest}
//   workout?:{count,total_duration_min,total_calories,activities:{<name>:<n>}}
export async function GET(req: NextRequest) {
  const daysParam = Number(req.nextUrl.searchParams.get("days") ?? 7);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : 7;

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  const summary = (await summarize({ from: fromStr, to: toStr })) as Summary;

  const lines: string[] = [
    `# Health Report: ${fromStr} to ${toStr}`,
    ``,
    `Source: Apple Watch HealthKit (auto-exported)`,
    `Period: ${days} days`,
    ``,
  ];

  if (summary.sleep) {
    const s = summary.sleep;
    lines.push(`## Sleep`);
    lines.push(`- Average duration: ${fmt(s.avg_hours, 1)} hours`);
    lines.push(`- Average deep sleep: ${fmt(s.avg_deep_hours, 1)} hours`);
    lines.push(`- Average REM: ${fmt(s.avg_rem_hours, 1)} hours`);
    lines.push(`- Nights tracked: ${s.count ?? 0}`);
    lines.push(``);
  }

  if (summary.hrv) {
    const h = summary.hrv;
    lines.push(`## HRV (Heart Rate Variability)`);
    lines.push(`- Average: ${fmt(h.avg_ms, 1)} ms`);
    lines.push(`- Measurements: ${h.count ?? 0}`);
    lines.push(``);
  }

  if (summary.resting_hr) {
    const r = summary.resting_hr;
    lines.push(`## Resting Heart Rate`);
    lines.push(`- Average: ${fmt(r.avg_bpm, 0)} bpm`);
    lines.push(`- Measurements: ${r.count ?? 0}`);
    lines.push(``);
  }

  if (summary.steps) {
    const st = summary.steps;
    lines.push(`## Steps`);
    lines.push(`- Daily average: ${fmt(st.avg_per_day, 0)}`);
    lines.push(`- Total: ${fmt(st.total, 0)}`);
    lines.push(`- Days tracked: ${st.days ?? 0}`);
    lines.push(``);
  }

  if (summary.vo2max) {
    const v = summary.vo2max;
    lines.push(`## VO2 Max`);
    lines.push(`- Latest: ${fmt(v.latest, 1)} mL/kg/min`);
    lines.push(`- Measurements: ${v.count ?? 0}`);
    lines.push(``);
  }

  if (summary.workout) {
    const w = summary.workout;
    lines.push(`## Workouts`);
    lines.push(`- Count: ${w.count ?? 0}`);
    lines.push(`- Total duration: ${fmt(w.total_duration_min, 0)} min`);
    lines.push(`- Total calories: ${fmt(w.total_calories, 0)} kcal`);
    if (w.activities && Object.keys(w.activities).length > 0) {
      lines.push(
        `- Activities: ${Object.entries(w.activities)
          .map(([a, n]) => `${a} (${n})`)
          .join(", ")}`
      );
    }
    lines.push(``);
  }

  const markdown = lines.join("\n");

  return NextResponse.json({
    from: fromStr,
    to: toStr,
    days,
    markdown,
    domain: "life",
  });
}

// ── Local types + formatting ────────────────────────────────────────────────
type Summary = {
  sleep?: { count?: number; avg_hours?: number | null; avg_deep_hours?: number | null; avg_rem_hours?: number | null };
  hrv?: { count?: number; avg_ms?: number | null };
  resting_hr?: { count?: number; avg_bpm?: number | null };
  steps?: { days?: number; total?: number | null; avg_per_day?: number | null };
  vo2max?: { count?: number; latest?: number | null };
  workout?: {
    count?: number;
    total_duration_min?: number | null;
    total_calories?: number | null;
    activities?: Record<string, number>;
  };
};

function fmt(v: number | null | undefined, digits: number): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "N/A";
}
