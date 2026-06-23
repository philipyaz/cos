import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { bodyBaseline } from "@/lib/body-baseline";
import { DEFAULT_DIET_PHILOSOPHY } from "@/lib/diet-philosophy-default";
import { toISODay } from "@/lib/nutrition-format";
import { TopBar } from "@/components/topbar";
import { BodyHubView } from "@/components/body/body-hub-view";
import type { DietProfile } from "@/lib/types";

// The /body hub — the Body add-on's surface (identity + the free-text objective + the weight/
// composition series + the dietary profile). A server component that SSR-seeds the interactive view.
// GATED — a disabled "body" add-on 404s (notFound); body hard auto-enables under nutrition/fitness.
export const dynamic = "force-dynamic";

export default async function BodyPage() {
  const db = await readDB();
  if (!isAddonEnabled(db, "body")) notFound();

  const clock = new Date();
  const now = clock.toISOString();
  const today = toISODay(clock);

  const profile = db.bodyProfile ?? null;
  const objective = db.bodyObjective ?? null;
  const weights = db.weights ?? [];
  const baseline = bodyBaseline({ profile, objective, weights, foodLogs: db.foodLogs ?? [], today });
  const latestTarget =
    [...(db.nutritionTargets ?? [])]
      .filter((a) => a.kind === "daily_targets")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ?? null;

  // The effective dietary profile (default philosophy injected when the user's is empty — mirrors the
  // /api/nutrition/diet-profile GET, so the SSR seed matches what the live refetch returns).
  const stored = db.dietProfile;
  const dietProfile: DietProfile = stored
    ? { ...stored, philosophy: stored.philosophy === "" ? DEFAULT_DIET_PHILOSOPHY : stored.philosophy }
    : { allergies: [], dietType: [], notes: "", philosophy: DEFAULT_DIET_PHILOSOPHY, createdAt: "", updatedAt: "" };

  return (
    <>
      <TopBar crumbs={["Cos", "Body"]} live />
      <BodyHubView
        now={now}
        profile={profile}
        objective={objective}
        baseline={baseline}
        latestTarget={latestTarget}
        weights={weights}
        unit={profile?.weightUnit ?? "kg"}
        sex={profile?.sex}
        dietProfile={dietProfile}
        version={db.version}
      />
    </>
  );
}
