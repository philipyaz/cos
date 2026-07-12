"use client";

// The /body hub — the Body add-on's surface. It reuses the ObjectivePanel (the free-text goal + the
// physiology baseline facts + the latest agent-authored daily targets + the weight chart) and adds a
// dietary-profile card (allergies / regime + an editor). Live-refetches off the SSE stream so an agent
// (or the food-log drawer) updating the goal / targets / dietary profile reflects here without a reload.

import { useMemo, useRef, useState } from "react";
import type { BodyObjective, BodyProfile, WeightEntry, NutritionTargetArtifact, DietProfile } from "@/lib/types";
import type { BodyBaseline } from "@/lib/body-baseline";
import { useLiveBoard } from "@/lib/use-live-board";
import { getBodyStatus, listWeights } from "@/lib/body-client";
import { getLatestNutritionTarget, getDietProfile } from "@/lib/nutrition-client";
import { toISODay } from "@/lib/nutrition-format";
import { ObjectivePanel } from "@/components/nutrition/objective-panel";
import { IconChef, IconScale } from "@/components/icons";
import { DietProfileDrawer } from "./diet-profile-drawer";
import { BodyProfileDrawer } from "./body-profile-drawer";

const TRAINING_LABEL: Record<string, string> = { novice: "Novice", intermediate: "Intermediate", advanced: "Advanced" };

export function BodyHubView({
  now,
  profile: ip,
  objective: io,
  baseline: ib,
  latestTarget: il,
  weights: iw,
  unit: iu,
  sex: isx,
  dietProfile: idp,
  version,
}: {
  now: string;
  profile: BodyProfile | null;
  objective: BodyObjective | null;
  baseline: BodyBaseline;
  latestTarget: NutritionTargetArtifact | null;
  weights: WeightEntry[];
  unit: "kg" | "lb";
  sex?: "male" | "female";
  dietProfile: DietProfile;
  version?: number;
}) {
  const [profile, setProfile] = useState(ip);
  const [objective, setObjective] = useState(io);
  const [baseline, setBaseline] = useState(ib);
  const [latestTarget, setLatestTarget] = useState(il);
  const [weights, setWeights] = useState(iw);
  const [unit, setUnit] = useState(iu);
  const [sex, setSex] = useState(isx);
  const [dietProfile, setDietProfile] = useState(idp);
  const [drawer, setDrawer] = useState(false);
  const [identityDrawer, setIdentityDrawer] = useState(false);
  const lastVersion = useRef<number>(version ?? 0);
  const today = useMemo(() => toISODay(new Date(now)), [now]);

  const refetch = async (): Promise<void> => {
    const [s, t, w, d] = await Promise.allSettled([getBodyStatus(), getLatestNutritionTarget(), listWeights(), getDietProfile()]);
    if (s.status === "fulfilled") {
      setBaseline(s.value.baseline);
      setObjective(s.value.objective);
      setProfile(s.value.profile);
      setUnit(s.value.profile?.weightUnit ?? "kg");
      setSex(s.value.profile?.sex);
      lastVersion.current = s.value.version;
    }
    if (t.status === "fulfilled") setLatestTarget(t.value.artifact);
    if (w.status === "fulfilled") setWeights(w.value.weights);
    if (d.status === "fulfilled") setDietProfile(d.value.profile);
  };

  useLiveBoard(lastVersion, refetch);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      <div className="h-12 px-5 flex items-center border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Body</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          <IdentityCard profile={profile} ageYears={baseline.ageYears} unit={unit} onEdit={() => setIdentityDrawer(true)} />
          <ObjectivePanel
            objective={objective}
            baseline={baseline}
            latestTarget={latestTarget}
            weights={weights}
            today={today}
            unit={unit}
            sex={sex}
            onMutated={refetch}
          />
          <DietProfileCard profile={dietProfile} onEdit={() => setDrawer(true)} />
        </div>
      </div>
      {drawer && <DietProfileDrawer profile={dietProfile} onClose={() => setDrawer(false)} onSaved={refetch} />}
      {identityDrawer && <BodyProfileDrawer profile={profile} onClose={() => setIdentityDrawer(false)} onSaved={refetch} />}
    </div>
  );
}

// The identity card — sex · age (from DOB) · height · training status · whether you lift. The
// single structured home for body identity (Nutrition + Fitness read it cross-add-on); editable here.
function IdentityCard({ profile, ageYears, unit, onEdit }: { profile: BodyProfile | null; ageYears: number | null; unit: "kg" | "lb"; onEdit: () => void }) {
  return (
    <section className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-ink-50">
        <IconScale className="w-4 h-4 shrink-0 text-ink-400" />
        <span className="text-[13px] font-semibold text-ink-900">About you</span>
        <button onClick={onEdit} className="ml-auto text-[11px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-ink-50">
          {profile ? "Edit" : "Set up"}
        </button>
      </div>
      <div className="px-3.5 py-3">
        {!profile ? (
          <p className="text-[12px] text-ink-500">
            Add your sex, date of birth, height, and training status — these feed your BMR/BMI and shape your nutrition + training plans.
          </p>
        ) : (
          <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap text-[12px] text-ink-700 tabular-nums">
            <span><span className="text-ink-400">Sex</span> {profile.sex === "male" ? "Male" : "Female"}</span>
            <span><span className="text-ink-400">Age</span> {ageYears ?? "—"}</span>
            <span><span className="text-ink-400">Height</span> {profile.heightCm} cm</span>
            <span><span className="text-ink-400">Training</span> {TRAINING_LABEL[profile.trainingStatus] ?? profile.trainingStatus}</span>
            <span><span className="text-ink-400">Lifts</span> {profile.resistanceTrains ? "yes" : "no"}</span>
            <span><span className="text-ink-400">Units</span> {unit}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function DietProfileCard({ profile, onEdit }: { profile: DietProfile; onEdit: () => void }) {
  const allergies = profile.allergies ?? [];
  const dietType = profile.dietType ?? [];
  return (
    <section className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-ink-50">
        <IconChef className="w-4 h-4 shrink-0 text-ink-400" />
        <span className="text-[13px] font-semibold text-ink-900">Dietary profile</span>
        <button onClick={onEdit} className="ml-auto text-[11px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-ink-50">
          Edit
        </button>
      </div>
      <div className="px-3.5 py-3 space-y-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-rose-500 mb-1 font-medium">Allergies (safety)</div>
          {allergies.length ? (
            <div className="flex flex-wrap gap-1.5">
              {allergies.map((a) => (
                <span key={a} className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-rose-50 text-rose-700 ring-1 ring-rose-200">{a}</span>
              ))}
            </div>
          ) : (
            <span className="text-[12px] text-ink-400">None recorded.</span>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-400 mb-1">Diet type / regime</div>
          {dietType.length ? (
            <div className="flex flex-wrap gap-1.5">
              {dietType.map((d) => (
                <span key={d} className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700">{d}</span>
              ))}
            </div>
          ) : (
            <span className="text-[12px] text-ink-400">No regime set.</span>
          )}
        </div>
        {profile.notes && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-400 mb-1">Notes</div>
            <p className="text-[12px] text-ink-700 leading-snug">{profile.notes}</p>
          </div>
        )}
        <p className="text-[11px] text-ink-400 pt-1 border-t border-ink-50">
          Your chief of staff reads this — and the diet methodology behind &ldquo;Edit&rdquo; — before planning meals or setting targets.
        </p>
      </div>
    </section>
  );
}
