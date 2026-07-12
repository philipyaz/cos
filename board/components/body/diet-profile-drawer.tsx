"use client";

// The DIETARY PROFILE editor (v14) — a slide-over to edit the nutrition add-on's ONE dietary record:
// allergies (the SAFETY list the chef agent must honor), diet type / regime (vegan / halal / keto …),
// free-text notes (intolerances, foods avoided, preferences), and the "our views on diet" philosophy
// (the methodology the agent follows when setting targets; a study-grounded default ships). Save does
// PUT /api/nutrition/diet-profile (full replace) via the typed nutrition-client.

import { useEffect, useState } from "react";
import type { DietProfile } from "@/lib/types";
import { setDietProfile } from "@/lib/nutrition-client";
import { IconWarning } from "@/components/icons";

const parseList = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);

export function DietProfileDrawer({
  profile,
  onSaved,
  onClose,
}: {
  profile: DietProfile;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [allergies, setAllergies] = useState((profile.allergies ?? []).join(", "));
  const [dietType, setDietType] = useState((profile.dietType ?? []).join(", "));
  const [notes, setNotes] = useState(profile.notes ?? "");
  const [philosophy, setPhilosophy] = useState(profile.philosophy ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await setDietProfile({
        allergies: parseList(allergies),
        dietType: parseList(dietType),
        notes: notes.trim(),
        philosophy: philosophy.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your dietary profile.");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label="Edit dietary profile" className="fixed top-0 right-0 h-screen w-full sm:w-[480px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col">
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">Dietary profile</span>
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
          {/* Allergies — the safety field, emphasized. */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-rose-500 mb-1 font-medium">Allergies (safety)</div>
            <input
              value={allergies}
              onChange={(e) => setAllergies(e.target.value)}
              placeholder="e.g. peanuts, shellfish, sesame"
              aria-label="Allergies, comma separated"
              className="w-full bg-white border border-rose-200 rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100 placeholder:text-ink-400"
            />
            <p className="text-[11px] text-ink-400 mt-1">Comma-separated. Your chief of staff never plans a meal containing these — but always double-check ingredients yourself; this is best-effort, not a guarantee.</p>
          </div>

          {/* Diet type / regime. */}
          <Field label="Diet type / regime">
            <input
              value={dietType}
              onChange={(e) => setDietType(e.target.value)}
              placeholder="e.g. vegan  ·  halal, no-pork  ·  keto"
              aria-label="Diet type, comma separated"
              className="w-full bg-white border border-ink-200 rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Notes — intolerances / avoided foods / preferences. */}
          <Field label="Notes (intolerances, foods avoided, preferences)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. gluten leaves me bloated; not a fan of cilantro; prefer fish over red meat; intermittent fasting until noon."
              aria-label="Dietary notes"
              className="w-full bg-white border border-ink-200 rounded-md px-2.5 py-2 text-[12.5px] text-ink-900 leading-snug outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 resize-none"
            />
          </Field>

          {/* Philosophy — the methodology context (long; collapsible). */}
          <details className="group">
            <summary className="text-[11px] uppercase tracking-wide text-ink-400 mb-1 cursor-pointer select-none">Our views on diet (methodology) — advanced</summary>
            <textarea
              value={philosophy}
              onChange={(e) => setPhilosophy(e.target.value)}
              rows={10}
              maxLength={24000}
              aria-label="Diet philosophy"
              className="w-full mt-1 bg-white border border-ink-200 rounded-md px-2.5 py-2 text-[12px] text-ink-700 leading-snug font-mono outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 resize-y"
            />
            <p className="text-[11px] text-ink-400 mt-1">The study-grounded methodology your chief of staff follows to set targets. Overwrite it for a specific approach (keto, vegan, your coach&rsquo;s plan); clear it entirely to restore the shipped default.</p>
          </details>
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
