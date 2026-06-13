import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findMealPlanEntry,
  findEvent,
  applyMealPlanUpdate,
  removeMealPlanEntry,
  NotFoundError,
  VersionConflictError,
  BadRequestError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { VALID_MEAL_SLOT, VALID_MEAL_PLAN_STATUS } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Calendar-day ("YYYY-MM-DD") shape guard (mirror route.ts).
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// GET /api/nutrition/plan/[id] — UNGATED (a disabled add-on's data stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const entry = findMealPlanEntry(db, id);
  if (!entry) {
    return NextResponse.json({ error: `Meal plan ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ entry, version: db.version });
}

// PATCH /api/nutrition/plan/[id] — partial update of any meal-plan field via
// applyMealPlanUpdate (present-keys-only). pantryItemIds stay SOFT (never validated).
// An eventId, when present + non-empty, must reference an existing event (checked inside
// the lock); eventId:null UNLINKS the calendar link. Optional optimistic-concurrency
// guard: body.expectedVersion ≠ db.version → 409. GATED: asserts the add-on is enabled
// inside the lock (disabled → NotFoundError → 404 via storeErrorToResponse).
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
  if ("date" in body && !isISODate(body.date)) {
    return NextResponse.json({ error: "'date' must be YYYY-MM-DD." }, { status: 400 });
  }
  if ("slot" in body && !VALID_MEAL_SLOT.includes(body.slot)) {
    return NextResponse.json(
      { error: `'slot' must be one of: ${VALID_MEAL_SLOT.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("title" in body && (typeof body.title !== "string" || body.title.trim() === "")) {
    return NextResponse.json({ error: "'title' must be a non-empty string." }, { status: 400 });
  }
  if ("servings" in body && body.servings != null && (typeof body.servings !== "number" || !Number.isFinite(body.servings))) {
    return NextResponse.json({ error: "'servings' must be a number." }, { status: 400 });
  }
  if ("status" in body && !VALID_MEAL_PLAN_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_MEAL_PLAN_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  // eventId may be a string (relink, validated in the lock) or null (UNLINK).
  if ("eventId" in body && body.eventId != null && typeof body.eventId !== "string") {
    return NextResponse.json({ error: "'eventId' must be a string or null." }, { status: 400 });
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). A meal-plan entry links to no
  // case, so there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
  // A present, non-empty eventId is a relink to validate; null/"" is an UNLINK (let
  // applyMealPlanUpdate clear it — no relational check needed to drop a link).
  const relinkEventId: string | undefined =
    "eventId" in body && typeof body.eventId === "string" && body.eventId.trim()
      ? body.eventId.trim()
      : undefined;

  // find + gate + relational-check + update + write as one critical section (closes the
  // TOCTOU).
  try {
    const { entry, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findMealPlanEntry(db, id);
      if (!rec) throw new NotFoundError(`Meal plan ${id} not found`);
      // RELATIONAL check inside the lock: a relinked eventId must reference an existing
      // event. Throws BadRequestError → 400 (the events-route precedent).
      if (relinkEventId && !findEvent(db, relinkEventId)) {
        throw new BadRequestError(`Event ${relinkEventId} not found for eventId.`);
      }
      applyMealPlanUpdate(rec, body);
      return { entry: rec, version: db.version };
    });
    return NextResponse.json({ entry, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/plan/[id] — hard-remove the entry (meal-plan entries have no
// soft-archive). GATED: asserts the add-on is enabled inside the lock (disabled → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findMealPlanEntry(db, id);
      if (!rec) throw new NotFoundError(`Meal plan ${id} not found`);
      removeMealPlanEntry(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
