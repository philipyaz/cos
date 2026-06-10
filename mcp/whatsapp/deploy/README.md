# WhatsApp MCP — launchd deploy templates

These are the **committed launchd plist templates** for wiring the external
[`whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp) checkout into this
chief-of-staff (cos) repo. `whatsapp-mcp` lives in its **own** repo (a sibling
checkout, `$WHATSAPP_MCP_DIR`); these templates live here because they reference cos
log paths and are installed by cos's setup flow.

The WhatsApp integration is **two processes**, the same split as elsewhere in `mcp/`
(a stdio MCP behind a supergateway bridge, plus an HTTP sidecar it calls):

| Template | Label | Port (default) | What it is |
|----------|-------|------|------------|
| `com.chiefofstaff.mcp-whatsapp.plist.template` | `com.chiefofstaff.mcp-whatsapp` | **:8006** (`$WHATSAPP_MCP_BRIDGE_PORT`) | The **MCP bridge** — supergateway wrapping the whatsapp-mcp **Python** stdio server (`uv run … main.py`) as Streamable HTTP for Claude Code + Cowork. |
| `com.chiefofstaff.mcp-whatsappbridge.plist.template` | `com.chiefofstaff.mcp-whatsappbridge` | **:8010** (`$WHATSAPP_GO_PORT`) | The **sidecar** — the whatsmeow **Go** bridge binary (`whatsapp-bridge`), an HTTP daemon that talks to WhatsApp Web. **Not** in `.mcp.json`. |

> **Why :8010 and not the upstream :8080?** whatsmeow's default bridge port is `8080`,
> which is commonly taken on a dev machine, so cos pins the Go bridge to
> `$WHATSAPP_GO_PORT` (default **8010**) and points the Python MCP at it via
> `WHATSAPP_API_URL`. Change the port in `config/cos.env` and re-render — it flows into
> both plists (it is a placeholder, not a literal).

Data flow: Claude Code → `:8006/mcp` (supergateway) → whatsapp-mcp Python MCP (stdio)
→ reads SQLite directly **or** calls the Go bridge REST on `:8010` → WhatsApp Web.

> The Python MCP reads `messages.db` directly for all **read** operations, so the
> whatsapp-triage skill can sweep chats even if the Go sidecar is momentarily down;
> only tool *calls* that hit the REST API need the sidecar.

## Placeholders & substitution

launchd **cannot expand `$VARS`** inside a plist and cannot see an nvm/asdf shim, so
the templates carry literal placeholders that the installer substitutes with `sed`,
resolving every value from the loader (`config/load-config.sh` /
`config/cos.env`) — exactly the `__REPO__` / `__VAULT_NAME__` convention the
`vault-server` template uses.

| Placeholder | Resolved from | Used in | Used for |
|-------------|---------------|---------|----------|
| `__BREW_PREFIX__` | `$BREW_PREFIX` | both | absolute `supergateway` / `uv` paths + `PATH` (launchd's PATH lacks Homebrew) |
| `__REPO__` | `$REPO_ROOT` | both | log paths under `__REPO__/mcp/logs/` |
| `__WHATSAPP_MCP_DIR__` | `$WHATSAPP_MCP_DIR` | both | the external whatsapp-mcp checkout (server, bridge binary, store) |
| `__WHATSAPP_MCP_BRIDGE_PORT__` | `$WHATSAPP_MCP_BRIDGE_PORT` | mcp-whatsapp | the supergateway HTTP `--port` (8006) |
| `__WHATSAPP_GO_PORT__` | `$WHATSAPP_GO_PORT` | both | the Go bridge bind port (8010); the MCP plist also builds `WHATSAPP_API_URL` from it |

> **No bearer-token placeholder.** The Python server resolves the Go bridge's bearer
> token from `$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token` (computed relative
> to its own `__file__`), so the live secret **never** lands in the installed plist —
> matching the vault template's "secret never in `~/Library/LaunchAgents`" rule. A token
> rotation therefore needs **no** plist re-render.

Render + install (see each template's header/footer for the exact `sed` invocation):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
sed -e "s#__BREW_PREFIX__#$BREW_PREFIX#g" \
    -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__WHATSAPP_MCP_DIR__#$WHATSAPP_MCP_DIR#g" \
    -e "s#__WHATSAPP_MCP_BRIDGE_PORT__#$WHATSAPP_MCP_BRIDGE_PORT#g" \
    -e "s#__WHATSAPP_GO_PORT__#$WHATSAPP_GO_PORT#g" \
  com.chiefofstaff.mcp-whatsapp.plist.template \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-whatsapp.plist"
```

(The `-whatsappbridge` template uses the same `sed` minus `__WHATSAPP_MCP_BRIDGE_PORT__`.)

## What's committed vs installed

**Only the `.template` files in this directory are tracked.** The rendered plists
(with placeholders substituted) land in `~/Library/LaunchAgents/` and are **never**
version-controlled. No secret is baked into either plist (see the token note above), so
re-rendering is only needed to pick up a path or port change — re-run the `sed` install.

## The `WHATSAPP_BRIDGE_PORT` gotcha (read this)

`WHATSAPP_BRIDGE_PORT` is read by **exactly one** process — the **Go** whatsmeow bridge
(`whatsapp-bridge/main.go`), which uses it as the port it **binds**. The **Python MCP
server does NOT read it** at all; it reaches the Go bridge **only** via
`WHATSAPP_API_URL`. So the two plists handle it oppositely:

- **MCP bridge plist (`:8006`)** — does **NOT** set `WHATSAPP_BRIDGE_PORT` (it would be
  a silent no-op that misleads). The bridge's own HTTP port is supergateway's `--port`
  (`$WHATSAPP_MCP_BRIDGE_PORT`); the Go bridge endpoint is pinned by
  `WHATSAPP_API_URL=http://localhost:$WHATSAPP_GO_PORT/api`.
- **Sidecar plist (`:8010`)** — sets `WHATSAPP_BRIDGE_PORT=$WHATSAPP_GO_PORT`: this is
  the **Go** process, the one that actually reads it.

On the cos side the two ports carry **distinct names** in `config/cos.env` —
**`WHATSAPP_MCP_BRIDGE_PORT`** (the supergateway bridge, 8006) and **`WHATSAPP_GO_PORT`**
(the Go sidecar, 8010) — deliberately keeping the literal name `WHATSAPP_BRIDGE_PORT`
confined to the one place it belongs: the Go sidecar's plist.

## Full runbook

This README covers the templates; for the end-to-end setup — building the Go binary,
the one-time QR pairing, loading both LaunchAgents, the `.mcp.json` / Cowork
registration, and verification — follow the **/whatsapp-mcp-setup** skill.
