"use client";

// Inbox triage — the hand-operated twin of the ingest router. This is a client
// component: it seeds `messages`/`cases` from SSR props into local state so every
// triage action (mark read, create-case-from-message, link/unlink) reflects
// OPTIMISTICALLY and reverts on failure. Mutations flow through board-client —
// the same HTTP API the agent's MCP path hits:
//   • read/unread → updateMessage(id, { read })           (revives the inert dot
//     + the sidebar unread badge's data source)
//   • message → NEW case → createCase(...) then updateMessage(id, { caseId })
//   • message → EXISTING case → updateMessage(id, { caseId })   (maintains both
//     sides: message.caseId + case.messageIds, server-side)
//   • unlink → updateMessage(id, { caseId: null })
//
// The visible list is NOT derived here — it comes from selectInboxMessages in
// lib/inbox.ts, the pure single-source-of-truth for read-state / from·to·cc /
// semantic-vs-date precedence. The component only owns the client view state
// (search query + its semantic order, the InboxFilters, the date sort) and feeds
// it to that selector. Mail search rides the same fail-safe POST /api/search the
// command palette uses (semantic ranking, transparent keyword fallback), scoped
// to messages — so a missing sidecar degrades to keyword, never an error.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseRecord, CaseDomain, MessageRecord } from "@/lib/types";
import { LANES } from "@/lib/types";
import { relativeTime, domainLabel, domainClasses } from "@/lib/format";
import {
  EMPTY_INBOX_FILTERS,
  activeFilterCount,
  messageContent,
  selectInboxMessages,
} from "@/lib/inbox";
import type { InboxFilters, InboxSort } from "@/lib/inbox";
import {
  IconCircle,
  IconCheckCircle,
  IconChevronDown,
  IconDot,
  IconFilter,
  IconInbox,
  IconMore,
  IconPlus,
  IconSearch,
  IconWarning,
} from "@/components/icons";
import { SourceIcon } from "@/components/shared/source-icon";
import { MessageLink } from "@/components/shared/message-link";
import { messageDeepLink } from "@/lib/message-url";
import {
  createCase,
  searchBatch,
  updateMessage,
} from "@/lib/board-client";

export function InboxView({
  now,
  messages: initialMessages,
  cases: initialCases,
}: {
  now: string;
  messages: MessageRecord[];
  cases: CaseRecord[];
}) {
  // Seed SSR props into state so triage updates are immediate. (A later live-SSE
  // pass on the board surface refetches on agent writes; here we hold the
  // optimistic copy so the human's own actions land without a round-trip wait.)
  const [messages, setMessages] = useState<MessageRecord[]>(initialMessages);
  const [cases, setCases] = useState<CaseRecord[]>(initialCases);
  const [error, setError] = useState<string | null>(null);

  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives relativeTime on the
  // rows + detail pane. Never `new Date()` during render (no SSR/hydration drift).
  const clock = useMemo(() => new Date(now), [now]);

  // ── View state (the inputs to the pure selector) ────────────────────────────
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_INBOX_FILTERS);
  const [sort, setSort] = useState<InboxSort>("newest");
  const [showFilters, setShowFilters] = useState(false);

  // Overflow menu in the list header. "Mark all read" is now a surfaced button;
  // this menu holds the rarer inverse (mark all unread).
  const [bulkMenu, setBulkMenu] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);

  // Semantic search wiring (mirrors command-palette.tsx). `semanticOrder` is the
  // ranked message-id list from /api/search (null = no active query → date-sort
  // path); `engine` records which path answered for the inline badge.
  const [semanticOrder, setSemanticOrder] = useState<string[] | null>(null);
  const [engine, setEngine] = useState<"semantic" | "keyword" | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0); // guards against out-of-order /api/search responses

  // Seed the selection from the DEFAULT view (newest-first), not raw store order,
  // so the opened/highlighted message matches the top of the rendered list on load.
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      selectInboxMessages(initialMessages, EMPTY_INBOX_FILTERS, "newest", null)[0]
        ?.id ?? null
  );

  // Debounced semantic search, scoped to messages. Trimmed length ≥ 2 hits the
  // route; below that we drop back to the date-sort path. Out-of-order responses
  // are discarded via the seq counter. The route is fail-safe, so a failure just
  // clears the searching flag — we never surface a search error to the user.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Invalidate any in-flight ≥2-char request whose 200ms timer already
      // fired: bumping seq makes its `id === seq.current` guard fail so the
      // stale resolve is discarded, keeping the empty box on the date-sort path.
      seq.current += 1;
      setSemanticOrder(null);
      setEngine(null);
      setSearching(false);
      return;
    }
    const id = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchBatch(q, { k: 50, types: ["message"] })
        .then((r) => {
          if (id !== seq.current) return; // a newer query already fired
          setSemanticOrder(r.merged.messages.map((m) => m.id));
          setEngine(r.engine);
          setSearching(false);
        })
        .catch(() => {
          if (id === seq.current) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // The ONE list the view renders — pure selector over all the view state. We
  // pass selectedId as pinnedId so the open message doesn't vanish out from under
  // the cursor when it's auto-marked read under the "unread" filter.
  const visible = useMemo(
    () => selectInboxMessages(messages, filters, sort, semanticOrder, selectedId),
    [messages, filters, sort, semanticOrder, selectedId]
  );

  // The header unread badge counts ALL messages, not the filtered view.
  const unreadCount = messages.filter((m) => !m.read).length;
  const filterCount = activeFilterCount(filters);

  // Bulk-action availability is scoped to the VISIBLE set (what the action
  // operates on): "Mark all read" needs an unread row in view, and vice versa.
  const visibleHasUnread = visible.some((m) => !m.read);
  const visibleHasRead = visible.some((m) => m.read);

  const selected = messages.find((m) => m.id === selectedId) ?? null;
  const linkedCase =
    selected?.caseId
      ? cases.find((c) => c.id === selected.caseId) ?? null
      : null;

  // ── Selection reconciliation ────────────────────────────────────────────────
  // When the filtered list changes such that the selection is no longer present,
  // fall to the first visible message (or null). Guard on the id so we don't
  // re-set state every render and thrash.
  useEffect(() => {
    if (selectedId !== null && visible.some((m) => m.id === selectedId)) return;
    const next = visible[0]?.id ?? null;
    if (next !== selectedId) setSelectedId(next);
  }, [visible, selectedId]);

  // Close the bulk-actions menu on outside-click or Escape (only wired while
  // open). Pointerdown catches the dismissing click before it lands elsewhere.
  useEffect(() => {
    if (!bulkMenu) return;
    function onPointerDown(e: PointerEvent) {
      if (!bulkMenuRef.current?.contains(e.target as Node)) setBulkMenu(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setBulkMenu(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bulkMenu]);

  // ── Optimistic helpers ──────────────────────────────────────────────────────
  // Patch one message in local state and return the previous snapshot so a failed
  // request can revert. All mutators below share this shape: apply → call → on
  // throw, revert + surface the error text.
  function patchMessage(id: string, patch: Partial<MessageRecord>): void {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  }

  async function setRead(id: string, read: boolean): Promise<void> {
    const prev = messages.find((m) => m.id === id);
    if (!prev || prev.read === read) return;
    setError(null);
    patchMessage(id, { read });
    try {
      await updateMessage(id, { read });
    } catch (e) {
      patchMessage(id, { read: prev.read }); // revert
      setError(e instanceof Error ? e.message : "Failed to update message");
    }
  }

  // Bulk read/unread over the currently VISIBLE (filtered) set — the standard
  // mail-client "mark all read" semantics: only the rows you can see, and only
  // those whose state differs (m.read !== read). One optimistic setMessages map
  // flips them all at once; each server write fires in parallel. If ANY write
  // fails we revert EVERY targeted id back to its prior read-state and surface
  // the error (reusing the single-row error UI). No-op when nothing differs.
  async function setManyRead(read: boolean): Promise<void> {
    const targets = visible.filter((m) => m.read !== read).map((m) => m.id);
    if (targets.length === 0) return;
    const ids = new Set(targets);
    setError(null);
    setMessages((prev) =>
      prev.map((m) => (ids.has(m.id) ? { ...m, read } : m))
    );
    const results = await Promise.allSettled(
      targets.map((id) => updateMessage(id, { read }))
    );
    if (results.some((r) => r.status === "rejected")) {
      // Revert all targeted ids to their prior (pre-flip) read-state.
      setMessages((prev) =>
        prev.map((m) => (ids.has(m.id) ? { ...m, read: !read } : m))
      );
      const reason = results.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      setError(
        reason?.reason instanceof Error
          ? reason.reason.message
          : "Failed to update messages"
      );
    }
  }

  // Selecting a message marks it read (mirrors "opening" it).
  function selectMessage(id: string): void {
    setSelectedId(id);
    const m = messages.find((x) => x.id === id);
    if (m && !m.read) void setRead(id, true);
  }

  async function linkToCase(messageId: string, caseId: string): Promise<void> {
    const prev = messages.find((m) => m.id === messageId);
    if (!prev) return;
    setError(null);
    patchMessage(messageId, { caseId });
    try {
      const res = await updateMessage(messageId, { caseId });
      // Reconcile from the server message (authoritative both-sides linkage).
      patchMessage(messageId, res.message);
    } catch (e) {
      patchMessage(messageId, { caseId: prev.caseId });
      setError(e instanceof Error ? e.message : "Failed to link message");
    }
  }

  async function unlinkFromCase(messageId: string): Promise<void> {
    const prev = messages.find((m) => m.id === messageId);
    if (!prev) return;
    setError(null);
    patchMessage(messageId, { caseId: undefined });
    try {
      await updateMessage(messageId, { caseId: null });
    } catch (e) {
      patchMessage(messageId, { caseId: prev.caseId });
      setError(e instanceof Error ? e.message : "Failed to unlink message");
    }
  }

  // Create a fresh case seeded from the message, then link the message to it.
  // Optimism here is partial (we await the new id before linking) but the new
  // case appears in the picker/linked panel immediately on success.
  async function createCaseFromMessage(
    message: MessageRecord,
    domain: CaseDomain
  ): Promise<void> {
    setError(null);
    try {
      const res = await createCase({
        title: message.subject || `Message from ${message.from}`,
        summary: message.preview || message.body.slice(0, 140),
        status: "todo",
        domain,
        actor: "human",
      });
      const created = res.case;
      setCases((prev) => [created, ...prev]);
      await linkToCase(message.id, created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create case");
    }
  }

  // Relevance ordering wins while a semantic query is active, so the date sort is
  // inert then — keep the toggle clickable but dim it (it still records the
  // user's preferred order for when they clear the search).
  const sortInert = semanticOrder !== null;

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-[380px] shrink-0 border-r border-ink-100 flex flex-col">
        <div className="h-12 px-4 flex items-center gap-2 border-b border-ink-100">
          <IconInbox className="w-4 h-4 text-ink-400 shrink-0" />
          <span className="text-[14px] font-semibold text-ink-900">Inbox</span>
          {/* "showing N of M" — the filtered count vs the whole inbox. */}
          <span className="text-[11px] text-ink-400 tabular-nums">
            {visible.length} of {messages.length}
          </span>
          {/* Right-side cluster: unread pill, the primary "Mark all read"
              button (surfaced as icon + label for discoverability), then the
              overflow menu holding the rarer inverse (mark all unread). */}
          <div className="ml-auto flex items-center gap-2">
            {/* Unread count as a sky-tinted pill (only when there's something
                unread); falls back to nothing rather than a bare "0". */}
            {unreadCount > 0 && (
              <span
                className="inline-grid place-items-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-sky-50 text-sky-700 ring-1 ring-sky-200 text-[10.5px] font-medium tabular-nums"
                aria-label={`${unreadCount} unread`}
              >
                {unreadCount}
              </span>
            )}

            {/* Primary bulk action, surfaced as icon + text (was buried in the
                overflow). Operates on the VISIBLE (filtered) set; disabled when
                nothing in view is unread to flip. */}
            <button
              onClick={() => void setManyRead(true)}
              disabled={!visibleHasUnread}
              aria-disabled={!visibleHasUnread}
              title="Mark all messages in view as read"
              className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-2 rounded-md border border-ink-200 text-[12px] font-medium text-ink-700 enabled:hover:bg-ink-50 enabled:hover:border-ink-300 transition disabled:text-ink-300 disabled:border-ink-100 disabled:cursor-default"
            >
              <IconCheckCircle className="w-3.5 h-3.5 shrink-0 text-sky-500" />
              Mark all read
            </button>

            {/* Overflow: the rarer inverse (mark all unread), disabled when the
                visible set has nothing to flip. Menu closes on outside-click /
                Escape (effect above). */}
            <div ref={bulkMenuRef} className="relative">
              <button
                onClick={() => setBulkMenu((s) => !s)}
                aria-haspopup="menu"
                aria-expanded={bulkMenu}
                aria-label="More inbox actions"
                title="More inbox actions"
                className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition ${
                  bulkMenu
                    ? "border-ink-300 bg-ink-50 text-ink-800"
                    : "border-transparent text-ink-400 hover:bg-ink-50 hover:text-ink-700"
                }`}
              >
                <IconMore className="w-4 h-4" />
              </button>
              {bulkMenu && (
                <div
                  role="menu"
                  aria-label="More inbox actions"
                  className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border border-ink-200 bg-white shadow-md py-1"
                >
                  <button
                    role="menuitem"
                    disabled={!visibleHasRead}
                    aria-disabled={!visibleHasRead}
                    onClick={() => {
                      setBulkMenu(false);
                      void setManyRead(false);
                    }}
                    className="w-full flex items-center gap-2 text-left text-[12.5px] px-3 py-1.5 text-ink-700 enabled:hover:bg-ink-50 transition disabled:text-ink-300 disabled:cursor-default"
                  >
                    <IconCircle className="w-3.5 h-3.5 shrink-0" />
                    Mark all unread
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Semantic search bar ──────────────────────────────────────────── */}
        <div className="px-3 pt-3">
          <div className="flex items-center gap-2 px-2.5 h-8 rounded-md border border-ink-200 bg-white focus-within:ring-1 focus-within:ring-ink-300">
            <IconSearch className="w-3.5 h-3.5 text-ink-400 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mail…"
              aria-label="Search mail"
              className="flex-1 min-w-0 text-[12.5px] outline-none bg-transparent text-ink-900 placeholder:text-ink-400"
            />
            {/* Inline state: spinner while in flight, then the engine badge so the
                user knows which path (semantic vs keyword) answered. */}
            {searching && (
              <span className="text-[10.5px] text-ink-400 shrink-0">…</span>
            )}
            {!searching && engine && (
              <span className="text-[10px] uppercase tracking-wide text-ink-400 shrink-0">
                {engine === "semantic" ? "Semantic" : "Keyword"}
              </span>
            )}
            {query !== "" && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="shrink-0 text-ink-300 hover:text-ink-600 transition text-[12px] leading-none"
              >
                <span aria-hidden>×</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Control row: read-state · sort · filters ─────────────────────── */}
        <div className="px-3 pt-2 pb-2 flex items-center gap-2">
          <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
            {(["all", "unread", "read"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setFilters((f) => ({ ...f, read: r }))}
                aria-pressed={filters.read === r}
                className={`text-[11.5px] px-2 py-1 capitalize transition ${
                  filters.read === r
                    ? "bg-ink-900 text-white"
                    : "bg-white text-ink-600 hover:bg-ink-50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          {/* Sort toggle. Dimmed + a "relevance" hint while a semantic query is
              active (relevance ordering wins), but still clickable so the user's
              preferred order is remembered for when they clear the search. */}
          <button
            onClick={() => setSort((s) => (s === "newest" ? "oldest" : "newest"))}
            title={
              sortInert
                ? "Ranked by relevance while searching"
                : `Sort: ${sort}`
            }
            className={`inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 transition ${
              sortInert
                ? "text-ink-300 bg-ink-50"
                : "text-ink-600 bg-white hover:bg-ink-50"
            }`}
          >
            {sortInert ? "Relevance" : sort === "newest" ? "Newest" : "Oldest"}
            <IconChevronDown
              className={`w-3 h-3 ${sort === "oldest" && !sortInert ? "rotate-180" : ""}`}
            />
          </button>

          <button
            onClick={() => setShowFilters((s) => !s)}
            aria-pressed={showFilters}
            className={`ml-auto inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border transition ${
              showFilters || filterCount > 0
                ? "border-ink-300 text-ink-800 bg-ink-50"
                : "border-ink-200 text-ink-600 bg-white hover:bg-ink-50"
            }`}
          >
            <IconFilter className="w-3.5 h-3.5" />
            Filters
            {filterCount > 0 && (
              <span className="ml-0.5 inline-grid place-items-center min-w-[14px] h-[14px] px-1 rounded-full bg-ink-900 text-white text-[9.5px] tabular-nums">
                {filterCount}
              </span>
            )}
          </button>
        </div>

        {/* ── Participant filter panel (collapsible) ───────────────────────── */}
        {showFilters && (
          <div className="px-3 pb-3 border-b border-ink-100">
            <div className="rounded-md border border-ink-100 bg-ink-50/40 p-2.5 space-y-2">
              {(["from", "to", "cc"] as const).map((field) => (
                <label key={field} className="flex items-center gap-2">
                  <span className="w-8 text-[11px] uppercase tracking-wide text-ink-400 capitalize">
                    {field}
                  </span>
                  <input
                    value={filters[field]}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, [field]: e.target.value }))
                    }
                    placeholder={`Filter ${field}…`}
                    aria-label={`Filter by ${field}`}
                    className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded border border-ink-200 bg-white outline-none text-ink-900 placeholder:text-ink-400 focus:ring-1 focus:ring-ink-300"
                  />
                </label>
              ))}
              {filterCount > 0 && (
                <button
                  onClick={() => setFilters(EMPTY_INBOX_FILTERS)}
                  className="text-[11px] text-ink-400 hover:text-ink-700 transition"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto" role="list" aria-label="Messages">
          {messages.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-ink-400">
              No messages
            </div>
          ) : visible.length === 0 ? (
            // Distinct from "No messages": there ARE messages, none match the
            // active search/filters.
            <div className="px-4 py-10 text-center text-[12px] text-ink-400">
              No messages match
            </div>
          ) : (
            visible.map((m) => (
              <InboxRow
                key={m.id}
                message={m}
                clock={clock}
                active={selectedId === m.id}
                linked={Boolean(m.caseId)}
                onSelect={() => selectMessage(m.id)}
                onToggleRead={() => void setRead(m.id, !m.read)}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {error && (
          <div
            role="alert"
            className="px-6 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2"
          >
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-rose-500 hover:text-rose-700"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}
        {selected ? (
          <MessageDetail
            key={selected.id}
            message={selected}
            clock={clock}
            linkedCase={linkedCase}
            cases={cases}
            onToggleRead={() => void setRead(selected.id, !selected.read)}
            onCreateCase={(domain) => void createCaseFromMessage(selected, domain)}
            onLink={(caseId) => void linkToCase(selected.id, caseId)}
            onUnlink={() => void unlinkFromCase(selected.id)}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

function InboxRow({
  message,
  clock,
  active,
  linked,
  onSelect,
  onToggleRead,
}: {
  message: MessageRecord;
  clock: Date;
  active: boolean;
  linked: boolean;
  onSelect: () => void;
  onToggleRead: () => void;
}) {
  return (
    <div
      role="listitem"
      className={`group relative w-full flex items-start gap-3 px-4 py-3 border-b border-ink-50 hover:bg-ink-50/60 transition ${
        active ? "bg-ink-50" : ""
      }`}
    >
      <button
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="flex-1 min-w-0 flex items-start gap-3 text-left"
      >
        <div className="mt-1 w-7 h-7 rounded-full bg-ink-900 text-white grid place-items-center shrink-0">
          <SourceIcon source={message.source} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {!message.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shrink-0" />
            )}
            <span
              className={`text-[13px] truncate ${
                !message.read ? "font-medium text-ink-900" : "text-ink-700"
              }`}
            >
              {message.subject || "(no subject)"}
            </span>
          </div>
          <div className="text-[12px] text-ink-500 truncate mt-0.5">
            {message.preview}
          </div>
          {linked && (
            <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-violet-700 bg-violet-50 ring-1 ring-violet-200 rounded-full px-1.5 py-0.5">
              <IconDot className="w-2 h-2 text-violet-500" />
              {message.caseId}
            </span>
          )}
        </div>
      </button>
      <div className="shrink-0 flex flex-col items-end gap-1">
        <span className="text-[11px] text-ink-400 mt-1">
          {relativeTime(message.receivedAt, clock)}
        </span>
        {/* Per-row read/unread toggle — the inert dot, now operable. */}
        <button
          onClick={onToggleRead}
          title={message.read ? "Mark as unread" : "Mark as read"}
          aria-label={message.read ? "Mark as unread" : "Mark as read"}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition text-ink-300 hover:text-ink-600"
        >
          {message.read ? (
            <IconCircle className="w-3.5 h-3.5" />
          ) : (
            <IconCheckCircle className="w-3.5 h-3.5 text-sky-500" />
          )}
        </button>
      </div>
    </div>
  );
}

function MessageDetail({
  message,
  clock,
  linkedCase,
  cases,
  onToggleRead,
  onCreateCase,
  onLink,
  onUnlink,
}: {
  message: MessageRecord;
  clock: Date;
  linkedCase: CaseRecord | null;
  cases: CaseRecord[];
  onToggleRead: () => void;
  onCreateCase: (domain: CaseDomain) => void;
  onLink: (caseId: string) => void;
  onUnlink: () => void;
}) {
  const lane = linkedCase
    ? LANES.find((l) => l.key === linkedCase.status) ?? null
    : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-5 border-b border-ink-100">
        <div className="flex items-center gap-2 text-[12px] text-ink-500">
          <SourceIcon source={message.source} />
          <span className="truncate">{message.from}</span>
          <span className="ml-auto shrink-0">
            {relativeTime(message.receivedAt, clock)} ago
          </span>
          {/* Deep-link back to the original message (Gmail thread, etc.) when captured. */}
          <MessageLink url={messageDeepLink(message)} />
          <button
            onClick={onToggleRead}
            className="shrink-0 inline-flex items-center gap-1 text-[11.5px] px-2 py-0.5 rounded-full border border-ink-100 text-ink-500 hover:bg-ink-50 hover:text-ink-700 transition"
          >
            {message.read ? (
              <>
                <IconCircle className="w-3 h-3" /> Mark unread
              </>
            ) : (
              <>
                <IconCheckCircle className="w-3 h-3 text-sky-500" /> Mark read
              </>
            )}
          </button>
        </div>
        {/* Recipient meta — To / Cc under the From line when present, joined like a
            mail header. Same muted meta styling as the From row above. */}
        {message.to && message.to.length > 0 && (
          <div className="mt-1 text-[11.5px] text-ink-400">
            <span className="text-ink-300">To</span> {message.to.join(", ")}
          </div>
        )}
        {message.cc && message.cc.length > 0 && (
          <div className="mt-0.5 text-[11.5px] text-ink-400">
            <span className="text-ink-300">Cc</span> {message.cc.join(", ")}
          </div>
        )}
        <h2 className="mt-2 text-[18px] font-semibold text-ink-900 leading-snug">
          {message.subject || "(no subject)"}
        </h2>
      </div>

      {linkedCase && lane ? (
        <div className="px-6 py-3 border-b border-ink-100 bg-ink-50/40">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-400">
              Linked case
            </span>
            <button
              onClick={onUnlink}
              className="text-[11px] text-ink-400 hover:text-rose-600 transition"
            >
              Unlink
            </button>
          </div>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="tabular-nums text-ink-500 font-medium">
              {linkedCase.id}
            </span>
            <span className="text-ink-900 font-medium truncate">
              {linkedCase.title}
            </span>
            <span
              className={`ml-auto inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full bg-white border border-ink-100 ${lane.tone}`}
            >
              <IconDot
                className={`w-2.5 h-2.5 ${lane.dotClass.replace("bg-", "text-")}`}
              />
              {lane.label}
            </span>
          </div>
        </div>
      ) : (
        <TriagePanel
          message={message}
          cases={cases}
          onCreateCase={onCreateCase}
          onLink={onLink}
        />
      )}

      <MessageBody message={message} />
    </div>
  );
}

// The reading-pane content for a message. Renders the real body when present;
// for a SUMMARY-ONLY stub (empty body — common on swept Gmail messages linked
// with just a preview, or guard-withheld bodies) it falls back to the preview
// under a "Summary" label so the pane is never blank and the fallback is never
// mistaken for the full message. (See messageContent in lib/inbox.)
function MessageBody({ message }: { message: MessageRecord }) {
  const { text, isSummary } = messageContent(message);

  if (text === "") {
    return (
      <div className="px-6 py-5 text-[13px] text-ink-400 italic">
        (no message content)
      </div>
    );
  }

  return (
    <div className="px-6 py-5">
      {isSummary && (
        <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1.5">
          Summary
        </div>
      )}
      <div className="text-[13px] text-ink-700 leading-relaxed whitespace-pre-line">
        {text}
      </div>
      {isSummary && (
        <div className="mt-3 text-[11.5px] text-ink-400">
          Full message body wasn’t stored for this item.
        </div>
      )}
    </div>
  );
}

// The untriaged-message panel: turn it into a case, or link it to an existing
// one. This is the human face of `link_message` / `create_case`.
function TriagePanel({
  message,
  cases,
  onCreateCase,
  onLink,
}: {
  message: MessageRecord;
  cases: CaseRecord[];
  onCreateCase: (domain: CaseDomain) => void;
  onLink: (caseId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  // Exclude done/archived cases from the picker — you link live work, not closed.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases
      .filter((c) => c.status !== "done" && !c.archivedAt)
      .filter((c) =>
        q === ""
          ? true
          : c.id.toLowerCase().includes(q) ||
            c.title.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [cases, query]);

  return (
    <div className="px-6 py-3 border-b border-ink-100 bg-amber-50/30">
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-2">
        Untriaged
      </div>

      {!picking ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onCreateCase("work")}
            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
          >
            <IconPlus className="w-3.5 h-3.5" /> Create case
          </button>
          <span className="text-[11px] text-ink-400">as</span>
          <button
            onClick={() => onCreateCase("work")}
            className={`text-[11px] px-2 py-0.5 rounded-full ${domainClasses(
              "work"
            )}`}
          >
            {domainLabel("work")}
          </button>
          <button
            onClick={() => onCreateCase("life")}
            className={`text-[11px] px-2 py-0.5 rounded-full ${domainClasses(
              "life"
            )}`}
          >
            {domainLabel("life")}
          </button>
          <span className="mx-1 text-ink-200">·</span>
          <button
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 transition"
          >
            Link to existing case
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md border border-ink-200 bg-white">
              <IconSearch className="w-3.5 h-3.5 text-ink-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setPicking(false);
                }}
                placeholder="Search cases by id or title…"
                aria-label="Search cases to link"
                className="flex-1 min-w-0 text-[12px] outline-none bg-transparent text-ink-900 placeholder:text-ink-400"
              />
            </div>
            <button
              onClick={() => setPicking(false)}
              className="text-[11px] text-ink-400 hover:text-ink-700"
            >
              Cancel
            </button>
          </div>
          <div
            className="max-h-48 overflow-y-auto rounded-md border border-ink-100 divide-y divide-ink-50"
            role="listbox"
            aria-label="Cases"
          >
            {candidates.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-ink-400 text-center">
                No matching open cases
              </div>
            ) : (
              candidates.map((c) => {
                const lane = LANES.find((l) => l.key === c.status);
                return (
                  <button
                    key={c.id}
                    role="option"
                    onClick={() => onLink(c.id)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-ink-50 transition"
                  >
                    <span className="tabular-nums text-ink-500 font-medium shrink-0">
                      {c.id}
                    </span>
                    <span className="text-ink-900 truncate">{c.title}</span>
                    {lane && (
                      <span
                        className={`ml-auto shrink-0 inline-flex items-center gap-1 text-[10.5px] ${lane.tone}`}
                      >
                        <IconDot
                          className={`w-2 h-2 ${lane.dotClass.replace(
                            "bg-",
                            "text-"
                          )}`}
                        />
                        {lane.label}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 grid place-items-center text-ink-400 text-[13px]">
      Select a notification to view details
    </div>
  );
}
