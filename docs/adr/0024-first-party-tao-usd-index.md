# ADR 0024 — First-party TAO/USD index: posture, venue criteria, and published methodology

- **Status:** Proposed
- **Date:** 2026-07-31
- **Relates to:** #8598 (this ADR), #8503 (the parent design spike, option (c)),
  #8599 (venue survey — the concrete list these criteria must be satisfied by),
  #8600 (computation + ingestion), #8601 (the published contract surface),
  #8602 (consuming it, and retiring the third-party call), #8603 (monitoring),
  #8369 / `src/price-at-tx.ts` (the first-party alpha price and the
  `price_basis` honesty-label convention this extends), ADR 0022 (shape).

## Context

**No TAO/USD history exists anywhere in this system.** No column in
`deploy/postgres/schema.sql`, no field in any `schemas-src/` route schema, no
ingestion job.

The only TAO/USD in the product today is a live spot read of
`api.coinpaprika.com/v1/tickers/tao-bittensor`
(`apps/ui/src/lib/metagraphed/market.functions.ts`), feeding the header
ticker's `τ $…` and `mkt cap`. Never stored, never historical, never in the
data plane.

One correction to how this has been described, because it changes what
decision 9 is actually deciding: that call is **not** browser-side. It is a
TanStack `createServerFn`, so the fetch executes **server-side in our Cloudflare
Worker**, reached by React Query from three consumers — `registry-ticker.tsx`,
`use-tao-price.ts`, and `-subnets-index-page.tsx`. No user's IP reaches
coinpaprika. What we have is a third-party dependency on our own serving path,
which is a different (and more tractable) problem than client-side leakage.

**A USD rate cannot be derived from chain data.** Nothing on Bittensor
denominates in dollars; that rate exists only where TAO trades against fiat,
off-chain. Unlike every other number this project publishes, it cannot be made
first-party by indexing harder.

The resolution: **aggregating raw market data from multiple venues into our own
computed, documented index makes us the provider** — in exactly the sense that
our alpha price is ours because we compute it from raw chain events rather than
copying someone's figure. Relaying a single upstream's number would not.

## Decision

### 1. Posture

metagraphed **publishes its own aggregated TAO/USD index**, computed from
multiple venues under the method fixed below, and **does not relay any single
provider's price as authoritative**.

The index is our arithmetic over other people's raw trades — which is the same
relationship `src/subnet-ohlc.ts` has to chain events. That is what makes it
first-party. It does not make it authoritative for settlement (decision 8).

### 2. Venue-selection criteria

A venue qualifies only if it satisfies **all** of:

| #   | Criterion                                   | Threshold                                                                                 |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| a   | Pair                                        | `TAO/USD`, `TAO/USDT`, or `TAO/USDC`                                                      |
| b   | Reported 24h volume on that pair            | **≥ $1,000,000 USD equivalent**                                                           |
| c   | Public endpoint for recent trades or ticker | no authentication required for public market data                                         |
| d   | Documented rate limit                       | permits **≥ 1 request/minute sustained** at decision 5's cadence, with headroom for retry |
| e   | Terms of service                            | see the amendment below — this is a recorded risk position, not a gate                    |
| f   | Operating history                           | ≥ 90 days serving the pair                                                                |

**Amended 2026-07-31, after #8599's survey.** Criterion (e) was originally
written as a hard gate — "explicitly permit redistribution of derived data;
silence is not permission." The survey established that no major venue clears
that bar. The terms are not silent, they are prohibitive: Coinbase's Market
Data Terms define "Derived Works" and bar redistributing them absent written
consent; Kraken's Global Terms §8–9 prohibit automated extraction and
commercial exploitation of "Our Content"; KuCoin's Terms bar derivative works
and systematic collection for commercial interests. Applied literally, the
criterion excludes every venue and the index cannot be built at all.

The position taken instead, recorded plainly so it is a decision rather than an
oversight:

- We read **public, unauthenticated** market-data endpoints at a low fixed rate
  (decision 5's 60s), the same access any browser makes.
- We publish an **aggregate index across venues** — a single number derived from
  many sources — and never redistribute any venue's data as such: no venue's
  raw ticker, order book, or trade feed is exposed, and no venue is attributed a
  price in the payload.
- This is the posture a DEX aggregator or an index provider operates under, and
  it is a **known, accepted risk**, not a clean permission. A venue may object
  and ask us to stop; the response is to drop that venue, and decision 4's
  quorum is what makes that survivable rather than fatal.

**An API key is not a fix, and would make this worse.** Registering for one
means affirmatively accepting the very terms that prohibit redistribution —
Coinbase's Market Data Terms attach specifically to accessing its Market Data
API. Holding a key converts "we read a public endpoint" into "we agreed not to
do this and did it anyway," and costs us the same-as-any-browser argument for
nothing in return. Criterion (c) already requires **no authentication**, and
that stays, now for this second reason as well. The actual route to permission
is a commercial redistribution licence — Coinbase calls these "authorized
redistribution partners" — which is a business agreement to pursue if the index
ever warrants it, not a checkbox.

So (e) no longer gates venue selection. #8599 still **records** each venue's
terms verbatim with a retrieval date, because a future reader needs to know
what was accepted and on what basis — and because a venue that moves from
prohibitive to permissive, or the reverse, is a fact worth having.

Venues remain excluded on the criteria that are still gates: reachability,
liquidity, public access, and rate limits.

The concrete venue list is #8599's deliverable. This ADR fixes only the rules it
must satisfy.

### 3. Aggregation method

**Volume-weighted median of qualifying venue prices.**

- **Statistic: median, not mean.** A single venue printing a bad tick moves a
  mean and does not move a median. With a venue count in the low single digits
  (decision 4), robustness matters more than smoothness.
- **Weighting: by each venue's trailing 24h volume on the surveyed pair**, so a
  qualifying-but-thin venue cannot pull the index toward itself. The
  volume-weighted median is the price at which cumulative weight crosses 50%.
- **Outlier rejection:** compute the unweighted median first; exclude any venue
  whose price deviates **more than 2%** from it; recompute the volume-weighted
  median over the survivors. A rejected venue **contributes nothing** to the
  published value and is **named in the payload** (decision 7) — it is not
  silently dropped.
- If rejection takes the survivor count below decision 4's minimum, the index
  publishes no value. Rejection cannot be used to manufacture a quorum.

Stable pairs (`USDT`/`USDC`) are treated as **1.00 USD** with no correction.
This is an assumption the index inherits and must therefore state: see
decision 7's `stable_pair_venues` field. #8599 may recommend excluding stable
pairs entirely; if it does, that recommendation amends this paragraph and
nothing else.

### 4. Minimum-venue policy

**Three healthy venues.** Below three, the index publishes **no value** —
`usd_per_tao: null` with `price_basis: "insufficient_venues"`.

"Publish something anyway" is **explicitly ruled out.** A two-venue median is a
coin flip between two numbers, and a one-venue index is the relay this ADR
exists to reject. A consumer that receives null can fall back, show nothing, or
say "unavailable"; a consumer that receives a confidently-wrong number cannot
do any of those.

### 5. Cadence and staleness

- **Update cadence: 60 seconds.** Fast enough for a header ticker, slow enough
  to sit inside every qualifying venue's rate limit with retry headroom.
- **Staleness threshold: 300 seconds.** A stored value older than five minutes
  is served with `stale: true` and its `observed_at`, never silently as
  current.
- A stale value is still **served**, not withheld — five-minute-old price with
  an honest label is useful, and the consumer decides. This is deliberately
  different from decision 4's null: there we have no defensible number, here we
  have an old one.

### 6. Outage and divergence policy

- **A venue is unreachable:** it is excluded from that computation cycle and
  counted in `venues_excluded`. No retry inside the cycle beyond the HTTP
  client's own; the next cycle is 60 seconds away.
- **Venues disagree beyond the outlier threshold:** decision 3's rejection
  applies. If that leaves fewer than three survivors, decision 4 applies and no
  value publishes.
- **All venues unreachable:** the last stored value is served with `stale: true`
  until it ages out of any consumer's tolerance. We do not extrapolate, and we
  do not carry a value forward with a fresh timestamp — the timestamp is the
  observation time, always.
- **A venue divergence that persists across cycles** is a monitoring concern,
  not a serving one: #8603 owns alerting on it. The serving path's behaviour is
  fully specified by the two rules above.

### 7. Honesty-label vocabulary

Extending the `price_basis` convention `src/price-at-tx.ts` established
(`trade_exact` / `root_no_pool`), the fiat index carries:

```ts
type FiatPriceBasis = "venue_median" | "insufficient_venues";

interface TaoUsdIndex {
  usd_per_tao: number | null; // null iff basis is "insufficient_venues"
  price_basis: FiatPriceBasis;
  observed_at: string; // ISO instant of the OBSERVATION, never of serving
  stale: boolean; // observed_at older than decision 5's threshold
  venue_count: number; // venues that contributed to this value
  venues_excluded: string[]; // named, with no silent drops
  stable_pair_venues: number; // how many contributors priced against USDT/USDC
}
```

`stable_pair_venues` exists because decision 3 treats stables as 1.00 USD. A
consumer that cares about a depeg can see how much of the index rests on that
assumption; one that does not can ignore it. Burying it would make the
assumption invisible, which is the failure mode this whole vocabulary exists to
prevent.

**A consumer must never receive a bare number.** Every surface that serves
`usd_per_tao` serves `price_basis`, `observed_at`, and `stale` alongside it.

### 8. Disclaimer

Fixed wording, not deferred:

> Informational index only. metagraphed's TAO/USD figure is a volume-weighted
> median computed from public market data across multiple venues. It is not a
> settlement price, not a valuation, not investment advice, and not suitable as
> a pricing oracle. Venues, methodology, and observation time are published
> alongside every value.

- **API:** carried in the route description in `src/contracts.ts`, so it reaches
  OpenAPI, the generated client, and the MCP tool description — the last being
  the consumer most likely to restate a number without its caveats.
- **UI:** on the tooltip of any surface displaying the figure, and in full on
  the methodology page (`docs/computed-metrics-methodology.md`, alongside the
  existing composite families).

### 9. The existing coinpaprika call

**Replaced by our index, then removed.** Not kept.

Keeping it would leave the product's most visible number — the header ticker —
sourced from exactly the relay this ADR rejects, while the API served something
better. That inconsistency is the reason #8598 was filed.

Sequencing, so nothing regresses: the call **stays until the index is live and
has met decision 4's minimum for a sustained period**, then all three consumers
(`registry-ticker.tsx`, `use-tao-price.ts`, `-subnets-index-page.tsx`) move to
the index in one change and `market.functions.ts` is deleted. That is #8602's
scope. Until then it remains, and this paragraph is the record that its
retirement is decided rather than forgotten.

## Consequences

- **#8599 has fixed criteria to survey against**, and its include/exclude call
  per venue is mechanical rather than a judgement.
- **#8600 has a fully specified computation** — statistic, weighting, outlier
  rule, quorum, cadence — and needs no further product decision.
- **#8601 has the field list and the null semantics**; the honesty labels are
  decided before the contract is written, not retrofitted.
- **#8602 has an explicit mandate** to delete `market.functions.ts` rather than
  leave two price sources in the product.
- **A quiet failure is now impossible to serve.** Every path either yields a
  value with its provenance or an explicit null with a reason.
- **This chain is authorized to proceed.** #8599 → #8600 → #8601 → #8602, with
  #8603 monitoring, need no further product decisions from this ADR.

## Open questions

- **The exact venue list** is #8599's output. If the survey finds fewer than
  three venues satisfying decision 2, that is a finding that comes back here —
  the criteria would need revisiting rather than the minimum being lowered,
  because lowering it re-opens decision 4 on grounds this ADR already rejected.
- **The DEX/stablecoin path** (#8503 option (d)) is deliberately not decided
  here. #8599 assesses whether a sufficiently liquid on-chain TAO↔stablecoin
  market exists; if one does, it is a candidate venue under decision 2 like any
  other, and its latency/reliability profile is that issue's to report.
- **Historical backfill** — whether the index is stored forward-only from
  first deploy or backfilled from venue trade history — is #8600's to decide,
  since it depends on what history the chosen venues actually expose.

## Links/resources

- `src/price-at-tx.ts` — the `price_basis` convention this extends
- `src/subnet-ohlc.ts` — the "our arithmetic over raw events" precedent
- `apps/ui/src/lib/metagraphed/market.functions.ts` — the call decision 9 retires
- `docs/computed-metrics-methodology.md` — where the published methodology lands
