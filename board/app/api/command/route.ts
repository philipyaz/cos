import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  applyCaseUpdate,
  applyTaskUpdate,
  appendTask,
  archiveCase,
  logActivity,
  nextCaseId,
} from "@/lib/store";
import {
  VALID_DOMAIN,
  type CaseRecord,
  type CaseStatus,
  type CaseDomain,
  type DBShape,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// Lane synonyms → canonical CaseStatus, so "in progress" / "progress" / "wip"
// all resolve. Keys are lower-cased; the longest match wins (checked in order).
const LANE_ALIASES: { phrases: string[]; status: CaseStatus }[] = [
  { phrases: ["waiting for input", "waiting", "blocked on input", "client"], status: "waiting_for_input" },
  { phrases: ["in progress", "in-progress", "progress", "wip", "doing"], status: "in_progress" },
  { phrases: ["urgent", "now", "asap"], status: "urgent" },
  { phrases: ["to do", "todo", "to-do", "backlog"], status: "todo" },
  { phrases: ["done", "complete", "completed", "finished"], status: "done" },
];

function resolveLane(text: string): CaseStatus | undefined {
  const t = text.toLowerCase().trim();
  for (const { phrases, status } of LANE_ALIASES) {
    if (phrases.some((p) => t === p || t.includes(p))) return status;
  }
  return undefined;
}

// Resolve a target case by CASE-id (exact, case-insensitive) or fuzzy title
// contains. Returns the first match (cases are newest-first in db.cases).
function resolveCase(db: DBShape, ref: string): CaseRecord | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  const byId = db.cases.find((c) => c.id.toLowerCase() === r.toLowerCase());
  if (byId) return byId;
  const lc = r.toLowerCase();
  return db.cases.find(
    (c) => !c.archivedAt && c.title.toLowerCase().includes(lc),
  );
}

interface Ran {
  verb: string;
  target?: string;
}

// Thrown from inside mutate() when a command matches nothing / can't be resolved.
// Throwing aborts the write (mutate only writes if fn returns), so a no-op command
// never bumps db.version — no spurious SSE "change" / client refetch. Carries the
// human-readable reason for the { ran:[], message } response.
class NoChange extends Error {}

// POST { text } → parse one of a small grammar of commands and EXECUTE it via the
// store verbs. Grammar (case-insensitive):
//   move <case|title> to <lane>
//   archive <case|title>
//   complete <task title> [in|on <case|title>]
//   add task <title> to <case|title>
//   create <work|life> case <title>   (also: "create case <title>")
// Unrecognized input never throws — returns { ran:[], message } with guidance.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const text = body && typeof body === "object" && typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ ran: [], message: "Empty command." });
  }
  const actor = body.actor === "agent" || req.headers.get("x-actor") === "agent" ? "agent" : "human";

  let dbRef: DBShape | undefined;
  try {
    const outcome = await mutate((db): { ran: Ran[]; message: string } => {
      dbRef = db;

      // ── create <work|life> case <title> | create case <title> ──────────────
      let m = /^create\s+(?:(work|life)\s+)?case\s+(.+)$/i.exec(text);
      if (m) {
        const domain: CaseDomain = VALID_DOMAIN.includes(m[1] as CaseDomain) ? (m[1] as CaseDomain) : "work";
        const title = m[2].trim();
        const id = nextCaseId(db);
        const now = new Date().toISOString();
        const rec: CaseRecord = {
          id,
          title,
          summary: "",
          status: "todo",
          domain,
          tasks: [],
          messageIds: [],
          createdAt: now,
          updatedAt: now,
        };
        logActivity(rec, actor, "created");
        db.cases.unshift(rec);
        return { ran: [{ verb: "create", target: id }], message: `Created ${id} “${title}”.` };
      }

      // ── move <case|title> to <lane> ────────────────────────────────────────
      m = /^move\s+(.+?)\s+to\s+(.+)$/i.exec(text);
      if (m) {
        const rec = resolveCase(db, m[1]);
        if (!rec) throw new NoChange(`Couldn't find a case matching “${m[1].trim()}”.`);
        const status = resolveLane(m[2]);
        if (!status) throw new NoChange(`Couldn't read a lane from “${m[2].trim()}”.`);
        applyCaseUpdate(rec, { status });
        logActivity(rec, actor, "moved", status);
        return { ran: [{ verb: "move", target: rec.id }], message: `Moved ${rec.id} to ${status}.` };
      }

      // ── archive <case|title> ───────────────────────────────────────────────
      m = /^archive\s+(.+)$/i.exec(text);
      if (m) {
        const rec = resolveCase(db, m[1]);
        if (!rec) throw new NoChange(`Couldn't find a case matching “${m[1].trim()}”.`);
        archiveCase(rec);
        logActivity(rec, actor, "archived");
        return { ran: [{ verb: "archive", target: rec.id }], message: `Archived ${rec.id}.` };
      }

      // ── add task <title> to <case|title> ───────────────────────────────────
      m = /^add\s+task\s+(.+?)\s+to\s+(.+)$/i.exec(text);
      if (m) {
        const rec = resolveCase(db, m[2]);
        if (!rec) throw new NoChange(`Couldn't find a case matching “${m[2].trim()}”.`);
        const t = appendTask(rec, { title: m[1].trim(), status: "open" });
        logActivity(rec, actor, "task_added", t.title);
        return { ran: [{ verb: "add_task", target: rec.id }], message: `Added task “${t.title}” to ${rec.id}.` };
      }

      // ── complete <task title> [in|on <case|title>] ─────────────────────────
      m = /^complete\s+(.+?)(?:\s+(?:in|on)\s+(.+))?$/i.exec(text);
      if (m) {
        const taskRef = m[1].trim().toLowerCase();
        const scoped = m[2] ? resolveCase(db, m[2]) : undefined;
        const pool = scoped ? [scoped] : db.cases.filter((c) => !c.archivedAt);
        for (const rec of pool) {
          const task = rec.tasks.find((t) => t.status !== "done" && t.title.toLowerCase().includes(taskRef));
          if (task) {
            applyTaskUpdate(rec, task, { status: "done" });
            logActivity(rec, actor, "task_completed", task.title);
            return {
              ran: [{ verb: "complete_task", target: rec.id }],
              message: `Completed “${task.title}” on ${rec.id}.`,
            };
          }
        }
        throw new NoChange(`Couldn't find an open task matching “${m[1].trim()}”.`);
      }

      throw new NoChange(
        "Unrecognized command. Try: move <case> to <lane>, archive <case>, add task <title> to <case>, complete <task>, or create <work|life> case <title>.",
      );
    });

    return NextResponse.json({ ran: outcome.ran, message: outcome.message, version: dbRef!.version });
  } catch (e) {
    // A NoChange means the command matched nothing / couldn't resolve — no write
    // happened. Return 200 with ran:[] and the current (unbumped) version.
    if (e instanceof NoChange) {
      const db = await readDB();
      return NextResponse.json({ ran: [], message: e.message, version: db.version });
    }
    // Defensive: the grammar itself shouldn't throw otherwise, but never 500.
    return NextResponse.json({ ran: [], message: "Command failed to run." });
  }
}
