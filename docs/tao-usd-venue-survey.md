# TAO/USD venue survey (#8599)

Measured **2026-07-31**. Scored against the criteria fixed in
[ADR 0024](adr/0024-first-party-tao-usd-index.md).

Every number below was read directly from the venue's own public endpoint or
its pool contract, at the stated date — not taken from an aggregator's summary,
except the 24h volume column, which is sourced where marked.

> **This survey is NOT complete, and the venue list below is NOT final.** The
> ToS review that ADR 0024 makes a gate (criterion e) is outstanding — see
> [What is still missing](#what-is-still-missing). Everything that can be
> measured has been; the part that requires reading legal terms has not.

## Headline findings

Three things here were not obvious before measuring, and two of them change
decisions.

1. **Two of the largest venues are unreachable from our infrastructure.**
   Binance (reported #2 by volume) returns
   `Service unavailable from a restricted location according to 'b. Eligibility'`
   and Bybit returns `The Amazon CloudFront distribution is configured to block
access from your country`. This is not a rate limit or an outage — the API
   is geo-blocked for US-hosted callers, and both our indexer box (LAX) and a
   US Cloudflare edge are US-hosted. They cannot be venues for us regardless of
   their terms.
2. **Reported volume and actual depth diverge sharply, in the wrong
   direction.** KuCoin reports **17×** Kraken's 24h volume and has **⅓** of its
   book depth within ±1% of mid. ADR 0024 decision 3 weights by volume; on this
   data that would hand the most influence to the thinnest book. See
   [Recommended amendment](#recommended-amendment-to-adr-0024).
3. **The DEX path fails on volume, not liquidity.** wTAO/USDC on Uniswap holds
   \$934,562 of liquidity but traded only **\$57,209** in 24h — under ADR 0024's
   \$1,000,000 floor by roughly 17×.

## Venue measurements

24h volume from CoinGecko's TAO tickers endpoint, 2026-07-31. Depth measured by
summing resting size within ±1% of mid from each venue's own order-book
endpoint, same date. Reachability tested unauthenticated from a US host.

| Venue                 | Pair      |      24h volume |     Depth ±1% (bid / ask) | Public API, no auth |  Reachable from US   |
| --------------------- | --------- | --------------: | ------------------------: | :-----------------: | :------------------: |
| **Kraken**            | TAO/USD   |     \$1,727,338 | **\$308,607 / \$294,425** |         yes         |         yes          |
| **Coinbase Exchange** | TAO/USD   |     \$3,623,792 |     \$179,856 / \$181,402 |         yes         |         yes          |
| **Gate**              | TAO/USDT  |     \$2,231,260 |      \$125,038 / \$95,775 |         yes         |         yes          |
| **KuCoin**            | TAO/USDT  |    \$29,522,313 |      \$112,594 / \$90,717 |         yes         |         yes          |
| **OKX**               | TAO/USDT  | _not in top 15_ |       \$68,626 / \$30,327 |         yes         |         yes          |
| Binance               | TAO/USDT  |    \$11,254,153 |                         — |          —          | **NO — geo-blocked** |
| Bybit                 | TAOUSDT   | _not in top 15_ |                         — |          —          | **NO — geo-blocked** |
| Uniswap (Ethereum)    | wTAO/USDC |    **\$57,209** |             \$934,562 TVL |         yes         |         yes          |

Prices at the moment of measurement, which is itself a result:

| Venue             |  Price | Quote |
| ----------------- | -----: | ----- |
| Kraken            | 195.18 | USD   |
| Coinbase          | 195.21 | USD   |
| OKX               | 195.40 | USDT  |
| Gate              | 195.48 | USDT  |
| KuCoin            | 195.51 | USDT  |
| Uniswap wTAO/USDC | 195.49 | USDC  |

**Total spread: 0.17%** — an order of magnitude inside ADR 0024's 2% outlier
threshold. On this sample the rejection rule would reject nothing, which is the
correct behaviour for a healthy market and confirms the threshold is not so
tight that it fires on normal venue dispersion.

## Include / exclude, with the reason

Reasons are kept distinct because they are not equally permanent — a venue
excluded for thin depth may qualify later; one that is geo-blocked will not
unless our hosting changes.

| Venue             | Call                      | Reason                                                                                                                                                             |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kraken            | **Include** (pending ToS) | Deepest book measured, native TAO/USD, no auth. Best single venue on every axis except reported volume.                                                            |
| Coinbase Exchange | **Include** (pending ToS) | Second-deepest, native TAO/USD, no auth.                                                                                                                           |
| Gate              | **Include** (pending ToS) | Third-deepest, clears the volume floor comfortably.                                                                                                                |
| KuCoin            | **Include** (pending ToS) | Clears volume by a wide margin; depth is adequate though far below what its volume implies.                                                                        |
| OKX               | **Exclude**               | Thinnest book by a factor of three on the ask side (\$30,327). Include only if the ToS review disqualifies one of the four above and a fifth is needed for quorum. |
| Binance           | **Exclude — structural**  | API geo-blocked from US hosts. Not a terms question; we cannot read it.                                                                                            |
| Bybit             | **Exclude — structural**  | Same.                                                                                                                                                              |
| Uniswap wTAO/USDC | **Exclude as a venue**    | \$57,209 24h volume against a \$1,000,000 floor, and it prices a _wrapped_ asset (see below). Viable as a cross-check.                                             |

## The DEX / stablecoin path

ADR 0024 lists this as an open question from #8503 option (d). The verdict is
**not viable as a venue, viable as a cross-check.**

- **Volume, not liquidity, is the disqualifier.** \$934,562 of TVL sounds
  adequate; \$57,209 of daily volume is not. A pool can hold deep liquidity and
  still be priced by a handful of trades, which is precisely the "thin market"
  failure ADR 0024's floor exists to exclude.
- **It prices wTAO, not TAO.** wTAO is a bridge-minted ERC-20 maintaining 1:1
  parity by construction, not by arbitrage guarantee. A bridge incident would
  make this pool price a _different asset_ while still returning a confident
  number. For an index **of TAO**, that is a correctness problem rather than a
  liquidity one, and it would not be fixed by the pool getting busier.
- **It tracks closely today** — \$195.49 against a CEX range of
  \$195.18–\$195.51. That is what makes it a good cross-check: a persistent
  divergence between wTAO and the CEX median is a meaningful signal about the
  bridge, and #8603 could watch it without the index ever depending on it.

TAO also went live on Solana via Wormhole's Sunrise bridge in May 2026
(Jupiter, Meteora). Same wrapped-asset objection applies, and the venue is
younger than ADR 0024's 90-day operating-history criterion at the surveyed
date.

## USDT as USD

**Position: treat USDT and USDC as 1.00 USD, and publish how much of the index
rests on that.**

The measurement supports it, and also shows the assumption is not free:

- The two native-USD venues (Kraken \$195.18, Coinbase \$195.21) priced
  **below** all three stable-quoted venues (\$195.40–\$195.51).
- That is a **~0.15% spread**, consistently in one direction. It is small, but
  it is not noise — it is the stable premium showing up exactly where theory
  says it should.

Excluding stable pairs entirely would leave **two** venues, below ADR 0024's
three-venue quorum, so the index would publish nothing. That is a worse outcome
than a documented 0.15% assumption.

Applying a correction is rejected: it would mean sourcing a USDT/USD rate, and
that is a second index with its own venue problem — an unbounded regress to fix
a 15-basis-point effect.

So: no correction, and ADR 0024's `stable_pair_venues` field is what keeps it
honest. On the recommended list, **2 of 4** contributors are stable-quoted, and
a consumer who cares about a depeg can see that.

## Minimum viable venue set

ADR 0024 requires three healthy venues to publish anything.

- **Recommended set (4):** Kraken, Coinbase, Gate, KuCoin — two native-USD, two
  stable-quoted.
- **Minimum viable subset (3):** Kraken, Coinbase, Gate. Losing any one of the
  four still leaves three, so the index survives a single-venue outage with no
  degradation.
- **Losing two** drops to the quorum floor exactly; losing three publishes
  nothing, which is the designed behaviour, not a failure.
- OKX is the designated fifth if the ToS review disqualifies one of the four.

## Recommended amendment to ADR 0024

**Decision 3 weights by 24h volume. This data argues for depth instead.**

| Venue    | Reported 24h volume | Depth ±1% (bid) | Volume ÷ depth |
| -------- | ------------------: | --------------: | -------------: |
| KuCoin   |        \$29,522,313 |       \$112,594 |           262× |
| Coinbase |         \$3,623,792 |       \$179,856 |            20× |
| Gate     |         \$2,231,260 |       \$125,038 |            18× |
| Kraken   |         \$1,727,338 |       \$308,607 |         **6×** |

Under volume weighting, KuCoin would carry roughly **17× Kraken's influence**
while resting **⅓** of Kraken's size near mid. Depth at ±1% is the quantity
that actually determines whether a printed price can be moved; reported 24h
volume is self-reported, unaudited, and inflated by wash trading on some
venues in a way depth is not.

**Recommendation:** amend decision 3 to weight by measured order-book depth
within ±1% of mid, sampled on the same cadence as the price. ADR 0024 already
anticipates this survey amending that paragraph. The median statistic, the 2%
outlier rule, and the quorum are unaffected.

## What is still missing

**The ToS review — criterion (e) — is not done, and it is a gate.** ADR 0024 is
explicit that silence is not permission: a venue whose terms do not address
redistribution of derived data is excluded until clarified. That means the four
"Include (pending ToS)" calls above are provisional, and a venue list cannot be
finalised on measurement alone.

For each of Kraken, Coinbase, Gate, and KuCoin, someone needs to read the
current API terms and record: whether redistribution of _derived_ data is
addressed at all, the exact clause if so, and the retrieved-on date. If fewer
than three survive, that finding goes back to ADR 0024 — the criteria would
need revisiting rather than the quorum being lowered, on grounds that ADR
already rejected.

Documented rate limits per venue are also unrecorded here. All five reachable
venues answered unauthenticated at survey time, which establishes access but
not the sustainable rate at ADR 0024's 60-second cadence.

## Reproducing this

Every measurement above is a public unauthenticated call. Depth:

```sh
curl -s "https://api.kraken.com/0/public/Depth?pair=TAOUSD&count=500"
curl -s "https://api.exchange.coinbase.com/products/TAO-USD/book?level=2"
curl -s "https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=TAO-USDT"
curl -s "https://api.gateio.ws/api/v4/spot/order_book?currency_pair=TAO_USDT&limit=100"
curl -s "https://www.okx.com/api/v5/market/books?instId=TAO-USDT&sz=400"
```

Sum resting size within ±1% of mid on each side. The geo-block is reproducible
by calling `https://api.binance.com/api/v3/ticker/24hr?symbol=TAOUSDT` from a
US host.
