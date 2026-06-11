import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findCase,
  findEvent,
  applyEventUpdate,
  removeEvent,
  logActivity,
  NotFoundError,
  VersionConflictError,
  BadRequestError,
} from "@/lib/store";
import { VALID_DOMAIN } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Calendar-day ("YYYY-MM-DD") and 24h time ("HH:MM") shape guards (mirror route.ts).
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHHMM = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const event = findEvent(db, id);
  if (!event) {
    return NextResponse.json({ error: `Event ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ event, version: db.version });
}

// PATCH /api/events/[id] — partial update of any event field incl. relinking via
// caseId (caseId:null/"" clears the link). Optional optimistic-concurrency guard:
// body.expectedVersion ≠ db.version → 409. event.caseId is the link source of truth.
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
  if ("date" in body && !isISODate(body.date)) {
    return NextResponse.json({ error: "'date' must be YYYY-MM-DD." }, { status: 400 });
  }
  if ("allDay" in body && typeof body.allDay !== "boolean") {
    return NextResponse.json({ error: "'allDay' must be a boolean." }, { status: 400 });
  }
  if ("startTime" in body && body.startTime != null && !isHHMM(body.startTime)) {
    return NextResponse.json({ error: "'startTime' must be HH:MM (24h)." }, { status: 400 });
  }
  if ("endTime" in body && body.endTime != null && !isHHMM(body.endTime)) {
    return NextResponse.json({ error: "'endTime' must be HH:MM (24h)." }, { status: 400 });
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

  const actor = resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + update + write as one critical section (closes the read-then-write TOCTOU).
  try {
    const { event, version } = await mutate((db) => {
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findEvent(db, id);
      if (!rec) throw new NotFoundError(`Event ${id} not found`);

      // RELATIONAL check: a non-empty caseId must reference an existing case.
      // Throws BadRequestError → 400 below (the cases-route precedent).
      if ("caseId" in body && typeof body.caseId === "string" && body.caseId.trim()) {
        if (!findCase(db, body.caseId.trim())) {
          throw new BadRequestError(`Case ${body.caseId.trim()} not found for caseId.`);
        }
      }

      // Snapshot the old link BEFORE the patch so we can audit a relink on both sides.
      const prevCaseId = rec.caseId;
      applyEventUpdate(rec, body);
      const now = rec.updatedAt;

      // Best-effort case audit trail (mirrors message_linked/unlinked). Guarded so a
      // missing case never breaks the event write.
      if (prevCaseId !== rec.caseId) {
        if (prevCaseId) {
          const prev = findCase(db, prevCaseId);
          if (prev) {
            logActivity(prev, actor, "event_unlinked", rec.title);
            prev.updatedAt = now;
          }
        }
        if (rec.caseId) {
          const next = findCase(db, rec.caseId);
          if (next) {
            logActivity(next, actor, "event_linked", rec.title);
            next.updatedAt = now;
          }
        }
      } else if (rec.caseId) {
        const linked = findCase(db, rec.caseId);
        if (linked) {
          logActivity(linked, actor, "event_updated", rec.title);
          linked.updatedAt = now;
        }
      }
      return { event: rec, version: db.version };
    });
    return NextResponse.json({ event, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/events/[id] — hard-remove the event (events have no soft-archive).
// Best-effort logs "event_unlinked" on the case it was linked to.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const actor = resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      const rec = findEvent(db, id);
      if (!rec) throw new NotFoundError(`Event ${id} not found`);
      const caseId = rec.caseId;
      const title = rec.title;
      removeEvent(db, id);

      // Best-effort case audit trail (mirrors message_unlinked). Guarded so a
      // missing case never breaks the delete.
      if (caseId) {
        const linked = findCase(db, caseId);
        if (linked) {
          logActivity(linked, actor, "event_unlinked", title);
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
