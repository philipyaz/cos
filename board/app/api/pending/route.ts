import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate } from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape, PendingMutation } from "@/lib/types";

export const dynamic = "force-dynamic";

// The verbs commitVerb() (pending/[id]/route.ts) can actually execute on approve.
// Reject anything else at proposal time so a bad verb fails loudly here rather
// than parking in the queue and dead-ending at approve. Keep in lockstep with
// commitVerb's switch.
const COMMITTABLE_VERBS = [
  "update_case",
  "update",
  "move",
  "archive",
  "restore",
  "add_task",
  "complete_task",
  "add_note",
  "create",
  "create_case",
];

// GET → the agent's approval queue (proposed mutations awaiting a human decision).
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  return NextResponse.json({ pending: db.pending ?? [], version: db.version });
}

// POST { verb, target?, payload, summary } → an agent proposes a mutation for
// human approval. It is parked (status "pending"); committing happens later via
// POST /api/pending/[id] { decision:"approve" }. proposedAt/actor are stamped here.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.verb !== "string" || body.verb.trim() === "") {
    return NextResponse.json({ error: "Field 'verb' is required." }, { status: 400 });
  }
  if (!COMMITTABLE_VERBS.includes(body.verb.trim())) {
    return NextResponse.json(
      { error: `'verb' must be one of: ${COMMITTABLE_VERBS.join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.summary !== "string" || body.summary.trim() === "") {
    return NextResponse.json({ error: "Field 'summary' is required." }, { status: 400 });
  }

  try {
    let dbRef: DBShape | undefined;
    const pending = await mutate((db): PendingMutation => {
      dbRef = db;
      if (!db.pending) db.pending = [];
      const p: PendingMutation = {
        id: `P-${db.pending.length + 1}`,
        proposedAt: new Date().toISOString(),
        actor: "agent",
        verb: String(body.verb).trim(),
        target: typeof body.target === "string" ? body.target : undefined,
        payload: body.payload && typeof body.payload === "object" ? body.payload : {},
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
    throw e;
  }
}
