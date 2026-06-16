import { NextResponse, type NextRequest } from "next/server";
import { listEntries, deleteEntries } from "@/lib/health";
import { storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/health/data?type=&from=&to=&limit= — list health entries.
// Reads are ungated (no token needed).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type")?.trim() || undefined;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const limitStr = sp.get("limit")?.trim();
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  const result = await listEntries({ type, from, to, limit });
  return NextResponse.json(result);
}

// DELETE /api/health/data — delete entries by IDs and/or date range.
// Token-gated like push.
export async function DELETE(req: NextRequest) {
  const token = (process.env.HEALTH_PUSH_TOKEN || "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Health push is not configured on the server." },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-health-token")?.trim();
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : undefined;
  const from = typeof body.from === "string" ? body.from.trim() : undefined;
  const to = typeof body.to === "string" ? body.to.trim() : undefined;

  if ((!ids || ids.length === 0) && !from && !to) {
    return NextResponse.json(
      { error: "Provide at least one of 'ids' or 'from'/'to'." },
      { status: 400 }
    );
  }

  try {
    const result = await deleteEntries({ ids, from, to });
    return NextResponse.json(result);
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
