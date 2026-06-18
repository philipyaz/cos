---
name: add-an-addon
description: Build a NEW optional vertical (an "add-on") in the Cos repo the framework-native way — one four-layer slice (nav + API + data + MCP) gated by ONE Settings.addons.<id> flag, with all data folded onto cases.json. Use when adding a whole new feature area (a "health" dashboard, a "finance" tracker, a "reading list", etc.), when reviewing/refactoring a feature that was built OUTSIDE the framework (its own *-store.ts, its own data/*.json, hardcoded nav, an unregistered route prefix), or whenever you're about to mint a new persistence store / new top-level nav and need to know whether it should instead be an add-on. The worked example is Nutrition & Chef (board/lib/addons.ts, mcp/nutrition-server, board/app/api/nutrition, tests/api-nutrition-gate.mjs); the cautionary example is the Health & Athlete PR this skill was written from.
---

# Add an add-on (the framework-native way)

An **add-on** is an optional, self-contained vertical layered over the core board. The
framework already exists — your job is to **parametrise it with one manifest**, not to invent
a parallel one. Copy **Nutrition & Chef** (`board/lib/addons.ts`, `mcp/nutrition-server/`,
`board/app/api/nutrition/`, `tests/api-nutrition-gate.mjs`) beat for beat. Read
`docs/architecture/addons.md` first; it is the spec, this is the recipe.

## WHEN this applies — and the tell that you're doing it wrong

Use this skill when you are adding a **whole feature area** (its own pages + routes + agent
tools) that should ship **disabled by default** and not bloat the core.

**The tell — STOP and make it an add-on if you catch yourself about to:**

- create a **new `board/lib/<x>-store.ts`** or a **new `board/data/<x>.json`** → the data
  belongs on `cases.json` via `DBShape`, written through the existing `mutate()`.
- **hardcode a nav entry** into the sidebar's core list → nav comes from the manifest's
  `navItems`, revealed only when the flag is on.
- add an `/api/<x>/*` route prefix that **nothing in `ADDON_REGISTRY` claims** → register it.
- mint a **second persistence chokepoint**, a second SSE channel, a second backup path → there
  is exactly one of each, and riding `cases.json` gives you all three for free.

Does **NOT** apply to: a tweak to a **core** surface (cases/events/reminders/priorities — those
are always-on, never gated), or a pure agent-skill with no new data/nav/routes.

## The mental model (memorise this)

> **One four-layer slice, gated by ONE flag. Writes close; reads stay open.**
> **A component is a STATE MACHINE — it never calls an LLM; the agent is the intelligence.**

An add-on is a **deterministic state machine**: it persists state and exposes it via an **API + an
MCP server**, and that is the whole contract. It **does NOT call an LLM / the Anthropic API.** Any
generative step (a training plan, a summary, a drafted reply) is produced by the **external agent**
(your operator skill, Claude Cowork) and written back through an **MCP write tool** / a `POST`; the
add-on only validates, versions, attributes, stores, and serves it. Deterministic **server-side
compute** (stats, projections, aggregations) is fine — only **generative LLM inference** is
delegated. **The sole exception in the whole repo is the vault MCP (`mcp/vault-server`)**, which
embeds the Claude Agent SDK and is itself an agent. If you catch yourself reaching for
`@anthropic-ai/sdk` (or any LLM client) inside an add-on route or MCP server, **stop** — that
generative step belongs in the agent's context, not the component.

- **Four layers:** **nav** + **API** + **data** + **MCP server** — the same machinery the core
  uses, parametrised by an `AddonManifest`. Nothing about an add-on is special-cased.
- **ONE flag:** `Settings.addons.<id>.enabled`, persisted **in `cases.json`** (board state, not
  config). `isAddonEnabled(db, id)` is `true` only when it is exactly `true`; absent === off.
- **Writes close:** every mutation calls `assertAddonEnabled(db, id)` **inside `mutate()`** →
  `NotFoundError` → **404** when disabled (atomic with the write, closes the TOCTOU).
- **Reads stay open:** every `GET` is **ungated**. Disabling **freezes** an add-on; it never
  hides or deletes a byte. Re-enabling resumes exactly where it left off.
- **WHY data rides `cases.json`:** you inherit **free SSE live-update** (one `version` bump
  reaches every tab), **free encrypted backup** (the whole file is snapshotted), and **free
  attribution** (`human` from the UI, `agent` from the MCP). A standalone store throws all
  three away and you'd have to rebuild them badly.

Two clocks, on purpose: the **in-board** surface (nav + API gate) activates the instant you flip
the flag via SSE; the **agent** surface (the MCP bridge) activates only when someone runs the
setup skill on that machine. Flipping the DB flag does **not** start a daemon — nothing hot-loads.

## The 9-step walkthrough (copy nutrition at each step)

### 1. Data — on `DBShape` in `board/lib/types.ts`, plus a singleton if you need one

- Add your owned **array(s)** as optional fields on `DBShape` (e.g. `healthEntries?: HealthEntry[]`,
  mirroring `foodLogs?`). Bump `SCHEMA_VERSION`; the change is **purely additive** so old boards
  read unchanged.
- A non-array **singleton** (a profile/goal object) is a bare field — `athleteProfile?` mirrors
  `nutritionGoal?` — and is **deliberately NOT in `dataArrays`** (that list is arrays only).
- Carry the new fields through `migration` + `validate` + `ensureFile` and add typed
  `getX`/`setX` store helpers with **sticky `createdAt`** (mirror `getNutritionGoal`/`setNutritionGoal`).
- Define all **vocabulary as `VALID_*` arrays in `types.ts`** and import them everywhere — the
  route validator AND the UI bind to the **same** arrays. Never redefine an enum inline; never
  store a label in a non-English language.

### 2. Manifest — ONE `AddonManifest` literal in `ADDON_REGISTRY`

Add one entry to `board/lib/addons.ts` (copy `NUTRITION_ADDON`). This **single source of truth**
gives you the `/addons` catalog row, the toggle, the nav, the gate, and the bridge probe — for
free. Fill: `id`, `title`, `description`, `icon`, `navItems[]`, `apiPrefixes[]`,
`dataArrays[]` (**arrays only** — omit singletons), the `mcp` block, and any `dependsOn[]`.
**Do not** add bespoke helpers; the four existing ones (`listAddons`, `getAddon`,
`isAddonEnabled`, `assertAddonEnabled`) are the entire gate.

### 3. API — routes that gate writes inside `mutate()`, leave GETs open, reuse helpers

For each resource under `board/app/api/<prefix>/`:

- **GET = ungated.** `readDB()`, filter, return `{ ..., version: db.version }`. A disabled
  add-on's data must still read.
- **POST / PATCH / DELETE = gated.** Do the read-modify-write **inside `mutate()`** and call
  `assertAddonEnabled(db, "<id>")` as the **first line inside the lock** (gate + id-mint + write
  are one critical section). Map thrown store errors with `storeErrorToResponse`.
- **Reuse `@/lib/route-helpers`** — `isISODate` (validate every date), `resolveActor` (write
  attribution), `storeErrorToResponse`. **Never re-inline** them.
- **NEVER call a sibling route over loopback HTTP.** No `fetch` to your own `/api/*`. If two
  routes share logic, extract a function into `board/lib/<x>.ts` and call it **in-process**.
- **Zero `console.log`** in `board/app/api` — and absolutely no logging of user/biometric data.
- **A route NEVER calls an LLM.** The component is a state machine; the **agent** generates. A
  "coach/summary" endpoint is a **CRUD seam** that **accepts** an already-generated artifact (the
  agent built it in its own context and `POST`s it) — validate the artifact's JSON **before** the
  store write (never persist an unvalidated body), version it, attribute it, store it. Deterministic
  **compute** (stats, a projection, an aggregator in `board/lib/<x>.ts`) is fine — only *generative
  inference* is off-limits. The **vault MCP is the one exception** (it embeds the Agent SDK).

### 4. Nav — from the manifest only

The sidebar reads `navItems` off the manifest and shows the group **only when the add-on is
enabled**. **Do NOT touch the sidebar's core/daily nav array** — adding your links there
hardcodes them on for everyone and defeats the gate.

### 5. MCP server — a THIN fetch wrapper, no business logic

Create `mcp/<name>-server/server.mjs` using **`packages/mcp-kit`** (`err`, `text`, `str`,
`start`, `baseUrl`, `makeBoardApi`) — copy `mcp/nutrition-server/server.mjs`. Every tool is a
thin `fetch` over your `/api/*` routes on `CRM_BASE_URL`; **no business logic and NO LLM calls in
the MCP** (the intelligence lives in the operator skill / the agent; the vault MCP is the one server
that embeds an LLM, and it is the exception, not the template). Every WRITE tool sends
`{ actor: "agent" }` + an `x-actor: agent` header. A disabled add-on 404s writes → surface as a
`Not found.` tool error. Adding a new `mcp/<x>-server` makes it a **root npm workspace member**:
run `npm install` at the repo root and **commit `package-lock.json`**, or CI's `npm ci` fails.

### 6. Install path — ONE descriptor + a port in the loader (manifest-driven, both OSes)

Supervision is **manifest-driven** (see [`mcp/CLAUDE.md`](../../../mcp/CLAUDE.md)): you define the
service **once** as a co-located descriptor and the generators render every platform from it. **No**
committed plist template, **no** `ensure-bridges.sh` edit, **no** second port map.

- Add the port to **`config/load-config.sh`** ONLY: a default `: "${<NAME>_BRIDGE_PORT:=80NN}"`, the
  derived `: "${<NAME>_BRIDGE_URL:=http://localhost:$<NAME>_BRIDGE_PORT}"`, and **both** names on the
  `export` line. Then mirror it into **`config/cos.env.example`** for documentation. This is the
  canonical port on every OS.
- Drop **ONE** descriptor `mcp/<name>-server/<name>.service.json` (`schemaVersion:1`,
  `kind/runtime:"bridge"`, `addon:"<id>"`, `portVar:"<NAME>_BRIDGE_PORT"`, `stdio:["${NODE_BIN}",
  "${REPO_ROOT}/mcp/<name>-server/server.mjs"]`, `env:{CRM_BASE_URL:"${BOARD_URL}"}`,
  `clients:["claude-code","cowork"]`, `probe:{type:"httpListen"}`, `idleExit:true`). Copy
  `mcp/nutrition-server/nutrition.service.json` beat for beat. The `addon:"<id>"` field is what makes
  the probe treat the bridge as **OPTIONAL** and skip it silently on a board that never installed it —
  there is no hand-maintained registry line or skip-`case` anymore.
- **If your write tools need a machine-local secret** (e.g. an ingest token, as fitness does), add
  `secrets:["<TOKEN>"]` + `secretWrapper:"${REPO_ROOT}/mcp/<name>-server/launch.sh"` to the descriptor
  and ship a `launch.sh` (copy `mcp/fitness-server/launch.sh` or `mcp/vault-server/launch.sh`) that
  sources `config/secrets.env` then execs supergateway — so the secret never lands in the rendered
  plist or `.mcp.json`. Most add-ons need no secret (copy nutrition, which has none).
- **Do NOT smuggle in pm2** or any new process manager, and **never hand-edit `.mcp.json`** (it is a
  generated, CI-checked artifact). The bridge is a launchd LaunchAgent rendered by `gen-launchd.mjs`;
  that is the only mechanism.

### 7. Skills — one setup skill + one operator skill

- **`/<x>-mcp-setup`** (copy `nutrition-mcp-setup`): renders + loads the launchd bridge plist,
  wires the `.mcp.json` + Cowork stdio entry, points `<X>_BRIDGE_PORT`, verifies the bridge.
- An **operator skill** (copy `/nutrition-chef`) that turns plain language into structured writes
  via your MCP — this is where any estimation/judgement lives, not in the MCP.

### 8. Docs — `docs/features/<x>.md` wired into `mkdocs.yml`

Write the feature page under `docs/features/<x>.md` and add it to the `nav:` in `mkdocs.yml`
(under `features:`, next to `Nutrition & Chef`). **No loose root `*.md`.** Cross-link with
relative `.md` paths; validate with `uvx --with mkdocs-material mkdocs build --strict`.

### 9. Tests — gate + CRUD + unit, wired into `tests/run.sh`

- **`tests/api-<x>-gate.mjs`** — copy `tests/api-nutrition-gate.mjs` exactly: snapshot
  `cases.json`, prove **disabled → GET 200 but POST/PATCH/DELETE 404**, **enable bumps
  `db.version`**, **enabled → POST 201**, unknown id → 404, non-boolean `enabled` → 400; restore
  in `finally`.
- **CRUD** coverage per resource and **unit tests** for any pure logic in `board/lib/<x>.ts`
  (summarisers, target engines) — assert the **canonical field names**, not the producer's
  incidental shape.
- Add all of them to `tests/run.sh`.

## Cross-add-on dependencies (soft by default)

When your add-on **reads** another add-on's data (e.g. a coach folding in the food log):

- Declare a **soft edge**: `dependsOn: [{ id: "<other>", required: false }]`. The catalog
  surfaces "works better with `<other>`"; runtime posture is **unchanged**.
- **Reads stay open.** Read the other add-on's array directly (`db.foodLogs`) and default with
  `?? []`. That `?? []` only ever fires when the other add-on was **never installed** (the field
  is absent) — a **disabled** add-on still has readable data.
- **NEVER gate a cross-read on the other add-on's `isAddonEnabled`.** That would hide
  frozen-but-readable data and violate "reads stay open". Soft deps never auto-enable and never
  hard-gate. Reserve `required: true` for a future dependent that is genuinely useless alone.

## Copy CHECKLIST — tick every box before the PR

- [ ] Owned **array(s)** on `DBShape` (`types.ts`); `SCHEMA_VERSION` bumped; migration + validate
      + ensureFile carry them.
- [ ] Any **singleton** is a bare field with sticky-`createdAt` `getX`/`setX` helpers; **not** in
      `dataArrays`.
- [ ] All vocabulary as `VALID_*` arrays in `types.ts`, imported by both route + UI; **English only**.
- [ ] **ONE** `AddonManifest` in `ADDON_REGISTRY`; no new gate helpers.
- [ ] GETs **ungated**; every write calls `assertAddonEnabled` **inside `mutate()`**.
- [ ] Routes reuse `isISODate` / `resolveActor` / `storeErrorToResponse`; **no re-inline**.
- [ ] **No loopback `fetch`** to own `/api/*`; shared logic in `board/lib/<x>.ts`, in-process.
- [ ] **Zero `console.log`** in `board/app/api`; no PII/biometric logging.
- [ ] **No LLM client** imported anywhere in the add-on (route OR MCP) — the component is a state
      machine; the agent generates and `POST`s. Any "coach" route is a CRUD seam that **validates
      the artifact JSON before the store write**. (Vault is the sole LLM-bearing server.)
- [ ] Nav from manifest only; **core sidebar array untouched**.
- [ ] MCP = thin `mcp-kit` fetch wrapper; `{ actor: "agent" }` on writes; `npm install` at root +
      `package-lock.json` committed.
- [ ] **ONE** co-located descriptor `mcp/<name>-server/<name>.service.json` (`schemaVersion:1`,
      `addon:"<id>"`, `portVar`); `<X>_BRIDGE_PORT` (+ derived `_URL`) added to `config/load-config.sh`
      and documented in `config/cos.env.example`; **no committed plist template, no `ensure-bridges.sh`
      edit, no pm2**; `.mcp.json` regenerated via `gen-mcp-json.mjs` (never hand-edited).
- [ ] `/<x>-mcp-setup` + operator skill.
- [ ] `docs/features/<x>.md` in `mkdocs.yml`; `mkdocs build --strict` clean.
- [ ] `api-<x>-gate.mjs` + CRUD + unit tests, all in `run.sh`.

## Lessons from the Health & Athlete PR (anti-pattern catalog)

Each of these was a real mistake in the feature this skill reviews. Don't repeat them.

- **Standalone store.** `board/lib/health-store.ts` + a separate data file — re-implementing what
  `cases.json` gives free and **losing SSE + backup + attribution**. → Fold onto `DBShape`;
  retire the standalone store. (Repoint every `@/lib/health-store` import to `@/lib/fitness`.)
- **Unregistered feature.** Pages + routes shipped with **no `ADDON_REGISTRY` entry**, so no
  catalog row, no toggle, no gate. → One manifest gives all of it.
- **Ungated writes.** Mutations with no `assertAddonEnabled` (or the check only at the route edge,
  not inside `mutate()`). → Gate **inside the lock**.
- **Hardcoded nav.** Links jammed into the core sidebar list, on for everyone. → `navItems` only.
- **Split-brain taxonomy.** The producer stored type `"hrv"` but consumers queried
  `"heart_rate_variability"`; summarise/trends read `data.duration_min` / `data.avg_ms` /
  `data.bpm` / `data.count` while the producer wrote `data.value`. **Producer and consumer
  disagreed on the type string and the field**, so reports silently came back empty. → **Canonicalise
  one taxonomy** (the HAE ingest shape; metric entries use `data.value`, day `ts`) and make every
  consumer read it. And: the test that **masked it** asserted the producer's incidental shape
  instead of the canonical contract — **tests must assert the contract**, or they certify the bug.
- **Loopback self-calls.** A route `fetch`-ing its sibling `/api/*` over HTTP. → Extract to
  `board/lib/<x>.ts`, call in-process.
- **Re-inlined helpers + unvalidated artifact JSON.** Date checks re-written instead of `isISODate`;
  an agent-supplied artifact body written **straight to the store** without validation. → Reuse
  route-helpers; validate the artifact shape before any write (raw bodies are never trusted).
- **An LLM call inside a component.** A route or MCP server that imports `@anthropic-ai/sdk` and
  generates a plan/summary/reply server-side — turning a state machine into a key-bearing,
  offline-broken, non-deterministically-testable thing. (This is exactly what the fitness add-on's
  removed board-side `GET /api/fitness/training-plan|weekly-review|pre-workout-brief` generate
  routes did.) → **Delegate generation to the agent**; expose a **CRUD seam** (`POST
  /api/fitness/coaching` + the `save_*` MCP tools) that accepts the agent's already-generated,
  validated artifact and persists it. The **vault MCP** is the only server that may embed an LLM.
- **Debug PII logging.** `console.log` of biometric data in API routes. → Zero `console.log`.
- **Silent missed-day data drop.** The HAE ingest converter kept only *today's* points and
  discarded the rest of the re-sent history, so a single missed sync lost those days **permanently**
  (and the UTC `today` misclassified late-evening points). → Don't filter the caller's data to one
  day; rely on dedup-by-id and compute day boundaries in the user's timezone.
- **Missing install path + smuggled pm2.** No service descriptor / no `<X>_BRIDGE_PORT`, and a new
  **pm2** dependency sneaked in. → ONE co-located descriptor (`<name>.service.json`) + the
  `<X>_BRIDGE_PORT` in `load-config.sh`; install via the generators (the probe picks it up
  automatically from `addon:`); **pm2 is dropped from this PR.**
- **Missing docs / tests.** No `docs/features/<x>.md`, no gate test. → Both are required, wired
  into `mkdocs.yml` / `run.sh`.
- **French in an English codebase.** Stored vocabulary, prompts, enums, and UI labels in French.
  → **ALL** stored vocabulary, prompts, enums, and labels in **English**; bind to the `VALID_*`
  arrays in `types.ts`.
