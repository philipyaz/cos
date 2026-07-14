# `mcp/` — the MCP servers + their cross-platform supervision (read this before adding one)

This directory holds the stdio **MCP servers** that expose Cos to agents (board, calendar, guard,
vault, nutrition, …) and the **supervision glue** that keeps them running on both macOS and Windows.
Each server is a small stdio process; agents reach it either over a **supergateway HTTP bridge** on a
fixed loopback port (Claude Code, via the repo-root `.mcp.json`) or as a **direct stdio command**
(Claude Cowork Desktop, via `claude_desktop_config.json`). On macOS, **launchd** supervises the
bridges; on Windows, the Node process manager `mcp/cos-services.mjs` does.

**A service is defined exactly once.** Each one ships a co-located, OS-agnostic descriptor
`<name>.service.json`; `mcp/service-manifest.mjs` resolves all of them against `config/load-config.sh`
(the single source of truth for ports/paths); and every supervisor, probe, and client config is a
thin **consumer** of that manifest. You do not hand-maintain a per-OS service list. The step-by-step
install runbooks live in the setup **skills**, not here — this file is the **contract + map + gotchas**.

```
mcp/<name>-server/<name>.service.json   ──┐   (declares one service: names/refs only)
config/load-config.sh  (ports/paths)    ──┤
                                          ▼
                            mcp/service-manifest.mjs   getManifest() / --json / --probe-list
                                          │
        ┌───────────────┬────────────────┼─────────────────┬──────────────────┐
        ▼               ▼                 ▼                 ▼                  ▼
 gen-launchd.mjs   cos-services.mjs  ensure-bridges.sh   gen-mcp-json.mjs   gen-cowork-config.mjs
 (macOS plists)    (Windows mgr)     (probe, both OS)    (.mcp.json + CI)   (Cowork stdio)
```

---

## Golden rule: define once, wire both platforms in the SAME change

**Never add a macOS-only or Windows-only MCP server.** Because the descriptor drives every platform,
"both OSes" is now one descriptor, not two parallel edits — but the discipline still holds: a server
isn't done until it comes up on launchd *and* under `cos-services.mjs`, and is reachable from *both*
clients. The two invariants that keep this honest:

- **Ports and paths live in `config/load-config.sh` (+ `config/cos.env`), nowhere else.** A descriptor
  carries only **names and references** (`portVar`, `${VAR}`, `secrets[]`) — never a literal port, an
  absolute path, a username, or a toolchain location. The resolver fails LOUDLY on an unknown `${VAR}`.
  This is what makes a `cos.env` override propagate to every OS and makes it *impossible* to commit a
  personal path (the bug the first Windows attempt shipped: `8001`, `C:/Users/kmy38`, `vault/kam-vault`).
- **Supervisors are thin consumers.** `cos-services.mjs`, `ensure-bridges.sh`, and the generators read
  the manifest; none of them redefines a port, path, or spawn command.

---

## Add a new MCP — the checklist

Steps are tagged **[shared]** (drives both OSes), **[mac]**, **[win]**, **[setup]** (run once per machine).

1. **[shared]** Write the stdio server `mcp/<name>-server/server.mjs` (import the shared helpers from
   `../../packages/mcp-kit/index.mjs` by **relative** path so a bare `node server.mjs` resolves with no
   workspace install) + a `package.json` (name `<name>-mcp`) making the dir a workspace member.
2. **[shared]** `npm install` at the **repo root** and commit the updated `package-lock.json`.
   `mcp/*-server` is a workspace glob, so a new dir is a new member — skip this and CI's `npm ci` fails
   with *"Missing: `<name>`-mcp from lock file"* (see Gotchas).
3. **[shared]** Add the port to `config/load-config.sh` ONLY: a default `: "${<NAME>_BRIDGE_PORT:=80NN}"`,
   the derived `<NAME>_BRIDGE_URL`, and **both** names on the `export` line. Document it in
   `config/cos.env.example`. This is the canonical port on every OS.
4. **[shared]** Drop **one** descriptor `mcp/<name>-server/<name>.service.json` (schema below). This is
   the *only* new per-service supervision file — it feeds the macOS plist, the Windows spawn, the probe,
   `.mcp.json`, and the Cowork entry. No `SERVICES[]` edit, no second port map, no probe-list edit, no
   launcher, no pm2 app, no per-OS anything.
5. **[shared]** (add-on only) Register the `AddonManifest` in `board/lib/addons.ts`. **Enabling is a
   separate board action** — `PATCH /api/addons/<name> {"enabled":true}`. Supervision being up does NOT
   flip the gate.
6. **[setup]** Install it on the machine via the setup skill (which runs the generators):
   `node scripts/gen-launchd.mjs --install` (macOS) renders+loads the plist; `node mcp/cos-services.mjs
   start` (Windows) reads the manifest; `node scripts/gen-mcp-json.mjs` writes the `.mcp.json` entry
   (CI verifies it matches); `node scripts/gen-cowork-config.mjs` writes the Cowork entry — this needs
   **`COWORK_CONFIG`** to point at the real `claude_desktop_config.json` (cos-setup detects + records it
   per OS; the generator refuses a missing dir — see the Cowork gotcha).
7. **[shared]** Verify on both clients: `curl` an MCP `initialize` POST to `…/mcp` →
   `serverInfo.name == "<name>"`, then round-trip one read + one write tool.

---

## The descriptor (`<name>.service.json`)

Pure declarative DATA — names/refs only, validated by `mcp/service-manifest.mjs` (`schemaVersion` 1).

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` (the resolver rejects any other value) |
| `name` | service id; derives the launchd label `com.chiefofstaff.mcp-<name>` + `mcp/logs/<name>.{out,err}.log` |
| `kind` | `bridge` (MCP server behind supergateway) · `sidecar` (HTTP daemon) · `runner` (portless background job) |
| `runtime` | `bridge` (supergateway-wrapped stdio) · `uvicorn` (uv/venv FastAPI) · `exec` (raw command) |
| `core` / `addon` / `optional` | `core:true` = always expected · `addon:"<id>"` = board add-on (skip silently if absent) · `optional:true` = conditionally installed, non-add-on (e.g. vaultjobs) |
| `portVar` | the `load-config.sh` var holding the port (omit for a portless runner) |
| `stdio` | (runtime `bridge`) the argv supergateway wraps, e.g. `["${NODE_BIN}", "${REPO_ROOT}/mcp/<name>-server/server.mjs"]` |
| `dir`/`app`/`host`/`uvExtras` | (runtime `uvicorn`) project dir, ASGI app (`sidecar:app`), bind host, `uv run --extra` list |
| `exec` | (runtime `exec`) the raw argv, e.g. a Go binary or `["${NODE_BIN}", "…/jobs-runner.mjs"]` |
| `env` | env map; values are `${VAR}` refs (resolved from the loader) or literals |
| `secrets` | env keys (e.g. `ANTHROPIC_API_KEY`) sourced from `config/secrets.env`, never written into a descriptor/plist/`.mcp.json` |
| `secretWrapper` | macOS secret-sourcing wrapper script (only on secret services); Windows ignores it (injects via `loadSecrets()`) |
| `idleExit` | `true` → add `COS_MCP_IDLE_EXIT_MS=300000` on the **bridge** spawn (never on Cowork, never on sidecars) |
| `clients` | which clients get an entry: `["claude-code","cowork"]` for bridges; `[]` for sidecars/runner |
| `inMcpJson` | optional override; defaults true only for bridges that list `claude-code` |
| `cwd` | working dir (default `${REPO_ROOT}`) |
| `roles` | device roles this service runs under: `["hub"]` (default) or `["hub","spoke"]`. A spoke runs only the board-facing thin wrappers (they point at the hub via `${BOARD_URL}`); every per-machine generator (`gen-launchd`, `gen-cowork-config`, `cos-services`, `ensure-bridges`) is scoped to `COS_DEVICE_ROLE` — the committed `.mcp.json` deliberately is NOT |
| `label` / `logDir` | overrides for services with PRE-manifest installed identities (backup keeps `com.chiefofstaff.backup` + `backup/logs/`) — omit for new services |
| `schedule` | `{ "hour": H, "minute": M }` → a SCHEDULED daily job (macOS `StartCalendarInterval`, no KeepAlive; skipped by the Windows manager — Task Scheduler territory). Literal numbers are fine (cadence, not machine config) |
| `probe` | `{ "type": "httpListen" \| "healthz" \| "bearerHealth" \| "process" \| "scheduled" }` — how `ensure-bridges.sh` checks liveness (`scheduled` = healthy when LOADED, it is not supposed to be running between fires) |

---

## Add-ons: supervision is always on; the board toggle gates **writes** (not just display)

An add-on (e.g. Nutrition & Chef) is an optional vertical = nav + API + data + an MCP server. Two
**independent** layers govern it — conflating them is the usual confusion:

**1. Supervision (this directory's concern) — always on once set up.** An add-on's MCP server is an
ordinary bridge/sidecar whose descriptor carries `addon: "<id>"`. It is installed + supervised like
any other service (launchd / `cos-services.mjs`), so **its tools are always mounted and reachable**
whenever the server is running — there is no per-tool gate at the MCP layer. The `addon` field affects
exactly one thing here: the **probe** treats it as optional, so a machine that never installed the
add-on is skipped silently (no `WARN`) instead of flagged. Supervision **never** reads `Settings.addons`.

**2. Board enablement (`Settings.addons.<id>.enabled`) — a real server-side gate, default OFF.** This is
separate from supervision and lives in `board/lib/addons.ts`:
- `isAddonEnabled(db, id)` is `db.settings?.addons?.[id]?.enabled === true` — **absent ⇒ off**.
- When **disabled**, the add-on's **writes are blocked**: every mutation funnels through
  `assertAddonEnabled()` inside `mutate()`, which throws `NotFoundError` → **HTTP 404** (`"Add-on <id>
  is not enabled"`). So an MCP **write** tool (`log_food`, `add_pantry_item`, …) called against a
  disabled add-on gets a **404** — it does **not** silently succeed. **Reads (`GET`) are ungated**, so
  `list_food_log` etc. still return data.
- The **nav/UI** is gated by the *same* flag but separately: the sidebar reads `isAddonEnabled` and the
  toggle flips it **live over SSE**.
- **Enabling is an explicit action**, never implied by the server being up: `PATCH /api/addons/<id>
  {"enabled":true}`.

So the common shorthand "add-ons are always on; the toggle just shows/hides them" is **half right**: the
**server** is always on and its tools are always callable, and the toggle *does* show/hide the nav — but
the toggle is **not** display-only. Disabling is a genuine write gate (writes 404; reads still work), so
a tool can be *reachable* yet *refused*. A new add-on therefore needs **both** its server supervised
(this doc) **and** its gate enabled (the `PATCH`) before its writes land.

---

## macOS vs Windows — differences the renderers handle for you

You write one descriptor; each platform's renderer does the OS-specific thing. Know these so you can
debug, but you don't hand-write them:

| Concern | macOS (`gen-launchd.mjs` → launchd) | Windows (`cos-services.mjs`) |
|---|---|---|
| **Supervisor / restart** | launchd LaunchAgent; `RunAtLoad`+`KeepAlive` = real crash-restart at login | `cos-services.mjs`: `start` = idempotent nudge (detached, `windowsHide`); `watch` = foreground supervisor that respawns crashes with exponential backoff + a fast-crash cap (the launchd-`KeepAlive` equivalent — run it from a startup shortcut for persistent supervision) |
| **Toolchain** | `$BREW_PREFIX/bin/{node,supergateway,uv}`; plist `PATH` leads with `$BREW_PREFIX/bin` | `$NODE_BIN`/`$SUPERGATEWAY_BIN`/`$UV_BIN` from `cos.env` — never `%APPDATA%/npm/...` or a pinned `pythoncore-3.x` literal |
| **supergateway** | `node --require scripts/loopback-bind.cjs <dist>/index.js --stdio "…"` — the preload pins the bridge to **127.0.0.1** (supergateway has no bind-host option; unpinned it serves every LAN/tailnet interface with zero auth) | `node --require scripts/loopback-bind.cjs <supergateway>/dist/index.js --stdio "…"` (same preload; also: no `cmd.exe` window, dodges MSYS `/mcp` path-mangling) |
| **Secret (vault/vaultjobs)** | `secretWrapper` (`launch.sh`) sources `config/secrets.env`, then execs — key never in the plist | `loadSecrets()` reads `config/secrets.env` and spreads the declared `secrets[]` into the spawn env — key never in committed source |
| **uv sidecars (search/guardsvc)** | `uv run [--extra model] --directory <dir> uvicorn sidecar:app …` (uv self-provisions the venv) | `<dir>/.venv/Scripts/uvicorn.exe …` directly (venv pre-provisioned by `uv sync`) — avoids the `uv`→`cmd.exe` visible window |
| **Stop** | `launchctl bootout` | `taskkill /T /F` against the PID file (`mcp/logs/.cos-services.pid`) |
| **Spawn hygiene** | n/a | `windowsHide:true`; **forward-slash paths**; `--stdio` tokens are quoted so a path with a space survives supergateway's re-split |
| **Platform selection** | `ensure-bridges.sh` gates on `uname` = `Darwin` | `ensure-bridges.mjs` (predev) routes `win32` → `cos-services`; `ensure-bridges.sh` Windows branch is a manual-invocation fallback |
| **Guard model** | `COS_GUARD_MODEL` default `llama-prompt-guard-2-86m` (real gated Llama) | set `COS_GUARD_MODEL=heuristic-only` in `cos.env` (no CUDA) — a per-machine *setting*, not a code fork; guard still fails CLOSED |
| **Scheduled / app-level** | `schedule` → `StartCalendarInterval`; `autostart:false` (`boardapp`) → installed by `gen-launchd --install`, NOT by the predev nudge | `cos-services` skips both (`!schedule && autostart`): schedule the `backup` job via Task Scheduler (backup-recovery §8); run `boardapp` (the production board) however the hub prefers (`boardapp-run.mjs` is cross-platform — it resolves `next`'s JS entrypoint, not the POSIX `.bin` shim) |

---

## Gotchas (grounded in how this actually works)

- **No hardcoded ports / personal paths / PII — structurally.** Descriptors carry only names; the
  resolver throws on an unknown `${VAR}`; CI runs `node mcp/service-manifest.mjs --json` (every
  descriptor must resolve) + `node scripts/gen-mcp-json.mjs --check`. A literal port or a `C:/Users/<you>`
  path simply has nowhere to live.
- **`.mcp.json` is GENERATED — never hand-edit it.** It is a build artifact of the manifest with a CI
  sync-check (modeled on `scripts/gen-labels-doc.mjs`); a hand-edit fails the build. Regenerate with
  `node scripts/gen-mcp-json.mjs`.
- **`sh` is a hard Windows prerequisite (Git Bash).** `config/load-config.mjs` runs
  `sh -c '. load-config.sh; env'` so Node reads the *same* ports/paths the shell loader defines. If `sh`
  is missing it fails LOUDLY — it never silently falls back to a hardcoded port.
- **npm-workspace lockfile.** A new `mcp/<name>-server` is a workspace member; `npm install` at the
  **repo root** and commit `package-lock.json`, or CI's `npm ci` fails.
- **Sidecar ≠ bridge.** `search` (:8008) and `guardsvc` (:8009) are uv FastAPI **sidecars**, `vaultjobs`
  is a portless **runner**. They are supervised but **NOT** in `.mcp.json`/Cowork (`clients:[]`,
  `inMcpJson:false`), and probed leniently (`/healthz` for the uv pair; a process check for the runner —
  a cold uv venv listens before the engine is warm). Security asymmetry: `search` degrades to a keyword
  scan if down, but the **guard MCP fails CLOSED** if `guardsvc` is down (returns UNTRUSTED, never
  silent-clean) — so `idleExit`/idle-exit is never set on sidecars.
- **`idleExit` is bridge-only.** It adds `COS_MCP_IDLE_EXIT_MS` to reap supergateway's leaked idle child.
  Never on the Cowork direct-stdio entry (one long-lived child → it surfaces as *"server transport closed
  unexpectedly"*) and never on sidecars/runner.
- **Cowork rejects HTTP `url` entries; Claude Code requires them.** Cowork's `claude_desktop_config.json`
  takes only direct-stdio `command`/`args`/`env`; `.mcp.json` takes the HTTP urls. Mixing them up is the
  #1 wiring failure. After editing the Cowork file, ⌘Q + reopen Cowork. **Its path is `COWORK_CONFIG`**
  (from `config/load-config.sh`/`cos.env`) — macOS `~/Library/Application Support/Claude/…`, Windows
  `%APPDATA%/Claude/…`. cos-setup detects + records it per OS and `gen-cowork-config.mjs` refuses a
  missing dir, so the path is *confirmed*, never assumed — fix it in `cos.env` if Cowork lives elsewhere.
- **Add-on double-gate.** An add-on needs BOTH its server supervised AND `Settings.addons.<id>.enabled`;
  a disabled add-on's **writes** 404 while reads stay open. See *"Add-ons: supervision is always on…"* above.
- **Guard model is config, and an empty value fails loud.** `COS_GUARD_MODEL`/`COS_GUARD_THRESHOLD` come
  from `load-config.sh`. To disable the real model, set `COS_GUARD_MODEL=heuristic-only` — never a blank
  value (a blank `${COS_GUARD_MODEL}` is an unresolved-var error, by the "never silently guess" rule).
- **Use forward-slash paths on Windows.** `cos.env` paths (`NODE_BIN`, `WHATSAPP_MCP_DIR`, …) should use
  `/`. Tokens with spaces are quoted automatically for supergateway's `--stdio`, but keeping `REPO_ROOT`
  free of spaces avoids edge cases.

---

## Worked example — `nutrition` (:8007)

The `nutrition` add-on is the canonical "thin fetch-wrapper" example. Under the manifest it is: (1) the
board backend (data model + `board/app/api/nutrition/*` + the `board/lib/addons.ts` manifest + the
`assertAddonEnabled` gate); (2) the stdio server `mcp/nutrition-server/server.mjs` importing `mcp-kit` by
relative path; (3) `npm install` at root + committed lockfile; (4) `NUTRITION_BRIDGE_PORT=8007` in
`config/load-config.sh` (+ `cos.env.example`); (5) **one** descriptor
`mcp/nutrition-server/nutrition.service.json` (`kind/runtime: bridge`, `addon:"nutrition"`,
`env: {CRM_BASE_URL: "${BOARD_URL}"}`, `clients: ["claude-code","cowork"]`); (6) the generators install
the plist / Windows spawn / `.mcp.json` / Cowork entry from that descriptor; (7) `PATCH
/api/addons/nutrition {"enabled":true}` flips the gate. No template, no `SERVICES[]`, no probe-list edit.

---

## Commands

```sh
node mcp/service-manifest.mjs                 # human summary of all services
node mcp/service-manifest.mjs --json          # full resolved manifest (cos-services consumes this)
node mcp/service-manifest.mjs --probe-list    # name/port/kind/probe/gate (ensure-bridges consumes this)
node scripts/gen-mcp-json.mjs [--check]       # write (or CI-verify) .mcp.json
node scripts/gen-launchd.mjs [--print <name>|--out <dir>|--install]   # macOS plists (dry-run by default)
node scripts/gen-cowork-config.mjs [--print]  # Cowork stdio entries (backup-first merge)
node mcp/cos-services.mjs [start|watch|stop|status|restart|plan]      # Windows manager
```

---

## The manifest is the only source of plist truth

The manifest drives **everything**: the macOS launchd plists (`gen-launchd.mjs --install`, rendered
from the descriptors — there are **no** committed `*.plist.template` files anymore), the Windows
manager (`cos-services.mjs`), the probes (`ensure-bridges.sh` reads `--probe-list`), the committed
`.mcp.json` (`gen-mcp-json.mjs` + its CI sync-check), and the Cowork stdio entries
(`gen-cowork-config.mjs`). The setup **skills** install by calling those generators — they no longer
sed a template or hand-merge Cowork. So a service's plist content is edited in exactly one place: its
descriptor (+ `config/load-config.sh` for the port/path values). The macOS `gen-launchd --install`
path itself has not yet been exercised end-to-end on a real machine — verify a full setup pass before
relying on it.

For the actual runbooks — do **not** duplicate them here:

- **`config/load-config.sh`** — the single source of truth for ports/paths (read it first).
- **`/mcp-bridge-setup`** — wires the core servers (board/calendar/guard/vault) into both clients + the
  launchd bridges/sidecars.
- **`/cos-setup`** — the first-run orchestrator (setup-vault → guard-setup → mcp-bridge-setup →
  backup-recovery); contains the Windows setup section.
- Per-add-on skills (`/nutrition-mcp-setup`, `/openwhispr-mcp-setup`, `/whatsapp-mcp-setup`) — the Cowork
  entry + the add-on enable step for each.
- **`/debug-cowork-mcp-issues`** — the escalation ladder when a client "can't see" a server.

> This is a **component `CLAUDE.md`** (allowed by the root doc policy — component README/CLAUDE files
> stay next to the code). It is **not** MkDocs site content, so it is not wired into `mkdocs.yml`.
