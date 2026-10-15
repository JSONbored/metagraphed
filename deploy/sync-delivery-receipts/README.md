# Stable bulk delivery qualification

This source contract fixes additive completeness accounting for newly identified
deliveries. It is not an applied migration, deployment, redrive authorization or
proof that historical data is complete. Both SQL files are qualification inputs.
Number the actual migrations only after reconciling held 0039–0043; do not create
placeholders, overwrite an applied migration or add these tables to production
configuration during source qualification.

The owner of legacy lane business delivery is `sync-delivery-receipt.ts`. Alpha
and self-stake finalized snapshot staging retain their existing specialized
owners, census and promotion rules. Raw capture publication receipts retain
ownership of immutable originals. A generic delivery receipt proves its exact
accepted source payload committed with the required writes; it does not prove
the current latest-only tables still contain an older pass, that the scan was
chain-complete, or that a finalized state snapshot can be reconstructed.

## Wire and accounting

Producers globally sort unique business keys before deterministic whole-key
packing. Identity hashes lane, capture, pass census and ordered keys. Content
digest additionally pins the exact scalar payload, using versioned binary
encoding shared by Rust and TypeScript golden vectors. Strings stay strings;
null/absent object cells normalize together, booleans normalize to 0/1, finite
numbers use big-endian IEEE754 and negative zero normalizes to zero. Lone JavaScript
surrogates are refused, matching Rust's valid UTF8 strings. Receipt identities and
hex key intervals use explicit binary/C collation in both qualification schemas.

V1 POSTs carry `delivery_rows`, `delivery` and `pass_total`, deliberately omitting
legacy `rows`. An old receiver rejects this shape before writing. The receiver
verifies the producer identity/digest before projection, echoes the original
identity in `delivery.parent_id` / `parent_sha256`, and pins that parent on every
queue fragment. An HTTP response naming `stores: ["queue"]` acknowledges queue
acceptance only. The consumer owns the committed business receipt.

The receipt, all required data/prune/normalize/coverage statements and tally
commit in one native transaction. PostgreSQL uses the existing pinned
`ProducerStore`, never the per-statement buffer. A pass row serializes concurrent
writers; immutable census, parent digest and nonoverlapping key intervals are
checked before business statements. A duplicate aborts its attempted transaction
and succeeds only after matching the complete already-committed receipt.
Changed payload, census, parent digest or overlapping repacking fails closed.
Changing packing limits therefore may require repair; it never recounts rows.

Receipts have no automatic expiry. Deleting them without durable rejection
tombstones invalidates replay safety. Measure their growth and index/backup
cost before choosing a retention policy. Qualify an isolated restore of both
business data and receipts before accepting replay after recovery.

## Compatibility and activation gates

Unidentified deliveries remain `legacy-ambiguous`. Existing row/API semantics
remain compatible; neither successful UPSERTs nor old completed tally rows are
retroactively certified. An identified pass refuses to adopt preexisting legacy
credit under the same capture. Qualification triggers also reject later legacy
additive credit on an identified pass. These guards do not convert arbitrary
unlabelled row writes into immutable snapshots.

`SYNC_DELIVERY_V1_READY` is absent by default. Both HTTP acceptance and the
actual queue consumer fail closed for identified messages until an operator
explicitly sets it to `"true"` after recording qualification and old-consumer
quiescence. The flag itself is not proof. Concurrent first legacy/identified
PostgreSQL publication remains outside the guarantee: a legacy writer does not
share the identified pass lock and may already have committed a per-statement
row write. Qualification triggers do not repair that race. Do not activate
without verified quiescence of those old writers.

Before any activation, qualify both SQL dialects and actual concurrent PG
connections, confirm capacity for receipts/indexes/WAL/backups and encoding CPU/peak memory at
the authenticated route caps, obtain independent
review, and record the exact receiver/schema versions. Deploy and verify the
receiver/consumer first, quiesce old consumers, and require the producer's explicit
capability echo. Never enable new producers against old consumers: those may
ignore extra queue fields. A resulting legacy tally is deliberately not adopted;
it needs explicit repair or a fresh proven scan, not automatic redrive.

No legacy DLQ redrive, purge, DDL application, producer rollout or recovery claim
is authorized by these source files. A rollback after any identified delivery
must preserve its receipts and accounting guards; returning to an additive old
consumer is not a safe rollback. Delayed older passes retain the existing latest
table/read selection limitations and must not be presented as coherent snapshots.
