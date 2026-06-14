// The weight-loss TARGETS ENGINE — a pure, I/O-free projection (like selectors.ts) that
// turns the user's goal/profile + their weigh-in series + their food log into ONE
// render-ready "how am I doing" envelope. Every function is deterministic given its
// inputs; there is NO new Date() anywhere — the caller passes `today` (a "YYYY-MM-DD"
// string) so the whole module is unit-testable. It imports ONLY from ./types.
//
// THE PHYSIOLOGY (why the numbers are what they are):
//  • BMR (basal metabolic rate) — energy at complete rest — via the Mifflin-St Jeor
//    equation, the current clinical standard. TDEE (total daily energy expenditure) is
//    BMR scaled by an activity factor (PAL). This is the ESTIMATED maintenance calories.
//  • A 1 kg change in body weight corresponds to ~7700 kcal (KCAL_PER_KG) — the classic
//    "3500 kcal/lb" seed. A daily deficit of (rateKgPerWeek*7700/7) kcal therefore drives
//    that weekly loss. This is a FIRST-ORDER seed, not gospel; real metabolism adapts.
//  • THE MEASURED-TDEE FEEDBACK LOOP corrects that seed against reality: given enough
//    logged days and a long-enough weight span, a person's ACTUAL maintenance is
//    meanIntake − (weightChangeKcal / days). If they ate 2000/day and lost 0.5 kg over
//    14 days, their true TDEE is higher than 2000 by that loss's kcal/day. We prefer this
//    "measured" basis over the formula whenever the data supports it.
//  • PROTEIN-FIRST MACROS: protein is set per-kg of (a bias toward the lower of current /
//    near-target weight) to preserve lean mass in a deficit; fat gets a floor (essential
//    fatty acids + satiety, ≥20% of calories); carbs are whatever calories remain.
//  • SAFETY GUARDRAILS clamp the aggressiveness: the loss rate is capped (≤1%/wk of body
//    weight and ≤1.0 kg/wk), the deficit is capped (≤25% of maintenance), and the calorie
//    target has a hard floor by sex. Plus an ALWAYS-ON "not medical advice" note. None of
//    this is medical advice — it is an informational estimate.

import type {
  ActivityLevel,
  BiologicalSex,
  FoodLogEntry,
  NutritionGoal,
  WeightEntry,
} from "./types";
import { ACTIVITY_FACTOR } from "./types";

// ── Physiological + safety constants ───────────────────────────────────────────
export const KCAL_PER_KG = 7700; // kcal per kg of body weight (the "3500 kcal/lb" seed)
export const CALORIE_FLOOR: Record<BiologicalSex, number> = { male: 1500, female: 1200 }; // hard daily-calorie floor by sex
export const MAX_DEFICIT_FRACTION = 0.25; // a deficit never exceeds 25% of maintenance
export const RATE_CAP_FRACTION = 0.01; // weekly loss capped at 1% of body weight
export const ABS_RATE_CAP_KG = 1.0; // …and an absolute 1.0 kg/wk ceiling
export const MIN_HEALTHY_BMI = 18.5; // a target BMI below this trips a guardrail warning
export const PROTEIN_G_PER_KG = 1.8; // protein grams per kg (lean-mass preservation in a deficit)
export const PROTEIN_BUFFER_KG = 5; // bias protein toward (targetWeight + buffer) so it isn't set too low
export const FAT_G_PER_KG = 0.8; // fat grams per kg of current weight
export const FAT_MIN_KCAL_FRACTION = 0.2; // …with a floor of 20% of calories from fat
export const DEFAULT_RATE_KG_WK = 0.5; // default desired loss rate when the goal omits one
export const EWMA_ALPHA = 0.25; // smoothing factor for the weight trend (EWMA)
export const MEASURED_WINDOW_DAYS = 14; // the look-back window for the measured-TDEE feedback loop
export const MEASURED_MIN_DAYS = 10; // …needs at least this many logged days + this much weight span

// ── Tiny local helpers (kept local so the module imports ONLY ./types) ──────────
// Round to an integer; round to 1 decimal. We keep FULL precision internally and only
// round at the output boundary, so intermediate math (EWMA, TDEE) isn't lossy.
const round = (n: number): number => Math.round(n);
const r1 = (n: number): number => Math.round(n * 10) / 10;

// Plain calendar arithmetic on a "YYYY-MM-DD" string (UTC-noon anchored so a day shift is
// never a DST/timezone off-by-one). Returns a "YYYY-MM-DD" string `n` days after `day`.
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Whole-day difference between two "YYYY-MM-DD" strings (b − a), via the same UTC-noon
// anchor. Used for the measured-TDEE weight span (days between first + last weigh-in).
function dayDiff(a: string, b: string): number {
  const pa = a.split("-").map((s) => parseInt(s, 10));
  const pb = b.split("-").map((s) => parseInt(s, 10));
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2], 12, 0, 0);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2], 12, 0, 0);
  return Math.round((tb - ta) / 86_400_000);
}

// ── Energy estimate (Mifflin-St Jeor) ──────────────────────────────────────────
// Basal metabolic rate (kcal/day) — the current clinical-standard equation. The sex
// constant is +5 (male) / −161 (female). Inputs are kg / cm / years.
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

// ── Weight trend (EWMA) ─────────────────────────────────────────────────────────
// The smoothed "current trend" weight — an exponentially-weighted moving average over
// every weigh-in on or before `asOfDay`, sorted ascending by date, seeded to the first
// weight. EWMA damps daily water-weight noise so the trend reflects real change. Returns
// null when there are no entries in range. Full precision kept internally; the caller
// rounds to 1 decimal for output.
export function weightTrendKg(weights: WeightEntry[], asOfDay: string): number | null {
  const inRange = weights
    .filter((w) => w.date <= asOfDay)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (inRange.length === 0) return null;
  let ema = inRange[0].weightKg; // seed to the first weight
  for (let i = 1; i < inRange.length; i++) {
    ema = EWMA_ALPHA * inRange[i].weightKg + (1 - EWMA_ALPHA) * ema;
  }
  return ema;
}

// ── Measured TDEE (the feedback loop) ───────────────────────────────────────────
// Best-effort ACTUAL maintenance calories from the last `windowDays`, correcting the
// formula estimate against what really happened. Returns null when the data is too thin.
// Window is [asOf − (windowDays − 1), asOf]. We need:
//   • at least MEASURED_MIN_DAYS distinct LOGGED food days in the window, and
//   • at least 2 weigh-ins in the window spanning ≥ MEASURED_MIN_DAYS days.
// Then: meanIntake = (total kcal over logged days) / loggedDays; the weight change over
// the span converts to kcal (deltaKg*KCAL_PER_KG) and is spread over the span; measured
// TDEE = meanIntake minus that per-day weight-change energy. (Lost weight ⇒ deltaKg<0 ⇒
// the subtraction ADDS energy ⇒ true maintenance is higher than intake, as expected.)
export function measuredTdee(
  foodLogs: FoodLogEntry[],
  weights: WeightEntry[],
  asOfDay: string,
  windowDays: number = MEASURED_WINDOW_DAYS,
): number | null {
  const from = addDays(asOfDay, -(windowDays - 1));
  // Group the in-window food logs by day → per-day kcal totals. The number of DISTINCT
  // days that have any log is `loggedDays` (the denominator for mean intake).
  const perDay = new Map<string, number>();
  for (const f of foodLogs) {
    if (f.date < from || f.date > asOfDay) continue;
    perDay.set(f.date, (perDay.get(f.date) ?? 0) + f.calories);
  }
  const loggedDays = perDay.size;
  if (loggedDays < MEASURED_MIN_DAYS) return null;

  const weightsInWindow = weights
    .filter((w) => w.date >= from && w.date <= asOfDay)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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

// ── Macros (protein-first) ──────────────────────────────────────────────────────
// Split the calorie target into protein / fat / carbs. Protein is set per-kg, biased
// toward the LOWER of (current weight) and (target + a small buffer) so it isn't pinned to
// a high starting weight nor set too low at a lean target. Fat is per-kg of current weight
// with a 20%-of-calories floor (essential fats + satiety). Carbs are the remainder. Energy
// densities: protein 4, carb 4, fat 9 kcal/g.
export function macroTargets(args: {
  calorieTarget: number;
  currentWeightKg: number;
  targetWeightKg: number;
}): { proteinG: number; fatG: number; carbsG: number } {
  const proteinG = round(PROTEIN_G_PER_KG * Math.min(args.currentWeightKg, args.targetWeightKg + PROTEIN_BUFFER_KG));
  const fatG = Math.max(round(FAT_G_PER_KG * args.currentWeightKg), round((FAT_MIN_KCAL_FRACTION * args.calorieTarget) / 9));
  const carbsG = Math.max(0, round((args.calorieTarget - proteinG * 4 - fatG * 9) / 4));
  return { proteinG, fatG, carbsG };
}

// ── Public envelope types ───────────────────────────────────────────────────────
export type TargetBasis = "measured" | "estimated"; // which TDEE the deficit is computed from

// Per-day adherence status, judged against the daily calorie target.
export type AdherenceStatus = "under" | "on_track" | "over" | "well_over";

export interface DayAdherence {
  date: string; // the calendar day
  calories: number; // total kcal logged that day
  target: number; // the daily calorie target (0 when none is computed)
  deltaKcal: number; // calories − target (negative = under)
  status: AdherenceStatus;
}

export type GuardrailLevel = "info" | "warn";
export interface GuardrailFlag {
  id: string; // stable key (e.g. "rate-capped")
  level: GuardrailLevel; // "info" (the always-on note) | "warn" (a safety clamp tripped)
  message: string; // human-readable explanation
}

// The render-ready targets envelope — ALWAYS resolvable (the engine never throws). When
// the goal or a current weight is missing, the numeric fields are null and `needs` lists
// what to configure, but the informational flags (chiefly the not-medical-advice note)
// still resolve. `rateKgPerWeek` in this envelope is the EFFECTIVE (clamped) rate.
export interface NutritionTargets {
  configured: boolean; // goal set AND a current weight exists
  needs: string[]; // what's missing ("goal" | "weight") when not configured
  currentWeightKg: number | null; // latest weigh-in on/before today (raw, not smoothed)
  trendWeightKg: number | null; // the EWMA-smoothed trend (1 dp)
  targetWeightKg: number | null; // the goal weight
  remainingKg: number | null; // trend − target (1 dp; ≤0 means at/under goal)
  bmrKcal: number | null; // estimated BMR
  tdeeKcal: number | null; // estimated maintenance (BMR × activity)
  measuredTdeeKcal: number | null; // measured maintenance (feedback loop), or null
  basis: TargetBasis; // "measured" when the feedback loop fired, else "estimated"
  dailyCalorieTarget: number | null; // the recommended daily intake
  deficitKcal: number | null; // baseTdee − dailyCalorieTarget (the effective deficit)
  rateKgPerWeek: number | null; // the EFFECTIVE (clamped) weekly loss rate
  macros: { proteinG: number; fatG: number; carbsG: number } | null;
  bmiCurrent: number | null; // BMI at the current weight (1 dp)
  bmiTarget: number | null; // BMI at the target weight (1 dp)
  etaWeeks: number | null; // weeks to target at the effective rate (0 when already at/under)
  etaDate: string | null; // today + etaWeeks (today when already at/under, null when unknown)
  flags: GuardrailFlag[]; // the guardrail flags (always includes the not-medical-advice note)
  adherence: DayAdherence[]; // per logged day, NEWEST FIRST
  todayCalories: number; // total kcal logged for `today`
  todayRemaining: number | null; // dailyCalorieTarget − todayCalories (null when no target)
  notMedicalAdvice: true; // a compile-time reminder this is informational, never medical advice
}

// ── The main projection ─────────────────────────────────────────────────────────
// Compute the full targets envelope. ALWAYS resolvable: with no goal/weight it returns a
// "needs configuration" envelope (nulls + the info flag); with both it runs the full
// estimate (formula or measured), the clamped deficit, the macros, the ETA, and the
// per-day adherence. No I/O, no clock — `today` is passed in.
export function computeNutritionTargets(args: {
  goal: NutritionGoal | null;
  weights: WeightEntry[];
  foodLogs: FoodLogEntry[];
  today: string;
}): NutritionTargets {
  const { goal, weights, foodLogs, today } = args;

  // The "current" weight is the latest RAW weigh-in on/before today; the trend is its
  // EWMA smoothing. We use current for the point-in-time BMR/BMI and trend for ETA.
  const currentEntry = weights
    .filter((w) => w.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .at(-1);
  const current = currentEntry ? currentEntry.weightKg : null;
  const trend = weightTrendKg(weights, today);

  const configured = goal != null && current != null;
  const needs: string[] = [];
  if (!goal) needs.push("goal");
  if (current == null) needs.push("weight");

  // Energy estimate (formula). Both require a goal (profile) AND a current weight.
  const bmr = goal && current != null ? mifflinStJeorBMR({ sex: goal.sex, weightKg: current, heightCm: goal.heightCm, age: goal.age }) : null;
  const tdee = bmr != null ? round(tdeeFromBMR(bmr, goal!.activity)) : null;

  // The feedback loop: prefer the MEASURED maintenance over the formula when the data
  // supports it. `baseTdee` is what the deficit is computed from.
  const measured = goal ? measuredTdee(foodLogs, weights, today) : null;
  const basis: TargetBasis = measured != null ? "measured" : "estimated";
  const baseTdee = measured ?? tdee;

  // The requested loss rate, CLAMPED by the safety guardrails: ≤1%/wk of body weight and
  // ≤1.0 kg/wk absolute. `effRate` is the rate every downstream calc uses; we flag when it
  // had to be reduced below what the user asked for.
  const requestedRate = goal?.rateKgPerWeek ?? DEFAULT_RATE_KG_WK;
  const rateCap = Math.min(ABS_RATE_CAP_KG, current != null ? current * RATE_CAP_FRACTION : ABS_RATE_CAP_KG);
  const effRate = Math.min(requestedRate, rateCap);

  // Derive the daily calorie target from baseTdee and the effective rate. The deficit is
  // the SMALLER of (the rate's implied deficit) and (25% of maintenance), then the target
  // is floored by sex. We track whether either safety clamp actually bit (for the flags).
  let dailyCalorieTarget: number | null = null;
  let deficitKcal: number | null = null;
  let deficitClamped = false; // the 25% cap or the floor reduced the deficit
  if (baseTdee != null && goal) {
    const deficitFromRate = (effRate * KCAL_PER_KG) / 7;
    const cap = baseTdee * MAX_DEFICIT_FRACTION;
    const deficit = Math.min(deficitFromRate, cap);
    if (deficit < deficitFromRate) deficitClamped = true; // the 25% cap bit
    const rawTarget = baseTdee - deficit;
    const floor = CALORIE_FLOOR[goal.sex];
    dailyCalorieTarget = round(Math.max(rawTarget, floor));
    if (rawTarget < floor) deficitClamped = true; // the floor bit
    deficitKcal = round(baseTdee - dailyCalorieTarget);
  }

  const macros = dailyCalorieTarget != null && current != null && goal
    ? macroTargets({ calorieTarget: dailyCalorieTarget, currentWeightKg: current, targetWeightKg: goal.targetWeightKg })
    : null;

  const bmiCurrent = current != null && goal ? r1(bmi(current, goal.heightCm)) : null;
  const bmiTarget = goal ? r1(bmi(goal.targetWeightKg, goal.heightCm)) : null;

  // Progress + ETA, computed off the SMOOTHED trend (not the noisy raw weight). remaining
  // ≤ 0 means at/under goal → 0 weeks / today. With weight still to lose and a positive
  // effective rate, ETA is remaining / rate (weeks) and a calendar date that far out.
  const remainingKg = trend != null && goal ? r1(trend - goal.targetWeightKg) : null;
  const etaWeeks =
    remainingKg != null && remainingKg > 0 && effRate > 0
      ? r1(remainingKg / effRate)
      : remainingKg != null && remainingKg <= 0
        ? 0
        : null;
  const etaDate = etaWeeks != null && etaWeeks > 0 ? addDays(today, round(etaWeeks * 7)) : etaWeeks === 0 ? today : null;

  // Per-day adherence: one row per DISTINCT logged day, newest first. Each day's status is
  // judged against the daily target (when there is one): well under (≤60%) is "under",
  // ≤target is "on_track", a modest overshoot (≤115%) is "over", beyond that "well_over".
  // With no target we report a neutral "on_track" so the day still surfaces its total.
  const perDay = new Map<string, number>();
  for (const f of foodLogs) perDay.set(f.date, (perDay.get(f.date) ?? 0) + f.calories);
  const adherence: DayAdherence[] = Array.from(perDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // newest first
    .map(([date, calories]) => {
      const target = dailyCalorieTarget ?? 0;
      let status: AdherenceStatus;
      if (dailyCalorieTarget == null) {
        status = "on_track"; // neutral default when there is no target to judge against
      } else if (calories <= dailyCalorieTarget * 0.6) {
        status = "under";
      } else if (calories <= dailyCalorieTarget) {
        status = "on_track";
      } else if (calories <= dailyCalorieTarget * 1.15) {
        status = "over";
      } else {
        status = "well_over";
      }
      return { date, calories, target, deltaKcal: calories - target, status };
    });

  const todayCalories = foodLogs.filter((f) => f.date === today).reduce((sum, f) => sum + f.calories, 0);
  const todayRemaining = dailyCalorieTarget != null ? round(dailyCalorieTarget - todayCalories) : null;

  // Guardrail flags. The not-medical-advice note ALWAYS leads (it is informational and
  // independent of any data). The warns fire only when a safety clamp actually mattered.
  const flags: GuardrailFlag[] = [
    {
      id: "not-medical-advice",
      level: "info",
      message:
        "Informational, not medical advice — consult a clinician or registered dietitian for medical conditions, pregnancy/breastfeeding, an eating-disorder history, or if under 18.",
    },
  ];
  if (bmiTarget != null && bmiTarget < MIN_HEALTHY_BMI) {
    flags.push({
      id: "target-below-bmi",
      level: "warn",
      message: `Your target weight is a BMI of ${bmiTarget}, below the healthy minimum of ${MIN_HEALTHY_BMI}. Consider a higher target.`,
    });
  }
  if (effRate < requestedRate) {
    flags.push({
      id: "rate-capped",
      level: "warn",
      message: `Your requested loss rate was capped to ${r1(effRate)} kg/week for safety (no more than 1% of body weight or 1.0 kg per week).`,
    });
  }
  if (deficitClamped) {
    flags.push({
      id: "deficit-capped",
      level: "warn",
      message: "Your calorie deficit was capped for safety (no more than 25% below maintenance, and never below the daily floor).",
    });
  }

  return {
    configured,
    needs,
    currentWeightKg: current,
    trendWeightKg: trend != null ? r1(trend) : null,
    targetWeightKg: goal ? goal.targetWeightKg : null,
    remainingKg,
    bmrKcal: bmr != null ? round(bmr) : null,
    tdeeKcal: tdee,
    measuredTdeeKcal: measured,
    basis,
    dailyCalorieTarget,
    deficitKcal,
    rateKgPerWeek: goal ? r1(effRate) : null,
    macros,
    bmiCurrent,
    bmiTarget,
    etaWeeks,
    etaDate,
    flags,
    adherence,
    todayCalories,
    todayRemaining,
    notMedicalAdvice: true,
  };
}
