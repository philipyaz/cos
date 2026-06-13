#!/usr/bin/env node
// MCP server (registry name "nutrition") for the Cos "Nutrition & Chef" add-on —
// the food-log vertical. Every tool wraps the board's /api/nutrition/log HTTP routes
// over `fetch` on CRM_BASE_URL; the server never shells out to curl. Runs over stdio;
// Claude Desktop bridges it into Cowork, or front it with supergateway for the HTTP bridge.
//
// This is an ADD-ON, not a core server: its food-log WRITES are GATED behind the
// "nutrition" add-on flag in cases.json (Settings.addons.nutrition.enabled). When the
// add-on is disabled, the board 404s every write (surfaced here as a "Not found." tool
// error) while reads still work — so enable it from the board's /addons catalog first.
//
// Actor attribution: every WRITE sends { actor: "agent" } in the body (and an
// `x-actor: agent` header as a belt-and-braces twin) so the change is attributed to the
// agent, not a human. The board UI is the visual twin path that writes as "human".
//
// Food-log model (board/lib/types.ts → FoodLogEntry):
//   id          FOOD-<n>           minted like CASE-<n>/EVT-<n>
//   date*       "YYYY-MM-DD"       the day the meal was eaten
//   slot*       breakfast|lunch|dinner|snack
//   description* non-empty         what was eaten
//   items       string[]           optional itemised components
//   calories    number             kcal for the entry
//   protein/carbs/fat              optional macros (grams)
//   health      green|amber|red    optional health flag
//   estimated   boolean (def true) the calorie count is a guess
//   note                           optional freeform note
//   createdAt / updatedAt          ISO
//
// Phase 1 scope: food-log tools ONLY. Pantry + meal-plan are later phases.
//
// Config: CRM_BASE_URL (default http://localhost:3000)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Shared MCP helpers (result shapers, env reader, transport boot, the board api()
// factory) live in the mcp-kit module, imported by RELATIVE path so launchd's
// direct `node .../server.mjs` resolves it without any workspace install. (The SDK
// transport is constructed HERE, from this server's own SDK, and handed to start.)
import { err, text, str, start, baseUrl, makeBoardApi } from "../../packages/mcp-kit/index.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");

// In lockstep with VALID_MEAL_SLOT / VALID_HEALTH_RATING in board/lib/types.ts.
const MEAL_SLOT = ["breakfast", "lunch", "dinner", "snack"];
const HEALTH_RATING = ["green", "amber", "red"];

// The add-on guardrail, baked into the write tool descriptions so the agent knows a
// disabled add-on rejects writes (and where to enable it).
const ADDON_GUARDRAIL =
  "The Nutrition & Chef add-on must be ENABLED for writes to succeed — a disabled add-on " +
  "rejects this write as 'Not found.' Enable it from the board's /addons catalog (reads work either way).";

// ── Tool definitions (OUR food-log model field names exactly) ──────────────────

const LOG_FOOD_TOOL = {
  name: "log_food",
  description:
    "Log a meal / food entry on the Cos food log — `POST /api/nutrition/log`. " +
    ADDON_GUARDRAIL +
    " `date` is the calendar day the meal was eaten (YYYY-MM-DD); `slot` is which meal " +
    "(breakfast|lunch|dinner|snack); `description` is what was eaten (required). Provide " +
    "`calories` (kcal) and optionally the macros `protein`/`carbs`/`fat` (grams), a `health` " +
    "flag (green|amber|red), itemised `items`, and a `note`. `estimated` defaults to true " +
    "(the calorie count is a guess) — set it false only for a measured/labelled value. " +
    "Returns the minted FOOD-id.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Calendar day the meal was eaten, as 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "Which meal: breakfast | lunch | dinner | snack." },
      description: { type: "string", description: "What was eaten, e.g. 'Chicken salad with feta'." },
      items: {
        type: "array",
        items: { type: "string" },
        description: "Optional itemised components, e.g. ['2 eggs', 'toast', 'black coffee'].",
      },
      calories: { type: "number", description: "Energy for the entry, in kcal." },
      protein: { type: "number", description: "Optional protein macro, in grams." },
      carbs: { type: "number", description: "Optional carbohydrate macro, in grams." },
      fat: { type: "number", description: "Optional fat macro, in grams." },
      health: {
        type: "string",
        enum: HEALTH_RATING,
        description: "Optional health flag: 'green' (good), 'amber' (so-so), or 'red' (a treat).",
      },
      estimated: {
        type: "boolean",
        description: "True if the calorie count is a guess. Defaults to true; set false for a measured value.",
      },
      note: { type: "string", description: "Optional freeform note." },
    },
    required: ["date", "slot", "description"],
  },
};

const LIST_FOOD_LOG_TOOL = {
  name: "list_food_log",
  description:
    "List food-log entries — `GET /api/nutrition/log`. Read-only (works even if the add-on is " +
    "disabled). Filter by a half-open day window with `from` (inclusive) / `to` (exclusive) as " +
    "'YYYY-MM-DD', and/or by an exact `date` ('YYYY-MM-DD') and `slot` (breakfast|lunch|dinner|snack). " +
    "With no filters, returns ALL entries. Renders one line per entry, grouped by day, with a " +
    "per-day calorie rollup.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Window start (inclusive), 'YYYY-MM-DD'." },
      to: { type: "string", description: "Window end (exclusive), 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "Only entries in this meal slot." },
      date: { type: "string", description: "Only entries on this exact day, 'YYYY-MM-DD'." },
    },
  },
};

const GET_FOOD_LOG_TOOL = {
  name: "get_food_log",
  description:
    "Fetch a single food-log entry by id (e.g. 'FOOD-1') — `GET /api/nutrition/log/{id}`. Read-only. " +
    "Renders the day, slot, description, items, calories, macros, health flag, estimated/measured, and " +
    "note. Unknown id → tool error.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Food-log entry id, e.g. 'FOOD-1'." },
    },
    required: ["id"],
  },
};

const UPDATE_FOOD_LOG_TOOL = {
  name: "update_food_log",
  description:
    "Update a food-log entry's fields — `PATCH /api/nutrition/log/{id}`. " +
    ADDON_GUARDRAIL +
    " Pass only the fields you want to change (any of: date, slot, description, calories, protein, " +
    "carbs, fat, health, note). A null/empty value on an optional macro/note/health clears it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Food-log entry id, e.g. 'FOOD-1'." },
      date: { type: "string", description: "New calendar day, 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "New meal slot: breakfast | lunch | dinner | snack." },
      description: { type: "string", description: "New description (non-empty)." },
      calories: { type: "number", description: "New calorie count, in kcal." },
      protein: { type: "number", description: "New protein macro, in grams." },
      carbs: { type: "number", description: "New carbohydrate macro, in grams." },
      fat: { type: "number", description: "New fat macro, in grams." },
      health: { type: "string", enum: HEALTH_RATING, description: "New health flag: green | amber | red." },
      note: { type: "string", description: "New freeform note." },
    },
    required: ["id"],
  },
};

const DELETE_FOOD_LOG_TOOL = {
  name: "delete_food_log",
  description:
    "Delete a food-log entry by id (e.g. 'FOOD-1') — `DELETE /api/nutrition/log/{id}`. " +
    ADDON_GUARDRAIL +
    " Food-log entries have no soft-archive; this hard-removes the entry.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Food-log entry id, e.g. 'FOOD-1'." },
    },
    required: ["id"],
  },
};

const TOOLS = [
  // reads
  LIST_FOOD_LOG_TOOL,
  GET_FOOD_LOG_TOOL,
  // food-log lifecycle
  LOG_FOOD_TOOL,
  UPDATE_FOOD_LOG_TOOL,
  DELETE_FOOD_LOG_TOOL,
];

const server = new Server(
  { name: "nutrition", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Single point where every tool talks to the board, parameterized "food log" so a 409
// reads "the food log changed". (err/text/str come from mcp-kit.)
const api = makeBoardApi("food log", CRM_BASE_URL);

// Calendar-day ("YYYY-MM-DD") shape guard (mirror the route).
const isISODate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// One-line render of a food-log entry for list/summary output.
function foodLine(e) {
  const kcal = typeof e.calories === "number" ? `${e.calories} kcal` : "(no kcal)";
  const macros = ["protein", "carbs", "fat"]
    .filter((k) => typeof e[k] === "number")
    .map((k) => `${k[0].toUpperCase()}${e[k]}`) // P30 C40 F10
    .join(" ");
  return (
    `  - ${e.id}  ${e.slot}  ${e.description}  ${kcal}` +
    `${macros ? `  ${macros}` : ""}${e.health ? `  [${e.health}]` : ""}${e.estimated ? "  ~est" : ""}`
  );
}

// ── Read tools ───────────────────────────────────────────────────────────────

async function handleListFoodLog(args) {
  const sp = new URLSearchParams();
  for (const k of ["from", "to", "date"]) {
    const v = str(args[k]);
    if (v) sp.set(k, v);
  }
  if (typeof args.slot === "string" && MEAL_SLOT.includes(args.slot)) sp.set("slot", args.slot);
  const qs = sp.toString();

  const { data, errorResult } = await api("GET", `/api/nutrition/log${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;

  const entries = data.entries ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!entries.length) return text(`No food-log entries${filters}.`);

  // Group by day, sorted chronologically; within a day, by slot order then id.
  const slotRank = (s) => {
    const i = MEAL_SLOT.indexOf(s);
    return i === -1 ? MEAL_SLOT.length : i;
  };
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const days = [...byDay.keys()].sort((a, b) => a.localeCompare(b));

  const lines = [`Food log (${entries.length})${filters}:`];
  for (const day of days) {
    const dayEntries = byDay
      .get(day)
      .sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.id.localeCompare(b.id));
    // Per-day calorie rollup (only counts numeric calories).
    const kcal = dayEntries.reduce((sum, e) => sum + (typeof e.calories === "number" ? e.calories : 0), 0);
    lines.push(`${day} — ${dayEntries.length} entr${dayEntries.length === 1 ? "y" : "ies"}, ${kcal} kcal`);
    for (const e of dayEntries) lines.push(foodLine(e));
  }
  return text(lines.join("\n"));
}

async function handleGetFoodLog(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'FOOD-1'.");

  const { data, errorResult } = await api("GET", `/api/nutrition/log/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const e = data.entry;
  const lines = [`${e.id} — ${e.description}`, `Date: ${e.date}`, `Slot: ${e.slot}`];
  if (Array.isArray(e.items) && e.items.length) lines.push(`Items: ${e.items.join(", ")}`);
  lines.push(`Calories: ${typeof e.calories === "number" ? `${e.calories} kcal` : "(not set)"}`);
  const macros = ["protein", "carbs", "fat"]
    .filter((k) => typeof e[k] === "number")
    .map((k) => `${k} ${e[k]}g`)
    .join(", ");
  if (macros) lines.push(`Macros: ${macros}`);
  if (e.health) lines.push(`Health: ${e.health}`);
  lines.push(`Estimated: ${e.estimated ? "yes (the calorie count is a guess)" : "no (measured)"}`);
  if (e.note) lines.push(`Note: ${e.note}`);
  return text(lines.join("\n"));
}

// ── Food-log lifecycle tools ──────────────────────────────────────────────────

async function handleLogFood(args) {
  if (!isISODate(args.date)) {
    return err("'date' is required as 'YYYY-MM-DD'.");
  }
  if (typeof args.slot !== "string" || !MEAL_SLOT.includes(args.slot)) {
    return err(`'slot' is required and must be one of: ${MEAL_SLOT.join(", ")}.`);
  }
  if (typeof args.description !== "string" || args.description.trim() === "") {
    return err("'description' is required.");
  }
  for (const k of ["calories", "protein", "carbs", "fat"]) {
    if (args[k] !== undefined && typeof args[k] !== "number") {
      return err(`'${k}' must be a number.`);
    }
  }
  if (args.health !== undefined && !HEALTH_RATING.includes(args.health)) {
    return err(`'health' must be one of: ${HEALTH_RATING.join(", ")}.`);
  }
  if (args.estimated !== undefined && typeof args.estimated !== "boolean") {
    return err("'estimated' must be a boolean.");
  }
  if (args.items !== undefined && (!Array.isArray(args.items) || args.items.some((i) => typeof i !== "string"))) {
    return err("'items' must be an array of strings.");
  }

  const payload = { date: args.date, slot: args.slot, description: args.description };
  for (const k of ["calories", "protein", "carbs", "fat"]) {
    if (typeof args[k] === "number") payload[k] = args[k];
  }
  if (typeof args.health === "string") payload.health = args.health;
  if (typeof args.estimated === "boolean") payload.estimated = args.estimated;
  if (Array.isArray(args.items)) payload.items = args.items;
  if (typeof args.note === "string" && args.note !== "") payload.note = args.note;

  const { data, errorResult } = await api("POST", "/api/nutrition/log", payload);
  if (errorResult) return errorResult;

  const e = data.entry;
  const kcal = typeof e.calories === "number" ? `${e.calories} kcal` : "(no kcal)";
  return text(
    `Logged ${e.id} — "${e.description}"\n` +
      `Date: ${e.date}  Slot: ${e.slot}  ${kcal}${e.estimated ? "  ~estimated" : ""}\n` +
      (e.health ? `Health: ${e.health}\n` : "") +
      `Logged to the food log.`
  );
}

async function handleUpdateFoodLog(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'FOOD-1'.");
  if (args.date !== undefined && !isISODate(args.date)) {
    return err("'date' must be 'YYYY-MM-DD'.");
  }
  if (args.slot !== undefined && !MEAL_SLOT.includes(args.slot)) {
    return err(`'slot' must be one of: ${MEAL_SLOT.join(", ")}.`);
  }
  if (args.description !== undefined && (typeof args.description !== "string" || args.description.trim() === "")) {
    return err("'description' must be a non-empty string.");
  }
  for (const k of ["calories", "protein", "carbs", "fat"]) {
    if (args[k] !== undefined && typeof args[k] !== "number") {
      return err(`'${k}' must be a number.`);
    }
  }
  if (args.health !== undefined && !HEALTH_RATING.includes(args.health)) {
    return err(`'health' must be one of: ${HEALTH_RATING.join(", ")}.`);
  }

  const payload = {};
  for (const k of ["date", "slot", "description", "health", "note"]) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  for (const k of ["calories", "protein", "carbs", "fat"]) {
    if (typeof args[k] === "number") payload[k] = args[k];
  }
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one field besides 'id'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/nutrition/log/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const e = data.entry;
  const changed = Object.keys(payload).join(", ");
  const kcal = typeof e.calories === "number" ? `${e.calories} kcal` : "(no kcal)";
  return text(
    `Updated ${e.id} (${changed})\n` +
      `Date: ${e.date}  Slot: ${e.slot}  ${kcal}\n` +
      `"${e.description}"`
  );
}

async function handleDeleteFoodLog(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'FOOD-1'.");

  const { errorResult } = await api("DELETE", `/api/nutrition/log/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Deleted ${id} from the food log (no soft-archive; hard-removed).`);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    // reads
    case "list_food_log":
      return handleListFoodLog(args);
    case "get_food_log":
      return handleGetFoodLog(args);
    // food-log lifecycle
    case "log_food":
      return handleLogFood(args);
    case "update_food_log":
      return handleUpdateFoodLog(args);
    case "delete_food_log":
      return handleDeleteFoodLog(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `nutrition MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
