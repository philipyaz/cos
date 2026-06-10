# backup/ — encrypted, off-site, versioned backups

The board/guard/vault are **live data**, not test fixtures. Local rolling snapshots
(`board/data/backups/`) are crash-safety only — they are count-pruned, same-disk, and
trivially deletable. This module adds the missing layer: **daily AES-256-GCM-encrypted
snapshots pushed to a private GitHub repo**, where git history is an immutable, off-site,
versioned record you cannot silently overwrite.

> Set up and recover via the **`/backup-recovery`** skill. This README is the reference.

## What it does

`node backup/backup.mjs` →
1. gzip-tars the in-scope stores (see `config.mjs SCOPE`): board data, guard data,
   config, and the **active vault** (`vault/<VAULT_NAME>`, resolved from `config/cos.env`
   so a renamed vault is never silently dropped — `backup.mjs` WARNs if it's missing);
2. encrypts the tarball with **AES-256-GCM** (`lib/crypto.mjs`) — key derived from your
   recovery passphrase via scrypt, random salt+IV per backup, authenticated;
3. writes `snapshots/cos-backup-<ts>.enc` + an integrity entry in `MANIFEST.json` into the
   private backup repo and **commits + pushes**. One file per run, never overwritten.

`node backup/restore.mjs` → pulls the repo, **verifies** (GCM auth tag → sha256 vs manifest
→ every `*.json` parses) before touching anything, runs **dry-run unless `--apply`**, and on
`--apply` snapshots the current live state to `~/cos-recovery/pre-restore-*` first (a restore
is itself reversible).

```
node backup/restore.mjs --list          # what's available
node backup/restore.mjs                  # verify latest (dry run)
node backup/restore.mjs --date 2026-06-06 --apply
```

**Three triggers, one floor.** `backup.mjs` is invoked by (1) the launchd **03:30** agent —
the guaranteed daily floor; and, while the board is up, (2) a manual **Back up now** button on
the board's `/backups` surface (`POST /api/backups/run`) and (3) an **opportunistic top-up**
fired non-blocking from hot read routes (`GET /api/cases`, `GET /api/backups`) when the newest
snapshot is older than the 12h freshness window. The board side (`board/lib/backup-status.ts`)
gates a top-up on freshness + a positive live-board identity check; a `?force=1` on the manual
route bypasses the freshness gate only.

**Single-flight lock + exit codes.** All three callers are serialized by an exclusive
`.backup.lock` inside the backup repo (`wx` atomic create, gitignored, reclaimed if >120s
stale). The lock lives in `backup.mjs` because launchd runs the file DIRECTLY, never through
board code. Exit codes: **0** = snapshot written + **pushed**; **2** = committed LOCALLY only
(push failed — still a successful backup); **3** = benign **lock-skip** (another run held the
lock — NOT a failure); other non-zero = a hard failure (exit `1` is also the fail-closed
repo-guard refusal, below).

## The recovery key (read this)

- A single high-entropy passphrase is the **only** way to decrypt. Lose it → the backups are
  unrecoverable by design (that is the point of encrypting before pushing off-site).
- It lives in the **macOS login Keychain** (`security` item `cos-backup-key`), read at backup
  time by the LaunchAgent. It is **never** written to the repo, the backup repo, or a log.
- **Keep one offline copy** in your password manager. Test a `--apply` restore on a scratch
  checkout periodically so you know the key + protocol actually work.
- Override for one-off/CI restores with `COS_BACKUP_KEY` (env), e.g. when restoring on a new
  machine before the Keychain item exists.

## Config

`config.mjs`: `SCOPE` (what's backed up), the backup-repo path, and
`KEYCHAIN_SERVICE`/`ACCOUNT`.

The repo location + the node binary are **config-driven via `config/cos.env`** (`BACKUP_REPO`,
`NODE_BIN`), parsed identically by `config.mjs` and `board/lib/backup-status.ts` (they can't
cross-import — the `.mjs` is outside the Next root). `EXPECTED_BACKUP_REPO` is the cos.env
`BACKUP_REPO` (tilde-expanded), else the `~/.cos-backups` default — **config-derived, NOT from
an env var**. The EFFECTIVE `BACKUP_REPO` is `COS_BACKUP_REPO` env override **>** cos.env
`BACKUP_REPO` **>** default (`repoSource` = `env`/`cos.env`/`default`).

`backup.mjs` is **fail-closed**: `assertDefaultRepoOrRefuse()` runs first and exits `1` unless
the effective repo `===` EXPECTED, so a `COS_BACKUP_REPO=/tmp…` override is refused — the
escape hatch `COS_BACKUP_ALLOW_NONDEFAULT=1` is reserved for deliberate disposable-repo tests.
To **relocate**, set `BACKUP_REPO` in `config/cos.env` (keeps effective `===` EXPECTED), move/
clone the repo there, then update the launchd plist's `COS_BACKUP_REPO` and reinstall the agent
(see the `/backup-recovery` skill, §6).

## Board surface + routes

The board exposes a READ-ONLY health view at **`/backups`** (sidebar → Review → Backups — a
top-level item next to Security/Trash/Activity, not nested under Security), served by
`board/lib/backup-status.ts` over **`GET /api/backups`** (always 200; fail-safe envelope) — the
verdict (healthy/warning/error), last-run facts, push-state, snapshot history, log tails, repo
provenance, and a readiness checklist. **`POST /api/backups/run`** (`?force=1` bypasses the 12h
freshness gate) is the only mutating route; it spawns this same `backup.mjs` and 403s only on a
non-live-board (sandbox) context. The readiness probe is read-only — it never reads the recovery
key secret (existence-only `security find-generic-password` without `-w`) and never hits the
network.

## Schedule

`deploy/com.chiefofstaff.backup.plist.template` → daily 03:30 LaunchAgent. The skill
substitutes paths and bootstraps it. Logs: `backup/logs/backup.{out,err}.log`.

## Threat model / guarantees

- **Off-site:** survives local disk loss or `rm -rf board/data/backups`.
- **Immutable history:** git keeps every daily snapshot; nothing in the past is rewritten.
- **Confidential:** AES-256-GCM; a leak of the private repo exposes nothing without the key.
- **Tamper-evident:** GCM auth tag + manifest sha256 — a modified snapshot fails to restore.
- **Reversible restore:** current state is snapshotted before any overwrite.
- **Serialized:** an exclusive `.backup.lock` (120s stale-reclaim) keeps the launchd, manual,
  and opportunistic callers from interleaving a push; a collision exits 3 (benign, no run).
