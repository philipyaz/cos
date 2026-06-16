"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/topbar";
import { FormScoreWidget } from "@/components/form-score-widget";
import {
  VALID_ATHLETE_GOAL,
  VALID_ATHLETE_LEVEL,
  VALID_ATHLETE_SPORT,
  VALID_ATHLETE_EQUIPMENT,
} from "@/lib/types";

// ── Constants ────────────────────────────────────────────────────────────────
// Option VALUES are the English enum values (single-sourced from @/lib/types — the
// SAME arrays the /api/fitness/profile route validates against). Human labels are derived
// here for display; the stored vocabulary stays the canonical English enum value.

// Links to the AI coaching surfaces + the metrics dashboard under /fitness/*. Rendered as
// a quick-jump row at the top of the overview hub.
const FITNESS_LINKS: { href: string; label: string; sub: string }[] = [
  { href: "/fitness/health", label: "Health Data", sub: "Apple Watch metrics" },
  { href: "/fitness/training-plan", label: "Training Plan", sub: "This week's sessions" },
  { href: "/fitness/weekly-review", label: "Weekly Review", sub: "Full analysis" },
  { href: "/fitness/pre-workout-brief", label: "Pre-Workout Brief", sub: "Readiness now" },
  { href: "/fitness/correlations", label: "Correlations", sub: "Sleep vs. performance" },
];

const GOAL_LABELS: Record<string, string> = {
  weight_loss: "Weight loss",
  sprint_triathlon: "Sprint triathlon",
  olympic_triathlon: "Olympic triathlon",
  cycling: "Cycling",
  swimming: "Swimming",
  running: "Running",
  general_fitness: "General fitness",
};
const GOALS = VALID_ATHLETE_GOAL.map((value) => ({ value, label: GOAL_LABELS[value] ?? value }));

const LEVEL_LABELS: Record<string, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};
const LEVELS = VALID_ATHLETE_LEVEL.map((value) => ({ value, label: LEVEL_LABELS[value] ?? value }));

// Human labels for every sport value in VALID_ATHLETE_SPORT.
const SPORT_LABELS: Record<string, string> = {
  cycling_outdoor: "Cycling (outdoor)",
  cycling_indoor: "Cycling (indoor)",
  running: "Running",
  walking: "Walking",
  swimming_pool: "Swimming (pool)",
  swimming_open_water: "Swimming (open water)",
  rowing: "Rowing",
  skiing_alpine: "Alpine skiing",
  skiing_cross_country: "Cross-country skiing",
  snowboard: "Snowboard",
  hiking: "Hiking",
  climbing: "Climbing",
  surfing: "Surfing",
  kayaking: "Kayaking",
  strength_training: "Strength training",
  hiit: "HIIT",
  yoga: "Yoga",
  pilates: "Pilates",
  dance: "Dance",
  martial_arts: "Martial arts",
  boxing: "Boxing",
  crossfit: "CrossFit",
  stretching: "Stretching",
  tennis: "Tennis",
  padel: "Padel",
  soccer: "Soccer",
  basketball: "Basketball",
  cycling_indoor_zwift: "Cycling indoor (Zwift)",
};

// Which group each sport falls into (advisory grouping for the form). A sport not listed
// here lands in "Other" so a future VALID_ATHLETE_SPORT addition still renders.
const SPORT_GROUP_OF: Record<string, "Cardio" | "Strength / flexibility" | "Other"> = {
  cycling_outdoor: "Cardio", cycling_indoor: "Cardio", running: "Cardio", walking: "Cardio",
  swimming_pool: "Cardio", swimming_open_water: "Cardio", rowing: "Cardio",
  skiing_alpine: "Cardio", skiing_cross_country: "Cardio", snowboard: "Cardio",
  hiking: "Cardio", climbing: "Cardio", surfing: "Cardio", kayaking: "Cardio",
  strength_training: "Strength / flexibility", hiit: "Strength / flexibility",
  yoga: "Strength / flexibility", pilates: "Strength / flexibility", dance: "Strength / flexibility",
  martial_arts: "Strength / flexibility", boxing: "Strength / flexibility",
  crossfit: "Strength / flexibility", stretching: "Strength / flexibility",
  tennis: "Other", padel: "Other", soccer: "Other", basketball: "Other",
  cycling_indoor_zwift: "Other",
};

const SPORT_GROUP_ORDER: ("Cardio" | "Strength / flexibility" | "Other")[] = [
  "Cardio", "Strength / flexibility", "Other",
];

const SPORT_GROUPS: { label: string; sports: { value: string; label: string }[] }[] =
  SPORT_GROUP_ORDER.map((label) => ({
    label,
    sports: VALID_ATHLETE_SPORT.filter((v) => (SPORT_GROUP_OF[v] ?? "Other") === label).map(
      (value) => ({ value, label: SPORT_LABELS[value] ?? value }),
    ),
  }));

const EQUIPMENT_LABELS: Record<string, string> = {
  road_bike: "Road bike",
  home_trainer: "Home trainer",
  pull_up_bar: "Pull-up bar",
  dumbbells: "Dumbbells",
  kettlebell: "Kettlebell",
  resistance_bands: "Resistance bands",
  treadmill: "Treadmill",
  rowing_machine: "Rowing machine",
  elliptical: "Elliptical",
  jump_rope: "Jump rope",
  bodyweight: "Bodyweight only",
  pool_access: "Pool access",
  gym_access: "Gym access",
};
const EQUIPMENT = VALID_ATHLETE_EQUIPMENT.map((value) => ({
  value,
  label: EQUIPMENT_LABELS[value] ?? value,
}));

// ── Types ────────────────────────────────────────────────────────────────────
// Mirrors AthleteProfile from @/lib/types (the route's GET returns {profile} with these
// fields). Weights are kilograms (currentWeightKg / targetWeightKg).

interface AthleteProfile {
  goal: string;
  goalDate: string;
  level: string;
  currentWeightKg: number | null;
  targetWeightKg: number | null;
  daysPerWeek: number | null;
  maxSessionMinutes: number | null;
  sports: string[];
  equipment: string[];
  notes: string;
  updatedAt: string;
}

const EMPTY: AthleteProfile = {
  goal: "general_fitness",
  goalDate: "",
  level: "beginner",
  currentWeightKg: null,
  targetWeightKg: null,
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
    const loadProfile = fetch("/api/fitness/profile")
      .then((r) => r.json())
      .then((d) => {
        if (d.profile) setForm({ ...EMPTY, ...d.profile });
      })
      .catch(() => {});

    // Source the current weight from the nutrition weigh-ins (the latest entry) — the old
    // page queried a "body_mass" health type that is never produced. The weight route
    // returns {weights} sorted ASCENDING by date, so the latest is the LAST element. When
    // the nutrition add-on is off / has no weigh-ins, this leaves the field blank.
    const loadWeight = fetch("/api/nutrition/weight")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const weights: { date: string; weightKg: number }[] = d?.weights ?? [];
        if (weights.length > 0) {
          const latest = weights[weights.length - 1];
          if (typeof latest.weightKg === "number") {
            setLastWeight({ kg: latest.weightKg, date: latest.date });
          }
        }
      })
      .catch(() => {});

    Promise.all([loadProfile, loadWeight]).finally(() => setLoading(false));
  }, []);

  // Pre-fill currentWeightKg from the latest weigh-in if the profile has no weight yet.
  useEffect(() => {
    if (lastWeight && form.currentWeightKg == null) {
      setForm((f) => ({ ...f, currentWeightKg: lastWeight.kg }));
    }
    // Only run when lastWeight arrives, not on every form change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWeight]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/fitness/profile", {
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
        <TopBar crumbs={["Cos", "Fitness"]} />
        <main className="flex-1 overflow-y-auto p-5">
          <p className="text-[13px] text-ink-400">Loading...</p>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar crumbs={["Cos", "Fitness"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-ink-900">
            Athlete Profile
          </h1>
          {form.updatedAt && (
            <span className="text-[11px] text-ink-400">
              Updated{" "}
              {new Date(form.updatedAt).toLocaleDateString("en-US", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </div>

        <FormScoreWidget />

        {/* Quick-jump to the metrics dashboard + the AI coaching surfaces. */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {FITNESS_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card hover:border-ink-200 hover:bg-ink-50/50 transition"
            >
              <p className="text-[13px] font-semibold text-ink-900">{l.label}</p>
              <p className="mt-0.5 text-[11px] text-ink-400">{l.sub}</p>
            </Link>
          ))}
        </div>

        <div className="rounded-lg border border-ink-100 bg-white shadow-card">
          <div className="p-5 space-y-5">
            {/* Row 1: Goal + Goal date */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Primary goal">
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
              <Field label="Goal date">
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
              <Field label="Level">
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
              <Field label="Days / week">
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
              <Field label="Max session (min)">
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
              <Field label="Current weight (kg)">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={form.currentWeightKg ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      currentWeightKg: e.target.value
                        ? Number(e.target.value)
                        : null,
                    }))
                  }
                  placeholder="75"
                  className="input-field"
                />
                {lastWeight && (
                  <p className="mt-1 text-[11px] text-ink-400">
                    Latest weigh-in: {lastWeight.kg} kg on{" "}
                    {new Date(lastWeight.date).toLocaleDateString("en-US", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}
                  </p>
                )}
              </Field>
              <Field label="Target weight (kg, optional)">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={form.targetWeightKg ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      targetWeightKg: e.target.value
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
            <Field label="Available sports">
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
            <Field label="Available equipment">
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
            <Field label="Free notes">
              <textarea
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
                rows={3}
                className="input-field resize-y"
                placeholder="Injuries, constraints, preferences..."
              />
            </Field>
          </div>

          {/* Footer */}
          <div className="border-t border-ink-100 px-5 py-3 flex items-center justify-end gap-3">
            {saved && (
              <span className="text-[12px] text-emerald-600 font-medium">
                Saved
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition"
            >
              {saving ? "Saving..." : "Save"}
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
