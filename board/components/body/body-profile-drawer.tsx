"use client";

// The BODY IDENTITY editor (v14) — a slide-over to set/edit the body-profile singleton: sex, date of
// birth (age is derived, never stored), height, training status, whether you lift, and the display
// unit. These are the slow-moving identity traits that feed BMR/BMI and that Nutrition + Fitness read
// cross-add-on. Save does PUT /api/body/profile (create-or-replace) via the typed body-client.

import { useEffect, useState } from "react";
import type { BodyProfile, BiologicalSex, TrainingStatus } from "@/lib/types";
import { VALID_BIOLOGICAL_SEX, VALID_TRAINING_STATUS } from "@/lib/types";
import { setBodyProfile } from "@/lib/body-client";
import { IconWarning } from "@/components/icons";

const SEX_LABEL: Record<BiologicalSex, string> = { male: "Male", female: "Female" };
const TRAINING_LABEL: Record<TrainingStatus, string> = {
  novice: "Novice (< ~1 yr lifting)",
  intermediate: "Intermediate (~1–3 yr)",
  advanced: "Advanced (> 3 yr)",
};

export function BodyProfileDrawer({
  profile,
  onSaved,
  onClose,
}: {
  profile: BodyProfile | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [sex, setSex] = useState<"" | BiologicalSex>(profile?.sex ?? "");
  const [dob, setDob] = useState(profile?.dateOfBirth ?? "");
  const [heightCm, setHeightCm] = useState(profile?.heightCm != null ? String(profile.heightCm) : "");
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>(profile?.trainingStatus ?? "novice");
  const [resistanceTrains, setResistanceTrains] = useState(profile?.resistanceTrains ?? false);
  const [unit, setUnit] = useState<"kg" | "lb">(profile?.weightUnit ?? "kg");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isISODate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

  const onSave = async () => {
    if (!sex) return setError("Sex is required.");
    if (!isISODate(dob)) return setError("Date of birth is required.");
    const h = Number(heightCm);
    if (!Number.isFinite(h) || h <= 0) return setError("Height (cm) must be a positive number.");
    setError(null);
    setSaving(true);
    try {
      await setBodyProfile({ sex, dateOfBirth: dob, heightCm: h, trainingStatus, resistanceTrains, weightUnit: unit });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your profile.");
      setSaving(false);
    }
  };

  const isEdit = profile !== null;
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label={isEdit ? "Edit body profile" : "Set up body profile"} className="fixed top-0 right-0 h-screen w-full sm:w-[440px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col">
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">{isEdit ? "Edit your details" : "About you"}</span>
          <button onClick={onClose} aria-label="Close drawer" className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50">Close · Esc</button>
        </div>

        {error && (
          <div role="alert" className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2">
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700 px-1" aria-label="Dismiss error">×</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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

          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Height (cm)">
                <input type="number" inputMode="decimal" min="1" step="any" value={heightCm} onChange={(e) => setHeightCm(e.target.value)}
                  placeholder="e.g. 178" aria-label="Height in centimetres"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400" />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Weight unit">
                <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
                  {(["kg", "lb"] as const).map((u) => (
                    <button key={u} type="button" onClick={() => setUnit(u)} aria-pressed={unit === u}
                      className={`text-[12px] px-3 py-1.5 ${unit === u ? "bg-ink-900 text-white" : "bg-white text-ink-600 hover:bg-ink-50"}`}>{u}</button>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          <Field label="Training status">
            <select value={trainingStatus} onChange={(e) => setTrainingStatus(e.target.value as TrainingStatus)} aria-label="Training status"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100">
              {VALID_TRAINING_STATUS.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
            </select>
          </Field>

          <label className="flex items-center gap-2 text-[12.5px] text-ink-700 cursor-pointer">
            <input type="checkbox" checked={resistanceTrains} onChange={(e) => setResistanceTrains(e.target.checked)} className="accent-ink-900" />
            I do resistance training (lifting)
          </label>
          <p className="text-[11px] text-ink-400">Age is derived from your date of birth (never stored stale). Height + sex feed your BMR/BMI; training status + lifting shape your nutrition + training plans.</p>
        </div>

        <div className="px-5 h-14 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} disabled={saving} className="text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-white disabled:opacity-50">Cancel</button>
            <button onClick={onSave} disabled={saving} className="text-[12px] px-3 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
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
