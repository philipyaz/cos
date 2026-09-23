// The single vocabulary of committable board-write verbs, and the validated
// write cores every caller — the direct case routes AND the approval queue —
// commits a case create/update through. See board/app/api/pending/route.ts
// and pending/[id]/route.ts: the approval path must commit exactly what the
// direct verb would, by calling the same code.

import {
  findCase,
  findTask,
  applyCaseUpdate,
  applyTaskUpdate,
  appendTask,
  archiveCase,
  restoreCase,
  addNote,
  logActivity,
  describeCaseChange,
  nextCaseId,
  assertHierarchy,
  NotFoundError,
  BadRequestError,
} from "./store";
import { assertKnownLabels } from "./labels";
import {
  VALID_CASE_STATUS,
  VALID_DOMAIN,
  VALID_CASE_KIND,
  VALID_PRIORITY,
  VALID_TASK_STATUS,
  type DBShape,
  type CaseRecord,
  type CaseStatus,
  type CaseDomain,
  type CaseKind,
  type Priority,
  type Task,
  type TaskStatus,
  type Actor,
} from "./types";

// A proposed verb committed through the approval queue is the agent's intent
// realised — every resulting activity entry is attributed to "agent". The
// direct routes pass their own resolved actor (human by default) instead.
const AGENT_ACTOR: Actor = "agent";

// ── Create ───────────────────────────────────────────────────────────────
// The POST /api/cases shape checks, moved verbatim (same messages, same
// order): title → priority → status → domain → kind → parentId → labels shape.
export function validateCreateCaseInput(input: Record<string, unknown>): void {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new BadRequestError("Field 'title' is required.");
  }
  if ("priority" in input && input.priority != null && !VALID_PRIORITY.includes(input.priority as Priority)) {
    throw new BadRequestError(`'priority' must be one of: ${VALID_PRIORITY.join(", ")}.`);
  }
  if ("status" in input && !VALID_CASE_STATUS.includes(input.status as CaseStatus)) {
    throw new BadRequestError(`'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.`);
  }
  if ("domain" in input && !VALID_DOMAIN.includes(input.domain as CaseDomain)) {
    throw new BadRequestError(`'domain' must be one of: ${VALID_DOMAIN.join(", ")}.`);
  }
  if ("kind" in input && input.kind != null && !VALID_CASE_KIND.includes(input.kind as CaseKind)) {
    throw new BadRequestError(`'kind' must be one of: ${VALID_CASE_KIND.join(", ")}.`);
  }
  if ("parentId" in input && input.parentId != null && typeof input.parentId !== "string") {
    throw new BadRequestError("'parentId' must be a string.");
  }
  if ("labels" in input && input.labels != null) {
    if (!Array.isArray(input.labels) || input.labels.some((x) => typeof x !== "string")) {
      throw new BadRequestError("'labels' must be an array of string label ids.");
    }
  }
}

// Validate + commit a case create — the single write core both POST
// /api/cases and an approved create_case proposal run. Must be called inside
// mutate()'s lock: assertKnownLabels/assertHierarchy need the live db, and
// nextCaseId must mint in the same critical section that inserts.
export function createCaseFromInput(db: DBShape, input: Record<string, unknown>, actor: Actor): CaseRecord {
  validateCreateCaseInput(input);
  assertKnownLabels(db, input.labels);
  const id = nextCaseId(db);
  const status: CaseStatus = "status" in input ? (input.status as CaseStatus) : "todo";
  const domain: CaseDomain = "domain" in input ? (input.domain as CaseDomain) : "work";
  // absent kind === "case" (a leaf) — keep the field off the record in that
  // case so existing leaves stay byte-clean (absent === case downstream).
  const kind: CaseKind = "kind" in input && input.kind != null ? (input.kind as CaseKind) : "case";
  const parentId: string | undefined =
    "parentId" in input && typeof input.parentId === "string" && input.parentId.trim()
      ? input.parentId.trim()
      : undefined;
  // RELATIONAL tier check inside the lock, BEFORE inserting: the parent (if
  // any) must exist and the tier rules must hold.
  assertHierarchy(db, { id, kind, parentId });
  const now = new Date().toISOString();

  const rec: CaseRecord = {
    id,
    title: String(input.title).trim(),
    summary: input.summary ? String(input.summary) : "",
    status,
    domain,
    kind: kind === "case" ? undefined : kind,
    parentId,
    tags: Array.isArray(input.tags) ? (input.tags as unknown[]).map(String) : undefined,
    labels: Array.isArray(input.labels)
      ? Array.from(new Set((input.labels as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)))
      : undefined,
    vaultLinks: Array.isArray(input.vaultLinks) ? (input.vaultLinks as unknown[]).map(String) : undefined,
    tasks: [],
    messageIds: [],
    createdAt: now,
    updatedAt: now,
    eta: input.eta ? String(input.eta) : undefined,
    dueAt: input.dueAt ? String(input.dueAt) : undefined,
    startDate: input.startDate ? String(input.startDate) : undefined,
    priority: VALID_PRIORITY.includes(input.priority as Priority) ? (input.priority as Priority) : undefined,
  };

  // Route input.tasks through appendTask — the single owner of completedAt at
  // birth. Both timestamps pin to the case's shared `now` so a create still
  // carries a single instant (cases/route.ts's own prior idiom).
  if (Array.isArray(input.tasks)) {
    for (const t of input.tasks as Partial<Task>[]) {
      appendTask(rec, {
        title: String(t.title ?? "Untitled task"),
        detail: t.detail ? String(t.detail) : undefined,
        status: VALID_TASK_STATUS.includes(t.status as TaskStatus) ? (t.status as TaskStatus) : "open",
        owner: t.owner ? String(t.owner) : undefined,
        createdAt: now,
        completedAt: now,
        dueAt: t.dueAt ? String(t.dueAt) : undefined,
      });
    }
    rec.updatedAt = now;
  }

  logActivity(rec, actor, "created");
  db.cases.unshift(rec);
  return rec;
}

// ── Update ───────────────────────────────────────────────────────────────
// The single-PATCH shape checks, moved verbatim: title → status → domain →
// priority → labels shape → kind → parentId. NOT expectedVersion — that is
// an HTTP envelope concern and stays in the route.
export function validateCasePatch(patch: Record<string, unknown>): void {
  if ("title" in patch && (typeof patch.title !== "string" || patch.title.trim() === "")) {
    throw new BadRequestError("'title' must be a non-empty string.");
  }
  if ("status" in patch && !VALID_CASE_STATUS.includes(patch.status as CaseStatus)) {
    throw new BadRequestError(`'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.`);
  }
  if ("domain" in patch && !VALID_DOMAIN.includes(patch.domain as CaseDomain)) {
    throw new BadRequestError(`'domain' must be one of: ${VALID_DOMAIN.join(", ")}.`);
  }
  if ("priority" in patch && patch.priority != null && !VALID_PRIORITY.includes(patch.priority as Priority)) {
    throw new BadRequestError(`'priority' must be one of: ${VALID_PRIORITY.join(", ")}.`);
  }
  if ("labels" in patch && patch.labels != null) {
    if (!Array.isArray(patch.labels) || patch.labels.some((x) => typeof x !== "string")) {
      throw new BadRequestError("'labels' must be an array of string label ids.");
    }
  }
  if ("kind" in patch && patch.kind != null && !VALID_CASE_KIND.includes(patch.kind as CaseKind)) {
    throw new BadRequestError(`'kind' must be one of: ${VALID_CASE_KIND.join(", ")}.`);
  }
  if ("parentId" in patch && patch.parentId != null && typeof patch.parentId !== "string") {
    throw new BadRequestError("'parentId' must be a string or null.");
  }
}

// Validate + commit a case patch — the single write core PATCH
// /api/cases/[id], the batch PATCH /api/cases, and an approved
// update_case/update/move proposal all run. Must be called inside mutate()'s
// lock. The before-snapshot + activity detail are a property of the core
// (not the caller), so every caller logs identically.
export function applyValidatedCasePatch(
  db: DBShape,
  id: string,
  patch: Record<string, unknown>,
  actor: Actor,
): CaseRecord {
  validateCasePatch(patch);
  const rec = findCase(db, id);
  if (!rec) throw new NotFoundError(`Case ${id} not found`);
  if ("labels" in patch) assertKnownLabels(db, patch.labels);
  // RELATIONAL tier check BEFORE applying: compute the INTENDED kind/parentId
  // (patch overlaid on the current record) and assert the invariants.
  if ("kind" in patch || "parentId" in patch) {
    const kind: CaseKind = "kind" in patch && patch.kind != null ? (patch.kind as CaseKind) : (rec.kind ?? "case");
    const parentId: string | undefined =
      "parentId" in patch ? ((patch.parentId as string) || undefined) : rec.parentId;
    assertHierarchy(db, { id, kind, parentId });
  }
  // Snapshot BEFORE the patch so the audit detail can say WHAT changed — this
  // is how a later reader sees the user's (or agent's) manual edits and
  // avoids undoing them.
  const before = { ...rec };
  applyCaseUpdate(rec, patch);
  const verb = "status" in patch ? "moved" : "updated";
  logActivity(rec, actor, verb, describeCaseChange(before, rec));
  return rec;
}

// ── The verb arms ────────────────────────────────────────────────────────
// update_case/update/move and create/create_case route through the validated
// cores above. archive/restore/add_task/complete_task/add_note were already
// faithful to their direct-route equivalents (there IS no separate direct
// route for them to diverge from), so they stay as simple, unvalidated arms.

function commitUpdateOrMove(
  db: DBShape,
  target: string | undefined,
  payload: Record<string, unknown>,
): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  return applyValidatedCasePatch(db, target, payload, AGENT_ACTOR);
}

function commitMove(db: DBShape, target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  // The payload.to alias is live — preserve it and the error message verbatim.
  const s = payload.status ?? payload.to;
  if (typeof s !== "string" || !VALID_CASE_STATUS.includes(s as CaseStatus)) {
    throw new Error("move requires a valid status.");
  }
  return applyValidatedCasePatch(db, target, { status: s }, AGENT_ACTOR);
}

function commitArchive(db: DBShape, target: string | undefined): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  const rec = findCase(db, target);
  if (!rec) throw new NotFoundError(`Case ${target} not found`);
  archiveCase(rec);
  logActivity(rec, AGENT_ACTOR, "archived");
  return rec;
}

function commitRestore(db: DBShape, target: string | undefined): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  const rec = findCase(db, target);
  if (!rec) throw new NotFoundError(`Case ${target} not found`);
  restoreCase(rec);
  logActivity(rec, AGENT_ACTOR, "restored");
  return rec;
}

function commitAddTask(db: DBShape, target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  const rec = findCase(db, target);
  if (!rec) throw new NotFoundError(`Case ${target} not found`);
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) throw new Error("add_task requires payload.title.");
  const t = appendTask(rec, {
    title,
    status: "open",
    detail: typeof payload.detail === "string" ? payload.detail : undefined,
    owner: typeof payload.owner === "string" ? payload.owner : undefined,
    dueAt: typeof payload.dueAt === "string" ? payload.dueAt : undefined,
  });
  logActivity(rec, AGENT_ACTOR, "task_added", t.title);
  return rec;
}

function commitCompleteTask(db: DBShape, target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  const rec = findCase(db, target);
  if (!rec) throw new NotFoundError(`Case ${target} not found`);
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const task = findTask(rec, taskId);
  if (!task) throw new NotFoundError(`Task ${taskId} not found on ${target}`);
  applyTaskUpdate(rec, task, { status: "done" });
  logActivity(rec, AGENT_ACTOR, "task_completed", task.title);
  return rec;
}

function commitAddNote(db: DBShape, target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  if (!target) throw new Error("Verb requires a 'target' case id.");
  const rec = findCase(db, target);
  if (!rec) throw new NotFoundError(`Case ${target} not found`);
  const noteBody = typeof payload.body === "string" ? payload.body : "";
  if (!noteBody.trim()) throw new Error("add_note requires payload.body.");
  addNote(rec, AGENT_ACTOR, noteBody);
  logActivity(rec, AGENT_ACTOR, "note_added");
  return rec;
}

function commitCreate(db: DBShape, _target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  return createCaseFromInput(db, payload, AGENT_ACTOR);
}

// ── The one vocabulary ──────────────────────────────────────────────────────
// The keys ARE the machine-readable verb list — deleting a verb here deletes
// its ability to be committed, with no separate name-only list to keep in
// lockstep (the door used to maintain its own copy of this vocabulary; see
// pending/route.ts).
export const COMMIT_HANDLERS: Record<
  string,
  (db: DBShape, target: string | undefined, payload: Record<string, unknown>) => CaseRecord
> = {
  update_case: commitUpdateOrMove,
  update: commitUpdateOrMove,
  move: commitMove,
  archive: commitArchive,
  restore: commitRestore,
  add_task: commitAddTask,
  complete_task: commitCompleteTask,
  add_note: commitAddNote,
  create: commitCreate,
  create_case: commitCreate,
};

// Commit a single verb against the live db, reusing the same store helpers the
// regular routes use. Mutates db in place. Object.hasOwn (not `verb in
// COMMIT_HANDLERS` or bare indexing) is load-bearing: a Record literal
// inherits Object.prototype, so "toString"/"hasOwnProperty" must 400 rather
// than dispatch to the inherited function.
export function commitVerb(
  db: DBShape,
  verb: string,
  target: string | undefined,
  payload: Record<string, unknown>,
): CaseRecord {
  if (!Object.hasOwn(COMMIT_HANDLERS, verb)) {
    throw new Error(`Unsupported verb '${verb}'. Valid verbs: ${Object.keys(COMMIT_HANDLERS).join(", ")}.`);
  }
  return COMMIT_HANDLERS[verb](db, target, payload);
}

// Resolve a proposal's target case id: honour an explicit `target`, else a
// targeted verb's own string `payload.id` (lifted into target so list_pending
// can name the case); a present-and-disagreeing pair is refused. No verb list
// here — absence-refusal for targeted verbs comes from commitVerb's own arms
// (each throws "Verb requires a 'target' case id." when target is undefined),
// so the door never grows a second vocabulary.
export function resolvePendingTarget(target: unknown, payload: Record<string, unknown>): string | undefined {
  const t = typeof target === "string" && target.trim() !== "" ? target.trim() : undefined;
  const pidRaw = payload?.id;
  const pid = typeof pidRaw === "string" && pidRaw.trim() !== "" ? pidRaw.trim() : undefined;
  if (t !== undefined && pid !== undefined && t !== pid) {
    throw new BadRequestError(`'target' (${t}) and payload.id (${pid}) disagree.`);
  }
  return t ?? pid;
}

// Dry-run a proposed commit against a CLONE of the live db — refuses at
// propose time anything that could never be approved, without touching the
// real store. structuredClone is a perfect sandbox: every handler above
// mutates only the db/record handed to it (nothing fetches, broadcasts, or
// writes elsewhere).
export function assertCommittable(
  db: DBShape,
  verb: string,
  target: string | undefined,
  payload: Record<string, unknown>,
): void {
  commitVerb(structuredClone(db), verb, target, payload);
}
