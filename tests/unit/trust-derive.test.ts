// Unit tests for the AUTOMATIC trust-derivation layer: board/lib/email.ts (deterministic
// address extraction/normalization) + board/lib/trust-derive.ts (the tight two-way-
// correspondence rule behind "trust-on-first-reply, made automatic"). Pure / in-memory —
// nothing reads board/data or the network. Run from the repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/trust-derive.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAddress, normalizeAddressList } from "../../board/lib/email.ts";
import { deriveTrustTargets } from "../../board/lib/trust-derive.ts";
import type { MessageRecord } from "../../board/lib/types.ts";

const PRINCIPAL = "rtanaka@gmail.com";

let counter = 0;
function msg(partial: Partial<MessageRecord>): MessageRecord {
  counter += 1;
  return {
    id: partial.id ?? `M-${counter}`,
    source: "gmail",
    from: "",
    subject: "",
    preview: "",
    body: "",
    receivedAt: "2026-06-01T00:00:00Z",
    read: false,
    ...partial,
  };
}

// ── board/lib/email.ts: extractAddress ──────────────────────────────────────────
test("extractAddress: bare address is lowercased", () => {
  assert.equal(extractAddress("Alice@Example.COM"), "alice@example.com");
});
test("extractAddress: display-name form yields the bracketed address", () => {
  assert.equal(extractAddress("Alice Smith <alice@x.com>"), "alice@x.com");
});
test("extractAddress: display-name CONTAINING @ is rejected (anti-spoof)", () => {
  assert.equal(extractAddress("ceo@corp.com <attacker@evil.com>"), null);
});
test("extractAddress: plain name / system id → null", () => {
  assert.equal(extractAddress("Jira Bot"), null);
  assert.equal(extractAddress("system"), null);
});
test("extractAddress: empty / whitespace / non-string → null", () => {
  assert.equal(extractAddress(""), null);
  assert.equal(extractAddress("   "), null);
  assert.equal(extractAddress(undefined), null);
  assert.equal(extractAddress(42), null);
});
test("extractAddress: stray brackets inside the angle form → null (no non-canonical key)", () => {
  assert.equal(extractAddress("X <<a@b.com>>"), null);
});

// ── board/lib/email.ts: normalizeAddressList ────────────────────────────────────
test("normalizeAddressList: array of mixed forms — deduped + lowercased, order preserved", () => {
  assert.deepEqual(
    normalizeAddressList(["Alice <alice@x.com>", "BOB@y.com", "alice@x.com"]),
    ["alice@x.com", "bob@y.com"],
  );
});
test("normalizeAddressList: comma- and semicolon-joined strings split", () => {
  assert.deepEqual(normalizeAddressList("a@x.com, b@y.com"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(normalizeAddressList("a@x.com; b@y.com"), ["a@x.com", "b@y.com"]);
});
test("normalizeAddressList: null/undefined → []", () => {
  assert.deepEqual(normalizeAddressList(undefined), []);
  assert.deepEqual(normalizeAddressList(null), []);
});
test("normalizeAddressList: non-email tokens are dropped", () => {
  assert.deepEqual(normalizeAddressList(["nope", "a@b.com"]), ["a@b.com"]);
});

// ── board/lib/trust-derive.ts: the rule ─────────────────────────────────────────
test("derive: no principal configured → no-op []", () => {
  const m = msg({ from: "alice@x.com" });
  assert.deepEqual(deriveTrustTargets({ message: m, linkedMessages: [m], principalEmail: "" }), []);
  assert.deepEqual(deriveTrustTargets({ message: m, linkedMessages: [m], principalEmail: null }), []);
});

test("derive (A) handshake: inbound from X + outbound to X → trust X", () => {
  const inbound = msg({ from: "alice@x.com", to: [PRINCIPAL] });
  const outbound = msg({ from: PRINCIPAL, to: ["alice@x.com"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound, linkedMessages: [inbound, outbound], principalEmail: PRINCIPAL }),
    ["alice@x.com"],
  );
});

test("derive: order-independent — outbound linked BEFORE the inbound still trusts", () => {
  const outbound = msg({ from: PRINCIPAL, to: ["alice@x.com"], outbound: true });
  const inbound = msg({ from: "alice@x.com", to: [PRINCIPAL] });
  assert.deepEqual(
    deriveTrustTargets({ message: inbound, linkedMessages: [outbound, inbound], principalEmail: PRINCIPAL }),
    ["alice@x.com"],
  );
});

test("derive (B) direct 1:1: sole-to, no-cc outbound trusts even without an inbound", () => {
  const outbound = msg({ from: PRINCIPAL, to: ["bob@y.com"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound, linkedMessages: [outbound], principalEmail: PRINCIPAL }),
    ["bob@y.com"],
  );
});

test("SECURITY: reply-all Cc bystander is NOT trusted (only the handshake correspondent)", () => {
  const inbound = msg({ from: "sender@partner.com", to: [PRINCIPAL], cc: ["exfil@attacker.com"] });
  const outbound = msg({ from: PRINCIPAL, to: ["sender@partner.com"], cc: ["exfil@attacker.com"], outbound: true });
  const targets = deriveTrustTargets({ message: outbound, linkedMessages: [inbound, outbound], principalEmail: PRINCIPAL });
  assert.deepEqual(targets, ["sender@partner.com"]);
  assert.ok(!targets.includes("exfil@attacker.com"), "Cc-only exfil address must not be trusted");
});

test("derive (C) origination: owner-originated GROUP send (no prior inbound) trusts ALL recipients (To + Cc)", () => {
  // The user COMPOSED a fresh group email — they chose every recipient, so trust them all,
  // To AND Cc. This is the origination relaxation: an origination's envelope is owner-chosen
  // (unlike a reply-all to a thread someone else started — see the SECURITY test below).
  const outbound = msg({
    from: PRINCIPAL,
    to: ["a@x.com", "b@x.com"],
    cc: ["c@x.com"],
    outbound: true,
  });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound, linkedMessages: [outbound], principalEmail: PRINCIPAL }).sort(),
    ["a@x.com", "b@x.com", "c@x.com"],
  );
});

test("derive (C) origination is order-independent: a later inbound reply does NOT retract the other recipients", () => {
  // The user originates a group send at 08:00; one recipient replies at 09:00. The origination
  // still precedes the inbound, so both originally-addressed parties stay trusted regardless of
  // which message triggered the derivation (compared on receivedAt, not link order).
  const origination = msg({ from: PRINCIPAL, to: ["a@x.com", "b@x.com"], outbound: true, receivedAt: "2026-06-01T08:00:00Z" });
  const reply = msg({ from: "a@x.com", to: [PRINCIPAL], receivedAt: "2026-06-01T09:00:00Z" });
  assert.deepEqual(
    deriveTrustTargets({ message: reply, linkedMessages: [origination, reply], principalEmail: PRINCIPAL }).sort(),
    ["a@x.com", "b@x.com"],
  );
});

test("SECURITY: reply-all to a thread SOMEONE ELSE started does NOT trust the room (only the handshake partner)", () => {
  // An inbound arrives FIRST (09:00); the user replies-all at 10:00 keeping a To/Cc room they
  // did NOT assemble. Because an inbound predates the outbound it is a REPLY, not an origination,
  // so rule (C) does not fire — only the genuine handshake partner (who wrote in) is trusted; the
  // attacker-added `to` and the bystander `cc` are not.
  const inbound = msg({
    from: "starter@partner.com",
    to: [PRINCIPAL],
    cc: ["bystander@x.com"],
    receivedAt: "2026-06-01T09:00:00Z",
  });
  const replyAll = msg({
    from: PRINCIPAL,
    to: ["starter@partner.com", "added@attacker.com"],
    cc: ["bystander@x.com"],
    outbound: true,
    receivedAt: "2026-06-01T10:00:00Z",
  });
  const targets = deriveTrustTargets({ message: replyAll, linkedMessages: [inbound, replyAll], principalEmail: PRINCIPAL });
  assert.deepEqual(targets, ["starter@partner.com"]);
  assert.ok(
    !targets.includes("added@attacker.com") && !targets.includes("bystander@x.com"),
    "a reply-all room (To added by the inbound thread, or Cc) must not be blanket-trusted",
  );
});

test("SECURITY: a mislabeled inbound (outbound:true but from≠principal) trusts nobody", () => {
  // A buggy/prompt-injected agent marks an INBOUND message outbound:true. Its sender is
  // not the principal, so it must NOT be treated as outbound — the attacker-chosen `to`
  // recipient must never be auto-trusted off a forged outbound flag.
  const mislabeled = msg({ from: "attacker@evil.com", to: ["victim@corp.com"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: mislabeled, linkedMessages: [mislabeled], principalEmail: PRINCIPAL }),
    [],
  );
});

test("SECURITY: a spoofed inbound From:<principal> contributes nothing (only the real partner trusts)", () => {
  // Attacker forges From: <you> on an inbound; a genuine 1:1 outbound to a real partner exists.
  const spoofedInbound = msg({ from: PRINCIPAL, to: ["someone@x.com"] }); // inbound (no outbound flag)
  const realOutbound = msg({ from: PRINCIPAL, to: ["partner@x.com"], outbound: true });
  const targets = deriveTrustTargets({
    message: spoofedInbound,
    linkedMessages: [spoofedInbound, realOutbound],
    principalEmail: PRINCIPAL,
  });
  assert.deepEqual(targets, ["partner@x.com"]); // the spoofed inbound mints no trust
});

test("SECURITY: thread co-member who never two-way-corresponded is NOT trusted", () => {
  const outboundToMain = msg({ from: PRINCIPAL, to: ["main@x.com"], outbound: true });
  const inboundMain = msg({ from: "main@x.com", to: [PRINCIPAL] });
  const inboundThird = msg({ from: "third@stranger.com", to: [PRINCIPAL, "main@x.com"] });
  const targets = deriveTrustTargets({
    message: inboundThird,
    linkedMessages: [outboundToMain, inboundMain, inboundThird],
    principalEmail: PRINCIPAL,
  });
  assert.deepEqual(targets, ["main@x.com"]);
});

test("derive: inbound on a case with ZERO outbound → nothing trusted", () => {
  const inbound = msg({ from: "alice@x.com", to: [PRINCIPAL] });
  assert.deepEqual(
    deriveTrustTargets({ message: inbound, linkedMessages: [inbound], principalEmail: PRINCIPAL }),
    [],
  );
});

test("derive: principal never trusts itself even if it appears in to/cc", () => {
  const outbound = msg({ from: PRINCIPAL, to: [PRINCIPAL], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound, linkedMessages: [outbound], principalEmail: PRINCIPAL }),
    [],
  );
});

test("derive: display-name forms in `to` are normalized; @-in-display-name is dropped", () => {
  const ok = msg({ from: PRINCIPAL, to: ["Bob <bob@y.com>"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: ok, linkedMessages: [ok], principalEmail: PRINCIPAL }),
    ["bob@y.com"],
  );
});

test("derive: case-insensitive principal + addresses", () => {
  const inbound = msg({ from: "Alice@X.com", to: ["RTANAKA@gmail.com"] });
  const outbound = msg({ from: "RTANAKA@gmail.com", to: ["alice@x.com"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound, linkedMessages: [inbound, outbound], principalEmail: "Rtanaka@Gmail.com" }),
    ["alice@x.com"],
  );
});

test("derive: idempotent / deduped — same correspondent across many messages trusted once", () => {
  const inbound = msg({ from: "alice@x.com", to: [PRINCIPAL] });
  const outbound1 = msg({ from: PRINCIPAL, to: ["alice@x.com"], outbound: true });
  const outbound2 = msg({ from: PRINCIPAL, to: ["alice@x.com"], outbound: true });
  assert.deepEqual(
    deriveTrustTargets({ message: outbound2, linkedMessages: [inbound, outbound1, outbound2], principalEmail: PRINCIPAL }),
    ["alice@x.com"],
  );
});
