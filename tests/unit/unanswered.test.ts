// Unit tests for board/lib/inbox.ts `selectUnansweredMessages` — the pure selector
// for "messages I still owe a reply to". UNANSWERED === flagged awaiting a reply
// (needsAnswer === true) AND not yet answered (no answeredAt); marking answered sets
// answeredAt so the row leaves the view. Newest-first by receivedAt. Pure / in-memory —
// nothing reads board/data; receivedAt fixtures are tiny ISO literals. Run from the repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/unanswered.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectUnansweredMessages } from "../../board/lib/inbox.ts";
import type { MessageRecord } from "../../board/lib/types.ts";

// In-memory fixture builder (no store reads). Defaults make a read gmail message that
// is NOT flagged unanswered; `over` pins the fields a test cares about. Distinct
// receivedAt per call keeps the date sort deterministic.
let seq = 0;
function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `M-${seq}`,
    source: "gmail",
    from: "alice@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: `subject ${seq}`,
    preview: `preview ${seq}`,
    body: `body ${seq}`,
    receivedAt: `2026-05-0${seq % 9 + 1}T00:00:00.000Z`,
    read: true,
    ...over,
  };
}

const ids = (ms: MessageRecord[]): string[] => ms.map((m) => m.id);

// ── the unanswered predicate: needsAnswer && !answeredAt ─────────────────────────
test("selectUnansweredMessages — only needsAnswer && !answeredAt qualify", () => {
  const messages = [
    msg({ id: "M-FLAGGED", needsAnswer: true }), // flagged, never answered → IN
    msg({ id: "M-ANSWERED", needsAnswer: true, answeredAt: "2026-05-09T00:00:00.000Z" }), // answered → OUT
    msg({ id: "M-UNFLAGGED" }), // not flagged → OUT
    msg({ id: "M-FALSE", needsAnswer: false }), // explicitly false → OUT
  ];
  assert.deepEqual(ids(selectUnansweredMessages(messages)), ["M-FLAGGED"]);
});

test("selectUnansweredMessages — needsAnswer must be strictly true (no coercion)", () => {
  // The predicate is `m.needsAnswer === true`; absent / false / undefined never qualify.
  assert.deepEqual(selectUnansweredMessages([msg({ id: "M-1", needsAnswer: undefined })]), []);
  assert.deepEqual(selectUnansweredMessages([msg({ id: "M-2", needsAnswer: false })]), []);
  assert.deepEqual(ids(selectUnansweredMessages([msg({ id: "M-3", needsAnswer: true })])), ["M-3"]);
});

test("selectUnansweredMessages — any answeredAt drops the row, even when still flagged", () => {
  // A flagged-but-answered message is OUT — marking answered is a pure status flip.
  const messages = [
    msg({ id: "M-OPEN", needsAnswer: true }),
    msg({ id: "M-DONE", needsAnswer: true, answeredAt: "2026-05-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(selectUnansweredMessages(messages)), ["M-OPEN"]);
});

// ── ordering: newest-first by receivedAt ─────────────────────────────────────────
test("selectUnansweredMessages — sorted newest-first by receivedAt", () => {
  const messages = [
    msg({ id: "M-OLD", needsAnswer: true, receivedAt: "2026-05-01T00:00:00.000Z" }),
    msg({ id: "M-NEW", needsAnswer: true, receivedAt: "2026-05-08T00:00:00.000Z" }),
    msg({ id: "M-MID", needsAnswer: true, receivedAt: "2026-05-04T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(selectUnansweredMessages(messages)), ["M-NEW", "M-MID", "M-OLD"]);
});

// ── empty / no-match ─────────────────────────────────────────────────────────────
test("selectUnansweredMessages — empty input and no-match both yield []", () => {
  assert.deepEqual(selectUnansweredMessages([]), []);
  assert.deepEqual(
    selectUnansweredMessages([msg({ id: "M-1" }), msg({ id: "M-2", needsAnswer: false })]),
    [],
  );
});
