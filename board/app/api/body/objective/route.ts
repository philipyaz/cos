import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, getBodyObjective, setBodyObjective, applyBodyObjectivePatch, NotFoundError } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import { VALID_ACTIVITY_LEVEL, type ActivityLevel, type BodyObjective } from "@/lib/types";

export const dynamic = "force-dynamic";

const GOAL_TEXT_CAP = 2000;

// GET /api/body/objective — the body-objective singleton (FREE-TEXT goal + target-weight anchor),
// or { objective: null }. UNGATED.
export async function GET() {
  const db = await readDB();
  return NextResponse.json({ objective: db.bodyObjective ?? null, version: db.version });
}

// Validate the optional anchor fields shared by PUT + PATCH. Returns an error string or null.
function shapeError(body: Record<string, unknown>, requireActivity: boolean): string | null {
  if (requireActivity || "activity" in body) {
    if (!VALID_ACTIVITY_LEVEL.includes(body.activity as ActivityLevel)) {
      return `'activity' must be one of: ${VALID_ACTIVITY_LEVEL.join(", ")}.`;
    }
  }
  if ("targetWeightKg" in body && body.targetWeightKg != null) {
    if (typeof body.targetWeightKg !== "number" || !Number.isFinite(body.targetWeightKg) || body.targetWeightKg <= 0) {
      return "'targetWeightKg' must be a number greater than 0, or null.";
    }
  }
  if ("targetDate" in body && body.targetDate != null && !isISODate(body.targetDate)) {
    return "'targetDate' must be YYYY-MM-DD or null.";
  }
  return null;
}

// PUT /api/body/objective — create-or-replace the objective. The goal is FREE TEXT: `goalText` is
// capped, never required (may be ""); `targetWeightKg` is the one structured anchor (number|null);
// `activity` is required (drawer defaults "moderate"). GATED inside mutate.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const err = shapeError(body, true);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  resolveActor(req, body);
  const input: Omit<BodyObjective, "createdAt" | "updatedAt"> = {
    goalText: typeof body.goalText === "string" ? body.goalText.slice(0, GOAL_TEXT_CAP) : "",
    targetWeightKg: typeof body.targetWeightKg === "number" && body.targetWeightKg > 0 ? body.targetWeightKg : null,
    targetDate: isISODate(body.targetDate) ? body.targetDate : null,
    activity: body.activity as ActivityLevel,
  };

  try {
    const { objective, version } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      return { objective: setBodyObjective(db, input), version: db.version };
    });
    return NextResponse.json({ objective, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// PATCH /api/body/objective — partial update of the EXISTING objective (404 when none set yet).
// goalText is capped here too; targetWeightKg/targetDate accept an explicit null to clear.
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const err = shapeError(body, false);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  resolveActor(req, body);

  // Pre-cap goalText so the store's coercion stores a bounded string.
  const patch: Record<string, unknown> = { ...body };
  if (typeof patch.goalText === "string") patch.goalText = patch.goalText.slice(0, GOAL_TEXT_CAP);

  try {
    const { objective, version } = await mutate((db) => {
      assertAddonEnabled(db, "body");
      const rec = getBodyObjective(db);
      if (!rec) throw new NotFoundError("No body objective set — use PUT to create one.");
      return { objective: applyBodyObjectivePatch(rec, patch), version: db.version };
    });
    return NextResponse.json({ objective, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
