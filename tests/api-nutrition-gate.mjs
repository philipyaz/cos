#!/usr/bin/env node
// api-nutrition-gate.mjs — the v9 Add-ons GATE contract for the Nutrition food-log API.
//
// Plain Node (ESM), zero deps. Proves the add-on gate end-to-end against a RUNNING
// board: a DISABLED add-on rejects every WRITE with 404 while its GET reads still
// return data (a disabled add-on's data stays viewable); enabling it via
// PATCH /api/addons/nutrition flips the gate live AND bumps db.version (so the SSE
// stream re-renders the nav). Specifically:
//   • DISABLE the add-on (PATCH { enabled:false }); GET /api/addons reports it as
//     enabled:false with a bridge:{ port, reachable } hint
//   • while DISABLED: GET /api/nutrition/log → 200 (ungated read); every WRITE
//     (POST /api/nutrition/log, PATCH+DELETE /api/nutrition/log/:id) → 404
//   • ENABLE the add-on (PATCH { enabled:true }) → 200, the response carries a bumped
//     version, and GET /api/addons now reports enabled:true
//   • while ENABLED: the same POST now succeeds (201) → the gate flipped
//   • an unknown add-on id (PATCH /api/addons/nope) → 404; a non-boolean enabled → 400
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero —
// settings.addons + db.foodLogs live in cases.json). Requires a running board:
//   cd board && npm run dev
//   node tests/api-nutrition-gate.mjs    # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

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
const DELETE = (p) => api("DELETE", p);

const newEntry = () => ({
  date: "2026-06-15",
  slot: "lunch",
  description: "Gate-test meal",
  calories: 500,
});

async function main() {
  console.log(`api-nutrition-gate · board=${BASE}`);

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // Seed one entry while ENABLED so the disabled-state reads have data to return,
    // then DISABLE — the entry must stay viewable through the gate.
    // ----------------------------------------------------------------------
    const enableForSeed = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enableForSeed.status === 200, `PATCH enable (seed) → 200 (got ${enableForSeed.status})`);
    const seeded = await POST("/api/nutrition/log", newEntry());
    check(seeded.status === 201, `seed POST while enabled → 201 (got ${seeded.status})`);
    const seedId = seeded.body.entry?.id;

    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "the add-on reports enabled:false");

    // GET /api/addons reports the row with the enabled flag + bridge hint.
    const catalog = await GET("/api/addons");
    check(catalog.status === 200, `GET /api/addons → 200 (got ${catalog.status})`);
    const row = (catalog.body.addons || []).find((a) => a.id === "nutrition");
    check(!!row, "GET /api/addons lists the nutrition add-on");
    check(row?.enabled === false, "GET /api/addons reports nutrition as enabled:false");
    check(
      row?.bridge && typeof row.bridge.port === "number" && typeof row.bridge.reachable === "boolean",
      "the catalog row carries a bridge:{ port, reachable } hint",
    );

    // ----------------------------------------------------------------------
    // while DISABLED: GETs still return data; every WRITE 404s.
    // ----------------------------------------------------------------------
    const readList = await GET("/api/nutrition/log");
    check(readList.status === 200, `GET /api/nutrition/log while disabled → 200 (got ${readList.status})`);
    check(
      Array.isArray(readList.body.entries) && readList.body.entries.some((e) => e.id === seedId),
      "the seeded entry is STILL readable while the add-on is disabled (reads are ungated)",
    );
    const readOne = await GET(`/api/nutrition/log/${encodeURIComponent(seedId)}`);
    check(readOne.status === 200, `GET /api/nutrition/log/:id while disabled → 200 (got ${readOne.status})`);

    const blockedPost = await POST("/api/nutrition/log", newEntry());
    check(blockedPost.status === 404, `POST while disabled → 404 (got ${blockedPost.status})`);

    const blockedPatch = await PATCH(`/api/nutrition/log/${encodeURIComponent(seedId)}`, { calories: 999 });
    check(blockedPatch.status === 404, `PATCH while disabled → 404 (got ${blockedPatch.status})`);

    const blockedDelete = await DELETE(`/api/nutrition/log/${encodeURIComponent(seedId)}`);
    check(blockedDelete.status === 404, `DELETE while disabled → 404 (got ${blockedDelete.status})`);

    // The seed entry survived the blocked PATCH/DELETE (the writes never landed).
    const stillThere = await GET(`/api/nutrition/log/${encodeURIComponent(seedId)}`);
    check(stillThere.body.entry?.calories === 500, "the blocked PATCH did NOT mutate the entry");

    // ----------------------------------------------------------------------
    // ENABLE flips the gate AND bumps version → the same write now succeeds.
    // ----------------------------------------------------------------------
    const vBeforeEnable = (await GET("/api/nutrition/log")).body.version;
    const enabled = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enabled.status === 200, `PATCH enable → 200 (got ${enabled.status})`);
    check(enabled.body.addon?.enabled === true, "the add-on reports enabled:true");
    check(
      typeof enabled.body.version === "number" && enabled.body.version > vBeforeEnable,
      `enabling bumps db.version (${vBeforeEnable} → ${enabled.body.version})`,
    );

    const catalogAfter = await GET("/api/addons");
    const rowAfter = (catalogAfter.body.addons || []).find((a) => a.id === "nutrition");
    check(rowAfter?.enabled === true, "GET /api/addons now reports nutrition as enabled:true");

    const allowedPost = await POST("/api/nutrition/log", newEntry());
    check(allowedPost.status === 201, `POST after enable → 201 (got ${allowedPost.status}) — the gate flipped`);

    // ----------------------------------------------------------------------
    // toggle validation → unknown id 404, non-boolean enabled 400.
    // ----------------------------------------------------------------------
    const unknown = await PATCH("/api/addons/nope", { enabled: true });
    check(unknown.status === 404, `PATCH /api/addons/nope (unknown id) → 404 (got ${unknown.status})`);

    const badEnabled = await PATCH("/api/addons/nutrition", { enabled: "yes" });
    check(badEnabled.status === 400, `PATCH { enabled:"yes" } → 400 (got ${badEnabled.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} gate check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v9 Add-ons gate holds (disabled writes 404, reads ungated, enable flips + bumps version).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
