// The PHYSIOLOGY BASELINE — the thin, uncontested-FACTS-only successor to the retired weight-loss
// engine (lib/nutrition-targets.ts). It answers "what is my maintenance / trend / BMI / age?" — the
// same for a vegan and a carnivore — and DELIBERATELY REFUSES "what should I eat?". The recommendation
// (calories, macros, deficit/surplus, the diet philosophy) is the AGENT's job: it reads this baseline +
// the goal + the diet profile and AUTHORS a nutrition-targets artifact (the save_training_plan law).
//
// Everything here is the "Pearson-stats carve-out": pure, deterministic, I/O-free, clock-free
// (the caller passes `today` as a "YYYY-MM-DD" string). It imports ONLY ./types + the re-homed shared
// helpers in ./nutrition-format. The one surviving SAFETY guard is lowCalorieWarn (the sex calorie
// floor) — a warn, never a computed target.

import type {
  ActivityLevel,
  BiologicalSex,
  BodyObjective,
  BodyProfile,
  FoodLogEntry,
  WeightEntry,
} from "./types";
import { ACTIVITY_FACTOR } from "./types";
import { addDays, EWMA_ALPHA, type GuardrailFlag } from "./nutrition-format";

// ── Physiological + safety constants (uncontested facts only) ───────────────────
export const KCAL_PER_KG = 7700; // kcal per kg of body weight (the "3500 kcal/lb" seed) — used by the measured-TDEE loop
export const CALORIE_FLOOR: Record<BiologicalSex, number> = { male: 1500, female: 1200 }; // the ONE surviving safety floor (a warn, not a target)
export const MEASURED_WINDOW_DAYS = 14; // look-back window for the measured-TDEE feedback loop
export const MEASURED_MIN_DAYS = 10; // …needs at least this many logged days + this much weight span

const round = (n: number): number => Math.round(n);
const r1 = (n: number): number => Math.round(n * 10) / 10;

// Whole-day difference between two "YYYY-MM-DD" strings (b − a), UTC-noon anchored (no DST drift).
function dayDiff(a: string, b: string): number {
  const pa = a.split("-").map((s) => parseInt(s, 10));
  const pb = b.split("-").map((s) => parseInt(s, 10));
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2], 12, 0, 0);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2], 12, 0, 0);
  return Math.round((tb - ta) / 86_400_000);
}

const byDateAsc = (a: WeightEntry, b: WeightEntry): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// ── Energy estimate (Mifflin-St Jeor) ──────────────────────────────────────────
// Basal metabolic rate (kcal/day) — the current clinical-standard equation. Sex constant +5/−161.
export function mifflinStJeorBMR(args: {
  sex: BiologicalSex;
  weightKg: number;
  heightCm: number;
  age: number;
}): number {
  return 10 * args.weightKg + 6.25 * args.heightCm - 5 * args.age + (args.sex === "male" ? 5 : -161);
}

// Scale BMR up to total daily energy expenditure by the activity factor (PAL).
export function tdeeFromBMR(bmr: number, activity: ActivityLevel): number {
  return bmr * ACTIVITY_FACTOR[activity];
}

// Body-mass index (kg / m²). heightCm is converted to metres.
export function bmi(weightKg: number, heightCm: number): number {
  return weightKg / (heightCm / 100) ** 2;
}

// Whole-year age from an ISO "YYYY-MM-DD" date-of-birth, as of `today` ("YYYY-MM-DD"). Clock-free
// (today is injected — the single seam where the route turns DOB into age). Returns null on bad input.
export function ageFromDOB(dob: string, today: string): number | null {
  const mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!mb || !mt) return null;
  const by = Number(mb[1]), bm = Number(mb[2]), bd = Number(mb[3]);
  const ty = Number(mt[1]), tm = Number(mt[2]), td = Number(mt[3]);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1; // birthday not yet reached this year
  return age >= 0 && age < 130 ? age : null;
}

// ── Current / trend weight + body composition (facts the agent reads) ────────────
// The latest RAW weigh-in on/before `asOfDay`, or null when there are none in range.
export function currentWeightKg(weights: WeightEntry[], asOfDay: string): number | null {
  const entry = weights.filter((w) => w.date <= asOfDay).sort(byDateAsc).at(-1);
  return entry ? entry.weightKg : null;
}

// The EWMA-smoothed "trend" weight over every weigh-in on/before `asOfDay`, seeded to the first.
export function weightTrendKg(weights: WeightEntry[], asOfDay: string): number | null {
  const inRange = weights.filter((w) => w.date <= asOfDay).sort(byDateAsc);
  if (inRange.length === 0) return null;
  let ema = inRange[0].weightKg;
  for (let i = 1; i < inRange.length; i++) ema = EWMA_ALPHA * inRange[i].weightKg + (1 - EWMA_ALPHA) * ema;
  return ema;
}

// Fat-free mass (kg) from the newest weigh-in on/before `asOfDay` that carries body composition:
// prefer a MEASURED leanMassKg, else DERIVE from bodyFatPct (weight × (1 − bf/100)) at read time
// (never persisted-derived). Returns null when no comp signal exists. The agent uses FFM to anchor
// protein for lean/high-body-fat users (per the diet philosophy).
export function fatFreeMassKg(weights: WeightEntry[], asOfDay: string): number | null {
  const inRange = weights.filter((w) => w.date <= asOfDay).sort(byDateAsc);
  for (let i = inRange.length - 1; i >= 0; i--) {
    const w = inRange[i];
    if (typeof w.leanMassKg === "number") return r1(w.leanMassKg);
    if (typeof w.bodyFatPct === "number") return r1(w.weightKg * (1 - w.bodyFatPct / 100));
  }
  return null;
}

// The newest waist circumference (cm) on/before `asOfDay` — the primary scale-independent recomp
// signal the agent narrates against. Null when none recorded.
export function latestWaistCm(weights: WeightEntry[], asOfDay: string): number | null {
  const inRange = weights.filter((w) => w.date <= asOfDay && typeof w.waistCm === "number").sort(byDateAsc);
  const last = inRange.at(-1);
  return last && typeof last.waistCm === "number" ? last.waistCm : null;
}

// ── Measured TDEE (the feedback loop) ───────────────────────────────────────────
// Best-effort ACTUAL maintenance calories over the last `windowDays`, correcting the formula against
// what really happened. Returns null when the data is too thin. (Salvaged verbatim from the engine —
// it is uncontested physics, not a dietary opinion.)
export function measuredTdee(
  foodLogs: FoodLogEntry[],
  weights: WeightEntry[],
  asOfDay: string,
  windowDays: number = MEASURED_WINDOW_DAYS,
): number | null {
  const from = addDays(asOfDay, -(windowDays - 1));
  const perDay = new Map<string, number>();
  for (const f of foodLogs) {
    if (f.date < from || f.date > asOfDay) continue;
    perDay.set(f.date, (perDay.get(f.date) ?? 0) + f.calories);
  }
  const loggedDays = perDay.size;
  if (loggedDays < MEASURED_MIN_DAYS) return null;

  const weightsInWindow = weights.filter((w) => w.date >= from && w.date <= asOfDay).sort(byDateAsc);
  if (weightsInWindow.length < 2) return null;
  const first = weightsInWindow[0];
  const last = weightsInWindow[weightsInWindow.length - 1];
  const spanDays = dayDiff(first.date, last.date);
  if (spanDays < MEASURED_MIN_DAYS) return null;

  let intakeSum = 0;
  for (const kcal of perDay.values()) intakeSum += kcal;
  const meanIntake = intakeSum / loggedDays;
  const deltaKg = last.weightKg - first.weightKg;
  return Math.round(meanIntake - (deltaKg * KCAL_PER_KG) / spanDays);
}

// ── The ONE surviving safety guard (a warn, never a target) ──────────────────────
// Flags a daily-calorie figure that falls below the sex floor. Pure: the caller passes the figure +
// the sex (read from db.bodyProfile in the route layer, which is why this never folds into the
// agent-authored artifact payload). Returns null when the figure is at/above the floor.
export function lowCalorieWarn(dailyCalories: number, sex: BiologicalSex): GuardrailFlag | null {
  const floor = CALORIE_FLOOR[sex];
  if (!Number.isFinite(dailyCalories) || dailyCalories >= floor) return null;
  return {
    id: "low-calorie",
    level: "warn",
    message: `${round(dailyCalories)} kcal/day is below the ${floor} kcal floor for ${sex === "male" ? "men" : "women"} — review this target with a clinician before following it.`,
  };
}

// ── The render-ready baseline envelope (facts only) ──────────────────────────────
export interface BodyBaseline {
  configured: boolean; // a body profile is set AND a current weight exists
  needs: string[]; // what's missing: "profile" | "objective" | "weight"
  currentWeightKg: number | null; // latest raw weigh-in on/before today
  trendWeightKg: number | null; // EWMA-smoothed trend (1 dp)
  ageYears: number | null; // derived from profile.dateOfBirth at `today`
  bmrKcal: number | null; // estimated BMR (needs profile + a current weight)
  tdeeKcal: number | null; // estimated maintenance (BMR × activity; needs objective.activity)
  measuredTdeeKcal: number | null; // measured maintenance (feedback loop), or null
  basis: "measured" | "estimated"; // "measured" when the feedback loop fired
  bmiCurrent: number | null; // BMI at the current weight (1 dp)
  ffmKg: number | null; // fat-free mass (measured or derived), or null
  latestWaistCm: number | null; // newest waist reading (recomp signal), or null
  notMedicalAdvice: true; // a compile-time reminder: facts only, never medical advice
}

// Compute the physiology baseline. ALWAYS resolvable: with no profile/objective/weight it returns a
// "needs configuration" envelope (nulls + the needs list). NO I/O, NO clock — `today` is passed in.
// activity comes from the body OBJECTIVE (its one true home); sex/DOB/height from the body PROFILE.
export function bodyBaseline(args: {
  profile: BodyProfile | null;
  objective: BodyObjective | null;
  weights: WeightEntry[];
  foodLogs: FoodLogEntry[];
  today: string;
}): BodyBaseline {
  const { profile, objective, weights, foodLogs, today } = args;

  const current = currentWeightKg(weights, today);
  const trend = weightTrendKg(weights, today);
  const ageYears = profile ? ageFromDOB(profile.dateOfBirth, today) : null;

  const needs: string[] = [];
  if (!profile) needs.push("profile");
  if (!objective) needs.push("objective");
  if (current == null) needs.push("weight");
  const configured = profile != null && current != null;

  const bmr = profile && current != null && ageYears != null
    ? mifflinStJeorBMR({ sex: profile.sex, weightKg: current, heightCm: profile.heightCm, age: ageYears })
    : null;
  const tdee = bmr != null && objective ? round(tdeeFromBMR(bmr, objective.activity)) : null;

  const measured = measuredTdee(foodLogs, weights, today);
  const basis: "measured" | "estimated" = measured != null ? "measured" : "estimated";

  const bmiCurrent = current != null && profile ? r1(bmi(current, profile.heightCm)) : null;

  return {
    configured,
    needs,
    currentWeightKg: current,
    trendWeightKg: trend != null ? r1(trend) : null,
    ageYears,
    bmrKcal: bmr != null ? round(bmr) : null,
    tdeeKcal: tdee,
    measuredTdeeKcal: measured,
    basis,
    bmiCurrent,
    ffmKg: fatFreeMassKg(weights, today),
    latestWaistCm: latestWaistCm(weights, today),
    notMedicalAdvice: true,
  };
}
