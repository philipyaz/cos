import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, nextPantryItemId } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_PANTRY_CATEGORY,
  VALID_PANTRY_LOCATION,
  type PantryItem,
  type PantryCategory,
  type PantryLocation,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/pantry?category=&location=&expiringBefore=&lowStock=true — default
// returns ALL pantry items. `category`/`location` narrow to a food category / storage
// location. `expiringBefore` keeps items whose expiresAt < the given day (string compare:
// ISO days sort lexically; items with no expiresAt are excluded). `lowStock=true` keeps
// only items flagged running-low. READS ARE UNGATED: a disabled add-on's data stays viewable.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const category = sp.get("category")?.trim() || undefined;
  const location = sp.get("location")?.trim() || undefined;
  const expiringBefore = sp.get("expiringBefore")?.trim() || undefined;
  const lowStock = sp.get("lowStock")?.trim() === "true";

  const db = await readDB();

  let items = db.pantryItems ?? [];
  if (category) items = items.filter((x) => x.category === category);
  if (location) items = items.filter((x) => x.location === location);
  if (expiringBefore) items = items.filter((x) => x.expiresAt != null && x.expiresAt < expiringBefore);
  if (lowStock) items = items.filter((x) => x.lowStock === true);

  return NextResponse.json({ items, version: db.version });
}

// POST /api/nutrition/pantry — add a pantry item. Only `name` is required; absent
// optionals are omitted from the record. GATED: the write asserts the add-on is enabled
// inside the lock (a disabled add-on → NotFoundError → 404 via storeErrorToResponse).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json({ error: "Field 'name' is required." }, { status: 400 });
  }
  if ("quantity" in body && body.quantity != null && (typeof body.quantity !== "number" || !Number.isFinite(body.quantity))) {
    return NextResponse.json({ error: "'quantity' must be a number." }, { status: 400 });
  }
  if ("category" in body && body.category != null && !VALID_PANTRY_CATEGORY.includes(body.category)) {
    return NextResponse.json(
      { error: `'category' must be one of: ${VALID_PANTRY_CATEGORY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("location" in body && body.location != null && !VALID_PANTRY_LOCATION.includes(body.location)) {
    return NextResponse.json(
      { error: `'location' must be one of: ${VALID_PANTRY_LOCATION.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("expiresAt" in body && body.expiresAt != null && !isISODate(body.expiresAt)) {
    return NextResponse.json({ error: "'expiresAt' must be YYYY-MM-DD." }, { status: 400 });
  }
  if ("lowStock" in body && body.lowStock != null && typeof body.lowStock !== "boolean") {
    return NextResponse.json({ error: "'lowStock' must be a boolean." }, { status: 400 });
  }

  // Resolve actor for write attribution (agent vs human via header/body). A pantry item
  // links to no case, so there is no case-activity audit trail to stamp — but we resolve
  // it for parity with the other write routes (and to honor the agent flag).
  resolveActor(req, body);

  // Read-modify-write inside the lock: the add-on gate + id generation + insert are one
  // critical section, so concurrent creates can't mint the same PANTRY-id or clobber.
  try {
    const { item, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const now = new Date().toISOString();
      const rec: PantryItem = {
        id: nextPantryItemId(db),
        name: String(body.name).trim(),
        quantity:
          typeof body.quantity === "number" && Number.isFinite(body.quantity) ? body.quantity : undefined,
        unit: body.unit ? String(body.unit) : undefined,
        category:
          "category" in body && body.category != null ? (body.category as PantryCategory) : undefined,
        location:
          "location" in body && body.location != null ? (body.location as PantryLocation) : undefined,
        expiresAt: isISODate(body.expiresAt) ? body.expiresAt : undefined,
        lowStock: "lowStock" in body && body.lowStock != null ? Boolean(body.lowStock) : undefined,
        note: body.note ? String(body.note) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      if (!db.pantryItems) db.pantryItems = [];
      db.pantryItems.push(rec);
      return { item: rec, version: db.version };
    });
    return NextResponse.json({ item, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
