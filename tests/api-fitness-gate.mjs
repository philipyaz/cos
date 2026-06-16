#!/usr/bin/env node
// api-fitness-gate.mjs — the Add-ons GATE contract for the "fitness" add-on (the unified
// /fitness + /fitness/health add-on). Modeled on api-nutrition-gate.mjs.
//
// Plain Node (ESM), zero deps. Proves the add-on gate end-to-end against a RUNNING board:
// a DISABLED "fitness" add-on rejects every WRITE with 404 while its GET reads still return
// 200 (a disabled add-on's data stays viewable); enabling it via PATCH /api/addons/fitness
// flips the gate live AND bumps db.version. Specifically:
//   • DISABLE the add-on (PATCH { enabled:false }); GET /api/addons reports it as
//     enabled:false with a bridge:{ port, reachable } hint
//   • while DISABLED: GET /api/fitness/summary + GET /api/fitness/profile → 200 (ungated reads);
//     every WRITE (POST /api/fitness/push with a valid token, POST /api/fitness/profile) → 404
//   • ENABLE the add-on (PATCH { enabled:true }) → 200, the response carries a bumped
//     version, and GET /api/addons now reports enabled:true
//   • while ENABLED: the same POSTs now succeed (push → 201, profile → 200) — the gate flipped
//   • an unknown add-on id (PATCH /api/addons/nope) → 404; a non-boolean enabled → 400
//
// The push route is token-gated (x-fitness-token must match FITNESS_PUSH_TOKEN). The test
// board exports FITNESS_PUSH_TOKEN (see tests/run.sh); locally pass it via env. When the
// token is absent the push route 503s — the test SKIPs the push-write checks but still
// drives the athlete-profile gate (which needs no token).
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero —
// settings.addons + db.healthEntries + db.athleteProfile live in cases.json). Requires a
// running board:
//   cd board && npm run dev
//   FITNESS_PUSH_TOKEN=… node tests/api-fitness-gate.mjs   # CRM_BASE_URL defaults to :3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path), FITNESS_PUSH_TOKEN.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");
const FITNESS_TOKEN = (process.env.FITNESS_PUSH_TOKEN || "").trim();

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

// A minimal, valid native-shape push payload (one HRV metric day). Uses a DISTINCT date from
// api-fitness-push's target day so the two tests never share a date-scoped summarize window on
// the shared throwaway board (writes to the test board are not rolled back between steps).
const pushPayload = () => ({
  entries: [
    { id: `gate-hrv-${Date.now()}`, ts: "2026-06-10", type: "hrv", data: { value: 55 } },
  ],
});
const pushHeaders = () => ({ "x-fitness-token": FITNESS_TOKEN });

// A complete, valid athlete profile (ENGLISH enums single-sourced in @/lib/types).
const athleteProfile = () => ({
  goal: "general_fitness",
  level: "intermediate",
  daysPerWeek: 4,
  sports: [],
  equipment: [],
  notes: "gate-test profile",
});

async function main() {
  console.log(`api-fitness-gate · board=${BASE}`);
  if (!FITNESS_TOKEN) {
    console.log("  ⚠ FITNESS_PUSH_TOKEN unset — push-write gate checks are SKIPPED (athlete gate still runs).");
  }

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ── DISABLE; reads stay open, writes 404 ────────────────────────────────
    const disabled = await PATCH("/api/addons/fitness", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "the add-on reports enabled:false");

    // GET /api/addons reports the row with the enabled flag + bridge hint.
    const catalog = await GET("/api/addons");
    check(catalog.status === 200, `GET /api/addons → 200 (got ${catalog.status})`);
    const row = (catalog.body.addons || []).find((a) => a.id === "fitness");
    check(!!row, "GET /api/addons lists the fitness add-on");
    check(row?.enabled === false, "GET /api/addons reports fitness as enabled:false");
    check(
      row?.bridge && typeof row.bridge.port === "number" && typeof row.bridge.reachable === "boolean",
      "the catalog row carries a bridge:{ port, reachable } hint",
    );

    // Reads stay open while disabled.
    const readSummary = await GET("/api/fitness/summary?date=2026-06-15");
    check(readSummary.status === 200, `GET /api/fitness/summary while disabled → 200 (got ${readSummary.status})`);
    const readProfile = await GET("/api/fitness/profile");
    check(readProfile.status === 200, `GET /api/fitness/profile while disabled → 200 (got ${readProfile.status})`);

    // Writes 404 while disabled.
    if (FITNESS_TOKEN) {
      const blockedPush = await POST("/api/fitness/push", pushPayload(), pushHeaders());
      check(blockedPush.status === 404, `POST /api/fitness/push while disabled → 404 (got ${blockedPush.status})`);
    }
    const blockedProfile = await POST("/api/fitness/profile", athleteProfile());
    check(blockedProfile.status === 404, `POST /api/fitness/profile while disabled → 404 (got ${blockedProfile.status})`);

    // ── ENABLE flips the gate AND bumps version ─────────────────────────────
    const vBeforeEnable = (await GET("/api/addons")).body.version;
    const enabled = await PATCH("/api/addons/fitness", { enabled: true });
    check(enabled.status === 200, `PATCH enable → 200 (got ${enabled.status})`);
    check(enabled.body.addon?.enabled === true, "the add-on reports enabled:true");
    check(
      typeof enabled.body.version === "number" && enabled.body.version > vBeforeEnable,
      `enabling bumps db.version (${vBeforeEnable} → ${enabled.body.version})`,
    );

    const catalogAfter = await GET("/api/addons");
    const rowAfter = (catalogAfter.body.addons || []).find((a) => a.id === "fitness");
    check(rowAfter?.enabled === true, "GET /api/addons now reports fitness as enabled:true");

    // The same writes now land.
    if (FITNESS_TOKEN) {
      const allowedPush = await POST("/api/fitness/push", pushPayload(), pushHeaders());
      check(allowedPush.status === 201, `POST /api/fitness/push after enable → 201 (got ${allowedPush.status}) — the gate flipped`);
      check(allowedPush.body.accepted === 1, `the push landed (accepted:1, got ${allowedPush.body.accepted})`);
    }
    const allowedProfile = await POST("/api/fitness/profile", athleteProfile());
    check(allowedProfile.status === 200, `POST /api/fitness/profile after enable → 200 (got ${allowedProfile.status}) — the gate flipped`);
    check(allowedProfile.body.profile?.goal === "general_fitness", "the athlete profile persisted (goal echoed)");

    // ── toggle validation → unknown id 404, non-boolean enabled 400 ─────────
    const unknown = await PATCH("/api/addons/nope", { enabled: true });
    check(unknown.status === 404, `PATCH /api/addons/nope (unknown id) → 404 (got ${unknown.status})`);

    const badEnabled = await PATCH("/api/addons/fitness", { enabled: "yes" });
    check(badEnabled.status === 400, `PATCH { enabled:"yes" } → 400 (got ${badEnabled.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} gate check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — fitness Add-ons gate holds (disabled writes 404, reads ungated, enable flips + bumps version).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
