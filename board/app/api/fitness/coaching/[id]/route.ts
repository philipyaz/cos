import { NextResponse, type NextRequest } from "next/server";
import {
  getCoachingArtifact,
  updateCoachingArtifact,
  deleteCoachingArtifact,
} from "@/lib/fitness";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Shared token gate (x-fitness-token vs FITNESS_PUSH_TOKEN) — verbatim push-route shape.
// Returns a NextResponse on failure (503 unset / 401 mismatch), or null when authorized.
function tokenGate(req: NextRequest): NextResponse | null {
  const token = (process.env.FITNESS_PUSH_TOKEN || "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Health push is not configured on the server." },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-fitness-token")?.trim();
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

// GET /api/fitness/coaching/[id] — UNGATED (a disabled add-on's artifact stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { artifact, version } = await getCoachingArtifact(id);
  if (!artifact) {
    return NextResponse.json({ error: `Coaching artifact ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ artifact, version });
}

// PATCH /api/fitness/coaching/[id] — partial update (payload / source / generatedAt) via
// applyCoachingArtifactUpdate (present-keys-only). TOKEN-gated. GATED inside the lock
// (disabled add-on → NotFoundError → 404 via storeErrorToResponse).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = tokenGate(req);
  if (gate) return gate;

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

// DELETE /api/fitness/coaching/[id] — hard-remove the artifact. TOKEN-gated. GATED inside the
// lock (disabled add-on → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = tokenGate(req);
  if (gate) return gate;

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
