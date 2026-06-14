// Pure inbox selector layer over MessageRecord[]. No React, no fetch, no I/O —
// every function is deterministic given its inputs. This is the SINGLE SOURCE OF
// TRUTH for inbox filtering/sorting so the inbox view stays a thin renderer and
// all the precedence rules (read-state, from/to/cc substring, the pinned-message
// exemption, and semantic-vs-date ordering) live in one unit-testable place.

import type { MessageRecord } from "./types";

export type InboxReadFilter = "all" | "unread" | "read";
export type InboxSort = "newest" | "oldest";

export interface InboxFilters {
  read: InboxReadFilter;
  from: string; // case-insensitive substring; "" = unconstrained
  to: string;
  cc: string;
}

// The no-constraints starting point: every message passes.
export const EMPTY_INBOX_FILTERS: InboxFilters = { read: "all", from: "", to: "", cc: "" };

// Count of active constraints for a UI badge: read !== "all" counts as 1, plus one
// for each of from/to/cc whose trimmed value is non-empty. Deliberately does NOT
// count the semantic search query — that has its own indicator.
export function activeFilterCount(f: InboxFilters): number {
  let n = 0;
  if (f.read !== "all") n += 1;
  if (f.from.trim() !== "") n += 1;
  if (f.to.trim() !== "") n += 1;
  if (f.cc.trim() !== "") n += 1;
  return n;
}

// Case-insensitive substring test against a from/to/cc value that may be a single
// string, a list of strings, or undefined. An empty/whitespace needle imposes no
// constraint (=> true). A string[] matches if ANY entry contains the needle.
export function matchesParticipant(field: string | string[] | undefined, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (q === "") return true; // no constraint
  if (field === undefined) return false;
  const values = Array.isArray(field) ? field : [field];
  return values.some((v) => v.toLowerCase().includes(q));
}

// Whether a message clears the structural from/to/cc filters (read-state handled
// separately so the pinned message can be exempted from it).
function matchesParticipantFilters(m: MessageRecord, filters: InboxFilters): boolean {
  return (
    matchesParticipant(m.from, filters.from) &&
    matchesParticipant(m.to, filters.to) &&
    matchesParticipant(m.cc, filters.cc)
  );
}

// Whether a message clears the read-state filter.
function matchesReadFilter(m: MessageRecord, read: InboxReadFilter): boolean {
  if (read === "unread") return !m.read;
  if (read === "read") return m.read;
  return true; // "all"
}

// The ONE selector the inbox view renders. Precedence:
//   1. Structural filters always apply: read-state AND from/to/cc substring.
//      EXCEPTION: the message whose id === pinnedId is EXEMPT from the READ
//      filter only (so opening an unread message while the "unread" filter is on
//      doesn't make it vanish from under the cursor). The pinned message must
//      still satisfy from/to/cc AND, when a semantic query is active, still be
//      present in semanticOrder.
//   2. Ordering:
//      - semanticOrder !== null → keep ONLY messages whose id is in semanticOrder,
//        ordered by their index in semanticOrder (relevance); `sort` is ignored.
//      - else → order by receivedAt per `sort` ("newest" = desc, "oldest" = asc).
export function selectInboxMessages(
  messages: MessageRecord[],
  filters: InboxFilters,
  sort: InboxSort,
  semanticOrder: string[] | null,
  pinnedId?: string | null,
): MessageRecord[] {
  // Structural filtering. The pinned message is exempt from the read filter only.
  const filtered = messages.filter((m) => {
    if (!matchesParticipantFilters(m, filters)) return false;
    const exemptFromRead = pinnedId != null && m.id === pinnedId;
    if (!exemptFromRead && !matchesReadFilter(m, filters.read)) return false;
    return true;
  });

  if (semanticOrder !== null) {
    // Semantic query active: restrict to ids in semanticOrder and order by their
    // relevance index. Anything not in the order (incl. an exempt pinned message)
    // is dropped. `sort` is ignored. An empty order yields an empty list.
    const rank = new Map(semanticOrder.map((id, i) => [id, i]));
    return filtered
      .filter((m) => rank.has(m.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  }

  // Date-sort path. "newest" = most-recent first (desc), "oldest" = ascending.
  const dir = sort === "newest" ? -1 : 1;
  return filtered
    .slice()
    .sort((a, b) => (new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()) * dir);
}

// The messages the user still owes a reply to, newest-first. UNANSWERED ===
// flagged as awaiting a reply (needsAnswer) AND not yet answered (no answeredAt);
// marking answered sets answeredAt, so the row leaves this view. Pure (no I/O),
// mirroring selectInboxMessages — the single source of truth for the unanswered set.
export function selectUnansweredMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages
    .filter((m) => m.needsAnswer === true && !m.answeredAt)
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}

// The text to render as a message's full content in a reading pane. Prefer the
// real `body`; when it's empty/whitespace — a SUMMARY-ONLY stub (e.g. a Gmail
// message linked with just a preview, or one whose raw body the guard withheld) —
// fall back to the `preview` so the pane is never blank. `isSummary` lets the
// caller label that fallback so it isn't mistaken for the full message. Both
// fields empty → empty text the caller can render as a muted placeholder. Kept
// here (the pure inbox layer) so every surface that shows a body agrees.
export function messageContent(
  m: Pick<MessageRecord, "body" | "preview">,
): { text: string; isSummary: boolean } {
  if (m.body.trim() !== "") return { text: m.body, isSummary: false };
  if (m.preview.trim() !== "") return { text: m.preview, isSummary: true };
  return { text: "", isSummary: false };
}
