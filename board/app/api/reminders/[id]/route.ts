import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findCase,
  findReminder,
  applyReminderUpdate,
  messagesForReminder,
  removeReminder,
  logActivity,
  NotFoundError,
  VersionConflictError,
  BadRequestError,
} from "@/lib/store";
import { assertKnownLabels } from "@/lib/labels";
import { VALID_DOMAIN, VALID_REMINDER_STATUS } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const reminder = findReminder(db, id);
  if (!reminder) {
    return NextResponse.json({ error: `Reminder ${id} not found` }, { status: 404 });
  }
  // Emails linked to this reminder (message.reminderId === id is the single source
  // of truth), newest-first. Normalize the timestamp before comparing so a bad/absent
  // receivedAt (NaN) deterministically sinks to the bottom (mirrors the cases GET sort).
  const receivedMs = (m: { receivedAt: string }): number => {
    const n = new Date(m.receivedAt).getTime();
    return Number.isNaN(n) ? -Infinity : n;
  };
  const messages = messagesForReminder(db, id)
    .slice()
    .sort((a, b) => receivedMs(b) - receivedMs(a));
  return NextResponse.json({ reminder, messages, version: db.version });
}

// PATCH /api/reminders/[id] — partial update of any reminder field incl. relinking
// via caseId (caseId:null/"" clears the link) and a status flip (which manages
// completedAt). Optional optimistic-concurrency guard: body.expectedVersion ≠
// db.version → 409. reminder.caseId is the link source of truth.
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
  if ("status" in body && !VALID_REMINDER_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_REMINDER_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("dueAt" in body && body.dueAt != null) {
    if (typeof body.dueAt !== "string" || body.dueAt.trim() === "" || Number.isNaN(new Date(body.dueAt).getTime())) {
      return NextResponse.json({ error: "'dueAt' must be a parseable ISO date string." }, { status: 400 });
    }
  }
  if ("domain" in body && body.domain != null && !VALID_DOMAIN.includes(body.domain)) {
    return NextResponse.json(
      { error: `'domain' must be one of: ${VALID_DOMAIN.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }
  // labels/tasks: shape-check OUTSIDE the lock → fast 400 (mirrors the cases route's
  // labels shape-check). Label-id VALIDITY (∈ catalog) is asserted INSIDE the lock.
  if ("labels" in body && body.labels != null) {
    if (!Array.isArray(body.labels) || body.labels.some((x: unknown) => typeof x !== "string")) {
      return NextResponse.json({ error: "'labels' must be an array of string label ids." }, { status: 400 });
    }
  }
  if ("tasks" in body && body.tasks != null) {
    if (
      !Array.isArray(body.tasks) ||
      body.tasks.some((t: unknown) => !t || typeof t !== "object" || typeof (t as Record<string, unknown>).title !== "string")
    ) {
      return NextResponse.json({ error: "'tasks' must be an array of objects with a string 'title'." }, { status: 400 });
    }
  }

  const actor = resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + update + write as one critical section (closes the read-then-write TOCTOU).
  try {
    const { reminder, version } = await mutate((db) => {
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findReminder(db, id);
      if (!rec) throw new NotFoundError(`Reminder ${id} not found`);

      // Label-id VALIDITY (∈ catalog) BEFORE applyReminderUpdate (which only coerces).
      // Throws BadRequestError → 400 below (the cases-route precedent).
      if ("labels" in body) assertKnownLabels(db, body.labels);

      // RELATIONAL check: a non-empty caseId must reference an existing case.
      // Throws BadRequestError → 400 below (the cases-route precedent).
      if ("caseId" in body && typeof body.caseId === "string" && body.caseId.trim()) {
        if (!findCase(db, body.caseId.trim())) {
          throw new BadRequestError(`Case ${body.caseId.trim()} not found for caseId.`);
        }
      }

      // Snapshot the old link + status BEFORE the patch so we can audit a relink on
      // both sides, and a completion when status flips TO "done".
      const prevCaseId = rec.caseId;
      const prevStatus = rec.status;
      applyReminderUpdate(rec, body);
      const now = rec.updatedAt;

      // Best-effort case audit trail (mirrors event_linked/unlinked/updated). Guarded
      // so a missing case never breaks the reminder write.
      if (prevCaseId !== rec.caseId) {
        if (prevCaseId) {
          const prev = findCase(db, prevCaseId);
          if (prev) {
            logActivity(prev, actor, "reminder_unlinked", rec.title);
            prev.updatedAt = now;
          }
        }
        if (rec.caseId) {
          const next = findCase(db, rec.caseId);
          if (next) {
            logActivity(next, actor, "reminder_linked", rec.title);
            next.updatedAt = now;
          }
        }
      } else if (rec.caseId) {
        const linked = findCase(db, rec.caseId);
        if (linked) {
          const verb = prevStatus !== "done" && rec.status === "done" ? "reminder_completed" : "reminder_updated";
          logActivity(linked, actor, verb, rec.title);
          linked.updatedAt = now;
        }
      }
      return { reminder: rec, version: db.version };
    });
    return NextResponse.json({ reminder, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/reminders/[id] — hard-remove the reminder (reminders have no
// soft-archive). Best-effort logs "reminder_unlinked" on the case it was linked to.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const actor = resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      const rec = findReminder(db, id);
      if (!rec) throw new NotFoundError(`Reminder ${id} not found`);
      const caseId = rec.caseId;
      const title = rec.title;
      removeReminder(db, id);

      // Best-effort case audit trail (mirrors event_unlinked). Guarded so a
      // missing case never breaks the delete.
      if (caseId) {
        const linked = findCase(db, caseId);
        if (linked) {
          logActivity(linked, actor, "reminder_unlinked", title);
          linked.updatedAt = new Date().toISOString();
        }
      }
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
