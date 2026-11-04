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

## Native authentication controls

`createNativeAuthControls(runtime, definitions, onError)` composes explicit
rate-limit bindings, `CONTROL_KV_STORE` and `DAILY_QUOTA_STORE` over the same
bounded pool. The final native process must call `assertEnvironment(env)` after
building its environment and before admitting requests. It checks that every
declared binding is the exact handle created by this composition. It does not
claim that undeclared capabilities are ready or change Worker defaults.

Each rate definition supplies its existing binding name, ceiling and 10- or
60-second period. The first operation persists that binding's immutable ceiling
and period; every admission and housekeeping call checks the same identity
before touching counters. Conflicting process definitions fail closed. Policy
creation commits in a separate short transaction before any caller-key lock;
even a blocked first caller cannot hold that policy row across unrelated keys.
Successful initialization is reused, but every mutation still verifies the
immutable stored policy. Policy changes
require an explicit migration. Admission serializes each binding/key with a
transaction lock and PostgreSQL's clock. Per-second buckets retain the entire boundary
second: this is a conservative rolling window that may retain traffic for up
to one extra second, not Cloudflare's distributed approximate algorithm. A
rejected admission spends nothing. Operational failures report through the
required `onError(error, binding)` callback and return `{ success: false }`,
including when the reporter itself throws. Existing public rate-limit responses
remain owned by the caller. Invalid definitions and keys throw before admission.
The process's existing housekeeping scheduler must call `pruneExpiredRates()`;
each call deletes at most its explicit budget (default 1,000, maximum 10,000).
The adapter starts no timer and does not close the pool.

Daily quota writes use one locked transaction for each account kind, account
ID and UTC day. The actual D1 composite-key UPSERT applies INTEGER affinity
before conflict arithmetic: INTEGER operands add exactly until int64 overflow;
REAL and overflow operations use binary64. The native adapter preserves that
operation, its mixed INTEGER/REAL comparison, and the existing separate response
calculation. PostgreSQL `numeric` stores exact resulting source values. The
storage-sensitive import codec keeps INTEGER at scale zero and integral REAL
values at nonzero scale, so the next write retains the same arithmetic. A plain
rowid-primary-key UPSERT has different affinity timing and cannot substitute for
the actual quota table in these tests. Migration 0010 declares the numeric
columns for source-only imports; 0028 retains the conversion for existing
schemas and adds native rate buckets after auth bootstrap. A first cost larger
than the day's limit touches no database. The internal HTTP handler selects
`DAILY_QUOTA_STORE` explicitly and retains its existing write-failure response.

`workers/tiered-rate-limit.ts` retains identity precedence, blocklist-before-rate
ordering, per-minute-before-daily ordering, and MCP's deferred tool cost.
Managed-key identity, OAuth account-tier and blocklist reads use the explicit
native control KV when supplied. Their positive/negative TTLs and fresh key
revocation checks remain unchanged. This preparation does not enable a native
process, migrate account rows, or activate any production binding.

## Native alert evaluation preparation

`createNativeAlerter(runtime, options)` wraps the existing `AlerterHub`
evaluator. It takes explicit internal-data and notification capabilities,
finite concurrency and body limits, an execution deadline shorter than its
lease, a renewal interval below one third of that lease, and a bounded drain
deadline. Migration `0037` adds the singleton ownership row in
`realtime.alerter_owner`; the source actor has no durable storage or alarms to
import. A fresh owner starts fresh trigger and metric caches and delivery
reservations, as a reconstructed source actor does.

Configuration caps four times the summed in-flight request and response byte
limits across evaluation, internal-data and delivery concurrency at 64 MiB.
This includes collection/copy headroom; it does not substitute for measuring
the source caches and decoded-object memory during placement qualification.

The owner uses short READ COMMITTED row-lock transactions for claims and
renewals. No transaction remains open during DNS, internal HTTP or delivery.
The local deadline conservatively subtracts the database round-trip duration.
Each effect checks cancellation and renews ownership first; late or failed
renewal retires the evaluator. A stale owner cannot release a successor's
token. `close()` stops admission, cancels active work and drains before release;
the process retains ownership of the shared PostgreSQL pool.

`createNativeAlertOutbound` supplies the concrete POST transport. It validates
all DNS answers, pins a vetted public address while preserving Host/TLS
identity, retains authentication headers and request bytes, and does not
follow redirects. Its finite deadline and request/response byte bounds apply
while buffering. It rechecks the evaluator's ownership fence immediately
before sending, then closes or destroys the per-request dispatcher.
Native request and response collectors cap chunk counts at 65,536 and yield
every 128 reads so tiny or empty chunks cannot prevent cancellation and lease
timers from running. The shared request collector retains the caller's existing
byte limit, including larger ingress limits.

The shared evaluator retains attempted-delivery and rate-limit counts,
optimistic delivery reservations and failure rollback, stale-cache behavior,
and best-effort match/delivery writebacks. The native environment copies only
the explicitly supported delivery secrets; it cannot enable ambient telemetry
through unrelated environment fields. Missing optional channel credentials
retain source behavior. This constructor opens no listener, sends no startup
notification, and does not activate a Worker binding or production owner.

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
queue invocations propagate background failures. HTTP background failures retain
their report-only behavior; the scheduler section below describes scheduled results.

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

## Cron scheduler preparation

`NATIVE_CRON_DEFINITIONS` derives all 36 current cron strings from the API, data
API and registry-sync owners. `parseNativeCron` accepts the UTC syntax actually
used by that grid: wildcard calendar fields and minute/hour integers, lists,
wildcards and steps. Other syntax fails explicitly. The existing handlers remain
the business-logic owners; no handler body is copied into the scheduler.

`createPgCronScheduler(runtime, definitions, limits)` uses the process-owned pool
and an explicit finite policy in migration `0030_cron.sql`. Constructing it
installs no schedules. The caller must deliberately call `register(startAtMs)`
with an inclusive UTC start boundary, then call `plan()` and `run(...)` or the
`createPgCronDispatcher(scheduler, { api, data, registry })` dispatcher. Each
method does one bounded operation. There is no timer, poller, process launcher or
production entry point. Registration is idempotent only for the same inventory
and start boundary; a changed policy or an incomplete/foreign stored inventory
fails closed. Retiring or changing a registered schedule requires a separately
reviewed migration.

Planning uses database time, advances a durable per-schedule cursor and selects
only the latest due occurrence. An older pending slot and any intervening due
slots become skipped receipts with their first/last UTC slot and count. One
pending slot can wait behind each active schedule. This is deliberate latest-due
coalescing: current handlers observe current time and do not consume the old
`scheduledTime` as historical input, so executing missed ticks would not backfill
historical observations. Native events provide the exact `cron` and selected
`scheduledTime` fields used by the current handlers. Other Worker event features
are not implied.

Claims have unique `(owner, cron, scheduledTime)` identity, a fresh fencing token,
and a database-enforced global concurrency limit. Each schedule has at most one
running lease. An expired lease can be reclaimed up to the finite attempt limit;
exhaustion leaves a durable `lease-exhausted` receipt. A stale token or expired
lease cannot record completion. Existing producers must remain safe for
at-least-once execution because fencing cannot undo side effects performed
before a process loses custody. Normal handler completion, a domain decline
(`ok: false` or `skipped: true`), handler exception, background failure and abort
are separate outcomes. Ordinary declines and completed failures are terminal for
that occurrence; only an abandoned expired lease is redelivered. A later
regular tick remains eligible.

Native process `scheduled` calls return the handler's result and wait for its
background work. A background failure throws `NativeScheduledBackgroundError`
with the original result and cause. The scheduler returns that result/error to
its caller but stores only the outcome and optional boolean `ok`/`skipped` flags,
never raw results or exception text. The execution deadline is shorter than the
lease; abort freezes the recorded outcome even if a handler returns late. An
uncooperative handler continues to consume its local concurrency slot until it
exits. Stop scheduler admission and await `close()` before closing its supplied
processes or pool. A failed drain retains `closing` state and can be awaited
again. The scheduler never closes the shared pool.

`historyLimit` bounds each schedule to that many recent skip-window receipts and
settled occurrence receipts, plus at most one active occurrence. The schedule's
lifetime skipped count survives receipt pruning. Exact old slot ranges beyond
that explicit retention limit are not retained; operators must export them
before pruning if a future retention policy requires a longer audit trail.

Durable Object alarms remain separate work. Chain firehose, write-buffer and MCP
session actors need their own durable state, serialized callback and
WebSocket/session semantics; generic cron rows do not replace those actors.

## API bootstrap and KV ownership

`createNativeApiProcess` accepts explicit KV capabilities or a `kv({ sources })`
factory. The factory runs after database source ownership is verified and before
application composition. It receives the same scoped handles as the application,
so PostgreSQL-backed control and OAuth-pending KV can use the process-owned pool
without a second pool or a deferred proxy.

Both factory results must provide the complete KV interface. A factory error or
incomplete result refuses startup and closes the owned pool. Source ownership
failure prevents the factory from running at all. The factory adds no listener,
timer or production activation; the process owner still drains before closing.
