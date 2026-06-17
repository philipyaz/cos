import { NextResponse, type NextRequest } from "next/server";
import { computeFormScore } from "@/lib/fitness-score";
import { readDB } from "@/lib/store";
import { isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/fitness/form-score?date=YYYY-MM-DD — the daily readiness ("form") score, a thin
// wrapper over computeFormScore (the pure helper that reads the canonical health taxonomy).
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date")?.trim();
  if (!isISODate(date)) {
    return NextResponse.json(
      { error: "Query param 'date' is required as YYYY-MM-DD." },
      { status: 400 },
    );
  }
  const result = await computeFormScore(date);
  // version is attached at the route level (db.version) so views can wire useLiveBoard —
  // additive to the FormScore payload, no change to computeFormScore's signature.
  const db = await readDB();
  return NextResponse.json({ ...result, version: db.version });
}
