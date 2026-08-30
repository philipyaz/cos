import { NextResponse, type NextRequest } from "next/server";
import { setPlanDayOutcome } from "@/lib/fitness";
import { VALID_PLAN_DAY_OUTCOME } from "@/lib/fitness-plan-status";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/fitness/coaching/[id]/day — a TARGETED per-day outcome write on a training_plan
// artifact (cos-ops#19): record what actually happened to ONE planned day WITHOUT re-saving
// the whole artifact. Body: { date, status, movedTo?, expectedVersion? }. A deeper member of
// the existing /api/fitness/coaching family (nested-write precedent: cases/[id]/notes,
// cases/[id]/tasks/[taskId], reminders/[id]/messages) — NOT the wholesale-replace PATCH at
// .../coaching/[id], which stays the un-validating manual-payload-edit escape hatch (see its
// KNOWN LIMIT comment in store.ts). GATED inside the lock (disabled add-on → 404 via
// storeErrorToResponse); the relational checks (artifact exists, is a training_plan, the day
// exists and is a session day) also run inside the lock, atomically with the write.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Body-shape validation (no DB needed) → fast 400s, outside the lock.
  if (!isISODate(body.date)) {
    return NextResponse.json({ error: "'date' must be YYYY-MM-DD." }, { status: 400 });
  }
  if (!VALID_PLAN_DAY_OUTCOME.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_PLAN_DAY_OUTCOME.join(", ")}.` },
      { status: 400 }
    );
  }
  // movedTo is required IFF status is "moved" — 400 in both directions.
  if (body.status === "moved") {
    if (!isISODate(body.movedTo)) {
      return NextResponse.json(
        { error: "'movedTo' must be YYYY-MM-DD when status is 'moved'." },
        { status: 400 }
      );
    }
    if (body.movedTo === body.date) {
      return NextResponse.json({ error: "'movedTo' must differ from 'date'." }, { status: 400 });
    }
  } else if ("movedTo" in body && body.movedTo != null) {
    return NextResponse.json(
      { error: "'movedTo' is only valid when status is 'moved'." },
      { status: 400 }
    );
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // A day outcome links to no case, so there is no case-activity audit trail to stamp;
  // resolved for parity (and its recordDevice side effect) like every other write route.
  resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  try {
    const { artifact, day, version } = await setPlanDayOutcome(id, {
      date: body.date,
      status: body.status,
      ...(body.status === "moved" ? { movedTo: body.movedTo } : {}),
      expectedVersion,
    });
    return NextResponse.json({ artifact, day, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
