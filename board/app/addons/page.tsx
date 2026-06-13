import { readDB } from "@/lib/store";
import { ADDON_REGISTRY, isAddonEnabled } from "@/lib/addons";
import { TopBar } from "@/components/topbar";
import { AddonsView } from "@/components/addons/addons-view";
import type { AddonView } from "@/lib/board-client";

// The Add-ons catalog / management surface — the single home for turning the optional
// verticals (Nutrition & Chef today; more later) on and off. A server component (like
// the Backups / Security pages) that SSR-seeds the interactive client view, then leaves
// it to reconcile live. The enabled flag lives in the CORE store (db.settings.addons),
// so a toggle bumps db.version → SSE → both this catalog and the sidebar's Add-ons group
// flip without a reload.
//
// dynamic="force-dynamic": the enabled flags live in cases.json (read per-request) and
// the bridge reachability is a live probe, so this must never be statically cached. The
// SSR seed carries the accurate enabled flags + the manifest content; bridge.reachable
// is seeded false and corrected by the view's first live refetch (which calls the same
// /api/addons GET that runs the real ~300ms probe). It is NOT seeded here because the
// probe belongs to the route — the page only needs the cheap DB read.
export const dynamic = "force-dynamic";

export default async function AddonsPage() {
  const db = await readDB();
  // Seed one row per manifest from the registry + the DB's enabled flags. bridge.reachable
  // starts false (a conservative "down until proven up"); the view's mount refetch hits the
  // /api/addons GET, which runs the authoritative probe and reseeds the reachability hints.
  const initial: AddonView[] = ADDON_REGISTRY.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    icon: a.icon,
    navItems: a.navItems,
    enabled: isAddonEnabled(db, a.id),
    bridge: { port: a.mcp.defaultPort, reachable: false },
  }));

  return (
    <>
      <TopBar crumbs={["Cos", "Add-ons"]} live />
      <AddonsView initial={initial} version={db.version} />
    </>
  );
}
