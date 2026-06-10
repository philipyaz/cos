---
name: second-brain-ingest
description: >
  Ingests an item (inline text and/or attached on-device files) into the
  domain-split knowledge wiki. Classifies the item's domain (work | life),
  writes a factual source page, copies attached artifacts into raw/assets,
  re-synthesizes the affected entity and concept pages, resolves entities to
  canonical [[wikilinks]] via aliases.md, and maintains the strong per-domain
  index and log. Knowledge-only — no tasks, no board, no channel polling.
  Invoked headlessly by the vault Agent SDK client via the MCP ingest route.
allowed-tools: Read Write Edit Glob Grep
---

# Second Brain — Ingest (knowledge-only)

This skill turns one incoming item into durable **knowledge** in the domain-split
wiki. It does **one** thing: ingest. It does **not** route to a board, does **not**
create tasks/reminders/events, does **not** poll Gmail / OpenWhispr / Calendar, and
does **not** own any watermark. It receives **marshalled inputs** from the MCP ingest
route: the **inline text** of the item, and zero or more **absolute file paths** to
attached on-device files. Work the inputs you are given; do not go looking for more.

The vault is **knowledge-only**: a fact / context / who-what-why. **Never** write task
checkboxes (`- [ ]`) into any page. Open work and to-dos live on the board, which this
skill has no access to and must not invent.

## Vault layout

The wiki is **split by domain**. Each domain has its own self-contained wiki tree:

| Root | When |
|---|---|
| `work/wiki/` | Professional knowledge — the venture, the role, advisory, work entities/concepts/sources. |
| `life/wiki/` | Personal knowledge — trips, health, admin, personal entities/concepts/sources. |
| `shared/wiki/` | **Truly-dual** entities only — pages referenced by *both* domains (the user themself, the city they live in). Lives under `shared/wiki/entities`. |

Each domain tree holds:

- `<domain>/wiki/index.md` — the **strong index** (see format below) — the entry point.
- `<domain>/wiki/log.md` — the append-only ingest log.
- `<domain>/wiki/entities/` — people / orgs / products / tools.
- `<domain>/wiki/concepts/` — ideas / projects / themes.
- `<domain>/wiki/sources/` — one factual page per real source.

Other shared resources at the vault root:

- `aliases.md` — the manual entity-resolution map (surface forms → canonical `[[Entity]]`).
- `raw/assets/` — preserved copies of attached artifacts. Drop attachments into
  `raw/assets/` inside your vault (the path is relative to the vault root, which is this
  session's cwd).

---

## CORE LOOP

### 1. Classify the DOMAIN

Decide whether the item is **work** or **life** from its content:

- **work** — your company or venture, your job/role, professional projects,
  work contacts, deliverables. *Default to `work` for ambiguous professional context.*
- **life** — trips, health, citizenship/admin, family, friends, personal logistics.
  *Default to `life` for personal context.*

The chosen domain selects the wiki root: `work/wiki` or `life/wiki`. A **truly-dual
entity** (one referenced by both sides of life — the user themself, the home city) is
written under `shared/wiki/entities` and linked from both domains' pages. Everything
else stays inside its single domain tree.

If an item genuinely spans both domains, ingest its knowledge into the **primary**
domain and link out to the relevant `shared/` entities; do not duplicate a work concept
into `life/wiki` or vice versa.

### 2. Write the source page (for a real source / attached file)

For a real source — an inline note worth preserving verbatim context, or any **attached
file** — create `<domain>/wiki/sources/<Title>.md`:

- Standard frontmatter: `tags`, `sources`, `created`, `updated` (and read-only `cases:`
  only if a board id was passed in — see step 7).
- The source's **factual** summary and key claims (no interpretation — save synthesis
  for concept pages).
- **Entities Mentioned** — `[[…]]` for each actor.
- **Concepts Covered** — `[[…]]` for each idea/project/theme.
- Filename **==** H1.

A bare inline thought with no real source artifact may not need a source page — route its
knowledge straight to the entity/concept pages.

### 3. Preserve attached artifacts

For **each absolute file path** handed to you in the inputs:

1. **Copy** the file into `raw/assets/` (relative to the vault root, which is this
   session's cwd) under a **sensible, human-readable name** (keep the original extension; disambiguate
   with a date or topic if the name is generic like `image.png`). Use `Read` to load the
   file and `Write` to write the copy (or `Read`+`Write` for text; for binary you cannot
   transform, copy by reading then writing the bytes through — preserve the original).
2. **Reference** the preserved copy from the source page via a **relative markdown link**,
   e.g. `[Original deck](../../raw/assets/2026-05-12-guadeloupe-deck.pdf)` from a page in
   `<domain>/wiki/sources/`. (Sources sit two levels under the vault root, so the relative
   path back to `raw/assets/` is `../../raw/assets/<file>`.)

This keeps the artifact **preserved and retrievable** — the query skill surfaces these
linked assets as associated artifacts.

### 4. Re-synthesize the affected pages (rewrite, don't append)

For **each** entity and concept the item touches, **rewrite** the page to reflect
everything now known — do **not** tack new bullets onto the end:

- Fold the new facts into the existing prose; resolve any contradiction in place and note
  it with both sources cited.
- Add the source to the page's `sources:` frontmatter and bump `updated:`.
- Create new entity / concept pages where the item introduces something with no page yet.
- A single **substantive** source touches **10-15 pages** — that cross-page re-synthesis
  is the entire value. If you only wrote the source page and the index, you missed it.

### 5. Resolve entities to canonical [[wikilinks]]

Before linking any actor, collapse it to **one** canonical entity:

1. **Heuristic first** — match on name, known email, and existing wiki entity pages (read
   the domain `index.md` and the candidate entity page).
2. **Then `aliases.md`** (vault root) — the hand-curated map of surface forms → canonical
   `[[Entity]]`. A sender email, a spoken name, and a written name must all collapse to the
   same page.
3. If you discover a new reliable mapping, **append it to `aliases.md`** in the documented
   format (`surface · surface · … → [[Canonical Entity]]`). Never fabricate a mapping.

Every mention of a page-bearing entity/concept is `[[linked]]`. Never use raw file paths
for internal references — only `[[wikilinks]]`.

### 6. Maintain the strong index + log

- **Strong index** — update `<domain>/wiki/index.md` so every concept, entity, and source
  page in the domain appears under exactly one **overarching theme** (see the verbatim
  format below). New pages slot under their theme; a page that fits no theme goes under a
  final `## Unfiled` so nothing is dropped.
- **Log** — append to `<domain>/wiki/log.md`:

      ## [YYYY-MM-DD] ingest | <Source Title>
      Pages: created [[A]]; re-synthesized [[B]], [[C]], … (N total).
      Entities: [[X]], [[Y]]. Concepts: [[P]], [[Q]]. Assets: raw/assets/<file>.

### 7. (Optional) Record a board case id passed in the prompt — READ-ONLY

If — and only if — the ingest route passes you an explicit board case id in the prompt,
you may record it on the affected pages as a **read-only** reference:

- A `cases:` frontmatter list, e.g. `cases: [CASE-12]`.
- A human-readable body line: `**Board:** [[CASE-12]] — <title>`.

**Never** call a board tool (you have none), **never** invent or guess a case id, and
**never** add task checkboxes. This is the *only* board reference allowed on a knowledge
page, and only when an id was explicitly handed to you.

---

## STRONG-INDEX FORMAT (per domain, `<domain>/wiki/index.md`)

The spec calls for an **ultra strong index: an overarching concept which handles multiple
concepts**. So the index is **NOT** a flat list; it is a navigable **MAP** whose
top-level sections are **OVERARCHING THEMES**, each grouping its constituent concepts +
entities + sources:

```
# <Work|Life> Wiki — Index
> One-line statement of what this domain covers. Overarching map: each ## is a theme that handles multiple concepts.

## <Overarching Theme>            (e.g. for work: "Flagship venture", "Day job & team", "Skill-building"; for life: "Big trip 2026", "Health", "Citizenship & admin")
One-line framing of the theme.
- **Concepts:** [[Concept A]] — 6-word gist · [[Concept B]] — 6-word gist
- **Entities:** [[Entity X]] — role · [[Entity Y]] — role
- **Sources:** [[Source 1]], [[Source 2]]

## <next theme> ...

## Shared (cross-domain)
- [[Your Name]], [[Your City]] — live in shared/wiki/entities (referenced by both domains).
```

Rules: every concept, entity, and source page in the domain MUST appear under exactly one
theme (sources may repeat under the theme they evidence). A page that fits no theme goes
under a final "## Unfiled" so nothing is dropped. Keep each gist <=8 words. The themes
themselves are the "overarching concepts".

---

## Conventions

- **Knowledge-only.** Never write `- [ ]` task checkboxes into any wiki page.
- **Rewrite, don't append.** Re-synthesize each touched page to reflect everything known.
- **Source pages are factual.** Save interpretation/synthesis for concept pages.
- **A substantive source touches 10-15 pages.** The cross-page work is the value.
- **`[[wikilinks]]` for every internal reference.** Never raw file paths.
- **Filename == H1** on every page.
- **Domain-split is real.** Keep work knowledge in `work/wiki`, life in `life/wiki`;
  only truly-dual entities live in `shared/wiki`. No cross-domain leaks.
- **Resolve entities first** — heuristic, then `aliases.md`; append new reliable aliases.
- **Strong index, not a flat list** — themes that group concepts/entities/sources.
- **No board, no channels, no watermarks.** This skill receives marshalled inputs and
  produces knowledge. It owns nothing outside the wiki.
