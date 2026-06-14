"use client";

// The WEIGHT-LOSS PANEL — a collapsible card rendered ABOVE the Food Log that turns the
// targets engine's render-ready envelope (NutritionTargets) into an at-a-glance "how am I
// doing" surface. It is purely PRESENTATIONAL over the `targets` it's handed (the parent
// FoodLogView owns fetching + the live SSE refetch); its only writes are through the typed
// nutrition-client: opening the GoalDrawer (set up / edit the goal) and a "Log weight"
// affordance that upserts today's weigh-in.
//
// It renders TWO macro states:
//   • COLD START (!targets.configured) — an invitation that reads `needs[]` ("goal" /
//     "weight") to say exactly what's missing, with the same two CTAs.
//   • CONFIGURED — the full readout: current (trend) weight vs target + remaining; the
//     daily calorie target with its P/F/C macro split + today's remaining; the deficit +
//     a basis chip (measured vs estimated TDEE) + BMR/TDEE; the ETA (weeks + date); the
//     guardrail flags (the not-medical-advice info line ALWAYS shown, warns in amber); and
//     the embedded weight-vs-intake chart.
//
// DETERMINISM: every kcal/kg figure is formatted from the envelope's already-rounded
// numbers (the engine did the rounding); there is NO new Date() in render — `today` comes
// from the parent's SSR clock. The card's collapsed/expanded state is local UI only.

import { useState } from "react";
import type { NutritionGoal, WeightEntry } from "@/lib/types";
import type { NutritionTargets, GuardrailFlag } from "@/lib/nutrition-targets";
import { upsertWeight } from "@/lib/nutrition-client";
import { IconScale, IconTrend, IconChevronDown, IconChevronRight, IconWarning } from "@/components/icons";
import { GoalDrawer } from "./goal-drawer";
import { WeightChart } from "./weight-chart";

// A canonical-kg weight → a display string in the goal's chosen unit (default kg), 1 dp.
// Kept here (not the engine) because it's a DISPLAY concern; storage is always kg.
const LB_PER_KG = 0.45359237;
function fmtWeight(kg: number | null, unit: "kg" | "lb"): string {
  if (kg == null) return "—";
  const v = unit === "lb" ? kg / LB_PER_KG : kg;
  return `${Math.round(v * 10) / 10} ${unit}`;
}
// A signed kg delta (the remaining-to-go), in the chosen unit. Positive = still to lose.
function fmtDeltaWeight(kg: number | null, unit: "kg" | "lb"): string {
  if (kg == null) return "—";
  const v = unit === "lb" ? kg / LB_PER_KG : kg;
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : ""}${r} ${unit}`;
}
// A bare integer kcal, or an em-dash when null.
const fmtKcal = (n: number | null): string => (n == null ? "—" : `${n} kcal`);

export function WeightLossPanel({
  goal,
  weights,
  targets,
  today,
  onMutated,
}: {
  goal: NutritionGoal | null;
  weights: WeightEntry[]; // for the chart (the trend overlay) + the quick "log weight" date
  targets: NutritionTargets;
  today: string; // "YYYY-MM-DD" from the parent's request-time clock (no clock here)
  onMutated: () => void; // called after a goal/weight write so the parent refetches
}) {
  // Collapsed/expanded — start expanded when there's something to act on (cold start) OR
  // when configured (the readout is the point); only ever collapsed by the user.
  const [open, setOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The display unit preference rides on the goal (storage stays kg). Cold start → kg.
  const unit: "kg" | "lb" = goal?.weightUnit ?? "kg";

  return (
    <section className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
      {/* Header — collapse toggle + title + the basis/ETA quick-glance + the two CTAs. */}
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-ink-50">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse weight-loss panel" : "Expand weight-loss panel"}
          aria-expanded={open}
          className="flex items-center gap-2 text-ink-700 hover:text-ink-900 min-w-0"
        >
          {open ? <IconChevronDown className="w-3.5 h-3.5 shrink-0" /> : <IconChevronRight className="w-3.5 h-3.5 shrink-0" />}
          <IconScale className="w-4 h-4 shrink-0 text-ink-400" />
          <span className="text-[13px] font-semibold text-ink-900 truncate">Weight loss</span>
        </button>

        {/* When configured + collapsed, a tiny summary so the header still informs. */}
        {targets.configured && !open && (
          <span className="text-[11px] text-ink-400 tabular-nums truncate">
            {fmtKcal(targets.dailyCalorieTarget)}/day · {fmtWeight(targets.trendWeightKg, unit)} → {fmtWeight(targets.targetWeightKg, unit)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <LogWeightButton today={today} unit={unit} weights={weights} onLogged={onMutated} />
          <button
            onClick={() => setDrawerOpen(true)}
            className="text-[11px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-ink-50"
          >
            {goal ? "Edit goal" : "Set up goal"}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-3.5 py-3">
          {!targets.configured ? (
            <ColdStart needs={targets.needs} onSetGoal={() => setDrawerOpen(true)} />
          ) : (
            <Configured targets={targets} weights={weights} today={today} unit={unit} />
          )}

          {/* Guardrail flags — ALWAYS rendered (the not-medical-advice info line is in here,
              even at cold start), warns in amber. */}
          <Flags flags={targets.flags} />
        </div>
      )}

      {drawerOpen && (
        <GoalDrawer
          goal={goal}
          today={today}
          onClose={() => setDrawerOpen(false)}
          onSaved={onMutated}
        />
      )}
    </section>
  );
}

// ── Cold start ───────────────────────────────────────────────────────────────────
// Shown when the targets aren't configured yet; `needs` says what's missing.
function ColdStart({ needs, onSetGoal }: { needs: string[]; onSetGoal: () => void }) {
  const needsGoal = needs.includes("goal");
  const needsWeight = needs.includes("weight");
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 py-5 px-4 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconTrend className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">Set a weight-loss goal</p>
      <p className="text-[12px] text-ink-500 max-w-[460px] mx-auto mb-3">
        {needsGoal && needsWeight
          ? "Add your goal (height, age, activity, target weight) and record today's weight — then your daily calorie target, macros, and ETA appear here."
          : needsGoal
            ? "Add your goal (height, age, activity, target weight) to compute your daily calorie target, macros, and ETA."
            : "Record today's weight to compute your daily calorie target, macros, and ETA."}
      </p>
      <button
        onClick={onSetGoal}
        className="text-[12px] px-3 py-1.5 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
      >
        Set up goal
      </button>
    </div>
  );
}

// ── Configured readout ─────────────────────────────────────────────────────────
function Configured({
  targets,
  weights,
  today,
  unit,
}: {
  targets: NutritionTargets;
  weights: WeightEntry[];
  today: string;
  unit: "kg" | "lb";
}) {
  const t = targets;
  // Whether the chart has anything to draw — at least one logged day OR ≥1 weigh-in. The
  // chart itself also guards, but skip the whole block (and its heading) when truly empty.
  const hasChart = t.adherence.length > 0 || weights.some((w) => w.date <= today);

  return (
    <div className="space-y-3">
      {/* Row 1 — the three headline stats: weight progress, daily target, ETA. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {/* Weight progress: current (trend) → target, with remaining. */}
        <Stat label="Weight (trend)">
          <span className="text-[15px] font-semibold text-ink-900 tabular-nums">
            {fmtWeight(t.trendWeightKg, unit)}
          </span>
          <span className="block text-[11px] text-ink-400 tabular-nums mt-0.5">
            target {fmtWeight(t.targetWeightKg, unit)}
            {t.remainingKg != null && (
              <span className={t.remainingKg > 0 ? "text-ink-500" : "text-emerald-600"}>
                {" · "}
                {t.remainingKg > 0 ? `${fmtDeltaWeight(t.remainingKg, unit)} to go` : "at/under goal"}
              </span>
            )}
          </span>
        </Stat>

        {/* Daily calorie target + today's remaining. */}
        <Stat label="Daily target">
          <span className="text-[15px] font-semibold text-ink-900 tabular-nums">{fmtKcal(t.dailyCalorieTarget)}</span>
          <span className="block text-[11px] text-ink-400 tabular-nums mt-0.5">
            {t.todayRemaining != null ? (
              <span className={t.todayRemaining < 0 ? "text-rose-600" : "text-ink-500"}>
                {t.todayRemaining >= 0 ? `${t.todayRemaining} kcal left today` : `${Math.abs(t.todayRemaining)} kcal over today`}
              </span>
            ) : (
              "—"
            )}
          </span>
        </Stat>

        {/* ETA: weeks + the projected date. */}
        <Stat label="ETA to goal">
          <span className="text-[15px] font-semibold text-ink-900 tabular-nums">
            {t.etaWeeks == null ? "—" : t.etaWeeks === 0 ? "Reached" : `${t.etaWeeks} wk`}
          </span>
          <span className="block text-[11px] text-ink-400 tabular-nums mt-0.5">
            {t.etaDate ? (t.etaWeeks === 0 ? "at/under goal" : `by ${formatDay(t.etaDate)}`) : "—"}
          </span>
        </Stat>
      </div>

      {/* Row 2 — the macro split (P/F/C) for the daily target. */}
      {t.macros && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-ink-400">Macros</span>
          <MacroPill label="Protein" grams={t.macros.proteinG} tint="bg-sky-50 text-sky-700 ring-sky-200" />
          <MacroPill label="Fat" grams={t.macros.fatG} tint="bg-amber-50 text-amber-700 ring-amber-200" />
          <MacroPill label="Carbs" grams={t.macros.carbsG} tint="bg-emerald-50 text-emerald-700 ring-emerald-200" />
        </div>
      )}

      {/* Row 3 — the energy basis: deficit, the measured/estimated chip, BMR/TDEE, BMI. */}
      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[11.5px] text-ink-500 tabular-nums">
        <BasisChip basis={t.basis} />
        {t.deficitKcal != null && (
          <span title="Daily energy deficit below maintenance">
            <span className="text-ink-400">Deficit</span> {t.deficitKcal} kcal
          </span>
        )}
        <span title="Basal metabolic rate (at rest)">
          <span className="text-ink-400">BMR</span> {fmtKcal(t.bmrKcal)}
        </span>
        <span title={t.basis === "measured" ? "Measured maintenance (feedback loop)" : "Estimated maintenance (BMR × activity)"}>
          <span className="text-ink-400">TDEE</span>{" "}
          {t.basis === "measured" && t.measuredTdeeKcal != null ? fmtKcal(t.measuredTdeeKcal) : fmtKcal(t.tdeeKcal)}
        </span>
        {t.rateKgPerWeek != null && (
          <span title="Effective (safety-capped) weekly loss rate">
            <span className="text-ink-400">Rate</span> {t.rateKgPerWeek} kg/wk
          </span>
        )}
        {t.bmiCurrent != null && (
          <span title="Body-mass index: current → target">
            <span className="text-ink-400">BMI</span> {t.bmiCurrent}
            {t.bmiTarget != null && ` → ${t.bmiTarget}`}
          </span>
        )}
      </div>

      {/* Row 4 — the embedded weight-vs-intake chart (degrades gracefully). */}
      {hasChart && (
        <div className="rounded-lg border border-ink-50 bg-ink-50/30 p-2.5">
          <WeightChart weights={weights} adherence={t.adherence} today={today} />
        </div>
      )}
    </div>
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────────

// A labelled headline stat block (the three top cards).
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-400 mb-0.5">{label}</div>
      {children}
    </div>
  );
}

// A macro pill — label + grams, tinted per macro (literal Tailwind strings).
function MacroPill({ label, grams, tint }: { label: string; grams: number; tint: string }) {
  return (
    <span className={`text-[11px] tabular-nums px-2 py-0.5 rounded-full font-medium ring-1 ${tint}`}>
      {label} {grams}g
    </span>
  );
}

// The measured/estimated basis chip — emerald when the feedback loop fired (a real
// measurement), slate when it's the formula estimate.
function BasisChip({ basis }: { basis: NutritionTargets["basis"] }) {
  const measured = basis === "measured";
  return (
    <span
      className={`text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ring-1 ${
        measured ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-ink-100 text-ink-600 ring-ink-200"
      }`}
      title={measured ? "Maintenance measured from your logs + weigh-ins (more accurate)" : "Maintenance estimated from the BMR formula"}
    >
      {measured ? "measured" : "estimated"}
    </span>
  );
}

// The guardrail flags — the info line(s) muted, the warns amber. ALWAYS rendered (the
// not-medical-advice info note lives here, even at cold start).
function Flags({ flags }: { flags: GuardrailFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-3 pt-2.5 border-t border-ink-50 space-y-1.5">
      {flags.map((f) => (
        <li
          key={f.id}
          className={`flex items-start gap-1.5 text-[11px] leading-snug ${
            f.level === "warn" ? "text-amber-700" : "text-ink-400"
          }`}
        >
          {f.level === "warn" ? (
            <IconWarning className="w-3 h-3 shrink-0 mt-px" />
          ) : (
            <span className="w-3 h-3 shrink-0" aria-hidden />
          )}
          <span>{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ── "Log weight" affordance ──────────────────────────────────────────────────────
// A compact inline prompt → upsert today's weigh-in. Opens a tiny popover with one number
// field; on submit it converts (lb→kg if needed) and upserts for `today`, then refetches.
// Pre-fills with the most recent weigh-in (in the display unit) as a starting point.
function LogWeightButton({
  today,
  unit,
  weights,
  onLogged,
}: {
  today: string;
  unit: "kg" | "lb";
  weights: WeightEntry[];
  onLogged: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Seed with the latest weigh-in on/before today (the natural "around here" starting value).
  const latest = weights
    .filter((w) => w.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .at(-1);
  const seed = latest ? String(Math.round((unit === "lb" ? latest.weightKg / LB_PER_KG : latest.weightKg) * 10) / 10) : "";
  const [value, setValue] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const num = Number(value.trim());
    if (!value.trim() || !Number.isFinite(num) || num <= 0) {
      setError("Enter a positive weight.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const weightKg = unit === "lb" ? num * LB_PER_KG : num; // convert at the boundary
      await upsertWeight({ date: today, weightKg });
      setOpen(false);
      onLogged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log the weight.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => {
          setValue(seed);
          setError(null);
          setOpen(true);
        }}
        className="text-[11px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-ink-50 inline-flex items-center gap-1"
      >
        <IconScale className="w-3 h-3" />
        Log weight
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        inputMode="decimal"
        step="any"
        min="0"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={unit}
        aria-label={`Today's weight in ${unit}`}
        className={`w-20 bg-white border rounded-md px-1.5 py-1 text-[12px] text-ink-900 tabular-nums outline-none focus:ring-2 focus:ring-sky-100 ${
          error ? "border-rose-300" : "border-ink-200 focus:border-sky-300"
        }`}
      />
      <span className="text-[11px] text-ink-400">{unit}</span>
      <button
        onClick={() => void submit()}
        disabled={saving}
        className="text-[11px] px-2 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 disabled:opacity-50"
      >
        {saving ? "…" : "Save"}
      </button>
      <button
        onClick={() => setOpen(false)}
        disabled={saving}
        aria-label="Cancel logging weight"
        className="text-[11px] px-1.5 py-1 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-50"
      >
        ×
      </button>
      {error && <span className="text-[10.5px] text-rose-600 ml-1">{error}</span>}
    </span>
  );
}

// ── Local date format (deterministic; mirrors food-log-view's formatDay) ──────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}
