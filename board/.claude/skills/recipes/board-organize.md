# Recipe — Board organize (housekeeping)

**Channel:** none (board-internal) · **MCP:** `board` · **Skill:** `/board-organize`
**Watermark:** none — the sweep is idempotent by construction (an already-filed case
is no longer an orphan; a clean board no-ops).

> **Not a channel-ingest recipe.** The other recipes pull from a channel, route through
> `/second-brain-ingest`, and watermark. This one pulls from **nothing** — it
> reorganizes the cases already on the board into a clean Initiative ▸ Workstream ▸
> Case tree. The reconcilers (`/mail-to-board`, `/whatsapp-triage`) create every matter
> as a **flat** card; this sweep files them, names the containers, and tidies up. Run
> it on a **slower** cadence than the reconcilers (structure isn't time-critical).

The pasteable block below is the **full procedure** — it runs the `/board-organize`
skill but is written to stand on its own so an unattended run does the right thing
end-to-end. Everything writes through the **`board`** MCP only (never `bash`/`curl`).

## Paste this into a Cowork scheduled task ("every X min", e.g. every 2–6 h or daily)

> **Board organize — hierarchy housekeeping (`/board-organize`).** Reorganize the
> board into a clean Initiative ▸ Workstream ▸ Case tree. Touch **only** structure
> (`kind`, `parentId`, container `title`/`summary`, archive/restore) — never lanes,
> tasks, labels, message links, or sending. Work through these steps in order:
>
> **0. Mode.** Read `config/auto-sync.json` → `autoSync` (default **ON**). In **auto**
> mode, auto-apply only the deterministic same-entity grouping in step 6 and `propose`
> everything else. In **approval** mode (`false`), apply nothing — `propose` every
> consequential change (→ `list_pending` → the human `approve`/`reject`s). State the
> mode once at the start.
>
> **1. Ground in priorities FIRST — `get_priorities`.** Capture the user's pinned
> intent: **starred** nodes, **`PRI-` priority notes** (free text, linked to no case —
> match them to cases **by meaning**), and (on every case you load) the **`P0`/`P1`**
> ones. Rules for the whole run: **never `archive_case` a starred node** (archiving
> drops it off the Priorities surface); keep pinned cases **shallow** and make them the
> **anchor** of any Initiative you build around them; if a pinned node looks stale,
> **flag it, don't archive it**.
>
> **2. Enumerate per domain** (`work` and `life` independently — never cross them).
> For each: **`get_tree`** + **`list_initiatives`** for the current structure (so you
> **reuse** containers, not duplicate them), and **`search`** — the only read that
> surfaces **Trash** — before creating any container, so you don't re-mint a
> soft-deleted one. Note, for every container, whether a **human** or the **agent**
> created/named it.
>
> **3. Identify** (a) the **orphans** = top-level leaf cases with no `parentId` (the
> flat cards to file); (b) the **containers** to possibly tidy.
>
> **4. Manual-action guard — before moving/renaming ANYTHING, `get_case` it** and read
> its **"Manual actions by the user"** block. **Frozen:** a `parentId` a human set by
> hand, and any `title`/`summary` a human edited — never re-home, rename, re-summary,
> or archive these; at most `propose`. **Yours:** a case the **agent** placed (refine
> freely) and a never-placed orphan (file it — that's the job). Human-built containers
> are authoritative (file orphans *into* them, but don't rename/dissolve them). When
> unsure who placed/named something, `propose` — don't touch.
>
> **5. Cluster** the non-frozen orphans by the resolved **entity** (`vaultLinks`) first,
> then topic / title / shared `labels`. Everything about one person/client/relationship
> is one cluster.
>
> **6. File — concrete thresholds, not vibes:**
>   - A **lone orphan with no kin** → leave it **standalone**. Never mint a container
>     for one case.
>   - **≥2 cases share an entity** → group them under that entity's Initiative:
>     **reuse** the existing one (`regroup_cases(ids, parentId)`) or `create_initiative`
>     named for the **canonical entity** (`Acme Corp`, the `vaultLinks` title) then
>     `regroup_cases`. *(Auto-apply only when the entity match is exact; else propose.)*
>   - An Initiative grown to **≥2 distinct multi-case threads** → `create_workstream(
>     title, initiativeId)` per thread and `regroup_cases` its leaves (propose). One
>     coherent thread → cases hang **directly** under the Initiative; **never a
>     single-case Workstream**.
>   - Keep a pinned (starred/P0/note) case as the Initiative's **anchor**, not buried.
>   - The board enforces legality (depth ≤ 3, container parents, no cycles, a Workstream
>     under an Initiative holding only leaves; `regroup_cases` is **batch-atomic** — one
>     bad id rejects the batch). Don't pre-check tier rules; **do** enforce human
>     authorship (step 4).
>
> **7. Normalize & tidy containers — PROPOSE-ONLY, agent-created only** (never a
> human-built/renamed container; never a starred shell):
>   - **Rename** a sloppy agent-made container → `update_case(id, { title })` to the
>     canonical entity name (`misc` / `acme stuff` → `Acme Corp`).
>   - **Describe** it → `update_case(id, { summary })` with one factual line.
>   - **Merge** duplicate Initiatives for one entity, in this exact order (archiving
>     does NOT detach children): **(1)** `regroup_cases(childIds, survivorId)` →
>     **(2)** optional `update_case(survivorId, …)` → **(3)** `archive_case(shellId)`.
>   - **Flatten** a single-case Workstream → `regroup_cases([caseId], initiativeId)`
>     then `archive_case` the empty Workstream.
>   - **Retire** an empty agent-made container → `archive_case` (soft/restorable).
>   - **Surface** a buried/archived priority → propose lifting it / `restore_case`.
>   - **Order rule:** always `regroup_cases` children to their new home **before**
>     archiving any shell — an archived parent doesn't take its children with it; they
>     pop to top-level until refiled.
>
> **8. Report**, grouped by domain: **Applied** (auto mode) / **Proposed** (with
> `propose` ids — offer "apply any?") / **Surfaced** (priorities needing attention).
> If nothing needed doing, say "nothing to organize". Then stop.

## Discipline (how this recipe stays trustworthy)

- **Idempotent — no watermark needed.** It acts only on `agent`-placed or unplaced
  orphans not already well-filed, and on its own agent-created containers; proposals
  stay inert until approved. A second run over a clean board does nothing — so a tight
  cadence is safe and cheap.
- **Priority-safe.** Re-parenting and renaming never break a star or a priority note
  (notes link to nothing; the star is a field on the case keyed by its own id; a
  re-parent patches only `parentId`). The one trap — archiving a starred node, which
  drops it off the Priorities surface — is forbidden.
- **Human edits win.** A `parentId`, `title`, or `summary` a human set by hand is
  frozen; the sweep refines only its own prior placements, files never-placed orphans,
  and renames/merges only the containers **it** created. Human-built containers are
  reused, never re-titled or dissolved.
- **Deletion is soft, everywhere.** `archive_case` ≡ `delete_case` — both just stamp
  `archivedAt` and are reversible with `restore_case`. There is **no hard delete** via
  the API; permanent removal is an automatic retention sweep. So every tidy step is
  undoable — but still propose the judgment calls.

## Why a separate sweep (intent)

The reconcilers optimize for **one clean card per matter** and write fast on the
channel cadence; deciding *where each card belongs in the tree*, *what the containers
should be called*, and *which duplicates to merge* is a slower, board-wide judgment
that needs the whole picture (and the user's priorities) at once. Splitting it out
keeps the reconcilers simple and gives hierarchy a single, priority-aware owner instead
of every channel guessing at structure one message at a time.
