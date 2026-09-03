---
name: cos-upgrade
description: Upgrade an EXISTING Cos install to the latest code — the post-pull runbook for a machine that already ran cos-setup (a hub) or spoke-setup (a spoke). It takes an on-demand backup, pulls, runs scripts/upgrade-check.mjs (the diff → checklist planner), applies every automatable step in order (npm install, gen-launchd --install, kickstart -k of exactly the bridges/sidecars whose code moved, the production board rebuild), and hands you the manual residue — Cowork bundle uploads, scheduled tasks to create, new config keys, a Cowork restart. The store migrates itself on the next board start (fail-closed the other way); everything ELSE keeps running the old version silently until this skill kicks it. Use when the user says "update Cos", "pull the latest changes", "upgrade my install", "I pulled and things look stale", "the board shows store-newer-than-code", after merging PRs on the hub, or on every spoke after the hub was upgraded. NOT for the first machine (cos-setup) or for joining a machine (spoke-setup).
allowed-tools: Bash, Read
---

# Cos — upgrade an existing install (the post-pull runbook)

`git pull` changes **files**. It does not rebuild the production board, restart a launchd bridge that
still runs the old server code, hand Cowork the rebuilt skill bundle it installed months ago, or create
the scheduled trigger `automation.json` just gained. Each of those is a **silent no-op** — the repo is
green, the tests pass, and your sweeps run last month's procedure. Only the **store** takes care of
itself, and only in one direction: it migrates *up* on the next read, and **refuses every write** when
the code is *older* than the file (`503 store-newer-than-code`) — see
[`docs/reference/migration.md`](../../../docs/reference/migration.md).

This skill is the deterministic answer. The planner (`scripts/upgrade-check.mjs`) turns *what your
pull changed* into *the ordered list of what this machine must do*; you apply it. Never re-run
`cos-setup` to upgrade — it is the first-run path and assumes empty state.

> **Roles.** A **hub** runs the board, the store, the sidecars and the backup. A **spoke** runs only the
> board-facing MCP wrappers. Upgrade the **hub first**, then every spoke (a wrapper newer than the hub
> calls routes the hub does not have yet).

## Step 0 — preflight (read-only)

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # REPO_ROOT, BOARD_URL, ports, COS_DEVICE_ROLE
cd "$REPO_ROOT"
git status --porcelain            # must be EMPTY — a dirty tree makes the pull ambiguous; stash or commit first
git rev-parse --abbrev-ref HEAD   # expect main (an upgrade tracks main or a release tag, never a feature branch)
PRE_PULL="$(git rev-parse HEAD)"; echo "running: $PRE_PULL"
echo "role: ${COS_DEVICE_ROLE:-hub}"
[ "${COS_DEVICE_ROLE:-hub}" = hub ] && curl -s "$BOARD_URL/api/healthz"   # note appVersion / schemaVersion / diskSchemaVersion BEFORE
```

CHECKPOINT: clean tree on `main`, `PRE_PULL` captured, healthz answered (hub). On a **spoke**, also
confirm the hub is already upgraded: `curl -s "$BOARD_URL/api/healthz"` must report an `appVersion` /
`schemaVersion` ≥ what you are about to pull (compare with `git show origin/main:package.json` and
`git show origin/main:board/lib/types.ts | grep SCHEMA_VERSION`).

## Step 1 — back up, pause, freeze (hub only; ALWAYS before the store can change)

```bash
node backup/backup.mjs; echo "backup exit $?"   # must be 0 (written AND pushed); 2 = local only (note it), 4 = not the lease-holding hub (STOP)
```

If backup is not set up here, copy `board/data/cases.json` somewhere safe by hand **now** — after the
first write on the new code, that file is at the new schema and an older board cannot use it. This
snapshot is the only rollback point (see *Rollback* below). A spoke has no store: skip.

Then, still on the hub:

- **Pause the Cowork scheduled tasks** (Cowork → *Scheduled Tasks*) for the upgrade window. A sweep
  that fires while the board rebuilds, or runs last month's bundle against the new API, fails halfway
  — after it has already written something. You resume them in Step 6.
- **Freeze the production board** before anything is installed or built:
  `launchctl bootout gui/$(id -u)/com.chiefofstaff.mcp-boardapp` (and quit any hand-run `next dev`
  on the board port). Nothing lands between the snapshot and the new code, `npm install` never runs
  under a live `next start`, and a build attempted before deps land cannot poison
  `board/.next/COS_BUILD_FAILED` for the new commit. `tailscale serve` answers 502 until Step 4
  brings the board back — expected.

## Step 2 — pull

```bash
git pull --ff-only                # a release tag instead: git fetch --tags && git checkout vX.Y.Z
```

`--ff-only` refuses a diverged local `main` instead of creating a merge commit; if it refuses, resolve
that first (`git log --oneline origin/main..HEAD` shows what is local-only).

## Step 3 — plan (read-only)

```bash
node scripts/upgrade-check.mjs --from "$PRE_PULL"        # the checklist for THIS machine (role-aware)
node scripts/upgrade-check.mjs --from "$PRE_PULL" --json # the same, for an agent to walk
```

Read it top to bottom. Each step is tagged **[auto]** (a command), **[manual]** (only you can do it),
or **[info]**. A **BLOCKER** line (the store is *newer* than the code you moved to — a downgrade) means
STOP: check out a commit whose `SCHEMA_VERSION` ≥ the store's, or restore the Step 1 snapshot.

## Step 4 — apply the [auto] steps, in the printed order

The order matters and the planner already sorted it: **deps → config keys → services → board**.

```bash
npm install && (cd board && npm install)                    # only when a lockfile changed (the plan says which)
node scripts/gen-launchd.mjs --install <installed names>    # only when a descriptor / generator changed — the plan names EXACTLY the services installed here; never --all
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-<name>   # each runner/sidecar/bridge the plan lists — the label is the manifest's
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chiefofstaff.mcp-boardapp.plist; launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-boardapp   # hub: rebuild (the commit moved) + start
node scripts/gen-cowork-config.mjs                          # only when the plan says the Cowork config snapshot is stale
```

Two staleness classes, and why the plan restarts what it restarts:

- **Long-lived processes serve the old code until their process restarts** — the production board
  (`next start`), the `vaultjobs` runner, the `guardsvc` / `search` uv sidecars (a `uv run` sidecar
  re-syncs its venv from `uv.lock` on start, so `kickstart -k` is the whole step; the guard MCP fails
  CLOSED while it restarts). `mcp/ensure-bridges.sh` only *starts what is down* (plain `kickstart`)
  and never stops anything — it does not refresh code.
- **A supergateway bridge spawns a fresh child per request**, so its next call already runs the pulled
  server; the kick only reaps idle pre-pull children. The stale part is the **client**: an open Claude
  Code session caches `tools/list` — start a **new session** (or `/mcp` → reconnect) — and Cowork holds
  one long-lived child per server — **⌘Q + reopen**.

The production board: `boardapp-run.mjs` builds only `main` — a tree parked on a feature branch keeps
serving whatever was last built and refuses to build anything else. A running **supervised** board (the
launchd job) notices within about a minute when `main` has moved and redeploys itself, so on a hub
**the `git pull` in Step 2 is itself what arms the redeploy** — Step 1's `bootout` *before* pulling is
what keeps the full freeze intact. A moved `board/package-lock.json` triggers `npm ci` before the build.
A failed build writes `board/.next/COS_BUILD_FAILED`
and will **not** retry on that commit — fix the cause (usually a missed `npm install`), `rm` the marker,
kick again; read `mcp/logs/boardapp.err.log`. Never `kickstart -k` the scheduled **backup** job — that
fires a backup (use `node backup/backup.mjs` when you want one).

**Dev machine (no boardapp LaunchAgent):** restart your `npm run dev`. **Never** run `next build` in
`board/` while a `next dev` is up — they share `.next` and the running board 500s until restarted.

**Windows hub:** `node mcp/cos-services.mjs restart` respawns every bridge + sidecar from the live
manifest (no render step); `uv sync` the sidecar venvs by hand (their uvicorn is called directly); stop
the running `boardapp-run.mjs` and re-run it (same rails — though rail 7 is supervised-only, so a
hand-run wrapper never self-exits; re-running it by hand IS the deploy there); the backup is a Task
Scheduler job (re-read from disk each fire). Stop a `cos-services watch` supervisor first — it would
respawn the old processes.

## Step 5 — the manual residue (the planner lists exactly which apply)

- **Cowork skill bundles** — for every `board/.claude/skill-bundles/<skill>.zip` the plan names:
  Cowork → *Settings → Capabilities → Skills* → upload it (replacing the installed copy). Nothing in the
  repo can do this and nothing can read it back: until you do, the scheduled sweep runs the **previous**
  procedure. **Then record it** — `node scripts/mark-skill-uploaded.mjs <skill>…` writes a per-machine
  receipt (`mcp/logs/.cowork-skills-uploaded.json`, the sha256 of each zip you uploaded). With a receipt
  the next plan lists exactly the bundles whose bytes differ from what this machine last uploaded —
  however many pulls ago they changed — instead of guessing from the git range. First time: upload
  everything and run `node scripts/mark-skill-uploaded.mjs --all`; `--list` shows the receipt vs the
  committed zips at any time.
- **An enabled add-on with no bridge here** (the plan's `addon-unwired` line): the board serves its nav +
  API, but no agent on this machine can reach it — run the named `/<addon>-mcp-setup`. Classic case:
  Nutrition or Fitness was enabled before `body` auto-enabled under them, and `/body-mcp-setup` never ran.
- **Scheduled tasks** — for every `CREATE` / `EDIT` line: Cowork → *Scheduled Tasks* → create the
  trigger string verbatim (the catalog in `board/.claude/skills/README.md` is the source of truth).
- **New config keys** — copy each named key's block from `config/cos.env.example` into
  `config/cos.env` (and `secrets.env.example` → `secrets.env`), then re-run the generator the plan
  names. Secrets reach Cowork as an inlined **copy** — a new secret needs `gen-cowork-config.mjs` too.
- **Restart Cowork Desktop** whenever server code moved — it holds one long-lived stdio child per
  server. **Restart Claude Code sessions** when `.mcp.json` changed.

## Step 6 — verify

```bash
curl -s "$BOARD_URL/api/healthz"    # hub: schemaVersion == the new code's, diskSchemaVersion <= it, degradedRead:false, appVersion == package.json
sh mcp/ensure-bridges.sh            # every installed service answers on its port (a DOWN line names the log to read)
node scripts/pack-skills.mjs --check && node scripts/gen-mcp-json.mjs --check   # the committed artifacts are in sync
```

Then open the board once: the first read migrates the store; the first write stamps the new
`schemaVersion` (`diskSchemaVersion` catches up in healthz). From that moment, **never run a board
built from older code against this store**, and **restore a snapshot only onto a checkout whose
`SCHEMA_VERSION` ≥ the snapshot's** — `node backup/restore.mjs --list` prints each snapshot's schema;
`restore.mjs` only WARNs on a newer snapshot, and the board then fails closed until you pull. Resume the
Cowork scheduled tasks you paused in Step 1.

Prove the agent path end-to-end in a **new** Claude Code session: `mcp__board__get_device_status`, then
one tool this pull added (the plan's restart lines name them) — a `Not found.` here means a wrapper is
ahead of the hub.

## Rollback

Code rolls back with git; **data does not roll back with git.** If you must return to the previous
version *after* a write happened on the new code: `git checkout <PRE_PULL>`, rebuild/restart, and
**restore the Step 1 snapshot** (`node backup/restore.mjs` — see `/backup-recovery`); the store on disk
is at the newer schema and the old board fails closed on it by design. Writes made between the
upgrade and the rollback are lost — that is the trade the snapshot protects you from forgetting.

## Multi-device order

1. Hub: Steps 0–6.
2. Each spoke: Step 0 (confirm the hub is ahead — the one-liner below) → Step 2 → Step 3 → Step 4 (it
   will list only the spoke-capable bridges — `board`, `calendar`, enabled add-on wrappers) → Step 5
   (Cowork bundles + restart apply on a spoke too) → `sh mcp/ensure-bridges.sh`. A spoke has no store,
   no backup, no board: no Step 1. If the hub **enabled an add-on** this spoke has no wrapper for, wire
   it: `node scripts/gen-launchd.mjs --install <addon> && node scripts/gen-cowork-config.mjs <addon>`.

   ```bash
   # spoke parity: the hub must already serve a schema >= what this checkout expects
   source "$(git rev-parse --show-toplevel)/config/load-config.sh"
   want=$(grep -oE 'SCHEMA_VERSION = [0-9]+' board/lib/types.ts | grep -oE '[0-9]+')
   curl -fsS --max-time 5 "$BOARD_URL/api/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const w=Number(process.argv[1]);console.log("hub app",j.appVersion,"schema",j.schemaVersion,"— this checkout wants",w);process.exit(j.schemaVersion>=w?0:1)})' "$want" || echo "HUB NOT UPGRADED YET — do not restart this spoke's wrappers"
   ```
   Warm-standby spokes (a backup clone + the recovery key) must reach ≥ the hub's schema promptly:
   from the hub's first post-upgrade backup on, every snapshot carries the new schema.
3. Pure browser viewers: nothing — they load the hub's board.

## If something fails

- **`503 store-newer-than-code` / a red banner after the pull** — the running board is *older* than the
  store: the production board did not rebuild. `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-boardapp`
  and read `mcp/logs/boardapp.err.log` (a failed build records the commit in `board/.next/COS_BUILD_FAILED`
  and will not hot-loop; fix the build, kick again).
- **A tool is missing in Cowork / Claude Code** after the upgrade — the server code moved but the client
  holds the old child: restart Cowork; `kickstart -k` the bridge; `sh mcp/ensure-bridges.sh`. Deeper:
  `/debug-cowork-mcp-issues`.
- **A sweep behaves like last month** — the bundle was rebuilt but not uploaded (Step 5), or the new
  scheduled trigger was never created.
- **`upgrade-check` cannot pick `--from`** — you ran it in a fresh session (no `ORIG_HEAD`) and no
  production build marker exists; pass `--from <the commit you were running>` (`git reflog` shows it).
