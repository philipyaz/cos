"use client";

// The Approvals tray — db.pending's human surface (cos-ops#136). Reachable before this only by
// GET /api/pending and the list_pending/approve/reject MCP tools, i.e. by an agent and by nobody
// on a phone. Mounted on /my-issues (MOBILE_TAB_HREFS[0], the first fixed phone tab): SSR seeds
// every pending row, a live SSE subscription (useLiveBoard) refetches whenever the board version
// advances past what we last saw, and approve/reject route through the same POST /api/pending/[id]
// the MCP tools call — no UI-only capability is minted (R2).
//
// A stacked card, not the house single-line `truncate` row: live summary lengths (min 64 / median
// 124 / max 529 chars) all exceed the ~56-char, 331px line at 390pt, so a wrapping block is the
// summary's only faithful render (issue + review, re-verified at plan time).
//
// Approve is NOT optimistic, deliberately — 69 of the 136 live rows 400 on approve (43 no-target +
// 25 `move` rows missing status/to + 1 hierarchy violation; B2), so an optimistic flash-remove
// would flash-reappear on more than half the legacy queue. Await-with-busy on approve; optimistic
// on reject (the cheap, revertible disposition — the priorities-view idiom verbatim).
import { useMemo, useRef, useState } from "react";
import { fetchPending, decidePending } from "@/lib/board-client";
import { PrimaryButton, SecondaryButton, DestructiveButton } from "@/components/shared/action-button";
import { TextInput } from "@/components/shared/field";
import { useLiveBoard } from "@/lib/use-live-board";
import type { PendingMutation } from "@/lib/types";

export function PendingTray({
  pending,
  version,
  now,
}: {
  pending: PendingMutation[];
  version: number;
  now: string;
}) {
  const [rows, setRows] = useState<PendingMutation[]>(pending);
  const lastVersion = useRef<number>(version);

  // Fixed clock — parsed ONCE from the SSR `now` prop (the reminders-view idiom), so ages don't
  // drift between server and first client render.
  const clock = useMemo(() => new Date(now), [now]);

  const [decideErrors, setDecideErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
  const [olderThanDays, setOlderThanDays] = useState(30);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  const refetch = async (): Promise<void> => {
    try {
      const r = await fetchPending();
      setRows(r.pending);
      lastVersion.current = r.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known rows in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  const ageDays = (p: PendingMutation): number =>
    Math.max(0, Math.floor((clock.getTime() - Date.parse(p.proposedAt)) / 86400000));

  // Oldest-first — the decision owed longest sits on top, which is also what the
  // bulk control targets.
  const open = [...rows]
    .filter((p) => p.status === "pending")
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));

  const affected = open.filter((p) => ageDays(p) >= olderThanDays);

  // The tray is exceptional UI: an empty queue renders nothing (the badge's zero-state twin).
  // Truthful, not the stalled-fetch cheerful empty — the seed is server-rendered from the same
  // readDB() the page uses, and a failed refetch keeps last-known rows rather than clearing.
  if (open.length === 0) return null;

  async function approve(p: PendingMutation): Promise<void> {
    if (!window.confirm(`Approve ${p.id}? This commits the proposed change to the board.`)) return;
    setBusyId(p.id);
    try {
      const r = await decidePending(p.id, "approve");
      lastVersion.current = r.version;
      setRows((prev) => prev.map((row) => (row.id === p.id ? r.pending : row)));
    } catch (e) {
      setDecideErrors((prev) => ({ ...prev, [p.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(p: PendingMutation): Promise<void> {
    const snapshot = rows;
    setRows((prev) => prev.map((row) => (row.id === p.id ? { ...row, status: "rejected" } : row)));
    try {
      const r = await decidePending(p.id, "reject");
      lastVersion.current = r.version;
    } catch (e) {
      setRows(snapshot);
      setDecideErrors((prev) => ({ ...prev, [p.id]: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function bulkReject(): Promise<void> {
    const targets = affected;
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `Reject ${targets.length} proposals older than ${olderThanDays} days? They leave the queue as rejected — no case changes.`,
      )
    ) {
      return;
    }
    setBulkSummary(null);
    setBulk({ done: 0, total: targets.length });
    let failed = 0;
    // Sequential, never parallel: each decide is a full store mutate, so parallel calls
    // would just queue on the server lock while hammering it.
    for (const p of targets) {
      try {
        const r = await decidePending(p.id, "reject");
        lastVersion.current = r.version;
        setRows((prev) => prev.map((row) => (row.id === p.id ? r.pending : row)));
      } catch (e) {
        failed += 1;
        setDecideErrors((prev) => ({ ...prev, [p.id]: e instanceof Error ? e.message : String(e) }));
      }
      setBulk((prev) => (prev ? { done: prev.done + 1, total: prev.total } : prev));
    }
    setBulkSummary(failed > 0 ? `${failed} of ${targets.length} could not be rejected — each card below shows why.` : null);
    setBulk(null);
    void refetch();
  }

  return (
    <section className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-3 py-2.5 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold text-ink-900">Approvals</span>
        <span className="text-[12px] text-ink-400 tabular-nums">{open.length} waiting</span>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-500">
          Older than
          <TextInput
            type="number"
            min={0}
            value={olderThanDays}
            onChange={(e) => setOlderThanDays(Math.max(0, Number(e.target.value) || 0))}
            className="w-16 tabular-nums"
          />
          days
        </label>
        <DestructiveButton className="px-3" disabled={bulk !== null || affected.length === 0} onClick={() => void bulkReject()}>
          {bulk ? `Rejecting… ${bulk.done}/${bulk.total}` : `Reject ${affected.length}`}
        </DestructiveButton>
      </div>
      {bulkSummary && <p className="px-3 pt-2 text-[12px] text-rose-700">{bulkSummary}</p>}
      <div className="max-h-[50dvh] overflow-y-auto divide-y divide-ink-50">
        {open.map((p) => (
          <PendingCard
            key={p.id}
            p={p}
            age={ageDays(p)}
            err={decideErrors[p.id]}
            busy={busyId === p.id || bulk !== null}
            onApprove={() => void approve(p)}
            onReject={() => void reject(p)}
          />
        ))}
      </div>
    </section>
  );
}

function PendingCard({
  p,
  age,
  err,
  busy,
  onApprove,
  onReject,
}: {
  p: PendingMutation;
  age: number;
  err?: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <p className="text-[13px] text-ink-900 whitespace-pre-wrap break-words">{p.summary}</p>
      <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-ink-400 tabular-nums">
        <span>{p.id}</span>
        <span className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600">{p.verb}</span>
        {p.target && <span>{p.target}</span>}
        <span>waiting {age}d</span>
      </div>
      {err && (
        <p className="text-[12px] text-rose-700 break-words">
          The board refused this: {err} It stays pending — reject it if it no longer applies.
        </p>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <PrimaryButton className="px-3" disabled={busy} onClick={onApprove}>
          Approve
        </PrimaryButton>
        <SecondaryButton className="px-3" disabled={busy} onClick={onReject}>
          Reject
        </SecondaryButton>
      </div>
    </div>
  );
}
