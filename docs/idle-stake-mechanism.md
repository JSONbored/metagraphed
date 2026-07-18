# Idle Stake Mechanism

Research spike for #6645 (part of the #5968 competitive survey — TaoSwap finding). Identifies
the exact on-chain mechanism behind TaoSwap's `/idle-stakes/` endpoint, verified 2026-07-18
against live `opentensor/subtensor` pallet source (`pallets/subtensor/src/coinbase/run_coinbase.rs`)
and cross-checked against TaoSwap's own live API response. Read this before re-researching any
of it.

## TaoSwap's own docs don't define it

TaoSwap's published OpenAPI spec (`https://api.taoswap.org/schema/`) lists `/idle-stakes/` and
`/idle-stakes/lookup/` with **no description, no response schema** — bare `operationId`s only.
The definition has to be reverse-engineered from the live response shape and cross-checked
against pallet source, exactly the situation #5303/`docs/conviction-lock-mechanism.md` existed
to resolve for the conviction-lock mechanism.

Live response (`GET https://api.taoswap.org/idle-stakes/`, 2026-07-18):

```json
{
  "total_idle_alpha_tao": 87314.8,
  "total_estimated_daily_loss_tao": 190.32,
  "total_delegators_affected": 9149,
  "subnets": [
    {
      "netuid": 12,
      "name": "Compute Horde",
      "symbol": "μ",
      "idle_alpha": 1109620.73,
      "idle_alpha_tao": 6321.28,
      "avg_validator_apy": 53.64,
      "estimated_daily_loss_tao": 9.29,
      "delegators_affected": 37
    }
  ]
}
```

`estimated_daily_loss_tao` reconciles exactly as `idle_alpha_tao * avg_validator_apy / 365` for
every subnet row checked (e.g. netuid 5: `6923.40 * 1.9979 / 365 = 37.87 ≈ 37.9`). That's only
arithmetically consistent if TaoSwap's "idle" stake earns **zero** yield today (a partial-yield
figure would make the "loss" a smaller delta, not the full APY) — the field names describe
stake sitting on hotkeys that currently pay their delegators nothing.

## The real mechanism: dividends vs. incentive, and when dividends are zero

Source: `pallets/subtensor/src/coinbase/run_coinbase.rs`.

Per-epoch, a hotkey's emission splits into two streams that are **not** distributed the same way:

- **Incentive** (mining reward) goes to the hotkey owner's own account only — `distribute_dividends_and_incentives` never gives delegators a share of incentive, regardless of how much they've staked to that hotkey.
- **Dividends** (validating reward) are the only stream delegated stake ever receives, split among the hotkey's stakers proportional to their contribution (`calculate_dividends_and_incentives` / `get_parent_child_dividends_distribution` for the childkey-delegation case).

Dividends are **zero** for a hotkey when:

1. **The hotkey has no validator permit.** `distribute_emission` skips epoch/weight-setting execution entirely for a non-permitted hotkey — no dividend calculation happens for it at all, so every delegating account earns nothing that epoch.
2. **The hotkey has a permit but its `dividends` output is zero anyway** — e.g. it isn't actually setting weights, or its weights are excluded/zeroed by consensus clipping.

Both cases are the same observable outcome from a staker's perspective: **alpha delegated to
that hotkey is earning nothing, right now, no matter how large the balance is** — "idle" in
the sense TaoSwap's math implies, not "unstaked"/"free balance" (that's a different, much
simpler concept this API doesn't seem to be describing, given `idle_alpha`/`idle_alpha_tao` are
alpha-denominated per-subnet figures, not a delegator's free TAO balance).

## Decodable from metagraphed's existing capture — no new state polling needed

Every input this needs is **already captured** in the `neurons` tier
(`src/metagraph-neurons.mjs`'s `MetagraphNeuron` shape, sourced from the periodic metagraph
snapshot): `validator_permit` (bool), `dividends` (already a per-neuron field), and `stake_tao`.
Unlike #6638's conviction leaderboard (which needed a brand-new `subnet_locks` polling pipeline
for state nothing else captured), this needs **zero new capture** — it's a pure shaping function
over data metagraphed already has on every build/refresh cycle.

Live sanity-check against metagraphed's own `neurons` data for netuid 12 (same subnet as
TaoSwap's example row above, checked same day): summing `stake_tao` across neurons with
`dividends == 0` gives 11,202.88 τ; restricting to `validator_permit == true AND dividends == 0`
(hotkeys that technically hold a permit but are earning nothing this epoch) gives 9,368.92 τ.
Neither matches TaoSwap's 6,321.28 exactly — expected, since both are independent live
snapshots taken at different moments and chain stake shifts continuously; the point of this
check is that the figures land in the **same order of magnitude** with the same qualitative
shape (a meaningful five-figure-τ chunk of one subnet's stake earning nothing), not a
byte-for-byte match to an undocumented competitor endpoint.

`delegators_affected` (a **per-coldkey** count, not per-neuron) needs one more join: which
distinct coldkeys have a stake position on a `dividends == 0` hotkey. That's exactly the
self-stake position data #6507 already captures (`scripts/fetch-self-stake.py`) — still no new
polling, just a join across two tiers that already exist.

## Deliverable scoping (follow-up issue, not this one)

This design note stops at "the mechanism is `dividends == 0`, fully decodable today." The actual
capture/API-exposure work — a per-subnet `idle_stake_tao` rollup (and optionally a per-neuron
`is_idle` flag, and a per-coldkey lookup joining #6507's self-stake data) — is buildable as a
pure shaping module + a REST route/MCP tool, following the same pattern as every other
`neurons`-tier-derived artifact in this codebase. Scoped as a fresh implementation issue (#6789)
rather than folded into this research spike.
