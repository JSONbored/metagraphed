# ADR 0029 — The database, rebuilt: one typed PostgreSQL model filled from the chain

- **Status:** Accepted
- **Date:** 2026-11-27
- **Supersedes:** the storage decisions of
  [0014](0014-chain-data-infrastructure-and-postgres-cutover.md) (D1 as the live
  hot cache; a per-tier Postgres cutover flag). Its rule 4 — "recent data is
  complete" and "all of history is complete" are separate claims with separate
  gates — is kept.
- **Relates to:** [0006](0006-provenance-tiered-storage.md),
  [0025](0025-on-chain-tao-usd-index.md),
  [0028](0028-public-private-repo-boundary.md),
  [indexed Parquet history](../indexed-parquet-history.md)

## Context

The serving database is one PostgreSQL 18 instance. Measured on it on
2026-11-27:

- **847 MB in total, 749 MB of it in `app`** — 136 tables carried over from D1
  and Neon. 88 of the 136 are empty: they belonged to D1 lanes that never ran
  on the native runtime.
- **`app`'s column types:** 426 `text`, 369 `bigint`, 51 `double precision`, 26
  `timestamptz`, 7 `jsonb`, 6 `bytea`. That is SQLite's type system:
  - addresses and hashes are 48–66-character strings, compared as strings.
  - TAO amounts are floats (`account_balances.free_tao`), so a balance above
    about a million TAO cannot hold every rao.
  - other amounts are strings (`alpha_rao`, `shares`, `fee_tao`), which cannot
    be summed or sorted without a cast.
  - time is epoch milliseconds in a `bigint`.
- **Snapshots are rewritten whole on every poll.** `account_balances` holds
  408,547 rows, one per account per capture. Most of each capture repeats the
  last one.
- **Documents are stored as JSON text.** `neuron_document_projections` is
  31 MB for 799 rows.
- **Retention deletes rows**, so the prune lanes leave bloat and vacuum work
  behind.
- **Chain detail costs about 141 KB per block** (`chain_detail_*`, 453.8 MB).
  A block averages 204 events, 16 extrinsics and 172 account-event rows. At
  that size the store keeps only ~3,200 blocks (about 10.7 hours).
- **The typed provenance core is empty.** It is the `chain`, `ops` and
  `registry` schemas, and no public reader uses it.
- **No extension is installed.** There is no `pg_stat_statements`, trigram
  index or vector type.

The migration to the native runtime moved the D1 model into PostgreSQL. It did
not redesign it. This ADR is the redesign.

## Decision

### 1. Rebuild, don't port

Each domain is redesigned and filled from the chain by its producer. Then its
routes move to the new tables and its old tables are dropped.

- **Nothing is copied from the old tables.** They hold derived data, and the
  source is the chain. The only rows the chain cannot recreate are the few that
  users create (sign-ins, keys, alert triggers, webhooks). Those move in place
  in phase 6.
- **A route reads one model at a time.** It switches when the new tables cover
  its window and the switch's checks pass. It never merges two models.

### 2. Physical conventions (every new table)

- **Accounts** are a `bigint` surrogate from `chain.accounts`, which holds the
  32-byte public key (`bytea`, unique) and its SS58 rendering. Fact tables
  carry the 8-byte id, not a 48-character string. `state.evm_associations`
  maps EVM H160 addresses to accounts.
- **Hashes** are `bytea` with an `octet_length` check, never hex text.
- **Amounts** in rao and alpha-rao are `bigint`. Supply is bounded at
  21 × 10^15, well inside its range. Fixed-point chain values (U64F64 shares,
  I96F32 prices) are `numeric`. Floats are never used for money.
- **The clock** of chain facts is `block_number`. Wall time is stored once, in
  `chain.blocks.produced_at` (`timestamptz`, from the block's `Timestamp.set`).
  Product tables use `timestamptz`.
- **Enumerations** — pallet, call, event kind, hyperparameter, role — are
  `smallint` ids into dimension tables.
- **Decoded arguments** are lossless `jsonb`, with u128 values as strings.
  Fields that routes filter or sort on are promoted to typed columns.
- **Append-only facts are range-partitioned on `block_number`**, one partition
  per 50,400 blocks (seven days). Retention detaches and drops whole
  partitions, never rows.
- **Slowly-changing state is stored as validity ranges** on the key, as
  `valid_from` and `valid_to`. Both are block numbers; `valid_to` is exclusive
  and `NULL` while current.
  - A partial unique index on the key `WHERE valid_to IS NULL` finds the
    current row. `(key, valid_from DESC)` answers "as of block N".
  - The writer receives the state a producer observed at block N. It closes
    the current row and opens a new one only when a value changed, so history
    costs one row per change, not one per poll.
- **High-churn state is current plus daily.** A balance changes on every fee
  paid. Its current row is updated in place, and its history is one closing
  row per changed key per UTC day.
- **The metagraph is stored per epoch**, as one row per
  `(network, netuid, block)`. Its columns are arrays indexed by UID. A
  subnet's metagraph at an epoch is one row; a neuron's history is that UID's
  element across rows.

### 3. Schemas

| Schema                     | Holds                                                                                 | Written by                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `chain`                    | The finalized chain: networks, accounts, blocks, extrinsics, events, account activity | the chain-detail producer, through its sync                             |
| `state`                    | Decoded on-chain state over time: subnets, the metagraph, stake, balances, identities | one producer per family, through its sync                               |
| `market`                   | Pool samples, price candles, stake flows, the TAO/USD index                           | derived in the database from `state`/`chain`, plus the TAO/USD producer |
| `registry`                 | The curated subnet registry and its published generations                             | the registry intake                                                     |
| `search`                   | The semantic index: documents and their vectors                                       | the indexer lane                                                        |
| `app`                      | Product state only: users, API keys, usage, quotas, alerts, webhooks, OAuth           | the API                                                                 |
| `ops`                      | Lanes, health, uptime checks, retention and the cold-segment manifest                 | the runtime                                                             |
| `jobs`, `realtime`, `auth` | The native queue, cron, actors and rate limits (already native; unchanged)            | the runtime                                                             |

`app` ends holding product state alone. Everything derived from the chain
leaves it.

### 4. The domain tables

| Family                 | Tables                                                                                                                      | Key                                                 | History                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain core             | `chain.blocks`                                                                                                              | `(network, block_number)`; unique `(network, hash)` | all of history: header, author, `produced_at`, spec version, counts                                                                                 |
|                        | `chain.extrinsics`                                                                                                          | `(network, block_number, extrinsic_index)`          | hot window; signer, call, success, fee, tip, nonce, `args`, `error`                                                                                 |
|                        | `chain.events`                                                                                                              | `(network, block_number, event_index)`              | hot window; kind, phase, extrinsic, `args`                                                                                                          |
|                        | `chain.account_activity`                                                                                                    | `(account, block_number, event_index, role)`        | longer hot window: the account timeline                                                                                                             |
|                        | `chain.accounts`, `chain.calls`, `chain.event_kinds`, `chain.runtime_versions`                                              | surrogate ids                                       | dimensions                                                                                                                                          |
| Subnets and metagraph  | `state.subnets`, `state.subnet_identities`                                                                                  | `netuid`                                            | validity ranges                                                                                                                                     |
|                        | `state.subnet_hyperparams`                                                                                                  | `(netuid, param)`                                   | one row per change, with the extrinsic that made it                                                                                                 |
|                        | `state.subnet_emission_splits`, `state.subnet_lifecycle_states`                                                             | `netuid`                                            | validity ranges on the capture's observation blocks (migration 0060); `state.observations` holds the newest block each family was observed whole at |
|                        | `state.neuron_registrations`                                                                                                | `(netuid, uid)`                                     | validity ranges: hotkey, coldkey, registered block                                                                                                  |
|                        | `state.metagraph_epochs`                                                                                                    | `(network, netuid, block_number)`                   | per epoch for 30 days, then one per subnet per day                                                                                                  |
|                        | `state.axons`                                                                                                               | `(netuid, hotkey)`                                  | validity ranges                                                                                                                                     |
| Stake and balances     | `state.stake_shares`                                                                                                        | `(coldkey, hotkey, netuid)`                         | validity ranges, changing only on stake and unstake                                                                                                 |
|                        | `state.hotkey_alpha_epochs`                                                                                                 | `(netuid, hotkey, block_number)`                    | per epoch: total alpha and total shares, so a position's value at any epoch is `shares × alpha / total_shares`                                      |
|                        | `state.balances`, `state.balance_days`                                                                                      | `account`                                           | current plus daily                                                                                                                                  |
|                        | `state.child_keys`, `state.delegate_takes`                                                                                  | `(parent, netuid, child)`, `(hotkey, netuid)`       | validity ranges                                                                                                                                     |
| Markets                | `market.pool_samples`                                                                                                       | `(netuid, block_number)`                            | reserves and price on a declared cadence                                                                                                            |
|                        | `market.candles`                                                                                                            | `(netuid, interval, bucket)`                        | OHLC and volume, built from swap events and samples                                                                                                 |
|                        | `market.stake_flows_daily`                                                                                                  | `(netuid, day)`                                     | stake in, stake out, net, count                                                                                                                     |
|                        | `market.tao_usd`                                                                                                            | `minute`                                            | the [0025](0025-on-chain-tao-usd-index.md) index with its source block                                                                              |
| Accounts and relations | `state.identities`, `state.proxies`, `state.multisigs`, `state.coldkey_swaps`, `state.evm_associations`                     | per family                                          | validity ranges or event-derived                                                                                                                    |
|                        | `state.liquidity_positions`, `state.limit_orders`, `state.leases`, `state.crowdloans`, `state.admin_actions`                | per family                                          | event-derived and kept for all of history                                                                                                           |
| Product                | `app.users`, `app.api_keys`, `app.usage_daily`, `app.alert_triggers`, `app.alert_deliveries`, `app.webhooks`, `app.oauth_*` | per table                                           | as the product needs                                                                                                                                |

Each phase's migration gives the exact columns. The conventions in §2 are
checked by a test over every migration, not by review.

### 5. The write contract

- **One producer and one sync endpoint per family.** The seam stays the HTTP
  sync that [0028](0028-public-private-repo-boundary.md) set: producers are
  private, and the endpoint and its writer are public.
- **Each batch names the finalized block it was read at**, as
  `(network, block_number, block_hash)`. The writer refuses a batch whose hash
  disagrees with `chain.blocks`. Only finalized blocks enter the canonical
  tables, so they never need reorg repair. The live head belongs to the
  realtime tier.
- **Writes are idempotent.** A re-sent batch changes nothing. A validity-range
  write is one transaction that diffs against the current row.
- **Each family records its coverage**, as the contiguous block range it holds
  completely. A route's freshness and completeness claims read that record, not
  `max(block_number)`.

### 6. The read contract

- **One data-access module per domain** (`src/db/<domain>.ts`) holds that
  domain's parameterized SQL. There is no runtime SQL translation and no store
  selection between models.
- **Every list is keyset-paginated** on its natural order, such as
  `(block_number, index) DESC`. There are no `OFFSET` scans.
- **Every hot route has an index** whose leading columns match its filter and
  order. A test runs `EXPLAIN` against a seeded database to check this.
- **SS58 encoding happens once**, from `chain.accounts`. A route that accepts an
  address resolves it to the surrogate id first.

### 7. Hot and cold

- **The hot tier is PostgreSQL.** It holds all of `chain.blocks`, every
  validity-range table and the daily and epoch history. Extrinsics and events
  stay in a declared window (seven days at first) and account activity in a
  longer one (thirty days). Each window is a setting. One is raised only
  after the phase's first partitions measure real bytes per block.
- **The cold tier is Parquet** in object storage. It is written per detached
  partition and read through the existing
  [indexed Parquet history](../indexed-parquet-history.md) reader.
  `ops.cold_segments` is the manifest: object key, digest, row count, block
  range. A partition is dropped only after its segment is published and
  verified. Readers fall through from hot to cold on block range.
- **Rough sizes for the hot chain core at steady state**, projected from
  today's per-block counts on the typed shape: blocks for all of history ≈ 2 GB;
  seven days of extrinsics ≈ 1 GB and of events ≈ 1.5 GB; thirty days of
  account activity ≈ 3 GB. The current shape costs 7 GB for seven days of
  everything. Phase 1 replaces these estimates with measurements.

### 8. Data this model serves that the old one could not

- **Every block header since genesis**, and every extrinsic and event through
  the cold tier. That is the whole explorer, not the last ten hours.
- **An account's timeline since genesis**, and its balance and stake at any
  block or day.
- **Subnet price history** from pool samples and swap events, as candles at
  several intervals, beside the TAO/USD index.
- **Hyperparameter change logs** naming the extrinsic that made each change.
- **Validator and neuron history per epoch**: stake, take, dividends,
  incentive, trust, nominator counts.
- **Relations over time**: identities, child keys, proxies, multisigs, scheduled key
  swaps, EVM associations, liquidity positions, limit orders, leases,
  crowdloans and admin actions.

### 9. Extensions and configuration

- **`pg_stat_statements`** for query observability. It needs a preload, which
  the deployment's configuration sets.
- **`btree_gist`**, so an exclusion constraint can keep validity ranges from
  overlapping.
- **`pg_trgm`** for identity and name search.
- **`vector`** for the semantic index. It is added when the database image
  carries it; until then `search.vectors` keeps its array column.

### 10. Phases

Each phase is one public release plus the private producer change behind it.
It lands in this order: new tables and their sync, then the producer filling
them, then the routes switching, then the old tables and their code dropped.

1. **Chain core** — the `chain` tables, the header backfill from genesis, and
   the block, extrinsic, event and account-activity routes.
2. **Subnets and the metagraph** — `state.subnets`, hyperparameters,
   identities, registrations, axons and `state.metagraph_epochs`. The subnet,
   neuron and validator routes move.
3. **Stake and balances** — stake shares, hotkey alpha per epoch, balances,
   child keys and takes. The account, nominator and holder routes move.
4. **Markets and economics** — pool samples, candles, flows, TAO/USD, root and
   gamma.
5. **Accounts, identity and relations** — identities, proxies, multisigs,
   coldkey swaps, EVM, liquidity, limit orders, leases, crowdloans and admin
   actions.
6. **Product state** — users, keys, usage, quotas, alerts, webhooks and OAuth,
   moved in place onto typed tables.
7. **Operations and monitoring** — lane health, uptime checks, retention, and
   the registry's published objects as typed tables.
8. **Cold tier and retirement** — Parquet segments for every detached
   partition, then the D1 code paths deleted: the D1 store, the export columns
   and tables, the SQLite fixtures, `migrations/d1`, `migrations/neon`,
   `source_meta` and the unused provenance core.

**A phase is done when all of these hold:**

- its producer is at the head and has filled each route's window;
- sampled answers match the chain's own storage at the sampled block;
- each hot route's plan uses its index and its latency is inside budget on the
  serving database;
- the phase's old tables are dropped, and their writers, readers, prune lanes,
  watchdog entries and fixtures are deleted.

## Consequences

- **The serving database stops being a D1 mirror.** After phase 8 no D1-shaped
  table, D1 store or SQLite dialect remains.
- **Storage gets smaller as coverage grows.** History is stored as changes and
  epochs instead of repeated snapshots, and retention drops partitions.
- **Each phase moves one domain end to end.** There is no cross-model read, and
  a phase's switch is reversible until its old tables are dropped.
- **Completeness is measured, not inferred.** Coverage records make "complete
  for this window" a stored fact that a route can state.
- **History depends on archive RPC capacity.** Header and history backfills
  are rate-bounded background work behind the private producers. "Complete
  recently" and "complete since genesis" stay separate claims.

## Appendix: every current `app` table and the phase that retires it

| Phase                                | Tables | Empty | Rows      | MB    | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------ | ----- | --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Chain core                       | 17     | 13    | 1,263,724 | 453.8 | `chain_detail_chain_events`, `chain_detail_account_events`, `chain_detail_extrinsics`, `chain_detail_blocks`, `blocks_head`, `raw_capture_selected`, `raw_capture_archives`, `raw_capture_budget`, `_migration_capture_governance`, `_migration_capture_governance_phase`, `raw_capture_state`, `raw_capture_publications`, `raw_capture_chunks`, `raw_capture_batches`, `iceberg_catalog_tables`, `iceberg_catalog_namespaces`, `chain_detail_payload_chunks`                                                                                                                                                    |
| 2 · Subnets and the metagraph        | 24     | 9     | 74,669    | 77.7  | `neuron_document_projections`, `neuron_daily_members`, `neurons_members`, `neuron_daily_documents`, `neurons_documents`, `subnet_burn_history`, `subnet_identity_history`, `subnet_identity`, `neurons_capture_batches`, `subnet_snapshots`, `subnet_ownership_history`, `subnet_hyperparams`, `subnet_hyperparams_history`, `subnet_ownership`, `neurons_passes`, `emission_gate_param_history`, `subnet_emission_enabled_history`, `subnet_deregistration_daily`, `subnet_lifecycle`, `subnets`, `_audit_neuron_members_20260922`, `subnet_alpha_dividends`, `subnet_mechanisms`, `_audit_neuron_docs_20260922` |
| 3 · Stake and balances               | 16     | 5     | 594,763   | 197.3 | `account_balances`, `nominator_positions`, `account_position_daily_documents`, `account_position_daily_members`, `validator_nominator_counts`, `nominator_scan_receipts`, `hotkey_alpha`, `account_balances_passes`, `validator_nominator_counts_passes`, `nominator_positions_passes`, `hotkey_alpha_passes`, `stake_locks`, `child_keys_history`, `pending_child_keys`, `childkey_takes`, `childkey_thresholds`                                                                                                                                                                                                 |
| 4 · Markets and economics            | 20     | 20    | 0         | 0.4   | `root_basket_captures`, `limit_order_events`, `root_basket_capture_pages`, `emission_flow_watch`, `tao_usd_index`, `tao_usd_oracle`, `root_basket_fund_snapshots`, `gamma_deposits`, `chain_concentration_daily`, `treasury_readings`, `limit_orders`, `gamma_events`, `root_basket_holdings`, `root_basket_targets`, `subnet_gamma`, `alpha_assets`, `swap_balancer`, `root_basket_current`, `root_basket_capture_completions`, `chain_gamma`                                                                                                                                                                    |
| 5 · Accounts, identity and relations | 11     | 9     | 927       | 0.8   | `account_identity_history`, `account_identity`, `multisigs`, `coldkey_swap_announcements`, `evm_associations`, `identities`, `accounts`, `proxies`, `key_successors`, `legacy_account_aliases`, `coldkey_swap_policy`                                                                                                                                                                                                                                                                                                                                                                                             |
| 6 · Product state                    | 24     | 22    | 291       | 1.0   | `api_usage_rollup`, `api_usage_rollup_batches`, `tokens`, `auth_requests`, `api_key_usage_daily`, `watch_push_subscriptions`, `invocation_approvals`, `api_keys`, `auth_capacity`, `rpc_usage_events`, `github_accounts`, `rpc_accounts`, `chain_alert_triggers`, `chain_alert_deliveries`, `rpc_usage_prune_state`, `api_key_blocks`, `service_credentials`, `oauth_grants`, `api_quota_daily`, `rpc_usage_archive_days`, `oauth_clients`, `preferences`, `_migration_user_state`, `_migration_user_state_phase`                                                                                                 |
| 7 · Operations and monitoring        | 24     | 10    | 37,196    | 18.1  | `surface_checks`, `native_export_revisions`, `lane_health`, `surface_uptime_daily`, `lane_health_clocks`, `surface_status`, `origin_reachability`, `surface_failure_daily`, `generated_artifacts`, `attribution_candidates`, `attribution_sweeps`, `self_health_checks`, `compute_declarations`, `lane_health_current`, `lane_health_verdict_latest`, `self_health_daily`, `revenue_probe_failures`, `surfaces`, `revenue_observations`, `surface_history`, `sync_dead_letters`, `providers`, `subnet_services`, `archive_export_revisions`                                                                       |

The other schemas retire in phase 8: `source_meta` (4 tables),
`public.schema_migrations`, `retained.history_*` (7 tables, replaced by
`chain.blocks`), and the unused tables of the provenance core.
