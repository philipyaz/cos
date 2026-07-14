---
name: hub-handover
description: Move the HUB role from one machine to another — promote a new machine to hub and demote the old one to a spoke (or retire it). The ceremony that makes the swap DATA-SAFE: it freezes the source board BEFORE the final backup (so no write is stranded), enforces a schema precondition on the promoting machine, restores the LEASE-HOLDER's newest snapshot producer-aware, verifies the archived store's digest against the final snapshot after demotion, and prints the non-automatable residue checklist. Use when making your Mac mini (or any machine) the main machine while an existing hub steps down, promoting a spoke to hub, doing a planned hub migration, or recovering from hub failure onto a warm-standby machine. NOT for adding a client (that's spoke-setup) or first-run setup (that's cos-setup).
allowed-tools: Bash, Read
---

# Hub handover — move the hub role between machines, safely

The **hub** is the one machine that runs the state machine (board, store, backups, routines). Handover
promotes a **new** machine to hub and demotes the **old** one (to a spoke, or retirement). The whole
risk is a **write that lands after the final backup** (stranded forever) or a **restore under a live
board** (silently reverted). This ceremony closes both, in order — do NOT freelance the sequence.

> Reusable for any hub swap; the worked example is **MacBook → Mac mini** (the mini becomes the main
> machine; the MacBook becomes a spoke). Prereqs: both machines on the same Tailscale tailnet, the
> **same recovery key** provisioned on both (backup-recovery §1.1 / §2), and the new machine at a code
> checkout whose `SCHEMA_VERSION` is **≥** the store's schema (the migration's safe direction).

## The order (each step gates the next — do not reorder)

### 1 — Soak the new machine FIRST (old hub stays authoritative)
Stand the new machine up as a hub **hydrated by restore**, and run it read-mostly for a day+, while the
**old hub keeps producing backups** (it is still the lease-holder — do NOT install the new machine's
backup LaunchAgent yet; a second producer would fight the old hub over the lease + remote).

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# On the NEW machine: same recovery key, then dry-run restore of the OLD hub's newest snapshot.
node "$REPO_ROOT/backup/restore.mjs" --list                 # note the old hub's deviceId
node "$REPO_ROOT/backup/restore.mjs" --device <old-hub-id>  # DRY RUN: auth tag / sha256 / JSON verified
```

Then `--apply` it **with no board running** (`restore.mjs` refuses `--apply` while anything answers on
`$BOARD_URL` — that guard is the point). First board boot migrates the store on read (code ≥ store =
the safe direction). Wire guard/mcp-bridge/add-ons, fresh WhatsApp QR (session DBs are non-portable),
and `tailscale serve --bg 3000`.

**CHECKPOINT** — the new machine's board shows the right case counts + add-on nav + a working vault
query, and an SSE stream stays open >10 min over the tailnet. **Treat it as read-mostly**: any writes
you make on it during soak are throwaway soak-state — the cutover re-restore (step 2.4) **OVERWRITES**
them with the old hub's final snapshot, so anything you typed on the new machine during soak is lost.
Don't do real work on it until after cutover.

### 2 — Cutover (do these five in THIS order; ~30 min)
1. **Pause/delete every scheduled routine on the OLD hub** (Cowork tasks / cron).
2. **STOP the OLD hub's board** — quit `next dev` / `launchctl bootout` the boardapp. The source is now
   FROZEN: no write can land after the snapshot in the next step. (This is the step a naive "pause
   routines + back up" misses — a still-running board keeps accepting browser/MCP writes.)
3. **Forced final backup FROM the OLD hub**, verify **exit 0 AND pushed**, then `launchctl bootout` its
   backup agent (it must stop producing).
   ```sh
   node "$REPO_ROOT/backup/backup.mjs" && echo "final backup OK (exit $?)"   # 0 = written + pushed
   ```
4. **Promote on the NEW machine**: stop its soak board, then re-restore the **OLD hub's FINAL** snapshot
   (producer-aware: pick `--device <old-hub-id>`, NOT whichever `--any-device` newest — the new
   machine's own soak snapshots must not win), no board answering:
   ```sh
   node "$REPO_ROOT/backup/restore.mjs" --device <old-hub-id> --apply
   ```
   Then flip this machine to the hub. The old hub's lease is still **FRESH** at cutover (it renewed
   minutes ago in step 2.3), so a plain backup would refuse and stand down — use **`--claim`**, the
   handover takeover, which claims the lease (epoch bump) even over a fresh one and produces the new
   hub's first snapshot:
   ```sh
   node "$REPO_ROOT/scripts/gen-launchd.mjs" --install backup   # install the new hub's daily agent
   node "$REPO_ROOT/backup/backup.mjs" --claim                  # take the lease + first backup (exit 0)
   ```
   Recreate the scheduled routines in the new hub's Cowork.
5. **Copy the machine-local sweep watermarks** (they are gitignored, NOT in the backup scope, and
   created on first sweep — copy each that exists, old → new) so nothing re-processes:
   `config/whatsapp-triage-state.json`, `config/unanswered-messages-state.json`, and (if voice ingest
   is scheduled) `mcp/openwhispr-server/state/watermark.json`. The **Gmail-side** watermarks are labels
   (`cos/processed`, `cos/answer-checked`) — they live in Gmail, shared across machines, so nothing to copy.

### 3 — Demote the OLD hub to a spoke
Order matters — the safety-net backup run must happen while the old machine is still a **hub**
(`backup.mjs` exits 1 immediately for a spoke, before the lease/quarantine logic):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# a) DIGEST-DISCIPLINE run — WHILE STILL A HUB, before spoke-setup:
node "$REPO_ROOT/backup/backup.mjs"   # sees the new hub's fresh lease → exit 4, orphan-quarantines any late write
# b) Archive the retired store (keep board/data/backups/):
mv "$REPO_ROOT/board/data/cases.json" "$REPO_ROOT/board/data/cases.retired-$(date +%F).json"
```
- **Digest discipline:** step (a) is why the new hub's `--claim` in step 2.4 matters — now that the new
  hub genuinely holds the lease, the old hub's run sees a fresh foreign lease and **quarantines any
  changed local state** to `orphan/<id>-<ts>.enc` (exit 4). Then compare the archived store's digest
  against the final snapshot; if they differ, a late write slipped in — it's in the orphan blob (the old
  hub already pushed it), recover it via the new hub, never discard it.
- c) Now **pull `main` freely** (with no live store, the schema-skew deadlock is gone), then run
  `spoke-setup` — it sets `COS_DEVICE_ROLE=spoke` + `BOARD_URL=<new hub>` and wires only the board-facing
  wrappers. `launchctl bootout` the old hub's stateful agents (boardapp, guard, sidecars, vault, backup).

**CHECKPOINT** — from the old machine (now a spoke): the new hub's board loads over the tailnet with a
"Connected to <hub>" chip; a write from the spoke appears on the new hub's screen (SSE); `npm run dev`
**and** a direct `npx next dev` write both REFUSE on the spoke (predev abort + the store's 503
`spoke-role-refusal`).

## Unplanned failover (the hub died — no graceful cutover possible)
If the hub is gone (dead/lost), promote a **warm-standby** machine that already has the recovery key +
a pulled backup clone (backup-recovery §1.1/§2): restore the latest snapshot with no board running
(`restore.mjs --device <dead-hub-id> --apply`), then `backup.mjs --claim` to take the lease (the dead
hub can't contest it), install its backup agent, and flip it to hub. The window's exposure is bounded
by the standby clone's freshness (≤24h) and GitHub reachability. The lost hub, if it ever returns,
sees the new fresh lease and stands down (exit 4) rather than double-producing.

## Rollback (before step 2 the old hub is untouched; after, symmetric)
After cutover, if the new hub is wrong: **take a final backup FROM the new hub first** (its post-cutover
writes must not be stranded — the mirror of step 3's archive), then restore the pre-cutover snapshot on
the old machine and `backup.mjs --claim` to re-take the lease. Then flip roles back.

## The non-automatable residue (print + tick by hand — nothing here can be scripted safely)
- [ ] Scheduled routines RECREATED in the new hub's Cowork, DELETED on the old.
- [ ] WhatsApp re-paired on the new hub (QR — session DBs don't move).
- [ ] Obsidian vault registered on the new hub (its `obsidianVaultId` is machine-local; a cross-machine
      restore deliberately keeps the *restoring* machine's id — so register the vault in Obsidian there).
- [ ] `COS_HUB_PUBLIC_URL` set on the new hub (its `tailscale serve` URL) so its Devices panel can emit
      join blobs.
- [ ] The old machine's backup agent booted out; the new machine's installed + holding the lease
      (check `/backups`: green, lease held by the new hub).

## Gotchas
- **The freeze is the whole point.** Routines-paused + backup-pushed is NOT enough — a running board
  keeps accepting writes. STOP the source board BEFORE the final backup (step 2.2), always.
- **Producer-aware selection.** At promote, pick the OLD hub's snapshot by `--device`, never
  `--any-device` — the new machine's soak snapshots are newer by wall-clock but are throwaway state.
- **Schema precondition.** Promote only on a checkout whose `SCHEMA_VERSION` ≥ the snapshot's schema;
  otherwise the board fails closed (`SchemaAheadError` → 503) after restore until you `git pull`.
- **One producer at a time.** Never have both machines' backup agents installed simultaneously — the
  HUB.json lease is the single-producer tripwire, but two agents racing it wastes an exit-2/4 cycle and
  muddies the history. Old off, new on, in that order (step 2.3 → 2.4).
- **Soak writes are quarantined, not merged** — that trade-off is accepted (the alternative is merge
  machinery this design exists to avoid). Keep the new machine read-mostly during soak.
