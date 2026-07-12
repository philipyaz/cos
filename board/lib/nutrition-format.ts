// Shared PURE display/date/unit helpers for the Nutrition & Chef feature — the single home
// for the small formatters that were previously copy-pasted across the food-log / pantry /
// meal-plan / weight-loss views, the SSR log page, and the targets route. Keeping them here
// removes the drift risk on a safety-relevant constant (the kg↔lb factor) and on the
// "SSR `today` must match the client's Today" coupling, with no behaviour change.
//
// This module is I/O-free and clock-free except `toISODay(new Date())` at the explicit
// call sites — it imports nothing app-specific, so it is safe to use from server components,
// route handlers, AND client components alike. As of v14 it is ALSO the home for the small
// shared calendar/trend helpers + the adherence/guardrail value types that used to live in the
// retired weight-loss engine (lib/nutrition-targets.ts) — re-homed here so the surviving views
// (weight-chart, food-log-view, weight-loss panel) and the new body-baseline read ONE source.

// ── Calendar-day formatting ─────────────────────────────────────────────────────
// "YYYY-MM-DD" for a Date in LOCAL time — the user's wall-calendar day (NOT UTC). Used to
// mark "Today", to seed the SSR `today` the engine projects against, and as a window bound.
// Reading local parts (not toISOString) keeps SSR and the first client render on the SAME
// day in any timezone.
export function toISODay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// A readable, DETERMINISTIC date from a bare "YYYY-MM-DD" string → "MMM D, YYYY". We format
// from the string PARTS (not new Date(iso), which parses as UTC midnight and could shift the
// day in a behind-UTC timezone, drifting between SSR and client).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

// ── Weight unit conversion (canonical storage is ALWAYS kilograms) ────────────────
// Pounds → kilograms, exact: 1 lb = 0.45359237 kg. "lb" is only ever a DISPLAY / entry unit;
// every weight is stored in kg, converted at the UI/route boundary. Single-sourced here so a
// typo can't silently diverge the weight-loss panel from the goal drawer (or the route).
export const LB_TO_KG = 0.45359237;

// A canonical-kg value → its number in the chosen display unit (kg passes through; lb divides).
export function kgToDisplay(kg: number, unit: "kg" | "lb"): number {
  return unit === "lb" ? kg / LB_TO_KG : kg;
}

// A number typed in the chosen display unit → canonical kg (kg passes through; lb multiplies).
export function displayToKg(value: number, unit: "kg" | "lb"): number {
  return unit === "lb" ? value * LB_TO_KG : value;
}

// ── Calendar-day arithmetic + trend smoothing (re-homed from the retired engine, v14) ─────────
// The smoothing factor for the weight-trend EWMA (exponentially-weighted moving average); damps
// daily water-weight noise so the trend reflects real change.
export const EWMA_ALPHA = 0.25;

// Plain calendar arithmetic on a "YYYY-MM-DD" string (UTC-noon anchored so a day shift is never a
// DST/timezone off-by-one). Returns a "YYYY-MM-DD" string `n` days after `day`. The single
// noon-anchored implementation the views + the body-baseline share.
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ── Adherence + guardrail value types (re-homed from the retired engine, v14) ─────────────────
// Per-day adherence status, judged against a daily calorie target (consumed by the food-log view).
export type AdherenceStatus = "under" | "on_track" | "over" | "well_over";

export interface DayAdherence {
  date: string; // the calendar day
  calories: number; // total kcal logged that day
  target: number; // the daily calorie target (0 when none is set)
  deltaKcal: number; // calories − target (negative = under)
  status: AdherenceStatus;
}

// A guardrail flag — the always-on not-medical-advice note ("info") + any safety warn ("warn").
export type GuardrailLevel = "info" | "warn";
export interface GuardrailFlag {
  id: string; // stable key (e.g. "low-calorie")
  level: GuardrailLevel;
  message: string;
}
