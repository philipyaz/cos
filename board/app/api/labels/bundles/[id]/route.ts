import { NextResponse, type NextRequest } from "next/server";
import { mutate } from "@/lib/store";
import { activeLabels, uninstallBundle } from "@/lib/labels";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape } from "@/lib/types";

export const dynamic = "force-dynamic";

// DELETE /api/labels/bundles/[id] — UNINSTALL a bundle: remove the catalog labels
// it owns (by provenance; shared ids owned by another installed bundle and custom
// labels are left). By default it also SCRUBS the removed ids from every case
// (so no card keeps a dangling reference); pass ?scrub=0 to keep the case refs.
// Returns the removed ids, how many cases were scrubbed, the catalog, and version.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const scrub = req.nextUrl.searchParams.get("scrub") !== "0"; // default ON

  try {
    let dbRef: DBShape | undefined;
    const result = await mutate((db) => {
      dbRef = db;
      return uninstallBundle(db, id, { scrub });
    });
    return NextResponse.json({
      ok: true,
      removed: result.removed,
      scrubbed: result.scrubbed,
      labels: activeLabels(dbRef!),
      version: dbRef!.version,
    });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
