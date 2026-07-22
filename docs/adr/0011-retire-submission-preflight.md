# ADR 0011 — Retire the metagraphed-side submission preflight

- **Status:** Accepted — implemented.
- **Date:** 2026-06-25
- **Supersedes:** the community-candidate-file intake of
  [ADR 0004](0004-candidate-trust-model.md).
- **Implements:** [ADR 0009](0009-autonomous-review-gate.md) ("metagraphed
  pre-gates nothing") on the one-file surface model of
  [ADR 0008](0008-subnet-data-model.md).

## Context

[ADR 0004](0004-candidate-trust-model.md) introduced a per-surface
**community-candidate file** intake (`registry/candidates/community/*.json`)
fronted by a deterministic **public preflight** in this repo
(`submission-policy.mjs` + `submission-pr.mjs` + the `metagraphed-submission-gate`
CI job), with a private AI gate behind it.

Two later decisions hollowed that out:

- **[ADR 0008](0008-subnet-data-model.md)** moved community contributions to
  **one file per subnet** (`registry/subnets/<slug>.json`); the per-candidate-file
  lane was retired and `validate-intake` now hard-fails it (#1670, #1734).
- **[ADR 0009](0009-autonomous-review-gate.md)** made an **external** gate
  (Gittensory) the sole adjudicator and declared metagraphed **pre-gates nothing**.

The preflight survived as dead weight: the `metagraphed-submission-gate` job is
**not a required check**, classifies every surface PR as `normal-pr` and **skips**,
and writes a report to `RUNNER_TEMP` that nothing reads. Verified against
`JSONbored/gittensory`: it references **none** of these scripts or the check (the
gate carries its own classifier), and the `submission-gate.metagraph.sh/health`
client points at a dead endpoint.

## Decision

Retire the metagraphed-side submission preflight and its externalized-gate client
stubs entirely. Remove `submission-policy.mjs`, `submission-pr.mjs`,
`ci-validate-route.mjs`, `classify-validation-route.py` (+ its action),
`submission-comment.mjs`, `submission-notifications.mjs`,
`submission-gate-health.mjs`, `submission-formatting.mjs`, `provider-new.mjs`, the
`submission-gate.yml` workflow, the dead tests, and `docs/submission-gate.md`.

Preserve the **only live survivors** — the owner-token match + GitHub-login helpers
that the build's candidate→surface promotion (`generated-overlays.ts`) and
`surface:add` depend on — in a focused `scripts/registry-identity.mjs`.

## Consequences

- **One model, not two.** `validate-surface` + `validate-intake` (in the required
  `checks` job) own shape/safety; the external Gittensory Gate ([ADR 0009](0009-autonomous-review-gate.md))
  owns adjudication. The contradictory candidate model is gone.
- **Leaner CI + tree** — one advisory CI job and ~2k lines of dead code/tests
  removed, with **no behavior change for any live PR** (surface PRs already skipped
  the preflight and are reviewed by the external gate).
- **The candidate → verified-surface _trust_ model ([ADR 0004](0004-candidate-trust-model.md))
  endures** — owner-match + liveness-before-promotion still gate
  machine-discovered surfaces, now via `registry-identity.mjs`; only the
  _community-candidate-file intake_ it described is retired.
- **0009 is now literally true** — "metagraphed pre-gates nothing" no longer has a
  residual pre-gate contradicting it.
