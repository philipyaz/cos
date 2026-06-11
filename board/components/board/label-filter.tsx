"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LabelDef } from "@/lib/types";
import { labelChipClasses, labelDotClass } from "@/lib/format";
import { fetchBundles, type BundleView } from "@/lib/board-client";
import { IconTag, IconChevronDown, IconChevronRight, IconSearch } from "@/components/icons";

// The board's label filter. Instead of a flat wall of every catalog chip, it's a
// compact "Labels" dropdown whose primary control is a CATEGORY <select>: a real
// drop-down listing the user's installed bundles (Manager, Private banking, Health
// …) grouped under Role / Life / Universal / Custom, each with a count — so you can
// scope to a PRECISE category (a specific bundle) or a whole category, then a search
// narrows further. The list is grouped by bundle for scanning. The active selection
// (an OR facet) shows as removable chips beside the button so it stays visible when
// closed. Bundle names/categories are lazy-loaded from /api/labels/bundles on first
// open (with a graceful id-based fallback) so the picker is cheap on every load.

type Category = "role" | "life" | "universal" | "custom";

const CAT_ORDER: Category[] = ["role", "life", "universal", "custom"];
const CAT_LABEL: Record<Category, string> = {
  role: "Role",
  life: "Life",
  universal: "Universal",
  custom: "Custom",
};

// Humanize a bundle id when its friendly name hasn't loaded yet.
function titleCase(id: string): string {
  return id
    .replace(/^life-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function LabelFilter({
  catalog,
  selected,
  onToggle,
  onSelectMany,
  onClear,
}: {
  catalog: LabelDef[];
  selected: string[];
  onToggle: (id: string) => void;
  onSelectMany: (ids: string[], on: boolean) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // scope: "all" | "cat:<category>" | "bundle:<bundleId>"
  const [scope, setScope] = useState("all");
  // bundle group keys the user has expanded (groups are collapsed by default so the
  // dropdown reads as a checkable list of bundles — the "scope of bundles" surface).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // bundle id → { name, category } for grouping + the category select.
  const meta = useMemo(() => {
    const m = new Map<string, { name: string; category: Category }>();
    for (const b of bundles ?? []) m.set(b.id, { name: b.name, category: b.category as Category });
    return m;
  }, [bundles]);

  // Lazy-load bundle metadata + wire outside-click / Esc when the popover opens.
  useEffect(() => {
    if (!open) return;
    if (bundles === null) {
      void fetchBundles()
        .then((r) => setBundles(r.bundles))
        .catch(() => setBundles([]));
    }
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, bundles]);

  const selSet = useMemo(() => new Set(selected), [selected]);
  const byId = useMemo(() => new Map(catalog.map((l) => [l.id, l])), [catalog]);

  const toggleExpanded = (key: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // A label's category = its bundle's category, with a robust id-based fallback for
  // when bundle metadata hasn't loaded (or a custom label with no provenance).
  const categoryOf = (l: LabelDef): Category => {
    if (l.bundle && meta.has(l.bundle)) return meta.get(l.bundle)!.category;
    if (l.bundle === "universal") return "universal";
    if (l.bundle?.startsWith("life-")) return "life";
    if (l.bundle) return "role";
    return "custom";
  };
  const bundleName = (id?: string): string => (id ? meta.get(id)?.name ?? titleCase(id) : "Custom");

  // The category <select> options, derived from the catalog the user actually has:
  // each distinct bundle (with a count) grouped under its category. Built from the
  // catalog so it's populated immediately; names sharpen once bundle meta loads.
  const scopeByCat = useMemo(() => {
    const perBundle = new Map<string, { category: Category; count: number }>();
    for (const l of catalog) {
      const key = l.bundle ?? "__custom__";
      const cur = perBundle.get(key) ?? { category: categoryOf(l), count: 0 };
      cur.count += 1;
      perBundle.set(key, cur);
    }
    const byCat = new Map<Category, { key: string; name: string; count: number }[]>();
    for (const [key, info] of perBundle) {
      const arr = byCat.get(info.category) ?? [];
      arr.push({ key, name: key === "__custom__" ? "Custom" : bundleName(key), count: info.count });
      byCat.set(info.category, arr);
    }
    for (const arr of byCat.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return byCat;
  }, [catalog, meta]);

  const matchesScope = (l: LabelDef): boolean => {
    if (scope === "all") return true;
    if (scope.startsWith("cat:")) return categoryOf(l) === scope.slice(4);
    if (scope.startsWith("bundle:")) return (l.bundle ?? "__custom__") === scope.slice(7);
    return true;
  };

  // Apply scope + search, then group by bundle (role → life → universal → custom;
  // bundles alphabetical; labels alphabetical within).
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = catalog.filter(
      (l) => matchesScope(l) && (!needle || `${l.title} ${l.description ?? ""}`.toLowerCase().includes(needle)),
    );
    const map = new Map<string, LabelDef[]>();
    for (const l of filtered) {
      const key = l.bundle ?? "__custom__";
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(l);
    }
    const rank: Record<Category, number> = { role: 0, life: 1, universal: 2, custom: 3 };
    return Array.from(map.entries())
      .map(([key, labels]) => ({
        key,
        name: key === "__custom__" ? "Custom" : bundleName(key),
        category: key === "__custom__" ? ("custom" as Category) : categoryOf(labels[0]),
        labels: [...labels].sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => rank[a.category] - rank[b.category] || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, q, scope, meta]);

  const count = selected.length;

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1 flex-wrap">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`text-[12px] inline-flex items-center gap-1.5 px-2 py-1 rounded-md border transition ${
          count > 0
            ? "text-ink-900 bg-ink-50 border-ink-200 font-medium"
            : "text-ink-500 border-ink-200 hover:bg-ink-50 hover:text-ink-900"
        }`}
      >
        <IconTag className="w-3.5 h-3.5" />
        Labels{count > 0 ? ` · ${count}` : ""}
        <IconChevronDown className="w-3 h-3 text-ink-400" />
      </button>

      {/* Active selection — removable chips, visible even when the dropdown is closed. */}
      {selected.map((id) => {
        const def = byId.get(id);
        return (
          <button
            key={id}
            onClick={() => onToggle(id)}
            title={def?.description ?? `Unknown label: ${id}`}
            aria-label={`Remove ${def?.title ?? id} filter`}
            className={`text-[10.5px] leading-none px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${labelChipClasses(
              def?.color,
            )} ${def ? "" : "opacity-60 italic"}`}
          >
            {def?.title ?? id}
            <span aria-hidden>×</span>
          </button>
        );
      })}
      {count > 0 && (
        <button
          onClick={onClear}
          className="text-[11px] px-1.5 py-0.5 rounded text-ink-500 hover:text-ink-900 hover:bg-ink-50"
        >
          Clear
        </button>
      )}

      {open && (
        <div
          role="menu"
          className="absolute top-8 left-0 z-40 w-[320px] bg-white rounded-md border border-ink-200 shadow-card"
        >
          <div className="p-2 border-b border-ink-100 space-y-2">
            {/* Precise category picker — the user's installed bundles, grouped. */}
            <div className="relative">
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                aria-label="Filter labels by category"
                className="w-full appearance-none text-[12.5px] pl-2 pr-7 py-1.5 rounded-md border border-ink-200 bg-white outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
              >
                <option value="all">All categories ({catalog.length})</option>
                {CAT_ORDER.map((c) => {
                  const arr = scopeByCat.get(c);
                  if (!arr || arr.length === 0) return null;
                  const total = arr.reduce((n, b) => n + b.count, 0);
                  return (
                    <optgroup key={c} label={CAT_LABEL[c]}>
                      {arr.length > 1 && c !== "custom" && (
                        <option value={`cat:${c}`}>All {CAT_LABEL[c].toLowerCase()} ({total})</option>
                      )}
                      {arr.map((b) =>
                        b.key === "__custom__" ? (
                          <option key={b.key} value="cat:custom">
                            Custom ({b.count})
                          </option>
                        ) : (
                          <option key={b.key} value={`bundle:${b.key}`}>
                            {b.name} ({b.count})
                          </option>
                        ),
                      )}
                    </optgroup>
                  );
                })}
              </select>
              <IconChevronDown className="w-3.5 h-3.5 text-ink-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            <div className="relative">
              <IconSearch className="w-3.5 h-3.5 text-ink-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search labels…"
                aria-label="Search labels"
                className="w-full text-[12.5px] pl-7 pr-2 py-1.5 rounded-md border border-ink-200 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {groups.length === 0 ? (
              <div className="px-3 py-5 text-[12px] text-ink-400 text-center">No labels match.</div>
            ) : (
              groups.map((g) => {
                const ids = g.labels.map((l) => l.id);
                const selN = ids.reduce((n, id) => n + (selSet.has(id) ? 1 : 0), 0);
                const allSel = selN === ids.length && ids.length > 0;
                const someSel = selN > 0 && !allSel;
                // Open when searching (so matches show), when explicitly expanded, or
                // when this is the only group (a precise single-bundle scope).
                const isOpen = !!q.trim() || expanded.has(g.key) || groups.length === 1;
                return (
                  <div key={g.key} className="mb-0.5">
                    {/* Bundle header: a tri-state "select all in bundle" + collapse toggle. */}
                    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-50/60">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={allSel ? "true" : someSel ? "mixed" : "false"}
                        aria-label={`${allSel ? "Deselect" : "Select"} all ${ids.length} labels in ${g.name}`}
                        onClick={() => onSelectMany(ids, !allSel)}
                        className={`w-3.5 h-3.5 rounded grid place-items-center shrink-0 border text-[9px] leading-none ${
                          allSel
                            ? "bg-ink-900 border-ink-900 text-white"
                            : someSel
                              ? "bg-ink-300 border-ink-400 text-ink-800"
                              : "border-ink-300"
                        }`}
                      >
                        {allSel ? "✓" : someSel ? "–" : ""}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(g.key)}
                        aria-expanded={isOpen}
                        className="flex-1 min-w-0 flex items-center gap-1 text-left"
                      >
                        {isOpen ? (
                          <IconChevronDown className="w-3 h-3 text-ink-400 shrink-0" />
                        ) : (
                          <IconChevronRight className="w-3 h-3 text-ink-400 shrink-0" />
                        )}
                        <span className="text-[11.5px] font-medium text-ink-700 truncate">{g.name}</span>
                        <span className="text-[10.5px] text-ink-400 tabular-nums shrink-0">
                          {selN ? `${selN}/${ids.length}` : ids.length}
                        </span>
                      </button>
                    </div>

                    {isOpen &&
                      g.labels.map((l) => {
                        const on = selSet.has(l.id);
                        return (
                          <button
                            key={l.id}
                            role="menuitemcheckbox"
                            aria-checked={on}
                            onClick={() => onToggle(l.id)}
                            title={l.description}
                            className="w-full text-left pl-7 pr-3 py-1 hover:bg-ink-50 flex items-center gap-2"
                          >
                            <span
                              className={`w-3.5 h-3.5 rounded grid place-items-center shrink-0 border text-[9px] ${
                                on ? "bg-ink-900 border-ink-900 text-white" : "border-ink-300"
                              }`}
                            >
                              {on ? "✓" : ""}
                            </span>
                            <span className={`w-2 h-2 rounded-full shrink-0 ${labelDotClass(l.color)}`} aria-hidden />
                            <span className="text-[12.5px] text-ink-800 truncate">{l.title}</span>
                          </button>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>

          {count > 0 && (
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-ink-100 text-[11.5px]">
              <span className="text-ink-500 tabular-nums">{count} selected</span>
              <button onClick={onClear} className="text-ink-500 hover:text-ink-900">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
