---
name: cos-onboarding
description: The "you're set up — now actually use it" runbook. Run as the FINAL step of cos-setup (the handoff after the four component setups) AND anytime later as a re-runnable health-and-usage check. It does three things: (1) walks a single end-to-end VERIFY checklist that proves the whole system is up (board app, the launchd bridges + sidecars, the guard sidecar, and the Cowork connectors), (2) explains the day-to-day mental model — how the bridges auto-start every session, and the one recurring gotcha (Cowork only re-reads its config at launch, so ⌘Q-reopen + re-confirm connectors after any MCP change), and (3) installs the STARTER recipes as Cowork scheduled tasks — the minimal set (mail → /mail-to-board, WhatsApp → /whatsapp-triage, board housekeeping → /board-organize). Use at the end of first-run setup, when onboarding a new user who "doesn't know what to do now that it's installed", when someone asks "is everything running / how do I use this day to day", or when wiring the scheduled tasks for the first time.
allowed-tools: Bash, Read
---

# Cos — start using it (verify + day-to-day handoff)

This is the **last mile** of onboarding. The four component setups (`/setup-vault`,
`/guard-setup`, `/mcp-bridge-setup`, `/backup-recovery`, sequenced by `/cos-setup`) **wire** the
system; this skill **hands it over to the human** — it proves everything is actually up, explains
how Cos behaves in every later session, and gets the **recurring work scheduled in Claude Cowork**
so the board starts filling itself. It writes nothing destructive: every probe here is read-only
and re-runnable, so it doubles as the **anytime "is everything running / what do I do now?" check**.

Run it:
- **as the final step of `/cos-setup`** — right after the backup checkpoint passes; or
- **anytime later** — to re-verify health after a reboot, or to refresh a user on day-to-day use.

Every shell step begins with the loader line so nothing is hardcoded — it exports `$REPO_ROOT`,
`$BOARD_URL`, `$BOARD_PORT`, the bridge/sidecar URLs (`$GUARD_SIDECAR_URL`, `$SEARCH_SIDECAR_URL`,
each `*_BRIDGE_URL`), `$COWORK_CONFIG`, and the rest:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

---

## Part A — VERIFY: is the whole system up? (the one checklist)

Walk these in order. Tick each box out loud for the user; if one fails, jump to the named owning
skill, fix it, re-run that one probe, then continue. This is the single consolidated pass — it
folds together what each component skill checked in isolation.

- [ ] **1. The board app is running.** The bridges live without it, but the board UI (and the
  in-app health surfaces below) need the Next.js app up. Start it if it isn't:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BOARD_URL/api/addons")   # any 2xx = app serving
  case "$code" in 2*) echo "board UP at $BOARD_URL";; *) echo "board DOWN (HTTP $code) — start it: (cd \"$REPO_ROOT/board\" && npm run dev) then open $BOARD_URL";; esac
  ```
  `npm run dev` runs `mcp/ensure-bridges.sh` first (Part B), so starting the board is also the
  fastest way to bring the bridges up. (Owner if it won't start: the board README under `board/`.)

- [ ] **2. The bridges + sidecars are up.** `mcp/ensure-bridges.sh` is the canonical probe — it is
  re-runnable, nudges every launchd service up, and prints one line each:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  "$REPO_ROOT/mcp/ensure-bridges.sh"            # one "[mcp] <name> bridge up on :<port>" line per service
  launchctl list | grep chiefofstaff            # each agent + last exit code (0 = clean)
  ```
  Expect the core four (`board` :8001, `calendar` :8003, `guard` :8004, `vault` :8005) plus the
  `search`/`guardsvc` sidecars, and any add-ons you wired (`openwhispr` :8002, `whatsapp` :8006 +
  `whatsappbridge` :8010, `nutrition` :8007). A `WARN … DOWN` line names the service + its log
  (`mcp/logs/<name>.err.log`). (Owner: `/mcp-bridge-setup`; for an add-on, its own setup skill.)

- [ ] **3. Guard is honest.** The sidecar should report the real classifier (or the *deliberate*
  heuristic fallback):
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s "$GUARD_SIDECAR_URL/healthz"          # {"ok":true,"classifier":"model:…"}  (or "heuristic-fallback")
  curl -s "$SEARCH_SIDECAR_URL/healthz"         # {"ok":true}  (a cold one just degrades to keyword search)
  ```
  A *silent* `heuristic-fallback` when you wanted the model = not done → `/guard-setup`.

- [ ] **4. The in-app health surfaces are green.** With the board up, open and eyeball each:
  - **`/security`** — guard model + deps + the master toggle (Guard ships **OFF**; flip it ON here
    once its deps are ready, or deliberately leave it off).
  - **`/backups`** — last snapshot + recovery-key readiness (backups run nightly at 03:30 once
    `/backup-recovery` is set up).
  - **`/vault`** — vault wiring + the Obsidian deep-link (the ↗ lights up once the vault is opened
    in Obsidian; see `/setup-vault`).

- [ ] **5. Claude Cowork can see the connectors (the step people miss).** Cowork reads
  `claude_desktop_config.json` **only at launch** and gates each server's tools behind a one-time
  permission prompt. So, the **first open** (and after *any* change to the MCP config):
  1. **Quit + reopen Cowork (⌘Q)** so it re-reads the config.
  2. **Settings → Connectors** — confirm the local stdio servers (`board`, `calendar`, `guard`,
     `vault`, plus any add-ons) are listed + enabled. They appear automatically once the config
     parses; if they don't, it didn't parse → re-check `/mcp-bridge-setup` §5.
  3. **Allow their tools** — the first tool call per server prompts; choose **"Always allow"** per
     server so routine + scheduled runs aren't interrupted every call.

  (Claude **Code** uses the HTTP bridges via `.mcp.json` and skips this — connector approval is
  **Cowork-only**.) Confirm the config at least carries the servers:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  "$NODE_BIN" -e 'const fs=require("fs"),p=process.env.COWORK_CONFIG;const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};console.log("Cowork servers:",Object.keys(c.mcpServers||{}).join(", ")||"(none — config missing/unparsed → /mcp-bridge-setup §5)")'
  ```

When all five tick, **say so plainly** — "Cos is fully up: board running, all bridges live for
Cowork + Claude Code, guard classifying, live data under nightly off-site backup" — then move to
Part B (how it runs) and Part C (start using it).

---

## Part B — How Cos runs every session (the mental model the user needs)

Tell the user these four things; they answer "do I have to do anything to start it each day?"

1. **The bridges + sidecars are launchd-managed — a normal next session needs NO action.** The core
   four, the `search`/`guardsvc` sidecars, and any add-ons all `RunAtLoad` at login and
   **crash-restart** on their own (`KeepAlive`). Cowork and Claude Code reach them through the
   bridges whether or not the board dev app happens to be running.

2. **Starting the board self-heals them.** `cd board && npm run dev` (or `npm run start`) runs
   `mcp/ensure-bridges.sh` **first**, which bootstraps + kickstarts every service and prints one
   status line each. **Reading that startup block is the fastest health check** — and
   `mcp/ensure-bridges.sh` can be run on its own anytime (it never stops anything).

3. **The one recurring gotcha: Cowork only re-reads its config at launch.** This is the thing that
   bit you during setup. Whenever the MCP wiring changes — you add an add-on, re-run
   `/mcp-bridge-setup`, or a setup skill rewrites `claude_desktop_config.json` — you must **⌘Q and
   reopen Cowork**, then re-confirm the connector is listed/enabled and **re-allow its tools**
   (Part A step 5). Claude Code needs none of this (it talks HTTP). If a client suddenly "can't see"
   a server, this reopen is the first thing to try; then re-run `mcp/ensure-bridges.sh`.

4. **The two standing gestures.** Guard ships **OFF** — turn it ON in `/security` once its model
   deps are ready (or leave it off deliberately). Backups run **nightly at 03:30** on their own once
   `/backup-recovery` is set up — check `/backups` for the last snapshot.

---

## Part C — START USING IT: schedule the starter recipes in Cowork

Setup is the boring half. The board only fills itself once you **schedule the recurring work in
Claude Cowork**. There is deliberately **no host-side cron/launchd for this** — Cowork's
[**Scheduled Tasks**](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
are the only periodic trigger (type `/schedule`, pick a cadence, paste the task prompt). The
copy-pasteable task blocks live in the repo at **`board/.claude/skills/recipes/`** — read the one
you're installing and paste its block:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
ls "$REPO_ROOT/board/.claude/skills/recipes/"   # README.md, mail.md, voice.md, board-organize.md
```

### The minimal setup — wire these three on day one
This is the smallest set that makes Cos feel alive: two **reconcilers** that keep the board current
from your busiest channels, plus one **housekeeper** that keeps the board tidy.

| # | Schedule this prompt | Skill it runs | Suggested cadence | Needs |
|---|---|---|---|---|
| 1 | `/mail-to-board` (or paste `recipes/mail.md`) | **mail reconciler** — sweeps Gmail (received **and** sent) onto the board | every 10–15 min, or hourly | the Gmail MCP (Anthropic out-of-the-box) |
| 2 | `/whatsapp-triage` | **WhatsApp reconciler** — sweeps DMs + groups onto the board | hourly | the **WhatsApp add-on** (see Part D) |
| 3 | `/board-organize` (or paste `recipes/board-organize.md`) | **board housekeeper** — files the flat cards into Initiatives ▸ Workstreams | every 2–6 h, or daily | the `board` MCP (always present) |

To install each: in Cowork, **`/schedule` → pick the cadence → paste the prompt** in the table (the
bare `/skill` invocation is enough; the longer block in the matching `recipes/*.md` is the fully
spelled-out fallback for an unattended run). Both reconcilers **scan untrusted input through Guard
first**, **resolve every message to the person + case** it belongs to, **keep one card per matter**,
and **never undo a manual edit** — so running them often is cheap and safe (idempotent re-runs that
find nothing just no-op).

> **The auto-sync switch (set it before scheduling).** Every recipe routes through the same switch
> in **`config/auto-sync.json`** → `{ "autoSync": true }`. **`true`** (default) = process + write
> automatically and **log every action** for after-the-fact review. **`false`** = **approval mode**:
> prepare the changes but **confirm outward actions** (sending mail, creating/moving cases) first.
> Pick the posture the user is comfortable with on day one; flip it anytime.

### Add more once the minimal set is humming
Optional, each just a prompt over the same board + vault:
- **Voice** — paste `recipes/voice.md` (needs the **`openwhispr`** add-on, `/openwhispr-mcp-setup`).
- **Morning brief** *(weekdays, 7am)* — *"Read my board priorities + today's calendar and message me
  a short brief: what's on top, what moved overnight, what's waiting on me, the one thing not to drop."*
- **Meeting prep** *(early, for the day ahead)* — *"For each meeting on my calendar today, pull what
  the vault knows about the people + deal and the latest threads, and draft a one-page prep card
  linked to the case."*
- **Vault upkeep** *(Fridays)* — *"Ingest this week's resolved cases + voice notes and re-synthesize
  the people/deal pages so the second brain stays current."*

---

## Part D — WhatsApp add-on: the prerequisite that trips people up

`/whatsapp-triage` (recipe #2 above) needs the **WhatsApp add-on**, which is **not** wired by the
core setup — it is the most hands-on add-on, and the steps that surprised you are real prerequisites,
not optional polish. Run **`/whatsapp-mcp-setup`** and budget time for:

- **A Go toolchain (`brew install go`).** There is **no prebuilt binary** — the whatsmeow bridge is
  compiled with `go build`. Missing `go` → no bridge → no pairing and no triage.
- **The external `whatsapp-mcp` checkout** at `$WHATSAPP_MCP_DIR` (cloned by the skill) — it lives
  **outside** this repo.
- **A phone running WhatsApp, for the one-time QR pairing.** This is a **human-in-the-loop** step:
  the bridge prints a QR in the terminal that you scan from the phone (**WhatsApp → Settings →
  Linked Devices → Link a Device**). Until you see `Connected to WhatsApp` in
  `mcp/logs/whatsappbridge.out.log`, the MCP has no data. This is the analog of guard's gated-model
  login — it cannot be skipped or automated.
- **Two processes, two ports** — the Go bridge sidecar (`:8010`) holds the session; the Python MCP
  bridge (`:8006`) is what Cowork/Code talk to. **Reads tolerate the Go bridge being down**
  (the MCP reads SQLite directly), but a **fresh pairing or any send needs it live**.

Confirm before scheduling recipe #2:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
grep -q "Connected to WhatsApp" "$REPO_ROOT/mcp/logs/whatsappbridge.out.log" 2>/dev/null \
  && echo "WhatsApp session live" || echo "WhatsApp not paired yet — run /whatsapp-mcp-setup §3 (scan the QR)"
```

---

## Day-to-day quick reference (the card to leave the user with)

- **Talk to Cos in plain language** — in Claude Cowork/Code, or by dropping a note in WhatsApp or
  email; the scheduled recipes pick it up. From your phone, use **Claude Dispatch** to converse with
  Cos and drop cases on the board while away from your desk.
- **Health, anytime:** `mcp/ensure-bridges.sh` (one-shot probe) · `launchctl list | grep
  chiefofstaff` (agents + exit codes) · in-app **`/security`**, **`/backups`**, **`/vault`**.
- **A client can't see a server:** ⌘Q-reopen Cowork (it re-reads config only at launch) → re-confirm
  the connector + re-allow tools → if still missing, `mcp/ensure-bridges.sh`, then `/mcp-bridge-setup`.
- **Deeper trouble:** **`/debug-cowork-mcp-issues`** (Cowork/Code can't see a server, a tool call
  fails/times out, a server dies). Each component skill owns its own troubleshooting:
  `/setup-vault`, `/guard-setup`, `/mcp-bridge-setup`, `/backup-recovery`, the add-on skills.
</content>
</invoke>
