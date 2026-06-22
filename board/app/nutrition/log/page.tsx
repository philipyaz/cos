import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { bodyBaseline } from "@/lib/body-baseline";
import { toISODay } from "@/lib/nutrition-format";
import { TopBar } from "@/components/topbar";
import { FoodLogView } from "@/components/nutrition/food-log-view";

// The Food Log surface — the Nutrition & Chef add-on's headline read. A server component that
// SSR-seeds the interactive client view (then it refetches live off the SSE stream). GATED — a
// disabled "nutrition" add-on 404s (notFound), so it has no reachable surface even though its
// data stays readable via the API.
export const dynamic = "force-dynamic";

export default async function FoodLogPage() {
  const db = await readDB();
  if (!isAddonEnabled(db, "nutrition")) notFound();

  // ONE request-time clock: an ISO instant the client parses (to mark "Today") + the local
  // calendar day the pure body-baseline projects against (it takes `today` as a string).
  const clock = new Date();
  const now = clock.toISOString();
  const today = toISODay(clock);

  // The v14 ObjectivePanel's SSR seed: the free-text objective, the deterministic physiology
  // baseline (facts only — NOT a recommendation), the weight series, and the latest AGENT-AUTHORED
  // daily-targets artifact (the board never computes targets; the agent authors them).
  const profile = db.bodyProfile ?? null;
  const objective = db.bodyObjective ?? null;
  const weights = db.weights ?? [];
  const baseline = bodyBaseline({ profile, objective, weights, foodLogs: db.foodLogs ?? [], today });
  const latestTarget =
    [...(db.nutritionTargets ?? [])]
      .filter((a) => a.kind === "daily_targets")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ?? null;

  return (
    <>
      <TopBar crumbs={["Cos", "Nutrition & Chef", "Food Log"]} live />
      <FoodLogView
        now={now}
        entries={db.foodLogs ?? []}
        version={db.version}
        objective={objective}
        baseline={baseline}
        latestTarget={latestTarget}
        weights={weights}
        unit={profile?.weightUnit ?? "kg"}
        sex={profile?.sex}
      />
    </>
  );
}
