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
import { PrimaryButton } from "@/components/shared/action-button";
import { Alert } from "@/components/shared/alert";
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
  // A surfaced LOAD failure — distinct from generateError below (that one is the Generate
  // button's). This feed has NO server-rendered seed, so `refetch` is its ONLY load path, and a
  // throw there is the difference between "no history" and "I couldn't find out"; only one of
  // those is safe to tell someone. Cleared on every success, and RENDERED only when there is
  // nothing to show — so a failed live refetch over an existing history stays silent and keeps
  // the last-known items, which is health-view.tsx's posture.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const lastVersion = useRef<number>(0);

  // Refetch the history for this kind and reseed. We default the selection to the newest item
  // when nothing is selected yet (or the selected id has fallen out of the list). A throw still
  // leaves the last-known history in place — the next change event retries, since lastVersion is
  // NOT advanced on a failure — but it is also RECORDED, so a feed with nothing loaded renders
  // the failure rather than the reassuring "No history yet".
  const refetch = async (): Promise<void> => {
    try {
      const res: CoachingListResponse = await listCoachingArtifacts({ kind, limit: 50 });
      setItems(res.items);
      if (typeof res.version === "number") lastVersion.current = res.version;
      setSelectedId((prev) => {
        if (prev && res.items.some((x) => x.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
      setLoadError(null);
    } catch (e) {
      // Non-critical while a history is loaded: the banner below renders only when there are
      // no items, so this keeps the last-known list and lets the next change event retry.
      setLoadError(e instanceof Error ? e.message : "Couldn't load the history.");
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
            <PrimaryButton onClick={handleGenerate} disabled={pending} className="px-4">
              {pending ? "Generating…" : generate.label}
            </PrimaryButton>
          )}
        </div>
      </div>

      {/* Generate error — danger tone is rose, role="alert" so it's announced. Dismissible: a
          failed generate leaves the history feed intact, so clearing it loses nothing. */}
      {generateError && (
        <Alert edge="inset" className="px-4" onDismiss={() => setGenerateError(null)}>
          {generateError}
        </Alert>
      )}

      {/* Loading skeleton on the very first fetch (before any history is known). */}
      {loading && items.length === 0 && (
        <div className="rounded-lg border border-ink-100 bg-white p-6 shadow-card space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-14 rounded-md bg-ink-50 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state — the dashed EmptyState recipe (mirrors training-plan-view's empty state).
          Gated on `!loadError` as well as `!loading`: "No history yet" is a claim about the
          user's artifacts, and we may only make it on data we actually received. A load that
          FAILED shows the banner below instead — never the reassuring card. */}
      {!loading && !loadError && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
          <div className="flex justify-center mb-2 text-ink-300">
            <IconRunner className="w-6 h-6" />
          </div>
          <p className="text-[13px] text-ink-700 font-medium mb-1">No history yet</p>
          <p className="text-[12.5px] text-ink-500 max-w-[460px] mx-auto">{emptyHint}</p>
        </div>
      )}

      {/* Load failure with NOTHING to show — the rose role="alert" banner instead of the
          cheerful empty card, plus a Retry. NOT dismissible: dismissing would leave a blank
          panel with no way back. With a history LOADED this renders not at all — the rail below
          keeps showing last-known. With a history that loaded EMPTY it does replace the "No
          history yet" card, which is deliberate and matches unanswered-messages.tsx: after a
          failure we no longer know the feed is empty. The retry's setLoading(true) swaps this
          block for the skeleton, which doubles as the double-submit guard.
          The button is hand-spelled rather than routed through SecondaryButton: this sits on the
          white page body, where that primitive's drawer-footer hover:bg-white is a dead utility
          — the same conflict label-manager.tsx names for its own non-footer secondary, resolved
          the same way, with the coarse-pointer floor bumped in place. */}
      {!loading && loadError && items.length === 0 && (
        <div className="space-y-3">
          <Alert edge="inset" className="px-4" onDismiss={null}>
            {loadError}
          </Alert>
          <div className="text-center">
            <button
              onClick={() => {
                setLoading(true);
                void refetch();
              }}
              className="text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-900 hover:bg-ink-50 transition inline-flex items-center justify-center active:bg-ink-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              Retry
            </button>
          </div>
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
