#!/usr/bin/env node
// MCP server (registry name "body") for the Cos "Body" add-on — the SINGLE OWNER of body
// identity, the weight + body-composition series, and the user's objective. Every tool is a thin
// wrapper over the board's /api/body/* HTTP routes via `fetch` on CRM_BASE_URL; the server never
// shells out. Runs over stdio (Cowork bridges it directly; Claude Code fronts it with supergateway).
//
// ADD-ON gate: WRITES are GATED behind Settings.addons.body.enabled (a disabled add-on 404s every
// write, surfaced here as "Not found."); READS always work. "body" HARD auto-enables whenever the
// nutrition or fitness add-on is enabled, so in practice it is on whenever a consumer is.
//
// Actor attribution: every WRITE sends { actor: "agent" } + an `x-actor: agent` header so the change
// is attributed to the agent, not a human.
//
// THE PHILOSOPHY (read before authoring): this add-on stores body STATE; it never recommends. The
// objective is FREE TEXT (a paragraph in the user's own words) + ONE structured anchor (target
// weight). get_body_status returns deterministic physiology FACTS (BMR/TDEE/BMI/trend/FFM) — NOT a
// calorie/macro plan. The agent reads the goal + the facts + the dietary profile + the diet-views
// philosophy (the nutrition add-on's get_diet_profile) and AUTHORS the daily targets via the
// nutrition add-on's save_nutrition_targets. This server owns identity/weight/objective only.
//
// Config: CRM_BASE_URL (default http://localhost:3000)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start, baseUrl, makeBoardApi } from "../../packages/mcp-kit/index.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");

// In lockstep with board/lib/types.ts: VALID_BIOLOGICAL_SEX / VALID_TRAINING_STATUS / VALID_ACTIVITY_LEVEL.
const BIOLOGICAL_SEX = ["male", "female"];
const TRAINING_STATUS = ["novice", "intermediate", "advanced"];
const ACTIVITY_LEVEL = ["sedentary", "light", "moderate", "very_active", "extra_active"];
const WEIGHT_UNIT = ["kg", "lb"];

const LB_TO_KG = 0.45359237;
const kgToLb = (kg) => `${(kg / LB_TO_KG).toFixed(1)} lb`;
const isISODate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

const ADDON_GUARDRAIL =
  "The Body add-on must be ENABLED for writes to succeed — a disabled add-on rejects this write as " +
  "'Not found.' (Body auto-enables when Nutrition or Fitness is on; reads work either way.)";

// ── Tool definitions ─────────────────────────────────────────────────────────

const GET_BODY_PROFILE_TOOL = {
  name: "get_body_profile",
  description:
    "Read the body-identity SINGLETON — `GET /api/body/profile`. Read-only. Returns sex, dateOfBirth " +
    "(age is derived, never stored), heightCm, trainingStatus (novice|intermediate|advanced), " +
    "resistanceTrains (does the user lift), and the weightUnit display preference. 'not set' when none.",
  inputSchema: { type: "object", properties: {} },
};

const SET_BODY_PROFILE_TOOL = {
  name: "set_body_profile",
  description:
    "Set (create or replace) the body-identity SINGLETON — `PUT /api/body/profile`. " +
    ADDON_GUARDRAIL +
    " Required: `sex` (male|female), `dateOfBirth` ('YYYY-MM-DD' — store the DOB, not an age), " +
    "`heightCm` (>0), `trainingStatus` (novice|intermediate|advanced), `resistanceTrains` (boolean). " +
    "Optional: `weightUnit` (kg|lb display preference; storage stays kg). There is exactly ONE profile.",
  inputSchema: {
    type: "object",
    properties: {
      sex: { type: "string", enum: BIOLOGICAL_SEX, description: "Biological sex for the BMR equation." },
      dateOfBirth: { type: "string", description: "Date of birth as 'YYYY-MM-DD' (age is derived at read time)." },
      heightCm: { type: "number", description: "Height in centimetres (>0)." },
      trainingStatus: { type: "string", enum: TRAINING_STATUS, description: "Resistance-training experience: novice | intermediate | advanced." },
      resistanceTrains: { type: "boolean", description: "Does the user do resistance training at all? (gates muscle/recomp realism)." },
      weightUnit: { type: "string", enum: WEIGHT_UNIT, description: "Display/entry unit preference: kg | lb (storage stays kg). Default kg." },
    },
    required: ["sex", "dateOfBirth", "heightCm", "trainingStatus", "resistanceTrains"],
  },
};

const GET_BODY_OBJECTIVE_TOOL = {
  name: "get_body_objective",
  description:
    "Read the body-objective SINGLETON — `GET /api/body/objective`. Read-only. Returns the FREE-TEXT " +
    "`goalText` (the user's objective in their own words), the `targetWeightKg` anchor (or null), an " +
    "optional `targetDate`, and `activity` (the TDEE multiplier). The agent reads this FIRST when " +
    "authoring nutrition targets or a training plan. 'not set' when none.",
  inputSchema: { type: "object", properties: {} },
};

const SET_BODY_OBJECTIVE_TOOL = {
  name: "set_body_objective",
  description:
    "Set (create or replace) the body objective — `PUT /api/body/objective`. " +
    ADDON_GUARDRAIL +
    " The goal is FREE TEXT: write the user's objective in their own words in `goalText` (fat loss, " +
    "muscle gain, recomposition, performance, 'just eat better' — whatever they said; there is NO " +
    "fixed list to pick from). The only structured anchor is `targetWeightKg` (a number, or null when " +
    "there is no scale target — recomp/maintenance legitimately omit it); `targetDate` is optional. " +
    "`activity` (sedentary|light|moderate|very_active|extra_active) is required — default it to " +
    "'moderate' if unknown. IMPORTANT: before authoring any meal plan or daily nutrition targets from " +
    "this goal you MUST also read the nutrition add-on's get_diet_profile — its `allergies` are a HARD " +
    "constraint a plan may never violate, and its `philosophy` is the diet-views methodology to follow.",
  inputSchema: {
    type: "object",
    properties: {
      goalText: { type: "string", description: "The user's objective in their OWN words (free text). May be empty." },
      targetWeightKg: { type: ["number", "null"], description: "Target weight in kg, or null when there is no scale target." },
      targetDate: { type: ["string", "null"], description: "Optional deadline 'YYYY-MM-DD', or null." },
      activity: { type: "string", enum: ACTIVITY_LEVEL, description: "Activity level (TDEE multiplier). Default 'moderate'." },
    },
    required: ["activity"],
  },
};

const LOG_WEIGHT_TOOL = {
  name: "log_weight",
  description:
    "Record a weigh-in (+ optional body composition) — `POST /api/body/weight`. " +
    ADDON_GUARDRAIL +
    " UPSERTS BY DAY (one entry per `date` 'YYYY-MM-DD'). Give the weight EXACTLY ONE way: `weightKg` " +
    "OR `weightLb` (pounds → kg server-side). Optionally attach body composition: `bodyFatPct` (3..60), " +
    "`leanMassKg` (fat-free mass), `waistCm` (the primary recomp signal) — these power the agent's " +
    "FFM-anchored protein + recomp tracking. Optional `note`. Returns the WEIGHT-id; 201 created / 200 updated.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Calendar day of the weigh-in 'YYYY-MM-DD' (the upsert key)." },
      weightKg: { type: "number", description: "Weight in kilograms. Give EITHER this OR weightLb." },
      weightLb: { type: "number", description: "Weight in pounds (converted to kg server-side). Give EITHER this OR weightKg." },
      bodyFatPct: { type: "number", description: "Optional body-fat percentage (3..60)." },
      leanMassKg: { type: "number", description: "Optional fat-free mass in kg (from a DXA / smart scale)." },
      waistCm: { type: "number", description: "Optional waist circumference in cm — the scale-independent recomp signal." },
      note: { type: "string", description: "Optional freeform note." },
    },
    required: ["date"],
  },
};

const LIST_WEIGHTS_TOOL = {
  name: "list_weights",
  description:
    "List weigh-ins + body composition — `GET /api/body/weight`. Read-only. Filter by a half-open day " +
    "window with `from` (inclusive) / `to` (exclusive) as 'YYYY-MM-DD'. Renders one line per day " +
    "(oldest first) with weight + any body-comp, and the raw first→last delta.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Window start (inclusive), 'YYYY-MM-DD'." },
      to: { type: "string", description: "Window end (exclusive), 'YYYY-MM-DD'." },
    },
  },
};

const DELETE_WEIGHT_TOOL = {
  name: "delete_weight",
  description:
    "Delete a weigh-in by id (e.g. 'WEIGHT-1') — `DELETE /api/body/weight/{id}`. " +
    ADDON_GUARDRAIL +
    " Weigh-ins have no soft-archive; this hard-removes the entry.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Weigh-in id, e.g. 'WEIGHT-1'." } },
    required: ["id"],
  },
};

const GET_BODY_STATUS_TOOL = {
  name: "get_body_status",
  description:
    "The deterministic physiology BASELINE — `GET /api/body/status`. Read-only. Returns FACTS ONLY: " +
    "current + EWMA-trend weight, derived age, BMR (Mifflin-St Jeor), estimated TDEE (maintenance) and " +
    "the measured-TDEE feedback loop with which basis is in use, BMI, fat-free mass (measured or " +
    "derived), and the latest waist reading — plus the raw profile + objective. It does NOT return a " +
    "calorie/macro recommendation: that is the agent's job (author it via the nutrition add-on's " +
    "save_nutrition_targets after reading the goal, this baseline, and get_diet_profile).",
  inputSchema: { type: "object", properties: {} },
};

const TOOLS = [
  GET_BODY_PROFILE_TOOL,
  SET_BODY_PROFILE_TOOL,
  GET_BODY_OBJECTIVE_TOOL,
  SET_BODY_OBJECTIVE_TOOL,
  LOG_WEIGHT_TOOL,
  LIST_WEIGHTS_TOOL,
  DELETE_WEIGHT_TOOL,
  GET_BODY_STATUS_TOOL,
];

const server = new Server({ name: "body", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const api = makeBoardApi("body", CRM_BASE_URL);

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleGetBodyProfile() {
  const { data, errorResult } = await api("GET", "/api/body/profile");
  if (errorResult) return errorResult;
  const p = data.profile;
  if (!p) return text("No body profile set yet. Set one with set_body_profile (sex, dateOfBirth, heightCm, trainingStatus, resistanceTrains).");
  return text(
    [
      "Body profile:",
      `Sex: ${p.sex}`,
      `Date of birth: ${p.dateOfBirth}`,
      `Height: ${p.heightCm} cm`,
      `Training status: ${p.trainingStatus}`,
      `Resistance trains: ${p.resistanceTrains ? "yes" : "no"}`,
      `Weight unit (display): ${p.weightUnit ?? "kg"}`,
    ].join("\n"),
  );
}

async function handleSetBodyProfile(args) {
  if (!BIOLOGICAL_SEX.includes(args.sex)) return err(`'sex' is required and must be one of: ${BIOLOGICAL_SEX.join(", ")}.`);
  if (!isISODate(args.dateOfBirth)) return err("'dateOfBirth' is required as 'YYYY-MM-DD'.");
  if (typeof args.heightCm !== "number" || !(args.heightCm > 0)) return err("'heightCm' is required and must be a positive number.");
  if (!TRAINING_STATUS.includes(args.trainingStatus)) return err(`'trainingStatus' is required and must be one of: ${TRAINING_STATUS.join(", ")}.`);
  if (typeof args.resistanceTrains !== "boolean") return err("'resistanceTrains' is required and must be a boolean.");
  if (args.weightUnit !== undefined && !WEIGHT_UNIT.includes(args.weightUnit)) return err(`'weightUnit' must be one of: ${WEIGHT_UNIT.join(", ")}.`);

  const payload = {
    sex: args.sex,
    dateOfBirth: args.dateOfBirth,
    heightCm: args.heightCm,
    trainingStatus: args.trainingStatus,
    resistanceTrains: args.resistanceTrains,
  };
  if (typeof args.weightUnit === "string") payload.weightUnit = args.weightUnit;

  const { data, errorResult } = await api("PUT", "/api/body/profile", payload);
  if (errorResult) return errorResult;
  const p = data.profile;
  return text(`Body profile set.\nSex: ${p.sex}  DOB: ${p.dateOfBirth}  Height: ${p.heightCm} cm\nTraining: ${p.trainingStatus}  Lifts: ${p.resistanceTrains ? "yes" : "no"}`);
}

async function handleGetBodyObjective() {
  const { data, errorResult } = await api("GET", "/api/body/objective");
  if (errorResult) return errorResult;
  const o = data.objective;
  if (!o) return text("No body objective set yet. Set one with set_body_objective (describe the goal in the user's own words in goalText + an optional targetWeightKg).");
  const lines = ["Body objective:", `Goal (free text): ${o.goalText || "(none written)"}`];
  lines.push(`Target weight: ${o.targetWeightKg != null ? `${o.targetWeightKg} kg (${kgToLb(o.targetWeightKg)})` : "none (no scale target)"}`);
  if (o.targetDate) lines.push(`Target date: ${o.targetDate}`);
  lines.push(`Activity: ${o.activity}`);
  return text(lines.join("\n"));
}

async function handleSetBodyObjective(args) {
  if (!ACTIVITY_LEVEL.includes(args.activity)) return err(`'activity' is required and must be one of: ${ACTIVITY_LEVEL.join(", ")} (default 'moderate').`);
  if (args.goalText !== undefined && typeof args.goalText !== "string") return err("'goalText' must be a string.");
  if (args.targetWeightKg !== undefined && args.targetWeightKg !== null && (typeof args.targetWeightKg !== "number" || !(args.targetWeightKg > 0))) {
    return err("'targetWeightKg' must be a positive number, or null.");
  }
  if (args.targetDate !== undefined && args.targetDate !== null && !isISODate(args.targetDate)) {
    return err("'targetDate' must be 'YYYY-MM-DD' or null.");
  }

  const payload = { activity: args.activity };
  if (typeof args.goalText === "string") payload.goalText = args.goalText;
  if (args.targetWeightKg === null || typeof args.targetWeightKg === "number") payload.targetWeightKg = args.targetWeightKg;
  if (args.targetDate === null || typeof args.targetDate === "string") payload.targetDate = args.targetDate;

  const { data, errorResult } = await api("PUT", "/api/body/objective", payload);
  if (errorResult) return errorResult;
  const o = data.objective;
  return text(
    `Objective set.\nGoal: ${o.goalText || "(none written)"}\n` +
      `Target: ${o.targetWeightKg != null ? `${o.targetWeightKg} kg` : "none"}  Activity: ${o.activity}\n` +
      `Remember: read get_diet_profile (allergies + diet philosophy) before authoring targets via save_nutrition_targets.`,
  );
}

async function handleLogWeight(args) {
  if (!isISODate(args.date)) return err("'date' is required as 'YYYY-MM-DD'.");
  const hasKg = args.weightKg !== undefined;
  const hasLb = args.weightLb !== undefined;
  if (hasKg && hasLb) return err("Give EXACTLY ONE of 'weightKg' or 'weightLb', not both.");
  if (!hasKg && !hasLb) return err("A weight is required: pass 'weightKg' (kilograms) or 'weightLb' (pounds).");
  if (hasKg && (typeof args.weightKg !== "number" || !(args.weightKg > 0))) return err("'weightKg' must be a positive number.");
  if (hasLb && (typeof args.weightLb !== "number" || !(args.weightLb > 0))) return err("'weightLb' must be a positive number.");
  for (const [k, lo, hi] of [["bodyFatPct", 3, 60], ["leanMassKg", 1, 300], ["waistCm", 20, 300]]) {
    if (args[k] !== undefined && (typeof args[k] !== "number" || args[k] < lo || args[k] > hi)) {
      return err(`'${k}' must be a number between ${lo} and ${hi}.`);
    }
  }

  const payload = { date: args.date };
  if (hasKg) payload.weightKg = args.weightKg;
  if (hasLb) payload.weightLb = args.weightLb;
  for (const k of ["bodyFatPct", "leanMassKg", "waistCm"]) if (typeof args[k] === "number") payload[k] = args[k];
  if (typeof args.note === "string" && args.note !== "") payload.note = args.note;

  const { data, errorResult } = await api("POST", "/api/body/weight", payload);
  if (errorResult) return errorResult;
  const w = data.entry;
  const comp = ["bodyFatPct", "leanMassKg", "waistCm"].filter((k) => typeof w[k] === "number").map((k) => `${k} ${w[k]}`).join("  ");
  return text(
    `${data.created ? "Logged" : "Updated"} ${w.id} — ${w.date}\n` +
      `Weight: ${w.weightKg.toFixed(1)} kg (${kgToLb(w.weightKg)})${comp ? `\nComposition: ${comp}` : ""}${w.note ? `\nNote: ${w.note}` : ""}`,
  );
}

function weightLine(w) {
  const comp = ["bodyFatPct", "leanMassKg", "waistCm"]
    .filter((k) => typeof w[k] === "number")
    .map((k) => `${k === "bodyFatPct" ? `${w[k]}%bf` : k === "leanMassKg" ? `${w[k]}kg lean` : `${w[k]}cm waist`}`)
    .join(" ");
  return `  - ${w.date}  ${w.weightKg.toFixed(1)} kg (${kgToLb(w.weightKg)})${comp ? `  ${comp}` : ""}${w.note ? `  — ${w.note}` : ""}`;
}

async function handleListWeights(args) {
  const sp = new URLSearchParams();
  for (const k of ["from", "to"]) {
    const v = str(args[k]);
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  const { data, errorResult } = await api("GET", `/api/body/weight${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  const weights = data.weights ?? [];
  const filters = qs ? ` (${qs.replace(/&/g, ", ")})` : "";
  if (!weights.length) return text(`No weigh-ins${filters}.`);
  const lines = [`Weigh-ins (${weights.length})${filters}:`];
  for (const w of weights) lines.push(weightLine(w));
  if (weights.length >= 2) {
    const delta = weights[weights.length - 1].weightKg - weights[0].weightKg;
    lines.push(`Trend: ${weights[0].weightKg.toFixed(1)} → ${weights[weights.length - 1].weightKg.toFixed(1)} kg (${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg)`);
  }
  return text(lines.join("\n"));
}

async function handleDeleteWeight(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required, e.g. 'WEIGHT-1'.");
  const { errorResult } = await api("DELETE", `/api/body/weight/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;
  return text(`Deleted ${id} (no soft-archive; hard-removed).`);
}

async function handleGetBodyStatus() {
  const { data, errorResult } = await api("GET", "/api/body/status");
  if (errorResult) return errorResult;
  const b = data.baseline;
  const p = data.profile;
  const lines = ["Body status — physiology FACTS (not a recommendation):"];
  if (p) {
    lines.push(`Identity: ${p.sex}, height ${p.heightCm} cm, training status ${p.trainingStatus}, lifts ${p.resistanceTrains ? "yes" : "no"}.`);
  }
  if (!b.configured) {
    const needs = (b.needs ?? []).join(", ");
    lines.push(`Not fully configured — still need: ${needs || "more data"}.`);
  }
  if (b.ageYears != null) lines.push(`Age: ${b.ageYears}`);
  const cur = b.currentWeightKg != null ? `${b.currentWeightKg.toFixed(1)} kg` : "—";
  const trend = b.trendWeightKg != null ? `${b.trendWeightKg} kg` : "—";
  lines.push(`Weight: current ${cur}  ·  trend ${trend}`);
  if (b.bmrKcal != null) lines.push(`BMR (estimated): ${b.bmrKcal} kcal`);
  if (b.tdeeKcal != null) lines.push(`TDEE estimated (maintenance): ${b.tdeeKcal} kcal`);
  if (b.measuredTdeeKcal != null) lines.push(`TDEE measured (feedback loop): ${b.measuredTdeeKcal} kcal`);
  lines.push(`Basis in use: ${b.basis}`);
  if (b.bmiCurrent != null) lines.push(`BMI: ${b.bmiCurrent}`);
  if (b.ffmKg != null) lines.push(`Fat-free mass: ${b.ffmKg} kg`);
  if (b.latestWaistCm != null) lines.push(`Latest waist: ${b.latestWaistCm} cm`);
  lines.push("");
  lines.push("To set daily calorie/macro targets: read get_body_objective + get_diet_profile (nutrition add-on), then author them via save_nutrition_targets. The board does NOT compute them.");
  return text(lines.join("\n"));
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "get_body_profile":
      return handleGetBodyProfile(args);
    case "set_body_profile":
      return handleSetBodyProfile(args);
    case "get_body_objective":
      return handleGetBodyObjective(args);
    case "set_body_objective":
      return handleSetBodyObjective(args);
    case "log_weight":
      return handleLogWeight(args);
    case "list_weights":
      return handleListWeights(args);
    case "delete_weight":
      return handleDeleteWeight(args);
    case "get_body_status":
      return handleGetBodyStatus(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `body MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`,
);
