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
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/body/weight/[id] — UNGATED.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await readDB();
  const entry = findWeight(db, id);
  if (!entry) return NextResponse.json({ error: `Weight entry ${id} not found` }, { status: 404 });
  return NextResponse.json({ entry, version: db.version });
}

const optInRange = (v: unknown, lo: number, hi: number): boolean =>
  v == null || (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi);

// PATCH /api/body/weight/[id] — present-keys-only update (weightKg + the body-comp optionals +
// note + date). A `date` change that collides with another day → 400. GATED on "body".
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if ("date" in body && !isISODate(body.date)) {
    return NextResponse.json({ error: "'date' must be YYYY-MM-DD." }, { status: 400 });
  }
  if ("weightKg" in body && (typeof body.weightKg !== "number" || !Number.isFinite(body.weightKg) || body.weightKg <= 0)) {
    return NextResponse.json({ error: "'weightKg' must be a number greater than 0." }, { status: 400 });
  }
  if (!optInRange(body.bodyFatPct, 3, 60)) return NextResponse.json({ error: "'bodyFatPct' must be 3..60 or null." }, { status: 400 });
  if (!optInRange(body.leanMassKg, 1, 300)) return NextResponse.json({ error: "'leanMassKg' must be a positive number or null." }, { status: 400 });
  if (!optInRange(body.waistCm, 20, 300)) return NextResponse.json({ error: "'waistCm' must be a positive number or null." }, { status: 400 });
  if ("expectedVersion" in body && typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "'expectedVersion' must be a number." }, { status: 400 });
  }

  resolveActor(req, body);
  const expectedVersion: number | undefined = typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

  try {
    const { entry, version } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      const currentVersion = db.version - 1;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(`Version conflict: expected ${expectedVersion}, current ${currentVersion}.`);
      }
      const rec = findWeight(db, id);
      if (!rec) throw new NotFoundError(`Weight entry ${id} not found`);
      if ("date" in body && typeof body.date === "string" && body.date !== rec.date) {
        const clash = findWeightByDate(db, body.date);
        if (clash && clash.id !== rec.id) throw new BadRequestError(`A weight entry already exists for ${body.date}.`);
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

// DELETE /api/body/weight/[id] — hard-remove the weigh-in. GATED on "body".
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  resolveActor(req, null);
  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "body");
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
