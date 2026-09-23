import { NextResponse, type NextRequest } from "next/server";
import { mutate, NotFoundError } from "@/lib/store";
import { commitVerb } from "@/lib/case-writes";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { CaseRecord, DBShape } from "@/lib/types";

export const dynamic = "force-dynamic";

// Local marker so an already-decided proposal maps to a 409 rather than a 400/404.
class ConflictError extends Error {}

// POST { decision: "approve" | "reject" } → resolve a queued proposal.
//  - approve → commit the verb via the shared write cores (lib/case-writes.ts —
//    the same code the direct routes call), mark the proposal "approved"
//  - reject  → mark it "rejected" (no board change)
// Both are one critical section so the queue flag + the committed change can't
// drift. A bad verb / missing target leaves the proposal untouched (we throw
// before mutating its status — but since we're inside mutate, throwing aborts the
// whole write, so the proposal stays "pending" and nothing is half-applied).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const decision = body && typeof body === "object" ? body.decision : undefined;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "Field 'decision' must be 'approve' or 'reject'." },
      { status: 400 },
    );
  }

  try {
    let dbRef: DBShape | undefined;
    const result = await mutate((db) => {
      dbRef = db;
      const p = (db.pending ?? []).find((x) => x.id === id);
      if (!p) throw new NotFoundError(`Pending mutation ${id} not found`);
      if (p.status !== "pending") {
        throw new ConflictError(`Pending mutation ${id} is already ${p.status}.`);
      }

      if (decision === "reject") {
        p.status = "rejected";
        return { pending: p, case: undefined as CaseRecord | undefined };
      }

      const rec = commitVerb(db, p.verb, p.target, p.payload);
      p.status = "approved";
      return { pending: p, case: rec };
    });

    return NextResponse.json({ pending: result.pending, case: result.case, version: dbRef!.version });
  } catch (e) {
    // Shared store-layer mapping FIRST (chiefly SchemaAheadError → 503) so the
    // generic Error → 400 below can't downgrade a fail-closed write refusal.
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    if (e instanceof ConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
