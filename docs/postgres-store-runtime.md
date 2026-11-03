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

This is an explicit composition option. It changes no Worker bindings, default
store selection, table ownership, schema or public route. Production handoff
still requires a dependency-closed set of readers, writers and transactions.
These adapters preserve existing parameter and result contracts; they do not
translate arbitrary SQLite SQL into PostgreSQL or supply schema compatibility.
