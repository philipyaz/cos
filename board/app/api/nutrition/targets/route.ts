import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, upsertNutritionTarget } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { validateNutritionTargetInput } from "@/lib/nutrition-artifacts";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";
import { lowCalorieWarn } from "@/lib/body-baseline";
import { toISODay, type GuardrailFlag } from "@/lib/nutrition-format";
import type { NutritionTargetKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const NOT_MEDICAL_ADVICE: GuardrailFlag = {
  id: "not-medical-advice",
  level: "info",
  message:
    "Informational, not medical advice — consult a clinician or registered dietitian for medical conditions, pregnancy/breastfeeding, an eating-disorder history, or if under 18.",
};

// Build the sibling `warnings` for a saved target: the always-on not-medical-advice note + the one
// surviving safety warn (the sex calorie floor), computed in the ROUTE because it needs db → sex
// (it is NEVER folded into the agent-authored payload — attribution stays honest).
function targetWarnings(dailyCalories: unknown, sex: "male" | "female" | undefined): GuardrailFlag[] {
  const out: GuardrailFlag[] = [NOT_MEDICAL_ADVICE];
  if (typeof dailyCalories === "number" && sex) {
    const warn = lowCalorieWarn(dailyCalories, sex);
    if (warn) out.push(warn);
  }
  return out;
}

// GET /api/nutrition/targets — the AGENT-AUTHORED targets feed (replaces the old engine projection).
//   • default → history feed { items, total, version } (newest-first; matches the coachingArtifacts feed)
//   • ?latest=<kind> → { artifact, version } (the newest of that kind, or { artifact: null, version })
//   • ?periodKey=<key>[&kind=] → { artifact, version } (exact period)
// UNGATED: the SSR page + the food-log SSE loop call it every bump; it must always resolve.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind")?.trim() || undefined;
  const latest = sp.get("latest")?.trim() || undefined;
  const periodKey = sp.get("periodKey")?.trim() || undefined;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const limitRaw = sp.get("limit");

  const db = await readDB();
  const all = db.nutritionTargets ?? [];

  // Single-artifact reads (latest-of-kind or exact period).
  if (latest || periodKey) {
    const wantKind = (latest || kind) as string | undefined;
    let pool = all;
    if (wantKind) pool = pool.filter((a) => a.kind === wantKind);
    if (periodKey) pool = pool.filter((a) => a.periodKey === periodKey);
    // newest-first by createdAt, then periodKey as a tiebreak.
    const sorted = [...pool].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.periodKey < b.periodKey ? 1 : -1,
    );
    return NextResponse.json({ artifact: sorted[0] ?? null, version: db.version });
  }

  // History feed.
  let items = all;
  if (kind) items = items.filter((a) => a.kind === kind);
  if (from) items = items.filter((a) => a.periodKey >= from);
  if (to) items = items.filter((a) => a.periodKey < to);
  items = [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const total = items.length;
  const limit = limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : 50;
  if (Number.isFinite(limit) && limit > 0) items = items.slice(0, limit);
  return NextResponse.json({ items, total, version: db.version });
}

// POST /api/nutrition/targets — save the AGENT-AUTHORED daily targets (upsert by kind+periodKey).
// The board validates the SHAPE only (calories/macros are the agent's verbatim body); attributes
// source:"agent" on an x-actor agent write; returns { artifact, version, created, warnings }.
// GATED on "nutrition".
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const today = toISODay(new Date());
  const v = validateNutritionTargetInput(body, today);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const actor = resolveActor(req, body);
  if (actor === "agent") v.value.source = "agent";

  try {
    const { artifact, version, created, warnings } = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");
      const { artifact, created } = upsertNutritionTarget(db, {
        kind: v.value.kind as NutritionTargetKind,
        periodKey: v.value.periodKey,
        source: v.value.source,
        payload: v.value.payload,
        generatedAt: v.value.generatedAt,
      });
      // The one safety warn runs HERE (needs db → sex), returned as a sibling field — never in payload.
      const warnings = targetWarnings(v.value.payload.daily_calories, db.bodyProfile?.sex);
      return { artifact, version: db.version, created, warnings };
    });
    return NextResponse.json({ artifact, version, created, warnings }, { status: created ? 201 : 200 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
