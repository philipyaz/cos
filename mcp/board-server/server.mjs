#!/usr/bin/env node
// MCP server (registry name "board") for the Cos board — the single
// to-do surface for both work and life. Every tool wraps the board HTTP API over
// `fetch` on CRM_BASE_URL; the server never shells out to curl. Runs over stdio;
// Claude Desktop bridges it into Cowork (Layer 1 / type:sdk), or front it with
// supergateway for the HTTP bridge.
//
// Actor attribution: every WRITE sends { actor: "agent" } in the body (and an
// `x-actor: agent` header as a belt-and-braces twin) so the board's activity log
// attributes the change to the agent, not a human. The board UI is the visual
// twin path that writes as "human".
//
// On READ, get_case surfaces the human-actor activity as a "Manual actions by the
// user" block (and the HTTP GET returns a `manualActions` array) — agents MUST NOT
// undo those deliberate edits.
//
// v3 toolset (the full case / task / message lifecycle + board ops):
//   reads   : get_case, search, list_templates, list_pending, list_labels,
//             list_label_bundles, get_tree, list_initiatives
//   devices : get_device_status (multi-device: role / lease / last-seen)
//   case    : create_case, update_case, update_cases (bulk), archive_case,
//             restore_case, delete_case (soft → Trash), apply_template
//   hierarchy: create_initiative, create_workstream, set_parent, regroup_cases
//   task    : add_task, update_task, complete_task, delete_task
//   notes   : add_note
//   message : link_message, update_message
//   reminder: create_reminder, list_reminders, get_reminder, update_reminder,
//             complete_reminder, delete_reminder, link_reminder, link_reminder_message
//   priority: get_priorities, add_priority, update_priority, remove_priority, set_starred
//   labels  : install_label_bundle, uninstall_label_bundle (configure the taxonomy)
//   approval: propose, approve, reject
//
// v3.2: reminders are ENRICHED — create_reminder/update_reminder carry catalog
// `labels` + a short `tasks` checklist, link_reminder_message attaches an email to
// a reminder (message.reminderId), and `search` indexes reminders (incl. DONE) and
// flags each hit's nature (case · task · message · reminder).
//
// v3.3: PRIORITIES — "what matters most right now." get_priorities READS the user's
// STARRED nodes (favorites/pins on any case/workstream/initiative — set with
// set_starred) PLUS their free-text PRIORITY NOTES (id PRI-<n>, the user's own words —
// add/update/remove_priority), so the agent can ALIGN its work to the user's focus.
// Priorities ride the board API (no new server/port); notes live at /api/priorities,
// starring is PATCH /api/cases/{id} { starred }.
//
// HIERARCHY (v3): the board is a strict 3-tier tree of MAX DEPTH 3, where ALL THREE
// tiers are the SAME CaseRecord (id CASE-<n>) distinguished by a `kind` field:
//   INITIATIVE  (Epic)      — a big work/life aspiration; NO parentId (a root).
//   WORKSTREAM  (Sub-Epic)  — a thread under an Initiative; parentId MUST be an Initiative.
//   CASE        (Issue/leaf)— today's unit of work; parentId OPTIONAL → an Initiative or Workstream.
// A workstream may contain only leaf cases; a leaf has no children. Detaching a
// workstream to top-level is illegal (convert it to an Initiative instead). The board
// REJECTS violations with a 400 — call get_tree / search FIRST to nest correctly.
//
// LABELS: cases can carry catalog-backed `labels` (a configurable taxonomy richer
// than freeform `tags`). ALWAYS call list_labels first to fetch valid ids + their
// meaning before setting `labels` on a case — the board rejects unknown ids with a
// 400 that lists the valid set, so fetching first avoids failed writes.
//
// Config: CRM_BASE_URL (default http://localhost:3000)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Shared MCP helpers (result shapers, env reader, transport boot, the board/calendar
// api() factory) live in the mcp-kit module, imported by RELATIVE path so launchd's
// direct `node .../server.mjs` resolves it without any workspace install. (The SDK
// transport is constructed HERE, from this server's own SDK, and handed to start.)
import { err, text, str, start, baseUrl, makeBoardApi } from "../../packages/mcp-kit/index.mjs";
// The declarative tool catalog (the FOO_TOOL defs + the TOOLS array) and the
// shared enums live in tools.mjs — pure data the handlers below validate against.
import {
  CASE_STATUS,
  TASK_STATUS,
  REMINDER_STATUS,
  CASE_DOMAIN,
  MESSAGE_SOURCE,
  PRIORITY,
  CASE_KIND,
  TOOLS,
} from "./tools.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");

const server = new Server(
  { name: "board", version: "3.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Single point where every tool talks to the board, parameterized "board" so a 409
// reads "the board changed". (err/text/str come from mcp-kit.)
const api = makeBoardApi("board", CRM_BASE_URL);

// ── Read tools ───────────────────────────────────────────────────────────────

async function handleGetCase(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");

  const { data, errorResult } = await api("GET", `/api/cases/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const c = data.case;
  const messages = data.messages ?? [];
  const kind = c.kind ?? "case";
  const tierLabel = kind === "initiative" ? "Initiative" : kind === "workstream" ? "Workstream" : "Case";
  const lines = [`${c.id} — ${c.title}`, `Tier: ${tierLabel}`, `Domain: ${c.domain ?? "work"}`, `Status: ${c.status}`];
  if (c.priority) lines.push(`Priority: ${c.priority}`);
  if (c.eta) lines.push(`ETA: ${c.eta}`);
  if (c.dueAt) lines.push(`Due: ${c.dueAt}`);
  if (c.archivedAt) lines.push(`Archived: ${c.archivedAt}`);
  if (c.snoozeUntil) lines.push(`Snoozed until: ${c.snoozeUntil}`);
  if (Array.isArray(c.tags) && c.tags.length) lines.push(`Tags: ${c.tags.join(", ")}`);
  if (Array.isArray(c.vaultLinks) && c.vaultLinks.length) {
    lines.push(`Vault context: ${c.vaultLinks.map((v) => `[[${v}]]`).join(", ")}`);
  }

  // Hierarchy context — the node's parent and (for a container) its children +
  // rollup, resolved from the tree. Best-effort: skipped if the tree can't be read.
  {
    const { data: treeData } = await api("GET", "/api/tree?includeArchived=1");
    const found = treeData ? findInForest(treeData.tree ?? [], c.id) : null;
    if (found?.parent) {
      lines.push(`Part of: ${found.parent.case.id} — ${found.parent.case.title}`);
    } else if (c.parentId) {
      lines.push(`Part of: ${c.parentId}`);
    }
    if (found && kind !== "case") {
      const r = found.node.rollup ?? {};
      const kids = found.node.children ?? [];
      lines.push(`Rollup: ${r.doneCases ?? 0}/${r.totalCases ?? 0} cases done · ${kids.length} direct child(ren)`);
      if (kids.length) {
        lines.push(`Children:`);
        for (const ch of kids) {
          const ck = ch.case.kind ?? "case";
          const tag = ck === "case" ? ch.case.status : ck === "workstream" ? "Workstream" : "Initiative";
          lines.push(`  - ${ch.case.id} [${tag}] ${ch.case.title}`);
        }
      }
    }
  }

  if (c.summary) lines.push(`\nSummary: ${c.summary}`);

  lines.push(`\nTasks (${c.tasks.length}):`);
  for (const t of c.tasks) {
    lines.push(
      `  - [${t.status}] ${t.id} — ${t.title}` +
        `${t.owner ? ` (owner: ${t.owner})` : ""}${t.dueAt ? ` [due ${t.dueAt}]` : ""}`
    );
    if (t.detail) lines.push(`      ${t.detail}`);
  }

  if (Array.isArray(c.notes) && c.notes.length) {
    lines.push(`\nNotes (${c.notes.length}):`);
    for (const n of c.notes) lines.push(`  - (${n.author}) ${n.body}`);
  }

  lines.push(`\nMessages (${messages.length}):`);
  for (const m of messages) {
    lines.push(`  - [${m.source}] ${m.from} — ${m.subject ?? ""}`);
  }

  if (Array.isArray(c.activity) && c.activity.length) {
    // Manual (human) actions FIRST, with an explicit do-NOT-undo warning — these
    // are the user's deliberate board edits; never revert them without instruction.
    const human = c.activity.filter((a) => a.actor === "human");
    if (human.length) {
      lines.push(
        `\n⚠ Manual actions by the user (human) — DO NOT undo, reopen, or override these without explicit instruction (${human.length}):`
      );
      for (const a of human) {
        lines.push(`  - ${a.ts} ${a.verb}${a.detail ? ` — ${a.detail}` : ""}`);
      }
    }
    const recent = c.activity.slice(-8);
    lines.push(`\nRecent activity — all actors (last ${recent.length} of ${c.activity.length}):`);
    for (const a of recent) {
      lines.push(`  - ${a.ts} ${a.actor} ${a.verb}${a.detail ? ` — ${a.detail}` : ""}`);
    }
  }

  lines.push(`\nBoard: ${CRM_BASE_URL}/my-issues`);
  return text(lines.join("\n"));
}

// Render a single-q GET result into the legacy block, byte-identical to the
// pre-semantic `search` output (extracted VERBATIM so single-q stays a perfect
// regression — see U3 spec). Returns the joined string; caller wraps in text().
function formatLegacy(q, data) {
  const cases = data.cases ?? [];
  const tasks = data.tasks ?? [];
  const messages = data.messages ?? [];
  // reminders is additive (the three existing arrays are unchanged); guard for an
  // older route that doesn't return it.
  const reminders = data.reminders ?? [];
  const lines = [`Search "${q}": ${cases.length} case(s), ${tasks.length} task(s), ${messages.length} message(s), ${reminders.length} reminder(s)`];

  if (cases.length) {
    lines.push(`\nCases:`);
    for (const c of cases) lines.push(`  - ${c.id} [${c.status}${c.archivedAt ? "·archived" : ""}] ${c.title}`);
  }
  if (tasks.length) {
    lines.push(`\nTasks:`);
    for (const t of tasks) lines.push(`  - ${t.caseId} / ${t.task.id} [${t.task.status}] ${t.task.title}`);
  }
  if (messages.length) {
    lines.push(`\nMessages:`);
    for (const m of messages) lines.push(`  - ${m.id} [${m.source}] ${m.from} — ${m.subject ?? ""}`);
  }
  if (reminders.length) {
    lines.push(`\nReminders:`);
    for (const r of reminders) lines.push(`  - ${r.id} [${r.status}] ${r.title}${r.caseId ? ` → ${r.caseId}` : ""}`);
  }
  if (!cases.length && !tasks.length && !messages.length && !reminders.length) lines.push(`\n(no matches)`);

  return lines.join("\n");
}

async function handleSearch(args) {
  const queries = Array.isArray(args.queries) ? args.queries.map(str).filter(Boolean) : [];
  const single = str(args.q);
  if (!queries.length && !single) return err("Provide 'q' or a non-empty 'queries' array.");
  const k = Number.isInteger(args.k) ? Math.max(1, Math.min(50, args.k)) : 10; // clamp [1,50] to match the board route
  // Default TRUE: this agent-facing dedupe tool should surface already-handled
  // (archived) matters so the agent can infer a thing is done and link/note it
  // instead of recreating. Only an explicit includeArchived:false narrows it.
  // (The board route/UI keep their own default of false; this is the MCP default.)
  const includeArchived = args.includeArchived !== false;

  // single q, no array → GET back-compat (and its keyword fallback), byte-identical output.
  if (!queries.length) {
    const qs = includeArchived ? "&includeArchived=1" : "";
    const { data, errorResult } = await api("GET", `/api/search?q=${encodeURIComponent(single)}${qs}`);
    if (errorResult) return errorResult;
    return text(formatLegacy(single, data));
  }

  // batch → POST. Route is fail-safe so this returns 200 (semantic or keyword).
  const all = single ? [single, ...queries] : queries;
  const { data, errorResult } = await api("POST", "/api/search", { queries: all, k, types: args.types, domain: args.domain, status: args.status, includeArchived });
  if (errorResult) return errorResult;

  const engine = data.engine ?? "keyword";
  const lines = [`Search (${engine}) · ${all.length} queries · top-${k} each`];
  for (const g of data.results ?? []) {
    // The board passes the sidecar's per-query groups through verbatim, so guard
    // a malformed group (missing/non-array hits) rather than crashing the render.
    const hits = Array.isArray(g?.hits) ? g.hits : [];
    lines.push(`\n▸ "${g?.query ?? ""}" — ${hits.length} hit(s):`);
    for (const h of hits) {
      const tag = h.type === "case"
        ? [h.case?.status, h.case?.archivedAt ? "archived" : null].filter(Boolean).join("·")
        : h.type === "task"
          ? "task"
          : h.type === "reminder"
            ? ["reminder", h.reminder?.status].filter(Boolean).join("·")
            : (h.from ?? "");
      const label = h.case?.title ?? h.reminder?.title ?? h.title ?? h.subject ?? "";
      const why = (h.why ?? []).join(",");
      const sc = typeof h.score === "number" ? h.score.toFixed(2) : "?";
      lines.push(`   - ${h.id} [${tag}] ${label}  (score ${sc}${why ? `; ${why}` : ""})`);
    }
    if (!hits.length) lines.push("   (no matches)");
  }
  lines.push(`\nDedupe: if a strong case match exists above, UPDATE it (update_case/add_task/link_message) — don't create a duplicate.`);
  return text(lines.join("\n"));
}

async function handleListTemplates() {
  const { data, errorResult } = await api("GET", "/api/templates");
  if (errorResult) return errorResult;

  const templates = data.templates ?? [];
  if (!templates.length) return text("No templates available.");
  const lines = [`Templates (${templates.length}):`];
  for (const t of templates) {
    lines.push(`  - ${t.id} — ${t.name ?? t.title ?? "(unnamed)"}${t.description ? `: ${t.description}` : ""}`);
  }
  return text(lines.join("\n"));
}

async function handleListPending() {
  const { data, errorResult } = await api("GET", "/api/pending");
  if (errorResult) return errorResult;

  const pending = data.pending ?? [];
  if (!pending.length) return text("No pending proposals.");
  const lines = [`Pending proposals (${pending.length}):`];
  for (const p of pending) {
    lines.push(
      `  - ${p.id} [${p.status}] ${p.verb}${p.target ? ` ${p.target}` : ""} — ${p.summary}`
    );
  }
  return text(lines.join("\n"));
}

async function handleListLabels() {
  const { data, errorResult } = await api("GET", "/api/labels");
  if (errorResult) return errorResult;

  const labels = data.labels ?? [];
  if (!labels.length) {
    return text(
      "The label catalog is empty. Install a bundle with install_label_bundle " +
        "(see list_label_bundles), then assign labels to cases."
    );
  }
  const lines = [`Active labels (${labels.length}) — use the id when setting a case's \`labels\`:`];
  for (const l of labels) {
    lines.push(`  - ${l.id} — ${l.title}${l.description ? `: ${l.description}` : ""}${l.bundle ? ` [${l.bundle}]` : ""}`);
  }
  return text(lines.join("\n"));
}

async function handleListLabelBundles() {
  const { data, errorResult } = await api("GET", "/api/labels/bundles");
  if (errorResult) return errorResult;

  const bundles = data.bundles ?? [];
  if (!bundles.length) return text("No label bundles available.");
  const lines = [`Label bundles (${bundles.length}) — install with install_label_bundle:`];
  for (const b of bundles) {
    const n = b.labels?.length ?? 0;
    // "installed" = labels this bundle OWNS (ownedCount), not mere presence — a
    // shared id from another installed bundle shouldn't read as installed here.
    const inN = b.ownedCount ?? 0;
    lines.push(
      `  - ${b.id} [${b.category}/${b.domain}] ${b.name} — ${n} labels` +
        `${inN ? ` (${inN}/${n} installed)` : ""}: ${b.description ?? ""}`
    );
  }
  return text(lines.join("\n"));
}

async function handleInstallLabelBundle(args) {
  const bundleId = str(args.bundleId);
  if (!bundleId) return err("'bundleId' is required (see list_label_bundles).");

  const { data, errorResult } = await api("POST", "/api/labels/bundles", { bundleId });
  if (errorResult) return errorResult;

  const installed = data.installed ?? [];
  const total = data.labels?.length ?? 0;
  return text(
    `Installed bundle '${bundleId}': ${installed.length} new label(s)` +
      `${installed.length ? ` (${installed.join(", ")})` : " (all already present)"}. ` +
      `Catalog now has ${total} label(s). Use list_labels to see them.`
  );
}

async function handleUninstallLabelBundle(args) {
  const bundleId = str(args.bundleId);
  if (!bundleId) return err("'bundleId' is required (see list_label_bundles).");
  const scrub = args.scrub === false ? "0" : "1";

  const { data, errorResult } = await api(
    "DELETE",
    `/api/labels/bundles/${encodeURIComponent(bundleId)}${scrub === "0" ? "?scrub=0" : ""}`
  );
  if (errorResult) return errorResult;

  const removed = data.removed ?? [];
  const total = data.labels?.length ?? 0;
  return text(
    `Uninstalled bundle '${bundleId}': removed ${removed.length} label(s)` +
      `${removed.length ? ` (${removed.join(", ")})` : ""}` +
      `${data.scrubbed ? `, cleared from ${data.scrubbed} case(s)` : ""}. ` +
      `Catalog now has ${total} label(s).`
  );
}

// ── Case lifecycle tools ─────────────────────────────────────────────────────

async function handleCreateCase(args) {
  if (typeof args.title !== "string" || args.title.trim() === "") {
    return err("'title' is required.");
  }
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }
  if (args.status !== undefined && !CASE_STATUS.includes(args.status)) {
    return err(`'status' must be one of: ${CASE_STATUS.join(", ")}.`);
  }
  if (args.priority !== undefined && !PRIORITY.includes(args.priority)) {
    return err(`'priority' must be one of: ${PRIORITY.join(", ")}.`);
  }
  if (args.kind !== undefined && !CASE_KIND.includes(args.kind)) {
    return err(`'kind' must be one of: ${CASE_KIND.join(", ")}.`);
  }
  // Pass through only provided fields. Default domain to 'work' (the API also
  // defaults, but we send it explicitly so the case is filed deterministically).
  const payload = { title: args.title, domain: args.domain ?? "work" };
  if (typeof args.status === "string") payload.status = args.status;
  for (const k of ["summary", "eta", "dueAt", "startDate", "priority"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  // Hierarchy: tier + parent. The board asserts tier validity and 400s an illegal
  // nesting (e.g. a leaf parent or a cycle) — surfaced via api()'s error path.
  if (typeof args.kind === "string") payload.kind = args.kind;
  if (typeof args.parentId === "string" && args.parentId) payload.parentId = args.parentId;
  if (Array.isArray(args.tags)) payload.tags = args.tags;
  if (Array.isArray(args.labels)) payload.labels = args.labels;
  if (Array.isArray(args.vaultLinks)) payload.vaultLinks = args.vaultLinks;
  if (Array.isArray(args.tasks)) payload.tasks = args.tasks;

  const { data, errorResult } = await api("POST", "/api/cases", payload);
  if (errorResult) return errorResult;

  const c = data.case;
  return text(
    `Created ${c.id} — "${c.title}"\n` +
      `Domain: ${c.domain ?? "work"}\n` +
      `Status: ${c.status}\n` +
      (c.priority ? `Priority: ${c.priority}\n` : "") +
      (c.dueAt ? `Due: ${c.dueAt}\n` : "") +
      (Array.isArray(c.labels) && c.labels.length ? `Labels: ${c.labels.join(", ")}\n` : "") +
      `Tasks: ${c.tasks.length}\n` +
      (Array.isArray(c.vaultLinks) && c.vaultLinks.length
        ? `Vault: ${c.vaultLinks.map((v) => `[[${v}]]`).join(", ")}\n`
        : "") +
      `Board: ${CRM_BASE_URL}/my-issues`
  );
}

async function handleUpdateCase(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }
  if (args.priority !== undefined && !PRIORITY.includes(args.priority)) {
    return err(`'priority' must be one of: ${PRIORITY.join(", ")}.`);
  }
  if (args.kind !== undefined && !CASE_KIND.includes(args.kind)) {
    return err(`'kind' must be one of: ${CASE_KIND.join(", ")}.`);
  }

  const payload = {};
  for (const k of [
    "title", "summary", "status", "domain",
    "eta", "dueAt", "startDate", "priority", "snoozeUntil",
  ]) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  // Hierarchy: change tier (kind) and/or re-parent. parentId === null detaches
  // (a leaf to top-level); the board enforces the tier rules and 400s a bad move.
  if (typeof args.kind === "string") payload.kind = args.kind;
  if (args.parentId === null) payload.parentId = null;
  else if (typeof args.parentId === "string") payload.parentId = args.parentId;
  if (Array.isArray(args.tags)) payload.tags = args.tags;
  if (Array.isArray(args.labels)) payload.labels = args.labels;
  if (Array.isArray(args.vaultLinks)) payload.vaultLinks = args.vaultLinks;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one field besides 'id'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/cases/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const c = data.case;
  const changed = Object.keys(payload).join(", ");
  return text(
    `Updated ${c.id} (${changed})\n` +
      `Domain: ${c.domain ?? "work"}\n` +
      `Status: ${c.status}\n` +
      (c.priority ? `Priority: ${c.priority}\n` : "") +
      (c.dueAt ? `Due: ${c.dueAt}\n` : "") +
      `Board: ${CRM_BASE_URL}/my-issues`
  );
}

async function handleUpdateCases(args) {
  const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === "string" && x.trim() !== "") : [];
  if (!ids.length) return err("'ids' must be a non-empty array of case ids.");
  if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch)) {
    return err("'patch' must be an object of fields to apply to every listed case.");
  }
  if (Object.keys(args.patch).length === 0) {
    return err("'patch' is empty — pass at least one field to set.");
  }
  if (args.patch.domain !== undefined && !CASE_DOMAIN.includes(args.patch.domain)) {
    return err(`patch.domain must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }
  if (args.patch.priority !== undefined && !PRIORITY.includes(args.patch.priority)) {
    return err(`patch.priority must be one of: ${PRIORITY.join(", ")}.`);
  }

  const { data, errorResult } = await api("PATCH", "/api/cases", { ids, patch: args.patch });
  if (errorResult) return errorResult;

  const updated = data.cases ?? [];
  const changed = Object.keys(args.patch).join(", ");
  return text(
    `Bulk-updated ${updated.length} case(s) (${changed}):\n` +
      updated.map((c) => `  - ${c.id} [${c.status}] ${c.title}`).join("\n")
  );
}

async function handleArchiveCase(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");

  const { data, errorResult } = await api("DELETE", `/api/cases/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const c = data.case;
  return text(
    `Archived ${id} (soft — restore with restore_case).` +
      (c && c.archivedAt ? `\nArchivedAt: ${c.archivedAt}` : "")
  );
}

async function handleRestoreCase(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");

  const { data, errorResult } = await api("PATCH", `/api/cases/${encodeURIComponent(id)}`, {
    archivedAt: null,
  });
  if (errorResult) return errorResult;

  const c = data.case;
  return text(`Restored ${c.id} — "${c.title}" is back on the board [${c.status}].`);
}

async function handleDeleteCase(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");

  const { data, errorResult } = await api("DELETE", `/api/cases/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const c = data.case;
  return text(
    `Deleted ${id} (soft — moved to Trash; restore with restore_case).` +
      (c && c.archivedAt ? `\nArchivedAt: ${c.archivedAt}` : "")
  );
}

async function handleApplyTemplate(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required — a template id (see list_templates).");
  const payload = { id };
  if (args.overrides && typeof args.overrides === "object" && !Array.isArray(args.overrides)) {
    payload.overrides = args.overrides;
  }

  const { data, errorResult } = await api("POST", "/api/templates", payload);
  if (errorResult) return errorResult;

  const c = data.case;
  return text(
    `Applied template '${id}' → created ${c.id} — "${c.title}"\n` +
      `Domain: ${c.domain ?? "work"}\n` +
      `Status: ${c.status}\n` +
      `Tasks: ${c.tasks.length}\n` +
      `Board: ${CRM_BASE_URL}/my-issues`
  );
}

// ── Task tools ───────────────────────────────────────────────────────────────

async function handleAddTask(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (typeof args.title !== "string" || args.title.trim() === "") {
    return err("'title' is required.");
  }

  const payload = { title: args.title };
  for (const k of ["detail", "status", "owner", "dueAt"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }

  const { data, errorResult } = await api("POST", `/api/cases/${encodeURIComponent(id)}/tasks`, payload);
  if (errorResult) return errorResult;

  const t = data.task;
  return text(
    `Added task ${t.id} to ${id} — "${t.title}" [${t.status}]${t.dueAt ? ` (due ${t.dueAt})` : ""}`
  );
}

async function handleUpdateTask(args, { forceDone } = {}) {
  const id = str(args.id);
  const taskId = str(args.taskId);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (!taskId) return err("'taskId' is required, e.g. 'CASE-1-T1'.");

  const payload = {};
  if (forceDone) {
    payload.status = "done";
  } else {
    for (const k of ["title", "detail", "status", "owner", "dueAt"]) {
      if (typeof args[k] === "string") payload[k] = args[k];
    }
    if (Object.keys(payload).length === 0) {
      return err("Nothing to update — pass at least one of title, detail, status, owner, dueAt.");
    }
  }

  const { data, errorResult } = await api(
    "PATCH",
    `/api/cases/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,
    payload
  );
  if (errorResult) return errorResult;

  const t = data.task;
  return text(
    `Task ${t.id} → [${t.status}] "${t.title}"${t.completedAt ? ` (completed ${t.completedAt})` : ""}`
  );
}

async function handleDeleteTask(args) {
  const id = str(args.id);
  const taskId = str(args.taskId);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (!taskId) return err("'taskId' is required, e.g. 'CASE-1-T1'.");

  const { data, errorResult } = await api(
    "DELETE",
    `/api/cases/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`
  );
  if (errorResult) return errorResult;

  const c = data.case;
  return text(`Deleted task ${taskId} from ${id}. Case now has ${c.tasks.length} task(s).`);
}

// ── Note tool ────────────────────────────────────────────────────────────────

async function handleAddNote(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (typeof args.body !== "string" || args.body.trim() === "") {
    return err("'body' is required — the note text.");
  }

  const { data, errorResult } = await api("POST", `/api/cases/${encodeURIComponent(id)}/notes`, {
    body: args.body,
  });
  if (errorResult) return errorResult;

  const n = data.note;
  return text(`Added note ${n.id} to ${id} (by ${n.author}): ${n.body}`);
}

// ── Message tools ────────────────────────────────────────────────────────────

async function handleLinkMessage(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1'.");
  if (!MESSAGE_SOURCE.includes(args.source)) {
    return err(`'source' must be one of: ${MESSAGE_SOURCE.join(", ")}.`);
  }
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("'from' is required.");
  }

  const payload = { source: args.source, from: args.from };
  // `url` forwards the original-message deep-link (e.g. the Gmail thread URL) — the
  // board route validates it (normalizeMessageUrl) and only stores an absolute http(s) one.
  for (const k of ["subject", "preview", "body", "receivedAt", "url"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  if (typeof args.read === "boolean") payload.read = args.read;
  // Recipient lists + the outbound flag drive automatic trust derivation server-side.
  for (const k of ["to", "cc"]) {
    if (Array.isArray(args[k])) {
      const list = args[k].filter((s) => typeof s === "string" && s.trim() !== "");
      if (list.length) payload[k] = list;
    }
  }
  if (typeof args.outbound === "boolean") payload.outbound = args.outbound;

  const { data, errorResult } = await api(
    "POST",
    `/api/cases/${encodeURIComponent(id)}/messages`,
    payload
  );
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Linked message ${m.id} to ${id} — [${m.source}]${m.outbound ? " (sent)" : ""} ${m.from}${m.subject ? ` — ${m.subject}` : ""}`
  );
}

async function handleUpdateMessage(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'M-1'.");

  const payload = {};
  if (typeof args.read === "boolean") payload.read = args.read;
  // null is a real update (unlink), so distinguish it from an absent caseId.
  if (args.caseId === null) payload.caseId = null;
  else if (typeof args.caseId === "string") payload.caseId = args.caseId;
  // url mirrors caseId: null CLEARS the deep-link, a string SETS it (the board route
  // validates it and only stores an absolute http(s) URL); absent leaves it untouched.
  if (args.url === null) payload.url = null;
  else if (typeof args.url === "string") payload.url = args.url;
  if (!("caseId" in payload) && !("read" in payload) && !("url" in payload)) {
    return err("Nothing to update — pass 'read', 'caseId', and/or 'url'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Updated message ${m.id} — read: ${m.read === true}${
      m.caseId ? `, linked to ${m.caseId}` : ", unlinked"
    }${m.url ? `, link ${m.url}` : ""}`
  );
}

// Store a brand-new message and flag it needs-a-reply (it lands in the board's
// 'Unanswered messages' view). Created standalone; caseId/reminderId ALSO link it.
async function handleAddUnansweredMessage(args) {
  if (!MESSAGE_SOURCE.includes(args.source)) {
    return err(`'source' must be one of: ${MESSAGE_SOURCE.join(", ")}.`);
  }
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("'from' is required.");
  }

  const payload = { source: args.source, from: args.from };
  // `url` forwards the original-message deep-link (e.g. the Gmail thread URL) — the
  // board route validates it (normalizeMessageUrl) and only stores an absolute http(s) one.
  // `context` is the one-sentence line shown in the unanswered view.
  for (const k of ["subject", "preview", "body", "receivedAt", "url", "context", "caseId", "reminderId"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  if (typeof args.read === "boolean") payload.read = args.read;
  // needsAnswer defaults true server-side — this tool always flags.

  const { data, errorResult } = await api("POST", "/api/messages", payload);
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Stored unanswered message ${m.id} — [${m.source}] ${m.from}${m.subject ? ` — ${m.subject}` : ""}${
      m.caseId ? `, linked to ${m.caseId}` : ""
    }${m.reminderId ? `, on ${m.reminderId}` : ""}`
  );
}

// Flag an EXISTING message as needing a reply (it appears in the unanswered view).
async function handleMarkMessageUnanswered(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'M-1'.");

  const payload = { needsAnswer: true };
  if (typeof args.context === "string" && args.context !== "") payload.context = args.context;

  const { data, errorResult } = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Flagged message ${m.id} as unanswered — [${m.source}] ${m.from}${m.subject ? ` — ${m.subject}` : ""}`
  );
}

// Mark a message answered — a pure status flip that drops it from the unanswered
// view (stamps answeredAt server-side). No cascade to any linked case/reminder.
async function handleMarkMessageAnswered(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'M-1'.");

  const { data, errorResult } = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, {
    answered: true,
  });
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Marked message ${m.id} answered — [${m.source}] ${m.from}${m.subject ? ` — ${m.subject}` : ""}`
  );
}

// List the messages the user still owes a reply to (needsAnswer, not answered),
// newest first; `limit` trims the summary client-side.
async function handleListUnansweredMessages(args) {
  const { data, errorResult } = await api("GET", "/api/messages?status=unanswered");
  if (errorResult) return errorResult;

  let messages = data.messages ?? [];
  if (!messages.length) return text("No unanswered messages — nothing awaiting a reply.");
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : null;
  const shown = limit ? messages.slice(0, limit) : messages;
  const lines = [`Unanswered messages (${messages.length}):`];
  for (const m of shown) {
    lines.push(
      `  - ${m.id} [${m.source}] ${m.from}${m.subject ? ` — ${m.subject}` : ""}` +
        (m.caseId ? ` → ${m.caseId}` : "") +
        (m.context ? `\n      ${m.context}` : "")
    );
  }
  if (limit && messages.length > limit) lines.push(`  … and ${messages.length - limit} more.`);
  return text(lines.join("\n"));
}

// ── Reminder tools ───────────────────────────────────────────────────────────
// Reminders are lightweight nudges (CHECK/DO) that ride the board API at
// /api/reminders. reminder.caseId optionally links to ANY tier (initiative/
// workstream/case) — the single source of truth for the node<->reminder link.

// Compact one-line render of a reminder (status · due · title · linked caseId ·
// task progress · created date). The created date is the AGE signal a staleness
// sweep (the reminders-review skill) reads to spot reminders worth closing — a
// dateless "review X, decide whether to Y" nudge has no dueAt, so createdAt is
// the only signal for how long it has been sitting.
function reminderLine(r) {
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  return (
    `[${r.status}]` +
    (r.dueAt ? ` due ${r.dueAt}` : "") +
    ` ${r.id} — ${r.title}` +
    (r.caseId ? ` → ${r.caseId}` : "") +
    (tasks.length ? ` · ${tasks.filter((t) => t.done).length}/${tasks.length} tasks` : "") +
    (typeof r.createdAt === "string" ? ` · created ${r.createdAt.slice(0, 10)}` : "")
  );
}

// Full-detail render of a reminder (verbose list mode): the id/status/title header, a
// one-line meta strip (created · due · domain · link · labels · task progress · completed),
// the task checklist with done-flags, and the full detail text. This carries everything
// on the reminder record so a cleanup sweep can triage the whole set from ONE
// list_reminders call — without a get_reminder per reminder. (Linked emails are the one
// thing not on the record; those still come from get_reminder.)
function reminderBlock(r) {
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  const done = tasks.filter((t) => t.done).length;
  const meta = [
    typeof r.createdAt === "string" ? `created ${r.createdAt.slice(0, 10)}` : null,
    `due ${r.dueAt ? r.dueAt : "—"}`,
    r.domain || "—",
    r.caseId ? `→ ${r.caseId}` : "standalone",
    `labels: ${Array.isArray(r.labels) && r.labels.length ? r.labels.join(", ") : "none"}`,
    tasks.length ? `tasks ${done}/${tasks.length}` : null,
    r.completedAt ? `completed ${r.completedAt.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [`${r.id} [${r.status}] — ${r.title}`, `    ${meta}`];
  for (const t of tasks) lines.push(`    [${t.done ? "x" : " "}] ${t.title}`);
  if (r.detail) lines.push(`    detail: ${r.detail}`);
  return lines.join("\n");
}

async function handleCreateReminder(args) {
  if (typeof args.title !== "string" || args.title.trim() === "") {
    return err("'title' is required — the nudge itself.");
  }
  if (args.status !== undefined && !REMINDER_STATUS.includes(args.status)) {
    return err(`'status' must be one of: ${REMINDER_STATUS.join(", ")}.`);
  }
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }

  const payload = { title: args.title };
  if (typeof args.status === "string") payload.status = args.status;
  for (const k of ["detail", "dueAt", "domain", "caseId"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  // Enrichment: catalog labels (the board validates them against the catalog and
  // 400s an unknown id) and a short tasks checklist (the store mints REM-<n>-T<k>
  // ids — never pass an id on create).
  if (Array.isArray(args.labels)) payload.labels = args.labels;
  if (Array.isArray(args.tasks)) payload.tasks = args.tasks;

  const { data, errorResult } = await api("POST", "/api/reminders", payload);
  if (errorResult) return errorResult;

  const r = data.reminder;
  return text(
    `Created ${r.id} — "${r.title}" [${r.status}]\n` +
      (r.dueAt ? `Due: ${r.dueAt}\n` : "") +
      (r.domain ? `Domain: ${r.domain}\n` : "") +
      (Array.isArray(r.labels) && r.labels.length ? `Labels: ${r.labels.join(", ")}\n` : "") +
      (Array.isArray(r.tasks) && r.tasks.length
        ? `Tasks: ${r.tasks.filter((t) => t.done).length}/${r.tasks.length}\n`
        : "") +
      (r.caseId ? `Linked to: ${r.caseId}` : "Standalone (not linked to a board node).")
  );
}

async function handleListReminders(args) {
  if (args.status !== undefined && !REMINDER_STATUS.includes(args.status)) {
    return err(`'status' must be one of: ${REMINDER_STATUS.join(", ")}.`);
  }
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }

  const sp = new URLSearchParams();
  if (typeof args.status === "string" && args.status) sp.set("status", args.status);
  if (typeof args.caseId === "string" && args.caseId.trim()) sp.set("caseId", args.caseId.trim());
  if (typeof args.domain === "string" && args.domain) sp.set("domain", args.domain);
  const qs = sp.toString();

  const { data, errorResult } = await api("GET", `/api/reminders${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;

  const reminders = data.reminders ?? [];
  if (!reminders.length) return text("No reminders match.");
  // verbose: one FULL block per reminder (detail, created/updated, tasks with done-flags,
  // labels, caseId) so a cleanup sweep triages the whole set in ONE call — no get_reminder
  // per reminder. Compact one-liners otherwise. (verbose is a render concern — it never
  // hits the API, which always returns the full records.)
  if (args.verbose) {
    return text([`Reminders (${reminders.length}) — full detail:`, ...reminders.map(reminderBlock)].join("\n\n"));
  }
  const lines = [`Reminders (${reminders.length}):`];
  for (const r of reminders) lines.push(`  - ${reminderLine(r)}`);
  return text(lines.join("\n"));
}

async function handleGetReminder(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'REM-1'.");

  const { data, errorResult } = await api("GET", `/api/reminders/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const r = data.reminder;
  const messages = data.messages ?? [];
  const lines = [`${r.id} — ${r.title}`, `Status: ${r.status}`];
  if (r.dueAt) lines.push(`Due: ${r.dueAt}`);
  if (r.domain) lines.push(`Domain: ${r.domain}`);
  // Surface createdAt/updatedAt so an agent can judge staleness — how long a nudge
  // has been sitting open — which is the signal the reminders-review sweep acts on.
  if (r.createdAt) lines.push(`Created: ${r.createdAt}`);
  if (r.updatedAt && r.updatedAt !== r.createdAt) lines.push(`Updated: ${r.updatedAt}`);
  if (r.completedAt) lines.push(`Completed: ${r.completedAt}`);
  if (Array.isArray(r.labels) && r.labels.length) lines.push(`Labels: ${r.labels.join(", ")}`);
  if (r.detail) lines.push(`\nDetail: ${r.detail}`);

  if (Array.isArray(r.tasks) && r.tasks.length) {
    const done = r.tasks.filter((t) => t.done).length;
    lines.push(`\nTasks (${done}/${r.tasks.length}):`);
    for (const t of r.tasks) lines.push(`  - [${t.done ? "x" : " "}] ${t.title}`);
  }

  if (messages.length) {
    lines.push(`\nMessages (${messages.length}):`);
    for (const m of messages) lines.push(`  - [${m.source}] ${m.from} — ${m.subject ?? ""}`);
  }

  lines.push(r.caseId ? `\nLinked to: ${r.caseId}` : `\nStandalone (not linked to a board node).`);
  return text(lines.join("\n"));
}

async function handleUpdateReminder(args, { forceDone, linkOnly } = {}) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'REM-1'.");

  const payload = {};
  if (forceDone) {
    payload.status = "done";
  } else if (linkOnly) {
    // link_reminder: only the caseId flows through; null/empty unlinks.
    if (args.caseId === null) payload.caseId = null;
    else if (typeof args.caseId === "string") payload.caseId = args.caseId.trim() === "" ? null : args.caseId.trim();
    else return err("'caseId' must be a node id string, or null/empty to unlink.");
  } else {
    if (args.status !== undefined && !REMINDER_STATUS.includes(args.status)) {
      return err(`'status' must be one of: ${REMINDER_STATUS.join(", ")}.`);
    }
    if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
      return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
    }
    for (const k of ["title", "detail", "status", "dueAt", "domain"]) {
      if (typeof args[k] === "string") payload[k] = args[k];
    }
    // An explicit null unlinks; a string relinks — do NOT str()-drop a null.
    if (args.caseId === null) payload.caseId = null;
    else if (typeof args.caseId === "string") payload.caseId = args.caseId;
    // Enrichment: REPLACE labels (catalog ids — validated by the board) and/or the
    // short tasks checklist (the store keeps ids it recognises and mints the rest).
    if (Array.isArray(args.labels)) payload.labels = args.labels;
    if (Array.isArray(args.tasks)) payload.tasks = args.tasks;
    if (Object.keys(payload).length === 0) {
      return err("Nothing to update — pass at least one of title, detail, status, dueAt, domain, caseId, labels, tasks.");
    }
  }

  const { data, errorResult } = await api("PATCH", `/api/reminders/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const r = data.reminder;
  return text(
    `Updated ${r.id} — "${r.title}" [${r.status}]` +
      (r.completedAt ? ` (completed ${r.completedAt})` : "") +
      (r.caseId ? `, linked to ${r.caseId}` : ", standalone")
  );
}

async function handleDeleteReminder(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'REM-1'.");

  const { errorResult } = await api("DELETE", `/api/reminders/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Deleted reminder ${id}.`);
}

// Mirror handleLinkMessage but target a REMINDER: the board creates the message,
// sets its reminderId (NOT caseId), and lists it under the reminder's messages.
async function handleLinkReminderMessage(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'REM-1'.");
  if (!MESSAGE_SOURCE.includes(args.source)) {
    return err(`'source' must be one of: ${MESSAGE_SOURCE.join(", ")}.`);
  }
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("'from' is required.");
  }

  const payload = { source: args.source, from: args.from };
  // `url` forwards the original-message deep-link (e.g. the Gmail thread URL) — the
  // board route validates it (normalizeMessageUrl) and only stores an absolute http(s) one.
  for (const k of ["subject", "preview", "body", "receivedAt", "url"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  if (typeof args.read === "boolean") payload.read = args.read;
  // Recipient lists + the outbound flag drive automatic trust derivation server-side
  // (a reminder is a first-class trust source, same rule as a case).
  for (const k of ["to", "cc"]) {
    if (Array.isArray(args[k])) {
      const list = args[k].filter((s) => typeof s === "string" && s.trim() !== "");
      if (list.length) payload[k] = list;
    }
  }
  if (typeof args.outbound === "boolean") payload.outbound = args.outbound;

  const { data, errorResult } = await api(
    "POST",
    `/api/reminders/${encodeURIComponent(id)}/messages`,
    payload
  );
  if (errorResult) return errorResult;

  const m = data.message;
  return text(
    `Linked message ${m.id} to ${id} — [${m.source}]${m.outbound ? " (sent)" : ""} ${m.from}${m.subject ? ` — ${m.subject}` : ""}`
  );
}

// ── Priority tools ───────────────────────────────────────────────────────────
// Priorities are "what matters most right now": the user's STARRED nodes (a
// favorite/pin on any case/workstream/initiative — set with set_starred) PLUS
// free-text PRIORITY NOTES (id PRI-<n>, the user's own words). They ride the board
// API at /api/priorities; starring is just PATCH /api/cases/{id} { starred }.

// One-line render of a starred node (id · [tier] · title · [lane]). Containers
// (initiative/workstream) have no kanban lane to show, so [lane] is leaf-only.
function starredLine(c) {
  const kind = c.kind ?? "case";
  const tier = kind === "initiative" ? "Initiative" : kind === "workstream" ? "Workstream" : "Case";
  return `${c.id} [${tier}] ${c.title}` + (kind === "case" && c.status ? ` — ${c.status}` : "");
}

async function handleGetDeviceStatus() {
  const { data, errorResult } = await api("GET", "/api/devices");
  if (errorResult) return errorResult;

  const lines = [`This machine: ${data.deviceId} (${data.role}), code schema v${data.schemaVersion}`];

  if (data.lease) {
    const who = data.lease.deviceId === data.deviceId ? `${data.lease.deviceId} (THIS machine)` : data.lease.deviceId;
    lines.push(
      `Hub lease: held by ${who}${data.lease.stale ? " — STALE (claimable)" : ""} ` +
        `(epoch ${data.lease.epoch}, renewed ${data.lease.renewedAt})`,
    );
  } else {
    lines.push("Hub lease: not armed (single-machine setup, or backup repo not configured).");
  }

  const devices = data.devices ?? [];
  if (devices.length) {
    lines.push(`\nDevices seen (${devices.length}, agent last-seen):`);
    for (const d of devices) {
      const tags = [d.deviceId === data.deviceId ? "this" : null, d.deviceId === data.lease?.deviceId ? "hub" : d.role]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${d.deviceId}${tags ? ` [${tags}]` : ""} — last seen ${d.lastSeen}`);
    }
  } else {
    lines.push("\nNo other devices seen yet.");
  }

  if (data.joinBlob) lines.push(`\nAdd a device (paste into spoke-setup): ${data.joinBlob}`);
  return text(lines.join("\n"));
}

async function handleGetPriorities() {
  const { data, errorResult } = await api("GET", "/api/priorities");
  if (errorResult) return errorResult;

  const starred = data.starred ?? [];
  const priorities = data.priorities ?? [];
  if (!starred.length && !priorities.length) {
    return text(
      "No priorities yet — the user hasn't starred any nodes or written any priority notes. " +
        "Star a case/workstream/initiative (set_starred) or add a note (add_priority) to record what matters most."
    );
  }

  const lines = [`What the user cares about most — ALIGN your work to these:`];
  lines.push(`\nStarred nodes (${starred.length}):`);
  if (starred.length) {
    for (const c of starred) lines.push(`  - ${starredLine(c)}`);
  } else {
    lines.push("  (none starred)");
  }
  lines.push(`\nPriority notes (${priorities.length}) — the user's own words:`);
  if (priorities.length) {
    for (const p of priorities) lines.push(`  - ${p.id} — ${p.text}`);
  } else {
    lines.push("  (no notes)");
  }
  lines.push(`\nThese are the user's stated priorities — align your triage and work to them.`);
  return text(lines.join("\n"));
}

async function handleAddPriority(args) {
  if (typeof args.text !== "string" || args.text.trim() === "") {
    return err("'text' is required — the priority in plain words.");
  }
  if (args.position !== undefined && typeof args.position !== "number") {
    return err("'position' must be a number (the manual rank).");
  }

  const payload = { text: args.text };
  if (typeof args.position === "number") payload.position = args.position;

  const { data, errorResult } = await api("POST", "/api/priorities", payload);
  if (errorResult) return errorResult;

  const p = data.priority;
  return text(`Added ${p.id} — "${p.text}"${typeof p.position === "number" ? ` (rank ${p.position})` : ""}`);
}

async function handleUpdatePriority(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'PRI-1'.");
  if (args.text !== undefined && (typeof args.text !== "string" || args.text.trim() === "")) {
    return err("'text' must be a non-empty string.");
  }
  if (args.position !== undefined && typeof args.position !== "number") {
    return err("'position' must be a number (the manual rank).");
  }

  const payload = {};
  if (typeof args.text === "string") payload.text = args.text;
  if (typeof args.position === "number") payload.position = args.position;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass 'text' and/or 'position'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/priorities/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const p = data.priority;
  return text(`Updated ${p.id} — "${p.text}"${typeof p.position === "number" ? ` (rank ${p.position})` : ""}`);
}

async function handleRemovePriority(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'PRI-1'.");

  const { errorResult } = await api("DELETE", `/api/priorities/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Removed priority note ${id}.`);
}

async function handleSetStarred(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-1' (any tier).");
  if (typeof args.starred !== "boolean") {
    return err("'starred' is required — true to star (pin), false to unstar.");
  }

  const { data, errorResult } = await api("PATCH", `/api/cases/${encodeURIComponent(id)}`, {
    starred: args.starred,
  });
  if (errorResult) return errorResult;

  const c = data.case;
  return text(`${args.starred ? "Starred" : "Unstarred"} ${c.id} — "${c.title}".`);
}

// ── Approval-queue tools ─────────────────────────────────────────────────────

async function handlePropose(args) {
  const verb = str(args.verb);
  const summary = str(args.summary);
  if (!verb) return err("'verb' is required — the board verb to run on approval.");
  if (!summary) return err("'summary' is required — a one-line description.");
  if (!args.payload || typeof args.payload !== "object" || Array.isArray(args.payload)) {
    return err("'payload' must be an object — the verb's arguments.");
  }

  const proposal = { verb, payload: args.payload, summary };
  if (typeof args.target === "string" && args.target.trim() !== "") proposal.target = args.target.trim();

  const { data, errorResult } = await api("POST", "/api/pending", proposal);
  if (errorResult) return errorResult;

  const p = data.pending;
  return text(
    `Proposed ${p.id} [${p.status}]: ${p.verb}${p.target ? ` ${p.target}` : ""} — ${p.summary}\n` +
      `Awaiting human approve/reject.`
  );
}

async function handleDecidePending(args, decision) {
  const pendingId = str(args.pendingId);
  if (!pendingId) return err("'pendingId' is required.");

  const { data, errorResult } = await api(
    "POST",
    `/api/pending/${encodeURIComponent(pendingId)}`,
    { decision }
  );
  if (errorResult) return errorResult;

  if (decision === "reject") {
    const p = data.pending;
    return text(`Rejected ${pendingId}${p ? ` [${p.status}]` : ""}. Not committed.`);
  }
  // approve → the board commits through the matching verb; it may return the
  // resulting case and/or the updated pending record.
  const c = data.case;
  const p = data.pending;
  return text(
    `Approved ${pendingId}${p ? ` [${p.status}]` : ""} — committed.` +
      (c ? `\nResulting case: ${c.id} [${c.status}] "${c.title}"` : "")
  );
}

// ── Hierarchy tools ──────────────────────────────────────────────────────────

// DFS a /api/tree forest for a node by id; returns { node, parent } or null.
function findInForest(forest, id, parent = null) {
  for (const n of forest ?? []) {
    if (n?.case?.id === id) return { node: n, parent };
    const hit = findInForest(n?.children, id, n);
    if (hit) return hit;
  }
  return null;
}

// Render a tree node (and its subtree) as an indented outline into `out`.
function renderTreeOutline(node, depth, out) {
  const c = node.case;
  const kind = c.kind ?? "case";
  const pad = "  ".repeat(depth);
  if (kind === "case") {
    const tasks = c.tasks ?? [];
    const done = tasks.filter((t) => t.status === "done").length;
    out.push(`${pad}• ${c.id} [${c.status}] ${c.title}${tasks.length ? ` (${done}/${tasks.length} tasks)` : ""}`);
  } else {
    const r = node.rollup ?? {};
    const label = kind === "initiative" ? "▸ INITIATIVE" : "▹ Workstream";
    out.push(
      `${pad}${label}  ${c.id} — ${c.title}  ` +
        `[${r.doneCases ?? 0}/${r.totalCases ?? 0} cases · ${node.children?.length ?? 0} child(ren)]`
    );
  }
  for (const ch of node.children ?? []) renderTreeOutline(ch, depth + 1, out);
}

function treeQuery(args) {
  const sp = new URLSearchParams();
  if (args.includeArchived === true) sp.set("includeArchived", "1");
  if (typeof args.domain === "string" && CASE_DOMAIN.includes(args.domain)) sp.set("domain", args.domain);
  const qs = sp.toString();
  return `/api/tree${qs ? `?${qs}` : ""}`;
}

async function handleGetTree(args) {
  const { data, errorResult } = await api("GET", treeQuery(args));
  if (errorResult) return errorResult;
  let forest = data.tree ?? [];
  const rootId = str(args.rootId);
  if (rootId) {
    const found = findInForest(forest, rootId);
    if (!found) return err(`No node ${rootId} in the tree (it may be archived — pass includeArchived:true).`);
    forest = [found.node];
  }
  if (!forest.length) {
    return text(
      "The board has no initiatives or standalone cases yet. Start one with create_initiative to group related cases."
    );
  }
  const out = [`Board hierarchy — Initiative > Workstream > Case${rootId ? ` (subtree of ${rootId})` : ""}:`];
  for (const n of forest) {
    out.push("");
    renderTreeOutline(n, 0, out);
  }
  out.push(
    "\nNest new work under the right container (create_workstream / create_case with parentId, or regroup_cases). " +
      "Prefer a STANDALONE case for an orphan one-off; a new Initiative only for a genuinely new multi-stream theme."
  );
  return text(out.join("\n"));
}

async function handleListInitiatives(args) {
  const { data, errorResult } = await api("GET", treeQuery(args));
  if (errorResult) return errorResult;
  const inits = (data.tree ?? []).filter((n) => (n.case.kind ?? "case") === "initiative");
  if (!inits.length) {
    return text("No initiatives yet. Use create_initiative to start one, then nest workstreams/cases under it.");
  }
  const out = [`Initiatives (${inits.length}):`];
  for (const n of inits) {
    const r = n.rollup ?? {};
    const ws = (n.children ?? []).filter((c) => (c.case.kind ?? "case") === "workstream").length;
    out.push(
      `  - ${n.case.id} [${n.case.domain}/${n.case.status}] ${n.case.title} — ` +
        `${r.doneCases ?? 0}/${r.totalCases ?? 0} cases done · ${ws} workstream(s)`
    );
  }
  out.push("\nDrill into one with get_tree(rootId).");
  return text(out.join("\n"));
}

async function handleCreateInitiative(args) {
  if (typeof args.title !== "string" || args.title.trim() === "") return err("'title' is required.");
  // An initiative is a root (no parent) — reuse the create path with kind set.
  return handleCreateCase({ ...args, kind: "initiative", parentId: undefined });
}

async function handleCreateWorkstream(args) {
  if (typeof args.title !== "string" || args.title.trim() === "") return err("'title' is required.");
  const initiativeId = str(args.initiativeId);
  if (!initiativeId) return err("'initiativeId' is required — the parent Initiative id (see get_tree).");
  return handleCreateCase({ ...args, kind: "workstream", parentId: initiativeId });
}

async function handleSetParent(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'CASE-5'.");
  if (!("parentId" in args)) {
    return err("'parentId' is required — an Initiative/Workstream id, or null to detach a leaf Case.");
  }
  let payload;
  if (args.parentId === null) payload = { parentId: null };
  else if (typeof args.parentId === "string" && args.parentId.trim()) payload = { parentId: args.parentId.trim() };
  else return err("'parentId' must be a case id string, or null to detach.");

  const { data, errorResult } = await api("PATCH", `/api/cases/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;
  const c = data.case;
  return text(c.parentId ? `Re-parented ${c.id} under ${c.parentId}.` : `Detached ${c.id} to top-level.`);
}

async function handleRegroupCases(args) {
  const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === "string" && x.trim() !== "") : [];
  if (!ids.length) return err("'ids' must be a non-empty array of case ids.");
  if (!("parentId" in args)) {
    return err("'parentId' is required — the container id to file them under, or null to detach them all.");
  }
  let parentId;
  if (args.parentId === null) parentId = null;
  else if (typeof args.parentId === "string" && args.parentId.trim()) parentId = args.parentId.trim();
  else return err("'parentId' must be a case id string, or null.");

  const { data, errorResult } = await api("PATCH", "/api/cases", { ids, patch: { parentId } });
  if (errorResult) return errorResult;
  const updated = data.cases ?? [];
  return text(
    `Regrouped ${updated.length} case(s) ${parentId ? `under ${parentId}` : "to top-level"}:\n` +
      updated.map((c) => `  - ${c.id} [${c.status}] ${c.title}`).join("\n")
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    // reads
    case "get_case":
      return handleGetCase(args);
    case "search":
      return handleSearch(args);
    case "list_templates":
      return handleListTemplates();
    case "list_pending":
      return handleListPending();
    case "list_labels":
      return handleListLabels();
    case "list_label_bundles":
      return handleListLabelBundles();
    case "install_label_bundle":
      return handleInstallLabelBundle(args);
    case "uninstall_label_bundle":
      return handleUninstallLabelBundle(args);
    case "get_tree":
      return handleGetTree(args);
    case "list_initiatives":
      return handleListInitiatives(args);
    // case lifecycle
    case "create_case":
      return handleCreateCase(args);
    case "update_case":
      return handleUpdateCase(args);
    case "update_cases":
      return handleUpdateCases(args);
    case "archive_case":
      return handleArchiveCase(args);
    case "restore_case":
      return handleRestoreCase(args);
    case "delete_case":
      return handleDeleteCase(args);
    case "apply_template":
      return handleApplyTemplate(args);
    // hierarchy (Initiatives & Workstreams)
    case "create_initiative":
      return handleCreateInitiative(args);
    case "create_workstream":
      return handleCreateWorkstream(args);
    case "set_parent":
      return handleSetParent(args);
    case "regroup_cases":
      return handleRegroupCases(args);
    // tasks
    case "add_task":
      return handleAddTask(args);
    case "update_task":
      return handleUpdateTask(args);
    case "complete_task":
      return handleUpdateTask(args, { forceDone: true });
    case "delete_task":
      return handleDeleteTask(args);
    // notes
    case "add_note":
      return handleAddNote(args);
    // messages
    case "link_message":
      return handleLinkMessage(args);
    case "update_message":
      return handleUpdateMessage(args);
    case "add_unanswered_message":
      return handleAddUnansweredMessage(args);
    case "mark_message_unanswered":
      return handleMarkMessageUnanswered(args);
    case "mark_message_answered":
      return handleMarkMessageAnswered(args);
    case "list_unanswered_messages":
      return handleListUnansweredMessages(args);
    // reminders
    case "create_reminder":
      return handleCreateReminder(args);
    case "list_reminders":
      return handleListReminders(args);
    case "get_reminder":
      return handleGetReminder(args);
    case "update_reminder":
      return handleUpdateReminder(args);
    case "complete_reminder":
      return handleUpdateReminder(args, { forceDone: true });
    case "delete_reminder":
      return handleDeleteReminder(args);
    case "link_reminder":
      return handleUpdateReminder(args, { linkOnly: true });
    case "link_reminder_message":
      return handleLinkReminderMessage(args);
    // priorities
    // devices (multi-device status)
    case "get_device_status":
      return handleGetDeviceStatus();
    // priorities
    case "get_priorities":
      return handleGetPriorities();
    case "add_priority":
      return handleAddPriority(args);
    case "update_priority":
      return handleUpdatePriority(args);
    case "remove_priority":
      return handleRemovePriority(args);
    case "set_starred":
      return handleSetStarred(args);
    // approval queue
    case "propose":
      return handlePropose(args);
    case "approve":
      return handleDecidePending(args, "approve");
    case "reject":
      return handleDecidePending(args, "reject");
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `board MCP server v3.3 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
