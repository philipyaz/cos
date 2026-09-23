import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate } from "@/lib/store";
import { COMMIT_HANDLERS, resolvePendingTarget, assertCommittable } from "@/lib/case-writes";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape, PendingMutation } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET → the agent's approval queue (proposed mutations awaiting a human decision).
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  return NextResponse.json({ pending: db.pending ?? [], version: db.version });
}

// POST { verb, target?, payload, summary } → an agent proposes a mutation for
// human approval. Validated at propose time: the door dry-runs the real
// commit (lib/case-writes.ts) against a clone and refuses a proposal that
// could never be approved, so nothing parks dead in the queue. A refusal here
// is never a promise the board will look identical at approve time — the
// queue's invariant is "was committable when proposed", not "is committable
// now"; approve re-runs the real commit against the live board (see its own
// Error → 400 arm in pending/[id]/route.ts, mirrored below).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.verb !== "string" || body.verb.trim() === "") {
    return NextResponse.json({ error: "Field 'verb' is required." }, { status: 400 });
  }
  const verb = body.verb.trim();
  if (!Object.hasOwn(COMMIT_HANDLERS, verb)) {
    return NextResponse.json(
      { error: `'verb' must be one of: ${Object.keys(COMMIT_HANDLERS).join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.summary !== "string" || body.summary.trim() === "") {
    return NextResponse.json({ error: "Field 'summary' is required." }, { status: 400 });
  }
  const payload: Record<string, unknown> = body.payload && typeof body.payload === "object" ? body.payload : {};

  try {
    const target = resolvePendingTarget(body.target, payload);

    let dbRef: DBShape | undefined;
    const pending = await mutate((db): PendingMutation => {
      dbRef = db;
      // Dry-run inside the lock: "was committable when proposed" and "stored"
      // are one act, so this can't race a concurrent write into a stale check.
      assertCommittable(db, verb, target, payload);
      if (!db.pending) db.pending = [];
      const p: PendingMutation = {
        id: `P-${db.pending.length + 1}`,
        proposedAt: new Date().toISOString(),
        actor: "agent",
        verb,
        target,
        payload,
        summary: String(body.summary).trim(),
        status: "pending",
      };
      db.pending.push(p);
      return p;
    });

    return NextResponse.json({ pending, version: dbRef!.version }, { status: 201 });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    // Mirrors approve's own generic arm (pending/[id]/route.ts): a dry-run
    // refusal that isn't a store-layer error class is still a 400, never a 500.
    if (e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
