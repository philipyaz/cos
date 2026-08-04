#!/usr/bin/env node
// api-fitness-plan-outcome.mjs — end-to-end contract for the per-day training-plan OUTCOME
// channel (cos-ops#19: PATCH /api/fitness/coaching/<id>/day + the computed `reconciliation` on
// GET /api/fitness/coaching/<id>).
//
// Plain Node (ESM), zero deps. Against a RUNNING board with the "fitness" add-on ENABLED, this
// seeds one training_plan artifact with open-enum session days (endurance/strength — never the
// literal "training", so a stray allow-list would be caught) on three PAST dates, one `rest`
// day, one `active_recovery` day, and one FUTURE day, then proves:
//   (a) targeted write   — a day PATCH changes exactly that one day; every other day's keys are
//                          byte-identical, and no plan-level key is touched
//   (b) schema untouched — the raw store file's schemaVersion is unchanged (the outcome rides
//                          the verbatim payload, no schema bump)
//   (c) computed + immediate — reconciliation.unresolvedDays reflects the write on the very next
//                          GET; rest/active_recovery days never appear in it
//   (d) proof             — a same-date healthEntries workout PROVES exactly the one day it
//                          matches (provenDone:true + healthEntryId), never another day
//   (e) never fabricated  — an unanswered day stays `planned` (absent key) and is never written
//                          by a mere read
//   (f) route-vs-tool     — server.mjs and fitness-client.ts both reference the SAME `/day`-
//                          suffixed coaching path (statically, in-file)
//   • validation           — bad status / moved without moved_to / moved_to on a non-moved
//                          status / an unknown date / a rest-day date all 400
//   • the add-on GATE      — disabled → the day PATCH 404s while the read stays open
//   • push integration     — a day already resolved (done/skipped/moved) is reported
//                          skipped/resolved by push-plan-to-calendar and never placed; an
//                          unanswered PAST day is skipped/past (the pre-existing engine rule);
//                          nothing is created at all
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero —
// coachingArtifacts + healthEntries + settings.addons all live in cases.json). Requires a
// running board:
//   cd board && npm run dev
//   node tests/api-fitness-plan-outcome.mjs   # CRM_BASE_URL defaults to :3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs, readFileSync } from "node:fs";
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

// ── Dynamic dates, all anchored on TODAY (mirrors api-fitness-push-plan.mjs's nextMonday()
// idiom): the past days must stay WITHIN the 90-day health-entry retention window, or the
// proof workout this test pushes would be purged the instant it lands (a fixed far-past
// literal like "2020-01-14" is exactly wrong here — retention would delete it on arrival). ──
function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(dayISO, n) {
  const [y, m, d] = dayISO.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d + n)));
}
const TODAY = isoDay(new Date());

// ── (f) route-vs-tool: static, in-file — no HTTP needed for this one ────────────────────────
// `/api/fitness/coaching/` alone half-passes today via the existing get/delete handlers; the
// `/day` suffix is the signal that both surfaces actually wire the NEW nested route.
function checkRouteVsTool() {
  const DAY_ROUTE_RE = /coaching\/.*\/day/;
  const serverSrc = readFileSync(path.join(HERE, "..", "mcp", "fitness-server", "server.mjs"), "utf8");
  const clientSrc = readFileSync(path.join(HERE, "..", "board", "lib", "fitness-client.ts"), "utf8");
  check(DAY_ROUTE_RE.test(serverSrc), "mcp/fitness-server/server.mjs references the /day-suffixed coaching path");
  check(DAY_ROUTE_RE.test(clientSrc), "board/lib/fitness-client.ts references the SAME /day-suffixed coaching path");
}

const WEEK = "2020-W03"; // a periodKey that can never collide with a real plan — independent of the days' own dates
const D1 = addDays(TODAY, -6); // endurance — resolved directly (a)
const D2 = addDays(TODAY, -5); // strength — resolved via proof (d); must be within the 90-day retention window
const D3 = addDays(TODAY, -4); // endurance — left unanswered throughout (e)
const D_REST = addDays(TODAY, -3); // rest — outside the session-day universe
const D_ACTIVE_RECOVERY = addDays(TODAY, -2); // active_recovery — outside the session-day universe
const D_FUTURE = addDays(TODAY, 30); // a session day that hasn't happened yet

const seedDays = () => [
  { date: D1, type: "endurance", sport: "running", duration_min: 40, intensity: "moderate", description: "Base run" },
  { date: D2, type: "strength", sport: "strength_training", duration_min: 35, intensity: "moderate", description: "Full-body strength" },
  { date: D3, type: "endurance", sport: "cycling", duration_min: 50, intensity: "easy", description: "Easy spin" },
  { date: D_REST, type: "rest" },
  { date: D_ACTIVE_RECOVERY, type: "active_recovery", sport: "walking", duration_min: 30, intensity: "recovery", description: "Recovery walk" },
  { date: D_FUTURE, type: "endurance", sport: "running", duration_min: 45, intensity: "moderate", description: "Future base run" },
];

const savePlan = () =>
  POST("/api/fitness/coaching", {
    kind: "training_plan",
    source: "agent",
    payload: { week: WEEK, recovery_status: "good", days: seedDays(), weekly_notes: "outcome-channel test plan" },
  });

const byDate = (days) => Object.fromEntries(days.map((d) => [d.date, d]));
const resultByDate = (body) => Object.fromEntries(body.results.map((r) => [r.date, r]));

async function main() {
  console.log(`api-fitness-plan-outcome · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");
  const schemaVersionBefore = JSON.parse(snapshot).schemaVersion;

  checkRouteVsTool();

  try {
    const enable = await PATCH("/api/addons/fitness", { enabled: true });
    check(enable.status === 200, `PATCH enable fitness → 200 (got ${enable.status})`);

    const saved = await savePlan();
    check(saved.status === 201, `seed POST /api/fitness/coaching → 201 (got ${saved.status})`);
    const id = saved.body.artifact?.id;
    check(typeof id === "string" && id.startsWith("COACH-"), `artifact id minted (got ${id})`);
    const originalByDate = byDate(saved.body.artifact.payload.days);

    // ── (a) targeted write — ONE day changes, nothing else does ─────────────────
    const patchD1 = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D1, status: "done" });
    check(patchD1.status === 200, `PATCH .../day {${D1}, done} → 200 (got ${patchD1.status})`);
    check(patchD1.body.day?.status === "done", "the response's day carries the new status");
    check(typeof patchD1.body.artifact === "object", "the response also carries the whole artifact");

    const afterD1 = await GET(`/api/fitness/coaching/${id}`);
    const daysAfterD1 = byDate(afterD1.body.artifact.payload.days);
    check(daysAfterD1[D1].status === "done", `re-GET shows ${D1} status:"done"`);
    for (const d of [D2, D3, D_REST, D_ACTIVE_RECOVERY, D_FUTURE]) {
      check(
        JSON.stringify(daysAfterD1[d]) === JSON.stringify(originalByDate[d]),
        `${d}'s day entry is BYTE-IDENTICAL to before the write — only ${D1} changed`,
      );
    }
    check(afterD1.body.artifact.payload.week === WEEK, "plan-level 'week' is untouched");
    check(afterD1.body.artifact.payload.weekly_notes === "outcome-channel test plan", "plan-level 'weekly_notes' is untouched");

    // ── (b) schema untouched — the outcome rides the verbatim payload ───────────
    const rawAfterD1 = await fs.readFile(DATA_FILE, "utf8");
    const schemaVersionAfter = JSON.parse(rawAfterD1).schemaVersion;
    check(
      schemaVersionAfter === schemaVersionBefore,
      `schemaVersion unchanged by a day write (before=${schemaVersionBefore}, after=${schemaVersionAfter})`,
    );

    // ── (c) computed + immediate — reconciliation reflects the write right away ─
    const unresolvedAfterD1 = new Set(afterD1.body.reconciliation.unresolvedDays.days.map((d) => d.date));
    check(!unresolvedAfterD1.has(D1), `${D1} (just resolved) is excluded from unresolvedDays on the very next GET`);
    check(unresolvedAfterD1.has(D2) && unresolvedAfterD1.has(D3), `${D2} and ${D3} are still unresolved`);
    check(!unresolvedAfterD1.has(D_REST) && !unresolvedAfterD1.has(D_ACTIVE_RECOVERY), "rest/active_recovery never appear in unresolvedDays");
    check(afterD1.body.reconciliation.sessionDays === 4, `sessionDays counts the 4 open-enum days, excluding rest/active_recovery (got ${afterD1.body.reconciliation.sessionDays})`);

    // ── (d) proof resolves exactly the ONE proven day ────────────────────────────
    const pushWorkout = await POST("/api/fitness/push", {
      entries: [{ id: "HE-OUTCOME-PROOF", ts: `${D2}T18:00:00.000Z`, type: "workout", data: { activity: "strength_training", duration_min: 35 } }],
    });
    check(pushWorkout.status === 201, `POST /api/fitness/push (proof workout) → 201 (got ${pushWorkout.status})`);

    const afterProof = await GET(`/api/fitness/coaching/${id}`);
    const unresolvedProofByDate = Object.fromEntries(afterProof.body.reconciliation.unresolvedDays.days.map((d) => [d.date, d]));
    check(unresolvedProofByDate[D2]?.provenDone === true, `${D2} is provenDone (a same-date workout exists)`);
    check(typeof unresolvedProofByDate[D2]?.healthEntryId === "string", `${D2}'s unresolved entry carries the proving healthEntryId`);
    check(unresolvedProofByDate[D3]?.provenDone === false, `${D3} is NOT provenDone (no matching workout)`);

    // As the close-out skill would: write the proven day.
    const patchD2 = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D2, status: "done" });
    check(patchD2.status === 200, `PATCH .../day {${D2}, done} (citing the proof) → 200 (got ${patchD2.status})`);

    const afterD2 = await GET(`/api/fitness/coaching/${id}`);
    const unresolvedAfterD2 = new Set(afterD2.body.reconciliation.unresolvedDays.days.map((d) => d.date));
    check(!unresolvedAfterD2.has(D2), `${D2} leaves unresolvedDays once written`);
    check(unresolvedAfterD2.has(D3), `${D3} is still the only one left unresolved`);
    check(afterD2.body.reconciliation.unresolvedDays.count === 1, `unresolvedDays.count === 1 (got ${afterD2.body.reconciliation.unresolvedDays.count})`);

    // ── (e) never fabricated — D3 stays 'planned' (absent key), nothing wrote it ─
    const d3Raw = byDate(afterD2.body.artifact.payload.days)[D3];
    check(d3Raw.status === undefined, `${D3} carries NO status key — a mere read never writes an outcome`);

    // ── validation: fast 400s ────────────────────────────────────────────────────
    const badStatus = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D1, status: "not-a-real-status" });
    check(badStatus.status === 400, `bad status → 400 (got ${badStatus.status})`);

    const movedNoDestination = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D1, status: "moved" });
    check(movedNoDestination.status === 400, `'moved' without moved_to → 400 (got ${movedNoDestination.status})`);

    const movedToOnNonMoved = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D1, status: "done", movedTo: "2020-02-01" });
    check(movedToOnNonMoved.status === 400, `movedTo present on a non-'moved' status → 400 (got ${movedToOnNonMoved.status})`);

    const unknownDate = await PATCH(`/api/fitness/coaching/${id}/day`, { date: "2020-01-01", status: "done" });
    check(unknownDate.status === 400, `an unknown date → 400 (got ${unknownDate.status})`);

    const restDayWrite = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D_REST, status: "done" });
    check(restDayWrite.status === 400, `writing an outcome on a rest day → 400 (got ${restDayWrite.status})`);

    // ── the add-on GATE: disabled → 404 the write; reads stay open ───────────────
    const disabled = await PATCH("/api/addons/fitness", { enabled: false });
    check(disabled.status === 200, `PATCH disable fitness → 200 (got ${disabled.status})`);

    const blockedWrite = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D3, status: "done" });
    check(blockedWrite.status === 404, `day PATCH while disabled → 404 (got ${blockedWrite.status})`);

    const readWhileDisabled = await GET(`/api/fitness/coaching/${id}`);
    check(readWhileDisabled.status === 200, `GET while disabled → 200 (reads stay open; got ${readWhileDisabled.status})`);
    check(typeof readWhileDisabled.body.reconciliation === "object", "reconciliation is STILL computed while the add-on is disabled (reads are ungated)");

    const reEnable = await PATCH("/api/addons/fitness", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable fitness → 200 (got ${reEnable.status})`);

    // ── push integration ─────────────────────────────────────────────────────────
    const patchFuture = await PATCH(`/api/fitness/coaching/${id}/day`, { date: D_FUTURE, status: "skipped" });
    check(patchFuture.status === 200, `PATCH .../day {${D_FUTURE}, skipped} → 200 (got ${patchFuture.status})`);

    const push = await POST("/api/fitness/push-plan-to-calendar", { artifactId: id });
    check(push.status === 200, `push-plan-to-calendar → 200 (got ${push.status})`);
    const pushResults = resultByDate(push.body);
    check(
      pushResults[D_FUTURE]?.action === "skipped" && pushResults[D_FUTURE]?.reason === "resolved",
      `${D_FUTURE} (marked skipped) reports skipped/resolved (got ${pushResults[D_FUTURE]?.action}/${pushResults[D_FUTURE]?.reason})`,
    );
    check(
      pushResults[D1]?.action === "skipped" && pushResults[D1]?.reason === "resolved",
      `${D1} (marked done) reports skipped/resolved, never placed (got ${pushResults[D1]?.action}/${pushResults[D1]?.reason})`,
    );
    check(
      pushResults[D2]?.action === "skipped" && pushResults[D2]?.reason === "resolved",
      `${D2} (marked done) reports skipped/resolved, never placed (got ${pushResults[D2]?.action}/${pushResults[D2]?.reason})`,
    );
    check(
      pushResults[D3]?.action === "skipped" && pushResults[D3]?.reason === "past",
      `${D3} (unanswered, but dated in the past) is skipped/past by the PRE-EXISTING engine rule, not invented by this unit (got ${pushResults[D3]?.action}/${pushResults[D3]?.reason})`,
    );
    check(
      pushResults[D_REST]?.action === "skipped" && pushResults[D_REST]?.reason === "rest_day",
      `${D_REST} still reports skipped/rest_day`,
    );
    check(push.body.created === 0, `nothing at all is created — every day is either resolved, rest, or an unanswered past day (got ${push.body.created})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} plan-outcome check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — the per-day training-plan outcome channel holds (targeted write, computed reconciliation, proof, validation, gate, push integration).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
