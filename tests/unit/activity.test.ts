// Unit tests for the Activity feed: the pure projection that flattens the board's
// three audit sources into one reverse-chronological FeedEntry[] (activityFeed) plus
// the presentation helpers that colour + label + deep-link each row (feedCategory /
// feedVerbLabel / feedHref). Pure / in-memory — nothing reads board/data; every
// timestamp is FIXED so ordering + slicing assertions are deterministic. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/activity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFeed } from "../../board/lib/selectors.ts";
import {
  feedCategory,
  feedVerbLabel,
  feedHref,
} from "../../board/lib/format.ts";
import type {
  DBShape,
  CaseRecord,
  CalendarEvent,
  Reminder,
  CaseActivity,
} from "../../board/lib/types.ts";

// ── In-memory fixture builders (no store reads) ───────────────────────────────
// A minimal CaseRecord — only the fields activityFeed reads (id/title/activity) plus
// the few the CaseRecord shape requires under strict TS. `over` pins what a test cares
// about (notably `activity` and `archivedAt`).
function makeCase(over: Partial<CaseRecord> & { id: string; title: string }): CaseRecord {
  return {
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function act(verb: string, ts: string, over: Partial<CaseActivity> = {}): CaseActivity {
  return { ts, actor: "human", verb, ...over };
}

function makeReminder(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    title: `reminder ${over.id}`,
    status: "open",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...over,
  };
}

function makeEvent(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: `event ${over.id}`,
    date: "2026-03-01",
    allDay: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...over,
  };
}

// Assemble a DBShape from the parts a given test exercises.
function makeDB(over: {
  cases?: CaseRecord[];
  events?: CalendarEvent[];
  reminders?: Reminder[];
}): DBShape {
  return {
    schemaVersion: 6,
    version: 1,
    cases: over.cases ?? [],
    messages: [],
    events: over.events ?? [],
    reminders: over.reminders ?? [],
  };
}

// ── activityFeed: case.activity flattening ────────────────────────────────────
test("activityFeed — flattens case.activity into one FeedEntry per entry", () => {
  const db = makeDB({
    cases: [
      makeCase({
        id: "CASE-1",
        title: "First case",
        activity: [
          act("created", "2026-05-01T10:00:00.000Z"),
          act("moved", "2026-05-02T10:00:00.000Z", { actor: "agent", detail: "todo → in_progress" }),
        ],
      }),
      makeCase({
        id: "CASE-2",
        title: "Second case",
        activity: [act("note_added", "2026-05-03T10:00:00.000Z", { actor: "system" })],
      }),
    ],
  });
  const feed = activityFeed(db);
  assert.equal(feed.length, 3);
  // All are case rows with subjectId === caseId and the case title.
  for (const row of feed) {
    assert.equal(row.kind, "case");
    assert.equal(row.subjectId, row.caseId);
  }
  const moved = feed.find((r) => r.verb === "moved")!;
  assert.equal(moved.subjectId, "CASE-1");
  assert.equal(moved.caseId, "CASE-1");
  assert.equal(moved.title, "First case");
  assert.equal(moved.actor, "agent");
  assert.equal(moved.detail, "todo → in_progress");
  // Keys are unique.
  const keys = new Set(feed.map((r) => r.key));
  assert.equal(keys.size, feed.length);
});

// ── activityFeed: archived cases are NOT filtered ─────────────────────────────
test("activityFeed — archived cases still contribute their activity rows", () => {
  const db = makeDB({
    cases: [
      makeCase({
        id: "CASE-A",
        title: "Archived case",
        archivedAt: "2026-05-09T00:00:00.000Z",
        activity: [act("archived", "2026-05-09T00:00:00.000Z")],
      }),
    ],
  });
  const feed = activityFeed(db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.subjectId, "CASE-A");
  assert.equal(feed[0]!.verb, "archived");
});

// ── activityFeed: DESC sort across mixed kinds ────────────────────────────────
test("activityFeed — sorts newest-ts first across case/reminder/event kinds", () => {
  const db = makeDB({
    cases: [
      makeCase({
        id: "CASE-1",
        title: "c1",
        activity: [act("created", "2026-05-01T00:00:00.000Z")],
      }),
    ],
    reminders: [makeReminder({ id: "REM-1", createdAt: "2026-05-04T00:00:00.000Z" })],
    events: [makeEvent({ id: "EVT-1", createdAt: "2026-05-02T00:00:00.000Z" })],
  });
  const feed = activityFeed(db);
  assert.deepEqual(
    feed.map((r) => r.ts),
    [
      "2026-05-04T00:00:00.000Z", // reminder created
      "2026-05-02T00:00:00.000Z", // event created
      "2026-05-01T00:00:00.000Z", // case created
    ],
  );
});

// ── activityFeed: tie-break by key for equal ts ───────────────────────────────
test("activityFeed — equal ts resolves deterministically by key (ascending)", () => {
  const ts = "2026-05-05T00:00:00.000Z";
  const db = makeDB({
    cases: [
      makeCase({ id: "CASE-2", title: "c2", activity: [act("created", ts)] }),
      makeCase({ id: "CASE-1", title: "c1", activity: [act("created", ts)] }),
    ],
  });
  const feed = activityFeed(db);
  // Keys: "case:CASE-1:..." < "case:CASE-2:..." lexicographically → CASE-1 first.
  assert.deepEqual(feed.map((r) => r.subjectId), ["CASE-1", "CASE-2"]);
  // Stable: re-running yields the same order.
  assert.deepEqual(activityFeed(db).map((r) => r.key), feed.map((r) => r.key));
});

// ── activityFeed: limit / default 200 ─────────────────────────────────────────
test("activityFeed — limit slices, default keeps all when under 200", () => {
  const activity: CaseActivity[] = [];
  for (let i = 0; i < 10; i++) {
    // Descending timestamps so the natural feed order is i=9 (oldest ts) last.
    activity.push(act("updated", `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
  }
  const db = makeDB({ cases: [makeCase({ id: "CASE-1", title: "c1", activity })] });
  assert.equal(activityFeed(db).length, 10); // default 200 → all 10 kept
  const limited = activityFeed(db, { limit: 3 });
  assert.equal(limited.length, 3);
  // The 3 newest survive the slice (DESC by ts).
  assert.deepEqual(
    limited.map((r) => r.ts),
    [
      "2026-05-10T00:00:00.000Z",
      "2026-05-09T00:00:00.000Z",
      "2026-05-08T00:00:00.000Z",
    ],
  );
});

// ── activityFeed: reminder synthesis ──────────────────────────────────────────
test("activityFeed — synthesizes reminder lifecycle rows, with NO actor", () => {
  const db = makeDB({
    reminders: [
      makeReminder({ id: "REM-OPEN", status: "open", createdAt: "2026-04-01T00:00:00.000Z" }),
      makeReminder({
        id: "REM-DONE",
        status: "done",
        caseId: "CASE-9",
        createdAt: "2026-04-02T00:00:00.000Z",
        completedAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      makeReminder({
        id: "REM-DISMISSED",
        status: "dismissed",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    ],
  });
  const feed = activityFeed(db);
  const byKey = new Map(feed.map((r) => [r.key, r]));

  // Open → only a created row.
  assert.ok(byKey.has("rem:REM-OPEN:created"));
  assert.ok(!byKey.has("rem:REM-OPEN:completed"));
  assert.ok(!byKey.has("rem:REM-OPEN:dismissed"));

  // Done → created + completed (at completedAt).
  const doneCreated = byKey.get("rem:REM-DONE:created")!;
  const doneCompleted = byKey.get("rem:REM-DONE:completed")!;
  assert.equal(doneCreated.kind, "reminder");
  assert.equal(doneCreated.subjectId, "REM-DONE");
  assert.equal(doneCreated.caseId, "CASE-9"); // linked → caseId set
  assert.equal(doneCompleted.verb, "reminder_completed");
  assert.equal(doneCompleted.ts, "2026-04-05T00:00:00.000Z"); // completedAt, not updatedAt

  // Dismissed → created + dismissed (at updatedAt).
  const dismissed = byKey.get("rem:REM-DISMISSED:dismissed")!;
  assert.equal(dismissed.verb, "reminder_dismissed");
  assert.equal(dismissed.ts, "2026-04-07T00:00:00.000Z");

  // Synth rows OMIT actor entirely (not actor: undefined) and have no caseId when unlinked.
  const openCreated = byKey.get("rem:REM-OPEN:created")!;
  assert.equal(openCreated.actor, undefined);
  assert.ok(!("actor" in openCreated));
  assert.ok(!("caseId" in openCreated)); // unlinked reminder → no caseId key

  for (const r of feed) {
    assert.ok(!("actor" in r), `${r.key} must omit actor`);
  }
});

// done reminder with NO completedAt falls back to updatedAt.
test("activityFeed — done reminder without completedAt uses updatedAt", () => {
  const db = makeDB({
    reminders: [
      makeReminder({
        id: "REM-DONE",
        status: "done",
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        // no completedAt
      }),
    ],
  });
  const feed = activityFeed(db);
  const completed = feed.find((r) => r.key === "rem:REM-DONE:completed")!;
  assert.equal(completed.ts, "2026-04-08T00:00:00.000Z");
});

// ── activityFeed: event synthesis ─────────────────────────────────────────────
test("activityFeed — synthesizes one event_created row per event, NO actor", () => {
  const db = makeDB({
    events: [
      makeEvent({ id: "EVT-1", title: "Linked event", caseId: "CASE-5", createdAt: "2026-03-01T00:00:00.000Z" }),
      makeEvent({ id: "EVT-2", title: "Standalone event", createdAt: "2026-03-02T00:00:00.000Z" }),
    ],
  });
  const feed = activityFeed(db);
  assert.equal(feed.length, 2);
  const linked = feed.find((r) => r.subjectId === "EVT-1")!;
  assert.equal(linked.kind, "event");
  assert.equal(linked.verb, "event_created");
  assert.equal(linked.title, "Linked event");
  assert.equal(linked.caseId, "CASE-5");
  assert.ok(!("actor" in linked));
  const standalone = feed.find((r) => r.subjectId === "EVT-2")!;
  assert.ok(!("caseId" in standalone)); // unlinked → no caseId key
});

// ── activityFeed: cross-kind NON-dedupe ───────────────────────────────────────
test("activityFeed — a case reminder_linked row and a reminder_created row coexist (not deduped)", () => {
  const db = makeDB({
    cases: [
      makeCase({
        id: "CASE-1",
        title: "Has a reminder",
        activity: [act("reminder_linked", "2026-05-10T00:00:00.000Z")],
      }),
    ],
    reminders: [
      makeReminder({ id: "REM-1", caseId: "CASE-1", createdAt: "2026-05-09T00:00:00.000Z" }),
    ],
  });
  const feed = activityFeed(db);
  const caseRow = feed.find((r) => r.kind === "case" && r.verb === "reminder_linked")!;
  const remRow = feed.find((r) => r.kind === "reminder" && r.verb === "reminder_created")!;
  assert.ok(caseRow, "case-row reminder_linked must exist");
  assert.ok(remRow, "reminder-row reminder_created must exist");
  // Different facts → different deep-links (case → /my-issues, reminder → /reminders).
  assert.notEqual(feedHref(caseRow), feedHref(remRow));
  assert.equal(feedHref(caseRow), "/my-issues?case=CASE-1");
  assert.equal(feedHref(remRow), "/reminders?reminder=REM-1");
});

// ── format: feedCategory ──────────────────────────────────────────────────────
test("feedCategory — maps a representative verb of each category; unknown → neutral", () => {
  assert.equal(feedCategory("created"), "create");
  assert.equal(feedCategory("reminder_created"), "create");
  assert.equal(feedCategory("task_completed"), "complete");
  assert.equal(feedCategory("reminder_completed"), "complete");
  assert.equal(feedCategory("moved"), "move");
  assert.equal(feedCategory("updated"), "update");
  assert.equal(feedCategory("restored"), "update");
  assert.equal(feedCategory("merged"), "update");
  assert.equal(feedCategory("message_linked"), "link");
  assert.equal(feedCategory("message_unlinked"), "unlink");
  assert.equal(feedCategory("note_added"), "note");
  assert.equal(feedCategory("archived"), "archive");
  assert.equal(feedCategory("reminder_dismissed"), "archive");
  assert.equal(feedCategory("task_deleted"), "delete");
  assert.equal(feedCategory("flagged_overdue"), "flag");
  assert.equal(feedCategory("some_future_verb"), "neutral");
});

// ── format: feedVerbLabel ─────────────────────────────────────────────────────
test("feedVerbLabel — explicit labels + humanize fallback for unknown verbs", () => {
  assert.equal(feedVerbLabel("created"), "Created");
  assert.equal(feedVerbLabel("message_linked"), "Email linked");
  assert.equal(feedVerbLabel("reminder_dismissed"), "Reminder dismissed");
  assert.equal(feedVerbLabel("event_created"), "Event created");
  // Fallback: snake_case → "Sentence case".
  assert.equal(feedVerbLabel("some_future_verb"), "Some future verb");
});

// ── format: feedHref ──────────────────────────────────────────────────────────
test("feedHref — routes each kind to its surface, URL-encoding the id", () => {
  assert.equal(feedHref({ kind: "case", subjectId: "CASE-1" }), "/my-issues?case=CASE-1");
  assert.equal(feedHref({ kind: "reminder", subjectId: "REM-1" }), "/reminders?reminder=REM-1");
  assert.equal(feedHref({ kind: "event", subjectId: "EVT-1" }), "/calendar?event=EVT-1");
  // Ids are URL-encoded (a hypothetical id with a reserved char round-trips safely).
  assert.equal(
    feedHref({ kind: "reminder", subjectId: "REM 1/2" }),
    "/reminders?reminder=REM%201%2F2",
  );
});
