"use client";

// The guard QUARANTINE log — the interactive review queue on the Security page. Like
// the WhitelistView, the data does NOT live in this board's cases.json; it lives in
// the guard SIDECAR (:8009), and the board only PROXIES it over /api/quarantine*. So
// there is NO SSE subscription here — the quarantine store is decoupled from
// db.version. We SSR-seed from the server's fetchQuarantineList() (structurally the
// same shape as the client fetchQuarantine()), then refetch IMPERATIVELY after every
// mutation (and on a manual Retry while offline).
//
// A quarantine record is EVERY flagged scan, saved verbatim for later review. The
// human can RELEASE one (mark a false positive — the content was actually safe & the
// sender is trusted + the mail re-admitted to triage), DISMISS one (acknowledged +
// ARCHIVED, NOT a false positive, never re-admitted), or DELETE it outright. Restoring
// a handled item back to the open queue is still possible but QUIET (an overflow item),
// never a loud rose button. Nothing auto-deletes; review is explicit. Re-scans of the
// same content dedup onto one row (count bumps) — that's why a row carries a count chip.
//
// ── Information architecture (v2 — "Triage + Archive") ──────────────────────────
// The OPEN QUEUE (quarantined) is the job; Released and Archived are quiet reference.
// We partition the already-sorted records into THREE stacked zones — never re-sort:
//   ZONE A — REVIEW QUEUE  (status === "quarantined")  — always open; it is the job.
//   ZONE B — RELEASED      (status === "released")      — collapsible (default closed),
//            split into "Pending re-admission" (!replayed) then "Replayed" (replayed).
//   ZONE C — ARCHIVE       (status === "dismissed")     — collapsible (default closed).
// Search + the slimmed status filter apply across all zones BEFORE partitioning.

import { useEffect, useMemo, useRef, useState } from "react";
import type { QuarantineRecord, QuarantineStatus } from "@/lib/types";
import {
  fetchQuarantine,
  updateQuarantine,
  deleteQuarantine,
  type QuarantineListResponse,
} from "@/lib/board-client";
import { relativeTime, formatDateTime } from "@/lib/format";
import { IconShield, IconWarning, IconChevronRight, IconMore } from "@/components/icons";

// The status filter options, in display order. Default is "quarantined" (the open
// review queue) — NOT a flat "All" that mixes open + handled. "all" shows every zone.
const STATUS_FILTERS: { key: "all" | QuarantineStatus; label: string }[] = [
  { key: "quarantined", label: "Review" },
  { key: "released", label: "Released" },
  { key: "dismissed", label: "Archived" },
  { key: "all", label: "All" },
];

// Row container + subject class constants. "active" = the open review queue (loud);
// "muted" = released/archive reference rows (calmer — softened bg + lighter subject).
// LITERAL strings (no runtime concat) so the Tailwind content scanner emits them.
const ROW_ACTIVE =
  "flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-3 py-2.5 cursor-pointer hover:bg-ink-50/60 transition";
const ROW_MUTED =
  "flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-3 py-2.5 cursor-pointer bg-ink-50/30 hover:bg-ink-50/60 transition";
const SUBJECT_ACTIVE = "block text-[13px] text-ink-900 truncate";
const SUBJECT_MUTED = "block text-[13px] text-ink-600 truncate";

// Released-lifecycle pills — pending (awaiting the next sweep) vs replayed (re-admitted).
// LITERAL strings, no concat.
const PILL_PENDING =
  "text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-50 text-sky-700 ring-1 ring-sky-100";
const PILL_REPLAYED = "text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-100 text-sky-700";

export function QuarantineView({ initial, now }: { initial: QuarantineListResponse; now: string }) {
  // The live quarantine envelope, seeded from SSR. We keep the WHOLE response (not
  // just the records) because `online`/`error`/`guardUrl` drive the offline banner
  // and `counts` drives the header stat strip.
  const [data, setData] = useState<QuarantineListResponse>(initial);

  // Fixed clock — parsed ONCE from the SSR `now` prop and threaded into every row's
  // relativeTime call, so the client never builds its own clock during render (no
  // SSR/hydration drift on the relative "when" timestamps).
  const clock = useMemo(() => new Date(now), [now]);

  // Client-side filters over the in-hand records (no extra round trips). A free-text
  // SEARCH across from/subject/body, and a STATUS filter — default "quarantined" (the
  // open review queue), not a flat "all".
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | QuarantineStatus>("quarantined");

  // Accordion state for the two collapsible reference zones. The Review Queue is always
  // open (it is the job, so it has no flag). Ephemeral — persisting is out of scope.
  const [openZones, setOpenZones] = useState({ released: false, archive: false });

  // A single in-flight key: the record id being mutated (release/dismiss/restore/delete).
  // Disables that row's controls so a double click can't fire two mutations. null === idle.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A surfaced mutation failure (release/dismiss/restore/delete) — the GET refetch
  // failures stay silent (last-known data persists), but a MUTATION that did not take
  // effect must show, so the human never thinks they handled a record that is offline.
  const [error, setError] = useState<string | null>(null);

  // Which rows are expanded (full body + per-segment scores + recommendation). A set
  // of ids; toggled per row. Independent of mutation state.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Derived view model ────────────────────────────────────────────────────────
  // The sidecar already sorts records newest-first by lastSeen; we keep that order
  // and only FILTER (search + status) on the client — never re-sort (the wire order
  // is the source of truth for "newest").
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.records.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [r.from ?? "", r.subject ?? "", r.body ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [data.records, query, statusFilter]);

  // Partition the (already search/status-filtered) records into the three zones,
  // preserving wire order. Released is sub-split into pending (!replayed) then replayed.
  // Pure + memoized on [filtered] — refetch re-partitions automatically.
  const { review, pending, replayedList, archive } = useMemo(() => {
    const review: QuarantineRecord[] = [];
    const pending: QuarantineRecord[] = [];
    const replayedList: QuarantineRecord[] = [];
    const archive: QuarantineRecord[] = [];
    for (const r of filtered) {
      if (r.status === "quarantined") review.push(r);
      else if (r.status === "released") (r.replayed ? replayedList : pending).push(r);
      else if (r.status === "dismissed") archive.push(r);
    }
    return { review, pending, replayedList, archive };
  }, [filtered]);

  // ── Refetch + mutation plumbing ────────────────────────────────────────────────
  // Re-read the whole queue and reseed. fetchQuarantine() never throws (the GET route
  // is fail-CLOSED-but-200), so an offline sidecar lands here as online:false and the
  // banner takes over. A network hiccup leaves the last-known data in place.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchQuarantine();
      setData(res);
    } catch {
      // Non-critical: keep the last-known envelope; the user can hit Retry.
    }
  };

  // Run a mutation under a busy key, surface any failure, and refetch on success.
  // Mutations (update/delete) DO throw on a 503/4xx (request<T> throws) — unlike a
  // refetch, a failed mutation MUST be shown.
  const runMutation = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (busyKey) return; // one mutation at a time
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The quarantine record could not be updated.");
    } finally {
      setBusyKey(null);
    }
  };

  const setStatus = (id: string, status: QuarantineStatus): void => {
    void runMutation(id, () => updateQuarantine(id, { status }));
  };

  const remove = (rec: QuarantineRecord): void => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete this quarantined message permanently?\n\n` +
          `${rec.subject || "(no subject)"} — from ${rec.from || "unknown sender"}\n\n` +
          `This removes it from the review queue for good (it is NOT recoverable).`,
      )
    )
      return;
    void runMutation(rec.id, () => deleteQuarantine(rec.id));
  };

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────────
  // OFFLINE: the queue is unreachable — show the banner and HIDE the list (reviewing
  // a store you can't reach would be misleading). A Retry refetches.
  if (!data.online) {
    return <OfflineBanner guardUrl={data.guardUrl} reason={data.error} onRetry={refetch} />;
  }

  const total = data.records.length;
  const disabled = busyKey !== null;

  // Stat-strip derivation: the four headline numbers come from the SAME filtered
  // partition arrays the zone headers render (review/pending/replayedList/archive), so
  // the strip can NEVER disagree with the rows below it under a search/status filter.
  // replayed is counted DIRECTLY from the loaded records (not released − pending), so it
  // matches its zone's count and can never go negative.

  // Per-zone "shown" gating for the slimmed filter: when a status is selected, only
  // that zone renders rows (others show their empty/short state); "all" shows every zone.
  const showReview = statusFilter === "all" || statusFilter === "quarantined";
  const showReleased = statusFilter === "all" || statusFilter === "released";
  const showArchive = statusFilter === "all" || statusFilter === "dismissed";

  // Effective accordion state. A zone is open if its toggle is open OR it is the active
  // single-status filter — selecting "Released"/"Archived" should reveal that zone's
  // rows, not leave the user staring at a collapsed header they have to click open.
  const releasedOpen = openZones.released || statusFilter === "released";
  const archiveOpen = openZones.archive || statusFilter === "dismissed";

  // Shared props passed to every QuarantineRow (the four handlers are bound per id).
  const rowProps = (r: QuarantineRecord) => ({
    record: r,
    clock,
    expanded: expanded.has(r.id),
    onToggle: () => toggleExpand(r.id),
    busy: busyKey === r.id,
    disabled,
    onRelease: () => setStatus(r.id, "released"),
    onDismiss: () => setStatus(r.id, "dismissed"),
    onRestore: () => setStatus(r.id, "quarantined"),
    onDelete: () => remove(r),
  });

  return (
    <div className="space-y-3">
      {/* Mutation error (release/dismiss/restore/delete) — dismissible. Refetch failures stay silent. */}
      {error && (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-500 hover:text-rose-700">
            ×
          </button>
        </div>
      )}

      {/* Stat strip + status filter + search — all on one flex row. */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-ink-500 tabular-nums">
          <span className="text-rose-700 font-medium">{review.length} to review</span>
          <span className="text-ink-300 px-1.5">·</span>
          <span className="text-sky-700 font-medium">{pending.length} pending replay</span>
          <span className="text-ink-300 px-1.5">·</span>
          <span className="text-emerald-700 font-medium">{replayedList.length} replayed</span>
          <span className="text-ink-300 px-1.5">·</span>
          <span className="text-ink-500 font-medium">{archive.length} archived</span>
        </span>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* Status filter — a small segmented control. shrink-0 + non-wrapping labels so
              "Archived" never truncates when the row gets tight. */}
          <div className="inline-flex shrink-0 items-center rounded-md border border-ink-200 overflow-hidden" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                aria-pressed={statusFilter === f.key}
                className={`text-[11.5px] whitespace-nowrap px-2 py-1 transition border-l first:border-l-0 border-ink-100 ${
                  statusFilter === f.key
                    ? "bg-ink-900 text-white"
                    : "bg-white text-ink-600 hover:bg-ink-50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            placeholder="Search messages…"
            aria-label="Search quarantined messages"
            // flex-1 (not w-full) with a sane min so the box fills slack without squeezing
            // the segmented control; it wraps to its own line before it ever crowds the tabs.
            className="flex-1 min-w-[150px] max-w-[220px] text-[12.5px] px-2.5 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
          />
        </div>
      </div>

      {/* App-level states: zero records = the GOOD empty card; a search/status no-match
          card; otherwise the three stacked zones. */}
      {total === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <div className="text-[12.5px] text-ink-400 text-center py-8 rounded-md border border-ink-100 bg-white">
          No messages match{query.trim() ? ` “${query.trim()}”` : ""}
          {statusFilter !== "all"
            ? ` in “${statusFilter === "dismissed" ? "archived" : statusFilter}”`
            : ""}
          .
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── ZONE A — REVIEW QUEUE (always open; it is the job) ── */}
          {showReview && (
            <section role="region" aria-label="Review queue">
              <div className="flex items-center gap-2 px-1 text-[12.5px] font-medium text-ink-700">
                <span className="uppercase tracking-wide text-[10.5px] text-ink-400">Review queue</span>
                <span className="text-ink-300">·</span>
                <span className="tabular-nums text-ink-500">{review.length} to review</span>
              </div>
              <div className="mt-2">
                {review.length === 0 ? (
                  <div className="rounded-md border border-ink-100 bg-white py-8 px-6 text-center text-[12.5px] text-ink-500">
                    No messages to review. The queue fills when the guard flags a scan.
                  </div>
                ) : (
                  <ZoneTable>
                    {review.map((r) => (
                      <QuarantineRow key={r.id} tone="active" {...rowProps(r)} />
                    ))}
                  </ZoneTable>
                )}
              </div>
            </section>
          )}

          {/* ── ZONE B — RELEASED (collapsible; pending then replayed sub-groups) ── */}
          {showReleased && (
            <section role="region" aria-label="Released">
              <button
                type="button"
                aria-expanded={releasedOpen}
                onClick={() => setOpenZones((z) => ({ ...z, released: !z.released }))}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-ink-700 hover:bg-ink-50/50 transition rounded-md"
              >
                <IconChevronRight className={`w-3.5 h-3.5 text-ink-300 transition-transform ${releasedOpen ? "rotate-90" : ""}`} />
                <span className="uppercase tracking-wide text-[10.5px] text-ink-400">Released</span>
                <span className="ml-1 tabular-nums text-[11.5px] text-ink-400">
                  {pending.length} pending replay · {replayedList.length} replayed
                </span>
              </button>
              {releasedOpen && (
                <div className="mt-2">
                  {pending.length === 0 && replayedList.length === 0 ? (
                    <div className="text-[12.5px] text-ink-400 px-3 py-4">No released messages.</div>
                  ) : (
                    <ZoneTable>
                      {pending.length > 0 && (
                        <>
                          <SubGroupHeader>Pending re-admission ({pending.length})</SubGroupHeader>
                          {pending.map((r) => (
                            <QuarantineRow key={r.id} tone="muted" {...rowProps(r)} />
                          ))}
                        </>
                      )}
                      {replayedList.length > 0 && (
                        <>
                          <SubGroupHeader>Replayed ({replayedList.length})</SubGroupHeader>
                          {replayedList.map((r) => (
                            <QuarantineRow key={r.id} tone="muted" {...rowProps(r)} />
                          ))}
                        </>
                      )}
                    </ZoneTable>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── ZONE C — ARCHIVE (collapsible; dismissed = final/handled) ── */}
          {showArchive && (
            <section role="region" aria-label="Archive">
              <button
                type="button"
                aria-expanded={archiveOpen}
                onClick={() => setOpenZones((z) => ({ ...z, archive: !z.archive }))}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-ink-700 hover:bg-ink-50/50 transition rounded-md"
              >
                <IconChevronRight className={`w-3.5 h-3.5 text-ink-300 transition-transform ${archiveOpen ? "rotate-90" : ""}`} />
                <span className="uppercase tracking-wide text-[10.5px] text-ink-400">Archive</span>
                <span className="ml-1 tabular-nums text-[11.5px] text-ink-400">{archive.length} archived</span>
              </button>
              {archiveOpen && (
                <div className="mt-2">
                  {archive.length === 0 ? (
                    <div className="text-[12.5px] text-ink-400 px-3 py-4">No archived messages.</div>
                  ) : (
                    <ZoneTable>
                      {archive.map((r) => (
                        <QuarantineRow key={r.id} tone="muted" {...rowProps(r)} />
                      ))}
                    </ZoneTable>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// One table shell for a non-empty zone body: the card wrapper, the md:flex column
// header row, and the divided list of rows (passed as children). Shared by all zones.
function ZoneTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      {/* Header row — column labels, hidden on narrow screens where rows stack. */}
      <div className="hidden md:flex items-center gap-3 px-3 py-2 border-b border-ink-100 text-[10.5px] uppercase tracking-wide text-ink-400">
        <span className="w-4 shrink-0" />
        <span className="flex-1 min-w-0">From / Subject</span>
        <span className="w-[64px] text-right">Score</span>
        <span className="w-[120px]">Classifier</span>
        <span className="w-[64px] text-right">When</span>
        <span className="w-[140px]">Status</span>
        <span className="w-[160px] text-right">Actions</span>
      </div>
      <div className="divide-y divide-ink-50">{children}</div>
    </div>
  );
}

// A sub-group label row inside the Released zone ("Pending re-admission (M)" /
// "Replayed (K)"). Sits between the table header and that sub-group's rows.
function SubGroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-ink-400 bg-ink-50/40">
      {children}
    </div>
  );
}

// One quarantine row: a collapsed summary line (expand chevron, from + subject,
// maxScore, classifier, relative when, status chips) plus the per-row actions. The
// `tone` prop calms released/archive rows (softened bg + lighter subject) while the
// open-queue rows stay loud. Actions are status-driven: quarantined rows get the loud
// Release/Dismiss pair + a kebab (Delete only); handled rows get ONLY a kebab whose
// items are Restore (quiet) + Delete (quiet) — so Restore stays possible-but-quiet,
// never a loud rose button. Clicking the row body (not a button) toggles the EXPANDED
// panel (full body + per-segment scores + recommendation — the evidence to re-review).
function QuarantineRow({
  record,
  clock,
  tone,
  expanded,
  onToggle,
  busy,
  disabled,
  onRelease,
  onDismiss,
  onRestore,
  onDelete,
}: {
  record: QuarantineRecord;
  clock: Date;
  tone: "active" | "muted";
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  disabled: boolean;
  onRelease: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const count = record.count ?? 1;
  // The "when" we show is lastSeen (the list sorts by it); fall back to at/firstSeen.
  const when = record.lastSeen || record.at || record.firstSeen || "";
  const isQuarantined = record.status === "quarantined";

  return (
    <div>
      {/* Summary line — the whole non-action area is the expand toggle. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className={tone === "muted" ? ROW_MUTED : ROW_ACTIVE}
      >
        {/* Expand chevron */}
        <span className="w-4 shrink-0 text-ink-300">
          <IconChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </span>

        {/* From + subject (the headline) */}
        <span className="flex-1 min-w-0">
          <span className="block font-mono text-[12px] text-ink-500 truncate" title={record.from ?? ""}>
            {record.from || <span className="text-ink-300">unknown sender</span>}
          </span>
          <span className={tone === "muted" ? SUBJECT_MUTED : SUBJECT_ACTIVE} title={record.subject ?? ""}>
            {record.subject || <span className="text-ink-300 italic">(no subject)</span>}
          </span>
        </span>

        {/* Max score (mono, tabular) — the headline malice probability. */}
        <span
          className="md:w-[64px] text-right text-[12px] font-mono tabular-nums text-ink-700"
          title={`Highest segment score ${record.maxScore} vs threshold ${record.threshold}`}
        >
          {fmtScore(record.maxScore)}
        </span>

        {/* Classifier — DEGRADED tint when on the heuristic fallback. */}
        <span className="md:w-[120px] text-[11.5px] truncate" title={record.classifier}>
          <span className={record.classifier.includes("heuristic") ? "text-amber-700" : "text-ink-500"}>
            {record.classifier || "—"}
          </span>
        </span>

        {/* When (relative), full timestamp on hover. */}
        <span
          className="md:w-[64px] text-right text-[11.5px] text-ink-400 tabular-nums"
          title={when ? formatDateTime(when) : "Unknown"}
        >
          {when ? relativeTime(when, clock) : "—"}
        </span>

        {/* Status chip(s) — status badge + count chip + lifecycle pill for released. */}
        <span className="md:w-[140px] flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${statusClasses(record.status)}`}>
            {statusLabel(record.status)}
          </span>
          {count > 1 && (
            <span
              className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600"
              title={`Scanned ${count} times (same content)`}
            >
              ×{count}
            </span>
          )}
          {record.status === "released" &&
            (record.replayed ? (
              <span className={PILL_REPLAYED} title="Re-admitted to triage by the mail sweep">
                replayed
              </span>
            ) : (
              <span
                className={PILL_PENDING}
                title="Trusted sender; waiting for the next mail sweep to re-admit to triage"
              >
                pending replay
              </span>
            ))}
        </span>

        {/* Per-row actions. Buttons stop propagation so they never toggle the row.
            quarantined → loud Release/Dismiss + a kebab (Delete only); handled →
            ONLY the kebab (Restore quiet + Delete quiet). */}
        <div className="md:w-[160px] flex items-center justify-end gap-1.5">
          {isQuarantined && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRelease();
                }}
                disabled={disabled}
                aria-label="Release — trust sender & re-admit to triage"
                title="Release — trust sender & re-admit to triage"
                className="text-[11.5px] px-2 py-1 rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition disabled:opacity-40"
              >
                {busy ? "…" : "Release"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss();
                }}
                disabled={disabled}
                aria-label="Dismiss — acknowledge & archive"
                title="Dismiss — acknowledge & archive"
                className="text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
              >
                {busy ? "…" : "Dismiss"}
              </button>
            </>
          )}
          <RowMenu
            disabled={disabled}
            canRestore={!isQuarantined}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        </div>
      </div>

      {/* Expanded panel — the full evidence: body + per-segment scores + recommendation. */}
      {expanded && <ExpandedDetail record={record} />}
    </div>
  );
}

// The per-row overflow (kebab) menu. The ONLY place Restore lives (quiet, ink-600) and
// where Delete is tucked away (off the always-visible row — declutter) while staying
// keyboard-reachable as a real <button> list. Quarantined rows show only "Delete
// permanently"; handled (released/dismissed) rows also show "Restore to review queue".
// Dismisses on item click, Escape, and click-outside. stopPropagation everywhere so it
// never toggles the row's expand.
function RowMenu({
  disabled,
  canRestore,
  onRestore,
  onDelete,
}: {
  disabled: boolean;
  canRestore: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Click-outside closes the menu — the standard ref + mousedown listener pattern.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="text-ink-300 hover:text-ink-700 transition disabled:opacity-40 p-1 rounded-md"
      >
        <IconMore className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute right-0 mt-1 z-10 min-w-[180px] bg-white border border-ink-100 rounded-md shadow-card py-1"
        >
          {canRestore && (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onRestore();
              }}
              className="w-full text-[11.5px] px-3 py-1.5 text-left text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
            >
              Restore to review queue
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="w-full text-[11.5px] px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 transition disabled:opacity-40"
          >
            Delete permanently
          </button>
        </div>
      )}
    </span>
  );
}

// The expanded detail panel: the recommendation, the per-segment scores (which part
// flagged + its score), and the full (capped) body. This is the evidence a human
// re-reviews to decide release vs dismiss.
function ExpandedDetail({ record }: { record: QuarantineRecord }) {
  return (
    <div className="px-3 pb-3 pt-1 bg-ink-50/40 border-t border-ink-50 space-y-3">
      {/* Recommendation — the scanner's verdict prose. */}
      {record.recommendation && (
        <div className="flex items-start gap-2 text-[12px] text-ink-700">
          <IconWarning className="w-3.5 h-3.5 mt-0.5 text-amber-600 shrink-0" />
          <span className="leading-relaxed">{record.recommendation}</span>
        </div>
      )}

      {/* Per-segment scores — which part flagged, and its score. Mirrors the /scan
          segments. Flagged segments get a rose tint so the offending part is obvious. */}
      {record.segments.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-ink-400 mb-1">
            Segment scores (threshold {fmtScore(record.threshold)})
          </div>
          <div className="rounded-md border border-ink-100 bg-white divide-y divide-ink-50 overflow-hidden">
            {record.segments.map((seg, i) => (
              <div key={`${seg.part}-${i}`} className="flex items-center gap-3 px-2.5 py-1.5">
                <span className="w-[90px] shrink-0 font-mono text-[11px] text-ink-500">{seg.part}</span>
                <span
                  className={`text-[11px] font-mono tabular-nums shrink-0 ${
                    seg.flagged ? "text-rose-700 font-semibold" : "text-ink-500"
                  }`}
                >
                  {fmtScore(seg.score)}
                </span>
                {seg.flagged && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-rose-50 text-rose-700 ring-1 ring-rose-200 shrink-0">
                    flagged
                  </span>
                )}
                <span className="flex-1 min-w-0 text-[11.5px] text-ink-500 truncate" title={seg.snippet}>
                  {seg.snippet}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The full (capped) body — verbatim, in a scrollable mono block. */}
      <div>
        <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-ink-400 mb-1">
          <span>Message body</span>
          {record.bodyTruncated && (
            <span className="text-[10px] normal-case tracking-normal px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
              truncated
            </span>
          )}
        </div>
        <pre className="max-h-[280px] overflow-auto rounded-md border border-ink-100 bg-white px-3 py-2 text-[12px] font-mono text-ink-700 whitespace-pre-wrap break-words">
          {record.body || <span className="text-ink-300 italic">(empty body)</span>}
        </pre>
      </div>

      {/* The review note, if any. */}
      {record.note && (
        <div className="text-[11.5px] text-ink-500">
          <span className="text-ink-400">Note: </span>
          {record.note}
        </div>
      )}
    </div>
  );
}

// The offline banner — shown when the guard sidecar is unreachable (initial seed or a
// refetch returned online:false). The quarantine log lives in the sidecar, so there is
// nothing to review while it's down; we explain where it lives and offer a Retry.
// Mirrors the WhitelistView's OfflineBanner exactly.
function OfflineBanner({
  guardUrl,
  reason,
  onRetry,
}: {
  guardUrl: string;
  reason?: string;
  onRetry: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <IconShield className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-amber-900">Guard service offline</p>
          <p className="mt-1 text-[12px] text-amber-800 leading-relaxed">
            The quarantine log lives in the guard sidecar (<span className="font-mono">{guardUrl}</span>); start
            it to review flagged messages.
          </p>
          {reason && <p className="mt-1 text-[11.5px] text-amber-700/80 font-mono break-words">{reason}</p>}
        </div>
        <button
          onClick={retry}
          disabled={retrying}
          className="shrink-0 text-[12px] px-2.5 py-1 rounded-md border border-amber-300 text-amber-800 bg-white hover:bg-amber-100 transition disabled:opacity-50"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

// Friendly empty state — online but zero records. Explains that the queue fills only
// when the guard flags a scan, so an empty queue is the GOOD state.
function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-ink-200 bg-white py-10 px-6 text-center">
      <p className="text-[13px] text-ink-700 font-medium mb-1">No quarantined messages</p>
      <p className="text-[12.5px] text-ink-500 max-w-[440px] mx-auto">
        Nothing has been flagged yet. Every message the guard flags as a possible prompt-injection
        is saved here for review — an empty queue means nothing has crossed the threshold.
      </p>
    </div>
  );
}

// ── Local presentation helpers ────────────────────────────────────────────────
// Status badge classes/labels — emerald for released (a confirmed false positive),
// rose for quarantined (the open risk), neutral ink for dismissed/archived (handled).
// Full literal Tailwind strings (no runtime concat) so the content scanner emits them.
const STATUS_CHIP: Record<QuarantineStatus, string> = {
  quarantined: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  released: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  dismissed: "bg-ink-50 text-ink-500 ring-1 ring-ink-200",
};

function statusClasses(status: QuarantineStatus): string {
  return STATUS_CHIP[status] ?? STATUS_CHIP.quarantined;
}

const STATUS_LABEL: Record<QuarantineStatus, string> = {
  quarantined: "Quarantined",
  released: "Released",
  dismissed: "Archived",
};

function statusLabel(status: QuarantineStatus): string {
  return STATUS_LABEL[status] ?? "Quarantined";
}

// A score (0..1) shown to 2 decimals — concise but precise enough to compare to the
// threshold. Defends against a non-finite value (renders "—").
function fmtScore(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}
