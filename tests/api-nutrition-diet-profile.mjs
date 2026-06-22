#!/usr/bin/env node
// api-nutrition-diet-profile.mjs — the v14 nutrition surfaces: the dietary PROFILE (allergies/
// dietType/notes/philosophy, with the default-when-empty diet-views philosophy) and the AGENT-
// AUTHORED daily-targets feed (save/list/latest + the board-computed `warnings` sibling). Modeled
// on api-fitness-gate.mjs. Against a RUNNING board; snapshots + restores cases.json (net-zero).
//   cd board && npm run dev ; node tests/api-nutrition-diet-profile.mjs   # CRM_BASE_URL :3000
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
const AGENT = { "x-actor": "agent" };
const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);
const GET = (p) => api("GET", p);
const POST = (p, b, h) => api("POST", p, b, h);
const PUT = (p, b) => api("PUT", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

async function main() {
  console.log(`api-nutrition-diet-profile · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ── default-when-empty philosophy is served even before anything is set / while disabled ──
    await PATCH("/api/addons/nutrition", { enabled: false });
    const def = await GET("/api/nutrition/diet-profile");
    check(def.status === 200, `GET diet-profile while disabled → 200 (got ${def.status})`);
    check(Array.isArray(def.body.profile?.allergies) && def.body.profile.allergies.length === 0, "unset profile → empty allergies");
    check(typeof def.body.profile?.philosophy === "string" && def.body.profile.philosophy.length > 100, "unset profile → the shipped default philosophy (non-empty)");
    check(/protein/i.test(def.body.profile.philosophy), "the default philosophy reads like the methodology (mentions protein)");

    // ── writes 404 while disabled ──
    check((await PUT("/api/nutrition/diet-profile", { allergies: ["x"] })).status === 404, "PUT diet-profile while disabled → 404");
    check((await POST("/api/nutrition/targets", { payload: { daily_calories: 2000 } })).status === 404, "POST targets while disabled → 404");

    // ── enable nutrition (auto-enables body) ──
    const en = await PATCH("/api/addons/nutrition", { enabled: true });
    check(en.status === 200, "PATCH enable nutrition → 200");

    // ── set allergies + a CUSTOM philosophy; the custom one replaces the default ──
    const put = await PUT("/api/nutrition/diet-profile", { allergies: ["peanuts", "shellfish"], dietType: ["vegan"], philosophy: "VEGAN PLAN: plant protein first, B12 + iron emphasis." });
    check(put.status === 200, `PUT diet-profile → 200 (got ${put.status})`);
    check(put.body.profile?.allergies?.includes("peanuts"), "allergies persisted");
    check(put.body.profile?.philosophy?.startsWith("VEGAN PLAN"), "the custom philosophy replaced the default");

    // ── PATCH merge keeps the safety allergy list (never element-dropped) ──
    const patched = await PATCH("/api/nutrition/diet-profile", { dietType: ["vegan", "halal"] });
    check(patched.status === 200 && patched.body.profile?.allergies?.includes("peanuts"), "PATCH (dietType only) preserved the allergies list");

    // ── clearing philosophy via PATCH restores the default-when-empty (allergies kept) ──
    const cleared = await PATCH("/api/nutrition/diet-profile", { philosophy: "" });
    check(cleared.body.profile?.philosophy?.length > 100 && !cleared.body.profile.philosophy.startsWith("VEGAN PLAN"), "cleared philosophy → default served again");
    check(cleared.body.profile?.allergies?.includes("peanuts"), "clearing philosophy did NOT drop the allergies");

    // ── a body profile so the low-calorie warn can resolve the sex ──
    await PUT("/api/body/profile", { sex: "male", dateOfBirth: "1991-06-21", heightCm: 178, trainingStatus: "intermediate", resistanceTrains: true });

    // ── save AGENT-authored targets → attributed "agent", warnings sibling present ──
    const saved = await POST("/api/nutrition/targets", { periodKey: "2026-06-12", payload: { daily_calories: 2300, protein_g: 165, fat_g: 70, carbs_g: 250, stance: "deficit", rationale: "test plan" } }, AGENT);
    check(saved.status === 201, `POST targets (agent) → 201 (got ${saved.status})`);
    check(saved.body.artifact?.source === "agent", "the saved target is attributed source:agent");
    check(Array.isArray(saved.body.warnings) && saved.body.warnings.some((w) => w.id === "not-medical-advice"), "the response carries the not-medical-advice warning sibling");
    check(saved.body.artifact?.payload?.daily_calories === 2300, "the agent payload is stored verbatim");

    // ── a below-floor target trips the one surviving safety warn ──
    const low = await POST("/api/nutrition/targets", { periodKey: "2026-06-13", payload: { daily_calories: 1100 } }, AGENT);
    check(Array.isArray(low.body.warnings) && low.body.warnings.some((w) => w.id === "low-calorie"), "a 1100 kcal target (male, floor 1500) trips the low-calorie warn");

    // ── feed reads: latest + history ──
    const latest = await GET("/api/nutrition/targets?latest=daily_targets");
    check(latest.body.artifact?.periodKey === "2026-06-13", "?latest returns the newest artifact");
    const feed = await GET("/api/nutrition/targets");
    check(Array.isArray(feed.body.items) && feed.body.items.length >= 2 && typeof feed.body.total === "number", "the default GET returns the { items, total } history feed");

    // ── shape validation: a target with no daily_calories → 400 ──
    check((await POST("/api/nutrition/targets", { payload: { foo: 1 } }, AGENT)).status === 400, "a payload without daily_calories → 400");
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — diet-profile (default-when-empty, gate, PATCH-merge safety) + agent-authored targets (attribution, warnings, feed) hold.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
