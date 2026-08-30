import { NextResponse, type NextRequest } from "next/server";
import {
  getCoachingArtifact,
  updateCoachingArtifact,
  deleteCoachingArtifact,
} from "@/lib/fitness";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// These writes are add-on-gated: the add-on enabled gate inside the store mutation
// (assertAddonEnabled → NotFoundError → 404) is the sole guard.

// GET /api/fitness/coaching/[id] — UNGATED (a disabled add-on's artifact stays viewable). For
// a training_plan, the response also carries `reconciliation` (cos-ops#19: unresolved past
// session days + the workout-proven subset) — compute-on-read, never stored; absent for every
// other kind.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { artifact, reconciliation, version } = await getCoachingArtifact(id);
  if (!artifact) {
    return NextResponse.json({ error: `Coaching artifact ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ artifact, reconciliation, version });
}

// PATCH /api/fitness/coaching/[id] — partial update (payload / source / generatedAt) via
// applyCoachingArtifactUpdate (present-keys-only). GATED inside the lock (disabled add-on →
// NotFoundError → 404 via storeErrorToResponse).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  resolveActor(req, body);

  try {
    const { artifact, version } = await updateCoachingArtifact(id, body as Record<string, unknown>);
    return NextResponse.json({ artifact, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/fitness/coaching/[id] — hard-remove the artifact. GATED inside the lock
// (disabled add-on → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  resolveActor(req, null);

  try {
    const { version } = await deleteCoachingArtifact(id);
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
