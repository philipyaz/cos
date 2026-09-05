# Changelog

All notable changes to Cos are recorded here. From v0.2.0 on, this file is generated
automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) messages — don't edit released
sections by hand. For the versioning policy and how a release is cut, see
[Releases & versioning](https://philipyaz.github.io/cos/reference/releasing/).

## [0.2.0](https://github.com/philipyaz/cos/compare/v0.1.0...v0.2.0) (2026-09-05)


### Features

* Add-ons framework + Nutrition & Chef add-on (food log, pantry, meal plan, weight loss) ([#17](https://github.com/philipyaz/cos/issues/17)) ([222b2a8](https://github.com/philipyaz/cos/commit/222b2a82ee41a5b29a9f97a2219677c7c22e11ae))
* **agents:** architect subagent for architectural coherence ([#69](https://github.com/philipyaz/cos/issues/69)) ([183e1da](https://github.com/philipyaz/cos/commit/183e1da1d9b976573212c442051743c062a001d7))
* **board:** aging rank for starving obligations + board-placed chase blocks + the board-organize staleness lens (cos-ops[#24](https://github.com/philipyaz/cos/issues/24)) ([#93](https://github.com/philipyaz/cos/issues/93)) ([99f4d45](https://github.com/philipyaz/cos/commit/99f4d459bac1d02d6daccc250046dddd1c1afbef))
* **board:** completed tasks collapse behind a disclosure in the case drawer (cos-ops[#52](https://github.com/philipyaz/cos/issues/52)) ([#129](https://github.com/philipyaz/cos/issues/129)) ([9feeaa3](https://github.com/philipyaz/cos/commit/9feeaa3f43196f9e4262a3ebb38208b106bf802b))
* **board:** fail-closed schema guard — refuse writes when the store is newer than the code ([#47](https://github.com/philipyaz/cos/issues/47)) ([6fc9a05](https://github.com/philipyaz/cos/commit/6fc9a057932c55fedd2a6a29a6ffccf07958d5ad))
* **board:** idempotent overlap-safe calendar placement for training + meal plans ([#17](https://github.com/philipyaz/cos/issues/17), [#25](https://github.com/philipyaz/cos/issues/25)) ([#81](https://github.com/philipyaz/cos/issues/81)) ([307e2f7](https://github.com/philipyaz/cos/commit/307e2f73a39a0c906be5ac868fad2a387ce18832))
* **board:** list the open-task set — selectTasks, GET /api/tasks, list_tasks, /tasks page ([#130](https://github.com/philipyaz/cos/issues/130)) ([d558617](https://github.com/philipyaz/cos/commit/d558617518efd8690180490f146908a508508530))
* **board:** name the staleness vocabulary + expose needs-attention over API/MCP ([#82](https://github.com/philipyaz/cos/issues/82)) ([d45d8bf](https://github.com/philipyaz/cos/commit/d45d8bf967210996c606e10483bb26339a095409))
* **board:** per-case vault ingest receipts + coverage read (schema v15) ([#76](https://github.com/philipyaz/cos/issues/76)) ([278c264](https://github.com/philipyaz/cos/commit/278c26405fa8a4cca469639d71704968e7384e00))
* **board:** the mail-triage drop leaves a decision record — reversible, digest-reviewed, computed on read (cos-ops[#41](https://github.com/philipyaz/cos/issues/41)) ([#100](https://github.com/philipyaz/cos/issues/100)) ([069d956](https://github.com/philipyaz/cos/commit/069d956ccaae92ebf1448cf7ef2db9d59e8b5ea2))
* **board:** unanswered-messages view, MCP tools, and sweep skill ([#16](https://github.com/philipyaz/cos/issues/16)) ([54972da](https://github.com/philipyaz/cos/commit/54972dac7b3dbfa4856a1e72ee31d7608748a1d8))
* **fitness,nutrition:** calendar-receipt coverage + close-out reminder deposits (cos-ops[#66](https://github.com/philipyaz/cos/issues/66), cos-ops[#67](https://github.com/philipyaz/cos/issues/67)) ([#141](https://github.com/philipyaz/cos/issues/141)) ([ab5a22a](https://github.com/philipyaz/cos/commit/ab5a22aa8e1051d9a1d3a8d53dc9aa00a3f7a742))
* **fitness:** Fitness add-on — framework-native, stateful & agent-native (API/MCP + skills) ([#24](https://github.com/philipyaz/cos/issues/24)) ([b2b7f5e](https://github.com/philipyaz/cos/commit/b2b7f5ea65e6aeb5072eebaa0e40d71da8419372))
* **fitness:** per-day training-plan outcomes — targeted write, computed drift, UI + daily/weekly close-outs (cos-ops[#19](https://github.com/philipyaz/cos/issues/19)) ([#94](https://github.com/philipyaz/cos/issues/94)) ([7ce3b0b](https://github.com/philipyaz/cos/commit/7ce3b0b35c5a69dd2ae6ea4af7c4ae2f38466d23))
* **guard:** wire classify_text into its first two callers (cos-ops[#26](https://github.com/philipyaz/cos/issues/26)) ([#126](https://github.com/philipyaz/cos/issues/126)) ([8d48055](https://github.com/philipyaz/cos/commit/8d48055e4f262ef6b796717d04e2b327489185b9))
* **multi-device:** backup hardening (PR 2) + device identity & roles (PR 3) ([#48](https://github.com/philipyaz/cos/issues/48)) ([1d1f97e](https://github.com/philipyaz/cos/commit/1d1f97ef8bd8fd7de64657916fa915c8310cd603))
* **multi-device:** hub-handover skill + backup --claim takeover + docs pass (PR 5) ([#53](https://github.com/philipyaz/cos/issues/53)) ([160a38b](https://github.com/philipyaz/cos/commit/160a38b03a23914d914eec4e65320acfdfff921f))
* **multi-device:** spoke onboarding + Devices surface (PR 4) ([#52](https://github.com/philipyaz/cos/issues/52)) ([ca095a4](https://github.com/philipyaz/cos/commit/ca095a4934b1166a15a23caeea0ed609e588347c))
* **nutrition:** lifecycle-scoped reconciliation + a computed freshness horizon; JOB 0 consumes every status signal (cos-ops[#18](https://github.com/philipyaz/cos/issues/18)) ([#84](https://github.com/philipyaz/cos/issues/84)) ([b34c719](https://github.com/philipyaz/cos/commit/b34c71958ba2f67ac8ea1dafe4e9e7836ce97c89))
* **nutrition:** meal-plan reconciliation + bulk pantry reconcile in /nutrition-chef ([#72](https://github.com/philipyaz/cos/issues/72)) ([af83690](https://github.com/philipyaz/cos/commit/af8369011fdedccc1bff1676206fb765520c4b2b))
* **nutrition:** the persistent shopping list — state, computed candidates, both surfaces, JOB 6 (cos-ops[#37](https://github.com/philipyaz/cos/issues/37)) ([#98](https://github.com/philipyaz/cos/issues/98)) ([2277563](https://github.com/philipyaz/cos/commit/22775636435cd8c21cf5b855e9591dcadae8ef2d))
* **nutrition:** the shopping-list board surface — /nutrition/shopping (cos-ops[#38](https://github.com/philipyaz/cos/issues/38)) ([#123](https://github.com/philipyaz/cos/issues/123)) ([bd536ca](https://github.com/philipyaz/cos/commit/bd536ca77d290ec856cbfc3924bf19611387f425))
* **skills:** cos-setup sequences fitness + body add-on setup; setupSkill gets its first code consumer ([#99](https://github.com/philipyaz/cos/issues/99)) ([6247a39](https://github.com/philipyaz/cos/commit/6247a39752405634ded842c7ddee2258a60ccbb7))
* **skills:** every operator skill declares its automation class; the catalog is generated (cos-ops[#21](https://github.com/philipyaz/cos/issues/21)) ([#83](https://github.com/philipyaz/cos/issues/83)) ([a081a89](https://github.com/philipyaz/cos/commit/a081a89f21ae2fae7956981617824b1b226f857d))
* **skills:** package Cowork skills as per-skill .zip bundles + a local CLAUDE.md ([#66](https://github.com/philipyaz/cos/issues/66)) ([86889c3](https://github.com/philipyaz/cos/commit/86889c3bba5d53868b72aa2861e8e74beff5c235))
* **skills:** reminder intake gate (five-tests) + reminders-review janitor + mail-to-board refactor ([#44](https://github.com/philipyaz/cos/issues/44)) ([7f5459c](https://github.com/philipyaz/cos/commit/7f5459ceb340291af3a18e2ca5cb457684072547))
* **skills:** the two bundle-upload paths record their upload receipt ([#145](https://github.com/philipyaz/cos/issues/145)) ([2862102](https://github.com/philipyaz/cos/commit/28621024ba5ee95ff24e1691c65826157ebae5db))
* unified cross-platform MCP service manifest (supersedes [#22](https://github.com/philipyaz/cos/issues/22)) ([#25](https://github.com/philipyaz/cos/issues/25)) ([10c9423](https://github.com/philipyaz/cos/commit/10c942324f74ba313ba0a59c51067f0f1f6e65e3))
* **upgrade:** cos-upgrade skill + scripts/upgrade-check.mjs — the deterministic post-pull checklist for existing installs ([#115](https://github.com/philipyaz/cos/issues/115)) ([dc91464](https://github.com/philipyaz/cos/commit/dc914649098842324289284b73c9b59aee148d50))
* **whatsapp-triage:** capture explicit purchase statements onto the shopping list (cos-ops[#39](https://github.com/philipyaz/cos/issues/39)) ([#124](https://github.com/philipyaz/cos/issues/124)) ([23f0c76](https://github.com/philipyaz/cos/commit/23f0c76388b391c09346943ad4778b57011faf50))
* **whatsapp-triage:** file confirmed appointments to the board calendar ([#37](https://github.com/philipyaz/cos/issues/37)) ([b727945](https://github.com/philipyaz/cos/commit/b727945886ef90af857bea5c01db062d4bda99a6))


### Bug Fixes

* **boardapp:** deploy only main, notice main moving, install when the lockfile moved (cos-ops[#63](https://github.com/philipyaz/cos/issues/63)) ([#135](https://github.com/philipyaz/cos/issues/135)) ([6d37cf8](https://github.com/philipyaz/cos/commit/6d37cf8b50b87e1f7a17d21846fc81f2295250e3))
* **board:** completedAt gets one owner at task birth ([#142](https://github.com/philipyaz/cos/issues/142)) ([95a3646](https://github.com/philipyaz/cos/commit/95a36469f83c3a0d219e1ab4e5014fc8c5ac908a))
* **board:** fix the phone path — dvh viewport + mobile navigation ([#75](https://github.com/philipyaz/cos/issues/75)) ([139b7f6](https://github.com/philipyaz/cos/commit/139b7f6b9bf33a60478e3885a6f55c94cbc04739))
* **board:** reminders-review reports the zero-drops ledger anomaly instead of "nothing new" ([#143](https://github.com/philipyaz/cos/issues/143)) ([36f9eea](https://github.com/philipyaz/cos/commit/36f9eea3c6f284ce9b9801b899b0f0ef953d6095))
* **deps:** bump nanoid past the self-retired Dependabot alert (cos-ops[#73](https://github.com/philipyaz/cos/issues/73)) ([#144](https://github.com/philipyaz/cos/issues/144)) ([7ad6213](https://github.com/philipyaz/cos/commit/7ad62135779565fbc3dde5db545915257115eb07))
* **gen-launchd:** verify every launchctl load before claiming success ([#131](https://github.com/philipyaz/cos/issues/131)) ([38235a7](https://github.com/philipyaz/cos/commit/38235a724f54f1d1775e5d8195ca157daed7a7b1))
* **multi-device:** green the hub verifier and pin the device/backup mirror sites (cos-ops[#33](https://github.com/philipyaz/cos/issues/33), cos-ops[#45](https://github.com/philipyaz/cos/issues/45)) ([#125](https://github.com/philipyaz/cos/issues/125)) ([459440c](https://github.com/philipyaz/cos/commit/459440ca80cff25bea352ad730c816ea282c0aa1))
* **setup:** refuse to snapshot a placeholder secret into the Cowork MCP config ([#70](https://github.com/philipyaz/cos/issues/70)) ([ebb5363](https://github.com/philipyaz/cos/commit/ebb5363b2da2223ab4dd097f14f7e66a5cc5edfe))
* **skills:** make /vault-operations the one reachable vault procedure for the capture sweeps ([#71](https://github.com/philipyaz/cos/issues/71)) ([c8f17c4](https://github.com/philipyaz/cos/commit/c8f17c4fa190e2a33214110ad371f9087490ed99))
* **skills:** make every SKILL.md description load (&lt;=1024 chars, no XML tags) ([#77](https://github.com/philipyaz/cos/issues/77)) ([07e3ae9](https://github.com/philipyaz/cos/commit/07e3ae9c71887d2d40d5bc33b20b10276120bfd0))
* **tests:** every api-* step targets the sandbox store — export COS_BOARD_DATA once the test board is up ([#114](https://github.com/philipyaz/cos/issues/114)) ([cf6414a](https://github.com/philipyaz/cos/commit/cf6414a45be9ba316f6c5286a74f0045229f99f0))
* **vault:** forbid unverifiable board assertions in query answers (guardrail + hard gate) ([#73](https://github.com/philipyaz/cos/issues/73)) ([95e45ab](https://github.com/philipyaz/cos/commit/95e45abb044e2d216329223e3f862f4f1d9c3e1a))


### Documentation

* **claude:** a local run.sh result is not evidence about a PR — read CI ([#106](https://github.com/philipyaz/cos/issues/106)) ([8704ef7](https://github.com/philipyaz/cos/commit/8704ef706d8d383b18033a89819ecd54e4d42b30))
* **claude:** a red pack-skills --check after a merge means rebuild the bundle ([#92](https://github.com/philipyaz/cos/issues/92)) ([8f07546](https://github.com/philipyaz/cos/commit/8f07546e3bf87bc28a2e0dd980c31ca78c53d578))
* **claude:** drop the gen-roles known-red carve-out; state the machine-local-state rule instead ([#128](https://github.com/philipyaz/cos/issues/128)) ([509da8b](https://github.com/philipyaz/cos/commit/509da8be7c6cf57804e9ba22685dc903b2a32900))
* **claude:** rebuilding a skill bundle does not install it in Cowork ([#79](https://github.com/philipyaz/cos/issues/79)) ([becfee4](https://github.com/philipyaz/cos/commit/becfee4123217d3cda93bf7ba175353445990a05))
* **claude:** state the two skill trees and which runtime loads each ([#74](https://github.com/philipyaz/cos/issues/74)) ([a5a117b](https://github.com/philipyaz/cos/commit/a5a117bfcb908463816f310373a46003be5bbee7))
* refresh root CLAUDE.md into an operational brief; fix stale docs/CONTRIBUTING claims ([#50](https://github.com/philipyaz/cos/issues/50)) ([a70bd8e](https://github.com/philipyaz/cos/commit/a70bd8ea35da52a3ee9ea21765dba7320f25e1f2))
* release & versioning docs, community-health files, and control-model accuracy fixes ([#15](https://github.com/philipyaz/cos/issues/15)) ([f5ede89](https://github.com/philipyaz/cos/commit/f5ede893ecff0b9682cb36bf3ccd940b37025303))
* **releasing:** tell the truth about Release-PR CI (no owner bypass) and gate the claim ([#85](https://github.com/philipyaz/cos/issues/85)) ([6123b89](https://github.com/philipyaz/cos/commit/6123b893ef4b3db740024cf8dc7ff15a18a734f8))

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
