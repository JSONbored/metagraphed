# PostgreSQL store composition

`createPgStoreRuntime` composes the existing SQL, read and producer contracts
over one bounded, process-owned PostgreSQL pool:

```ts
const runtime = createPgStoreRuntime(options);

// Hand only the capability each handler needs to that handler.
await loadTaoUsdSeries(runtime.read, { windowHours: 24 });
const rows = await runtime.sql<{
  id: number;
}>`SELECT id FROM items WHERE id = ${id}`;
await runtime.producer.transaction(statements);

// Read-check-write work keeps one lease and one explicit transaction scope.
const receipt = await runtime.transaction(async (tx) => {
  const row = await tx.first(
    "SELECT value FROM state WHERE id = ? FOR UPDATE",
    [id],
  );
  await tx.run("UPDATE state SET value = ? WHERE id = ?", [nextValue, id]);
  return row;
});

// After the process stops admitting requests/jobs, drain and close once.
await runtime.close();
```

All three capabilities share the pool's connection admission limit. A tagged
query and a row-reader query can therefore consume the same capacity that a
transaction needs; composing different interfaces does not create extra pools
or an unbounded waiter queue. A caller must handle capacity rejection explicitly.

Only the returned runtime has `close()`. Request-scoped code receives `sql`,
`read`, or `producer`; it cannot close the process pool through those contracts.
Shutdown rejects new operations and waits for admitted work through the existing
pooled runtime.

The callback receives `query`, `first` and `run`. Its scope closes when the
callback settles. Calls made afterward reject. All operations issued while the
scope was open settle before `COMMIT` or `ROLLBACK`, including issued promises
the callback did not await. An issued operation that fails causes rollback even
if the callback caught that error. A callback failure retains its original
error while pending operations drain. A failed commit retains its uncertain
outcome and discards the connection.

The optional isolation values are `read committed` and `repeatable read`. Both
are emitted explicitly at transaction start, so a role or database default
cannot silently turn a requested read-committed lease into repeatable-read.
The existing array-based `producer.transaction` uses the same transaction
lifecycle at `read committed`. Callbacks own their business-operation deadline
and use the provided methods for statements. The runtime owns transaction
terminators and connection release.

`createPgRetainedBlocks(runtime)` supplies the `RETAINED_BLOCKS_STORE` capability
used by the existing retained synchronization and read entry points. Supply
that single capability with the existing network and synchronization-secret
configuration so the retained family shares one owner. It uses source row locks
for chunks, a per-network transaction lock for publication, and repeatable-read
transactions for status, census and feed reads. The process still owns pool
closure after request admission stops.

`createPgLaneHealth(runtime)` supplies an explicit `LANE_HEALTH_STORE`
capability to the existing lane-health selectors. Caller-supplied test injection
keeps precedence, followed by this native capability and the existing D1 and
Hyperdrive choices. Each operation uses the shared pool's transaction runner,
sets the application schema for that lease, and checks the activated maintenance
triggers before reading or writing. Temporary tables cannot shadow the
application tables through this schema selection. Pool closure remains with
the process owner.

The native adapter uses the maintained current, clock and verdict projections,
retains the bounded housekeeping query, and exposes `source_row_id` as its
statement-local retention identity. Clock storage preserves exact integer and
binary64 source values. The public gap query converts the selected value to the
existing JavaScript number representation.

This is an explicit composition option. It changes no Worker bindings, default
store selection, table ownership, schema or public route. Production handoff
still requires a dependency-closed set of readers, writers and transactions.
These adapters preserve existing parameter and result contracts; they do not
translate arbitrary SQLite SQL into PostgreSQL or supply schema compatibility.

## Application KV

`createPgKv(runtime, namespace)` stores application KV values in
`auth.kv_entries`, separately from the imported application and retained
schemas. The `control` and `oauth-pending` namespaces use the same table with
independent keys. UTF-8 key bytes and raw payload bytes are preserved, including
NUL bytes. Text reads use the platform's replacement decoding, and JSON reads
retain ordinary parse failures.

The default limits are 25 MiB per value, 512 UTF-8 bytes per key, 1 KiB of JSON
metadata and 1,000 keys per list page. Callers may lower value, key and list
bounds. Stream writes use one bounded buffer and a configurable collection
deadline of at most 30 seconds. Cancellation starts on refusal without waiting
for the producer's cancellation callback. Lists use a bytewise
prefix/keyset range. Their versioned cursors bind the namespace, prefix and
last key. Expired rows are invisible to reads, listing and consumption at the
expiry second. Absolute expiry and TTL are mutually exclusive, with the
existing 60-second TTL floor.

`CONTROL_KV_STORE` selects this capability for wallet challenges and generic
control/registry reads. `OAUTH_PENDING_STORE` selects only GitHub's pending
authorization state. Native callbacks lock, validate and delete the value in
one transaction, so a concurrent request cannot consume the same challenge twice.
The existing legacy bindings remain available through their selectors.

## Native OAuth preparation

`node scripts/build-native-oauth.ts` deterministically bundles the lock-pinned
Workers OAuth provider 0.8.3 for Node 22, retaining its MIT notice and checking
the source bytes against the reviewed SHA-256. The builder rejects expanded imports and executable use of
`WorkerEntrypoint`; native composition supports object handlers. Load the
generated module with `loadNativeOAuthProvider(bundleUrl)`, then pass that module,
`runtime` and provider options to `createPgOAuthProvider()`.

The adapter uses the `oauth-provider` namespace in `auth.kv_entries`. Token and
registration endpoints, authorization completion, client mutations, grant
revocation, token exchange and purge each acquire one transaction-scoped
namespace lock before reading. They explicitly select READ COMMITTED so a
waiter sees the previous lock holder's committed grant even if the connection
defaults differ. Nested helper calls share that lease. Each operation creates
fresh helpers and environment objects; no closed transaction is cached.

The upstream provider retains crypto, PKCE, grant formats, expiry, current and
previous refresh-token acceptance, and response semantics. A replayed code can
deliberately revoke its grant while returning a 400 response, so client errors
do not automatically roll back. Server-error responses roll back. A failed SQL
statement also rolls back if upstream catches it. Bearer authentication uses
ordinary pooled reads and releases them before invoking application/MCP work.

This remains preparation, not a production replacement. The generated native
module supplies public-only metadata fetch for Client ID Metadata Documents
(CIMD) and enterprise issuer keys. It scopes that fetch and its compatibility
flag to each provider factory; it does not change global fetch or the ordinary
Worker entry. The loader and PostgreSQL adapter require the generated capability
before accepting options that need metadata fetching.

The fetch owner reuses the script DNS and connection-pinning implementation.
Every DNS answer and redirect is checked before connection; reserved and
non-public addresses are rejected. Each hop pins its validated address at
socket lookup. Metadata requests support GET/HEAD, retain ordinary response
status and headers, and strip credentials on a cross-origin redirect. A
10-second total deadline, five-redirect ceiling and 1-MiB decoded-body ceiling
bound the operation; callers may lower these limits. Completion closes the
dispatcher, while cancellation or failure destroys it even if a body producer
never completes cancellation. Cloudflare's edge HTTP cache is not supplied by
the native process; native serving latency still needs its own acceptance.
Upstream metadata checks during token mutations share the transaction lease,
so their bounded fetch time also counts toward namespace-lock occupancy.

Native rate limiting is a separate capability. `workers/tiered-rate-limit.ts`
owns tier/IP limiter selection and ordering; daily quota decisions remain in
`src/daily-quota.ts` with guarded `api_quota_daily` persistence in
`workers/data-api.ts`. Managed-key identity and OAuth account-tier caches retain
their freshness contracts. PostgreSQL OAuth storage does not replace the
Cloudflare rate-limit algorithm or alter failure/entitlement behavior.

## Queue transport

`createPgQueueTransport(runtime, limits)` uses the same process-owned pool for
bounded queue storage. The `jobs` schema keeps the six live/dead-letter policies
from the current Wrangler declarations. Startup refuses a different policy set
or capacity configuration. The caller supplies finite message/byte limits, a
lease duration, an execution deadline shorter than the lease, and a bounded drain
deadline. The database enforces the shared capacity, including parked messages. Applying its schema and running a consumer remain separate actions.

The returned bindings provide `send`, `sendBatch` and `metrics` for the existing
producer entrypoints. JSON is the default format. Text and `ArrayBuffer` payloads
also retain their bytes; unsupported V8 bodies fail explicitly. A whole
`sendBatch` is accepted or rejected in one transaction, with the existing
100-message, 128 KiB/message and 256 KiB/batch transport bounds. Delays are
bounded to 24 hours. Embedded webhook body strings are never reconstructed from
their parsed events.

`createPgQueueDispatcher(transport, { api, data })` routes sync batches and their
DLQ to the existing data process, and probe/webhook queues and their DLQs to the
existing main process. Its `run(queue)` performs one bounded pull without
installing a recurring poller or background service. Each process handle supplies
its normal `queue` method and receives the transport abort signal. The lower-level
transport `run` also accepts a consumer directly for explicit composition and
testing.

Claims are atomic and limited by the queue's batch size and active lease count.
An expired claim can be delivered again, so handlers retain their existing
at-least-once contract. A stale lease cannot settle another claim's messages.
The execution deadline aborts the consumer signal and freezes its acknowledged/retried decisions. A
late callback cannot change settled custody; an uncooperative callback retains
its local concurrency slot until it actually exits.
Successful handlers default to acknowledgment; handler or queued background
failure defaults to retry. Individual explicit decisions win over the batch
fallback and preserve their first decision, including retry delays. Native
queue invocations propagate background failures while retaining the existing
HTTP and scheduled-job reporting behavior.

Retry exhaustion moves the original payload, message ID and timestamp to its
configured DLQ and records the source attempt count. A DLQ begins its own attempt
count. If a queue without a further DLQ exhausts its budget, the original message
is parked durably instead of silently expiring. Existing DLQ consumers still
own acknowledgment and preservation policy. Parked custody continues to consume
capacity until an operator explicitly resolves it.

Stop admitting queue work and await `transport.close()` before closing the
native process or its shared pool. Transport closure drains its admitted sends
and deliveries. At the drain deadline it aborts consumers and rejects while retaining `closing` state if work
is unfinished; a later close can observe completion. It does not close the
database pool. No production queue binding, scheduler, fleet job or activation is supplied by this preparation layer.
