import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, upsertWeight } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
// LB_TO_KG (the exact 1 lb = 0.45359237 kg factor) is single-sourced in lib/nutrition-format;
// the route converts at its boundary so the store NEVER sees a pound (storage is always kg).
import { LB_TO_KG } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// GET /api/nutrition/weight?from=&to= — default returns ALL weigh-ins sorted ASCENDING by
// date. `from`/`to` filter on e.date by string compare (ISO days sort lexically), the
// half-open interval [from, to). READS ARE UNGATED: a disabled add-on's data stays viewable.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;

  const db = await readDB();

  let weights = db.weights ?? [];
  if (from) weights = weights.filter((w) => w.date >= from);
  if (to) weights = weights.filter((w) => w.date < to);
  // ISO days sort lexically, so a plain string compare yields ascending-by-date.
  weights = [...weights].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return NextResponse.json({ weights, version: db.version });
}

// POST /api/nutrition/weight — the single ADD-OR-UPDATE endpoint: UPSERT BY DAY. A weigh-in
// is unique per calendar day, so re-posting the same date updates that day's entry in place
// (keeping its id + createdAt) rather than appending a duplicate. Exactly one of weightKg /
// weightLb is required; a pound value is converted to kg HERE (the store stores canonical kg
// only). GATED: the write asserts the add-on is enabled inside the lock (a disabled add-on →
// NotFoundError → 404 via storeErrorToResponse). Returns 201 when created, 200 when updated.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!isISODate(body.date)) {
    return NextResponse.json({ error: "Field 'date' is required as YYYY-MM-DD." }, { status: 400 });
  }
  // Accept weightKg directly, OR weightLb (converted to kg below). Exactly one must be a
  // finite positive number — validated outside the lock for a fast 400.
  const hasKg = typeof body.weightKg === "number" && Number.isFinite(body.weightKg);
  const hasLb = typeof body.weightLb === "number" && Number.isFinite(body.weightLb);
  if (hasKg === hasLb) {
    return NextResponse.json(
      { error: "Provide exactly one of 'weightKg' or 'weightLb' as a number." },
      { status: 400 }
    );
  }
  // Resolve to canonical kg at the boundary (the store stores kg only).
  const weightKg = hasKg ? (body.weightKg as number) : (body.weightLb as number) * LB_TO_KG;
  if (!(weightKg > 0)) {
    return NextResponse.json({ error: "Weight must be greater than 0." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human via header/body). A weigh-in links
  // to no case, so there is no case-activity audit trail to stamp — but we resolve it for
  // parity with the other write routes (and to honor the agent flag).
  resolveActor(req, body);

  // Read-modify-write inside the lock: the add-on gate + upsert-by-day are one critical
  // section, so concurrent writes for the same day can't both append (the day is unique).
  try {
    const { entry, version, created } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const { entry, created } = upsertWeight(db, {
        date: body.date as string,
        weightKg,
        note: body.note != null ? String(body.note) : undefined,
      });
      return { entry, version: db.version, created };
    });
    return NextResponse.json({ entry, version, created }, { status: created ? 201 : 200 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
