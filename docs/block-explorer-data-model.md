# Block Explorer Data Model

This is the reference for "what does a block actually contain, what does a full archive
node expose, and what does a real Bittensor block explorer need to show" — researched and
verified 2026-07-08 (source-level, against live polkadot-sdk, plus a direct competitor
audit of taostats.io and taomarketcap.com). Read this before re-researching any of it.

## Blocks, extrinsics, and events

A Substrate block has a header (block number, parent hash, `state_root`, `extrinsics_root`,
`digest`) and a body: an ordered list of **extrinsics**.

**Extrinsics are the input.** Substrate's general term for "things included and executed in
a block" — broader than "transaction": it covers user-signed calls (`SubtensorModule.set_weights`)
and **inherents**, special extrinsics the block author inserts itself, not signed by any user
(every block's extrinsic #0 is `Timestamp.set`).

**Events are the output** — the log of what happened as a _result_ of executing extrinsics.
One extrinsic can produce zero, one, or many events. Every extrinsic ends in exactly one
`System.ExtrinsicSuccess` or `System.ExtrinsicFailed` event (source of the `success` column
on `extrinsics`).

The `phase` field ties them together. Verified directly against block #8,575,300: events
0–270 all had `phase=Initialization` — fired automatically at the _start_ of block execution,
before any extrinsic ran (emission distribution, scheduled weight-reveals — none triggered by
a user). Events 271+ had `phase=ApplyExtrinsic`, each tagged with the causing `extrinsic_index`.
Execution order for every block: **Initialization events → extrinsics execute in order, each
producing its own events → Finalization events (if any).** Replaying a block's extrinsics
against the prior block's state deterministically produces both the new state and this log —
that determinism is what consensus is built on.

## The gap: extrinsics + events give you a log, not a snapshot

Events are a log of _changes_, not a snapshot of _current values_. A `Balances.Transfer` event
tells you money moved; it doesn't hand you "this account's balance right now." Point-in-time
values (an account's exact balance, a hotkey's stake, a neuron's weight vector) at a specific
historical block require querying **state/storage**, not replaying events.

This is what "archive node" means, distinct from an events indexer: the archive node retains
the full state trie at every historical block. Verified from live polkadot-sdk source
(`substrate/client/db/src/lib.rs`, `substrate/client/cli/src/params/pruning_params.rs`):
pruning has **two independent axes**.

- `--state-pruning` (`PruningMode::{ArchiveAll, ArchiveCanonical, Constrained(n)}`, default
  keeps only the last 256 blocks' state) — governs the **state trie**.
- `--blocks-pruning` (`BlocksPruning::{KeepAll, KeepFinalized, Some(n)}`, default
  `archive-canonical`) — governs **block bodies and justifications**.

A node can retain full block/extrinsic/event history forever (`blocks-pruning=archive`) while
still discarding all state older than 256 blocks (`state-pruning=256`, the default) — it'll
happily serve `chain_getBlock`/events back to genesis, but any `state_getStorage` call at an
old block fails with a pruned-state error. **Only `state-pruning=archive` keeps the full
historical trie.** `--pruning archive` (the legacy single flag) is a clap alias for
`--state-pruning` ONLY — it does not set `--blocks-pruning`, which silently defaults to
`archive-canonical` if not passed explicitly. Both flags must be set explicitly for a true,
complete archive node.

## What a full archive node exposes beyond `chain_getBlock` + `system_events`

Verified against live polkadot-sdk source, 2026-07-08:

- **`state_getStorage`/`getStorageAt`/`getKeysPaged`/`getPairs`/`getReadProof`** — direct
  historical state reads at an arbitrary block. Requires `state-pruning=archive`.
- **`state_call`** (aliased `state_callAt`) — execute any Runtime API method against a
  historical block's state. This is how you get _computed_ values (e.g. a chain-defined
  aggregate like subnet/neuron info) rather than one raw storage key. Same archive-depth
  requirement as above. Parity's own guidance: prefer custom Runtime APIs + `state_call` over
  bespoke RPC endpoints — a Runtime API upgrades with the runtime, no node restart needed.
- **Header fields we don't currently store**: `state_root`, `extrinsics_root` (Merkle
  commitments), `digest` (Aura consensus logs — the slot number and the author's seal
  signature, letting you independently verify block authorship without re-executing it).
- **GRANDPA justifications** (`grandpa_proveFinality`) — finality proofs, but **sparsely
  stored even on a full archive node**: only at authority-set-change blocks, every
  `justification_period` blocks, and the current finalized tip. `grandpa_proveFinality`
  reconstructs a proof for any block by walking to the nearest stored one. Retention is also
  gated by `--blocks-pruning archive`.
- **`archive_v1_*`** — a JSON-RPC v2 surface **stabilized June 2026** (`polkadot-sdk` release
  `stable2506`), purpose-built for archivers/indexers, intended to eventually replace the ad
  hoc `state_*`/`chain_*` combination: `genesisHash`, `hashByHeight` (correctly handles
  forks — multiple hashes per height, unlike `chain_getBlockHash`'s one-hash assumption),
  `header`, `body`, `finalizedHeight`, `call` (the `state_call` equivalent), and `storage`/
  `storageDiff` as **streaming subscriptions** designed for bulk indexer reads rather than
  one-off blocking calls. Build future state-ingestion against this, not the older methods.

## What a real Bittensor block explorer needs (benchmarked against taostats.io and taomarketcap.com)

taostats.io is the dominant, most feature-complete explorer. TaoMarketCap is the strongest
"second" — notably has a "Conviction" tab (subnet-owner exit-lock vesting tracker) taostats
lacks, a real differentiator worth matching or beating.

**Block/extrinsic/event pages** — foundation we already have, verified accurate:

- Block page: header + Extrinsics tab + Events tab (taostats hides the first ~30 System
  events by default — worth copying).
- Extrinsic detail page: decoded call name/params, signer, fee, linked events — a full
  decoder. We already store `call_args` as JSONB, so the raw material exists.
- Site-wide `/blocks`, `/extrinsics`, `/events`, `/runtime` (spec-version change history),
  `/sudo` (root-origin calls) tables.

**Account pages**: balance breakdown (staked-to-root / staked-in-alpha / free / liquidity-pool
/ reserved), alpha holdings per subnet/validator, transfer + stake-transaction history. The
history is event-log-derived (buildable from what we have now). **The current balance
breakdown is a state snapshot, not derivable from events alone.**

**Subnet pages**: identity, market data (price/mcap/volume — needs a price/DEX data source we
don't have), and **hyperparameters** (rho, kappa, tempo, immunity period, commit-reveal
settings, etc.) — live state values, not events.

**The metagraph** (per-neuron: UID, stake weight, VTrust, consensus, incentive, dividends,
emission, "Updated" = blocks since last weight-set) — **fundamentally a state snapshot**.
Already captured today via a separate D1-backed pipeline (`.github/workflows/refresh-metagraph.yml`
→ `scripts/fetch-metagraph-native.py` → D1 `neurons`) — see the block-explorer completion
roadmap issue tree for the one confirmed remaining gap (subnet hyperparameters).

**Validator dashboards, historical time-series** (price charts, registration-cost charts,
historical metagraph snapshots) — mix of event-derived and state-derived data.

## Our current data model vs. the gap

We capture the **log layer** — `blocks` (curated subset), `extrinsics`, `chain_events`,
`account_events` — via the indexer decoding live blocks + events. Verified accurate via
direct independent cross-check against two sources with zero shared infrastructure with our
indexing pipeline (our own archive node for a historical block, `entrypoint-finney.opentensor.ai`
for a live one): perfect parity, both extrinsic and event content, exact order.

Per-neuron metagraph state is already captured (see above) via D1, not Postgres — the
Postgres `neurons`/`neuron_daily`/`economics_history` tables exist in the schema as future
D1→Postgres cutover targets (ADR 0013) but have no writer yet; check D1's route list in
`workers/config.mjs` before assuming a chain-data tier is missing, the two can diverge.

The one confirmed, unfiled capture gap is **subnet hyperparameters** — no pipeline captures
these anywhere. Everything else needed for full explorer parity is a derived view or narrow
enrichment on already-accurate data, not new chain-state capture. See the block-explorer
completion roadmap issue tree for the full breakdown.

Price/market data is a separate problem again — not a state read in the simple sense, needs
a decision on data source (on-chain bonding-curve state vs. an external price feed).
