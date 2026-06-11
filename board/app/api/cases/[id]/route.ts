import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findCase,
  applyCaseUpdate,
  describeCaseChange,
  logActivity,
  archiveCase,
  assertHierarchy,
  NotFoundError,
  VersionConflictError,
} from "@/lib/store";
import { assertKnownLabels } from "@/lib/labels";
import { rolledUpMessageIds } from "@/lib/selectors";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";
import {
  VALID_CASE_STATUS,
  VALID_DOMAIN,
  VALID_PRIORITY,
  VALID_CASE_KIND,
  type CaseKind,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const caseRec = findCase(db, id);
  if (!caseRec) {
    return NextResponse.json({ error: `Case ${id} not found` }, { status: 404 });
  }
  // ROLLED-UP mail for the node (self + every descendant), newest-first. For a
  // LEAF this is identical to today — a leaf has no descendants, so the rolled-up
  // set is exactly its own messageIds. For an Initiative/Workstream it now surfaces
  // every email linked anywhere beneath it, which also flows to the MCP get_case
  // tool that renders data.messages.
  const ids = new Set(rolledUpMessageIds(db.cases, id));
  // Newest-first. Normalize the timestamp before comparing so a bad/absent
  // receivedAt (NaN) deterministically sinks to the bottom rather than landing in
  // an engine-dependent spot among the valid rows.
  const receivedMs = (m: { receivedAt: string }): number => {
    const n = new Date(m.receivedAt).getTime();
    return Number.isNaN(n) ? -Infinity : n;
  };
  const messages = db.messages
    .filter((m) => ids.has(m.id))
    .sort((a, b) => receivedMs(b) - receivedMs(a));
  // Surface the user's MANUAL (human) actions explicitly so a reader can see what
  // was done by hand and avoid undoing it (the agent must not revert these).
  const manualActions = (caseRec.activity ?? []).filter((a) => a.actor === "human");
  // Linked calendar events. event.caseId is the single source of truth for the
  // case<->event link (no eventIds[] array lives on the case), so derive by filter.
  const events = (db.events ?? []).filter((e) => e.caseId === id);
  // Linked reminders. reminder.caseId is the single source of truth for the
  // node<->reminder link (no reminderIds[] array lives on the case), so derive by filter.
  const reminders = (db.reminders ?? []).filter((r) => r.caseId === id && !r.archivedAt);
  return NextResponse.json({ case: caseRec, messages, manualActions, events, reminders, version: db.version });
}

// PATCH /api/cases/[id] — partial update incl. lane move (status), dueAt, priority,
// position, snoozeUntil, archivedAt(null clears), domain, vaultLinks, all scalars.
// Optional optimistic-concurrency guard: body.expectedVersion ≠ db.version → 409.
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
  if ("title" in body && (typeof body.title !== "string" || body.title.trim() === "")) {
    return NextResponse.json({ error: "'title' must be a non-empty string." }, { status: 400 });
  }
  if ("status" in body && !VALID_CASE_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("domain" in body && !VALID_DOMAIN.includes(body.domain)) {
    return NextResponse.json(
      { error: `'domain' must be one of: ${VALID_DOMAIN.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("priority" in body && body.priority != null && !VALID_PRIORITY.includes(body.priority)) {
    return NextResponse.json(
      { error: `'priority' must be one of: ${VALID_PRIORITY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }
  if ("labels" in body && body.labels != null) {
    if (!Array.isArray(body.labels) || body.labels.some((x: unknown) => typeof x !== "string")) {
      return NextResponse.json({ error: "'labels' must be an array of string label ids." }, { status: 400 });
    }
  }
  // Tier shape-checks outside the lock; RELATIONAL validity (parent exists / tier
  // rules) is asserted inside the lock via assertHierarchy. parentId:null clears it.
  if ("kind" in body && body.kind != null && !VALID_CASE_KIND.includes(body.kind)) {
    return NextResponse.json(
      { error: `'kind' must be one of: ${VALID_CASE_KIND.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("parentId" in body && body.parentId != null && typeof body.parentId !== "string") {
    return NextResponse.json({ error: "'parentId' must be a string or null." }, { status: 400 });
  }

  const actor = resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // A status change is a lane move ("moved"); anything else is a generic "updated".
  // The detail is computed from a before/after snapshot inside the lock (below).
  const verb = "status" in body ? "moved" : "updated";

  // find + update + write as one critical section (closes the read-then-write TOCTOU).
  try {
    const { caseRec, version } = await mutate((db) => {
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      if ("labels" in body) assertKnownLabels(db, body.labels);
      // RELATIONAL tier check BEFORE applying: compute the INTENDED kind/parentId
      // (body overlaid on the current record — exactly the post-patch shape) and
      // assert the invariants. Throws BadRequestError → 400 below.
      if ("kind" in body || "parentId" in body) {
        const kind: CaseKind = "kind" in body && body.kind != null ? (body.kind as CaseKind) : (rec.kind ?? "case");
        const parentId: string | undefined =
          "parentId" in body ? ((body.parentId as string) || undefined) : rec.parentId;
        assertHierarchy(db, { id, kind, parentId });
      }
      // Snapshot BEFORE the patch so the audit detail can say WHAT changed
      // (e.g. "todo→done; priority") — this is how a later reader sees the user's
      // manual edits and avoids undoing them.
      const before = { ...rec };
      applyCaseUpdate(rec, body);
      logActivity(rec, actor, verb, describeCaseChange(before, rec));
      return { caseRec: rec, version: db.version };
    });
    return NextResponse.json({ case: caseRec, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/cases/[id] — SOFT delete (Trash): set archivedAt, activity
// "archived". The case stays browsable (includeArchived) and restorable
// (restoreCase). Permanent removal is the lazy retention sweep (sweepExpiredTrash),
// never an HTTP verb — there is no hard-delete path anymore (it orphaned emails and
// caused re-triage to duplicate cases).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const actor = resolveActor(req, null);

  try {
    const { caseRec, version } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      archiveCase(rec);
      logActivity(rec, actor, "archived");
      return { caseRec: rec, version: db.version };
    });
    return NextResponse.json({ ok: true, case: caseRec, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
