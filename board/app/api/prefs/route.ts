import { NextResponse, type NextRequest } from "next/server";
import { readPrefs, writePrefs, VALID_BOARD_VIEW } from "@/lib/prefs";
import { parseBoardQuery, encodeBoardQuery } from "@/lib/selectors";
import { VALID_CASE_STATUS, type BoardPrefs, type CaseStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/prefs → the board's persisted UI preferences (filter/sort/group +
// collapsed lanes). The My Issues page reads these server-side too; this endpoint
// exists for the client to re-read if needed.
export async function GET(): Promise<NextResponse> {
  const prefs = await readPrefs();
  return NextResponse.json({ prefs });
}

// PATCH /api/prefs — persist last-used filter/sort/group, collapsed lanes, and/or
// the strategy roadmap's folded containers. All fields are optional; pass any subset.
// `boardQuery` is canonicalised through the selectors round-trip so only real
// board-query keys land on disk; `collapsedLanes` is filtered to valid lane keys;
// `collapsedNodes` is filtered to non-empty id strings. Returns the merged prefs.
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const patch: BoardPrefs = {};

  if ("boardQuery" in body) {
    if (typeof body.boardQuery !== "string") {
      return NextResponse.json({ error: "'boardQuery' must be a string." }, { status: 400 });
    }
    // Round-trip through the parser to strip anything that isn't a board-query key
    // (and to normalise the ordering), so prefs.json can't accumulate junk.
    patch.boardQuery = encodeBoardQuery(parseBoardQuery(new URLSearchParams(body.boardQuery)));
  }

  if ("collapsedLanes" in body) {
    if (!Array.isArray(body.collapsedLanes)) {
      return NextResponse.json({ error: "'collapsedLanes' must be an array." }, { status: 400 });
    }
    patch.collapsedLanes = body.collapsedLanes.filter(
      (l: unknown): l is CaseStatus =>
        typeof l === "string" && VALID_CASE_STATUS.includes(l as CaseStatus),
    );
  }

  if ("collapsedNodes" in body) {
    if (!Array.isArray(body.collapsedNodes)) {
      return NextResponse.json({ error: "'collapsedNodes' must be an array." }, { status: 400 });
    }
    // Strategy-roadmap folded containers — node ids are arbitrary (no catalog to
    // validate against), so keep non-empty strings; sanitize() de-dupes on write.
    patch.collapsedNodes = body.collapsedNodes.filter(
      (n: unknown): n is string => typeof n === "string" && n.length > 0,
    );
  }

  if ("view" in body) {
    if (
      typeof body.view !== "string" ||
      !VALID_BOARD_VIEW.includes(body.view as (typeof VALID_BOARD_VIEW)[number])
    ) {
      return NextResponse.json(
        { error: `'view' must be one of: ${VALID_BOARD_VIEW.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.view = body.view as (typeof VALID_BOARD_VIEW)[number];
  }

  if (
    !("boardQuery" in patch) &&
    !("collapsedLanes" in patch) &&
    !("collapsedNodes" in patch) &&
    !("view" in patch)
  ) {
    return NextResponse.json(
      { error: "Pass 'boardQuery', 'collapsedLanes', 'collapsedNodes', and/or 'view'." },
      { status: 400 },
    );
  }

  const prefs = await writePrefs(patch);
  return NextResponse.json({ prefs });
}
