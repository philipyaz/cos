import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, getDietProfile, setDietProfile, applyDietProfilePatch } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";
import { DEFAULT_DIET_PHILOSOPHY } from "@/lib/diet-philosophy-default";
import type { DietProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

// The EFFECTIVE profile a reader gets: the stored record with the DEFAULT diet-views philosophy
// injected whenever `philosophy` is "" / never-set. The default is NOT persisted (so "cleared" stays
// distinguishable from "never set" in the store); it is injected at read time only.
function effective(profile: DietProfile | undefined): DietProfile {
  if (!profile) {
    return { allergies: [], dietType: [], notes: "", philosophy: DEFAULT_DIET_PHILOSOPHY, createdAt: "", updatedAt: "" };
  }
  return { ...profile, philosophy: profile.philosophy === "" ? DEFAULT_DIET_PHILOSOPHY : profile.philosophy };
}

// GET /api/nutrition/diet-profile — the ONE dietary endpoint (allergies/dietType/notes + the
// "our views on diet" philosophy). UNGATED. The agent reads this FIRST before planning/logging
// (allergies are honored by the SKILLS, not enforced by the component).
export async function GET() {
  const db = await readDB();
  return NextResponse.json({ profile: effective(getDietProfile(db)), version: db.version });
}

// PUT /api/nutrition/diet-profile — FULL REPLACE (the UI Save). Lists are coerced/trimmed/deduped,
// notes/philosophy capped, by the store helper. GATED on "nutrition".
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  resolveActor(req, body);
  try {
    const { profile, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      return {
        profile: setDietProfile(db, {
          allergies: body.allergies,
          dietType: body.dietType,
          notes: body.notes,
          philosophy: body.philosophy,
        }),
        version: db.version,
      };
    });
    return NextResponse.json({ profile: effective(profile), version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// PATCH /api/nutrition/diet-profile — present-keys MERGE (the MCP set_diet_profile path: send only
// the changed field(s)). A list field is whole-array replace (never element-merge → can't silently
// drop an allergen). Creates the record on first PATCH if none exists. GATED on "nutrition".
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  resolveActor(req, body);
  try {
    const { profile, version } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const existing = getDietProfile(db);
      // First-PATCH-creates: seed an empty record, then merge the present keys.
      const rec = existing ?? setDietProfile(db, {});
      return { profile: applyDietProfilePatch(rec, body), version: db.version };
    });
    return NextResponse.json({ profile: effective(profile), version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
