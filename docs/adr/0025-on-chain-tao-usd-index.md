# ADR 0025 — On-chain TAO/USD index: composed through ETH, read from chain state

- **Status:** Proposed
- **Supersedes:** [ADR 0024](0024-first-party-tao-usd-index.md) — same goal, different basis.
- **Date:** 2026-07-31
- **Relates to:** #8598 / #8599 (the survey whose findings forced this),
  #8600–#8602 (the implementation chain), #8603 (monitoring),
  `src/price-at-tx.ts` (the `price_basis` convention this extends).

## Context

ADR 0024 decided to aggregate centralised-exchange tickers. #8599's survey then
established two facts that make that basis untenable, and one that makes a
better basis available.

**Every surveyed venue explicitly prohibits this use.** Not silence —
prohibition. Coinbase's Market Data Terms define "Derived Works" and bar
redistributing them absent written consent. Kraken's Global Terms §8–9 prohibit
automated extraction and commercial exploitation of "Our Content". KuCoin bars
derivative works and systematic collection for commercial interests. An API key
makes this worse rather than better: registering means affirmatively accepting
those terms.

**Two of the largest venues are unreachable anyway.** Binance and Bybit
geo-block US-hosted callers, and both our indexer box and a US Cloudflare edge
are US-hosted.

**Chain state has no terms of service.** Reading a public blockchain is
permissionless in a way no exchange API is, and it is first-party in exactly
the sense this project means everywhere else: our arithmetic over raw chain
data, verifiable by anyone who repeats the read.

## Decision

### 1. Basis: on-chain, composed through ETH

```
TAO/USD  =  (wTAO per WETH, from the deepest wTAO/WETH pool)
         ×  (WETH per USDC, from Uniswap v3 WETH/USDC)
```

**Why composed rather than direct.** The obvious route is a wTAO/USDC pool. It
is also the wrong one, measured 2026-07-31:

| path                                |        24h volume |
| ----------------------------------- | ----------------: |
| wTAO/USDC pools, all three combined |          \$81,000 |
| wTAO/WETH (deepest single pool)     |         \$361,684 |
| WETH/USDC (Uniswap v3 0.05%)        | **\$117,847,395** |

The ETH leg is **~1,455×** deeper than the entire USD-direct path. Composing
adds a second hop, and each hop is far better priced than the single hop it
replaces. The thin USDC pools also demonstrably misprice: the \$55k pool quoted
197.17 against a 195.5 consensus, +0.85%.

Verified end to end at the same instant: recomposition returns **195.68**
against a CEX range of 195.18–195.51 and a deep-USDC-pool print of 195.49.

### 2. Pool-selection criteria

Replaces ADR 0024's venue criteria entirely.

| #   | Criterion                 | Threshold                                           |
| --- | ------------------------- | --------------------------------------------------- |
| a   | Chain                     | Ethereum mainnet (where wTAO liquidity actually is) |
| b   | Pool liquidity            | **≥ \$250,000 TVL**                                 |
| c   | Pool 24h volume           | **≥ \$50,000**                                      |
| d   | Readable from chain state | reserves / `slot0`, no venue API                    |
| e   | Terms of service          | **not applicable — this is the point**              |

At the surveyed date this admits the wTAO/WETH pools at \$2.1M and \$297k, and
excludes the \$55k and \$296 dust pools that were mispricing.

### 3. Aggregation

**Liquidity-weighted median across qualifying wTAO/WETH pools**, then multiplied
by the ETH/USDC leg.

Weighting by **liquidity, not volume** — carried over from #8599's finding that
reported volume and real depth diverge badly, and reinforced here because pool
TVL is a directly observable on-chain quantity rather than a self-reported one.

Outlier rejection as ADR 0024 fixed it: reject a pool more than **2%** from the
unweighted median, name it in the payload, and never let rejection manufacture
a quorum.

### 4. Minimum-pool policy

**Two qualifying wTAO/WETH pools plus a healthy ETH leg.** Below that, publish
no value — `usd_per_tao: null`, `price_basis: "insufficient_pools"`.

Two rather than ADR 0024's three, because the population is different: there are
only two pools above the liquidity floor today, and the ETH leg is a single pool
so deep that its failure mode is "Ethereum is down", not "a venue is thin".

### 5. Cadence and staleness

Unchanged from ADR 0024: **60-second** cadence, **300-second** staleness
threshold, stale values still served with `stale: true` rather than withheld.

One addition: reads are taken **at a block height**, and that height is
published. A chain read is reproducible in a way an exchange ticker is not — a
reader can re-execute it against the same block and get the same number, which
is the strongest form of the honesty this project aims at.

### 6. wTAO is not TAO, and the index says so

The unavoidable cost of this basis. wTAO is a bridge-minted ERC-20 holding 1:1
parity by construction, not by arbitrage guarantee. A bridge incident would have
these pools confidently pricing a **different asset**.

Three mitigations, all required:

- `price_basis` is `wrapped_onchain_median` — never a bare "market price". A
  consumer is told the asset it was derived from.
- **Peg divergence is monitored** (#8603): a persistent gap between the
  wTAO-derived index and any independent reference is a bridge signal, and
  crossing a threshold marks the index `stale` rather than continuing to serve
  it as current.
- The disclaimer (decision 8) names the wrapping explicitly.

### 7. Honesty-label vocabulary

Extends `src/price-at-tx.ts`'s `price_basis` convention:

```ts
type FiatPriceBasis = "wrapped_onchain_median" | "insufficient_pools";

interface TaoUsdIndex {
  usd_per_tao: number | null; // null iff basis is "insufficient_pools"
  price_basis: FiatPriceBasis;
  block_number: number; // the height the read was taken at — reproducible
  observed_at: string; // ISO instant of observation, never of serving
  stale: boolean;
  pool_count: number; // qualifying pools that contributed
  pools_excluded: string[]; // pool addresses, named, never silently dropped
  eth_usd: number; // the anchor leg, published so the composition is checkable
}
```

`eth_usd` is published deliberately: the index is a product of two readings, and
a consumer that cannot see both cannot check either.

### 8. Disclaimer

> Informational index only. metagraphed's TAO/USD figure is computed from
> on-chain Uniswap pool state — wrapped TAO against ETH, composed with ETH
> against USDC — at a published block height. It prices **wrapped TAO**, not
> native TAO, and is not a settlement price, not a valuation, not investment
> advice, and not suitable as a pricing oracle.

Carried in the route description in `src/contracts.ts` (so it reaches OpenAPI,
the generated client, and the MCP tool description) and on any UI surface
displaying the figure.

### 9. The existing coinpaprika call

Unchanged from ADR 0024: **replaced by this index, then removed**, once the
index is live and has met decision 4's minimum for a sustained period. All three
consumers move in one change and `market.functions.ts` is deleted (#8602).

## Consequences

- **No terms-of-service exposure.** The index rests on public chain state, which
  nobody licenses.
- **No API keys, no rate-limit negotiation, no geo-blocks.** An Ethereum RPC is
  transport, not a data licence, and is replaceable — including by our own node.
- **Reproducible by a third party**, at a stated block height. This is stronger
  than anything the CEX basis could have offered.
- **We inherit bridge risk**, which the CEX basis did not have. Decision 6 is
  what keeps that honest rather than hidden.
- **Thinner than the CEX aggregate.** \$362k/day on the TAO leg against Kraken's
  \$308k book alone. The composition is what makes this acceptable; without the
  ETH leg it would not be.
- **#8599's venue survey is superseded as a venue list** but retained as the
  record of why the CEX basis was rejected.

## Open questions

- **An Ethereum RPC must be chosen** — public endpoint, provider, or our own
  node. It is transport rather than a data source, so it does not reopen the
  licensing question, but availability and rate limits are #8600's to settle.
- **Solana wTAO** (Wormhole Sunrise, May 2026) is a second venue for the TAO leg
  if its pools clear decision 2. Not included today: unmeasured, and younger
  than a 90-day history.
- **Historical backfill** — pool state is readable at any historical block, so
  unlike the CEX basis this index _can_ be backfilled. Whether it should be is
  #8600's call.

## Links/resources

- [`docs/tao-usd-venue-survey.md`](../tao-usd-venue-survey.md) — the measurements
- Uniswap v3 WETH/USDC 0.05%: `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`
- wTAO/WETH (deepest): `0x433a00819C771b33FA7223a5B3499b24FBCd1bBC`
