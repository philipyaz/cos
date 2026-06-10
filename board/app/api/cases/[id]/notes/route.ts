import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, addNote, logActivity, NotFoundError } from "@/lib/store";
import type { Actor } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/cases/[id]/notes — add a freeform note; activity "note_added".
// The note author defaults to the request actor; an explicit { author } is
// honored only when it's "human" or "agent" — "system" stays store-internal
// and is never accepted from an untrusted body.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.body !== "string" || body.body.trim() === "") {
    return NextResponse.json({ error: "Field 'body' is required." }, { status: 400 });
  }

  const actor = resolveActor(req, body);
  const author: Actor = body.author === "human" || body.author === "agent" ? body.author : actor;

  try {
    const { caseRec, note, version } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      const n = addNote(rec, author, String(body.body).trim());
      logActivity(rec, actor, "note_added");
      return { caseRec: rec, note: n, version: db.version };
    });
    return NextResponse.json({ case: caseRec, note, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
