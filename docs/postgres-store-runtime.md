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
