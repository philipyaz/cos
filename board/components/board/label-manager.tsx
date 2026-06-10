"use client";

import { useCallback, useEffect, useState } from "react";
import type { LabelColor, LabelDef } from "@/lib/types";
import { VALID_LABEL_COLORS } from "@/lib/types";
import { labelChipClasses, labelDotClass } from "@/lib/format";
import {
  fetchBundles,
  installBundle as apiInstallBundle,
  uninstallBundle as apiUninstallBundle,
  createLabel as apiCreateLabel,
  updateLabel as apiUpdateLabel,
  deleteLabel as apiDeleteLabel,
  type BundleView,
} from "@/lib/board-client";
import { IconPlus } from "@/components/icons";

// The Labels manager — a slide-over for configuring the board's taxonomy entirely
// from the UI: install role/life bundles in one click, add custom labels, and edit
// or remove existing ones. Every mutation hits the label API and calls onChanged()
// so the board re-reads the catalog (chips/filter stay in sync). This is the
// "personalize your depth of categorization" surface.
export function LabelManager({
  open,
  onClose,
  labels,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  labels: LabelDef[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"yours" | "bundles">("yours");
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-label composer.
  const [nTitle, setNTitle] = useState("");
  const [nDesc, setNDesc] = useState("");
  const [nColor, setNColor] = useState<LabelColor>("gray");

  const loadBundles = useCallback(async () => {
    try {
      const res = await fetchBundles();
      setBundles(res.bundles);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load bundles.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (bundles === null) void loadBundles();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, bundles, loadBundles, onClose]);

  if (!open) return null;

  // Run a label mutation, then refresh both the board catalog and the bundle
  // install-state. Surfaces the API error text on failure.
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
      await loadBundles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // Install a bundle, then surface any conflicts (a same-id label already in the
  // catalog with a different definition — kept as-is, the bundle's version skipped)
  // so the install-order-wins behaviour is visible, not silent.
  const installBundleWithNotice = async (id: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiInstallBundle(id);
      onChanged();
      await loadBundles();
      if (res.conflicts?.length) {
        setNotice(
          `${res.conflicts.length} label${res.conflicts.length === 1 ? "" : "s"} already existed with a ` +
            `different meaning and ${res.conflicts.length === 1 ? "was" : "were"} kept as-is: ` +
            res.conflicts.map((c) => `${c.id} (“${c.kept.title}”)`).join(", ") + ".",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // Uninstall a bundle — removes the labels it owns and (by default) strips them
  // off any cases that carry them. Confirms first since it can touch many cases.
  const uninstallBundleWithConfirm = async (b: BundleView): Promise<void> => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Uninstall “${b.name}”? This removes its ${b.ownedCount} label${b.ownedCount === 1 ? "" : "s"} ` +
          `and removes them from any cases that use them. Custom labels and labels from other bundles are kept.`,
      )
    )
      return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiUninstallBundle(b.id);
      onChanged();
      await loadBundles();
      setNotice(
        `Uninstalled “${b.name}”: removed ${res.removed.length} label${res.removed.length === 1 ? "" : "s"}` +
          (res.scrubbed ? ` and cleared them from ${res.scrubbed} case${res.scrubbed === 1 ? "" : "s"}` : "") +
          ".",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const addLabel = async () => {
    const title = nTitle.trim();
    if (!title) return;
    await run(() => apiCreateLabel({ title, description: nDesc.trim(), color: nColor }));
    setNTitle("");
    setNDesc("");
    setNColor("gray");
  };

  const installed = new Set(labels.map((l) => l.id));
  const roleBundles = bundles?.filter((b) => b.category === "role") ?? [];
  const lifeBundles = bundles?.filter((b) => b.category === "life") ?? [];
  const universalBundles = bundles?.filter((b) => b.category === "universal") ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-[60]" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Manage labels"
        className="fixed top-0 right-0 h-screen w-full sm:w-[520px] bg-white border-l border-ink-200 shadow-xl z-[61] flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">Labels</span>
          <span className="text-[11.5px] text-ink-400 tabular-nums">{labels.length} active</span>
          <button
            onClick={onClose}
            aria-label="Close labels manager"
            className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50"
          >
            Close · Esc
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1">
          {(["yours", "bundles"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[12.5px] px-2.5 py-1 rounded-md transition ${
                tab === t ? "text-ink-900 bg-ink-100 font-medium" : "text-ink-500 hover:text-ink-900 hover:bg-ink-50"
              }`}
            >
              {t === "yours" ? "Your labels" : "Bundles"}
            </button>
          ))}
        </div>

        {error && (
          <div role="alert" className="mx-5 mt-3 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
            {error}
          </div>
        )}
        {notice && (
          <div className="mx-5 mt-3 px-3 py-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-100 rounded-md flex items-start gap-2">
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="text-amber-500 hover:text-amber-700">
              ×
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "yours" ? (
            <>
              {/* Add custom label */}
              <div className="rounded-lg border border-ink-200 p-3 mb-4">
                <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-2">Add a custom label</div>
                <input
                  value={nTitle}
                  onChange={(e) => setNTitle(e.target.value)}
                  placeholder="Title (e.g. Access request)"
                  aria-label="New label title"
                  className="w-full text-[13px] px-2 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 mb-2"
                />
                <input
                  value={nDesc}
                  onChange={(e) => setNDesc(e.target.value)}
                  placeholder="Description — when does this label apply?"
                  aria-label="New label description"
                  className="w-full text-[12.5px] px-2 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 mb-2"
                />
                <div className="flex items-center gap-2">
                  <ColorPicker value={nColor} onChange={setNColor} />
                  <button
                    onClick={addLabel}
                    disabled={!nTitle.trim() || busy}
                    className="ml-auto inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white disabled:opacity-40"
                  >
                    <IconPlus className="w-3.5 h-3.5" />
                    Add
                  </button>
                </div>
              </div>

              {/* Active labels */}
              {labels.length === 0 ? (
                <div className="text-[12.5px] text-ink-400 py-6 text-center">
                  No labels yet. Add one above or install a bundle.
                </div>
              ) : (
                <div className="space-y-2">
                  {labels.map((l) => (
                    <LabelRow key={l.id} label={l} busy={busy} run={run} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {bundles === null ? (
                <div className="text-[12.5px] text-ink-400 py-6 text-center">Loading bundles…</div>
              ) : (
                <div className="space-y-5">
                  <BundleGroup title="By role" bundles={roleBundles} installed={installed} busy={busy} onInstall={installBundleWithNotice} onUninstall={uninstallBundleWithConfirm} />
                  <BundleGroup title="For life" bundles={lifeBundles} installed={installed} busy={busy} onInstall={installBundleWithNotice} onUninstall={uninstallBundleWithConfirm} />
                  <BundleGroup title="Universal" bundles={universalBundles} installed={installed} busy={busy} onInstall={installBundleWithNotice} onUninstall={uninstallBundleWithConfirm} />
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );

  function BundleGroup({
    title,
    bundles,
    installed,
    busy,
    onInstall,
    onUninstall,
  }: {
    title: string;
    bundles: BundleView[];
    installed: Set<string>;
    busy: boolean;
    onInstall: (id: string) => void;
    onUninstall: (b: BundleView) => void;
  }) {
    if (bundles.length === 0) return null;
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-2">{title}</div>
        <div className="space-y-2">
          {bundles.map((b) => {
            const allIn = b.labels.length > 0 && b.labels.every((l) => installed.has(l.id));
            const owned = b.ownedCount > 0;
            return (
              <div key={b.id} className="rounded-lg border border-ink-100 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink-900">{b.name}</span>
                  <span className="text-[11px] text-ink-400 tabular-nums">{b.labels.length}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {!allIn && (
                      <button
                        onClick={() => onInstall(b.id)}
                        disabled={busy}
                        className="text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-900 hover:bg-ink-50 transition"
                      >
                        {/* "Add missing" only when THIS bundle already owns some of its
                            labels (partially installed). A bundle the user never installed
                            can still have labels present via a shared id from another
                            bundle (installedCount > 0) — that must read as "Install". */}
                        {owned ? "Add missing" : "Install"}
                      </button>
                    )}
                    {owned ? (
                      <button
                        onClick={() => onUninstall(b)}
                        disabled={busy}
                        title={`Remove the ${b.ownedCount} label(s) this bundle added`}
                        className="text-[12px] px-2.5 py-1 rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50 transition"
                      >
                        Uninstall
                      </button>
                    ) : allIn ? (
                      <span className="text-[12px] px-2.5 py-1 rounded-md border border-ink-100 bg-ink-50 text-ink-400">
                        Installed
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="text-[12px] text-ink-500 mt-0.5 mb-2">{b.description}</div>
                <div className="flex flex-wrap gap-1">
                  {b.labels.map((l) => (
                    <span
                      key={l.id}
                      title={l.description}
                      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full ${labelChipClasses(l.color)} ${
                        installed.has(l.id) ? "" : "opacity-60"
                      }`}
                    >
                      {l.title}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
}

// One editable row in "Your labels": colour swatch, inline title, inline
// description, delete. Edits save on blur; delete confirms and scrubs from cases.
function LabelRow({
  label,
  busy,
  run,
}: {
  label: LabelDef;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(label.title);
  const [desc, setDesc] = useState(label.description);

  // Re-seed the drafts only when a DIFFERENT label mounts in this row (keyed on
  // id), NOT when the label's fields change — otherwise a refetch (e.g. an SSE
  // event mid-edit) would clobber the user's unsaved text with the server value.
  // Mirrors the EditableText pattern in case-detail-drawer.tsx.
  useEffect(() => {
    setTitle(label.title);
    setDesc(label.description);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label.id]);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== label.title) void run(() => apiUpdateLabel(label.id, { title: t }));
    else setTitle(label.title);
  };
  const saveDesc = () => {
    if (desc !== label.description) void run(() => apiUpdateLabel(label.id, { description: desc }));
  };
  const onDelete = () => {
    if (typeof window !== "undefined" &&
      !window.confirm(`Delete label “${label.title}”? It will be removed from all cases.`)) return;
    void run(() => apiDeleteLabel(label.id, true));
  };

  return (
    <div className="rounded-lg border border-ink-100 p-2.5">
      <div className="flex items-center gap-2">
        <ColorPicker
          value={label.color ?? "gray"}
          onChange={(c) => void run(() => apiUpdateLabel(label.id, { color: c }))}
          compact
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label={`Title for ${label.id}`}
          className="flex-1 text-[13px] font-medium text-ink-900 px-1.5 py-1 rounded border border-transparent hover:border-ink-200 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 outline-none"
        />
        {label.bundle && (
          <span className="text-[10px] text-ink-400 px-1.5 py-0.5 rounded-full bg-ink-50" title={`From bundle: ${label.bundle}`}>
            {label.bundle}
          </span>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${label.title}`}
          className="text-ink-300 hover:text-rose-600 text-[15px] leading-none px-1"
        >
          ×
        </button>
      </div>
      <input
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={saveDesc}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="Description — when does this label apply?"
        aria-label={`Description for ${label.id}`}
        className="w-full mt-1 text-[12px] text-ink-500 px-1.5 py-1 rounded border border-transparent hover:border-ink-200 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 outline-none"
      />
    </div>
  );
}

// A compact colour picker over the fixed label palette.
function ColorPicker({
  value,
  onChange,
  compact = false,
}: {
  value: LabelColor;
  onChange: (c: LabelColor) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Pick colour"
        className={`grid place-items-center rounded-full border border-ink-200 hover:ring-2 hover:ring-ink-100 ${compact ? "w-5 h-5" : "w-6 h-6"}`}
      >
        <span className={`rounded-full ${labelDotClass(value)} ${compact ? "w-2.5 h-2.5" : "w-3 h-3"}`} />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 p-1.5 bg-white rounded-md border border-ink-200 shadow-card grid grid-cols-6 gap-1">
          {VALID_LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className={`w-5 h-5 grid place-items-center rounded-full hover:ring-2 hover:ring-ink-200 ${value === c ? "ring-2 ring-ink-300" : ""}`}
            >
              <span className={`w-3 h-3 rounded-full ${labelDotClass(c)}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
