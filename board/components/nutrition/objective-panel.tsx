"use client";

// The OBJECTIVE PANEL (v14, was WeightLossPanel) — a collapsible card above the Food Log that shows
// the user's FREE-TEXT goal + the deterministic physiology BASELINE (facts) + the AGENT-AUTHORED daily
// targets artifact. It is purely PRESENTATIONAL over what the parent FoodLogView hands it (the parent
// owns fetching + the live SSE refetch). The board never computes a recommendation here — the calories/
// macros come from the latest saved targets artifact (authored by the agent); this panel just renders it.
//
// Three states:
//   • NO OBJECTIVE — a cold-start inviting "set your goal" (opens the free-text GoalDrawer).
//   • OBJECTIVE, NO TARGETS YET — the goal prose + the baseline strip + "ask your chief of staff for
//     today's targets" (the agent authors them via the nutrition MCP's save_nutrition_targets).
//   • TARGETS PRESENT — the daily calorie target + P/F/C + stance + a [why?] rationale, over the baseline.
//
// DETERMINISM: no new Date() in render — `today` comes from the parent's SSR clock.

import { useState } from "react";
import type { BodyObjective, WeightEntry } from "@/lib/types";
import type { BodyBaseline } from "@/lib/body-baseline";
import type { NutritionTargetArtifact } from "@/lib/types";
import { upsertWeight } from "@/lib/body-client";
import { formatDay, kgToDisplay, displayToKg } from "@/lib/nutrition-format";
import { IconScale, IconTrend, IconChevronDown, IconChevronRight, IconWarning } from "@/components/icons";
import { GoalDrawer } from "./goal-drawer";
import { WeightChart } from "./weight-chart";

// The sex calorie floors (mirrored from body-baseline's CALORIE_FLOOR — a literal here so this client
// component doesn't pull the server lib into the bundle). Used only for the low-calorie advisory.
const CALORIE_FLOOR: Record<"male" | "female", number> = { male: 1500, female: 1200 };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function fmtWeight(kg: number | null, unit: "kg" | "lb"): string {
  if (kg == null) return "—";
  return `${Math.round(kgToDisplay(kg, unit) * 10) / 10} ${unit}`;
}
const fmtKcal = (n: number | null): string => (n == null ? "—" : `${Math.round(n)} kcal`);

export function ObjectivePanel({
  objective,
  baseline,
  latestTarget,
  weights,
  today,
  unit,
  sex,
  onMutated,
}: {
  objective: BodyObjective | null;
  baseline: BodyBaseline;
  latestTarget: NutritionTargetArtifact | null;
  weights: WeightEntry[];
  today: string;
  unit: "kg" | "lb";
  sex?: "male" | "female";
  onMutated: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const payload = latestTarget?.payload ?? {};
  const dailyCalories = num(payload.daily_calories);

  return (
    <section className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-ink-50">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse body panel" : "Expand body panel"}
          aria-expanded={open}
          className="flex items-center gap-2 text-ink-700 hover:text-ink-900 min-w-0"
        >
          {open ? <IconChevronDown className="w-3.5 h-3.5 shrink-0" /> : <IconChevronRight className="w-3.5 h-3.5 shrink-0" />}
          <IconScale className="w-4 h-4 shrink-0 text-ink-400" />
          <span className="text-[13px] font-semibold text-ink-900 truncate">Body &amp; nutrition</span>
        </button>

        {objective && !open && (
          <span className="text-[11px] text-ink-400 tabular-nums truncate">
            {dailyCalories != null ? `${Math.round(dailyCalories)} kcal/day · ` : ""}
            {fmtWeight(baseline.trendWeightKg, unit)}
            {objective.targetWeightKg != null ? ` → ${fmtWeight(objective.targetWeightKg, unit)}` : ""}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <LogWeightButton today={today} unit={unit} weights={weights} onLogged={onMutated} />
          <button
            onClick={() => setDrawerOpen(true)}
            className="text-[11px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-ink-50"
          >
            {objective ? "Edit goal" : "Set up goal"}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-3.5 py-3">
          {!objective ? (
            <ColdStart onSetGoal={() => setDrawerOpen(true)} />
          ) : (
            <Configured objective={objective} baseline={baseline} latestTarget={latestTarget} weights={weights} today={today} unit={unit} />
          )}
          <Flags dailyCalories={dailyCalories} sex={sex} hasObjective={!!objective} />
        </div>
      )}

      {drawerOpen && (
        <GoalDrawer
          objective={objective}
          unit={unit}
          today={today}
          onClose={() => setDrawerOpen(false)}
          onSaved={onMutated}
        />
      )}
    </section>
  );
}

function ColdStart({ onSetGoal }: { onSetGoal: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 py-5 px-4 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconTrend className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">Set your goal</p>
      <p className="text-[12px] text-ink-500 max-w-[460px] mx-auto mb-3">
        Describe what you&rsquo;re after in your own words — &ldquo;lose some fat but keep my strength&rdquo;,
        &ldquo;lean recomposition&rdquo;, &ldquo;build muscle&rdquo; — and (optionally) a target weight. Your
        chief of staff reads it to plan your daily targets.
      </p>
      <button onClick={onSetGoal} className="text-[12px] px-3 py-1.5 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition">
        Set up goal
      </button>
    </div>
  );
}

function Configured({
  objective,
  baseline,
  latestTarget,
  weights,
  today,
  unit,
}: {
  objective: BodyObjective;
  baseline: BodyBaseline;
  latestTarget: NutritionTargetArtifact | null;
  weights: WeightEntry[];
  today: string;
  unit: "kg" | "lb";
}) {
  const payload = latestTarget?.payload ?? {};
  const dailyCalories = num(payload.daily_calories);
  const protein = num(payload.protein_g);
  const fat = num(payload.fat_g);
  const carbs = num(payload.carbs_g);
  const stance = str(payload.stance);
  const rationale = str(payload.rationale);
  const [showWhy, setShowWhy] = useState(false);
  const hasChart = weights.some((w) => w.date <= today);

  return (
    <div className="space-y-3">
      {/* The free-text goal + the target anchor. */}
      <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-ink-400 mb-0.5">Your goal</div>
        <p className="text-[12.5px] text-ink-800 leading-snug">{objective.goalText || <span className="text-ink-400">No goal text yet — edit to describe it.</span>}</p>
        <div className="text-[11px] text-ink-400 tabular-nums mt-1">
          {objective.targetWeightKg != null ? <>target {fmtWeight(objective.targetWeightKg, unit)}</> : "no scale target"}
          {objective.targetDate ? ` · by ${formatDay(objective.targetDate)}` : ""}
          {` · activity ${objective.activity}`}
        </div>
      </div>

      {/* The agent-authored daily targets — or a prompt to ask for them. */}
      {latestTarget && dailyCalories != null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <Stat label={`Daily target${stance ? ` · ${stance}` : ""}`}>
            <span className="text-[15px] font-semibold text-ink-900 tabular-nums">{fmtKcal(dailyCalories)}</span>
            <span className="block text-[11px] text-ink-400 mt-0.5">
              authored {formatDay(latestTarget.periodKey)}
              {rationale && (
                <>
                  {" · "}
                  <button onClick={() => setShowWhy((s) => !s)} className="underline decoration-dotted hover:text-ink-600">why?</button>
                </>
              )}
            </span>
          </Stat>
          <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2 flex items-center">
            <div className="flex items-center gap-2 flex-wrap">
              {protein != null && <MacroPill label="Protein" grams={protein} tint="bg-sky-50 text-sky-700 ring-sky-200" />}
              {fat != null && <MacroPill label="Fat" grams={fat} tint="bg-amber-50 text-amber-700 ring-amber-200" />}
              {carbs != null && <MacroPill label="Carbs" grams={carbs} tint="bg-emerald-50 text-emerald-700 ring-emerald-200" />}
              {protein == null && fat == null && carbs == null && <span className="text-[11px] text-ink-400">no macro split</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/30 px-3 py-2.5 text-[12px] text-ink-500">
          No daily targets yet — ask your chief of staff for today&rsquo;s targets (it reads your goal, the facts
          below, and your dietary profile, then sets them).
        </div>
      )}

      {showWhy && rationale && <p className="text-[11.5px] text-ink-500 leading-snug border-l-2 border-ink-100 pl-2.5">{rationale}</p>}

      {/* The physiology BASELINE — facts only. */}
      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[11.5px] text-ink-500 tabular-nums">
        <BasisChip basis={baseline.basis} />
        {baseline.ageYears != null && (
          <span title="Age (derived from date of birth)"><span className="text-ink-400">Age</span> {baseline.ageYears}</span>
        )}
        <span title="Current → trend weight">
          <span className="text-ink-400">Weight</span> {fmtWeight(baseline.currentWeightKg, unit)}
          {baseline.trendWeightKg != null ? ` (trend ${fmtWeight(baseline.trendWeightKg, unit)})` : ""}
        </span>
        <span title="Basal metabolic rate (at rest)"><span className="text-ink-400">BMR</span> {fmtKcal(baseline.bmrKcal)}</span>
        <span title={baseline.basis === "measured" ? "Measured maintenance (feedback loop)" : "Estimated maintenance (BMR × activity)"}>
          <span className="text-ink-400">TDEE</span>{" "}
          {baseline.basis === "measured" && baseline.measuredTdeeKcal != null ? fmtKcal(baseline.measuredTdeeKcal) : fmtKcal(baseline.tdeeKcal)}
        </span>
        {baseline.bmiCurrent != null && <span title="Body-mass index"><span className="text-ink-400">BMI</span> {baseline.bmiCurrent}</span>}
        {baseline.ffmKg != null && <span title="Fat-free mass"><span className="text-ink-400">FFM</span> {baseline.ffmKg} kg</span>}
        {baseline.latestWaistCm != null && <span title="Latest waist circumference"><span className="text-ink-400">Waist</span> {baseline.latestWaistCm} cm</span>}
      </div>

      {hasChart && (
        <div className="rounded-lg border border-ink-50 bg-ink-50/30 p-2.5">
          <WeightChart weights={weights} adherence={[]} today={today} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-400 mb-0.5">{label}</div>
      {children}
    </div>
  );
}

function MacroPill({ label, grams, tint }: { label: string; grams: number; tint: string }) {
  return <span className={`text-[11px] tabular-nums px-2 py-0.5 rounded-full font-medium ring-1 ${tint}`}>{label} {Math.round(grams)}g</span>;
}

function BasisChip({ basis }: { basis: BodyBaseline["basis"] }) {
  const measured = basis === "measured";
  return (
    <span
      className={`text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ring-1 ${measured ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-ink-100 text-ink-600 ring-ink-200"}`}
      title={measured ? "Maintenance measured from your logs + weigh-ins (more accurate)" : "Maintenance estimated from the BMR formula"}
    >
      {measured ? "measured" : "estimated"}
    </span>
  );
}

// The always-on not-medical-advice line, plus a client-side low-calorie advisory when the latest
// target dips below the sex floor (sex unknown → only the info note shows).
function Flags({ dailyCalories, sex, hasObjective }: { dailyCalories: number | null; sex?: "male" | "female"; hasObjective: boolean }) {
  const warns: string[] = [];
  if (dailyCalories != null && sex && dailyCalories < CALORIE_FLOOR[sex]) {
    warns.push(`${Math.round(dailyCalories)} kcal/day is below the ${CALORIE_FLOOR[sex]} kcal floor for ${sex === "male" ? "men" : "women"} — review this with a clinician.`);
  }
  return (
    <ul className="mt-3 pt-2.5 border-t border-ink-50 space-y-1.5">
      {warns.map((w) => (
        <li key={w} className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-700">
          <IconWarning className="w-3 h-3 shrink-0 mt-px" />
          <span>{w}</span>
        </li>
      ))}
      <li className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-400">
        <span className="w-3 h-3 shrink-0" aria-hidden />
        <span>
          {hasObjective
            ? "Targets are set by your chief of staff from your goal + dietary profile. Informational, not medical advice."
            : "Informational, not medical advice — consult a clinician for medical conditions, pregnancy/breastfeeding, an eating-disorder history, or if under 18."}
        </span>
      </li>
    </ul>
  );
}

// ── "Log weight" affordance — upserts today's weigh-in via the BODY add-on ──────────
function LogWeightButton({ today, unit, weights, onLogged }: { today: string; unit: "kg" | "lb"; weights: WeightEntry[]; onLogged: () => void }) {
  const [open, setOpen] = useState(false);
  const latest = weights.filter((w) => w.date <= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).at(-1);
  const seed = latest ? String(Math.round(kgToDisplay(latest.weightKg, unit) * 10) / 10) : "";
  const [value, setValue] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const n = Number(value.trim());
    if (!value.trim() || !Number.isFinite(n) || n <= 0) {
      setError("Enter a positive weight.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await upsertWeight({ date: today, weightKg: displayToKg(n, unit) });
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
        className={`w-20 bg-white border rounded-md px-1.5 py-1 text-[12px] text-ink-900 tabular-nums outline-none focus:ring-2 focus:ring-sky-100 ${error ? "border-rose-300" : "border-ink-200 focus:border-sky-300"}`}
      />
      <span className="text-[11px] text-ink-400">{unit}</span>
      <button onClick={() => void submit()} disabled={saving} className="text-[11px] px-2 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 disabled:opacity-50">
        {saving ? "…" : "Save"}
      </button>
      <button onClick={() => setOpen(false)} disabled={saving} aria-label="Cancel logging weight" className="text-[11px] px-1.5 py-1 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-50">
        ×
      </button>
      {error && <span className="text-[10.5px] text-rose-600 ml-1">{error}</span>}
    </span>
  );
}
