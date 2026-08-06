import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, nextShoppingItemId } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_SHOPPING_CATEGORY,
  VALID_SHOPPING_STATUS,
  VALID_SHOPPING_SOURCE,
  type ShoppingItem,
  type ShoppingCategory,
  type ShoppingStatus,
  type ShoppingSource,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/nutrition/shopping?status=&category= — default returns ALL rows; `status`/
// `category` narrow to an exact enum match. READS ARE UNGATED: a disabled add-on's data
// stays viewable.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status")?.trim() || undefined;
  const category = sp.get("category")?.trim() || undefined;

  const db = await readDB();

  let items = db.shoppingItems ?? [];
  if (status) items = items.filter((x) => x.status === status);
  if (category) items = items.filter((x) => x.category === category);

  return NextResponse.json({ items, version: db.version });
}

// POST /api/nutrition/shopping — add a shopping item. Only `name` is required; defaults
// `status: "needed"`, `source: "manual"`. `sourceRef` is a SOFT ref — never validated
// relationally, exactly like MealPlanEntry.pantryItemIds. If created directly with
// `status: "bought"`, `boughtAt` is stamped (same rule as applyShoppingItemUpdate). GATED:
// the write asserts the add-on is enabled inside the lock (disabled → 404).
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
  if ("category" in body && body.category != null && !VALID_SHOPPING_CATEGORY.includes(body.category)) {
    return NextResponse.json(
      { error: `'category' must be one of: ${VALID_SHOPPING_CATEGORY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("status" in body && body.status != null && !VALID_SHOPPING_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_SHOPPING_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("source" in body && body.source != null && !VALID_SHOPPING_SOURCE.includes(body.source)) {
    return NextResponse.json(
      { error: `'source' must be one of: ${VALID_SHOPPING_SOURCE.join(", ")}.` },
      { status: 400 }
    );
  }

  // Resolve actor for write attribution (agent vs human via header/body). A shopping item
  // links to no case, so there is no case-activity audit trail to stamp — but we resolve
  // it for parity with the other write routes (and to honor the agent flag).
  resolveActor(req, body);

  // Read-modify-write inside the lock: the add-on gate + id generation + insert are one
  // critical section, so concurrent creates can't mint the same SHOP-id or clobber.
  try {
    const { item, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const now = new Date().toISOString();
      const status: ShoppingStatus = "status" in body && body.status != null ? (body.status as ShoppingStatus) : "needed";
      const rec: ShoppingItem = {
        id: nextShoppingItemId(db),
        name: String(body.name).trim(),
        category:
          "category" in body && body.category != null ? (body.category as ShoppingCategory) : undefined,
        quantity:
          typeof body.quantity === "number" && Number.isFinite(body.quantity) ? body.quantity : undefined,
        unit: body.unit ? String(body.unit) : undefined,
        status,
        source: "source" in body && body.source != null ? (body.source as ShoppingSource) : "manual",
        sourceRef: body.sourceRef ? String(body.sourceRef) : undefined,
        note: body.note ? String(body.note) : undefined,
        boughtAt: status === "bought" ? now : undefined,
        createdAt: now,
        updatedAt: now,
      };
      if (!db.shoppingItems) db.shoppingItems = [];
      db.shoppingItems.push(rec);
      return { item: rec, version: db.version };
    });
    return NextResponse.json({ item, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
