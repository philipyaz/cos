# Changelog

All notable changes to Cos are recorded here. From v0.2.0 on, this file is generated
automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) messages — don't edit released
sections by hand. For the versioning policy and how a release is cut, see
[Releases & versioning](https://philipyaz.github.io/cos/reference/releasing/).

## [0.2.0](https://github.com/philipyaz/cos/compare/v0.1.0...v0.2.0) (2026-06-23)


### Features

* Add-ons framework + Nutrition & Chef add-on (food log, pantry, meal plan, weight loss) ([#17](https://github.com/philipyaz/cos/issues/17)) ([222b2a8](https://github.com/philipyaz/cos/commit/222b2a82ee41a5b29a9f97a2219677c7c22e11ae))
* **board:** unanswered-messages view, MCP tools, and sweep skill ([#16](https://github.com/philipyaz/cos/issues/16)) ([54972da](https://github.com/philipyaz/cos/commit/54972dac7b3dbfa4856a1e72ee31d7608748a1d8))
* unified cross-platform MCP service manifest (supersedes [#22](https://github.com/philipyaz/cos/issues/22)) ([#25](https://github.com/philipyaz/cos/issues/25)) ([10c9423](https://github.com/philipyaz/cos/commit/10c942324f74ba313ba0a59c51067f0f1f6e65e3))
* **whatsapp-triage:** file confirmed appointments to the board calendar ([#37](https://github.com/philipyaz/cos/issues/37)) ([b727945](https://github.com/philipyaz/cos/commit/b727945886ef90af857bea5c01db062d4bda99a6))


### Documentation

* release & versioning docs, community-health files, and control-model accuracy fixes ([#15](https://github.com/philipyaz/cos/issues/15)) ([f5ede89](https://github.com/philipyaz/cos/commit/f5ede893ecff0b9682cb36bf3ccd940b37025303))

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
