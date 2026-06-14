import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { MealPlanView } from "@/components/nutrition/meal-plan-view";

// The Meal Plan surface — the Phase-3 vertical of the Nutrition & Chef add-on. A server
// component (like the Food Log page) that SSR-seeds the interactive client view, then
// leaves it to refetch live off the SSE stream. The meal-plan data lives in the CORE
// store (db.mealPlanEntries), but it is an OPTIONAL add-on: this page is GATED — when the
// "nutrition" add-on is disabled it 404s (notFound), so a disabled add-on has no
// reachable surface even though its data stays on disk + readable via the API.
export const dynamic = "force-dynamic";

export default async function MealPlanPage() {
  const db = await readDB();
  // Gate the surface on the add-on flag. The WRITE routes gate inside mutate() (a
  // disabled add-on refuses new entries), and the nav group hides when disabled — but a
  // hand-typed /nutrition/plan must also 404, so the disabled add-on is fully dormant.
  if (!isAddonEnabled(db, "nutrition")) notFound();

  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Nutrition & Chef", "Meal Plan"]} live />
      <MealPlanView now={now} entries={db.mealPlanEntries ?? []} version={db.version} />
    </>
  );
}
