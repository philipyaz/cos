import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, nextMealPlanId, findEvent, BadRequestError } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_MEAL_SLOT,
  VALID_MEAL_PLAN_STATUS,
  type MealPlanEntry,
  type MealSlot,
  type MealPlanStatus,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/plan?from=&to=&slot=&status= — default returns ALL meal-plan entries.
// `from`/`to` filter on e.date by string compare (ISO days sort lexically), the
// half-open interval [from, to). `slot`/`status` narrow to an exact slot / status.
// READS ARE UNGATED: a disabled add-on's data stays viewable.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const slot = sp.get("slot")?.trim() || undefined;
  const status = sp.get("status")?.trim() || undefined;

  const db = await readDB();

  let entries = db.mealPlanEntries ?? [];
  if (from) entries = entries.filter((e) => e.date >= from);
  if (to) entries = entries.filter((e) => e.date < to);
  if (slot) entries = entries.filter((e) => e.slot === slot);
  if (status) entries = entries.filter((e) => e.status === status);

  return NextResponse.json({ entries, version: db.version });
}

// POST /api/nutrition/plan — plan a meal. status defaults "planned"; absent optionals are
// omitted from the record. pantryItemIds are SOFT refs (stored as-is, never validated).
// A non-empty eventId, when present, must reference an existing CalendarEvent (checked
// inside the lock). GATED: the write asserts the add-on is enabled inside the lock
// (a disabled add-on → NotFoundError → 404 via storeErrorToResponse).
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
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json({ error: "Field 'title' is required." }, { status: 400 });
  }
  if ("servings" in body && body.servings != null && (typeof body.servings !== "number" || !Number.isFinite(body.servings))) {
    return NextResponse.json({ error: "'servings' must be a number." }, { status: 400 });
  }
  if ("status" in body && body.status != null && !VALID_MEAL_PLAN_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_MEAL_PLAN_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("eventId" in body && body.eventId != null && typeof body.eventId !== "string") {
    return NextResponse.json({ error: "'eventId' must be a string." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human via header/body). A meal-plan
  // entry links to no case, so there is no case-activity audit trail to stamp — but we
  // resolve it for parity with the other write routes (and to honor the agent flag).
  resolveActor(req, body);
  const eventId: string | undefined =
    "eventId" in body && typeof body.eventId === "string" && body.eventId.trim()
      ? body.eventId.trim()
      : undefined;

  // Read-modify-write inside the lock: the add-on gate + relational check + id generation
  // + insert are one critical section, so concurrent creates can't mint the same MEAL-id
  // or clobber.
  try {
    const { entry, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      // RELATIONAL check inside the lock: a linked eventId must reference an existing
      // event. Throws BadRequestError → 400 below (the events-route precedent).
      if (eventId && !findEvent(db, eventId)) {
        throw new BadRequestError(`Event ${eventId} not found for eventId.`);
      }
      const now = new Date().toISOString();
      const rec: MealPlanEntry = {
        id: nextMealPlanId(db),
        date: body.date as string,
        slot: body.slot as MealSlot,
        title: String(body.title).trim(),
        recipe: body.recipe ? String(body.recipe) : undefined,
        ingredients:
          "ingredients" in body && Array.isArray(body.ingredients)
            ? body.ingredients.map(String)
            : undefined,
        servings:
          typeof body.servings === "number" && Number.isFinite(body.servings) ? body.servings : undefined,
        status:
          "status" in body && body.status != null ? (body.status as MealPlanStatus) : "planned",
        // SOFT refs: stored as-is (dangling tolerated, never validated/scrubbed).
        pantryItemIds:
          "pantryItemIds" in body && Array.isArray(body.pantryItemIds)
            ? body.pantryItemIds.map(String)
            : undefined,
        eventId,
        note: body.note ? String(body.note) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      if (!db.mealPlanEntries) db.mealPlanEntries = [];
      db.mealPlanEntries.push(rec);
      return { entry: rec, version: db.version };
    });
    return NextResponse.json({ entry, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
