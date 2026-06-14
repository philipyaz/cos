"use client";

// The weight-loss GOAL editor — a slide-over used to set up (no `goal`) or edit the
// nutrition goal/profile SINGLETON. It mirrors the SHELL of the PantryItemDrawer (fixed
// overlay + right aside + header Close · Esc + error banner + Save footer; Esc and an
// overlay click both close) but with GOAL fields: a NutritionGoal carries the body
// profile (sex / age / heightCm) the BMR→TDEE math needs, the activity level, the
// target weight, the desired loss rate, and a display unit preference.
//
// It also offers a "today's weight" field so the very first setup can record a current
// weigh-in in the SAME save — without one, the targets engine stays in its cold-start
// "needs: weight" state. Save does setGoal(...) (PUT, upsert the singleton) and, IF a
// today's weight was entered, ALSO upsertWeight({date: today, weightKg}); both write
// through the typed nutrition-client (the same gated path the agent's MCP uses) and then
// onSaved() refetches the parent's goal/weights/targets.
//
// UNIT HANDLING: weights are stored canonically in KILOGRAMS. The user may enter + display
// in kg or lb (the weightUnit toggle); we convert lb→kg HERE (at the boundary) before
// sending — both the target-weight field and the today's-weight field. heightCm is always
// centimetres (height has no unit toggle in this first cut).

import { useEffect, useMemo, useState } from "react";
import type { NutritionGoal, BiologicalSex, ActivityLevel } from "@/lib/types";
import { VALID_BIOLOGICAL_SEX, VALID_ACTIVITY_LEVEL } from "@/lib/types";
import { setGoal, upsertWeight } from "@/lib/nutrition-client";
import { IconWarning } from "@/components/icons";

// Pounds → kilograms (the canonical store unit). Mirrors the route boundary's factor.
const LB_PER_KG = 0.45359237;

// Enum → human label for the selects (kept local so the drawer stays self-contained).
const SEX_LABEL: Record<BiologicalSex, string> = { male: "Male", female: "Female" };
const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "Sedentary (little/no exercise)",
  light: "Light (1–3 days/week)",
  moderate: "Moderate (3–5 days/week)",
  very_active: "Very active (6–7 days/week)",
  extra_active: "Extra active (hard daily/physical job)",
};

// The default desired loss rate (kg/week) when the goal omits one — mirrors the engine's
// DEFAULT_RATE_KG_WK so a fresh form pre-fills the same value the engine would assume.
const DEFAULT_RATE_KG_WK = 0.5;

export function GoalDrawer({
  goal,
  today,
  onSaved,
  onClose,
}: {
  // The current goal singleton, or null when setting one up for the first time.
  goal: NutritionGoal | null;
  today: string; // "YYYY-MM-DD" — the day a today's-weight entry is stamped with
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = goal !== null;

  // The display/entry unit. Stored weights are always kg; this only governs what the user
  // types + the labels. Default to the goal's saved preference, else kg.
  const [unit, setUnit] = useState<"kg" | "lb">(goal?.weightUnit ?? "kg");

  // ── Form state ────────────────────────────────────────────────────────────────
  // Numeric fields are held as STRINGS so inputs can be cleared to "" while typing; they
  // are parsed/validated at save. The target-weight field is seeded IN THE CHOSEN UNIT
  // (converting the stored kg → lb when the preference is lb), so editing reads naturally.
  const [sex, setSex] = useState<"" | BiologicalSex>(goal?.sex ?? "");
  const [age, setAge] = useState(goal?.age != null ? String(goal.age) : "");
  const [heightCm, setHeightCm] = useState(goal?.heightCm != null ? String(goal.heightCm) : "");
  const [activity, setActivity] = useState<"" | ActivityLevel>(goal?.activity ?? "");
  const [targetWeight, setTargetWeight] = useState(
    goal?.targetWeightKg != null ? formatWeight(goal.targetWeightKg, goal.weightUnit ?? "kg") : "",
  );
  const [rate, setRate] = useState(
    goal?.rateKgPerWeek != null ? String(goal.rateKgPerWeek) : String(DEFAULT_RATE_KG_WK),
  );
  // Today's weight — only used to record an opening/current weigh-in alongside the goal.
  // Optional; empty means "don't touch the weight series".
  const [todayWeight, setTodayWeight] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Esc closes the drawer (matching the PantryItemDrawer). Bound once per mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The unit suffix shown on the weight fields' labels (kg / lb).
  const unitLabel = unit;

  // Switching the unit re-expresses the two weight FIELDS in the new unit so the user isn't
  // surprised by a number that suddenly means something else. Parses the current value in
  // the OLD unit and re-formats it in the NEW one (blank stays blank). Memoized handler.
  const onUnitChange = useMemo(
    () => (next: "kg" | "lb") => {
      const reExpress = (raw: string): string => {
        const v = raw.trim();
        if (v === "" || !Number.isFinite(Number(v))) return raw;
        const kg = unit === "lb" ? Number(v) * LB_PER_KG : Number(v);
        return formatWeight(kg, next);
      };
      setTargetWeight((prev) => reExpress(prev));
      setTodayWeight((prev) => reExpress(prev));
      setUnit(next);
    },
    [unit],
  );

  // Parse a weight field (in the chosen unit) → canonical kg, or null when blank/invalid.
  const toKg = (raw: string): number | null => {
    const v = raw.trim();
    if (v === "") return null;
    const num = Number(v);
    if (!Number.isFinite(num) || num <= 0) return null;
    return unit === "lb" ? num * LB_PER_KG : num;
  };

  // ── Save ──────────────────────────────────────────────────────────────────────
  const onSave = async () => {
    // Validate the required goal fields up front (the route re-validates, but a clear
    // client message beats a 400). Mirrors the route's required set.
    if (!sex) return setError("Biological sex is required.");
    const ageN = Number(age.trim());
    if (!age.trim() || !Number.isFinite(ageN) || ageN <= 0) return setError("Age must be a positive number.");
    const heightN = Number(heightCm.trim());
    if (!heightCm.trim() || !Number.isFinite(heightN) || heightN <= 0)
      return setError("Height (cm) must be a positive number.");
    if (!activity) return setError("Activity level is required.");
    const targetKg = toKg(targetWeight);
    if (targetKg == null) return setError(`Target weight must be a positive number (${unitLabel}).`);
    // Rate is optional in the contract (defaults 0.5); validate only when typed.
    const rateTrim = rate.trim();
    let rateN: number | undefined;
    if (rateTrim !== "") {
      const r = Number(rateTrim);
      if (!Number.isFinite(r) || r <= 0) return setError("Loss rate must be a positive number (kg/week).");
      rateN = r;
    }
    // Today's weight is optional; when present it must be a positive number.
    const todayKg = toKg(todayWeight);
    if (todayWeight.trim() !== "" && todayKg == null)
      return setError(`Today's weight must be a positive number (${unitLabel}).`);

    setError(null);
    setSaving(true);
    try {
      await setGoal({
        sex,
        age: ageN,
        heightCm: heightN,
        activity,
        targetWeightKg: targetKg,
        ...(rateN !== undefined ? { rateKgPerWeek: rateN } : {}),
        weightUnit: unit,
      });
      // If a today's weight was entered, record it as a weigh-in for `today` (upsert by day).
      // Sent in canonical kg — the lb→kg conversion already happened in toKg().
      if (todayKg != null) {
        await upsertWeight({ date: today, weightKg: todayKg });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the goal.");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={isEdit ? "Edit weight-loss goal" : "Set up weight-loss goal"}
        className="fixed top-0 right-0 h-screen w-full sm:w-[460px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">
            {isEdit ? "Edit goal" : "Set up goal"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50"
          >
            Close · Esc
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2"
          >
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-rose-500 hover:text-rose-700 px-1"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Unit toggle — governs the weight FIELDS only; storage stays kg regardless. */}
          <Field label="Weight unit">
            <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
              {(["kg", "lb"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => onUnitChange(u)}
                  aria-pressed={unit === u}
                  className={`text-[12px] px-3 py-1 ${
                    unit === u ? "bg-ink-900 text-white" : "bg-white text-ink-600 hover:bg-ink-50"
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </Field>

          {/* Sex + age — both required BMR inputs, side by side. */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Sex">
                <select
                  value={sex}
                  onChange={(e) => setSex(e.target.value as "" | BiologicalSex)}
                  aria-label="Biological sex"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="">Select…</option>
                  {VALID_BIOLOGICAL_SEX.map((s) => (
                    <option key={s} value={s}>
                      {SEX_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Age (years)">
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="e.g. 34"
                  aria-label="Age in years"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
          </div>

          {/* Height — always centimetres (no unit toggle in this first cut). */}
          <Field label="Height (cm)">
            <input
              type="number"
              inputMode="decimal"
              min="1"
              step="any"
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
              placeholder="e.g. 178"
              aria-label="Height in centimetres"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Activity — the TDEE multiplier. */}
          <Field label="Activity level">
            <select
              value={activity}
              onChange={(e) => setActivity(e.target.value as "" | ActivityLevel)}
              aria-label="Activity level"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              <option value="">Select…</option>
              {VALID_ACTIVITY_LEVEL.map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABEL[a]}
                </option>
              ))}
            </select>
          </Field>

          {/* Target weight (in the chosen unit) + desired loss rate, side by side. */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label={`Target weight (${unitLabel})`}>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={targetWeight}
                  onChange={(e) => setTargetWeight(e.target.value)}
                  placeholder={unit === "lb" ? "e.g. 165" : "e.g. 75"}
                  aria-label={`Target weight in ${unitLabel}`}
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Loss rate (kg/wk)">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="0.5"
                  aria-label="Desired loss rate in kilograms per week"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
          </div>
          <p className="text-[11px] text-ink-400 -mt-2">
            The loss rate is a target — it&rsquo;s capped for safety (≤1%/week of body weight, ≤1.0 kg/week).
          </p>

          {/* Today's weight — optional opening/current weigh-in recorded alongside the goal. */}
          <Field label={`Today's weight (${unitLabel}) — optional`}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={todayWeight}
              onChange={(e) => setTodayWeight(e.target.value)}
              placeholder={isEdit ? "Log today's weigh-in" : "Record your current weight"}
              aria-label={`Today's weight in ${unitLabel}`}
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>
          <p className="text-[11px] text-ink-400 -mt-2">
            Stored as a weigh-in for today; storage is always in kilograms regardless of the unit above.
          </p>
        </div>

        {/* Footer — Save (PUT goal + optional weigh-in). */}
        <div className="px-5 h-14 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="text-[12px] px-3 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50"
            >
              {saving ? "Saving…" : isEdit ? "Save goal" : "Set goal"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// A labelled form row (mirrors the PantryItemDrawer's Field).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}

// Format a canonical-kg weight into the chosen DISPLAY unit, to one decimal, as a bare
// string suitable for an input value (kg passes through; lb multiplies by 1/0.45359237).
function formatWeight(kg: number, unit: "kg" | "lb"): string {
  const v = unit === "lb" ? kg / LB_PER_KG : kg;
  return String(Math.round(v * 10) / 10);
}
