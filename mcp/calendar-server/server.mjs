#!/usr/bin/env node
// MCP server (registry name "calendar") for the Cos calendar — basic
// appointments/events that live ALONGSIDE the board and, ideally, roll UP under a
// case. Every tool wraps the board's /api/events HTTP routes over `fetch` on
// CRM_BASE_URL; the server never shells out to curl. Runs over stdio; Claude
// Desktop bridges it into Cowork, or front it with supergateway for the HTTP bridge.
//
// Actor attribution: every WRITE sends { actor: "agent" } in the body (and an
// `x-actor: agent` header as a belt-and-braces twin) so the case audit trail
// (event_linked / event_updated / event_unlinked) attributes the change to the
// agent, not a human. The board UI is the visual twin path that writes as "human".
//
// THE LINK: an event's `caseId` is the SINGLE SOURCE OF TRUTH for the case<->event
// link. PREFER linking an appointment to an existing case — this agent ALSO has the
// `board` MCP: call its `search` (and `get_tree`) FIRST to find a matching case
// (client/person, account number, topic). If a strong match exists, set `caseId` so
// the appointment rolls up under that case and its related data. If nothing matches,
// create the event STANDALONE (omit caseId).
//
// Calendar-event model (board/lib/types.ts → CalendarEvent):
//   id        EVT-<n>            minted like CASE-<n>/M-<n>
//   title*    non-empty
//   date*     "YYYY-MM-DD"       the day it falls on (start day for a timed event)
//   allDay    boolean (def false)
//   startTime "HH:MM" 24h        present when !allDay
//   endTime   "HH:MM" 24h        optional
//   description / location       optional
//   caseId    optional link to a CaseRecord (the case<->event link)
//   domain    "work" | "life"    optional/advisory (may mirror the linked case)
//   createdAt / updatedAt        ISO
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

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");

// In lockstep with VALID_DOMAIN in board/lib/types.ts. No new enums — domain
// reuses CaseDomain. (There is no event-status enum; the model is intentionally basic.)
const CASE_DOMAIN = ["work", "life"];

// The house guardrail, baked into the create/link tool descriptions so the agent
// prefers rolling an appointment up under an existing case.
const LINK_GUARDRAIL =
  "PREFER linking an appointment to an existing case. This agent ALSO has the board MCP: " +
  "call its `search` (and `get_tree`) FIRST to find a matching case (client/person, account " +
  "number, topic). If a strong match exists, set `caseId` so the appointment rolls up under " +
  "that case and its related data. If nothing matches, create the event STANDALONE (omit " +
  "caseId) — leave it as is.";

// ── Tool definitions (OUR event model field names exactly) ─────────────────────

const CREATE_EVENT_TOOL = {
  name: "create_event",
  description:
    "Create a calendar event / appointment on the Cos calendar — `POST /api/events`. " +
    LINK_GUARDRAIL +
    " `date` is the calendar day it falls on (YYYY-MM-DD); for a timed event also set `startTime` " +
    "(HH:MM 24h) and optionally `endTime`. `allDay` defaults to false. Set `domain` ('work'|'life') " +
    "to mirror the linked case's side, or leave it advisory. Returns the minted EVT-id. A `caseId` " +
    "that doesn't reference an existing case is rejected with a clear error (search the board first).",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event title, e.g. 'Review call — Acme Ltd'." },
      date: {
        type: "string",
        description: "Calendar day the event falls on, as 'YYYY-MM-DD' (start day for a timed event).",
      },
      allDay: { type: "boolean", description: "All-day event. Defaults to false." },
      startTime: {
        type: "string",
        description: "Start time as 'HH:MM' (24h), e.g. '14:30'. Present for a timed (non all-day) event.",
      },
      endTime: { type: "string", description: "Optional end time as 'HH:MM' (24h)." },
      description: { type: "string", description: "Optional free-text description / agenda." },
      location: { type: "string", description: "Optional location (room, address, call link)." },
      caseId: {
        type: "string",
        description:
          "OPTIONAL — link this appointment to an existing case (e.g. 'CASE-1') so it rolls up under " +
          "that case. " + LINK_GUARDRAIL + " An unknown caseId is rejected with a 400.",
      },
      domain: {
        type: "string",
        enum: CASE_DOMAIN,
        description: "Optional/advisory 'work' or 'life' — may mirror the linked case's domain.",
      },
    },
    required: ["title", "date"],
  },
};

const LIST_EVENTS_TOOL = {
  name: "list_events",
  description:
    "List calendar events — `GET /api/events`. Read-only. Filter by a half-open day window with " +
    "`from` (inclusive) / `to` (exclusive) as 'YYYY-MM-DD', and/or by `caseId` (events linked to one " +
    "case) and `domain` ('work'|'life'). With no filters, returns ALL events. Renders a compact one-" +
    "line-per-event list with the day, time (or 'all-day'), title, and linked caseId.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Window start (inclusive), 'YYYY-MM-DD'." },
      to: { type: "string", description: "Window end (exclusive), 'YYYY-MM-DD'." },
      caseId: { type: "string", description: "Only events linked to this case id, e.g. 'CASE-1'." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Restrict to 'work' or 'life'." },
    },
  },
};

const GET_EVENT_TOOL = {
  name: "get_event",
  description:
    "Fetch a single calendar event by id (e.g. 'EVT-1') — `GET /api/events/{id}`. Read-only. Renders " +
    "the title, date, time (or all-day), description, location, domain, and the linked caseId. Unknown " +
    "id → tool error.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Event id, e.g. 'EVT-1'." },
    },
    required: ["id"],
  },
};

const UPDATE_EVENT_TOOL = {
  name: "update_event",
  description:
    "Update a calendar event's fields — `PATCH /api/events/{id}`. Pass only the fields you want to " +
    "change (any of: title, date, allDay, startTime, endTime, description, location, domain, caseId). " +
    "Set `caseId` to (re)link the appointment to a case, or pass `caseId: null` to UNLINK it (leave it " +
    "standalone). A non-empty caseId that doesn't reference an existing case is rejected with a 400.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Event id, e.g. 'EVT-1'." },
      title: { type: "string", description: "New title (non-empty)." },
      date: { type: "string", description: "New calendar day, 'YYYY-MM-DD'." },
      allDay: { type: "boolean", description: "Toggle all-day." },
      startTime: { type: "string", description: "New start time 'HH:MM' (24h)." },
      endTime: { type: "string", description: "New end time 'HH:MM' (24h)." },
      description: { type: "string", description: "New description." },
      location: { type: "string", description: "New location." },
      domain: { type: "string", enum: CASE_DOMAIN, description: "Refile to 'work' or 'life'." },
      caseId: {
        type: ["string", "null"],
        description:
          "(Re)link this appointment to a case id (e.g. 'CASE-2'); pass null to UNLINK it from any " +
          "case. An unknown caseId is rejected with a 400.",
      },
    },
    required: ["id"],
  },
};

const DELETE_EVENT_TOOL = {
  name: "delete_event",
  description:
    "Delete a calendar event by id (e.g. 'EVT-1') — `DELETE /api/events/{id}`. Events have no soft-" +
    "archive; this hard-removes the event. If it was linked to a case, that link is dropped (the case " +
    "itself is untouched).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Event id, e.g. 'EVT-1'." },
    },
    required: ["id"],
  },
};

const LINK_EVENT_TOOL = {
  name: "link_event",
  description:
    "Link (or unlink) an appointment to a case — `PATCH /api/events/{id} { caseId }`. Sugar for the " +
    "common case of rolling an existing event up under a case. " + LINK_GUARDRAIL +
    " Pass a `caseId` to link; pass null/empty (or omit) to UNLINK it from any case. An unknown caseId " +
    "is rejected with a 400.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Event id, e.g. 'EVT-1'." },
      caseId: {
        type: ["string", "null"],
        description:
          "Case id to link the appointment to (e.g. 'CASE-1'), so it rolls up under that case. Pass " +
          "null/empty to UNLINK it from any case.",
      },
    },
    required: ["id"],
  },
};

const TOOLS = [
  // reads
  LIST_EVENTS_TOOL,
  GET_EVENT_TOOL,
  // event lifecycle
  CREATE_EVENT_TOOL,
  UPDATE_EVENT_TOOL,
  DELETE_EVENT_TOOL,
  // linking sugar
  LINK_EVENT_TOOL,
];

const server = new Server(
  { name: "calendar", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Single point where every tool talks to the board, parameterized "calendar" so a 409
// reads "the calendar changed". (err/text/str come from mcp-kit.)
const api = makeBoardApi("calendar", CRM_BASE_URL);

// Calendar-day ("YYYY-MM-DD") and 24h time ("HH:MM") shape guards (mirror the route).
const isISODate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHHMM = (v) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

// One-line render of an event for list/summary output.
function eventLine(e) {
  const when = e.allDay ? "all-day" : [e.startTime, e.endTime].filter(Boolean).join("–") || "(no time)";
  return (
    `  - ${e.id}  ${e.date} ${when}  ${e.title}` +
    `${e.domain ? ` [${e.domain}]` : ""}${e.caseId ? `  → ${e.caseId}` : ""}`
  );
}

// ── Read tools ───────────────────────────────────────────────────────────────

async function handleListEvents(args) {
  const sp = new URLSearchParams();
  for (const k of ["from", "to", "caseId"]) {
    const v = str(args[k]);
    if (v) sp.set(k, v);
  }
  if (typeof args.domain === "string" && CASE_DOMAIN.includes(args.domain)) sp.set("domain", args.domain);
  const qs = sp.toString();

  const { data, errorResult } = await api("GET", `/api/events${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;

  const events = data.events ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!events.length) return text(`No calendar events${filters}.`);
  // Sort by day then start time so the list reads chronologically.
  const sorted = [...events].sort(
    (a, b) => (a.date.localeCompare(b.date)) || (a.startTime ?? "").localeCompare(b.startTime ?? "")
  );
  const lines = [`Events (${events.length})${filters}:`];
  for (const e of sorted) lines.push(eventLine(e));
  return text(lines.join("\n"));
}

async function handleGetEvent(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'EVT-1'.");

  const { data, errorResult } = await api("GET", `/api/events/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const e = data.event;
  const lines = [`${e.id} — ${e.title}`, `Date: ${e.date}`];
  if (e.allDay) {
    lines.push(`Time: all-day`);
  } else {
    const when = [e.startTime, e.endTime].filter(Boolean).join("–");
    lines.push(`Time: ${when || "(no time set)"}`);
  }
  if (e.domain) lines.push(`Domain: ${e.domain}`);
  if (e.location) lines.push(`Location: ${e.location}`);
  if (e.description) lines.push(`Description: ${e.description}`);
  lines.push(e.caseId ? `Linked case: ${e.caseId}` : `Linked case: (standalone — not linked to a case)`);
  return text(lines.join("\n"));
}

// ── Event lifecycle tools ────────────────────────────────────────────────────

async function handleCreateEvent(args) {
  if (typeof args.title !== "string" || args.title.trim() === "") {
    return err("'title' is required.");
  }
  if (!isISODate(args.date)) {
    return err("'date' is required as 'YYYY-MM-DD'.");
  }
  if (args.allDay !== undefined && typeof args.allDay !== "boolean") {
    return err("'allDay' must be a boolean.");
  }
  if (args.startTime !== undefined && !isHHMM(args.startTime)) {
    return err("'startTime' must be 'HH:MM' (24h).");
  }
  if (args.endTime !== undefined && !isHHMM(args.endTime)) {
    return err("'endTime' must be 'HH:MM' (24h).");
  }
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }

  const payload = { title: args.title, date: args.date };
  if (typeof args.allDay === "boolean") payload.allDay = args.allDay;
  for (const k of ["startTime", "endTime", "description", "location", "domain"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  // The board asserts a linked caseId references an existing case and 400s an
  // unknown one — surfaced via api()'s error path. Search the board FIRST.
  if (typeof args.caseId === "string" && args.caseId.trim()) payload.caseId = args.caseId.trim();

  const { data, errorResult } = await api("POST", "/api/events", payload);
  if (errorResult) return errorResult;

  const e = data.event;
  const when = e.allDay ? "all-day" : [e.startTime, e.endTime].filter(Boolean).join("–") || "(no time)";
  return text(
    `Created ${e.id} — "${e.title}"\n` +
      `Date: ${e.date} ${when}\n` +
      (e.location ? `Location: ${e.location}\n` : "") +
      (e.domain ? `Domain: ${e.domain}\n` : "") +
      (e.caseId
        ? `Linked to case ${e.caseId} (rolls up under it).`
        : `Standalone (not linked to a case). If a case matches, link_event it.`)
  );
}

async function handleUpdateEvent(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'EVT-1'.");
  if (args.title !== undefined && (typeof args.title !== "string" || args.title.trim() === "")) {
    return err("'title' must be a non-empty string.");
  }
  if (args.date !== undefined && !isISODate(args.date)) {
    return err("'date' must be 'YYYY-MM-DD'.");
  }
  if (args.allDay !== undefined && typeof args.allDay !== "boolean") {
    return err("'allDay' must be a boolean.");
  }
  if (args.startTime !== undefined && !isHHMM(args.startTime)) {
    return err("'startTime' must be 'HH:MM' (24h).");
  }
  if (args.endTime !== undefined && !isHHMM(args.endTime)) {
    return err("'endTime' must be 'HH:MM' (24h).");
  }
  if (args.domain !== undefined && !CASE_DOMAIN.includes(args.domain)) {
    return err(`'domain' must be one of: ${CASE_DOMAIN.join(", ")}.`);
  }

  const payload = {};
  if (typeof args.allDay === "boolean") payload.allDay = args.allDay;
  for (const k of ["title", "date", "startTime", "endTime", "description", "location", "domain"]) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  // null is a real update (unlink), so distinguish it from an absent caseId.
  if (args.caseId === null) payload.caseId = null;
  else if (typeof args.caseId === "string") payload.caseId = args.caseId;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one field besides 'id'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/events/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const e = data.event;
  const changed = Object.keys(payload).join(", ");
  const when = e.allDay ? "all-day" : [e.startTime, e.endTime].filter(Boolean).join("–") || "(no time)";
  return text(
    `Updated ${e.id} (${changed})\n` +
      `Date: ${e.date} ${when}\n` +
      (e.caseId ? `Linked case: ${e.caseId}` : `Linked case: (standalone)`)
  );
}

async function handleDeleteEvent(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'EVT-1'.");

  const { errorResult } = await api("DELETE", `/api/events/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Deleted ${id} (any case link was dropped; the case itself is untouched).`);
}

// ── Linking sugar ─────────────────────────────────────────────────────────────

async function handleLinkEvent(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'EVT-1'.");

  // null/empty/absent caseId all mean UNLINK; a non-empty string links.
  let payload;
  if (typeof args.caseId === "string" && args.caseId.trim()) {
    payload = { caseId: args.caseId.trim() };
  } else {
    payload = { caseId: null };
  }

  const { data, errorResult } = await api("PATCH", `/api/events/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const e = data.event;
  return text(
    e.caseId
      ? `Linked ${e.id} — "${e.title}" rolls up under ${e.caseId}.`
      : `Unlinked ${e.id} — "${e.title}" is now standalone (no case).`
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    // reads
    case "list_events":
      return handleListEvents(args);
    case "get_event":
      return handleGetEvent(args);
    // event lifecycle
    case "create_event":
      return handleCreateEvent(args);
    case "update_event":
      return handleUpdateEvent(args);
    case "delete_event":
      return handleDeleteEvent(args);
    // linking sugar
    case "link_event":
      return handleLinkEvent(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `calendar MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
