#!/usr/bin/env node
// MCP server (registry name "fitness") for the Cos Fitness add-on — Apple
// Watch HealthKit data ingestion and querying. A THIN fetch wrapper over the board's
// /api/fitness/* HTTP routes on CRM_BASE_URL (packages/mcp-kit primitives); the server
// holds NO business logic and never shells out to curl. Runs over stdio; front it with
// supergateway for the HTTP bridge (port 8011).
//
// Canonical data types (in lockstep with board/lib/types.ts VALID_HEALTH_ENTRY_TYPE):
//   workout, sleep_night, sleep_nap, hrv, resting_hr, steps, vo2max.
// (Plus any unmapped Health Auto Export metric names, stored verbatim by the push route.)
//
// The push endpoint (POST /api/fitness/push) is token-gated via the x-fitness-token
// header — the token lives in config/secrets.env as FITNESS_PUSH_TOKEN. The MCP tools
// that READ data are ungated; the WRITE tools (push/delete) attach the token automatically.
//
// makeBoardApi from mcp-kit is NOT used here: it attributes writes with actor:"agent"
// (header + body) for the board's activity log, whereas the fitness writes authenticate
// with the x-fitness-token shared secret instead — a different auth shape — so this thin
// healthApi keeps the token-header behaviour.
//
// Retention: the board auto-purges entries older than 90 days on every push.
//
// Config: CRM_BASE_URL (default http://localhost:3000)
//         FITNESS_PUSH_TOKEN (required for the write tools)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start, baseUrl } from "../../packages/mcp-kit/index.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");
const FITNESS_PUSH_TOKEN = (process.env.FITNESS_PUSH_TOKEN || "").trim();

// ── Canonical health-entry types (in lockstep with board/lib/types.ts
//    VALID_HEALTH_ENTRY_TYPE; the push route maps Health Auto Export metric
//    names onto these and stores unmapped names verbatim). ──
const HEALTH_TYPES = ["workout", "sleep_night", "sleep_nap", "hrv", "resting_hr", "steps", "vo2max"];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function healthApi(method, path, payload) {
  const headers = {};
  let body;

  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  // Attach the shared-secret auth token on writes (push/delete).
  if (method !== "GET" && FITNESS_PUSH_TOKEN) {
    headers["x-fitness-token"] = FITNESS_PUSH_TOKEN;
  }

  let res, data;
  try {
    const url = `${CRM_BASE_URL}${path}`;
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { errorResult: err(`Could not reach the board at ${CRM_BASE_URL}: ${e.message}`) };
  }
  if (res.status === 401) return { errorResult: err(data.error ?? "Unauthorized — check FITNESS_PUSH_TOKEN.") };
  if (res.status === 404) return { errorResult: err(data.error ?? "Not found — the fitness add-on may be disabled.") };
  if (!res.ok) return { errorResult: err(`Board returned ${res.status}: ${data.error ?? "unknown error"}`) };
  return { data };
}

// ── Tool definitions ────────────────────────────────────────────────────────

const PUSH_HEALTH_DATA_TOOL = {
  name: "push_health_data",
  description:
    "Push a batch of Apple Watch HealthKit entries in the canonical taxonomy " +
    "(workout, sleep_night, sleep_nap, hrv, resting_hr, steps, vo2max). " +
    "Each entry needs a globally-unique id, an ISO-8601 timestamp (ts), a canonical type, " +
    "and a type-specific data object. Entries are deduplicated by id. Entries older than " +
    "90 days are auto-purged. (The board also accepts raw Health Auto Export payloads " +
    "directly on POST /api/fitness/push; this tool is for already-canonical entries.)",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: "Array of canonical HealthKit entries to push.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique entry ID (e.g. hlth_abc123). Must be globally unique for dedup." },
            ts: { type: "string", description: "Timestamp: YYYY-MM-DD for daily metrics/sleep, full ISO-8601 for a workout start." },
            type: { type: "string", enum: HEALTH_TYPES, description: "Canonical health-entry type." },
            data: {
              type: "object",
              description:
                "Type-specific payload. Metrics carry a per-day aggregate in data.value: " +
                "hrv {value: ms}, resting_hr {value: bpm}, steps {value: count}, vo2max {value: mL/kg/min}. " +
                "sleep_night / sleep_nap {value: hours, metadata:{deep,rem,core,awake,sleepStart,sleepEnd}}. " +
                "workout {activity, duration_min, calories?, avg_hr?, distance_km?}.",
            },
          },
          required: ["id", "ts", "type", "data"],
        },
      },
    },
    required: ["entries"],
  },
};

const LIST_HEALTH_DATA_TOOL = {
  name: "list_health_data",
  description:
    "List stored HealthKit entries, optionally filtered by type and/or date range. " +
    "Returns entries sorted by timestamp descending.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: HEALTH_TYPES, description: "Filter by data type." },
      from: { type: "string", description: "Start date (YYYY-MM-DD), inclusive." },
      to: { type: "string", description: "End date (YYYY-MM-DD), exclusive." },
      limit: { type: "number", description: "Max entries to return (default 100)." },
    },
  },
};

const GET_HEALTH_SUMMARY_TOOL = {
  name: "get_health_summary",
  description:
    "Get an aggregated health summary for a specific date or date range. " +
    "Returns per-type aggregates: sleep {count, avg_hours, avg_deep_hours, avg_rem_hours}, " +
    "hrv {count, avg_ms}, resting_hr {count, avg_bpm}, steps {days, total, avg_per_day}, " +
    "vo2max {count, latest}, workout {count, total_duration_min, total_calories, activities}.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Single date (YYYY-MM-DD) to summarize." },
      from: { type: "string", description: "Start date (YYYY-MM-DD), inclusive. Used with 'to' for range summaries." },
      to: { type: "string", description: "End date (YYYY-MM-DD), exclusive." },
    },
  },
};

const DELETE_HEALTH_DATA_TOOL = {
  name: "delete_health_data",
  description:
    "Delete health entries by ID(s) or by date range. At least one of ids or from/to must be provided.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, description: "Specific entry IDs to delete." },
      from: { type: "string", description: "Delete entries from this date (YYYY-MM-DD), inclusive." },
      to: { type: "string", description: "Delete entries before this date (YYYY-MM-DD), exclusive." },
    },
  },
};

const GET_HEALTH_TRENDS_TOOL = {
  name: "get_health_trends",
  description:
    "Get health trends over the last N days. Returns daily averages and deltas for each metric type.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to look back (default 7)." },
      type: { type: "string", enum: HEALTH_TYPES, description: "Filter trends to a specific type." },
    },
  },
};

const GET_DAILY_SUMMARY_TOOL = {
  name: "get_daily_summary",
  description:
    "Get a full daily health + nutrition summary for a given date. " +
    "Returns workouts, sleep (night + naps), metrics (HRV, resting HR, steps), " +
    "food logs with macro totals, and a calorie balance (workout calories burned − calories ingested).",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to summarize (YYYY-MM-DD)." },
    },
    required: ["date"],
  },
};

const INGEST_HEALTH_TO_VAULT_TOOL = {
  name: "ingest_health_to_vault",
  description:
    "Compose a textual health summary from recent data and return it as structured content " +
    "ready for vault ingestion. The caller (the agent) should then pass the returned text " +
    "to the vault MCP's ingest tool with domain 'life'. This tool does NOT call the vault " +
    "directly — it prepares the content.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Number of days to summarize (default 7)." },
    },
  },
};

const TOOLS = [
  PUSH_HEALTH_DATA_TOOL,
  LIST_HEALTH_DATA_TOOL,
  GET_HEALTH_SUMMARY_TOOL,
  GET_DAILY_SUMMARY_TOOL,
  DELETE_HEALTH_DATA_TOOL,
  GET_HEALTH_TRENDS_TOOL,
  INGEST_HEALTH_TO_VAULT_TOOL,
];

// ── Tool handlers ───────────────────────────────────────────────────────────

async function handlePushHealthData(args) {
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return err("'entries' must be a non-empty array.");
  }
  if (!FITNESS_PUSH_TOKEN) {
    return err("FITNESS_PUSH_TOKEN is not configured — set it in config/secrets.env.");
  }
  for (const e of entries) {
    if (!e.id || !e.ts || !e.type || !e.data) {
      return err(`Entry missing required fields (id, ts, type, data): ${JSON.stringify(e)}`);
    }
    if (!HEALTH_TYPES.includes(e.type)) {
      return err(`Invalid type '${e.type}'. Valid: ${HEALTH_TYPES.join(", ")}.`);
    }
  }

  const { data, errorResult } = await healthApi("POST", "/api/fitness/push", { entries });
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleListHealthData(args) {
  const params = new URLSearchParams();
  if (args.type) params.set("type", args.type);
  if (args.from) params.set("from", args.from);
  if (args.to) params.set("to", args.to);
  if (args.limit) params.set("limit", String(args.limit));
  const qs = params.toString();

  const { data, errorResult } = await healthApi("GET", `/api/fitness/data${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetHealthSummary(args) {
  const params = new URLSearchParams();
  if (args.date) params.set("date", args.date);
  if (args.from) params.set("from", args.from);
  if (args.to) params.set("to", args.to);
  const qs = params.toString();

  const { data, errorResult } = await healthApi("GET", `/api/fitness/summary${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleDeleteHealthData(args) {
  if (!FITNESS_PUSH_TOKEN) {
    return err("FITNESS_PUSH_TOKEN is not configured — set it in config/secrets.env.");
  }
  const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
  const hasRange = args.from || args.to;
  if (!hasIds && !hasRange) {
    return err("Provide at least one of 'ids' or 'from'/'to'.");
  }

  const payload = {};
  if (hasIds) payload.ids = args.ids;
  if (args.from) payload.from = args.from;
  if (args.to) payload.to = args.to;

  const { data, errorResult } = await healthApi("DELETE", "/api/fitness/data", payload);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetDailySummary(args) {
  const date = str(args.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err("'date' is required as YYYY-MM-DD.");
  }
  const { data, errorResult } = await healthApi("GET", `/api/fitness/daily-summary?date=${date}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetHealthTrends(args) {
  const params = new URLSearchParams();
  params.set("days", String(args.days ?? 7));
  if (args.type) params.set("type", args.type);

  const { data, errorResult } = await healthApi("GET", `/api/fitness/trends?${params}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleIngestHealthToVault(args) {
  const days = args.days ?? 7;

  // The board composes the Markdown report from the canonical summarize() output
  // (GET /api/fitness/report?days=N); this tool is a THIN forwarder — no composition here.
  const { data, errorResult } = await healthApi("GET", `/api/fitness/report?days=${days}`);
  if (errorResult) return errorResult;

  return text(
    JSON.stringify({
      vault_ingest_content: data.markdown,
      domain: data.domain ?? "life",
      instruction:
        "Pass 'vault_ingest_content' as the 'content' argument and 'life' as the 'domain' " +
        "argument to the vault MCP's ingest tool to persist this health report in the knowledge base.",
    }, null, 2)
  );
}

// ── Server wiring ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "fitness", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "push_health_data":
      return handlePushHealthData(args);
    case "list_health_data":
      return handleListHealthData(args);
    case "get_health_summary":
      return handleGetHealthSummary(args);
    case "get_daily_summary":
      return handleGetDailySummary(args);
    case "delete_health_data":
      return handleDeleteHealthData(args);
    case "get_health_trends":
      return handleGetHealthTrends(args);
    case "ingest_health_to_vault":
      return handleIngestHealthToVault(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `fitness MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
