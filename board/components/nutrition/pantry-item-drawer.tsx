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
// deletePantryItem) and calls onSaved() after each success so the parent (PantryView)
// refetches and closes. API errors surface in the banner (the thrown Error.message). Its
// Delete is this item's only route since cos-ops#86 removed the row's own hover-only
// quick-delete (undiscoverable on a coarse pointer; this was already the equivalent
// visible route).
//
// One payload builder serves both create and edit: it sends explicit `null` for the
// cleared optionals. The POST route ignores nulls/empties, and the PATCH route's
// applyPantryUpdate treats a present `null`/"" as "clear this field", so an emptied
// input round-trips to an absent value on either path.

import { useState } from "react";
import type { PantryItem, PantryCategory, PantryLocation } from "@/lib/types";
import { VALID_PANTRY_CATEGORY, VALID_PANTRY_LOCATION } from "@/lib/types";
import { createPantryItem, updatePantryItem, deletePantryItem } from "@/lib/nutrition-client";
import { TextInput, TextArea, Select, Field } from "@/components/shared/field";
import { PrimaryButton, SecondaryButton, DestructiveButton } from "@/components/shared/action-button";
import { DrawerHeader, DrawerShell } from "@/components/shared/drawer";
import { Alert } from "@/components/shared/alert";

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
    <DrawerShell
      ariaLabel={isEdit ? `Edit pantry item ${item?.id}` : "New pantry item"}
      width={460}
      onClose={onClose}
      footer={
        <div className="px-5 min-h-14 pb-safe flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          {isEdit && (
            <DestructiveButton onClick={onDelete} disabled={saving} className="px-2.5">
              Delete
            </DestructiveButton>
          )}
          <div className="ml-auto flex items-center gap-2">
            <SecondaryButton onClick={onClose} disabled={saving} className="px-2.5">
              Cancel
            </SecondaryButton>
            <PrimaryButton onClick={onSave} disabled={saving} className="px-3">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add item"}
            </PrimaryButton>
          </div>
        </div>
      }
    >
      <DrawerHeader closeLabel="Close drawer" onClose={onClose}>
        <span className="text-[13px] font-semibold text-ink-900">
          {isEdit ? "Edit pantry item" : "New pantry item"}
        </span>
        {isEdit && item && (
          <span className="text-[11px] tabular-nums text-ink-400">{item.id}</span>
        )}
      </DrawerHeader>

      {error && (
        <Alert edge="flush" className="px-5" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Name — the item itself. */}
        <Field label="Name">
          <TextInput
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What's on hand?"
            aria-label="Name"
            className="w-full"
          />
        </Field>

        {/* Quantity + unit — both optional, side by side. */}
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Quantity">
              <TextInput
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 2"
                aria-label="Quantity"
                className="w-full tabular-nums"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Unit">
              <TextInput
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="g, cans, bunch…"
                aria-label="Unit"
                className="w-full"
              />
            </Field>
          </div>
        </div>

        {/* Category + location — both optional, side by side. */}
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Category">
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as "" | PantryCategory)}
                aria-label="Category"
                className="w-full"
              >
                <option value="">No category</option>
                {VALID_PANTRY_CATEGORY.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Location">
              <Select
                value={location}
                onChange={(e) => setLocation(e.target.value as "" | PantryLocation)}
                aria-label="Location"
                className="w-full"
              >
                <option value="">No location</option>
                {VALID_PANTRY_LOCATION.map((l) => (
                  <option key={l} value={l}>
                    {LOCATION_LABEL[l]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {/* Expiry — optional calendar day. */}
        <Field label="Expires">
          <TextInput
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            aria-label="Expiry date"
            className="w-full"
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
          <TextArea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional note…"
            aria-label="Note"
            className="w-full resize-y"
          />
        </Field>
      </div>
    </DrawerShell>
  );
}
