"use client";

// The guard sender-trust WHITELIST manager — the interactive half of the Settings
// page. The whitelist data does NOT live in this board's cases.json; it lives in the
// guard SIDECAR (:8009), and the board only PROXIES it over /api/trust*. So unlike
// the reminders/calendar views there is NO SSE subscription here — the trust store
// is decoupled from db.version. We SSR-seed from the server's fetchTrustList() (the
// same shape as the client fetchTrust()), then refetch IMPERATIVELY after every
// mutation (and on a manual Retry while offline).
//
// Trust is a SECOND axis to the guard's content scan, never a bypass — see the page
// blurb. The implicit "unknown" tier is the absence of a record; it is never written
// (the POST route 400s trust:"unknown"). To clear a sender we DELETE it (which the
// sidecar reports back as trust:"unknown").

import { useMemo, useState } from "react";
import type { TrustRecord, TrustTier } from "@/lib/types";
import {
  fetchTrust,
  upsertTrust,
  deleteTrust,
  type TrustListResponse,
} from "@/lib/board-client";
import { trustClasses, trustLabel, relativeTime, formatDateTime } from "@/lib/format";
import { IconPlus, IconShield, IconTrash } from "@/components/icons";

// Same loose-but-real email shape the POST route validates with — we check it
// CLIENT-side first so the inline add form can show a fast, precise error before a
// round trip (the route is still the source of truth and re-validates).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WhitelistView({ initial, now }: { initial: TrustListResponse; now: string }) {
  // The live whitelist envelope, seeded from SSR. We keep the WHOLE response (not
  // just the senders) because `online`/`error`/`guardUrl` drive the offline banner.
  const [data, setData] = useState<TrustListResponse>(initial);

  // Fixed clock — parsed ONCE from the SSR `now` prop and threaded into every row's
  // relativeTime call, so the client never builds its own clock during render (no
  // SSR/hydration drift on the relative "last seen" timestamps).
  const clock = useMemo(() => new Date(now), [now]);

  // Client-side filter over email + reason + provenance (case-insensitive substring).
  const [query, setQuery] = useState("");

  // A single in-flight key: an email being mutated (flip/delete) or "__add__" while
  // the add form posts. Disables that row's controls + the add button so a double
  // click can't fire two mutations. null === idle.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A surfaced mutation failure (add/flip/delete) — the GET refetch failures stay
  // silent (last-known data persists), but a MUTATION that did not take effect must
  // show, so the human never thinks they changed a whitelist that is actually offline.
  const [error, setError] = useState<string | null>(null);

  // New-sender composer.
  const [nEmail, setNEmail] = useState("");
  const [nTier, setNTier] = useState<Exclude<TrustTier, "unknown">>("trusted");
  const [nReason, setNReason] = useState("");

  // ── Derived view model ────────────────────────────────────────────────────────
  // The sidecar stores senders as a map keyed by email; derive a stable sorted array
  // for the table (blocked first so risks surface, then trusted, then alphabetical).
  const senders = useMemo(() => {
    const list = Object.values(data.senders);
    return list.sort((a, b) => {
      const rank = (t: TrustTier) => (t === "blocked" ? 0 : t === "trusted" ? 1 : 2);
      const byTier = rank(a.trust) - rank(b.trust);
      return byTier !== 0 ? byTier : a.email.localeCompare(b.email);
    });
  }, [data.senders]);

  // Filter by the search query across email + reason + provenance lines.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return senders;
    return senders.filter((s) => {
      const hay = [s.email, s.reason ?? "", ...(s.provenance ?? [])].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [senders, query]);

  const trustedCount = senders.filter((s) => s.trust === "trusted").length;
  const blockedCount = senders.filter((s) => s.trust === "blocked").length;

  // ── Refetch + mutation plumbing ────────────────────────────────────────────────
  // Re-read the whole whitelist and reseed. fetchTrust() never throws (the GET route
  // is fail-CLOSED-but-200), so an offline sidecar lands here as online:false and the
  // banner takes over. A network hiccup leaves the last-known data in place.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchTrust();
      setData(res);
    } catch {
      // Non-critical: keep the last-known envelope; the user can hit Retry.
    }
  };

  // Run a mutation under a busy key, surface any failure, and refetch on success.
  // Mutations (upsert/delete) DO throw on a 503/4xx (request<T> throws) — unlike a
  // refetch, a failed mutation MUST be shown.
  const runMutation = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (busyKey) return; // one mutation at a time
    setBusyKey(key);
    setError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The whitelist could not be updated.");
    } finally {
      setBusyKey(null);
    }
  };

  const addSender = async (): Promise<void> => {
    const email = nEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      setError("Enter a valid email address (e.g. name@example.com).");
      return;
    }
    const reason = nReason.trim();
    await runMutation("__add__", () =>
      upsertTrust({ email, trust: nTier, ...(reason ? { reason } : {}) }),
    );
    // Clear the composer only on success (no error set by the mutation).
    setNEmail("");
    setNReason("");
    setNTier("trusted");
  };

  // ── Render ──────────────────────────────────────────────────────────────────────
  // OFFLINE: the whitelist is unreachable — show the banner and HIDE the table/add
  // form (managing a store you can't reach would be misleading). A Retry refetches.
  if (!data.online) {
    return <OfflineBanner guardUrl={data.guardUrl} reason={data.error} onRetry={refetch} />;
  }

  return (
    <div className="space-y-3">
      {/* Mutation error (add/flip/delete) — dismissible. Refetch failures stay silent. */}
      {error && (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-500 hover:text-rose-700">
            ×
          </button>
        </div>
      )}

      {/* Add a sender — an inline composer pinned at the top (mirrors the label
          manager's add row): email + tier + optional reason. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addSender();
        }}
        className="rounded-md border border-ink-200 p-3"
      >
        <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-2">Add a sender</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={nEmail}
            onChange={(e) => setNEmail(e.target.value)}
            type="email"
            placeholder="name@example.com"
            aria-label="Sender email"
            autoComplete="off"
            className="flex-1 min-w-0 font-mono text-[13px] px-2 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
          />
          <select
            value={nTier}
            onChange={(e) => setNTier(e.target.value as Exclude<TrustTier, "unknown">)}
            aria-label="Trust tier"
            className="text-[13px] px-2 py-1.5 rounded-md border border-ink-200 bg-white outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
          >
            <option value="trusted">Trusted</option>
            <option value="blocked">Blocked</option>
          </select>
          <button
            type="submit"
            disabled={!nEmail.trim() || busyKey !== null}
            className="inline-flex items-center justify-center gap-1 text-[12px] px-2.5 py-1.5 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-40"
          >
            <IconPlus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
        <input
          value={nReason}
          onChange={(e) => setNReason(e.target.value)}
          placeholder="Reason (optional) — why this tier?"
          aria-label="Reason"
          className="w-full mt-2 text-[12.5px] px-2 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
        />
      </form>

      {/* Count line + search. */}
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-ink-500 tabular-nums">
          <span className="text-emerald-700 font-medium">{trustedCount} trusted</span>
          <span className="text-ink-300 px-1.5">·</span>
          <span className="text-rose-700 font-medium">{blockedCount} blocked</span>
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          placeholder="Search senders…"
          aria-label="Search whitelist"
          className="ml-auto w-full max-w-[240px] text-[12.5px] px-2.5 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
        />
      </div>

      {/* EMPTY (online, zero senders) vs the table. */}
      {senders.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <div className="text-[12.5px] text-ink-400 text-center py-8 rounded-md border border-ink-100 bg-white">
          No senders match &ldquo;{query.trim()}&rdquo;.
        </div>
      ) : (
        <div className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
          {/* Header row — column labels, hidden on narrow screens where rows stack. */}
          <div className="hidden md:flex items-center gap-3 px-3 py-2 border-b border-ink-100 text-[10.5px] uppercase tracking-wide text-ink-400">
            <span className="flex-1 min-w-0">Sender</span>
            <span className="w-[88px]">Tier</span>
            <span className="w-[200px]">Reason</span>
            <span className="w-[84px]">Last seen</span>
            <span className="w-[120px] text-right">Actions</span>
          </div>
          <div className="divide-y divide-ink-50">
            {filtered.map((s) => (
              <SenderRow
                key={s.email}
                record={s}
                clock={clock}
                busy={busyKey === s.email}
                disabled={busyKey !== null}
                onFlip={(next) =>
                  runMutation(s.email, () =>
                    upsertTrust({
                      email: s.email,
                      trust: next,
                      note: `tier set to ${next} via board settings`,
                    }),
                  )
                }
                onDelete={() => runMutation(s.email, () => deleteTrust(s.email))}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One sender row: email (mono), tier badge, reason, last-seen (relative), and the
// per-row controls — a tier FLIP (trusted<->blocked) and a DELETE (clear to unknown).
// A small muted provenance line sits under the row (the audit trail of how the
// record came to be), with the full trail on hover via the title attribute.
function SenderRow({
  record,
  clock,
  busy,
  disabled,
  onFlip,
  onDelete,
}: {
  record: TrustRecord;
  clock: Date;
  busy: boolean;
  disabled: boolean;
  onFlip: (next: Exclude<TrustTier, "unknown">) => void;
  onDelete: () => void;
}) {
  // The flip target is the OTHER persisted tier (we never write "unknown" — that's a
  // delete). An "unknown" record shouldn't appear in the list (the store only
  // persists trusted/blocked), but defend: treat it as flipping toward "trusted".
  const next: Exclude<TrustTier, "unknown"> = record.trust === "trusted" ? "blocked" : "trusted";
  const provenance = record.provenance ?? [];
  const provenanceText = provenance.join(" · ");

  const onDeleteClick = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Remove ${record.email} from the whitelist? It returns to the implicit “unknown” tier ` +
          `(the guard still scans its messages).`,
      )
    )
      return;
    onDelete();
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
        {/* Email (mono) */}
        <span className="flex-1 min-w-0 font-mono text-[12.5px] text-ink-900 truncate" title={record.email}>
          {record.email}
        </span>

        {/* Tier badge */}
        <span className="md:w-[88px]">
          <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${trustClasses(record.trust)}`}>
            {trustLabel(record.trust)}
          </span>
        </span>

        {/* Reason */}
        <span className="md:w-[200px] text-[12px] text-ink-500 truncate" title={record.reason ?? ""}>
          {record.reason || <span className="text-ink-300">—</span>}
        </span>

        {/* Last seen (relative) */}
        <span
          className="md:w-[84px] text-[11.5px] text-ink-400 tabular-nums"
          title={record.lastSeen ? formatDateTime(record.lastSeen) : "Never seen"}
        >
          {record.lastSeen ? relativeTime(record.lastSeen, clock) : "—"}
        </span>

        {/* Per-row controls: flip tier + delete */}
        <div className="md:w-[120px] flex items-center justify-end gap-1.5">
          <button
            onClick={() => onFlip(next)}
            disabled={disabled}
            aria-label={`Set ${record.email} to ${next}`}
            title={`Switch to ${trustLabel(next)}`}
            className={`text-[11.5px] px-2 py-1 rounded-md border transition disabled:opacity-40 ${
              next === "blocked"
                ? "border-rose-200 text-rose-600 hover:bg-rose-50"
                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            {busy ? "…" : trustLabel(next)}
          </button>
          <button
            onClick={onDeleteClick}
            disabled={disabled}
            aria-label={`Remove ${record.email} from the whitelist`}
            title="Remove (clear to unknown)"
            className="text-ink-300 hover:text-rose-600 transition disabled:opacity-40 p-1"
          >
            <IconTrash className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Provenance — the append-only audit trail, muted, full trail on hover. */}
      {provenance.length > 0 && (
        <div className="mt-1 text-[11px] text-ink-400 truncate" title={provenanceText}>
          {provenanceText}
        </div>
      )}
    </div>
  );
}

// The offline banner — shown when the guard sidecar is unreachable (initial seed or
// a refetch returned online:false). The whitelist lives in the sidecar, so there is
// nothing to manage while it's down; we explain where it lives and offer a Retry.
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
            The whitelist lives in the guard sidecar (<span className="font-mono">{guardUrl}</span>); start
            it to manage senders.
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

// Friendly empty state — online but zero senders. Explains trust-on-first-reply so
// the human understands the whitelist fills itself over time.
function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-ink-200 bg-white py-10 px-6 text-center">
      <p className="text-[13px] text-ink-700 font-medium mb-1">No senders yet</p>
      <p className="text-[12.5px] text-ink-500 max-w-[440px] mx-auto">
        A sender becomes <span className="font-medium text-emerald-700">trusted</span> automatically once
        you reply to them (trust-on-first-reply). You can also add, block, or remove a sender here at any
        time — the guard still scans every message regardless of tier.
      </p>
    </div>
  );
}
