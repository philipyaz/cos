// Unit tests for the starving-obligations aging rank
// (board/lib/selectors.ts:starvingObligations) — cos-ops#24. Pure, clock-injected, no I/O, so it
// runs headless under `node --test`. Lives OUTSIDE tests/unit/ (the issue pins this exact path)
// but uses the SAME zero-dep TS resolve hook tests/unit/*.test.ts does, so the run command differs
// only in the file list:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     --import ./tests/unit/ts-resolve.mjs --test tests/board-starving-obligations.mjs
//
// NOW is a fixed reference instant; every "days idle/overdue" figure below is computed relative to
// it via the iso()/dayOffset() helpers, so the suite is deterministic regardless of wall clock.
//
// Covers: (a) aging beats static priority — the issue's own named test (CASE-8's shape outranking
// a freshly-touched P1); (b) a no-dueAt case still ranks via stale-idle; (c) allocation — a linked
// TIMED event within the bounded 7-day horizon suppresses the case entirely, an ALL-DAY one never
// does, the horizon's day-granular boundary (today / +7 in / +8 out), and the CASE-7 far-future
// recurring-series shape that must NOT be muted for months; (d) a passed-unactioned block escalates
// the score, and a later touch clears it; (e) all-day never allocates OR escalates, past or future;
// reminders (past/future/no dueAt, done/dismissed/archived); messages (unanswered/answered/fresh);
// visibility exclusions (archived/done/snoozed); and full-output determinism.

import { test } from "node:test";
import assert from "node:assert/strict";

import { starvingObligations, todayISO } from "../board/lib/selectors.ts";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const DAY = 86_400_000;
const TODAY = todayISO(NOW);

// ISO timestamp `days` whole days offset from NOW (negative = past). Drives daysIdle/daysOverdue.
function iso(days) {
  return new Date(NOW.getTime() + days * DAY).toISOString();
}

// A "YYYY-MM-DD" calendar day `n` whole days offset from `dayISO`, UTC-anchored the same way
// starvingObligations itself computes its allocation horizon — so a fixture's event date and the
// selector's own day math can never drift apart.
function dayOffset(dayISO, n) {
  const [y, m, d] = dayISO.split("-").map((s) => parseInt(s, 10));
  return todayISO(new Date(Date.UTC(y, m - 1, d + n)));
}

let caseSeq = 0;
function mkCase(over = {}) {
  caseSeq += 1;
  return {
    id: over.id ?? `CASE-${caseSeq}`,
    title: over.title ?? `case ${caseSeq}`,
    summary: over.summary ?? "",
    status: over.status ?? "in_progress",
    domain: over.domain ?? "work",
    tasks: over.tasks ?? [],
    messageIds: over.messageIds ?? [],
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

let eventSeq = 0;
function mkEvent(over = {}) {
  eventSeq += 1;
  return {
    id: over.id ?? `EVT-${eventSeq}`,
    title: over.title ?? `event ${eventSeq}`,
    date: over.date ?? TODAY,
    allDay: over.allDay ?? false,
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

let remSeq = 0;
function mkReminder(over = {}) {
  remSeq += 1;
  return {
    id: over.id ?? `REM-${remSeq}`,
    title: over.title ?? `reminder ${remSeq}`,
    status: over.status ?? "open",
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

let msgSeq = 0;
function mkMessage(over = {}) {
  msgSeq += 1;
  return {
    id: over.id ?? `M-${msgSeq}`,
    source: over.source ?? "gmail",
    from: over.from ?? `sender${msgSeq}@example.com`,
    subject: over.subject ?? `subject ${msgSeq}`,
    preview: over.preview ?? "",
    body: over.body ?? "",
    receivedAt: over.receivedAt ?? "2026-05-01T00:00:00.000Z",
    read: over.read ?? false,
    ...over,
  };
}

let taskSeq = 0;
function mkTask(over = {}) {
  taskSeq += 1;
  return {
    id: over.id ?? `T-${taskSeq}`,
    title: over.title ?? `task ${taskSeq}`,
    status: over.status ?? "open",
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

const EMPTY = { cases: [], events: [], reminders: [], messages: [] };
const ids = (out) => out.map((o) => o.id);

// ── (a) aging beats static priority ─────────────────────────────────────────
test("(a) aging beats static priority — CASE-8's shape outranks a freshly-touched P1", () => {
  const starved = mkCase({ priority: "P2", dueAt: iso(-63), updatedAt: iso(-45) });
  const fresh = mkCase({ priority: "P1", dueAt: iso(-1), updatedAt: iso(-1) });

  const out = starvingObligations({ ...EMPTY, cases: [starved, fresh] }, NOW);

  const s = out.find((o) => o.id === starved.id);
  const f = out.find((o) => o.id === fresh.id);
  assert.ok(s, "the starved P2 case is a member");
  assert.equal(s.daysIdle, 45);
  assert.equal(s.daysOverdue, 63);
  assert.equal(s.score, 171);
  assert.ok(f, "the fresh P1 case is a member too (overdue by exactly one day — non-vacuous)");
  assert.equal(f.score, 3);
  assert.deepEqual(ids(out), [starved.id, fresh.id], "the starved P2 ranks ABOVE the fresh P1");
});

// ── (b) no dueAt, long idle, still ranked ───────────────────────────────────
test("(b) a case with no dueAt but long idle time still ranks, via stale-idle", () => {
  const c = mkCase({ priority: "P1", tasks: [mkTask()], updatedAt: iso(-40) });

  const out = starvingObligations({ ...EMPTY, cases: [c] }, NOW);

  const entry = out.find((o) => o.id === c.id);
  assert.ok(entry, "present — no dueAt, no untriaged (in_progress + a task + a priority), stale-idle only");
  assert.equal(entry.daysOverdue, 0);
  assert.equal(entry.daysIdle, 40);
  assert.equal(entry.score, 40);
});

// ── (c) allocation — skip, boundary, and the bounded horizon ────────────────
test("(b2) untriaged raw intake filed just now is NOT starving; the same card untouched a day later is", () => {
  const fresh = mkCase({ status: "todo", tasks: [], priority: undefined, createdAt: iso(0), updatedAt: iso(0) });
  const dayOld = mkCase({ status: "todo", tasks: [], priority: undefined, createdAt: iso(-2), updatedAt: iso(-2) });
  const out = starvingObligations({ ...EMPTY, cases: [fresh, dayOld] }, NOW);
  assert.equal(out.find((e) => e.id === fresh.id), undefined, "a card the sweep filed this morning is not starving (score 0 would only swamp the tail)");
  const entry = out.find((e) => e.id === dayOld.id);
  assert.ok(entry, "the same shape idle for two days IS a member (untriaged + idle)");
  assert.equal(entry.score, 2, "scored by its idle days");
});

test("(c) a linked TIMED event tomorrow suppresses the case entirely (already-allocated)", () => {
  const c = mkCase({ priority: "P1", tasks: [mkTask()], updatedAt: iso(-40) });
  const e = mkEvent({ caseId: c.id, date: dayOffset(TODAY, 1), startTime: "18:30", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [e] }, NOW);

  assert.ok(!out.some((o) => o.id === c.id));
});

test("(c) a timed event dated TODAY suppresses — day-granular, not HH:MM (an earlier-today block still counts)", () => {
  const c = mkCase({ updatedAt: iso(-40) });
  const e = mkEvent({ caseId: c.id, date: TODAY, startTime: "09:00", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [e] }, NOW);

  assert.ok(!out.some((o) => o.id === c.id));
});

test("(c) allocation horizon boundary IN: a timed event exactly 7 days out suppresses", () => {
  const c = mkCase({ updatedAt: iso(-40) });
  const e = mkEvent({ caseId: c.id, date: dayOffset(TODAY, 7), startTime: "09:00", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [e] }, NOW);

  assert.ok(!out.some((o) => o.id === c.id));
});

test("(c) allocation horizon boundary OUT: a timed event 8 days out does NOT suppress", () => {
  const c = mkCase({ updatedAt: iso(-40) });
  const e = mkEvent({ caseId: c.id, date: dayOffset(TODAY, 8), startTime: "09:00", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [e] }, NOW);

  assert.ok(out.some((o) => o.id === c.id));
});

test("(c) the CASE-7 shape: a far-future recurring series (14d, 28d out) does NOT mute an idle case", () => {
  const c = mkCase({ updatedAt: iso(-20) });
  const ev14 = mkEvent({ caseId: c.id, date: dayOffset(TODAY, 14), startTime: "12:00", allDay: false });
  const ev28 = mkEvent({ caseId: c.id, date: dayOffset(TODAY, 28), startTime: "12:00", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [ev14, ev28] }, NOW);

  const entry = out.find((o) => o.id === c.id);
  assert.ok(entry, "still ranked — an unbounded rule would mute this case for two months");
  assert.equal(entry.score, 20);
});

// ── (d) passed-unactioned block escalates ───────────────────────────────────
test("(d) a passed-unactioned block escalates the score and outranks its no-event twin", () => {
  const pastDay = dayOffset(TODAY, -6);
  const a = mkCase({ updatedAt: iso(-10) });
  const evA = mkEvent({ caseId: a.id, date: pastDay, startTime: "10:30", allDay: false });
  const b = mkCase({ updatedAt: iso(-10) }); // twin: identical, minus the event

  const out = starvingObligations({ ...EMPTY, cases: [a, b], events: [evA] }, NOW);

  const entryA = out.find((o) => o.id === a.id);
  const entryB = out.find((o) => o.id === b.id);
  assert.ok(entryA.passedBlock, "A carries a passedBlock");
  assert.equal(entryA.passedBlock.date, pastDay);
  assert.equal(entryA.passedBlock.daysSincePassed, 6);
  assert.equal(entryA.score, 10 + 0 + 18);
  assert.equal(entryA.score, 28);
  assert.ok(!entryB.passedBlock, "B (no event) carries no passedBlock");
  assert.equal(entryB.score, 10);
  assert.ok(ids(out).indexOf(a.id) < ids(out).indexOf(b.id), "A ranks above B");
});

test("(d) touched AFTER the block's day clears the escalation (counter-case C)", () => {
  const pastDay = dayOffset(TODAY, -6);
  const c = mkCase({ updatedAt: iso(-4) }); // touched 4d ago — after the block passed 6d ago
  const evC = mkEvent({ caseId: c.id, date: pastDay, startTime: "09:00", allDay: false });

  const out = starvingObligations({ ...EMPTY, cases: [c], events: [evC] }, NOW);

  const entry = out.find((o) => o.id === c.id);
  assert.ok(entry, "present via stale-idle (4d > STALE_AFTER_DAYS)");
  assert.ok(!entry.passedBlock, "no passedBlock — the case was touched after the block's day ended");
  assert.equal(entry.score, 4);
});

// ── (e) all-day never counts, past or future ────────────────────────────────
test("(e) an all-day PAST event never counts as a passed block (the EVT-1/EVT-2 shape)", () => {
  const d = mkCase({ priority: "P2", dueAt: iso(-63), updatedAt: iso(-55) });
  const evD = mkEvent({ caseId: d.id, date: dayOffset(TODAY, -60), allDay: true });

  const out = starvingObligations({ ...EMPTY, cases: [d], events: [evD] }, NOW);

  const entry = out.find((o) => o.id === d.id);
  assert.ok(entry, "present — the all-day event never allocates");
  assert.ok(!entry.passedBlock, "an all-day event is a deadline marker, never a passed chase block");
  assert.equal(entry.daysIdle, 55);
  assert.equal(entry.daysOverdue, 63);
  assert.equal(entry.score, 55 + 126);
  assert.equal(entry.score, 181);
});

test("(e) an all-day FUTURE event never allocates — E ranks identically to its no-event twin", () => {
  const e = mkCase({ updatedAt: iso(-20) });
  const evE = mkEvent({ caseId: e.id, date: dayOffset(TODAY, 3), allDay: true });
  const twin = mkCase({ updatedAt: iso(-20) });

  const out = starvingObligations({ ...EMPTY, cases: [e, twin], events: [evE] }, NOW);

  const entryE = out.find((o) => o.id === e.id);
  const entryTwin = out.find((o) => o.id === twin.id);
  assert.ok(entryE, "a future deadline marker is not an allocation");
  assert.equal(entryE.score, entryTwin.score);
});

// ── Reminders ────────────────────────────────────────────────────────────────
test("reminder: open + a PAST parseable dueAt is a member, aged by daysOverdue", () => {
  const r = mkReminder({ dueAt: iso(-5) });

  const out = starvingObligations({ ...EMPTY, reminders: [r] }, NOW);

  const entry = out.find((o) => o.id === r.id);
  assert.ok(entry);
  assert.equal(entry.kind, "reminder");
  assert.equal(entry.daysOverdue, 5);
});

test("reminder: open + a FUTURE parseable dueAt is excluded — already time-anchored", () => {
  const r = mkReminder({ dueAt: iso(3) });

  const out = starvingObligations({ ...EMPTY, reminders: [r] }, NOW);

  assert.ok(!out.some((o) => o.id === r.id));
});

test("reminder: open + no dueAt, idle past the shared threshold → member, score = daysIdle", () => {
  const r = mkReminder({ updatedAt: iso(-10) });

  const out = starvingObligations({ ...EMPTY, reminders: [r] }, NOW);

  const entry = out.find((o) => o.id === r.id);
  assert.ok(entry);
  assert.equal(entry.daysOverdue, 0);
  assert.equal(entry.score, 10);
});

test("reminder: done, dismissed, and archived are all excluded", () => {
  const done = mkReminder({ status: "done", updatedAt: iso(-30) });
  const dismissed = mkReminder({ status: "dismissed", updatedAt: iso(-30) });
  const archived = mkReminder({ status: "open", archivedAt: iso(-1), updatedAt: iso(-30) });

  const out = starvingObligations({ ...EMPTY, reminders: [done, dismissed, archived] }, NOW);

  assert.equal(out.length, 0);
});

// ── Messages ─────────────────────────────────────────────────────────────────
test("message: unanswered + idle past the shared threshold → member, score = daysIdle", () => {
  const m = mkMessage({ needsAnswer: true, receivedAt: iso(-12) });

  const out = starvingObligations({ ...EMPTY, messages: [m] }, NOW);

  const entry = out.find((o) => o.id === m.id);
  assert.ok(entry);
  assert.equal(entry.kind, "message");
  assert.equal(entry.title, m.subject);
  assert.equal(entry.from, m.from);
  assert.equal(entry.daysOverdue, 0);
  assert.equal(entry.score, 12);
});

test("message: answered is excluded even though it was idle", () => {
  const m = mkMessage({ needsAnswer: true, answeredAt: iso(-1), receivedAt: iso(-12) });

  const out = starvingObligations({ ...EMPTY, messages: [m] }, NOW);

  assert.ok(!out.some((o) => o.id === m.id));
});

test("message: unanswered but under the shared idle threshold is excluded (an hour isn't starving)", () => {
  const m = mkMessage({ needsAnswer: true, receivedAt: iso(-1) });

  const out = starvingObligations({ ...EMPTY, messages: [m] }, NOW);

  assert.ok(!out.some((o) => o.id === m.id));
});

// ── Exclusions ───────────────────────────────────────────────────────────────
test("exclusions: archived, done, and future-snoozed cases are all absent", () => {
  const archived = mkCase({ updatedAt: iso(-20), archivedAt: iso(-1) });
  const done = mkCase({ status: "done", updatedAt: iso(-20) });
  const snoozed = mkCase({ updatedAt: iso(-20), snoozeUntil: iso(5) });

  const out = starvingObligations({ ...EMPTY, cases: [archived, done, snoozed] }, NOW);

  assert.equal(out.length, 0);
});

// ── Determinism ──────────────────────────────────────────────────────────────
test("determinism: equal scores tie-break by priority (P0 first); identical input -> identical output", () => {
  const p3 = mkCase({ priority: "P3", updatedAt: iso(-10) });
  const p0 = mkCase({ priority: "P0", updatedAt: iso(-10) });
  const noPriority = mkCase({ updatedAt: iso(-10) });
  const r = mkReminder({ updatedAt: iso(-20) });
  const m = mkMessage({ needsAnswer: true, receivedAt: iso(-20) });

  const db = { cases: [p3, p0, noPriority], events: [], reminders: [r], messages: [m] };
  const out1 = starvingObligations(db, NOW);
  const out2 = starvingObligations(db, NOW);

  assert.deepEqual(out1, out2, "the same input produces the identical order, twice");

  const tieIds = [p3.id, p0.id, noPriority.id];
  const tie = out1.filter((o) => tieIds.includes(o.id));
  assert.equal(tie[0].score, tie[1].score, "the three equal-idle cases share a score");
  assert.equal(tie[1].score, tie[2].score);
  assert.deepEqual(
    tie.map((o) => o.id),
    [p0.id, p3.id, noPriority.id],
    "P0 ranks first, then P3, then no-priority",
  );
});
