<!-- Thanks for contributing to Cos! Keep PRs scoped: one concern per PR. -->

## What & why

<!-- What does this change, and why? Link the issue if there is one (e.g. Closes #123). -->

## Checklist

- [ ] Branched off `main` (not committed to `main` directly)
- [ ] One concern — a tight PR that does one thing well
- [ ] Tests pass (`tests/run.sh`)
- [ ] Added/updated a test for any behavior change
- [ ] Changes are additive / back-compat where possible (bumped the store `schemaVersion` + `migrate()` if the data shape changed)
- [ ] Updated docs under `docs/` and the `nav:` in `mkdocs.yml` if behavior or features changed
- [ ] Added an entry under `## [Unreleased]` in `docs/changelog.md` if the change is user-facing
