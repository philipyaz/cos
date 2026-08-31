// Shared PURE display/date/unit helpers for the Nutrition & Chef feature — the single home
// for the small formatters that were previously copy-pasted across the food-log / pantry /
// meal-plan / weight-loss views, the SSR log page, and the targets route. Keeping them here
// removes the drift risk on a safety-relevant constant (the kg↔lb factor) and on the
// "SSR `today` must match the client's Today" coupling, with no behaviour change.
//
// This module is I/O-free and clock-free except `toISODay(new Date())` at the explicit
// call sites — it imports only pure type/constant definitions from ./types (no I/O, no
// framework code), so it is safe to use from server components, route handlers, AND client
// components alike. As of v14 it is ALSO the home for the small shared calendar/trend helpers +
// the adherence/guardrail value types that used to live in the retired weight-loss engine
// (lib/nutrition-targets.ts) — re-homed here so the surviving views (weight-chart, food-log-view,
// weight-loss panel) and the new body-baseline read ONE source. As of v16/cos-ops#38 it is also
// the home for the shopping-list grouping helper (below) — pulled out of the view so the
// type-stripping unit runner (tests/unit/*.test.ts) can import it.

import { VALID_SHOPPING_CATEGORY, type ShoppingItem } from "./types";

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
// (Whole-day DIFFERENCES over "YYYY-MM-DD" strings live in `./staleness` — do not mint one here.)
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

// ── Pantry name normalisation (v14 bulk-reconcile upsert key) ─────────────────────────────────
// The deterministic identity key POST /api/nutrition/pantry/reconcile upserts on: strip accents
// (Unicode-decompose, drop the combining marks), lowercase, trim + collapse internal whitespace,
// then drop ONE trailing "s" (only when the result is ≥4 chars and doesn't already end "ss") so a
// re-shop's spelling/case/plural drift still lands on the same row. It deliberately does NOT
// resolve synonyms, translations, or pack-size math (two rows of one food in different languages
// or sizes) — merging those stays the agent's judgement call (see nutrition-chef's pantry-capture
// reference), the ADR 0001 line between mechanics and generative reasoning.
export function normalizePantryName(name: string): string {
  const stripped = name.normalize("NFD").replace(/\p{M}/gu, "");
  const collapsed = stripped.toLowerCase().trim().replace(/\s+/g, " ");
  return collapsed.length >= 4 && collapsed.endsWith("s") && !collapsed.endsWith("ss")
    ? collapsed.slice(0, -1)
    : collapsed;
}

// ── Shopping-list category grouping (v16 UI, cos-ops#38) ───────────────────────────────────────
// Groups shopping items by category in the fixed VALID_SHOPPING_CATEGORY (aisle) order, with an
// "uncategorized" bucket LAST for items whose category is unset — the shopping-view.tsx analogue
// of pantry-view.tsx's local groupByCategory (pantry-view.tsx:331-352), generalised to
// ShoppingItem and pulled into this lib module (not the .tsx) so the type-stripping unit runner
// can import it directly. Returns bare category KEYS, not display strings — display labels
// (SHOPPING_CATEGORY_LABEL) are a component concern and stay in shopping-view.tsx, matching the
// pantry CATEGORY_LABEL idiom.
export interface ShoppingCategoryGroup {
  key: string; // a ShoppingCategory, or "uncategorized" for items with no category
  items: ShoppingItem[]; // sorted by name, case-insensitive
}

const SHOPPING_UNCATEGORIZED = "uncategorized"; // bucket key for items with no category (sorts last)

export function groupShoppingByCategory(items: ShoppingItem[]): ShoppingCategoryGroup[] {
  const byCat = new Map<string, ShoppingItem[]>();
  for (const it of items) {
    const key = it.category ?? SHOPPING_UNCATEGORIZED;
    const bucket = byCat.get(key);
    if (bucket) bucket.push(it);
    else byCat.set(key, [it]);
  }
  // Build groups in the canonical aisle order, then the Uncategorized bucket last.
  const ordered: ShoppingCategoryGroup[] = [];
  for (const cat of VALID_SHOPPING_CATEGORY) {
    const bucket = byCat.get(cat);
    if (bucket && bucket.length > 0) {
      ordered.push({ key: cat, items: sortShoppingByName(bucket) });
    }
  }
  const uncat = byCat.get(SHOPPING_UNCATEGORIZED);
  if (uncat && uncat.length > 0) {
    ordered.push({ key: SHOPPING_UNCATEGORIZED, items: sortShoppingByName(uncat) });
  }
  return ordered;
}

function sortShoppingByName(items: ShoppingItem[]): ShoppingItem[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
