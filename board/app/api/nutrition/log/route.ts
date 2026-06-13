import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, nextFoodLogId } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_MEAL_SLOT,
  VALID_HEALTH_RATING,
  type FoodLogEntry,
  type MealSlot,
  type HealthRating,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Calendar-day ("YYYY-MM-DD") shape guard — pure string shape, like the events route.
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// GET /api/nutrition/log?from=&to=&slot=&date= — default returns ALL food-log entries.
// `from`/`to` filter on e.date by string compare (ISO days sort lexically), the
// half-open interval [from, to). `slot`/`date` narrow to an exact slot / day.
// READS ARE UNGATED: a disabled add-on's data stays viewable.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const slot = sp.get("slot")?.trim() || undefined;
  const date = sp.get("date")?.trim() || undefined;

  const db = await readDB();

  let entries = db.foodLogs ?? [];
  if (from) entries = entries.filter((e) => e.date >= from);
  if (to) entries = entries.filter((e) => e.date < to);
  if (slot) entries = entries.filter((e) => e.slot === slot);
  if (date) entries = entries.filter((e) => e.date === date);

  return NextResponse.json({ entries, version: db.version });
}

// POST /api/nutrition/log — log a meal. estimated defaults true; absent optionals are
// omitted from the record. GATED: the write asserts the add-on is enabled inside the
// lock (a disabled add-on → NotFoundError → 404 via storeErrorToResponse).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!isISODate(body.date)) {
    return NextResponse.json({ error: "Field 'date' is required as YYYY-MM-DD." }, { status: 400 });
  }
  if (!VALID_MEAL_SLOT.includes(body.slot)) {
    return NextResponse.json(
      { error: `Field 'slot' is required, one of: ${VALID_MEAL_SLOT.join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.description !== "string" || body.description.trim() === "") {
    return NextResponse.json({ error: "Field 'description' is required." }, { status: 400 });
  }
  if (typeof body.calories !== "number" || !Number.isFinite(body.calories)) {
    return NextResponse.json({ error: "Field 'calories' must be a number." }, { status: 400 });
  }
  if ("health" in body && body.health != null && !VALID_HEALTH_RATING.includes(body.health)) {
    return NextResponse.json(
      { error: `'health' must be one of: ${VALID_HEALTH_RATING.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("estimated" in body && body.estimated != null && typeof body.estimated !== "boolean") {
    return NextResponse.json({ error: "'estimated' must be a boolean." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human via header/body). A food-log
  // entry links to no case, so there is no case-activity audit trail to stamp — but we
  // resolve it for parity with the other write routes (and to honor the agent flag).
  resolveActor(req, body);

  // Read-modify-write inside the lock: the add-on gate + id generation + insert are one
  // critical section, so concurrent creates can't mint the same FOOD-id or clobber.
  try {
    const { entry, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const now = new Date().toISOString();
      const rec: FoodLogEntry = {
        id: nextFoodLogId(db),
        date: body.date as string,
        slot: body.slot as MealSlot,
        description: String(body.description).trim(),
        items:
          "items" in body && Array.isArray(body.items) ? body.items.map(String) : undefined,
        calories: body.calories as number,
        protein:
          typeof body.protein === "number" && Number.isFinite(body.protein) ? body.protein : undefined,
        carbs:
          typeof body.carbs === "number" && Number.isFinite(body.carbs) ? body.carbs : undefined,
        fat: typeof body.fat === "number" && Number.isFinite(body.fat) ? body.fat : undefined,
        health:
          "health" in body && body.health != null ? (body.health as HealthRating) : undefined,
        estimated: "estimated" in body && body.estimated != null ? Boolean(body.estimated) : true,
        note: body.note ? String(body.note) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      if (!db.foodLogs) db.foodLogs = [];
      db.foodLogs.push(rec);
      return { entry: rec, version: db.version };
    });
    return NextResponse.json({ entry, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
