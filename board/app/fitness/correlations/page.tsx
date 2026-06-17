import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { CorrelationsView } from "@/components/fitness/correlations-view";

// The Sleep / Performance correlation surface — a read-only analysis vertical of the
// Fitness add-on. A server component (like the Food Log page) that gates the surface, then
// hands off to the interactive client view. The correlation is computed on demand by the
// /api/fitness/correlations route over the health time-series; this page itself carries no
// SSR seed — the view fetches when the human picks a window and hits "Analyze".
//
// GATED: when the "fitness" add-on is disabled this page 404s (notFound), so a hand-typed
// /fitness/correlations is dormant even though the underlying health data stays on disk and
// readable via the API. Mirrors the nutrition Food Log page's gate exactly.
export const dynamic = "force-dynamic";

export default async function CorrelationsPage() {
  const db = await readDB();
  // Gate the surface on the add-on flag. The nav group hides when disabled, the WRITE
  // routes gate inside their handlers, but a hand-typed /fitness/correlations must also
  // 404 — so the disabled add-on has no reachable surface.
  if (!isAddonEnabled(db, "fitness")) notFound();

  return (
    <>
      <TopBar crumbs={["Cos", "Fitness", "Correlations"]} live />
      <CorrelationsView />
    </>
  );
}
