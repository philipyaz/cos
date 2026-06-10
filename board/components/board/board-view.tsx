"use client";

// BoardView — the operational kanban + strategy lens for the case tree.
//
// OWNS: the live `cases` snapshot, the optimistic/undo machinery, the
// filter/sort/group query (mirrored to the URL + prefs.json), the multi-select
// + bulk bar, drag-drop (lane move + intra-lane reorder), the Done-lane "Clean"
// purge, and the toast/undo host. The board is AGENT-NATIVE: cases are NOT
// created on this surface — they arrive from the agent / inbox triage — so there
// is no manual "new case" affordance here.
// DELEGATES: the kanban column to <Column>, each card to <CaseCard>, the
// strategy roadmap to <StrategyView>, the case drawer to <CaseDetailDrawer>,
// and the label catalog UI to <LabelManager>/<LabelFilter>. Every mutation
// goes through board-client (the same HTTP routes the agent's MCP twin hits).
//
// LIVE + OPTIMISTIC + UNDO model:
//  • Live: subscribeToBoard pushes a version; when it's newer than lastVersion
//    we refetch + replace, so agent/other writes land without a reload.
//  • Optimistic: a gesture mutates `cases` immediately, fires the server call,
//    then reconciles to the server's copy (or reverts to the pre-gesture
//    snapshot on error) — the user never waits on the round-trip.
//  • Undo: each undoable gesture pushes an inverse (local `apply` + server
//    `run`) onto a stack; the toast's Undo and Cmd/Ctrl+Z replay the latest.
//
// Verbs routed through `optimistic()` (the ONE revert/undo path): moveCaseTo,
// archiveOne, reorderWithin. Three flows stay inline because each needs
// something `optimistic()` deliberately does not model:
//  • bulkPatch / bulkArchive — a multi-entity transaction whose final state is
//    reconciled via refetch(), which the single-case helper has no hook for.
//  • cleanColumn — a PERMANENT bulk delete (done cases + their emails) with no
//    undo, so the revert/undo dance doesn't apply; a confirm dialog guards it.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { CaseRecord, CaseStatus, CaseDomain, MessageRecord, Settings, LabelDef } from "@/lib/types";
import { LANES } from "@/lib/types";
import {
  applyBoardQuery,
  groupCases,
  isLeaf,
  lineageOfCases,
  rootInitiativeOf,
  rolledUpMessageIds,
  type BoardQuery,
  type BoardSort,
  type BoardGroup,
} from "@/lib/selectors";
import { encodeBoardQuery } from "@/lib/selectors";
import {
  moveCase,
  updateCase,
  updateCases,
  starCase as apiStarCase,
  archiveCase as apiArchiveCase,
  restoreCase as apiRestoreCase,
  cleanCases,
  fetchCases,
  fetchLabels,
  subscribeToBoard,
  savePrefs,
} from "@/lib/board-client";
import { Column } from "./column";
import { CaseCard, type CardLineage } from "./case-card";
import { StrategyView } from "./strategy-view";
import { LabelManager } from "./label-manager";
import { LabelFilter } from "./label-filter";
import { CaseDetailDrawer } from "@/components/case-detail-drawer";
import {
  IconFilter,
  IconSpark,
  IconStar,
  IconChevronDown,
  IconTag,
  IconTree,
  IconInitiative,
} from "@/components/icons";

// ── Undo model ───────────────────────────────────────────────────────────────
// Every card-level gesture (lane move, archive, quick-add) pushes an inverse
// onto a stack. The toast offers Undo and Cmd/Ctrl+Z replays the latest inverse
// through board-client. `run` is the async server call; `revertLocal` is an
// optional optimistic local revert applied immediately when undoing.
interface UndoEntry {
  label: string;
  run: () => Promise<unknown>;
  apply: (cases: CaseRecord[]) => CaseRecord[];
}

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
  tone: "info" | "error";
}

type DomainFilter = "all" | CaseDomain;

const SORTS: { key: BoardSort; label: string }[] = [
  { key: "updated", label: "Updated" },
  { key: "created", label: "Created" },
  { key: "due", label: "Due" },
  { key: "priority", label: "Priority" },
  { key: "title", label: "Title" },
  { key: "doneRatio", label: "Progress" },
  { key: "position", label: "Manual" },
];

const GROUPS: { key: BoardGroup; label: string }[] = [
  { key: "none", label: "None" },
  { key: "initiative", label: "Initiative" },
  { key: "workstream", label: "Workstream" },
  { key: "domain", label: "Domain" },
  { key: "priority", label: "Priority" },
  { key: "label", label: "Label" },
  { key: "tag", label: "Tag" },
];

export function BoardView({
  now,
  cases: initialCases,
  messages,
  version: initialVersion,
  query: initialQuery,
  collapsedLanes,
  collapsedNodes,
  settings,
  labels: initialLabels,
  view: initialView,
}: {
  now: string;
  cases: CaseRecord[];
  messages: import("@/lib/types").MessageRecord[];
  version?: number;
  query?: BoardQuery;
  collapsedLanes?: CaseStatus[];
  collapsedNodes?: string[];
  settings?: Settings;
  labels?: LabelDef[];
  view?: "operational" | "strategy";
}) {
  // Fixed clock — parsed ONCE from the SSR `now` prop and threaded down to every
  // card so relativeTime / dueLabel / dueStatus / isStale compute against the
  // server request instant. Never `new Date()` during render (no SSR/hydration
  // drift on the cards' relative timestamps + due classification).
  const clock = useMemo(() => new Date(now), [now]);

  // ── Live + optimistic state ──────────────────────────────────────────────
  const [cases, setCases] = useState<CaseRecord[]>(initialCases);
  const lastVersion = useRef<number>(initialVersion ?? 0);
  const [live, setLive] = useState<"idle" | "synced">("idle");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverLane, setDragOverLane] = useState<CaseStatus | null>(null);
  // The card we're hovering over for an intra-lane reorder drop ("before" it).
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  const [showToolbar, setShowToolbar] = useState(false);
  // Whether the bulk-bar's "Move to lane" submenu is open.
  const [bulkLaneOpen, setBulkLaneOpen] = useState(false);
  // The label catalog (kept in state so installs/edits via the manager and agent
  // writes over SSE refresh the chips/filter without a reload) + the manager panel.
  const [labelCatalog, setLabelCatalog] = useState<LabelDef[]>(initialLabels ?? []);
  const [showLabelManager, setShowLabelManager] = useState(false);
  // Operational (kanban of leaf cases) vs Strategy (the Initiative > Workstream
  // outline roadmap). Seeded from prefs; the toggle persists the choice.
  const [view, setView] = useState<"operational" | "strategy">(initialView ?? "operational");
  // Operational-only focus: clicking a card's lineage breadcrumb narrows the lanes
  // to a single initiative's subtree (all its leaves, any depth). Cleared by a chip.
  const [focusInitiative, setFocusInitiative] = useState<string | null>(null);

  const undoStack = useRef<UndoEntry[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Query (filter/sort/group) state ──────────────────────────────────────
  const [query, setQuery] = useState<BoardQuery>(initialQuery ?? {});
  const domainFilter: DomainFilter = query.domain ?? "all";

  // Reflect the query into the URL so every slice is deep-linkable, without a
  // navigation (replaceState keeps SSR untouched; the page reads it on reload).
  // encodeBoardQuery only emits filter/sort/group keys, so we re-attach a live
  // ?case deep-link we haven't consumed yet — otherwise this writer would wipe a
  // fresh deep-link before the consumer effect below sees it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(encodeBoardQuery(query));
    const incoming = new URLSearchParams(window.location.search);
    const caseParam = incoming.get("case");
    if (caseParam) sp.set("case", caseParam);
    const qs = sp.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [query]);

  // ── Persisted view state (board/data/prefs.json) ─────────────────────────
  // Collapsed lanes — seeded from the server prefs, toggled per lane. Persisted
  // immediately (a deliberate click) so a folded "Done" stays folded after reboot.
  const [collapsed, setCollapsed] = useState<Set<CaseStatus>>(() => new Set(collapsedLanes ?? []));
  const toggleLaneCollapsed = useCallback((lane: CaseStatus) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      void savePrefs({ collapsedLanes: Array.from(next) }).catch(() => {});
      return next;
    });
  }, []);

  // Strategy-roadmap folded containers — the outline twin of collapsedLanes. Held HERE
  // in the always-mounted BoardView (StrategyView mounts/unmounts on the view toggle,
  // so collapse state living there would reset on every switch); seeded from server
  // prefs, toggled per container, persisted immediately so a folded initiative/
  // workstream stays folded across a view switch, reload, or reboot.
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set(collapsedNodes ?? []));
  const toggleNodeCollapsed = useCallback((id: string) => {
    setCollapsedNodeIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void savePrefs({ collapsedNodes: Array.from(next) }).catch(() => {});
      return next;
    });
  }, []);

  // Persist the last-used filter/sort/group (debounced, so typing in the text
  // filter coalesces into one write). Skip the initial mount so just opening the
  // board — or following a deep link — doesn't overwrite the saved slice; only a
  // real user change does. Best-effort: failures are swallowed (view state only).
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (!prefsHydrated.current) {
      prefsHydrated.current = true;
      return;
    }
    const t = setTimeout(() => {
      void savePrefs({ boardQuery: encodeBoardQuery(query) }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [query]);

  // ── Deep-link consumer: ?case=CASE-n opens that case's drawer. Runs on mount
  // and whenever the URL changes (popstate / pushes from the command palette).
  // Consumes the param (strips it) so a later filter-sync write doesn't keep
  // re-triggering it, and so the drawer can be closed.
  const consumeDeepLink = useCallback(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const caseParam = sp.get("case");
    if (!caseParam) return;
    setSelectedId(caseParam);
    // Strip the consumed param; keep the filter/sort/group slice intact.
    sp.delete("case");
    const qs = sp.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    consumeDeepLink();
    window.addEventListener("popstate", consumeDeepLink);
    return () => window.removeEventListener("popstate", consumeDeepLink);
  }, [consumeDeepLink]);

  // ── Live subscription: refetch + replace when a newer version lands ───────
  const refetch = useCallback(async () => {
    try {
      const [res, lr] = await Promise.all([
        fetchCases({ includeArchived: query.includeArchived }),
        fetchLabels().catch(() => null), // catalog refresh is best-effort
      ]);
      lastVersion.current = res.version;
      setCases(res.cases);
      if (lr) setLabelCatalog(lr.labels);
      setLive("synced");
    } catch {
      // Keep the optimistic state; a later event will retry.
    }
  }, [query.includeArchived]);

  useEffect(() => {
    const unsub = subscribeToBoard((v) => {
      if (v > lastVersion.current) {
        void refetch();
      }
    });
    return unsub;
  }, [refetch]);

  // When the archive toggle flips, refetch so archived cases load/unload.
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.includeArchived]);

  // ── Toast / undo plumbing ────────────────────────────────────────────────
  const showToast = useCallback((t: Omit<Toast, "id">) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ ...t, id });
    toastTimer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), 6000);
  }, []);

  const performUndo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    setCases((cur) => entry.apply(cur));
    entry
      .run()
      .then((r) => {
        const v = (r as { version?: number } | undefined)?.version;
        if (typeof v === "number") lastVersion.current = v;
      })
      .catch((err: unknown) => {
        showToast({ message: `Undo failed: ${String((err as Error).message)}`, tone: "error" });
        void refetch();
      });
    showToast({ message: "Undone", tone: "info" });
  }, [refetch, showToast]);

  // Optimistically mutate local state, fire the server call, reconcile/revert.
  //
  // The default path models a SINGLE-entity mutation whose undo label is known
  // up front and whose server response carries the canonical `{ case }` to
  // id-replace (moveCaseTo / archiveOne / reorderWithin use this — no `opts`).
  // `opts` is a fully additive override (reconcile / undo / toast) for flows
  // whose real id or final state arrives only in the response — omit it and the
  // behaviour is exactly the single-entity default.
  const optimistic = useCallback(
    (
      label: string,
      apply: (cases: CaseRecord[]) => CaseRecord[],
      run: () => Promise<{ version?: number; case?: CaseRecord } | unknown>,
      inverse: { apply: (cases: CaseRecord[]) => CaseRecord[]; run: () => Promise<unknown> },
      opts?: {
        // Fold the server response into local state (replaces the default
        // single-case id-replace) — e.g. swap a temp placeholder for the real
        // record, or insert a freshly-created case.
        reconcile?: (res: { version?: number; case?: CaseRecord }, cases: CaseRecord[]) => CaseRecord[];
        // Build the undo entry from the response (replaces the static `label` +
        // `inverse`), for when the new id isn't known until the call returns.
        undo?: (res: { version?: number; case?: CaseRecord }) => UndoEntry | null;
        // Toast text, when it must differ from the undo entry's label.
        toast?: (res: { version?: number; case?: CaseRecord }) => string;
      },
    ) => {
      setCases((cur) => apply(cur));
      run()
        .then((r) => {
          const res = (r ?? {}) as { version?: number; case?: CaseRecord };
          if (typeof res.version === "number") lastVersion.current = res.version;
          // Reconcile local state with the server's canonical copy.
          if (opts?.reconcile) {
            const reconcile = opts.reconcile;
            setCases((cur) => reconcile(res, cur));
          } else if (res.case) {
            const updated = res.case;
            setCases((cur) => cur.map((c) => (c.id === updated.id ? updated : c)));
          }
          const entry = opts?.undo ? opts.undo(res) : { label, run: inverse.run, apply: inverse.apply };
          if (entry) undoStack.current.push(entry);
          const message = opts?.toast ? opts.toast(res) : entry?.label ?? label;
          showToast({ message, undo: entry ? performUndo : undefined, tone: "info" });
        })
        .catch((err: unknown) => {
          // Revert by re-pulling the authoritative set rather than clobbering with a
          // stale render-time snapshot: a snapshot can resurrect a card another writer
          // removed (or drop a concurrent agent edit) if an SSE refetch landed mid-flight.
          void refetch();
          showToast({ message: `Failed: ${String((err as Error).message)}`, tone: "error" });
        });
    },
    [performUndo, showToast, refetch],
  );

  // ── Card-level verbs ─────────────────────────────────────────────────────
  const moveCaseTo = useCallback(
    (id: string, status: CaseStatus) => {
      const target = cases.find((c) => c.id === id);
      if (!target || target.status === status) return;
      const prev = target.status;
      const lane = LANES.find((l) => l.key === status)?.label ?? status;
      optimistic(
        `Moved to ${lane}`,
        (cur) => cur.map((c) => (c.id === id ? { ...c, status } : c)),
        () => moveCase(id, status),
        {
          apply: (cur) => cur.map((c) => (c.id === id ? { ...c, status: prev } : c)),
          run: () => moveCase(id, prev),
        },
      );
    },
    [cases, optimistic],
  );

  const archiveOne = useCallback(
    (id: string) => {
      const target = cases.find((c) => c.id === id);
      if (!target) return;
      if (typeof window !== "undefined" && !window.confirm(`Delete ${id}? It moves to Trash (you can undo this).`)) return;
      // The board only shows live cases, so a delete drops the card; it reappears in
      // the /trash surface. Undo re-adds it here (restore clears archivedAt).
      optimistic(
        `Deleted ${id}`,
        (cur) => cur.filter((c) => c.id !== id),
        () => apiArchiveCase(id),
        {
          apply: (cur) => (cur.some((c) => c.id === id) ? cur : [...cur, target]),
          run: () => apiRestoreCase(id),
        },
      );
      if (selectedId === id) setSelectedId(null);
    },
    [cases, optimistic, selectedId],
  );

  // Star / unstar a card (the favorite/pin) — a single-field flip routed through
  // the same optimistic/undo path as a lane move. starCase returns the updated
  // `{ case }`, so the default reconcile id-replaces it; the inverse re-flips.
  const toggleStar = useCallback(
    (id: string) => {
      const target = cases.find((c) => c.id === id);
      if (!target) return;
      const next = !target.starred;
      optimistic(
        next ? `Starred ${id}` : `Unstarred ${id}`,
        (cur) => cur.map((c) => (c.id === id ? { ...c, starred: next || undefined } : c)),
        () => apiStarCase(id, next),
        {
          apply: (cur) => cur.map((c) => (c.id === id ? { ...c, starred: !next || undefined } : c)),
          run: () => apiStarCase(id, !next),
        },
      );
    },
    [cases, optimistic],
  );

  // ── Bulk actions (update_cases UI twin) ──────────────────────────────────
  const clearSelection = useCallback(() => setPicked(new Set()), []);

  // Apply one patch across all selected ids, optimistically, with a single undo.
  const bulkPatch = useCallback(
    (label: string, patch: Record<string, unknown>, optimisticApply: (c: CaseRecord) => CaseRecord) => {
      const ids = Array.from(picked);
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const before = cases;
      // Snapshot the affected records so undo restores their exact prior fields.
      const prior = before.filter((c) => idSet.has(c.id));
      setCases((cur) => cur.map((c) => (idSet.has(c.id) ? optimisticApply(c) : c)));
      clearSelection();
      updateCases(ids, patch)
        .then((res) => {
          if (typeof res.version === "number") lastVersion.current = res.version;
          if (Array.isArray(res.cases)) void refetch();
          undoStack.current.push({
            label,
            apply: (cur) => cur.map((c) => prior.find((p) => p.id === c.id) ?? c),
            run: () =>
              Promise.all(
                prior.map((p) =>
                  updateCase(p.id, {
                    status: p.status,
                    domain: p.domain,
                    archivedAt: p.archivedAt ?? null,
                  }),
                ),
              ),
          });
          showToast({ message: label, undo: performUndo, tone: "info" });
        })
        .catch((err: unknown) => {
          // Reconcile from the server rather than restoring a stale `before`
          // snapshot — a concurrent SSE/agent write (e.g. another delete) landing
          // mid-flight must not be resurrected by our revert (same class as the
          // optimistic()/bulkArchive race fix).
          void refetch();
          showToast({ message: `Failed: ${String((err as Error).message)}`, tone: "error" });
        });
    },
    [cases, picked, clearSelection, refetch, performUndo, showToast],
  );

  const bulkMove = useCallback(
    (status: CaseStatus) => {
      const lane = LANES.find((l) => l.key === status)?.label ?? status;
      bulkPatch(`Moved ${picked.size} to ${lane}`, { status }, (c) => ({ ...c, status }));
    },
    [bulkPatch, picked.size],
  );

  const bulkDomain = useCallback(
    (domain: CaseDomain) => {
      bulkPatch(`Set ${picked.size} to ${domain}`, { domain }, (c) => ({ ...c, domain }));
    },
    [bulkPatch, picked.size],
  );

  const bulkArchive = useCallback(() => {
    if (typeof window !== "undefined" && !window.confirm(`Delete ${picked.size} case(s)? They move to Trash (you can undo this).`))
      return;
    const ids = Array.from(picked);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const prior = cases.filter((c) => idSet.has(c.id));
    setCases((cur) => cur.filter((c) => !idSet.has(c.id)));
    clearSelection();
    updateCases(ids, { archivedAt: new Date().toISOString() })
      .then((res) => {
        if (typeof res.version === "number") lastVersion.current = res.version;
        void refetch();
        undoStack.current.push({
          label: `Deleted ${ids.length} case(s)`,
          apply: (cur) => {
            const have = new Set(cur.map((c) => c.id));
            return [...cur, ...prior.filter((p) => !have.has(p.id))];
          },
          run: () => Promise.all(prior.map((p) => apiRestoreCase(p.id))),
        });
        showToast({ message: `Deleted ${ids.length} case(s)`, undo: performUndo, tone: "info" });
      })
      .catch((err: unknown) => {
        // Re-pull authoritative state instead of clobbering with a stale snapshot.
        void refetch();
        showToast({ message: `Failed: ${String((err as Error).message)}`, tone: "error" });
      });
  }, [cases, picked, clearSelection, refetch, performUndo, showToast]);

  // ── Clean Done (storage reclaim) ─────────────────────────────────────────
  // PERMANENTLY delete the done cases shown in a column AND purge their linked
  // emails (an email also linked to a reminder is kept + unlinked server-side).
  // Unlike archive this is NOT undoable — a disk backup is the only safety net —
  // so a confirm dialog stating the count guards it. Optimistically drops the
  // cards, then refetch()es to resync the canonical set. `items` is the done
  // column's current cards, so a filtered/grouped board cleans exactly what's
  // shown (the route additionally hard-guards: it only ever purges done-lane ids).
  const cleanColumn = useCallback(
    (items: CaseRecord[]) => {
      const ids = items.map((c) => c.id);
      if (ids.length === 0) return;
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Permanently delete ${ids.length} done case${ids.length === 1 ? "" : "s"} and their linked emails?\n\n` +
            `This frees storage and can't be undone from the board (a disk backup is kept).`,
        )
      ) {
        return;
      }
      const idSet = new Set(ids);
      setCases((cur) => cur.filter((c) => !idSet.has(c.id)));
      if (selectedId && idSet.has(selectedId)) setSelectedId(null);
      setPicked((cur) => {
        if (!ids.some((id) => cur.has(id))) return cur;
        const next = new Set(cur);
        for (const id of ids) next.delete(id);
        return next;
      });
      cleanCases(ids)
        .then((res) => {
          if (typeof res.version === "number") lastVersion.current = res.version;
          void refetch();
          const emails = res.messagesDeleted
            ? ` · ${res.messagesDeleted} email${res.messagesDeleted === 1 ? "" : "s"} deleted`
            : "";
          showToast({
            message: `Cleaned ${res.removed} done case${res.removed === 1 ? "" : "s"}${emails}`,
            tone: "info",
          });
        })
        .catch((err: unknown) => {
          // Re-pull authoritative state instead of clobbering with a stale snapshot.
          void refetch();
          showToast({ message: `Clean failed: ${String((err as Error).message)}`, tone: "error" });
        });
    },
    [selectedId, refetch, showToast],
  );

  // ── Intra-lane reorder (position) ────────────────────────────────────────
  // Drop `id` immediately before `beforeId` within the same lane: assign a
  // `position` between the two neighbours (or just under the top one) and persist.
  const reorderWithin = useCallback(
    (id: string, beforeId: string) => {
      if (id === beforeId) return;
      const moving = cases.find((c) => c.id === id);
      const target = cases.find((c) => c.id === beforeId);
      if (!moving || !target || moving.status !== target.status) return;

      // The lane in current visual order (the same projection the board renders).
      const laneCases = applyBoardQuery(cases, query).filter((c) => c.status === target.status);
      const targetIdx = laneCases.findIndex((c) => c.id === beforeId);
      if (targetIdx < 0) return;
      const prevCard = laneCases[targetIdx - 1];
      const before = prevCard?.position;
      const after = target.position;

      // Fast path: both neighbours already carry a position, so we can simply
      // interpolate a single value between them and persist just the moved card.
      if (before !== undefined && after !== undefined) {
        const newPos = (before + after) / 2;
        if (moving.position === newPos) return;
        const prevPos = moving.position;
        optimistic(
          "Reordered",
          (cur) => cur.map((c) => (c.id === id ? { ...c, position: newPos } : c)),
          () => updateCase(id, { position: newPos }),
          {
            apply: (cur) => cur.map((c) => (c.id === id ? { ...c, position: prevPos } : c)),
            run: () => updateCase(id, { position: prevPos ?? null }),
          },
        );
        return;
      }

      // Seeding path: at least one neighbour has no position yet, so a lone index
      // on only the moved card would be meaningless against position-less siblings
      // (they sort as Infinity). Rebase the WHOLE lane to sequential positions in
      // its current visual order, with the moved card slotted before `beforeId`.
      const STEP = 1000;
      const reordered = laneCases.filter((c) => c.id !== id);
      const insertAt = reordered.findIndex((c) => c.id === beforeId);
      reordered.splice(insertAt, 0, moving);
      const positions = new Map(reordered.map((c, i) => [c.id, i * STEP]));
      const newPos = positions.get(id)!;
      if (moving.position === newPos && reordered.every((c) => c.position === positions.get(c.id))) return;

      const prior = laneCases.map((c) => ({ id: c.id, position: c.position }));
      optimistic(
        "Reordered",
        (cur) => cur.map((c) => (positions.has(c.id) ? { ...c, position: positions.get(c.id) } : c)),
        () =>
          // Persist the rebased lane in one batch so subsequent reorders have real
          // neighbour positions to interpolate between.
          Promise.all(
            reordered.map((c) => updateCase(c.id, { position: positions.get(c.id) })),
          ).then(() => ({})),
        {
          apply: (cur) =>
            cur.map((c) => {
              const p = prior.find((x) => x.id === c.id);
              return p ? { ...c, position: p.position } : c;
            }),
          run: () => Promise.all(prior.map((p) => updateCase(p.id, { position: p.position ?? null }))),
        },
      );
    },
    [cases, query, optimistic],
  );

  // ── Filtered / grouped projection ────────────────────────────────────────
  // The OPERATIONAL board shows leaf cases only — Initiatives/Workstreams are
  // containers and live in the Strategy view (they stay in `cases` so lineage and
  // group-by-initiative can resolve their titles). A focused initiative narrows
  // the lanes to that initiative's whole subtree.
  const filtered = useMemo(() => {
    const leaves = applyBoardQuery(cases, query).filter(isLeaf);
    if (!focusInitiative) return leaves;
    return leaves.filter((c) => rootInitiativeOf(cases, c.id)?.id === focusInitiative);
  }, [cases, query, focusInitiative]);
  // group-by initiative/workstream needs the FULL set (containers included) to
  // resolve a leaf's ancestor — pass `cases` as the allCases arg.
  const grouped = useMemo(
    () => groupCases(filtered, query.group ?? "none", cases),
    [filtered, query.group, cases],
  );
  const focusInitiativeTitle = focusInitiative
    ? cases.find((c) => c.id === focusInitiative)?.title ?? focusInitiative
    : null;

  // Persisted view toggle: flip the surface and remember it (best-effort).
  const setBoardView = useCallback((v: "operational" | "strategy") => {
    setView(v);
    void savePrefs({ view: v }).catch(() => {});
  }, []);

  // Lineage breadcrumb for a leaf card (ancestor container titles, root-first) +
  // the root initiative id so a click can focus that initiative. Undefined when
  // the case is a standalone top-level leaf (no breadcrumb to show).
  const lineageFor = useCallback(
    (id: string): CardLineage | undefined => {
      const ancestors = lineageOfCases(cases, id).slice(0, -1);
      if (!ancestors.length) return undefined;
      return { titles: ancestors.map((a) => a.title), initiativeId: rootInitiativeOf(cases, id)?.id };
    },
    [cases],
  );

  // id → LabelDef for resolving chips on cards, the drawer, filter, and group headers.
  const labelMap = useMemo(
    () => Object.fromEntries(labelCatalog.map((l) => [l.id, l])) as Record<string, LabelDef>,
    [labelCatalog],
  );

  const selected = selectedId ? cases.find((c) => c.id === selectedId) ?? null : null;
  // The drawer's Messages section inherits down the tree: a leaf shows only its
  // own linked mail, but an Initiative/Workstream rolls up every message linked to
  // it OR any descendant (rolledUpMessageIds — self first, de-duplicated), so the
  // user sees all the related email in one place. `messages` is the static SSR set
  // (no refetch here — matches today's behavior); we just widen the id filter to
  // the rolled-up set and sort newest-first for the drawer to render.
  const drawerMessages = useMemo(() => {
    if (!selected) return [];
    const ids = new Set(
      rolledUpMessageIds(cases, selected.id, { includeArchived: query.includeArchived }),
    );
    // Newest-first; normalize so a bad/absent receivedAt (NaN) deterministically
    // sinks to the bottom rather than landing in an engine-dependent spot — mirrors
    // the GET /api/cases/[id] route's ordering.
    const receivedMs = (m: MessageRecord): number => {
      const n = new Date(m.receivedAt).getTime();
      return Number.isNaN(n) ? -Infinity : n;
    };
    return messages
      .filter((m) => ids.has(m.id))
      .sort((a, b) => receivedMs(b) - receivedMs(a));
  }, [selected, cases, messages, query.includeArchived]);

  // ── Drag-drop ────────────────────────────────────────────────────────────
  const onCardDragStart = useCallback(
    (id: string) => (e: DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", id);
      } catch {
        // some browsers restrict setData outside of trusted handlers — ignore
      }
    },
    [],
  );
  const onCardDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverLane(null);
    setDragOverCardId(null);
  }, []);
  const onLaneDragOver = useCallback(
    (lane: CaseStatus) => (e: DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOverLane !== lane) setDragOverLane(lane);
    },
    [dragId, dragOverLane],
  );
  const onLaneDrop = useCallback(
    (lane: CaseStatus) => (e: DragEvent) => {
      e.preventDefault();
      const id = dragId ?? e.dataTransfer.getData("text/plain");
      const overCard = dragOverCardId;
      setDragOverLane(null);
      setDragId(null);
      setDragOverCardId(null);
      if (!id) return;
      const dropped = cases.find((c) => c.id === id);
      // Cross-lane drop = lane move. Same-lane drop onto a card = reorder.
      if (dropped && dropped.status === lane && overCard && overCard !== id) {
        reorderWithin(id, overCard);
      } else {
        moveCaseTo(id, lane);
      }
    },
    [dragId, dragOverCardId, cases, moveCaseTo, reorderWithin],
  );

  // Card-level drag hover: marks the card the dragged item would drop *before*,
  // for the intra-lane reorder indicator.
  const onCardDragOver = useCallback(
    (id: string) => (e: DragEvent) => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      if (dragOverCardId !== id) setDragOverCardId(id);
    },
    [dragId, dragOverCardId],
  );
  const onCardDrop = useCallback(
    (overId: string, lane: CaseStatus) => (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const id = dragId ?? e.dataTransfer.getData("text/plain");
      setDragOverLane(null);
      setDragId(null);
      setDragOverCardId(null);
      if (!id || id === overId) return;
      const dropped = cases.find((c) => c.id === id);
      if (dropped && dropped.status === lane) reorderWithin(id, overId);
      else moveCaseTo(id, lane);
    },
    [dragId, cases, reorderWithin, moveCaseTo],
  );

  // ── Keyboard map ─────────────────────────────────────────────────────────
  const onCardKeyDown = useCallback(
    (id: string) => (e: KeyboardEvent) => {
      // Lane jumps 1–5
      const laneIdx = ["1", "2", "3", "4", "5"].indexOf(e.key);
      if (laneIdx >= 0) {
        e.preventDefault();
        moveCaseTo(id, LANES[laneIdx]!.key);
        return;
      }
      if (e.key === "e" || e.key === "Enter") {
        e.preventDefault();
        setSelectedId(id);
      } else if (e.key === "a") {
        e.preventDefault();
        archiveOne(id);
      } else if (e.key === "x") {
        e.preventDefault();
        setPicked((cur) => {
          const next = new Set(cur);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    },
    [moveCaseTo, archiveOne],
  );

  // Global shortcuts: Cmd/Ctrl+Z undo, Esc to clear a multi-select.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        performUndo();
      } else if (e.key === "Escape") {
        // Esc clears a multi-select (the drawer/menus stop propagation first).
        if (typing) return;
        setPicked((cur) => (cur.size ? new Set() : cur));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [performUndo]);

  const patchQuery = useCallback((p: Partial<BoardQuery>) => {
    setQuery((cur) => {
      const next = { ...cur, ...p };
      // Drop empty values so the URL/encode stays clean.
      (Object.keys(next) as (keyof BoardQuery)[]).forEach((k) => {
        const v = next[k];
        if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || v === false) {
          delete next[k];
        }
      });
      return next;
    });
  }, []);

  const setDomain = (d: DomainFilter): void =>
    patchQuery({ domain: d === "all" ? undefined : d });

  // Toggle a label in/out of the active label filter (an OR facet). Clicking a
  // chip on a card calls this too, so the board jumps to "show me this label".
  const toggleLabelFilter = useCallback(
    (id: string) => {
      const set = new Set(query.labels ?? []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      patchQuery({ labels: Array.from(set) });
    },
    [query.labels, patchQuery],
  );

  // Add/remove a whole set of label ids at once (a bundle's labels, via the filter's
  // group "select all"), in one patch — so filtering by a scope of bundles is one click.
  const selectLabels = useCallback(
    (ids: string[], on: boolean) => {
      const set = new Set(query.labels ?? []);
      for (const id of ids) {
        if (on) set.add(id);
        else set.delete(id);
      }
      patchQuery({ labels: Array.from(set) });
    },
    [query.labels, patchQuery],
  );

  const activeFilterCount =
    (query.tag ? 1 : 0) +
    (query.labels?.length ? 1 : 0) +
    (query.q ? 1 : 0) +
    (query.includeArchived ? 1 : 0);

  return (
    <>
      {/* Toolbar row */}
      <div className="px-3 pt-3 flex items-center gap-1 flex-wrap">
        {/* Operational ↔ Strategy view toggle (the strategy/operational lens) */}
        <div className="inline-flex items-center rounded-md border border-ink-200 p-0.5 mr-1.5">
          {(["operational", "strategy"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setBoardView(v)}
              aria-pressed={view === v}
              className={`inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded transition ${
                view === v ? "bg-ink-900 text-white font-medium" : "text-ink-500 hover:text-ink-900"
              }`}
              title={v === "operational" ? "Operational — the kanban of cases" : "Strategy — the Initiative roadmap"}
            >
              {v === "strategy" && <IconTree className="w-3 h-3" />}
              {v === "operational" ? "Operational" : "Strategy"}
            </button>
          ))}
        </div>
        {(["all", "work", "life"] as DomainFilter[]).map((d) => (
          <button
            key={d}
            onClick={() => setDomain(d)}
            className={`text-[12.5px] px-2.5 py-1 rounded-md transition ${
              domainFilter === d
                ? "text-ink-900 bg-ink-100 font-medium"
                : "text-ink-500 hover:text-ink-900 hover:bg-ink-50"
            }`}
          >
            {d === "all" ? "All" : d === "work" ? "Work" : "Life"}
          </button>
        ))}
        {view === "operational" && (
          <span className="ml-1 text-[11.5px] text-ink-400 tabular-nums">
            {filtered.length} {filtered.length === 1 ? "case" : "cases"}
          </span>
        )}
        {view === "operational" && focusInitiativeTitle && (
          <button
            onClick={() => setFocusInitiative(null)}
            title="Clear initiative focus"
            className="ml-1 inline-flex items-center gap-1 text-[11.5px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100 transition"
          >
            <IconInitiative className="w-3 h-3" />
            <span className="max-w-[160px] truncate">{focusInitiativeTitle}</span>
            <span aria-hidden>×</span>
          </button>
        )}
        {live === "synced" && (
          <span
            className="ml-1 inline-flex items-center gap-1 text-[10.5px] text-emerald-600"
            title="Live — reflects agent + other writes"
          >
            <IconSpark className="w-3 h-3" />
            live
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowToolbar((v) => !v)}
            aria-pressed={showToolbar}
            className={`text-[12px] flex items-center gap-1.5 px-2 py-1 rounded-md border transition ${
              showToolbar || activeFilterCount > 0
                ? "text-ink-900 bg-ink-50 border-ink-200 font-medium"
                : "text-ink-500 border-ink-100 hover:bg-ink-50 hover:text-ink-900"
            }`}
          >
            <IconFilter className="w-3.5 h-3.5" />
            Filter{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </button>
          <button
            onClick={() => setShowLabelManager(true)}
            title="Manage labels — install bundles, add custom labels"
            className="text-[12px] flex items-center gap-1.5 px-2 py-1 rounded-md border border-ink-100 text-ink-500 hover:bg-ink-50 hover:text-ink-900 transition"
          >
            <IconTag className="w-3.5 h-3.5" />
            Labels
          </button>
        </div>
      </div>

      {showToolbar && (
        <div className="px-3 pt-2 flex items-center gap-2 flex-wrap text-[12px]">
          <input
            value={query.q ?? ""}
            onChange={(e) => patchQuery({ q: e.target.value || undefined })}
            placeholder="Search title, summary, tasks…"
            aria-label="Filter cases by text"
            className="text-[12px] px-2 py-1 rounded-md border border-ink-200 outline-none focus:border-ink-300 w-52 placeholder:text-ink-400"
          />
          <input
            value={query.tag ?? ""}
            onChange={(e) => patchQuery({ tag: e.target.value || undefined })}
            placeholder="Tag"
            aria-label="Filter by tag"
            className="text-[12px] px-2 py-1 rounded-md border border-ink-200 outline-none focus:border-ink-300 w-28 placeholder:text-ink-400"
          />
          <label className="flex items-center gap-1.5 text-ink-500">
            <span>Sort</span>
            <select
              value={query.sort ?? "updated"}
              onChange={(e) => patchQuery({ sort: e.target.value as BoardSort })}
              className="text-[12px] px-1.5 py-1 rounded-md border border-ink-200 outline-none bg-white"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => patchQuery({ dir: (query.dir ?? "desc") === "desc" ? "asc" : "desc" })}
            className="text-[12px] px-2 py-1 rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50"
            title="Toggle sort direction"
          >
            {(query.dir ?? "desc") === "desc" ? "↓ Desc" : "↑ Asc"}
          </button>
          <label className="flex items-center gap-1.5 text-ink-500">
            <span>Group</span>
            <select
              value={query.group ?? "none"}
              onChange={(e) => patchQuery({ group: e.target.value as BoardGroup })}
              className="text-[12px] px-1.5 py-1 rounded-md border border-ink-200 outline-none bg-white"
            >
              {GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          {/* Deleted cases live in the dedicated /trash surface (sidebar → Trash),
              not behind a board toggle — the board only ever shows live cases. */}
          {(activeFilterCount > 0 || query.sort || query.group || query.dir) && (
            <button
              onClick={() => setQuery(query.domain ? { domain: query.domain } : {})}
              className="text-[12px] px-2 py-1 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-50"
            >
              Clear
            </button>
          )}

          {/* Label filter — a category-scoped, searchable dropdown (an OR facet);
              the active selection shows as removable chips beside the button. */}
          {labelCatalog.length > 0 && (
            <div className="w-full flex items-center gap-1 flex-wrap pt-1">
              <LabelFilter
                catalog={labelCatalog}
                selected={query.labels ?? []}
                onToggle={toggleLabelFilter}
                onSelectMany={selectLabels}
                onClear={() => patchQuery({ labels: [] })}
              />
            </div>
          )}
        </div>
      )}

      {/* Board body */}
      <div className="board-scroll flex-1 overflow-x-auto overflow-y-auto">
        {view === "strategy" ? (
          <StrategyView
            onOpenCase={(id) => setSelectedId(id)}
            domain={query.domain}
            labelCatalog={labelCatalog}
            collapsed={collapsedNodeIds}
            onToggleCollapsed={toggleNodeCollapsed}
          />
        ) : (query.group ?? "none") === "none" ? (
          <div className="h-full flex gap-3 p-3 min-h-0">
            {LANES.map((lane) => renderColumn(lane, filtered.filter((c) => c.status === lane.key)))}
          </div>
        ) : (
          <div className="p-3 space-y-4">
            {grouped.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className="text-[12.5px] font-medium text-ink-900">
                    {query.group === "label" ? labelMap[g.key]?.title ?? g.label : g.label}
                  </span>
                  <span className="text-[11.5px] text-ink-400 tabular-nums">{g.cases.length}</span>
                </div>
                <div className="flex gap-3">
                  {LANES.map((lane) =>
                    renderColumn(lane, g.cases.filter((c) => c.status === lane.key)),
                  )}
                </div>
              </div>
            ))}
            {grouped.length === 0 && (
              <div className="text-[12.5px] text-ink-400 px-3 py-10 text-center">No cases match.</div>
            )}
          </div>
        )}
      </div>

      <CaseDetailDrawer
        caseRec={selected}
        messages={drawerMessages}
        allCases={cases}
        labelCatalog={labelCatalog}
        onClose={() => setSelectedId(null)}
        onChanged={refetch}
      />

      <LabelManager
        open={showLabelManager}
        onClose={() => setShowLabelManager(false)}
        labels={labelCatalog}
        onChanged={refetch}
      />

      {/* Bulk-action bar — the update_cases UI twin (multi-select via 'x') */}
      {picked.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-2 px-3 py-2 rounded-lg shadow-card text-[12.5px] bg-ink-900 text-white"
        >
          <span className="font-medium tabular-nums pl-1 pr-1">{picked.size} selected</span>
          <span className="w-px h-5 bg-white/15" aria-hidden />

          {/* Move to lane */}
          <div className="relative">
            <button
              onClick={() => setBulkLaneOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={bulkLaneOpen}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-white/10 transition"
            >
              Move to
              <IconChevronDown className="w-3 h-3 opacity-70" />
            </button>
            {bulkLaneOpen && (
              <div
                role="menu"
                className="absolute bottom-9 left-0 min-w-[170px] bg-white rounded-md border border-ink-200 shadow-card py-1 text-ink-700"
              >
                {LANES.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBulkLaneOpen(false);
                      bulkMove(l.key);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-ink-50 flex items-center gap-2"
                  >
                    <span className={`w-2 h-2 rounded-full ${l.dotClass}`} aria-hidden />
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Set domain */}
          <button
            onClick={() => bulkDomain("work")}
            className="px-2 py-1 rounded hover:bg-white/10 transition"
            title="Set selected to Work"
          >
            → Work
          </button>
          <button
            onClick={() => bulkDomain("life")}
            className="px-2 py-1 rounded hover:bg-white/10 transition"
            title="Set selected to Life"
          >
            → Life
          </button>

          <button
            onClick={bulkArchive}
            className="px-2 py-1 rounded text-rose-200 hover:bg-white/10 transition"
          >
            Delete
          </button>
          <span className="w-px h-5 bg-white/15" aria-hidden />
          <button
            onClick={() => {
              setBulkLaneOpen(false);
              clearSelection();
            }}
            className="px-2 py-1 rounded text-ink-300 hover:text-white hover:bg-white/10 transition"
          >
            Clear · Esc
          </button>
        </div>
      )}

      {/* Toast / undo host */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 px-3.5 py-2 rounded-lg shadow-card text-[12.5px] bg-ink-900 text-white ${
            picked.size > 0 ? "bottom-20" : "bottom-4"
          }`}
        >
          <span className={toast.tone === "error" ? "text-rose-300" : ""}>{toast.message}</span>
          {toast.undo && (
            <button
              onClick={toast.undo}
              className="text-[12px] font-medium text-white underline underline-offset-2 hover:text-ink-200"
            >
              Undo
            </button>
          )}
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="text-ink-400 hover:text-white"
          >
            ×
          </button>
        </div>
      )}
    </>
  );

  // Column renderer shared by flat + grouped layouts.
  function renderColumn(
    lane: { key: CaseStatus; label: string; dotClass: string },
    items: CaseRecord[],
  ) {
    return (
      <Column
        key={lane.key}
        label={lane.label}
        count={items.length}
        dotClass={lane.dotClass}
        wipLimit={settings?.wipLimits?.[lane.key]}
        collapsed={collapsed.has(lane.key)}
        onToggleCollapse={() => toggleLaneCollapsed(lane.key)}
        isDropTarget={dragOverLane === lane.key && dragId !== null}
        onDragOver={onLaneDragOver(lane.key)}
        onDragLeave={() => setDragOverLane((cur) => (cur === lane.key ? null : cur))}
        onDrop={onLaneDrop(lane.key)}
        onClean={lane.key === "done" ? () => cleanColumn(items) : undefined}
      >
        <div role="list" className="space-y-2">
          {items.map((c) => (
            // `group/card` wraps the card so the unobtrusive corner star can fade
            // in on card hover (and stay visible when the card is starred). The
            // star floats over the top-right corner via an absolute overlay so the
            // CaseCard markup stays untouched; stopPropagation keeps a star click
            // from opening the drawer or starting a drag.
            <div key={c.id} className="group/card relative">
              <button
                type="button"
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStar(c.id);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                aria-pressed={!!c.starred}
                aria-label={c.starred ? `Unstar ${c.id}` : `Star ${c.id}`}
                title={c.starred ? "Starred — click to unstar" : "Star — pin to Priorities"}
                className={`absolute top-1.5 left-1.5 z-10 grid place-items-center w-5 h-5 rounded transition ${
                  c.starred
                    ? "text-amber-500 hover:bg-amber-50"
                    : "text-ink-300 opacity-0 group-hover/card:opacity-100 focus:opacity-100 hover:text-amber-500 hover:bg-ink-100"
                }`}
              >
                <IconStar className="w-3.5 h-3.5" fill={c.starred ? "currentColor" : "none"} />
              </button>
              <CaseCard
                caseRec={c}
                clock={clock}
                selected={picked.has(c.id)}
                focused={focusedId === c.id}
                dropBefore={dragOverCardId === c.id && dragId !== null && dragId !== c.id}
                labelCatalog={labelMap}
                lineage={lineageFor(c.id)}
                onClick={() => setSelectedId(c.id)}
                onArchive={() => archiveOne(c.id)}
                onLabelClick={toggleLabelFilter}
                onLineageClick={setFocusInitiative}
                onKeyDown={onCardKeyDown(c.id)}
                onFocus={() => setFocusedId(c.id)}
                onDragStart={onCardDragStart(c.id)}
                onDragEnd={onCardDragEnd}
                onDragOver={onCardDragOver(c.id)}
                onDrop={onCardDrop(c.id, lane.key)}
              />
            </div>
          ))}
        </div>
      </Column>
    );
  }
}
