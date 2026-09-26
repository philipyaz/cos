# Changelog

All notable changes to Cos are recorded here. From v0.2.0 on, this file is generated
automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) messages — don't edit released
sections by hand. For the versioning policy and how a release is cut, see
[Releases & versioning](https://philipyaz.github.io/cos/reference/releasing/).

## [0.2.0](https://github.com/philipyaz/cos/compare/v0.1.0...v0.2.0) (2026-09-26)


### Features

* Add-ons framework + Nutrition & Chef add-on (food log, pantry, meal plan, weight loss) ([#17](https://github.com/philipyaz/cos/issues/17)) ([222b2a8](https://github.com/philipyaz/cos/commit/222b2a82ee41a5b29a9f97a2219677c7c22e11ae))
* **agents:** architect subagent for architectural coherence ([#69](https://github.com/philipyaz/cos/issues/69)) ([183e1da](https://github.com/philipyaz/cos/commit/183e1da1d9b976573212c442051743c062a001d7))
* **board:** aging rank for starving obligations + board-placed chase blocks + the board-organize staleness lens (cos-ops[#24](https://github.com/philipyaz/cos/issues/24)) ([#93](https://github.com/philipyaz/cos/issues/93)) ([99f4d45](https://github.com/philipyaz/cos/commit/99f4d459bac1d02d6daccc250046dddd1c1afbef))
* **board:** completed tasks collapse behind a disclosure in the case drawer (cos-ops[#52](https://github.com/philipyaz/cos/issues/52)) ([#129](https://github.com/philipyaz/cos/issues/129)) ([9feeaa3](https://github.com/philipyaz/cos/commit/9feeaa3f43196f9e4262a3ebb38208b106bf802b))
* **board:** consolidate the 24 rose error banners into shared/alert.tsx — explicit dismissibility, 44px dismiss ([#158](https://github.com/philipyaz/cos/issues/158)) ([c17d486](https://github.com/philipyaz/cos/commit/c17d486827f984d0c7aaa5976b78697928cda7e5))
* **board:** consolidate the nine drawer shells into shared/drawer.tsx — 44px coarse-pointer Close ([#156](https://github.com/philipyaz/cos/issues/156)) ([d2fafdf](https://github.com/philipyaz/cos/commit/d2fafdfcce14dec99b22142b54bc695c1c0b3ea1))
* **board:** fail-closed schema guard — refuse writes when the store is newer than the code ([#47](https://github.com/philipyaz/cos/issues/47)) ([6fc9a05](https://github.com/philipyaz/cos/commit/6fc9a057932c55fedd2a6a29a6ffccf07958d5ad))
* **board:** idempotent overlap-safe calendar placement for training + meal plans ([#17](https://github.com/philipyaz/cos/issues/17), [#25](https://github.com/philipyaz/cos/issues/25)) ([#81](https://github.com/philipyaz/cos/issues/81)) ([307e2f7](https://github.com/philipyaz/cos/commit/307e2f73a39a0c906be5ac868fad2a387ce18832))
* **board:** list the open-task set — selectTasks, GET /api/tasks, list_tasks, /tasks page ([#130](https://github.com/philipyaz/cos/issues/130)) ([d558617](https://github.com/philipyaz/cos/commit/d558617518efd8690180490f146908a508508530))
* **board:** name the staleness vocabulary + expose needs-attention over API/MCP ([#82](https://github.com/philipyaz/cos/issues/82)) ([d45d8bf](https://github.com/philipyaz/cos/commit/d45d8bf967210996c606e10483bb26339a095409))
* **board:** one history entry per full-screen detail view (cos-ops[#107](https://github.com/philipyaz/cos/issues/107)) ([#174](https://github.com/philipyaz/cos/issues/174)) ([b9a7ee3](https://github.com/philipyaz/cos/commit/b9a7ee3684e02d80f238cfedb4be8f06faa413cb))
* **board:** pending-approvals tray, tab-bar badge, bulk age-threshold reject (cos-ops[#136](https://github.com/philipyaz/cos/issues/136)) ([#194](https://github.com/philipyaz/cos/issues/194)) ([77fc348](https://github.com/philipyaz/cos/commit/77fc34838cdb8d3747a8800664eea7b26a560392))
* **board:** per-case vault ingest receipts + coverage read (schema v15) ([#76](https://github.com/philipyaz/cos/issues/76)) ([278c264](https://github.com/philipyaz/cos/commit/278c26405fa8a4cca469639d71704968e7384e00))
* **board:** secondary + destructive action primitives — coarse-pointer visibility for hidden controls ([#154](https://github.com/philipyaz/cos/issues/154)) ([db7a9cb](https://github.com/philipyaz/cos/commit/db7a9cbe1867c3613b56931bff009dbc22176229))
* **board:** shared field + action-button primitives — 16px controls, 44px touch targets, press states ([#151](https://github.com/philipyaz/cos/issues/151)) ([9abd43a](https://github.com/philipyaz/cos/commit/9abd43a31e8451f6185c5f079a1c504dd655c587))
* **board:** the mail-triage drop leaves a decision record — reversible, digest-reviewed, computed on read (cos-ops[#41](https://github.com/philipyaz/cos/issues/41)) ([#100](https://github.com/philipyaz/cos/issues/100)) ([069d956](https://github.com/philipyaz/cos/commit/069d956ccaae92ebf1448cf7ef2db9d59e8b5ea2))
* **board:** unanswered-messages view, MCP tools, and sweep skill ([#16](https://github.com/philipyaz/cos/issues/16)) ([54972da](https://github.com/philipyaz/cos/commit/54972dac7b3dbfa4856a1e72ee31d7608748a1d8))
* **devices:** report Cowork installed-skill drift on the Devices surface ([#189](https://github.com/philipyaz/cos/issues/189)) ([17f2ab7](https://github.com/philipyaz/cos/commit/17f2ab7b748e33cda1bbe98b648dbaf82cb8bd85))
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
* **vault:** make the example-vault template the source of record for vault doctrine ([#150](https://github.com/philipyaz/cos/issues/150)) ([dd85bcb](https://github.com/philipyaz/cos/commit/dd85bcbdd877295a5c36e4d4a561a414d72bd6f8))
* **whatsapp-triage:** capture explicit purchase statements onto the shopping list (cos-ops[#39](https://github.com/philipyaz/cos/issues/39)) ([#124](https://github.com/philipyaz/cos/issues/124)) ([23f0c76](https://github.com/philipyaz/cos/commit/23f0c76388b391c09346943ad4778b57011faf50))
* **whatsapp-triage:** file confirmed appointments to the board calendar ([#37](https://github.com/philipyaz/cos/issues/37)) ([b727945](https://github.com/philipyaz/cos/commit/b727945886ef90af857bea5c01db062d4bda99a6))


### Bug Fixes

* **board:** /tasks phone row shows the task title — progressive case chip + coarse toggle (cos-ops[#133](https://github.com/philipyaz/cos/issues/133)) ([#191](https://github.com/philipyaz/cos/issues/191)) ([041e245](https://github.com/philipyaz/cos/commit/041e2452c65f426b6f028f7c289c4d51b00abc1b))
* **boardapp:** deploy only main, notice main moving, install when the lockfile moved (cos-ops[#63](https://github.com/philipyaz/cos/issues/63)) ([#135](https://github.com/philipyaz/cos/issues/135)) ([6d37cf8](https://github.com/philipyaz/cos/commit/6d37cf8b50b87e1f7a17d21846fc81f2295250e3))
* **board:** coarse-pointer command palette + widen viewport-lint to raw vh (cos-ops[#141](https://github.com/philipyaz/cos/issues/141)) ([#200](https://github.com/philipyaz/cos/issues/200)) ([68cae2e](https://github.com/philipyaz/cos/commit/68cae2e6a7913399b0df19f2b63271c13a0f270d))
* **board:** completedAt gets one owner at task birth ([#142](https://github.com/philipyaz/cos/issues/142)) ([95a3646](https://github.com/philipyaz/cos/commit/95a36469f83c3a0d219e1ab4e5014fc8c5ac908a))
* **board:** fix the phone path — dvh viewport + mobile navigation ([#75](https://github.com/philipyaz/cos/issues/75)) ([139b7f6](https://github.com/philipyaz/cos/commit/139b7f6b9bf33a60478e3885a6f55c94cbc04739))
* **board:** name the local-day derivation seam and convert its mixed-frame call sites ([#149](https://github.com/philipyaz/cos/issues/149)) ([e150c1f](https://github.com/philipyaz/cos/commit/e150c1ffa1e624ea073ab1d6835c9d164848694f))
* **board:** one pane at a time on /inbox below md, plus a Back control (cos-ops[#98](https://github.com/philipyaz/cos/issues/98)) ([#170](https://github.com/philipyaz/cos/issues/170)) ([9fa357c](https://github.com/philipyaz/cos/commit/9fa357c46a193aeaaba5546ea3b230f7572e0076))
* **board:** one shared SSE stream, and three empty states that claimed "nothing" off data never received ([#165](https://github.com/philipyaz/cos/issues/165)) ([defe2c7](https://github.com/philipyaz/cos/commit/defe2c7e69e5421dbf89846f32898f601592cac1))
* **board:** phone More sheet renders add-ons above the Review group (cos-ops[#122](https://github.com/philipyaz/cos/issues/122)) ([#190](https://github.com/philipyaz/cos/issues/190)) ([a3e5977](https://github.com/philipyaz/cos/commit/a3e59771d1fa17bbd097e2b18f5a3b598af4b5ef))
* **board:** reminders-review reports the zero-drops ledger anomaly instead of "nothing new" ([#143](https://github.com/philipyaz/cos/issues/143)) ([36f9eea](https://github.com/philipyaz/cos/commit/36f9eea3c6f284ce9b9801b899b0f0ef953d6095))
* **board:** the approval queue commits through the real board verbs (cos-ops[#119](https://github.com/philipyaz/cos/issues/119)) ([#193](https://github.com/philipyaz/cos/issues/193)) ([ea68dfa](https://github.com/philipyaz/cos/commit/ea68dfa9c730695065fc112a3c59466b869e54c6))
* **board:** the board resolves every service port from cos.env — one resolver family, five sites (cos-ops[#99](https://github.com/philipyaz/cos/issues/99)) ([#173](https://github.com/philipyaz/cos/issues/173)) ([acedaca](https://github.com/philipyaz/cos/commit/acedacaa0489bca63d3f221b2766e010a65c9453))
* **board:** title-first reminders row below sm, 44px coarse completion toggle (cos-ops[#102](https://github.com/philipyaz/cos/issues/102)) ([#171](https://github.com/philipyaz/cos/issues/171)) ([a2f4fbf](https://github.com/philipyaz/cos/commit/a2f4fbf8d94e9485414ed7e405d79cf35da2cbf1))
* **ci:** give gen-labels-doc.mjs a --check, fold into the drift-gate step ([#201](https://github.com/philipyaz/cos/issues/201)) ([baebbac](https://github.com/philipyaz/cos/commit/baebbacc7c91acc6ca2f95ad3287062a269b5247))
* **config:** one shared secrets.env reader — collapse the three parser copies, pin the board's fourth (cos-ops[#91](https://github.com/philipyaz/cos/issues/91)) ([#157](https://github.com/philipyaz/cos/issues/157)) ([804cdda](https://github.com/philipyaz/cos/commit/804cdda50e7f83cdca790db189ac030e4c64c649))
* **deps:** bump nanoid past the self-retired Dependabot alert (cos-ops[#73](https://github.com/philipyaz/cos/issues/73)) ([#144](https://github.com/philipyaz/cos/issues/144)) ([7ad6213](https://github.com/philipyaz/cos/commit/7ad62135779565fbc3dde5db545915257115eb07))
* **docs:** derive the MCP debug runbook's bridge set from the manifest, repair through the generator ([#179](https://github.com/philipyaz/cos/issues/179)) ([ffcd4a4](https://github.com/philipyaz/cos/commit/ffcd4a458786b9b9a29c8ed6cb7723c3d961f397))
* **gen-launchd:** verify every launchctl load before claiming success ([#131](https://github.com/philipyaz/cos/issues/131)) ([38235a7](https://github.com/philipyaz/cos/commit/38235a724f54f1d1775e5d8195ca157daed7a7b1))
* **mcp:** device identity headers + fold fitness's HTTP path onto mcp-kit (cos-ops[#137](https://github.com/philipyaz/cos/issues/137), cos-ops[#138](https://github.com/philipyaz/cos/issues/138)) ([#195](https://github.com/philipyaz/cos/issues/195)) ([b57b278](https://github.com/philipyaz/cos/commit/b57b278a96cb7bdd8645a20b796f0cd6dc0bb10d))
* **mcp:** vault bridge joins the shared loopback-pinned argv (cos-ops[#123](https://github.com/philipyaz/cos/issues/123)) ([#192](https://github.com/philipyaz/cos/issues/192)) ([6671fa1](https://github.com/philipyaz/cos/commit/6671fa17b5efcb22b15efbbbd48686cbf495c991))
* **multi-device:** green the hub verifier and pin the device/backup mirror sites (cos-ops[#33](https://github.com/philipyaz/cos/issues/33), cos-ops[#45](https://github.com/philipyaz/cos/issues/45)) ([#125](https://github.com/philipyaz/cos/issues/125)) ([459440c](https://github.com/philipyaz/cos/commit/459440ca80cff25bea352ad730c816ea282c0aa1))
* **nutrition:** deposit the pantry ramp every mode, not behind step 5's else ([#177](https://github.com/philipyaz/cos/issues/177)) ([d16c583](https://github.com/philipyaz/cos/commit/d16c583e446f3bd9fd87886674ef879c790fbc60))
* **setup:** refuse to snapshot a placeholder secret into the Cowork MCP config ([#70](https://github.com/philipyaz/cos/issues/70)) ([ebb5363](https://github.com/philipyaz/cos/commit/ebb5363b2da2223ab4dd097f14f7e66a5cc5edfe))
* **setup:** replace backup-recovery's dead template render with gen-launchd; gate $REPO_ROOT paths (SCAN 6) ([#178](https://github.com/philipyaz/cos/issues/178)) ([abfe577](https://github.com/philipyaz/cos/commit/abfe577270701aa89fb46689ce4a63b3d306ec0d))
* **skills:** make /vault-operations the one reachable vault procedure for the capture sweeps ([#71](https://github.com/philipyaz/cos/issues/71)) ([c8f17c4](https://github.com/philipyaz/cos/commit/c8f17c4fa190e2a33214110ad371f9087490ed99))
* **skills:** make every SKILL.md description load (&lt;=1024 chars, no XML tags) ([#77](https://github.com/philipyaz/cos/issues/77)) ([07e3ae9](https://github.com/philipyaz/cos/commit/07e3ae9c71887d2d40d5bc33b20b10276120bfd0))
* **tests:** api-fitness-push pinned a day that aged out of the 90-day retention window ([#166](https://github.com/philipyaz/cos/issues/166)) ([8ced37e](https://github.com/philipyaz/cos/commit/8ced37ebbc575fbb32c92a483753c8062fc5244e))
* **tests:** enforce ADR 0029's host rule across all 29 store-path defaults ([#175](https://github.com/philipyaz/cos/issues/175)) ([0deadfe](https://github.com/philipyaz/cos/commit/0deadfefee4f23b63bbd84a9467b44534b2002a1))
* **tests:** every api-* step targets the sandbox store — export COS_BOARD_DATA once the test board is up ([#114](https://github.com/philipyaz/cos/issues/114)) ([cf6414a](https://github.com/philipyaz/cos/commit/cf6414a45be9ba316f6c5286a74f0045229f99f0))
* **vault:** forbid unverifiable board assertions in query answers (guardrail + hard gate) ([#73](https://github.com/philipyaz/cos/issues/73)) ([95e45ab](https://github.com/philipyaz/cos/commit/95e45abb044e2d216329223e3f862f4f1d9c3e1a))


### Documentation

* **claude:** a local run.sh result is not evidence about a PR — read CI ([#106](https://github.com/philipyaz/cos/issues/106)) ([8704ef7](https://github.com/philipyaz/cos/commit/8704ef706d8d383b18033a89819ecd54e4d42b30))
* **claude:** a red pack-skills --check after a merge means rebuild the bundle ([#92](https://github.com/philipyaz/cos/issues/92)) ([8f07546](https://github.com/philipyaz/cos/commit/8f07546e3bf87bc28a2e0dd980c31ca78c53d578))
* **claude:** a tool or report states only what it verified ([#153](https://github.com/philipyaz/cos/issues/153)) ([a6f5db1](https://github.com/philipyaz/cos/commit/a6f5db179430058c18cdc8931e10e78b9c7346b7))
* **claude:** census a source tree with git grep or a node walk, never grep -r ([#164](https://github.com/philipyaz/cos/issues/164)) ([002db1e](https://github.com/philipyaz/cos/commit/002db1e45d5818c4ee6abbaf0ff537d1e4c2f48d))
* **claude:** drop the gen-roles known-red carve-out; state the machine-local-state rule instead ([#128](https://github.com/philipyaz/cos/issues/128)) ([509da8b](https://github.com/philipyaz/cos/commit/509da8be7c6cf57804e9ba22685dc903b2a32900))
* **claude:** rebuilding a skill bundle does not install it in Cowork ([#79](https://github.com/philipyaz/cos/issues/79)) ([becfee4](https://github.com/philipyaz/cos/commit/becfee4123217d3cda93bf7ba175353445990a05))
* **claude:** resolve a repo path against the git index, never the working tree ([#188](https://github.com/philipyaz/cos/issues/188)) ([2ca1ad5](https://github.com/philipyaz/cos/commit/2ca1ad5b4581f608beacadf5035d5830063e629e))
* **claude:** state the two skill trees and which runtime loads each ([#74](https://github.com/philipyaz/cos/issues/74)) ([a5a117b](https://github.com/philipyaz/cos/commit/a5a117bfcb908463816f310373a46003be5bbee7))
* refresh root CLAUDE.md into an operational brief; fix stale docs/CONTRIBUTING claims ([#50](https://github.com/philipyaz/cos/issues/50)) ([a70bd8e](https://github.com/philipyaz/cos/commit/a70bd8ea35da52a3ee9ea21765dba7320f25e1f2))
* release & versioning docs, community-health files, and control-model accuracy fixes ([#15](https://github.com/philipyaz/cos/issues/15)) ([f5ede89](https://github.com/philipyaz/cos/commit/f5ede893ecff0b9682cb36bf3ccd940b37025303))
* **releasing:** tell the truth about Release-PR CI (no owner bypass) and gate the claim ([#85](https://github.com/philipyaz/cos/issues/85)) ([6123b89](https://github.com/philipyaz/cos/commit/6123b893ef4b3db740024cf8dc7ff15a18a734f8))


### Code Refactoring

* **addons:** one tool list per server — delete the mcp.tools copy, fix parseToolNames self-capture (cos-ops[#104](https://github.com/philipyaz/cos/issues/104)) ([#172](https://github.com/philipyaz/cos/issues/172)) ([36ec1a6](https://github.com/philipyaz/cos/commit/36ec1a61d34dd5d6797054b2a425e6e03db56a1c))
* **backup:** fold the hand-rolled single-flight lock into lib/util.mjs (cos-ops[#146](https://github.com/philipyaz/cos/issues/146)) ([#202](https://github.com/philipyaz/cos/issues/202)) ([d24a0d0](https://github.com/philipyaz/cos/commit/d24a0d0867beb708c3154846f1a616cf7cfb2b2a))
* **board:** delete 30 dead board-lib/component exports (T1) ([#176](https://github.com/philipyaz/cos/issues/176)) ([c0db969](https://github.com/philipyaz/cos/commit/c0db96908e8e76c12cae39d6032626bc004a0f69))
* **tests:** one className resolver + one exclusion idiom for the A5 gates — fold the hand-copied helpers into tsx-controls.mjs (cos-ops[#103](https://github.com/philipyaz/cos/issues/103)) ([#169](https://github.com/philipyaz/cos/issues/169)) ([e51ccb9](https://github.com/philipyaz/cos/commit/e51ccb90090f0d0beef2f551a199260908538118))

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
