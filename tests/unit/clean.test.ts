// Unit tests for cleanCases (the "Clean Done" storage-reclaiming store verb): a
// bulk HARD delete of cases that ALSO purges their linked emails. It is the sole
// permanent-removal primitive — reused by the lazy retention sweep — so an email
// is only purged when nothing surviving (a reminder, or another case) still needs
// it. Pure / in-memory: cleanCases takes a DBShape and mutates it in place;
// nothing here reads or writes board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/clean.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCases, sweepExpiredTrash } from "../../board/lib/store.ts";
import { _resetRetentionCache } from "../../board/lib/retention.ts";
import type {
  DBShape,
  CaseRecord,
  MessageRecord,
  Reminder,
  CalendarEvent,
} from "../../board/lib/types.ts";

// ── In-memory fixture builders (no store reads) ───────────────────────────────
function caseRec(over: Partial<CaseRecord> & { id: string }): CaseRecord {
  return {
    title: `case ${over.id}`,
    summary: "",
    status: "done",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}
function msg(over: Partial<MessageRecord> & { id: string }): MessageRecord {
  return {
    source: "gmail",
    from: "someone@example.com",
    subject: `subject ${over.id}`,
    preview: "",
    body: "x".repeat(500), // body is the bulk we're reclaiming
    receivedAt: "2026-05-01T00:00:00.000Z",
    read: true,
    ...over,
  };
}
function reminder(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    title: `reminder ${over.id}`,
    status: "open",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}
function evt(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: `event ${over.id}`,
    date: "2026-05-01",
    allDay: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}
function db(over: Partial<DBShape> = {}): DBShape {
  return {
    schemaVersion: 6,
    version: 1,
    cases: [],
    messages: [],
    events: [],
    reminders: [],
    ...over,
  };
}

// ── The headline contract: delete the case AND its email ──────────────────────
test("cleanCases — removes the case AND purges its linked email (both link directions)", () => {
  const d = db({
    cases: [
      caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1", "M-2"] }),
      caseRec({ id: "CASE-2", status: "todo", messageIds: ["M-3"] }),
    ],
    // M-1 is linked via the case.messageIds[] only; M-2 via BOTH; M-3 belongs to a survivor.
    messages: [
      msg({ id: "M-1", caseId: "CASE-1" }),
      msg({ id: "M-2", caseId: "CASE-1" }),
      msg({ id: "M-3", caseId: "CASE-2" }),
    ],
  });

  const out = cleanCases(d, ["CASE-1"]);
  assert.equal(out.cases, 1, "one case removed");
  assert.equal(out.messages, 2, "both of CASE-1's emails purged");
  assert.deepEqual(d.cases.map((c) => c.id), ["CASE-2"], "CASE-1 is gone, CASE-2 survives");
  assert.deepEqual(d.messages.map((m) => m.id), ["M-3"], "CASE-1's emails are deleted; CASE-2's survives");
});

// ── cleanCases DELETES the email (storage reclaimed) ───────────────────────────
test("cleanCases — DELETES a removed case's email (no orphan kept-and-unlinked)", () => {
  const d = db({
    cases: [caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1"] })],
    messages: [msg({ id: "M-1", caseId: "CASE-1" })],
  });
  cleanCases(d, ["CASE-1"]);
  assert.equal(d.messages.length, 0, "cleanCases deletes the message (no orphan survives)");
});

// ── sweepExpiredTrash and cleanCases AGREE on email protection ─────────────────
// The retention sweep reuses cleanCases, so the same reminder/surviving-case
// protection applies whether removal is manual (clean) or automatic (sweep).
test("sweepExpiredTrash and cleanCases agree on which emails are protected", () => {
  const fixture = () =>
    db({
      cases: [
        caseRec({
          id: "CASE-1",
          status: "done",
          archivedAt: new Date(Date.now() - 99 * 86_400_000).toISOString(),
          messageIds: ["M-1", "M-2"],
        }),
      ],
      messages: [
        msg({ id: "M-1", caseId: "CASE-1" }), // case-only → purged
        msg({ id: "M-2", caseId: "CASE-1", reminderId: "REM-1" }), // reminder → kept
      ],
      reminders: [reminder({ id: "REM-1" })],
    });

  const dClean = fixture();
  cleanCases(dClean, ["CASE-1"]);

  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const dSweep = fixture();
  sweepExpiredTrash(dSweep);
  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();

  assert.deepEqual(
    dSweep.messages.map((m) => m.id),
    dClean.messages.map((m) => m.id),
    "sweep and clean keep the same emails (reminder-linked survives, case-only purged)",
  );
  assert.deepEqual(dSweep.messages.map((m) => m.id), ["M-2"]);
});

// ── Safety: an email also linked to a reminder is KEPT + unlinked, not deleted ──
test("cleanCases — keeps (and unlinks) an email still referenced by a reminder", () => {
  const d = db({
    cases: [caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1", "M-2"] })],
    messages: [
      msg({ id: "M-1", caseId: "CASE-1" }), // case-only → purged
      msg({ id: "M-2", caseId: "CASE-1", reminderId: "REM-1" }), // also a reminder → kept
    ],
    reminders: [reminder({ id: "REM-1" })],
  });

  const out = cleanCases(d, ["CASE-1"]);
  assert.equal(out.messages, 1, "only the case-only email is purged");
  assert.deepEqual(d.messages.map((m) => m.id), ["M-2"], "the reminder-linked email survives");
  assert.equal(d.messages[0].caseId, undefined, "the survivor's dangling caseId is cleared");
  assert.equal(d.messages[0].reminderId, "REM-1", "its reminder link is untouched");
});

// ── Events / reminders pointing at a cleaned case are KEPT but unlinked ─────────
test("cleanCases — unlinks (keeps) events and reminders that referenced the cleaned case", () => {
  const d = db({
    cases: [caseRec({ id: "CASE-1", status: "done" })],
    events: [evt({ id: "EVT-1", caseId: "CASE-1" }), evt({ id: "EVT-2", caseId: "CASE-9" })],
    reminders: [reminder({ id: "REM-1", caseId: "CASE-1" })],
  });

  cleanCases(d, ["CASE-1"]);
  assert.equal(d.events!.length, 2, "events survive the purge");
  assert.equal(d.events!.find((e) => e.id === "EVT-1")!.caseId, undefined, "EVT-1 unlinked from the cleaned case");
  assert.equal(d.events!.find((e) => e.id === "EVT-2")!.caseId, "CASE-9", "an unrelated event's link is untouched");
  assert.equal(d.reminders!.length, 1, "the reminder survives");
  assert.equal(d.reminders![0].caseId, undefined, "the reminder is unlinked from the cleaned case");
});

// ── A removed container detaches its children to top-level ─────────────────────
test("cleanCases — detaches children of a removed container (no dangling parentId)", () => {
  const d = db({
    cases: [
      caseRec({ id: "CASE-1", kind: "workstream", status: "done" }),
      caseRec({ id: "CASE-2", parentId: "CASE-1", status: "todo" }),
    ],
  });
  cleanCases(d, ["CASE-1"]);
  assert.deepEqual(d.cases.map((c) => c.id), ["CASE-2"], "the container is gone, the child survives");
  assert.equal(d.cases[0].parentId, undefined, "the orphaned child is detached to top-level");
});

// ── Conservative: an email a SURVIVING case still references is not deleted ─────
test("cleanCases — never deletes an email a surviving case still references", () => {
  const d = db({
    // Inconsistent fixture: CASE-1 (removed) lists M-1 in messageIds, but M-1's own
    // caseId points at the SURVIVING CASE-2. The purge must NOT delete M-1.
    cases: [
      caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1"] }),
      caseRec({ id: "CASE-2", status: "todo", messageIds: ["M-1"] }),
    ],
    messages: [msg({ id: "M-1", caseId: "CASE-2" })],
  });
  const out = cleanCases(d, ["CASE-1"]);
  assert.equal(out.messages, 0, "no email purged — a survivor still references M-1");
  assert.deepEqual(d.messages.map((m) => m.id), ["M-1"], "M-1 survives");
  assert.equal(d.messages[0].caseId, "CASE-2", "M-1 stays linked to the surviving case");
});

// ── Cleaning many at once, and the no-op cases ────────────────────────────────
test("cleanCases — purges several at once and reports accurate counts", () => {
  const d = db({
    cases: [
      caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1"] }),
      caseRec({ id: "CASE-2", status: "done", messageIds: ["M-2", "M-3"] }),
      caseRec({ id: "CASE-3", status: "todo" }),
    ],
    messages: [
      msg({ id: "M-1", caseId: "CASE-1" }),
      msg({ id: "M-2", caseId: "CASE-2" }),
      msg({ id: "M-3", caseId: "CASE-2" }),
    ],
  });
  const out = cleanCases(d, ["CASE-1", "CASE-2"]);
  assert.equal(out.cases, 2, "two cases removed");
  assert.equal(out.messages, 3, "all three of their emails purged");
  assert.deepEqual(d.cases.map((c) => c.id), ["CASE-3"]);
  assert.equal(d.messages.length, 0);
});

test("cleanCases — unknown ids are ignored (no-op, zero counts)", () => {
  const d = db({
    cases: [caseRec({ id: "CASE-1", status: "done", messageIds: ["M-1"] })],
    messages: [msg({ id: "M-1", caseId: "CASE-1" })],
  });
  const out = cleanCases(d, ["CASE-404", "nope"]);
  assert.deepEqual(out, { cases: 0, messages: 0 }, "no matching id → nothing changes");
  assert.equal(d.cases.length, 1, "the case is untouched");
  assert.equal(d.messages.length, 1, "the message is untouched");
});
