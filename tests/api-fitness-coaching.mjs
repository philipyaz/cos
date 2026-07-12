#!/usr/bin/env node
// api-fitness-coaching.mjs — full CRUD + gate + upsert contract for the "fitness" add-on's
// STATEFUL coaching artifacts (/api/fitness/coaching[/:id] + db.coachingArtifacts).
//
// Plain Node (ESM), zero deps. The four AI coaching surfaces (training_plan, weekly_review,
// pre_workout_brief, correlations) are persisted in ONE polymorphic array, UPSERTED by
// (kind, periodKey), creatable by an EXTERNAL agent (Cowork) WITHOUT the board's Anthropic
// key, and queryable as history via GET. Against a RUNNING board with the "fitness" add-on
// ENABLED this proves:
//   • POST /api/fitness/coaching (a valid training_plan body) → 201; the minted artifact.id
//     starts "COACH-"; the response carries { artifact, version, created:true }
//   • GET /api/fitness/coaching?kind=training_plan → the new artifact is in items; total >= 1
//   • GET /api/fitness/coaching/<id> → 200 { artifact }
//   • POST again for the SAME (kind, periodKey) → UPSERT: created:false, same id, and the list
//     still holds EXACTLY ONE training_plan for that week (no duplicate)
//   • DISABLE the add-on (PATCH /api/addons/fitness { enabled:false }) → a POST 404s
//     (writes close) while GET /api/fitness/coaching stays 200 (reads stay open)
//   • re-ENABLE → DELETE /api/fitness/coaching/<id> → ok; GET <id> → 404
//
// Every coaching write is gated ONLY by the add-on enabled check (a disabled add-on 404s
// writes), exactly like the rest of the fitness add-on.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero —
// settings.addons + db.coachingArtifacts live in cases.json). Requires a running board:
//   cd board && npm run dev
//   node tests/api-fitness-coaching.mjs   # CRM_BASE_URL defaults to :3000
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
const DELETE = (p, h) => api("DELETE", p, undefined, h);

// A valid training_plan body (the minimal required fields validateCoachingArtifactInput
// enforces: a non-empty week string + a days array). The week is the upsert periodKey.
const WEEK = "2026-W26";
const trainingPlanBody = () => ({
  kind: "training_plan",
  source: "agent",
  payload: {
    week: WEEK,
    recovery_status: "good",
    days: [
      {
        date: "2026-06-22",
        day: "Monday",
        type: "training",
        sport: "Running",
        duration_min: 45,
        intensity: "moderate",
        description: "Coaching-test base run",
        zones: "Z2",
      },
    ],
    weekly_notes: "Coaching CRUD gate-test plan.",
  },
});

async function main() {
  console.log(`api-fitness-coaching · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // Enable the add-on so the coaching writes land.
    const enable = await PATCH("/api/addons/fitness", { enabled: true });
    check(enable.status === 200, `PATCH enable fitness → 200 (got ${enable.status})`);

    // ── CREATE: a POST mints a COACH-<n> artifact ────────────────────────────
    const created = await POST("/api/fitness/coaching", trainingPlanBody());
    check(created.status === 201, `POST /api/fitness/coaching → 201 (got ${created.status})`);
    const id = created.body.artifact?.id;
    check(typeof id === "string" && id.startsWith("COACH-"), `the artifact.id is minted "COACH-…" (got ${id})`);
    check(created.body.created === true, "the response reports created:true (a fresh artifact)");
    check(created.body.artifact?.kind === "training_plan", "the artifact echoes kind training_plan");
    check(created.body.artifact?.periodKey === WEEK, `the artifact periodKey is the week ${WEEK} (got ${created.body.artifact?.periodKey})`);
    check(typeof created.body.version === "number", "the response carries a numeric version");

    // ── LIST: the new artifact shows up, filtered by kind ────────────────────
    const list = await GET("/api/fitness/coaching?kind=training_plan");
    check(list.status === 200, `GET /api/fitness/coaching?kind=training_plan → 200 (got ${list.status})`);
    check(Array.isArray(list.body.items), "the list response carries an items[] array");
    check(list.body.items.some((x) => x.id === id), "the new training_plan is listed");
    check(typeof list.body.total === "number" && list.body.total >= 1, `total >= 1 (got ${list.body.total})`);

    // ── GET-by-id: the artifact reads back ───────────────────────────────────
    const one = await GET(`/api/fitness/coaching/${encodeURIComponent(id)}`);
    check(one.status === 200, `GET /api/fitness/coaching/${id} → 200 (got ${one.status})`);
    check(one.body.artifact?.id === id, "GET-by-id returns the same artifact");

    // ── UPSERT: a re-POST for the SAME (kind, week) updates, never duplicates ─
    const upsert = await POST("/api/fitness/coaching", trainingPlanBody());
    check(upsert.status === 201, `re-POST same week → 201 (got ${upsert.status})`);
    check(upsert.body.created === false, "the re-POST reports created:false (an UPSERT, not a new row)");
    check(upsert.body.artifact?.id === id, `the upsert kept the SAME id ${id} (got ${upsert.body.artifact?.id})`);

    const listAfterUpsert = await GET("/api/fitness/coaching?kind=training_plan");
    const sameWeek = (listAfterUpsert.body.items || []).filter(
      (x) => x.kind === "training_plan" && x.periodKey === WEEK,
    );
    check(sameWeek.length === 1, `EXACTLY ONE training_plan for ${WEEK} (no duplicate; got ${sameWeek.length})`);

    // ── ADD-ON GATE: disabled → writes 404, reads stay 200 ───────────────────
    const disabled = await PATCH("/api/addons/fitness", { enabled: false });
    check(disabled.status === 200, `PATCH disable fitness → 200 (got ${disabled.status})`);

    const blockedPost = await POST("/api/fitness/coaching", trainingPlanBody());
    check(blockedPost.status === 404, `POST while disabled → 404 (got ${blockedPost.status})`);

    const readWhileDisabled = await GET("/api/fitness/coaching?kind=training_plan");
    check(
      readWhileDisabled.status === 200,
      `GET /api/fitness/coaching while disabled → 200 (reads stay open; got ${readWhileDisabled.status})`,
    );
    check(
      (readWhileDisabled.body.items || []).some((x) => x.id === id),
      "the artifact is STILL readable while the add-on is disabled (reads are ungated)",
    );

    // ── re-ENABLE then DELETE → the artifact is gone ─────────────────────────
    const reEnable = await PATCH("/api/addons/fitness", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable fitness → 200 (got ${reEnable.status})`);

    const del = await DELETE(`/api/fitness/coaching/${encodeURIComponent(id)}`);
    check(del.status === 200, `DELETE /api/fitness/coaching/${id} → 200 (got ${del.status})`);
    check(del.body.ok === true, "DELETE reports ok:true");

    const gone = await GET(`/api/fitness/coaching/${encodeURIComponent(id)}`);
    check(gone.status === 404, `GET /api/fitness/coaching/${id} after delete → 404 (got ${gone.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} coaching CRUD check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — fitness coaching artifacts CRUD holds (201 create, upsert-no-duplicate, 404 disabled, reads open, delete).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
