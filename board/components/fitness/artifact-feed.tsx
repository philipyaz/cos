"use client";

// The shared <ArtifactFeed> shell — the ONE client surface behind the Fitness add-on's four
// AI coaching surfaces (training plan, weekly review, pre-workout brief, correlations). Each
// view supplies its `kind`, its `renderItem` (the kind-specific presentational JSX, reading
// from `payload`), and optionally a `generate` action; the feed owns everything else: the
// history rail, the prev/next steppers, the latest-by-default selection, the empty state, and
// — like FormScoreWidget — the LIVE reconciliation. It is the SINGLE SOURCE OF TRUTH for
// artifact data: the views no longer hold any artifact useState.
//
// LIVE: coaching artifacts live in the CORE store (db.coachingArtifacts), so a write — the
// board's own persist-on-generate, OR the agent's via the fitness MCP (save_*) — bumps
// db.version → SSE → useLiveBoard refetches the list (which carries db.version) and adopts the
// freshest history. lastVersion is seeded to 0 so the SSE `hello` on connect always reconciles
// on mount; after a fetch the ref advances to the response version so our own writes don't echo
// back as a foreign change.

import { useRef, useState } from "react";
import {
  listCoachingArtifacts,
  type CoachingListResponse,
} from "@/lib/fitness-client";
import { formatArtifactLabel, formatTimestampDay } from "@/lib/fitness-format";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconRunner, IconChevronRight } from "@/components/icons";
import type { CoachingArtifact, CoachingArtifactKind } from "@/lib/types";

export interface ArtifactFeedProps {
  // Which coaching surface this feed renders — the list filter + the renderItem contract.
  kind: CoachingArtifactKind;
  // The surface title (rendered in the feed header beside the history controls).
  title: string;
  // The optional generate action — the button label + the async runner (the view's generate
  // GET) + a pending flag. When absent, no generate button is shown (read-only history).
  generate?: { run: () => Promise<void>; label: string; pending?: boolean };
  // The dashed-empty-state hint shown when there are no artifacts yet.
  emptyHint: string;
  // The kind-specific body renderer — given the selected artifact's payload (and the full
  // record for metadata), returns the presentational JSX for the main panel.
  renderItem: (payload: Record<string, unknown>, artifact: CoachingArtifact) => React.ReactNode;
  // Optional extra header content (e.g. the correlations days <select>).
  headerExtra?: React.ReactNode;
}

export function ArtifactFeed({
  kind,
  title,
  generate,
  emptyHint,
  renderItem,
  headerExtra,
}: ArtifactFeedProps) {
  // The history (newest-first) + the currently-selected artifact id. selectedId defaults to
  // the newest (items[0]) when unset; a user pick / a stepper overrides it. The board version
  // we last reconciled to lives in a ref (seeded to 0 so the SSE `hello` reconciles on mount).
  const [items, setItems] = useState<CoachingArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const lastVersion = useRef<number>(0);

  // Refetch the history for this kind and reseed. We default the selection to the newest item
  // when nothing is selected yet (or the selected id has fallen out of the list). A throw just
  // leaves the last-known history in place — the next change event retries.
  const refetch = async (): Promise<void> => {
    try {
      const res: CoachingListResponse = await listCoachingArtifacts({ kind, limit: 50 });
      setItems(res.items);
      if (typeof res.version === "number") lastVersion.current = res.version;
      setSelectedId((prev) => {
        if (prev && res.items.some((x) => x.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch {
      // Non-critical: keep the last-known history; the next change event retries.
    } finally {
      setLoading(false);
    }
  };

  useLiveBoard(lastVersion, refetch);

  const selected = items.find((x) => x.id === selectedId) ?? items[0] ?? null;
  const selectedIndex = selected ? items.findIndex((x) => x.id === selected.id) : -1;

  // Prev (older) / Next (newer). items are newest-first, so "newer" is a SMALLER index. The
  // steppers are index-based across the loaded history.
  const goNewer = () => {
    if (selectedIndex > 0) setSelectedId(items[selectedIndex - 1].id);
  };
  const goOlder = () => {
    if (selectedIndex >= 0 && selectedIndex < items.length - 1) {
      setSelectedId(items[selectedIndex + 1].id);
    }
  };

  // Run the view-supplied generate action, then refetch so the freshly-persisted artifact
  // lands at the top of the history (and becomes the selection, being the newest). A throw
  // surfaces in the rose banner; the double-submit guard is the disabled button.
  const handleGenerate = async () => {
    if (!generate) return;
    setRunning(true);
    setGenerateError(null);
    try {
      await generate.run();
      await refetch();
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setRunning(false);
    }
  };

  const pending = running || generate?.pending === true;

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      {/* Header: title + history controls + optional generate button. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[15px] font-semibold text-ink-900">{title}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {headerExtra}

          {/* Prev/next steppers across the loaded history (only when there's >1 artifact). */}
          {items.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={goOlder}
                disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
                aria-label="Older"
                title="Older"
                className="p-1.5 rounded-md border border-ink-200 bg-white text-ink-600 hover:bg-ink-50 disabled:opacity-40 transition"
              >
                <IconChevronRight className="w-3.5 h-3.5 rotate-180" />
              </button>
              <span className="text-[11px] text-ink-400 tabular-nums px-1">
                {selectedIndex < 0 ? "—" : `${selectedIndex + 1} / ${items.length}`}
              </span>
              <button
                onClick={goNewer}
                disabled={selectedIndex <= 0}
                aria-label="Newer"
                title="Newer"
                className="p-1.5 rounded-md border border-ink-200 bg-white text-ink-600 hover:bg-ink-50 disabled:opacity-40 transition"
              >
                <IconChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {generate && (
            <button
              onClick={handleGenerate}
              disabled={pending}
              className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition"
            >
              {pending ? "Generating…" : generate.label}
            </button>
          )}
        </div>
      </div>

      {/* Generate error — danger tone is rose, role="alert" so it's announced. */}
      {generateError && (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-[13px] text-rose-700">{generateError}</p>
        </div>
      )}

      {/* Loading skeleton on the very first fetch (before any history is known). */}
      {loading && items.length === 0 && (
        <div className="rounded-lg border border-ink-100 bg-white p-6 shadow-card space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-14 rounded-md bg-ink-50 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state — the dashed EmptyState recipe (mirrors training-plan-view's empty state). */}
      {!loading && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
          <div className="flex justify-center mb-2 text-ink-300">
            <IconRunner className="w-6 h-6" />
          </div>
          <p className="text-[13px] text-ink-700 font-medium mb-1">No history yet</p>
          <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">{emptyHint}</p>
        </div>
      )}

      {/* History + main panel — a two-column layout once there's at least one artifact. */}
      {items.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-5">
          {/* History rail */}
          <div className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden lg:self-start">
            <div className="px-3 py-2 border-b border-ink-100">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                History
              </p>
            </div>
            <div className="divide-y divide-ink-100 max-h-[480px] overflow-y-auto">
              {items.map((a) => {
                const active = selected?.id === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    className={`w-full text-left px-3 py-2.5 transition ${
                      active ? "bg-ink-50" : "hover:bg-ink-50/50"
                    }`}
                  >
                    <p
                      className={`text-[12.5px] font-medium ${
                        active ? "text-ink-900" : "text-ink-700"
                      }`}
                    >
                      {formatArtifactLabel(a)}
                    </p>
                    <p className="text-[11px] text-ink-400">
                      {formatTimestampDay(a.createdAt)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Main panel — the kind-specific body. */}
          <div className="min-w-0 space-y-6">
            {selected && renderItem(selected.payload, selected)}
          </div>
        </div>
      )}
    </div>
  );
}
