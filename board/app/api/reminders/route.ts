import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  nextReminderId,
  findCase,
  applyReminderUpdate,
  logActivity,
  BadRequestError,
} from "@/lib/store";
import { assertKnownLabels } from "@/lib/labels";
import { VALID_DOMAIN, VALID_REMINDER_STATUS, type Reminder, type CaseDomain, type ReminderStatus } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/reminders?status=&caseId=&domain=&includeArchived= — by default returns
// every LIVE reminder (soft-deleted/Trash ones excluded). `status` filters on
// r.status (only applied when a valid ReminderStatus). `caseId`/`domain` narrow to a
// linked node / domain. `includeArchived=1` adds the Trash reminders back (the /trash
// surface uses it). reminder.caseId is the link source of truth.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status")?.trim() || undefined;
  const caseId = sp.get("caseId")?.trim() || undefined;
  const domain = sp.get("domain")?.trim() || undefined;
  const includeArchived = sp.get("includeArchived") === "1";

  const db = await readDB();

  let reminders = db.reminders ?? [];
  // Soft-deleted reminders are Trash — hidden from every surface except /trash.
  if (!includeArchived) reminders = reminders.filter((r) => !r.archivedAt);
  if (status && VALID_REMINDER_STATUS.includes(status as ReminderStatus)) {
    reminders = reminders.filter((r) => r.status === status);
  }
  if (caseId) reminders = reminders.filter((r) => r.caseId === caseId);
  if (domain) reminders = reminders.filter((r) => r.domain === domain);

  return NextResponse.json({ reminders, version: db.version });
}

// POST /api/reminders — create a lightweight nudge. status defaults "open"; absent
// optionals are omitted from the record. A caseId, when present, must reference an
// existing case (checked inside the lock); reminder.caseId is the link's source of truth.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json({ error: "Field 'title' is required." }, { status: 400 });
  }
  if ("status" in body && body.status != null && !VALID_REMINDER_STATUS.includes(body.status)) {
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
  if ("caseId" in body && body.caseId != null && typeof body.caseId !== "string") {
    return NextResponse.json({ error: "'caseId' must be a string." }, { status: 400 });
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
  const caseId: string | undefined =
    "caseId" in body && typeof body.caseId === "string" && body.caseId.trim()
      ? body.caseId.trim()
      : undefined;

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same REM-id or clobber.
  try {
    const { reminder, version } = await mutate((db) => {
      // RELATIONAL check inside the lock: a linked caseId must reference an existing
      // case. Throws BadRequestError → 400 below (the cases-route precedent).
      if (caseId && !findCase(db, caseId)) {
        throw new BadRequestError(`Case ${caseId} not found for caseId.`);
      }
      // Label-id VALIDITY (∈ catalog) inside the lock, mirroring the cases route.
      // Throws BadRequestError → 400 below. applyReminderUpdate only coerces, so this
      // must run BEFORE we feed labels through it.
      if ("labels" in body) assertKnownLabels(db, body.labels);
      const now = new Date().toISOString();
      const status: ReminderStatus =
        "status" in body && body.status != null ? (body.status as ReminderStatus) : "open";
      const rec: Reminder = {
        id: nextReminderId(db),
        title: String(body.title).trim(),
        detail: body.detail ? String(body.detail) : undefined,
        status,
        caseId,
        dueAt: "dueAt" in body && body.dueAt != null ? String(body.dueAt) : undefined,
        domain: "domain" in body && body.domain != null ? (body.domain as CaseDomain) : undefined,
        createdAt: now,
        updatedAt: now,
        completedAt: status === "done" ? now : undefined,
      };
      // Coerce labels/tasks through the SAME chokepoint a PATCH uses (dedupe/trim
      // labels; mint REM-<n>-T<k> task ids off the fresh record). Only invoke when
      // one is present so we don't touch updatedAt or the absent optionals otherwise.
      if ("labels" in body || "tasks" in body) {
        const patch: Record<string, unknown> = {};
        if ("labels" in body) patch.labels = body.labels;
        if ("tasks" in body) patch.tasks = body.tasks;
        applyReminderUpdate(rec, patch);
        rec.updatedAt = now; // keep create's single timestamp (applyReminderUpdate restamps)
      }
      if (!db.reminders) db.reminders = [];
      db.reminders.push(rec);

      // Best-effort case audit trail (mirrors event_linked): note the link on the
      // case + bump its updatedAt. Guarded so a missing case never breaks the write.
      if (rec.caseId) {
        const linked = findCase(db, rec.caseId);
        if (linked) {
          logActivity(linked, actor, "reminder_linked", rec.title);
          linked.updatedAt = now;
        }
      }
      return { reminder: rec, version: db.version };
    });
    return NextResponse.json({ reminder, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
