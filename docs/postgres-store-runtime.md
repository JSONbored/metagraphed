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

The optional isolation values are `read committed` and `repeatable read`.
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
Workers OAuth provider 0.8.3 for Node 22, retaining its MIT notice and source
digest. The builder rejects expanded imports and executable use of
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

This remains preparation, not a production replacement. The current Worker
options enable Client ID Metadata Documents (CIMD), which require Cloudflare's
public-only fetch protection. The native adapter explicitly rejects those
options, and the optional enterprise issuer fetcher, until a qualified native
public-fetch capability exists; it does not
silently disable URL clients or pretend that Cloudflare's safety flag exists.
The [public-fetch follow-up](https://github.com/JSONbored/metagraphed/issues/13020)
owns that remaining boundary. The ordinary Worker entry point is unchanged.

Native rate limiting is a separate capability. `workers/tiered-rate-limit.ts`
owns tier/IP limiter selection and ordering; daily quota decisions remain in
`src/daily-quota.ts` with guarded `api_quota_daily` persistence in
`workers/data-api.ts`. Managed-key identity and OAuth account-tier caches retain
their freshness contracts. PostgreSQL OAuth storage does not replace the
Cloudflare rate-limit algorithm or alter failure/entitlement behavior.
