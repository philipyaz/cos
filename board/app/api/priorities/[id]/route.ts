import { NextResponse, type NextRequest } from "next/server";
import {
  mutate,
  findPriority,
  applyPriorityUpdate,
  removePriority,
  NotFoundError,
  VersionConflictError,
} from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/priorities/[id] — partial update of a priority note. Only `text`
// (non-empty) and `position` (number, or null to clear) are editable — there is
// no status/link/labels to relink. Optional optimistic-concurrency guard:
// body.expectedVersion ≠ db.version → 409 (mirrors the reminders [id] PATCH).
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
  if ("text" in body && (typeof body.text !== "string" || body.text.trim() === "")) {
    return NextResponse.json({ error: "'text' must be a non-empty string." }, { status: 400 });
  }
  if ("position" in body && body.position != null && typeof body.position !== "number") {
    return NextResponse.json({ error: "'position' must be a number." }, { status: 400 });
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + update + write as one critical section (closes the read-then-write TOCTOU).
  try {
    const { priority, version } = await mutate((db) => {
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findPriority(db, id);
      if (!rec) throw new NotFoundError(`Priority ${id} not found`);
      applyPriorityUpdate(rec, body);
      return { priority: rec, version: db.version };
    });
    return NextResponse.json({ priority, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/priorities/[id] — hard-remove the note (priority notes have no
// soft-archive and no links to clean up).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const version = await mutate((db) => {
      if (!removePriority(db, id)) throw new NotFoundError(`Priority ${id} not found`);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
