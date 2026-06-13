# Changelog

All notable changes to Cos are recorded here. Every tagged version also has
[auto-generated release notes on GitHub](https://github.com/philipyaz/cos/releases).

## How Cos is versioned

Cos is versioned as a **whole repository** — one git tag and one GitHub release
per version — not per package. (The individual `package.json`/`pyproject.toml`
versions inside the monorepo are internal and may drift; none are published to a
registry.) Releases follow [Semantic Versioning](https://semver.org):

- **MAJOR** (`1.0.0`) — breaking change for operators: a non-back-compatible store
  migration, a config format change requiring action, or removing a feature/server.
- **MINOR** (`0.2.0`) — a new, backward-compatible feature (a new capability, MCP
  tool, or server). **New features land here.**
- **PATCH** (`0.1.1`) — bug fixes, docs, and dependency bumps; no behaviour change.

While Cos is in `0.x`, breaking changes may ride a **minor** bump as the design
settles. The board's store `schemaVersion` is a **separate** axis from the release
version — it migrates on read and is bumped independently when the data shape changes.

This page tracks the format below; the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
conventions (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`) apply.

## [Unreleased]

_Changes merged to `main` but not yet tagged will be listed here._

## [0.1.0] — 2026-06-13

First open-source release of Cos — a personal "chief of staff" that lays your work
and personal lives on one board, builds a private interlinked vault, and exposes it
all to agents over MCP.

### Added

- **Board** — a writable kanban store (Next.js + a schema-versioned JSON store) for
  work + life to-dos, with an append-only `human` / `agent` / `system` activity log.
- **Vault** — an interlinked knowledge wiki (the LLM-Wiki pattern) that re-synthesises
  every source it is fed.
- **Guard** — a fail-closed prompt-injection classifier sidecar (Meta
  Llama-Prompt-Guard-2-86M, with a heuristic fallback).
- **Search** — on-device semantic search (turbovec + model2vec).
- **MCP** — five core MCP servers (board, calendar, guard, vault, and the bridge)
  plus WhatsApp and OpenWhispr add-ons, exposing 60+ tools to Claude.
- **Backup** — daily AES-256-GCM encrypted off-site snapshots to a private repo.
- **Docs** — a full Material for MkDocs site published to GitHub Pages.

[Unreleased]: https://github.com/philipyaz/cos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/philipyaz/cos/releases/tag/v0.1.0
