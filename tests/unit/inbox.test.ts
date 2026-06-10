// Unit tests for board/lib/inbox.ts — the pure inbox selector layer over a flat
// MessageRecord[]. The module is the single source of truth for inbox filtering
// (read-state + from/to/cc substring), the pinned-message read-exemption, and the
// semantic-vs-date ordering precedence. Pure / in-memory — nothing reads
// board/data; receivedAt fixtures are tiny ISO literals. Run from the repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/inbox.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_INBOX_FILTERS,
  activeFilterCount,
  matchesParticipant,
  messageContent,
  selectInboxMessages,
  type InboxFilters,
} from "../../board/lib/inbox.ts";
import type { MessageRecord } from "../../board/lib/types.ts";

// In-memory fixture builder (no store reads). Defaults make a read gmail message
// with a single from and list-shaped to/cc; `over` pins the fields a test cares
// about. Distinct receivedAt per call keeps the date sort deterministic.
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

// ── EMPTY_INBOX_FILTERS ─────────────────────────────────────────────────────────
test("EMPTY_INBOX_FILTERS — the unconstrained starting point", () => {
  assert.deepEqual(EMPTY_INBOX_FILTERS, { read: "all", from: "", to: "", cc: "" });
});

// ── read filter ─────────────────────────────────────────────────────────────────
test("read filter — all vs unread vs read", () => {
  const messages = [
    msg({ id: "M-READ", read: true }),
    msg({ id: "M-UNREAD", read: false }),
  ];
  const filt = (read: InboxFilters["read"]): InboxFilters => ({ ...EMPTY_INBOX_FILTERS, read });

  // "all" → both, in date order (these share no semantic order; newest-first).
  assert.deepEqual(
    new Set(ids(selectInboxMessages(messages, filt("all"), "newest", null))),
    new Set(["M-READ", "M-UNREAD"]),
  );
  assert.deepEqual(ids(selectInboxMessages(messages, filt("unread"), "newest", null)), ["M-UNREAD"]);
  assert.deepEqual(ids(selectInboxMessages(messages, filt("read"), "newest", null)), ["M-READ"]);
});

// ── from/to/cc substring (case-insensitive) ─────────────────────────────────────
test("from/to/cc substring — case-insensitive, against a string field and string[] fields", () => {
  const messages = [
    msg({ id: "M-A", from: "Alice Smith <alice@example.com>", to: ["bob@corp.com"], cc: ["carol@corp.com"] }),
    msg({ id: "M-B", from: "dan@other.com", to: ["erin@corp.com"], cc: ["frank@other.com"] }),
  ];

  // from → m.from (a plain string), case-insensitive.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, from: "ALICE" }, "newest", null)),
    ["M-A"],
  );
  // to → m.to (string[]), case-insensitive substring of any entry.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, to: "BOB" }, "newest", null)),
    ["M-A"],
  );
  // cc → m.cc (string[]).
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, cc: "frank" }, "newest", null)),
    ["M-B"],
  );
  // Combined constraints are AND-ed.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, from: "alice", cc: "carol" }, "newest", null)),
    ["M-A"],
  );
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, from: "alice", cc: "frank" }, "newest", null)),
    [],
  );
});

test("from/to/cc substring — an empty needle imposes no constraint", () => {
  const messages = [msg({ id: "M-1", to: undefined, cc: undefined })];
  // Empty from/to/cc → message passes even though to/cc are absent.
  assert.deepEqual(
    ids(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "newest", null)),
    ["M-1"],
  );
  // A whitespace-only needle is also treated as no constraint.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, to: "   " }, "newest", null)),
    ["M-1"],
  );
});

// ── matchesParticipant ──────────────────────────────────────────────────────────
test("matchesParticipant — string | string[] | undefined; empty/whitespace needle => true", () => {
  // Empty / whitespace needle is unconstrained regardless of the field shape.
  assert.equal(matchesParticipant(undefined, ""), true);
  assert.equal(matchesParticipant("alice", ""), true);
  assert.equal(matchesParticipant(["a", "b"], "   "), true);
  assert.equal(matchesParticipant(["a", "b"], "\t\n"), true);

  // undefined field with a real needle never matches.
  assert.equal(matchesParticipant(undefined, "x"), false);

  // string field — case-insensitive substring.
  assert.equal(matchesParticipant("Alice@Example.com", "alice"), true);
  assert.equal(matchesParticipant("Alice", "bob"), false);

  // string[] field — true if ANY entry contains the needle.
  assert.equal(matchesParticipant(["bob@corp.com", "carol@corp.com"], "CAROL"), true);
  assert.equal(matchesParticipant(["bob@corp.com"], "dan"), false);
  assert.equal(matchesParticipant([], "anything"), false); // empty list, real needle
});

// ── activeFilterCount ───────────────────────────────────────────────────────────
test("activeFilterCount — read!=='all' counts 1, plus one per non-empty trimmed from/to/cc", () => {
  assert.equal(activeFilterCount(EMPTY_INBOX_FILTERS), 0);
  assert.equal(activeFilterCount({ ...EMPTY_INBOX_FILTERS, read: "unread" }), 1);
  assert.equal(activeFilterCount({ ...EMPTY_INBOX_FILTERS, read: "read" }), 1);
  assert.equal(activeFilterCount({ ...EMPTY_INBOX_FILTERS, from: "alice" }), 1);
  assert.equal(activeFilterCount({ read: "unread", from: "a", to: "b", cc: "c" }), 4);
  // Whitespace-only constraints don't count (trimmed empty).
  assert.equal(activeFilterCount({ read: "all", from: "   ", to: "\t", cc: " " }), 0);
  assert.equal(activeFilterCount({ read: "read", from: "x", to: "  ", cc: "y" }), 3);
});

// ── messageContent (body-with-preview-fallback for reading panes) ────────────────
test("messageContent — real body wins and is NOT flagged a summary", () => {
  assert.deepEqual(
    messageContent({ body: "full body text", preview: "short preview" }),
    { text: "full body text", isSummary: false },
  );
});

test("messageContent — empty/whitespace body falls back to preview, flagged isSummary", () => {
  // The reported bug: swept Gmail stubs carry a preview but an empty body.
  assert.deepEqual(
    messageContent({ body: "", preview: "Robin forwarded his VelaStack proposal." }),
    { text: "Robin forwarded his VelaStack proposal.", isSummary: true },
  );
  // Whitespace-only body counts as empty (so a stray "\n" body still falls back).
  assert.deepEqual(
    messageContent({ body: "   \n\t", preview: "a summary" }),
    { text: "a summary", isSummary: true },
  );
});

test("messageContent — both empty yields empty text the caller renders as a placeholder", () => {
  assert.deepEqual(messageContent({ body: "", preview: "" }), { text: "", isSummary: false });
  assert.deepEqual(messageContent({ body: "  ", preview: "  " }), { text: "", isSummary: false });
});

// ── ordering: semantic vs date ──────────────────────────────────────────────────
test("semanticOrder null — falls to the date-sort path (all structurally-matching msgs)", () => {
  const messages = [
    msg({ id: "M-OLD", receivedAt: "2026-05-01T00:00:00.000Z" }),
    msg({ id: "M-NEW", receivedAt: "2026-05-03T00:00:00.000Z" }),
    msg({ id: "M-MID", receivedAt: "2026-05-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    ids(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "newest", null)),
    ["M-NEW", "M-MID", "M-OLD"],
  );
});

test("semanticOrder non-null — restrict to ids in the order, ranked by relevance index", () => {
  const messages = [
    msg({ id: "M-1", receivedAt: "2026-05-01T00:00:00.000Z" }),
    msg({ id: "M-2", receivedAt: "2026-05-09T00:00:00.000Z" }), // newest by date…
    msg({ id: "M-3", receivedAt: "2026-05-05T00:00:00.000Z" }),
    msg({ id: "M-4", receivedAt: "2026-05-04T00:00:00.000Z" }), // not in the order → dropped
  ];
  // Relevance order intentionally disagrees with date order; the date `sort` is ignored.
  const out = selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "newest", ["M-3", "M-1", "M-2"]);
  assert.deepEqual(ids(out), ["M-3", "M-1", "M-2"]);
  // Same result whichever date sort is requested — semantic order wins.
  assert.deepEqual(
    ids(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "oldest", ["M-3", "M-1", "M-2"])),
    ["M-3", "M-1", "M-2"],
  );
});

test("semanticOrder [] — query active with zero hits => empty list", () => {
  const messages = [msg({ id: "M-1" }), msg({ id: "M-2" })];
  assert.deepEqual(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "newest", []), []);
});

test("semantic ordering still applies the structural filters first", () => {
  const messages = [
    msg({ id: "M-A", from: "alice@example.com" }),
    msg({ id: "M-B", from: "bob@example.com" }),
  ];
  // M-B is in the semantic order but fails the from filter → dropped.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, from: "alice" }, "newest", ["M-B", "M-A"])),
    ["M-A"],
  );
});

// ── date sort newest vs oldest ──────────────────────────────────────────────────
test("date sort — newest is descending, oldest is ascending by receivedAt", () => {
  const messages = [
    msg({ id: "M-OLD", receivedAt: "2026-05-01T00:00:00.000Z" }),
    msg({ id: "M-NEW", receivedAt: "2026-05-08T00:00:00.000Z" }),
    msg({ id: "M-MID", receivedAt: "2026-05-04T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    ids(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "newest", null)),
    ["M-NEW", "M-MID", "M-OLD"],
  );
  assert.deepEqual(
    ids(selectInboxMessages(messages, EMPTY_INBOX_FILTERS, "oldest", null)),
    ["M-OLD", "M-MID", "M-NEW"],
  );
});

// ── pinnedId (read-filter exemption) ────────────────────────────────────────────
test("pinnedId — a just-read message stays visible under the 'unread' filter", () => {
  const messages = [
    msg({ id: "M-PINNED", read: true, receivedAt: "2026-05-02T00:00:00.000Z" }), // was just opened
    msg({ id: "M-UNREAD", read: false, receivedAt: "2026-05-01T00:00:00.000Z" }),
    msg({ id: "M-OTHERREAD", read: true, receivedAt: "2026-05-03T00:00:00.000Z" }), // not pinned → filtered out
  ];
  const filters: InboxFilters = { ...EMPTY_INBOX_FILTERS, read: "unread" };
  // Without the pin, M-PINNED (now read) would vanish under the unread filter.
  assert.deepEqual(ids(selectInboxMessages(messages, filters, "newest", null)), ["M-UNREAD"]);
  // With the pin it stays; the other read message is still dropped.
  assert.deepEqual(
    ids(selectInboxMessages(messages, filters, "newest", null, "M-PINNED")),
    ["M-PINNED", "M-UNREAD"],
  );
});

test("pinnedId — exemption is for the read filter ONLY; from/to/cc still apply", () => {
  const messages = [
    msg({ id: "M-PINNED", read: true, from: "alice@example.com" }),
    msg({ id: "M-UNREAD", read: false, from: "bob@example.com" }),
  ];
  // The pinned message fails the from filter → dropped despite the read exemption.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { read: "unread", from: "bob", to: "", cc: "" }, "newest", null, "M-PINNED")),
    ["M-UNREAD"],
  );
});

test("pinnedId — when a semantic query is active, a pinned message NOT in the order is dropped", () => {
  const messages = [
    msg({ id: "M-PINNED", read: true }),
    msg({ id: "M-HIT", read: false }),
  ];
  // M-PINNED is exempt from the read filter but is not in semanticOrder → dropped.
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, read: "unread" }, "newest", ["M-HIT"], "M-PINNED")),
    ["M-HIT"],
  );
  // If the pinned message IS in the order, it survives (and follows relevance order).
  assert.deepEqual(
    ids(selectInboxMessages(messages, { ...EMPTY_INBOX_FILTERS, read: "unread" }, "newest", ["M-PINNED", "M-HIT"], "M-PINNED")),
    ["M-PINNED", "M-HIT"],
  );
});
