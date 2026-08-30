#!/usr/bin/env node
// api-fitness-push-plan.mjs — end-to-end contract for the RECONCILING calendar push
// (board/app/api/fitness/push-plan-to-calendar/route.ts + board/lib/placement.ts).
//
// Plain Node (ESM), zero deps. Against a RUNNING board with the "fitness" add-on ENABLED,
// this saves a training plan (open-enum day types — endurance/strength/tempo/long/technique,
// NEVER the literal "training" — so a stray allow-list on that one string would be caught: a
// day typed "endurance" that MUST be placed is the assertion an allow-list fails) and proves:
//   • idempotency         — pushing twice creates nothing new the second time; the week's total
//                           event count is unchanged (created:0, updated:4 on the re-push)
//   • per-day receipts    — GET /api/fitness/coaching/<id> shows payload.days[i].eventId on
//                           every SESSION day, and NONE on a rest / active_recovery / skipped day
//   • rest-day deny-list  — rest AND active_recovery days create nothing (never an allow-list on
//                           the single string "training")
//   • overlap-safety      — a pre-seeded conflict across the WHOLE evening window pushes a session
//                           into the morning window instead of double-booking; a day fully booked
//                           in BOTH windows is reported skipped/no_free_slot with nothing created
//   • the description IS the payload — a created event's description carries the day's own prose
//     + duration
//   • human edits win     — a manually PATCHed event startTime is NEVER moved back by a re-push;
//                           only the title/description refresh (an "updated" op, not a re-create)
//   • carry-forward       — re-saving the SAME week (upsert) then pushing still yields exactly one
//                           event per placed day (proven over HTTP, not just the unit test)
//   • regenerate-to-rest  — flipping a day that already has a live event to rest/active_recovery
//                           in a regenerated plan reports skipped/rest_day WITH the stale eventId,
//                           and the event itself is left untouched (never deleted)
//   • caller-only busy    — a conflict that exists ONLY in a caller-supplied `busyWindows` entry
//                           (ops#25) is avoided just as if it were a real event — the session falls
//                           through to the morning margin — and the windows are NEVER persisted:
//                           after the call, the raw store file contains neither sentinel time
//   • the add-on GATE     — disabled → 404 (mirrors api-fitness-gate.mjs)
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero — settings.addons
// + coachingArtifacts + events all live in cases.json). Requires a running board:
//   cd board && npm run dev
//   node tests/api-fitness-push-plan.mjs   # CRM_BASE_URL defaults to :3000
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

// ── Dynamic dates: a week anchored on the NEXT Monday (always safely in the future, and pins
// which index is a weekday vs a weekend so the fixture is correct regardless of when this runs) ──
function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(dayISO, n) {
  const [y, m, d] = dayISO.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d + n)));
}
function nextMonday() {
  const d = new Date();
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = ((8 - dow) % 7) || 7; // 1..7, so it is NEVER today
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)));
}
const MONDAY = nextMonday();
const day = (n) => addDays(MONDAY, n); // 0=Mon 1=Tue 2=Wed 3=Thu 4=Fri 5=Sat 6=Sun

const WEEK = "2099-W01"; // a periodKey that can never collide with a real plan

const baseDays = () => [
  { date: day(0), type: "endurance", sport: "running", duration_min: 45, intensity: "easy", description: "Base endurance run", zones: "Z2" },
  { date: day(1), type: "rest" },
  { date: day(2), type: "strength", sport: "strength_training", duration_min: 40, intensity: "moderate", description: "Full-body strength session" },
  { date: day(3), type: "active_recovery", sport: "walking", duration_min: 30, intensity: "recovery", description: "Easy recovery walk" },
  { date: day(4), type: "tempo", sport: "running", duration_min: 50, intensity: "hard", description: "Tempo intervals", zones: "Z4" },
  { date: day(5), type: "long", sport: "cycling_outdoor", duration_min: 90, intensity: "moderate", description: "Long steady ride", zones: "Z2" },
  { date: day(6), type: "technique", sport: "swimming_pool", duration_min: 35, intensity: "easy", description: "Technique drills" },
];

const savePlan = (days, notes = "push-plan-to-calendar test", week = WEEK) =>
  POST("/api/fitness/coaching", {
    kind: "training_plan",
    source: "agent",
    payload: { week, recovery_status: "good", days, weekly_notes: notes },
  });

const resultByDate = (body) => Object.fromEntries(body.results.map((r) => [r.date, r]));

async function main() {
  console.log(`api-fitness-push-plan · board=${BASE} · week anchored ${MONDAY}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    const enable = await PATCH("/api/addons/fitness", { enabled: true });
    check(enable.status === 200, `PATCH enable fitness → 200 (got ${enable.status})`);

    const saved = await savePlan(baseDays());
    check(saved.status === 201, `POST /api/fitness/coaching → 201 (got ${saved.status})`);
    const artifactId = saved.body.artifact?.id;
    check(typeof artifactId === "string" && artifactId.startsWith("COACH-"), `artifact id minted (got ${artifactId})`);

    // Pre-seed conflicts BEFORE the first push: Wed's whole EVENING window is booked (should
    // fall through to the morning window); Fri's BOTH windows are booked (should skip entirely).
    const wedConflict = await POST("/api/events", { title: "Busy evening", date: day(2), allDay: false, startTime: "18:00", endTime: "21:30" });
    check(wedConflict.status === 201, `pre-seed Wed evening conflict → 201 (got ${wedConflict.status})`);
    const friEvening = await POST("/api/events", { title: "Busy evening", date: day(4), allDay: false, startTime: "18:00", endTime: "21:30" });
    const friMorning = await POST("/api/events", { title: "Busy morning", date: day(4), allDay: false, startTime: "06:30", endTime: "09:00" });
    check(friEvening.status === 201 && friMorning.status === 201, "pre-seed Fri fully-busy (both windows) → 201/201");

    // ── first push ────────────────────────────────────────────────────────────
    const push1 = await POST("/api/fitness/push-plan-to-calendar", { periodKey: WEEK });
    check(push1.status === 200, `first push → 200 (got ${push1.status})`);
    check(Array.isArray(push1.body.results) && push1.body.results.length === 7, `results carries all 7 plan days (got ${push1.body.results?.length})`);
    check(push1.body.created === 4, `4 sessions created — Mon/Wed/Sat/Sun (got ${push1.body.created})`);
    check(push1.body.skipped === 3, `3 skipped — Tue/Thu rest, Fri no_free_slot (got ${push1.body.skipped})`);

    const r1 = resultByDate(push1.body);
    check(r1[day(0)].action === "created", "Mon (endurance, open-enum type) IS placed");
    check(r1[day(1)].action === "skipped" && r1[day(1)].reason === "rest_day", "Tue (rest) skipped/rest_day, nothing created");
    check(r1[day(2)].action === "created", "Wed (strength) still placed despite the evening conflict");
    check(r1[day(3)].action === "skipped" && r1[day(3)].reason === "rest_day", "Thu (active_recovery) skipped/rest_day, nothing created");
    check(r1[day(4)].action === "skipped" && r1[day(4)].reason === "no_free_slot", "Fri (tempo) skipped/no_free_slot — fully booked both windows");
    check(r1[day(5)].action === "created", "Sat (long, weekend window) IS placed");
    check(r1[day(6)].action === "created", "Sun (technique, weekend window) IS placed");

    // Overlap-safety: Wed's session must have landed in the MORNING window, not on the conflict.
    const wedEvent = await GET(`/api/events/${r1[day(2)].eventId}`);
    check(wedEvent.body.event?.startTime === "06:30", `Wed session placed at 06:30 (morning window), not on the evening conflict (got ${wedEvent.body.event?.startTime})`);
    check(wedEvent.body.event?.description?.includes("Full-body strength session"), "Wed event description carries its own session prose");

    // The description IS the payload (day prose + duration).
    const mondayEvent = await GET(`/api/events/${r1[day(0)].eventId}`);
    check(mondayEvent.body.event?.description?.includes("Base endurance run"), "Monday event description carries the session prose");
    check(mondayEvent.body.event?.description?.includes("Duration: 45 min"), "Monday event description carries the duration");

    const rangeFrom = day(0);
    const rangeTo = addDays(day(6), 1); // half-open, so day(6) itself is included
    const eventsBefore = await GET(`/api/events?from=${rangeFrom}&to=${rangeTo}`);
    const countBefore = eventsBefore.body.events.length;

    // ── idempotency: push again ──────────────────────────────────────────────
    const push2 = await POST("/api/fitness/push-plan-to-calendar", { periodKey: WEEK });
    check(push2.status === 200, `second push → 200 (got ${push2.status})`);
    check(push2.body.created === 0, `second push creates NOTHING NEW (got ${push2.body.created})`);
    check(push2.body.updated === 4, `second push UPDATES the 4 previously-placed sessions (got ${push2.body.updated})`);
    const eventsAfter = await GET(`/api/events?from=${rangeFrom}&to=${rangeTo}`);
    check(eventsAfter.body.events.length === countBefore, `event count for the week UNCHANGED after the second push (before=${countBefore}, after=${eventsAfter.body.events.length})`);

    // ── per-day receipts on the artifact itself ──────────────────────────────
    const artifactAfterPush = await GET(`/api/fitness/coaching/${artifactId}`);
    const byDate = Object.fromEntries(artifactAfterPush.body.artifact.payload.days.map((d) => [d.date, d]));
    check(typeof byDate[day(0)].eventId === "string", "Monday's day entry carries an eventId receipt");
    check(typeof byDate[day(2)].eventId === "string", "Wednesday's day entry carries an eventId receipt");
    check(byDate[day(1)].eventId === undefined, "Tuesday (rest) carries no eventId");
    check(byDate[day(4)].eventId === undefined, "Friday (skipped, no_free_slot) carries no eventId");

    // ── human edits win: PATCH a pushed event's time by hand, then re-save + re-push ─────────
    const sunEventId = r1[day(6)].eventId;
    const manualPatch = await PATCH(`/api/events/${sunEventId}`, { startTime: "20:00", endTime: "20:35" });
    check(manualPatch.status === 200, `manual PATCH of Sunday's event time → 200 (got ${manualPatch.status})`);

    const daysV2 = baseDays().map((d) => (d.date === day(6) ? { ...d, description: "Technique drills — REVISED" } : d));
    const savedV2 = await savePlan(daysV2);
    check(savedV2.status === 201 && savedV2.body.created === false, `re-save (upsert) same week → 201, created:false (got ${savedV2.status}/${savedV2.body.created})`);

    const push3 = await POST("/api/fitness/push-plan-to-calendar", { periodKey: WEEK });
    check(push3.status === 200, "third push (after manual edit + re-save) → 200");
    const r3 = resultByDate(push3.body);
    check(r3[day(6)].action === "updated", "Sunday's session is an UPDATE, never a re-create");

    const sunEventAfter = await GET(`/api/events/${sunEventId}`);
    check(sunEventAfter.body.event?.startTime === "20:00", `Sunday's manually-set startTime is UNCHANGED (got ${sunEventAfter.body.event?.startTime})`);
    check(sunEventAfter.body.event?.description?.includes("REVISED"), "Sunday's description REFRESHED to the new content");

    // ── carry-forward proven over HTTP: still one event per placed day ──────
    const eventsAfterV2Push = await GET(`/api/events?from=${rangeFrom}&to=${rangeTo}`);
    check(eventsAfterV2Push.body.events.length === countBefore, `still exactly one event per placed day after the upsert + push (got ${eventsAfterV2Push.body.events.length})`);

    // ── regenerate-to-rest: Saturday flips from "long" to "rest" ─────────────
    const satEventId = r1[day(5)].eventId;
    const daysV3 = daysV2.map((d) => (d.date === day(5) ? { date: day(5), type: "rest" } : d));
    const savedV3 = await savePlan(daysV3);
    check(savedV3.status === 201, `re-save with Saturday flipped to rest → 201 (got ${savedV3.status})`);

    const push4 = await POST("/api/fitness/push-plan-to-calendar", { periodKey: WEEK });
    const r4 = resultByDate(push4.body);
    check(r4[day(5)].action === "skipped" && r4[day(5)].reason === "rest_day", "Saturday (now rest) is skipped/rest_day");
    check(r4[day(5)].eventId === satEventId, `the skip result STILL carries the stale eventId ${satEventId} (got ${r4[day(5)].eventId})`);

    const satEventStill = await GET(`/api/events/${satEventId}`);
    check(satEventStill.status === 200, "Saturday's old event is UNTOUCHED (not deleted) after flipping to rest");

    // ── ops#25: a conflict that exists ONLY in busyWindows is avoided, and never persisted ───
    const WEEK2 = "2099-W02"; // a separate artifact — no carry-forward receipt to interfere
    const busyProbeDate = day(10); // a weekday untouched by anything above
    const saved2 = await savePlan(
      [{ date: busyProbeDate, type: "endurance", sport: "running", duration_min: 45, intensity: "easy", description: "busyWindows probe" }],
      "busy-windows probe",
      WEEK2,
    );
    check(saved2.status === 201, `POST a fresh single-day plan (${WEEK2}) → 201 (got ${saved2.status})`);

    const pushBusy = await POST("/api/fitness/push-plan-to-calendar", {
      periodKey: WEEK2,
      busyWindows: [{ date: busyProbeDate, start: "18:07", end: "21:23" }],
    });
    check(pushBusy.status === 200, `push with a caller-only busyWindows conflict → 200 (got ${pushBusy.status})`);
    check(pushBusy.body.created === 1, `the probe day is created (got ${pushBusy.body.created})`);
    check(pushBusy.body.results[0]?.action === "created", "the probe day is placed, not skipped");

    const probeEvent = await GET(`/api/events/${pushBusy.body.results[0].eventId}`);
    check(
      probeEvent.body.event?.startTime === "06:30",
      `the session falls through to the MORNING margin — the evening conflict exists ONLY in busyWindows, not db.events (got ${probeEvent.body.event?.startTime})`,
    );

    // Quote-bounded, not a loose substring search: an ISO createdAt/updatedAt timestamp
    // minted during this very test run (e.g. "...T18:07:45.230Z") legitimately CONTAINS
    // "18:07" without a leading/trailing '"' — a bare .includes("18:07") is a false-positive
    // trap at whatever wall-clock minute the suite happens to run. `"18:07"` (as a complete,
    // quoted JSON string value) is what an actually-leaked CalendarEvent startTime/endTime
    // would look like, and an ISO timestamp never produces that exact quoted token.
    const rawStoreAfterBusy = await fs.readFile(DATA_FILE, "utf8");
    check(
      !rawStoreAfterBusy.includes('"18:07"') && !rawStoreAfterBusy.includes('"21:23"'),
      "the busyWindows sentinel times appear NOWHERE in the raw store file after the call — used-and-discarded, never persisted",
    );

    // ── GATE: disabled add-on → 404 (mirrors api-fitness-gate.mjs) ───────────
    const disabled = await PATCH("/api/addons/fitness", { enabled: false });
    check(disabled.status === 200, `PATCH disable fitness → 200 (got ${disabled.status})`);
    const blocked = await POST("/api/fitness/push-plan-to-calendar", { periodKey: WEEK });
    check(blocked.status === 404, `push while disabled → 404 (got ${blocked.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} push-plan check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — fitness push-plan-to-calendar is idempotent, overlap-safe, rest-day-safe, and reconciles across a regenerate.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
