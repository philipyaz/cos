# WhatsApp MCP — launchd deploy

This directory used to hold committed launchd plist **templates** for wiring the external
[`whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp) checkout into this
chief-of-staff (cos) repo. Those templates are **gone** — the two plists are now **generated**
from co-located service descriptors by `scripts/gen-launchd.mjs` (see `mcp/CLAUDE.md` for the
unified service-manifest model). The `deploy/` dir now holds only this README.

`whatsapp-mcp` lives in its **own** repo (a sibling checkout, `$WHATSAPP_MCP_DIR`); cos installs it
because the generated plists reference cos log paths and cos's setup flow brings it up.

The WhatsApp integration is **two processes**, the same split as elsewhere in `mcp/` (a stdio MCP
behind a supergateway bridge, plus an HTTP sidecar it calls):

| Descriptor | Label | Port (default) | What it is |
|----------|-------|------|------------|
| `../whatsapp.service.json` | `com.chiefofstaff.mcp-whatsapp` | **:8006** (`$WHATSAPP_MCP_BRIDGE_PORT`) | The **MCP bridge** — supergateway wrapping the whatsapp-mcp **Python** stdio server (`uv run … main.py`) as Streamable HTTP for Claude Code + Cowork. |
| `../whatsappbridge.service.json` | `com.chiefofstaff.mcp-whatsappbridge` | **:8010** (`$WHATSAPP_GO_PORT`) | The **sidecar** — the whatsmeow **Go** bridge binary (`whatsapp-bridge`), an HTTP daemon that talks to WhatsApp Web. **Not** in `.mcp.json`. |

> **Why :8010 and not the upstream :8080?** whatsmeow's default bridge port is `8080`,
> which is commonly taken on a dev machine, so cos pins the Go bridge to
> `$WHATSAPP_GO_PORT` (default **8010**) and points the Python MCP at it via
> `WHATSAPP_API_URL`. Change the port in `config/cos.env` and regenerate — it flows from
> the loader into both plists (it is a `${VAR}` ref in the descriptor, not a literal).

Data flow: Claude Code → `:8006/mcp` (supergateway) → whatsapp-mcp Python MCP (stdio)
→ reads SQLite directly **or** calls the Go bridge REST on `:8010` → WhatsApp Web.

> The Python MCP reads `messages.db` directly for all **read** operations, so the
> whatsapp-triage skill can sweep chats even if the Go sidecar is momentarily down;
> only tool *calls* that hit the REST API need the sidecar.

## How the plists are generated

launchd **cannot expand `$VARS`** inside a plist and cannot see an nvm/asdf shim, so the rendered
plists carry **literal absolute paths**. The two descriptors (`../whatsapp.service.json` +
`../whatsappbridge.service.json`) declare only **names and `${VAR}` references**;
`mcp/service-manifest.mjs` resolves them against `config/load-config.sh` / `config/cos.env`, and
`scripts/gen-launchd.mjs` renders + installs the plists into `~/Library/LaunchAgents/` (on macOS it
renders AND `bootout→bootstrap→kickstart`s in one step). The values they resolve:

| Resolved from | Used for |
|---------------|----------|
| `$BREW_PREFIX` | absolute `supergateway` / `uv` paths + `PATH` (launchd's PATH lacks Homebrew) |
| `$REPO_ROOT` | log paths under `mcp/logs/whatsapp{,bridge}.{out,err}.log` |
| `$WHATSAPP_MCP_DIR` | the external whatsapp-mcp checkout (server, bridge binary, store) |
| `$WHATSAPP_MCP_BRIDGE_PORT` | the supergateway HTTP `--port` (8006) on the `whatsapp` bridge |
| `$WHATSAPP_GO_PORT` | the Go bridge bind port (8010); the MCP bridge also builds `WHATSAPP_API_URL` from it |

Install / refresh both (name the add-on services explicitly — they aren't core):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install whatsapp whatsappbridge
```

> **No bearer-token placeholder.** The Python server resolves the Go bridge's bearer
> token from `$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token` (computed relative
> to its own `__file__`), so the live secret **never** lands in the installed plist. A token
> rotation therefore needs **no** plist regeneration.

The rendered plists in `~/Library/LaunchAgents/` are machine-specific (absolute paths) and **never**
version-controlled — regenerating is only needed to pick up a path or port change (re-run the command
above).

## The `WHATSAPP_BRIDGE_PORT` gotcha (read this)

`WHATSAPP_BRIDGE_PORT` is read by **exactly one** process — the **Go** whatsmeow bridge
(`whatsapp-bridge/main.go`), which uses it as the port it **binds**. The **Python MCP
server does NOT read it** at all; it reaches the Go bridge **only** via
`WHATSAPP_API_URL`. So the two descriptors handle it oppositely:

- **MCP bridge (`whatsapp`, `:8006`)** — does **NOT** set `WHATSAPP_BRIDGE_PORT` (it would be
  a silent no-op that misleads). The bridge's own HTTP port is supergateway's `--port`
  (`$WHATSAPP_MCP_BRIDGE_PORT`); the Go bridge endpoint is pinned by
  `WHATSAPP_API_URL=http://localhost:$WHATSAPP_GO_PORT/api`.
- **Sidecar (`whatsappbridge`, `:8010`)** — sets `WHATSAPP_BRIDGE_PORT=$WHATSAPP_GO_PORT`: this is
  the **Go** process, the one that actually reads it.

On the cos side the two ports carry **distinct names** in `config/cos.env` —
**`WHATSAPP_MCP_BRIDGE_PORT`** (the supergateway bridge, 8006) and **`WHATSAPP_GO_PORT`**
(the Go sidecar, 8010) — deliberately keeping the literal name `WHATSAPP_BRIDGE_PORT`
confined to the one place it belongs: the Go sidecar's descriptor.

## Full runbook

This README covers how the plists are generated; for the end-to-end setup — building the Go binary,
the one-time QR pairing, installing both LaunchAgents, the `.mcp.json` / Cowork
registration, and verification — follow the **/whatsapp-mcp-setup** skill.
