# Upgrading an existing install

`git pull` changes files. It does not rebuild the production board, restart a launchd bridge that is
still running the old server code, hand Cowork the rebuilt skill bundle it installed months ago, or
create the scheduled trigger `automation.json` just gained. Every one of those is a **silent no-op**:
the repo is green, the tests pass, and your sweeps run last month's procedure. Only the **store** takes
care of itself, and only in one direction — it migrates *up* on the next read and **refuses every
write** when the code is *older* than the file (`503 store-newer-than-code`, see
[Store migrations](migration.md#store-schema-versions-schemaversion)).

This page is the runbook. The **`cos-upgrade`** skill (Claude Code, `.claude/skills/cos-upgrade/`) is the
same runbook executed for you; **`scripts/upgrade-check.mjs`** is the deterministic planner both use.

## The short version

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
PRE_PULL="$(git rev-parse HEAD)"
node backup/backup.mjs                                  # hub: a snapshot BEFORE the store can change (exit 0 = pushed)
# hub: pause the Cowork scheduled tasks; freeze the board:
launchctl bootout gui/$(id -u)/com.chiefofstaff.mcp-boardapp
git pull --ff-only
node scripts/upgrade-check.mjs --from "$PRE_PULL"        # the ordered checklist for THIS machine
# ...apply the [auto] lines in order, then do the [manual] ones (bundles → mark-skill-uploaded, tasks, ⌘Q Cowork)...
curl -s "$BOARD_URL/api/healthz"; sh mcp/ensure-bridges.sh   # then a NEW Claude Code session; resume the tasks
```

Hub **first**, then every spoke. Browser-only viewers do nothing.

## What the planner derives, and from where

`upgrade-check` never mutates anything. It reads the git range, the
[service manifest](../architecture/mcp-servers.md), and — read-only — the live store's top-level
`schemaVersion` and the key names in your `config/*.env`, and maps **paths that changed → steps**:

| Changed | Step | Why it is silent otherwise |
|---|---|---|
| `board/lib/types.ts` bumps `SCHEMA_VERSION` | **backup first**; then the store migrates on the first read after the board restarts | the on-disk file is the only copy of your data; after the first write on new code an older board fails closed on it |
| the live store is **newer** than the target code | **BLOCKER** (exit 2 with `--strict`) | that is a downgrade — `migrate()` only knows its own collections |
| `package-lock.json` / `board/package-lock.json` | `npm install` / `(cd board && npm install)` | a bridge on a missing dep dies at spawn; the board build fails |
| any `*.service.json`, `mcp/service-manifest.mjs`, `scripts/gen-launchd.mjs`, `scripts/boardapp-run.mjs`, `mcp/ensure-bridges.*` | `node scripts/gen-launchd.mjs --install <the services installed here>` (re-renders + reloads exactly those; supersedes the per-service kicks). Never `--all` on an existing machine — it renders plists for add-ons never set up, which crash-loop under KeepAlive | the plist on disk is a rendering of the descriptor |
| `mcp/<name>-server/**` (a bridge's `stdio` source dir), `mcp/vault-server/**` (the `vaultjobs` runner), `guard/` or `search/` (a sidecar's `dir`) | `launchctl kickstart -k gui/$UID/<label>` for **that** service, if its plist is installed here — the step names the tools the server gained | a long-lived runner/sidecar serves the old code until its process restarts (a uv sidecar re-syncs its venv on start); a supergateway bridge spawns a fresh child per request, so there the stale part is the client — a **new Claude Code session** and a **⌘Q of Cowork**. `ensure-bridges.sh` only starts what is *down* |
| `board/**` or a lockfile, on a hub with the boardapp agent | **first** `launchctl bootout` the board (freeze), **last** `bootstrap` + `kickstart -k` it | no write lands between the snapshot and the new code; `npm install` never runs under a live `next start`; a build before deps land cannot poison `COS_BUILD_FAILED` |
| `packages/mcp-kit/**` | kick **every** installed bridge | they all embed it |
| `board/**` (outside `.claude/` and `data/`) | hub: `kickstart -k` the `boardapp` LaunchAgent (it rebuilds when the checked-out commit moved); dev: restart `next dev` | the production build is the old commit's |
| `board/.claude/skill-bundles/*.zip` — or, with an upload receipt, any zip whose sha256 differs from the one last marked uploaded here | **manual:** upload each in Cowork → Settings → Capabilities → Skills, then `node scripts/mark-skill-uploaded.mjs <skill>…` | Cowork installs the zip you uploaded, not the repo, and cannot be read back — the per-machine receipt (`mcp/logs/.cowork-skills-uploaded.json`) is what makes the drift computable |
| an add-on enabled in the store with no `com.chiefofstaff.mcp-<id>` plist here | **manual:** run `/<id>-mcp-setup` | the board serves its nav + API; no agent on this machine can reach it |
| `board/.claude/skills/automation.json` | **manual:** create / edit the listed Cowork scheduled tasks | a catalogued trigger runs nowhere until it exists in Cowork |
| `config/cos.env.example` / `secrets.env.example` gain keys your live files lack | **manual:** add them (then `gen-cowork-config.mjs` for a secret — Cowork holds an inlined copy) | the generators read `cos.env` |
| server code moved, or the Cowork config was regenerated | **manual:** quit + reopen Cowork Desktop | one long-lived stdio child per server |
| `.mcp.json` | **manual:** restart Claude Code sessions | read at start |
| `.claude/skills/**` | info — Claude Code reads them live | Cowork never sees this tree, by design |
| `docs/**` | info — the site deploys manually (maintainer) | — |

Only two rules are repo-shaped rather than manifest-derived: *any* `board/` change rebuilds the board,
and *any* `packages/mcp-kit/` change restarts every bridge. Everything else — which directory belongs
to which launchd label, which services run on a spoke, which are scheduled (never kicked, or they would
fire) — comes from the descriptors, so a new add-on needs no edit here.
[`tests/upgrade-check.mjs`](https://github.com/philipyaz/cos/blob/main/tests/upgrade-check.mjs) pins
the mapping (`run.sh` step `[13g]`).

**`--install` verifies every load it claims.** Each `launchctl bootstrap` / `kickstart -k` it runs is
checked: a non-zero exit means a named service genuinely FAILED to load — not a cosmetic problem, and
not something a re-run will silently fix. The stderr line `FAILED to load <label>: <reason>` names it,
and the process exits non-zero. Read that service's err log under `mcp/logs/` (path per its
descriptor), fix the cause, then re-run `node scripts/gen-launchd.mjs --install <name>`.  `--install`
also prints its selection first (`selected: <names>`), and a **bare** (default, core-only) invocation
additionally names any already-installed plists it left untouched — the line where a by-hand run sees
that `boardapp` was deliberately not restarted. That "not selected" note is scoped to the bare form:
the upgrade command above names `boardapp` explicitly, so on *this* path boardapp IS restarted.

Choosing `--from`: right after a pull the default is `ORIG_HEAD`; otherwise the commit the production
board was last **built** from (`board/.next/COS_BUILT_COMMIT`), which is the honest "what is running".
Pass `--from <ref>` explicitly in any other situation (`git reflog` shows what you were on).

The plan also pauses/resumes the Cowork routines around the window on a hub (a sweep that fires
mid-rebuild, or runs last month's bundle against the new API, fails halfway after writing), names the
tools each restarted server gained, and — on a spoke — tells you to confirm the hub is ahead before
restarting the wrappers. **Windows hub:** `node mcp/cos-services.mjs restart` respawns every bridge and
sidecar from the live manifest; `uv sync` the sidecar venvs by hand; stop and re-run
`scripts/boardapp-run.mjs` for the board.

## Restore and rollback rules

- **Restore a snapshot only onto a checkout whose `SCHEMA_VERSION` ≥ the snapshot's.** An older snapshot
  on newer code is fine (migrate-on-read). A newer snapshot on older code: `backup/restore.mjs` only
  **warns**, the copy succeeds, and the board then refuses every write (`503 store-newer-than-code`)
  until you pull. `node backup/restore.mjs --list` prints each snapshot's schema; compare it with
  `grep SCHEMA_VERSION board/lib/types.ts` before `--apply`, and always apply with no board answering.
- **Code rolls back with git; data does not.** Once a write has happened on the new code the store is
  at the new `schemaVersion` and an older board refuses it by design. A real rollback: take a final
  backup **from the new code** (post-upgrade writes must not be stranded) → `launchctl bootout` the
  board → `git checkout <previous>` + installs → `node backup/restore.mjs --date <pre-upgrade> --apply`
  → kick the board. Writes made between the upgrade and the rollback live only in that final snapshot
  (quarantined, not merged — the same trade `hub-handover` makes).

## Per-release upgrade notes

Release-please writes the [changelog](../changelog.md); this section records what each release asks of
an *existing* machine beyond `git pull` (the planner prints the same for your exact range).

### v0.1.0 → v0.2.0

- **Store schema 8 → 17.** Additive, migrate-on-read; no script. **Back up first** (`node
  backup/backup.mjs`, exit 0). From v14 the legacy `nutritionGoal` is re-homed into the Body add-on
  (`bodyProfile` / `bodyObjective`) and dropped on the next write — the one entry that is not a pure
  carry-forward. Ledger: [Store migrations](migration.md#store-schema-versions-schemaversion).
- **Set `COS_DEVICE_ID` in `config/cos.env` BEFORE the first backup run on the new code.** Backups are
  now per-device manifests keyed on it (default: the sanitised hostname); changing it later makes this
  device's own older snapshots look foreign to restore's device-scoped `latest` (`--device <hostname>`
  still finds them). Also new and optional: `COS_DEVICE_ROLE` (`hub` | `spoke` — anything else makes
  the loader fail loud), `COS_HUB_PUBLIC_URL`, `BACKUP_REPO_REF`.
- **New `config/cos.env` keys:** `COS_GUARD_MODEL`, `COS_GUARD_THRESHOLD` (the guard preset —
  `/guard-setup`), `NUTRITION_BRIDGE_PORT`, `FITNESS_BRIDGE_PORT`, `BODY_BRIDGE_PORT` (the add-on
  bridges). All have defaults in `config/load-config.sh`; copy the blocks from `config/cos.env.example`
  only for non-defaults.
- **Services are now manifest-rendered, and the old templates are gone.** The five committed
  `*.plist.template` files were deleted; every LaunchAgent comes from a `*.service.json` descriptor
  through `node scripts/gen-launchd.mjs --install <names>` (the board runs as the `boardapp`
  LaunchAgent; the search/guard sidecars, `vaultjobs`, and the backup agent are descriptors too).
  **Security fix included:** bridges are now pinned to `127.0.0.1` (`scripts/loopback-bind.cjs`) — a
  v0.1.0 hub keeps every bridge bound to all interfaces until it re-renders. Name the services you
  actually have (`launchctl list | grep chiefofstaff`); never `--all`.
- **`.mcp.json` is generated** (`scripts/gen-mcp-json.mjs`, CI-checked) and gained the `nutrition`,
  `fitness`, `body` entries; Cowork's config is regenerated by `scripts/gen-cowork-config.mjs` (⌘Q +
  reopen afterwards).
- **Add-ons:** Nutrition & Chef (`/nutrition-mcp-setup`), Fitness (`/fitness-mcp-setup`) and Body
  (`/body-mcp-setup`, auto-enabled under either) are optional — wire the ones you want; the
  `cos-setup` sequence (Steps 3.6–3.8) is the reference.
- **Operator skills are `.zip` bundles now.** Cowork installs each from
  `board/.claude/skill-bundles/<skill>.zip` (upload once per skill; re-upload when the planner says a
  bundle moved). The scheduled triggers to create are catalogued in `board/.claude/skills/README.md`.
- **Multi-device:** hub & spoke over Tailscale — [Multi-device](../architecture/multi-device.md). A
  machine that only *views* the board installs nothing.
- **Reach the new agent surfaces once, by hand:** a new Claude Code session (cached tool lists), ⌘Q +
  reopen Cowork (long-lived stdio children), and the scheduled tasks catalogued in
  `board/.claude/skills/README.md`.
