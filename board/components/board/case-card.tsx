"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { CaseRecord, LabelDef } from "@/lib/types";
import {
  progress,
  relativeTime,
  domainLabel,
  domainClasses,
  dueLabel,
  dueClasses,
  labelChipClasses,
} from "@/lib/format";
import { dueStatus, isStale } from "@/lib/selectors";
import { IconWarning, IconCircle, IconMore, IconChevronRight } from "@/components/icons";

// The lineage breadcrumb shown atop a leaf card: the chain of ancestor container
// titles (root initiative first), plus the root initiative's id so a click can
// pivot the board to that initiative. Resolved by the board from the full case
// set (containers live there even though they aren't rendered as lane cards).
export interface CardLineage {
  titles: string[]; // ["Build DevForge", "Pipeline"] — root-first
  initiativeId?: string; // the root initiative id (the click target for filtering)
}

// One case on the board. Beyond the original compact look it now carries: a
// due/overdue chip, a "stale" dot, an optional priority tag, a drag handle
// (the whole card is draggable for lane moves), an optional lineage breadcrumb
// (its place in the Initiative › Workstream tree), and a … actions menu (archive).
// It's a focusable listitem so the board's keyboard map (1–5 / e / a / x)
// can act on the focused card. All mutations are delegated up to the board.
export function CaseCard({
  caseRec,
  clock,
  selected = false,
  focused = false,
  dropBefore = false,
  labelCatalog,
  lineage,
  onClick,
  onArchive,
  onLabelClick,
  onLineageClick,
  onKeyDown,
  onFocus,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  caseRec: CaseRecord;
  // The single server-minted clock, threaded from BoardView (parsed once from the
  // SSR `now` prop) so relative-time + due classification match between SSR and the
  // first client render. The card must NOT construct its own clock.
  clock: Date;
  selected?: boolean;
  focused?: boolean;
  dropBefore?: boolean;
  labelCatalog?: Record<string, LabelDef>;
  lineage?: CardLineage;
  onClick?: () => void;
  onArchive?: () => void;
  onLabelClick?: (labelId: string) => void;
  onLineageClick?: (initiativeId: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onFocus?: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const p = progress(caseRec.tasks);
  const showProgress = caseRec.tasks.length > 0 && caseRec.status !== "done";
  const showUrgent = caseRec.status === "urgent";
  const due = dueStatus(caseRec.dueAt, clock);
  const showDue = due !== "none";
  const stale = isStale(caseRec, clock);

  // Close the actions menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div
      role="listitem"
      tabIndex={0}
      draggable
      aria-grabbed={false}
      aria-current={selected ? true : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group relative w-full text-left bg-white rounded-lg border transition p-3 space-y-2 cursor-grab active:cursor-grabbing outline-none ${
        dropBefore ? "before:absolute before:-top-1 before:inset-x-0 before:h-0.5 before:rounded-full before:bg-ink-400" : ""
      } ${
        selected
          ? "border-ink-300 ring-1 ring-ink-300"
          : focused
            ? "border-ink-300 ring-2 ring-ink-200"
            : "border-ink-100 hover:border-ink-200 hover:shadow-card focus-visible:border-ink-300 focus-visible:ring-2 focus-visible:ring-ink-200"
      }`}
    >
      <div className="flex items-center gap-2 text-[11.5px] text-ink-500">
        {showUrgent ? (
          <IconWarning className="w-3.5 h-3.5 text-lane-urgent" />
        ) : (
          <span className="text-ink-300">—</span>
        )}
        <span className="font-medium tabular-nums">{caseRec.id}</span>
        <span
          className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full font-medium ${domainClasses(caseRec.domain)}`}
        >
          {domainLabel(caseRec.domain)}
        </span>
        {caseRec.priority && (
          <span
            className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full font-semibold tabular-nums ${
              caseRec.priority === "P0"
                ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                : caseRec.priority === "P1"
                  ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                  : "bg-ink-50 text-ink-500 ring-1 ring-ink-200"
            }`}
            title={`Priority ${caseRec.priority}`}
          >
            {caseRec.priority}
          </span>
        )}
        {stale && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-lane-todo"
            title="Stale — no update in 5+ days"
            aria-label="stale"
          />
        )}

        <div ref={menuRef} className="relative ml-auto">
          <button
            type="button"
            aria-label={`${caseRec.id} actions`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="w-5 h-5 grid place-items-center rounded text-ink-300 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-ink-100 hover:text-ink-700 transition"
          >
            <IconMore className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-6 z-10 min-w-[140px] bg-white rounded-md border border-ink-200 shadow-card py-1 text-[12.5px] text-ink-700"
            >
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onArchive?.();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-ink-50"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {lineage && lineage.titles.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (lineage.initiativeId) onLineageClick?.(lineage.initiativeId);
          }}
          title={`Filter to ${lineage.titles[0]}`}
          className="flex items-center gap-0.5 max-w-full text-[10.5px] text-violet-600 hover:text-violet-800 transition -mb-0.5"
        >
          {lineage.titles.map((t, i) => (
            <span key={i} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && <IconChevronRight className="w-2.5 h-2.5 text-ink-300 shrink-0" aria-hidden />}
              <span className="truncate">{t}</span>
            </span>
          ))}
        </button>
      )}

      <div className="text-[13.5px] font-medium text-ink-900 leading-snug line-clamp-2">
        {caseRec.title}
      </div>

      {caseRec.summary && (
        <div className="text-[12px] text-ink-500 leading-snug line-clamp-2">
          {caseRec.summary}
        </div>
      )}

      {caseRec.labels && caseRec.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {caseRec.labels.map((id) => {
            const def = labelCatalog?.[id];
            return (
              <button
                key={id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onLabelClick?.(id);
                }}
                title={def?.description ?? `Unknown label: ${id}`}
                className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full font-medium transition hover:brightness-95 ${labelChipClasses(def?.color)} ${
                  def ? "" : "opacity-60 italic"
                }`}
              >
                {def?.title ?? id}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <span className="flex-1" />
        {showDue && (
          <span
            className={`text-[10.5px] leading-none px-1.5 py-0.5 rounded-full font-medium ${dueClasses(due)}`}
            title={caseRec.dueAt}
          >
            {dueLabel(caseRec.dueAt, clock)}
          </span>
        )}
        {showProgress && (
          <span className="flex items-center gap-1 text-[11px] text-ink-500 tabular-nums">
            <IconCircle className="w-3.5 h-3.5 text-ink-300" />
            {p.done}/{p.total}
          </span>
        )}
        {caseRec.status === "done" && (
          <span className="text-[11px] text-lane-done">Resolved</span>
        )}
        <span className="text-[11px] text-ink-400 tabular-nums">
          {relativeTime(caseRec.updatedAt, clock)}
        </span>
      </div>
    </div>
  );
}
