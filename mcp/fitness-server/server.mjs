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
// Auth model: every write is attributed to the agent via the x-actor:"agent" header (the
// board's resolveActor reads it), exactly like the other add-on MCPs. Writes are gated by the
// board's add-on enabled toggle alone — a disabled add-on 404s every write.
//
// Retention: the board auto-purges entries older than 90 days on every push.
//
// Config: CRM_BASE_URL (default http://localhost:3000)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start, baseUrl } from "../../packages/mcp-kit/index.mjs";

const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");

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
  // Writes are attributed to the agent via x-actor (the board's resolveActor reads it) and
  // gated by the board's add-on enabled toggle (a disabled add-on 404s every write).
  if (method !== "GET") {
    headers["x-actor"] = "agent";
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
  if (res.status === 401) return { errorResult: err(data.error ?? "Unauthorized.") };
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

// ── Athlete-profile + readiness/correlation reads (thin wrappers) ─────────────
// The athlete PROFILE singleton (goal, level, weekly availability, sports, equipment) and the
// two deterministic computed signals — the daily FORM SCORE and the sleep/performance
// CORRELATIONS — that the board COMPUTES and the coaching agent INTERPRETS. The enums below are
// in lockstep with board/lib/types.ts (VALID_ATHLETE_GOAL/LEVEL/SPORT/EQUIPMENT); the board is
// the single validator — these enums document the allowed vocabulary for the agent.

const ATHLETE_GOALS = [
  "sprint_triathlon", "olympic_triathlon",
  "cycling", "swimming", "running", "general_fitness",
];
// (v14: "weight_loss" removed — the body objective owns "lose fat"; this is training FOCUS only.)
// (v14: the athlete `level` enum is gone — training status lives on the body add-on's bodyProfile.)
const ATHLETE_SPORTS = [
  "cycling_outdoor", "cycling_indoor", "running", "walking",
  "swimming_pool", "swimming_open_water", "rowing",
  "skiing_alpine", "skiing_cross_country", "snowboard", "hiking",
  "climbing", "surfing", "kayaking",
  "strength_training", "hiit", "yoga", "pilates", "dance",
  "martial_arts", "boxing", "crossfit", "stretching",
  "tennis", "padel", "soccer", "basketball", "cycling_indoor_zwift",
];
const ATHLETE_EQUIPMENT = [
  "road_bike", "home_trainer", "pull_up_bar", "dumbbells",
  "kettlebell", "resistance_bands", "treadmill", "rowing_machine",
  "elliptical", "jump_rope", "bodyweight",
  "pool_access", "gym_access",
];

const GET_ATHLETE_PROFILE_TOOL = {
  name: "get_athlete_profile",
  description:
    "Read the athlete training-profile singleton — the coach's TRAINING-FOCUS context: goal " +
    "(sport/event focus), weekly availability (daysPerWeek, maxSessionMinutes), sports + equipment, " +
    "and goalDate. Ungated read. Returns { profile, version }; profile is null when none is set. " +
    "NOTE: training STATUS, current weight, and the BODY goal live in the body add-on — read them " +
    "with get_body_profile / get_body_status / get_body_objective, NOT here.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const SET_ATHLETE_PROFILE_TOOL = {
  name: "set_athlete_profile",
  description:
    "Create-or-replace the athlete training-profile singleton (add-on-gated write) — the TRAINING-FOCUS " +
    "half only. There is exactly ONE profile — a second call REPLACES it (createdAt is preserved). " +
    "Training STATUS / current weight / the BODY goal are NOT here — set those via the body add-on " +
    "(set_body_profile / log_weight / set_body_objective). Returns { profile, version }.",
  inputSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        enum: ATHLETE_GOALS,
        description: "Training FOCUS — the sport/event (required). NOT the body goal (that is the body objective).",
      },
      goalDate: {
        type: "string",
        description: "Target date for the goal as YYYY-MM-DD, or \"\" for none (optional).",
      },
      daysPerWeek: { type: "number", description: "Sessions available per week, 1-7 (optional)." },
      maxSessionMinutes: { type: "number", description: "Max minutes per session (optional, > 0)." },
      sports: {
        type: "array",
        items: { type: "string", enum: ATHLETE_SPORTS },
        description:
          "The sports the athlete trains — a subset of the allowed values: " +
          ATHLETE_SPORTS.join(", ") + ". Values outside this set are dropped by the board.",
      },
      equipment: {
        type: "array",
        items: { type: "string", enum: ATHLETE_EQUIPMENT },
        description:
          "Training equipment the athlete has access to — a subset of the allowed values: " +
          ATHLETE_EQUIPMENT.join(", ") + ". Values outside this set are dropped by the board.",
      },
      notes: { type: "string", description: "Freeform context for the coach (optional; capped at 2000 chars)." },
    },
    required: ["goal"],
  },
};

const GET_FORM_SCORE_TOOL = {
  name: "get_form_score",
  description:
    "Get the deterministic daily READINESS ('form') score (0-100) the board computes for a date " +
    "from the canonical health taxonomy. Ungated read. Returns { score, level, color, breakdown:" +
    "{hrv, sleep, resting_hr, load}, recommendation } — the agent INTERPRETS this; it does not " +
    "recompute it.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "The date to score (YYYY-MM-DD)." },
    },
    required: ["date"],
  },
};

const GET_CORRELATIONS_TOOL = {
  name: "get_correlations",
  description:
    "Get the sleep-vs-performance CORRELATION analysis the board COMPUTES (and persists to the " +
    "correlations history feed) over the last N days. Ungated read. Returns { days, data_points, " +
    "from, to, correlation:{sleep_vs_performance, deep_sleep_vs_performance}, regression:{slope, " +
    "intercept}|null, points[] } — a Pearson correlation + linear fit. The agent INTERPRETS the " +
    "stats; it does not recompute them.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Window length in days (default 30, valid 7-365)." },
    },
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

// ── Coaching-artifact tools (v13) ─────────────────────────────────────────────
// The FOUR stateful AI coaching surfaces — training plan, weekly review, pre-workout
// brief, and sleep/performance correlations — are persisted on the board's core store
// (db.coachingArtifacts) and upserted by (kind, periodKey). The save_* tools are THIN
// fetch wrappers over POST /api/fitness/coaching (writes are attributed via x-actor and
// gated by the add-on toggle). An EXTERNAL agent (Cowork) creates these WITHOUT the board's
// Anthropic key. ZERO business logic here — the board validates + upserts.

const COACHING_KINDS = ["training_plan", "weekly_review", "pre_workout_brief", "correlations"];

const SAVE_TRAINING_PLAN_TOOL = {
  name: "save_training_plan",
  description:
    "Persist a weekly TRAINING PLAN as a coaching artifact (upserted by week: a second save " +
    "for the same week replaces it). Provide the full plan; the board stores it verbatim and " +
    "exposes it in the /fitness/training-plan history feed.",
  inputSchema: {
    type: "object",
    properties: {
      week: { type: "string", description: "ISO week the plan covers (e.g. '2026-W26'). The upsert key." },
      recovery_status: { type: "string", enum: ["good", "moderate", "poor"], description: "Overall recovery state going into the week." },
      generated_at: { type: "string", description: "ISO-8601 timestamp the plan was generated (optional; defaults to now)." },
      days: {
        type: "array",
        description: "One entry per planned day of the week.",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD for this day." },
            day: { type: "string", description: "Day name (e.g. 'Monday')." },
            type: { type: "string", enum: ["training", "rest", "active_recovery"], description: "Day classification." },
            sport: { type: "string", description: "Sport / modality (e.g. 'running', 'cycling')." },
            duration_min: { type: "number", description: "Planned duration in minutes." },
            intensity: { type: "string", enum: ["easy", "moderate", "hard"], description: "Target intensity." },
            description: { type: "string", description: "What to do this day." },
            zones: { type: "string", description: "Target heart-rate / power zones." },
          },
          required: ["date", "day", "type"],
        },
      },
      weekly_notes: { type: "string", description: "Coach notes for the week as a whole." },
    },
    required: ["week", "days"],
  },
};

const SAVE_WEEKLY_REVIEW_TOOL = {
  name: "save_weekly_review",
  description:
    "Persist a WEEKLY REVIEW as a coaching artifact (upserted by week). Stored verbatim and " +
    "shown in the /fitness/weekly-review history feed.",
  inputSchema: {
    type: "object",
    properties: {
      week: { type: "string", description: "ISO week reviewed (e.g. '2026-W25'). The upsert key." },
      overall_score: { type: "number", description: "Overall week score (0-100)." },
      summary: { type: "string", description: "Narrative summary of the week." },
      training: {
        type: "object",
        properties: {
          sessions_done: { type: "number" },
          total_volume_min: { type: "number" },
          total_distance_km: { type: "number" },
          sports_breakdown: { type: "object", description: "Map of sport → count/minutes." },
          vs_plan: { type: "string", description: "How actual compared to the plan." },
          highlights: { type: "array", items: { type: "string" } },
        },
        required: ["sessions_done", "total_volume_min", "vs_plan"],
      },
      sleep: {
        type: "object",
        properties: {
          avg_duration_h: { type: "number" },
          avg_deep_h: { type: "number" },
          avg_rem_h: { type: "number" },
          quality_trend: { type: "string", enum: ["improving", "stable", "declining"] },
          notes: { type: "string" },
        },
        required: ["quality_trend", "notes"],
      },
      recovery: {
        type: "object",
        properties: {
          avg_hrv: { type: "number" },
          avg_resting_hr: { type: "number" },
          fatigue_level: { type: "string", enum: ["low", "moderate", "high"] },
          notes: { type: "string" },
        },
        required: ["fatigue_level", "notes"],
      },
      nutrition: {
        type: "object",
        properties: {
          days_logged: { type: "number" },
          avg_calories: { type: "number" },
          notes: { type: "string" },
        },
      },
      recommendations: { type: "array", items: { type: "string" } },
      next_week_focus: { type: "string" },
      avg_form_score: { type: "number", description: "Average daily form score across the week." },
      form_trend: { type: "string", description: "Direction of the form-score trend." },
    },
    required: ["week", "overall_score", "summary", "training", "sleep", "recovery", "recommendations", "next_week_focus"],
  },
};

const SAVE_PRE_WORKOUT_BRIEF_TOOL = {
  name: "save_pre_workout_brief",
  description:
    "Persist a daily PRE-WORKOUT readiness BRIEF as a coaching artifact (upserted by date). " +
    "Shown in the /fitness/pre-workout-brief history feed.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD the brief is for. The upsert key (also stored in the payload)." },
      readiness: { type: "string", enum: ["ready", "caution", "rest"], description: "Overall readiness verdict." },
      form_score: { type: "number", description: "Today's form score (0-100)." },
      recommended_session: {
        type: "object",
        properties: {
          sport: { type: "string" },
          duration_min: { type: "number" },
          intensity: { type: "string" },
          description: { type: "string" },
        },
      },
      warnings: { type: "array", items: { type: "string" }, description: "Red/amber flags to heed." },
      green_lights: { type: "array", items: { type: "string" }, description: "Positive signals." },
      one_liner: { type: "string", description: "A one-sentence verdict." },
    },
    required: ["date", "readiness"],
  },
};

const SAVE_CORRELATION_REPORT_TOOL = {
  name: "save_correlation_report",
  description:
    "Persist a sleep/performance CORRELATION report as a coaching artifact (upserted by the " +
    "window '<from>_<to>'). Shown in the /fitness/correlations history feed.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD window start (inclusive). Part of the upsert key." },
      to: { type: "string", description: "YYYY-MM-DD window end. Part of the upsert key." },
      days: { type: "number", description: "Number of days in the window." },
      data_points: { type: "number", description: "Number of paired data points." },
      correlation: {
        type: "object",
        properties: {
          sleep_vs_performance: { type: "number" },
          deep_sleep_vs_performance: { type: "number" },
        },
      },
      regression: {
        type: ["object", "null"],
        properties: {
          slope: { type: "number" },
          intercept: { type: "number" },
        },
        description: "Linear fit, or null when too few points.",
      },
      points: {
        type: "array",
        description: "The paired (sleep, performance) data points.",
        items: { type: "object" },
      },
    },
    required: ["from", "to", "points"],
  },
};

const LIST_COACHING_ARTIFACTS_TOOL = {
  name: "list_coaching_artifacts",
  description:
    "List persisted coaching artifacts (training plans, weekly reviews, pre-workout briefs, " +
    "correlation reports), newest-first. Ungated read. Optionally filter by kind and/or a " +
    "createdAt date range.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: COACHING_KINDS, description: "Filter to one artifact kind." },
      from: { type: "string", description: "createdAt start date (YYYY-MM-DD), inclusive." },
      to: { type: "string", description: "createdAt end date (YYYY-MM-DD), exclusive." },
      limit: { type: "number", description: "Max artifacts to return (default 50)." },
    },
  },
};

const GET_COACHING_ARTIFACT_TOOL = {
  name: "get_coaching_artifact",
  description: "Fetch one coaching artifact by its id (e.g. 'COACH-3'). Ungated read.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact id (e.g. 'COACH-3')." },
    },
    required: ["id"],
  },
};

const DELETE_COACHING_ARTIFACT_TOOL = {
  name: "delete_coaching_artifact",
  description: "Delete one coaching artifact by id (add-on-gated).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact id to delete (e.g. 'COACH-3')." },
    },
    required: ["id"],
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
  GET_ATHLETE_PROFILE_TOOL,
  SET_ATHLETE_PROFILE_TOOL,
  GET_FORM_SCORE_TOOL,
  GET_CORRELATIONS_TOOL,
  SAVE_TRAINING_PLAN_TOOL,
  SAVE_WEEKLY_REVIEW_TOOL,
  SAVE_PRE_WORKOUT_BRIEF_TOOL,
  SAVE_CORRELATION_REPORT_TOOL,
  LIST_COACHING_ARTIFACTS_TOOL,
  GET_COACHING_ARTIFACT_TOOL,
  DELETE_COACHING_ARTIFACT_TOOL,
];

// ── Tool handlers ───────────────────────────────────────────────────────────

async function handlePushHealthData(args) {
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return err("'entries' must be a non-empty array.");
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

// ── Athlete-profile + readiness/correlation handlers (thin wrappers) ──────────

async function handleGetAthleteProfile() {
  const { data, errorResult } = await healthApi("GET", "/api/fitness/profile");
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleSetAthleteProfile(args) {
  if (!ATHLETE_GOALS.includes(args.goal)) {
    return err(`'goal' is required, one of: ${ATHLETE_GOALS.join(", ")}.`);
  }
  // Pass the whole args object through; the board is the single validator (it coerces the
  // optionals, ignores any v14-removed fields like level/weight, and drops out-of-vocabulary
  // sports/equipment). ZERO business logic here.
  const { data, errorResult } = await healthApi("POST", "/api/fitness/profile", args);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetFormScore(args) {
  const date = str(args.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err("'date' is required as YYYY-MM-DD.");
  }
  const { data, errorResult } = await healthApi("GET", `/api/fitness/form-score?date=${date}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetCorrelations(args) {
  const params = new URLSearchParams();
  if (args.days != null) params.set("days", String(args.days));
  const qs = params.toString();
  const { data, errorResult } = await healthApi("GET", `/api/fitness/correlations${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

// ── Coaching-artifact handlers (v13) — thin POST/GET/DELETE wrappers ──────────

// Build a coaching POST body and persist it. source:"agent" (the external agent);
// periodKey is the kind's upsert key. The board validates + upserts.
async function saveCoachingArtifact(kind, payload, periodKey) {
  const { data, errorResult } = await healthApi("POST", "/api/fitness/coaching", {
    kind,
    source: "agent",
    payload,
    periodKey,
  });
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleSaveTrainingPlan(args) {
  if (!str(args.week)) return err("'week' is required (the ISO week, e.g. '2026-W26').");
  if (!Array.isArray(args.days)) return err("'days' is required as an array.");
  return saveCoachingArtifact("training_plan", args, args.week);
}

async function handleSaveWeeklyReview(args) {
  if (!str(args.week)) return err("'week' is required (the ISO week, e.g. '2026-W25').");
  if (typeof args.overall_score !== "number") return err("'overall_score' is required as a number.");
  return saveCoachingArtifact("weekly_review", args, args.week);
}

async function handleSavePreWorkoutBrief(args) {
  const date = str(args.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err("'date' is required as YYYY-MM-DD.");
  if (!["ready", "caution", "rest"].includes(args.readiness)) {
    return err("'readiness' is required, one of ready|caution|rest.");
  }
  return saveCoachingArtifact("pre_workout_brief", args, date);
}

async function handleSaveCorrelationReport(args) {
  const from = str(args.from);
  const to = str(args.to);
  if (!from || !to) return err("'from' and 'to' are required (YYYY-MM-DD).");
  if (!Array.isArray(args.points)) return err("'points' is required as an array.");
  return saveCoachingArtifact("correlations", args, `${from}_${to}`);
}

async function handleListCoachingArtifacts(args) {
  const params = new URLSearchParams();
  if (args.kind) params.set("kind", args.kind);
  if (args.from) params.set("from", args.from);
  if (args.to) params.set("to", args.to);
  if (args.limit) params.set("limit", String(args.limit));
  const qs = params.toString();

  const { data, errorResult } = await healthApi("GET", `/api/fitness/coaching${qs ? `?${qs}` : ""}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleGetCoachingArtifact(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required (e.g. 'COACH-3').");
  const { data, errorResult } = await healthApi("GET", `/api/fitness/coaching/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
}

async function handleDeleteCoachingArtifact(args) {
  const id = str(args.id);
  if (!id) return err("'id' is required (e.g. 'COACH-3').");
  const { data, errorResult } = await healthApi("DELETE", `/api/fitness/coaching/${encodeURIComponent(id)}`);
  if (errorResult) return errorResult;
  return text(JSON.stringify(data, null, 2));
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
    case "get_athlete_profile":
      return handleGetAthleteProfile(args);
    case "set_athlete_profile":
      return handleSetAthleteProfile(args);
    case "get_form_score":
      return handleGetFormScore(args);
    case "get_correlations":
      return handleGetCorrelations(args);
    case "save_training_plan":
      return handleSaveTrainingPlan(args);
    case "save_weekly_review":
      return handleSaveWeeklyReview(args);
    case "save_pre_workout_brief":
      return handleSavePreWorkoutBrief(args);
    case "save_correlation_report":
      return handleSaveCorrelationReport(args);
    case "list_coaching_artifacts":
      return handleListCoachingArtifacts(args);
    case "get_coaching_artifact":
      return handleGetCoachingArtifact(args);
    case "delete_coaching_artifact":
      return handleDeleteCoachingArtifact(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `fitness MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
