# Native RPC archive retention

The native public-pool usage producer stores the complete source event in
`app.rpc_usage_events`. An age cutoff alone is insufficient to delete it: the
archive exporter must first commit and read back a complete UTC day, then record
its source row count/fingerprint, Iceberg table UUID and committed snapshot ID in
`app.rpc_usage_archive_days`.

The fingerprint is defined once in PostgreSQL by
`app.rpc_usage_day_fingerprint(date)`. It includes the exact UUID, epoch
milliseconds, raw JSON-quoted identities, pool/cache, boolean, float8 bits and
integer sample weight in deterministic event-ID order. It includes the day in
its hash domain and enforces a 250,000-row/64 MiB day bound and 16 KiB row bound.
This function is `VOLATILE` so a second call after deletion in the same function
observes the new command state.

`app.rpc_usage_record_archive` uses READ COMMITTED and locks the source before
receipt rows. Identical receipts are replayable, including after partial
pruning. A concurrent first receipt uses insert-on-conflict plus locked readback,
and cannot replace another archive identity. New receipts must match the current
source fingerprint. Receipt creation does not delete data.

`app.rpc_usage_prune` holds a source write lock, verifies the stored remaining
count/fingerprint, deletes at most 10,000 total events, recomputes the remainder,
and updates the remaining receipt in one transaction. A late insert, changed
row, missing receipt or incompatible source prevents public deletion. At most
eight eligible receipt days are examined per call. A durable cursor rotates
past stale days so they cannot permanently hide later qualified days; stale
source remains available for explicit reconciliation. Original archive identity/count/hash never change.

Fullnode usage belongs to a separate population and is not in the public archive
series. Its prior age-based retention remains explicit, sharing the 10,000-row
per-call deletion budget. Public receipt policy does not redefine that population.

These migrations and runtime changes are preparation. They do not apply a schema,
run retention, move data, deploy a service or authorize retirement. The private
exporter must also prove that its archive schema preserves native float values;
a lossy target must retain the PostgreSQL source without recording completion.
