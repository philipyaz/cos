# Cos — your chief of staff

**Stop being the router between your inbox and your to-do list — Cos reads the noise so you
only see what actually needs you.**

> The persistent memory and judgment layer your agentic OS lacks — owned by you.

Cos is a personal *chief of staff*: a writable **board** for work + life to-dos, a knowledge
**vault** (the LLM-Wiki pattern), a fail-closed prompt-injection **guard**, semantic **search**,
and the **MCP servers** that expose it all to your agents. This site is the deep-dive
documentation; the [README on GitHub](https://github.com/philipyaz/cos) is the
quickstart.

## The two pillars

```
            voice · email · calendar
                       │
              ┌────────▼────────┐
              │  Claude Cowork  │   the operator — classify & route
              │   (the agent)   │
              └───┬─────────┬───┘
       knowledge  │         │  action
        ┌─────────▼──┐   ┌──▼──────────┐
        │   VAULT    │◄─►│    BOARD    │
        │ second     │   │  kanban of  │
        │ brain      │   │ what's left │
        └────────────┘   └─────────────┘
          GUARD (fail-closed)  ·  SEARCH (semantic)  ·  MCP (exposes it all)
```

## Explore the docs

<div class="grid cards" markdown>

-   :material-sitemap:{ .lg .middle } __Architecture__

    ---

    The system spec and the Initiative → Workstream → Case hierarchy that organizes everything.

    [:octicons-arrow-right-24: Spec](architecture/spec.md) ·
    [Hierarchy](architecture/hierarchy.md)

-   :material-view-dashboard:{ .lg .middle } __Features__

    ---

    The writable board, plus Calendar, Reminders, the Activity feed, and Priorities.

    [:octicons-arrow-right-24: Board](features/board.md) ·
    [Calendar](features/calendar.md) ·
    [Reminders](features/reminders.md)

-   :material-shield-lock:{ .lg .middle } __Security__

    ---

    The Guard: a fail-closed prompt-injection scanner that reads untrusted mail *before* the
    agent does.

    [:octicons-arrow-right-24: Guard](security/guard.md)

-   :material-book-open-variant:{ .lg .middle } __Reference__

    ---

    Semantic search, the configurable label taxonomy, and the consolidation/migration notes.

    [:octicons-arrow-right-24: Search](reference/search.md) ·
    [Labels](reference/labels.md) ·
    [Migration](reference/migration.md)

</div>

## Principles

- **Local-first & private.** Your email, voice notes, and second brain stay on your machine —
  local files, gitignored, never committed.
- **The Guard fails closed.** Untrusted mail is scanned for prompt injection *before* any agent
  reads it; a down scanner treats content as untrusted, never a false all-clear.
- **Human-in-the-loop.** The agent **proposes, you approve** — outward actions go through a board
  approval queue, and the audit trail attributes every write to `human` or `agent`.

!!! tip "Contributing to the docs"
    These pages are an [MkDocs](https://www.mkdocs.org/) site
    ([Material theme](https://squidfunk.github.io/mkdocs-material/)) under `docs/`, published to
    GitHub Pages on every push to `main`. To add or change a page, edit the Markdown under `docs/`
    and wire it into the `nav:` in `mkdocs.yml` — don't drop loose Markdown files at the repo root.
    Preview locally with `uvx --with mkdocs-material mkdocs serve`.
