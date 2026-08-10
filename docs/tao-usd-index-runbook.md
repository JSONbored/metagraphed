# TAO/USD index — operations runbook

What to do when the TAO/USD index misbehaves, and the one policy decision that
has to exist _before_ it does.

Companion documents: [`docs/adr/0025-on-chain-tao-usd-index.md`](adr/0025-on-chain-tao-usd-index.md) fixes the
thresholds and the minimum-pool policy; [`docs/tao-usd-venue-survey.md`](tao-usd-venue-survey.md)
records why these pools and no others. The watchdog that raises everything below
is `src/tao-usd-index-watchdog.ts`, with `tao_usd_index`'s staleness bound
declared separately in `src/table-freshness-watchdog.ts`.

---

## Why this index gets its own runbook

Every other number this API serves is chain-derived and self-evidently
reproducible: a wrong one is a bug, and it looks like one. A wrong **price** is
_our_ wrong price, and it can be wrong while looking perfectly healthy — a pool
quietly returning stale reserves produces a plausible number with no error
anywhere.

It is also load-bearing. Since #10381/#10382/#10383, every alpha figure the API
publishes in dollars is this index multiplied by a chain-measured alpha price.
A bad reading is not one card; it is the dollar axis of the whole surface.

---

## The standing risk: there has never been a spare pool

**Measured over the index's entire life (11,772 ticks from 2026-08-02):
`pool_count` was exactly 2 on every single tick. Minimum 2, maximum 2.**

`MIN_QUALIFYING_POOLS` is 2. So the redundancy margin is **zero**: one pool
dropping out takes the index straight to `insufficient_pools`, and every USD
figure on the API becomes unavailable at once.

This is a property of the on-chain wTAO liquidity, not an incident, which is why
the watchdog **reports** it on every verdict (`noRedundancy: true`) rather than
alerting on it every minute — a permanent alarm is one nobody reads. It is
recorded here because it changes how urgently a single-pool alert should be
treated: **one pool failing is not a partial degradation, it is the whole index
one step from down.**

### The corollary that is easy to get wrong

With exactly two pools, outlier rejection **cannot reject an outlier — it
collapses the index.**

`computeTaoUsdIndex` locates outliers against the _unweighted_ median, and the
median of two values is their midpoint, so both pools are always equidistant
from it by exactly half their spread. When that half-spread crosses
`OUTLIER_THRESHOLD` (2%), **both** pools are rejected in the same pass,
survivors fall to zero, and ADR 0025 forbids falling back to the pre-rejection
set. A spread wider than ~4% therefore stops publication rather than discarding
the bad reading.

This is why the watchdog warns on **deviation** at half the rejection threshold
(1%) instead of waiting for `insufficient_pools`: by the time the basis
degrades, the index is already down. Observed maximum half-spread to date is
**0.431%**, so the warning sits at roughly 2.3× the worst thing that has ever
happened and half the distance to a total stop.

---

## Scenario 1 — one pool down

**Alert:** `tao_usd_index pool 0x… last contributed N minutes ago (last reason: …)`
or `… contributed to no tick in the window`. Verdict: `fail`.

1. Read the `reason` in the alert. It is one of the `ExclusionReason` values
   from `src/tao-usd-index.ts`:
   - `unusable_reading` — the pool answered, but the price or balance was
     unusable (zero, negative, non-finite). Suspect the RPC or a pool that has
     been drained.
   - `below_tvl_floor` — the pool is still there but no longer deep enough to
     qualify. This is a liquidity event, not a fault.
   - `outlier` — it read fine and disagreed. Go to scenario 3.
   - `below_quorum` — it was fine but there were not enough others; the cause is
     elsewhere.
2. Confirm the index is still publishing: if `degradedTicks` is 0, the remaining
   pool(s) are carrying it and there is no user-visible impact **yet**. Given the
   standing risk above, treat this as one failure away from an outage.
3. Check whether the pool still exists on-chain and holds liquidity. If it has
   been drained or migrated, this is a **venue-set change**, not an incident:
   update the pool set per `docs/tao-usd-venue-survey.md` and record why.
4. If the pool is healthy on-chain but we cannot read it, the fault is ours —
   RPC endpoint health, not the venue.

**Do not** lower `MIN_QUALIFYING_POOLS` to keep the index publishing. Publishing
a one-pool median is not a median, and the floor exists precisely so that we
decline instead.

## Scenario 2 — several pools down / below the floor

**Alert:** `tao_usd_index published no price on N of M ticks in the last hour
(price_basis: insufficient_pools)`. Verdict: `fail`.

The index is publishing `usd_per_tao: null` with
`price_basis: "insufficient_pools"`. This is a **stated outcome**, not a
crash — the contract carries it, and `src/alpha-usd.ts` refuses to multiply by
it, so downstream surfaces render USD as unavailable rather than as zero. That
behaviour is correct and needs no intervention; the _cause_ does.

1. Establish whether the pools are down or our reading of them is. If every pool
   failed simultaneously, suspect the shared dependency (RPC / anchor), not the
   venues — a genuine simultaneous liquidity event across independent pools is
   far less likely than one endpoint failing.
2. Check the anchor separately. `anchor_unavailable` means the ETH/USDC leg
   failed, and no amount of healthy wTAO pools will produce a price without it.
3. While degraded: **nothing to fix downstream.** Every USD figure is absent and
   labelled with a reason. Do not hand-set a price anywhere to fill the gap —
   see the policy below.

## Scenario 3 — a pool returning plausible-but-wrong data

**Alert:** `tao_usd_index pool deviation reached X% (warn 1.00%, rejection 2.00%)`.
Verdict: `warn`.

This is the one the whole module exists for, because nothing is broken and the
output looks fine.

1. A single tick above the warn line is not action. Sustained divergence is: it
   means either that pool is broken or our reading of it is.
2. Compare the two pools' `eth_per_tao` in the stored `pools` provenance against
   an independent observation of the same pools. The stored row carries
   `eth_per_tao` and `liquidity_usd` per pool at each tick, so the divergence is
   reconstructable after the fact — you do not need to catch it live.
3. A thin pool drifting is expected; a deep pool drifting is not. Weigh by
   `liquidity_usd`.
4. If a pool is genuinely wrong, **remove it from the pool set** rather than
   widening `OUTLIER_THRESHOLD`. Widening the threshold to accommodate a bad
   reading is how a bad reading becomes the price.
5. Remember the corollary: as the spread grows, the outcome is not "the bad pool
   gets dropped". It is "publication stops". Act before 4%.

## Scenario 4 — the index published a wrong value

**How you find out:** almost never from an alert. Usually from a reader, or from
a divergence noticed after the fact.

1. Establish the window: `SELECT observed_at, usd_per_tao, price_basis,
pool_count, pools FROM tao_usd_index WHERE observed_at BETWEEN … ORDER BY
observed_at` — the per-pool provenance stored on every row is what makes the
   value auditable.
2. Establish the cause before deciding anything. A wrong input (a pool we should
   not have trusted) and a wrong computation (a bug in the aggregator) have
   different remedies: the first is a venue-set change, the second is a fix plus
   a decision about every value the bug touched.
3. Then apply the policy below.

---

## Policy: correcting or annotating a historical index value

**Decided here, in advance, rather than in the moment.**

**Stored index rows are immutable. A published value is never silently
rewritten.**

The reasoning: `tao_usd_index` is an observational record — "this is what the
qualifying pools said at this block". Rewriting it would destroy the only
evidence of what we actually served, and any consumer that read the old value
would have no way to learn it had changed. A price history that is edited is not
a history.

Concretely:

- **Never** `UPDATE tao_usd_index SET usd_per_tao = …`. If a value is wrong, it
  is wrong _and recorded_.
- A wrong value caused by a **bad input** is corrected going forward by changing
  the pool set. The historical rows stand: they faithfully record what those
  pools said.
- A wrong value caused by an **aggregator bug** is fixed in code. If the
  affected window must be restated, it is **recomputed into a new row set with a
  new `price_basis`**, never in place — the original rows stay, and the
  restatement is additive and labelled. Any such restatement requires a
  corresponding ADR entry saying what was recomputed and why.
- **Deleting** rows is never a correction. A gap and a wrong number are
  different claims, and a deletion converts one into the other.
- Nothing downstream may hand-set a price to paper over a gap. Health, uptime
  and latency are probe-derived only in this repo, and a price is held to the
  same rule: it is measured, or it is absent with a stated reason.

---

## What is monitored, and where the thresholds live

| Condition                                      | Threshold              | Source                            |
| ---------------------------------------------- | ---------------------- | --------------------------------- |
| Table staleness (ingestion wholly stopped)     | 2 h                    | `TABLE_FRESHNESS.tao_usd_index`   |
| Empty evaluation window                        | 1 h, any               | `evaluateTaoUsdIndex`             |
| Degraded publication (`insufficient_pools`)    | any tick               | `evaluateTaoUsdIndex`             |
| Pool divergence (warn)                         | 1% — half of rejection | `POOL_DEVIATION_WARN`             |
| Pool divergence (rejection, stops publication) | 2%                     | `OUTLIER_THRESHOLD` (ADR 0025)    |
| Pool not contributing                          | 15 min ≈ 15 ticks      | `POOL_FAILING_MS`                 |
| Minimum qualifying pools                       | 2                      | `MIN_QUALIFYING_POOLS` (ADR 0025) |

The divergence warning is **derived** from `OUTLIER_THRESHOLD` rather than typed
as its own number, so retuning the ADR moves the warning with it instead of
quietly turning it into noise or a rubber stamp.

No endpoint hostnames, credentials or private URLs appear in this document, in
the watchdog, or in any alert payload it produces. Pool addresses are public
on-chain identifiers and are safe to name.
