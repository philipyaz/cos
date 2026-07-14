# Changelog

All notable changes to Cos are recorded here. From v0.2.0 on, this file is generated
automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) messages — don't edit released
sections by hand. For the versioning policy and how a release is cut, see
[Releases & versioning](https://philipyaz.github.io/cos/reference/releasing/).

## [0.2.0](https://github.com/philipyaz/cos/compare/v0.1.0...v0.2.0) (2026-07-14)


### Features

* Add-ons framework + Nutrition & Chef add-on (food log, pantry, meal plan, weight loss) ([#17](https://github.com/philipyaz/cos/issues/17)) ([222b2a8](https://github.com/philipyaz/cos/commit/222b2a82ee41a5b29a9f97a2219677c7c22e11ae))
* **board:** fail-closed schema guard — refuse writes when the store is newer than the code ([#47](https://github.com/philipyaz/cos/issues/47)) ([6fc9a05](https://github.com/philipyaz/cos/commit/6fc9a057932c55fedd2a6a29a6ffccf07958d5ad))
* **board:** unanswered-messages view, MCP tools, and sweep skill ([#16](https://github.com/philipyaz/cos/issues/16)) ([54972da](https://github.com/philipyaz/cos/commit/54972dac7b3dbfa4856a1e72ee31d7608748a1d8))
* **fitness:** Fitness add-on — framework-native, stateful & agent-native (API/MCP + skills) ([#24](https://github.com/philipyaz/cos/issues/24)) ([b2b7f5e](https://github.com/philipyaz/cos/commit/b2b7f5ea65e6aeb5072eebaa0e40d71da8419372))
* **multi-device:** backup hardening (PR 2) + device identity & roles (PR 3) ([#48](https://github.com/philipyaz/cos/issues/48)) ([1d1f97e](https://github.com/philipyaz/cos/commit/1d1f97ef8bd8fd7de64657916fa915c8310cd603))
* **skills:** reminder intake gate (five-tests) + reminders-review janitor + mail-to-board refactor ([#44](https://github.com/philipyaz/cos/issues/44)) ([7f5459c](https://github.com/philipyaz/cos/commit/7f5459ceb340291af3a18e2ca5cb457684072547))
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
