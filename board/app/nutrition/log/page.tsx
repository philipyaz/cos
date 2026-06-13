import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { FoodLogView } from "@/components/nutrition/food-log-view";

// The Food Log surface — the Phase-1 vertical of the Nutrition & Chef add-on. A server
// component (like the Reminders page) that SSR-seeds the interactive client view, then
// leaves it to refetch live off the SSE stream. The food-log data lives in the CORE
// store (db.foodLogs), but it is an OPTIONAL add-on: this page is GATED — when the
// "nutrition" add-on is disabled it 404s (notFound), so a disabled add-on has no
// reachable surface even though its data stays on disk + readable via the API.
export const dynamic = "force-dynamic";

export default async function FoodLogPage() {
  const db = await readDB();
  // Gate the surface on the add-on flag. The WRITE routes gate inside mutate() (a
  // disabled add-on refuses new entries), and the nav group hides when disabled — but a
  // hand-typed /nutrition/log must also 404, so the disabled add-on is fully dormant.
  if (!isAddonEnabled(db, "nutrition")) notFound();

  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Nutrition & Chef", "Food Log"]} live />
      <FoodLogView now={now} entries={db.foodLogs ?? []} version={db.version} />
    </>
  );
}
