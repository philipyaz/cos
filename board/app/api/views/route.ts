import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate } from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";
import type { DBShape, SavedView } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET → the list of saved board views (filter/sort/group presets).
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  return NextResponse.json({ views: db.views ?? [], version: db.version });
}

// POST { name, query } → persist a SavedView. `query` is an encoded board-query
// string (see selectors.encodeBoardQuery), so views are deep-linkable.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json({ error: "Field 'name' is required." }, { status: 400 });
  }
  if (typeof body.query !== "string") {
    return NextResponse.json({ error: "Field 'query' must be a string." }, { status: 400 });
  }

  // Hold the live db reference so we can read its post-write version (writeDB
  // bumps db.version in place after the mutate body returns).
  try {
    let dbRef: DBShape | undefined;
    const view = await mutate((db) => {
      dbRef = db;
      if (!db.views) db.views = [];
      const v: SavedView = {
        id: `VIEW-${db.views.length + 1}`,
        name: String(body.name).trim(),
        query: String(body.query),
      };
      db.views.push(v);
      return v;
    });

    return NextResponse.json({ view, version: dbRef!.version }, { status: 201 });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
