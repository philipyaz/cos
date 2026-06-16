"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/topbar";

// ── Constants ────────────────────────────────────────────────────────────────

const GOALS = [
  { value: "perte_de_poids", label: "Perte de poids" },
  { value: "triathlon_sprint", label: "Triathlon Sprint" },
  { value: "triathlon_olympique", label: "Triathlon Olympique" },
  { value: "cyclisme", label: "Cyclisme" },
  { value: "natation", label: "Natation" },
  { value: "course_a_pied", label: "Course a pied" },
  { value: "forme_generale", label: "Forme generale" },
];

const LEVELS = [
  { value: "debutant", label: "Debutant" },
  { value: "intermediaire", label: "Intermediaire" },
  { value: "avance", label: "Avance" },
];

const SPORT_GROUPS: { label: string; sports: { value: string; label: string }[] }[] = [
  {
    label: "Cardio",
    sports: [
      { value: "velo_exterieur", label: "Velo exterieur" },
      { value: "velo_interieur", label: "Velo interieur" },
      { value: "course_a_pied", label: "Course a pied" },
      { value: "marche", label: "Marche" },
      { value: "natation_piscine", label: "Natation piscine" },
      { value: "natation_eau_libre", label: "Natation eau libre" },
      { value: "aviron", label: "Aviron" },
      { value: "ski_alpin", label: "Ski alpin" },
      { value: "ski_de_fond", label: "Ski de fond" },
      { value: "snowboard", label: "Snowboard" },
      { value: "randonnee", label: "Randonnee" },
      { value: "escalade", label: "Escalade" },
      { value: "surf", label: "Surf" },
      { value: "kayak", label: "Kayak" },
    ],
  },
  {
    label: "Force / Flex",
    sports: [
      { value: "musculation", label: "Musculation" },
      { value: "hiit", label: "HIIT" },
      { value: "yoga", label: "Yoga" },
      { value: "pilates", label: "Pilates" },
      { value: "danse", label: "Danse" },
      { value: "arts_martiaux", label: "Arts martiaux" },
      { value: "boxe", label: "Boxe" },
      { value: "crossfit", label: "CrossFit" },
      { value: "stretching", label: "Stretching" },
    ],
  },
  {
    label: "Autres",
    sports: [
      { value: "tennis", label: "Tennis" },
      { value: "padel", label: "Padel" },
      { value: "football", label: "Football" },
      { value: "basketball", label: "Basketball" },
      { value: "cyclisme_indoor_zwift", label: "Cyclisme indoor (Zwift)" },
    ],
  },
];

const ALL_SPORT_VALUES = SPORT_GROUPS.flatMap((g) => g.sports.map((s) => s.value));

const EQUIPMENT = [
  { value: "velo_route", label: "Velo route" },
  { value: "velo_home_trainer", label: "Velo home trainer" },
  { value: "barre_traction", label: "Barre de traction" },
  { value: "halteres", label: "Halteres" },
  { value: "kettlebell", label: "Kettlebell" },
  { value: "elastiques", label: "Elastiques" },
  { value: "tapis_de_course", label: "Tapis de course" },
  { value: "rameur", label: "Rameur" },
  { value: "velo_elliptique", label: "Velo elliptique" },
  { value: "corde_a_sauter", label: "Corde a sauter" },
  { value: "poids_du_corps", label: "Poids du corps uniquement" },
  { value: "acces_piscine", label: "Acces piscine" },
  { value: "acces_salle", label: "Acces salle de sport" },
];

const EQUIPMENT_VALUES = EQUIPMENT.map((e) => e.value);

// ── Types ────────────────────────────────────────────────────────────────────

interface AthleteProfile {
  goal: string;
  goalDate: string;
  level: string;
  currentWeight: number | null;
  targetWeight: number | null;
  daysPerWeek: number | null;
  maxSessionMinutes: number | null;
  sports: string[];
  equipment: string[];
  notes: string;
  updatedAt: string;
}

const EMPTY: AthleteProfile = {
  goal: "forme_generale",
  goalDate: "",
  level: "debutant",
  currentWeight: null,
  targetWeight: null,
  daysPerWeek: null,
  maxSessionMinutes: null,
  sports: [],
  equipment: [],
  notes: "",
  updatedAt: "",
};

interface LastWeight {
  kg: number;
  date: string;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AthletePage() {
  const [form, setForm] = useState<AthleteProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastWeight, setLastWeight] = useState<LastWeight | null>(null);

  useEffect(() => {
    const loadProfile = fetch("/api/athlete")
      .then((r) => r.json())
      .then((d) => {
        if (d.profile) setForm({ ...EMPTY, ...d.profile });
      })
      .catch(() => {});

    const loadWeight = fetch("/api/health/data?type=body_mass&limit=1")
      .then((r) => r.json())
      .then((d) => {
        const entries: { ts: string; data: Record<string, unknown> }[] =
          d.entries ?? [];
        if (entries.length > 0) {
          const e = entries[0];
          const kg =
            typeof e.data.value === "number"
              ? e.data.value
              : typeof e.data.kg === "number"
                ? e.data.kg
                : null;
          if (kg != null) setLastWeight({ kg, date: e.ts });
        }
      })
      .catch(() => {});

    Promise.all([loadProfile, loadWeight]).finally(() => setLoading(false));
  }, []);

  // Pre-fill currentWeight from health data if profile has no weight yet
  useEffect(() => {
    if (lastWeight && form.currentWeight == null) {
      setForm((f) => ({ ...f, currentWeight: lastWeight.kg }));
    }
    // Only run when lastWeight arrives, not on every form change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWeight]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/athlete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        const d = await res.json();
        setForm(d.profile);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleList = (field: "sports" | "equipment", value: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].includes(value)
        ? prev[field].filter((v) => v !== value)
        : [...prev[field], value],
    }));
  };

  if (loading) {
    return (
      <>
        <TopBar crumbs={["Cos", "Athlete"]} />
        <main className="flex-1 overflow-y-auto p-5">
          <p className="text-[13px] text-ink-400">Loading...</p>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar crumbs={["Cos", "Athlete"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-ink-900">
            Profil Athlete
          </h1>
          {form.updatedAt && (
            <span className="text-[11px] text-ink-400">
              Mis a jour le{" "}
              {new Date(form.updatedAt).toLocaleDateString("fr-FR", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </div>

        <div className="rounded-lg border border-ink-100 bg-white shadow-card">
          <div className="p-5 space-y-5">
            {/* Row 1: Goal + Goal date */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Objectif principal">
                <select
                  value={form.goal}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, goal: e.target.value }))
                  }
                  className="input-field"
                >
                  {GOALS.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date objectif">
                <input
                  type="date"
                  value={form.goalDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, goalDate: e.target.value }))
                  }
                  className="input-field"
                />
              </Field>
            </div>

            {/* Row 2: Level + Days per week + Max session */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Niveau">
                <select
                  value={form.level}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, level: e.target.value }))
                  }
                  className="input-field"
                >
                  {LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Jours / semaine">
                <input
                  type="number"
                  min={1}
                  max={7}
                  value={form.daysPerWeek ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      daysPerWeek: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  placeholder="1-7"
                  className="input-field"
                />
              </Field>
              <Field label="Duree max seance (min)">
                <input
                  type="number"
                  min={10}
                  value={form.maxSessionMinutes ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      maxSessionMinutes: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  placeholder="60"
                  className="input-field"
                />
              </Field>
            </div>

            {/* Row 3: Weight current + target */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Poids actuel (kg)">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={form.currentWeight ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      currentWeight: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  placeholder="75"
                  className="input-field"
                />
                {lastWeight && (
                  <p className="mt-1 text-[11px] text-ink-400">
                    Derniere mesure : {lastWeight.kg} kg le{" "}
                    {new Date(lastWeight.date).toLocaleDateString("fr-FR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}
                  </p>
                )}
              </Field>
              <Field label="Poids cible (kg, optionnel)">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={form.targetWeight ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      targetWeight: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  placeholder="70"
                  className="input-field"
                />
              </Field>
            </div>

            {/* Sports — grouped by category */}
            <Field label="Sports disponibles">
              <div className="space-y-3 pt-1">
                {SPORT_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="text-[11px] font-semibold text-ink-500 mb-1.5">
                      {group.label}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {group.sports.map((s) => (
                        <label
                          key={s.value}
                          className="flex items-center gap-1.5 text-[13px] text-ink-700 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={form.sports.includes(s.value)}
                            onChange={() => toggleList("sports", s.value)}
                            className="rounded border-ink-300 text-violet-600 focus:ring-violet-500"
                          />
                          {s.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Field>

            {/* Equipment */}
            <Field label="Equipement disponible">
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
                {EQUIPMENT.map((eq) => (
                  <label
                    key={eq.value}
                    className="flex items-center gap-1.5 text-[13px] text-ink-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={form.equipment.includes(eq.value)}
                      onChange={() => toggleList("equipment", eq.value)}
                      className="rounded border-ink-300 text-violet-600 focus:ring-violet-500"
                    />
                    {eq.label}
                  </label>
                ))}
              </div>
            </Field>

            {/* Notes */}
            <Field label="Notes libres">
              <textarea
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
                rows={3}
                className="input-field resize-y"
                placeholder="Blessures, contraintes, preferences..."
              />
            </Field>
          </div>

          {/* Footer */}
          <div className="border-t border-ink-100 px-5 py-3 flex items-center justify-end gap-3">
            {saved && (
              <span className="text-[12px] text-emerald-600 font-medium">
                Enregistre
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition"
            >
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
          </div>
        </div>
      </main>

      <style jsx>{`
        .input-field {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid var(--ink-200, #e2e2e2);
          background: white;
          padding: 0.375rem 0.625rem;
          font-size: 13px;
          color: var(--ink-900, #1a1a1a);
          outline: none;
          transition: border-color 0.15s;
        }
        .input-field:focus {
          border-color: var(--ink-400, #a3a3a3);
          box-shadow: 0 0 0 1px var(--ink-200, #e2e2e2);
        }
        .input-field::placeholder {
          color: var(--ink-400, #a3a3a3);
        }
      `}</style>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-400 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
