import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, cleanCases } from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/cases/clean — the storage-reclaiming "Clean Done" verb. Body:
//   { ids: string[] }
// PERMANENTLY removes the given cases AND purges their linked emails (the manual
// counterpart to the automatic retention sweep). This is deliberately NARROW: it is a
// done-lane housekeeping tool, so the route only ever removes ids whose case is in
// the `done` lane — any other id (a non-done case, or an unknown id) is skipped, so
// a bad client list can never delete an in-flight case. An email still linked to a
// reminder (or a surviving case) is kept + unlinked, not deleted (see cleanCases).
// Returns the counts actually purged plus the post-write version (for live reconcile).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!Array.isArray(body.ids) || body.ids.some((x: unknown) => typeof x !== "string")) {
    return NextResponse.json({ error: "Field 'ids' must be an array of case ids." }, { status: 400 });
  }
  const ids = body.ids as string[];

  try {
    const { removed, messagesDeleted, version } = await mutate((db) => {
      // Policy guard: only purge ids that exist AND are in the `done` lane. This is
      // what makes "Clean" structurally incapable of deleting a non-done case even if
      // the client sends a stale/wrong list.
      const doneIds = ids.filter((id) => {
        const c = findCase(db, id);
        return c !== undefined && c.status === "done";
      });
      const { cases, messages } = cleanCases(db, doneIds);
      return { removed: cases, messagesDeleted: messages, version: db.version };
    });

    return NextResponse.json({ ok: true, removed, messagesDeleted, version });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
