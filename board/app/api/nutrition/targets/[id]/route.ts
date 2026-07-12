import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  findNutritionTarget,
  applyNutritionTargetUpdate,
  removeNutritionTarget,
  NotFoundError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/targets/[id] — UNGATED.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await readDB();
  const artifact = findNutritionTarget(db, id);
  if (!artifact) return NextResponse.json({ error: `Nutrition target ${id} not found` }, { status: 404 });
  return NextResponse.json({ artifact, version: db.version });
}

// PATCH /api/nutrition/targets/[id] — present-keys update of an agent-authored target (payload /
// source / generatedAt). Identity (id, createdAt, kind, periodKey) is never changed. GATED.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  resolveActor(req, body);
  try {
    const { artifact, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findNutritionTarget(db, id);
      if (!rec) throw new NotFoundError(`Nutrition target ${id} not found`);
      return { artifact: applyNutritionTargetUpdate(rec, body), version: db.version };
    });
    return NextResponse.json({ artifact, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/nutrition/targets/[id] — hard-remove the artifact. GATED.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  resolveActor(req, null);
  try {
    const version = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const rec = findNutritionTarget(db, id);
      if (!rec) throw new NotFoundError(`Nutrition target ${id} not found`);
      removeNutritionTarget(db, id);
      return db.version;
    });
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
