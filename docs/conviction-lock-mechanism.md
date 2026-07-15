# Conviction Lock Mechanism

Research spike for #5303 (part of #4302, the Conviction/vesting tracker epic) — identifies
the exact on-chain mechanism behind TaoMarketCap's "Conviction" tab, verified 2026-07-15
against live `opentensor/subtensor` pallet source (`pallets/subtensor/src/staking/lock.rs`,
`pallets/subtensor/src/macros/dispatches.rs`, `pallets/subtensor/src/coinbase/run_coinbase.rs`).
Read this before re-researching any of it.

## Correcting the issue's framing

#5303's framing — "a subnet owner submits an unlock transaction, then a vesting-style
countdown runs before the position becomes liquid" — describes only the exit side of a much
larger mechanism. This is not a single owner's voluntary announcement; it's a **permissionless,
conviction-weighted subnet-ownership contest** that runs continuously for every subnet.
**Any account can lock alpha to any hotkey on any subnet to build "conviction," and once a
challenger's conviction overtakes the incumbent owner's, ownership of the subnet transfers
automatically** — no vote, no owner cooperation required. The owner's own lock is simply their
entry in the same contest; "unlocking" is how an incumbent lets their advantage decay, not a
separate withdrawal mechanism.

## The three extrinsics

All three take `origin` = the coldkey; `netuid` is `NetUid` (u16 newtype), `amount` is
`AlphaBalance`. Source: `pallets/subtensor/src/macros/dispatches.rs`.

- **`SubtensorModule.lock_stake(hotkey, netuid, amount)`** (call_index 136) — locks
  already-staked alpha on `netuid` to `hotkey`, building conviction over time. First call for a
  (coldkey, netuid) pair creates the lock; a second call is a top-up and must target the same
  hotkey the existing lock already has (`Error::LockHotkeyMismatch` otherwise). Requires
  `amount` to be available in the caller's total alpha stake on the subnet
  (`Error::InsufficientStakeForLock`/`Error::StakeUnavailable`).
- **`SubtensorModule.move_lock(destination_hotkey, netuid)`** (call_index 137) — moves an
  existing lock to a different hotkey on the same subnet. Rolls the lock forward to the current
  block first (preserving decayed locked mass), then resets conviction to zero under the new
  hotkey. `Error::NoExistingLock` if the caller has no lock on that subnet.
- **`SubtensorModule.set_perpetual_lock(netuid, enabled: bool)`** (call_index 138) — **this is
  the exit-initiating call.** `enabled: true` makes the caller's lock non-decaying (parks it
  indefinitely, defending their conviction score); `enabled: false` (or never calling this at
  all — decay is the default state) returns the lock to normal exponential decay. There is no
  separate "unlock" or "withdraw" extrinsic — decay is the mechanism, and this toggle is the
  only lever a lock holder has over it.

## Storage

Source: `pallets/subtensor/src/lib.rs`, all under `#[pallet::storage]`.

| Item                                | Shape                                           | Meaning                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lock`                              | NMap (coldkey, netuid, hotkey) → `LockState`    | The individual lock for one coldkey/netuid/hotkey tuple.                                                                                                                                                                                                                                                                         |
| `DecayingLock`                      | DMap (coldkey, netuid) → `bool`                 | Presence + `false` = perpetual (non-decaying). **Missing entry = decaying (the default).** Never `true`-valued in practice — written only via `insert(..., false)` or `remove(...)`.                                                                                                                                             |
| `HotkeyLock` / `DecayingHotkeyLock` | DMap (netuid, hotkey) → `LockState`             | Aggregate of all non-owner locks targeting that hotkey, split perpetual vs. decaying.                                                                                                                                                                                                                                            |
| `OwnerLock` / `DecayingOwnerLock`   | Map netuid → `LockState`                        | Aggregate of locks targeting the _current subnet owner's_ hotkey specifically — tracked separately so an ownership handover can cleanly reassign the aggregate (see below).                                                                                                                                                      |
| `LockingColdkeys`                   | NMap (netuid, hotkey, coldkey) → `()`           | Reverse index: which coldkeys have a non-zero lock on a given hotkey/subnet.                                                                                                                                                                                                                                                     |
| `UnlockRate`                        | `StorageValue<u64>`, default **934,866 blocks** | Decay half-life for `locked_mass` — governance-adjustable, **not a hardcoded constant**. At ~12s/block, 934,866 blocks ≈ **~130 days**, not the ~90-day figure the doc comment's own label implies and not TaoMarketCap's 30/60-day UI framing — verify against live value before displaying a "days remaining" figure anywhere. |
| `MaturityRate`                      | `StorageValue<u64>`, default **934,866 blocks** | Decay half-life for `conviction`'s _build-up_ (conviction matures toward `locked_mass` while a lock is held, then decays once mass is gone) — same live-query caveat.                                                                                                                                                            |

`LockState { locked_mass: AlphaBalance, conviction: U64F64, last_update: u64 }` — `conviction`
is a literal field name in the pallet's own source (`ConvictionModel` in `lock.rs`), not just
TaoMarketCap's UI label; it's an exponentially-smoothed integral of `locked_mass` over time, not
`locked_mass` itself. Every read rolls the state forward from `last_update` to "now" using
`UnlockRate`/`MaturityRate` — there is no block-by-block storage write, so reconstructing a
point-in-time conviction value requires replaying the roll-forward math
(`ConvictionModel::roll_forward_lock`, `exp_decay`), not just reading the last-written row.

## The ownership-transfer trigger

`change_subnet_owner_if_needed(netuid)` (`lock.rs`) runs once per subnet **every time that
subnet's epoch fires** (`coinbase/run_coinbase.rs:447`, inside the per-subnet emission-drain
loop — cadence is that subnet's tempo, not a fixed global interval). Gates, all of which must
pass:

1. `SubnetAlphaOut(netuid)` is non-zero (no outstanding alpha ⇒ no meaningful threshold).
2. The subnet is at least `ONE_YEAR` old (`7200 * 365 + 1800` blocks ≈ 365 days at 12s/block),
   measured from `NetworkRegisteredAt`.
3. Total rolled aggregate conviction across the subnet (`get_total_conviction`, sum of every
   hotkey's aggregate plus the owner's) is **at least 10% of `SubnetAlphaOut`**.
4. `subnet_king(netuid)` — the hotkey with the single highest rolled conviction across
   `HotkeyLock`, `DecayingHotkeyLock`, `OwnerLock`, and `DecayingOwnerLock` — resolves to a real
   coldkey (different from the current `SubnetOwner`).

If all four pass: the king hotkey is registered as a neuron on the subnet if not already:
`SubnetOwner` and `SubnetOwnerHotkey` are overwritten, the old owner's `OwnerLock`/
`DecayingOwnerLock` aggregates are folded back into their (now-ordinary) hotkey's
`HotkeyLock`/`DecayingHotkeyLock`, the new owner's prior `HotkeyLock` is promoted into
`OwnerLock`, and `Event::SubnetOwnerChanged { netuid, old_coldkey, new_coldkey }` fires.

## Answering #5303's deliverable questions

- **Decodable from existing capture, or needs new state-query polling?** Both, for different
  parts. The _event log_ — every `lock_stake`/`move_lock`/`set_perpetual_lock` extrinsic call
  plus the `PerpetualLockUpdated { coldkey, netuid, enabled }` and `SubnetOwnerChanged {
netuid, old_coldkey, new_coldkey }` events — is an ordinary `pallet.method`/event pair,
  already within scope of the existing `chain_events`/`account_events` capture (no new
  indexer surface needed; `SubtensorModule` is already a tracked pallet). But a **live
  "who's currently winning the conviction race" leaderboard** is state-derived, not
  event-derived: `conviction` isn't stored pre-computed anywhere, it has to be rolled forward
  from each `LockState`'s `last_update` using the _current_ `UnlockRate`/`MaturityRate` values
  at query time. That requires either (a) a `state_call` against the relevant storage items at
  query time, or (b) replicating `roll_forward_lock`'s exponential-decay math in
  `chain-alpha-volume.mjs`-style offline shaping code, fed by the raw `LockState` rows via
  periodic state polling. The math is deterministic and self-contained (no other pallet state
  needed beyond the two rate constants), so (b) is buildable without new RPC surface once the
  raw `Lock`/`HotkeyLock`/`OwnerLock` maps are being polled at all.
- **Historical instances recoverable from archive state, or only observable going forward?**
  Every `SubnetOwnerChanged` event is a permanent, replayable fact in the block/event log going
  back to whenever this pallet version activated on mainnet — fully recoverable via a one-time
  backfill scan of `chain_events` (or `account_events` once/if `SubnetOwnerChanged` is added to
  its curated allowlist) for that event name, no archive _state_ access required for the
  event-log side. Reconstructing the _lead-up_ (the conviction race's trajectory before a given
  flip) for a historical instance would need archive state reads at those specific historical
  blocks (`state_getStorage`/`state_call` at an old block, per
  `docs/block-explorer-data-model.md`'s archive-node section) — available once #2111's
  bare-metal archive node ships, not before.

## What this means for the capture-pipeline epic (#4302's actual scope)

This spike only identifies the mechanism; #4302 remains the issue that scopes and builds
against it. Concretely unblocked by this research:

- A `SubnetOwnerChanged` historical backfill (event-log-only, no archive-state dependency) is
  buildable today, independent of #2111.
- A live per-subnet "conviction leaderboard" (current locks + rolled conviction, ranked) needs
  either `state_call` polling (deferred until the archive node/state-query tooling in #4344
  ships) or an off-chain roll-forward replica fed by ordinary event capture — the latter is
  buildable today without waiting on #4344/#2111, at the cost of re-implementing (and keeping in
  sync with) the pallet's own decay math.
- Do not build a "days until unlock" countdown display against a hardcoded 30/60-day figure —
  live-query `UnlockRate`/`MaturityRate` the same way every other governance-adjustable pallet
  bound in this codebase already is (mirrors the `MaxDelegateTake`/`TxDelegateTakeRateLimit`
  pattern from the native-staking epic, #5229).
