# Pantry lifecycle — the class table, the wording guide, and worked judgment calls

Depth for [JOB 0](../SKILL.md)'s lifecycle scoping rule. Read this the first time the status read
surfaces a past-horizon item, or when a stock-take needs the full class table.

## The three classes

`board/lib/nutrition-status.ts`'s `pantryLifecycleClass()` sorts every pantry row into one of three
classes from its stored `category` + `location` — nothing new is captured, nothing is stored:

| Class | Rule | What it means for reconciliation |
|---|---|---|
| **fresh** | `produce`/`dairy`, anything `location: fridge`, or `frozen` category/freezer location | The routine sweep's whole scope — this is what gets asked about |
| **staple** | `pantry`, tinned `protein`/`grain` with no location, and the no-field default | Raised only on an explicit stock-take |
| **spice** | `category: spice` | Never raised unless you mention it or a planned meal needs one |

**Why `protein`/`grain` with no location default to staple, not fresh:** without a location, a
protein row is just as plausibly a tin as a fresh cut — both live protein rows in the real pantry
are tinned. A wrong "fresh" spends the attention this scoping exists to save, so the default leans
conservative. **This is exactly where your judgment is the escape hatch** (see below) — if you know
a specific row is actually fresh, raise it anyway; the classifier's job is a safe default, not the
last word.

## The shelf-life table (fresh class only; conservative on purpose)

| Category | Location | Horizon (days) |
|---|---|---|
| produce | fridge | 7 |
| produce | pantry | 14 |
| dairy | fridge | 10 |
| protein | fridge | 3 |
| grain | fridge | 7 |
| pantry | fridge | 60 (opened jars/sauces kept chilled — long, so they don't nag) |
| other | fridge | 7 |
| *(fresh, no matching row above)* | — | 14 (the default) |

A horizon that fires early costs one glance; one that fires late costs trust — every default above
leans short on purpose. Tuning is a one-line edit in `FRESH_SHELF_LIFE_DAYS`.

## Fact vs. inference — the wording that must never blur

A **read** `expiresAt` is a fact — a date the item actually carries, printed on the pack or stated
by Philip. A **computed horizon** is an inference from typical shelf life for the class — never
persisted, recomputed on every status read, and it never survives a real date: an item with an
`expiresAt` is excluded from `likelyPastHorizon` even when it's old, because the fact path already
owns it.

- **Right:** *"expired 2026-06-30"* (a fact) / *"unverified 15 days, typically past its useful
  life — inferred, no printed date"* (an inference).
- **Wrong:** *"expires in 15 days"*, or any phrasing that lets a computed horizon read as a date the
  item carries. The horizon is a guess about a class of food, not a fact about this row.

## The day-one shape — when everything reads stale together

The first time this ships against a pantry that has gone quiet for a while, expect
`daysSinceLastPantryWrite` and `pantryLifecycle.likelyPastHorizon` to describe the **same
silence**: if nothing has been touched in N days, every fresh row is uniformly N-or-more days old,
so the whole fresh scope reads past-horizon at once. Don't state this as two separate facts —
*"the pantry's been unverified for 15 days, and everything fresh is past its usual shelf life as a
result"* is one clause, not a wall of per-item lines. The MCP render caps itself at the 5 oldest
items for the same reason.

## Worked judgment calls — where the classifier can't see what you can

The classifier only knows `category` and `location`; it can't see freshness a human would notice
at a glance. Your judgment always **extends** the routine scope, never shrinks it:

- **Fresh-baked bread**, stored `grain`/`pantry` (so it classifies **staple**): if you know it's a
  loaf from this week, raise it with the fresh set regardless of its computed class — say so
  plainly (*"the bread's not in the routine scope by category, but it's a few days old — worth
  checking"*).
- **Fresh fish logged with no `location`** (so it defaults **staple**, per the table above): same
  move — if you know it's a fresh cut, not a tin, raise it.
- Never the other direction: don't demote a `fresh`-classed row to skip it because it seems
  unimportant — the classifier's inclusion is the floor, not a suggestion.
