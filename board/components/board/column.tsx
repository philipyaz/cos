"use client";

import { type DragEvent, type ReactNode } from "react";
import { IconChevronRight, IconTrash } from "@/components/icons";

// A board column = one lane. It's a drop target for drag-drop lane moves
// (highlights on dragover, calls onDrop with the lane key). Cases are NOT created
// here — the board is agent-native, so cases arrive from the agent / inbox triage,
// not a manual quick-add. The Done lane gets an optional "Clean" action (onClean):
// a storage-reclaiming purge of the done cases shown in this column + their emails.
// A soft WIP warning shows when a settings wipLimit is exceeded (skipped if none).
// When `collapsed`, the lane folds to a narrow vertical strip (header only) but
// stays a full drop target, so a card can be dragged onto e.g. a folded "Done".
export function Column({
  label,
  count,
  dotClass,
  wipLimit,
  collapsed,
  onToggleCollapse,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onClean,
  children,
}: {
  label: string;
  count: number;
  dotClass: string;
  wipLimit?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isDropTarget?: boolean;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  // Present only on the Done lane: permanently purge this column's done cases +
  // their linked emails. Rendered as a header action when there are cases to clean.
  onClean?: () => void;
  children: ReactNode;
}) {
  const overWip = wipLimit !== undefined && count > wipLimit;

  // ── Collapsed: a narrow vertical strip (chevron · dot · count · rotated label).
  // Keeps the section's drag handlers so it remains a drop target while folded.
  if (collapsed) {
    return (
      <section
        aria-label={`${label} column (collapsed)`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex flex-col w-11 flex-none overflow-hidden rounded-xl border transition ${
          isDropTarget
            ? "bg-ink-100/70 border-ink-300 ring-1 ring-ink-200"
            : "bg-ink-50/60 border-ink-100"
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={`Expand ${label} column`}
          aria-expanded={false}
          title={`${label} · ${count}${overWip && wipLimit !== undefined ? `/${wipLimit}` : ""} — click to expand`}
          className="flex flex-col items-center gap-2 h-full w-full py-2.5 rounded-xl text-ink-500 hover:bg-ink-100/60 hover:text-ink-800 transition"
        >
          <IconChevronRight className="w-3.5 h-3.5" aria-hidden />
          <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden />
          <span
            className={`text-[12px] tabular-nums ${overWip ? "text-lane-urgent font-medium" : "text-ink-400"}`}
          >
            {count}
          </span>
          <span className="text-[12px] font-medium text-ink-700 [writing-mode:vertical-rl]">{label}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label={`${label} column`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex flex-col flex-1 min-w-[220px] rounded-xl border transition ${
        isDropTarget
          ? "bg-ink-100/70 border-ink-300 ring-1 ring-ink-200"
          : "bg-ink-50/60 border-ink-100"
      }`}
    >
      <div className="flex items-center gap-2 px-3 h-10 border-b border-ink-100/80">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden />
        <span className="text-[13px] font-medium text-ink-900">{label}</span>
        <span
          className={`text-[12px] tabular-nums ${overWip ? "text-lane-urgent font-medium" : "text-ink-400"}`}
          title={overWip ? `Over WIP limit (${wipLimit})` : undefined}
        >
          {count}
          {overWip && wipLimit !== undefined ? `/${wipLimit}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {/* Clean — Done lane only: permanently delete this column's done cases +
              their linked emails (storage reclaim). Hidden when there's nothing to
              clean. The destructive rose hover + confirm dialog (in onClean) guard it. */}
          {onClean && count > 0 && (
            <button
              type="button"
              onClick={onClean}
              aria-label={`Clean ${label} — permanently delete its cases and their emails`}
              title={`Clean ${label} — permanently delete these ${count} case${count === 1 ? "" : "s"} and their linked emails (frees storage; cannot be undone)`}
              className="w-6 h-6 grid place-items-center rounded text-ink-400 hover:bg-rose-50 hover:text-rose-600 transition"
            >
              <IconTrash className="w-3.5 h-3.5" />
            </button>
          )}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={`Collapse ${label} column`}
              aria-expanded={true}
              title="Collapse this lane"
              className="w-6 h-6 grid place-items-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition"
            >
              {/* chevron-right rotated to point left = "fold this column away" */}
              <IconChevronRight className="w-3.5 h-3.5 rotate-180" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
        {count === 0 ? (
          <div className="text-[12px] text-ink-400 px-2 py-6 text-center select-none">No cases</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
