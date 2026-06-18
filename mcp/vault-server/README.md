# vault MCP server (v2)

A stdio MCP server (registry name **`vault`**) that **embeds the Claude Agent SDK** to run headless
sessions over the Cos **domain-split knowledge vault** (`work/` · `life/` · `shared/`). Four tools:
**`ingest`** (asynchronous — submit-then-poll), **`ingest_status`**, **`ingest_cancel`**, and
**`query`** (synchronous). `query` runs its session inline; `ingest` enqueues a job and a **detached
launchd runner** (`com.chiefofstaff.mcp-vaultjobs`, [`jobs-runner.mjs`](jobs-runner.mjs)) performs the
synthesis — so a multi-minute ingest survives the client's tool-call timeout (notably Cowork's ~4-min
cap). The shared agent-run path (prompts, scoping safeguards, `run()`) lives in
[`agent.mjs`](agent.mjs); the durable job store in [`jobs.mjs`](jobs.mjs). Runs over stdio; Claude
Desktop bridges it into Cowork, or front it with supergateway for the HTTP bridge on **`8005`**.
Full async lifecycle: [docs/reference/vault-async.md](../../docs/reference/vault-async.md).

> **This server is different from its siblings.** `board`, `calendar`, and `guard` are thin
> `fetch` wrappers over an HTTP route and make **no LLM calls**. `vault` **embeds the Agent
> SDK** (`@anthropic-ai/claude-agent-sdk`) and runs a full agent session per tool call. That
> has two consequences you must plan for: it needs an **`ANTHROPIC_API_KEY`** in its
> environment, and each call takes **seconds to minutes** and **costs tokens**.

## Knowledge only — never the board

The vault is the **knowledge** half of the system; the **board** is the **action** half. This
server is **KNOWLEDGE-ONLY**: the embedded session has **no board / calendar / guard tools** and
**must not create or move board cases**. Any board case id you hand to `ingest` is recorded **by
reference only** — a read-only `cases:` / **Board:** note inside the wiki. The vault never writes
the board.

The wiki is **domain-split**:

| Domain | Path |
| --- | --- |
| work | `$COS_VAULT_DIR/work/wiki` |
| life | `$COS_VAULT_DIR/life/wiki` |
| shared entities | `$COS_VAULT_DIR/shared/wiki` |

## Tools

`[x]` marks optional args.

### `ingest(content, [files], [domain], [cases])`

Ingest knowledge into the domain-split vault wiki. Provide inline `content` (a thought / email /
transcript / recap) **and/or** `files`. The session classifies each input's domain (`work|life`),
re-synthesizes the affected source / entity / concept pages in that wiki (rewrite, don't append —
a substantive source touches ~10–15 pages), updates that domain's `index.md` / `log.md`, and
resolves entities to canonical `[[wikilinks]]`. **Asynchronous:** returns a **`job_id`** immediately
(in `structuredContent`) and a detached runner performs the work — poll `ingest_status` to a terminal
state. On `completed`, `ingest_status` surfaces the JSON ingest summary
(`{ perDomain, sourcesCreated, pagesResynthesized, contradictions, boardRefsRecorded }`). Identical
re-submits **dedup** to the same `job_id` (no second agent). See
[Async vault ingest](../../docs/reference/vault-async.md).

- `content` **(required)** — inline material. May be an **empty string** if `files` are supplied.
- `files` `[x]` — array of **absolute on-device paths** to read as sources (PDFs / images read
  natively). Each path must be inside the vault root **or** inside an allowed
  `COS_VAULT_ATTACH_DIRS` dir; **any path outside the allowlist rejects the whole call** (see
  [Path validation](#path-validation--arbitrary-file-read-guard)).
- `domain` `[x]` — `work | life | auto` (default `auto`, the session classifies each input).
- `cases` `[x]` — board case ids (e.g. `CASE-1`) recorded **by reference only**.
- **Validation:** rejects when **both** `content` is empty **and** no `files` are given
  (`provide content or files`).

### `ingest_status(job_id)`

Poll an ingest job started by `ingest`. Returns the job's `status` (`working` | `running` |
`completed` | `failed` | `cancelled` | `interrupted`) in `structuredContent`, plus `result` on
`completed` (the ingest summary) or `error` on `failed` / `interrupted`. Call every `poll_interval_ms`
until terminal. An unknown / expired `job_id` returns an error (the job aged out of its retention
window — re-submit the material).

- `job_id` **(required)** — the id returned by `ingest`.

### `ingest_cancel(job_id)`

Request a cooperative stop of an in-flight ingest job. Pages already written **stay** (no rollback);
acking an already-terminal job is a harmless no-op.

- `job_id` **(required)**.

### `query(question, [domain])`

Answer a question against the domain-split vault wiki. The session reads the matching domain
`index.md`(s), follows `[[wikilinks]]`, and answers with `[[wikilink]]` citations. **Read-only**
(`Write` / `Edit` are disallowed). KNOWLEDGE-ONLY: no board access — a question that is **purely**
about open work / to-dos is **declined with a pointer to the board**.

- `question` **(required)**.
- `domain` `[x]` — `work | life | both | auto` (default `auto`; `both` reads work + life).

## Embedded Agent SDK + nesting safeguards

Each call is `query({ prompt, options })` from `@anthropic-ai/claude-agent-sdk`. Because this MCP
is itself bridged at `vault:8005` in the repo's `.mcp.json`, a naïve inner session could re-mount
**this** server and recurse into `ingest` / `query`. The `baseOptions` are written to make that
impossible, all set deliberately:

- **`mcpServers: {}` + `strictMcpConfig: true`** — the inner agent mounts **no** MCP servers and
  is forbidden from reading any `.mcp.json`, so it can never re-mount `vault:8005` and recurse.
- **`disallowedTools`** lists `mcp__vault__ingest` / `mcp__vault__query` (and `WebFetch` /
  `WebSearch`) — belt-and-braces: even if a server were mounted, the re-entrant tools are denied.
  `query` additionally disallows `Write` / `Edit` (read-only).
- **`settingSources: ["project"]`** — set **explicitly** (the SDK default is version-ambiguous) so
  the inner session loads only the **vault-local** `CLAUDE.md` + skills, **not** the repo-root
  config (which carries the full board / guard MCP wiring).
- **`cwd = COS_VAULT_DIR`** — the **scoped vault**, not the launchd repo-root WorkingDirectory, so
  `project` settings and the `Read/Write/Glob/Grep` tools are anchored to the vault.
- **`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`** — fully
  non-interactive behind the MCP (no human is on the other end of a permission prompt).

The session is allowed only `Skill`, `Read`, `Glob`, `Grep` (+ `Write`, `Edit` for `ingest`), and
loads `second-brain-ingest` / `second-brain-query`.

## Path validation — arbitrary-file-read guard

`ingest.files` is the one place a caller could ask the server to read an arbitrary on-device file.
Before the agent is **ever** invoked, every path is checked: it must be a **non-empty absolute
path**, it is resolved, and it is accepted only if it lives **inside `COS_VAULT_DIR`** or **inside
one of `COS_VAULT_ATTACH_DIRS`**. Any offending path **rejects the whole call** with an error
naming the path. For accepted **out-of-vault** paths, their parent dirs are passed to the session
as `additionalDirectories` so `Read` can reach them (in-vault paths are already reachable via cwd).

## Config

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | **yes** | — | The embedded SDK calls the Anthropic API. Without it, sessions fail and the tool returns a clean error. |
| `COS_VAULT_DIR` | **yes** | — | Absolute vault root. Missing/nonexistent → every tool returns a clear error (the process still boots so KeepAlive stays calm). |
| `COS_VAULT_QUERY_MODEL` | no | `claude-haiku-4-5` | Model for the **read** path (`query`) — fast/low-cost tier so a lookup returns inside the client's tool-call timeout. |
| `COS_VAULT_INGEST_MODEL` | no | `claude-sonnet-4-6` | Model for the **write** path (`ingest`) — higher tier for multi-page synthesis quality. |
| `COS_VAULT_MODEL` | no | _(unset)_ | If set, pins **both** tools to this model (back-compat / global override of the two above). |
| `COS_VAULT_MAX_TURNS` | no | `30` | Max agent turns for `ingest`. |
| `COS_VAULT_QUERY_MAX_TURNS` | no | `15` | Max agent turns for `query` (a read needs far fewer than a synthesis). |
| `COS_VAULT_INGEST_TIMEOUT_MS` | no | `600000` | `ingest` per-call timeout. NOTE: under **Cowork** the binding limit is Cowork's own hard ~4-min cap (unconfigurable, ignores progress); this generous ceiling is for the **Claude Code** bridge (client tool timeout ~28h by default). Client cancellation is wired into the abort, so it won't keep burning tokens after a client gives up. |
| `COS_VAULT_QUERY_TIMEOUT_MS` | no | `90000` | `query` per-call timeout (Haiku reads finish well inside this). |
| `COS_VAULT_TIMEOUT_MS` | no | _(unset)_ | If set, overrides **both** timeouts above (back-compat). |
| `COS_VAULT_ATTACH_DIRS` | no | _(empty)_ | Colon-separated allowlist of dirs **outside** the vault from which `ingest.files` may be read. |
| `COS_VAULT_CONCURRENCY` | no | `2` | Max embedded sessions running at once (the semaphore). |

## Cost & concurrency caveats

- **Every tool call is a full agent session** — seconds to minutes, consuming tokens. Don't call
  it in a tight loop; batch material into a single `ingest`.
- A tiny **in-process semaphore** (`COS_VAULT_CONCURRENCY`, default **2**) serializes sessions so
  simultaneous tool calls don't fan out into N concurrent `claude` subprocesses.
- Every failure mode — thrown error, abort / timeout, SDK-spawn failure — is caught and returned
  as an MCP error result, so a bad input can never **crash-loop** the KeepAlive'd process.

## Install

```bash
cd mcp/vault-server && npm install
```

## `.mcp.json` entry (registry name: `vault`)

The bridge port for this server is **`8005`** (board = `8001`, openwhispr = `8002`,
calendar = `8003`, guard = `8004`, search = `8008`).

### Option A — HTTP via supergateway (the bridged setup)

Under launchd this server is fronted by the **`launch.sh`** wrapper (the plist's only
`ProgramArguments` entry), which sources the `ANTHROPIC_API_KEY` from the gitignored
`config/secrets.env` and then execs supergateway — so the key stays out of the installed
plist. The plist itself is generated from `mcp/vault-server/vault.service.json` by
`scripts/gen-launchd.mjs` (see [`mcp/CLAUDE.md`](../CLAUDE.md)). See the `mcp-bridge-setup`
skill for the full install. The equivalent by hand:

```bash
# one-time: put the key in the gitignored secrets file
cp config/secrets.env.example config/secrets.env   # then edit in your sk-ant-… key

# the wrapper loads it and fronts the stdio server on :8005
COS_VAULT_DIR=/ABSOLUTE/PATH/TO/vault/my-personal-thoughts-vault \
  /ABSOLUTE/PATH/TO/mcp/vault-server/launch.sh &
```

Point `.mcp.json` at the bridge:

```json
{
  "mcpServers": {
    "vault": { "type": "http", "url": "http://localhost:8005/mcp" }
  }
}
```

### Option B — local stdio (no supergateway, for testing on your own machine)

Claude Code spawns the server itself over stdio:

```json
{
  "mcpServers": {
    "vault": {
      "command": "node",
      "args": ["./mcp/vault-server/server.mjs"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "COS_VAULT_DIR": "/ABSOLUTE/PATH/TO/vault/my-personal-thoughts-vault"
      }
    }
  }
}
```
