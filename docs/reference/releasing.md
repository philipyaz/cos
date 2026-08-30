# Releases &amp; versioning

How Cos is versioned, and how a release is cut. The short version: **you never hand-edit
version numbers.** [release-please](https://github.com/googleapis/release-please) watches
`main`, keeps a running **Release PR** with the next version + changelog, and a release
happens the moment you merge it.

## How Cos is versioned

Cos is versioned as a **whole repository** — one git tag and one GitHub release per version,
*not* per package. The root [`package.json`](https://github.com/philipyaz/cos/blob/main/package.json)
`version` is the single source of truth. The individual `package.json` / `pyproject.toml`
versions inside the monorepo — `board/`, the `mcp/*-server`s, `packages/*` — are **internal**,
may drift, and are never published to a registry; release-please does not touch them.

Releases follow [Semantic Versioning](https://semver.org):

| Bump | When | Conventional Commit |
| --- | --- | --- |
| **MAJOR** (`1.0.0`) | A breaking change for operators: a non-back-compatible store migration, a config format change requiring action, or removing a feature/server. | `feat!:` · `fix!:` · `BREAKING CHANGE:` |
| **MINOR** (`0.2.0`) | A new, backward-compatible feature — a new capability, MCP tool, or server. **New features land here.** | `feat:` |
| **PATCH** (`0.1.1`) | Bug fixes, docs, and dependency bumps; no behaviour change. | `fix:` |

!!! note "While Cos is in 0.x"
    Breaking changes ride a **minor** bump and features bump the minor (not the patch) —
    release-please is configured with `bump-minor-pre-major: true` and
    `bump-patch-for-minor-pre-major: false` to match. The board store's `schemaVersion` is a
    **separate** axis from the release version: it migrates on read and is bumped
    independently when the data shape changes.

## The release flow

1. **Merge feature/fix PRs to `main`** with [Conventional Commit](https://www.conventionalcommits.org)
   titles (`feat:`, `fix:`, `docs:` …). Never edit the version by hand.
2. On every push to `main`, the
   [release-please workflow](https://github.com/philipyaz/cos/blob/main/.github/workflows/release-please.yml)
   opens or updates a single **Release PR** (titled like `chore(main): release 0.2.0`). It
   computes the next version from the commits since the last release and writes the matching
   `package.json` bump + `CHANGELOG.md` entry.
3. The Release PR is your **staging area** — let it accumulate as more PRs land. Want richer
   notes than the commit subjects? Edit `CHANGELOG.md` *in the Release PR* before merging.
   Always add an **"Upgrade notes"** paragraph there that links the release's section of
   [Upgrading an existing install](upgrading.md) — the schema range, new config keys, and anything a
   machine must re-render, re-upload, or restart; the conventional-commit changelog never says any of that.
4. **To cut the release, merge the Release PR.** release-please then tags `vX.Y.Z`, publishes
   the GitHub Release from the changelog, and bumps `.release-please-manifest.json`.

That's it — no tagging, no `gh release create`, no manual changelog edits.

### What drives the version

Only `feat` (→ minor) and `fix` (→ patch), plus breaking changes (`!` / `BREAKING CHANGE`),
move the version. Other types are changelog-only and don't, on their own, trigger a release —
so a lone `docs:` or `chore:` commit will sit on `main` until the next `feat`/`fix` opens a
Release PR. The commit type also picks the changelog heading (`feat` → **Features**, `fix` →
**Bug Fixes**, `perf` → **Performance Improvements**, … see
[`release-please-config.json`](https://github.com/philipyaz/cos/blob/main/release-please-config.json)).

## One-time setup (maintainers)

This is wired up once and then runs itself. The moving parts:

- **Workflow** —
  [`.github/workflows/release-please.yml`](https://github.com/philipyaz/cos/blob/main/.github/workflows/release-please.yml)
  (pinned `googleapis/release-please-action`).
- **Config** —
  [`release-please-config.json`](https://github.com/philipyaz/cos/blob/main/release-please-config.json)
  (release type, `v`-prefixed tags, changelog sections) and
  [`.release-please-manifest.json`](https://github.com/philipyaz/cos/blob/main/.release-please-manifest.json)
  (the last released version — release-please updates this for you).
- **Repo setting** — *Settings → Actions → General → Workflow permissions* must have
  **"Allow GitHub Actions to create and approve pull requests"** enabled, or release-please
  cannot open the Release PR.
- **`RELEASE_PLEASE_TOKEN` secret** — a fine-grained PAT (see below) so the Release PR's CI
  actually runs. Not set by default; the workflow falls back to `GITHUB_TOKEN` without it.

!!! warning "The bot's Release PR CI run parks — it needs a nudge"
    The Release PR *does* get a `lint-test` / `python` CI run created on every push — but
    when it's opened with the default `GITHUB_TOKEN`, the run parks at `action_required`
    awaiting manual approval. The repo's contributor-approval policy for workflow runs
    (*Settings → Actions → General → "Approval for running fork pull request workflows from
    contributors"*; `gh api repos/philipyaz/cos/actions/permissions/fork-pr-contributor-approval`)
    catches the bot's own PRs too, so the checks never report and the strict `main` ruleset
    blocks the merge (the parked runs are visible under *Actions*, filtered by the branch
    `release-please--branches--main--components--cos`). **No owner bypass exists** — the
    `main` ruleset has zero bypass actors, deliberately — so this has to be unstuck, not
    skipped.

    - **Primary path (recommended): a `RELEASE_PLEASE_TOKEN` secret.** A fine-grained PAT
      (repository `philipyaz/cos` only; *Contents: Read and write* + *Pull requests: Read
      and write*), stored as a repository Actions secret. The workflow already prefers it
      (`secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN`) — pushes/PRs made with it
      trigger CI as the token's owner, so the checks gate the merge normally, every time.
      **Failure mode:** an expired PAT does **not** fall back — the `||` only fires on an
      absent/empty secret, and an expired token is still a non-empty string. Instead the
      `release-please` workflow on `main` fails red (bad credentials) and the Release PR
      stops being refreshed, so its version and changelog go stale. Check
      `gh run list --workflow release-please.yml` after a merge to `main`; fix by
      re-minting and `gh secret set RELEASE_PLEASE_TOKEN --repo philipyaz/cos`. Only an
      absent secret falls back to `GITHUB_TOKEN` — and then the runs park again.
    - **One-off unblock (no secret set yet).** Approve the parked run from the Actions tab
      ("Approve and run"), or push an empty commit to the Release PR's branch yourself — a
      `pull_request` event from a maintainer runs CI unparked. Merge promptly: the next push
      to `main` regenerates the branch and re-parks it.

## Manual fallback

If you ever need to cut a release by hand (release-please is down, or a one-off), the classic
flow still works from a clean, green `main` — bump `version` in
[`package.json`](https://github.com/philipyaz/cos/blob/main/package.json), add the
`CHANGELOG.md` entry, land it via PR, then from the updated `main`:

```bash
git tag -a vX.Y.Z -m "Cos vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes
```

Then set the new version in `.release-please-manifest.json` so release-please picks up from
the right baseline next time.

The released entries themselves live on the [Changelog](../changelog.md) page.
