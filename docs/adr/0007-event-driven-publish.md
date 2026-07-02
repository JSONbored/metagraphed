# ADR 0007 — Event-driven data publish + daily floor (replacing the 6h cron)

- **Status:** Accepted — implemented (#1250).
- **Date:** 2026-06-19
- **Supersedes:** the 6h-cron data refresh in ADR 0001's "Outcome — deploy
  architecture" (the `metagraph:latest` pointer is now advanced on data change,
  not on a fixed 6h timer).
- **Relates to:** ADR 0002 (live operational health — the 15-minute prober) and
  the live economics tier — the two volatile tiers this publish is decoupled
  from.

## Context

ADR 0001 split serving into a slow **batch publish** (build → R2 → KV
`metagraph:latest` pointer) and a fast committed contract. It ran the batch on a
**6h cron**. After ADR 0002 moved operational health to a live 15-minute prober
and the economics tier moved to its own ~3h KV refresh, the only thing the batch
publish still produces is the **structural** dataset (subnets, providers,
surfaces, search, profiles, evidence — things that change when a _human-curated
registry input_ changes, plus slow on-chain identity/metadata drift).

That left the 6h cron mismatched to its remaining job in both directions:

1. **Too slow for contributor changes.** A merged registry PR (a new subnet,
   provider, community candidate, maintainer review, or adapter) waited up to 6h
   to appear in the served dataset — friction for the autonomous contributor
   lane, whose whole point is "merge → it's live."
2. **Mostly wasted work.** Most 6h ticks rebuilt and republished a dataset whose
   human inputs had not changed at all — 1k+ surface re-probes and a full R2
   upload for a no-op delta, four times a workday.

The naive fix — "flip the pointer on every push to `main`" — is a **landmine**:
a code- or docs-only push carries no fresh chain snapshot, so a build triggered
by it could advance the live pointer onto structurally-stale data.

## Decision

**Publish on data change, not on a clock; keep a daily floor; never trust a
trigger to carry freshness.** `publish-cloudflare.yml` is repurposed:

1. **Push trigger scoped to human-input registry paths** — `registry/subnets`,
   `registry/providers`, `registry/candidates/community`, `registry/reviews`,
   `registry/adapters`. A merged contributor change republishes within minutes.
   Machine-generated paths (`registry/native`, `registry/generated`,
   `registry/candidates/generated`) are excluded — the build regenerates them, so
   they must not self-trigger. Code/docs commits don't match the filter, so they
   never re-probe (ADR 0001's decoupling intent is preserved).
2. **A once-daily schedule floor** (07:17 UTC) catches slow chain/registry drift
   that no human-input event covered.
3. **Freshness by construction, not by trigger.** Every run fresh-fetches the
   chain snapshot _first_ (`build.mjs` `productionSteps`, tolerant), so the KV
   `latest` pointer always flips onto freshly-built data regardless of what
   triggered the run. This is what makes a push trigger safe — the pointer can
   never advance onto stale data, because there is no "reuse the last snapshot"
   path.

The two volatile tiers stay decoupled and refresh independently: operational
health via the 15-minute prober (`src/health-prober.mjs`, ADR 0002), economics
via `refresh-economics.yml` (~3h KV tier). `operational-surfaces.json` is
DUAL/committed (#1247) so the live prober survives a publish outage.

## Consequences

- A contributor's merged change is live in minutes; no-op 6h ticks disappear.
- Maximum structural-data staleness with zero input changes is bounded by the
  daily floor (~24h) rather than the cron (~6h) — acceptable because the
  _volatile_ data (health, economics) is served live, and structural data that
  has no input change is by definition not drifting except for slow on-chain
  metadata, which the daily floor covers.
- The publish core (build → R2 → pointer) is unchanged and irreducible; only its
  **cadence and trigger** changed. Any future "skip the rebuild and just reflip
  the pointer" optimization is forbidden for the same reason the naive push fix
  was: it would decouple the pointer from a fresh snapshot.
- Docs/comments that described a "6h publish/cadence" are corrected to "the data
  publish"; a `validate-docs` prose guard fails the build if the stale 6h/2-min
  cadence language reappears in served-facing (non-ADR) docs.
