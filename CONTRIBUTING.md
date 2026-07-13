# Contributing to Cos

Welcome — Cos is your chief of staff, and it gets better when more hands shape it. Thanks for being here.

Cos is the persistent memory and judgment layer your agentic OS lacks — owned by you. It filters
communication noise (every channel is spam by default) into one honest view: a writable board of
what's left to do and a second-brain vault that compounds your context. Contributions that sharpen
that clarity, keep your data yours, and respect the human-in-the-loop are exactly what we want.

## How the repo is laid out

Everything lives in one monorepo. The fuller tour is in [`README.md`](./README.md); the short version:

- **`board/`** — the **Board**: a Next.js 16 app (App Router, React 19, Tailwind) and the writable
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
  key), `settings.json` (board prefs), `auto-sync.json` (router switch). The loaders, `auto-sync.json`,
  and the `*.example` files are committed — the live `cos.env`/`secrets.env`/`settings.json` are
  gitignored. Every shell step sources `config/load-config.sh` first.
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

## Releasing (maintainers)

Cos is versioned as a **whole repo** — one git tag and one GitHub release per version, *not* per
package; the root [`package.json`](./package.json) `version` is the single source of truth (the
individual package versions inside the monorepo are internal and may drift). Releases follow
[Semantic Versioning](https://semver.org): a **new feature is a minor bump**, a bug fix is a
patch, and the board store's `schemaVersion` is a *separate* axis bumped independently of the
release tag.

**You don't hand-edit versions.** [release-please](https://github.com/googleapis/release-please)
watches `main` and keeps a running **Release PR** that bumps `package.json` + `CHANGELOG.md` from
the [Conventional Commit](https://www.conventionalcommits.org) titles since the last release. To
cut a release, **merge that Release PR** — it tags `vX.Y.Z` and publishes the GitHub Release. So
the one habit that matters day to day is a clear, conventional PR/commit title (`feat:`, `fix:`,
`docs:` …); the changelog writes itself.

The full runbook — the SemVer policy, the one-time repo setup, and the manual fallback — is in
[Releases & versioning](docs/reference/releasing.md).

## The ethos: transparent and human-in-the-loop

Cos is **human-in-the-loop and transparent by design.** The platform's core job is to make every
change *legible*: each write is attributed to `human` / `agent` / `system` in an append-only activity
log, and a human's manual edits are authoritative — never silently undone. On top of that, the board
offers an **opt-in** `propose → approve/reject → commit` queue an agent can route a change through when
it warrants sign-off; the platform doesn't force it — *when* to propose, and the rest of the
safeguards, live in the **skills** that drive Cos. (The Guard is the one strictly **fail-closed** piece:
unscanned mail is untrusted.) When you add a capability that acts on the user's behalf, keep them in
control: attribute it, prefer proposing consequential changes, and never overwrite a human's hand-made
edit. The human and the agent drive one shared surface; neither gets to surprise the other.

## Good first issues

New here? Look for issues tagged **`good first issue`**. Docs fixes, a missing test case, a small UI
polish on the board, a sharper label description — these are real contributions and a great way to learn
the codebase. If something confused you on your first read, that's a contribution waiting to happen.

## Conduct and security

Be the kind of collaborator you'd want a chief of staff to be: assume good faith, be respectful and direct, and keep discussion focused on the work. Harassment or hostility toward anyone isn't welcome here — see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) for the full standard and how to report a concern.
Found a vulnerability? Please report it responsibly per [`SECURITY.md`](./SECURITY.md) rather than opening
a public issue.
