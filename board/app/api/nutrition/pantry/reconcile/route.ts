import { NextResponse, type NextRequest } from "next/server";
import { mutate, nextPantryItemId, applyPantryUpdate } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import {
  VALID_PANTRY_CATEGORY,
  VALID_PANTRY_LOCATION,
  type PantryItem,
  type PantryCategory,
  type PantryLocation,
} from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import { normalizePantryName } from "@/lib/nutrition-format";

export const dynamic = "force-dynamic";

interface ReconcileSkip {
  name: string;
  reason: string;
}

// POST /api/nutrition/pantry/reconcile — apply a WHOLE shop or photo extraction as ONE gated
// write: `items` upsert by a NORMALISED name (trim/casefold/accent-strip/trailing-plural — see
// normalizePantryName), so a re-shop UPDATES the existing row instead of minting a duplicate.
// This route NEVER deletes (removal stays the explicit DELETE /api/nutrition/pantry/{id} path)
// and FAILS CLOSED: every item is validated before mutate() ever runs, so a malformed item in a
// 25-item batch rejects the whole batch rather than landing the good 24 and silently dropping one.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Field 'items' must be a non-empty array." }, { status: 400 });
  }

  // Validate EVERY item before mutate() is ever entered — a 400 must never land a partial
  // write, and an empty/all-bad batch must never bump db.version for a no-op.
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (!it || typeof it !== "object") {
      return NextResponse.json({ error: `Item ${i}: must be an object.` }, { status: 400 });
    }
    if (typeof it.name !== "string" || it.name.trim() === "") {
      return NextResponse.json({ error: `Item ${i}: field 'name' is required.` }, { status: 400 });
    }
    if ("quantity" in it && it.quantity != null && (typeof it.quantity !== "number" || !Number.isFinite(it.quantity))) {
      return NextResponse.json({ error: `Item ${i}: 'quantity' must be a number.` }, { status: 400 });
    }
    if ("unit" in it && it.unit != null && typeof it.unit !== "string") {
      return NextResponse.json({ error: `Item ${i}: 'unit' must be a string.` }, { status: 400 });
    }
    if ("category" in it && it.category != null && !VALID_PANTRY_CATEGORY.includes(it.category)) {
      return NextResponse.json(
        { error: `Item ${i}: 'category' must be one of: ${VALID_PANTRY_CATEGORY.join(", ")}.` },
        { status: 400 },
      );
    }
    if ("location" in it && it.location != null && !VALID_PANTRY_LOCATION.includes(it.location)) {
      return NextResponse.json(
        { error: `Item ${i}: 'location' must be one of: ${VALID_PANTRY_LOCATION.join(", ")}.` },
        { status: 400 },
      );
    }
    if ("expiresAt" in it && it.expiresAt != null && !isISODate(it.expiresAt)) {
      return NextResponse.json({ error: `Item ${i}: 'expiresAt' must be YYYY-MM-DD.` }, { status: 400 });
    }
  }

  resolveActor(req, body);

  try {
    const { added, updated, skipped, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      if (!db.pantryItems) db.pantryItems = [];
      const pantryItems = db.pantryItems;

      // First existing row per normalised key wins (array order) — when a live duplicate
      // already has two rows sharing a key, reconcile only ever touches the older one; the
      // second is left for the agent to merge by hand (this route mints no NEW duplicates).
      const existingByKey = new Map<string, PantryItem>();
      for (const existing of pantryItems) {
        const key = normalizePantryName(existing.name);
        if (!existingByKey.has(key)) existingByKey.set(key, existing);
      }

      const added: PantryItem[] = [];
      const updated: PantryItem[] = [];
      const skipped: ReconcileSkip[] = [];
      const consumed = new Set<string>();
      const now = new Date().toISOString();

      for (const it of body.items as Record<string, unknown>[]) {
        const name = String(it.name).trim();
        const key = normalizePantryName(name);

        // A second submitted item mapping to a key already handled THIS batch (whether that
        // key pre-existed or was just added) is a receipt repeat — skip it, don't touch twice.
        if (consumed.has(key)) {
          skipped.push({ name, reason: "duplicate-in-batch" });
          continue;
        }
        consumed.add(key);

        const existing = existingByKey.get(key);
        if (existing) {
          // Only the SUBMITTED fields move. `name` is deliberately never in this patch (it was
          // only the match key — no churn); `lowStock`/`note` aren't part of the reconcile
          // payload at all. A name-only resubmit still bumps `updatedAt` via applyPantryUpdate —
          // that bump IS the "re-verified the fridge" freshness signal.
          const patch: Record<string, unknown> = {};
          if ("quantity" in it) patch.quantity = it.quantity;
          if ("unit" in it) patch.unit = it.unit;
          if ("category" in it) patch.category = it.category;
          if ("location" in it) patch.location = it.location;
          if ("expiresAt" in it) patch.expiresAt = it.expiresAt;
          applyPantryUpdate(existing, patch);
          updated.push(existing);
        } else {
          const rec: PantryItem = {
            id: nextPantryItemId(db),
            name,
            quantity: typeof it.quantity === "number" && Number.isFinite(it.quantity) ? it.quantity : undefined,
            unit: typeof it.unit === "string" ? it.unit : undefined,
            category: it.category != null ? (it.category as PantryCategory) : undefined,
            location: it.location != null ? (it.location as PantryLocation) : undefined,
            expiresAt: typeof it.expiresAt === "string" ? it.expiresAt : undefined,
            createdAt: now,
            updatedAt: now,
          };
          pantryItems.push(rec); // pushed immediately — nextPantryItemId is a max-scan (see store.ts)
          added.push(rec);
        }
      }

      return { added, updated, skipped, version: db.version };
    });

    return NextResponse.json({ added, updated, skipped, version }, { status: 200 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
