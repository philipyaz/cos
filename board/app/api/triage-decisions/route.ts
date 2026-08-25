import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, recordTriageDrop } from "@/lib/store";
import { computeTriageSummary } from "@/lib/triage-decisions";
import {
  VALID_MESSAGE_SOURCE,
  VALID_TRIAGE_DROP_REASON,
  VALID_TRIAGE_DECISION_STATUS,
  type MessageSource,
  type TriageDropReason,
  type TriageDecisionStatus,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/triage-decisions?source=&status= — the review's read. `source` (a VALID_MESSAGE_SOURCE
// member) filters BOTH the `decisions` list and the computed `summary`'s scope; `status` filters
// only the `decisions` list (the summary always spans both statuses — the history of a reversed
// sender still happened). computeTriageSummary does the counting (ADR 0017 — computed on read,
// never persisted).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sourceParam = sp.get("source")?.trim() || undefined;
  const statusParam = sp.get("status")?.trim() || undefined;
  // An unknown filter value is a 400, never a silent fallback to the unscoped (mixed-scope) summary —
  // POST 400s on the same input, and a typo'd `?source=gmial` read as the gmail figure otherwise.
  if (sourceParam && !VALID_MESSAGE_SOURCE.includes(sourceParam as MessageSource)) {
    return NextResponse.json({ error: `'source' must be one of: ${VALID_MESSAGE_SOURCE.join(", ")}.` }, { status: 400 });
  }
  if (statusParam && !VALID_TRIAGE_DECISION_STATUS.includes(statusParam as TriageDecisionStatus)) {
    return NextResponse.json({ error: `'status' must be one of: ${VALID_TRIAGE_DECISION_STATUS.join(", ")}.` }, { status: 400 });
  }
  const source = sourceParam ? (sourceParam as MessageSource) : undefined;

  const db = await readDB();

  let decisions = db.triageDecisions ?? [];
  if (source) decisions = decisions.filter((d) => d.source === source);
  if (statusParam && VALID_TRIAGE_DECISION_STATUS.includes(statusParam as TriageDecisionStatus)) {
    decisions = decisions.filter((d) => d.status === statusParam);
  }

  const summary = computeTriageSummary(db, source);
  return NextResponse.json({ decisions, summary, version: db.version });
}

// POST /api/triage-decisions { sender*, source*, reason* } — the sweep's write, called the moment
// mail-to-board's five-test gate drops a thread. Upserts by (sender, source, reason): a repeat drop
// bumps `count` (200) rather than adding a row; a genuinely new key mints one (201). A sender with
// ANY reversed row for this (sender, source) is refused — 403, `code: "sender-reversed"` — the
// fail-closed half of the reversal guarantee (see TriageReversedError in lib/store.ts).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.sender !== "string" || body.sender.trim() === "") {
    return NextResponse.json({ error: "Field 'sender' is required." }, { status: 400 });
  }
  if (typeof body.source !== "string" || !VALID_MESSAGE_SOURCE.includes(body.source as MessageSource)) {
    return NextResponse.json(
      { error: `'source' must be one of: ${VALID_MESSAGE_SOURCE.join(", ")}.` },
      { status: 400 },
    );
  }
  if (typeof body.reason !== "string" || !VALID_TRIAGE_DROP_REASON.includes(body.reason as TriageDropReason)) {
    return NextResponse.json(
      { error: `'reason' must be one of: ${VALID_TRIAGE_DROP_REASON.join(", ")}.` },
      { status: 400 },
    );
  }

  resolveActor(req, body); // records the calling device; nothing lands on the row (no author field — decision 7)

  try {
    const { decision, created, version } = await mutate((db) => {
      const { decision, created } = recordTriageDrop(db, {
        sender: body.sender,
        source: body.source as MessageSource,
        reason: body.reason as TriageDropReason,
      });
      return { decision, created, version: db.version };
    });
    return NextResponse.json({ decision, created, version }, { status: created ? 201 : 200 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
