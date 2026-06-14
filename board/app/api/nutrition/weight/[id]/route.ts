import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findWeight,
  findWeightByDate,
  applyWeightUpdate,
  removeWeight,
  NotFoundError,
  VersionConflictError,
  BadRequestError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Calendar-day ("YYYY-MM-DD") shape guard (mirror route.ts).
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// GET /api/nutrition/weight/[id] — UNGATED (a disabled add-on's data stays viewable).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await readDB();
  const entry = findWeight(db, id);
  if (!entry) {
    return NextResponse.json({ error: `Weight entry ${id} not found` }, { status: 404 });
  }
  return NextResponse.json({ entry, version: db.version });
}

// PATCH /api/nutrition/weight/[id] — partial update of a weigh-in via applyWeightUpdate
// (present-keys-only). A `date` change can collide with ANOTHER day's entry; the store does
// NOT enforce day-uniqueness on patch, so the ROUTE checks it inside the lock (a collision
// throws BadRequestError → 400). Optional optimistic-concurrency guard: body.expectedVersion
// ≠ db.version → 409. GATED: asserts the add-on is enabled inside the lock (disabled →
// NotFoundError → 404 via storeErrorToResponse).
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
  if ("weightKg" in body && (typeof body.weightKg !== "number" || !Number.isFinite(body.weightKg) || body.weightKg <= 0)) {
    return NextResponse.json({ error: "'weightKg' must be a number greater than 0." }, { status: 400 });
  }
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human). A weigh-in links to no case, so
  // there is no case-activity audit trail to stamp — resolved for parity.
  resolveActor(req, body);
  const expectedVersion: number | undefined =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  // find + gate + day-uniqueness check + update + write as one critical section (closes the
  // TOCTOU on both the version guard and the date-collision check).
  try {
    const { entry, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      // mutate() bumps db.version up-front, so the client's last-seen version is the
      // pre-bump baseline (db.version - 1).
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(
          `Version conflict: expected ${expectedVersion}, current ${currentVersion}.`
        );
      }
      const rec = findWeight(db, id);
      if (!rec) throw new NotFoundError(`Weight entry ${id} not found`);
      // ROUTE-enforced day-uniqueness: a date change that lands on ANOTHER day's entry is a
      // collision (one weigh-in per day). The store leaves this to us by design.
      if ("date" in body && typeof body.date === "string" && body.date !== rec.date) {
        const clash = findWeightByDate(db, body.date);
        if (clash && clash.id !== rec.id) {
          throw new BadRequestError(`A weight entry already exists for ${body.date}.`);
        }
      }
      applyWeightUpdate(rec, body);
      return { entry: rec, version: db.version };
    });
    return NextResponse.json({ entry, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/weight/[id] — hard-remove the weigh-in (weigh-ins have no
// soft-archive and link to nothing). GATED: asserts the add-on is enabled inside the lock
// (disabled → 404).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  resolveActor(req, null);

  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findWeight(db, id);
      if (!rec) throw new NotFoundError(`Weight entry ${id} not found`);
      removeWeight(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
