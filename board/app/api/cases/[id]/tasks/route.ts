import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, appendTask, logActivity, NotFoundError } from "@/lib/store";
import { VALID_TASK_STATUS } from "@/lib/types";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/cases/[id]/tasks — add task (+dueAt); activity "task_added".
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json(
      { error: "Field 'title' is required." },
      { status: 400 }
    );
  }
  // Reject a present-but-invalid status (the task PATCH sibling does too) rather
  // than silently defaulting; an absent status still defaults to "open".
  if ("status" in body && !VALID_TASK_STATUS.includes(body.status)) {
    return NextResponse.json(
      { error: `'status' must be one of: ${VALID_TASK_STATUS.join(", ")}.` },
      { status: 400 }
    );
  }

  const actor = resolveActor(req, body);

  try {
    const { caseRec, task, version } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);
      const t = appendTask(rec, {
        title: String(body.title).trim(),
        detail: body.detail ? String(body.detail) : undefined,
        status: body.status ?? "open",
        owner: body.owner ? String(body.owner) : undefined,
        completedAt: body.completedAt ? String(body.completedAt) : undefined,
        dueAt: body.dueAt ? String(body.dueAt) : undefined,
      });
      logActivity(rec, actor, "task_added", t.title);
      return { caseRec: rec, task: t, version: db.version };
    });
    return NextResponse.json({ case: caseRec, task, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
