# ADR 0009 — Autonomous contributor review gate (the Gittensory Gate)

- **Status:** Accepted — in use.
- **Date:** 2026-06-22
- **Relates to:** ADR 0008 (the one-file-per-subnet model the gate validates) and
  [`docs/submission-gate.md`](../submission-gate.md) (the operational contract
  this records the rationale for).

## Context

The contributor flywheel produces a steady stream of data PRs (new surfaces for
subnets). A maintainer cannot review each one, and a human pre-gate would be the
very bottleneck the flywheel exists to remove. The decision is **how a contributor
PR gets merged without a human in the loop — safely.**

## Decision

Contributor data PRs are adjudicated by an **external AI review gate** (Gittensory,
a separate repo + GitHub App) that is the **sole adjudicator** — the maintainer is
**not** in the loop before or after merge. metagraphed itself **pre-gates nothing**
(its CI emits advisory flags only; trust/provenance is display-only). The
disposition is deterministic at the edges and conservative in the middle:

- **Auto-CLOSE** on a deterministic fail — duplicate, dead/private `source_url`, a
  secret, **no linked issue**, a clear reviewer reject, or red CI.
- **Auto-MERGE** only when content is verified (owner-matched, fresh) with **both
  AI reviewers ≥ 0.9**, CI green, mergeable-clean, and a valid linked issue.
- **Hold for a human** only when genuinely uncertain.

The default posture is **close-when-in-doubt**: a redundant or unprovable PR costs
the contributor a re-submission, not the registry its integrity.

## Consequences

- **Throughput without a maintainer bottleneck** — the flywheel scales; recovery
  from an auto-close is a fresh PR, not a negotiation.
- **The gate is the contract.** Contributors (and AI tools) must get a PR _right
  before pushing_ — one focused subnet file (ADR 0008), a public `url` plus an
  independent `source_url` that proves it, and a linked issue. See
  [`docs/submission-gate.md`](../submission-gate.md) and the
  `contributing-to-metagraphed` skill for the checklist.
- **metagraphed stays adjudication-free** — no manual pre-escalation, no stored
  trust gating; the gate lives outside this repo and is configured there.
- **Trade-off:** an external adjudicator is a dependency, and a wrong auto-close is
  possible — accepted because the cost is a re-submit and the default protects the
  registry over any single contribution.
