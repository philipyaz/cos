"use client";

// The GOAL editor (v14) — a slide-over to set up or edit the FREE-TEXT body objective (+ the body
// identity on first run). It mirrors the drawer SHELL (overlay + right aside + Close · Esc + error
// banner + Save footer). The goal is PROSE — the user describes what they're after in their own words;
// the only structured anchor is a target weight (optional). Identity (sex / DOB / height / training
// status) is collected once (the BMR/TDEE inputs), prefilled on edit.
//
// Save: setBodyObjective(...) (PUT) + setBodyProfile(...) when identity is provided + an optional
// today's weigh-in (upsertWeight, body add-on). All through the typed body-client — the same gated
// path the agent's MCP uses — then onSaved() refetches the parent.

import { useEffect, useState } from "react";
import type { BodyObjective, BiologicalSex, ActivityLevel, TrainingStatus } from "@/lib/types";
import { VALID_BIOLOGICAL_SEX, VALID_ACTIVITY_LEVEL, VALID_TRAINING_STATUS } from "@/lib/types";
import { setBodyObjective, setBodyProfile, getBodyProfile, upsertWeight } from "@/lib/body-client";
import { kgToDisplay, displayToKg } from "@/lib/nutrition-format";
import { IconWarning } from "@/components/icons";

const SEX_LABEL: Record<BiologicalSex, string> = { male: "Male", female: "Female" };
const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "Sedentary (little/no exercise)",
  light: "Light (1–3 days/week)",
  moderate: "Moderate (3–5 days/week)",
  very_active: "Very active (6–7 days/week)",
  extra_active: "Extra active (hard daily/physical job)",
};
const TRAINING_LABEL: Record<TrainingStatus, string> = {
  novice: "Novice (< ~1 yr lifting)",
  intermediate: "Intermediate (~1–3 yr)",
  advanced: "Advanced (> 3 yr)",
};

export function GoalDrawer({
  objective,
  unit,
  today,
  onSaved,
  onClose,
}: {
  objective: BodyObjective | null;
  unit: "kg" | "lb";
  today: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  // ── Objective (free text + anchor) ──
  const [goalText, setGoalText] = useState(objective?.goalText ?? "");
  const [targetWeight, setTargetWeight] = useState(
    objective?.targetWeightKg != null ? String(Math.round(kgToDisplay(objective.targetWeightKg, unit) * 10) / 10) : "",
  );
  const [targetDate, setTargetDate] = useState(objective?.targetDate ?? "");
  const [activity, setActivity] = useState<ActivityLevel>(objective?.activity ?? "moderate");

  // ── Identity (prefilled from the profile fetch; required on first run) ──
  const [hasProfile, setHasProfile] = useState<boolean | null>(null); // null = still loading
  const [sex, setSex] = useState<"" | BiologicalSex>("");
  const [dob, setDob] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>("novice");
  const [resistanceTrains, setResistanceTrains] = useState(false);

  const [todayWeight, setTodayWeight] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Prefill identity from the stored profile (or mark first-run when none).
  useEffect(() => {
    let live = true;
    getBodyProfile()
      .then(({ profile }) => {
        if (!live) return;
        if (profile) {
          setSex(profile.sex);
          setDob(profile.dateOfBirth);
          setHeightCm(String(profile.heightCm));
          setTrainingStatus(profile.trainingStatus);
          setResistanceTrains(profile.resistanceTrains);
          setHasProfile(true);
        } else {
          setHasProfile(false);
        }
      })
      .catch(() => live && setHasProfile(false));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toKg = (raw: string): number | null => {
    const v = raw.trim();
    if (v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return displayToKg(n, unit);
  };
  const isISODate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

  const onSave = async () => {
    if (!activity) return setError("Activity level is required.");
    const targetKg = targetWeight.trim() === "" ? null : toKg(targetWeight);
    if (targetWeight.trim() !== "" && targetKg == null) return setError(`Target weight must be a positive number (${unit}).`);
    if (targetDate.trim() !== "" && !isISODate(targetDate)) return setError("Target date must be a valid date.");

    // Identity is required on first run; optional (but written) once it exists.
    const identityProvided = sex !== "" && isISODate(dob) && Number(heightCm) > 0;
    if (hasProfile === false && !identityProvided) {
      return setError("First time setup: please add your sex, date of birth, and height (the BMR inputs).");
    }
    const todayKg = todayWeight.trim() === "" ? null : toKg(todayWeight);
    if (todayWeight.trim() !== "" && todayKg == null) return setError(`Today's weight must be a positive number (${unit}).`);

    setError(null);
    setSaving(true);
    try {
      if (identityProvided) {
        await setBodyProfile({
          sex,
          dateOfBirth: dob,
          heightCm: Number(heightCm),
          trainingStatus,
          resistanceTrains,
          weightUnit: unit,
        });
      }
      await setBodyObjective({
        goalText: goalText.trim(),
        targetWeightKg: targetKg,
        targetDate: targetDate.trim() === "" ? null : targetDate,
        activity,
      });
      if (todayKg != null) await upsertWeight({ date: today, weightKg: todayKg });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your goal.");
      setSaving(false);
    }
  };

  const isEdit = objective !== null;
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={isEdit ? "Edit goal" : "Set up goal"}
        className="fixed top-0 right-0 h-screen w-full sm:w-[460px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">{isEdit ? "Edit goal" : "Set up goal"}</span>
          <button onClick={onClose} aria-label="Close drawer" className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50">
            Close · Esc
          </button>
        </div>

        {error && (
          <div role="alert" className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2">
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700 px-1" aria-label="Dismiss error">×</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* The free-text goal — the headline. */}
          <Field label="Your goal (in your own words)">
            <textarea
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="e.g. Lose some fat but keep my strength — I lift 3×/week and want to lean out for summer without losing muscle."
              aria-label="Describe your goal"
              className="w-full bg-white border border-ink-200 rounded-md px-2.5 py-2 text-[12.5px] text-ink-900 leading-snug outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 resize-none"
            />
            <p className="text-[11px] text-ink-400 mt-1">Your chief of staff reads this to set your daily calorie + macro targets.</p>
          </Field>

          {/* Target weight (optional anchor) + target date. */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label={`Target weight (${unit}) — optional`}>
                <input
                  type="number" inputMode="decimal" min="0" step="any"
                  value={targetWeight} onChange={(e) => setTargetWeight(e.target.value)}
                  placeholder={unit === "lb" ? "e.g. 165" : "e.g. 75"} aria-label={`Target weight in ${unit}`}
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Target date — optional">
                <input
                  type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-label="Target date"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                />
              </Field>
            </div>
          </div>

          {/* Activity — the TDEE multiplier. */}
          <Field label="Activity level">
            <select
              value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)} aria-label="Activity level"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              {VALID_ACTIVITY_LEVEL.map((a) => (
                <option key={a} value={a}>{ACTIVITY_LABEL[a]}</option>
              ))}
            </select>
          </Field>

          {/* Identity — the BMR inputs (required on first run, prefilled on edit). */}
          <div className="pt-2 border-t border-ink-50">
            <p className="text-[11px] uppercase tracking-wide text-ink-400 mb-2">About you {hasProfile === false ? "(required)" : ""}</p>
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label="Sex">
                  <select value={sex} onChange={(e) => setSex(e.target.value as "" | BiologicalSex)} aria-label="Biological sex"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100">
                    <option value="">Select…</option>
                    {VALID_BIOLOGICAL_SEX.map((s) => <option key={s} value={s}>{SEX_LABEL[s]}</option>)}
                  </select>
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Date of birth">
                  <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} aria-label="Date of birth"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
                </Field>
              </div>
            </div>
            <div className="flex gap-3 mt-3">
              <div className="flex-1">
                <Field label="Height (cm)">
                  <input type="number" inputMode="decimal" min="1" step="any" value={heightCm} onChange={(e) => setHeightCm(e.target.value)}
                    placeholder="e.g. 178" aria-label="Height in centimetres"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400" />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Training status">
                  <select value={trainingStatus} onChange={(e) => setTrainingStatus(e.target.value as TrainingStatus)} aria-label="Training status"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100">
                    {VALID_TRAINING_STATUS.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
                  </select>
                </Field>
              </div>
            </div>
            <label className="flex items-center gap-2 mt-3 text-[12.5px] text-ink-700 cursor-pointer">
              <input type="checkbox" checked={resistanceTrains} onChange={(e) => setResistanceTrains(e.target.checked)} className="accent-ink-900" />
              I do resistance training (lifting)
            </label>
          </div>

          {/* Today's weight — optional opening weigh-in. */}
          <Field label={`Today's weight (${unit}) — optional`}>
            <input type="number" inputMode="decimal" min="0" step="any" value={todayWeight} onChange={(e) => setTodayWeight(e.target.value)}
              placeholder="Record your current weight" aria-label={`Today's weight in ${unit}`}
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400" />
          </Field>
        </div>

        <div className="px-5 h-14 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} disabled={saving} className="text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-white disabled:opacity-50">Cancel</button>
            <button onClick={onSave} disabled={saving || hasProfile === null} className="text-[12px] px-3 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save goal" : "Set goal"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}
