import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, findCase, archiveCase, logActivity, NotFoundError, VersionConflictError } from "@/lib/store";
import { rolledUpMessageIds } from "@/lib/selectors";
import { validateCasePatch, applyValidatedCasePatch } from "@/lib/case-writes";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

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

  // Shape-check outside the lock, fast 400s before the lock. validateCasePatch
  // runs FIRST (title/status/domain/priority/labels-shape/kind/parentId), then
  // expectedVersion — an HTTP envelope concern the shared core doesn't own.
  // Residual: a body combining a field-shape error AND a non-number
  // expectedVersion now reports the field error (today reports the version
  // error) — no test pins either order.
  try {
    validateCasePatch(body);
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  const actor = resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

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
      // applyValidatedCasePatch (lib/case-writes.ts) — the same write core
      // PATCH /api/cases (batch) and an approved update_case/move proposal
      // call — owns the label check, the hierarchy check, the before-snapshot,
      // and the verb derivation (status present → "moved", else "updated").
      const rec = applyValidatedCasePatch(db, id, body, actor);
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
