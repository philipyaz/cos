import { NextResponse, type NextRequest } from "next/server";
import { readDB } from "@/lib/store";
import { computeShoppingCandidates } from "@/lib/shopping-candidates";
import { toISODay, addDays } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

// GET /api/nutrition/shopping/candidates?from=&to= — the computed shopping-candidates read
// (never stored). Mirrors /api/nutrition/status: force-dynamic, no mutate() anywhere, the
// clock is read HERE ONCE and passed into the pure engine. UNGATED (a read — works with the
// add-on disabled and on a spoke). Defaults `from` to today, `to` to today+6 (the coming
// week) — both use the vertical's single noon-anchored addDays, never a second implementation.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const today = toISODay(new Date());
  const from = sp.get("from")?.trim() || today;
  const to = sp.get("to")?.trim() || addDays(today, 6);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "'from'/'to' must be YYYY-MM-DD." }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "'from' must not be after 'to'." }, { status: 400 });
  }

  const db = await readDB();
  const result = computeShoppingCandidates({
    mealPlanEntries: db.mealPlanEntries ?? [],
    foodLogs: db.foodLogs ?? [],
    pantryItems: db.pantryItems ?? [],
    nutritionTargets: db.nutritionTargets ?? [],
    shoppingItems: db.shoppingItems ?? [],
    from,
    to,
    today,
  });
  return NextResponse.json({ ...result, today, version: db.version });
}
