#!/usr/bin/env node
// api-body-gate.mjs — the Add-ons GATE contract for the foundational "body" add-on. Modeled on
// api-fitness-gate.mjs, plus the two v14 invariants unique to a PROVIDER add-on:
//   • HARD AUTO-ENABLE: enabling a consumer (nutrition/fitness) auto-enables body in the same write.
//   • PROVIDER-DISABLE GUARD: disabling body while a hard consumer is enabled → 409.
//
// Plain Node (ESM), zero deps. Against a RUNNING board:
//   • clean slate (disable fitness, nutrition, THEN body — consumers first so the 409 guard allows it)
//   • while body DISABLED: GET profile/objective/weight/status → 200; PUT/POST writes → 404
//   • ENABLE body → 200 + bumped version; the same writes now land
//   • CASCADE: from a clean slate, enabling nutrition auto-enables body
//   • 409 GUARD: with nutrition enabled, PATCH body { enabled:false } → 409
//
// Snapshots board/data/cases.json and restores it in a `finally` (net-zero). Requires a running board.
//   cd board && npm run dev ; node tests/api-body-gate.mjs   # CRM_BASE_URL defaults to :3000
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

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
const POST = (p, b) => api("POST", p, b);
const PUT = (p, b) => api("PUT", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

const rowFor = (catalogBody, id) => (catalogBody.addons || []).find((a) => a.id === id);
const isEnabled = async (id) => rowFor((await GET("/api/addons")).body, id)?.enabled === true;

const profile = () => ({ sex: "male", dateOfBirth: "1991-06-21", heightCm: 178, trainingStatus: "intermediate", resistanceTrains: true });
const objective = () => ({ activity: "moderate", goalText: "body gate test — recomposition", targetWeightKg: 75 });
const weigh = () => ({ date: "2026-06-11", weightKg: 76.4 });

async function main() {
  console.log(`api-body-gate · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ── clean slate: disable the consumers first, then body (so the 409 guard allows it) ──
    await PATCH("/api/addons/fitness", { enabled: false });
    await PATCH("/api/addons/nutrition", { enabled: false });
    const disabled = await PATCH("/api/addons/body", { enabled: false });
    check(disabled.status === 200, `PATCH disable body → 200 (got ${disabled.status})`);
    check(disabled.body.addon?.enabled === false, "body reports enabled:false");

    const catalog = await GET("/api/addons");
    const row = rowFor(catalog.body, "body");
    check(!!row && row.enabled === false, "GET /api/addons lists body as enabled:false");
    check(row?.bridge && typeof row.bridge.port === "number", "the body catalog row carries a bridge:{ port } hint");

    // ── reads stay open while disabled ──
    for (const p of ["/api/body/profile", "/api/body/objective", "/api/body/weight", "/api/body/status"]) {
      const r = await GET(p);
      check(r.status === 200, `GET ${p} while disabled → 200 (got ${r.status})`);
    }

    // ── writes 404 while disabled ──
    check((await PUT("/api/body/profile", profile())).status === 404, "PUT /api/body/profile while disabled → 404");
    check((await PUT("/api/body/objective", objective())).status === 404, "PUT /api/body/objective while disabled → 404");
    check((await POST("/api/body/weight", weigh())).status === 404, "POST /api/body/weight while disabled → 404");

    // ── enable body → writes land + version bumps ──
    const vBefore = (await GET("/api/addons")).body.version;
    const enabled = await PATCH("/api/addons/body", { enabled: true });
    check(enabled.status === 200 && enabled.body.addon?.enabled === true, "PATCH enable body → 200, enabled:true");
    check(typeof enabled.body.version === "number" && enabled.body.version > vBefore, `enabling bumps db.version (${vBefore} → ${enabled.body.version})`);

    check((await PUT("/api/body/profile", profile())).status === 200, "PUT /api/body/profile after enable → 200 (gate flipped)");
    const obj = await PUT("/api/body/objective", objective());
    check(obj.status === 200 && obj.body.objective?.goalText?.includes("recomposition"), "PUT /api/body/objective lands + echoes free-text goal");
    const w = await POST("/api/body/weight", weigh());
    check(w.status === 201 || w.status === 200, `POST /api/body/weight after enable → 201/200 (got ${w.status})`);

    // ── HARD AUTO-ENABLE cascade: from a clean slate, enabling nutrition auto-enables body ──
    await PATCH("/api/addons/fitness", { enabled: false });
    await PATCH("/api/addons/nutrition", { enabled: false });
    await PATCH("/api/addons/body", { enabled: false });
    check((await isEnabled("body")) === false, "clean slate: body is disabled");
    const enNut = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enNut.status === 200, "PATCH enable nutrition → 200");
    check((await isEnabled("body")) === true, "enabling nutrition AUTO-ENABLED body (hard dependsOn cascade)");

    // ── PROVIDER-DISABLE GUARD: body can't be disabled while a hard consumer is on → 409 ──
    const blockedDisable = await PATCH("/api/addons/body", { enabled: false });
    check(blockedDisable.status === 409, `PATCH disable body while nutrition on → 409 (got ${blockedDisable.status})`);
    check((await isEnabled("body")) === true, "body stayed enabled after the refused disable");
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} gate check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — body Add-ons gate holds (writes 404 when disabled, reads open, enable flips + bumps; cascade auto-enables; 409 disable guard).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
