#!/usr/bin/env node
// MCP server (registry name "health") for the Cos Health add-on — Apple Watch
// HealthKit data ingestion and querying. Every tool wraps the board's
// /api/health/* HTTP routes over `fetch` on CRM_BASE_URL; the server never
// shells out to curl. Runs over stdio; front it with supergateway for the
// HTTP bridge (port 8011).
//
// Data types: sleep, hrv, steps, workout, vo2max, resting_hr.
//
// The push endpoint (POST /api/health/push) is token-gated via x-health-token
// header — the token lives in config/cos.env as HEALTH_PUSH_TOKEN. The MCP
// tools that READ data are ungated; the push_health_data tool attaches the
// token automatically.
//
// Retention: health.json auto-purges entries older than 90 days on every push.
//
// Config: CRM_BASE_URL (default http://localhost:3000)
//         HEALTH_PUSH_TOKEN (required for push_health_data)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start, baseUrl } from "../../packages/mcp-kit/index.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");
const HEALTH_PUSH_TOKEN = (process.env.HEALTH_PUSH_TOKEN || "").trim();

// ── Valid data types (in lockstep with board/app/api/health/push/route.ts) ──
const HEALTH_TYPES = ["sleep", "hrv", "steps", "workout", "vo2max", "resting_hr"];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function healthApi(method, path, payload) {
  const headers = {};
  let body;

  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  // Attach auth token on writes
  if (method !== "GET" && HEALTH_PUSH_TOKEN) {
    headers["x-health-token"] = HEALTH_PUSH_TOKEN;
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
  if (res.status === 401) return { errorResult: err(data.error ?? "Unauthorized — check HEALTH_PUSH_TOKEN.") };
  if (res.status === 404) return { errorResult: err(data.error ?? "Not found.") };
  if (!res.ok) return { errorResult: err(`Board returned ${res.status}: ${data.error ?? "unknown error"}`) };
  return { data };
}

// ── Tool definitions ────────────────────────────────────────────────────────

const PUSH_HEALTH_DATA_TOOL = {
  name: "push_health_data",
  description:
    "Push a batch of Apple Watch HealthKit entries (sleep, hrv, steps, workout, vo2max, resting_hr). " +
    "Each entry needs a type, timestamp (ts), and a type-specific data object. " +
    "Entries are deduplicated by id. Entries older than 90 days are auto-purged.",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: "Array of HealthKit entries to push.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique entry ID (e.g. hlth_abc123). Must be globally unique for dedup." },
            ts: { type: "string", description: "ISO-8601 timestamp of the measurement." },
            type: { type: "string", enum: HEALTH_TYPES, description: "HealthKit data type." },
            data: {
              type: "object",
              description:
                "Type-specific payload. " +
                "sleep: {duration_min, deep_min, rem_min, awake_min, bed_time, wake_time}. " +
                "hrv: {avg_ms, samples?}. " +
                "steps: {count, distance_km?}. " +
                "workout: {activity, duration_min, calories?, avg_hr?, distance_km?}. " +
                "vo2max: {value, unit?}. " +
                "resting_hr: {bpm}.",
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
    "Returns per-type aggregates (avg sleep duration, avg HRV, total steps, workouts, latest VO2max, avg resting HR).",
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
  if (!HEALTH_PUSH_TOKEN) {
    return err("HEALTH_PUSH_TOKEN is not configured — set it in config/cos.env.");
  }
  for (const e of entries) {
    if (!e.id || !e.ts || !e.type || !e.data) {
      return err(`Entry missing required fields (id, ts, type, data): ${JSON.stringify(e)}`);
    }
    if (!HEALTH_TYPES.includes(e.type)) {
      return err(`Invalid type '${e.type}'. Valid: ${HEALTH_TYPES.join(", ")}.`);
    }
  }

  const { data, errorResult } = await healthApi("POST", "/api/health/push", { entries });
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

  const { data, errorResult } = await healthApi("GET", `/api/health/data${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetHealthSummary(args) {
  const params = new URLSearchParams();
  if (args.date) params.set("date", args.date);
  if (args.from) params.set("from", args.from);
  if (args.to) params.set("to", args.to);
  const qs = params.toString();

  const { data, errorResult } = await healthApi("GET", `/api/health/summary${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleDeleteHealthData(args) {
  if (!HEALTH_PUSH_TOKEN) {
    return err("HEALTH_PUSH_TOKEN is not configured — set it in config/cos.env.");
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

  const { data, errorResult } = await healthApi("DELETE", "/api/health/data", payload);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetDailySummary(args) {
  const date = str(args.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err("'date' is required as YYYY-MM-DD.");
  }
  const { data, errorResult } = await healthApi("GET", `/api/health/daily-summary?date=${date}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetHealthTrends(args) {
  const params = new URLSearchParams();
  params.set("days", String(args.days ?? 7));
  if (args.type) params.set("type", args.type);

  const { data, errorResult } = await healthApi("GET", `/api/health/trends?${params}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleIngestHealthToVault(args) {
  const days = args.days ?? 7;

  // Fetch summary for the date range
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  const { data, errorResult } = await healthApi(
    "GET",
    `/api/health/summary?from=${fromStr}&to=${toStr}`
  );
  if (errorResult) return errorResult;

  // Also fetch the raw entries for detail
  const { data: listData, errorResult: listErr } = await healthApi(
    "GET",
    `/api/health/data?from=${fromStr}&to=${toStr}&limit=500`
  );
  if (listErr) return listErr;

  const summary = data;
  const entries = listData.entries ?? [];

  // Compose a human-readable health report for vault ingestion
  const lines = [
    `# Health Report: ${fromStr} to ${toStr}`,
    ``,
    `Source: Apple Watch HealthKit (auto-exported)`,
    `Period: ${days} days`,
    `Total entries: ${entries.length}`,
    ``,
  ];

  if (summary.sleep) {
    const s = summary.sleep;
    lines.push(`## Sleep`);
    lines.push(`- Average duration: ${s.avg_duration_min?.toFixed(0) ?? "N/A"} min`);
    lines.push(`- Average deep sleep: ${s.avg_deep_min?.toFixed(0) ?? "N/A"} min`);
    lines.push(`- Average REM: ${s.avg_rem_min?.toFixed(0) ?? "N/A"} min`);
    lines.push(`- Nights tracked: ${s.count ?? 0}`);
    lines.push(``);
  }

  if (summary.hrv) {
    const h = summary.hrv;
    lines.push(`## HRV (Heart Rate Variability)`);
    lines.push(`- Average: ${h.avg_ms?.toFixed(1) ?? "N/A"} ms`);
    lines.push(`- Measurements: ${h.count ?? 0}`);
    lines.push(``);
  }

  if (summary.resting_hr) {
    const r = summary.resting_hr;
    lines.push(`## Resting Heart Rate`);
    lines.push(`- Average: ${r.avg_bpm?.toFixed(0) ?? "N/A"} bpm`);
    lines.push(`- Measurements: ${r.count ?? 0}`);
    lines.push(``);
  }

  if (summary.steps) {
    const st = summary.steps;
    lines.push(`## Steps`);
    lines.push(`- Daily average: ${st.avg_count?.toFixed(0) ?? "N/A"}`);
    lines.push(`- Total: ${st.total_count ?? "N/A"}`);
    lines.push(`- Days tracked: ${st.count ?? 0}`);
    lines.push(``);
  }

  if (summary.vo2max) {
    const v = summary.vo2max;
    lines.push(`## VO2 Max`);
    lines.push(`- Latest: ${v.latest_value ?? "N/A"} mL/kg/min`);
    lines.push(`- Measurements: ${v.count ?? 0}`);
    lines.push(``);
  }

  if (summary.workout) {
    const w = summary.workout;
    lines.push(`## Workouts`);
    lines.push(`- Count: ${w.count ?? 0}`);
    lines.push(`- Total duration: ${w.total_duration_min?.toFixed(0) ?? "N/A"} min`);
    lines.push(`- Total calories: ${w.total_calories?.toFixed(0) ?? "N/A"} kcal`);
    if (w.activities && Object.keys(w.activities).length > 0) {
      lines.push(`- Activities: ${Object.entries(w.activities).map(([a, n]) => `${a} (${n})`).join(", ")}`);
    }
    lines.push(``);
  }

  const content = lines.join("\n");

  return text(
    JSON.stringify({
      vault_ingest_content: content,
      domain: "life",
      instruction:
        "Pass 'vault_ingest_content' as the 'content' argument and 'life' as the 'domain' " +
        "argument to the vault MCP's ingest tool to persist this health report in the knowledge base.",
    }, null, 2)
  );
}

// ── Server wiring ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "health", version: "1.0.0" },
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
  `health MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
