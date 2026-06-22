"use client";

// The Pantry surface — a lightweight, read-focused inventory over db.pantryItems, the
// close twin of the Food Log surface. SSR seeds the items list and the board version
// into local state; a live SSE subscription (useLiveBoard → subscribeToBoard) refetches
// whenever the board version advances past what we last saw (mirrors food-log-view), so
// an agent stocking the fridge via the nutrition MCP lands here without a reload.
//
// A PantryItem is "what's on hand" — a name, with an optional quantity/unit, a food
// category, a storage location, and an optional expiry day. Items are GROUPED BY
// CATEGORY (in the fixed PantryCategory order); each category header carries a count.
// An item nearing its expiresAt gets a "use soon" highlight (and an "expired" tone once
// past), and a manually-flagged running-low item shows a low-stock chip. Items can be
// stocked / edited / removed two ways: by the agent via the nutrition MCP, OR by the
// human right here — the toolbar (and empty-state) "Add item" button and a click on any
// row open the PantryItemDrawer, which writes to /api/nutrition/pantry and refetches.

import { useMemo, useRef, useState } from "react";
import type { PantryItem, PantryCategory, PantryLocation } from "@/lib/types";
import { VALID_PANTRY_CATEGORY } from "@/lib/types";
import { useLiveBoard } from "@/lib/use-live-board";
import { deletePantryItem } from "@/lib/nutrition-client";
import { toISODay, formatDay, addDays } from "@/lib/nutrition-format";
import { IconFridge, IconPlus, IconTrash, IconWarning } from "@/components/icons";
import { PantryItemDrawer } from "./pantry-item-drawer";

// What the drawer is doing: stocking a new item, or editing an existing one.
type Compose = { mode: "create" } | { mode: "edit"; item: PantryItem };

// Category display order + label — items read in the fixed PantryCategory order, with an
// "Uncategorized" bucket last for items with no category. Order mirrors VALID_PANTRY_CATEGORY.
const CATEGORY_LABEL: Record<PantryCategory, string> = {
  produce: "Produce",
  protein: "Protein",
  dairy: "Dairy",
  grain: "Grain",
  pantry: "Pantry",
  frozen: "Frozen",
  spice: "Spice",
  other: "Other",
};
const UNCATEGORIZED = "uncategorized"; // bucket key for items with no category (sorts last)
const UNCATEGORIZED_LABEL = "Uncategorized";

// Storage location → a short label for the per-item location chip.
const LOCATION_LABEL: Record<PantryLocation, string> = {
  fridge: "Fridge",
  freezer: "Freezer",
  pantry: "Pantry",
};

// Expiry windows (in days, against the SSR `now` clock): items past their expiresAt read
// "expired"; items within EXPIRING_SOON_DAYS read "use soon"; everything else is plain.
const EXPIRING_SOON_DAYS = 3;

export function PantryView({
  now,
  items: initialItems,
  version,
}: {
  now: string;
  items: PantryItem[];
  version?: number;
}) {
  // Live items list, seeded from SSR. The board version we last reconciled to — a ref so
  // the SSE callback always compares against the freshest value (mirrors food-log-view).
  const [items, setItems] = useState<PantryItem[]>(initialItems);
  const lastVersion = useRef<number>(version ?? 0);

  // The open drawer (stocking a new item / editing an existing one), or null when closed.
  const [compose, setCompose] = useState<Compose | null>(null);

  // Fixed clock — parsed ONCE from the SSR `now` prop, used only to classify expiry
  // ("expired" / "use soon"). Never `new Date()` during render, so SSR and the first
  // client render agree (no hydration drift); the expiry days are plain ISO day strings.
  const today = useMemo(() => toISODay(new Date(now)), [now]);
  const soonCutoff = useMemo(() => addDays(today, EXPIRING_SOON_DAYS), [today]);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full pantry list and replace state, advancing lastVersion. There is no
  // dedicated /api/nutrition/pantry list client fn; a pantry write bumps db.version →
  // SSE → we re-read the items from the pantry route (a DIRECT fetch, no board-client fn).
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetch("/api/nutrition/pantry");
      if (!res.ok) return; // a disabled/erroring read leaves the last-known list in place
      const data = (await res.json()) as { items?: PantryItem[]; version?: number };
      if (Array.isArray(data.items)) setItems(data.items);
      if (typeof data.version === "number") lastVersion.current = data.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known items in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // Group items by category (fixed PantryCategory order, Uncategorized last); within a
  // category, items sort by name. Recomputed whenever the live list changes.
  const groups = useMemo(() => groupByCategory(items), [items]);
  const hasAny = items.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left, Add item on the right. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Pantry</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <button
          onClick={() => setCompose({ mode: "create" })}
          className="ml-auto inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
        >
          <IconPlus className="w-3.5 h-3.5" />
          Add item
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {!hasAny ? (
            <EmptyState onCompose={() => setCompose({ mode: "create" })} />
          ) : (
            groups.map(({ key, label, items: catItems }) => (
              <section key={key}>
                {/* Category header — the label + the item count for this category. */}
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                    {label}
                  </h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600 tabular-nums">
                    {catItems.length}
                  </span>
                </div>
                <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                  {catItems.map((it) => (
                    <PantryRow
                      key={it.id}
                      item={it}
                      today={today}
                      soonCutoff={soonCutoff}
                      onOpen={() => setCompose({ mode: "edit", item: it })}
                      onDeleted={refetch}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {compose && (
        <PantryItemDrawer
          item={compose.mode === "edit" ? compose.item : null}
          onSaved={refetch}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

// One pantry row: the item name, the optional quantity/unit, an optional storage-location
// chip, a low-stock chip when flagged, an expiry chip (plain / "use soon" / "expired" by
// the SSR clock), and a quick-delete that reveals on hover/focus. Clicking the row (or
// Enter/Space) opens the editor drawer; the delete button stops propagation so it doesn't.
function PantryRow({
  item,
  today,
  soonCutoff,
  onOpen,
  onDeleted,
}: {
  item: PantryItem;
  today: string;
  soonCutoff: string;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const qty = formatQuantity(item.quantity, item.unit);
  const expiry = item.expiresAt ? classifyExpiry(item.expiresAt, today, soonCutoff) : null;

  // Row-level quick-delete state. `busy` guards against a double-submit; `error` surfaces
  // a failed delete inline (rose, mirroring the drawer's banner) instead of silently
  // no-op-ing. A hard delete has no undo, so we confirm first (like the drawer's Delete);
  // onDeleted() refetches the list on success.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation(); // never open the editor when deleting
    if (busy) return;
    if (!window.confirm(`Remove “${item.name}” from the pantry? This cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      await deletePantryItem(item.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the item.");
      setBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only a keypress on the row ITSELF opens the editor — a keydown bubbling up from
        // the nested delete button must not also open the drawer.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Edit ${item.name}`}
      className="group flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-ink-50 focus:outline-none focus-visible:bg-ink-50 transition-colors">
      {/* Name + (optional) quantity/unit and note beneath. */}
      <span className="flex-1 min-w-0">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-[13px] text-ink-900">{item.name}</span>
          {qty && <span className="text-[11.5px] text-ink-400 tabular-nums">{qty}</span>}
        </span>
        {item.note && (
          <span className="block mt-0.5 text-[11.5px] text-ink-400 italic">{item.note}</span>
        )}
      </span>

      {/* Low-stock — manual running-low flag. */}
      {item.lowStock && (
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200"
          title="Flagged running low"
        >
          Low
        </span>
      )}

      {/* Storage location — optional fridge/freezer/pantry. */}
      {item.location && (
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-100"
          title={`Stored in the ${LOCATION_LABEL[item.location].toLowerCase()}`}
        >
          {LOCATION_LABEL[item.location]}
        </span>
      )}

      {/* Expiry — optional. Plain when far out; "use soon" then "expired" as it nears/passes. */}
      {expiry && (
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${EXPIRY_CHIP[expiry.tone]}`}
          title={
            expiry.tone === "expired"
              ? `Expired ${formatDay(item.expiresAt!)}`
              : expiry.tone === "soon"
                ? `Use soon — expires ${formatDay(item.expiresAt!)}`
                : `Expires ${formatDay(item.expiresAt!)}`
          }
        >
          {expiry.label}
        </span>
      )}

      {/* Quick delete — hidden until row hover / keyboard focus. On failure it's replaced
          by an inline error chip (click to dismiss). Both stop propagation so the row's
          click/keydown never opens the editor while deleting. */}
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
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${item.name}`}
          title="Delete item"
          className="shrink-0 text-ink-300 hover:text-rose-600 transition opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
        >
          <IconTrash className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// The friendly empty state — shown when there are no pantry items at all.
function EmptyState({ onCompose }: { onCompose: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <div className="flex justify-center mb-2 text-ink-300">
        <IconFridge className="w-6 h-6" />
      </div>
      <p className="text-[13px] text-ink-700 font-medium mb-1">Your pantry is empty</p>
      <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto mb-4">
        Add what&rsquo;s in your fridge below, or ask your chief of staff — &ldquo;add a
        dozen eggs and a bunch of spinach to the fridge&rdquo; — and items appear here,
        grouped by category with expiry and low-stock flags.
      </p>
      <button
        onClick={onCompose}
        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
      >
        <IconPlus className="w-3.5 h-3.5" />
        Add item
      </button>
    </div>
  );
}

// ── Local helpers ────────────────────────────────────────────────────────────
// A grouped category with its sorted items. Categories follow the fixed PantryCategory
// order (VALID_PANTRY_CATEGORY), with an "Uncategorized" bucket last; items sort by name.
type CategoryGroup = { key: string; label: string; items: PantryItem[] };

function groupByCategory(items: PantryItem[]): CategoryGroup[] {
  const byCat = new Map<string, PantryItem[]>();
  for (const it of items) {
    const key = it.category ?? UNCATEGORIZED;
    const bucket = byCat.get(key);
    if (bucket) bucket.push(it);
    else byCat.set(key, [it]);
  }
  // Build groups in the canonical category order, then the Uncategorized bucket last.
  const ordered: CategoryGroup[] = [];
  for (const cat of VALID_PANTRY_CATEGORY) {
    const bucket = byCat.get(cat);
    if (bucket && bucket.length > 0) {
      ordered.push({ key: cat, label: CATEGORY_LABEL[cat], items: sortByName(bucket) });
    }
  }
  const uncat = byCat.get(UNCATEGORIZED);
  if (uncat && uncat.length > 0) {
    ordered.push({ key: UNCATEGORIZED, label: UNCATEGORIZED_LABEL, items: sortByName(uncat) });
  }
  return ordered;
}

function sortByName(items: PantryItem[]): PantryItem[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

// "3 cans" / "250 g" / "2" — a compact quantity+unit label, omitted when no quantity.
function formatQuantity(quantity?: number, unit?: string): string | null {
  if (quantity == null || !Number.isFinite(quantity)) return null;
  const amount = String(quantity);
  return unit ? `${amount} ${unit}` : amount;
}

// The expiry chip tone → a tinted chip. Full literal Tailwind strings per tone (no runtime
// concat) so the content scanner emits them. "soon" and "expired" only; far-out is plain.
const EXPIRY_CHIP: Record<"soon" | "expired", string> = {
  soon: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  expired: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};

// Classify an item's expiry against the SSR clock: past `today` → expired; on/before the
// "soon" cutoff (~3 days out) → use soon; further out → null (no chip). All ISO-day
// string compares (ISO days sort lexically), so this is deterministic across SSR/client.
function classifyExpiry(
  expiresAt: string,
  today: string,
  soonCutoff: string,
): { tone: "soon" | "expired"; label: string } | null {
  if (expiresAt < today) return { tone: "expired", label: "Expired" };
  if (expiresAt <= soonCutoff) return { tone: "soon", label: "Use soon" };
  return null; // far enough out to not need a chip
}

// toISODay (local "YYYY-MM-DD") + formatDay ("MMM D, YYYY") come from the shared
// nutrition-format module; addDays (the noon-anchored day-shift) from the engine. Both
// imported above so the whole feature shares one implementation of each.
