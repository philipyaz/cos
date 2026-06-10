---
name: second-brain-lint
description: >
  Scheduled integrity pass over the domain-split knowledge wiki. Runs over
  work/wiki, life/wiki, and shared/wiki independently and flags: filename != H1,
  broken [[wikilinks]], orphan pages, strong-index integrity gaps, cross-domain
  leaks, stray task checkboxes (knowledge-only violations), and legacy
  priorities.md / reminders/ that should not exist. Read-only health check —
  it FLAGS, it does not write the board. Use when the user says "audit", "health
  check", "lint", "find problems", or on a schedule.
allowed-tools: Read Glob Grep
---

# Second Brain — Lint (knowledge integrity pass)

A **scheduled integrity pass** over the domain-split wiki. This is **not** an MCP route —
it is a periodic health check. It runs over the three wiki trees — `work/wiki`,
`life/wiki`, and `shared/wiki` — **independently**, and reports issues with actionable
fixes. The vault is **knowledge-only**: this lint **flags** problems, it never writes the
board (it has no board access) and never auto-mutates pages unless the user asks.

Run every check below for **each** domain tree, then present one consolidated report with
findings grouped by domain and severity.

## Checks (run per domain: work/wiki, life/wiki, shared/wiki)

### 1. Filename == H1

For every `.md` page, the H1 (`# Title`) must equal the filename (minus `.md`). Flag any
page whose first heading does not match its filename.

### 2. Broken [[wikilinks]]

Scan all pages for `[[wikilink]]` references and verify each target page exists (within
the domain, or in `shared/wiki` for a shared entity). Flag links that point to no file.

```
grep -roh '\[\[[^]]*\]\]' work/wiki/ | sort -u
```

(Repeat for `life/wiki/` and `shared/wiki/`.) Cross-reference against actual files.

### 3. Orphan pages

Find pages with **no inbound `[[wikilink]]`** from any other page (and not reachable from
the strong index). For each entity / concept / source page, search the domain's other
pages for `[[Page Name]]`; if nothing links it and the index doesn't list it, it's an
orphan.

### 4. Strong-index integrity

The domain `index.md` is a **strong index**: a map of overarching **themes**, each
grouping its concepts, entities, and sources. Verify:

- **Every** concept, entity, and source page in the domain appears under **exactly one**
  theme (a source may repeat under the theme it evidences). A page under no theme is a gap
  — it belongs under a theme or under the final `## Unfiled`.
- **No index entry points to a missing page** (a `[[link]]` in the index with no file).
- Each theme actually groups multiple concepts (the index is not a flat list masquerading
  as themes).

### 5. Cross-domain leaks

The wiki is **domain-split**. Flag a leak when:

- A page in `work/wiki` links **only** into `life/wiki` (or vice versa) — work knowledge
  bleeding into the life tree, or the reverse.
- A page lives in the wrong tree for its content.

**Documented exception:** `shared/wiki` entities (the user themself, the home city, other
truly-dual entities) are *meant* to be referenced by both domains — links to/from
`shared/` are **not** leaks. Only flag work↔life leaks that bypass `shared/`.

### 6. Stray task checkboxes (knowledge-only violation)

The vault is **knowledge-only** — pages must never host task checkboxes. Flag any
`- [ ]` / `- [x]` on any wiki page:

```
grep -rn '^[[:space:]]*- \[[ xX]\]' work/wiki/ life/wiki/ shared/wiki/
```

Each hit is an error: the actionable item belongs on the board (not the vault), and the
checkbox should be removed leaving only the knowledge. (`## Open questions` plain `-`
bullets are fine — those are knowledge gaps, not tasks.)

### 7. Legacy priorities / reminders (must not exist)

This system is knowledge-only and **board-free at the vault layer**. There must be **no**
`priorities.md` and **no** `reminders/` directory anywhere in the vault. Flag any as
**legacy to remove**:

```
find . -name 'priorities.md' -o -type d -name 'reminders' 2>/dev/null
```

Any such file/dir is a leftover from a deprecated flow — its open items belong on the
board, and the file should be deleted. Flag it; never recreate it.

### 8. Contradictions & stale claims (quality)

Read pages that share entities/concepts and flag conflicting claims (opposing facts,
divergent dates/figures) and stale claims (a concept citing only old sources when newer
ones on the same topic exist). These are quality warnings, not structural errors.

## Report Format

Group findings by **domain** (work / life / shared), then by severity:

### Errors (must fix)
- Filename != H1
- Broken `[[wikilinks]]` / index entries pointing to missing pages
- Stray task checkboxes (knowledge-only violation)
- Cross-domain leaks (work↔life bypassing shared)
- Legacy `priorities.md` / `reminders/` present

### Warnings (should fix)
- Orphan pages with no inbound links
- Strong-index gaps (page under no theme; theme that doesn't group multiple concepts)
- Contradictions / stale claims

### Info (nice to fix)
- Missing pages for frequently-referenced topics
- Thin themes / coverage gaps

For each finding: **What** (the issue), **Where** (file + line), **Fix** (what to do).

## After the report

> "Found N errors, N warnings, N info items across work / life / shared. Want me to fix
> any of these?"

This skill **flags**; it does not write the board and does not mutate pages on its own.
Fix wiki-side issues only if the user asks.

## Conventions

- **Per-domain, independent.** Run every check over `work/wiki`, `life/wiki`, and
  `shared/wiki` separately and report by domain.
- **It flags, never writes the board.** No board access; no auto-mutation without consent.
- **`shared/` is the documented cross-domain exception** — links to/from shared entities
  are not leaks.
- **Knowledge-only is enforced** — no task checkboxes, no `priorities.md`, no `reminders/`.
- **Strong index is structural** — every page under exactly one theme; no dangling entries.
