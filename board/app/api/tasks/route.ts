import { NextResponse, type NextRequest } from "next/server";
import { readDB } from "@/lib/store";
import { selectTasks, TASK_BUCKETS, type TaskBucket } from "@/lib/selectors";
import { VALID_TASK_STATUS, type TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/tasks?status=&scope=&due=&caseId=&owner= — the board's own open-task
// list (cos-ops#51): the task is the only first-class entity with full CRUD
// (add/update/complete/delete) and, until now, no list verb. A thin param-parsing
// shell over the selectTasks engine — the MCP `list_tasks` tool rides this same
// route, so the two surfaces return the same set by construction.
//
// Params silently drop invalid values (the reminders GET's convention); `status`
// and `due` are comma lists (parseBoardQuery's convention). `status` — comma list
// ∩ VALID_TASK_STATUS; empty/absent → the selector's own default (every status
// except "done"). `scope` — "live" (default) excludes tasks whose case is
// done/archived/future-snoozed; "all" adds done-status + snoozed cases back
// (archived stays excluded under BOTH — see selectTasks). `due` — comma list ∩
// the five buckets; empty after the drop → no filter. `caseId`/`owner` — trimmed
// strings.
//
// `counts` describes the FILTERED result of THIS request, not the whole board
// (the needs-attention route's own convention) — a `?due=overdue` call returns
// counts whose only non-zero bucket is `overdue`.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const statusRaw = sp.get("status");
  const status = statusRaw
    ? statusRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TaskStatus => VALID_TASK_STATUS.includes(s as TaskStatus))
    : [];

  const scope = sp.get("scope") === "all" ? "all" : "live";

  const dueRaw = sp.get("due");
  const due = dueRaw
    ? dueRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TaskBucket => TASK_BUCKETS.includes(s as TaskBucket))
    : [];

  const caseId = sp.get("caseId")?.trim() || undefined;
  const owner = sp.get("owner")?.trim() || undefined;

  const db = await readDB();
  const { tasks } = selectTasks(db.cases, new Date(), {
    status: status.length ? status : undefined,
    scope,
    due: due.length ? due : undefined,
    caseId,
    owner,
  });

  const counts = { overdue: 0, today: 0, week: 0, later: 0, undated: 0, total: tasks.length };
  for (const t of tasks) counts[t.bucket]++;

  return NextResponse.json({ tasks, counts, version: db.version });
}
