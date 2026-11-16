# Native registry and control state

The native application selects three control-state capabilities from its
verified PostgreSQL source. None of these factories opens a pool, starts a
timer, applies a migration or changes a Worker default.

`REGISTRY_SYNC_STORE` provides the registry mutation operation. Its PostgreSQL
factory calls the same transaction body as the existing PostgreSQL writer,
including pruning, provenance history, repeated logical keys and rollback.
The caller's scoped runtime owns the transaction and its connection. A shared
transaction lock serializes native registry batches, preserving the source's
behavior when concurrent requests introduce the same surface and its history.
Native selection happens before D1/Hyperdrive availability checks, and the response
retains the existing PostgreSQL response shape. The original connection-owning
writer remains the Worker path when native ownership is absent.

`GENERATED_ARTIFACT_STORE` provides mutable registry snapshots through
`createPgGeneratedArtifactStore`. Missing, unreadable or invalid snapshots keep
the existing cold-read behavior. A write returns successfully only when its
own key is acknowledged. The table remains `app.generated_artifacts`, shared
with the separately selected archive catalog where appropriate.

The container-lane watchdog reads its five status keys from this selected
store with a 64 KiB per-document bound. Missing, failed or oversized native
reads remain unavailable statuses; they do not expose an older D1 or archive
status. Other snapshot consumers can also supply an explicit byte limit.

`SELF_HEALTH_STORE` supplies both the self-health SQL reader and the probe's
atomic tick writer. The writer adds a daily contribution only when it inserted
a new immutable tick, preserving the current D1 retry behavior. A failed daily
update rolls back that tick. Repeating a tick with a different outcome does not
replace its original result or add another contribution. The factory's reads
and writes use the same runtime and schema; no independent connection is
created by a reader. Probe HTTP behavior remains with the existing prober.

The final environment manifest must select these complete capabilities and
their source relations together. This source preparation does not establish
historical transfer, credentials, production ownership or activation.
