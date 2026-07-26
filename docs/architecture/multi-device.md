# Multi-device: hub & spoke

Cos runs across more than one machine with a **hub-and-spoke** topology. Exactly one machine — the
**hub** — runs the state machine: the board on `:3000`, `cases.json` behind the single `mutate()`
chokepoint, the sidecars, the encrypted backups, and the scheduled routines. Another machine becomes a
**spoke** only when it needs to run **agents** (Claude Code / Cowork) against the board: a checkout
with the thin board-facing MCP wrappers pointed at the hub, but **no state of its own** — its wrappers
talk to the hub's HTTP API over a private [Tailscale](https://tailscale.com) network. A device that
only needs to *view* the board is **not** a spoke — it installs nothing and reaches the hub in a
browser over the same tailnet (see [View vs. drive](#two-ways-to-reach-the-hub-view-vs-drive) below).
Nothing syncs, because there is nothing to sync; the single store is the single source of truth.

The whole design is one decision — **don't sync; keep one store and reach it.** A hub failure or a
planned migration is handled by moving the *role*, not by reconciling two stores (see
[Moving the hub role](#moving-the-hub-role) below).

## Two ways to reach the hub — view vs. drive

Hub & spoke exists for exactly one reason: so that **agents** — Claude Code and Claude Cowork on a
second machine — can drive the board through **local** MCP tools. It is **not** required to *view* the
board from another device. The decision is binary:

- **View / use the board UI** → a **browser**, zero per-device setup. The hub runs the production board
  behind `tailscale serve`; any tailnet device opens it. The browser writes through the same `/api/*`
  HTTP API the wrappers use, so it is full read/write — not read-only.
- **Act on the board with an agent on that device** → a **spoke**. Claude Cowork accepts **only local
  stdio MCP servers**; it cannot consume a remote HTTP MCP over the tailnet (a hard, validated
  constraint), so the only way to give a local agent board tools is the thin stdio wrappers
  ([`spoke-setup`](https://github.com/philipyaz/cos/blob/main/.claude/skills/spoke-setup/SKILL.md))
  forwarding tool calls to the hub's `/api/*`. A browser cannot hand a local agent those tools.

**Easy mode (solo viewer)** — the simplest multi-device setup is one hub + browser viewers, no spoke:

1. On the hub, run the **production** board — `cd board && npm run build && npm run start` (or install
   the `boardapp` LaunchAgent). **Not** `next dev`: dev-mode on-demand compilation + lazy chunks are
   unreliable through a reverse proxy, so the page loads but interactions (e.g. opening a case) can
   silently fail.
2. Expose it on the tailnet — `tailscale serve --bg 3000` (needs Tailscale HTTPS/MagicDNS on the
   tailnet). The board is loopback-bound, so `tailscale serve` is the **only** door in — and the URL is
   **portless** (HTTPS 443), never `:3000`.
3. On any other tailnet device, open `https://<hub>.<tailnet>.ts.net` in a browser. Done — no
   per-device setup.

Add `spoke-setup` to a device **only** if you also want Claude/Cowork to act on the board there.

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
board answering, schema ≥ the snapshot), claim the lease, then demote the old machine and
diff its archived store against the final snapshot (any late write is quarantined, never lost).
Demoting to a spoke is optional, not obligatory: if you only want to keep *viewing* the new hub from
the old machine, it needs **nothing** installed — just open the new hub's `tailscale serve` URL in a
browser, which makes it a **viewer**, not a spoke (run `spoke-setup` there only if you still want
agents on it). Either way its own board and backup services are stopped as part of the handover. The
same skill covers unplanned failover onto a warm-standby machine. The single irreversible hazard —
running old code against a newer store — is blocked structurally by the
[fail-closed schema guard](../reference/migration.md#store-schema-versions-schemaversion).

## Related

- [Backups](../reference/backup.md) — per-device manifests, producer admission, the hub lease.
- [Migration notes](../reference/migration.md) — the fail-closed schema guard (code ≥ store).
- `spoke-setup`, `hub-handover`, `cos-setup`, `backup-recovery` skills (in `.claude/skills/`).
