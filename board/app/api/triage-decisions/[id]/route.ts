import { NextResponse, type NextRequest } from "next/server";
import { mutate, findTriageDecision, applyTriageResolution, NotFoundError } from "@/lib/store";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/triage-decisions/[id] { resolution: "confirm" | "reverse" } — the review's write
// (/reminders-review's digest answers a first-time sender through this). "confirm" stamps
// reviewedAt only — the sender leaves the computed first-time set, the sweep keeps filtering.
// "reverse" also flips status → "reversed" — the human said KEEP, so the sweep's next
// recordTriageDrop for this sender+source is refused (403 sender-reversed). Un-reversing a
// reversed row is out of scope (no criterion needs it) — reversing an already-confirmed row
// later stays legal. Unknown id → 404; a resolution outside the two values → 400.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (body.resolution !== "confirm" && body.resolution !== "reverse") {
    return NextResponse.json({ error: "'resolution' must be 'confirm' or 'reverse'." }, { status: 400 });
  }

  resolveActor(req, body); // records the calling device; nothing lands on the row (no author field — decision 7)

  try {
    const { decision, version } = await mutate((db) => {
      const rec = findTriageDecision(db, id);
      if (!rec) throw new NotFoundError(`Triage decision ${id} not found`);
      const decision = applyTriageResolution(rec, body.resolution as "confirm" | "reverse");
      return { decision, version: db.version };
    });
    return NextResponse.json({ decision, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
