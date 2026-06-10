---
name: second-brain-query
description: >
  Answer questions against the domain-split knowledge wiki. Read-only. Determine
  the domain (work | life | both), enter through the strong per-domain index,
  follow [[wikilinks]], and answer with [[wikilink]] citations. Also surface any
  associated artifacts (files under raw/assets linked from the cited pages). Use
  when the user asks what they know about something, wants to explore connections
  between topics, or says "what do I know about X". The vault has no board access:
  decline pure open-work / to-do questions.
allowed-tools: Read Glob Grep
---

# Second Brain — Query (knowledge-only, read-only)

Answer questions by searching and synthesizing **knowledge** from the domain-split wiki.
This skill is **read-only** — it never writes, edits, or runs commands. It also has **no
board access**: it answers from knowledge, not from open work.

## CORE LOOP

### 1. Determine the domain — work | life | both

From the question, decide which wiki tree(s) to search:

- **work** — the venture, the role, advisory, work contacts/projects → `work/wiki`.
- **life** — trips, health, admin, family, personal logistics → `life/wiki`.
- **both** — a question that spans the two (the user themself, the home city, anything
  touching `shared/wiki` entities, or an explicitly cross-cutting question) → search
  `work/wiki` **and** `life/wiki`, plus `shared/wiki`.

When unsure, prefer **both** and let the index tell you which side actually has the answer.

### 2. Enter through the strong index

Read `<domain>/wiki/index.md` — the **strong index is the entry point**. It is a map of
overarching **themes**, each grouping its concepts, entities, and sources. Find the
theme(s) relevant to the question and the specific `[[pages]]` listed under them. The
index, not a directory scan, is how you locate the right pages fast.

### 3. Follow the [[wikilinks]]

Read the pages the index points you to, then **follow their `[[wikilinks]]`** to pull in
related context (linked entities, concepts, and source pages). Read enough to answer
thoroughly — but don't read the whole wiki. If the wiki pages don't fully answer, drop to
the relevant `<domain>/wiki/sources/` pages for detail; go to `raw/` only as a last resort.

### 4. Surface associated artifacts (CRUCIAL)

For the pages you cite, **also surface any associated artifacts** — files under
`raw/assets/` linked from those pages (the source pages reference preserved attachments via
relative markdown links like `../../raw/assets/<file>`). **List their paths** in your
answer so the user can retrieve the original artifact, not just the synthesized text. If a
cited page links an asset, name it.

### 5. Synthesize the answer with [[wikilink]] citations

Match the format to the question — direct answer for a fact; a table for a comparison; a
narrative for an exploration; a bulleted catalog for a list. **Every factual claim cites
the wiki page it came from** via `[[wikilink]]` syntax, e.g.:

> According to [[Region Travel Guide]], the dry season runs Dec–Apr. This connects to
> [[Big Trip 2026]], which [[Jane Doe]] advised on. Associated artifact:
> `raw/assets/2026-05-12-region-travel-guide.pdf`.

## Declining open-work / to-do questions

The vault is **knowledge-only** and this skill has **no board access**. For a **purely**
open-work / to-do question — "what's open?", "what are my to-dos?", "what's waiting on the
client?", "what's overdue?", "what's open with [Person]?" — do **not** fabricate an answer
from the wiki. Decline with a single line, e.g.:

> The board owns open work and to-dos — the vault has no access to that surface. I can tell
> you what's *known* about [topic] from the wiki, though.

Then, if there's a knowledge angle (context on the person/project), answer **that** part
from the wiki. Mixed questions ("what's the latest with [Person]?") get the **context**
from the wiki with the one-line note that current open work lives on the board.

## Conventions

- **Read-only.** Never write, edit, or run commands. No `raw/assets` copies, no page edits.
- **Strong index is the entry point.** Start there, not with a directory scan.
- **Follow `[[wikilinks]]`** to gather context; cite every claim with a `[[wikilink]]`.
- **Always surface associated artifacts** — list the `raw/assets/` paths linked from the
  pages you cite.
- **Decline pure open-work questions** with the one-line board note; the vault has no board.
- **Domain-aware.** Pick work / life / both up front; use `shared/wiki` for dual entities.
- Use `[[wikilinks]]` for all internal references. Never raw file paths.
