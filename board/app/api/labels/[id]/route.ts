import { NextResponse, type NextRequest } from "next/server";
import { mutate, NotFoundError } from "@/lib/store";
import { activeLabels, updateLabelDef, removeLabelDef } from "@/lib/labels";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape } from "@/lib/types";

export const dynamic = "force-dynamic";

// PATCH /api/labels/[id] — edit a label's display fields (title/description/color/
// domain). Identity (id) and provenance (bundle) are immutable. Returns the updated
// label, the full catalog, and the new version.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  try {
    let dbRef: DBShape | undefined;
    const label = await mutate((db) => {
      dbRef = db;
      return updateLabelDef(db, id, body as Record<string, unknown>);
    });
    return NextResponse.json({ label, labels: activeLabels(dbRef!), version: dbRef!.version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/labels/[id] — remove a label from the catalog. By default it just
// drops the definition (cases keep the now-dangling id, which the UI renders as a
// muted raw chip). Pass ?scrub=1 to ALSO strip the id from every case.labels.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const scrub = req.nextUrl.searchParams.get("scrub") === "1";

  try {
    let dbRef: DBShape | undefined;
    await mutate((db) => {
      dbRef = db;
      const removed = removeLabelDef(db, id, { scrub });
      if (!removed) throw new NotFoundError(`Label '${id}' not found.`);
      return true;
    });
    return NextResponse.json({ ok: true, scrubbed: scrub, labels: activeLabels(dbRef!), version: dbRef!.version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
