# Cos — Product Spec (high-level)

> Working name. The whole system lives in **one monorepo — `./cos`** (board, vault, MCP
> bridges, skills, recipes), consolidating the two foundations built so far without overwriting
> anything else in `~/Code`. Layout in §3.

## 1. Vision

**Cos**, your local-first personal **chief of staff**, watches every incoming channel — voice, email,
calendar, meetings — keeps a **compounding knowledge base** of context, and maintains a **single
minimalist kanban** of what needs doing. **Claude Cowork Desktop is the operator**; scheduled tasks
keep both surfaces current on their own, so you stop hand-connecting the dots between a message →
the person → the history → the note → the task.

## 2. Problem

Too many incoming channels to monitor. Staying organized means manually connecting an email to
context about the sender and subject, finding or writing the related note, and remembering the
follow-up. The dot-connecting is the work, and it's chaotic. Capture, context, and follow-through
live in different places and never reconcile themselves.

## 3. The shape: two pillars + one operator

```
            ┌─────────────────────────────────────────────┐
  CHANNELS  │ OpenWhispr · Gmail · Google Calendar · Meet  │
            └───────────────────────┬─────────────────────┘
                                    │  (local or remote MCP bridges)
                      ┌─────────────▼──────────────┐
   OPERATOR           │   Claude Cowork Desktop     │   ← the router:
                      │   + scheduled tasks (X min) │     classify & route
                      └───────┬─────────────┬───────┘
              knowledge ──────┘             └────── action
        ┌───────────────▼──────┐      ┌────────────▼───────────┐
  PILLARS│  Knowledge base     │◄────►│   Kanban (the board)   │
        │  vault/              │ links│   board/               │
        │  context, compounds  │      │  single to-do surface  │
        └──────────────────────┘      └────────────────────────┘
```

**Pillar 1 — Knowledge base (`vault/`).** Context that compounds. An LLM-Wiki Obsidian
vault: sources go in, a librarian re-synthesizes interlinked entity / concept / source pages. After
this product, the vault holds **knowledge only** — the timeless *who / what / why*.

**Pillar 2 — Kanban (`board/`).** The **single home for what needs doing**. Keeps the
existing rich case model (a case with a task checklist, a board lifecycle, and linked messages),
generalized to be business-domain-neutral. The time-bound *what / where / next*.

**Operator — Cowork Desktop + scheduled tasks.** The always-on router that ingests channels and
keeps both pillars current without manual steps.

**The dividing line is strict:** the vault never owns to-dos anymore; **the board is the one and
only surface for actionable work.** Knowledge compounds in the vault and *links to* the cases it
informs.

**Repository layout — one monorepo.** Everything for this system lives under **`./cos`**;
no part of it sits outside that directory. The two foundations built so far are **consolidated, not
rebuilt** — their content (and git history where practical) moves in, unrelated repos elsewhere in
`~/Code` are left untouched, and nothing is overwritten.

```
cos/                 ← the monorepo; everything lives here
├── docs/                          ← MkDocs site → GitHub Pages (this file: docs/architecture/spec.md)
├── .claude/skills/                ← all skills, discovered by Claude Code / Cowork
│   ├── second-brain-ingest/       ← the router (knowledge → vault, action → board)
│   ├── second-brain-query/ · second-brain-lint/
│   └── <business-process>/        ← e.g. release-readiness-…
├── .mcp.json                      ← wires the local MCP servers below
├── vault/                         ← Pillar 1 · knowledge base (from notes-vault)
│   └── my-personal-thoughts-vault/   Obsidian vault — knowledge only
├── board/                         ← Pillar 2 · kanban (Next.js app, moved off the repo root)
│   └── app/ · components/ · lib/ · data/ …
├── mcp/                           ← local MCP bridges (sandbox-aware)
│   ├── board-server/                 was create-case-server; full case/task lifecycle
│   └── openwhispr-server/            new; transcripts + processed-watermark
└── tests/                         ← golden fixtures + board lint
```

One-time migrations the move implies: the board shifts from the repo root into `board/`; Obsidian
re-points to `vault/my-personal-thoughts-vault/`; the `.mcp.json` and board `data/` paths update; and
the old host-side git auto-sync (`sync.sh` + launchd) is **retired** — at the end of the build nothing
runs on our side; Cowork's scheduled tasks are the only periodic trigger (see §5).

## 4. Channels & bridges

| Channel | Role | Bridge |
|---|---|---|
| **OpenWhispr** | Local voice transcripts (`openwhispr --local transcriptions list/get`) | **New local MCP** (to build) |
| **Gmail** | Read / search / draft / label mail | Anthropic out-of-the-box MCP |
| **Google Calendar** | List / create / update events | Anthropic out-of-the-box MCP |
| **Google Meet** | Meeting transcripts / recaps | Ingested as sources (path TBD — see §10) |

**Architectural principle — sandbox-aware bridges.** Cowork's sandbox blocks outbound HTTP, so every
local capability is exposed to Cowork as an **MCP server**, not a direct API call. The template
already exists: `mcp/create-case-server` (stdio MCP, optionally fronted by supergateway). The
OpenWhispr bridge is modeled on it.

**Child-lifecycle contract (idle-exit is opt-in).** Each node MCP server (board, calendar, guard,
vault, openwhispr) is consumed two ways with opposite lifecycles, and the shared boot helper
`packages/mcp-kit/index.mjs` `start()` handles both:

- **Direct stdio** — Claude Cowork Desktop (and running a server by hand) spawn one long-lived child
  for the whole session and do **not** respawn it. So the **idle-exit timer is OFF by default**: the
  server never self-terminates while idle (an idle-exit here is the *"server transport closed
  unexpectedly → MCP not responding"* failure). A real disconnect/quit closes stdin, which reaps the
  child cleanly (the always-on stdin-`end`/`close` backstop).
- **supergateway HTTP bridge** — Claude Code reaches each server through a launchd `supergateway`
  bridge. In stateless StreamableHttp mode supergateway spawns a fresh child per request and frees it
  only on child-exit/protocol-error (never on normal completion), so idle children leak. Each **bridge
  LaunchAgent therefore opts in** with `COS_MCP_IDLE_EXIT_MS=300000`, reaping idle children after 5 min
  (a request in flight disarms the timer; supergateway respawns on the next call). This env var lives
  **only in the bridge plists**, never in the Cowork config. Regression-guarded by `tests/mcp-kit-idle.mjs`.

## 5. The loop (how the dots get connected, automatically)

**The router is `/second-brain-ingest`, extended.** Today it ingests into the vault; it grows into the
system's single **classify-and-route** entry point: read an item, decide **knowledge vs action**, and
write to **either the vault or the board** (or both, cross-linked). Everything flows through it,
whether triggered by hand or by a schedule.

**Cowork drives the loop — no host-side scripts.** Periodic fetching is done by **Cowork scheduled
tasks** the user configures by hand in Claude Cowork Desktop; each task pulls new inputs through the
MCPs and hands them to the router. At the end of the build **nothing runs on our side** — no cron,
launchd, or shell script; Cowork is the only trigger. This spec supplies the **recipes** (what each
task pulls), not a scheduler:

- **Voice (every X min)** — pull new transcripts → router → mark processed.
- **Mail (every X min)** — scan important / unread → router → label processed.
- **Calendar (periodic)** — ensure a prep case + notes exist for upcoming meetings; after a meeting, ingest the Meet recap and update the case.

**Routing contract (the core behavior, run by the router):**

- **Knowledge** (a fact, context, who/what/why) → **vault** — re-synthesize the affected entity / concept / source pages.
- **Action** (something to do, a state change) → **board** — create a case, add or update a task, move a lane, tagged with a **work / life** domain.
- **Most inputs produce both** — a source page in the vault *and* a case/task on the board, **cross-linked**.

**Discipline that makes it trustworthy:**

- **Idempotent** — a per-channel watermark (last processed transcript id / email / timestamp) so nothing is processed twice.
- **De-duplicated** — the same thread or topic updates the existing case instead of spawning a duplicate.
- **Entity-resolved** — a sender, a spoken name, and a board entity all resolve to one vault entity.

**Execution policy — the router reads an `auto-sync` switch first.** Step 0 of the router is a config
check: is **`auto-sync`** enabled (a variable defined somewhere in the repo / config)? If **on**, the
router processes and writes to vault and board **automatically** and **logs every action**, so you can
review what it did and ask for changes afterward. If **off**, it runs in **approval mode** — preparing
the changes but confirming outward actions (sending mail, moving cases) before committing. Default is
auto-send on.

## 6. Object & linkage model (the dots, made explicit)

```
KNOWLEDGE (vault, notes-vault)              EXECUTION (board, cos)
  Entity   — a person / org                   Case    — a unit of work, in a work|life domain
  Concept  — a project / idea / theme         Task    — a checklist item on a case
  Source   — one ingested transcript/email    Message — an incoming item linked to a case

Auto-maintained links:
  Case   ──names──▶  Entity / Concept     jump from a card to who/what/why
  Case   ──from───▶  Source / Message     the transcript/email that spawned or advanced it
  Entity ──open───▶  Case                 from a person's page, see everything open with them
```

From any board card you reach full context in one hop; from any person's page you see all open
work with them. **That bidirectional link is the dot-connection — and the operator maintains it.**

## 7. Skills layer (the payoff)

Once the foundation exists, each recurring business process is a **thin skill** that:
**reads context** from the vault → **acts** through channel MCPs (Gmail / Calendar) → **writes state**
to the board through the board MCP. No new infrastructure per process.

Reference, already built: **`release-readiness-call-check`** — `/status-check` →
`/readiness` → `/email` (drafts via Gmail MCP) → `/create-case` (opens a tracked case via the
board MCP). The foundation is what makes skills like this cheap to add.

## 8. Definition of Done

The job is **done** when every component below holds and the end-to-end acceptance test passes.

**A. The router & knowledge base**
- [ ] `/second-brain-ingest` **extended into the router**: it classifies each item and writes knowledge to the **vault** and actionable work to the **board** (via the board MCP), cross-linking the two — instead of writing to-dos into `life/` || `work/` reminders.
- [ ] Vault `CLAUDE.md` schema updated to match: vault is **knowledge-only**; `life/` & `work/` reminders + priorities **deprecated** (or a transient capture buffer that drains to the board); existing open items **migrated** to board cases.
- [ ] Entity / concept / source pages carry links back to their related board cases; the router writes these.
- [ ] `query` / `lint` still pass on knowledge-only content.

**B. Kanban — single to-do surface, rich model, generalized**
- [ ] `CaseRecord` model retained but **business-domain-neutral** — Northwind Systems specifics generalized; developer-tooling fields/labels live in the *skill*, not the core board.
- [ ] Cases carry a **`work | life` domain** (mirrors the vault's split) so the board is the single to-do surface for *both* sides of life, filterable by domain.
- [ ] Board MCP exposes the **full lifecycle**, not just create/get: `create_case`, `get_case`, `update_case` (fields + lane move), `add_task` / `update_task` / `complete_task`, `link_message`. *(Required so the board can be "automatically updated with new or modified tasks.")*
- [ ] Cases link to vault context (entity / concept / source).
- [ ] Board persistence durability across devices decided (durable store vs accepted single-machine).

**C. Channel bridges**
- [ ] **OpenWhispr local MCP** built: `list_transcripts`, `get_transcript`, and a **processed-watermark** so the loop is idempotent. Modeled on `create-case-server`; sandbox-bridged.
- [ ] Gmail MCP wired (search / read / draft / label).
- [ ] Calendar MCP wired (list / create / update).
- [ ] Google Meet recaps have a **defined ingestion path** (where they land, how the loop picks them up).

**D. The operator — scheduled-task recipes (user-scheduled in Cowork)**
- [ ] Documented **recipes** for the voice, mail, and calendar tasks (what each pulls through the MCPs and hands to the router). The end user sets the cadence in Cowork; we don't build a scheduler.
- [ ] **No host-side cron / launchd / shell scripts** — Cowork scheduled tasks are the only periodic trigger.
- [ ] Each recipe is **idempotent** (per-channel watermark) and routes per the contract.
- [ ] Routing implemented end-to-end with **dedup** and **entity resolution**.
- [ ] Router does a **step-0 `auto-sync` check** — auto-send + action log when on; approval mode when off.

**E. End-to-end acceptance — the "it's done" test**
- [ ] **Speak a voice note about a client** → within one cycle, with no manual step: a source page exists in the vault, the person's entity page is updated, and a case/task appears or updates on the board in the right lane and **work/life** domain — all cross-linked, and the action logged.
- [ ] **An email on an open matter arrives** → the matching case auto-updates (message linked, task/lane changed) and context lands in the vault.
- [ ] **One-hop navigation works** both ways: card → context, person → open work.
- [ ] **A new business process** can be added as a single skill on top of the existing KB + channel MCPs + board MCP, with zero new infrastructure.

**F. Repository — one monorepo**
- [ ] Everything lives under `./cos`: the board moves off the repo root into `board/`, the vault consolidates into `vault/`, second-brain + business skills under `.claude/skills/`.
- [ ] Consolidation is **non-destructive** — content (and git history where practical) preserved; no unrelated repo in `~/Code` touched or overwritten.
- [ ] Wiring updated to the new paths: `.mcp.json`, Obsidian vault path, board `data/`.

## 9. Validation: spec · tests · convergence

This is an autonomous LLM loop writing to two persistent stores. Three small artifacts keep it
trustworthy and improvable — deliberately minimal:

**The spec — this document.** The single source of truth for what "done" and "correct routing" mean.
It **co-evolves** (like the vault's `CLAUDE.md` schema): when behaviour should change, change the spec
first, then the router prompt / skills. Keep it minimal — it's read by you *and* the operator.

**The test suite — golden fixtures + invariants, on a throwaway copy.**
- A small, versioned corpus of representative inputs (a handful of sample transcripts, emails, calendar events), each paired with its **expected structural outcome**: which vault pages are touched, which case/task is created or updated, the cross-links, the work/life domain.
- **Assert on invariants, not prose** (LLM output varies): "a source page exists for this transcript", "the speaker's entity page links the new case", "the case is in the right lane + domain", "no duplicate case for the same thread".
- Run against a **throwaway copy** of the vault + board — never live data.
- Reuse **`second-brain-lint`** as property tests for the vault (no orphans, contradictions, stray checkboxes); add a **board lint** (every case has a domain, no duplicate case per thread, no orphan message, task counters consistent).

**The convergence criterion — a measurable "good enough" bar.**
- The loop **has converged** when golden fixtures pass, vault + board lint are clean, and over the last *K* real cycles the user made **≤ N manual corrections**. Below the bar → tune the router prompt / schema; at or above → leave it alone.
- **Every manual correction becomes a new fixture.** Corrections feed back into the golden set so the same mistake can't regress — the test suite compounds from real use, exactly as the knowledge base does.

## 10. Open decisions & risks

- **Entity resolution** — one canonical key per person across email address, spoken name, and board entity. Start heuristic; keep a manual alias map in the vault.
- **Idempotency watermarks** — where the per-channel "last processed" marker lives (OpenWhispr has no native "mark read", so the operator owns it).
- **Vault-reminders migration** — a one-time move of existing open reminders/priorities into board cases when the board becomes the single surface.
- **Meet ingestion path** — Calendar-attached notes vs Drive export vs manual; pick one.

*(Resolved this round: triggering → Cowork scheduled tasks only, no host-side cron/launchd/shell scripts; the old `sync.sh` + launchd git-sync is retired. Execution policy → the router reads an `auto-sync` switch at step 0; auto-send + action log when on, approval mode when off — see §5. Work surface → kanban is the single to-do home.)*
