#!/usr/bin/env node
// api-health-push.mjs — a round-trip through the health-push INGEST → SUMMARIZE pipeline that
// kills THE BUG the old test masked: the summarize/daily-summary aggregators must read the
// CANONICAL taxonomy (type "hrv" with data.value, type "sleep_night" with data.value=hours)
// produced by the HAE converter — NOT the legacy "heart_rate_variability"/data.avg_ms shapes.
//
// Plain Node (ESM), zero deps. Against a RUNNING board with the "health" add-on ENABLED:
//   1. POST /api/health/push a realistic Health-Auto-Export-shaped payload:
//        • a metrics export with a `sleep_analysis` night + a `heart_rate_variability` series
//        • a workouts export with one run
//   2. GET /api/health/summary?date=… → assert NON-EMPTY sleep {count,avg_hours} + hrv
//        {count,avg_ms} + workout (this is exactly what the old buggy aggregator dropped)
//   3. GET /api/health/daily-summary?date=… → surfaces the same: sleep.night.totalSleep_h,
//        metrics.hrv, and the workout
//
// The push route is token-gated. HEALTH_PUSH_TOKEN must be set (the test board exports it;
// see tests/run.sh). When unset the test SKIPs gracefully (exit 0) — it cannot push.
//
// Snapshots board/data/cases.json and restores it in a `finally` (net-zero — healthEntries +
// settings.addons live there). Requires a running board:
//   cd board && npm run dev
//   HEALTH_PUSH_TOKEN=… node tests/api-health-push.mjs   # CRM_BASE_URL defaults to :3000
//
// Env: CRM_BASE_URL, COS_BOARD_DATA, HEALTH_PUSH_TOKEN.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");
const HEALTH_TOKEN = (process.env.HEALTH_PUSH_TOKEN || "").trim();

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};

const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b, h) => api("POST", p, b, h);
const PATCH = (p, b, h) => api("PATCH", p, b, h);

// The target day for the whole round-trip.
const DAY = "2026-06-15";

// A realistic Health-Auto-Export METRICS export: a sleep night + an HRV series. HAE
// timestamps are "YYYY-MM-DD HH:MM:SS +ZZZZ"; the converter keys entries by calendar day.
const haeMetrics = () => ({
  data: {
    metrics: [
      {
        name: "sleep_analysis",
        units: "hr",
        data: [
          {
            date: `${DAY} 06:30:00 +0000`,
            // sleepStart in the night window (>=20:00) so it classifies as sleep_night.
            sleepStart: `${DAY} 23:15:00 +0000`,
            sleepEnd: `${DAY} 06:30:00 +0000`,
            totalSleep: 7.5,
            deep: 1.6,
            rem: 1.4,
            core: 4.0,
            awake: 0.3,
          },
        ],
      },
      {
        name: "heart_rate_variability",
        units: "ms",
        data: [
          { date: `${DAY} 03:00:00 +0000`, qty: 60 },
          { date: `${DAY} 04:00:00 +0000`, qty: 70 },
        ],
      },
    ],
  },
});

// A realistic Health-Auto-Export WORKOUTS export: one run on the same day.
const haeWorkouts = () => ({
  data: {
    workouts: [
      {
        id: `gate-run-${Date.now()}`,
        name: "Running",
        start: `${DAY} 17:00:00 +0000`,
        end: `${DAY} 17:45:00 +0000`,
        activeEnergyBurned: { qty: 1880, units: "kJ" }, // → ~449 kcal
        distance: { qty: 8.2, units: "km" },
      },
    ],
  },
});

async function main() {
  console.log(`api-health-push · board=${BASE}`);
  if (!HEALTH_TOKEN) {
    console.log("  SKIP: HEALTH_PUSH_TOKEN unset — the push route is token-gated, cannot round-trip.");
    process.exit(0);
  }

  const snapshot = await fs.readFile(DATA_FILE, "utf8");
  const H = { "x-health-token": HEALTH_TOKEN };

  try {
    // Enable the add-on so the push writes land.
    const enable = await PATCH("/api/addons/health", { enabled: true });
    check(enable.status === 200, `PATCH enable health → 200 (got ${enable.status})`);

    // ── 1. PUSH the HAE metrics (sleep + HRV) and the workout ───────────────
    const pushMetrics = await POST("/api/health/push", haeMetrics(), H);
    check(pushMetrics.status === 201, `POST /api/health/push (metrics) → 201 (got ${pushMetrics.status})`);
    // sleep_analysis → 1 sleep_night entry; HRV (2 points, same day) → 1 hrv entry. = 2 accepted.
    check(pushMetrics.body.accepted >= 2, `metrics push accepted ≥ 2 entries (got ${pushMetrics.body.accepted})`);

    const pushWorkout = await POST("/api/health/push", haeWorkouts(), H);
    check(pushWorkout.status === 201, `POST /api/health/push (workout) → 201 (got ${pushWorkout.status})`);
    check(pushWorkout.body.accepted === 1, `workout push accepted 1 entry (got ${pushWorkout.body.accepted})`);

    // ── 2. SUMMARY surfaces NON-EMPTY sleep + hrv (the bug the old test masked) ──
    const summary = await GET(`/api/health/summary?date=${DAY}`);
    check(summary.status === 200, `GET /api/health/summary → 200 (got ${summary.status})`);

    // sleep — the converter wrote type "sleep_night" with data.value=hours, NOT data.avg_ms.
    // (count is >=1, not ==1: the shared throwaway board may already hold entries from an
    // earlier step — the canonical-read signal is the AVERAGE, asserted next.)
    check(summary.body.sleep && summary.body.sleep.count >= 1, "summary.sleep is NON-EMPTY — the HRV/sleep canonicalization bug is dead");
    check(
      typeof summary.body.sleep?.avg_hours === "number" && Math.abs(summary.body.sleep.avg_hours - 7.5) < 0.01,
      `summary.sleep.avg_hours reads data.value (≈7.5, got ${summary.body.sleep?.avg_hours})`,
    );
    check(
      typeof summary.body.sleep?.avg_deep_hours === "number" && Math.abs(summary.body.sleep.avg_deep_hours - 1.6) < 0.01,
      `summary.sleep.avg_deep_hours reads data.metadata.deep (≈1.6, got ${summary.body.sleep?.avg_deep_hours})`,
    );

    // hrv — type "hrv" (NOT "heart_rate_variability"); avg of 60,70 → 65.
    check(summary.body.hrv && summary.body.hrv.count >= 1, "summary.hrv is NON-EMPTY — the canonical 'hrv' type is read");
    check(
      typeof summary.body.hrv?.avg_ms === "number" && Math.abs(summary.body.hrv.avg_ms - 65) < 0.01,
      `summary.hrv.avg_ms reads data.value (≈65, the avg of 60,70; got ${summary.body.hrv?.avg_ms})`,
    );

    // workout — count + the activity histogram.
    check(summary.body.workout && summary.body.workout.count >= 1, "summary.workout is NON-EMPTY");
    check(
      summary.body.workout?.activities?.Running === 1,
      "summary.workout.activities counts the run by name",
    );

    // ── 3. DAILY-SUMMARY surfaces them too ──────────────────────────────────
    const daily = await GET(`/api/health/daily-summary?date=${DAY}`);
    check(daily.status === 200, `GET /api/health/daily-summary → 200 (got ${daily.status})`);
    check(
      daily.body.sleep?.night && Math.abs(daily.body.sleep.night.totalSleep_h - 7.5) < 0.01,
      `daily-summary surfaces the sleep night (totalSleep_h ≈7.5, got ${daily.body.sleep?.night?.totalSleep_h})`,
    );
    check(
      typeof daily.body.metrics?.hrv === "number" && Math.abs(daily.body.metrics.hrv - 65) < 0.01,
      `daily-summary.metrics.hrv reads data.value (≈65, got ${daily.body.metrics?.hrv})`,
    );
    check(
      Array.isArray(daily.body.workouts) && daily.body.workouts.some((w) => w.activity === "Running"),
      "daily-summary lists the run in workouts[]",
    );
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} push round-trip check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — health push→summarize round-trip surfaces sleep + hrv + workout (canonical taxonomy).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
