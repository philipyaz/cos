import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { needsAttention } from "@/lib/selectors";
import type { CaseDomain, CaseKind, CaseRecord, CaseStatus, Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// One case in a needs-attention bucket — a trimmed projection, not a full CaseRecord (the read
// is an answer, not a case dump; mirrors VaultCoverageGap in ./vault-coverage).
interface NeedsAttentionRef {
  id: string;
  title: string;
  domain: CaseDomain;
  status: CaseStatus;
  kind?: CaseKind;
  priority?: Priority;
  dueAt?: string;
  updatedAt: string;
}

function ref(c: CaseRecord): NeedsAttentionRef {
  return {
    id: c.id,
    title: c.title,
    domain: c.domain,
    status: c.status,
    kind: c.kind,
    priority: c.priority,
    dueAt: c.dueAt,
    updatedAt: c.updatedAt,
  };
}

// GET /api/cases/needs-attention — the board's own "what needs attention" read, agent-reachable
// (ADR 0017's compute-on-read family; cos-ops#20). No query params: needsAttention excludes
// archived cases in EVERY bucket by definition, so an includeArchived knob would change what the
// buckets mean, not just their scope (out of scope here — see selectors.ts). `counts` is the
// phone-glance number (vault-coverage / unanswered-count precedent); buckets OVERLAP (e.g. a case
// can be both overdue and unlinked), so `counts.total` is a SUM of bucket sizes, not a count of
// distinct cases.
export async function GET() {
  const db = await readDB();
  const at = needsAttention(db.cases, new Date());

  const overdue = at.overdue.map(ref);
  const agingWaiting = at.agingWaiting.map(ref);
  const untriaged = at.untriaged.map(ref);
  const unlinked = at.unlinked.map(ref);

  return NextResponse.json({
    overdue,
    agingWaiting,
    untriaged,
    unlinked,
    counts: {
      overdue: overdue.length,
      agingWaiting: agingWaiting.length,
      untriaged: untriaged.length,
      unlinked: unlinked.length,
      total: overdue.length + agingWaiting.length + untriaged.length + unlinked.length,
    },
    version: db.version,
  });
}
