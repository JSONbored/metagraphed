# Computed Metrics Methodology

Public transparency page for #6758 (sourced from SubnetRadar's own `subnetradar.com/methodology`
pattern: exact storage items, formulas, and self-verify-against-RPC instructions for every
composite score metagraphed publishes). Every formula below is copied from the actual
implementation in `src/*.ts` as of 2026-07-18, not described from memory — each section cites
the exact function and file. Documentation only: no new capture, no new route.

Five composite families are covered: **concentration**, **sentiment**, **market depth**,
**health/uptime reliability**, and **OHLC**. The first four are pure statistics over data
metagraphed already captures on its normal build/refresh cycle; the last (health/uptime) is the
one family that is **not** chain-derived at all — see its own section below.

## Concentration (stake / emission decentralization)

**Source:** the `neurons` tier — a periodic snapshot of every subnet's per-UID metagraph state.
The concentration handler reads exactly four columns per row (`CONCENTRATION_READ_COLUMNS`,
[`src/concentration.ts:14`](../src/concentration.ts)): `stake_tao`, `emission_tao`, `coldkey`,
`validator_permit`. On chain, `stake_tao`/`emission_tao` come from the bittensor SDK's
`get_all_metagraphs_info` call (SubtensorModule per-UID storage), captured by
`scripts/fetch-metagraph-native.py`.

`computeConcentration(values)` ([`src/concentration.ts:165`](../src/concentration.ts)) takes one
positive-valued distribution (e.g. every UID's `stake_tao` on a subnet) and returns:

| Metric                           | Formula                                                                    | Range / meaning                                                          |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `gini`                           | `(2·Σ i·x₍ᵢ₎) / (n·Σx) − (n+1)/n`, values ascending, `i = 1..n`            | `0` = perfectly equal, `→1` = one holder owns everything                 |
| `hhi`                            | `Σ shareᵢ²`                                                                | `[1/n, 1]`; `1` = a single holder owns everything                        |
| `hhi_normalized`                 | `(hhi − 1/n) / (1 − 1/n)`, or `1` when `n = 1`                             | `[0, 1]`, independent of holder count                                    |
| `nakamoto_coefficient`           | fewest top holders whose cumulative share strictly exceeds 50%             | the smallest set that could collude to control the subnet                |
| `top_{1,5,10,20}pct_share`       | cumulative share held by the top `⌈n·p/100⌉` holders                       | one prefix-sum pass over holders sorted descending                       |
| `entropy` / `entropy_normalized` | Shannon entropy in bits, `−Σ shareᵢ·log2(shareᵢ)`, normalized by `log2(n)` | `entropy_normalized`: `1` = perfectly uniform, `→0` = fully concentrated |

`buildConcentration` ([`src/concentration.ts:229`](../src/concentration.ts)) runs this three
times per subnet, over three different lenses on the same snapshot: `stake`/`emission` (per UID),
`entity_stake`/`entity_emission` (rows collapsed by `coldkey` first — an operator running many
hotkeys counts as one holder, the _true_ control distribution), and `validator_stake`
(validator-permit UIDs only). Every sum runs in rao-integer (`BigInt`) space, not floating point,
so thousands of holders summing to a subnet total never accumulate rounding drift.

## Sentiment (buy/sell lean)

**Source:** `account_events` rows for `event_kind IN ('StakeAdded', 'StakeRemoved')` in a rolling
24-hour window ([`src/alpha-volume.ts`](../src/alpha-volume.ts)). On chain, both event kinds are
`SubtensorModule.StakeAdded` / `SubtensorModule.StakeRemoved`, decoded as a positional tuple
`[coldkey, hotkey, amount_tao, alpha_amount, netuid]`
([`src/chain-event-args.ts:128-137`](../src/chain-event-args.ts), confirmed live against a
direct chain-events sample). `StakeAdded` is a buy (TAO spent, alpha received); `StakeRemoved` is
a sell (alpha spent, TAO received).

For a subnet's 24h window: `netAlpha = buyAlpha − sellAlpha`, `grossAlpha = buyAlpha + sellAlpha`.

- `sentiment_ratio = netAlpha / grossAlpha`, rounded to 4dp, `null` when `grossAlpha` is `0` (no
  volume in the window — an undefined ratio, not a zero one). Clamped so a sub-perfect ratio never
  displays as an exact `±1`
  ([`sentimentRatio`, `src/alpha-volume.ts:62`](../src/alpha-volume.ts)).
- `sentiment` is the coarse label from the same ratio: `"bullish"` at or above `+0.2`, `"bearish"`
  at or below `−0.2`, `"neutral"` in between **or** when `grossAlpha` is `0`
  ([`classifySentiment`, `src/alpha-volume.ts:77`](../src/alpha-volume.ts)).

The network-wide sentiment reading (the mood gauge on `/subnets`) sums buy/sell alpha across every
subnet first, then applies the exact same `sentimentRatio`/`classifySentiment` functions to the
network totals — one formula, two scopes ([`src/chain-alpha-volume.ts:183`](../src/chain-alpha-volume.ts)).

## Market depth (24h volume / market-cap turnover)

**Source:** the same `account_events` `StakeAdded`/`StakeRemoved` rows as sentiment, above — the
two metrics are derived from one query.

- `total_volume_tao = buy_volume_tao + sell_volume_tao` (unsigned; both sides always add, never
  net against each other, unlike `net_volume_alpha`).
- `vol_mcap_ratio = total_volume_tao / alpha_market_cap_tao`
  ([`volMcapRatio`, `src/alpha-volume.ts:94`](../src/alpha-volume.ts)), `null` when the market
  cap input is missing or non-positive. Unbounded — a genuinely high-turnover day can exceed `1`.
- `alpha_market_cap_tao = alpha_price_tao × total_stake_alpha`
  ([`computeAlphaMarketCapTao`, `scripts/lib/economics-artifacts.ts:58`](../scripts/lib/economics-artifacts.ts)),
  where `alpha_price_tao` is read directly from the chain's `moving_price` field on each subnet's
  info (the `SubnetMovingPrice` storage item — `scripts/fetch-native-subnets.py:80`) and
  `total_stake_alpha` stands in as the circulating-alpha proxy until a dedicated supply field exists.

## Health / uptime reliability

This is the one family **not** derived from chain storage or chain events at all — it scores
metagraphed's own HTTP/WSS probe history against each subnet's registered surfaces
(`surface_uptime_daily`), not on-chain state. Included here because it is still a published
composite score readers may want to reproduce, just from a different kind of raw input (a probe
log, not an RPC call).

Every probe result is classified first (`classifyProbe`/`classifyRpcProbe`,
[`src/health-probe-core.ts:268`](../src/health-probe-core.ts)) into a fine-grained reason
(`live`, `redirected`, `timeout`, `rate-limited`, `dead`, `wrong-chain`, …), then rolled up to one
of four statuses (`statusForClassification`,
[`src/health-probe-core.ts:407`](../src/health-probe-core.ts)): `ok` (live/redirected),
`degraded` (rate-limited/auth-required/transient/timeout, or a registry-observed/community surface
that's merely unsupported/dead/content-mismatched), or `failed` (everything else, including any
wrong-chain answer regardless of authority).

The reliability score itself is documented directly in its own source header
([`src/reliability.ts:1-13`](../src/reliability.ts)):

```
uptimeScore    = uptime_ratio * 100                     (sample-weighted, exact)
latencyPenalty = clamp((avg_latency_ms - 500) / 100, 0, 15)
                  -> 0 at/under 500ms, +1 point per extra 100ms, capped at 15
score          = round(max(0, uptimeScore - latencyPenalty))
```

`uptime_ratio = ok_count / samples` over the requested window. Grades: `A` at `score >= 99`, `B`
at `>= 95`, `C` at `>= 90`, `D` at `>= 75`, else `F`. A sub-perfect uptime ratio is clamped so it
can never round up to a flawless `score: 100`/grade `A`
([`scoreFromStats`, `src/reliability.ts:42`](../src/reliability.ts)). `null` (not a fabricated
`0`) whenever there is no probe data for the window — this score is only ever computed from real
history.

## OHLC (subnet alpha price candles)

**Source:** the same `SubtensorModule.StakeAdded`/`StakeRemoved` account_events rows as sentiment
and market depth, but read tick-level (unaggregated) rather than summed —
[`src/subnet-ohlc.ts`](../src/subnet-ohlc.ts). Each row is one executed trade:
`price = amount_tao / alpha_amount` for that single trade (this is genuine trade-level data, not a
derived moving average).

Trades are sorted by `observed_at` ascending, then bucketed into fixed-width time windows (`1h` or
`1d`, `Math.floor(observed_at / intervalMs) * intervalMs`). Per bucket: `open` = first trade's
price, `close` = last trade's price, `high`/`low` = max/min trade price in the bucket,
`volume_alpha`/`volume_tao` = summed trade amounts, `event_count` = trade count. A bucket with no
trades never appears in the output (a genuine gap, not a synthesized flat candle — honest given
how sparse an illiquid subnet's trading can be). Root (netuid 0) is excluded entirely: it has no
AMM pool, so staking there is always 1:1 TAO↔TAO with no price to chart.

## Emission share (and what it is not)

**Source:** `emission_share = alpha_price / Σ alpha_price` across subnets —
[`scripts/lib/economics-artifacts.ts`](../scripts/lib/economics-artifacts.ts). It is a **price
share**, and it is the default sort on `/api/v1/economics`.

Before runtime spec 440 that was a reasonable proxy for a subnet's share of TAO emission. Since
440 went live on finney (2026-07-27) it is **stage 1 of an eight-stage pipeline**, and the gap
between it and the TAO a subnet actually receives is large enough that reading one as the other
is simply wrong.

| #   | stage                  | what it does                                                                              |
| --- | ---------------------- | ----------------------------------------------------------------------------------------- |
| 0   | eligibility            | non-root, `FirstEmissionBlockNumber` set, `SubtokenEnabled`, `NetworkRegistrationAllowed` |
| 1   | **`emission_share`**   | price-EMA share — `SubnetMovingPrice_i / Σ SubnetMovingPrice`                             |
| 2   | miner-burn reweighting | `× (1 − MinerBurned_i)`, renormalized — non-zero on 68 subnets                            |
| 3   | gate bar               | `θ` recomputed by the runtime every `block % 360 == 0`                                    |
| 4   | Hill gate              | `w · 1/(1+(θ/w)^h)`, renormalized to sum 1                                                |
| 5   | enabled filter         | `SubnetEmissionEnabled == false` → zeroed, share redistributed (47 subnets)               |
| 6   | TAO emission           | `block_emission × final_share`                                                            |
| 7   | alpha injection cap    | the remainder becomes `excess_tao` → chain buys                                           |
| 8   | balancer               | splits materialized TAO into the price-active part written to `SubnetTaoInEmission`       |

Two consequences worth stating plainly, because both are counter-intuitive:

- **The gate redistributes; it does not withhold.** Stage 4 renormalizes to sum 1, so 100% of
  block emission reaches subnets. What changes is _which_ subnets get it.
- **Block emission is 0.5 TAO/block, not 1.0.** The `BlockEmission` storage item reads 1.0 and is
  stale — the live value is recomputed from `TotalIssuance` every block, and the network is past
  its first halving. Anything deriving percentages from that storage item is off by 2×.

`total_emission_share` (per domain) and `mean_emission_share` (on `/economics/trends`) are
aggregates of this same stage-1 value and inherit the caveat exactly.

### Verify the gate parameters yourself

Each is a `StorageValue` under `twox128("SubtensorModule")` =
`658faa385070e074c85bf6b568cf0555`, concatenated with the item hash — no further hashing:

```sh
# EmissionBarQuantile (q) — U64F64, SIXTEEN bytes, not eight
curl -s -X POST https://api.metagraph.sh/rpc/v1/finney \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":
       ["0x658faa385070e074c85bf6b568cf0555a772007dde2ed63e0f21b5f9d7f16650"]}'
# -> "0x00000000000000c00000000000000000"
```

Decode a U64F64: read the 16 bytes little-endian into a u128, then divide by `2^64`. The value
above is `0.75`. `EmissionGateBar` (θ) is
`7c9b0d2964cc73e7519676c3cc4d5df9`; `EmissionGateExponent` (h) is
`88c70e8dd0cf4af3aeb977ba2eee1df4` and currently reads `null` — **unset means the runtime
default `h = 3`, not zero** (`h = 0` would make the gate `0.5` for every subnet).

All three, plus the issuance-derived block emission and its halving count, are served decoded on
[`/api/v1/network/parameters`](https://api.metagraph.sh/api/v1/network/parameters).

## Verify it yourself

Two worked examples, reproducing a published number from a raw chain read — the actual
trust-building mechanism a methodology page exists to provide, not just formula prose.

### Concentration

1. Fetch one subnet's live metagraph with the bittensor SDK:

   ```python
   import bittensor as bt
   s = bt.SubtensorApi(network="finney")
   infos = s.metagraphs.get_all_metagraphs_info(all_mechanisms=True)
   info = next(i for i in infos if int(i.netuid) == 7 and int(getattr(i, "mechid", 0) or 0) == 0)
   stakes = [s.rao / 1e9 for s in info.alpha_stake if s.rao > 0]  # positive holders only
   ```

2. Reproduce `gini` exactly:

   ```python
   xs = sorted(stakes)
   n, total = len(xs), sum(xs)
   g = (2 * sum((i + 1) * x for i, x in enumerate(xs))) / (n * total) - (n + 1) / n
   gini = max(0.0, g)
   ```

   This must match the `gini` field `GET /api/v1/subnets/7/concentration` returns for the same
   snapshot (small drift is expected if the two reads land on different blocks — stake shifts
   continuously).

### Sentiment

1. Query the last 24h of `SubtensorModule.StakeAdded`/`StakeRemoved` events for one subnet (via an
   indexer, or by scanning recent blocks' events directly against an archive node) and decode each
   event's positional args as `[coldkey, hotkey, amount_tao, alpha_amount, netuid]`, filtering to
   the target `netuid`.
2. Sum `alpha_amount` separately for each kind:

   ```python
   buy_alpha = sum(e.args[3] for e in events if e.name == "StakeAdded")
   sell_alpha = sum(e.args[3] for e in events if e.name == "StakeRemoved")
   net_alpha, gross_alpha = buy_alpha - sell_alpha, buy_alpha + sell_alpha
   sentiment_ratio = round(net_alpha / gross_alpha, 4) if gross_alpha > 0 else None
   ```

3. This must match the `sentiment_ratio` field `GET /api/v1/subnets/7/volume` returns for
   the same 24h window (again subject to normal window-boundary drift between two independent
   reads).
