import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, nextPriorityId } from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";
import { sortPriorityNotes, starredCases } from "@/lib/selectors";
import { type PriorityNote } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/priorities — the user's top-of-mind in ONE call: their free-text
// priority notes (sortPriorityNotes order: position asc, absent last) AND their
// starred nodes (cases/workstreams/initiatives, tier-ranked). The MCP's
// get_priorities reads this single endpoint to align work to what the user cares
// about. Pure read; no filters (priority notes are deliberately lightweight).
export async function GET(_req: NextRequest) {
  const db = await readDB();
  return NextResponse.json({
    priorities: sortPriorityNotes(db.priorities ?? []),
    starred: starredCases(db.cases),
    version: db.version,
  });
}

// POST /api/priorities — create a free-text priority note (the user's own words).
// Deliberately simpler than a reminder: no status/link/labels/tasks/domain, no
// actor attribution, no case audit. `text` is required and non-empty; `position`
// is an optional manual rank (smaller = higher). Absent optionals are omitted.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return NextResponse.json({ error: "Field 'text' is required." }, { status: 400 });
  }
  if ("position" in body && body.position != null && typeof body.position !== "number") {
    return NextResponse.json({ error: "'position' must be a number." }, { status: 400 });
  }

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same PRI-id or clobber.
  try {
    const { priority, version } = await mutate((db) => {
      const now = new Date().toISOString();
      const rec: PriorityNote = {
        id: nextPriorityId(db),
        text: String(body.text).trim(),
        position: "position" in body && body.position != null ? (body.position as number) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      (db.priorities ??= []).push(rec);
      return { priority: rec, version: db.version };
    });
    return NextResponse.json({ priority, version }, { status: 201 });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
