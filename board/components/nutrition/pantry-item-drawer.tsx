"use client";

// The pantry-item editor — a slide-over used for BOTH stocking a new pantry item
// (no `item`) and editing/removing an existing one. It mirrors the SHELL of the
// ReminderDrawer (fixed overlay + right aside + header Close · Esc + error banner +
// Save/Delete footer; Esc and an overlay click both close) but with PANTRY fields:
// a PantryItem is "what's on hand" — a name, an optional quantity/unit, a food
// category, a storage location, an optional expiry day, a running-low flag, and a
// freeform note.
//
// It writes through the typed nutrition-client (createPantryItem / updatePantryItem /
// deletePantryItem) — the SAME safe path the row's quick-delete uses — and calls
// onSaved() after each success so the parent (PantryView) refetches and closes. API
// errors surface in the banner (the thrown Error.message).
//
// One payload builder serves both create and edit: it sends explicit `null` for the
// cleared optionals. The POST route ignores nulls/empties, and the PATCH route's
// applyPantryUpdate treats a present `null`/"" as "clear this field", so an emptied
// input round-trips to an absent value on either path.

import { useEffect, useState } from "react";
import type { PantryItem, PantryCategory, PantryLocation } from "@/lib/types";
import { VALID_PANTRY_CATEGORY, VALID_PANTRY_LOCATION } from "@/lib/types";
import { createPantryItem, updatePantryItem, deletePantryItem } from "@/lib/nutrition-client";
import { IconWarning } from "@/components/icons";

// Category / location → a human label for the select options (mirrors PantryView's
// CATEGORY_LABEL / LOCATION_LABEL; kept local so the drawer stays self-contained).
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
const LOCATION_LABEL: Record<PantryLocation, string> = {
  fridge: "Fridge",
  freezer: "Freezer",
  pantry: "Pantry",
};

export function PantryItemDrawer({
  item,
  onSaved,
  onClose,
}: {
  // The pantry item being edited, or null when stocking a brand-new one.
  item: PantryItem | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = item !== null;

  // ── Form state (seeded from the item, or empty new-item defaults) ──────────
  // quantity is held as a STRING so the input can be cleared to "" (= no quantity);
  // it is parsed to a number (or null) at save time.
  const [name, setName] = useState(item?.name ?? "");
  const [quantity, setQuantity] = useState(
    item?.quantity != null && Number.isFinite(item.quantity) ? String(item.quantity) : "",
  );
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [category, setCategory] = useState<"" | PantryCategory>(item?.category ?? "");
  const [location, setLocation] = useState<"" | PantryLocation>(item?.location ?? "");
  const [expiresAt, setExpiresAt] = useState(item?.expiresAt ?? "");
  const [lowStock, setLowStock] = useState<boolean>(item?.lowStock ?? false);
  const [note, setNote] = useState(item?.note ?? "");

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Esc closes the drawer (matching the ReminderDrawer). Bound once per mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Save / delete ───────────────────────────────────────────────────────────
  // Build the wire payload from the form. Send explicit nulls so clearing a field
  // clears it on edit; on create the route ignores nulls/empties. quantity is parsed
  // here (an unparseable, non-empty quantity is caught in onSave before we get here).
  const buildPayload = (): Record<string, unknown> => {
    const q = quantity.trim();
    return {
      name: name.trim(),
      quantity: q === "" ? null : Number(q),
      unit: unit.trim() ? unit.trim() : null,
      category: category || null,
      location: location || null,
      expiresAt: expiresAt ? expiresAt : null,
      lowStock,
      note: note.trim() ? note.trim() : null,
    };
  };

  const onSave = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const q = quantity.trim();
    if (q !== "" && !Number.isFinite(Number(q))) {
      setError("Quantity must be a number.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (isEdit && item) {
        await updatePantryItem(item.id, buildPayload());
      } else {
        await createPantryItem(buildPayload());
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the item.");
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!isEdit || !item) return;
    if (!window.confirm(`Remove “${item.name}” from the pantry? This cannot be undone.`)) return;
    setError(null);
    setSaving(true);
    try {
      await deletePantryItem(item.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove the item.");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={isEdit ? `Edit pantry item ${item?.id}` : "New pantry item"}
        className="fixed top-0 right-0 h-screen w-full sm:w-[460px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">
            {isEdit ? "Edit pantry item" : "New pantry item"}
          </span>
          {isEdit && item && (
            <span className="text-[11px] tabular-nums text-ink-400">{item.id}</span>
          )}
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50"
          >
            Close · Esc
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2"
          >
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-rose-500 hover:text-rose-700 px-1"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name — the item itself. */}
          <Field label="Name">
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What's on hand?"
              aria-label="Name"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[13px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Quantity + unit — both optional, side by side. */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Quantity">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="e.g. 2"
                  aria-label="Quantity"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 tabular-nums outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Unit">
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="g, cans, bunch…"
                  aria-label="Unit"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
                />
              </Field>
            </div>
          </div>

          {/* Category + location — both optional, side by side. */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Category">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as "" | PantryCategory)}
                  aria-label="Category"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="">No category</option>
                  {VALID_PANTRY_CATEGORY.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Location">
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value as "" | PantryLocation)}
                  aria-label="Location"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="">No location</option>
                  {VALID_PANTRY_LOCATION.map((l) => (
                    <option key={l} value={l}>
                      {LOCATION_LABEL[l]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          {/* Expiry — optional calendar day. */}
          <Field label="Expires">
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              aria-label="Expiry date"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            />
          </Field>

          {/* Low stock — the manual running-low flag. */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={lowStock}
              onChange={(e) => setLowStock(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-ink-300 text-ink-900 focus:ring-sky-100"
            />
            <span className="text-[12.5px] text-ink-700">Running low</span>
          </label>

          {/* Note — optional freeform note. */}
          <Field label="Note">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Optional note…"
              aria-label="Note"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 resize-y"
            />
          </Field>
        </div>

        {/* Footer — Save (create/patch) + Delete on an existing item. */}
        <div className="px-5 h-14 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          {isEdit && (
            <button
              onClick={onDelete}
              disabled={saving}
              className="text-[12px] text-rose-600 hover:text-rose-700 px-2.5 py-1 rounded-md hover:bg-rose-50 border border-rose-200 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="text-[12px] px-3 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add item"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// A labelled form row (mirrors the ReminderDrawer's Field).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}
