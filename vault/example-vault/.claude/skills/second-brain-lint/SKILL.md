---
name: second-brain-lint
description: >
  Scheduled integrity pass over the domain-split knowledge wiki. Runs over
  work/wiki, life/wiki, and shared/wiki independently and flags: filename != H1,
  broken [[wikilinks]], orphan pages, strong-index integrity gaps, cross-domain
  leaks, stray task checkboxes (knowledge-only violations), bloat / fragmentation
  (merge-or-prune candidates), and legacy priorities.md / reminders/ that should
  not exist. Auto-fixes the safe, deterministic issues and proposes the rest;
  never writes the board. Use when the user says "audit", "health
  check", "lint", "find problems", or on a schedule.
allowed-tools: Read Glob Grep Edit Write
---

# Second Brain — Lint (knowledge integrity pass)

A **scheduled integrity pass** over the domain-split wiki. This is **not** an MCP route —
it is a periodic health check. It runs over the three wiki trees — `work/wiki`,
`life/wiki`, and `shared/wiki` — **independently**, and reports issues with actionable
fixes. The vault is **knowledge-only**: this lint never writes the board (it has no board
access). It **auto-fixes the safe, deterministic issues** itself and **proposes** the
judgment or destructive ones — see the auto-fix policy below.

Run every check below for **each** domain tree, applying the safe auto-fixes as you go, then
present one consolidated report (grouped by domain and severity) that separates what was
**auto-fixed** from what is **proposed**.

## Auto-fix policy — repair the safe, propose the rest

Lint does not just flag; it **fixes what is safe to fix automatically** and **proposes**
everything that needs judgment. Two tiers:

**AUTO-FIX (apply the edit, then record it in the report)** — only when the repair is
*deterministic and unambiguous*:

- **Filename ≠ H1** → rewrite the H1 to match the filename (the filename is what
  `[[wikilinks]]` resolve to, so it is canonical).
- **Broken `[[wikilink]]` with a single unambiguous target** → repoint it via an exact
  `aliases.md` mapping or a one-to-one rename (e.g. `[[Jane]]` → `[[Jane Doe]]`). If the
  link is a same-page section reference that — per the *reinforce-before-spawn* doctrine —
  should not get its own page, **de-link** it to plain text instead.
- **A genuinely homeless page** → add it to the index under `## Unfiled` (additive, never
  lossy). Choosing its *real* theme is a proposal, not an auto-fix.

**PROPOSE ONLY (never auto-apply — describe the fix, leave the page untouched)** — anything
destructive, lossy, or a judgment call:

- **Bloat merges / prunes** (Check 9), page deletions, folding one page into another.
- **Contradictions / stale claims** (Check 8) — re-synthesis is a judgment rewrite.
- **Cross-domain moves**, orphan resolution, and strong-index *theme placement*.
- **Stray task checkboxes** — these signal an item that belongs on the **board**; lint has
  no board access, so it flags the item for routing rather than silently deleting the action.
- **Legacy `priorities.md` / `reminders/`** — flag for removal; never delete unread.

**Discipline:** when a fix is the least bit ambiguous, *flag it, don't guess*. Record every
auto-fix in the report (What / Where / the edit applied) so it is reviewable — `git` history
makes each one reversible. Auto-fix is bounded to the wiki: lint still **never** writes the
board, deletes a page, or merges pages on its own.

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

**Ignore `[[links]]` inside code spans or fenced code blocks** — a literal `` `[[wikilinks]]` ``
written as an example is not a live link, so not broken. **`log.md` is append-only history:**
auto-fix a renamed entity (e.g. `[[Jane]]` → `[[Jane Doe]]`), but don't rewrite the
substance of a past entry; a link to a deliberately-deleted page may be left or de-linked,
not recreated. **Auto-fix** a broken link only when the target is unambiguous (an `aliases.md`
mapping or a one-to-one rename), or de-link a same-page section reference with no page of its
own; flag anything ambiguous rather than guessing.

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

### 9. Bloat & fragmentation (selectivity, not completeness)

The vault is **selective** — a lean, high-signal wiki is the health target, and bloat is as
much a defect as a gap. Flag the following as **merge / prune candidates**, judged by *lack
of value* and **never** by a page merely being short (a brief page that is heavily
inbound-linked is *dense*, not a stub — measure inbound links with
`grep -rl '\[\[Title\]\]' <domain>/wiki/ | wc -l`, and never flag on length alone):

- **Pages nothing leans on** — zero inbound `[[wikilinks]]`, not named in the strong index,
  and not referenced by any `cases:`. Candidate to merge into a parent page or retire.
- **Mutual-definition stub clusters** — thin pages that mostly define each other ("A is the
  counterpart to B", "B is a sibling of A") or share most of their links / sources. These
  are facets of **one** page — candidate to merge into a single page with `## Sections`.
- **One-mention residue** — a page that appears in exactly one source's frontmatter, was
  never re-synthesized (`created` == `updated`, single source), and that nothing references.
  The classic "documented everything" leftover — candidate to fold into context elsewhere.

Surface the top few candidates by thinness / staleness; **flag only**, never delete. Every
proposed merge must re-assert the cross-domain (check 5) and checkbox (check 6) checks on
the surviving page, so consolidation never crosses domains or drags in actionable state.

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
- **Bloat / fragmentation** — pages nothing leans on, mutual-definition stub clusters, one-mention residue (merge or prune candidates)
- Strong-index gaps (page under no theme; theme that doesn't group multiple concepts)
- Contradictions / stale claims

### Info (nice to fix)
- A genuinely missing page for a topic referenced by **multiple** sources — only when the gap actually costs clarity, not a nudge toward more coverage

For each finding: **What** (the issue), **Where** (file + line), **Fix** (what to do).

## After the report

Separate what was **auto-fixed** from what is **proposed**, e.g.:

> "Auto-fixed N safe issues (filename≠H1, unambiguous broken links / de-links) across work /
> life / shared — listed below. Proposing M more that need a judgment call (merges / prunes,
> contradictions, checkbox routing). Want me to apply any of the proposals?"

Lint applies the safe auto-fixes itself (and lists each one: What / Where / the edit applied);
it leaves the propose-tier untouched until the user okays it. It never writes the board, and
never deletes or merges a page on its own.

## Conventions

- **Per-domain, independent.** Run every check over `work/wiki`, `life/wiki`, and
  `shared/wiki` separately and report by domain.
- **Auto-fixes the safe, proposes the rest.** Applies deterministic repairs (filename ≠ H1, unambiguous broken-link repair / de-link, homeless-page → `## Unfiled`) and records each; everything destructive or judgment-laden (merges, prunes, contradictions, checkbox routing, cross-domain moves) is proposed, not applied. Never writes the board; never deletes or merges a page on its own; when ambiguous, **flag, don't guess**.
- **`shared/` is the documented cross-domain exception** — links to/from shared entities
  are not leaks.
- **Knowledge-only is enforced** — no task checkboxes, no `priorities.md`, no `reminders/`.
- **Strong index is structural** — every page under exactly one theme; no dangling entries.
- **Flag bloat, not just gaps.** A lean, high-signal wiki is the health target — surface pages nothing leans on and mutual-definition stub clusters as merge / prune candidates, and don't nudge toward more coverage. **Never** flag a page for being short: a brief, densely inbound-linked page is signal, not a stub. Lint flags; it never deletes.
