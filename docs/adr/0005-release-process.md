# ADR 0005 — Release-channel policy

Status: accepted (2026-06-12)

## Context

metagraphed is a private monorepo app (`private: true`) that **generates** two
shippable client libraries from its OpenAPI contract, plus a continuously
deployed hosted service. There are three distinct shipping tracks with different
versioning rhythms, and until now the release-channel policy lived only in
maintainers' heads:

1. **npm — `@jsonbored/metagraphed`** (`packages/client/`): the typed TS client.
   SemVer; published from `publish-client.yml`.
2. **PyPI — `metagraphed`** (`python/`): the typed Python client. SemVer;
   published from `publish-python.yml`. Blocked on the one-time PyPI
   pending-publisher bootstrap (#378) before its first publish.
3. **Hosted Worker / API / MCP**: continuous-deploy via `publish-cloudflare.yml`,
   versioned by the date-string `CONTRACT_VERSION` in `src/contracts.mjs` — **not**
   a packaged release.

Both package workflows already use OIDC trusted publishing (no long-lived
tokens), a hardened split unprivileged-build / privileged-publish design, a
strict release gate (must be on `main`, strict SemVer, refuse if the tag or
registry version already exists), and — as their final step — create the git tag
and a matching GitHub Release. What was missing: a written policy for **which
channels we use**, and release notes worth reading (the GitHub Release body was a
hardcoded one-liner). This ADR records the policy and the categorized-notes
mechanism (issue #395, part of the #392 release-engineering epic).

## Decision

**Release channels: npm + PyPI + GitHub Releases. GitHub Packages is
deliberately excluded.**

- **Each package publish creates a matching GitHub Release atomically.** One
  workflow run does: publish to the registry → `git tag` (`client-v<ver>` /
  `python-v<ver>`) → `gh release create`. The npm/PyPI version, the git tag, and
  the GitHub Release are always the same version, created together. There is no
  separate "make a GitHub release" step to forget.
- **GitHub Packages is NOT used.** It is redundant with npmjs.org / PyPI (which
  already carry provenance) and adds install-time auth friction (consumers would
  need a GitHub token to `npm install`). GitHub Releases — the human-readable
  changelog + tag — are kept; GitHub _Packages_ — the registry — are not.
- **All publishing stays OIDC trusted publishing + provenance. No long-lived
  tokens** (no `NPM_TOKEN` / PyPI API token in secrets). Publishes run in the
  `npm-production` / `pypi-production` GitHub Environments.
- **Release notes are auto-generated and categorized.** `.github/release.yml`
  groups merged PRs since the previous release tag into Features / Fixes /
  Security / Documentation / Other by PR label, and the workflows pass
  `--generate-notes` to `gh release create` (the branded "published to npm/PyPI
  via OIDC" line is kept as the note header).
- **Triggers stay manual (`workflow_dispatch`).** A maintainer bumps the package
  version on `main`, then dispatches the workflow; the gate refuses anything that
  isn't strict SemVer / is already published. Automating the version bump +
  changelog is deferred to release-please (#394).

## Consequences

- **Categorization is label-driven** (GitHub's native mechanism). PRs without a
  type label land under "Other Changes". This is the lightweight, tool-agnostic
  interim; commit-type-driven notes + an auto-maintained `CHANGELOG.md` arrive
  with release-please monorepo mode (#394), at which point `--generate-notes` can
  be swapped for release-please's notes.
- **To cut a release:** bump the version in the package's `package.json` /
  `pyproject.toml` on `main`, then run the corresponding `publish-*` workflow.
  Do not hand-create tags or GitHub Releases — the workflow owns that.
- **PyPI is one bootstrap away.** `publish-python.yml` is fully wired but cannot
  authenticate until the PyPI pending publisher + `pypi-production` Environment
  exist (#378, owner action).
- The hosted Worker/API/MCP track is intentionally out of scope here — it has no
  packaged release. A dedicated `MCP_SERVER_VERSION` SemVer (independent of the
  date-string `CONTRACT_VERSION`) is tracked separately in #393.
