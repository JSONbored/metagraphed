# ADR 0008 — Subnet data model: one file per subnet, trust + review as fields

- **Status:** Accepted — implemented (#1678 + the surface-model migration).
- **Date:** 2026-06-24
- **Relates to:** ADR 0004 (candidate → verified-surface trust model — the
  machine-verification axis this separates from human review) and ADR 0006
  (provenance-tiered storage — git holds these human inputs).

## Context

A contribution adds a _surface_ (a public API, doc, schema, RPC, or dashboard) to
a subnet. The earlier layout spread this across the tree: providers were split by
trust into `registry/providers/` vs `registry/community/`, and surfaces were
proposed as per-candidate files. Two problems followed:

- **PR-splitting farms.** One surface per file, plus trust-by-directory, invited
  many tiny redundant PRs — the same surface re-submitted as a different `kind`,
  or one PR per surface — noise the review gate then had to auto-close.
- **Trust and review were encoded by _location_.** Moving a surface between trust
  tiers meant moving files, and there was no clean place to record a _human_
  review decision distinct from machine probe results.

## Decision

One subnet is **one file** — `registry/subnets/<slug>.json`, holding a
`surfaces[]` list. Trust and governance are **fields on each surface, not
directories**:

- **`authority`** — provenance/trust tier: `official`, `registry-observed`,
  `provider-claimed`, `community`, `native-chain`. Providers likewise live in a
  single flat `registry/providers/<slug>.json`; trust is the `authority` field,
  not the directory (#1678).
- **`review`** — the **human governance axis**:
  `{ state: community-submitted | maintainer-reviewed | rejected, … }`. This is
  deliberately **separate from machine verification** — probe-derived
  health/freshness is a live overlay (ADR 0002), never a stored, hand-set field.
  A surface can be `maintainer-reviewed` (human) yet `unknown` health (machine),
  and vice versa.

A data contribution therefore edits **exactly one** `registry/subnets/<slug>.json`.
For an existing manifest, it appends surface(s) with `authority: "community"` and
`review.state: "community-submitted"` — and nothing else. For a missing manifest,
the same one-file contribution may create the required `subnet:new` scaffold and
add the surface(s) to it.

Base-layer network endpoints (`subtensor-rpc`/`subtensor-wss`/`archive`) are the
one carve-out: maintainer-curated infra on `root.json` (netuid 0), not the
contributor surface lane.

## Consequences

- **One merge per subnet.** Adding several surfaces for a subnet is one diff, one
  review, one merge — and the autonomous gate (ADR 0009) validates a single
  file's diff.
- **Trust is data.** Promotion between tiers is a field change — machine-checkable
  — not a file move. The display layer reads `authority`/`review` directly.
- **Human and machine signals never conflate.** `review.state` records what a
  maintainer decided; health/verification stays a probe overlay (probe-derived
  only, per ADR 0002).
- **Trade-off:** large subnets accrue large single files. Accepted — they stay
  diff-reviewable, and one-file-per-subnet is what makes the autonomous gate
  tractable.
