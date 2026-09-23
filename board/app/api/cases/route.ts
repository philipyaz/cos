import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, findCase } from "@/lib/store";
import { assertKnownLabels } from "@/lib/labels";
import { createCaseFromInput, validateCreateCaseInput, validateCasePatch, applyValidatedCasePatch } from "@/lib/case-writes";
import { maybeOpportunisticBackup } from "@/lib/backup-status";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";
import type { CaseRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/cases?includeArchived=1&q= — default EXCLUDES archived & future-snoozed.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const includeArchived = sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true";
  const q = (sp.get("q") ?? "").trim().toLowerCase();

  // Opportunistic backup top-up: /api/cases is the most-hit board data GET (the
  // kanban loads it on every view), so it's the natural heartbeat for the freshness-
  // first, debounced, fire-and-forget top-up. NON-blocking and invisible to this
  // response — the helper returns immediately and swallows every error (it can never
  // delay or error a cases read). Spawns nothing on a fresh window, a debounce hit, or
  // a non-live-board context.
  maybeOpportunisticBackup();

  const db = await readDB();
  const now = Date.now();

  let cases = db.cases;
  if (!includeArchived) {
    cases = cases.filter((c) => {
      if (c.archivedAt) return false;
      if (c.snoozeUntil && new Date(c.snoozeUntil).getTime() > now) return false;
      return true;
    });
  }
  if (q) {
    cases = cases.filter((c) => {
      const hay = [c.title, c.summary, (c.tags ?? []).join(" ")]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  return NextResponse.json({ cases, version: db.version });
}

// POST /api/cases — create. Body adds dueAt/startDate/priority; tasks[] may carry dueAt.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Shape-check outside the lock, preserving today's fast-400-before-lock order.
  try {
    validateCreateCaseInput(body);
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }

  const actor = resolveActor(req, body);

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same CASE-id or clobber.
  // createCaseFromInput (lib/case-writes.ts) is the single write core also used
  // by an approved create_case proposal — its internal re-validation is
  // idempotent string checks, harmless after the shape-check above.
  try {
    const { caseRec, version } = await mutate((db) => {
      const rec = createCaseFromInput(db, body, actor);
      return { caseRec: rec, version: db.version };
    });
    return NextResponse.json({ case: caseRec, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// PATCH /api/cases — BATCH update_cases: { ids:string[], patch:object } applies
// the same validated patch to each case, logging activity per case.
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!Array.isArray(body.ids) || body.ids.some((x: unknown) => typeof x !== "string")) {
    return NextResponse.json({ error: "Field 'ids' must be an array of case ids." }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "Field 'patch' must be a JSON object." }, { status: 400 });
  }

  const patch = body.patch as Record<string, unknown>;

  // Validate the shared patch once (it's applied to every id), outside the lock.
  try {
    validateCasePatch(patch);
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }

  const ids = body.ids as string[];
  const actor = resolveActor(req, body);

  try {
    const { cases, version } = await mutate((db) => {
      // One catalog check up front: the same patch is applied to every id —
      // preserves today's behaviour that an empty-ids batch with bad labels
      // still 400s (applyValidatedCasePatch's own label check never runs for
      // an empty id set).
      if ("labels" in patch) assertKnownLabels(db, patch.labels);
      const updated: CaseRecord[] = [];
      for (const id of ids) {
        if (!findCase(db, id)) continue; // skip unknown ids — batch is best-effort across the set
        // applyValidatedCasePatch (lib/case-writes.ts) asserts the per-id
        // hierarchy invariant itself; a violation on any id throws, and
        // mutate()'s abort keeps the batch all-or-nothing (nothing persisted).
        updated.push(applyValidatedCasePatch(db, id, patch, actor));
      }
      return { cases: updated, version: db.version };
    });
    return NextResponse.json({ cases, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
