// Pure read-projection engine over CaseRecord[]. No fetch, no React, no I/O —
// every function is deterministic given its inputs (an optional `now` makes the
// time-relative ones testable). The board, Today, and Entity-360 pages all read
// the board through these so filtering/sorting/grouping stays consistent and
// deep-linkable. URL state round-trips through parseBoardQuery/encodeBoardQuery.

import type { CaseRecord, CaseStatus, CaseDomain, CaseKind, CalendarEvent, Reminder, ReminderStatus, PriorityNote, MessageRecord, CaseActivity, Actor, DBShape } from "./types";
import { VALID_CASE_STATUS, VALID_DOMAIN, VALID_PRIORITY, VALID_CASE_KIND, VALID_REMINDER_STATUS, caseKind } from "./types";

export type BoardSort =
  | "updated"
  | "created"
  | "due"
  | "title"
  | "doneRatio"
  | "priority"
  | "position";
export type BoardDir = "asc" | "desc";
export type BoardGroup =
  | "none"
  | "domain"
  | "tag"
  | "label"
  | "priority"
  | "initiative"
  | "workstream";

export interface BoardQuery {
  status?: CaseStatus[];
  domain?: CaseDomain;
  tag?: string;
  labels?: string[]; // catalog label ids — a case matches if it carries ANY of them (OR)
  kind?: CaseKind; // hierarchy tier filter (initiative|workstream|case)
  parentId?: string; // direct-parent filter (children of a given container)
  q?: string;
  sort?: BoardSort;
  dir?: BoardDir;
  group?: BoardGroup;
  includeArchived?: boolean;
}

const VALID_SORT: BoardSort[] = ["updated", "created", "due", "title", "doneRatio", "priority", "position"];
const VALID_GROUP: BoardGroup[] = [
  "none", "domain", "tag", "label", "priority", "initiative", "workstream",
];

// ── URL round-trip ───────────────────────────────────────────────────────────
// Read a BoardQuery out of URLSearchParams. Unknown / malformed values are
// silently dropped so a hand-edited URL degrades to a sane default rather than
// throwing. `status` is a comma list; booleans are "1"/"true".
export function parseBoardQuery(sp: URLSearchParams): BoardQuery {
  const q: BoardQuery = {};

  const statusRaw = sp.get("status");
  if (statusRaw) {
    const statuses = statusRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is CaseStatus => VALID_CASE_STATUS.includes(s as CaseStatus));
    if (statuses.length) q.status = statuses;
  }

  const domain = sp.get("domain");
  if (domain && VALID_DOMAIN.includes(domain as CaseDomain)) q.domain = domain as CaseDomain;

  const tag = sp.get("tag");
  if (tag) q.tag = tag;

  const labelsRaw = sp.get("labels");
  if (labelsRaw) {
    const labels = labelsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.length) q.labels = Array.from(new Set(labels));
  }

  const kind = sp.get("kind");
  if (kind && VALID_CASE_KIND.includes(kind as CaseKind)) q.kind = kind as CaseKind;

  const parentId = sp.get("parentId");
  if (parentId) q.parentId = parentId;

  const text = sp.get("q");
  if (text) q.q = text;

  const sort = sp.get("sort");
  if (sort && VALID_SORT.includes(sort as BoardSort)) q.sort = sort as BoardSort;

  const dir = sp.get("dir");
  if (dir === "asc" || dir === "desc") q.dir = dir;

  const group = sp.get("group");
  if (group && VALID_GROUP.includes(group as BoardGroup)) q.group = group as BoardGroup;

  const incArch = sp.get("includeArchived");
  if (incArch === "1" || incArch === "true") q.includeArchived = true;

  return q;
}

// Encode a BoardQuery to a query string (no leading "?"). Only set fields are
// emitted, so encode(parse(x)) is stable and produces clean shareable URLs.
export function encodeBoardQuery(q: BoardQuery): string {
  const sp = new URLSearchParams();
  if (q.status?.length) sp.set("status", q.status.join(","));
  if (q.domain) sp.set("domain", q.domain);
  if (q.tag) sp.set("tag", q.tag);
  if (q.labels?.length) sp.set("labels", q.labels.join(","));
  if (q.kind) sp.set("kind", q.kind);
  if (q.parentId) sp.set("parentId", q.parentId);
  if (q.q) sp.set("q", q.q);
  if (q.sort) sp.set("sort", q.sort);
  if (q.dir) sp.set("dir", q.dir);
  if (q.group && q.group !== "none") sp.set("group", q.group);
  if (q.includeArchived) sp.set("includeArchived", "1");
  return sp.toString();
}

// ── Visibility ───────────────────────────────────────────────────────────────
const ms = (iso?: string): number => (iso ? new Date(iso).getTime() : NaN);

// Archived cases and cases snoozed into the future are hidden from the default
// board. `includeArchived` (used by the archive view + saved queries) keeps both.
function isVisible(c: CaseRecord, now: Date, includeArchived: boolean): boolean {
  if (includeArchived) return true;
  if (c.archivedAt) return false;
  if (c.snoozeUntil && ms(c.snoozeUntil) > now.getTime()) return false;
  return true;
}

// Free-text match across the searchable scalar fields + tags + task titles.
function matchesText(c: CaseRecord, needle: string): boolean {
  const n = needle.toLowerCase();
  const hay = [
    c.title,
    c.summary,
    ...(c.tags ?? []),
    ...c.tasks.map((t) => t.title),
  ];
  return hay.some((h) => typeof h === "string" && h.toLowerCase().includes(n));
}

function doneRatio(c: CaseRecord): number {
  if (!c.tasks.length) return 0;
  return c.tasks.filter((t) => t.status === "done").length / c.tasks.length;
}

// P0 sorts "highest"; cases with no priority sort lowest. Returns a rank where
// a larger number = more important, so the comparator can treat it like a date.
function priorityRank(c: CaseRecord): number {
  if (!c.priority) return -1;
  return VALID_PRIORITY.length - 1 - VALID_PRIORITY.indexOf(c.priority);
}

// ── Filter + sort ────────────────────────────────────────────────────────────
// Apply a BoardQuery: AND all the predicates that are set, then sort. Archived /
// future-snoozed cases are excluded unless q.includeArchived. Default sort is
// updated-desc (most recently touched first). Returns a new array.
export function applyBoardQuery(cases: CaseRecord[], q: BoardQuery, now: Date = new Date()): CaseRecord[] {
  const includeArchived = q.includeArchived ?? false;

  const out = cases.filter((c) => {
    if (!isVisible(c, now, includeArchived)) return false;
    if (q.status?.length && !q.status.includes(c.status)) return false;
    if (q.domain && c.domain !== q.domain) return false;
    if (q.tag && !(c.tags ?? []).some((t) => t.toLowerCase() === q.tag!.toLowerCase())) return false;
    // Labels are an OR facet: a case passes if it carries ANY of the selected ids.
    if (q.labels?.length && !(c.labels ?? []).some((l) => q.labels!.includes(l))) return false;
    if (q.kind && caseKind(c) !== q.kind) return false;
    if (q.parentId && c.parentId !== q.parentId) return false;
    if (q.q && !matchesText(c, q.q)) return false;
    return true;
  });

  const sort = q.sort ?? "updated";
  // Most signals read best newest/biggest-first, so default to descending;
  // text and manual `position` read best small-first, so default to ascending.
  const dir =
    q.dir ?? (sort === "title" || sort === "position" ? "asc" : "desc");
  const factor = dir === "asc" ? 1 : -1;

  out.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "created":
        cmp = ms(a.createdAt) - ms(b.createdAt);
        break;
      case "due": {
        // Cases with a due date sort before those without (when ascending).
        const da = ms(a.dueAt);
        const db = ms(b.dueAt);
        const va = Number.isNaN(da) ? Infinity : da;
        const vb = Number.isNaN(db) ? Infinity : db;
        cmp = va - vb;
        break;
      }
      case "doneRatio":
        cmp = doneRatio(a) - doneRatio(b);
        break;
      case "priority":
        cmp = priorityRank(a) - priorityRank(b);
        break;
      case "position": {
        // Manual order within a lane. Cases without a position sort last (when
        // ascending); ties fall through to the updatedAt tiebreak below.
        const pa = a.position ?? Infinity;
        const pb = b.position ?? Infinity;
        cmp = pa - pb;
        break;
      }
      case "updated":
      default:
        cmp = ms(a.updatedAt) - ms(b.updatedAt);
        break;
    }
    if (cmp === 0) cmp = ms(a.updatedAt) - ms(b.updatedAt); // stable-ish tiebreak
    return cmp * factor;
  });

  return out;
}

// ── Grouping ─────────────────────────────────────────────────────────────────
// Partition cases into labelled groups for a grouped board view. `none` returns
// a single "All" group. Missing values bucket under an explicit "—" group that
// always sorts last. Order within each group is preserved from the input.
//
// The hierarchy groupers ("initiative"/"workstream") resolve a leaf's container
// via the full case set — pass `allCases` (the unfiltered board) so the ancestor
// walk can see containers that the current filter excluded; it defaults to the
// visible `cases` for back-compat with existing callers.
export function groupCases(
  cases: CaseRecord[],
  group: BoardGroup,
  allCases: CaseRecord[] = cases,
): { key: string; label: string; cases: CaseRecord[] }[] {
  if (group === "none") {
    return [{ key: "all", label: "All", cases }];
  }

  const NONE = " none"; // sorts last via the comparator below
  const buckets = new Map<string, { label: string; cases: CaseRecord[] }>();

  const push = (key: string, label: string, c: CaseRecord): void => {
    let b = buckets.get(key);
    if (!b) {
      b = { label, cases: [] };
      buckets.set(key, b);
    }
    b.cases.push(c);
  };

  for (const c of cases) {
    switch (group) {
      case "domain":
        push(c.domain, c.domain === "life" ? "Life" : "Work", c);
        break;
      case "priority":
        c.priority ? push(c.priority, c.priority, c) : push(NONE, "No priority", c);
        break;
      case "tag":
        if (c.tags?.length) {
          for (const t of c.tags) push(t, t, c);
        } else {
          push(NONE, "No tag", c);
        }
        break;
      case "label":
        // Group by catalog label id. The id doubles as the display label here
        // (the board resolves it to the label's title when rendering the header).
        if (c.labels?.length) {
          for (const l of c.labels) push(l, l, c);
        } else {
          push(NONE, "No label", c);
        }
        break;
      case "initiative": {
        // Swimlane each card by its ROOT initiative (nearest ancestor that is an
        // initiative, walking parentId via the full case set). The id is the
        // bucket key; the board resolves it to the initiative's title.
        const root = rootInitiativeOf(allCases, c.id);
        root ? push(root.id, root.title, c) : push(NONE, "No initiative", c);
        break;
      }
      case "workstream": {
        // Swimlane by the card's direct workstream parent (only when the parent is
        // actually a workstream); otherwise it has no owning workstream.
        const parent = c.parentId ? allCases.find((p) => p.id === c.parentId) : undefined;
        parent && caseKind(parent) === "workstream"
          ? push(parent.id, parent.title, c)
          : push(NONE, "No workstream", c);
        break;
      }
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => {
      if (a[0] === NONE) return 1;
      if (b[0] === NONE) return -1;
      if (group === "priority") return a[0].localeCompare(b[0]); // P0..P3
      return a[1].label.localeCompare(b[1].label);
    })
    .map(([key, b]) => ({ key: key === NONE ? "none" : key, label: b.label, cases: b.cases }));
}

// ── Attention surfaces ───────────────────────────────────────────────────────
// "Today" focus list: things to actually do now. Urgent-lane cases, cases with
// an own open/in-progress task, and overdue cases — but NOT waiting_for_input
// (the ball's in someone else's court) and never archived/done. De-duplicated,
// ordered urgent-first then by due date.
// CANDIDATE FOR REMOVAL: no app importer since /today → /activity; only
// tests/unit/selectors.test.ts still exercises it. Drop both together when ready.
export function todayCases(cases: CaseRecord[], now: Date = new Date()): CaseRecord[] {
  const t = now.getTime();
  const picked = cases.filter((c) => {
    if (c.archivedAt) return false;
    if (c.status === "done" || c.status === "waiting_for_input") return false;
    if (c.status === "urgent") return true;
    const overdue = !Number.isNaN(ms(c.dueAt)) && ms(c.dueAt) < t;
    if (overdue) return true;
    const hasOpenTask = c.tasks.some((task) => task.status === "open" || task.status === "in_progress");
    return hasOpenTask;
  });

  return picked.sort((a, b) => {
    const au = a.status === "urgent" ? 0 : 1;
    const bu = b.status === "urgent" ? 0 : 1;
    if (au !== bu) return au - bu;
    const da = Number.isNaN(ms(a.dueAt)) ? Infinity : ms(a.dueAt);
    const db = Number.isNaN(ms(b.dueAt)) ? Infinity : ms(b.dueAt);
    if (da !== db) return da - db;
    return ms(b.updatedAt) - ms(a.updatedAt);
  });
}

// Bucketed "needs attention" report used by Today / the inbox. All four arrays
// exclude archived cases.
//  - overdue:      dueAt in the past, not done
//  - agingWaiting: waiting_for_input idle (no update) > 3 days
//  - untriaged:    in the todo lane with no tasks and no priority (raw intake)
//  - unlinked:     no vaultLinks (no knowledge attached yet), not done
export function needsAttention(
  cases: CaseRecord[],
  now: Date = new Date(),
): { overdue: CaseRecord[]; agingWaiting: CaseRecord[]; untriaged: CaseRecord[]; unlinked: CaseRecord[] } {
  const t = now.getTime();
  const live = cases.filter((c) => !c.archivedAt);
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

  return {
    overdue: live.filter((c) => c.status !== "done" && !Number.isNaN(ms(c.dueAt)) && ms(c.dueAt) < t),
    agingWaiting: live.filter(
      (c) => c.status === "waiting_for_input" && t - ms(c.updatedAt) > THREE_DAYS,
    ),
    untriaged: live.filter((c) => c.status === "todo" && c.tasks.length === 0 && !c.priority),
    unlinked: live.filter((c) => c.status !== "done" && !(c.vaultLinks?.length)),
  };
}

// A case is "stale" if it hasn't been touched in `days` days and isn't already
// finished/archived — a nudge that something's been sitting.
export function isStale(c: CaseRecord, now: Date = new Date(), days = 5): boolean {
  if (c.archivedAt || c.status === "done") return false;
  const cutoff = days * 24 * 60 * 60 * 1000;
  return now.getTime() - ms(c.updatedAt) > cutoff;
}

// ── Due / SLA classification ─────────────────────────────────────────────────
export type DueStatus = "none" | "overdue" | "today" | "soon" | "later";

// Classify a due date relative to `now`. "today" = same calendar day; "soon" =
// within the next 3 days; "later" beyond that; "overdue" already past.
export function dueStatus(dueAt?: string, now: Date = new Date()): DueStatus {
  if (!dueAt) return "none";
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "none";
  // The day comparison and the past-cutoff must share one reference frame, or a
  // date-only due (UTC midnight, as stored on disk) reads as "overdue" instead
  // of "today" for users west of UTC. Anchor both to the UTC calendar day.
  if (sameDay(due, now)) return "today"; // earlier-today still counts as today, not overdue
  if (due.getTime() < startOfUTCDay(now)) return "overdue";
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  if (due.getTime() - now.getTime() <= THREE_DAYS) return "soon";
  return "later";
}

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// SLA signal for a waiting_for_input case: how many days it's been idle, and
// whether that breaches the 5-day threshold. null for any other status.
export function slaStatus(c: CaseRecord, now: Date = new Date()): { days: number; breached: boolean } | null {
  if (c.status !== "waiting_for_input") return null;
  const days = Math.floor((now.getTime() - ms(c.updatedAt)) / (24 * 60 * 60 * 1000));
  return { days, breached: days > 5 };
}

// ── Hierarchy (Initiative > Workstream > Case) ─────────────────────────────────
// All three tiers are CaseRecords in one flat array; a node's tier is caseKind(c)
// and its place in the tree is parentId. These PURE helpers project that flat set
// into parent/child/rollup/forest views — the board, the GET /api/tree route, the
// strategy roadmap, and the drawer all read the hierarchy through them, so the
// shape stays consistent. hierarchyViolation() is the SINGLE SOURCE OF TRUTH for
// the invariants: the store throws on it (assertHierarchy) and the lint mirrors it.

// A node is a LEAF when its kind is "case" (absent kind === "case"); any other
// kind (initiative/workstream) is a CONTAINER that can hold children.
export const isLeaf = (c: { kind?: CaseKind }): boolean => caseKind(c) === "case";
export const isContainer = (c: { kind?: CaseKind }): boolean => caseKind(c) !== "case";

// Rolled-up progress of a container over its NON-ARCHIVED descendant leaf cases.
export interface Rollup {
  totalCases: number; // descendant leaf cases (non-archived)
  doneCases: number; // ...of which status === "done"
  totalTasks: number; // tasks summed across those leaves
  doneTasks: number; // ...done
  ratio: number; // doneCases / totalCases (0 when there are none)
  childCount: number; // DIRECT children (any kind)
  messageCount: number; // ROLLED-UP distinct messages linked to this node OR any non-archived descendant (self + subtree, like the case counts)
}

// One node of the strategy forest: a case + its child subtrees + its rollup.
export interface TreeNode {
  case: CaseRecord;
  children: TreeNode[];
  rollup: Rollup;
}

// Direct children of `id` (nodes whose parentId points at it).
export function childrenOfCases(cases: CaseRecord[], id: string): CaseRecord[] {
  return cases.filter((c) => c.parentId === id);
}

// All leaf cases at or below `id` (any depth). Excludes archived unless asked.
// Cycle-guarded (a visited set) so malformed data can't loop forever.
export function descendantLeaves(
  cases: CaseRecord[],
  id: string,
  opts: { includeArchived?: boolean } = {},
): CaseRecord[] {
  const includeArchived = opts.includeArchived ?? false;
  const byParent = new Map<string, CaseRecord[]>();
  for (const c of cases) {
    if (!c.parentId) continue;
    const arr = byParent.get(c.parentId);
    if (arr) arr.push(c);
    else byParent.set(c.parentId, [c]);
  }
  const out: CaseRecord[] = [];
  const seen = new Set<string>();
  const walk = (nodeId: string): void => {
    if (seen.has(nodeId)) return; // cycle guard
    seen.add(nodeId);
    for (const child of byParent.get(nodeId) ?? []) {
      if (!includeArchived && child.archivedAt) continue;
      if (isLeaf(child)) out.push(child);
      else walk(child.id);
    }
  };
  walk(id);
  return out;
}

// Every message id linked to `id` ITSELF or any of its descendants (containers
// AND leaves), self first then descendants, DE-DUPLICATED preserving first-seen
// order. A leaf returns just its own messageIds. Archived descendant SUBTREES are
// skipped (unless includeArchived); the node itself is always included regardless
// of its own archived state — you asked for *this* node's mail. Cycle-guarded.
//
// A container carries no mail of its own normally, so this is how an Initiative /
// Workstream surfaces all the email/threads linked anywhere beneath it ("show me
// the latest related mail"). Pure + order-stable but NOT time-sorted: the CALLER
// resolves these ids → MessageRecords and sorts by receivedAt (newest first).
export function rolledUpMessageIds(
  cases: CaseRecord[],
  id: string,
  opts: { includeArchived?: boolean } = {},
): string[] {
  const includeArchived = opts.includeArchived ?? false;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const byParent = new Map<string, CaseRecord[]>();
  for (const c of cases) {
    if (!c.parentId) continue;
    const arr = byParent.get(c.parentId);
    if (arr) arr.push(c);
    else byParent.set(c.parentId, [c]);
  }
  const out: string[] = [];
  const ids = new Set<string>(); // de-dup: first-seen wins, order preserved
  const push = (mid: string): void => {
    if (ids.has(mid)) return;
    ids.add(mid);
    out.push(mid);
  };
  const seen = new Set<string>(); // cycle guard, like descendantLeaves/lineageOfCases
  // The node's OWN ids come first (self before descendants); the node itself is
  // always emitted even if archived. Descendants honour the archived filter.
  const walk = (nodeId: string, isRoot: boolean): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return;
    if (!isRoot && !includeArchived && node.archivedAt) return; // skip archived subtree
    for (const mid of node.messageIds) push(mid);
    for (const child of byParent.get(nodeId) ?? []) walk(child.id, false);
  };
  walk(id, true);
  return out;
}

// Rollup over a container's descendant leaves (a leaf has no descendants → 0/0).
// ratio = doneCases/totalCases; childCount counts DIRECT children of any kind.
export function rollupFor(cases: CaseRecord[], id: string): Rollup {
  const leaves = descendantLeaves(cases, id);
  const totalCases = leaves.length;
  const doneCases = leaves.filter((c) => c.status === "done").length;
  let totalTasks = 0;
  let doneTasks = 0;
  for (const lf of leaves) {
    totalTasks += lf.tasks.length;
    doneTasks += lf.tasks.filter((t) => t.status === "done").length;
  }
  return {
    totalCases,
    doneCases,
    totalTasks,
    doneTasks,
    ratio: totalCases ? doneCases / totalCases : 0,
    childCount: childrenOfCases(cases, id).length,
    // ROLLED-UP like the case counts: distinct messages on this node OR any
    // non-archived descendant (see rolledUpMessageIds for the dedupe/skip rules).
    messageCount: rolledUpMessageIds(cases, id).length,
  };
}

// The ancestor chain [root, …, node] inclusive (by parentId), root first.
// Cycle-guarded so malformed data can't loop forever.
export function lineageOfCases(cases: CaseRecord[], id: string): CaseRecord[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const chain: CaseRecord[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse(); // root first
}

// Nearest ancestor (or self) whose kind is "initiative"; undefined if none. For
// valid data an initiative is always the root, but we scan nearest-first to be
// robust to malformed chains.
export function rootInitiativeOf(cases: CaseRecord[], id: string): CaseRecord | undefined {
  const chain = lineageOfCases(cases, id); // root-first
  for (let i = chain.length - 1; i >= 0; i--) {
    if (caseKind(chain[i]) === "initiative") return chain[i];
  }
  return undefined;
}

// Project the flat case set into the strategy forest. Roots = nodes with no
// (resolvable) parentId — initiatives plus orphan standalone leaves. Children are
// nested by parentId, each sorted by manual position then updatedAt, and carry
// their rollup. Archived nodes are pruned unless includeArchived. Cycle-guarded.
//
// hideDoneLeaves PRESENTATION-ONLY-prunes finished leaf cases (status "done")
// from the roadmap shape — both nested children and top-level roots — so the view
// can declutter. Containers are NEVER pruned (even an unlikely "done" container),
// preserving the Initiative/Workstream scaffold. CRITICAL: rollups are unaffected
// — rollupFor reads the FULL `cases` array, not the pruned set, so a container
// still reports e.g. 2/3 done even when its 2 done leaves aren't listed.
export function buildForest(
  cases: CaseRecord[],
  opts: { includeArchived?: boolean; hideDoneLeaves?: boolean } = {},
): TreeNode[] {
  const includeArchived = opts.includeArchived ?? false;
  const hideDoneLeaves = opts.hideDoneLeaves ?? false;
  // Presentation prune: drop done LEAVES only (containers always survive). Applied
  // to the node set BEFORE bucketing so it hits both children and roots uniformly.
  const prune = (c: CaseRecord): boolean => !(hideDoneLeaves && isLeaf(c) && c.status === "done");
  const visible = (includeArchived ? cases : cases.filter((c) => !c.archivedAt)).filter(prune);
  const ids = new Set(visible.map((c) => c.id));
  const byParent = new Map<string, CaseRecord[]>();
  for (const c of visible) {
    // A dangling/absent parent files the node under the root bucket ("").
    const pid = c.parentId && ids.has(c.parentId) ? c.parentId : "";
    const arr = byParent.get(pid);
    if (arr) arr.push(c);
    else byParent.set(pid, [c]);
  }
  const cmp = (a: CaseRecord, b: CaseRecord): number => {
    const pa = a.position ?? Infinity;
    const pb = b.position ?? Infinity;
    if (pa !== pb) return pa - pb;
    return ms(a.updatedAt) - ms(b.updatedAt);
  };
  const seen = new Set<string>();
  const build = (c: CaseRecord): TreeNode => {
    seen.add(c.id);
    const children = (byParent.get(c.id) ?? [])
      .filter((k) => !seen.has(k.id)) // cycle guard
      .sort(cmp)
      .map(build);
    // rollupFor(cases, …) — the FULL array — so pruned done leaves still COUNT.
    return { case: c, children, rollup: rollupFor(cases, c.id) };
  };
  return (byParent.get("") ?? []).sort(cmp).map(build);
}

// ── Drag-reorder (manual position) ─────────────────────────────────────────────
// Compute the position writes for dragging `movedId` WITHIN one container's child
// list. `siblings` = that container's current children (ANY order — we sort inside
// by (position ?? Infinity) then updatedAt, the SAME cmp buildForest uses, so we
// reorder the list the view actually renders). `beforeId` = the sibling to drop
// immediately BEFORE, or null to append to the end.
//
// Mirrors board-view's reorderWithin, extracted PURE so the strategy view and its
// tests share one source of truth. Returns the {id, position} writes the caller
// persists (board-client.updateCase / updateCases) — [] when there's nothing to do.
export function reorderPositions(
  siblings: CaseRecord[],
  movedId: string,
  beforeId: string | null,
): { id: string; position: number }[] {
  const STEP = 1000;
  if (!siblings.some((c) => c.id === movedId)) return []; // not ours to move

  // Sort into the rendered order (buildForest's cmp), then compute the desired
  // order: pull the moved card out and re-insert it before beforeId (or at end).
  const ordered = [...siblings].sort((a, b) => {
    const pa = a.position ?? Infinity;
    const pb = b.position ?? Infinity;
    if (pa !== pb) return pa - pb;
    return ms(a.updatedAt) - ms(b.updatedAt);
  });
  const moved = ordered.find((c) => c.id === movedId)!;
  const without = ordered.filter((c) => c.id !== movedId);
  const insertAt = beforeId === null ? without.length : without.findIndex((c) => c.id === beforeId);
  if (insertAt < 0) return []; // beforeId isn't a sibling — nothing sensible to do
  const desired = [...without];
  desired.splice(insertAt, 0, moved);

  // No-op: the desired order already matches the current order.
  if (desired.every((c, i) => c.id === ordered[i].id)) return [];

  // FAST PATH: every sibling already carries a FINITE numeric position, so we can
  // drop a single interpolated value on the moved card without disturbing the rest.
  // NaN/±Infinity satisfy `typeof === "number"` but would poison the bisect (e.g.
  // (prev+next)/2 → NaN, which the store/JSON round-trips to a position clear), so
  // a stray non-finite position falls through to the seeding rebase below instead.
  if (siblings.every((c) => typeof c.position === "number" && Number.isFinite(c.position))) {
    const idx = desired.findIndex((c) => c.id === movedId);
    const prev = desired[idx - 1]?.position;
    const next = desired[idx + 1]?.position;
    const position =
      prev === undefined ? next! - STEP // front: just under the (new) top
        : next === undefined ? prev + STEP // end: just past the (new) bottom
          : (prev + next) / 2; // middle: bisect the neighbours
    return [{ id: movedId, position }];
  }

  // SEEDING PATH: at least one sibling has no position yet, so a lone value on the
  // moved card would be meaningless against position-less siblings (they sort as
  // Infinity). REBASE the whole list to index*STEP integers in the desired order
  // so later moves have real neighbours to interpolate between. Skip entries that
  // already sit at their target position (no redundant writes).
  return desired
    .map((c, i) => ({ id: c.id, position: i * STEP }))
    .filter((w) => siblings.find((c) => c.id === w.id)!.position !== w.position);
}

// THE invariant checker (single source of truth). Given a PROPOSED node state
// {id, kind, parentId} and the CURRENT case set, return a human-readable reason
// the state is illegal, or null when it's allowed. Considers the node's EXISTING
// children in `cases`, so turning a parent into a leaf (etc.) is caught. Pure —
// store.assertHierarchy throws BadRequestError(this), and the lint mirrors it.
export function hierarchyViolation(
  cases: CaseRecord[],
  change: { id: string; kind: CaseKind; parentId?: string },
): string | null {
  const { id, kind, parentId } = change;
  if (!VALID_CASE_KIND.includes(kind)) {
    return `Unknown kind "${kind}" (expected initiative, workstream, or case).`;
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const children = cases.filter((c) => c.parentId === id);

  // Tier rule for THIS node's parent edge.
  if (kind === "initiative") {
    if (parentId) return "An Initiative is a top-level node and cannot have a parent.";
  } else if (kind === "workstream") {
    if (!parentId) {
      return "A Workstream must sit under an Initiative — give it an initiative parent, or convert it to an Initiative.";
    }
  }

  if (parentId !== undefined) {
    if (parentId === id) return "A node cannot be its own parent.";
    const parent = byId.get(parentId);
    if (!parent) return `Parent "${parentId}" does not exist.`;
    const pk = caseKind(parent);
    if (pk === "case") {
      return `Parent "${parentId}" is a Case; only an Initiative or Workstream can contain other nodes.`;
    }
    if (kind === "workstream" && pk !== "initiative") {
      return `A Workstream must sit directly under an Initiative (parent "${parentId}" is a ${pk}).`;
    }
    // Cycle + depth: walk up from the parent. We must not reach `id`, and the
    // chain above must stay within the 3-tier limit (≤ 2 ancestors for a leaf).
    let cur: CaseRecord | undefined = parent;
    const seen = new Set<string>([id]);
    let depthAbove = 0;
    while (cur) {
      if (seen.has(cur.id)) return "That move would create a cycle in the hierarchy.";
      seen.add(cur.id);
      depthAbove += 1;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (depthAbove > 2) {
      return "The hierarchy is limited to three tiers (Initiative > Workstream > Case).";
    }
  }

  // Constraints from THIS node's OWN kind given its existing children.
  if (children.length) {
    if (kind === "case") {
      return "This node has child cases, so it can't become a leaf Case — keep it an Initiative or Workstream (or move its children out first).";
    }
    if (kind === "workstream") {
      const badChild = children.find((c) => caseKind(c) !== "case");
      if (badChild) {
        return `A Workstream can only contain Cases, but "${badChild.id}" is a ${caseKind(badChild)}.`;
      }
    }
  }

  return null;
}

// ── Calendar events ────────────────────────────────────────────────────────────
// PURE projections over a flat CalendarEvent[] — no fetch, no React, no I/O, just
// like the case selectors above. A timed event sorts by its "HH:MM" startTime;
// all-day events (and any event missing a startTime) sort FIRST within a day. Day
// math is UTC-anchored (consistent with startOfUTCDay/sameDay/dueStatus) so a
// date-only "YYYY-MM-DD" value never drifts across timezones. Because the date
// strings are zero-padded "YYYY-MM-DD", lexicographic string compare === calendar
// order, which the range/upcoming helpers lean on.

// The UTC "YYYY-MM-DD" for `now` — the shared anchor for the day-relative helpers
// below, matching how dueStatus pins comparisons to the UTC calendar day. Pure
// given `now`; pass a fixed Date to make callers deterministic.
export function todayISO(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // getUTCMonth is 0-based
  const d = now.getUTCDate();
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

// Compare two events within a day: all-day (or startTime-less) first, then by
// "HH:MM" startTime ascending (string compare === clock order for zero-padded
// 24h times), with an empty/missing startTime sorting before any timed one.
function eventTimeCmp(a: CalendarEvent, b: CalendarEvent): number {
  const ka = a.allDay ? "" : a.startTime ?? "";
  const kb = b.allDay ? "" : b.startTime ?? "";
  return ka.localeCompare(kb);
}

// Events linked to a specific case (e.caseId === caseId) — the caseId field is the
// single source of truth for the case↔event link. Input order is preserved.
export function eventsByCaseId(events: CalendarEvent[], caseId: string): CalendarEvent[] {
  return events.filter((e) => e.caseId === caseId);
}

// Events falling on one calendar day (e.date === dayISO), sorted all-day first
// then by startTime (empty/missing time sorts first). Stable (sort tie-break
// preserves input order). `dayISO` is a "YYYY-MM-DD" day string.
export function eventsForDay(events: CalendarEvent[], dayISO: string): CalendarEvent[] {
  return events.filter((e) => e.date === dayISO).sort(eventTimeCmp);
}

// Events whose day falls in the half-open window [startISO, endISO) — startISO
// inclusive, endISO exclusive — by lexicographic "YYYY-MM-DD" compare (which
// equals calendar order). Sorted by date then startTime (all-day/time-less first).
export function eventsByDateRange(
  events: CalendarEvent[],
  startISO: string,
  endISO: string,
): CalendarEvent[] {
  return events
    .filter((e) => e.date >= startISO && e.date < endISO)
    .sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : eventTimeCmp(a, b)));
}

// Events landing within the next `daysAhead` days INCLUSIVE of both ends —
// [today, today+daysAhead] — anchored to the UTC calendar day derived from `now`
// (consistent with dueStatus / todayISO). Sorted ascending by date then startTime.
// daysAhead 0 = just today; the past is excluded.
export function upcomingEvents(
  events: CalendarEvent[],
  daysAhead = 7,
  now: Date = new Date(),
): CalendarEvent[] {
  const start = todayISO(now);
  // The inclusive far edge: today's UTC midnight + daysAhead whole days, re-read as
  // a "YYYY-MM-DD" string via the same UTC anchor todayISO uses.
  const end = todayISO(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead)));
  return events
    .filter((e) => e.date >= start && e.date <= end)
    .sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : eventTimeCmp(a, b)));
}

// Build the month matrix for a calendar grid. PURE — takes the year/monthIndex
// explicitly (monthIndex 0-based, like Date's months) so there's no implicit now.
// Returns whole weeks (5 or 6 rows) of 7 cells each, padding leading/trailing days
// from the adjacent months so every cell has a real date. weekStartsOn 1 = Monday
// (0 = Sunday). Each cell: { date: "YYYY-MM-DD", inMonth, day }. UTC-anchored so
// the emitted day strings never drift across timezones.
export function monthGrid(
  year: number,
  monthIndex: number,
  weekStartsOn = 1,
): { date: string; inMonth: boolean; day: number }[][] {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  // Days to pad before the 1st so the grid starts on weekStartsOn. getUTCDay is
  // 0=Sun..6=Sat; ((dow - weekStartsOn) + 7) % 7 = how many cells precede the 1st.
  const lead = ((first.getUTCDay() - weekStartsOn) + 7) % 7;
  // Length of this month: day 0 of the next month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  // Whole weeks needed to cover lead-padding + every day of the month.
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;

  const cell = (offsetFromFirst: number): { date: string; inMonth: boolean; day: number } => {
    const d = new Date(Date.UTC(year, monthIndex, 1 + offsetFromFirst));
    return {
      date: todayISO(d),
      inMonth: d.getUTCMonth() === monthIndex && d.getUTCFullYear() === year,
      day: d.getUTCDate(),
    };
  };

  const weeks: { date: string; inMonth: boolean; day: number }[][] = [];
  for (let i = 0; i < totalCells; i += 7) {
    const week: { date: string; inMonth: boolean; day: number }[] = [];
    for (let j = 0; j < 7; j++) week.push(cell(i + j - lead));
    weeks.push(week);
  }
  return weeks;
}

// ── Reminders ────────────────────────────────────────────────────────────────
// PURE projections over a flat Reminder[] — no fetch, no React, no I/O, exactly
// like the Calendar-events selectors above. A reminder is a lightweight nudge that
// may OPTIONALLY link to ONE board node via `caseId` (the single source of truth for
// the node↔reminder link — derive a node's reminders by filtering on it). `dueAt`
// is the sortable "when to be reminded" signal; it may be a date-only "YYYY-MM-DD"
// or a full datetime. Day-relative math is UTC-anchored (reusing todayISO /
// startOfUTCDay, consistent with upcomingEvents / dueStatus) so a date-only dueAt
// never drifts across timezones. VALID_REMINDER_STATUS pins the open<done<dismissed
// rank used by sortReminders.

// Reminders linked to a specific node (r.caseId === caseId) — caseId is the single
// source of truth for the node↔reminder link, and one id space covers all three
// tiers. Input order is preserved (mirror eventsByCaseId).
export function remindersByCaseId(reminders: Reminder[], caseId: string): Reminder[] {
  return reminders.filter((r) => r.caseId === caseId);
}

// Emails linked to a specific reminder (m.reminderId === reminderId) — reminderId
// is the single source of truth for the reminder↔email link (no messageIds[] on the
// reminder; many emails about ONE matter point at one reminder). Input order is
// preserved (mirror remindersByCaseId; the [id] GET route resolves + sorts these).
export function messagesByReminderId(messages: MessageRecord[], reminderId: string): MessageRecord[] {
  return messages.filter((m) => m.reminderId === reminderId);
}

// The still-actionable reminders: status === "open" (excludes done/dismissed).
// Input order is preserved.
export function openReminders(reminders: Reminder[]): Reminder[] {
  return reminders.filter((r) => r.status === "open");
}

// A NEW sorted array, by: (1) status rank — open before done before dismissed,
// per VALID_REMINDER_STATUS; (2) due — a reminder WITH a parseable dueAt sorts
// before one without, earlier dueAt first (an absent/unparseable dueAt is treated
// as +Infinity so it sorts last); (3) createdAt ascending as a stable tiebreak.
// PURE given inputs. `now` is accepted only for signature parity with the other
// reminder helpers — the ordering is absolute and does NOT depend on it.
export function sortReminders(reminders: Reminder[], now: Date = new Date()): Reminder[] {
  void now; // intentionally unused: the sort is `now`-independent (see doc above)
  const statusRank = (s: ReminderStatus): number => {
    const i = VALID_REMINDER_STATUS.indexOf(s);
    return i < 0 ? VALID_REMINDER_STATUS.length : i; // unknown status sorts last
  };
  const due = (r: Reminder): number => {
    const t = ms(r.dueAt);
    return Number.isNaN(t) ? Infinity : t; // absent/unparseable dueAt sorts last
  };
  return [...reminders].sort((a, b) => {
    const sr = statusRank(a.status) - statusRank(b.status);
    if (sr !== 0) return sr;
    const dd = due(a) - due(b);
    if (dd !== 0) return dd;
    return ms(a.createdAt) - ms(b.createdAt); // stable tiebreak
  });
}

// OPEN reminders whose dueAt day falls in [today, today+daysAhead] INCLUSIVE,
// anchored to the UTC calendar day derived from `now` (consistent with
// upcomingEvents / dueStatus / todayISO). A reminder with no (or unparseable)
// dueAt is excluded; the past is excluded; daysAhead 0 = just today. Sorted
// ascending by dueAt. Returns a new array.
export function upcomingReminders(
  reminders: Reminder[],
  daysAhead = 7,
  now: Date = new Date(),
): Reminder[] {
  const start = todayISO(now);
  // The inclusive far edge: today's UTC midnight + daysAhead whole days, re-read as
  // a "YYYY-MM-DD" string via the same UTC anchor todayISO uses (mirrors upcomingEvents).
  const end = todayISO(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead)));
  // Derive each dueAt's UTC calendar day via todayISO so a date-only value and a
  // datetime both compare as zero-padded "YYYY-MM-DD" (lexicographic === calendar).
  const dayOf = (dueAt: string): string => todayISO(new Date(dueAt));
  return reminders
    .filter((r) => {
      if (r.status !== "open") return false;
      if (!r.dueAt) return false;
      const t = ms(r.dueAt);
      if (Number.isNaN(t)) return false; // unparseable dueAt excluded
      const day = dayOf(r.dueAt);
      return day >= start && day <= end;
    })
    .sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
}

// ── Priorities (stars + free-text notes) ───────────────────────────────────────
// PURE projections backing the Priorities surface — no fetch, no React, no I/O,
// like the Calendar/Reminders selectors above. Priorities have TWO complementary
// mechanisms: STARRED nodes (a user-curated favorite flag on any case/workstream/
// initiative) and free-text PriorityNotes ("what matters most right now"). Both the
// GET /api/priorities route and the UI read through these so their order agrees.

// A NEW array of priority notes sorted by manual rank then age: (1) position
// ascending (smaller = higher priority; an absent position is treated as +Infinity
// so it sorts LAST); (2) createdAt ascending as a stable tiebreak (oldest first).
// PURE given inputs. Mirrors the position handling in applyBoardQuery's "position"
// sort + buildForest's cmp.
export function sortPriorityNotes(notes: PriorityNote[]): PriorityNote[] {
  return [...notes].sort((a, b) => {
    const pa = a.position ?? Infinity;
    const pb = b.position ?? Infinity;
    if (pa !== pb) return pa - pb;
    return ms(a.createdAt) - ms(b.createdAt); // stable tiebreak (oldest first)
  });
}

// The starred (favorited/pinned) nodes for the Priorities surface: NON-archived
// nodes carrying the star, ordered by tier (initiative before workstream before
// case, via caseKind) then updatedAt DESCENDING (most recently touched first). All
// three tiers are CaseRecords in one id space, so this single filter covers them.
// Returns a new array. PURE given inputs.
export function starredCases(cases: CaseRecord[]): CaseRecord[] {
  const tierRank = (c: CaseRecord): number =>
    ({ initiative: 0, workstream: 1, case: 2 } as const)[caseKind(c)];
  return cases
    .filter((c) => c.starred && !c.archivedAt)
    .sort((a, b) => {
      const tr = tierRank(a) - tierRank(b);
      if (tr !== 0) return tr;
      return ms(b.updatedAt) - ms(a.updatedAt); // most recently touched first
    });
}

// ── Activity feed (the unified audit-trail surface) ───────────────────────────
// One reverse-chronological stream of EVERY fact the board has recorded, drawn
// from three sources and flattened into a single FeedEntry[]:
//   (a) case.activity[] — the append-only audit log on every case (capped to 50),
//       carried verbatim (actor + verb + detail);
//   (b) reminder lifecycle — synthesized rows for a reminder's create / complete /
//       dismiss moments (db.reminders has no activity log of its own);
//   (c) event lifecycle — a synthesized "created" row per calendar event.
// Synthesized (reminder/event) rows carry NO `actor` (the store never attributes
// them); case rows always do. The feed is the Activity surface's only data source.
// PURE given `db` — the SSR page passes a fixed `now` to the view, not here.

export type FeedKind = "case" | "reminder" | "event";

export interface FeedEntry {
  key: string; // stable, unique, deterministic — also the sort tie-break
  ts: string; // ISO timestamp this fact occurred at
  actor?: Actor; // PRESENT only for case rows; OMITTED for synth reminder/event rows
  verb: string; // raw verb (real CaseActivity.verb, or a synth verb)
  detail?: string; // CaseActivity.detail when present (case rows only)
  kind: FeedKind;
  subjectId: string; // CASE-/REM-/EVT- id of the subject
  title: string; // subject display title
  caseId?: string; // set when the row links to a case (case rows: always; synth rows: r/e.caseId if any)
}

// Flatten + synthesize the unified feed, newest first. INCLUDES archived cases —
// the audit trail shows everything (do NOT filter archivedAt). Cross-kind rows are
// NOT deduped: a case-row `reminder_linked` (the link-time fact, pointing AT the
// case) and a reminder-row `reminder_created` (the create-time fact, pointing AT
// the reminder) are different facts at different times linking to different places.
export function activityFeed(db: DBShape, opts?: { limit?: number }): FeedEntry[] {
  const rows: FeedEntry[] = [];

  // (a) Case rows — one per activity entry on every case (archived included).
  for (const c of db.cases) {
    (c.activity ?? []).forEach((act: CaseActivity, index: number) => {
      rows.push({
        kind: "case",
        subjectId: c.id,
        caseId: c.id,
        title: c.title,
        ts: act.ts,
        actor: act.actor,
        verb: act.verb,
        detail: act.detail,
        key: `case:${c.id}:${act.verb}:${act.ts}:${index}`,
      });
    });
  }

  // (b) Reminder rows — synthesized create / complete / dismiss lifecycle moments.
  // NO `actor` (the property is never assigned, so it cannot round-trip into a key).
  for (const r of db.reminders ?? []) {
    const base = { kind: "reminder" as const, subjectId: r.id, title: r.title };
    const linked = r.caseId ? { caseId: r.caseId } : {};
    rows.push({
      ...base,
      ...linked,
      verb: "reminder_created",
      ts: r.createdAt,
      key: `rem:${r.id}:created`,
    });
    if (r.status === "done") {
      rows.push({
        ...base,
        ...linked,
        verb: "reminder_completed",
        ts: r.completedAt ?? r.updatedAt,
        key: `rem:${r.id}:completed`,
      });
    } else if (r.status === "dismissed") {
      rows.push({
        ...base,
        ...linked,
        verb: "reminder_dismissed",
        ts: r.updatedAt,
        key: `rem:${r.id}:dismissed`,
      });
    }
  }

  // (c) Event rows — one synthesized "created" row per calendar event. NO `actor`.
  for (const e of db.events ?? []) {
    rows.push({
      kind: "event",
      subjectId: e.id,
      title: e.title,
      ...(e.caseId ? { caseId: e.caseId } : {}),
      verb: "event_created",
      ts: e.createdAt,
      key: `evt:${e.id}:created`,
    });
  }

  // (d) Newest first; tie-break by key (ids/index embedded) for a stable order.
  rows.sort((a, b) => {
    const dt = ms(b.ts) - ms(a.ts);
    if (dt !== 0) return dt;
    return a.key.localeCompare(b.key);
  });
  return rows.slice(0, opts?.limit ?? 200);
}
