import { NextResponse, type NextRequest } from "next/server";
import { mutate, nextCaseId, appendTask, logActivity } from "@/lib/store";
import { storeErrorToResponse } from "@/lib/route-helpers";
import {
  VALID_CASE_STATUS,
  VALID_DOMAIN,
  VALID_PRIORITY,
  type CaseRecord,
  type CaseStatus,
  type CaseDomain,
  type DBShape,
  type Priority,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// A template task seed — title (+ optional detail/owner). Ids are minted at apply.
interface TemplateTask {
  title: string;
  detail?: string;
  owner?: string;
}

interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  domain: CaseDomain;
  status?: CaseStatus;
  priority?: Priority;
  tags?: string[];
  tasks: TemplateTask[];
}

// Built-in templates. `pb-onboarding` is the plugin-onboarding checklist
// (the workflow the onboarding skill drives); `followup` is the generic
// follow-up stub.
const TEMPLATES: BoardTemplate[] = [
  {
    id: "pb-onboarding",
    name: "Plugin onboarding checklist",
    description: "Plugin onboarding — collect and verify the integration's setup details.",
    domain: "work",
    status: "waiting_for_input",
    priority: "P1",
    tags: ["onboarding", "developer-tooling"],
    tasks: [
      { title: "Collect plugin manifest / metadata" },
      { title: "Collect repository access details" },
      { title: "Collect declared scopes / permissions" },
      { title: "Collect signed contributor agreement" },
      { title: "Run access review / security scan" },
      { title: "File config and confirm completeness" },
    ],
  },
  {
    id: "followup",
    name: "Follow-up",
    description: "Generic follow-up case.",
    domain: "work",
    status: "todo",
    tasks: [{ title: "Draft follow-up" }],
  },
];

// GET → list the built-in templates (metadata + their seed tasks).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ templates: TEMPLATES });
}

// POST { id, overrides? } → instantiate a template into a real case through the
// same create path as POST /api/cases (id generation + insert inside the lock).
// `overrides` may set title/summary/status/domain/priority/etc.; template
// tasks are appended via the store's appendTask. Logs activity "created".
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.id !== "string" || body.id.trim() === "") {
    return NextResponse.json({ error: "Field 'id' (template id) is required." }, { status: 400 });
  }

  const tpl = TEMPLATES.find((t) => t.id === body.id);
  if (!tpl) {
    return NextResponse.json({ error: `Template '${body.id}' not found.` }, { status: 404 });
  }

  const ov = (body.overrides && typeof body.overrides === "object" ? body.overrides : {}) as Record<
    string,
    unknown
  >;
  const actor = body.actor === "agent" || req.headers.get("x-actor") === "agent" ? "agent" : "human";

  const status: CaseStatus =
    typeof ov.status === "string" && VALID_CASE_STATUS.includes(ov.status as CaseStatus)
      ? (ov.status as CaseStatus)
      : tpl.status ?? "todo";
  const domain: CaseDomain =
    typeof ov.domain === "string" && VALID_DOMAIN.includes(ov.domain as CaseDomain)
      ? (ov.domain as CaseDomain)
      : tpl.domain;
  const priority: Priority | undefined =
    typeof ov.priority === "string" && VALID_PRIORITY.includes(ov.priority as Priority)
      ? (ov.priority as Priority)
      : tpl.priority;

  try {
    let dbRef: DBShape | undefined;
    const caseRec = await mutate((db): CaseRecord => {
      dbRef = db;
      const id = nextCaseId(db);
      const now = new Date().toISOString();

      const rec: CaseRecord = {
        id,
        title: typeof ov.title === "string" && ov.title.trim() ? ov.title.trim() : tpl.name,
        summary: typeof ov.summary === "string" ? ov.summary : tpl.description,
        status,
        domain,
        tags: Array.isArray(ov.tags) ? ov.tags.map(String) : tpl.tags,
        vaultLinks: Array.isArray(ov.vaultLinks) ? ov.vaultLinks.map(String) : undefined,
        tasks: [],
        messageIds: [],
        createdAt: now,
        updatedAt: now,
        eta: typeof ov.eta === "string" ? ov.eta : undefined,
        dueAt: typeof ov.dueAt === "string" ? ov.dueAt : undefined,
        startDate: typeof ov.startDate === "string" ? ov.startDate : undefined,
        priority,
      };

      for (const t of tpl.tasks) {
        appendTask(rec, { title: t.title, detail: t.detail, owner: t.owner, status: "open" });
      }
      rec.updatedAt = now; // appendTask touched it; pin to creation time

      logActivity(rec, actor, "created", `from template ${tpl.id}`);
      db.cases.unshift(rec);
      return rec;
    });

    return NextResponse.json({ case: caseRec, version: dbRef!.version }, { status: 201 });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
