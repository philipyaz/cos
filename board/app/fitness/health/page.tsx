import { notFound } from "next/navigation";
import { readDB } from "@/lib/store";
import { isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { HealthView } from "@/components/fitness/health-view";

// The Health dashboard — the Apple-Watch health time-series surface of the Fitness add-on.
// A server component (like the Food Log / Reminders pages) that SSR-seeds the interactive
// client view, then leaves it to refetch live off the SSE stream. The health entries live
// in the CORE store (db.healthEntries), but it is an OPTIONAL add-on: this page is GATED —
// when the "fitness" add-on is disabled it 404s (notFound), so a disabled add-on has no
// reachable surface even though its data stays on disk + readable via the API.
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const db = await readDB();
  // Gate the surface on the add-on flag. The WRITE routes gate server-side (a disabled
  // add-on refuses pushes), and the nav group hides when disabled — but a hand-typed
  // /fitness/health must also 404, so the disabled add-on is fully dormant.
  if (!isAddonEnabled(db, "fitness")) notFound();

  // SSR seed: the health time-series, newest-first, plus the board version the client wires
  // useLiveBoard against. This mirrors the data route's listEntries EXACTLY — same descending
  // ts sort, same 500-row cap (the view refetches with getFitnessData({ limit: 500 })), and
  // `total` is the pre-cap count — so the first paint matches the live refetch (no hydration
  // drift, no row count jump). The view's own type matching projects each entry into sections.
  const all = [...(db.healthEntries ?? [])].sort((a, b) =>
    a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0,
  );
  const total = all.length;
  const entries = all.slice(0, 500);

  return (
    <>
      <TopBar crumbs={["Cos", "Fitness", "Health"]} live />
      <HealthView entries={entries} total={total} version={db.version} />
    </>
  );
}
