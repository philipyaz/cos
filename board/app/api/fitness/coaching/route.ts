import { NextResponse, type NextRequest } from "next/server";
import { listCoachingArtifacts, saveCoachingArtifact } from "@/lib/fitness";
import { validateCoachingArtifactInput } from "@/lib/fitness-artifacts";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/fitness/coaching?kind=&from=&to=&limit= — the coaching-artifact history feed.
// UNGATED: a disabled "fitness" add-on's artifacts stay viewable. `kind` filters exact;
// `from`/`to` compare against createdAt's date-only prefix (from inclusive, to exclusive);
// returns newest-first. `total` is the pre-limit count (default limit 50, limit<=0 = no limit).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind")?.trim() || undefined;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const limitRaw = sp.get("limit");
  const limit = limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : undefined;

  const { items, total, version } = await listCoachingArtifacts({ kind, from, to, limit });
  return NextResponse.json({ items, total, version });
}

// POST /api/fitness/coaching — create-or-replace a coaching artifact (upsert by kind+periodKey).
// Add-on-gated: the sole gate is the add-on enabled check inside saveCoachingArtifact
// (assertAddonEnabled in mutate → a disabled add-on yields 404), so an external agent (Cowork)
// writes WITHOUT the board's Anthropic key, attributed via x-actor.
export async function POST(req: NextRequest) {
  // ── Parse + validate body ──
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const v = validateCoachingArtifactInput(body);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 });
  }

  // An agent write is always source:"agent" (the x-actor header marks an external agent);
  // a non-agent caller keeps the validated source.
  const actor = resolveActor(req, body);
  if (actor === "agent") v.value.source = "agent";

  // ── Persist (add-on gate inside mutate → 404 when disabled) ──
  try {
    const { artifact, version, created } = await saveCoachingArtifact(v.value);
    return NextResponse.json({ artifact, version, created }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
