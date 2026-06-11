import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  nextCaseId,
  findCase,
  applyCaseUpdate,
  describeCaseChange,
  logActivity,
  assertHierarchy,
} from "@/lib/store";
import { assertKnownLabels } from "@/lib/labels";
import { maybeOpportunisticBackup } from "@/lib/backup-status";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";
import {
  VALID_CASE_STATUS,
  VALID_TASK_STATUS,
  VALID_DOMAIN,
  VALID_PRIORITY,
  VALID_CASE_KIND,
  type CaseRecord,
  type CaseStatus,
  type CaseDomain,
  type CaseKind,
  type Priority,
  type Task,
  type TaskStatus,
} from "@/lib/types";

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
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json({ error: "Field 'title' is required." }, { status: 400 });
  }
  if ("priority" in body && body.priority != null && !VALID_PRIORITY.includes(body.priority)) {
    return NextResponse.json(
      { error: `'priority' must be one of: ${VALID_PRIORITY.join(", ")}.` },
      { status: 400 }
    );
  }
  // Reject a present-but-invalid status/domain (the PATCH paths do the same) so a
  // typo like "in-progress" 400s instead of being silently filed under the default.
  if ("status" in body && !VALID_CASE_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("domain" in body && !VALID_DOMAIN.includes(body.domain)) {
    return NextResponse.json(
      { error: `'domain' must be one of: ${VALID_DOMAIN.join(", ")}.` },
      { status: 400 }
    );
  }
  // Tier (hierarchy) shape-checks outside the lock; RELATIONAL validity (parent
  // exists / tier rules) is asserted INSIDE the lock via assertHierarchy below.
  if ("kind" in body && body.kind != null && !VALID_CASE_KIND.includes(body.kind)) {
    return NextResponse.json(
      { error: `'kind' must be one of: ${VALID_CASE_KIND.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("parentId" in body && body.parentId != null && typeof body.parentId !== "string") {
    return NextResponse.json({ error: "'parentId' must be a string." }, { status: 400 });
  }

  // Default only the absent case; a present value has been validated above.
  const status: CaseStatus = "status" in body ? body.status : "todo";
  const domain: CaseDomain = "domain" in body ? body.domain : "work";
  // absent kind === "case" (a leaf) — keep the field off the record in that case
  // to stay back-compat-clean (absent === case everywhere downstream).
  const kind: CaseKind = "kind" in body && body.kind != null ? (body.kind as CaseKind) : "case";
  const parentId: string | undefined =
    "parentId" in body && typeof body.parentId === "string" && body.parentId.trim()
      ? body.parentId.trim()
      : undefined;

  // Shape-check labels before the lock; VALIDITY (∈ catalog) is checked inside it.
  if ("labels" in body && body.labels != null) {
    if (!Array.isArray(body.labels) || body.labels.some((x: unknown) => typeof x !== "string")) {
      return NextResponse.json({ error: "'labels' must be an array of string label ids." }, { status: 400 });
    }
  }

  const actor = resolveActor(req, body);

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same CASE-id or clobber.
  try {
    const { caseRec, version } = await mutate((db) => {
    // Label ids must already exist in the catalog — fail loudly with the valid set
    // rather than silently filing the case under a category the board doesn't know.
    assertKnownLabels(db, body.labels);
    const id = nextCaseId(db);
    // RELATIONAL tier check inside the lock, BEFORE inserting: the parent (if any)
    // must exist and the tier rules must hold. Throws BadRequestError → 400 below.
    assertHierarchy(db, { id, kind, parentId });
    const now = new Date().toISOString();

    const tasks: Task[] = Array.isArray(body.tasks)
      ? body.tasks.map((t: Partial<Task>, i: number) => ({
          id: `${id}-T${i + 1}`,
          title: String(t.title ?? "Untitled task"),
          detail: t.detail ? String(t.detail) : undefined,
          status: VALID_TASK_STATUS.includes(t.status as TaskStatus)
            ? (t.status as TaskStatus)
            : "open",
          owner: t.owner ? String(t.owner) : undefined,
          createdAt: now,
          dueAt: t.dueAt ? String(t.dueAt) : undefined,
        }))
      : [];

    const rec: CaseRecord = {
      id,
      title: String(body.title).trim(),
      summary: body.summary ? String(body.summary) : "",
      status,
      domain,
      // Omit kind when it's the default "case" so existing leaves stay byte-clean
      // (absent === case downstream); persist parentId only when present.
      kind: kind === "case" ? undefined : kind,
      parentId,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      labels: Array.isArray(body.labels)
        ? Array.from(new Set(body.labels.map(String).map((s: string) => s.trim()).filter(Boolean)))
        : undefined,
      vaultLinks: Array.isArray(body.vaultLinks) ? body.vaultLinks.map(String) : undefined,
      tasks,
      messageIds: [],
      createdAt: now,
      updatedAt: now,
      eta: body.eta ? String(body.eta) : undefined,
      dueAt: body.dueAt ? String(body.dueAt) : undefined,
      startDate: body.startDate ? String(body.startDate) : undefined,
      priority: VALID_PRIORITY.includes(body.priority) ? (body.priority as Priority) : undefined,
    };

    logActivity(rec, actor, "created");
    db.cases.unshift(rec);
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

  // Validate the shared patch once (it's applied to every id).
  if ("title" in patch && (typeof patch.title !== "string" || patch.title.trim() === "")) {
    return NextResponse.json({ error: "'title' must be a non-empty string." }, { status: 400 });
  }
  if ("status" in patch && !VALID_CASE_STATUS.includes(patch.status as CaseStatus)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("domain" in patch && !VALID_DOMAIN.includes(patch.domain as CaseDomain)) {
    return NextResponse.json(
      { error: `'domain' must be one of: ${VALID_DOMAIN.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("priority" in patch && patch.priority != null && !VALID_PRIORITY.includes(patch.priority as Priority)) {
    return NextResponse.json(
      { error: `'priority' must be one of: ${VALID_PRIORITY.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("labels" in patch && patch.labels != null) {
    if (!Array.isArray(patch.labels) || patch.labels.some((x: unknown) => typeof x !== "string")) {
      return NextResponse.json({ error: "'labels' must be an array of string label ids." }, { status: 400 });
    }
  }
  // Tier shape-checks up front; RELATIONAL validity (per id) is asserted inside the
  // lock. parentId === null clears the parent (re-parent to top-level / detach).
  if ("kind" in patch && patch.kind != null && !VALID_CASE_KIND.includes(patch.kind as CaseKind)) {
    return NextResponse.json(
      { error: `'kind' must be one of: ${VALID_CASE_KIND.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("parentId" in patch && patch.parentId != null && typeof patch.parentId !== "string") {
    return NextResponse.json({ error: "'parentId' must be a string or null." }, { status: 400 });
  }

  const ids = body.ids as string[];
  const actor = resolveActor(req, body);

  try {
    const { cases, version } = await mutate((db) => {
      // One catalog check up front: the same patch is applied to every id.
      if ("labels" in patch) assertKnownLabels(db, patch.labels);
      // Tier check FIRST across every known id: if any id would violate the
      // hierarchy, 400 the WHOLE batch (the labels-reject-whole-batch precedent)
      // by throwing before we mutate anything. Skip unknown ids (best-effort set).
      if ("kind" in patch || "parentId" in patch) {
        for (const id of ids) {
          const rec = findCase(db, id);
          if (!rec) continue;
          const kind: CaseKind =
            "kind" in patch ? (patch.kind as CaseKind) : (rec.kind ?? "case");
          const parentId: string | undefined =
            "parentId" in patch
              ? (typeof patch.parentId === "string" && patch.parentId ? patch.parentId : undefined)
              : rec.parentId;
          assertHierarchy(db, { id, kind, parentId });
        }
      }
      const updated: CaseRecord[] = [];
      for (const id of ids) {
        const rec = findCase(db, id);
        if (!rec) continue; // skip unknown ids — batch is best-effort across the set
        const before = { ...rec };
        applyCaseUpdate(rec, patch);
        logActivity(rec, actor, "updated", describeCaseChange(before, rec));
        updated.push(rec);
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
