import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findFoodLog,
  applyFoodLogUpdate,
  removeFoodLog,
  NotFoundError,
  VersionConflictError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { VALID_MEAL_SLOT, VALID_HEALTH_RATING } from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/log/[id] — UNGATED (a disabled add-on's data stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const entry = findFoodLog(db, id);
  if (!entry) {
    return NextResponse.json({ error: `Food log ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ entry, version: db.version });
}

// PATCH /api/nutrition/log/[id] — partial update of any food-log field via
// applyFoodLogUpdate (present-keys-only). Optional optimistic-concurrency guard:
// body.expectedVersion ≠ db.version → 409. GATED: asserts the add-on is enabled
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
  if ("description" in body && (typeof body.description !== "string" || body.description.trim() === "")) {
    return NextResponse.json({ error: "'description' must be a non-empty string." }, { status: 400 });
  }
  if ("calories" in body && (typeof body.calories !== "number" || !Number.isFinite(body.calories))) {
    return NextResponse.json({ error: "'calories' must be a number." }, { status: 400 });
  }
  if ("health" in body && body.health != null && !VALID_HEALTH_RATING.includes(body.health)) {
    return NextResponse.json(
      { error: `'health' must be one of: ${VALID_HEALTH_RATING.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). A food-log entry links to no
  // case, so there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + gate + update + write as one critical section (closes the TOCTOU).
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
      const rec = findFoodLog(db, id);
      if (!rec) throw new NotFoundError(`Food log ${id} not found`);
      applyFoodLogUpdate(rec, body);
      return { entry: rec, version: db.version };
    });
    return NextResponse.json({ entry, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/log/[id] — hard-remove the entry (food logs have no soft-archive).
// GATED: asserts the add-on is enabled inside the lock (disabled → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findFoodLog(db, id);
      if (!rec) throw new NotFoundError(`Food log ${id} not found`);
      removeFoodLog(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
