// Unit tests for the reminder selectors (v5): the pure projection layer over a flat
// Reminder[] (remindersByCaseId, openReminders, sortReminders, upcomingReminders). A
// reminder is a lightweight nudge that may OPTIONALLY link to ONE board node via
// `caseId` (the node<->reminder link source of truth). Pure / in-memory — nothing
// reads board/data; every time-relative helper takes a FIXED `now` so the suite is
// deterministic. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/reminders.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  remindersByCaseId,
  messagesByReminderId,
  openReminders,
  sortReminders,
  upcomingReminders,
} from "../../board/lib/selectors.ts";
import type { Reminder, MessageRecord } from "../../board/lib/types.ts";

// In-memory fixture builder (no store reads). Defaults make an open, unlinked,
// no-dueAt nudge; `over` pins the fields a given test cares about. `createdAt`
// increments per call so the stable createdAt tiebreak in sortReminders is testable.
let seq = 0;
function rem(over: Partial<Reminder> = {}): Reminder {
  seq += 1;
  return {
    id: `REM-${seq}`,
    title: `reminder ${seq}`,
    status: "open",
    createdAt: `2026-05-01T00:00:0${seq % 10}.000Z`,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// ── remindersByCaseId ─────────────────────────────────────────────────────────
test("remindersByCaseId — filters by caseId (the node<->reminder link source of truth)", () => {
  const reminders = [
    rem({ id: "REM-1", caseId: "CASE-1" }),
    rem({ id: "REM-2", caseId: "CASE-2" }),
    rem({ id: "REM-3", caseId: "CASE-1" }),
    rem({ id: "REM-4" }), // unlinked → excluded from any caseId match
  ];
  assert.deepEqual(
    remindersByCaseId(reminders, "CASE-1").map((r) => r.id),
    ["REM-1", "REM-3"],
  );
  assert.deepEqual(remindersByCaseId(reminders, "CASE-2").map((r) => r.id), ["REM-2"]);
  assert.deepEqual(remindersByCaseId(reminders, "CASE-404"), []); // none linked
});

// ── messagesByReminderId ──────────────────────────────────────────────────────
// In-memory MessageRecord builder. reminderId is the single source of truth for the
// reminder<->email link (no messageIds[] on the reminder); a message may also carry a
// caseId — the two links are independent, so we set both on one fixture to prove the
// selector keys ONLY on reminderId.
let mseq = 0;
function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  mseq += 1;
  return {
    id: `M-${mseq}`,
    source: "gmail",
    from: `sender${mseq}@example.com`,
    subject: `subject ${mseq}`,
    preview: `preview ${mseq}`,
    body: `body ${mseq}`,
    receivedAt: `2026-05-01T00:00:0${mseq % 10}.000Z`,
    read: false,
    ...over,
  };
}

test("messagesByReminderId — filters by reminderId (the reminder<->email link source of truth)", () => {
  const messages = [
    msg({ id: "M-1", reminderId: "REM-1" }),
    msg({ id: "M-2", reminderId: "REM-2" }),
    // links to BOTH a case and a reminder — the two links are independent, so this
    // still matches REM-1 on reminderId regardless of its caseId.
    msg({ id: "M-3", reminderId: "REM-1", caseId: "CASE-9" }),
    msg({ id: "M-4", caseId: "CASE-9" }), // case-only, no reminderId → excluded
    msg({ id: "M-5" }), // unlinked → excluded
  ];
  assert.deepEqual(
    messagesByReminderId(messages, "REM-1").map((m) => m.id),
    ["M-1", "M-3"],
  );
  assert.deepEqual(messagesByReminderId(messages, "REM-2").map((m) => m.id), ["M-2"]);
  assert.deepEqual(messagesByReminderId(messages, "REM-404"), []); // none linked
});

// ── openReminders ─────────────────────────────────────────────────────────────
test("openReminders — returns only status === 'open' (done/dismissed excluded)", () => {
  const reminders = [
    rem({ id: "REM-OPEN", status: "open" }),
    rem({ id: "REM-DONE", status: "done", completedAt: "2026-05-02T00:00:00.000Z" }),
    rem({ id: "REM-DISMISSED", status: "dismissed" }),
    rem({ id: "REM-OPEN2", status: "open" }),
  ];
  assert.deepEqual(openReminders(reminders).map((r) => r.id), ["REM-OPEN", "REM-OPEN2"]);
});

// ── sortReminders ─────────────────────────────────────────────────────────────
test("sortReminders — open before done before dismissed, then dueAt (no-due last), then createdAt", () => {
  const reminders = [
    // dismissed sorts last regardless of an early dueAt
    rem({ id: "REM-DISMISSED", status: "dismissed", dueAt: "2026-06-01", createdAt: "2026-05-01T00:00:00.000Z" }),
    // done sorts between open and dismissed
    rem({ id: "REM-DONE", status: "done", dueAt: "2026-06-01", createdAt: "2026-05-01T00:00:00.000Z" }),
    // open, no dueAt → after open-with-dueAt
    rem({ id: "REM-OPEN-NODUE", status: "open", createdAt: "2026-05-01T00:00:00.000Z" }),
    // open, later dueAt
    rem({ id: "REM-OPEN-LATE", status: "open", dueAt: "2026-06-10", createdAt: "2026-05-01T00:00:00.000Z" }),
    // open, earliest dueAt → first overall
    rem({ id: "REM-OPEN-EARLY", status: "open", dueAt: "2026-06-02", createdAt: "2026-05-01T00:00:00.000Z" }),
  ];
  const out = sortReminders(reminders).map((r) => r.id);
  assert.deepEqual(out, [
    "REM-OPEN-EARLY", // open + earliest dueAt
    "REM-OPEN-LATE", // open + later dueAt
    "REM-OPEN-NODUE", // open + no dueAt sorts after open-with-dueAt
    "REM-DONE", // done
    "REM-DISMISSED", // dismissed last
  ]);
});

test("sortReminders — equal status + equal dueAt fall back to createdAt ascending (stable tiebreak)", () => {
  const reminders = [
    rem({ id: "REM-B", status: "open", dueAt: "2026-06-05", createdAt: "2026-05-02T00:00:00.000Z" }),
    rem({ id: "REM-A", status: "open", dueAt: "2026-06-05", createdAt: "2026-05-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortReminders(reminders).map((r) => r.id), ["REM-A", "REM-B"]);
});

// ── upcomingReminders ─────────────────────────────────────────────────────────
test("upcomingReminders — windows OPEN dueAt reminders in [today, today+daysAhead] with a FIXED now", () => {
  // Fixed now = 2026-06-10 (UTC). A 7-day window covers 2026-06-10 .. 2026-06-17.
  const now = new Date("2026-06-10T12:00:00.000Z");
  const reminders = [
    rem({ id: "REM-PAST", status: "open", dueAt: "2026-06-09" }), // yesterday → excluded
    rem({ id: "REM-TODAY", status: "open", dueAt: "2026-06-10" }), // today → included (near edge)
    rem({ id: "REM-MID", status: "open", dueAt: "2026-06-14" }),
    rem({ id: "REM-EDGE", status: "open", dueAt: "2026-06-17" }), // today+7 → included (far edge)
    rem({ id: "REM-FAR", status: "open", dueAt: "2026-06-18" }), // day 8 → excluded
    rem({ id: "REM-NODUE", status: "open" }), // no dueAt → excluded
    rem({ id: "REM-DONE", status: "done", dueAt: "2026-06-12", completedAt: "2026-06-11T00:00:00.000Z" }), // not open → excluded
    rem({ id: "REM-DISMISSED", status: "dismissed", dueAt: "2026-06-13" }), // not open → excluded
  ];
  const out = upcomingReminders(reminders, 7, now);
  // Only open, in-window, with a dueAt — sorted ascending by dueAt.
  assert.deepEqual(out.map((r) => r.id), ["REM-TODAY", "REM-MID", "REM-EDGE"]);
});

test("upcomingReminders — daysAhead 0 is just today; the past + no-due are excluded", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");
  const reminders = [
    rem({ id: "REM-Y", status: "open", dueAt: "2026-06-09" }),
    rem({ id: "REM-T", status: "open", dueAt: "2026-06-10" }),
    rem({ id: "REM-TM", status: "open", dueAt: "2026-06-11" }),
    rem({ id: "REM-NODUE", status: "open" }),
  ];
  assert.deepEqual(upcomingReminders(reminders, 0, now).map((r) => r.id), ["REM-T"]);
});
