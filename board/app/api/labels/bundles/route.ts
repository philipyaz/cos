import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate } from "@/lib/store";
import { activeLabels, installBundle, ownedCount } from "@/lib/labels";
import { LABEL_BUNDLES } from "@/lib/label-bundles";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/labels/bundles — the built-in installable bundles (role / life /
// universal packs). Read-only static content. The UI's Labels manager lists these
// for one-click install; an agent can read them to suggest a taxonomy. Per bundle
// it reports `installedCount` (how many of its labels are in the catalog, by any
// provenance — drives install/add-missing) and `ownedCount` (labels this bundle
// owns and would remove on uninstall — drives the Uninstall affordance).
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  const have = new Set(activeLabels(db).map((l) => l.id));
  const bundles = LABEL_BUNDLES.map((b) => ({
    ...b,
    installedCount: b.labels.filter((l) => have.has(l.id)).length,
    ownedCount: ownedCount(db, b.id),
  }));
  return NextResponse.json({ bundles, version: db.version });
}

// POST /api/labels/bundles — install a bundle's labels into the active catalog.
// Body: { bundleId* }. Idempotent: labels already present are skipped. Returns the
// ids actually installed, the full catalog, and the new version.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const bundleId = typeof body.bundleId === "string" ? body.bundleId.trim() : "";
  if (!bundleId) {
    return NextResponse.json({ error: "Field 'bundleId' is required." }, { status: 400 });
  }

  try {
    let dbRef: DBShape | undefined;
    const result = await mutate((db) => {
      dbRef = db;
      return installBundle(db, bundleId);
    });
    return NextResponse.json({
      installed: result.installed,
      conflicts: result.conflicts,
      labels: activeLabels(dbRef!),
      version: dbRef!.version,
    });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
