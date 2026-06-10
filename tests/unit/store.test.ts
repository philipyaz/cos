// Unit tests for the helpers in board/lib/store.ts.
//
// Scope: primarily the in-memory, side-effect-free functions (migrate, id
// minting, patch appliers, activity/notes, archive/restore) — every such
// fixture is a plain object literal. A final disk-path section additionally
// exercises the disk-touching functions (readDB/mutate and .bak recovery)
// against an ISOLATED throwaway COS_DATA_DIR (os.mkdtemp) — the real
// board/data file is never read or written.
//
// Determinism note: the store's mutators stamp timestamps via an internal
// nowISO() (Date.now) that is NOT injectable. So instead of pinning the clock
// we (a) capture a tight wall-clock window around each call and assert the
// stamp lands inside it, and (b) assert stamps are valid round-trippable ISO
// strings. A fixed reference instant is used where we compare relative ordering.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migrate,
  nextCaseId,
  nextMessageId,
  nextTaskId,
  nextNoteId,
  nextEventId,
  nextReminderId,
  nextPriorityId,
  nextReminderTaskId,
  findCase,
  findTask,
  findEvent,
  findReminder,
  findPriority,
  appendTask,
  applyCaseUpdate,
  applyTaskUpdate,
  applyEventUpdate,
  logActivity,
  addNote,
  archiveCase,
  restoreCase,
  sweepExpiredTrash,
  sweepExpiredReminders,
  applyReminderUpdate,
  deleteTask,
  removeEvent,
  removeReminder,
  removePriority,
  messagesForReminder,
} from "../../board/lib/store.ts";
import { _resetRetentionCache } from "../../board/lib/retention.ts";
import { SCHEMA_VERSION } from "../../board/lib/types.ts";
import type {
  CaseRecord,
  CalendarEvent,
  DBShape,
  MessageRecord,
  PriorityNote,
  Reminder,
  Task,
} from "../../board/lib/types.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────
// Small literal factories so each test starts from a clean, isolated object.

const ISO = "2026-05-31T12:00:00.000Z"; // fixed reference instant for fixtures

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "CASE-1-T1",
    title: "task",
    status: "open",
    createdAt: ISO,
    ...over,
  };
}

function makeCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: "CASE-1",
    title: "Case one",
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

function makeMessage(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "M-1",
    source: "gmail",
    from: "a@b.c",
    subject: "s",
    preview: "p",
    body: "b",
    receivedAt: ISO,
    read: false,
    ...over,
  };
}

function makeReminder(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    title: "Reminder",
    status: "open",
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

function makeEvent(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: "Event",
    date: "2026-06-01",
    allDay: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

function makePriority(over: Partial<PriorityNote> & { id: string }): PriorityNote {
  return {
    text: "Priority",
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

function makeDB(over: Partial<DBShape> = {}): DBShape {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    cases: [],
    messages: [],
    ...over,
  };
}

// Assert `s` is a valid ISO string that round-trips and is "recent" relative to
// a captured pre-call instant — replaces injecting a fixed clock for the
// internal nowISO() calls (which are not parameterised).
function assertRecentISO(s: unknown, notBefore: number): void {
  assert.equal(typeof s, "string");
  const t = Date.parse(s as string);
  assert.ok(Number.isFinite(t), `expected ISO-parseable string, got ${s}`);
  assert.ok(t >= notBefore - 1000, `stamp ${s} is older than the call window`);
  assert.ok(t <= Date.now() + 1000, `stamp ${s} is in the future`);
  // round-trips through Date → same instant
  assert.equal(new Date(s as string).toISOString(), s);
}

// ── migrate ────────────────────────────────────────────────────────────────
test("migrate: empty / garbage / nullish input → canonical empty shape", () => {
  for (const garbage of [undefined, null, 42, "nope", true, [], () => {}]) {
    const db = migrate(garbage as unknown);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    assert.equal(db.version, 0, "missing version defaults to 0");
    assert.deepEqual(db.cases, []);
    assert.deepEqual(db.messages, []);
    // additive optional collections stay ABSENT on a fresh/old file
    assert.equal(db.pending, undefined);
    assert.equal(db.views, undefined);
    assert.equal(db.settings, undefined);
  }
});

test("migrate: an array input is treated as an object → no cases harvested", () => {
  // Array is typeof 'object' so it passes the guard, but obj.cases is undefined.
  const db = migrate([{ id: "CASE-9" }] as unknown);
  assert.deepEqual(db.cases, []);
});

test("migrate: keeps an explicit numeric version, ignores non-numeric", () => {
  assert.equal(migrate({ version: 7 }).version, 7);
  assert.equal(migrate({ version: "7" }).version, 0, "string version → default 0");
  assert.equal(migrate({ version: null }).version, 0);
});

test("migrate: missing domain defaults to 'work'; invalid domain coerced to 'work'", () => {
  const db = migrate({
    cases: [
      { id: "CASE-1", status: "todo" }, // no domain
      { id: "CASE-2", status: "todo", domain: "life" }, // valid kept
      { id: "CASE-3", status: "todo", domain: "bogus" }, // invalid coerced
    ],
  });
  assert.equal(db.cases[0].domain, "work");
  assert.equal(db.cases[1].domain, "life");
  assert.equal(db.cases[2].domain, "work");
});

test("migrate: missing tasks/messageIds become empty arrays; existing kept", () => {
  const db = migrate({
    cases: [
      { id: "CASE-1", status: "todo" },
      {
        id: "CASE-2",
        status: "todo",
        tasks: [{ id: "CASE-2-T1", title: "x", status: "open", createdAt: ISO }],
        messageIds: ["M-1"],
      },
      { id: "CASE-3", status: "todo", tasks: "not-array", messageIds: 99 },
    ],
  });
  assert.deepEqual(db.cases[0].tasks, []);
  assert.deepEqual(db.cases[0].messageIds, []);
  assert.equal(db.cases[1].tasks.length, 1);
  assert.deepEqual(db.cases[1].messageIds, ["M-1"]);
  assert.deepEqual(db.cases[2].tasks, [], "non-array tasks → []");
  assert.deepEqual(db.cases[2].messageIds, [], "non-array messageIds → []");
});

test("migrate: messages default to [] when absent or non-array", () => {
  assert.deepEqual(migrate({}).messages, []);
  assert.deepEqual(migrate({ messages: "nope" }).messages, []);
  const msgs = [{ id: "M-1" }];
  assert.deepEqual(migrate({ messages: msgs }).messages, msgs);
});

test("migrate: pending/views carried ONLY when present and array-shaped", () => {
  const withAll = migrate({
    pending: [{ id: "P-1" }],
    views: [{ id: "V-1", name: "n", query: "q" }],
    settings: { autoSync: true },
  });
  assert.equal(withAll.pending?.length, 1);
  assert.equal(withAll.views?.length, 1);
  assert.deepEqual(withAll.settings, { autoSync: true });

  // non-array / non-object shapes are dropped (stay absent)
  const dropped = migrate({ pending: "x", views: 3, settings: "y" });
  assert.equal(dropped.pending, undefined);
  assert.equal(dropped.views, undefined);
  assert.equal(dropped.settings, undefined);
});

test("migrate: preserves unknown case fields via spread (forward-compat)", () => {
  const db = migrate({ cases: [{ id: "CASE-1", status: "todo", priority: "P1" }] });
  assert.equal(db.cases[0].priority, "P1");
});

// ── nextCaseId / nextMessageId / nextTaskId / nextNoteId ─────────────────────
test("nextCaseId: max+1 across gaps; ignores non-numeric suffixes; empty → 1", () => {
  assert.equal(nextCaseId(makeDB({ cases: [] })), "CASE-1");
  const db = makeDB({
    cases: [
      makeCase({ id: "CASE-2" }),
      makeCase({ id: "CASE-7" }), // gap is fine — uses the max
      makeCase({ id: "CASE-5" }),
      makeCase({ id: "CASE-abc" }), // non-numeric suffix ignored
      makeCase({ id: "weird" }), // no prefix-dash → parseInt("weird") NaN, filtered
    ],
  });
  assert.equal(nextCaseId(db), "CASE-8");
});

test("nextCaseId: stays unique after a delete of the current max", () => {
  const db = makeDB({ cases: [makeCase({ id: "CASE-1" }), makeCase({ id: "CASE-2" })] });
  assert.equal(nextCaseId(db), "CASE-3");
  db.cases.pop(); // remove CASE-2 (the max)
  assert.equal(nextCaseId(db), "CASE-2", "reuses the freed id since it is now the max+1");
});

test("nextMessageId: max+1, ignores non-numeric, empty → M-1", () => {
  assert.equal(nextMessageId(makeDB({ messages: [] })), "M-1");
  const db = makeDB({
    messages: [
      makeMessage({ id: "M-3" }),
      makeMessage({ id: "M-10" }),
      makeMessage({ id: "gmail-xyz" }), // ignored
    ],
  });
  assert.equal(nextMessageId(db), "M-11");
});

test("nextTaskId: max(-T<k>) + 1, scoped to the case id prefix", () => {
  const c = makeCase({
    id: "CASE-4",
    tasks: [makeTask({ id: "CASE-4-T1" }), makeTask({ id: "CASE-4-T3" })],
  });
  assert.equal(nextTaskId(c), "CASE-4-T4", "uses highest -T suffix (3) + 1");
});

test("nextTaskId: empty task list → -T1", () => {
  assert.equal(nextTaskId(makeCase({ id: "CASE-9", tasks: [] })), "CASE-9-T1");
});

test("nextTaskId: guards against id reuse when suffixes are low but count is high", () => {
  // Tasks with low/unparseable -T suffixes could otherwise collide; the Math.max
  // with tasks.length prevents minting an id that clashes with an existing one.
  const c = makeCase({
    id: "CASE-1",
    tasks: [
      makeTask({ id: "CASE-1-T1" }),
      makeTask({ id: "CASE-1-T1-dup-but-parses-as-1" }), // /-T(\d+)$/ won't match → 0
    ],
  });
  // max suffix = 1, tasks.length = 2 → Math.max(1,2)+1 = 3
  assert.equal(nextTaskId(c), "CASE-1-T3");
});

test("nextTaskId: tasks with no parseable -T suffix fall back to length-based id", () => {
  const c = makeCase({ id: "CASE-1", tasks: [makeTask({ id: "foo" }), makeTask({ id: "bar" })] });
  // max = 0, length = 2 → 3
  assert.equal(nextTaskId(c), "CASE-1-T3");
});

test("nextNoteId: max(-N<k>)+1; empty/absent notes → -N1", () => {
  assert.equal(nextNoteId(makeCase({ id: "CASE-1" })), "CASE-1-N1", "absent notes array");
  assert.equal(nextNoteId(makeCase({ id: "CASE-1", notes: [] })), "CASE-1-N1");
  const c = makeCase({
    id: "CASE-1",
    notes: [
      { id: "CASE-1-N1", author: "human", body: "a", createdAt: ISO },
      { id: "CASE-1-N4", author: "human", body: "b", createdAt: ISO },
    ],
  });
  assert.equal(nextNoteId(c), "CASE-1-N5");
});

// ── findCase / findTask ──────────────────────────────────────────────────────
test("findCase / findTask: hit and miss", () => {
  const c = makeCase({ id: "CASE-2", tasks: [makeTask({ id: "CASE-2-T1" })] });
  const db = makeDB({ cases: [c] });
  assert.equal(findCase(db, "CASE-2"), c);
  assert.equal(findCase(db, "CASE-404"), undefined);
  assert.equal(findTask(c, "CASE-2-T1")?.id, "CASE-2-T1");
  assert.equal(findTask(c, "nope"), undefined);
});

// ── appendTask ───────────────────────────────────────────────────────────────
test("appendTask: defaults status 'open', mints id, sets createdAt, bumps updatedAt", () => {
  const c = makeCase({ id: "CASE-1", updatedAt: ISO });
  const before = Date.now();
  const t = appendTask(c, { title: "do it" } as Task);
  assert.equal(t.id, "CASE-1-T1");
  assert.equal(t.status, "open");
  assert.equal(t.title, "do it");
  assert.equal(c.tasks.length, 1);
  assert.equal(c.tasks[0], t);
  assertRecentISO(t.createdAt, before);
  assertRecentISO(c.updatedAt, before);
  assert.notEqual(c.updatedAt, ISO, "updatedAt was bumped off the fixture value");
});

test("appendTask: honours explicit id/createdAt/status and optional fields", () => {
  const c = makeCase({ id: "CASE-1" });
  const t = appendTask(c, {
    id: "CASE-1-T99",
    title: "x",
    status: "blocked",
    createdAt: "2020-01-01T00:00:00.000Z",
    owner: "me",
    detail: "d",
    dueAt: "2026-06-01T00:00:00.000Z",
    position: 3,
    subtasks: [{ id: "s1", title: "st", done: false }],
  });
  assert.equal(t.id, "CASE-1-T99");
  assert.equal(t.createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(t.status, "blocked");
  assert.equal(t.owner, "me");
  assert.equal(t.position, 3);
  assert.equal(t.subtasks?.length, 1);
});

test("appendTask: second append mints the next sequential id", () => {
  const c = makeCase({ id: "CASE-1" });
  appendTask(c, { title: "a" } as Task);
  const second = appendTask(c, { title: "b" } as Task);
  assert.equal(second.id, "CASE-1-T2");
  assert.equal(c.tasks.length, 2);
});

// ── applyCaseUpdate ──────────────────────────────────────────────────────────
test("applyCaseUpdate: only present keys are touched; absent keys untouched", () => {
  const c = makeCase({ id: "CASE-1", title: "Orig", summary: "keep", eta: "soon" });
  applyCaseUpdate(c, { title: "New" });
  assert.equal(c.title, "New");
  assert.equal(c.summary, "keep", "summary not in patch → untouched");
  assert.equal(c.eta, "soon", "eta not in patch → untouched");
});

test("applyCaseUpdate: title is trimmed; empty/whitespace/non-string title ignored", () => {
  const c = makeCase({ title: "Orig" });
  applyCaseUpdate(c, { title: "  Spaced  " });
  assert.equal(c.title, "Spaced");
  applyCaseUpdate(c, { title: "   " });
  assert.equal(c.title, "Spaced", "whitespace-only title rejected");
  applyCaseUpdate(c, { title: 42 });
  assert.equal(c.title, "Spaced", "non-string title rejected");
});

test("applyCaseUpdate: summary null → '' ; numeric/other coerced via String", () => {
  const c = makeCase({ summary: "old" });
  applyCaseUpdate(c, { summary: null });
  assert.equal(c.summary, "");
  applyCaseUpdate(c, { summary: 123 });
  assert.equal(c.summary, "123");
});

test("applyCaseUpdate: status set only when valid; invalid status ignored (preserves prior)", () => {
  const c = makeCase({ status: "todo" });
  applyCaseUpdate(c, { status: "done" });
  assert.equal(c.status, "done");
  applyCaseUpdate(c, { status: "nonsense" });
  assert.equal(c.status, "done", "invalid status left the prior value in place");
  applyCaseUpdate(c, { status: null });
  assert.equal(c.status, "done", "null status ignored");
});

test("applyCaseUpdate: domain set only when valid; invalid domain ignored", () => {
  const c = makeCase({ domain: "work" });
  applyCaseUpdate(c, { domain: "life" });
  assert.equal(c.domain, "life");
  applyCaseUpdate(c, { domain: "space" });
  assert.equal(c.domain, "life", "invalid domain left the prior value in place");
});

test("applyCaseUpdate: optional scalars clear on null/empty, set on value", () => {
  const c = makeCase({ dueAt: "2026-06-01T00:00:00.000Z", eta: "soon" });
  applyCaseUpdate(c, { dueAt: undefined, eta: "tomorrow" });
  assert.equal(c.dueAt, undefined, "undefined clears");
  assert.equal(c.eta, "tomorrow");
});

test("applyCaseUpdate: tags / vaultLinks become array-of-strings, or undefined if not array", () => {
  const c = makeCase();
  applyCaseUpdate(c, { tags: ["a", 1, true], vaultLinks: ["w/x"] });
  assert.deepEqual(c.tags, ["a", "1", "true"], "elements String()-coerced");
  assert.deepEqual(c.vaultLinks, ["w/x"]);
  applyCaseUpdate(c, { tags: "nope", vaultLinks: null });
  assert.equal(c.tags, undefined, "non-array tags → undefined");
  assert.equal(c.vaultLinks, undefined, "non-array vaultLinks → undefined");
});

test("applyCaseUpdate: priority set only when valid; invalid/null clears it", () => {
  const c = makeCase({ priority: "P1" });
  applyCaseUpdate(c, { priority: "P0" });
  assert.equal(c.priority, "P0");
  applyCaseUpdate(c, { priority: "P9" });
  assert.equal(c.priority, undefined, "invalid priority CLEARS (not preserves)");
  c.priority = "P2";
  applyCaseUpdate(c, { priority: null });
  assert.equal(c.priority, undefined, "null priority clears");
});

test("applyCaseUpdate: position number-guard — number kept, non-number → undefined", () => {
  const c = makeCase({ position: 5 });
  applyCaseUpdate(c, { position: 2 });
  assert.equal(c.position, 2);
  applyCaseUpdate(c, { position: "3" });
  assert.equal(c.position, undefined, "string position rejected → undefined");
  c.position = 9;
  applyCaseUpdate(c, { position: null });
  assert.equal(c.position, undefined);
  c.position = 0;
  applyCaseUpdate(c, { position: 0 });
  assert.equal(c.position, 0, "zero is a valid number position");
});

test("applyCaseUpdate: archivedAt clears on null, sets on value (soft-archive plumbing)", () => {
  const c = makeCase({ archivedAt: ISO });
  applyCaseUpdate(c, { archivedAt: null });
  assert.equal(c.archivedAt, undefined);
  applyCaseUpdate(c, { archivedAt: "2026-06-02T00:00:00.000Z" });
  assert.equal(c.archivedAt, "2026-06-02T00:00:00.000Z");
});

test("applyCaseUpdate: always bumps updatedAt", () => {
  const c = makeCase({ updatedAt: ISO });
  const before = Date.now();
  applyCaseUpdate(c, {}); // even an empty patch bumps the stamp
  assertRecentISO(c.updatedAt, before);
  assert.notEqual(c.updatedAt, ISO);
});

test("applyCaseUpdate: never mutates identity / sub-resources", () => {
  const tasks = [makeTask()];
  const messageIds = ["M-1"];
  const c = makeCase({ id: "CASE-1", createdAt: ISO, tasks, messageIds });
  applyCaseUpdate(c, {
    id: "HACK",
    createdAt: "1999-01-01T00:00:00.000Z",
    tasks: [],
    messageIds: [],
  } as Record<string, unknown>);
  assert.equal(c.id, "CASE-1", "id immutable");
  assert.equal(c.createdAt, ISO, "createdAt immutable");
  assert.equal(c.tasks, tasks, "tasks array reference untouched");
  assert.equal(c.messageIds, messageIds, "messageIds untouched");
});

// ── applyTaskUpdate ──────────────────────────────────────────────────────────
test("applyTaskUpdate: status→done sets completedAt; bumps case updatedAt", () => {
  const c = makeCase({ updatedAt: ISO });
  const t = makeTask({ status: "open", completedAt: undefined });
  const before = Date.now();
  applyTaskUpdate(c, t, { status: "done" });
  assert.equal(t.status, "done");
  assertRecentISO(t.completedAt, before);
  assertRecentISO(c.updatedAt, before);
});

test("applyTaskUpdate: status→done preserves an EXISTING completedAt", () => {
  const c = makeCase();
  const prior = "2026-05-30T00:00:00.000Z";
  const t = makeTask({ status: "done", completedAt: prior });
  applyTaskUpdate(c, t, { status: "done" });
  assert.equal(t.completedAt, prior, "already-done task keeps its original completedAt");
});

test("applyTaskUpdate: status off 'done' clears completedAt", () => {
  const c = makeCase();
  const t = makeTask({ status: "done", completedAt: ISO });
  applyTaskUpdate(c, t, { status: "in_progress" });
  assert.equal(t.status, "in_progress");
  assert.equal(t.completedAt, undefined, "moving off done clears completedAt");
});

test("applyTaskUpdate: title trimmed; detail/owner clear on empty/null", () => {
  const c = makeCase();
  const t = makeTask({ title: "old", detail: "d", owner: "o" });
  applyTaskUpdate(c, t, { title: "  new  ", detail: "", owner: null });
  assert.equal(t.title, "new");
  assert.equal(t.detail, undefined);
  assert.equal(t.owner, undefined);
});

test("applyTaskUpdate: position number-guard and subtasks array-guard", () => {
  const c = makeCase();
  const t = makeTask({ position: 1, subtasks: [{ id: "s", title: "x", done: false }] });
  applyTaskUpdate(c, t, { position: "2", subtasks: "nope" });
  assert.equal(t.position, undefined, "non-number position → undefined");
  assert.equal(t.subtasks, undefined, "non-array subtasks → undefined");
  applyTaskUpdate(c, t, { position: 4, subtasks: [{ id: "s2", title: "y", done: true }] });
  assert.equal(t.position, 4);
  assert.equal(t.subtasks?.length, 1);
});

test("applyTaskUpdate: absent keys leave the task field untouched", () => {
  const c = makeCase();
  const t = makeTask({ title: "keep", detail: "keepd", status: "blocked" });
  applyTaskUpdate(c, t, {});
  assert.equal(t.title, "keep");
  assert.equal(t.detail, "keepd");
  assert.equal(t.status, "blocked");
});

// ── logActivity ──────────────────────────────────────────────────────────────
test("logActivity: appends an entry, lazily creating the array; does NOT bump updatedAt", () => {
  const c = makeCase({ updatedAt: ISO });
  assert.equal(c.activity, undefined);
  logActivity(c, "agent", "created", "first");
  assert.equal(c.activity?.length, 1);
  assert.equal(c.activity?.[0].actor, "agent");
  assert.equal(c.activity?.[0].verb, "created");
  assert.equal(c.activity?.[0].detail, "first");
  assert.equal(typeof c.activity?.[0].ts, "string");
  assert.equal(c.updatedAt, ISO, "logging is a side-record — updatedAt unchanged");
});

test("logActivity: caps at 50, keeping the NEWEST entries", () => {
  const c = makeCase();
  for (let i = 0; i < 60; i++) logActivity(c, "human", `v${i}`);
  assert.equal(c.activity?.length, 50, "capped to 50");
  assert.equal(c.activity?.[0].verb, "v10", "oldest kept is the 11th entry (v10)");
  assert.equal(c.activity?.[49].verb, "v59", "newest entry retained");
});

test("logActivity: detail is optional", () => {
  const c = makeCase();
  logActivity(c, "system", "touched");
  assert.equal(c.activity?.[0].detail, undefined);
});

// ── addNote ──────────────────────────────────────────────────────────────────
test("addNote: mints id, records author/body/createdAt, bumps updatedAt", () => {
  const c = makeCase({ id: "CASE-1", updatedAt: ISO });
  const before = Date.now();
  const note = addNote(c, "human", "hello");
  assert.equal(note.id, "CASE-1-N1");
  assert.equal(note.author, "human");
  assert.equal(note.body, "hello");
  assertRecentISO(note.createdAt, before);
  assert.equal(c.notes?.length, 1);
  assertRecentISO(c.updatedAt, before);
  assert.notEqual(c.updatedAt, ISO);
});

test("addNote: second note mints sequential id", () => {
  const c = makeCase({ id: "CASE-1" });
  addNote(c, "human", "a");
  const second = addNote(c, "agent", "b");
  assert.equal(second.id, "CASE-1-N2");
  assert.equal(c.notes?.length, 2);
});

// ── archive / restore ────────────────────────────────────────────────────────
test("archiveCase: sets archivedAt and bumps updatedAt", () => {
  const c = makeCase({ updatedAt: ISO, archivedAt: undefined });
  const before = Date.now();
  archiveCase(c);
  assertRecentISO(c.archivedAt, before);
  assertRecentISO(c.updatedAt, before);
});

test("restoreCase: clears archivedAt and bumps updatedAt", () => {
  const c = makeCase({ archivedAt: ISO, updatedAt: ISO });
  const before = Date.now();
  restoreCase(c);
  assert.equal(c.archivedAt, undefined);
  assertRecentISO(c.updatedAt, before);
});

// ── sweepExpiredTrash (lazy retention purge) ─────────────────────────────────
// The OLD removeCaseHard ("keep but unlink") path is gone — the only permanent
// removal is this sweep, which reuses cleanCases (so it PURGES a purged case's
// emails EXCEPT those still referenced by a reminder or a surviving case).
const DAY_MS = 86_400_000;

test("sweepExpiredTrash: purges archived cases older than the window, keeps fresh ones", () => {
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const expired = makeCase({ id: "CASE-1", archivedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() });
  const fresh = makeCase({ id: "CASE-2", archivedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() });
  const live = makeCase({ id: "CASE-3", archivedAt: undefined });
  const db = makeDB({ cases: [expired, fresh, live] });

  const removed = sweepExpiredTrash(db);
  assert.equal(removed, 1, "only the over-window archived case is purged");
  assert.equal(findCase(db, "CASE-1"), undefined, "expired Trash case is gone");
  assert.ok(findCase(db, "CASE-2"), "fresh Trash case survives the window");
  assert.ok(findCase(db, "CASE-3"), "a live case is never swept");

  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

test("sweepExpiredTrash: purges a swept case's emails EXCEPT a reminder-linked one (cleanCases semantics)", () => {
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const plain = makeMessage({ id: "M-1", caseId: "CASE-1" });
  const reminderLinked = makeMessage({ id: "M-2", caseId: "CASE-1", reminderId: "R-1" });
  const db = makeDB({
    cases: [
      makeCase({
        id: "CASE-1",
        archivedAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
        messageIds: ["M-1", "M-2"],
      }),
    ],
    messages: [plain, reminderLinked],
  });

  assert.equal(sweepExpiredTrash(db), 1);
  assert.equal(findCase(db, "CASE-1"), undefined);
  assert.equal(db.messages.find((m) => m.id === "M-1"), undefined, "plain email is purged");
  const survivor = db.messages.find((m) => m.id === "M-2");
  assert.ok(survivor, "reminder-linked email survives the purge");
  assert.equal(survivor?.caseId, undefined, "survivor's dangling case link is cleared");

  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

test("sweepExpiredTrash: a non-positive window disables the sweep (no-op)", () => {
  process.env.COS_TRASH_RETENTION_DAYS = "0";
  _resetRetentionCache();
  const db = makeDB({
    cases: [makeCase({ id: "CASE-1", archivedAt: new Date(Date.now() - 999 * DAY_MS).toISOString() })],
  });
  assert.equal(sweepExpiredTrash(db), 0, "window <= 0 disables the sweep");
  assert.ok(findCase(db, "CASE-1"), "case is untouched when the sweep is off");

  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

// ── sweepExpiredReminders (auto soft-delete + purge) ─────────────────────────
// done/dismissed reminders untouched longer than COS_REMINDER_AUTODELETE_DAYS get
// archivedAt set (→ Trash); archived reminders older than COS_TRASH_RETENTION_DAYS
// are hard-removed. OPEN reminders are never auto-deleted.
test("sweepExpiredReminders: soft-deletes stale done/dismissed, leaves open + fresh", () => {
  process.env.COS_REMINDER_AUTODELETE_DAYS = "7";
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const staleDone = makeReminder({ id: "REM-1", status: "done", updatedAt: new Date(Date.now() - 8 * DAY_MS).toISOString() });
  const staleDismissed = makeReminder({ id: "REM-2", status: "dismissed", updatedAt: new Date(Date.now() - 9 * DAY_MS).toISOString() });
  const freshDone = makeReminder({ id: "REM-3", status: "done", updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
  const staleOpen = makeReminder({ id: "REM-4", status: "open", updatedAt: new Date(Date.now() - 99 * DAY_MS).toISOString() });
  const db = makeDB({ reminders: [staleDone, staleDismissed, freshDone, staleOpen] });

  const { archived } = sweepExpiredReminders(db);
  assert.equal(archived, 2, "both stale terminal reminders are soft-deleted");
  assert.ok(staleDone.archivedAt, "stale done → Trash");
  assert.ok(staleDismissed.archivedAt, "stale dismissed → Trash");
  assert.equal(freshDone.archivedAt, undefined, "fresh done survives the window");
  assert.equal(staleOpen.archivedAt, undefined, "an OPEN reminder is never auto-deleted");

  delete process.env.COS_REMINDER_AUTODELETE_DAYS;
  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

test("sweepExpiredReminders: purges archived reminders past the Trash window, unlinking emails", () => {
  process.env.COS_REMINDER_AUTODELETE_DAYS = "7";
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const linked = makeMessage({ id: "M-1", reminderId: "REM-1" });
  const db = makeDB({
    reminders: [
      makeReminder({ id: "REM-1", status: "done", archivedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() }),
    ],
    messages: [linked],
  });

  const { purged } = sweepExpiredReminders(db);
  assert.equal(purged, 1, "over-window archived reminder is purged");
  assert.equal(db.reminders?.length, 0, "reminder is gone");
  assert.equal(db.messages.find((m) => m.id === "M-1")?.reminderId, undefined, "linked email is kept but unlinked");

  delete process.env.COS_REMINDER_AUTODELETE_DAYS;
  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

test("sweepExpiredReminders: a restored reminder isn't immediately re-swept (updatedAt clock)", () => {
  process.env.COS_REMINDER_AUTODELETE_DAYS = "7";
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  // A done reminder that finished long ago, just restored from Trash (archivedAt
  // cleared via applyReminderUpdate, which re-stamps updatedAt to now).
  const r = makeReminder({
    id: "REM-1",
    status: "done",
    completedAt: new Date(Date.now() - 99 * DAY_MS).toISOString(),
    archivedAt: new Date(Date.now() - 40 * DAY_MS).toISOString(),
    updatedAt: new Date(Date.now() - 99 * DAY_MS).toISOString(),
  });
  const db = makeDB({ reminders: [r] });
  applyReminderUpdate(r, { archivedAt: null }); // restore

  const { archived, purged } = sweepExpiredReminders(db);
  assert.equal(purged, 0, "restored reminder is not purged");
  assert.equal(archived, 0, "restored reminder is not immediately re-soft-deleted");
  assert.equal(r.archivedAt, undefined, "stays restored after a sweep");

  delete process.env.COS_REMINDER_AUTODELETE_DAYS;
  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

test("sweepExpiredReminders: a non-positive auto-delete window disables soft-delete", () => {
  process.env.COS_REMINDER_AUTODELETE_DAYS = "0";
  process.env.COS_TRASH_RETENTION_DAYS = "30";
  _resetRetentionCache();
  const r = makeReminder({ id: "REM-1", status: "done", updatedAt: new Date(Date.now() - 999 * DAY_MS).toISOString() });
  const db = makeDB({ reminders: [r] });
  const { archived } = sweepExpiredReminders(db);
  assert.equal(archived, 0, "window <= 0 disables auto soft-delete");
  assert.equal(r.archivedAt, undefined, "reminder untouched when auto-delete is off");

  delete process.env.COS_REMINDER_AUTODELETE_DAYS;
  delete process.env.COS_TRASH_RETENTION_DAYS;
  _resetRetentionCache();
});

// ── deleteTask ───────────────────────────────────────────────────────────────
test("deleteTask: removes by id, bumps updatedAt, returns true; false on miss", () => {
  const c = makeCase({
    id: "CASE-1",
    updatedAt: ISO,
    tasks: [makeTask({ id: "CASE-1-T1" }), makeTask({ id: "CASE-1-T2" })],
  });
  const before = Date.now();
  assert.equal(deleteTask(c, "CASE-1-T1"), true);
  assert.equal(c.tasks.length, 1);
  assert.equal(c.tasks[0].id, "CASE-1-T2");
  assertRecentISO(c.updatedAt, before);

  const c2 = makeCase({ id: "CASE-2", updatedAt: ISO, tasks: [] });
  assert.equal(deleteTask(c2, "nope"), false);
  assert.equal(c2.updatedAt, ISO, "miss does not bump updatedAt");
});

// ── id minters: nextEventId / nextReminderId / nextPriorityId ─────────────────
// Each is the EVT/REM/PRI twin of nextCaseId/nextMessageId: max numeric suffix + 1,
// ignoring unparseable ids, base-1 on an empty (or absent) collection, and it never
// reuses a freed id while that id is still the max — but DOES re-mint it once it is
// the new max+1 after the old max is deleted (the same "freed id reused as max+1"
// behaviour nextCaseId is documented to have).
test("nextEventId: max+1, ignores non-numeric, base EVT-1 on empty/absent", () => {
  assert.equal(nextEventId(makeDB({ events: [] })), "EVT-1");
  assert.equal(nextEventId(makeDB({})), "EVT-1", "absent events array → EVT-1");
  const db = makeDB({
    events: [
      makeEvent({ id: "EVT-2" }),
      makeEvent({ id: "EVT-9" }), // gap is fine — uses the max
      makeEvent({ id: "EVT-5" }),
      makeEvent({ id: "ics-xyz" }), // unparseable suffix ignored
    ],
  });
  assert.equal(nextEventId(db), "EVT-10");
});

test("nextEventId: re-mints a freed id once it becomes the new max+1", () => {
  const db = makeDB({ events: [makeEvent({ id: "EVT-1" }), makeEvent({ id: "EVT-2" })] });
  assert.equal(nextEventId(db), "EVT-3");
  db.events!.pop(); // remove EVT-2 (the current max)
  assert.equal(nextEventId(db), "EVT-2", "the freed id is reused since it is now max+1");
});

test("nextReminderId: max+1, ignores non-numeric, base REM-1 on empty/absent", () => {
  assert.equal(nextReminderId(makeDB({ reminders: [] })), "REM-1");
  assert.equal(nextReminderId(makeDB({})), "REM-1", "absent reminders array → REM-1");
  const db = makeDB({
    reminders: [
      makeReminder({ id: "REM-3" }),
      makeReminder({ id: "REM-10" }),
      makeReminder({ id: "free-text" }), // unparseable suffix ignored
    ],
  });
  assert.equal(nextReminderId(db), "REM-11");
});

test("nextReminderId: re-mints a freed id once it becomes the new max+1", () => {
  const db = makeDB({ reminders: [makeReminder({ id: "REM-1" }), makeReminder({ id: "REM-2" })] });
  assert.equal(nextReminderId(db), "REM-3");
  db.reminders!.pop(); // remove REM-2 (the current max)
  assert.equal(nextReminderId(db), "REM-2", "the freed id is reused since it is now max+1");
});

test("nextPriorityId: max+1, ignores non-numeric, base PRI-1 on empty/absent", () => {
  assert.equal(nextPriorityId(makeDB({ priorities: [] })), "PRI-1");
  assert.equal(nextPriorityId(makeDB({})), "PRI-1", "absent priorities array → PRI-1");
  const db = makeDB({
    priorities: [
      makePriority({ id: "PRI-4" }),
      makePriority({ id: "PRI-12" }),
      makePriority({ id: "note" }), // unparseable suffix ignored
    ],
  });
  assert.equal(nextPriorityId(db), "PRI-13");
});

test("nextPriorityId: re-mints a freed id once it becomes the new max+1", () => {
  const db = makeDB({ priorities: [makePriority({ id: "PRI-1" }), makePriority({ id: "PRI-2" })] });
  assert.equal(nextPriorityId(db), "PRI-3");
  db.priorities!.pop(); // remove PRI-2 (the current max)
  assert.equal(nextPriorityId(db), "PRI-2", "the freed id is reused since it is now max+1");
});

// ── nextReminderTaskId ────────────────────────────────────────────────────────
// The REM-<n>-T<k> twin of nextTaskId: highest -T<k> + 1, scoped to the reminder
// id, base -T1 on an empty/absent checklist, and the same Math.max(length) guard so
// a re-add after a delete (or unparseable ids) never collides with an existing one.
test("nextReminderTaskId: max(-T<k>)+1 scoped to the reminder id", () => {
  const r = makeReminder({
    id: "REM-4",
    tasks: [
      { id: "REM-4-T1", title: "a", done: false },
      { id: "REM-4-T3", title: "b", done: true },
    ],
  });
  assert.equal(nextReminderTaskId(r), "REM-4-T4", "uses highest -T suffix (3) + 1");
});

test("nextReminderTaskId: empty/absent task list → -T1", () => {
  assert.equal(nextReminderTaskId(makeReminder({ id: "REM-9" })), "REM-9-T1", "absent tasks");
  assert.equal(nextReminderTaskId(makeReminder({ id: "REM-9", tasks: [] })), "REM-9-T1");
});

test("nextReminderTaskId: guards against reuse when suffixes are low but count is high", () => {
  const r = makeReminder({
    id: "REM-1",
    tasks: [
      { id: "REM-1-T1", title: "a", done: false },
      { id: "free", title: "b", done: false }, // /-T(\d+)$/ won't match → 0
    ],
  });
  // max suffix = 1, length = 2 → Math.max(1,2)+1 = 3
  assert.equal(nextReminderTaskId(r), "REM-1-T3");
});

// ── removeEvent / removeReminder / removePriority (splice removers) ────────────
test("removeEvent: splices by id, returns true; false on miss or absent array", () => {
  const db = makeDB({ events: [makeEvent({ id: "EVT-1" }), makeEvent({ id: "EVT-2" })] });
  assert.equal(removeEvent(db, "EVT-1"), true);
  assert.equal(db.events?.length, 1);
  assert.equal(db.events?.[0].id, "EVT-2");
  assert.equal(removeEvent(db, "EVT-404"), false, "unknown id → false");
  assert.equal(removeEvent(makeDB({}), "EVT-1"), false, "absent events array → false");
});

test("removePriority: splices by id, returns true; false on miss or absent array", () => {
  const db = makeDB({ priorities: [makePriority({ id: "PRI-1" }), makePriority({ id: "PRI-2" })] });
  assert.equal(removePriority(db, "PRI-2"), true);
  assert.equal(db.priorities?.length, 1);
  assert.equal(db.priorities?.[0].id, "PRI-1");
  assert.equal(removePriority(db, "PRI-404"), false, "unknown id → false");
  assert.equal(removePriority(makeDB({}), "PRI-1"), false, "absent priorities array → false");
});

test("removeReminder: splices by id AND unlinks reminderId from ALL-and-only its linked emails", () => {
  const linkedA = makeMessage({ id: "M-1", reminderId: "REM-1" });
  const linkedB = makeMessage({ id: "M-2", reminderId: "REM-1" });
  const otherReminder = makeMessage({ id: "M-3", reminderId: "REM-2" }); // must stay linked
  const unlinked = makeMessage({ id: "M-4" }); // already has no reminderId
  const db = makeDB({
    reminders: [makeReminder({ id: "REM-1" }), makeReminder({ id: "REM-2" })],
    messages: [linkedA, linkedB, otherReminder, unlinked],
  });

  assert.equal(removeReminder(db, "REM-1"), true);
  assert.equal(db.reminders?.length, 1, "only REM-1 is spliced out");
  assert.equal(db.reminders?.[0].id, "REM-2");
  assert.equal(linkedA.reminderId, undefined, "REM-1's first email is unlinked");
  assert.equal(linkedB.reminderId, undefined, "REM-1's second email is unlinked");
  assert.equal(otherReminder.reminderId, "REM-2", "a DIFFERENT reminder's email is left linked");
  assert.equal(unlinked.reminderId, undefined, "an already-unlinked email is untouched");
});

test("removeReminder: returns false on a miss / absent array (and unlinks nothing)", () => {
  const linked = makeMessage({ id: "M-1", reminderId: "REM-1" });
  const db = makeDB({ reminders: [makeReminder({ id: "REM-1" })], messages: [linked] });
  assert.equal(removeReminder(db, "REM-404"), false, "unknown id → false");
  assert.equal(linked.reminderId, "REM-1", "a miss must not unlink any email");
  assert.equal(removeReminder(makeDB({}), "REM-1"), false, "absent reminders array → false");
});

// ── find* / messagesForReminder (db-bound lookups over optional arrays) ────────
test("findEvent / findReminder / findPriority: hit, miss, and absent-array all safe", () => {
  const e = makeEvent({ id: "EVT-1" });
  const r = makeReminder({ id: "REM-1" });
  const p = makePriority({ id: "PRI-1" });
  const db = makeDB({ events: [e], reminders: [r], priorities: [p] });
  assert.equal(findEvent(db, "EVT-1"), e);
  assert.equal(findReminder(db, "REM-1"), r);
  assert.equal(findPriority(db, "PRI-1"), p);
  assert.equal(findEvent(db, "nope"), undefined);
  assert.equal(findReminder(db, "nope"), undefined);
  assert.equal(findPriority(db, "nope"), undefined);
  const bare = makeDB({});
  assert.equal(findEvent(bare, "EVT-1"), undefined, "absent events array → undefined");
  assert.equal(findReminder(bare, "REM-1"), undefined, "absent reminders array → undefined");
  assert.equal(findPriority(bare, "PRI-1"), undefined, "absent priorities array → undefined");
});

test("messagesForReminder: returns exactly the emails whose reminderId matches", () => {
  const db = makeDB({
    messages: [
      makeMessage({ id: "M-1", reminderId: "REM-1" }),
      makeMessage({ id: "M-2", reminderId: "REM-2" }),
      makeMessage({ id: "M-3", reminderId: "REM-1" }),
      makeMessage({ id: "M-4" }),
    ],
  });
  const ids = messagesForReminder(db, "REM-1").map((m) => m.id).sort();
  assert.deepEqual(ids, ["M-1", "M-3"]);
  assert.deepEqual(messagesForReminder(db, "REM-404"), [], "no match → []");
});

// ── applyEventUpdate (coercive chokepoint) ────────────────────────────────────
test("applyEventUpdate: empty/whitespace/non-string title ignored; valid title trimmed", () => {
  const e = makeEvent({ id: "EVT-1", title: "Orig" });
  applyEventUpdate(e, { title: "  New  " });
  assert.equal(e.title, "New");
  applyEventUpdate(e, { title: "   " });
  assert.equal(e.title, "New", "whitespace-only title rejected");
  applyEventUpdate(e, { title: 42 });
  assert.equal(e.title, "New", "non-string title rejected");
});

test("applyEventUpdate: allDay is Boolean-coerced from any truthy/falsy value", () => {
  const e = makeEvent({ id: "EVT-1", allDay: false });
  applyEventUpdate(e, { allDay: 1 });
  assert.equal(e.allDay, true, "truthy → true");
  applyEventUpdate(e, { allDay: 0 });
  assert.equal(e.allDay, false, "falsy → false");
  applyEventUpdate(e, { allDay: "yes" });
  assert.equal(e.allDay, true, "non-empty string → true");
});

test("applyEventUpdate: null/'' clears optional fields; a value sets them", () => {
  const e = makeEvent({
    id: "EVT-1",
    startTime: "09:00",
    endTime: "10:00",
    description: "d",
    location: "l",
    caseId: "CASE-1",
  });
  applyEventUpdate(e, { startTime: null, endTime: "", description: null, location: "", caseId: null });
  assert.equal(e.startTime, undefined, "null clears startTime");
  assert.equal(e.endTime, undefined, "'' clears endTime");
  assert.equal(e.description, undefined);
  assert.equal(e.location, undefined);
  assert.equal(e.caseId, undefined, "null clears the case link");
  applyEventUpdate(e, { startTime: "11:00", caseId: "CASE-2" });
  assert.equal(e.startTime, "11:00");
  assert.equal(e.caseId, "CASE-2");
});

test("applyEventUpdate: domain set only when valid; invalid ignored", () => {
  const e = makeEvent({ id: "EVT-1", domain: "work" });
  applyEventUpdate(e, { domain: "life" });
  assert.equal(e.domain, "life");
  applyEventUpdate(e, { domain: "space" });
  assert.equal(e.domain, "life", "invalid domain left the prior value in place");
});

test("applyEventUpdate: never mutates id/createdAt; always bumps updatedAt", () => {
  const e = makeEvent({ id: "EVT-1", createdAt: ISO, updatedAt: ISO });
  const before = Date.now();
  applyEventUpdate(e, { id: "HACK", createdAt: "1999-01-01T00:00:00.000Z", title: "x" } as Record<string, unknown>);
  assert.equal(e.id, "EVT-1", "id immutable");
  assert.equal(e.createdAt, ISO, "createdAt immutable");
  assertRecentISO(e.updatedAt, before);
  assert.notEqual(e.updatedAt, ISO);
});

// ── applyReminderUpdate: completedAt lifecycle (status done/not-done) ──────────
test("applyReminderUpdate: status→done sets completedAt; off-done clears it", () => {
  const r = makeReminder({ id: "REM-1", status: "open", completedAt: undefined });
  const before = Date.now();
  applyReminderUpdate(r, { status: "done" });
  assert.equal(r.status, "done");
  assertRecentISO(r.completedAt, before);
  applyReminderUpdate(r, { status: "dismissed" });
  assert.equal(r.status, "dismissed");
  assert.equal(r.completedAt, undefined, "moving off done clears completedAt");
});

test("applyReminderUpdate: status→done preserves an EXISTING completedAt", () => {
  const prior = "2026-05-30T00:00:00.000Z";
  const r = makeReminder({ id: "REM-1", status: "done", completedAt: prior });
  applyReminderUpdate(r, { status: "done" });
  assert.equal(r.completedAt, prior, "already-done reminder keeps its original completedAt");
});

// ── mutate / readDB / writeDB (DISK path; isolated tmp COS_DATA_DIR) ───────────
// The disk-touching write path is loaded via a DYNAMIC import so we can point
// COS_DATA_DIR at a throwaway dir BEFORE store.ts resolves its module-level
// DATA_DIR (resolved once, at import time). The store module is cached after the
// first dynamic import, so EVERY disk test shares the SAME tmp dir; resetStore()
// wipes the on-disk file/.bak/backups between cases for isolation. The real
// board/data is never touched (the safety tenet of run.sh's sandbox).
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-store-disk-"));
process.env.COS_DATA_DIR = DISK_DIR;
// Disable the retention sweeps mutate() runs on every write so they can never
// perturb these write-path assertions (the fixtures are fresh anyway).
process.env.COS_TRASH_RETENTION_DAYS = "0";
process.env.COS_REMINDER_AUTODELETE_DAYS = "0";
_resetRetentionCache();

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import
// time. The file's TOP static import already evaluated store.ts (with the real
// default data dir), so we re-import a FRESH module instance with a cache-busting
// query AFTER pointing COS_DATA_DIR at DISK_DIR — that re-evaluation re-reads the
// env, so DATA_FILE now lands inside the throwaway dir (the real board/data is
// never touched). The ts-resolve hook leaves the `?disk` specifier alone (its
// pathname still ends in .ts so type-stripping still applies).
const storeDisk = await import("../../board/lib/store.ts?disk");
const DISK_FILE = storeDisk.DATA_FILE as string;

// Seed cases.json (and clear any .bak / backups) so each disk test starts clean.
// Also (re-)disable the retention sweeps mutate() runs on every write — the earlier
// in-memory sweep tests set/delete COS_*_DAYS in their own bodies, so we re-assert
// the disabled state here, independent of test ordering.
async function resetStore(db: DBShape): Promise<void> {
  process.env.COS_TRASH_RETENTION_DAYS = "0";
  process.env.COS_REMINDER_AUTODELETE_DAYS = "0";
  _resetRetentionCache();
  await fsp.mkdir(DISK_DIR, { recursive: true });
  await fsp.writeFile(DISK_FILE, JSON.stringify(db, null, 2), "utf8");
  await fsp.rm(`${DISK_FILE}.bak`, { force: true });
  await fsp.rm(nodePath.join(DISK_DIR, "backups"), { recursive: true, force: true });
}

test("mutate: N concurrent appends all land with unique ids and version === start + N", async () => {
  const N = 25;
  await resetStore(makeDB({ version: 0, cases: [], messages: [] }));

  // Fire N appends WITHOUT awaiting between them — they pile onto the module-level
  // promise chain and MUST be serialized one-at-a-time (no interleaved read-modify-
  // write), so every minted id is unique and no update is lost.
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      storeDisk.mutate((db) => {
        const id = storeDisk.nextCaseId(db);
        db.cases.push(makeCase({ id, title: id }));
        return id;
      }),
    ),
  );

  assert.equal(new Set(results).size, N, "every concurrent append minted a UNIQUE id (no lost updates)");
  const after = await storeDisk.readDB();
  assert.equal(after.cases.length, N, "all N appends persisted");
  assert.equal(after.version, N, "version bumped exactly once per write (start 0 + N)");
  assert.equal(new Set(after.cases.map((c) => c.id)).size, N, "no duplicate ids on disk");
});

test("mutate: a throwing callback leaves cases.json byte-identical and does NOT bump version", async () => {
  await resetStore(makeDB({ version: 5, cases: [makeCase({ id: "CASE-1" })], messages: [] }));
  const before = await fsp.readFile(DISK_FILE, "utf8");

  await assert.rejects(
    storeDisk.mutate((db) => {
      db.cases.push(makeCase({ id: "CASE-2" })); // would-be write
      throw new Error("boom"); // abort BEFORE writeDB
    }),
    /boom/,
  );

  const after = await fsp.readFile(DISK_FILE, "utf8");
  assert.equal(after, before, "an aborted mutate leaves the file byte-identical");
  const db = await storeDisk.readDB();
  assert.equal(db.version, 5, "version is NOT bumped by an aborted write");
  assert.equal(db.cases.length, 1, "the would-be appended case never persisted");

  // The chain stays alive past the rejection: a subsequent mutate still works.
  const ok = await storeDisk.mutate((db2) => {
    db2.cases.push(makeCase({ id: "CASE-9" }));
    return "ok";
  });
  assert.equal(ok, "ok");
  assert.equal((await storeDisk.readDB()).version, 6, "next successful write bumps from the unchanged baseline");
});

test("readDB: a corrupt cases.json recovers from a good .bak", async () => {
  const good = makeDB({ version: 3, cases: [makeCase({ id: "CASE-7", title: "from bak" })], messages: [] });
  await resetStore(good);
  // Write a GOOD .bak alongside, then corrupt the live file.
  await fsp.writeFile(`${DISK_FILE}.bak`, JSON.stringify(good, null, 2), "utf8");
  await fsp.writeFile(DISK_FILE, "{ this is not json", "utf8");

  const db = await storeDisk.readDB();
  assert.equal(db.version, 3, "recovered the previous good version from .bak");
  assert.equal(db.cases.length, 1);
  assert.equal(db.cases[0].id, "CASE-7", "recovered the .bak's case");
});

test("readDB: a corrupt cases.json with NO .bak rethrows the parse error", async () => {
  await resetStore(makeDB({}));
  await fsp.rm(`${DISK_FILE}.bak`, { force: true }); // ensure no fallback exists
  await fsp.writeFile(DISK_FILE, "{ not json either", "utf8");

  await assert.rejects(storeDisk.readDB(), (err: unknown) => err instanceof Error, "no .bak → the primary parse error propagates");
});
