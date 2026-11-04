# PostgreSQL schema and query port

The destination is one PostgreSQL 18 database. `app` owns application state,
`retained` owns the complete retained-block family, and `source_meta` preserves
source bookkeeping independently for each original database. The provisioning
owner supplies a migration owner and a separate import role. These migrations
create schema objects under the executing owner and contain no role creation,
credential material or production connection settings.

## Source baseline and complete coverage

The committed application snapshot at `bac885fb4a339d90087984122ff31ee240f11906`
contains 98 tables, 115 indexes, 52 triggers and four views. The complete live
metadata review also contains `sqlite_sequence`, giving 99 physical application
tables. Four live lane-health trigger definitions differ from the committed
snapshot only by trailing spaces after `BEGIN`. Exact source pins must preserve
those bytes when the private importer binds its source identity.

The retained database contains nine physical tables, seven explicit indexes and
one view. Its two bookkeeping tables are `d1_migrations` and `sqlite_sequence`.
Together the sources have 108 physical tables, 122 explicit indexes, 52 triggers
and five views. Provider-owned `_cf_KV` remains the source-custody contract's
explicit exclusion. A newly captured source profile supersedes this baseline
and must reconcile every added, removed or changed object before loading.

The application DDL, generated object list and retained DDL are public source
references. Live account identifiers and custody records stay in the private
qualification path. [Application DDL](../db/d1-schema.sql),
[object inventory](../generated/db/d1-schema.json),
[retained source DDL](../migrations/retained-blocks/0001_retained_blocks.sql)

The application table families account for all 99 physical tables. Every name
below needs a concrete target mapping and typed data reconciliation.

| Family                                               | Count | Physical tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source metadata and historical migration/audit state |     8 | `d1_migrations`, `sqlite_sequence`, `_audit_neuron_docs_20260922`, `_audit_neuron_members_20260922`, `_migration_capture_governance`, `_migration_capture_governance_phase`, `_migration_user_state`, `_migration_user_state_phase`                                                                                                                                                                                                                                                                                                  |
| Accounts, API authorization, quota and alerts        |    11 | `rpc_accounts`, `github_accounts`, `api_keys`, `api_key_blocks`, `api_key_usage_daily`, `api_quota_daily`, `api_usage_rollup`, `api_usage_rollup_batches`, `chain_alert_triggers`, `chain_alert_deliveries`, `watch_push_subscriptions`                                                                                                                                                                                                                                                                                              |
| Neuron document projections and pass state           |     8 | `neurons_documents`, `neurons_members`, `neuron_daily_documents`, `neuron_daily_members`, `account_position_daily_documents`, `account_position_daily_members`, `neurons_capture_batches`, `neurons_passes`                                                                                                                                                                                                                                                                                                                          |
| Account balances, identity and nominations           |    11 | `account_balances`, `account_balances_passes`, `account_identity`, `account_identity_history`, `hotkey_alpha`, `hotkey_alpha_passes`, `nominator_positions`, `nominator_positions_passes`, `nominator_scan_receipts`, `validator_nominator_counts`, `validator_nominator_counts_passes`                                                                                                                                                                                                                                              |
| Registry, surface probes and health                  |    11 | `providers`, `subnets`, `surfaces`, `surface_checks`, `surface_history`, `surface_status`, `surface_uptime_daily`, `surface_failure_daily`, `origin_reachability`, `self_health_checks`, `self_health_daily`                                                                                                                                                                                                                                                                                                                         |
| Subnet and economic history                          |    21 | `subnet_snapshots`, `subnet_hyperparams`, `subnet_hyperparams_history`, `subnet_identity`, `subnet_identity_history`, `subnet_ownership`, `subnet_ownership_history`, `subnet_lifecycle`, `subnet_burn_history`, `subnet_deregistration_daily`, `subnet_emission_enabled_history`, `chain_concentration_daily`, `treasury_readings`, `compute_declarations`, `tao_usd_index`, `revenue_observations`, `revenue_probe_failures`, `emission_flow_watch`, `emission_gate_param_history`, `attribution_candidates`, `attribution_sweeps` |
| Recent chain data                                    |     6 | `blocks_head`, `chain_detail_blocks`, `chain_detail_extrinsics`, `chain_detail_chain_events`, `chain_detail_account_events`, `chain_detail_payload_chunks`                                                                                                                                                                                                                                                                                                                                                                           |
| Lane health and materializations                     |     4 | `lane_health`, `lane_health_current`, `lane_health_clocks`, `lane_health_verdict_latest`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Raw capture and publications                         |     7 | `raw_capture_archives`, `raw_capture_batches`, `raw_capture_budget`, `raw_capture_chunks`, `raw_capture_publications`, `raw_capture_selected`, `raw_capture_state`                                                                                                                                                                                                                                                                                                                                                                   |
| Root-basket finalized observations                   |     7 | `root_basket_captures`, `root_basket_capture_pages`, `root_basket_fund_snapshots`, `root_basket_holdings`, `root_basket_targets`, `root_basket_capture_completions`, `root_basket_current`                                                                                                                                                                                                                                                                                                                                           |
| Export and generated-store control                   |     5 | `archive_export_revisions`, `generated_artifacts`, `iceberg_catalog_namespaces`, `iceberg_catalog_tables`, `sync_dead_letters`                                                                                                                                                                                                                                                                                                                                                                                                       |

`d1_migrations` and `sqlite_sequence` from each source map into the four
profile-qualified `source_meta` tables. The other 97 application tables map into
`app`. The seven retained domain tables map into `retained`. Original migration
IDs, migration names, timestamp text, duplicate sequence rows and sequence
high-water marks remain independently reviewable. PostgreSQL migration history
uses its own native owner and never consumes these copied source ledgers.

## Import and finalization phases

1. Create base tables with exact column mappings, primary/unique keys, checks and
   explicitly approved indexes. Create actual view/function implementations as
   each family is ported. The private import guard pins this native load-phase
   catalog and the expected schema/database owners.
2. Import every physical table, including materialized rows and bookkeeping.
   Keep user triggers, active foreign keys, row security and generated-always
   columns outside the load phase. Loading both history and its materialization
   through active maintenance triggers can double counters or overwrite the
   original projection. Each source trigger still needs its real implementation
   function in the mapping before the complete source can qualify.
3. Reconcile complete typed row multisets, stable identities and all projection
   relationships. Retain a database-native catalog from the loaded target.
   Resolve every source rowid dependency explicitly. Failed validation keeps the
   target in the load phase.
4. With the external writer fence held, reconcile identity sequences forward,
   add and validate the family's foreign keys, attach its reviewed triggers, and
   verify materializations against the imported source. Record the final native
   catalog and ready-phase receipt separately. Sequence advancement is
   nontransactional in PostgreSQL, so its reconciliation must remain safe to
   repeat and must never lower an existing high-water mark.
5. Qualify the actual readers, writers, concurrency, restart and recovery path
   against the finalized schema before moving routing. The private importer
   owns load execution and its progress receipts. Native provisioning owns
   schema/role grants and operational activation.

This uses explicit phases instead of `session_replication_role` or disabling
all validation globally. Per-family foreign-key and trigger activation remains
visible in the migration and final catalog. A source trigger cannot be waived
by mapping it to an empty function.

## Trigger and view semantics to port

All 52 application triggers belong to six groups.

| Group                                      | Count | Required behavior and finalization check                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed-day export revisions                |    15 | Insert/update/delete triggers on `subnet_snapshots`, `neuron_daily_documents`, `neuron_daily_members`, `account_position_daily_documents`, `account_position_daily_members`. Preserve each affected closed UTC day, old/new day handling, and one increment per trigger effect. Import original revision rows before attaching these triggers.                                           |
| Lane-health materializations               |     7 | `lane_health_current_insert/delete/update`, `lane_health_clocks_insert/delete/update`, `lane_health_verdict_update`. Preserve latest timestamp, worse-verdict tie rank, earliest physical row tie, clock multiplicities and predecessor gaps. Import history and projections with stable original row identities, then validate all three materializations before attaching maintenance. |
| Neuron axon projections                    |     4 | `neuron_daily_axon_document_insert/update`, `neuron_daily_axon_member_insert/move`. Decode the actual SQLite binary JSON payload, preserve missing/null/scalar semantics and only update the exact affected member/day/shard. Imported member projections must be compared before activation.                                                                                            |
| Raw-capture accounting and archive release |     4 | `raw_capture_reserve/release`, `raw_capture_archive_source/release`. Preserve byte-budget accounting, source/archive eligibility, and release only the exact archived source. Concurrent updates need PostgreSQL row locks and an explicit serialization order.                                                                                                                          |
| Root-basket integrity                      |    21 | Replay conflict, page/fund/holding/target immutability, completion proof, receipt immutability and monotonic current-pointer triggers. Preserve the full completion census, chain/hash/decoder identity, cursor chain, equal-height conflict and unsigned lexical bounds. Serialize completion and writes on the same capture to prevent a concurrent write crossing completion.         |
| Surface alias preservation                 |     1 | `surface_status_alias_insert`. Preserve newer-observation refusal, old alias move and legacy-key removal. SQLite `RAISE(IGNORE)` needs an explicit PostgreSQL before-trigger return and locked conflict handling.                                                                                                                                                                        |

The four application views are `neurons`, `neuron_daily`,
`account_position_daily` and `_audit_neurons_20260922`. Each joins physical
member rows with document bytes. SQLite binary JSON is retained as `bytea` until
the reviewed decoder produces a verified projection. PostgreSQL `jsonb` does
not consume SQLite JSONB bytes. Dynamic member keys, including the uppercase
hexadecimal account key used by `account_position_daily`, must retain their
exact construction. Missing keys and JSON null currently become SQL null, and
SQLite JSON booleans project as 0/1. Those output types need explicit tests.

The fifth view, `retained.history_block_rows`, is implemented by the first slice.
It joins only active sources in the same network and left-joins author identity.
It preserves duplicate physical rows across source files.

## Type and query rules

- Signed SQLite integer values map to PostgreSQL `bigint` unless a narrower or
  boolean conversion has explicit data and caller qualification. Epoch values
  stay integer milliseconds. Wide unsigned/Q64 values stored as canonical text
  retain their lexical form and checks, including digit-count ordering.
- Ordinary text uses the source's bytewise comparison where identity or order
  matters. The retained identity/author keys explicitly use `COLLATE "C"`.
  Dates stored as text stay text until a separately qualified query port changes
  their representation. SQLite `TIMESTAMP` affinity in copied migration ledgers
  requires the source storage-class census to confirm exported timestamp text.
- BLOB data maps to `bytea` with exact bytes. Text containing NUL or other values
  PostgreSQL text cannot represent requires an explicit alternate storage/query
  port. It cannot be silently discarded or coerced.
- SQLite rowids used as identity require an explicit stable PostgreSQL key.
  `lane_health_current._history_rowid` is a concrete dependency. `ctid` changes
  on updates and is unsuitable for that role. Preserve original hidden rowids
  under the source-custody contract and reconcile the projection references.
- Each `INSERT OR IGNORE/REPLACE`, `json_each/json_extract`, date function,
  `INDEXED BY`, scalar min/max and null-safe comparison is ported at its query
  owner. PostgreSQL `IS NOT DISTINCT FROM`, explicit UTC arithmetic and explicit
  null ordering replace the corresponding semantics where required. A broad
  text substitution cannot establish equivalence.
- Preserve transactional scope across related statements. The D1 `batch`
  reads and guarded writes in retained sync need a single PostgreSQL transaction,
  with row locking or equivalent compare-and-set for each source/network.
  Separate pool calls cannot stand in for that transaction.

The old PostgreSQL snapshot and Neon migrations are useful evidence for column
history and established query forms. They predate the current physical document,
capture and revision tables and cannot initialize the complete destination by
themselves. [Legacy PostgreSQL DDL](../db/schema.sql),
[historical migrations](../migrations/neon)

## First complete schema slice

The first three migrations create copied source bookkeeping, the complete
retained domain, its actual view and an explicit sequence reconciliation step.
[Source metadata](../migrations/postgres/0000_source_metadata.sql),
[retained load schema](../migrations/postgres/0001_retained_blocks.sql),
[post-load sequences](../migrations/postgres/0002_retained_sequences.sql)

The retained source tables contain no foreign keys or user triggers. This slice
therefore adds neither. It retains all source checks, seven explicit indexes,
nullable payloads, source/author identity and `(source_id, ordinal)` keys. A
block hash or height cannot replace that key because different source files can
carry the same physical observation. The two identity sequences advance above
the imported maximum, legacy source sequence and already-consumed PostgreSQL
sequence values before native producers begin.
An exhausted signed-bigint high-water mark refuses activation before either
sequence advances. The runtime port must also qualify its accepted identifier
range against the public reader/writer contracts.

The real PostgreSQL integration exercises the actual migrations and verifies
the source view, inactive/cross-network exclusion, duplicate observations, null
authors, source metadata, sequence floors, all count/range constraints, atomic
publication effects, explicit null ordering and physical tie keys. It runs with
the established fixture database and immutable PostgreSQL 18.6 image.
[Integration test](../tests/postgres-retained-schema.pg18.ts),
[CI workflow](../.github/workflows/postgres-runtime-integration.yml)

The retained runtime port follows the existing normal entry points.
`handleRetainedBlocksSync` owns begin/chunk/publish/status behavior and HTTP
envelopes. `readRetainedBlockRows`, `readRetainedBlockObservedAt` and
`readRetainedBlockCensus` feed block handlers and watermark reconciliation.
The PostgreSQL capability keeps descriptor conflicts, exact chunk replay,
complete source census, monotonic publication and consistent reads in leased
transactions. Existing D1 selection remains available when the native capability
is absent. The native height-order migration names all cursor keys explicitly,
including null placement and physical source/ordinal ties. Its plan fixture
checks that the index can supply that order. Full-history latency, the complete
source import and production cutover retain their separate acceptance evidence.
[Sync owner](../src/retained-blocks-sync.ts),
[reader owner](../src/retained-blocks-d1.ts),
[PostgreSQL capability](../src/retained-blocks-pg.ts),
[cursor index](../migrations/postgres/0003_retained_feed_order.sql)

## Lane-health history and materializations

The lane-health load phase preserves original hidden SQLite rowids in
`app.lane_health.source_row_id`, with the complete signed 64-bit range. Import
history and all three original materializations before activation. The
activation transaction validates current-row payloads and source identities,
the timestamp/severity maximum, clock multiplicities and predecessor links,
and each verdict maximum. An imported current row may retain any existing
equal-time, equal-severity winner. Subsequent updates and winner deletions use
the source's ascending physical-identity tie break.

The generated clock gap is stored as `numeric`. SQLite performs exact integer
subtraction within the signed 64-bit range and promotes overflow by converting
both operands to binary64 before subtracting. `app.lane_health_gap` reproduces
that operation and stores the exact binary64 value as a numeric integer. The
private importer's explicit `sqlite_numeric` codec maps source INTEGER values
exactly and source REAL values from their binary64 value, while retaining the
original storage-class census. A cast of the exact mathematical difference to
binary64, or a direct PostgreSQL float-to-numeric cast, can produce another
value and cannot replace that codec or function.

Native writes take one history-wide advisory transaction lock before tuple
locks. The row-identity trigger retains explicit imported IDs, allocates the
largest ID plus one normally, and searches at most 100 positive random IDs
when the signed maximum exists. This preserves SQLite's non-AUTOINCREMENT
allocation behavior and permits reuse after the maximum row is deleted.
PostgreSQL transaction failures retain their normal rollback semantics.

[Load schema and functions](../migrations/postgres/0004_lane_health.sql),
[activation](../migrations/postgres/0005_lane_health_activate.sql),
[differential SQLite/PostgreSQL fixture](../tests/lane-health-runtime.pg18.ts)

## Root basket load and integrity

Migrations `0020_root_basket.sql` and `0021_root_basket_activate.sql` preserve
the seven Root basket tables and five explicit indexes. Capture IDs remain
source text; unsigned and signed quantities retain their canonical decimal
text and exact bounds, including the 128-bit limits. The source 0/1
`provisional` flag remains an integer. The old Neon numeric/UUID schema is not
the import target.

Activation validates every imported completion against its capture digest,
page chain and per-page/per-fund child counts, and validates current-pointer
scope before attaching six foreign keys and all 21 source trigger effects.
Completed observations and receipts reject even no-op updates. The original
source may choose a different first error when two immutable-write triggers
apply; both reject the statement atomically.

Seven additional statement triggers serialize family writes before tuple and
foreign-key locks. Native writers use `READ COMMITTED`; activation explicitly
rejects writes under a fixed transaction snapshot, whose stale view after a
lock wait could miss a newly committed completion. The fixture exercises both
directions of the completion/child-write race, replay conflicts, monotonic
current selection, failed activation rollback and decimal bounds. This is
schema preparation; it does not select a producer or move production data.
[Root basket integration](../tests/postgres-root-basket-schema.pg18.ts)

## Registry and surface-health load schema

Migrations `0007_registry_health.sql` and `0008_registry_health_activate.sql`
port all eleven registry/probe tables and their sixteen explicit indexes.
The four 0/1 source flags use the qualified `boolean01` codec. Source overlay
JSON remains text. `surface_history` retains original IDs and advances above
both its source sequence ledger and any consumed native sequence value.

The load phase leaves alias maintenance detached. The explicit activation
phase installs the source alias rule after loading. It serializes surface-status
writes before tuple acquisition, rejects a strictly newer conflicting observation,
moves the prior non-null alias to its history key and clears a superseded legacy
null alias. Nullable timestamps and equal-time observations retain their source
comparison behavior. The fixture compares this sequence with the actual SQLite
trigger and verifies rollback plus waiting-writer behavior on PostgreSQL.

This schema slice does not enable producer/read ownership. Native query and
process composition must explicitly select these tables after complete data
reconciliation and full API/runtime qualification.

The observation runtime accepts an explicit `OBSERVATIONS_STORE`, built by
`createPgObservations` from the process-owned pool. Probe batches, rollups and
pruning use a callback transaction with a transaction-local `app` search path.
The health prober's continuity reads and the observation read runner select the
same capability. Invalid explicit capabilities throw; an absent capability
preserves the existing selection path. SQLite differential fixtures exercise
alias replay, whole-batch rollback, the NULL/-1 failure-key collision and
uptime percentiles. This does not select a production writer or activate the
separate `subnet_snapshots` family; that path also requires its complete schema
and closed-day revision triggers.

## Account, usage and alert state

The account-state load migration preserves eleven source tables and their
fourteen explicit indexes. Account identifiers and timestamps remain signed
`bigint` values. Opaque credential, contact, condition and subscription text
retain their original bytes. The source `applied`, `active` and `success` flags
use the existing `boolean01` import codec. Account-kind composite keys continue
to distinguish RPC and GitHub accounts with the same numeric ID.
[Load schema](../migrations/postgres/0010_account_state.sql)

Delivery rows load before reference enforcement, so source export table order
does not become an import prerequisite. The separate activation migration
validates and adds the delivery-to-trigger foreign key with `ON DELETE CASCADE`.
It checks all seven identity sequence floors before advancing any sequence,
using imported rows, original `sqlite_sequence` metadata and consumed native
sequence values. Exhaustion or orphaned deliveries abort activation.
[Activation](../migrations/postgres/0011_account_state_activate.sql)

The PostgreSQL fixture compares source columns and explicit indexes, exercises
exact values, nullable fields, account-kind keys and partial uniqueness, and
checks sequence floors, orphan refusal, cascade deletion and rollback.
[Integration test](../tests/postgres-account-state-schema.pg18.ts)

## Subnet and economic history

The economic-history load migration preserves twenty source tables and their
thirty-one explicit indexes. It covers subnet parameters, identities, ownership,
lifecycle and emission history, plus price, revenue, compute, treasury and
attribution observations. Nullable and exact text values retain their source
representation. Boolean fields use the explicit `boolean01` codec, while
binary64 observations remain `double precision`. Compute-declaration JSON stays
text with object validation, preserving its original serialization.
[Load schema](../migrations/postgres/0012_economic_history.sql)

The separate activation checks all seven identity high-water marks before any
sequence advances. Imported IDs, retained source sequence rows and consumed
native sequence values all contribute to that floor. These tables have no
source foreign keys or user triggers. `subnet_snapshots` and the shared
`archive_export_revisions` table remain with the complete closed-day trigger
family, which has separate activation requirements.
[Sequence activation](../migrations/postgres/0013_economic_history_activate.sql)

The native fixture compares source columns, types, nullability and explicit
indexes, checks exact text and number storage, exercises source constraints and
uniqueness, and validates forward-only sequence reconciliation and exhaustion.
[Integration test](../tests/postgres-economic-history-schema.pg18.ts)
