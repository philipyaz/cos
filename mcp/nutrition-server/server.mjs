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
// Scope: the food-log vertical (FOOD-<n>) PLUS the pantry vertical (PantryItem,
// PANTRY-<n>, /api/nutrition/pantry) and the meal-plan vertical (MealPlanEntry,
// MEAL-<n>, /api/nutrition/plan) AND the weight-loss vertical below. All mirror the
// same tool shape + gate model.
//
// Weight-loss vertical (board/lib/types.ts → WeightEntry / NutritionGoal, engine in
// board/lib/nutrition-targets.ts). It adds three things the agent can drive:
//   • a WEIGH-IN time-series — WeightEntry, one per day (the date is the upsert key):
//       id        WEIGHT-<n>         minted like FOOD-<n>
//       date*     "YYYY-MM-DD"       UNIQUE per day — POST upserts by this key
//       weightKg* number            canonical storage is ALWAYS kilograms (the route
//                                    converts a weightLb entry to kg before storing)
//       note                        optional freeform note
//   • a GOAL/PROFILE SINGLETON — NutritionGoal (exactly one, no id):
//       sex*      male|female        BMR sex constant
//       age*      number (years)     BMR input
//       heightCm* number            BMR + BMI input
//       activity* sedentary|light|moderate|very_active|extra_active  (TDEE multiplier)
//       targetWeightKg* number      the goal weight (kg)
//       rateKgPerWeek  number        DESIRED loss rate (default 0.5) — the engine CLAMPS
//                                    it (≤1%/wk of body weight, ≤1.0 kg/wk) for safety
//       weightUnit     kg|lb         DISPLAY/entry preference only; storage stays kg
//   • a derived TARGETS envelope — a read-only "how am I doing" projection over the
//     goal + weigh-ins + food log: BMR/TDEE (estimated AND a measured feedback-loop
//     TDEE), a daily calorie target + protein/fat/carb macros, the effective deficit,
//     BMI, an ETA to target, per-day adherence, and the safety guardrail flags. It is
//     ALWAYS resolvable (nulls + a `needs` list when the goal/weight isn't set yet) and
//     ALWAYS carries the leading "not medical advice" note — this is informational only.
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
// In lockstep with VALID_PANTRY_CATEGORY / VALID_PANTRY_LOCATION / VALID_MEAL_PLAN_STATUS
// in board/lib/types.ts (pantry + meal-plan verticals).
const PANTRY_CATEGORY = ["produce", "protein", "dairy", "grain", "pantry", "frozen", "spice", "other"];
const PANTRY_LOCATION = ["fridge", "freezer", "pantry"];
const MEAL_PLAN_STATUS = ["planned", "cooked", "skipped"];
// In lockstep with VALID_ACTIVITY_LEVEL / VALID_BIOLOGICAL_SEX in board/lib/types.ts
// (the weight-loss goal vertical). WEIGHT_UNIT is the goal's display/entry preference.
const ACTIVITY_LEVEL = ["sedentary", "light", "moderate", "very_active", "extra_active"];
const BIOLOGICAL_SEX = ["male", "female"];
const WEIGHT_UNIT = ["kg", "lb"];
// Pounds → kilograms. The ROUTE does the canonical lb→kg conversion for the wire payload (we
// forward the caller's raw input unit); LB_TO_KG is mirrored here ONLY for the kg→lb DISPLAY
// twin in the weigh-in (list/log) + goal renders. `kgToLb` is that one-line display helper.
const LB_TO_KG = 0.45359237;
const kgToLb = (kg) => `${(kg / LB_TO_KG).toFixed(1)} lb`;

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

// ── Pantry tool definitions (OUR pantry model field names exactly) ─────────────

const READ_PANTRY_TOOL = {
  name: "read_pantry",
  description:
    "Read the pantry / on-hand inventory — `GET /api/nutrition/pantry`. Read-only (works even if the " +
    "add-on is disabled). Filter by `category` (produce|protein|dairy|grain|pantry|frozen|spice|other), " +
    "`location` (fridge|freezer|pantry), `expiringBefore` ('YYYY-MM-DD' — only items whose expiry is " +
    "before that day), and/or `lowStock` (true — only items flagged running-low). With no filters, " +
    "returns ALL items. Renders the items grouped by category, flagging expiring-soon + low-stock items.",
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", enum: PANTRY_CATEGORY, description: "Only items in this food category." },
      location: { type: "string", enum: PANTRY_LOCATION, description: "Only items stored here: fridge | freezer | pantry." },
      expiringBefore: { type: "string", description: "Only items whose expiry is before this day, 'YYYY-MM-DD'." },
      lowStock: { type: "boolean", description: "True to return only items flagged running-low." },
    },
  },
};

const ADD_PANTRY_ITEM_TOOL = {
  name: "add_pantry_item",
  description:
    "Add an item to the pantry — `POST /api/nutrition/pantry`. " +
    ADDON_GUARDRAIL +
    " `name` is required (what the item is). Optionally provide `quantity` (amount on hand), `unit` " +
    "('g', 'cans', 'bunch'), `category` (produce|protein|dairy|grain|pantry|frozen|spice|other), " +
    "`location` (fridge|freezer|pantry), `expiresAt` ('YYYY-MM-DD' expiry), and a `note`. Returns the " +
    "minted PANTRY-id.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What the item is, e.g. 'Greek yoghurt'." },
      quantity: { type: "number", description: "Optional amount on hand, e.g. 2." },
      unit: { type: "string", description: "Optional unit, e.g. 'g', 'cans', 'bunch'." },
      category: { type: "string", enum: PANTRY_CATEGORY, description: "Optional food category." },
      location: { type: "string", enum: PANTRY_LOCATION, description: "Optional storage location: fridge | freezer | pantry." },
      expiresAt: { type: "string", description: "Optional expiry day, 'YYYY-MM-DD'." },
      note: { type: "string", description: "Optional freeform note." },
    },
    required: ["name"],
  },
};

const UPDATE_PANTRY_ITEM_TOOL = {
  name: "update_pantry_item",
  description:
    "Update a pantry item's fields — `PATCH /api/nutrition/pantry/{id}`. " +
    ADDON_GUARDRAIL +
    " Pass only the fields you want to change (any of: name, quantity, unit, category, location, " +
    "expiresAt, lowStock, note). Set `lowStock` true/false to flag/clear running-low. " +
    "To record PARTIAL consumption, set `quantity` to the amount STILL LEFT. When an item is " +
    "USED UP, call `remove_pantry_item` instead — do NOT set `quantity` to 0 (a zero-quantity " +
    "row is a ghost; 'gone' means removed, not zero).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Pantry item id, e.g. 'PANTRY-1'." },
      name: { type: "string", description: "New name (non-empty)." },
      quantity: { type: "number", description: "New amount STILL ON HAND (use remove_pantry_item, not 0, when used up)." },
      unit: { type: "string", description: "New unit, e.g. 'g', 'cans', 'bunch'." },
      category: { type: "string", enum: PANTRY_CATEGORY, description: "New food category." },
      location: { type: "string", enum: PANTRY_LOCATION, description: "New storage location: fridge | freezer | pantry." },
      expiresAt: { type: "string", description: "New expiry day, 'YYYY-MM-DD'." },
      lowStock: { type: "boolean", description: "Set true/false to flag/clear the running-low flag." },
      note: { type: "string", description: "New freeform note." },
    },
    required: ["id"],
  },
};

const REMOVE_PANTRY_ITEM_TOOL = {
  name: "remove_pantry_item",
  description:
    "Remove a pantry item by id (e.g. 'PANTRY-1') — `DELETE /api/nutrition/pantry/{id}`. " +
    ADDON_GUARDRAIL +
    " This is the RIGHT tool when an item is used up / finished / thrown out (NOT " +
    "`update_pantry_item` with quantity 0). Pantry items have no soft-archive; this hard-removes " +
    "the item. (Meal-plan `pantryItemIds` are soft refs — a removed item leaves them dangling, " +
    "which is tolerated.)",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Pantry item id, e.g. 'PANTRY-1'." },
    },
    required: ["id"],
  },
};

// ── Meal-plan tool definitions (OUR meal-plan model field names exactly) ───────

const PLAN_MEAL_TOOL = {
  name: "plan_meal",
  description:
    "Plan a meal on a day/slot — `POST /api/nutrition/plan`. " +
    ADDON_GUARDRAIL +
    " `date` ('YYYY-MM-DD'), `slot` (breakfast|lunch|dinner|snack), and `title` are required. " +
    "Optionally provide a `recipe` (text/link), an `ingredients` list, `servings`, `pantryItemIds` " +
    "(SOFT refs to PANTRY-ids — not validated, dangling tolerated), and `eventId` (a CalendarEvent " +
    "EVT-id to show the meal on the calendar — it MUST exist or the write is rejected). New entries " +
    "default to status 'planned'. Returns the minted MEAL-id.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Day the meal is planned for, 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "Which meal: breakfast | lunch | dinner | snack." },
      title: { type: "string", description: "The meal name, e.g. 'Sheet-pan salmon'." },
      recipe: { type: "string", description: "Optional recipe text or link." },
      ingredients: {
        type: "array",
        items: { type: "string" },
        description: "Optional ingredient list, e.g. ['salmon', 'broccoli', 'lemon'].",
      },
      servings: { type: "number", description: "Optional serving count." },
      pantryItemIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional SOFT refs to pantry items (PANTRY-ids); not validated, dangling tolerated.",
      },
      eventId: { type: "string", description: "Optional CalendarEvent id (EVT-<n>) to link — it must exist." },
    },
    required: ["date", "slot", "title"],
  },
};

const LIST_MEAL_PLAN_TOOL = {
  name: "list_meal_plan",
  description:
    "List meal-plan entries — `GET /api/nutrition/plan`. Read-only (works even if the add-on is " +
    "disabled). Filter by a half-open day window with `from` (inclusive) / `to` (exclusive) as " +
    "'YYYY-MM-DD', and/or by `slot` (breakfast|lunch|dinner|snack) and `status` (planned|cooked|skipped). " +
    "With no filters, returns ALL entries. Renders a per-day agenda, one line per entry.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Window start (inclusive), 'YYYY-MM-DD'." },
      to: { type: "string", description: "Window end (exclusive), 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "Only entries in this meal slot." },
      status: { type: "string", enum: MEAL_PLAN_STATUS, description: "Only entries with this status: planned | cooked | skipped." },
    },
  },
};

const GET_MEAL_PLAN_TOOL = {
  name: "get_meal_plan",
  description:
    "Fetch a single meal-plan entry by id (e.g. 'MEAL-1') — `GET /api/nutrition/plan/{id}`. Read-only. " +
    "Renders the day, slot, title, recipe, ingredients, servings, status, linked pantry items, linked " +
    "calendar event, and note. Unknown id → tool error.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Meal-plan entry id, e.g. 'MEAL-1'." },
    },
    required: ["id"],
  },
};

const UPDATE_MEAL_PLAN_TOOL = {
  name: "update_meal_plan",
  description:
    "Update a meal-plan entry's fields — `PATCH /api/nutrition/plan/{id}`. " +
    ADDON_GUARDRAIL +
    " Pass only the fields you want to change (any of: date, slot, title, recipe, ingredients, servings, " +
    "status, pantryItemIds, eventId). Set `status` to planned|cooked|skipped. A non-empty `eventId` links " +
    "to a CalendarEvent (EVT-id — it MUST exist); `eventId` null UNLINKS it. `pantryItemIds` are soft refs " +
    "(not validated).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Meal-plan entry id, e.g. 'MEAL-1'." },
      date: { type: "string", description: "New day, 'YYYY-MM-DD'." },
      slot: { type: "string", enum: MEAL_SLOT, description: "New meal slot: breakfast | lunch | dinner | snack." },
      title: { type: "string", description: "New title (non-empty)." },
      recipe: { type: "string", description: "New recipe text or link." },
      ingredients: {
        type: "array",
        items: { type: "string" },
        description: "New ingredient list (replaces the old one).",
      },
      servings: { type: "number", description: "New serving count." },
      status: { type: "string", enum: MEAL_PLAN_STATUS, description: "New status: planned | cooked | skipped." },
      pantryItemIds: {
        type: "array",
        items: { type: "string" },
        description: "New SOFT refs to pantry items (PANTRY-ids); not validated, dangling tolerated.",
      },
      eventId: {
        type: ["string", "null"],
        description: "A CalendarEvent id (EVT-<n>) to link (it must exist), or null to UNLINK.",
      },
    },
    required: ["id"],
  },
};

const REMOVE_MEAL_PLAN_TOOL = {
  name: "remove_meal_plan",
  description:
    "Remove a meal-plan entry by id (e.g. 'MEAL-1') — `DELETE /api/nutrition/plan/{id}`. " +
    ADDON_GUARDRAIL +
    " Meal-plan entries have no soft-archive; this hard-removes the entry. (A linked CalendarEvent is " +
    "NOT touched.)",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Meal-plan entry id, e.g. 'MEAL-1'." },
    },
    required: ["id"],
  },
};

const GET_NUTRITION_TARGETS_TOOL = {
  name: "get_nutrition_targets",
  description:
    "Read the LATEST agent-authored daily nutrition targets — `GET /api/nutrition/targets?latest=daily_targets`. " +
    "Read-only. Returns the most recently SAVED daily target (calories + macros + the agent's stance/rationale), " +
    "or 'none yet'. The board does NOT compute this — author today's with save_nutrition_targets after reading " +
    "the goal (get_body_objective), the physiology facts (get_body_status), and get_diet_profile.",
  inputSchema: { type: "object", properties: {} },
};

// ── v14 dietary profile + agent-authored targets ──────────────────────────────

const GET_DIET_PROFILE_TOOL = {
  name: "get_diet_profile",
  description:
    "Read the dietary profile — `GET /api/nutrition/diet-profile`. Read-only. Returns `allergies` (a " +
    "SAFETY list you MUST honor — NEVER plan or suggest a meal containing one), `dietType` (regime tags: " +
    "vegan / halal / no-pork / keto …), `notes` (intolerances, foods avoided, preferences — soft), and " +
    "`philosophy` (the 'our views on diet' methodology to follow when setting targets; a study-grounded " +
    "default ships, the user can override it). CALL THIS FIRST before planning a meal, logging food " +
    "against a plan, or authoring nutrition targets — if it errors, STOP and ask the user to confirm allergies.",
  inputSchema: { type: "object", properties: {} },
};

const SET_DIET_PROFILE_TOOL = {
  name: "set_diet_profile",
  description:
    "Update the dietary profile — `PATCH /api/nutrition/diet-profile` (MERGE: send ONLY the fields you " +
    "change). " +
    ADDON_GUARDRAIL +
    " `allergies` is SAFETY-CRITICAL — a sent list REPLACES the old one, so to ADD one send the FULL new " +
    "array (e.g. {allergies: [...existing, 'peanuts']}). `dietType` is regime tags (free strings: 'vegan', " +
    "'halal', 'no-pork', 'keto'). `notes` is free text (intolerances / foods avoided / preferences). " +
    "`philosophy` is the free-text 'views on diet' methodology — overwrite it for a vegan/keto/etc. user; " +
    "leaving it empty restores the shipped default.",
  inputSchema: {
    type: "object",
    properties: {
      allergies: { type: "array", items: { type: "string" }, description: "SAFETY list — the FULL allergy array (replaces the old one)." },
      dietType: { type: "array", items: { type: "string" }, description: "Regime tags (free strings): vegan, halal, no-pork, keto…" },
      notes: { type: "string", description: "Free text: intolerances, foods avoided, non-allergy issues, preferences." },
      philosophy: { type: "string", description: "The 'our views on diet' methodology (free text). Empty restores the shipped default." },
    },
  },
};

const SAVE_NUTRITION_TARGETS_TOOL = {
  name: "save_nutrition_targets",
  description:
    "Save the daily nutrition targets YOU authored — `POST /api/nutrition/targets`. " +
    ADDON_GUARDRAIL +
    " The board NEVER computes targets; you do, from get_body_objective + get_body_status + get_diet_profile " +
    "+ the recent food log, then persist the result here (the save_training_plan pattern). Upserts by day. " +
    "`periodKey` is the day 'YYYY-MM-DD' (defaults to today). Put the plan in `payload`: `daily_calories` " +
    "(required number) + `protein_g`/`fat_g`/`carbs_g` + an optional `stance` ('deficit'|'surplus'|'maintenance'), " +
    "`rationale` (why these numbers, citing the diet philosophy), and any extra fields — stored verbatim. " +
    "The response carries board-computed `warnings` (e.g. a below-floor calorie note).",
  inputSchema: {
    type: "object",
    properties: {
      periodKey: { type: "string", description: "The day 'YYYY-MM-DD' (the upsert key). Defaults to today." },
      payload: {
        type: "object",
        description: "Your authored targets. Requires daily_calories (number); include protein_g/fat_g/carbs_g, stance, rationale, etc.",
      },
    },
    required: ["payload"],
  },
};

const LIST_NUTRITION_TARGETS_TOOL = {
  name: "list_nutrition_targets",
  description:
    "List saved daily nutrition targets (history) — `GET /api/nutrition/targets`. Read-only. Filter by a " +
    "half-open day window `from` (inclusive) / `to` (exclusive) as 'YYYY-MM-DD'. Newest first, one line per day.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Window start (inclusive), 'YYYY-MM-DD'." },
      to: { type: "string", description: "Window end (exclusive), 'YYYY-MM-DD'." },
    },
  },
};

const TOOLS = [
  // reads
  LIST_FOOD_LOG_TOOL,
  GET_FOOD_LOG_TOOL,
  READ_PANTRY_TOOL,
  LIST_MEAL_PLAN_TOOL,
  GET_MEAL_PLAN_TOOL,
  GET_NUTRITION_TARGETS_TOOL,
  GET_DIET_PROFILE_TOOL,
  LIST_NUTRITION_TARGETS_TOOL,
  // food-log lifecycle
  LOG_FOOD_TOOL,
  UPDATE_FOOD_LOG_TOOL,
  DELETE_FOOD_LOG_TOOL,
  // pantry lifecycle
  ADD_PANTRY_ITEM_TOOL,
  UPDATE_PANTRY_ITEM_TOOL,
  REMOVE_PANTRY_ITEM_TOOL,
  // meal-plan lifecycle
  PLAN_MEAL_TOOL,
  UPDATE_MEAL_PLAN_TOOL,
  REMOVE_MEAL_PLAN_TOOL,
  // v14 dietary profile + agent-authored targets
  SET_DIET_PROFILE_TOOL,
  SAVE_NUTRITION_TARGETS_TOOL,
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

// Today, as "YYYY-MM-DD" in local time — the anchor for the expiring-soon window.
const today = () => {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

// One-line render of a pantry item for the grouped pantry listing. `flags` annotates
// expiring-soon (within 3 days / already past) + low-stock so they pop in the list.
function pantryLine(it) {
  const qty =
    typeof it.quantity === "number"
      ? ` ${it.quantity}${it.unit ? ` ${it.unit}` : ""}`
      : it.unit
        ? ` (${it.unit})`
        : "";
  const flags = [];
  if (it.lowStock) flags.push("LOW");
  if (it.expiresAt) {
    const now = today();
    if (it.expiresAt < now) flags.push(`EXPIRED ${it.expiresAt}`);
    else {
      // expiring soon === within 3 days of today (inclusive of today).
      const soon = new Date(`${now}T00:00:00`);
      soon.setDate(soon.getDate() + 3);
      const soonDay = `${soon.getFullYear()}-${`${soon.getMonth() + 1}`.padStart(2, "0")}-${`${soon.getDate()}`.padStart(2, "0")}`;
      if (it.expiresAt <= soonDay) flags.push(`exp ${it.expiresAt}`);
    }
  }
  const loc = it.location ? `  @${it.location}` : "";
  return `  - ${it.id}  ${it.name}${qty}${loc}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

// One-line render of a meal-plan entry for the per-day agenda.
function mealLine(e) {
  const servings = typeof e.servings === "number" ? `  x${e.servings}` : "";
  const status = e.status && e.status !== "planned" ? `  (${e.status})` : "";
  const evt = e.eventId ? `  →${e.eventId}` : "";
  return `  - ${e.id}  ${e.slot}  ${e.title}${servings}${status}${evt}`;
}

// ── Read tools ───────────────────────────────────────────────────────────────

// Shared day-grouping for the list renders (food log + meal plan): bucket entries by their
// ISO `date`, return the days chronologically, each paired with that day's entries sorted by
// meal slot then id. `slotRank` ranks the four meal slots; an unknown slot sorts last.
const slotRank = (s) => {
  const i = MEAL_SLOT.indexOf(s);
  return i === -1 ? MEAL_SLOT.length : i;
};
function groupByDayThenSlot(entries) {
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  return [...byDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => [day, byDay.get(day).sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.id.localeCompare(b.id))]);
}

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

  // Group by day (chronological), each day's entries by slot then id — see groupByDayThenSlot.
  const lines = [`Food log (${entries.length})${filters}:`];
  for (const [day, dayEntries] of groupByDayThenSlot(entries)) {
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

// ── Pantry tools ───────────────────────────────────────────────────────────────

async function handleReadPantry(args) {
  const sp = new URLSearchParams();
  const expiringBefore = str(args.expiringBefore);
  if (typeof args.category === "string" && PANTRY_CATEGORY.includes(args.category)) sp.set("category", args.category);
  if (typeof args.location === "string" && PANTRY_LOCATION.includes(args.location)) sp.set("location", args.location);
  if (expiringBefore) sp.set("expiringBefore", expiringBefore);
  if (args.lowStock === true) sp.set("lowStock", "true");
  const qs = sp.toString();

  const { data, errorResult } = await api("GET", `/api/nutrition/pantry${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;

  const items = data.items ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!items.length) return text(`No pantry items${filters}.`);

  // Group by category (in the canonical PANTRY_CATEGORY order, then any unknowns last);
  // within a category, by name then id. An absent category groups under "uncategorised".
  const catRank = (c) => {
    const i = PANTRY_CATEGORY.indexOf(c);
    return i === -1 ? PANTRY_CATEGORY.length : i;
  };
  const byCat = new Map();
  for (const it of items) {
    const key = it.category ?? "uncategorised";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const cats = [...byCat.keys()].sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));

  const lines = [`Pantry (${items.length})${filters}:`];
  for (const cat of cats) {
    const catItems = byCat
      .get(cat)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    lines.push(`${cat} — ${catItems.length} item${catItems.length === 1 ? "" : "s"}`);
    for (const it of catItems) lines.push(pantryLine(it));
  }
  return text(lines.join("\n"));
}

async function handleAddPantryItem(args) {
  if (typeof args.name !== "string" || args.name.trim() === "") {
    return err("'name' is required.");
  }
  if (args.quantity !== undefined && typeof args.quantity !== "number") {
    return err("'quantity' must be a number.");
  }
  if (args.category !== undefined && !PANTRY_CATEGORY.includes(args.category)) {
    return err(`'category' must be one of: ${PANTRY_CATEGORY.join(", ")}.`);
  }
  if (args.location !== undefined && !PANTRY_LOCATION.includes(args.location)) {
    return err(`'location' must be one of: ${PANTRY_LOCATION.join(", ")}.`);
  }
  if (args.expiresAt !== undefined && !isISODate(args.expiresAt)) {
    return err("'expiresAt' must be 'YYYY-MM-DD'.");
  }

  const payload = { name: args.name };
  if (typeof args.quantity === "number") payload.quantity = args.quantity;
  for (const k of ["unit", "category", "location", "expiresAt", "note"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }

  const { data, errorResult } = await api("POST", "/api/nutrition/pantry", payload);
  if (errorResult) return errorResult;

  const it = data.item;
  const qty = typeof it.quantity === "number" ? `  ${it.quantity}${it.unit ? ` ${it.unit}` : ""}` : "";
  return text(
    `Added ${it.id} — "${it.name}"${qty}\n` +
      (it.category ? `Category: ${it.category}  ` : "") +
      (it.location ? `Location: ${it.location}  ` : "") +
      (it.expiresAt ? `Expires: ${it.expiresAt}` : "") +
      `\nAdded to the pantry.`
  );
}

async function handleUpdatePantryItem(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'PANTRY-1'.");
  if (args.name !== undefined && (typeof args.name !== "string" || args.name.trim() === "")) {
    return err("'name' must be a non-empty string.");
  }
  if (args.quantity !== undefined && typeof args.quantity !== "number") {
    return err("'quantity' must be a number.");
  }
  if (args.category !== undefined && !PANTRY_CATEGORY.includes(args.category)) {
    return err(`'category' must be one of: ${PANTRY_CATEGORY.join(", ")}.`);
  }
  if (args.location !== undefined && !PANTRY_LOCATION.includes(args.location)) {
    return err(`'location' must be one of: ${PANTRY_LOCATION.join(", ")}.`);
  }
  if (args.expiresAt !== undefined && !isISODate(args.expiresAt)) {
    return err("'expiresAt' must be 'YYYY-MM-DD'.");
  }
  if (args.lowStock !== undefined && typeof args.lowStock !== "boolean") {
    return err("'lowStock' must be a boolean.");
  }

  const payload = {};
  for (const k of ["name", "unit", "category", "location", "expiresAt", "note"]) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  if (typeof args.quantity === "number") payload.quantity = args.quantity;
  if (typeof args.lowStock === "boolean") payload.lowStock = args.lowStock;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one field besides 'id'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/nutrition/pantry/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const it = data.item;
  const changed = Object.keys(payload).join(", ");
  const qty = typeof it.quantity === "number" ? `  ${it.quantity}${it.unit ? ` ${it.unit}` : ""}` : "";
  return text(
    `Updated ${it.id} (${changed})\n` +
      `"${it.name}"${qty}${it.lowStock ? "  [LOW]" : ""}`
  );
}

async function handleRemovePantryItem(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'PANTRY-1'.");

  const { errorResult } = await api("DELETE", `/api/nutrition/pantry/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Removed ${id} from the pantry (no soft-archive; hard-removed).`);
}

// ── Meal-plan tools ────────────────────────────────────────────────────────────

async function handlePlanMeal(args) {
  if (!isISODate(args.date)) {
    return err("'date' is required as 'YYYY-MM-DD'.");
  }
  if (typeof args.slot !== "string" || !MEAL_SLOT.includes(args.slot)) {
    return err(`'slot' is required and must be one of: ${MEAL_SLOT.join(", ")}.`);
  }
  if (typeof args.title !== "string" || args.title.trim() === "") {
    return err("'title' is required.");
  }
  if (args.servings !== undefined && typeof args.servings !== "number") {
    return err("'servings' must be a number.");
  }
  if (
    args.ingredients !== undefined &&
    (!Array.isArray(args.ingredients) || args.ingredients.some((i) => typeof i !== "string"))
  ) {
    return err("'ingredients' must be an array of strings.");
  }
  if (
    args.pantryItemIds !== undefined &&
    (!Array.isArray(args.pantryItemIds) || args.pantryItemIds.some((i) => typeof i !== "string"))
  ) {
    return err("'pantryItemIds' must be an array of strings.");
  }

  const payload = { date: args.date, slot: args.slot, title: args.title };
  for (const k of ["recipe", "eventId", "note"]) {
    if (typeof args[k] === "string" && args[k] !== "") payload[k] = args[k];
  }
  if (typeof args.servings === "number") payload.servings = args.servings;
  if (Array.isArray(args.ingredients)) payload.ingredients = args.ingredients;
  if (Array.isArray(args.pantryItemIds)) payload.pantryItemIds = args.pantryItemIds;

  const { data, errorResult } = await api("POST", "/api/nutrition/plan", payload);
  if (errorResult) return errorResult;

  const e = data.entry;
  return text(
    `Planned ${e.id} — "${e.title}"\n` +
      `Date: ${e.date}  Slot: ${e.slot}  Status: ${e.status}` +
      (typeof e.servings === "number" ? `  x${e.servings}` : "") +
      (e.eventId ? `\nLinked event: ${e.eventId}` : "") +
      `\nAdded to the meal plan.`
  );
}

async function handleListMealPlan(args) {
  const sp = new URLSearchParams();
  for (const k of ["from", "to"]) {
    const v = str(args[k]);
    if (v) sp.set(k, v);
  }
  if (typeof args.slot === "string" && MEAL_SLOT.includes(args.slot)) sp.set("slot", args.slot);
  if (typeof args.status === "string" && MEAL_PLAN_STATUS.includes(args.status)) sp.set("status", args.status);
  const qs = sp.toString();

  const { data, errorResult } = await api("GET", `/api/nutrition/plan${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;

  const entries = data.entries ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!entries.length) return text(`No meal-plan entries${filters}.`);

  // Per-day agenda: group by day (chronological), each day's entries by slot then id.
  const lines = [`Meal plan (${entries.length})${filters}:`];
  for (const [day, dayEntries] of groupByDayThenSlot(entries)) {
    lines.push(`${day} — ${dayEntries.length} meal${dayEntries.length === 1 ? "" : "s"}`);
    for (const e of dayEntries) lines.push(mealLine(e));
  }
  return text(lines.join("\n"));
}

async function handleGetMealPlan(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'MEAL-1'.");

  const { data, errorResult } = await api("GET", `/api/nutrition/plan/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  const e = data.entry;
  const lines = [`${e.id} — ${e.title}`, `Date: ${e.date}`, `Slot: ${e.slot}`, `Status: ${e.status}`];
  if (typeof e.servings === "number") lines.push(`Servings: ${e.servings}`);
  if (e.recipe) lines.push(`Recipe: ${e.recipe}`);
  if (Array.isArray(e.ingredients) && e.ingredients.length) lines.push(`Ingredients: ${e.ingredients.join(", ")}`);
  if (Array.isArray(e.pantryItemIds) && e.pantryItemIds.length) {
    lines.push(`Pantry items: ${e.pantryItemIds.join(", ")} (soft refs)`);
  }
  if (e.eventId) lines.push(`Linked event: ${e.eventId}`);
  if (e.note) lines.push(`Note: ${e.note}`);
  return text(lines.join("\n"));
}

async function handleUpdateMealPlan(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'MEAL-1'.");
  if (args.date !== undefined && !isISODate(args.date)) {
    return err("'date' must be 'YYYY-MM-DD'.");
  }
  if (args.slot !== undefined && !MEAL_SLOT.includes(args.slot)) {
    return err(`'slot' must be one of: ${MEAL_SLOT.join(", ")}.`);
  }
  if (args.title !== undefined && (typeof args.title !== "string" || args.title.trim() === "")) {
    return err("'title' must be a non-empty string.");
  }
  if (args.servings !== undefined && typeof args.servings !== "number") {
    return err("'servings' must be a number.");
  }
  if (args.status !== undefined && !MEAL_PLAN_STATUS.includes(args.status)) {
    return err(`'status' must be one of: ${MEAL_PLAN_STATUS.join(", ")}.`);
  }
  if (
    args.ingredients !== undefined &&
    (!Array.isArray(args.ingredients) || args.ingredients.some((i) => typeof i !== "string"))
  ) {
    return err("'ingredients' must be an array of strings.");
  }
  if (
    args.pantryItemIds !== undefined &&
    (!Array.isArray(args.pantryItemIds) || args.pantryItemIds.some((i) => typeof i !== "string"))
  ) {
    return err("'pantryItemIds' must be an array of strings.");
  }
  // eventId: a non-empty string links (must exist server-side); null UNLINKS. Reject any
  // other shape locally so the unlink-vs-link intent stays unambiguous.
  if (args.eventId !== undefined && args.eventId !== null && typeof args.eventId !== "string") {
    return err("'eventId' must be a CalendarEvent id (EVT-<n>) string, or null to unlink.");
  }

  const payload = {};
  for (const k of ["date", "slot", "title", "recipe", "note"]) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  if (typeof args.servings === "number") payload.servings = args.servings;
  if (typeof args.status === "string") payload.status = args.status;
  if (Array.isArray(args.ingredients)) payload.ingredients = args.ingredients;
  if (Array.isArray(args.pantryItemIds)) payload.pantryItemIds = args.pantryItemIds;
  // eventId is forwarded for both a non-empty link AND the explicit null unlink.
  if (args.eventId === null || typeof args.eventId === "string") payload.eventId = args.eventId;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one field besides 'id'.");
  }

  const { data, errorResult } = await api("PATCH", `/api/nutrition/plan/${encodeURIComponent(id)}`, payload);
  if (errorResult) return errorResult;

  const e = data.entry;
  const changed = Object.keys(payload).join(", ");
  return text(
    `Updated ${e.id} (${changed})\n` +
      `Date: ${e.date}  Slot: ${e.slot}  Status: ${e.status}\n` +
      `"${e.title}"` +
      (e.eventId ? `\nLinked event: ${e.eventId}` : "")
  );
}

async function handleRemoveMealPlan(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'MEAL-1'.");

  const { errorResult } = await api("DELETE", `/api/nutrition/plan/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;

  return text(`Removed ${id} from the meal plan (no soft-archive; hard-removed).`);
}

// Render one target artifact's macros compactly (P.. F.. C..).
function targetMacros(p) {
  return ["protein_g", "fat_g", "carbs_g"]
    .filter((k) => typeof p[k] === "number")
    .map((k) => `${k.replace("_g", "")} ${p[k]}g`)
    .join(" · ");
}

async function handleGetNutritionTargets() {
  const { data, errorResult } = await api("GET", "/api/nutrition/targets?latest=daily_targets");
  if (errorResult) return errorResult;
  const a = data.artifact;
  if (!a) {
    return text(
      "No daily nutrition targets saved yet. Author today's with save_nutrition_targets — first read " +
        "get_body_objective (the goal), get_body_status (the physiology facts), and get_diet_profile " +
        "(allergies + the diet-views methodology)."
    );
  }
  const p = a.payload ?? {};
  const lines = [
    `Latest daily targets — ${a.periodKey} (authored by ${a.source}):`,
    `Calories: ${p.daily_calories ?? "—"} kcal${p.stance ? `  (${p.stance})` : ""}`,
  ];
  const macros = targetMacros(p);
  if (macros) lines.push(`Macros: ${macros}`);
  if (p.rationale) lines.push(`Rationale: ${p.rationale}`);
  return text(lines.join("\n"));
}

async function handleListNutritionTargets(args) {
  const sp = new URLSearchParams();
  for (const k of ["from", "to"]) {
    const v = str(args[k]);
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  const { data, errorResult } = await api("GET", `/api/nutrition/targets${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  const items = data.items ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!items.length) return text(`No saved nutrition targets${filters}. Author today's with save_nutrition_targets.`);
  const lines = [`Nutrition targets (${items.length}, newest first)${filters}:`];
  for (const a of items) {
    const p = a.payload ?? {};
    const m = ["protein_g", "fat_g", "carbs_g"].filter((k) => typeof p[k] === "number").map((k) => `${k.replace("_g", "")[0].toUpperCase()}${p[k]}`).join(" ");
    lines.push(`  - ${a.periodKey}  ${p.daily_calories ?? "—"} kcal${m ? `  ${m}` : ""}${p.stance ? `  (${p.stance})` : ""}  [${a.source}]`);
  }
  return text(lines.join("\n"));
}

// ── Dietary profile tools ────────────────────────────────────────────────────

async function handleGetDietProfile() {
  const { data, errorResult } = await api("GET", "/api/nutrition/diet-profile");
  if (errorResult) return errorResult;
  const p = data.profile ?? {};
  const lines = ["Dietary profile:"];
  lines.push(`Allergies (SAFETY — NEVER serve these): ${p.allergies?.length ? p.allergies.join(", ") : "none recorded"}`);
  lines.push(`Diet type / regime: ${p.dietType?.length ? p.dietType.join(", ") : "none"}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  lines.push("");
  lines.push("Our views on diet (the methodology to follow when setting targets):");
  lines.push(p.philosophy || "(none)");
  return text(lines.join("\n"));
}

async function handleSetDietProfile(args) {
  const payload = {};
  if (Array.isArray(args.allergies)) payload.allergies = args.allergies.filter((s) => typeof s === "string");
  if (Array.isArray(args.dietType)) payload.dietType = args.dietType.filter((s) => typeof s === "string");
  if (typeof args.notes === "string") payload.notes = args.notes;
  if (typeof args.philosophy === "string") payload.philosophy = args.philosophy;
  if (Object.keys(payload).length === 0) {
    return err("Nothing to update — pass at least one of: allergies, dietType, notes, philosophy.");
  }
  const { data, errorResult } = await api("PATCH", "/api/nutrition/diet-profile", payload);
  if (errorResult) return errorResult;
  const p = data.profile ?? {};
  return text(
    `Dietary profile updated (${Object.keys(payload).join(", ")}).\n` +
      `Allergies: ${p.allergies?.length ? p.allergies.join(", ") : "none"}  ·  Diet: ${p.dietType?.length ? p.dietType.join(", ") : "none"}`
  );
}

async function handleSaveNutritionTargets(args) {
  if (!args.payload || typeof args.payload !== "object" || Array.isArray(args.payload)) {
    return err("'payload' is required and must be an object with at least daily_calories (number).");
  }
  if (typeof args.payload.daily_calories !== "number") {
    return err("'payload.daily_calories' is required and must be a number.");
  }
  const body = { payload: args.payload };
  if (typeof args.periodKey === "string" && args.periodKey !== "") body.periodKey = args.periodKey;

  const { data, errorResult } = await api("POST", "/api/nutrition/targets", body);
  if (errorResult) return errorResult;
  const a = data.artifact;
  const p = a.payload ?? {};
  const lines = [
    `${data.created ? "Saved" : "Updated"} daily targets for ${a.periodKey} (${a.id}).`,
    `Calories: ${p.daily_calories} kcal${p.stance ? `  (${p.stance})` : ""}`,
  ];
  const macros = targetMacros(p);
  if (macros) lines.push(`Macros: ${macros}`);
  if (p.rationale) lines.push(`Rationale: ${p.rationale}`);
  if (Array.isArray(data.warnings)) for (const w of data.warnings) lines.push(`[${w.level}] ${w.message}`);
  return text(lines.join("\n"));
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
    case "read_pantry":
      return handleReadPantry(args);
    case "list_meal_plan":
      return handleListMealPlan(args);
    case "get_meal_plan":
      return handleGetMealPlan(args);
    case "get_nutrition_targets":
      return handleGetNutritionTargets(args);
    case "list_nutrition_targets":
      return handleListNutritionTargets(args);
    case "get_diet_profile":
      return handleGetDietProfile(args);
    // food-log lifecycle
    case "log_food":
      return handleLogFood(args);
    case "update_food_log":
      return handleUpdateFoodLog(args);
    case "delete_food_log":
      return handleDeleteFoodLog(args);
    // pantry lifecycle
    case "add_pantry_item":
      return handleAddPantryItem(args);
    case "update_pantry_item":
      return handleUpdatePantryItem(args);
    case "remove_pantry_item":
      return handleRemovePantryItem(args);
    // meal-plan lifecycle
    case "plan_meal":
      return handlePlanMeal(args);
    case "update_meal_plan":
      return handleUpdateMealPlan(args);
    case "remove_meal_plan":
      return handleRemoveMealPlan(args);
    // weight-loss lifecycle
    case "set_diet_profile":
      return handleSetDietProfile(args);
    case "save_nutrition_targets":
      return handleSaveNutritionTargets(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `nutrition MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
