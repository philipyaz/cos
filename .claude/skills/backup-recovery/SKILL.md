---
name: backup-recovery
description: Set up and operate the encrypted off-site backup for the chief-of-staff live data (board, guard, config, vault). Daily AES-256-GCM snapshots are pushed to a PRIVATE GitHub repo (immutable git history); the recovery key lives in the macOS Keychain. Use when bootstrapping the app on a new machine, when you need to RESTORE after data loss/corruption, to take an on-demand backup before a risky/bulk operation on live data, to verify backups are healthy, or when rotating the recovery key. This is a first-class setup skill alongside mcp-bridge-setup and guard-setup.
---

# Backup & Recovery

The board (`board/data/`), guard (`guard/data/`), config (`config/`), and **vault**
(`vault/<VAULT_NAME>` — the active vault from `config/cos.env`) are
**real, live data**. The local rolling snapshots
in `board/data/backups/` are crash-safety only — count-pruned, same-disk, deletable. This
skill operates the durable layer: **daily AES-256-GCM-encrypted snapshots in a private
GitHub repo** (`backup/`), where git history is immutable, off-site, and versioned.

Implementation lives in `backup/` (see `backup/README.md`). This skill is the operator
runbook. **Golden rule: never run a bulk or destructive operation on live data without a
fresh, VERIFIED backup first** (`Backup now` below). The data-loss incident that motivated
this skill happened because live data was edited and the only backups were local + count-pruned.

---

## 0. Concepts (read once)

- **Recovery key** — one high-entropy passphrase; the ONLY way to decrypt. Stored in the
  macOS login Keychain (`security` item `cos-backup-key`) AND an offline copy in your
  password manager. Never in any repo, never logged. Lose it → backups are unrecoverable.
- **Backup repo** — a PRIVATE GitHub repo (local clone at `$BACKUP_REPO`). Holds
  `snapshots/cos-backup-<ts>.enc` + **per-device manifests** `manifests/<deviceId>.json`
  (one per producing machine — the deviceId is `COS_DEVICE_ID` from `config/cos.env`, else
  a sanitized hostname; a legacy single `MANIFEST.json` from before the split is still
  READ, never written). Private **and** encrypted = a repo leak exposes nothing. Its
  location is **config-driven**: `config/cos.env BACKUP_REPO` (the loader exports it as
  `$BACKUP_REPO`), defaulting to `~/.cos-backups` when unset. This config value is the
  **EXPECTED** repo; `backup.mjs` refuses to run against any other effective path (see §6
  Relocating + the fail-closed guard). Multiple machines may produce into ONE archive:
  each run converges with the remote first (fetch + rebase), and a machine's FIRST run
  must **decrypt-verify** the newest existing snapshot with its local key (producer
  admission) — a wrong key is refused before it can split the archive.
- **Scope** — `backup/config.mjs SCOPE`: board data, guard data, config, the vault. The
  vault entry is **resolved from `config/cos.env VAULT_NAME`** (`vault/<VAULT_NAME>`, the
  same active vault `setup-vault` records), so a renamed/relocated vault is always captured
  — never silently dropped. If the configured vault dir is missing at backup time,
  `backup.mjs` logs a loud `WARN` (visible in the `/backups` log tails) rather than omitting
  it quietly. Falls back to `vault/my-personal-thoughts-vault` when `VAULT_NAME` is unset
  (a slug guard rejects any name with a path separator).
- **Three triggers, one floor** — the launchd **03:30** agent is the GUARANTEED DAILY
  FLOOR. While the board is running it ADDS two more triggers of the SAME
  `backup/backup.mjs`: an **opportunistic top-up** (fires non-blocking from hot read
  routes when the newest snapshot is >12h old) and the **"Back up now"** button on the
  board's `/backups` surface. All three callers are serialized by a single-flight lock
  inside `backup.mjs` (see §3 + §6) and share the same exit codes.
- **Board `/backups` surface** — a READ-ONLY health UI (board sidebar → Review →
  Backups; the **Backups** item sits next to Security/Trash/Activity, it is NOT nested
  under Security). The new at-a-glance health check: a healthy/warning/error verdict, last-run
  time/size/store-count, push-state, snapshot history, log tails, the repo-path
  provenance, and a Setup & Diagnostics readiness card. Look here FIRST; the CLI below is
  the headless fallback. See §4.

Resolve the repo root as `$(git rev-parse --show-toplevel)`; commands below run from there.

---

## 1. Setup (new machine / first time)

**1.1 — Generate + store the recovery key.** Skip if the Keychain item already exists
(`security find-generic-password -s cos-backup-key -w >/dev/null 2>&1 && echo exists`).

> **NEVER mint a new key when the backup repo already has snapshots.** If the configured
> repo has history (`node backup/restore.mjs --list` shows entries, or `ls "$BACKUP_REPO"/snapshots`
> is non-empty), this machine is JOINING an existing archive: provision the **same** recovery
> key from the password manager via §2's `COS_BACKUP_KEY` path instead. A second key silently
> splits the archive into two mutually-unrestorable halves — `backup.mjs` also enforces this
> (producer admission: a joining machine's first run must decrypt-verify the newest existing
> snapshot, and refuses to produce otherwise).

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# The loader exports $REPO_ROOT, $BREW_PREFIX, $NODE_BIN, $BACKUP_REPO, $LAUNCH_AGENTS_DIR,
# the ports/URLs, etc. — use those instead of hardcoding machine paths.
KEY="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))')"
security add-generic-password -s cos-backup-key -a "$USER" -w "$KEY" -U
echo "$KEY"   # ← copy this into your password manager NOW (offline copy), then clear scrollback
```

**STOP and confirm with the user** that they have saved the offline copy before continuing.
This key is unrecoverable; treat it like a root credential.

**1.2 — Create the private backup repo** (confirm the name with the user first). Then clone it
to the local backup path:

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
gh repo create cos-backups --private --description "Encrypted chief-of-staff backups (do not make public)" --clone=false
git clone "$(gh repo view cos-backups --json sshUrl -q .sshUrl)" "$BACKUP_REPO"
# seed it so the first push has a branch:
( cd "$BACKUP_REPO" && printf '# cos-backups\nEncrypted backups. Recover with the /backup-recovery skill. Useless without the recovery key.\n' > README.md && git add -A && git commit -m init && git push -u origin HEAD )
```

**1.3 — First backup + verify** (this proves the whole chain end-to-end):

```bash
node backup/backup.mjs                 # archive → encrypt → commit → push
node backup/restore.mjs --list         # the snapshot shows up
node backup/restore.mjs                # DRY RUN: auth tag OK ✓ / sha256 OK ✓ / JSON-verified ✓
```

**1.4 — Install the daily LaunchAgent** (rendered from the service manifest — the backup is an
ordinary manifest service now, descriptor `backup/backup.service.json`, label
`com.chiefofstaff.backup`, hub-only):

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
mkdir -p "$REPO_ROOT/backup/logs"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install backup
# The job is SCHEDULED (03:30 daily; next wake if asleep) — gen-launchd loads it but does
# not fire it. Run once now to prove the chain end-to-end:
launchctl kickstart -k "gui/$(id -u)/com.chiefofstaff.backup"   # then check backup/logs/
```

Done. A backup runs daily at 03:30 (or next wake).

---

## 2. Restore (after data loss / corruption / on a new machine)

**STOP THE BOARD FIRST** (quit `next dev` / `launchctl bootout` the board service): restore
`--apply` **refuses while anything answers on `$BOARD_URL`** — a live board holds the whole
store in memory and an in-flight write would clobber the restored file (`--allow-live-board`
overrides, at your own risk). Restore also **requires a reachable remote** (a stale clone
must not pick "latest"); for offline disaster recovery pass `--stale-ok`.

```bash
node backup/restore.mjs --list                       # pick a date (lists ALL devices' snapshots)
node backup/restore.mjs --date 2026-06-06             # DRY RUN: verify only, nothing written
node backup/restore.mjs --date 2026-06-06 --apply     # restore (snapshots current state first)
```

**Selection is device-scoped:** "latest" means THIS machine's latest. On a NEW machine (or
restoring another machine's data — the migration/handover flow) pick the producer explicitly:
`--device <id>` (ids shown by `--list`) or `--any-device` for the global newest. Cross-machine
restores are role-aware: the snapshot's vault is mapped into this machine's configured
`VAULT_NAME`, the producer's `vault/.cos/jobs.json` worker queue is stripped, and this
machine's Obsidian identity in `config/settings.json` is preserved.

`--apply` copies the current live stores to `~/cos-recovery/pre-restore-<ts>/` **before**
overwriting, so the restore is reversible. After it completes, restart services:

```bash
for s in board calendar guard guardsvc openwhispr search; do launchctl kickstart -k "gui/$(id -u)/com.chiefofstaff.mcp-$s" 2>/dev/null; done
# and restart the board dev server (cd board && npm run dev)
```

**New machine, no Keychain yet:** export the key first so `resolveKey()` finds it, e.g.
`COS_BACKUP_KEY='<from password manager>' node backup/restore.mjs --apply`, then run 1.1 to
store it in the Keychain.

If verification FAILS (`bad magic`, auth-tag throw, sha256 mismatch): the key is wrong or the
snapshot is corrupt — try an earlier `--date`; do **not** `--apply` a snapshot that won't verify.

---

## 3. Backup now (before any risky/bulk operation on live data)

```bash
node backup/backup.mjs && node backup/restore.mjs   # back up, then dry-run verify it
```

Or, with the board up, click **Back up now** on `/backups` (it forces — bypasses the 12h
freshness gate; see §4). Always back up before: anonymization passes, bulk edits/migrations,
schema changes, or anything that rewrites `cases.json` / `guard/data/` / the vault.

**Single-flight lock + exit codes.** `backup.mjs` takes an exclusive `.backup.lock` (inside
the backup repo, gitignored; reclaimed if a crashed run left it >120s stale) so the launchd
agent, the manual button, and the opportunistic top-up can never interleave a push. Its exit
code tells you the outcome:

- **`0`** — encrypted snapshot written + **pushed**. Healthy.
- **`2`** — committed **LOCALLY only**, push failed (no network). Still a SUCCESSFUL backup —
  note it and re-push later; NOT a failure.
- **`3`** — benign **lock-skip** ("busy"): another run held the lock, so this one did nothing.
  No new snapshot, nothing went wrong — NOT a failure.
- **other non-zero** — a real hard failure (or, exit `1`, the fail-closed repo guard refused —
  see §6).

---

## 4. Health check

**Look at the board first.** With the board up, open **`/backups`** (sidebar → Review →
Backups — a top-level item, sibling to Security, not under it) — it's the at-a-glance health view, served by `board/lib/backup-status.ts` (server-
only, fail-safe) over `GET /api/backups`. The headline **verdict chip** is the whole story:

- **Healthy** (green) — fresh (<36h), pushed, last exit clean.
- **Warning** (amber) — stale (>36h), or pushed locally-only (committed, not on remote), or
  push-state unknown. The same three conditions the CLI `Flag if:` below names.
- **Error** (red) — no snapshots yet, or the last run HARD-failed (a non-zero exit that is
  NOT 2 or 3 — exits 2 and 3 are not failures; see §3).

The page also shows last-run time/size/store-count, the schedule, the agent state, the
snapshot **history**, **log tails** (`backup.err.log` is raw git output — a non-empty tail is
NOT a failure), the repo-path **provenance** (where `$BACKUP_REPO` is defined), and a
**Setup & Diagnostics** readiness card. There's a **Back up now** button (forces — bypasses
the 12h freshness gate) and a **Refresh**.

**Readiness diagnostics.** When the backup isn't fully set up the card surfaces the headline
"**Backup isn't fully set up**", separate run-setup guidance (a body line that points at the
backup-recovery setup, plus a copyable command), and enumerates the missing prerequisites. It
probes (read-only, never reads the key secret, never hits the network): repo present + git-
initialised, an `origin` remote, the recovery key EXISTING in the Keychain (existence-only,
no `-w`), the daily agent installed + targeting the configured repo, the node binary, git on
PATH, and ≥1 snapshot. "Ready" needs the repo, git-init, remote, key, node, and git; a
missing agent or zero snapshots are warnings, not blockers.

**The headless / deeper check** (no board running, or to confirm what the page shows):

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node backup/restore.mjs --list | head                       # recent snapshots present?
launchctl print "gui/$(id -u)/com.chiefofstaff.backup" | grep -E 'state|last exit'
tail -5 "$REPO_ROOT/backup/logs/backup.err.log"
git -C "$BACKUP_REPO" log --oneline -5                       # daily commits landing?
```

Flag if: no snapshot in >36h, the LaunchAgent's last exit is a hard failure (**ignore 2 and
3** — 2 = committed-locally-not-pushed, 3 = a benign lock-skip; see §3), or `--list` shows
pushes stalled (committed locally but not on the remote). NOTE: for a calendar-interval agent,
`state = not running` WITH `last exit code = 0` is the HEALTHY between-runs state.

---

## 5. Rotate the recovery key

Re-keying does NOT re-encrypt old snapshots (they still need the OLD key — keep it archived
offline). New backups use the new key.

```bash
NEW="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))')"
security add-generic-password -s cos-backup-key -a "$USER" -w "$NEW" -U   # -U overwrites
echo "$NEW"   # → password manager; label the OLD one "retired <date>, needed for snapshots before <date>"
node backup/backup.mjs   # first snapshot under the new key
```

---

## 6. Relocate the backup repo (config-driven path)

The repo location + the node binary used to spawn `backup.mjs` come from **`config/cos.env`**
(`BACKUP_REPO`, `NODE_BIN`), read by BOTH `backup/config.mjs` and the board. Effective-path
precedence: `COS_BACKUP_REPO` env override **>** `config/cos.env BACKUP_REPO` **>**
`~/.cos-backups` default (the board's `/backups` provenance line tells you which is in play).
The **EXPECTED** repo is derived from `cos.env` (NOT the env var); the **fail-closed guard**
(`assertDefaultRepoOrRefuse`) refuses to run unless the effective repo `===` EXPECTED —
escape hatch `COS_BACKUP_ALLOW_NONDEFAULT=1`, reserved for deliberate disposable-repo tests.
So `COS_BACKUP_REPO` is NOT the relocation knob — edit `cos.env` instead, which keeps
effective `===` EXPECTED and runs normally.

To move the repo:

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# 1) Set BACKUP_REPO to the new absolute path in config/cos.env, then re-source:
#    (edit config/cos.env → BACKUP_REPO="…"), then `source …/config/load-config.sh` again.
# 2) Move/clone the repo there (it must contain .git + an 'origin' remote):
git clone "$(gh repo view cos-backups --json sshUrl -q .sshUrl)" "$BACKUP_REPO"   # or `mv` the old clone
# 3) Re-point the launchd plist's COS_BACKUP_REPO at $BACKUP_REPO and reinstall the agent
#    (this re-runs §1.4 verbatim — the template's __BACKUP_REPO__ token becomes $BACKUP_REPO):
U="$(id -u)"
sed -e "s|__NODE__|$BREW_PREFIX/bin/node|g" -e "s|__REPO_ROOT__|$REPO_ROOT|g" -e "s|__BACKUP_REPO__|$BACKUP_REPO|g" \
  "$REPO_ROOT/backup/deploy/com.chiefofstaff.backup.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.backup.plist"
launchctl bootout "gui/$U/com.chiefofstaff.backup" 2>/dev/null || true
launchctl bootstrap "gui/$U" "$LAUNCH_AGENTS_DIR/com.chiefofstaff.backup.plist"
```

The board's `agent-target` readiness check WARNS when the installed plist's `COS_BACKUP_REPO`
doesn't match the `cos.env` EXPECTED — catching a half-done relocation (step 3 skipped) so the
daily floor and the board stay in sync.

---

## 7. Diverged backup repo (manual reconcile)

`backup.mjs` converges with the remote automatically (fetch + rebase before producing;
unique snapshot names + per-device manifests make that conflict-free). The ONE case it
will not auto-resolve is a **pre-upgrade divergence on the legacy shared `MANIFEST.json`**
(both machines appended to it before the per-device split). Symptoms: backup runs log
`WARN rebase onto origin/... failed` and exit 2; `restore.mjs` refuses with `DIVERGED`.

Reconcile once, by hand — the snapshots themselves never conflict (unique filenames):

```bash
cd "$BACKUP_REPO"
git fetch origin && git rebase origin/HEAD   # conflicts only on MANIFEST.json
# Union the two MANIFEST.json versions: keep BOTH sides' entries, newest first
# (each entry is self-contained; order within the array is cosmetic).
$EDITOR MANIFEST.json && git add MANIFEST.json && git rebase --continue
git push origin HEAD
```

New entries land in `manifests/<deviceId>.json` from now on, so this cannot recur.

---

## 8. Windows: schedule the daily backup (Task Scheduler)

macOS installs the 03:30 job as a launchd `StartCalendarInterval` plist
(`gen-launchd.mjs --install backup`). Windows has no launchd — the Node service
manager (`cos-services.mjs`) deliberately skips scheduled jobs — so register the
daily run with **Task Scheduler** once:

```powershell
# from the repo root; sources cos.env via load-config so BACKUP_REPO etc. resolve
schtasks /create /sc daily /st 03:30 /tn "com.chiefofstaff.backup" ^
  /tr "node %CD%\backup\backup.mjs"
```

The backup script is identical across platforms (per-device manifest, producer
admission, the HUB.json lease); only the scheduler differs.

---

## Protocol summary (the non-negotiables)

1. **The key is a root credential.** Keychain + offline copy; never in a repo or log; lose it → game over.
2. **Verify before you trust.** A backup isn't real until a dry-run restore verifies it (auth tag + sha256 + JSON).
3. **Backup before destruction.** No bulk/destructive op on live data without a fresh verified backup.
4. **Restores are reversible.** `--apply` always snapshots current state to `~/cos-recovery/` first.
5. **Off-site + immutable + encrypted.** Private GitHub repo, full git history, AES-256-GCM. Never make the backup repo public.
6. **Test recovery periodically.** A backup you've never restored is a hope, not a backup.
7. **Check the board first.** The `/backups` surface is the at-a-glance health view; the launchctl/git CLI is the headless fallback.
8. **Exit 2 and 3 are not failures.** 2 = committed-locally (push later); 3 = a benign single-flight lock-skip ("busy"). Only a non-0/2/3 exit is a real failure.
