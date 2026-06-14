import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findPantryItem,
  applyPantryUpdate,
  removePantryItem,
  NotFoundError,
  VersionConflictError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { VALID_PANTRY_CATEGORY, VALID_PANTRY_LOCATION } from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/pantry/[id] — UNGATED (a disabled add-on's data stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const item = findPantryItem(db, id);
  if (!item) {
    return NextResponse.json({ error: `Pantry item ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ item, version: db.version });
}

// PATCH /api/nutrition/pantry/[id] — partial update of any pantry field via
// applyPantryUpdate (present-keys-only). Optional optimistic-concurrency guard:
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
  if ("name" in body && (typeof body.name !== "string" || body.name.trim() === "")) {
    return NextResponse.json({ error: "'name' must be a non-empty string." }, { status: 400 });
  }
  if ("quantity" in body && body.quantity != null && (typeof body.quantity !== "number" || !Number.isFinite(body.quantity))) {
    return NextResponse.json({ error: "'quantity' must be a number." }, { status: 400 });
  }
  if ("category" in body && body.category != null && !VALID_PANTRY_CATEGORY.includes(body.category)) {
    return NextResponse.json(
      { error: `'category' must be one of: ${VALID_PANTRY_CATEGORY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("location" in body && body.location != null && !VALID_PANTRY_LOCATION.includes(body.location)) {
    return NextResponse.json(
      { error: `'location' must be one of: ${VALID_PANTRY_LOCATION.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expiresAt" in body && body.expiresAt != null && !isISODate(body.expiresAt)) {
    return NextResponse.json({ error: "'expiresAt' must be YYYY-MM-DD." }, { status: 400 });
  }
  if ("lowStock" in body && body.lowStock != null && typeof body.lowStock !== "boolean") {
    return NextResponse.json({ error: "'lowStock' must be a boolean." }, { status: 400 });
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). A pantry item links to no
  // case, so there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + gate + update + write as one critical section (closes the TOCTOU).
  try {
    const { item, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      // mutate() bumps db.version up-front, so the client's last-seen version is
      // the pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findPantryItem(db, id);
      if (!rec) throw new NotFoundError(`Pantry item ${id} not found`);
      applyPantryUpdate(rec, body);
      return { item: rec, version: db.version };
    });
    return NextResponse.json({ item, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/pantry/[id] — hard-remove the item (pantry items have no
// soft-archive; a removed item leaves any mealPlanEntry.pantryItemIds soft ref dangling,
// which is TOLERATED). GATED: asserts the add-on is enabled inside the lock (disabled → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findPantryItem(db, id);
      if (!rec) throw new NotFoundError(`Pantry item ${id} not found`);
      removePantryItem(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
