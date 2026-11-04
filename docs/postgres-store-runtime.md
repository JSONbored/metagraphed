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
bounds. Stream writes count bytes before storage, and lists use a bytewise
prefix/keyset range. Their versioned cursors bind the namespace, prefix and
last key. Expired rows are invisible to reads, listing and consumption at the
expiry second. Absolute expiry and TTL are mutually exclusive, with the
existing 60-second TTL floor.

`CONTROL_KV_STORE` selects this capability for wallet challenges and generic
control/registry reads. `OAUTH_PENDING_STORE` selects only GitHub's pending
authorization state. Native callbacks use one atomic delete-and-return
operation, so a concurrent request cannot consume the same challenge twice.
The existing legacy bindings remain available through their selectors.

The Workers OAuth provider's client, grant, code and refresh-token records have
a separate transaction boundary. Its read-modify-write grant transitions and
token rotation require request-level transactional qualification before native
selection. Supplying a KV-compatible object alone does not establish that
qualification, and this capability does not select the provider's `OAUTH_KV`.
