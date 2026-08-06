import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findShoppingItem,
  applyShoppingItemUpdate,
  removeShoppingItem,
  NotFoundError,
  VersionConflictError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { VALID_SHOPPING_CATEGORY, VALID_SHOPPING_STATUS, VALID_SHOPPING_SOURCE } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/shopping/[id] — UNGATED (a disabled add-on's data stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const item = findShoppingItem(db, id);
  if (!item) {
    return NextResponse.json({ error: `Shopping item ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ item, version: db.version });
}

// PATCH /api/nutrition/shopping/[id] — partial update of any shopping field via
// applyShoppingItemUpdate (present-keys-only) — flipping `status` to "bought" stamps
// `boughtAt`, any other status clears it. Optional optimistic-concurrency guard:
// body.expectedVersion ≠ db.version → 409. GATED: asserts the add-on is enabled inside the
// lock (disabled → NotFoundError → 404 via storeErrorToResponse).
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
  if ("category" in body && body.category != null && !VALID_SHOPPING_CATEGORY.includes(body.category)) {
    return NextResponse.json(
      { error: `'category' must be one of: ${VALID_SHOPPING_CATEGORY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("status" in body && body.status != null && !VALID_SHOPPING_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_SHOPPING_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("source" in body && body.source != null && !VALID_SHOPPING_SOURCE.includes(body.source)) {
    return NextResponse.json(
      { error: `'source' must be one of: ${VALID_SHOPPING_SOURCE.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). A shopping item links to no
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
      const rec = findShoppingItem(db, id);
      if (!rec) throw new NotFoundError(`Shopping item ${id} not found`);
      applyShoppingItemUpdate(rec, body);
      return { item: rec, version: db.version };
    });
    return NextResponse.json({ item, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/shopping/[id] — hard-remove the item (shopping items have no
// soft-archive; a dangling `sourceRef` pointing AT the removed row elsewhere is TOLERATED).
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
      const rec = findShoppingItem(db, id);
      if (!rec) throw new NotFoundError(`Shopping item ${id} not found`);
      removeShoppingItem(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
