import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate } from "@/lib/store";
import { activeLabels, addCustomLabel } from "@/lib/labels";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/labels — the active label catalog (the installed-bundle + custom labels
// the board knows about). THIS is the endpoint skills/agents fetch before a case
// write so they use valid label ids (the `list_labels` MCP tool wraps it). Each
// entry is { id, title, description, color?, bundle?, domain? }.
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  return NextResponse.json({ labels: activeLabels(db), version: db.version });
}

// POST /api/labels — add ONE custom label to the catalog.
// Body: { title* , description?, color?, domain?, id? }. The id is minted from the
// title if absent (and de-duplicated); a provided id must be unique. Returns the
// created label plus the full catalog and the new version.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  try {
    let dbRef: DBShape | undefined;
    const label = await mutate((db) => {
      dbRef = db;
      return addCustomLabel(db, body as Record<string, unknown>);
    });
    return NextResponse.json(
      { label, labels: activeLabels(dbRef!), version: dbRef!.version },
      { status: 201 },
    );
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
