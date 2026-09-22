# D1 operational-state migration

Tracked by #12151; the first destination is watchdog history (#12152).

`D1_STATE_TABLES` selects the owner of explicitly qualified tables. A D1 binding
alone does not move a reader. Selected tables require the binding and do not fall
back to Neon if it is unavailable. A query that joins different owners is refused;
estate-wide freshness checks partition tables before constructing their queries.

## Watchdog history

Both the API Worker and Data API select `lane_health` in the same deployment.
All existing watchdog writers continue through `laneHealthStore`. The public
self-health response and alarm decisions retain their existing contracts.

The source history is retained. D1 also maintains these internal indexes in the
same transaction as each history mutation:

- `lane_health_current`: newest verdict per lane, with the existing worst-verdict
  rule for equal timestamps. Unknown verdicts rank between `ok` and `stale`.
- `lane_health_clocks`: distinct timestamps, duplicate counts and the preceding
  timestamp. Late arrivals split an interval; deletion rejoins it. Cadence reads
  exclude intervals that cross the requested cutoff and retain the three-sample
  minimum without counting the entire history.
- `lane_health_verdict_latest`: last timestamp per lane and verdict, allowing
  current finding runs to use indexed ranges rather than correlated full scans.

The native D1 adapter submits an entire transaction as one `batch`. It never
splits a failed capture into committed prefixes. SQL remains native SQLite SQL;
PostgreSQL-specific statements must be ported by their owners before selecting
another table. Wide integer binds are strings, and structured values require
explicit serialization. A statement may bind at most 100 parameters.

## Qualification and cutover

1. Apply `migrations/d1` to the destination with Wrangler. Keep ownership unset
   until both schema and data are ready.
2. Export `lane_health` through a read-only repeatable-read source transaction.
   Stream bounded batches into D1. `_source_tid` identifies imported source rows
   within this migration window; native destination writes leave it null.
3. Compare retained records by lane and verdict, including counts, timestamp
   ranges/sums, age sums and detail lengths. These are aggregate parity checks,
   not a cryptographic proof of every byte. Preserve the source for recovery.
4. Immediately before deploying the ownership switch, copy every latest source
   timestamp, including ties. Deploy both Workers, then repeat the latest copy
   and full idempotent catch-up after old invocations drain. Do not select deltas
   only by `checked_at`: producers can write backdated capture timestamps.
5. Verify live destination writes from API watchdogs and the Data API's poller
   receiver, current health responses, alarm-history query parity, and freshness
   census behavior. Record deployed version identities and query row-read counts.

Native Miniflare tests exercise the actual D1 migrations, transaction rollback,
retention, duplicate clocks, updates, deletes, unknown verdicts and comparisons
against the original history queries. Before cutover, a live seven-day cadence
comparison returned identical results for 77 lanes while reading 1,355 rows
instead of 809,183. The current-status query read 83 rows. These are measurements
of the qualification dataset, not fixed limits or account billing guarantees.

## Recovery

Prefer rolling forward with D1 ownership preserved. Changing the flag back to
Neon after destination writes begin would expose a stale source: first copy the
destination-only records back and verify the source's current status. Keep both
source history and migration evidence until the complete retirement is verified.

This slice does not retire the other Neon tables or any R2 SQL reader. Those
dependencies remain tracked by #12151; neither subscription nor credentials may
be removed on the strength of this watchdog cutover alone.

## Neuron capture documents

The neuron writer has a native D1 implementation, gated as one ownership group:
`neurons`, `neuron_daily`, `account_position_daily`, and `neurons_passes`.
This implementation does not select that group in deployment configuration.
All retained history and the additional tables used by joined readers must be
qualified before selecting it.

Migration `0007_neuron_documents.sql` exposes the existing relational columns as
views over JSONB documents and stable membership indexes. Neuron documents are
partitioned by subnet, day, and groups of 256 UIDs. Account position documents
use four deterministic account buckets per subnet/day; their history is separate
because replacing a UID must not erase the previous account's position.
Account document keys encode UTF-8 bytes, preserving strings with quotes and
Unicode without interpreting them as JSON paths.

Each member retains its own capture timestamp. A newer member replaces the old
record; equal or older captures leave it intact. A delayed previously unseen
member is retained even when other members in the document are newer. The
membership indexes are derived from accepted records and only update when
indexed identities change. Current-neuron pruning uses each subnet's cutoff and
never prunes either daily family. All document writes, membership changes,
pruning and the pass tally share one D1 transaction. The existing pass/prune
health verdicts remain observable.

Both SQL parameter batches and retained documents are bounded at 512 KiB.
Oversized input, oversized merged history, and an atomic batch exceeding 900
statements fail without committing a prefix. Producers must retry at their
existing explicit capture boundary; a failed capture must not be acknowledged
as complete. Initial membership/index construction has a one-time write cost.
Repeated metric updates write documents instead of rewriting every row/index.

Native Miniflare tests cover column/null fidelity, exact account history, late
and partial updates, equal-timestamp retries, pruning, multi-day partitions,
merged-size limits, and rollback when the final pass statement fails. Copy
retained source rows in bounded keyset pages and compare full normalized content
hashes. Measure broad aggregation queries separately before activation: indexed
point lookup performance does not establish the cost of history-wide rankings.

## Probe observations

Migration `0008_observations.sql` and the native observation writer cover
`surface_checks`, `surface_status`, `surface_uptime_daily`,
`surface_failure_daily`, and `subnet_snapshots` as one ownership group.
This implementation leaves ownership unset until retained data and joined
readers have been qualified. Read and write selectors both require the entire
family, and selected D1 operation does not require Hyperdrive.

A sweep commits its raw checks and latest statuses in one atomic batch. The
status insert trigger preserves displaced stable identities under history
aliases, rejects stale alias displacement, and retains measured `last_ok` as a
high-water mark. Retries do not duplicate raw checks. Oversized captures fail
before writing. Failures remain visible in the observation writer's verdict and
error log.

Daily uptime replacement deletes and rebuilds each requested day in the same
transaction. Native window functions preserve the latest identity, nullable
subnet metadata, success-only latency samples and nearest-rank percentiles.
Nullable subnet failure groups have an expression unique index so repeated
rollups update the same group. Snapshot flags preserve unknown, false and true.
The prober's existing successful-rollup requirement still gates raw retention.

Native Miniflare tests exercise alias changes, delayed probes, unknown success
timestamps, raw retry deduplication, percentiles, nullable failure groups,
snapshot provenance and rollback after an injected mid-batch failure. Copy
pages compare hashes of every normalized source column before accepting a
receipt; production ownership requires a final catch-up and live readback.

## Subnet and identity captures

Migration `0009_subnet_identity_state.sql` retains the latest/history pairs for
subnet hyperparameters, subnet identity, subnet ownership and account identity,
plus burn history and lifecycle. The wide raw hyperparameter integers use
decimal TEXT; timestamps, block numbers and generated IDs use integer columns.
Copy source IDs before activation and reserve space above the source sequence
for destination appends while the final source writes drain.

Each latest/history pair selects D1 together. Native captures submit every
bounded payload chunk and optional ownership-card prune as one transaction.
Latest cards retain the newest capture, content-keyed history retains the
earliest observation, and an empty ownership key set never deletes the card.
Oversized rows, unsupported values and oversized transactions report failure
without committing a prefix. The existing lane verdict remains the record of
whether the capture landed.

The Data API's history-diff and historical-backfill paths select the same store
as the family writer. Lifecycle's latest-event query uses a portable window
function; burn capture already uses portable atomic statements. Native tests
exercise real schema constraints, wide/null values, chronological guards,
ownership pruning, injected history failures, multiple payload chunks and
authenticated capture/backfill routes without Hyperdrive. This implementation
does not select production ownership; shared serving readers must also be
qualified before moving these families.

### Ledger captures and completeness

`0010_ledger_state.sql` retains the account balance, hotkey alpha, validator
nominator count, and nominator position schemas, their pass tables, and full-scan
receipts. Nominator shares remain decimal TEXT; only the derived share fraction
uses floating point, matching the served contract.

Selected writers send native SQLite transactions directly to D1. Each transaction
includes all data chunks, source-scoped pruning, scan receipts, and the pass tally.
A failure in any member rolls back the entire delivery. Hotkey alpha still stores
only pools referenced by nominator positions. Capture guards prevent delayed
readings from replacing newer values, and replayed scan receipts replace their
payload count instead of adding it. Pass tallies retain the existing at-least-once
accounting contract. Fraction normalization only visits pools affected by a chunk,
while including earlier chunks of that capture in each pool's denominator.

The migration does not select these tables. Copy every retained row and receipt,
qualify the joined readers and final source drain, and then select each complete
group through `D1_STATE_TABLES`. The hotkey alpha writer also requires nominator
positions to belong to D1; mixing owners fails explicitly.

## Shared serving readers and economic references

The Data API's neuron routes and directory materializer select the entire joined
family together: neuron documents and passes, subnet snapshots, ownership,
hyperparameters, nominator counts and positions, TAO/USD observations, and treasury
readings. Identity and hyperparameter routes select their latest/history pairs;
the health continuity route selects surface status. Independently loaded compute
declarations and cached identity cards retain their own selectors. An incomplete
ownership group is an error, never permission to read a stale Neon copy.

Migration `0011_economic_reference_state.sql` preserves price observations,
treasury readings, daily concentration cards, and revenue observations/failures.
The price producer writes directly to selected D1 with the same immutable
observation key. Shared queries use a native window function for the latest subnet snapshot
and bounded indexed lookups for the last priced sample per UTC day. An unpriced sample does not
erase a measured price from that day.

`0012_neuron_daily_join_index.sql` indexes stable membership by subnet, day and
document shard. This prevents a daily-document join from rescanning the subnet's
entire membership history once per document. On the qualification copy, the
price-query and join-index changes reduced one subnet's 30-day emission-history
request from 787,730 to 24,029 D1 rows read. Completed-day response values matched
the source exactly. These are dataset measurements, not billing guarantees.

Populated native D1 tests exercise the same public handlers, joined economics,
history, identity and health reads, and directory publication with no Hyperdrive
binding. This slice keeps production ownership unchanged while retained copies
and source drains finish; serving ownership must move with the corresponding
writers after live read parity and broad-query costs have been checked.

## Registry mutations and self-health

Migration `0013_registry_self_health.sql` retains provider, subnet and surface
metadata, the full surface audit history, individual self-health observations,
and daily health summaries. Registry ownership selects all four registry tables
together; self-health selects its two tables together across the producer, REST,
GraphQL and MCP. The registry Worker also binds D1 and selects the already-moved
`lane_health` family, so its scheduled probe reports to the same watchdog store.

Native registry writes preserve stable surface IDs, unchanged provenance, scoped
prunes, and every changed overlay in delivery order, including duplicate-key
reversions within a payload. Audit rows and mutations commit atomically. JSON
chunks contain at most 100 rows and 512 KiB; oversized rows or transactions above
900 statements fail before writing. Self-health commits an immutable tick and its
daily contribution together; retrying a tick does not count it twice. A failed
tick rolls back its daily increment and remains visible as stale capture. Latest
component reads use indexed maxima and normalize SQLite boolean values before
building the shared response.

Retained copies and native transaction tests do not select production ownership.
Before activating these families, reserve generated history IDs above the live
source sequence, reconcile mutable registry cards, and record source daily-health
baselines. After old invocations drain, import immutable tick tails and add only
the source daily deltas to the destination; replacing a destination daily summary
after its own probes begin would erase observations. Verify the registry Worker's
lane-health records as well as the API and Data API before retiring the source.

## Recent block detail and large payloads

Migration `0014_recent_chain_state.sql` provisions recent block headers and all
four chain-detail tables. Select `blocks_head` and the complete chain-detail
family together after copying and catching up retained rows: block-list readers
join headers to the detail coverage register. This migration does not select
ownership or change the existing retention policy.

The HTTP sync and queue consumer share one native D1 transaction. Detail rows
and their coverage register either all commit or all roll back. A failed queue
write requests retry; it must never acknowledge the message merely because the
writer returned an error result instead of throwing. A failed D1 resume query
returns 503, keeping it distinct from a verified empty register.

Decoded argument JSON above 128 KiB is stored in immutable R2 objects before the
D1 transaction. Gzip is used when it reduces size. D1 retains an opaque reference;
readers restore the original UTF-8 bytes and verify their SHA-256 digest. This
keeps valid multi-megabyte calls readable without exceeding D1's row limit.
Both serving Workers require the `METAGRAPH_ARCHIVE` binding. Missing objects,
invalid references, corruption, and expansion beyond the declared size fail the
read rather than returning truncated arguments. Values are bounded at 16 MiB
and hydration at 32 MiB per query. The reader also supports the uncompressed
references used by the initial retained-history copy.

Keep the source history and immutable objects until copy receipts, reader
qualification, final catch-up, and ownership readback complete. Never prune a
history interval solely because its source rows were copied: its indexed archive
must be readable before the recent tier can release that interval.

## Archive export source

Migration `0016_archive_export_revisions.sql` supports the existing state mirror
and daily rollup jobs through `POST /api/v1/internal/state-export`. Provision a
dedicated `STATE_EXPORT_SECRET` in the Data API and the archive producer. Requests
send it in `x-state-export-token`; public API keys do not grant export access.
The endpoint accepts fixed table names and operations, never SQL. All 31 state
mirror tables and three daily families have explicit keyset plans.

`src/d1-export-columns.ts` independently approves every exportable column.
A storage migration adding a public column stops that table's export until its
disclosure policy is reviewed; private underscore-prefixed columns are never
exposed. Neither schema discovery nor possession of the export credential can
expand this list automatically.

Apply the migration before enabling `D1_EXPORT_REVISIONS` on every writer Worker.
The selected store increments each affected export table's revision once per
transaction, atomically with its data. Price and lifecycle writes use that same
mutation path. Deploy and drain older writer versions before enabling a consumer;
an untracked writer or migration copy invalidates the revision guarantee.

The client reads at most 2,000 rows per page, with a 2 MiB row payload budget.
Rows and their revision share one D1 batch. A cursor requires the expected
revision, and the producer checks that revision again before publishing a whole
snapshot. Concurrent changes return 409 so the producer discards partial data and
retries within its bounded budget. Repeated changes fail the export explicitly;
they must not publish a mixed snapshot or advance its history watermark.

Schema responses retain logical booleans, JSON, dates and decimal values. Daily
counts use membership indexes; row exports retain the original column shape.
Missing ownership, credentials, revision tracking or D1 availability fail closed.
The endpoint never opens Neon or queries R2 SQL.

This route does not activate any additional table owner. Complete the final
source copies, select each qualified family, and measure full exports under live
writer traffic before switching the existing archive jobs to the D1 endpoint.
Keep the previous immutable archive and its version/day receipts throughout the
cutover. This change adds no database or compute service.

### Completed root-basket captures

The same authenticated endpoint accepts `kind: "basket"` with `ceiling`,
`discover`, and `rows` operations. Every request names the exact network,
genesis hash, and decoder. Discovery returns at most 64 completed capture IDs;
row reads are limited to 500 rows and 2 MiB per page. Only fixed tables and
explicitly approved fields can be exported. No caller supplies SQL or columns.

Each page joins the capture to its immutable completion receipt and scope.
Uncompleted or foreign captures expose no rows. All seven native capture tables
must be owned by D1. Integers cross the boundary as decimal strings, including
small counts; the archive client validates their ranges while reconstructing
the original canonical bundle. It verifies page/fund/child counts and the stored
observation digest before publication. This protocol relies on completed-row
immutability, so unrelated new captures do not invalidate an existing export.

Native tests exercise scoped discovery, exact numeric extremes, replay
provenance, multi-page children, unapproved columns, and failures. A local HTTP
interoperability check also runs the Python archive client against the native
D1 writer/exporter; all four canonical receiver vectors produce byte-identical
archive bundles. Production ownership and source retirement still require the
final capture census and export qualification.

Migration `0017_root_basket_export.sql` provides the scoped capture-ID index for
ceiling and discovery reads, including empty scopes. Apply it before enabling
the archive consumer; native query-plan tests reject table scans and temp sorts.

## Complete application ownership

The final ownership configuration selects all 71 application tables on the API
and Data API, and the registry plus self-health families on the registry Worker.
Neuron ingestion and backfill require the complete native family, including its
pass ledger. Analytics cache eligibility and the health heartbeat recognize the
selected D1 store even after Hyperdrive is removed.

Before applying this configuration, complete retained/current reconciliation and
reserve generated history IDs above the source sequences. Record the current
pass and daily-health baselines, then reconcile late source writes after the old
invocations and buffer drain. Preserve newer D1 captures and add only source
counter deltas to daily health; an old-source overwrite would erase new data.

Hyperdrive remains available for this final drain. Archive consumers switch only
after their required tables are owned and migration writes stop, so revision
checks describe every concurrent mutation. Removing the credentials follows live
read/write and archive qualification; ownership alone is not proof of retirement.
