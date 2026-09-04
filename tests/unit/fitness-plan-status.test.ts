// Unit tests for the fitness per-day RECONCILIATION engine (board/lib/fitness-plan-status.ts) —
// the training-plan twin of nutrition-status.ts's computeNutritionStatus. Pure, deterministic,
// clock-free (today injected), so it runs headless under `node --test` with NO disk and NO
// clock. Covers the boundary/proof/deny-list rules the live-API test
// (tests/api-fitness-plan-outcome.mjs) exercises end-to-end but can't isolate as precisely.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/fitness-plan-status.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePlanReconciliation,
  isSessionDay,
  VALID_PLAN_DAY_OUTCOME,
  effectivePlanDayStatus,
} from "../../board/lib/fitness-plan-status.ts";
import type { HealthEntry } from "../../board/lib/types.ts";

const TODAY = "2026-07-26";

const workout = (over: Partial<HealthEntry> = {}): HealthEntry => ({
  id: "HE-1",
  ts: "2026-07-25T18:00:00.000Z",
  type: "workout",
  data: { activity: "running", duration_min: 40 },
  pushedAt: "2026-07-25T19:00:00.000Z",
  ...over,
});

// ── isSessionDay: the deny-list truth table ──────────────────────────────────────────────────
test("isSessionDay: rest and active_recovery are excluded; everything else — including an unseen open-enum type or a missing type — counts", () => {
  assert.equal(isSessionDay({ type: "rest" }), false);
  assert.equal(isSessionDay({ type: "active_recovery" }), false);
  assert.equal(isSessionDay({ type: "training" }), true);
  assert.equal(isSessionDay({ type: "endurance" }), true, "the day-type enum is OPEN — not an allow-list on 'training'");
  assert.equal(isSessionDay({ type: "intervals" }), true);
  assert.equal(isSessionDay({}), true, "a missing type over-includes rather than silently dropping a real session");
  assert.equal(isSessionDay({ type: 42 }), true, "a non-string type is not 'rest'/'active_recovery' either");
});

test("VALID_PLAN_DAY_OUTCOME is the four-value enum", () => {
  assert.deepEqual(VALID_PLAN_DAY_OUTCOME, ["planned", "done", "skipped", "moved"]);
});

// ── computePlanReconciliation: garbage in → zeros out, never throws ─────────────────────────────
test("computePlanReconciliation: missing/non-array/dayless days → zeros, no throw", () => {
  const empty = {
    sessionDays: 0,
    outcomes: { done: 0, skipped: 0, moved: 0, planned: 0 },
    unresolvedDays: { count: 0, days: [] },
    calendarCoverage: { sessionDays: 0, withEventId: 0, missing: { count: 0, dates: [] } },
  };

  assert.deepEqual(computePlanReconciliation({ payload: {}, healthEntries: [], today: TODAY }), empty, "no days key at all");
  assert.deepEqual(
    computePlanReconciliation({ payload: { days: "not-an-array" }, healthEntries: [], today: TODAY }),
    empty,
    "days is not an array",
  );
  assert.deepEqual(
    computePlanReconciliation({
      payload: { days: [null, "garbage", 42, {}, { type: "training" }] }, // last two have no `date`
      healthEntries: [],
      today: TODAY,
    }),
    empty,
    "every entry is either not an object or has no date — nothing to reconcile",
  );
});

// ── absent status ≡ planned ──────────────────────────────────────────────────────────────────
test("computePlanReconciliation: a day with no status key is effectively 'planned'", () => {
  const r = computePlanReconciliation({
    payload: { days: [{ date: "2026-07-20", type: "endurance", sport: "running" }] },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.sessionDays, 1);
  assert.equal(r.outcomes.planned, 1);
  assert.equal(r.unresolvedDays.count, 1, "an unanswered past session day is unresolved");
  assert.equal(r.unresolvedDays.days[0].date, "2026-07-20");
});

// ── strict boundary: today's own session is NOT yet unresolved ─────────────────────────────────
test("computePlanReconciliation: strict date < today — today is not unresolved, yesterday is", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: TODAY, type: "endurance", sport: "running" }, // today — may still happen
        { date: "2026-07-25", type: "endurance", sport: "running" }, // yesterday — unresolved
      ],
    },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.sessionDays, 2, "both are still session days for outcomes/sessionDays purposes");
  assert.equal(r.outcomes.planned, 2);
  assert.equal(r.unresolvedDays.count, 1, "only the past day is unresolved");
  assert.equal(r.unresolvedDays.days[0].date, "2026-07-25");
});

// ── deny-list universe — the allow-list tripwire ────────────────────────────────────────────────
test("computePlanReconciliation: rest/active_recovery are outside the universe; an open-enum day is inside", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: "2026-07-20", type: "rest", sport: "rest" },
        { date: "2026-07-21", type: "active_recovery", sport: "walk" },
        { date: "2026-07-22", type: "endurance", sport: "cycling" }, // NOT "training" — the tripwire
      ],
    },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.sessionDays, 1, "only the open-enum session day counts — rest/active_recovery are excluded entirely");
  assert.equal(r.outcomes.planned, 1);
  assert.equal(r.unresolvedDays.count, 1);
  assert.equal(r.unresolvedDays.days[0].type, "endurance");
});

// ── provenDone: date-level workout proof, first match, no sport matching ───────────────────────
test("computePlanReconciliation: a same-date workout entry proves a day; a non-workout entry or a different date does not", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: "2026-07-20", type: "endurance", sport: "running" }, // proven by a workout
        { date: "2026-07-21", type: "strength", sport: "strength" }, // only an hrv entry same-date — not proven
        { date: "2026-07-22", type: "endurance", sport: "cycling" }, // a workout exists, but on another date
      ],
    },
    healthEntries: [
      workout({ id: "HE-PROOF", ts: "2026-07-20T18:00:00.000Z" }),
      { id: "HE-HRV", ts: "2026-07-21", type: "hrv", data: { value: 40 }, pushedAt: "2026-07-21T00:00:00.000Z" },
      workout({ id: "HE-WRONG-DATE", ts: "2026-07-23T18:00:00.000Z" }),
    ],
    today: TODAY,
  });
  const byDate = Object.fromEntries(r.unresolvedDays.days.map((d) => [d.date, d]));
  assert.equal(byDate["2026-07-20"].provenDone, true);
  assert.equal(byDate["2026-07-20"].healthEntryId, "HE-PROOF");
  assert.equal(byDate["2026-07-21"].provenDone, false, "a same-date NON-workout entry does not prove");
  assert.equal(byDate["2026-07-21"].healthEntryId, undefined);
  assert.equal(byDate["2026-07-22"].provenDone, false, "a workout on a DIFFERENT date does not prove this day");
});

test("computePlanReconciliation: proof is first-match by array order — one healthEntryId per day", () => {
  const r = computePlanReconciliation({
    payload: { days: [{ date: "2026-07-20", type: "endurance", sport: "running" }] },
    healthEntries: [
      workout({ id: "HE-FIRST", ts: "2026-07-20T07:00:00.000Z" }),
      workout({ id: "HE-SECOND", ts: "2026-07-20T18:00:00.000Z" }),
    ],
    today: TODAY,
  });
  assert.equal(r.unresolvedDays.days[0].healthEntryId, "HE-FIRST", "first match by array order, never the last");
});

// ── resolved days: done/skipped/moved never appear in unresolvedDays, proven or not ────────────
test("computePlanReconciliation: a proven day already marked 'done' counts in outcomes.done, not in unresolvedDays", () => {
  const r = computePlanReconciliation({
    payload: { days: [{ date: "2026-07-20", type: "endurance", sport: "running", status: "done" }] },
    healthEntries: [workout({ ts: "2026-07-20T18:00:00.000Z" })],
    today: TODAY,
  });
  assert.equal(r.outcomes.done, 1);
  assert.equal(r.outcomes.planned, 0);
  assert.equal(r.unresolvedDays.count, 0, "already resolved — proof or not, it is not 'unresolved'");
});

test("computePlanReconciliation: skipped/moved past days are resolved WITHOUT proof (no health entries at all)", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: "2026-07-20", type: "endurance", sport: "running", status: "skipped" },
        { date: "2026-07-21", type: "strength", sport: "strength", status: "moved", movedTo: "2026-07-28" },
      ],
    },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.outcomes.skipped, 1);
  assert.equal(r.outcomes.moved, 1);
  assert.equal(r.unresolvedDays.count, 0, "resolved statuses never need proof to leave the unresolved set");
});

// ── sessionDays / outcomes arithmetic — every session day accounted for exactly once ────────────
test("computePlanReconciliation: sessionDays equals the sum of every outcomes bucket", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: "2026-07-19", type: "endurance", sport: "running", status: "done" },
        { date: "2026-07-20", type: "endurance", sport: "cycling", status: "skipped" },
        { date: "2026-07-21", type: "strength", sport: "strength", status: "moved", movedTo: "2026-07-28" },
        { date: "2026-07-22", type: "tempo", sport: "running" }, // planned (absent)
        { date: "2026-07-23", type: "rest", sport: "rest" }, // outside the universe
      ],
    },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.sessionDays, 4, "the rest day is excluded from the universe entirely");
  assert.equal(
    r.outcomes.done + r.outcomes.skipped + r.outcomes.moved + r.outcomes.planned,
    r.sessionDays,
    "every session day is counted in exactly one outcomes bucket",
  );
});

// ── calendarCoverage (cos-ops#66): the calendar-push receipt over the SAME deny-list universe ──
test("computePlanReconciliation: calendarCoverage counts receipts over the deny-list universe only", () => {
  const r = computePlanReconciliation({
    payload: {
      days: [
        { date: "2026-07-20", type: "endurance", sport: "running", eventId: "EVT-1" }, // receipted, planned
        { date: "2026-07-21", type: "strength", sport: "strength" }, // planned, no receipt — missing
        { date: "2026-07-22", type: "tempo", sport: "running", status: "done" }, // resolved, no receipt — neither bucket
        { date: "2026-07-23", type: "rest", sport: "rest", eventId: "EVT-STRAY" }, // rest day — outside the universe entirely
      ],
    },
    healthEntries: [],
    today: TODAY,
  });
  assert.deepEqual(
    r.calendarCoverage,
    { sessionDays: 3, withEventId: 1, missing: { count: 1, dates: ["2026-07-21"] } },
    "the rest day's stray eventId never counts — same deny-list scope as sessionDays",
  );
});

test("computePlanReconciliation: calendarCoverage.missing includes a FUTURE planned day too — unlike unresolvedDays", () => {
  const r = computePlanReconciliation({
    payload: { days: [{ date: TODAY, type: "endurance", sport: "running" }] }, // today, planned, no receipt
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(r.unresolvedDays.count, 0, "today's own session is not yet unresolved");
  assert.equal(r.calendarCoverage.missing.count, 1, "but it IS missing a calendar receipt — coverage is not date-bounded");
});

test("computePlanReconciliation: calendarCoverage recomputes when a fixture's eventId is added/removed — pure, no store", () => {
  const base = { date: "2026-07-20", type: "endurance", sport: "running" };

  const withReceipt = computePlanReconciliation({
    payload: { days: [{ ...base, eventId: "EVT-1" }] },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(withReceipt.calendarCoverage.withEventId, 1);
  assert.equal(withReceipt.calendarCoverage.missing.count, 0);

  const withoutReceipt = computePlanReconciliation({
    payload: { days: [base] },
    healthEntries: [],
    today: TODAY,
  });
  assert.equal(withoutReceipt.calendarCoverage.withEventId, 0, "removing the receipt drops withEventId");
  assert.equal(withoutReceipt.calendarCoverage.missing.count, 1, "and the day now counts as missing");
  assert.deepEqual(withoutReceipt.calendarCoverage.missing.dates, ["2026-07-20"]);
});

test("effectivePlanDayStatus: the ONE reader — valid is itself, anything else is 'planned'", () => {
  assert.equal(effectivePlanDayStatus({ status: "done" }), "done");
  assert.equal(effectivePlanDayStatus({ status: "moved" }), "moved");
  assert.equal(effectivePlanDayStatus({}), "planned");
  assert.equal(effectivePlanDayStatus({ status: null }), "planned");
  assert.equal(effectivePlanDayStatus({ status: "Done" }), "planned", "a stray capitalised value is not a resolution");
  assert.equal(effectivePlanDayStatus({ status: "" }), "planned");
});
