"use client";

// The Fitness overview hub's interactive client island — the athlete-profile editor plus
// the form-score widget + the quick-jump row to the add-on's coaching surfaces. The page
// (a server component) gates the surface on the "fitness" add-on flag and renders the
// shell (TopBar); this view owns ALL the client logic.
//
// LIVE: the profile lives in the CORE store (db.athleteProfile), so a profile write —
// our own Save, OR the agent's via the fitness MCP — bumps db.version → SSE →
// useLiveBoard refetches GET /api/fitness/profile (which carries db.version) and adopts
// the freshest profile. We seed lastVersion to 0 (so the SSE `hello` on connect always
// reconciles on mount, like the addons surface) and advance the ref after our OWN write so
// our save doesn't echo back as a foreign change and clobber the field we just edited.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FormScoreWidget } from "@/components/form-score-widget";
import { useLiveBoard } from "@/lib/use-live-board";
import { getProfile, setProfile } from "@/lib/fitness-client";
import { formatDay } from "@/lib/fitness-format";
import { IconRunner, IconWarning } from "@/components/icons";
import {
  VALID_ATHLETE_GOAL,
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

// The canonical board text-input class — matches every other input on the board (sky focus
// ring, ink palette). Replaces the deleted styled-jsx `.input-field` (whose var(--ink-*)
// fallbacks were broken). Applied to every select / input / textarea below.
const INPUT_CLASS =
  "w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400";

// ── Types ────────────────────────────────────────────────────────────────────
// Mirrors AthleteProfile from @/lib/types (the route's GET returns {profile} with these
// fields). Weights are kilograms (currentWeightKg / targetWeightKg).

interface AthleteProfile {
  goal: string;
  goalDate: string;
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
  daysPerWeek: null,
  maxSessionMinutes: null,
  sports: [],
  equipment: [],
  notes: "",
  updatedAt: "",
};

// ── View ─────────────────────────────────────────────────────────────────────

export function FitnessOverviewView() {
  const [form, setForm] = useState<AthleteProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The board version we last reconciled to — a ref so the SSE callback always compares
  // against the freshest value (mirrors the other live views). Seeded to 0 so the SSE
  // `hello` on connect always passes useLiveBoard's `v > lastVersion` guard and adopts the
  // authoritative profile on mount. We advance it after our OWN save (below) so that write
  // doesn't echo back as a foreign change.
  const lastVersion = useRef<number>(0);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Re-GET the profile (the GET carries db.version) and adopt it into the form, advancing
  // lastVersion. A profile write by the agent (via the fitness MCP) bumps db.version → SSE
  // → this refetch lands the new profile here without a reload. Best-effort: a failed
  // refetch leaves the last-known form in place.
  const refetch = async (): Promise<void> => {
    try {
      const d = await getProfile();
      if (typeof d.version === "number") lastVersion.current = d.version;
      if (d.profile) setForm({ ...EMPTY, ...d.profile });
    } catch {
      // Non-critical: keep the last-known form; the next change event retries.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // Initial seed from the client (no SSR props): the profile via refetch (which also seeds
  // lastVersion). Current weight + the body goal live in the BODY add-on now (/body), not here.
  useEffect(() => {
    refetch().finally(() => setLoading(false));
    // Mount-once seed (refetch closes over mount-time state, like useLiveBoard).
  }, []);

  // Save the profile through the typed fitness-client (it throws on a non-2xx with the
  // API's error text). On success adopt the canonical profile + advance lastVersion to the
  // returned write version so the SSE echo of OUR write is suppressed; on a throw surface
  // the error in the rose banner (a failed save is visible, not a silent flip back to "Save").
  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const d = await setProfile({ ...form });
      if (typeof d.version === "number") lastVersion.current = d.version;
      if (d.profile) setForm({ ...EMPTY, ...d.profile });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The profile could not be saved.");
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
      <div className="flex-1 overflow-y-auto p-5">
        <div className="flex items-center gap-2 text-ink-400">
          <IconRunner className="w-4 h-4" />
          <p className="text-[13px]">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
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

      {/* A failed save (the POST threw) — surfaced inline so it isn't a silent flip back to
          "Save". Dismissible; success states (the "Saved" chip) are handled in the footer. */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md"
        >
          <IconWarning className="w-4 h-4 mt-px shrink-0 text-rose-500" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-rose-500 hover:text-rose-700"
          >
            ×
          </button>
        </div>
      )}

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
            <Field label="Training focus">
              <select
                value={form.goal}
                onChange={(e) =>
                  setForm((f) => ({ ...f, goal: e.target.value }))
                }
                className={INPUT_CLASS}
              >
                {GOALS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-ink-400">
                Your sport/event focus. Your body goal (fat loss, muscle, recomp) lives in{" "}
                <a href="/body" className="underline hover:text-ink-600">Body</a>.
              </p>
            </Field>
            <Field label="Goal date">
              <input
                type="date"
                value={form.goalDate}
                onChange={(e) =>
                  setForm((f) => ({ ...f, goalDate: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          {/* Row 2: training availability (days/week + max session). Experience LEVEL moved to the
              body add-on's trainingStatus (v14). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                className={INPUT_CLASS}
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
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          {/* Weight, body composition, and the body goal moved to the Body add-on (v14). */}
          <p className="text-[12px] text-ink-500 rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2">
            Your weight, body composition, and body goal now live in{" "}
            <a href="/body" className="underline hover:text-ink-700">Body</a> — this profile is your training focus + availability.
          </p>

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
              className={`${INPUT_CLASS} resize-y`}
              placeholder="Injuries, constraints, preferences…"
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
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
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
