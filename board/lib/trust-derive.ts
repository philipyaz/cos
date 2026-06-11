// Pure, deterministic trust DERIVATION over a case's linked messages — the engine
// behind "trust-on-first-reply, made automatic". No React, no fetch, no I/O: given the
// message just linked, the case's other linked messages, and the principal (the board
// owner's) address, it returns the set of correspondent addresses that have EARNED the
// guard `trusted` tier. The board route calls this INSIDE its store mutation (purely,
// from the in-memory db) and pushes the result to the guard sidecar AFTER the write —
// the agent never calls trust_sender. A LEAF module (imports only ./types as types +
// ./email) so the node --test unit suite can load it through the ts-resolve hook.
//
// THE RULE — trust GENUINE TWO-WAY correspondence OR a conversation the user ORIGINATED,
// never mere thread co-membership on a thread someone ELSE started (To/Cc/From on a REPLY
// are attacker-influenced envelope fields). An address X is trusted on a case iff X is a
// valid, non-principal email AND any of:
//   (A) HANDSHAKE — X wrote in (X is the `from` of some INBOUND message on the case)
//       AND the user replied to X (X is in the `to` of some OUTBOUND message); or
//   (B) DIRECT 1:1 — X is the SOLE `to` recipient of an OUTBOUND message that has NO cc
//       (a message the user composed directly to X); or
//   (C) ORIGINATION — X is a `to` OR `cc` recipient of an OUTBOUND message the user
//       ORIGINATED (no inbound message in the case predates it — the user STARTED the
//       conversation, so they chose every recipient themselves). Here Cc IS trusted,
//       because an origination's envelope is owner-chosen, not attacker-assembled.
// On a REPLY (any inbound message predates the outbound — ties count as "predates") rule
// (C) does NOT fire — only (A)/(B) — so a reply-all to a thread someone else started never
// blanket-trusts the room (the bystander-Cc case the tight rule was built to stop).
// "Predates" is compared on `receivedAt` (the real Gmail times), so the verdict is
// independent of link order; an unparseable/absent time is treated conservatively (such an
// outbound is never an origination; an undated inbound blocks origination for the case).
// A message counts as OUTBOUND only via its explicit `outbound` flag, set SOLELY from the
// Gmail SENT scan (the user's own outbox) — never inferred from `from === principal`, so a
// spoofed "From: <you>" inbound can never mint trust. If the principal is unknown, NOTHING
// is trusted (we cannot tell "the user" from anyone else).
//
// RESIDUAL EDGE (accepted): if the user REPLIES to an inbound that is NOT linked to this
// case (so the case holds no earlier inbound), the reply looks like an origination and its
// recipients are trusted. The mail-to-board sweep links BOTH directions onto one case, so
// the triggering inbound is normally present; and trusting an owner-chosen reply room is the
// policy opted into for originations.

import type { MessageRecord } from "./types";
import { extractAddress, normalizeAddressList } from "./email";

export interface DeriveTrustInput {
  message?: MessageRecord; // the message just linked (OPTIONAL — omit for a set-only re-derive, e.g. after a merge/relink)
  linkedMessages: MessageRecord[]; // ALL messages linked to the NODE — a case OR a reminder — i.e. the conversation set (may already include `message`)
  principalEmail: string | null | undefined; // the board owner's address; unset/empty ⇒ no-op
}

// Parse an ISO/RFC `receivedAt` into epoch-ms for ordering; null when missing/unparseable.
function parseTime(s: unknown): number | null {
  if (typeof s !== "string" || s.trim() === "") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function deriveTrustTargets(input: DeriveTrustInput): string[] {
  const principal =
    typeof input.principalEmail === "string" ? input.principalEmail.trim().toLowerCase() : "";
  // No principal configured ⇒ we cannot distinguish "the user" from anyone else ⇒ trust
  // NOTHING (never widen trust to a whole thread when we don't know who the user is).
  if (principal === "") return [];

  // Merge the just-linked message with the node's existing messages, de-duped by id
  // (the route passes a linkedMessages list that already includes `message`). Recomputing
  // from the full set each link makes the result ORDER-INDEPENDENT and idempotent.
  const byId = new Map<string, MessageRecord>();
  for (const m of input.linkedMessages || []) if (m && typeof m.id === "string") byId.set(m.id, m);
  if (input.message && typeof input.message.id === "string") byId.set(input.message.id, input.message);
  const messages = [...byId.values()];

  const inboundFroms = new Set<string>(); // `from` of inbound messages (X wrote in)
  const outboundTos = new Set<string>(); // `to` of outbound messages (the user wrote to X)
  const direct = new Set<string>(); // sole-to / no-cc outbound recipients (a 1:1 the user composed)

  // Outbound messages held for the origination pass (rule C), plus the earliest arrival of
  // any NON-outbound (inbound) message — the anchor that tells a fresh origination apart
  // from a reply. We compare real `receivedAt` times, so the verdict is link-order-independent.
  const outboundMsgs: { tos: string[]; ccs: string[]; time: number | null }[] = [];
  let earliestInbound: number | null = null;

  for (const m of messages) {
    // A message counts as OUTBOUND for trust ONLY when the flag is set AND its sender
    // resolves to the principal. This makes the "unspoofable" claim true in CODE, not
    // just in skill prose: a mislabeled / prompt-injected inbound (outbound:true but
    // from ≠ you) falls through to the inbound branch below, so its attacker-chosen `to`
    // recipients are never trusted. A genuine SENT-scan message always has from ===
    // principal, so this rejects nothing legitimate (send-as aliases stay manual).
    if (m.outbound === true && extractAddress(m.from) === principal) {
      const tos = normalizeAddressList(m.to).filter((a) => a !== principal);
      const ccs = normalizeAddressList(m.cc).filter((a) => a !== principal);
      for (const a of tos) outboundTos.add(a);
      if (tos.length === 1 && ccs.length === 0) direct.add(tos[0]); // rule (B)
      outboundMsgs.push({ tos, ccs, time: parseTime(m.receivedAt) });
    } else {
      const f = extractAddress(m.from);
      if (f && f !== principal) inboundFroms.add(f);
      // Count EVERY non-outbound message toward the inbound-arrival anchor (even a
      // from-principal / undated one — conservative: it can only make a later outbound look
      // like a reply, never widen trust). An unparseable time becomes a -Infinity sentinel
      // that predates everything, so it blocks origination for the whole case.
      const t = parseTime(m.receivedAt);
      if (t === null) earliestInbound = -Infinity;
      else if (earliestInbound === null || t < earliestInbound) earliestInbound = t;
    }
  }

  // Rule (C) ORIGINATION: an outbound the user STARTED the conversation with — strictly
  // before every inbound (ties count as a reply) — trusts ALL its recipients (To AND Cc),
  // because the user chose the envelope. With NO inbound on the case at all, every outbound
  // is an origination. An outbound with an unparseable time is never an origination.
  const originated = new Set<string>();
  for (const o of outboundMsgs) {
    const isOrigination = o.time !== null && (earliestInbound === null || o.time < earliestInbound);
    if (isOrigination) {
      for (const a of o.tos) originated.add(a);
      for (const a of o.ccs) originated.add(a);
    }
  }

  const trusted = new Set<string>();
  for (const f of inboundFroms) if (outboundTos.has(f)) trusted.add(f); // (A) handshake
  for (const d of direct) trusted.add(d); // (B) direct 1:1
  for (const o of originated) trusted.add(o); // (C) origination (To + Cc, owner-chosen)
  trusted.delete(principal); // belt-and-suspenders: never trust the principal
  return [...trusted];
}
