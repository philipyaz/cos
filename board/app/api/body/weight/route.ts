import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, upsertWeight } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import { LB_TO_KG } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// An optional body-comp number within [lo, hi], or undefined (absent === not measured). Returns
// the value, or undefined when the field is absent/null; throws a 400-marker string when present
// but out of range. Kept simple: { ok, value? , error? }.
function optInRange(v: unknown, lo: number, hi: number): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
    return { ok: false, error: `must be a number between ${lo} and ${hi}` };
  }
  return { ok: true, value: v };
}

// GET /api/body/weight?from=&to= — the weigh-in + body-composition series, ascending by date.
// `from`/`to` filter the half-open [from, to). UNGATED (frozen-but-readable).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;

  const db = await readDB();
  let weights = db.weights ?? [];
  if (from) weights = weights.filter((w) => w.date >= from);
  if (to) weights = weights.filter((w) => w.date < to);
  weights = [...weights].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return NextResponse.json({ weights, version: db.version });
}

// POST /api/body/weight — UPSERT BY DAY (one weigh-in per calendar day). Exactly one of
// weightKg / weightLb is required (a pound value is converted to canonical kg here). Optionally
// carries body-composition: bodyFatPct (3..60) / leanMassKg (>0) / waistCm (>0). GATED on "body".
// Returns 201 created / 200 updated.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!isISODate(body.date)) {
    return NextResponse.json({ error: "Field 'date' is required as YYYY-MM-DD." }, { status: 400 });
  }
  const hasKg = typeof body.weightKg === "number" && Number.isFinite(body.weightKg);
  const hasLb = typeof body.weightLb === "number" && Number.isFinite(body.weightLb);
  if (hasKg === hasLb) {
    return NextResponse.json({ error: "Provide exactly one of 'weightKg' or 'weightLb' as a number." }, { status: 400 });
  }
  const weightKg = hasKg ? (body.weightKg as number) : (body.weightLb as number) * LB_TO_KG;
  if (!(weightKg > 0)) {
    return NextResponse.json({ error: "Weight must be greater than 0." }, { status: 400 });
  }

  // Optional body-composition fields (range-validated).
  const bf = optInRange(body.bodyFatPct, 3, 60);
  if (!bf.ok) return NextResponse.json({ error: `'bodyFatPct' ${bf.error}.` }, { status: 400 });
  const lean = optInRange(body.leanMassKg, 1, 300);
  if (!lean.ok) return NextResponse.json({ error: `'leanMassKg' ${lean.error}.` }, { status: 400 });
  const waist = optInRange(body.waistCm, 20, 300);
  if (!waist.ok) return NextResponse.json({ error: `'waistCm' ${waist.error}.` }, { status: 400 });

  resolveActor(req, body);

  try {
    const { entry, version, created } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      const { entry, created } = upsertWeight(db, {
        date: body.date as string,
        weightKg,
        bodyFatPct: bf.value,
        leanMassKg: lean.value,
        waistCm: waist.value,
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
