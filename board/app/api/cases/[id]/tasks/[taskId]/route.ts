import { NextResponse, type NextRequest } from "next/server";
import {
  mutate,
  findCase,
  findTask,
  applyTaskUpdate,
  deleteTask,
  logActivity,
  NotFoundError,
} from "@/lib/store";
import { VALID_TASK_STATUS } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/cases/[id]/tasks/[taskId] — update task (+dueAt, position, subtasks).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { id, taskId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  if ("title" in body && (typeof body.title !== "string" || body.title.trim() === "")) {
    return NextResponse.json({ error: "'title' must be a non-empty string." }, { status: 400 });
  }
  if ("status" in body && !VALID_TASK_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_TASK_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }

  const actor = resolveActor(req, body);
  // Completing a task reads differently in the audit trail than a generic edit.
  const verb = body.status === "done" ? "task_completed" : "task_updated";

  try {
    const { caseRec, task, version } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      const t = findTask(rec, taskId);
      if (!t) throw new NotFoundError(`Task ${taskId} not found in case ${id}`);
      applyTaskUpdate(rec, t, body);
      logActivity(rec, actor, verb, t.title);
      return { caseRec: rec, task: t, version: db.version };
    });
    return NextResponse.json({ case: caseRec, task, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}

// DELETE /api/cases/[id]/tasks/[taskId] — delete task; activity "task_deleted".
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { id, taskId } = await params;
  const actor = resolveActor(req, null);

  try {
    const { caseRec, version } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      const t = findTask(rec, taskId);
      if (!t) throw new NotFoundError(`Task ${taskId} not found in case ${id}`);
      const title = t.title;
      deleteTask(rec, taskId);
      logActivity(rec, actor, "task_deleted", title);
      return { caseRec: rec, version: db.version };
    });
    return NextResponse.json({ case: caseRec, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
