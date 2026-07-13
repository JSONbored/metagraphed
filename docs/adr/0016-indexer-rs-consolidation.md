# ADR 0016 — indexer-rs consolidation: private repo into the public monorepo

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** #4947 (the consolidation issue), PR #5079 (the move itself),
  ADR 0014 (chain-data infrastructure — describes the indexer box this
  Rust process runs on; its own text said "if reality moves again, write
  ADR 0015" — 0015 was already claimed by the realtime-firehose ADR by the
  time this move happened, so this is 0016 instead).

## Context

ADR 0014 describes `indexer-rs` (the Rust continuous chain indexer +
sharded backfill) as living in a separate, private `metagraphed-indexer-rs`
repo — true when that ADR was written, and consistent with the earlier
`metagraphed-infra` precedent of keeping infra-adjacent code private. By
2026-07, `apps/ui/` had already gone through the same kind of move (folded
in from the former `metagraphed-ui` repo, 2026-07), establishing a working
precedent for consolidating a previously-separate implementation repo into
this monorepo without losing history or introducing a security regression.

Keeping `indexer-rs` private after that precedent no longer had a real
justification: it isn't itself a secret (subtensor is a public chain,
decode/backfill logic isn't proprietary), and splitting it out cost real
friction — a second repo to clone, a second CI surface, and no single place
to review chain-ingestion changes alongside the Worker code that consumes
their output.

## Decision

Move `metagraphed-indexer-rs` into `apps/indexer-rs/` in this repo (PR
#5079), matching `apps/ui/`'s own consolidation shape:

- **Full commit history preserved**, not squashed — merged via
  `git read-tree --prefix` (equivalent to `git subtree`, which wasn't
  available in the environment that did the move) so the ported history
  remains a real, permanently reachable second parent, content-verified
  identical to the source.
- **Independent security re-audit before merging**, not a rubber-stamp of
  the private repo's own audit: every commit's diff (not just filenames)
  was searched for leaked secrets/keys, credential-bearing connection
  strings, and private/tailnet IP literals or `.ts.net` hostnames. One
  real issue was found and fixed — one commit's author email
  was a real personal address rather than the GitHub-provided noreply
  address every other commit used — rewritten via `git filter-branch` in
  the source clone _before_ the merge, so it never entered public history.
- **New, path-scoped CI** (`.github/workflows/validate-indexer-rs.yml`,
  `paths: apps/indexer-rs/**`) so JS/Python PRs never pay for a Cargo
  build. Uses only GitHub-owned, SHA-pinned actions (`actions/checkout`,
  `actions/cache`) — `ubuntu-latest` runners already ship a preinstalled
  Rust toolchain, so no third-party toolchain action was needed against
  this repo's Actions allowlist.

**Deliberately not part of this move** (tracked separately, #5150):

- **The live deploy path.** `metagraphed-infra`'s `indexer-rust` Ansible
  role still assumes a manually-built-and-transferred Docker image
  (`docker buildx build` locally, `docker save | ssh ... docker load` onto
  the box) — there is no CI/CD here to break, but repointing that build
  source to `apps/indexer-rs/` needs its own verified, human-gated deploy
  before it's safe to flip.
- **Archiving the private repo.** `JSONbored/metagraphed-indexer-rs` is left
  untouched (not archived) until the deploy cutover above is verified
  stable — it remains the source of truth for production builds until then.

## Consequences

- One place to review chain-ingestion changes alongside the Worker code
  that consumes `indexer-rs`'s output, and one less repo to clone for a
  full local dev setup.
- `apps/indexer-rs/**`-scoped CI keeps the Cargo build off the hot path for
  every other PR, matching the `apps/ui/**` precedent.
- Until #5150 lands, the _build source_ and the _deploy source_ diverge:
  `apps/indexer-rs/` is where changes are reviewed and merged, but
  production still builds from the private repo's own copy. A change
  landed here does not reach production until it is also carried over
  there by hand — a real, temporary seam, not an oversight.
- The private repo stays around as a safety net (not archived) specifically
  so that seam has a working fallback if the cutover surfaces a problem.

## Links/resources

- PR #5079 — the move itself, full technical detail on the history-merge
  mechanics and the security re-audit
- #5150 — the follow-up: repoint the live deploy path to `apps/indexer-rs/`
  and decide the private repo's fate
- ADR 0014 — the chain-data infrastructure this process runs inside
