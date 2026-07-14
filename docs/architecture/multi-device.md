# Multi-device: hub & spoke

Cos runs across more than one machine with a **hub-and-spoke** topology. Exactly one machine — the
**hub** — runs the state machine: the board on `:3000`, `cases.json` behind the single `mutate()`
chokepoint, the sidecars, the encrypted backups, and the scheduled routines. Every other machine is a
**spoke**: a full checkout with the same skills and thin MCP wrappers, but **no state of its own** —
its browser and its board-facing wrappers talk to the hub's HTTP API over a private
[Tailscale](https://tailscale.com) network. Nothing syncs, because there is nothing to sync; the
single store is the single source of truth.

The whole design is one decision — **don't sync; keep one store and reach it.** A hub failure or a
planned migration is handled by moving the *role*, not by reconciling two stores (see
[Moving the hub role](#moving-the-hub-role) below).

## Roles

A machine's role is one per-machine setting in `config/cos.env`:

- **`COS_DEVICE_ROLE=hub`** (the default) — runs the state machine. A solo machine is a hub and never
  meets the concept.
- **`COS_DEVICE_ROLE=spoke`** — a stateless client. Its board-facing wrappers point at the hub's
  `BOARD_URL`; a spoke MUST set `BOARD_URL` to the hub's tailnet URL (the loader refuses `spoke` + a
  localhost `BOARD_URL`). A spoke runs no board — the board `predev` hook aborts, and the store's
  write chokepoint refuses every write with a typed `SpokeRoleError` (HTTP 503 `spoke-role-refusal`),
  so even `npx next dev` cannot fork the store.

`COS_DEVICE_ID` is a stable per-machine id (a sanitized hostname until setup mints one). Both are read
by `board/lib/cos-env.ts` (`getDeviceRole()` / `getDeviceId()`), mirrored in `backup/config.mjs`, and
validated loudly by `config/load-config.sh`.

## What runs where

The service manifest (`mcp/service-manifest.mjs`) tags each service with `roles`. The per-machine
generators (`gen-launchd`, `gen-cowork-config`, `cos-services`, `ensure-bridges`) scope to the local
role, so a spoke installs **only** the board-facing wrappers (`board`, `calendar`, and any enabled
add-on wrappers). Hub-only services — the board app itself, the vault/guard bridges, the sidecars, and
the backup job — are never installed on a spoke.

The MCP bridges bind **loopback only** (`scripts/loopback-bind.cjs` pins supergateway's `listen()` to
`127.0.0.1`); the hub is reached from a spoke over the tailnet via `tailscale serve`, never by binding
the raw app to every interface.

## The hub lease

Exactly one machine may produce backups: the holder of a plaintext `HUB.json` lease in the backup repo
(`{deviceId, host, epoch, renewedAt}`). It rides the normal backup commit with a convergent (non-force)
push; a machine that finds a fresh lease held elsewhere quarantines any changed state and stands down
(exit 4), and a stale lease (>26h unrenewed) is claimable — which is how the hub role hands over. See
[Backups](../reference/backup.md).

## The Devices surface

Every board exposes `GET /api/healthz` (the identity handshake — role, deviceId, code-vs-disk
schemaVersion, the lease) and `GET /api/devices` (the richer envelope: identity + lease + the
ephemeral last-seen of devices whose agents have talked to this board + the join blob). The board's
**Devices** page renders that envelope; the `get_device_status` board MCP tool reads it; and a spoke's
browser shows a bottom-right "Connected to &lt;hub&gt;" reachability chip. Last-seen is keyed on the
`x-device` header the wrappers send, so it is *agent* last-seen — a plain browser sends none.

## Adding a device

On the hub, the **Devices → Add a device** panel (or `node scripts/join-blob.mjs`) emits a
`cos-join://v1?hub=…&schema=…` string — the hub's tailnet URL + its store schemaVersion + an optional
backup-repo ref, **addresses and expectations, no secrets**. On the new machine, run the
[`spoke-setup`](https://github.com/philipyaz/cos/blob/main/.claude/skills/spoke-setup/SKILL.md) skill
and paste it. `cos-setup` asks "first machine, or joining?" up front and routes a join to `spoke-setup`,
structurally skipping the board-seed step (which must never run on a machine with no local store).

## Moving the hub role

There is no failover to coordinate because there is no second store — a hub swap moves the **role**.
The `hub-handover` skill is the data-safe ceremony: soak the new machine as a restore-hydrated hub
while the old one stays authoritative; at cutover **stop the old board *before* the final backup** (so
no write is stranded), restore the old hub's final snapshot on the new machine (producer-aware, no
board answering, schema ≥ the snapshot), claim the lease, then demote the old machine to a spoke and
diff its archived store against the final snapshot (any late write is quarantined, never lost). The
same skill covers unplanned failover onto a warm-standby machine. The single irreversible hazard —
running old code against a newer store — is blocked structurally by the
[fail-closed schema guard](../reference/migration.md#store-schema-versions-schemaversion).

## Related

- [Backups](../reference/backup.md) — per-device manifests, producer admission, the hub lease.
- [Migration notes](../reference/migration.md) — the fail-closed schema guard (code ≥ store).
- `spoke-setup`, `hub-handover`, `cos-setup`, `backup-recovery` skills (in `.claude/skills/`).
