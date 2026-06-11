"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseDomain, CaseRecord, CaseKind, CaseStatus, LabelDef } from "@/lib/types";
import { LANES, caseKind } from "@/lib/types";
import type { TreeNode, Rollup } from "@/lib/selectors";
import { reorderPositions } from "@/lib/selectors";
import { domainLabel, domainClasses } from "@/lib/format";
import {
  fetchTree,
  createInitiative,
  createWorkstream,
  createCase,
  setParent,
  updateCase,
  subscribeToBoard,
  starCase,
} from "@/lib/board-client";

// ── Strategy view ──────────────────────────────────────────────────────────────
// The OUTLINE ROADMAP, the strategy twin of the operational kanban. It renders the
// three-tier forest the board returns from GET /api/tree (Initiative > Workstream >
// Case), each container with a rollup progress bar (done/total leaf cases) so you
// can see the shape of the work at a glance and drill into a single leaf.
//
// It owns its own data: it fetches the tree on mount / domain-change and refetches
// live on the board SSE (so an agent grouping cases via MCP reshapes it in place).
// It is deliberately DECOUPLED from icons.tsx — every glyph here is an inline SVG —
// so the strategy surface can evolve without touching the kanban's icon set.
//
// Mutations go through board-client (createInitiative / createWorkstream /
// createCase) and then refetch; opening a leaf is delegated up via onOpenCase so
// the shell can show the existing drawer.
//
// It is also DRAGGABLE: leaf rows (a Case) and workstream headers (a Workstream)
// can be dragged onto other containers to reparent, onto the Ungrouped zone to
// detach, or onto a sibling row to reorder. The reshape itself rides board-client
// (setParent / updateCase) and the SERVER (assertHierarchy) is the backstop — we
// surface its 400 text via run() + the error banner. We DO pre-filter obviously
// illegal drops so they never highlight (good UX), but we never re-implement the
// invariants client-side; the server is the single source of truth.

// ── Drag-and-drop plumbing ─────────────────────────────────────────────────────
// What's being dragged: enough of the node to decide which drops are legal WITHOUT
// re-deriving the tree invariants (we leave the hard rules to the server). `kind`
// gates targets (a workstream can't drop on a workstream / can't detach); `parentId`
// lets a drop onto a sibling tell reorder (same container) from reparent (different).
interface DragPayload {
  id: string;
  kind: CaseKind;
  parentId?: string;
}

// The bundle plumbed down into every row (no globals). `dragging` is the live
// payload (null when idle) so rows can dim themselves; `over` is the id of the
// drop target currently highlighted (a container id, the Ungrouped sentinel, or a
// sibling row id) so exactly one target lights up. The verbs wrap the HTML5 DnD
// dance and resolve each drop to a board-client call routed through run().
const UNGROUPED = "ungrouped"; // sentinel target id for the detach zone
interface Dnd {
  dragging: DragPayload | null;
  over: string | null;
  start: (e: React.DragEvent, payload: DragPayload) => void;
  end: () => void;
  // A drop ONTO A CONTAINER (initiative or workstream) — reparent the dragged node
  // under it. `accepts` is the per-target legality pre-check (returns false ⇒ no
  // highlight, no drop). A container drop ALWAYS reparents; the reorder-onto-a-
  // child-row path lives in rowProps (just below), not here.
  containerProps: (
    targetId: string,
    accepts: (p: DragPayload) => boolean,
  ) => ContainerDropProps;
  // A drop ONTO A SIBLING ROW — reorder within the same container, or (cross-
  // container) reparent into that row's container appended. `containerId` is the
  // row's owning container (null for the top-level Ungrouped list); the reorder
  // path re-reads that container's FULL child set itself (positions can go stale in
  // a render closure, and the bisect needs hidden leaves too), so it isn't passed.
  rowProps: (
    targetRowId: string,
    containerId: string | null,
    accepts: (p: DragPayload) => boolean,
  ) => RowDropProps;
  // The Ungrouped detach zone — only a leaf Case may drop, clearing its parent.
  ungroupedProps: () => ContainerDropProps;
  // A drop ONTO AN INITIATIVE HEADER by another dragged initiative — reorder the
  // top-level initiative band. Initiatives are always roots (they cannot reparent),
  // so reorder is their ONLY drag interaction: drop A onto B to place A immediately
  // before B. Mirrors rowProps' SAME-container branch, but the sibling set is the
  // initiatives, read fresh (positions go stale in a render closure). CONSUME-ONLY-
  // ON-ACCEPT: a non-initiative drop (a case dropped on the header) is NOT swallowed
  // here — it falls through to the row's container zone, which reparents it.
  initiativeReorderProps: (targetId: string) => RowDropProps;
}

// The HTML5 drop-zone props a target spreads onto its element. `isOver` is true
// when this is the highlighted drop target; the consumer uses it to toggle the
// ring/glow class.
interface ContainerDropProps {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  isOver: boolean;
}
type RowDropProps = ContainerDropProps;

// The DnD controller. Lives once in StrategyView; its verbs close over the active
// payload (a ref so handlers see the latest without re-subscribing) and the run()
// helper so every reshape clears the banner / refetches / surfaces the 400 text.
function useDnd(
  run: (fn: () => Promise<unknown>) => Promise<void>,
  // The container's FULL child set (done/hidden leaves included) used for reorder
  // bisect math — NOT the pruned in-view list, so positions stay distinct under
  // Hide-Done (see the SAME-container branch in rowProps).
  childrenForReorder: (containerId: string | null) => CaseRecord[],
  // The ROOT initiative band, for the initiative reorder path (see
  // initiativeReorderProps) — same freshness rationale as childrenForReorder.
  initiativesForReorder: () => CaseRecord[],
): Dnd {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A ref mirror so the drop handlers (bound once per render) always read the
  // current payload even mid-drag, without making every handler a dependency.
  const payload = useRef<DragPayload | null>(null);

  const start = (e: React.DragEvent, p: DragPayload): void => {
    payload.current = p;
    setDragging(p);
    // Mark the drag as a move; the text payload is a courtesy for native targets.
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", p.id);
  };
  const end = (): void => {
    payload.current = null;
    setDragging(null);
    setOver(null);
  };

  // Shared dragover/leave wiring for any zone: highlight iff `accepts(payload)`.
  const zone = (targetId: string, accepts: (p: DragPayload) => boolean) => {
    const ok = (): boolean => {
      const p = payload.current;
      return !!p && p.id !== targetId && accepts(p);
    };
    return {
      isOver: over === targetId,
      onDragOver: (e: React.DragEvent) => {
        if (!ok()) return; // illegal target — don't preventDefault ⇒ no drop, no glow
        e.preventDefault();
        e.stopPropagation(); // a child zone wins over its container
        e.dataTransfer.dropEffect = "move";
        if (over !== targetId) setOver(targetId);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Only clear when truly leaving (ignore bubbling between inner children).
        if (e.currentTarget === e.target && over === targetId) setOver(null);
      },
    };
  };

  const containerProps = (
    targetId: string,
    accepts: (p: DragPayload) => boolean,
  ): ContainerDropProps => {
    const z = zone(targetId, accepts);
    return {
      ...z,
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const p = payload.current;
        end();
        if (!p || p.id === targetId || !accepts(p)) return;
        // Reparent under this container (a workstream stays a workstream; a case
        // becomes a direct child). The server vets the tier rules.
        run(() => setParent(p.id, targetId));
      },
    };
  };

  const ungroupedProps = (): ContainerDropProps => {
    // Only a leaf Case may detach to top-level (a workstream cannot — convert first).
    const accepts = (p: DragPayload): boolean => p.kind === "case" && !!p.parentId;
    const z = zone(UNGROUPED, accepts);
    return {
      ...z,
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const p = payload.current;
        end();
        if (!p || !accepts(p)) return;
        run(() => setParent(p.id, null)); // detach
      },
    };
  };

  const rowProps = (
    targetRowId: string,
    containerId: string | null,
    accepts: (p: DragPayload) => boolean,
  ): RowDropProps => {
    const z = zone(targetRowId, accepts);
    return {
      ...z,
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const p = payload.current;
        end();
        if (!p || p.id === targetRowId || !accepts(p)) return;
        if (p.parentId === (containerId ?? undefined)) {
          // SAME container ⇒ reorder before the dropped-on sibling. We re-read the
          // container's FULL child set — done/hidden leaves INCLUDED — so the bisect
          // computes a position between the moved card's true neighbours and can
          // never land on a hidden card's slot (when Hide-Done prunes the rendered
          // list, the pruned cards keep their real positions between the visible
          // siblings). reorderPositions sorts internally, so order here is moot.
          const sibs = childrenForReorder(containerId);
          const writes = reorderPositions(sibs, p.id, targetRowId);
          if (!writes.length) return;
          // Fan the (independent) position writes out in parallel — matches
          // board-view's reorderWithin and trims avoidable round-trip latency.
          run(() => Promise.all(writes.map((w) => updateCase(w.id, { position: w.position }))));
        } else {
          // CROSS container ⇒ treat the row as its container: reparent, appended.
          if (containerId === null) {
            // The row lives in the top-level Ungrouped list ⇒ detach the dragged case.
            if (p.kind === "case") run(() => setParent(p.id, null));
          } else {
            run(() => setParent(p.id, containerId));
          }
        }
      },
    };
  };

  const initiativeReorderProps = (targetId: string): RowDropProps => {
    // A dragged initiative only, and never onto itself (the self-check is folded into
    // accepts so a self-hover doesn't even highlight). Key the zone on a SENTINEL
    // distinct from the bare initiative id: the outer container reparent zone is keyed
    // on `targetId` and `over` holds a single id, so sharing it would light BOTH rings
    // at once. The sentinel decouples them — the header ring shows for an initiative
    // drag, the outer container ring for a case/workstream reparent, never both.
    const accepts = (p: DragPayload): boolean => p.kind === "initiative" && p.id !== targetId;
    const z = zone(`reorder:${targetId}`, accepts);
    return {
      ...z,
      onDrop: (e: React.DragEvent) => {
        // CONSUME-ONLY-ON-ACCEPT: guard BEFORE preventDefault/stopPropagation so a
        // drop we don't own (a case/workstream released on this header) bubbles out
        // to the row's container zone and reparents, instead of being swallowed here.
        const p = payload.current;
        if (!p || p.id === targetId || !accepts(p)) return;
        e.preventDefault();
        e.stopPropagation();
        end();
        // Reorder among the initiatives: drop the dragged one immediately BEFORE the
        // target (parity with the leaf/workstream same-container reorder). The writes
        // fan out in parallel, exactly like rowProps' reorder branch.
        const sibs = initiativesForReorder();
        const writes = reorderPositions(sibs, p.id, targetId);
        if (!writes.length) return;
        run(() => Promise.all(writes.map((w) => updateCase(w.id, { position: w.position }))));
      },
    };
  };

  return { dragging, over, start, end, containerProps, ungroupedProps, rowProps, initiativeReorderProps };
}

export function StrategyView({
  onOpenCase,
  domain,
  labelCatalog = [],
  collapsed,
  onToggleCollapsed,
}: {
  onOpenCase: (id: string) => void;
  domain?: CaseDomain;
  labelCatalog?: LabelDef[];
  // The folded-container set + per-container toggle, lifted to (and persisted by) the
  // always-mounted BoardView so a fold survives a view switch / reload (see board-view).
  // Keyed by node id; a node NOT in the set is expanded (default), so we store only folds.
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  // The UNPRUNED forest (done leaves included) used SOLELY for reorder bisect math —
  // see childrenForReorder. Only populated (and fetched) when Hide-Done is on; when
  // it's off the rendered `tree` is already the full set, so this stays null.
  const [fullTree, setFullTree] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row composer + create-busy state, keyed so only one form is open at a time.
  const [composer, setComposer] = useState<Composer | null>(null);
  const [busy, setBusy] = useState(false);
  // Declutter the roadmap by hiding finished leaves (default ON). PRESENTATION ONLY
  // — the server keeps counting done leaves, so a container's bar still reads e.g.
  // 2/3 even when the 2 done leaves aren't listed. Toggling re-fetches the tree.
  const [hideDone, setHideDone] = useState(true);

  const refetch = useCallback(async () => {
    try {
      // Render off the (optionally pruned) tree; when Hide-Done is on, ALSO fetch
      // the unpruned forest so reorder math sees the real positions of the hidden
      // done leaves and never bisects onto one of their slots.
      const [res, full] = await Promise.all([
        fetchTree({ ...(domain ? { domain } : {}), hideDone }),
        hideDone ? fetchTree({ ...(domain ? { domain } : {}) }) : Promise.resolve(null),
      ]);
      setTree(res.tree);
      setFullTree(full ? full.tree : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the roadmap.");
    } finally {
      setLoading(false);
    }
  }, [domain, hideDone]);

  // Initial load + refetch whenever the domain filter changes.
  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  // Live: refetch on every board write (agent regroup, a leaf moving lane, …).
  useEffect(() => subscribeToBoard(() => refetch()), [refetch]);

  // ── Create runner ─────────────────────────────────────────────────────────
  // Clears the banner, runs the create, closes the composer + refetches on
  // success, surfaces the API error text (e.g. a 400 hierarchy violation) on fail.
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        setComposer(null);
        await refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );

  // The FULL-SIBLING lookup the DnD reorder path needs: given a container id (or
  // null for the top-level Ungrouped list), that container's CaseRecords INCLUDING
  // hidden done leaves. We read off `fullTree` (the unpruned forest) when Hide-Done
  // is on, else off the rendered `tree` — which already IS the full set. Feeding
  // reorderPositions the full set keeps the bisect off the hidden cards' slots, so
  // positions stay distinct regardless of the Hide-Done toggle.
  const childrenForReorder = useCallback(
    (containerId: string | null): CaseRecord[] => {
      const src = fullTree ?? tree;
      if (containerId === null) {
        return src.filter((n) => caseKind(n.case) !== "initiative").map((n) => n.case);
      }
      const find = (nodes: TreeNode[]): TreeNode | undefined => {
        for (const n of nodes) {
          if (n.case.id === containerId) return n;
          const hit = find(n.children);
          if (hit) return hit;
        }
        return undefined;
      };
      return find(src)?.children.map((n) => n.case) ?? [];
    },
    [tree, fullTree],
  );

  // The initiative band for the DnD reorder path: the ROOT initiatives, read off the
  // unpruned forest when Hide-Done is on (else the rendered tree, already the full
  // set). Mirrors childrenForReorder for the top-level initiatives so reorder math
  // sees real positions and never bisects onto a hidden node's slot.
  const initiativesForReorder = useCallback((): CaseRecord[] => {
    const src = fullTree ?? tree;
    return src.filter((n) => caseKind(n.case) === "initiative").map((n) => n.case);
  }, [tree, fullTree]);

  const dnd = useDnd(run, childrenForReorder, initiativesForReorder);

  // ── Star toggle ────────────────────────────────────────────────────────────
  // Favorite/pin ANY node (initiative | workstream | case) straight from the
  // roadmap — the strategy twin of the drawer's star. Rides the same case PATCH
  // (starCase -> updateCase) then refetches so the star reflects at once (the board
  // SSE would refetch too; we don't wait on it). Kept SEPARATE from run() so a star
  // toggle never closes an open inline composer or disables its input.
  const toggleStar = useCallback(
    async (id: string, next: boolean): Promise<void> => {
      setError(null);
      try {
        await starCase(id, next);
        await refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't update the star.");
      }
    },
    [refetch],
  );

  const submitComposer = (title: string) => {
    const t = title.trim();
    if (!t || !composer) return;
    const base: Record<string, unknown> = { title: t };
    if (domain) base.domain = domain;
    if (composer.kind === "initiative") {
      run(() => createInitiative(base));
    } else if (composer.kind === "workstream") {
      run(() => createWorkstream(composer.parentId!, base));
    } else {
      // A leaf case, optionally nested under the composer's container.
      run(() => createCase(composer.parentId ? { ...base, parentId: composer.parentId } : base));
    }
  };

  // buildForest returns top-level standalone leaves as single-node roots; split
  // them out into an "Ungrouped" section so the roadmap reads cleanly.
  const initiatives = tree.filter((n) => caseKind(n.case) === "initiative");
  const ungrouped = tree.filter((n) => caseKind(n.case) !== "initiative");

  return (
    <div className="px-4 sm:px-6 py-5 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-[15px] font-semibold text-ink-900">Strategy roadmap</h2>
        <span className="text-[12px] text-ink-400">
          {initiatives.length} initiative{initiatives.length === 1 ? "" : "s"}
        </span>

        {/* Presentation toggle: drop finished leaves to declutter (default ON). The
            rollup bars keep counting them server-side, so progress is unaffected. */}
        <button
          type="button"
          onClick={() => setHideDone((v) => !v)}
          aria-pressed={!hideDone}
          title={hideDone ? "Completed cases are hidden" : "Completed cases are shown"}
          className="ml-auto inline-flex items-center gap-1.5 text-[12px] px-2 py-1.5 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100 transition"
        >
          <EyeGlyph className="w-3.5 h-3.5" off={hideDone} />
          {hideDone ? "Show completed" : "Hide completed"}
        </button>

        <button
          type="button"
          onClick={() => setComposer({ kind: "initiative" })}
          className="inline-flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700 transition shadow-sm"
        >
          <PlusGlyph className="w-3.5 h-3.5" />
          New Initiative
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md flex items-center gap-2"
        >
          <WarnGlyph className="w-3.5 h-3.5 shrink-0" />
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

      {/* Top-level "New Initiative" composer */}
      {composer?.kind === "initiative" && (
        <div className="mb-3">
          <InlineComposer
            placeholder="New initiative title…"
            busy={busy}
            onSubmit={submitComposer}
            onCancel={() => setComposer(null)}
          />
        </div>
      )}

      {loading ? (
        <div className="text-[13px] text-ink-400 py-10 text-center">Loading the roadmap…</div>
      ) : initiatives.length === 0 && ungrouped.length === 0 ? (
        <div className="text-[13px] text-ink-400 border border-dashed border-ink-200 rounded-lg py-12 text-center">
          No initiatives yet — create one to group related cases.
        </div>
      ) : (
        <div className="space-y-2.5">
          {initiatives.map((node) => (
            <InitiativeRow
              key={node.case.id}
              node={node}
              labelCatalog={labelCatalog}
              composer={composer}
              busy={busy}
              dnd={dnd}
              onOpenCase={onOpenCase}
              onCompose={setComposer}
              onSubmit={submitComposer}
              onCancelCompose={() => setComposer(null)}
              onToggleStar={toggleStar}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))}

          {/* Ungrouped · standalone cases — also the DETACH drop zone: dragging a
              leaf here clears its parent (a workstream can't detach, so it won't
              highlight). The zone wraps the list so a drop anywhere on it lands. */}
          {(() => {
            const drop = dnd.ungroupedProps();
            return (
              ungrouped.length > 0 && (
                <div className="pt-2">
                  <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1.5 px-1">
                    Ungrouped · standalone cases
                  </div>
                  <div
                    onDragOver={drop.onDragOver}
                    onDragLeave={drop.onDragLeave}
                    onDrop={drop.onDrop}
                    className={`rounded-lg border bg-white divide-y divide-ink-50 transition ${
                      drop.isOver ? "border-violet-300 ring-2 ring-violet-200" : "border-ink-100"
                    }`}
                  >
                    {ungrouped.map((node) => (
                      <LeafRow
                        key={node.case.id}
                        node={node}
                        depth={1}
                        dnd={dnd}
                        containerId={null}
                        onOpenCase={onOpenCase}
                        onToggleStar={toggleStar}
                      />
                    ))}
                  </div>
                </div>
              )
            );
          })()}
        </div>
      )}
    </div>
  );
}

// What the inline composer is creating and (for nested kinds) under which parent.
type Composer =
  | { kind: "initiative" }
  | { kind: "workstream"; parentId: string }
  | { kind: "case"; parentId?: string };

// ── Initiative row (top container) ─────────────────────────────────────────────
// Violet-accented header: caret, glyph, title, rollup bar, x/y, domain chip, child
// count, status pill, and "+ Workstream" / "+ Case" inline actions. Collapsible —
// its workstreams + direct leaf cases render indented underneath when expanded.
function InitiativeRow({
  node,
  labelCatalog,
  composer,
  busy,
  dnd,
  onOpenCase,
  onCompose,
  onSubmit,
  onCancelCompose,
  onToggleStar,
  collapsed,
  onToggleCollapsed,
}: {
  node: TreeNode;
  labelCatalog: LabelDef[];
  composer: Composer | null;
  busy: boolean;
  dnd: Dnd;
  onOpenCase: (id: string) => void;
  onCompose: (c: Composer) => void;
  onSubmit: (title: string) => void;
  onCancelCompose: () => void;
  onToggleStar: (id: string, next: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
}) {
  const id = node.case.id;
  // Open unless this container is in the lifted collapsed set (default = expanded).
  const open = !collapsed.has(id);
  const workstreams = node.children.filter((c) => caseKind(c.case) === "workstream");
  const directLeaves = node.children.filter((c) => caseKind(c.case) === "case");

  const composingWorkstream = composer?.kind === "workstream" && composer.parentId === id;
  const composingCase = composer?.kind === "case" && composer.parentId === id;

  // Drop ONTO this initiative ⇒ reparent the dragged node under it. It accepts a
  // workstream (stays a workstream) or a case (becomes a direct child), but NOT
  // another initiative — an initiative can't be reparented; it reorders via its own
  // header instead (see reorderDrop below). Every other tier rule is the server's.
  const drop = dnd.containerProps(id, (p) => p.kind !== "initiative");
  const beingDragged = dnd.dragging?.id === id;
  // This initiative's header is itself a DRAG SOURCE (grab it to reorder the band).
  const drag = (e: React.DragEvent): void =>
    dnd.start(e, { id, kind: "initiative", parentId: node.case.parentId });

  return (
    <div
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={`rounded-lg border bg-white overflow-hidden transition ${
        drop.isOver ? "border-violet-300 ring-2 ring-violet-200" : "border-violet-100"
      }${beingDragged ? " opacity-50" : ""}`}
    >
      <ContainerHeader
        tier="initiative"
        open={open}
        onToggle={() => onToggleCollapsed(id)}
        title={node.case.title}
        domain={node.case.domain}
        status={node.case.status}
        rollup={node.rollup}
        onOpenSelf={() => onOpenCase(id)}
        draggable
        onDragStart={drag}
        onDragEnd={dnd.end}
        reorderDrop={dnd.initiativeReorderProps(id)}
        starred={node.case.starred}
        onToggleStar={() => onToggleStar(id, !node.case.starred)}
        actions={
          <>
            <RowAction label="+ Workstream" onClick={() => onCompose({ kind: "workstream", parentId: id })} />
            <RowAction label="+ Case" onClick={() => onCompose({ kind: "case", parentId: id })} />
          </>
        }
      />

      {open && (
        <div className="border-t border-violet-50">
          {composingWorkstream && (
            <div className="px-3 py-2 bg-sky-50/40">
              <InlineComposer
                placeholder="New workstream title…"
                busy={busy}
                onSubmit={onSubmit}
                onCancel={onCancelCompose}
              />
            </div>
          )}

          {workstreams.map((ws) => (
            <WorkstreamRow
              key={ws.case.id}
              node={ws}
              labelCatalog={labelCatalog}
              composer={composer}
              busy={busy}
              dnd={dnd}
              onOpenCase={onOpenCase}
              onCompose={onCompose}
              onSubmit={onSubmit}
              onCancelCompose={onCancelCompose}
              onToggleStar={onToggleStar}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))}

          {/* Direct leaf cases hung off the initiative itself. They reorder among
              ALL of the initiative's direct children (workstreams + cases share the
              one position scale under their common parent). */}
          {directLeaves.map((leaf) => (
            <LeafRow
              key={leaf.case.id}
              node={leaf}
              depth={1}
              dnd={dnd}
              containerId={id}
              onOpenCase={onOpenCase}
              onToggleStar={onToggleStar}
            />
          ))}

          {composingCase && (
            <div className="px-3 py-2 pl-8 bg-ink-50/40">
              <InlineComposer
                placeholder="New case title…"
                busy={busy}
                onSubmit={onSubmit}
                onCancel={onCancelCompose}
              />
            </div>
          )}

          {workstreams.length === 0 && directLeaves.length === 0 && !composingWorkstream && !composingCase && (
            <div className="px-3 py-2.5 pl-9 text-[12px] text-ink-400">
              Empty — add a workstream or a case.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Workstream row (middle container) ──────────────────────────────────────────
// Sky-accented, indented one level under its initiative. Collapsible; its leaf
// cases render underneath with a "+ Case" inline action.
function WorkstreamRow({
  node,
  composer,
  busy,
  dnd,
  onOpenCase,
  onCompose,
  onSubmit,
  onCancelCompose,
  onToggleStar,
  collapsed,
  onToggleCollapsed,
}: {
  node: TreeNode;
  labelCatalog: LabelDef[];
  composer: Composer | null;
  busy: boolean;
  dnd: Dnd;
  onOpenCase: (id: string) => void;
  onCompose: (c: Composer) => void;
  onSubmit: (title: string) => void;
  onCancelCompose: () => void;
  onToggleStar: (id: string, next: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
}) {
  const id = node.case.id;
  // Open unless this container is in the lifted collapsed set (default = expanded).
  const open = !collapsed.has(id);
  const leaves = node.children.filter((c) => caseKind(c.case) === "case");
  const composingCase = composer?.kind === "case" && composer.parentId === id;

  // This workstream is itself DRAGGABLE (grab its header to move it under another
  // initiative). The payload carries kind+parentId so drops can tell reorder from
  // reparent.
  const drag = (e: React.DragEvent): void =>
    dnd.start(e, { id, kind: "workstream", parentId: node.case.parentId });

  // Drop ONTO this workstream's header/body ⇒ reparent that node under it, but ONLY
  // a Case is a legal child of a workstream — a workstream dropped on a workstream
  // must not even highlight. The server is still the backstop.
  const drop = dnd.containerProps(id, (p) => p.kind === "case");
  const beingDragged = dnd.dragging?.id === id;

  return (
    <div className="border-t border-ink-50">
      <div
        className={`pl-5 transition ${beingDragged ? "opacity-50" : ""} ${
          drop.isOver ? "bg-sky-50 ring-2 ring-inset ring-sky-200" : ""
        }`}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <ContainerHeader
          tier="workstream"
          open={open}
          onToggle={() => onToggleCollapsed(id)}
          title={node.case.title}
          domain={node.case.domain}
          status={node.case.status}
          rollup={node.rollup}
          onOpenSelf={() => onOpenCase(id)}
          draggable
          onDragStart={drag}
          onDragEnd={dnd.end}
          starred={node.case.starred}
          onToggleStar={() => onToggleStar(id, !node.case.starred)}
          actions={<RowAction label="+ Case" onClick={() => onCompose({ kind: "case", parentId: id })} />}
        />
      </div>

      {open && (
        <div>
          {leaves.map((leaf) => (
            <LeafRow
              key={leaf.case.id}
              node={leaf}
              depth={2}
              dnd={dnd}
              containerId={id}
              onOpenCase={onOpenCase}
              onToggleStar={onToggleStar}
            />
          ))}
          {composingCase && (
            <div className="px-3 py-2 pl-12 bg-ink-50/40">
              <InlineComposer
                placeholder="New case title…"
                busy={busy}
                onSubmit={onSubmit}
                onCancel={onCancelCompose}
              />
            </div>
          )}
          {leaves.length === 0 && !composingCase && (
            <div className="px-3 py-2 pl-12 text-[12px] text-ink-400">No cases yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Container header (shared by Initiative + Workstream) ───────────────────────
// `draggable` (+ onDragStart/onDragEnd) turns the WHOLE header into a drag source
// — used for the Workstream tier (an Initiative is always a root, so it isn't
// draggable). When draggable it shows a grab cursor + a 6-dot grip glyph on hover.
function ContainerHeader({
  tier,
  open,
  onToggle,
  title,
  domain,
  status,
  rollup,
  onOpenSelf,
  actions,
  draggable = false,
  onDragStart,
  onDragEnd,
  starred,
  onToggleStar,
  reorderDrop,
}: {
  tier: "initiative" | "workstream";
  open: boolean;
  onToggle: () => void;
  title: string;
  domain: CaseDomain;
  status: CaseStatus;
  rollup: Rollup;
  onOpenSelf: () => void;
  actions: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  starred?: boolean;
  onToggleStar?: () => void;
  reorderDrop?: RowDropProps;
}) {
  const accent =
    tier === "initiative"
      ? { text: "text-violet-600", soft: "bg-violet-50", bar: "bg-violet-500" }
      : { text: "text-sky-600", soft: "bg-sky-50", bar: "bg-sky-500" };

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-2.5 ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${
        reorderDrop?.isOver ? "ring-2 ring-inset ring-violet-300 bg-violet-50/70" : ""
      }`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={reorderDrop?.onDragOver}
      onDragLeave={reorderDrop?.onDragLeave}
      onDrop={reorderDrop?.onDrop}
    >
      {/* Grip — affordance that the header is draggable (workstream tier only) */}
      {draggable && (
        <span className="shrink-0 -ml-1 text-ink-300 opacity-0 group-hover:opacity-100 transition" aria-hidden>
          <GripGlyph className="w-3 h-3.5" />
        </span>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Collapse" : "Expand"}
        className="shrink-0 text-ink-400 hover:text-ink-700"
      >
        <CaretGlyph className="w-3.5 h-3.5" open={open} />
      </button>

      <span className={`shrink-0 ${accent.text}`} title={tier === "initiative" ? "Initiative" : "Workstream"}>
        {tier === "initiative" ? <InitiativeGlyph className="w-4 h-4" /> : <WorkstreamGlyph className="w-4 h-4" />}
      </span>

      {/* Title — clicking opens the container's own drawer */}
      <button
        type="button"
        onClick={onOpenSelf}
        title="Open detail"
        className={`min-w-0 text-left ${tier === "initiative" ? "text-[14px] font-semibold" : "text-[13px] font-medium"} text-ink-900 truncate hover:underline underline-offset-2 decoration-ink-300`}
      >
        {title}
      </button>

      {/* Rollup progress bar + x/y */}
      <div className="flex items-center gap-2 shrink-0">
        <div className={`h-1.5 w-24 rounded-full overflow-hidden ${accent.soft}`} title="Done / total cases">
          <div
            className={`h-full ${accent.bar} transition-all`}
            style={{ width: `${Math.round(rollup.ratio * 100)}%` }}
          />
        </div>
        <span className="text-[11px] tabular-nums text-ink-500">
          {rollup.doneCases}/{rollup.totalCases}
        </span>
      </div>

      <span
        className={`shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded-full font-medium ${domainClasses(domain)}`}
      >
        {domainLabel(domain)}
      </span>

      <span className="shrink-0 text-[11px] text-ink-400 tabular-nums" title="Direct children">
        {rollup.childCount} child{rollup.childCount === 1 ? "" : "ren"}
      </span>

      {/* Rolled-up linked mail (self + child cases). Opening the header's drawer
          lists these inherited messages; here we just surface the count. */}
      {rollup.messageCount > 0 && (
        <span
          className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-ink-400 tabular-nums"
          title="Linked emails, incl. child cases"
        >
          <MailGlyph className="w-3.5 h-3.5" />
          {rollup.messageCount}
        </span>
      )}

      <StatusPill status={status} />

      {/* Right cluster: the star (favorite) anchors the edge — always visible when
          starred so favorites read at a glance, hover-revealed otherwise — and the
          inline create actions reveal on hover beside it. */}
      <div className="ml-auto shrink-0 flex items-center gap-1">
        {onToggleStar && <StarButton starred={!!starred} onToggle={onToggleStar} />}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
          {actions}
        </div>
      </div>
    </div>
  );
}

// ── Leaf row (a Case) ──────────────────────────────────────────────────────────
// dot + id + title + status pill + done/total tasks. Clicking (or Enter/Space)
// opens the existing drawer. It is DRAGGABLE (grab the grip to move it under
// another container, detach it, or reorder it among its siblings) and is itself a
// drop target: dropping a sibling here reorders before it; dropping a case from
// ANOTHER container reparents into this row's container (appended). The DnD is
// additive — keyboard users keep the plain open-the-drawer behaviour.
//
// `containerId` is the row's owning container (null for the top-level Ungrouped
// list); the reorder math re-reads that container's children-in-view via the dnd
// bundle, so the row need only name its container.
function LeafRow({
  node,
  depth,
  dnd,
  containerId,
  onOpenCase,
  onToggleStar,
}: {
  node: TreeNode;
  depth: number;
  dnd: Dnd;
  containerId: string | null;
  onOpenCase: (id: string) => void;
  onToggleStar: (id: string, next: boolean) => void;
}) {
  const c = node.case;
  const lane = LANES.find((l) => l.key === c.status);
  const done = c.tasks.filter((t) => t.status === "done").length;
  const total = c.tasks.length;
  // depth 1 = under an initiative; depth 2 = under a workstream (one notch deeper).
  const pad = depth >= 2 ? "pl-12" : "pl-9";

  const beingDragged = dnd.dragging?.id === c.id;
  // As a drop target this row accepts any draggable except itself; whether the drop
  // reorders (same container) or reparents (cross container) is decided in rowProps
  // from the payload's parentId, and the server vets the resulting tier. The ONE
  // exception we pre-filter: a row in the top-level Ungrouped list (containerId ===
  // null) can only host a leaf Case — a workstream there has no handler (it can't
  // detach to top-level), so we reject it rather than light up a dead drop.
  const accepts = (p: DragPayload): boolean =>
    containerId === null ? p.kind === "case" : p.kind !== "initiative";
  const drop = dnd.rowProps(c.id, containerId, accepts);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => dnd.start(e, { id: c.id, kind: "case", parentId: c.parentId })}
      onDragEnd={dnd.end}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      onClick={() => onOpenCase(c.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenCase(c.id);
        }
      }}
      className={`group/leaf w-full text-left flex items-center gap-2 pr-3 py-1.5 ${pad} cursor-grab active:cursor-grabbing hover:bg-ink-50/70 transition ${
        beingDragged ? "opacity-50" : ""
      } ${drop.isOver ? "ring-2 ring-inset ring-violet-200 bg-violet-50/40" : ""}`}
    >
      {/* Grip — reveals on hover to advertise the row is draggable */}
      <span className="shrink-0 -ml-2 text-ink-300 opacity-0 group-hover/leaf:opacity-100 transition" aria-hidden>
        <GripGlyph className="w-3 h-3.5" />
      </span>
      <span
        className={`shrink-0 w-2 h-2 rounded-full ${lane?.dotClass ?? "bg-ink-300"}`}
        title={lane?.label ?? c.status}
        aria-hidden
      />
      <span className="shrink-0 text-[11px] tabular-nums text-ink-400 font-medium">{c.id}</span>
      <span className="min-w-0 truncate text-[12.5px] text-ink-800">{c.title}</span>
      <StatusPill status={c.status} />
      <div className="ml-auto shrink-0 flex items-center gap-2">
        <StarButton starred={!!c.starred} onToggle={() => onToggleStar(c.id, !c.starred)} />
        {total > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-400" title="Done / total tasks">
            {done}/{total}
          </span>
        )}
      </div>
    </div>
  );
}

// A compact lane pill (mirrors the drawer's resting lane chip, decoupled).
function StatusPill({ status }: { status: CaseStatus }) {
  const lane = LANES.find((l) => l.key === status);
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-full bg-ink-50 ${lane?.tone ?? "text-ink-500"}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${lane?.dotClass ?? "bg-ink-300"}`} aria-hidden />
      {lane?.label ?? status}
    </span>
  );
}

// A small inline action button shown in a container header.
function RowAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11.5px] px-1.5 py-0.5 rounded text-ink-500 hover:text-ink-900 hover:bg-ink-100 transition"
    >
      {label}
    </button>
  );
}

// A compact star toggle for the roadmap rows (initiative/workstream header + leaf).
// ALWAYS visible (amber, filled) when starred so favorites read at a glance; when
// NOT starred it stays muted and only surfaces on row hover. The reveal lists BOTH
// `group-hover` and `group-hover/leaf` on purpose: this one button mounts under the
// header's `group` AND under the leaf row's `group/leaf`, so each context matches its
// own variant (the other is inert). Click toggles via onToggle and STOPS propagation so it never
// opens the drawer, toggles the caret, or starts a row drag (onMouseDown stops the
// drag from beginning on the button itself).
function StarButton({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keyboard parity with the click guard: keep Enter/Space from bubbling to the
        // leaf row's onKeyDown (which opens the drawer). The button's OWN activation
        // still toggles the star — we only stop the row from also firing.
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={starred}
      aria-label={starred ? "Unstar — remove from Priorities" : "Star — pin to Priorities"}
      title={starred ? "Starred — click to unstar" : "Star — pin to Priorities"}
      className={`shrink-0 grid place-items-center w-6 h-6 rounded transition ${
        starred
          ? "text-amber-500 hover:bg-amber-50"
          : "text-ink-300 hover:text-amber-500 hover:bg-ink-50 opacity-0 group-hover:opacity-100 group-hover/leaf:opacity-100 focus:opacity-100"
      }`}
    >
      <StarGlyph className="w-3.5 h-3.5" filled={starred} />
    </button>
  );
}

// Star = the 5-point favorite mark (mirrors icons.tsx IconStar's path, kept inline so
// this surface stays decoupled from icons.tsx). Outline by default; filled when starred.
function StarGlyph({ className, filled }: { className?: string; filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      <path d="M8 1.9l1.78 3.99 4.34.43-3.25 2.9.94 4.27L8 11.95 3.44 13.48l.94-4.27L1.13 6.31l4.34-.43L8 1.9Z" />
    </svg>
  );
}

// ── Inline composer ────────────────────────────────────────────────────────────
// A single-line title input: Enter submits, Esc cancels, blur cancels (unless
// busy). Used for all three create flows; the parent decides what gets built.
function InlineComposer({
  placeholder,
  busy,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  busy: boolean;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        autoFocus
        value={value}
        disabled={busy}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        className="flex-1 bg-white border border-sky-300 rounded px-2 py-1.5 text-[13px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => onSubmit(value)}
        disabled={busy || !value.trim()}
        className="text-[12px] px-2 py-1.5 rounded bg-ink-900 text-white hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-[12px] px-1.5 py-1.5 rounded text-ink-400 hover:text-ink-700"
        aria-label="Cancel"
      >
        ×
      </button>
    </div>
  );
}

// ── Inline glyphs (decoupled from icons.tsx) ───────────────────────────────────
function CaretGlyph({ className, open }: { className?: string; open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d={open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Initiative = a stacked "epic" mark (three bars).
function InitiativeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <rect x="2.5" y="3" width="11" height="2.2" rx="1.1" fill="currentColor" />
      <rect x="2.5" y="7" width="8" height="2.2" rx="1.1" fill="currentColor" opacity="0.8" />
      <rect x="2.5" y="11" width="5" height="2.2" rx="1.1" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

// Workstream = a branch mark (a node splitting into a thread).
function WorkstreamGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <circle cx="4" cy="4" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path d="M4 5.6V9a3 3 0 003 3h3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function WarnGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M8 1.8L15 14H1L8 1.8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M8 6.2v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.8" fill="currentColor" />
    </svg>
  );
}

// Grip = the conventional 6-dot drag handle (two columns of three dots).
function GripGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <circle cx="5.5" cy="3.5" r="1.2" />
      <circle cx="10.5" cy="3.5" r="1.2" />
      <circle cx="5.5" cy="8" r="1.2" />
      <circle cx="10.5" cy="8" r="1.2" />
      <circle cx="5.5" cy="12.5" r="1.2" />
      <circle cx="10.5" cy="12.5" r="1.2" />
    </svg>
  );
}

// Mail = an envelope, for the rolled-up linked-email count on container headers.
function MailGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 4.5L8 8.6l5.4-4.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Eye = the show/hide-completed toggle; `off` draws a slash through it (hidden).
function EyeGlyph({ className, off }: { className?: string; off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      {off && <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}
