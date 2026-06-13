// Declarative tool catalog for the board MCP server — the pure-data layer pulled
// out of server.mjs so the god-file shrinks to enums + handlers + dispatch. These
// are the const FOO_TOOL = { name, description, inputSchema } objects and the
// TOOLS array that server.mjs's ListTools handler serves verbatim. No handler
// logic lives here. The shared enums (CASE_STATUS, …) are exported too because
// both the schemas below and server.mjs's handlers validate against them.

export const CASE_STATUS = ["urgent", "todo", "in_progress", "waiting_for_input", "done"];
export const TASK_STATUS = ["open", "in_progress", "blocked", "done"];
export const REMINDER_STATUS = ["open", "done", "dismissed"];
export const CASE_DOMAIN = ["work", "life"];
export const MESSAGE_SOURCE = ["gmail", "whatsapp", "jira", "agent", "client", "system"];
export const PRIORITY = ["P0", "P1", "P2", "P3"];
// The three hierarchy tiers (in lockstep with VALID_CASE_KIND in board/lib/types.ts).
// All three are CaseRecords; `kind` absent === "case" (a leaf).
export const CASE_KIND = ["initiative", "workstream", "case"];

// ── Tool definitions ─────────────────────────────────────────────────────────

const CREATE_CASE_TOOL = {
  name: "create_case",
  description:
    "BEFORE opening a case, call `search` with several queries (the person/entity/topic, the vault " +
    "entity) AND `get_tree` to check for an existing case on the same matter — if one exists, UPDATE it " +
    "instead of creating a duplicate. When the matter belongs to an existing Initiative/Workstream, NEST " +
    "it: pass `parentId` (an Initiative or Workstream id) so the leaf rolls up under it. Prefer a " +
    "STANDALONE case (no parentId) for a one-off; open a new Initiative (create_initiative) only for a " +
    "genuinely new multi-stream theme. " +
    "Open a case on the Cos board — the single to-do surface for both work and " +
    "life. Set `domain` to 'work' or 'life' to file the case on the right side of the board " +
    "(defaults to 'work'). New cases land in the 'To do' column unless you set `status`. Seed " +
    "`tasks` from a checklist; each task defaults to status 'open' and drives the card's " +
    "done/total counter. Set `dueAt` (ISO date) for a sortable/filterable deadline and " +
    "`priority` (P0..P3) for triage. Use `vaultLinks` to wire the card to the vault pages " +
    "(entities / concepts / sources) that give it its who/what/why, by their exact wikilink titles. " +
    "`kind` defaults to 'case' (a leaf); to open a container tier use create_initiative / create_workstream.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Case title, e.g. 'Onboarding — Acme Ltd'." },
      domain: {
        type: "string",
        enum: CASE_DOMAIN,
        description: "Which side of the board: 'work' or 'life'. Defaults to 'work'.",
      },
      kind: {
        type: "string",
        enum: CASE_KIND,
        description:
          "Hierarchy tier. Defaults to 'case' (a leaf/Issue). Prefer create_initiative / " +
          "create_workstream for the container tiers — but you may set it here directly.",
      },
      parentId: {
        type: "string",
        description:
          "Nest this case UNDER an existing Initiative or Workstream id (e.g. 'CASE-3'), so it rolls " +
          "up there. Omit for a standalone top-level case. The board rejects an invalid parent (must " +
          "exist and be a container) with a 400 — call get_tree first to find the right parent.",
      },
      summary: { type: "string", description: "One- or two-line summary of the current state." },
      status: {
        type: "string",
        enum: CASE_STATUS,
        description: "Board column. Defaults to 'todo'.",
      },
      tags: { type: "array", items: { type: "string" }, description: "Freeform short tags, e.g. ['onboarding','first-call']." },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Catalog label ids categorizing the case, e.g. ['doc-chase','at-risk']. Call list_labels " +
          "FIRST to get valid ids and what each means; UNKNOWN ids are REJECTED (the board returns the " +
          "valid set). Labels are the configurable taxonomy — distinct from freeform `tags`.",
      },
      eta: { type: "string", description: "Free-text ETA, e.g. 'Awaiting documents'." },
      dueAt: {
        type: "string",
        description:
          "Structured due date as an ISO string, e.g. '2026-06-15' or a full ISO timestamp. " +
          "This is the sortable/filterable deadline (distinct from the free-text `eta`).",
      },
      startDate: { type: "string", description: "ISO start date (reserved for timeline views)." },
      priority: {
        type: "string",
        enum: PRIORITY,
        description: "Triage priority, one of P0 (top) .. P3. Distinct from the 'urgent' lane.",
      },
      vaultLinks: {
        type: "array",
        items: { type: "string" },
        description:
          "Vault page titles exactly as they appear inside [[...]] wikilinks, e.g. " +
          "['Acme Ltd', 'Jane Doe']. These link the card to its context pages.",
      },
      tasks: {
        type: "array",
        description: "Checklist / action items. Each defaults to status 'open'.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            status: { type: "string", enum: TASK_STATUS },
            owner: { type: "string" },
            dueAt: { type: "string", description: "ISO due date for this task." },
          },
          required: ["title"],
        },
      },
    },
    required: ["title"],
  },
};

const GET_CASE_TOOL = {
  name: "get_case",
  description:
    "Fetch a single case from the Cos board by id (e.g. 'CASE-1'). Returns the case " +
    "fields (including `domain`, `priority`, `dueAt`, `archivedAt`, and linked vault context " +
    "pages), its tasks (the checklist, with each task's status, owner, and dueAt), its recent " +
    "activity log, and the messages linked to it. Use this to load a case's current state before " +
    "acting on it." +
    " It ALSO surfaces the case's MANUAL ACTIONS — the edits the user made by hand (lane moves, task completions, field changes) — which you MUST NOT undo, reopen, or override without explicit instruction. Treat the human's deliberate state as authoritative; when an email or inference seems to conflict, add a note (or propose the change) instead of reverting.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
    },
    required: ["id"],
  },
};

const UPDATE_CASE_TOOL = {
  name: "update_case",
  description:
    "Update a single case's fields and/or move it between board columns. Pass only the fields " +
    "you want to change. Set `status` to move the card to a new lane (e.g. 'waiting_for_input' → " +
    "'done'). Set `domain` to refile it between 'work' and 'life'. Set `dueAt`/`priority` to " +
    "change the deadline/triage. Set `vaultLinks` to replace the case's list of linked vault " +
    "context pages (by their exact wikilink titles). Set `parentId` to re-parent the node under an " +
    "Initiative/Workstream (or null to detach a leaf to top-level); set `kind` to change tier. The " +
    "board enforces the tier invariants and rejects an illegal move with a 400 — prefer the dedicated " +
    "set_parent / regroup_cases verbs for re-parenting. " +
    "The target id usually comes from a prior `search`/`get_case` — search first to avoid " +
    "duplicating an existing matter." +
    " RESPECT MANUAL ACTIONS: get_case first and never silently revert a lane move, task completion, or field the user set by hand — if your change would override a human action, add_note to flag it (or propose it) instead of overwriting.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      title: { type: "string", description: "New title." },
      summary: { type: "string", description: "New summary." },
      status: { type: "string", enum: CASE_STATUS, description: "Move the card to this column." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Refile to 'work' or 'life'." },
      kind: {
        type: "string",
        enum: CASE_KIND,
        description:
          "Change the hierarchy tier (initiative | workstream | case). Illegal transitions (e.g. " +
          "demoting a container that still has children to 'case') are rejected with a 400.",
      },
      parentId: {
        type: ["string", "null"],
        description:
          "Re-parent under an Initiative/Workstream id, or null to DETACH (only valid for a leaf " +
          "case — a workstream cannot detach to top-level; convert it to an Initiative instead). " +
          "Prefer set_parent / regroup_cases for re-parenting.",
      },
      tags: { type: "array", items: { type: "string" }, description: "Replace the case's freeform tags." },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "REPLACE the case's catalog labels with these ids (pass [] to clear). Call list_labels first " +
          "for valid ids; unknown ids are rejected. Distinct from freeform `tags`.",
      },
      eta: { type: "string", description: "Free-text ETA." },
      dueAt: {
        type: "string",
        description: "Structured ISO due date (the sortable/filterable deadline). Distinct from `eta`.",
      },
      startDate: { type: "string", description: "ISO start date (reserved for timeline views)." },
      priority: {
        type: "string",
        enum: PRIORITY,
        description: "Triage priority P0..P3. Distinct from the 'urgent' lane.",
      },
      snoozeUntil: { type: "string", description: "ISO date; hide the card until then." },
      vaultLinks: {
        type: "array",
        items: { type: "string" },
        description: "Replace the case's linked vault page titles (exact wikilink titles).",
      },
    },
    required: ["id"],
  },
};

const UPDATE_CASES_TOOL = {
  name: "update_cases",
  description:
    "Bulk-update many cases at once: apply ONE patch to every id in `ids`. Use for sweeps like " +
    "re-prioritising a batch, moving several cards to a lane, or refiling a group between 'work' " +
    "and 'life'. The same `patch` object is applied to each case; activity is logged per case." +
    " Do not use a bulk sweep to override cases the user edited by hand — check get_case for manual actions on any case you are unsure about.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Case ids to update, e.g. ['CASE-1','CASE-4'].",
      },
      patch: {
        type: "object",
        description:
          "Fields to set on every listed case (e.g. { status, priority, domain, " +
          "dueAt, tags, labels, vaultLinks, snoozeUntil, parentId }). For `labels` (catalog ids), call " +
          "list_labels first — unknown ids reject the whole batch. `parentId` re-parents the batch " +
          "(prefer regroup_cases); if ANY id would violate the tier rules the WHOLE batch is rejected (400).",
      },
    },
    required: ["ids", "patch"],
  },
};

// ── Hierarchy tools (Initiatives & Workstreams) ──────────────────────────────
// All three tiers are CaseRecords (id CASE-<n>); these verbs are sugar over the
// case API that set `kind`/`parentId` and read the tree. The board enforces the
// tier invariants and returns a 400 on any illegal nesting.

const CREATE_INITIATIVE_TOOL = {
  name: "create_initiative",
  description:
    "Open a new INITIATIVE — the top tier (an Epic): a big work-or-life aspiration that decomposes " +
    "into Workstreams and Cases (e.g. 'Build DevForge', 'Get healthy'). An Initiative is a " +
    "root (no parent). " +
    "BEFORE creating, call get_tree + search: create a new Initiative ONLY for a genuinely new " +
    "multi-stream theme. If the matter belongs to an existing Initiative, add a Workstream " +
    "(create_workstream) or a Case (create_case with parentId) under it instead; for a one-off, open " +
    "a STANDALONE case (create_case with no parentId). " +
    "`POST /api/cases` with kind:'initiative'.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Initiative title, e.g. 'Build DevForge'." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "'work' or 'life'. Defaults to 'work'." },
      summary: { type: "string", description: "One- or two-line description of the aspiration." },
      vaultLinks: {
        type: "array",
        items: { type: "string" },
        description: "Vault page titles (exact [[wikilink]] titles) giving the initiative its context.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Catalog label ids — call list_labels FIRST; unknown ids are rejected.",
      },
      tags: { type: "array", items: { type: "string" }, description: "Freeform short tags." },
      dueAt: { type: "string", description: "Structured ISO target date for the initiative." },
      priority: { type: "string", enum: PRIORITY, description: "Triage priority P0..P3." },
    },
    required: ["title"],
  },
};

const CREATE_WORKSTREAM_TOOL = {
  name: "create_workstream",
  description:
    "Open a new WORKSTREAM — the middle tier (a Sub-Epic): a thread of related work UNDER an " +
    "Initiative (e.g. 'Pipeline' or 'Brand' under 'Build DevForge'). A Workstream MUST have " +
    "an Initiative parent and may contain only leaf Cases. " +
    "BEFORE creating, call get_tree to find the right `initiativeId` and avoid a duplicate thread. " +
    "If the work is a one-off, prefer a Case (create_case) rather than a new Workstream. " +
    "`POST /api/cases` with kind:'workstream', parentId:initiativeId.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Workstream title, e.g. 'Pipeline'." },
      initiativeId: {
        type: "string",
        description: "Parent INITIATIVE id (e.g. 'CASE-3'). REQUIRED — must reference an existing initiative.",
      },
      domain: { type: "string", enum: CASE_DOMAIN, description: "'work' or 'life'. Defaults to 'work'." },
      summary: { type: "string", description: "One- or two-line description of the thread." },
      vaultLinks: {
        type: "array",
        items: { type: "string" },
        description: "Vault page titles (exact [[wikilink]] titles) for context.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Catalog label ids — call list_labels FIRST; unknown ids are rejected.",
      },
      tags: { type: "array", items: { type: "string" }, description: "Freeform short tags." },
      dueAt: { type: "string", description: "Structured ISO target date." },
      priority: { type: "string", enum: PRIORITY, description: "Triage priority P0..P3." },
    },
    required: ["title", "initiativeId"],
  },
};

const SET_PARENT_TOOL = {
  name: "set_parent",
  description:
    "Re-parent (or detach) a single node in the hierarchy. Move a Case or Workstream UNDER a new " +
    "container by passing `parentId` (an Initiative or Workstream id), or pass `parentId: null` to " +
    "DETACH a leaf Case to top-level. Detaching a Workstream to top-level is ILLEGAL (convert it to " +
    "an Initiative with update_case { kind:'initiative' } instead). The board enforces the tier " +
    "rules (no cycles, depth ≤ 3, parent must be a container) and rejects an illegal move with a 400. " +
    "`PATCH /api/cases/{id} { parentId }`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The node to move, e.g. 'CASE-5'." },
      parentId: {
        type: ["string", "null"],
        description:
          "New parent Initiative/Workstream id, or null to detach the node to top-level (leaf only).",
      },
    },
    required: ["id"],
  },
};

const REGROUP_CASES_TOOL = {
  name: "regroup_cases",
  description:
    "Group several cases UNDER one Initiative or Workstream in a single sweep — the headline " +
    "'organise these cases' verb. Applies `parentId` to every id in `ids` (pass parentId:null to " +
    "detach them all to top-level). If ANY id would violate the tier rules the WHOLE batch is " +
    "rejected (400). Call get_tree first to pick the right container. " +
    "`PATCH /api/cases { ids, patch:{ parentId } }`.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Case ids to regroup, e.g. ['CASE-5','CASE-6'].",
      },
      parentId: {
        type: ["string", "null"],
        description:
          "The Initiative/Workstream id to file them all under, or null to detach them to top-level.",
      },
    },
    required: ["ids"],
  },
};

const GET_TREE_TOOL = {
  name: "get_tree",
  description:
    "Read the board's HIERARCHY as an indented outline: Initiative > Workstream > Case, with each " +
    "container's rollup (done/total leaf cases) and child count. Read-only. Pass `rootId` to print " +
    "only that subtree. CALL THIS FIRST before creating a case/initiative/workstream to find the " +
    "right place to nest it and avoid duplicating a theme. Set `includeArchived` to also show " +
    "archived nodes; `domain` filters to 'work' or 'life' roots. `GET /api/tree`. " +
    "Archived/deleted (Trash) nodes are HIDDEN by default — you MUST also call `search` " +
    "(which surfaces Trash) before create_* to avoid duplicating a soft-deleted matter.",
  inputSchema: {
    type: "object",
    properties: {
      rootId: { type: "string", description: "Print only this node's subtree (e.g. 'CASE-3')." },
      includeArchived: { type: "boolean", description: "Include archived nodes. Defaults to false." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Restrict to 'work' or 'life' roots." },
    },
  },
};

const LIST_INITIATIVES_TOOL = {
  name: "list_initiatives",
  description:
    "List the top-tier INITIATIVES — one line each with its rollup (done/total cases) and its " +
    "workstream + case counts. Read-only. Use to see the big themes at a glance before nesting new " +
    "work; drill into one with get_tree(rootId). `GET /api/tree` (top level). `domain` filters to " +
    "'work' or 'life'. Archived/deleted (Trash) nodes are HIDDEN by default — you MUST also call " +
    "`search` (which surfaces Trash) before create_* to avoid duplicating a soft-deleted matter.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", enum: CASE_DOMAIN, description: "Restrict to 'work' or 'life'." },
      includeArchived: { type: "boolean", description: "Include archived initiatives. Defaults to false." },
    },
  },
};

const ADD_TASK_TOOL = {
  name: "add_task",
  description:
    "Append a task to a case's checklist. The task drives the card's done/total counter. " +
    "Defaults to status 'open'. Set `dueAt` (ISO date) for a per-task deadline.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      title: { type: "string", description: "Task title." },
      detail: { type: "string", description: "Optional detail / context." },
      status: { type: "string", enum: TASK_STATUS, description: "Defaults to 'open'." },
      owner: { type: "string", description: "Who the task is on." },
      dueAt: { type: "string", description: "ISO due date for this task." },
    },
    required: ["id", "title"],
  },
};

const UPDATE_TASK_TOOL = {
  name: "update_task",
  description:
    "Update a task on a case. Pass only the fields you want to change. Setting `status` to " +
    "'done' stamps the task's completedAt. To just mark a task done, prefer complete_task. " +
    "Set `dueAt` for a per-task deadline.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      taskId: { type: "string", description: "Task id, e.g. 'CASE-1-T1'." },
      title: { type: "string", description: "New task title." },
      detail: { type: "string", description: "New detail." },
      status: { type: "string", enum: TASK_STATUS, description: "New task status." },
      owner: { type: "string", description: "New owner." },
      dueAt: { type: "string", description: "ISO due date for this task." },
    },
    required: ["id", "taskId"],
  },
};

const COMPLETE_TASK_TOOL = {
  name: "complete_task",
  description:
    "Mark a task done — sugar for update_task with status 'done' (which also stamps completedAt).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      taskId: { type: "string", description: "Task id, e.g. 'CASE-1-T1'." },
    },
    required: ["id", "taskId"],
  },
};

const DELETE_TASK_TOOL = {
  name: "delete_task",
  description:
    "Remove a task from a case's checklist. The task is spliced out (this is a hard delete of " +
    "the task, not a completion). Prefer complete_task when the work is actually done.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      taskId: { type: "string", description: "Task id, e.g. 'CASE-1-T1'." },
    },
    required: ["id", "taskId"],
  },
};

const ADD_NOTE_TOOL = {
  name: "add_note",
  description:
    "Append a freeform note to a case's running notes. Use for context, observations, or a " +
    "trail of reasoning that isn't a task or a message. The note is attributed to the agent.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
      body: { type: "string", description: "The note text." },
    },
    required: ["id", "body"],
  },
};

const LINK_MESSAGE_TOOL = {
  name: "link_message",
  description:
    "Create a message and link it to a case (its id is pushed onto the case's messageIds). Use " +
    "this to attach an inbound email, a chat, an agent note, or a system event to the case it " +
    "belongs to, so the case carries its conversation trail. " +
    "AUTOMATIC TRUST: when you link the USER's OWN sent mail, pass `outbound: true` plus the `to` " +
    "(and `cc`) recipients — the board then auto-derives those correspondents as `trusted` in the " +
    "guard whitelist (trust-on-first-reply, deterministic, no separate trust call). Set `outbound` " +
    "ONLY for sent messages; never for received mail.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id to link the message to, e.g. 'CASE-1'." },
      source: {
        type: "string",
        enum: MESSAGE_SOURCE,
        description: "Where the message came from.",
      },
      from: { type: "string", description: "Sender — an email address, name, or system id." },
      to: {
        type: "array",
        items: { type: "string" },
        description:
          "Recipient (To) addresses. Accepts 'Name <addr>' forms (normalized to bare addresses). On " +
          "an OUTBOUND message these are who the user wrote to — the basis for automatic trust.",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description:
          "Cc recipient addresses (stored for the inbox Cc filter). Trusted only on an ORIGINATION " +
          "(a message the user sent FIRST) — never on a reply-all to a thread someone else started.",
      },
      outbound: {
        type: "boolean",
        description:
          "TRUE iff this is the USER's OWN sent mail (from the Gmail SENT scan). The unspoofable signal " +
          "that drives automatic trust; recipients the user replied to / wrote 1:1 to / originated a " +
          "conversation with become `trusted`. NEVER set it for received mail (default false).",
      },
      subject: { type: "string", description: "Subject / title." },
      preview: { type: "string", description: "Short preview line." },
      body: { type: "string", description: "Full message body." },
      receivedAt: { type: "string", description: "ISO timestamp; defaults to now." },
      read: { type: "boolean", description: "Whether the message is read. Defaults false." },
      url: {
        type: "string",
        description:
          "Direct deep-link back to the ORIGINAL message so the board/UI can jump straight to it. For Gmail pass the " +
          "thread URL https://mail.google.com/mail/u/0/#all/<threadId> (use the Gmail threadId you already have; u/0 is " +
          "the signed-in account index). ALWAYS pass this when linking an email. Stored only if it is an absolute http(s) URL.",
      },
    },
    required: ["id", "source", "from"],
  },
};

const UPDATE_MESSAGE_TOOL = {
  name: "update_message",
  description:
    "Update an existing message by id (e.g. 'M-1'). Set `read` to flip its read flag. Set " +
    "`caseId` to link or relink the message to a case — both sides are maintained server-side " +
    "(the case's messageIds and the message's caseId). Pass `caseId: null` to UNLINK the message " +
    "from any case. Set `url` to attach (or, with null, clear) the direct deep-link back to the " +
    "ORIGINAL message (the Gmail thread URL) so the board/UI can jump straight to it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Message id, e.g. 'M-1'." },
      read: { type: "boolean", description: "Mark read (true) or unread (false)." },
      caseId: {
        type: ["string", "null"],
        description: "Case id to (re)link the message to (e.g. 'CASE-2'); pass null to unlink it from any case.",
      },
      url: {
        type: ["string", "null"],
        description:
          "Direct deep-link back to the ORIGINAL message — set it (the Gmail thread URL " +
          "https://mail.google.com/mail/u/0/#all/<threadId>, u/0 is the signed-in account index) so the board/UI can " +
          "jump straight to it, or pass null to CLEAR it. Stored only if it is an absolute http(s) URL.",
      },
    },
    required: ["id"],
  },
};

const ADD_UNANSWERED_MESSAGE_TOOL = {
  name: "add_unanswered_message",
  description:
    "Store a brand-new message and FLAG it as awaiting a reply (it appears in the board's " +
    "'Unanswered messages' view until marked answered). Use this for an inbound email or chat the " +
    "USER still owes a reply to that generated no case / reminder / event of its own — it would " +
    "otherwise be silently forgotten. The message is created STANDALONE (linked to nothing); pass " +
    "`caseId` and/or `reminderId` to ALSO link it to a matter you already found. `needsAnswer` " +
    "defaults to true server-side. " +
    "`POST /api/messages`.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: MESSAGE_SOURCE,
        description: "Where the message came from.",
      },
      from: { type: "string", description: "Sender — an email address, name, or system id (the 'who')." },
      subject: { type: "string", description: "Subject / title." },
      preview: { type: "string", description: "Short preview line." },
      body: { type: "string", description: "Full message body (the message itself)." },
      receivedAt: { type: "string", description: "ISO timestamp; defaults to now (the 'date')." },
      context: {
        type: "string",
        description:
          "A ONE-SENTENCE context shown in the unanswered view — what they're asking and the " +
          "person's role, e.g. 'Sara (landlord) is asking when you'll sign the renewal.'",
      },
      caseId: { type: "string", description: "OPTIONAL case id to ALSO link the message to, e.g. 'CASE-1'." },
      reminderId: { type: "string", description: "OPTIONAL reminder id to ALSO link the message to, e.g. 'REM-1'." },
      read: { type: "boolean", description: "Whether the message is read. Defaults false." },
      url: {
        type: "string",
        description:
          "Direct deep-link back to the ORIGINAL message so the board/UI can jump straight to it. For Gmail pass the " +
          "thread URL https://mail.google.com/mail/u/0/#all/<threadId> (use the Gmail threadId you already have; u/0 is " +
          "the signed-in account index). Stored only if it is an absolute http(s) URL.",
      },
    },
    required: ["source", "from"],
  },
};

const MARK_MESSAGE_UNANSWERED_TOOL = {
  name: "mark_message_unanswered",
  description:
    "Flag an EXISTING message (already linked to a case/reminder, or standalone) as awaiting a " +
    "reply, so it appears in the board's 'Unanswered messages' view. Use this when the message is " +
    "already on the board (you found it via search / list_unanswered_messages) — use " +
    "add_unanswered_message instead to store a brand-new one. " +
    "`PATCH /api/messages/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Message id, e.g. 'M-1'." },
      context: {
        type: "string",
        description:
          "OPTIONAL one-sentence context shown in the unanswered view (what they're asking; the " +
          "person's role woven in).",
      },
    },
    required: ["id"],
  },
};

const MARK_MESSAGE_ANSWERED_TOOL = {
  name: "mark_message_answered",
  description:
    "Mark a message as ANSWERED — a pure status flip that removes it from the board's 'Unanswered " +
    "messages' view (it stamps `answeredAt`). Use this once the USER has replied. It does NOT " +
    "cascade to any linked case / reminder (no lane move, no reminder close). " +
    "`PATCH /api/messages/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Message id, e.g. 'M-1'." },
    },
    required: ["id"],
  },
};

const LIST_UNANSWERED_MESSAGES_TOOL = {
  name: "list_unanswered_messages",
  description:
    "List every message the USER still owes a reply to (flagged needsAnswer and not yet answered), " +
    "newest first — the contents of the board's 'Unanswered messages' view. Use it to dedup before " +
    "flagging (so you don't store one twice) and to see what's outstanding. " +
    "`GET /api/messages?status=unanswered`.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "OPTIONAL max number of messages to show (applied when summarizing; defaults to all).",
      },
    },
  },
};

// ── Reminders (8) ──────────────────────────────────────────────────────────
// A reminder is a LIGHTWEIGHT NUDGE — "a reminder to CHECK or to DO something" —
// for a minor matter that doesn't justify a full Case (no kanban lanes, no
// hierarchy of its own). It is RICHER than a bare note though: a reminder may
// carry catalog `labels`, a SHORT `tasks` checklist (concise, NOT full Tasks),
// and LINKED EMAILS — attach a multitude of emails about ONE matter to ONE
// reminder via link_reminder_message (message.reminderId is the single source of
// truth for that link). It can also OPTIONALLY point at ONE board node it
// concerns via `caseId` (an Initiative/Workstream/Case — all share one CASE-<n>
// id space), and the node lists its reminders by filtering on that caseId.
// Reminders ride the board MCP/API (no separate server or port).

const CREATE_REMINDER_TOOL = {
  name: "create_reminder",
  description:
    "Open a REMINDER on the Cos board — a SIMPLE, lightweight NUDGE to CHECK or DO " +
    "something, deliberately LIGHTER than a case (no tasks, no kanban lanes, no hierarchy of its own). " +
    "Use it for a one-line 'remember to …' / 'check whether …' nudge, not for a unit of work (open a " +
    "case for that). " +
    "PREFER LINKING: before creating one, this agent ALSO has the board case tools — call `search` " +
    "(several queries) AND `get_tree` FIRST to find the Initiative/Workstream/Case the reminder " +
    "concerns. If a node matches, set `caseId` to it so that node lists the reminder (caseId is the " +
    "SINGLE SOURCE OF TRUTH for the link, and works for ANY tier — initiative, workstream, or case). " +
    "If nothing matches, create it STANDALONE (omit caseId). " +
    "`POST /api/reminders`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The nudge itself, e.g. 'Check the trip dates against the Tech Deep Dive dates'." },
      detail: { type: "string", description: "Optional elaboration / context." },
      status: {
        type: "string",
        enum: REMINDER_STATUS,
        description: "Reminder state: 'open' (default), 'done', or 'dismissed'.",
      },
      dueAt: {
        type: "string",
        description:
          "When to be reminded / when the check is due, as an ISO date ('2026-06-15') or full ISO " +
          "datetime. This is the sortable signal.",
      },
      domain: {
        type: "string",
        enum: CASE_DOMAIN,
        description: "'work' or 'life' — optional/advisory (may mirror the linked node's domain).",
      },
      caseId: {
        type: "string",
        description:
          "OPTIONAL link to the board node this reminder concerns — the id of ANY tier " +
          "(Initiative/Workstream/Case, e.g. 'CASE-3'). Set it when a node matches (search/get_tree " +
          "FIRST) so that node lists the reminder; omit for a standalone nudge. The board rejects a " +
          "caseId that doesn't exist with a 400.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Catalog label ids; call list_labels FIRST; UNKNOWN ids are REJECTED.",
      },
      tasks: {
        type: "array",
        description: "A short checklist of { title, done? } items.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            done: { type: "boolean" },
          },
          required: ["title"],
        },
      },
    },
    required: ["title"],
  },
};

const LIST_REMINDERS_TOOL = {
  name: "list_reminders",
  description:
    "List reminders on the board — the lightweight nudges (CHECK/DO items), one compact line each " +
    "(status · due · title · linked caseId). Read-only. Filter by `status`, by the linked `caseId` " +
    "(to see a node's reminders), and/or by `domain`. `GET /api/reminders`.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: REMINDER_STATUS, description: "Restrict to 'open' | 'done' | 'dismissed'." },
      caseId: { type: "string", description: "Only reminders linked to this node id (e.g. 'CASE-3')." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Restrict to 'work' or 'life'." },
    },
  },
};

const GET_REMINDER_TOOL = {
  name: "get_reminder",
  description:
    "Fetch a single reminder by id (e.g. 'REM-1'). Returns its title, status, detail, dueAt, and " +
    "domain, plus the board node it is linked to (its `caseId`) or that it is standalone. Read-only. " +
    "`GET /api/reminders/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id, e.g. 'REM-1'." },
    },
    required: ["id"],
  },
};

const UPDATE_REMINDER_TOOL = {
  name: "update_reminder",
  description:
    "Update a reminder's fields. Pass only what you want to change: `title`, `detail`, `status` " +
    "('open'|'done'|'dismissed'), `dueAt` (ISO), `domain` ('work'|'life'), and/or `caseId` to relink " +
    "it to the node it concerns (pass `caseId: null` to UNLINK it to standalone). Setting status to " +
    "'done' stamps completedAt. `PATCH /api/reminders/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id, e.g. 'REM-1'." },
      title: { type: "string", description: "New nudge text." },
      detail: { type: "string", description: "New elaboration / context." },
      status: { type: "string", enum: REMINDER_STATUS, description: "New status: 'open' | 'done' | 'dismissed'." },
      dueAt: { type: "string", description: "New ISO due date / datetime." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Refile to 'work' or 'life'." },
      caseId: {
        type: ["string", "null"],
        description: "Relink to this node id (e.g. 'CASE-2'), or pass null to UNLINK it to standalone.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Catalog label ids; call list_labels FIRST; UNKNOWN ids are REJECTED.",
      },
      tasks: {
        type: "array",
        description: "A short checklist of { title, done? } items.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            done: { type: "boolean" },
          },
          required: ["title"],
        },
      },
    },
    required: ["id"],
  },
};

const COMPLETE_REMINDER_TOOL = {
  name: "complete_reminder",
  description:
    "Mark a reminder done — sugar for update_reminder with status 'done' (which also stamps " +
    "completedAt). Use when you did/checked the thing the reminder was nudging. " +
    "`PATCH /api/reminders/{id} { status: 'done' }`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id, e.g. 'REM-1'." },
    },
    required: ["id"],
  },
};

const DELETE_REMINDER_TOOL = {
  name: "delete_reminder",
  description:
    "Delete a reminder by id (a hard remove — reminders have no soft-archive). Prefer " +
    "complete_reminder / status 'dismissed' when the nudge is simply resolved. " +
    "`DELETE /api/reminders/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id, e.g. 'REM-1'." },
    },
    required: ["id"],
  },
};

const LINK_REMINDER_TOOL = {
  name: "link_reminder",
  description:
    "Attach a reminder to the board node it concerns (or detach it) — sugar for update_reminder's " +
    "caseId. Set `caseId` to the id of ANY tier (Initiative/Workstream/Case) so that node lists the " +
    "reminder; pass null/empty to UNLINK it to standalone. caseId is the SINGLE SOURCE OF TRUTH for " +
    "the link. PREFER LINKING: when a reminder concerns a real matter, find the node with `search` + " +
    "`get_tree` FIRST and link it here so it surfaces alongside that node's work. " +
    "`PATCH /api/reminders/{id} { caseId }`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id, e.g. 'REM-1'." },
      caseId: {
        type: ["string", "null"],
        description:
          "The node id to link the reminder to (e.g. 'CASE-3' — any tier), or null/empty to unlink it.",
      },
    },
    required: ["id"],
  },
};

const LINK_REMINDER_MESSAGE_TOOL = {
  name: "link_reminder_message",
  description:
    "Create a message and link it to a REMINDER (its `reminderId` is set to this reminder). Use this " +
    "to attach an inbound email (a chat, an agent note, a system event) to the reminder it belongs to, " +
    "so MANY emails about ONE matter (e.g. a billing notice) hang off a single reminder. A message may " +
    "link to a case AND/OR a reminder (the two links are independent). The reminder must exist. " +
    "AUTOMATIC TRUST: a reminder is a first-class trust source, exactly like a case. When you link the " +
    "USER's OWN sent mail, pass `outbound: true` plus the `to` (and `cc`) recipients — the board " +
    "auto-derives those correspondents as `trusted` from the reminder's own message set (same rule as " +
    "a case). Set `outbound` ONLY for sent messages; never for received mail. " +
    "`POST /api/reminders/{id}/messages`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder id to link the message to, e.g. 'REM-1'." },
      source: {
        type: "string",
        enum: MESSAGE_SOURCE,
        description: "Where the message came from.",
      },
      from: { type: "string", description: "Sender — an email address, name, or system id." },
      to: {
        type: "array",
        items: { type: "string" },
        description:
          "Recipient (To) addresses. Accepts 'Name <addr>' forms (normalized to bare addresses). On " +
          "an OUTBOUND message these are who the user wrote to — the basis for automatic trust.",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description:
          "Cc recipient addresses (stored for the inbox Cc filter). Trusted only on an ORIGINATION " +
          "(a message the user sent FIRST) — never on a reply-all.",
      },
      outbound: {
        type: "boolean",
        description:
          "TRUE iff this is the USER's OWN sent mail (from the Gmail SENT scan). The unspoofable signal " +
          "that drives automatic trust; recipients the user replied to / wrote 1:1 to / originated a " +
          "conversation with become `trusted`. NEVER set it for received mail (default false).",
      },
      subject: { type: "string", description: "Subject / title." },
      preview: { type: "string", description: "Short preview line." },
      body: { type: "string", description: "Full message body." },
      receivedAt: { type: "string", description: "ISO timestamp; defaults to now." },
      read: { type: "boolean", description: "Whether the message is read. Defaults false." },
      url: {
        type: "string",
        description:
          "Direct deep-link back to the ORIGINAL message so the board/UI can jump straight to it. For Gmail pass the " +
          "thread URL https://mail.google.com/mail/u/0/#all/<threadId> (use the Gmail threadId you already have; u/0 is " +
          "the signed-in account index). ALWAYS pass this when linking an email. Stored only if it is an absolute http(s) URL.",
      },
    },
    required: ["id", "source", "from"],
  },
};

// ── Priorities (5) ───────────────────────────────────────────────────────────
// "What matters most right now." Two complementary mechanisms, both READ back by
// get_priorities so the agent can ALIGN its work to the user's stated focus:
//   (1) STAR a node — a favorite/pin toggle on ANY case/workstream/initiative (all
//       three tiers share one CASE-<n> id space). set_starred flips it; starred
//       nodes surface in get_priorities and on the Priorities page.
//   (2) PRIORITY NOTES — free-text "top of mind" items in the user's OWN words, a
//       NEW lightweight entity (id PRI-<n>) — lighter than a reminder (no status,
//       link, tasks, or labels). add/update/remove_priority manage them.
// Priorities ride the board MCP/API (no separate server or port), exactly like
// reminders. starring is just PATCH /api/cases/{id} { starred }; the notes live at
// /api/priorities (+ /api/priorities/{id}).

const GET_PRIORITIES_TOOL = {
  name: "get_priorities",
  description:
    "Read WHAT THE USER CARES ABOUT MOST so you can ALIGN your work and triage to it. Returns the " +
    "user's STARRED nodes — the cases / workstreams / initiatives they pinned as favorites — PLUS their " +
    "free-text PRIORITY NOTES (their own words for what matters right now). Read-only. Call this to " +
    "ground a sweep or a plan in the user's stated priorities before you act. `GET /api/priorities`.",
  inputSchema: { type: "object", properties: {} },
};

const ADD_PRIORITY_TOOL = {
  name: "add_priority",
  description:
    "Add a free-text PRIORITY NOTE — a 'top of mind' item in plain words (e.g. 'Close the Acme deal " +
    "this week'). Deliberately lighter than a case or a reminder (no status, link, tasks, or labels). " +
    "These are the user's own words for what matters; agents READ them via get_priorities to align. " +
    "`POST /api/priorities`.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The priority in plain words, e.g. 'Close the Acme deal this week'." },
      position: {
        type: "number",
        description: "Manual rank within the list (smaller = higher priority). Omit to sort last.",
      },
    },
    required: ["text"],
  },
};

const UPDATE_PRIORITY_TOOL = {
  name: "update_priority",
  description:
    "Update a priority note's text and/or its manual rank. Pass only what you want to change. " +
    "`PATCH /api/priorities/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Priority note id, e.g. 'PRI-1'." },
      text: { type: "string", description: "New text (the priority in plain words)." },
      position: {
        type: "number",
        description: "New manual rank (smaller = higher priority).",
      },
    },
    required: ["id"],
  },
};

const REMOVE_PRIORITY_TOOL = {
  name: "remove_priority",
  description:
    "Remove a priority note by id (a hard delete — priority notes have no soft-archive). Use when the " +
    "user no longer wants it on their list. `DELETE /api/priorities/{id}`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Priority note id, e.g. 'PRI-1'." },
    },
    required: ["id"],
  },
};

const SET_STARRED_TOOL = {
  name: "set_starred",
  description:
    "Star or unstar ANY node — a case, workstream, or initiative (all three tiers share one CASE-<n> " +
    "id space). The star is the user-facing favorite/pin: starred nodes surface in get_priorities and " +
    "on the Priorities page. Pass `starred: true` to pin, `false` to unpin. " +
    "`PATCH /api/cases/{id} { starred }`.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The node to (un)star, e.g. 'CASE-1' (any tier)." },
      starred: { type: "boolean", description: "true to star (pin), false to unstar." },
    },
    required: ["id", "starred"],
  },
};

const ARCHIVE_CASE_TOOL = {
  name: "archive_case",
  description:
    "Soft-archive a case: it gets an archivedAt stamp and is hidden from the default board, but " +
    "nothing is destroyed. Archived is NOT the same as done. Undo with restore_case. Prefer this " +
    "over delete_case for anything you might want back." +
    " Do not archive a case the user is actively working (check get_case for recent manual actions first).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
    },
    required: ["id"],
  },
};

const RESTORE_CASE_TOOL = {
  name: "restore_case",
  description:
    "Un-archive a case: clears its archivedAt so it returns to the default board. The inverse of " +
    "archive_case." +
    " Do not restore a case the user deliberately archived by hand unless asked.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
    },
    required: ["id"],
  },
};

const DELETE_CASE_TOOL = {
  name: "delete_case",
  description:
    "Delete a case — a SOFT delete (Trash): sets archivedAt, hidden from the default board, fully " +
    "restorable with restore_case. Nothing is destroyed; permanent removal is automatic after the " +
    "retention window. Identical wire behaviour to archive_case.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Case id, e.g. 'CASE-1'." },
    },
    required: ["id"],
  },
};

const SEARCH_TOOL = {
  name: "search",
  description:
    "Search the board across case titles/summaries/tags/labels, task titles, " +
    "and message subjects/senders/bodies. Semantic + keyword (fuzzy, not just substring). Read-only. " +
    "Accepts EITHER a single `q` OR an array of `queries`, plus optional `k` (top-K per query, default 10) " +
    "and `types`/`domain`/`status` filters. ALWAYS SEARCH BEFORE create_case / update_case: before opening " +
    "a new case, run SEVERAL queries at once — the person/entity name, the vault entity, and the topic — " +
    "to find an existing case on the same matter. If a strong match comes back, UPDATE that " +
    "case (update_case / add_task / link_message) instead of creating a duplicate; only create_case when " +
    "nothing matches. Archived (closed) cases ARE included by default so already-handled matters surface for " +
    "dedupe: a strong match that is archived or in the `done` lane means the work is already done, so link/note " +
    "it rather than recreating. Hits flag a closed match as [done] and/or [·archived]. Pass " +
    "`includeArchived: false` to exclude archived cases. REMINDERS are searched too (including DONE " +
    "ones — reminders have no archive); each hit flags its NATURE so you can tell a [case]/[task]/" +
    "[message]/[reminder] match apart. Returns ranked hits per query (cases, tasks, messages, reminders).",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", description: "Single search query (substring/semantic)." },
      queries: { type: "array", items: { type: "string" },
        description: "Several queries to run at once for dedupe — e.g. [person/entity name, vault entity, topic]." },
      k: { type: "integer", description: "Top-K hits per query. Default 10 (max 50)." },
      types: { type: "array", items: { type: "string", enum: ["case", "task", "message", "reminder"] }, description: "Restrict to these doc types." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Restrict to 'work' or 'life'." },
      status: { type: "string", enum: CASE_STATUS, description: "Restrict to a lane (e.g. 'done' for already-completed matters)." },
      includeArchived: { type: "boolean", description: "Include archived (closed) cases. Defaults to TRUE so pre-create dedupe surfaces already-handled matters and you can infer a matter is done instead of recreating it. Pass false to exclude archived cases." },
    },
  },
};

const LIST_TEMPLATES_TOOL = {
  name: "list_templates",
  description:
    "List the built-in case templates (e.g. a developer-tooling onboarding doc-checklist and a " +
    "generic follow-up). Read-only. Use to discover a template id, then apply_template to " +
    "stamp out a pre-filled case.",
  inputSchema: { type: "object", properties: {} },
};

const APPLY_TEMPLATE_TOOL = {
  name: "apply_template",
  description:
    "Create a new case from a built-in template (see list_templates for ids). `overrides` are " +
    "merged onto the template (e.g. { title, domain, priority, dueAt }) so you can customise the " +
    "stamped-out case. Goes through the same create path as create_case.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Template id (from list_templates)." },
      overrides: {
        type: "object",
        description: "Fields to override/add on the templated case, e.g. { title, domain, dueAt }.",
      },
    },
    required: ["id"],
  },
};

const LIST_PENDING_TOOL = {
  name: "list_pending",
  description:
    "List the board's pending approval queue — agent-proposed mutations awaiting a human " +
    "approve/reject. Read-only. Each entry has an id, the proposed verb + payload, and a summary.",
  inputSchema: { type: "object", properties: {} },
};

const LIST_LABELS_TOOL = {
  name: "list_labels",
  description:
    "List the board's active LABEL CATALOG — the configurable taxonomy used to categorize cases. " +
    "Read-only. Returns every label's id, title, description (the description tells you WHEN the " +
    "label applies), colour, and originating bundle. ALWAYS call this BEFORE setting `labels` on a " +
    "create_case / update_case / update_cases — assigning an id that isn't in the catalog is rejected, " +
    "so fetch the valid ids first and choose the ones whose descriptions match the case.",
  inputSchema: { type: "object", properties: {} },
};

const LIST_LABEL_BUNDLES_TOOL = {
  name: "list_label_bundles",
  description:
    "List the built-in installable label BUNDLES — themed packs of labels for a role (manager, sales, " +
    "IT, developer-tooling, …), a life area (health, travel, finance, …), or the universal cross-cutting " +
    "set. Read-only. Use to discover a bundle id, then install_label_bundle to add its labels to the " +
    "active catalog. Each bundle reports how many of its labels are already installed.",
  inputSchema: { type: "object", properties: {} },
};

const INSTALL_LABEL_BUNDLE_TOOL = {
  name: "install_label_bundle",
  description:
    "Install a label bundle into the active catalog (see list_label_bundles for ids). Idempotent — " +
    "labels already present are skipped. Use to set up a user's taxonomy so its labels become available " +
    "for case operations and the board's filter. Returns the ids actually added.",
  inputSchema: {
    type: "object",
    properties: {
      bundleId: { type: "string", description: "Bundle id from list_label_bundles, e.g. 'manager'." },
    },
    required: ["bundleId"],
  },
};

const UNINSTALL_LABEL_BUNDLE_TOOL = {
  name: "uninstall_label_bundle",
  description:
    "Uninstall a label bundle: remove the labels it owns from the active catalog (the inverse of " +
    "install_label_bundle). Labels shared with another installed bundle, and custom labels, are kept. " +
    "By default the removed ids are also stripped from any cases that use them; pass scrub:false to keep " +
    "those (now dangling) references. Returns the removed ids.",
  inputSchema: {
    type: "object",
    properties: {
      bundleId: { type: "string", description: "Bundle id to uninstall, e.g. 'manager'." },
      scrub: {
        type: "boolean",
        description: "Also remove the labels from cases that use them. Defaults to true.",
      },
    },
    required: ["bundleId"],
  },
};

const PROPOSE_TOOL = {
  name: "propose",
  description:
    "Propose a board mutation for human approval instead of doing it directly. The proposal lands " +
    "in the pending queue; on approve it is COMMITTED through the matching verb. Use for changes " +
    "that should have a human in the loop. `verb` is the board verb to run (e.g. 'update_case', " +
    "'move', 'archive', 'restore'), `payload` its arguments, `summary` a one-line human-readable description.",
  inputSchema: {
    type: "object",
    properties: {
      verb: { type: "string", description: "The board verb to run on approval, e.g. 'update_case', 'move', 'archive', 'restore'." },
      target: { type: "string", description: "Optional target id the verb acts on, e.g. 'CASE-1'." },
      payload: {
        type: "object",
        description: "Arguments for the verb (the same shape that verb's tool would take).",
      },
      summary: { type: "string", description: "One-line human-readable description of the proposal." },
    },
    required: ["verb", "payload", "summary"],
  },
};

const APPROVE_TOOL = {
  name: "approve",
  description:
    "Approve a pending proposal by id — the board commits it through the matching verb and marks " +
    "the proposal approved. See list_pending for ids.",
  inputSchema: {
    type: "object",
    properties: {
      pendingId: { type: "string", description: "Pending proposal id." },
    },
    required: ["pendingId"],
  },
};

const REJECT_TOOL = {
  name: "reject",
  description:
    "Reject a pending proposal by id — it is marked rejected and never committed. See list_pending " +
    "for ids.",
  inputSchema: {
    type: "object",
    properties: {
      pendingId: { type: "string", description: "Pending proposal id." },
    },
    required: ["pendingId"],
  },
};

// MAINTENANCE: adding a tool means touching FOUR places — the tool def + this
// TOOLS array (here), the dispatch switch in server.mjs, and the README.
export const TOOLS = [
  // reads
  GET_CASE_TOOL,
  SEARCH_TOOL,
  LIST_TEMPLATES_TOOL,
  LIST_PENDING_TOOL,
  LIST_LABELS_TOOL,
  LIST_LABEL_BUNDLES_TOOL,
  GET_TREE_TOOL,
  LIST_INITIATIVES_TOOL,
  // case lifecycle
  CREATE_CASE_TOOL,
  UPDATE_CASE_TOOL,
  UPDATE_CASES_TOOL,
  ARCHIVE_CASE_TOOL,
  RESTORE_CASE_TOOL,
  DELETE_CASE_TOOL,
  APPLY_TEMPLATE_TOOL,
  // hierarchy (Initiatives & Workstreams)
  CREATE_INITIATIVE_TOOL,
  CREATE_WORKSTREAM_TOOL,
  SET_PARENT_TOOL,
  REGROUP_CASES_TOOL,
  // tasks
  ADD_TASK_TOOL,
  UPDATE_TASK_TOOL,
  COMPLETE_TASK_TOOL,
  DELETE_TASK_TOOL,
  // notes
  ADD_NOTE_TOOL,
  // messages
  LINK_MESSAGE_TOOL,
  UPDATE_MESSAGE_TOOL,
  ADD_UNANSWERED_MESSAGE_TOOL,
  MARK_MESSAGE_UNANSWERED_TOOL,
  MARK_MESSAGE_ANSWERED_TOOL,
  LIST_UNANSWERED_MESSAGES_TOOL,
  // reminders (8)
  CREATE_REMINDER_TOOL,
  LIST_REMINDERS_TOOL,
  GET_REMINDER_TOOL,
  UPDATE_REMINDER_TOOL,
  COMPLETE_REMINDER_TOOL,
  DELETE_REMINDER_TOOL,
  LINK_REMINDER_TOOL,
  LINK_REMINDER_MESSAGE_TOOL,
  // priorities (5)
  GET_PRIORITIES_TOOL,
  ADD_PRIORITY_TOOL,
  UPDATE_PRIORITY_TOOL,
  REMOVE_PRIORITY_TOOL,
  SET_STARRED_TOOL,
  // labels (taxonomy config)
  INSTALL_LABEL_BUNDLE_TOOL,
  UNINSTALL_LABEL_BUNDLE_TOOL,
  // approval queue
  PROPOSE_TOOL,
  APPROVE_TOOL,
  REJECT_TOOL,
];
