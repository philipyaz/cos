---
name: cos-setup
description: The single first-run entry point that stands up the WHOLE Cos system, sequencing the four component setup skills in dependency order — setup-vault → guard-setup → mcp-bridge-setup → backup-recovery. Use when setting up the chief of staff system, doing a first-run setup, onboarding a new machine, or asking for the full setup; also when you're unsure which component skill to run first and want the guided end-to-end runbook.
allowed-tools: Bash, Read
---

# Cos — full first-run setup (orchestrator)

This is the **root runbook** that brings the whole system up on a fresh machine. It does not
re-implement the component skills — it **sequences** them in the one order that works, because
each step produces what the next one needs: the **vault** must exist before the MCP can point at
it and before backup has something to protect; the **guard model** must be configured before the
guard bridge can report a real classifier; **all the bridges + sidecars** must be wired before
backup can snapshot live, populated stores. Run the four sub-skills **in order**, stop at each
**CHECKPOINT**, and only advance when it passes. End with the **§ End-to-end verification**.

Every shell step below begins with the loader line
`source "$(git rev-parse --show-toplevel)/config/load-config.sh"`, which exports `$REPO_ROOT`
(git-derived), `$BREW_PREFIX`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`, `$VAULT_DIR`, `$BOARD_URL`,
and the bridge/sidecar ports + URLs — use those instead of hardcoding paths, ports, or your
username. The only value still derived inline is `$U=$(id -u)`, which `launchctl` needs at runtime.

## Prerequisites checklist (gather these BEFORE step 1)
- [ ] **node + npm** (Homebrew) — bridges, vault Agent SDK, backup. `node -v`.
- [ ] **supergateway** — `npm install -g supergateway`. The stdio→HTTP bridge for Claude Code.
- [ ] **uv** (Homebrew: `brew install uv`) — runs the two Python sidecars (search `:8008`,
      guard `:8009`); self-provisions each venv on first launch.
- [ ] **hf CLI** (`pip install -U huggingface_hub` / `brew install huggingface-cli`) **+ a Llama
      license** — only if you want the real gated guard model (step 2). The heuristic-only fallback
      needs none of this.
- [ ] **ANTHROPIC_API_KEY** (`sk-ant-…`) in **`config/secrets.env`** — the **vault** bridge embeds
      the Agent SDK and makes outbound Anthropic calls; it is the only bridge that needs a key, and
      the key goes in this one gitignored file (the launch wrapper loads it), never in the plist.
- [ ] **A PRIVATE GitHub backup repo** + a **recovery passphrase** — step 4. Encrypted, off-site.

The whole system runs on these ports — keep them free
(`lsof -nP -iTCP:<port> -sTCP:LISTEN`): **3000** board app · **8001** board · **8003** calendar ·
**8004** guard · **8005** vault (core bridges) · **8002** openwhispr · **8006** whatsapp (optional
add-on bridges) · **8008** search · **8009** guard · **8010** whatsapp-go (sidecars). The `8002`
(openwhispr) and `8006`/`8010` (WhatsApp) ports are only needed if you run those optional add-ons
(Steps 3.4 / 3.5).

---

## The sequence

### Step 0 — seed runtime stores (fresh public clone only)
- **What it does** — a fresh clone of the public repo ships WITHOUT real runtime data
  (`board/data/cases.json`, `config/settings.json`, `guard/data/*.json` are gitignored). Seed the
  board + config once from the shipped synthetic counterparts so everything boots:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"; cd "$REPO_ROOT"
  cp tests/fixtures/board-seed.json board/data/cases.json   # board store — OR skip: the board
                                                            # auto-creates an EMPTY store if absent
  cp config/settings.example.json   config/settings.json    # then HAND-EDIT "principalEmail" to yours
  ```
  `config/settings.json` holds board/app prefs; you must set `principalEmail` by hand (the copy
  ships a placeholder — nothing auto-fills it). The next step (0.5) adds `config/cos.env` to the
  `config/` picture: the machine-local paths/ports for the skills.
- **Skip** on the private dev machine where the real stores already exist.
- **CHECKPOINT** — `config/settings.json` exists with your `principalEmail` (and `board/data/cases.json`
  exists, or you accept an empty board that the app creates on first run).

### Step 0.5 — generate `config/cos.env` (machine paths / ports for the skills)
- **What it does** — writes `config/cos.env`, the machine-local **public** config every skill
  reads through the loader: the absolute Homebrew prefix, the `node`/`uv`/`supergateway` binary
  paths, the LaunchAgents + Cowork config locations, the OpenWhispr store paths, the backup repo,
  and all the ports (board `:3000`, bridges `:8001–8005`, sidecars `:8008/:8009`). It writes
  **only** these public values — **no secrets**. The config split is deliberate, four files under
  `config/`:
  - **`cos.env`** — machine paths + ports for the **skills/setup** (this step). Public, gitignored.
  - **`secrets.env`** — the `ANTHROPIC_API_KEY` (step 3). The loader does **not** source it; only
    the vault bridge's launch wrapper does.
  - **`settings.json`** — board/app prefs incl. `principalEmail` (step 0).
  - **`auto-sync.json`** — the ingest router's auto-sync switch.
- **Idempotent** — never overwrites an existing `cos.env` (delete the file to regenerate, e.g. if
  you changed machines and `BREW_PREFIX` moved). `VAULT_NAME` is left blank here — **step 1
  (setup-vault) fills it** once your vault exists.
- **Why before the vault** — from here on every shell step in this skill and the component skills
  begins with the loader line `source "$(git rev-parse --show-toplevel)/config/load-config.sh"`,
  which sources this file and exports `$REPO_ROOT`, `$BREW_PREFIX`, `$LAUNCH_AGENTS_DIR`,
  `$COWORK_CONFIG`, `$OPENWHISPR_DB`, `$VAULT_DIR`, `$BOARD_URL`, the bridge/sidecar ports + URLs,
  etc. (`$REPO_ROOT` is git-derived, never stored in the file.) Generate it first so every step
  downstream resolves to your machine's real values.
- **Run** (the heredoc body must stay flush-left — `<<EOF` preserves leading whitespace, so do not
  indent these lines or `cos.env` would gain stray spaces):

```bash
# --- Step 0.5 · Generate config/cos.env (machine paths / ports for skills) ---
# Idempotent: never overwrites an existing cos.env (delete the file to regenerate).
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # sets $REPO_ROOT, $BREW_PREFIX, $HOME defaults
cd "$REPO_ROOT"
if [ -f config/cos.env ]; then
  echo "config/cos.env exists — leaving it untouched (delete it to regenerate). Current values:"
  grep -E '^[A-Z]' config/cos.env
  [ -d "$BREW_PREFIX" ] || echo "WARNING: BREW_PREFIX '$BREW_PREFIX' not found — changed machines? delete config/cos.env and re-run."
else
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# Cos — machine-local PUBLIC config (paths/ports for SKILLS + SETUP).
# Generated by cos-setup. Safe to edit. NO SECRETS (those live in config/secrets.env).
# Skills read this via: source "\$(git rev-parse --show-toplevel)/config/load-config.sh"
# ALWAYS QUOTE values (paths contain spaces). REPO_ROOT is git-derived, never stored here.
BREW_PREFIX="$BREW_PREFIX"
NODE_BIN="$BREW_PREFIX/bin/node"
UV_BIN="$BREW_PREFIX/bin/uv"
SUPERGATEWAY_BIN="$BREW_PREFIX/bin/supergateway"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
COWORK_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
# OpenWhispr voice add-on (optional; wired by openwhispr-mcp-setup) — paths to the desktop app's store.
OPENWHISPR_DB="$HOME/Library/Application Support/open-whispr/transcriptions.db"
OPENWHISPR_AUDIO_DIR="$HOME/Library/Application Support/open-whispr/audio"
BACKUP_REPO="$HOME/.cos-backups"
VAULT_NAME=""
BOARD_PORT="3000"
BOARD_BRIDGE_PORT="8001"
OPENWHISPR_BRIDGE_PORT="8002"
CALENDAR_BRIDGE_PORT="8003"
GUARD_BRIDGE_PORT="8004"
VAULT_BRIDGE_PORT="8005"
SEARCH_SIDECAR_PORT="8008"
GUARD_SIDECAR_PORT="8009"
# WhatsApp MCP add-on (optional; wired by whatsapp-mcp-setup). WHATSAPP_GO_PORT is the Go
# whatsmeow bridge sidecar (8010; whatsmeow's default 8080 is usually taken).
WHATSAPP_MCP_DIR="$HOME/Code/whatsapp-mcp"
WHATSAPP_MCP_BRIDGE_PORT="8006"
WHATSAPP_GO_PORT="8010"
EOF
  mv "$tmp" config/cos.env
  echo "Wrote config/cos.env — review it, then continue. setup-vault (Step 1) fills VAULT_NAME."
fi
```
- **CHECKPOINT** — `config/cos.env` exists, lists your real `BREW_PREFIX`, and sourcing the loader
  exports the vars:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  echo "$REPO_ROOT $BREW_PREFIX $LAUNCH_AGENTS_DIR"   # all three populated for your machine
  ```

### Step 1 — setup-vault (FIRST: create the knowledge target)
- **What it does** — creates a **private vault instance** from the committed template
  `$REPO_ROOT/vault/example-vault/` (`cp -R vault/example-vault vault/<name>`), points
  **`COS_VAULT_DIR`** at it (set ONLY in the installed launchd plist + the Cowork config — see
  step 3), **registers it with Obsidian and records its unique vault ID** in
  `config/settings.json` (so the board's `obsidian://` deep-links open THIS in-repo vault, not a
  same-named copy elsewhere — STEP 3.5 of setup-vault), **registers it in the backup `SCOPE`**
  (`backup/config.mjs`), and confirms it is **gitignored** (the real vault holds PII and is NOT
  git-backed — its durability comes from step 4's encrypted off-site backup; only `example-vault`
  is tracked).
- **Why FIRST** — the MCP needs a target to scope `COS_VAULT_DIR` to, and backup needs something
  to protect. Nothing downstream works without the vault directory existing.
- **Prereq** — the committed template `$REPO_ROOT/vault/example-vault/` is present (it ships with
  the repo). Confirm: `ls "$REPO_ROOT/vault/example-vault/"`.
- **Run** — invoke **`/setup-vault`** (or follow its steps): `cp -R vault/example-vault vault/<name>`,
  fill `__VAULT_NAME__` where used, add `"vault/<name>"` to `SCOPE` in `backup/config.mjs` (and
  remove an old vault entry if this replaces it).
- **CHECKPOINT** — all three must hold before step 2 (`VAULT_DIR` resolves to
  `$REPO_ROOT/vault/$VAULT_NAME` once setup-vault has set `VAULT_NAME` in `cos.env`):
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  ls "$VAULT_DIR" >/dev/null && echo "vault dir OK"
  git -C "$REPO_ROOT" check-ignore "vault/$VAULT_NAME" && echo "gitignored OK"   # prints the path = ignored
  grep -q "vault/$VAULT_NAME" "$REPO_ROOT/backup/config.mjs" && echo "in backup SCOPE OK"
  ```
  Plus, for board deep-links to open the right vault: `config/settings.json` should carry a 16-char
  `obsidianVaultId` (setup-vault STEP 3.5). A **blank** id is non-fatal — the in-app vault preview
  still works and the board disables the ↗ "open in Obsidian" arrow — but flag it so the user can
  Open-folder-as-vault in Obsidian and re-run STEP 3.5 to enable deep-links:
  ```sh
  grep -o '"obsidianVaultId": *"[^"]*"' "$REPO_ROOT/config/settings.json" || echo "WARN: no obsidianVaultId — ↗ deep-links disabled until setup-vault STEP 3.5"
  ```

### Step 2 — guard-setup (the prompt-injection classifier model)
- **What it does** — configures the **guard classifier model** the sidecar (`guard/sidecar.py`,
  `:8009`) runs: picks a preset (default the **gated Meta `Llama-Prompt-Guard-2-86M`**), accepts the
  Llama license + authenticates with `hf`, prefetches the model, sets
  `COS_GUARD_MODEL`/`COS_GUARD_THRESHOLD`/`COS_GUARD_CLASSIFIER`, installs the guardsvc launchd
  plist from its committed template, and verifies the sidecar reports the **real model**, not the
  `heuristic-fallback`. (The guard MCP *bridge* on `:8004` is wired in step 3 — this step is just
  the model + `:8009` sidecar.)
- **Why now (before the bridges)** — wiring the guard bridge is pointless until the sidecar behind
  it reports a real classifier; do the model first so step 3's `:8004` check is meaningful. Guard
  is OFF by default and the board's `/security` toggle stays gated until the model's deps are ready.
- **Prereq** — **uv**, the **hf** CLI, and an **accepted Llama license** for the gated default.
  No license / can't gate? Use the **heuristic-only** preset (zero-dependency, no download, no
  token) — honest but degraded; you can upgrade to the model later.
- **Run** — invoke **`/guard-setup`** (or follow its steps: `hf auth login` → `hf download
  meta-llama/Llama-Prompt-Guard-2-86M` → `uv sync --directory "$REPO_ROOT/guard" --extra model` →
  install the `guard/deploy/com.chiefofstaff.mcp-guardsvc.plist.template` → `kickstart -k`).
- **CHECKPOINT** — the sidecar is up and reports the real model (not the heuristic):
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s "$GUARD_SIDECAR_URL/healthz"
  # {"ok":true,"classifier":"model:meta-llama/Llama-Prompt-Guard-2-86M",...}
  ```
  `classifier` must read `model:…` (or, deliberately, `heuristic-fallback` if you chose the
  heuristic-only preset). A *silent* `heuristic-fallback` when you wanted the model = not done —
  see guard-setup → Troubleshooting (force `COS_GUARD_CLASSIFIER=promptguard` to surface the cause).

### Step 3 — mcp-bridge-setup (wire the CORE servers + sidecars)
- **What it does** — wires the **four core** stdio MCP servers (**board, calendar, guard,
  vault**) into both clients: **Cowork** spawns them directly as stdio `command` entries in
  `claude_desktop_config.json`; **Claude Code** reaches them over HTTP via `$REPO_ROOT/.mcp.json`,
  each a **supergateway + launchd** bridge on **8001/8003/8004/8005**. Also loads the two **uv
  sidecars** — search `:8008` and guard `:8009` — and `mcp/ensure-bridges.sh` (chained into
  `board`'s `dev`/`start`) so the app brings the bridges up. (The optional **openwhispr** voice
  server on `:8002` is wired by **Step 3.4**'s add-on skill, not here.)
- **The vault bridge is special** — `:8005`, launchd label `com.chiefofstaff.mcp-vault`. Unlike the
  other four it embeds the Agent SDK and makes outbound Anthropic calls, so it needs an
  **`ANTHROPIC_API_KEY`**. The key is **NOT in the plist**: the plist's `ProgramArguments` runs
  the launch wrapper **`mcp/vault-server/launch.sh`**, which sources the gitignored
  **`config/secrets.env`** (copied from `config/secrets.env.example`) and exports the key before
  exec'ing supergateway — so the secret lives in one machine-local file, never in the installed
  plist or a committed file. `COS_VAULT_DIR` (= `$VAULT_DIR`, i.e. `$REPO_ROOT/vault/$VAULT_NAME`)
  IS set in the installed plist (`EnvironmentVariables`) and the Cowork config; the **committed**
  template `mcp/vault-server/deploy/com.chiefofstaff.mcp-vault.plist.template` carries only the
  `__REPO__` + `__VAULT_NAME__` placeholders (their values come from `$REPO_ROOT` / `$VAULT_NAME`;
  the API key has no placeholder — it stays in `config/secrets.env`). Restart it after editing the
  key or the plist (rotating the key needs only this restart, no plist edit):
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
  launchctl bootout   gui/$U/com.chiefofstaff.mcp-vault 2>/dev/null || true
  launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist"
  launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-vault
  ```
- **Prereq** — node + supergateway; the **vault from step 1** (the bridge's `COS_VAULT_DIR`
  target); the **guard model from step 2** (so `:8004` reports the real classifier); an
  **ANTHROPIC_API_KEY** in **`config/secrets.env`** (`cp config/secrets.env.example config/secrets.env`,
  then edit in the `sk-ant-…` key) for the vault bridge.
- **Run** — invoke **`/mcp-bridge-setup`** (or follow its steps: per-server plists for the core
  four on 8001/8003/8004/8005, the search + guardsvc sidecar plists, register Cowork stdio +
  Claude Code `.mcp.json`, `mcp/ensure-bridges.sh`).
- **CHECKPOINT** — all four core bridges answer an MCP `initialize`, and the vault one is scoped:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
  launchctl list | grep chiefofstaff      # PIDs present, exit 0
  for p in "$BOARD_BRIDGE_PORT" "$CALENDAR_BRIDGE_PORT" "$GUARD_BRIDGE_PORT" "$VAULT_BRIDGE_PORT"; do
    curl -s -X POST "http://127.0.0.1:$p/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
      | grep -o '"name":"[a-z]*"' | head -1
  done
  # expect: board / calendar / guard / vault
  ```
  The vault server's ready line (`$REPO_ROOT/mcp/logs/vault.out.log`) must echo your
  `COS_VAULT_DIR` (= `$VAULT_DIR`). `serverInfo.name=="vault"` confirms the vault bridge
  (`$VAULT_BRIDGE_PORT`).

### Step 3.4 — openwhispr-mcp-setup (OPTIONAL: the voice-notes add-on)
- **What it does** — wires the **`openwhispr`** voice server (a Node stdio MCP fronted by a
  supergateway + launchd bridge on `:8002`, plus a direct Cowork stdio entry) so the voice recipe
  and **`/second-brain-ingest`** can read your OpenWhispr transcripts and route them onto the
  board / vault. Entirely optional: skip it if you don't use the OpenWhispr desktop app.
- **Why HERE (after the core bridges)** — it reuses the same supergateway/launchd/`ensure-bridges.sh`
  machinery Step 3 set up, and routing voice notes depends on the **board** + **vault** MCPs already
  being live (Steps 1–3). Its only external state is the app's own store, so its position relative
  to Step 4 doesn't matter.
- **Prereq** — node + supergateway (from Step 3) and the **OpenWhispr desktop app installed with at
  least one recorded note** (so `$OPENWHISPR_DB` exists). No app yet? Skip this step, or wire it
  against the bundled fixtures for a dry run (see the skill).
- **Run** — invoke **`/openwhispr-mcp-setup`** (confirm the store → install the `:8002` bridge plist
  → register both clients → wire `ensure-bridges.sh` → verify `list_transcripts` reports
  `Source: sqlite`).
- **CHECKPOINT** — the openwhispr MCP answers and reads the real store:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$OPENWHISPR_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"openwhispr"' && echo "openwhispr MCP OK"
  ```

### Step 3.5 — whatsapp-mcp-setup (OPTIONAL: the WhatsApp add-on)
- **What it does** — stands up the **external** `whatsapp-mcp` repo (the Go whatsmeow bridge as a
  launchd SIDECAR on `:8010`, the Python stdio MCP as a supergateway BRIDGE on `:8006`), does the
  one-time **QR pairing** against your phone, and registers `whatsapp` in `.mcp.json` + the Cowork
  config — so the **`/whatsapp-triage`** skill can reconcile WhatsApp onto the board exactly like
  `/mail-to-board` does Gmail. Entirely optional: skip it if you don't want WhatsApp on the board.
- **Why HERE (after the bridges)** — it reuses the same supergateway/launchd/`ensure-bridges.sh`
  machinery Step 3 set up, and `/whatsapp-triage` depends on the **board** + **guard** MCPs already
  being live (Steps 2–3). Its external `store/` is **not** covered by Step 4's backup (that protects
  the Cos repo's own stores), so its position relative to Step 4 doesn't matter.
- **Prereq** — **go** (builds the bridge), **uv**, **supergateway**, the **whatsapp-mcp checkout**
  at `$WHATSAPP_MCP_DIR`, and a **phone running WhatsApp** for the QR pairing.
- **Run** — invoke **`/whatsapp-mcp-setup`** (clone/build → QR pair → install both LaunchAgents →
  register both clients → wire `ensure-bridges.sh` → verify `list_chats`).
- **CHECKPOINT** — the whatsapp MCP answers and returns chat data:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$WHATSAPP_MCP_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"whatsapp"' && echo "whatsapp MCP OK"
  ```

### Step 4 — backup-recovery (LAST: protect the now-populated stores)
- **What it does** — stands up **daily AES-256-GCM-encrypted, off-site** snapshots of the live
  stores (board `board/data/`, guard `guard/data/`, `config/`, and the **vault**) to a private
  GitHub repo, with the recovery key in the macOS Keychain (`cos-backup-key`) + an offline copy.
- **Why LAST** — backup snapshots the **populated** stores; running it before the vault exists and
  the bridges are wired would back up an empty/partial system. The backup `SCOPE` already lists the
  vault entry you added in step 1.
- **Prereq** — a **private GitHub backup repo** (e.g. `gh repo create cos-backups --private`) and a
  **recovery passphrase** stored in the macOS Keychain as `cos-backup-key` (plus a password-manager
  copy — it is unrecoverable). The backup LaunchAgent (`com.chiefofstaff.backup`, daily 03:30)
  reads `backup/config.mjs` at run time, so SCOPE edits need no restart.
- **Run** — invoke **`/backup-recovery`** (§1 Setup: generate + store the key, create + clone the
  repo, first backup + verify, install the daily LaunchAgent).
- **CHECKPOINT** — the key exists and a backup verifies end-to-end:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"; cd "$REPO_ROOT"
  security find-generic-password -s cos-backup-key -w >/dev/null 2>&1 && echo "key OK"
  node backup/backup.mjs && node backup/restore.mjs   # backup, then DRY-RUN verify (no writes)
  # → auth tag OK ✓ / sha256 OK ✓ / JSON-verified ✓ ; and "vault/$VAULT_NAME" appears in the manifest
  ```

---

## End-to-end verification (the whole system, after all four steps)
Run from the repo root with the board dev app up (`cd board && npm run dev`, port `$BOARD_PORT`).
Start each shell with `source "$(git rev-parse --show-toplevel)/config/load-config.sh"`:

1. **All four core bridges answer** (the step-3 loop) → `board / calendar / guard / vault` (plus
   `openwhispr` on `:8002` if you ran the Step 3.4 add-on). `launchctl list | grep chiefofstaff`
   shows each with exit 0.
2. **Guard sidecar healthy** — `curl -s "$GUARD_SIDECAR_URL/healthz"` → `{"ok":true,
   "classifier":"model:…"}` (or the deliberate `heuristic-fallback`). The **search** sidecar is
   best-effort: `curl -s "$SEARCH_SIDECAR_URL/healthz"` → `{"ok":true}` (a cold/absent one just
   degrades the board to keyword search — not a failure).
3. **A test vault ingest + query round-trips** — drop a throwaway note into the vault and read it
   back through the vault MCP (`$VAULT_BRIDGE_URL`); the inner Agent SDK session is scoped to your
   `COS_VAULT_DIR` (= `$VAULT_DIR`), so it must find what you just wrote and return it.
   (Equivalently, use `/second-brain-ingest` then `/second-brain-query`.) Remove the throwaway note
   after.
4. **A backup dry-run verifies** — `node backup/backup.mjs && node backup/restore.mjs` →
   `auth tag OK ✓ / sha256 OK ✓ / JSON-verified ✓`, with `vault/$VAULT_NAME` present in the
   manifest.

If all four pass, the Cos system is fully stood up: vault populated, guard classifying,
all bridges live for Cowork + Claude Code, and the live data under encrypted off-site backup.
Tell the user so, then hand off with the **first-open** and **Day-to-day** notes below.

## First open in Claude Cowork — confirm the connectors + allow their tools
The config is wired, but **Cowork reads `claude_desktop_config.json` only at launch** and gates tool
calls behind a permission prompt. Walk the user through the one-time activation:

1. **Quit + reopen Cowork (⌘Q)** so it re-reads the config.
2. **Settings → Connectors** — confirm the local MCP servers (**board**, **calendar**, **guard**,
   **vault**, plus **openwhispr**/**whatsapp** if added) are listed and enabled. They run as local
   stdio `command` servers (not custom HTTP connectors), so they appear automatically once the config
   is read — if they don't, it didn't parse: re-check §5 of **/mcp-bridge-setup**.
3. **Allow their tools** — the first time an agent calls a server's tool, Cowork asks for permission;
   choose **"Always allow"** per server so routine agent runs aren't interrupted by a prompt every
   call (or approve per-tool if you prefer — "Always allow" is the smooth default for your own local
   servers).

(Claude Code uses the HTTP bridges via `.mcp.json` and skips this — the connector-approval step is
Cowork-only.)

## Day-to-day: running Cos in later sessions
After setup, most of it runs itself — make sure the user knows how to live with it and how to check health:

- **The bridges + sidecars are launchd-managed.** All nine (`board`, `calendar`, `guard`, `vault`, the
  optional `openwhispr`/`whatsapp` add-ons, and the `search`/`guardsvc` uv sidecars) start at login and
  **crash-restart** on their own (`KeepAlive`). A normal next session needs **no action** — Cowork and
  Claude Code reach them through the bridges whether or not the board dev app is running.
- **Starting the board self-heals them.** `cd board && npm run dev` (or `npm run start`) runs
  `mcp/ensure-bridges.sh` *first*, which bootstraps + kickstarts every service and prints one line each
  (`[mcp] vault bridge up on :$VAULT_BRIDGE_PORT` … or `WARN: <name> bridge DOWN on :<port> — see
  mcp/logs/<name>.err.log`). Reading that startup block IS the fastest health check.
- **One-shot health check anytime:** run `mcp/ensure-bridges.sh` directly — it is re-runnable and never
  stops anything, so it's the canonical "is everything up?" probe. Backstops: `launchctl list | grep
  chiefofstaff` (each agent + last exit code; `0` = clean) and `curl -s "$GUARD_SIDECAR_URL/healthz"` /
  `curl -s "$SEARCH_SIDECAR_URL/healthz"` for the sidecars.
- **In-app health surfaces:** **`/security`** (guard model, deps, master toggle), **`/backups`** (last
  snapshot + recovery-key readiness), **`/vault`** (vault wiring + Obsidian deep-link).
- **When a client can't see a server:** re-run `mcp/ensure-bridges.sh`; if it's still missing, re-run
  **/mcp-bridge-setup**. Per-service logs for any WARN/DOWN live in `mcp/logs/<name>.{err,out}.log`.
- **The two standing gestures:** Guard ships **OFF** — flip it ON in `/security` once its model deps are
  ready (or deliberately leave it OFF; see **/guard-setup**). Backups then run **nightly at 03:30** on
  their own once **/backup-recovery** is set up.

## If something fails
Each component skill owns its own troubleshooting — jump straight there:
**/setup-vault** (template/gitignore/SCOPE), **/guard-setup** (GatedRepoError, silent heuristic
fallback, cold sidecar), **/mcp-bridge-setup** (the node/simdjson + pm2 gotchas, a bridge DOWN,
Cowork can't see a server), **/backup-recovery** (bad magic / auth-tag throw / sha256 mismatch on
restore). Re-run only the failing step, re-check its CHECKPOINT, then resume the sequence.
