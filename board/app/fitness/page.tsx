import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { FitnessOverviewView } from "@/components/fitness/overview-view";

// The Fitness overview hub — the athlete-profile editor + the quick-jump row to the
// add-on's coaching surfaces. A server component (like the Food Log page) that GATES the
// surface on the "fitness" add-on flag, then hands off to the interactive client view,
// which seeds itself from its own client fetch and refetches live off the SSE stream.
//
// The profile data lives in the CORE store (db.athleteProfile), but it is an OPTIONAL
// add-on: this page is GATED — when the "fitness" add-on is disabled it 404s (notFound),
// so a disabled add-on has no reachable surface even though its data stays on disk +
// readable via the (ungated) API.
export const dynamic = "force-dynamic";

export default async function FitnessOverviewPage() {
  const db = await readDB();
  // Gate the surface on the add-on flag. The WRITE route gates inside mutate() (a disabled
  // add-on refuses a profile save), and the nav group hides when disabled — but a
  // hand-typed /fitness must also 404, so the disabled add-on is fully dormant.
  if (!isAddonEnabled(db, "fitness")) notFound();

  return (
    <>
      <TopBar crumbs={["Cos", "Fitness"]} live />
      <FitnessOverviewView />
    </>
  );
}
