# Initiatives & Workstreams — the three-tier hierarchy

A flat kanban is right for most matters: a thing to do, in a lane, done. But some matters
are too big to be a single card. "Build DevForge" or "Get healthy" is not one task —
it is an **aspiration** that decomposes into threads of work, each of which holds the actual
day-to-day cards. The hierarchy is how the board models that without leaving the kanban it
already is.

There are **three tiers**:

| tier | branding | role | id | parent |
|---|---|---|---|---|
| **Initiative** | "Initiative" (an Epic) | a big work-or-life aspiration | `CASE-<n>` | none (always a root) |
| **Workstream** | "Workstream" (a Sub-Epic) | a thread of related work under an Initiative | `CASE-<n>` | an Initiative |
| **Case** | "Case" (an Issue) | the actual unit of work — today's card | `CASE-<n>` | optional: an Initiative or Workstream |

The leaf tier is the `CaseRecord` you already know. The two container tiers — **Initiative**
and **Workstream** — are the new layer above it. The branding ("Initiative" / "Workstream")
is the user's choice; the leaf stays "Case".

## The one decision that makes this cheap: all three tiers are CaseRecords

There is **no new entity type and no new id space.** An Initiative and a Workstream are just
`CaseRecord`s in `db.cases` with a `kind` field — every node, at every tier, is `CASE-<n>`.

This is the load-bearing call, and it is deliberate. By making the containers the *same record*
as the leaves, the entire existing lifecycle is reused **for free, at every tier**:

- the store's serialized read-modify-write `mutate()` chokepoint,
- the append-only **activity log** (who did what, when, human vs agent),
- **notes**, **labels**, **tags**, **vaultLinks**, linked **messages**,
- **search** (cases/tasks/messages indexing is unchanged — containers are searchable too),
- **archive / restore / hard-delete**, **merge**,
- the lint id rule `/^CASE-\d+$/`,
- the SSE live-refresh, the version guard, the timestamped backups.

An Initiative can carry labels, notes, vault links, and messages exactly like a Case, because
it *is* one. **Linking works at every level for free.** A new entity type would have meant
forking all of that; a `kind` discriminator on the record we already have means inheriting all
of it.

## Data model

Two new **optional** fields on `CaseRecord` (absent on every existing case — fully
back-compatible, migrate-on-read leaves them absent unless present, so `SCHEMA_VERSION`
stays **3**):

```ts
export type CaseKind = "initiative" | "workstream" | "case";

kind?: CaseKind;     // absent  =>  treated as "case" (a leaf)
parentId?: string;   // id of the parent node; absent  =>  top-level / root
```

And one new optional field on `BoardPrefs`:

```ts
view?: "operational" | "strategy";   // which board surface was last shown
```

A small presentation table co-locates the branding so every surface labels the tiers
identically:

```ts
export const TIERS = [
  { kind: "initiative", label: "Initiative", plural: "Initiatives" },
  { kind: "workstream", label: "Workstream", plural: "Workstreams" },
  { kind: "case",       label: "Case",       plural: "Cases" },
];
export const caseKind = (c) => c.kind ?? "case";   // absent === leaf
export const kindLabel = (k) => TIERS.find((t) => t.kind === k)?.label ?? k;
```

The convention everywhere: **`kind` absent means `"case"`** (a leaf). Nothing about the old
flat board changes — a board with zero Initiatives is exactly the board you had.

## The invariants — a strict tree, max depth 3

The hierarchy is a **strict tree of maximum depth 3**. Let `kind(c) = c.kind ?? "case"`.

- **initiative** — MUST have no `parentId` (it is always a root). May contain Workstreams
  and/or Cases.
- **workstream** — MUST have a `parentId` referencing an existing **Initiative**. May contain
  Cases only.
- **case** (leaf) — `parentId` is OPTIONAL; if present it MUST reference an existing
  **Initiative** or **Workstream**. A Case has **no children**.
- A parent must **exist**, must be a **container** (never a Case), `parentId !== own id`,
  **no cycles**.
- Changing a node **to `case`** is illegal if it currently has children. Changing **to
  `workstream`** is illegal unless all its current children are leaf Cases *and* it gets/keeps
  an Initiative parent.
- **Detaching a Workstream to top-level** (clearing its `parentId`) is **illegal** — convert it
  to an Initiative first, or move it under another Initiative. (The error text says so.)

Two cascade rules keep the tree from ever dangling:

- On **hard-delete** of a container, its children are **detached** (their `parentId` is
  cleared) so nothing points at a deleted node.
- On **merge** of one case into another, the source's children are **re-parented** to the
  target (a Workstream child stays a Workstream under the new Initiative; if the target is not a
  valid container for a given child, that child is left detached and noted).

### Where the invariants are enforced — three places, one source of truth

The single source of truth is the pure function **`hierarchyViolation(cases, change)`** in
`board/lib/selectors.ts` — given the current flat `CaseRecord[]` and a proposed
`{ id, kind, parentId }`, it returns `null` (ok) or a human-readable message. Every enforcement
point calls *it*:

1. **Store** — `assertHierarchy(db, change)` throws `BadRequestError(hierarchyViolation(...))`.
   The HTTP API calls it inside the lock, **before** the write, on every create / single
   PATCH / batch PATCH that touches `kind` or `parentId`.
2. **Lint** — `tests/board-lint.mjs` re-asserts the tier rules over the persisted store as a
   hard gate (dangling parent, wrong-tier parent, a leaf as someone's parent, cycles, depth > 3
   all FAIL).
3. **UI affordances** — the drawer's parent/kind pickers only offer *legal* targets, so an
   illegal move is hard to make in the first place; the API rejection is the backstop.

## Rollup semantics

Containers show **progress rolled up from their leaves**. A rollup is computed over the
**non-archived descendant leaf cases** of a node (any depth):

```ts
interface Rollup {
  totalCases; doneCases;   // count of descendant LEAF cases (doneCases = status "done")
  totalTasks; doneTasks;   // tasks summed across those leaves
  ratio;                   // totalCases ? doneCases / totalCases : 0
  childCount;              // number of DIRECT children
}
```

So an Initiative's progress bar reads `doneCases / totalCases` over every leaf beneath it
(through its Workstreams), archived leaves excluded. The pure helpers
(`childrenOfCases`, `descendantLeaves`, `rollupFor`, `lineageOfCases`, `rootInitiativeOf`,
`buildForest`) live in `selectors.ts`, are deterministic, and are unit-tested — all three
surfaces (API tree, strategy view, drawer) read the *same* rollup definition.

## API

The hierarchy rides the existing case routes plus one new read endpoint. Everything mirrors the
existing route idioms: `force-dynamic`, `resolveActor` (human default; `x-actor: agent` or
`body.actor === "agent"` ⇒ agent), `BadRequestError → 400`, `NotFoundError → 404`,
`VersionConflictError → 409`, the `{ error }` body, the `mutate()` critical section.

| route | change |
|---|---|
| `POST /api/cases` | accepts optional `kind` (∈ `VALID_CASE_KIND`) and `parentId`; calls `assertHierarchy` inside the lock **before** insert; violation → `400` |
| `PATCH /api/cases/[id]` | accepts `kind` and `parentId` (`parentId: null` clears); asserts the *intended* kind+parent before `applyCaseUpdate`; the activity log records kind/parent changes |
| `PATCH /api/cases` (batch) | the `update_cases` patch may set `parentId` / `kind`; asserts per id inside the lock; **any** violation 400s the whole batch (the labels-reject-whole-batch precedent) |
| `GET /api/tree` | **new.** `?includeArchived=0&domain=work\|life` → `{ tree: TreeNode[], version }` via `buildForest`; `domain` filters roots by `root.domain` |

## MCP — the agent verbs

The `board` MCP server gains the hierarchy verbs. `create_case` / `update_case` are extended to
accept `kind` and `parentId`; `get_case` now shows **Kind**, **Parent** (id + title),
**Children** (ids + titles), and a **rollup** line for containers. New tools (each wraps the
HTTP API, agent-actor attributed):

| verb | does |
|---|---|
| `create_initiative(title, …)` | `POST /api/cases` with `kind:"initiative"` |
| `create_workstream(title, initiativeId, …)` | `POST` with `kind:"workstream"`, `parentId: initiativeId` |
| `set_parent(id, parentId)` | `PATCH /api/cases/{id} { parentId }`; `parentId: null` detaches (leaf only) |
| `regroup_cases(ids[], parentId)` | `PATCH /api/cases { ids, patch:{ parentId } }` — "group these under an Initiative/Workstream" |
| `get_tree(rootId?)` | `GET /api/tree`; renders an indented `Initiative > Workstream > Case` outline with each container's rollup + child counts; `rootId` prints only that subtree |
| `list_initiatives()` | top level of the tree; one line per Initiative with rollup + workstream/case counts |

## The two views + the toggle

The board now has **two surfaces**, toggled by a segmented **Operational | Strategy** control
in the toolbar that persists via `savePrefs({ view })`:

- **Operational view** — the existing 5-lane kanban, but it shows **only leaf Cases**
  (`isLeaf`). Each leaf card gains a subtle **lineage breadcrumb** chip
  ("Build DevForge › Pipeline") resolved from the loaded cases; clicking it filters to
  that Initiative. The New menu gains **New Initiative** and **New Workstream**, and group-by
  gains an **Initiative** swimlane (leaves grouped by their root Initiative).
- **Strategy view** — a new **outline roadmap**: a collapsible
  `Initiative > Workstream > Case` tree, each container with a **rollup progress bar**
  (`doneCases / totalCases`) + domain chip + child count + status pill. Clicking a leaf opens
  the existing detail drawer; inline **+ Workstream / + Case / New Initiative** actions create
  in place. It fetches its own tree (`fetchTree`) and refetches on the board SSE.

The **detail drawer** gains a **Parent** row (lineage + a picker to set/clear the parent among
valid containers), a **Children** section for containers (list + rollup bar), and a **Kind**
control where a change is legal — all derived from the `allCases` prop it already receives and
written through `board-client`.

## The agent / skill contract

Because containers and leaves share one id space, an agent must be deliberate about **where** a
new matter lands. The `create_*` tools carry this dedupe/nesting rule, and the skills follow it:

1. **Search first.** Call `get_tree` + `search` before creating anything (the same
   search-before-create mandate that prevents duplicate cards).
2. **Prefer a standalone Case** for a genuine one-off — an orphan leaf with no `parentId` is the
   right default.
3. **Nest under an existing Initiative/Workstream** when the matter clearly belongs to one.
4. **Create a new Initiative only for a genuinely new multi-stream theme** — not for every task.

## Parity rule

The hierarchy obeys the board's founding tenet: **every human gesture is the visual twin of an
MCP verb.** Dragging "New Workstream" in the strategy view, picking a parent in the drawer, and
regrouping a multi-select all resolve to the *same* routes the agent's `create_workstream`,
`set_parent`, and `regroup_cases` call. There is no human-only or agent-only way to shape the
tree — one mutation path, two faces.
