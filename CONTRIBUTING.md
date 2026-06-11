# Contributing to Cos

Welcome — Cos is your chief of staff, and it gets better when more hands shape it. Thanks for being here.

Cos is the persistent memory and judgment layer your agentic OS lacks — owned by you. It filters
communication noise (every channel is spam by default) into one honest view: a writable board of
what's left to do and a second-brain vault that compounds your context. Contributions that sharpen
that clarity, keep your data yours, and respect the human-in-the-loop are exactly what we want.

## How the repo is laid out

Everything lives in one monorepo. The fuller tour is in [`README.md`](./README.md); the short version:

- **`board/`** — the **Board**: a Next.js 15 app (App Router, React 19, Tailwind) and the writable
  kanban of what's left to do. UI under `app/` + `components/`, pure logic in `lib/`, the HTTP API
  under `app/api/`, persistence in `data/cases.json` (a single JSON file).
- **`vault/`** — the **Vault**: your second brain, a compounding context fingerprint, local-first.
  `example-vault/` is the committed template; your live vault is cloned from it and gitignored.
- **`guard/`** — the **Guard**: a fail-closed prompt-injection scanner (uv FastAPI sidecar) that reads
  untrusted mail *before* the agent does. See [Guard](docs/security/guard.md).
- **`search/`** — the **Search** sidecar: optional semantic search (uv Python, absent-safe). See
  [Search](docs/reference/search.md).
- **`mcp/`** — the local stdio **MCP servers** (`board` · `openwhispr` · `calendar` · `guard` · `vault`)
  that expose it all to agents, plus the shared `packages/mcp-kit` helper.
- **`config/`** — machine config, split by concern: `cos.env` (paths/ports), `secrets.env` (the API
  key), `settings.json` (board prefs), `auto-sync.json` (router switch). Only the `*.example` files
  are committed. Every shell step sources `config/load-config.sh` first.
- **`tests/`** — golden fixtures + invariants (see below).
- **`.claude/skills/`** — the setup skills that stand the system up.

## Local setup

Don't wire it by hand. Run the **`cos-setup`** skill — the single first-run entry point that sequences
vault → guard → MCP bridges → backup in dependency order. For the manual quickstart (just the board),
see [README → Manual quickstart (just the board)](./README.md#manual-quickstart-just-the-board):
`source "$(git rev-parse --show-toplevel)/config/load-config.sh"`, then `cd board && npm install && npm run dev`.

## Proposing changes

1. **Branch** off `main` — never commit to `main` directly.
2. Keep it **scoped**: one concern per pull request. A tight PR that does one thing well beats a sprawling one.
3. Open a **PR** with a clear description of the what and the why. Link the issue if there is one.
4. Make sure the tests pass (`tests/run.sh`) before you ask for review.

## Coding conventions

- **Match the surrounding code.** Read the file you're editing and follow its style, naming, and
  structure. Cos prefers small, pure modules (the board's read-projection selectors, the vault's
  property-tested skills) over clever abstractions.
- **Keep changes additive and back-compat** where you can — the store migrates-on-read (`schemaVersion`
  + a pure `migrate()`); bump the schema additively rather than breaking old files.
- **The `COS_` env-prefix convention.** All Cos environment variables use the `COS_` prefix (e.g.
  `COS_VAULT_DIR`, `COS_GUARD_URL`). Don't hardcode paths or ports — source `config/load-config.sh`
  and read from config.
- **Never add `board` to the npm workspace.** The root `package.json` workspace scopes the four
  `mcp/*-server` packages + `packages/*` only. Adding `board` guts `board/node_modules` and 500s the
  dev server. The board manages its own install.
- **Don't touch functional identifiers** when editing prose — the `COS_` prefix, `cos.env`, `cos-setup`,
  the `@cos` npm scope, package `name` fields, and launchd labels are intentional. Edit comments and
  human-readable strings, not keys, imports, or paths.

## Running tests

The full suite lives in [`tests/`](./tests/) and runs from anywhere:

```bash
tests/run.sh
```

It runs against a **throwaway copy** of the board + vault in a temp sandbox — **never your live data**.
Unit tests over the pure board modules and the board lint are hard gates; the HTTP/API steps spin up an
isolated test board and self-skip when their dependencies aren't installed. Add a test alongside any
behavior change, and assert on **structural invariants**, not prose.

## The ethos: propose, then approve

Cos is **human-in-the-loop and fail-closed** by design. The board's `propose → approve/reject → commit`
queue, the Guard that treats unscanned mail as untrusted, the auto-sync approval mode — these are not
accidents. When you add a capability that acts on the user's behalf, give them the seat at the wheel:
propose the action, let them approve it, and fail safe when in doubt. The human and the agent drive one
shared surface; neither gets to surprise the other.

## Good first issues

New here? Look for issues tagged **`good first issue`**. Docs fixes, a missing test case, a small UI
polish on the board, a sharper label description — these are real contributions and a great way to learn
the codebase. If something confused you on your first read, that's a contribution waiting to happen.

## Conduct and security

Be the kind of collaborator you'd want a chief of staff to be: assume good faith, be respectful and direct, and keep discussion focused on the work. Harassment or hostility toward anyone isn't welcome here.
Found a vulnerability? Please report it responsibly per [`SECURITY.md`](./SECURITY.md) rather than opening
a public issue.
