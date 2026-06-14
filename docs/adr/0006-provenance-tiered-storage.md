# ADR 0006 — Provenance-tiered storage: git for human inputs, R2/D1 for machine data

Status: proposed (2026-06-14)

Refines [ADR 0001](0001-r2-only-data-artifacts.md). Builds on
[ADR 0002](0002-live-operational-health.md).

## Context

[ADR 0001](0001-r2-only-data-artifacts.md) set the rule "commit the source of
truth + the public contract; derive and serve everything else from R2," and
moved ~4.3 MB of high-churn derived artifacts to R2-only. [ADR 0002](0002-live-operational-health.md)
moved all operational health/analytics to D1 + KV, computed on read and never
written as files. Both worked: the `publish-cloudflare.yml` 6h job writes **only**
to R2 + the KV `latest` pointer — **zero git commits** — and the contract files
(`openapi.json`, `types.d.ts`) don't churn because they use a deterministic
epoch-0 `generated_at` with real time carried by the KV pointer (#349).

One churn source survived: **`sync-subnets.yml`**, a 6h scheduled job that opens a
`codex/sync-subnets` bot PR. ADR 0001's "commit `registry/**`" treated the
registry tree as homogeneous, but it is not — it mixes two provenance classes:

- **Human/community-authored, review-gated roots** — `registry/subnets/*`
  (curated interface overlays), `registry/providers/*` (operator profiles),
  `registry/reviews/*` (maintainer decisions), `registry/lineage.json`,
  `registry/candidates/community/*` (submitted, unverified, awaiting review).
  Across 5 inspected sync PRs the bot touched **none** of these; they change only
  via hand-authored PRs (`#502`, `#496`, `#491`).
- **Machine-derived inputs** — `registry/native/finney-subnets.json` (+ testnet;
  chain RPC snapshot), `registry/candidates/generated/public-sources.json`
  (scraper output), `registry/verification/promotions.json` (probe
  classifications), `registry/adapters/latest/*.json` (adapter latency
  telemetry). **These are the entire content of the scheduled bot PR.**

A field-level audit found the bot PR is **~95% machine telemetry** (chain `block`
height advancing, `captured_at` wall-clock timestamps, adapter `latency_ms`). The
root cause of "a diff even when nothing changed": `fetch-native-subnets.py`
stamps `captured_at = datetime.now()` and `sync-subnets.mjs` writes it
unconditionally with no content-stability guard, so the timestamp propagates into
`subnets.json` → `coverage.json` → `build-summary.json` and guarantees a
non-empty allowlisted diff every successful run. Committing machine-probed chain
state to git history is precisely the anti-pattern ADR 0001's own wording ("the
**source** of truth") argues against — a chain snapshot is not a source of truth a
human authored; it is a machine reading of one.

**Cadence was never the real problem; git-PR-ness was.** Subnet registration is
rare (a new netuid every few days at most) and chain-identity edits rarer, so a
6h cadence is already overkill — but once this data is an R2/D1 *overwrite*
instead of a git commit, the cadence stops mattering (overwrites have no history,
no PR, no review cost). The fix is to move it off git, not to slow it down.

**Motivation — the contributor flywheel.** metagraphed is being listed as a
gittensor emission-weighted repo, so the git tree is about to become the primary
surface contributors ("farmers") work against. The live coverage map shows the
opportunity precisely: all 129 subnets have identity/docs, but only ~15 expose a
callable `subnet-api`, ~13 an `openapi`, ~17 a `data-artifact` — i.e. **~114
subnets need an API surface registered**, thousands of discrete verifiable tasks.
For that flywheel to work, the git history must read as a log of *human*
contributions, not be drowned 6h-at-a-time by a bot committing chain telemetry.
Removing the scheduled bot PR is therefore not just churn-hygiene — it clears the
contribution surface the launch depends on.

## Decision

**A datum's store is decided by its _provenance_, not its shape or its
consumers.** Three tiers, with a single rule each:

1. **Git — human/community-authored, review-gated source of truth, and nothing
   else.** `registry/subnets/*`, `registry/providers/*`, `registry/reviews/*`,
   `registry/lineage.json`, `registry/candidates/community/*`, plus the
   code-adjacent API contract (`openapi.json`, `types.d.ts`, `contracts.json`,
   `api-index.json`, `schemas/index.json`). These change only by human PR and are
   verifiable/reviewable; git history is a record of human decisions.
2. **R2 — machine-produced, regenerable, served as an immutable blob.** Both the
   ~30 derived published artifacts (already R2-only per ADR 0001) **and the four
   machine-derived inputs** (`registry/native/*`, `registry/candidates/generated/*`,
   `registry/verification/*`, `registry/adapters/latest/*`). The production build
   fetches/derives these fresh each run — it already re-probes health and
   re-snapshots adapters live — and writes them to R2, never to git.
3. **D1 / computed-on-read — machine-derived, dynamic or queryable.** All health,
   trends, percentiles, incidents, trajectory, uptime, leaderboards. Unchanged
   from ADR 0002; recorded here for completeness.

Concretely:

- **Retire the `sync-subnets.yml` _scheduled_ trigger.** Keep it as
  `workflow_dispatch`-only for manual backfill. This removes 100% of the
  recurring git churn in one change. No hard publish gate depends on the
  committed native snapshot's freshness — the only hard gate
  (`assert-published-probe-health.mjs`) checks *probe* freshness, and the publish
  build re-snapshots adapters itself "so the freshness gate never depends on a
  recently-merged sync PR" (`build.mjs` productionSteps).
- **New-subnet and chain-identity discovery moves into the publish refresh**
  (machine data → R2/D1), surfaced through the change-feed / webhooks /
  candidates API — not a git diff. Cadence becomes a free knob (R2 overwrites
  cost nothing); daily is ample for chain registrations.
- **Contributor submissions never bypass the probe trust model.** A submitted
  surface lands as an *unverified candidate* and is only ever probed-as-
  operational after `verify → maintainer-review → promote`. So opening the git
  corpus to community PRs does not let bad/hostile endpoints reach the health
  prober — addressing the "we could ping the wrong endpoints" risk directly.
- **Re-point the changelog baseline.** `changelog.json` is built by diffing the
  new `subnets.json`/`coverage.json` against the *committed-HEAD* copies, which is
  the only reason those derived files are still committed. Diff against the last
  **published R2 snapshot** (or a small KV-stored digest) instead, so the derived
  indexes need not be committed at all.
- **Content-stability guard** on any machine timestamp that must remain in git:
  only restamp `captured_at` when the payload actually changed (mirrors the
  epoch-0 contract discipline).

This **refines ADR 0001**: "commit `registry/**`" becomes "commit only the
human-authored subset of `registry/**`; machine-derived inputs join the R2 tier."

## Consequences

- **Zero scheduled git churn.** The only commits become human PRs (overlays,
  provider profiles, community candidates, maintainer reviews) + code/contract
  changes. Git history becomes a log of human decisions, which is what makes it
  worth reviewing.
- **Chain-snapshot freshness now rides the publish cadence**, not a committed
  file. The publish already re-fetches it; the sole soft consequence of a stale
  read is the existing 7-day completeness-score demotion (`FRESHNESS_STALE_AFTER_DAYS`),
  a scoring penalty, not a publish failure.
- **The build's input resolution changes** for the four machine inputs (read from
  R2 / fetch-fresh instead of committed files), and the **changelog baseline**
  mechanism is rewritten. These are the two non-trivial code changes; everything
  else is deletion.
- **Provenance story improves.** "Trustworthy coverage" is verified by reviewable
  committed *human* inputs + a deterministic reproducible build + versioned R2
  evidence — machine readings no longer masquerade as committed source.
- **Reversible.** Re-enabling the scheduled trigger restores the old behavior; the
  R2 move is the only piece that requires a forward migration.

## Migration

| Step | Change | Effort | Risk |
|---|---|---|---|
| 1 | Delete the `schedule:` trigger from `sync-subnets.yml` (keep `workflow_dispatch`) | S | low — stops churn immediately; manual backfill still available |
| 2 | Make the production build fetch/derive the 4 machine inputs to R2 instead of reading committed files; stop committing them | M | medium — touches build input resolution; publish already re-fetches most |
| 3 | Re-point the changelog baseline to the last published R2 snapshot / KV digest; drop `subnets.json`/`coverage.json` from the committed (DUAL) tier | M | medium — changelog correctness; needs a one-time baseline seed |
| 4 | Add the `captured_at` content-stability guard (defensive; covers any machine field that stays in git) | S | low |

Each step is its own PR, sequenced 1→4 so nothing breaks: step 1 stops the bleed
immediately and is independently shippable; steps 2–3 are the substantive
migration; step 4 is belt-and-suspenders.

## Open questions

- **Discovery latency.** With no scheduled snapshot commit, a newly-registered
  subnet appears only at the next 6h publish (acceptable; same cadence as today's
  bot, just without the PR). Confirm no consumer expects sub-6h new-subnet
  visibility.
- **`registry/adapters/latest/`** is the one machine-scraped artifact currently
  living in the human `registry/` tree. Moving it to R2 is correct by this ADR but
  should be confirmed against the adapter-snapshot tooling that reads it back.
- **Audit-trail of machine inputs.** Git currently gives a free history of chain
  snapshots. If that history has value (e.g. forensic "what did the chain look
  like on date X"), it belongs in the R2 artifact-history mechanism, not git —
  confirm the R2 history retention covers it.
