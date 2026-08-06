// Unit tests for the mail-triage editorial-drop decision record's PURE layer (cos-ops#41):
// computeTriageSummary (board/lib/triage-decisions.ts — the ADR 0017 computed-on-read engine),
// normalizeTriageSender, recordTriageDrop's reversed-guard, and applyTriageResolution's two verbs
// (board/lib/store.ts). Pure, in-memory — nothing here reads or writes board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/triage-decisions.test.ts
//
// normalizeTriageSender's fixtures below are SYNTHETIC — they exercise the same non-bare shapes
// the architect measured against the live store (a bare address, an address-then-parenthetical,
// a display-name-with-the-address-inside-parens, an HTML-escaped angle form, a bare display name
// with no "@", and a real angle-bracket form) — never the real addresses/names themselves. This
// repo is public; no personal data belongs in a committed fixture, including test data (root
// CLAUDE.md's review checklist).

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTriageSummary } from "../../board/lib/triage-decisions.ts";
import {
  recordTriageDrop,
  applyTriageResolution,
  normalizeTriageSender,
  TriageReversedError,
} from "../../board/lib/store.ts";
import type { DBShape, TriageDecision, MessageRecord } from "../../board/lib/types.ts";

let seq = 0;
function td(over: Partial<TriageDecision> = {}): TriageDecision {
  seq += 1;
  return {
    id: `TD-${seq}`,
    sender: "sender@example.com",
    source: "gmail",
    reason: "notification",
    count: 1,
    firstSeen: "2026-07-01T09:00:00.000Z",
    lastSeen: "2026-07-01T09:00:00.000Z",
    status: "active",
    ...over,
  };
}

function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `M-${seq}`,
    source: "gmail",
    from: "someone@example.com",
    subject: "",
    preview: "",
    body: "",
    receivedAt: "2026-07-01T09:00:00.000Z",
    read: true,
    ...over,
  } as MessageRecord;
}

function mkDb(over: Partial<DBShape> = {}): DBShape {
  return {
    schemaVersion: 16,
    version: 1,
    cases: [],
    messages: [],
    ...over,
  };
}

// ── computeTriageSummary ──────────────────────────────────────────────────────

test("computeTriageSummary: two reasons for one sender group into ONE firstTime entry", () => {
  const db = mkDb({
    triageDecisions: [
      td({ id: "TD-1", sender: "a@example.com", reason: "notification", count: 5, firstSeen: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-03T00:00:00.000Z" }),
      td({ id: "TD-2", sender: "a@example.com", reason: "watch", count: 2, firstSeen: "2026-07-02T00:00:00.000Z", lastSeen: "2026-07-04T00:00:00.000Z" }),
    ],
  });

  const summary = computeTriageSummary(db, "gmail");
  assert.equal(summary.dropped, 7, "dropped sums count across BOTH rows");
  assert.equal(summary.senders, 1, "one distinct (sender,source) pair");
  assert.equal(summary.firstTime.length, 1, "grouped into one firstTime entry");
  const entry = summary.firstTime[0];
  assert.equal(entry.sender, "a@example.com");
  assert.equal(entry.reasons.length, 2, "the entry carries both reasons");
  assert.deepEqual(
    entry.reasons.sort((x, y) => x.reason.localeCompare(y.reason)),
    [
      { reason: "notification", count: 5 },
      { reason: "watch", count: 2 },
    ].sort((x, y) => x.reason.localeCompare(y.reason)),
  );
  assert.deepEqual(new Set(entry.ids), new Set(["TD-1", "TD-2"]), "ids carries both TD ids to resolve");
  assert.equal(entry.firstSeen, "2026-07-01T00:00:00.000Z", "firstSeen is the MIN over the group");
  assert.equal(entry.lastSeen, "2026-07-04T00:00:00.000Z", "lastSeen is the MAX over the group");
});

test("computeTriageSummary: a reviewed row is excluded from firstTime but still counted in dropped/senders", () => {
  const db = mkDb({
    triageDecisions: [td({ sender: "b@example.com", count: 4, reviewedAt: "2026-07-05T00:00:00.000Z" })],
  });
  const summary = computeTriageSummary(db, "gmail");
  assert.equal(summary.dropped, 4, "reviewed rows still count toward dropped");
  assert.equal(summary.senders, 1, "reviewed rows still count toward senders");
  assert.equal(summary.firstTime.length, 0, "a reviewed (settled) sender never appears in firstTime");
});

test("computeTriageSummary: a reversed row is excluded from firstTime but still counted in dropped/senders", () => {
  const db = mkDb({
    triageDecisions: [td({ sender: "c@example.com", count: 3, status: "reversed", reviewedAt: "2026-07-06T00:00:00.000Z" })],
  });
  const summary = computeTriageSummary(db, "gmail");
  assert.equal(summary.dropped, 3, "history doesn't un-happen — reversed rows still count toward dropped");
  assert.equal(summary.senders, 1);
  assert.equal(summary.firstTime.length, 0, "a reversed sender never appears in firstTime");
});

test("computeTriageSummary: the source filter scopes dropped/senders/firstTime/promoted together", () => {
  const db = mkDb({
    triageDecisions: [
      td({ sender: "whatsapp-sender", source: "whatsapp", count: 9 }),
      td({ sender: "d@example.com", source: "gmail", count: 1 }),
    ],
    messages: [msg({ source: "gmail" }), msg({ source: "whatsapp" }), msg({ source: "whatsapp" })],
  });

  const gmailOnly = computeTriageSummary(db, "gmail");
  assert.equal(gmailOnly.dropped, 1, "the whatsapp row is excluded from dropped under source:gmail");
  assert.equal(gmailOnly.senders, 1);
  assert.equal(gmailOnly.firstTime.length, 1);
  assert.equal(gmailOnly.firstTime[0]?.sender, "d@example.com");
  assert.equal(gmailOnly.promoted, 1, "promoted also scopes to gmail messages only");

  const unfiltered = computeTriageSummary(db);
  assert.equal(unfiltered.dropped, 10, "unfiltered dropped sums BOTH sources' rows (9 + 1)");
  assert.equal(unfiltered.senders, 2);
  assert.equal(unfiltered.promoted, 3, "unfiltered promoted counts every message regardless of source");
});

test("computeTriageSummary: promoted is messages-derived and independent of triageDecisions", () => {
  const db = mkDb({
    triageDecisions: [],
    messages: [msg({ source: "gmail" }), msg({ source: "gmail" }), msg({ source: "jira" })],
  });
  assert.equal(computeTriageSummary(db, "gmail").promoted, 2);
  assert.equal(computeTriageSummary(db, "jira").promoted, 1);
  assert.equal(computeTriageSummary(db).promoted, 3);
  assert.equal(computeTriageSummary(db, "gmail").dropped, 0, "no decisions yet — dropped is 0");
});

// ── normalizeTriageSender ─────────────────────────────────────────────────────
// Synthetic rows exercising each measured non-bare SHAPE (never real addresses — see header).

test("normalizeTriageSender: extracts the addr-spec, never a name fragment, across every measured shape", () => {
  assert.equal(normalizeTriageSender("dan@example.com"), "dan@example.com", "a bare address rides through lowercased");
  assert.equal(
    normalizeTriageSender("promo@example.com (unsubscribe here)"),
    "promo@example.com",
    "address-then-parenthetical: the parenthetical is dropped, not merged in",
  );
  assert.equal(
    normalizeTriageSender("Alex Rivera (Alex.Rivera@example.com)"),
    "alex.rivera@example.com",
    "display-name-then-parens-address: the address INSIDE the parens wins, mixed case lowercased — never the first name",
  );
  assert.equal(
    normalizeTriageSender("Updates (via Example) &lt;abc123@mail.example.com&gt;"),
    "abc123@mail.example.com",
    "HTML-escaped angle brackets are unescaped-and-extracted",
  );
  assert.equal(
    normalizeTriageSender("Jordan Lee"),
    "jordan lee",
    "a bare display name with no '@' falls back to the whole trimmed lowercased value — never a name fragment",
  );
  assert.equal(
    normalizeTriageSender("Sales Team <sales@example.com>"),
    "sales@example.com",
    "real angle brackets extract the address",
  );
  assert.equal(
    normalizeTriageSender("  Foo@Example.COM  "),
    "foo@example.com",
    "trims surrounding whitespace and lowercases",
  );
});

test("normalizeTriageSender: two representations of one human collapse to the SAME key (the reversal guarantee)", () => {
  // The exact failure mode the architect caught in the plan draft: a first-whitespace-token rule
  // would key "Alex Rivera (Alex.Rivera@example.com)" as "alex" and a bare
  // "alex.rivera@example.com" as itself — two keys for one human, silently breaking a reversal.
  assert.equal(
    normalizeTriageSender("Alex Rivera (Alex.Rivera@example.com)"),
    normalizeTriageSender("alex.rivera@example.com"),
    "the parenthesized-address form and the bare address normalize to the same key",
  );
});

// ── recordTriageDrop: the reversed-guard throw ────────────────────────────────

test("recordTriageDrop: a reversed (sender,source) refuses ANY further drop, any reason, fail-closed", () => {
  const reversedRow = td({ id: "TD-9", sender: "reversed@example.com", source: "gmail", reason: "watch", status: "reversed" });
  const db = mkDb({ triageDecisions: [reversedRow] });

  assert.throws(
    () => recordTriageDrop(db, { sender: "reversed@example.com", source: "gmail", reason: "open_loop" }),
    (err: unknown) => {
      assert.ok(err instanceof TriageReversedError, "throws TriageReversedError");
      assert.equal((err as TriageReversedError).decision.id, "TD-9", "carries the reversed row");
      return true;
    },
  );
  // The refusal must not have mutated the store — no new row, the existing one untouched.
  assert.equal(db.triageDecisions?.length, 1, "no new row was added by the refused attempt");
  assert.equal(db.triageDecisions?.[0]?.count, 1, "the reversed row's count is untouched");
});

test("recordTriageDrop: a first drop creates a row; a repeat of the same key bumps count, adds none", () => {
  const db = mkDb({ triageDecisions: [] });

  const first = recordTriageDrop(db, { sender: "Fresh@Example.com (via list)", source: "gmail", reason: "no_stakes" });
  assert.equal(first.created, true);
  assert.equal(first.decision.sender, "fresh@example.com", "normalized on write");
  assert.equal(first.decision.count, 1);

  const second = recordTriageDrop(db, { sender: "fresh@example.com", source: "gmail", reason: "no_stakes" });
  assert.equal(second.created, false, "same (sender,source,reason) → bump, not a new row");
  assert.equal(second.decision.count, 2);
  assert.equal(second.decision.id, first.decision.id, "the SAME row was bumped");
  assert.equal(db.triageDecisions?.length, 1, "still exactly one row");

  const differentReason = recordTriageDrop(db, { sender: "fresh@example.com", source: "gmail", reason: "watch" });
  assert.equal(differentReason.created, true, "a different reason for the same sender is a SIBLING row, not a bump");
  assert.equal(db.triageDecisions?.length, 2);
});

// ── applyTriageResolution: the two verbs ──────────────────────────────────────

test("applyTriageResolution: 'confirm' stamps reviewedAt only — status stays active", () => {
  const rec = td({ status: "active" });
  const before = rec.reviewedAt;
  applyTriageResolution(rec, "confirm");
  assert.equal(rec.status, "active", "confirm never flips status");
  assert.notEqual(rec.reviewedAt, before);
  assert.ok(typeof rec.reviewedAt === "string" && !Number.isNaN(Date.parse(rec.reviewedAt)), "reviewedAt is a valid ISO stamp");
});

test("applyTriageResolution: 'reverse' stamps reviewedAt AND flips status to reversed", () => {
  const rec = td({ status: "active" });
  applyTriageResolution(rec, "reverse");
  assert.equal(rec.status, "reversed");
  assert.ok(typeof rec.reviewedAt === "string" && !Number.isNaN(Date.parse(rec.reviewedAt)));
});

test("applyTriageResolution: idempotent re-calls just restamp reviewedAt", () => {
  const rec = td({ status: "active" });
  applyTriageResolution(rec, "confirm");
  const first = rec.reviewedAt;
  applyTriageResolution(rec, "confirm");
  assert.equal(rec.status, "active");
  assert.ok(typeof rec.reviewedAt === "string", "still a valid stamp after a second confirm");
  void first; // both calls stamp "now" — equality isn't asserted (same-tick clocks can coincide)
});
