"use client";

// The Shopping surface — the fourth Nutrition & Chef vertical, over db.shoppingItems (cos-ops#37
// shipped the state; this is the human face, cos-ops#38). SSR seeds the list + the computed
// Suggested candidates + the board version into local state; a live SSE subscription
// (useLiveBoard → subscribeToBoard) refetches both reads whenever the board version advances
// past what we last saw, so a Friday-routine or agent write lands here without a reload.
//
// Every interaction below drives the SAME /api/nutrition/shopping* routes the nutrition MCP's
// five shopping tools already wrap (no new route, tool, status shape, or store field — see the
// issue's criterion 9). Items are GROUPED BY CATEGORY in the fixed aisle order
// (groupShoppingByCategory, board/lib/nutrition-format.ts), uncategorized last. Ticking a row is
// the ENTIRE gesture — one tap, no drawer, no confirm — and moves it into a collapsed "Bought &
// dismissed" pile that a second tap (once expanded) restores; a small Dismiss control is
// distinct from bought. Quick-add is one always-visible input pinned above the list — it leaves
// `category` UNSET on purpose (see createShoppingItem below) rather than defaulting to "other".
// Suggested renders the candidates read verbatim (never a write until "Add" is tapped) — see the
// ADR 0025 note on SuggestedRow. Every status-changing tap follows the reminders-view discipline:
// a `busy` guard, then `finally { onMutated() }` so BOTH success and failure reconcile to server
// truth (no optimistic state to desync), with the error surfaced inline.

import { useMemo, useRef, useState } from "react";
import type { ShoppingItem, ShoppingCategory, ShoppingSource, ShoppingStatus } from "@/lib/types";
import type { ShoppingCandidate } from "@/lib/shopping-candidates";
import { useLiveBoard } from "@/lib/use-live-board";
import { createShoppingItem, updateShoppingItem } from "@/lib/nutrition-client";
import { groupShoppingByCategory } from "@/lib/nutrition-format";
import { relativeTime } from "@/lib/format";
import { IconCart, IconPlus, IconX, IconWarning, IconChevronDown, IconChevronRight } from "@/components/icons";

// Category display order + label — mirrors pantry-view.tsx's CATEGORY_LABEL idiom exactly, but
// keyed to ShoppingCategory. The grouping itself (order + uncategorized-last) lives in
// board/lib/nutrition-format.ts; this is display strings only.
const SHOPPING_CATEGORY_LABEL: Record<ShoppingCategory, string> = {
  produce: "Produce",
  protein: "Protein",
  dairy: "Dairy",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  household: "Household",
  "personal-care": "Personal care",
  other: "Other",
};
const UNCATEGORIZED_LABEL = "Uncategorized";

// A group key resolves to its display label, or "Uncategorized" for the one bucket that isn't a
// real ShoppingCategory — mirrors navIcon()'s cast-and-fallback shape (nav-icons.tsx:59).
function categoryLabel(key: string): string {
  return (SHOPPING_CATEGORY_LABEL as Record<string, string>)[key] ?? UNCATEGORIZED_LABEL;
}

// Source chip label — shown only when source !== "manual" (a manual add needs no provenance
// chip). "manual" itself is never rendered but the map stays total so a lookup never falls back.
const SOURCE_LABEL: Record<ShoppingSource, string> = {
  manual: "manual",
  plan: "from plan",
  pantry: "from pantry",
  channel: "from chat",
};

export function ShoppingView({
  now,
  items: initialItems,
  candidates: initialCandidates,
  version,
}: {
  now: string;
  items: ShoppingItem[];
  candidates: ShoppingCandidate[];
  version?: number;
}) {
  const [items, setItems] = useState<ShoppingItem[]>(initialItems);
  const [candidates, setCandidates] = useState<ShoppingCandidate[]>(initialCandidates);
  const lastVersion = useRef<number>(version ?? 0);
  // The "Bought & dismissed" pile is collapsed by default (it only grows) — click the header to
  // expand it, mirroring reminders-view's "Done & dismissed" pile exactly.
  const [showFinished, setShowFinished] = useState(false);

  // Fixed clock — parsed ONCE from the SSR `now` prop (mirrors reminders-view), used only for
  // the pile's "bought X ago" hint. Never `new Date()` during render, so SSR and the first
  // client render agree (no hydration drift).
  const clock = useMemo(() => new Date(now), [now]);

  // Quick-add — the always-visible input's own local state.
  const [draft, setDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch BOTH reads (the list + the computed candidates) and replace state, advancing
  // lastVersion off the list response — reads stay inline (pantry-view.tsx:83-93 is the model),
  // each in its own try/catch so a hiccup on one leaves the other's last-known state alone.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetch("/api/nutrition/shopping");
      if (res.ok) {
        const data = (await res.json()) as { items?: ShoppingItem[]; version?: number };
        if (Array.isArray(data.items)) setItems(data.items);
        if (typeof data.version === "number") lastVersion.current = data.version;
      }
    } catch {
      // Non-critical: a failed refetch just leaves the last-known items in place.
    }
    try {
      const res = await fetch("/api/nutrition/shopping/candidates");
      if (res.ok) {
        const data = (await res.json()) as { candidates?: ShoppingCandidate[] };
        if (Array.isArray(data.candidates)) setCandidates(data.candidates);
      }
    } catch {
      // Non-critical: a failed refetch just leaves the last-known candidates in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  const neededItems = useMemo(() => items.filter((it) => it.status === "needed"), [items]);
  const groups = useMemo(() => groupShoppingByCategory(neededItems), [neededItems]);
  // Bought + dismissed, most-recently-changed first.
  const finished = useMemo(
    () =>
      items
        .filter((it) => it.status !== "needed")
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    [items],
  );
  const isEmpty = items.length === 0 && candidates.length === 0;

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name || addBusy) return;
    setAddError(null);
    setAddBusy(true);
    try {
      await createShoppingItem({ name });
      setDraft(""); // keep the draft on failure so a retry doesn't lose what was typed
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add the item.");
    } finally {
      setAddBusy(false);
      refetch();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left; no Add button, the quick-add input replaces it. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Shopping</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {neededItems.length} to buy
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {/* Quick-add — one always-visible input + Enter. No category picker, no drawer:
              category stays unset so the row lands in Uncategorized (deliberate — see
              createShoppingItem call above; unset is the agent's cue to categorise it later). */}
          <div>
            <form onSubmit={onAdd} className="flex gap-2">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add an item — milk, batteries…"
                aria-label="Add an item"
                disabled={addBusy}
                className="flex-1 text-[13px] px-3 py-2 rounded-lg border border-ink-200 bg-white placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-ink-900/10 disabled:opacity-50"
              />
            </form>
            {addError && (
              <p role="alert" className="mt-1.5 text-[11.5px] text-rose-700">
                {addError}
              </p>
            )}
          </div>

          {isEmpty ? (
            <EmptyState />
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="flex items-center gap-2 mb-1.5 px-1">
                    <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                      {categoryLabel(g.key)}
                    </h2>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600 tabular-nums">
                      {g.items.length}
                    </span>
                  </div>
                  <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                    {g.items.map((it) => (
                      <ShoppingRow key={it.id} item={it} onMutated={refetch} />
                    ))}
                  </div>
                </section>
              ))}

              {/* Suggested — a pure read of the candidates engine; writes nothing until "Add"
                  is tapped (see SuggestedRow). */}
              {candidates.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-1.5 px-1">
                    <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                      Suggested
                    </h2>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600 tabular-nums">
                      {candidates.length}
                    </span>
                  </div>
                  <div className="rounded-lg border border-dashed border-ink-200 bg-white/60 divide-y divide-ink-50 overflow-hidden">
                    {candidates.map((c, i) => (
                      <SuggestedRow key={`${c.source}-${c.sourceRef ?? c.name}-${i}`} candidate={c} onAdded={refetch} />
                    ))}
                  </div>
                </section>
              )}

              {/* Bought & dismissed — the reminders "Done & dismissed" pile verbatim: collapsed
                  by default, an always-visible header + live count so a mis-tick is never
                  silent, expand to restore a row with one more tap. */}
              {finished.length > 0 && (
                <section className="pt-2 border-t border-ink-100">
                  <button
                    type="button"
                    onClick={() => setShowFinished((v) => !v)}
                    aria-expanded={showFinished}
                    className="w-full flex items-center gap-1.5 mb-1.5 px-1 text-ink-300 hover:text-ink-500 transition"
                  >
                    {showFinished ? (
                      <IconChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <IconChevronRight className="w-3.5 h-3.5" />
                    )}
                    <h2 className="text-[11px] uppercase tracking-wide font-medium">
                      Bought &amp; dismissed
                    </h2>
                    <span className="text-[11px] tabular-nums">{finished.length}</span>
                  </button>
                  {showFinished && (
                    <div className="rounded-lg border border-ink-100 bg-ink-50/40 divide-y divide-ink-100/60 overflow-hidden opacity-80">
                      {finished.map((it) => (
                        <FinishedRow key={it.id} item={it} clock={clock} onMutated={refetch} />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared PATCH discipline for every status-changing tap (tick/dismiss/restore): busy guard, the
// write, then `finally { onMutated() }` so BOTH success and failure reconcile to server truth
// (no optimistic state to desync — the reminders-view precedent), with the error surfaced inline.
async function applyPatch(
  id: string,
  patch: { status: ShoppingStatus },
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  onMutated: () => void,
): Promise<void> {
  setError(null);
  setBusy(true);
  try {
    await updateShoppingItem(id, patch);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to update the item.");
  } finally {
    setBusy(false);
    onMutated();
  }
}

// One "needed" row: the WHOLE row is the tick target (status → "bought"), plus a small Dismiss
// (✕) control, distinct from bought, that stops propagation so it never also ticks the row.
function ShoppingRow({ item, onMutated }: { item: ShoppingItem; onMutated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onTick = async () => {
    if (busy) return;
    await applyPatch(item.id, { status: "bought" }, setBusy, setError, onMutated);
  };
  const onDismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    await applyPatch(item.id, { status: "dismissed" }, setBusy, setError, onMutated);
  };

  const qty = formatQuantity(item.quantity, item.unit);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTick}
      onKeyDown={(e) => {
        // Only a keypress on the row ITSELF ticks it — a keydown bubbling up from the nested
        // Dismiss button must not also tick the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onTick();
        }
      }}
      aria-label={`Mark ${item.name} as bought`}
      className="group flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-ink-50 focus:outline-none focus-visible:bg-ink-50 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="inline-flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[13px] text-ink-900">{item.name}</span>
          {qty && <span className="text-[11.5px] text-ink-400 tabular-nums">{qty}</span>}
          {item.source !== "manual" && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-100">
              {SOURCE_LABEL[item.source]}
            </span>
          )}
        </span>
        {item.note && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 italic">{item.note}</span>
        )}
      </span>

      {/* Dismiss — hidden until row hover / keyboard focus (mirrors pantry-view's quick-delete).
          On failure it's replaced by an inline error chip (click to dismiss the chip itself). */}
      {error ? (
        <span
          role="alert"
          onClick={(e) => {
            e.stopPropagation();
            setError(null);
          }}
          title={`${error} · click to dismiss`}
          className="shrink-0 inline-flex items-center gap-1 max-w-[180px] text-[10.5px] px-1.5 py-0.5 rounded-full font-medium bg-rose-50 text-rose-700 cursor-pointer"
        >
          <IconWarning className="w-3 h-3 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          aria-label={`Dismiss ${item.name}`}
          title="Dismiss"
          className="shrink-0 text-ink-300 hover:text-rose-600 transition opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
        >
          <IconX className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// One Suggested row: the candidate's name + its `reason` rendered VERBATIM (the ADR 0025
// condition-4 "(inferred — no printed date)" label rides inside `reason` — never reformat or
// truncate this string) + a source chip, and one "Add" button. Nothing here writes until Add is
// tapped; the created item carries the candidate's own source/sourceRef, so the engine
// suppresses it on the next candidates read (the handoff the state half was built for).
function SuggestedRow({ candidate, onAdded }: { candidate: ShoppingCandidate; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await createShoppingItem({ name: candidate.name, source: candidate.source, sourceRef: candidate.sourceRef });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the item.");
    } finally {
      setBusy(false);
      onAdded();
    }
  };

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span className="flex-1 min-w-0">
        <span className="inline-flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[13px] text-ink-700">{candidate.name}</span>
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-100">
            {SOURCE_LABEL[candidate.source]}
          </span>
        </span>
        <span className="block mt-0.5 text-[11.5px] text-ink-400">{candidate.reason}</span>
      </span>

      {error ? (
        <span
          role="alert"
          onClick={() => setError(null)}
          title={`${error} · click to dismiss`}
          className="shrink-0 inline-flex items-center gap-1 max-w-[180px] text-[10.5px] px-1.5 py-0.5 rounded-full font-medium bg-rose-50 text-rose-700 cursor-pointer"
        >
          <IconWarning className="w-3 h-3 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 transition disabled:opacity-50"
        >
          <IconPlus className="w-3 h-3" />
          Add
        </button>
      )}
    </div>
  );
}

// One row inside the collapsed "Bought & dismissed" pile — tapping it restores status:"needed",
// mirroring reminders-view's ReminderRow toggle exactly (busy guard, finally-reconcile).
function FinishedRow({
  item,
  clock,
  onMutated,
}: {
  item: ShoppingItem;
  // The fixed, SSR-minted clock threaded from ShoppingView — never built locally, so the "bought
  // X ago" hint matches the server render (no hydration drift).
  clock: Date;
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRestore = async () => {
    if (busy) return;
    await applyPatch(item.id, { status: "needed" }, setBusy, setError, onMutated);
  };

  const boughtHint = item.status === "bought" && item.boughtAt ? relativeTime(item.boughtAt, clock) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRestore}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRestore();
        }
      }}
      aria-label={`Restore ${item.name} to the list`}
      className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-ink-100/40 transition-colors"
    >
      <span
        className={`flex-1 min-w-0 truncate text-[12.5px] ${
          item.status === "bought" ? "text-ink-400 line-through" : "text-ink-400 italic"
        }`}
      >
        {item.name}
      </span>
      {boughtHint && (
        <span className="shrink-0 text-[10.5px] text-ink-300 tabular-nums">bought {boughtHint}</span>
      )}
      {item.status === "dismissed" && (
        <span className="shrink-0 text-[10.5px] text-ink-300">dismissed</span>
      )}
      {error && (
        <span
          role="alert"
          onClick={(e) => {
            e.stopPropagation();
            setError(null);
          }}
          title={`${error} · click to dismiss`}
          className="shrink-0 text-[10.5px] text-rose-600 cursor-pointer"
        >
          {error}
        </span>
      )}
    </div>
  );
}

// The friendly empty state — shown only when there is truly nothing to show (no items in any
// status AND no Suggested candidates). The quick-add above still carries the page otherwise.
function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconCart className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">Nothing on the list</p>
      <p className="text-[12.5px] text-ink-500 max-w-[420px] mx-auto">
        Add something above, or ask your chief of staff — &ldquo;add batteries to my
        list&rdquo; — and it appears here.
      </p>
    </div>
  );
}

// "3 cans" / "250 g" / "2" — a compact quantity+unit label, omitted when no quantity (mirrors
// pantry-view.tsx's local, unexported formatQuantity — kept local here too, not shared).
function formatQuantity(quantity?: number, unit?: string): string | null {
  if (quantity == null || !Number.isFinite(quantity)) return null;
  const amount = String(quantity);
  return unit ? `${amount} ${unit}` : amount;
}
