import { NextResponse, type NextRequest } from "next/server";
import {
  mutate,
  findCase,
  findTask,
  applyCaseUpdate,
  applyTaskUpdate,
  appendTask,
  archiveCase,
  restoreCase,
  addNote,
  logActivity,
  nextCaseId,
  NotFoundError,
} from "@/lib/store";
import {
  VALID_CASE_STATUS,
  VALID_DOMAIN,
  type CaseRecord,
  type CaseStatus,
  type CaseDomain,
  type DBShape,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// A proposed verb committed here is the agent's intent realised — so every
// resulting activity entry is attributed to "agent".
const ACTOR = "agent" as const;

// Commit a single approved PendingMutation against the live db, reusing the same
// store helpers the regular routes use. Mutates db in place. Throws NotFoundError
// when a referenced case/task is missing; throws Error on an unsupported verb.
function commitVerb(db: DBShape, verb: string, target: string | undefined, payload: Record<string, unknown>): CaseRecord {
  switch (verb) {
    case "update_case":
    case "update":
    case "move": {
      if (!target) throw new Error("Verb requires a 'target' case id.");
      const rec = findCase(db, target);
      if (!rec) throw new NotFoundError(`Case ${target} not found`);
      let patch: Record<string, unknown>;
      if (verb === "move") {
        const s = payload.status ?? payload.to;
        if (typeof s !== "string" || !VALID_CASE_STATUS.includes(s as CaseStatus)) {
          throw new Error("move requires a valid status.");
        }
        patch = { status: s };
      } else {
        // Validate the agent-proposed patch at the boundary, mirroring the PATCH
        // routes, so a bad status fails loudly here (→ 400) rather than being
        // silently dropped by applyCaseUpdate's chokepoint guard.
        if ("status" in payload && (typeof payload.status !== "string" || !VALID_CASE_STATUS.includes(payload.status as CaseStatus))) {
          throw new Error(`'status' must be one of: ${VALID_CASE_STATUS.join(", ")}.`);
        }
        if ("title" in payload && (typeof payload.title !== "string" || payload.title.trim() === "")) {
          throw new Error("'title' must be a non-empty string.");
        }
        patch = payload;
      }
      applyCaseUpdate(rec, patch);
      logActivity(rec, ACTOR, verb === "move" ? "moved" : "updated");
      return rec;
    }
    case "archive": {
      if (!target) throw new Error("Verb requires a 'target' case id.");
      const rec = findCase(db, target);
      if (!rec) throw new NotFoundError(`Case ${target} not found`);
      archiveCase(rec);
      logActivity(rec, ACTOR, "archived");
      return rec;
    }
    case "restore": {
      if (!target) throw new Error("Verb requires a 'target' case id.");
      const rec = findCase(db, target);
      if (!rec) throw new NotFoundError(`Case ${target} not found`);
      restoreCase(rec);
      logActivity(rec, ACTOR, "restored");
      return rec;
    }
    case "add_task": {
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
      logActivity(rec, ACTOR, "task_added", t.title);
      return rec;
    }
    case "complete_task": {
      if (!target) throw new Error("Verb requires a 'target' case id.");
      const rec = findCase(db, target);
      if (!rec) throw new NotFoundError(`Case ${target} not found`);
      const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
      const task = findTask(rec, taskId);
      if (!task) throw new NotFoundError(`Task ${taskId} not found on ${target}`);
      applyTaskUpdate(rec, task, { status: "done" });
      logActivity(rec, ACTOR, "task_completed", task.title);
      return rec;
    }
    case "add_note": {
      if (!target) throw new Error("Verb requires a 'target' case id.");
      const rec = findCase(db, target);
      if (!rec) throw new NotFoundError(`Case ${target} not found`);
      const noteBody = typeof payload.body === "string" ? payload.body : "";
      if (!noteBody.trim()) throw new Error("add_note requires payload.body.");
      addNote(rec, ACTOR, noteBody);
      logActivity(rec, ACTOR, "note_added");
      return rec;
    }
    case "create":
    case "create_case": {
      const id = nextCaseId(db);
      const now = new Date().toISOString();
      const status: CaseStatus = VALID_CASE_STATUS.includes(payload.status as CaseStatus)
        ? (payload.status as CaseStatus)
        : "todo";
      const domain: CaseDomain = VALID_DOMAIN.includes(payload.domain as CaseDomain)
        ? (payload.domain as CaseDomain)
        : "work";
      const rec: CaseRecord = {
        id,
        title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Untitled case",
        summary: typeof payload.summary === "string" ? payload.summary : "",
        status,
        domain,
        tasks: [],
        messageIds: [],
        createdAt: now,
        updatedAt: now,
      };
      logActivity(rec, ACTOR, "created");
      db.cases.unshift(rec);
      return rec;
    }
    default:
      throw new Error(`Unsupported verb '${verb}'.`);
  }
}

// Local marker so an already-decided proposal maps to a 409 rather than a 400/404.
class ConflictError extends Error {}

// POST { decision: "approve" | "reject" } → resolve a queued proposal.
//  - approve → commit the verb via the store helpers, mark the proposal "approved"
//  - reject  → mark it "rejected" (no board change)
// Both are one critical section so the queue flag + the committed change can't
// drift. A bad verb / missing target leaves the proposal untouched (we throw
// before mutating its status — but since we're inside mutate, throwing aborts the
// whole write, so the proposal stays "pending" and nothing is half-applied).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const decision = body && typeof body === "object" ? body.decision : undefined;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "Field 'decision' must be 'approve' or 'reject'." },
      { status: 400 },
    );
  }

  try {
    let dbRef: DBShape | undefined;
    const result = await mutate((db) => {
      dbRef = db;
      const p = (db.pending ?? []).find((x) => x.id === id);
      if (!p) throw new NotFoundError(`Pending mutation ${id} not found`);
      if (p.status !== "pending") {
        throw new ConflictError(`Pending mutation ${id} is already ${p.status}.`);
      }

      if (decision === "reject") {
        p.status = "rejected";
        return { pending: p, case: undefined as CaseRecord | undefined };
      }

      const rec = commitVerb(db, p.verb, p.target, p.payload);
      p.status = "approved";
      return { pending: p, case: rec };
    });

    return NextResponse.json({ pending: result.pending, case: result.case, version: dbRef!.version });
  } catch (e) {
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof ConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
