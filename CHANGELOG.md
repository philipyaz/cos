# Changelog

All notable changes to Cos are recorded here. From v0.2.0 on, this file is generated
automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) messages — don't edit released
sections by hand. For the versioning policy and how a release is cut, see
[Releases & versioning](https://philipyaz.github.io/cos/reference/releasing/).

## [0.1.0](https://github.com/philipyaz/cos/releases/tag/v0.1.0) (2026-06-13)

First open-source release of Cos — a personal "chief of staff" that lays your work and
personal lives on one board, builds a private interlinked vault, and exposes it all to
agents over MCP.

### Features

* **Board** — a writable kanban store (Next.js + a schema-versioned JSON store) for work + life to-dos, with an append-only `human` / `agent` activity log.
* **Vault** — an interlinked knowledge wiki (the LLM-Wiki pattern) that re-synthesises every source it is fed.
* **Guard** — a fail-closed prompt-injection classifier sidecar (Meta Llama-Prompt-Guard-2-86M, with a heuristic fallback).
* **Search** — on-device semantic search (turbovec + model2vec).
* **MCP** — five core MCP servers (board, calendar, guard, vault, and the bridge) plus WhatsApp and OpenWhispr add-ons, exposing 60+ tools to Claude.
* **Backup** — daily AES-256-GCM encrypted off-site snapshots to a private repo.
* **Docs** — a full Material for MkDocs site published to GitHub Pages.
