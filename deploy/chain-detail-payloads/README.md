# Native payload publication and finite retention

Prepared schema only. No workflow applies this bundle, sets a quota, deploys a
Worker or deletes data. The capacity and physical-schema gates remain held.

The native writer requires this held schema for chunked captures. It stages exact
chunk statements and business references, then
commits them with all four families in one existing D1 batch. All statements
count against the same900 ceiling; every statement retains the100-bind ceiling.
Existing parts must have identical bytes. Extra parts fail the same transaction.
A late failure rolls back newly inserted parts, references, coverage, revisions
and quota accounting. No catch-path deletion can damage a concurrent shared hash.
A different compressed representation for the same logical hash is refused and
requires explicit verified representation migration; it is never overwritten.

The schema bundle maintains a single encoded-byte counter through database
triggers, counting unique committed parts, including retained orphans. Its limit
starts at0 and must be explicitly chosen from measurements. Exact replay uses
no new quota. A replacement requiring extra retained bytes can fail before any
business change if headroom is absent. Provisioning and source activation must
be coordinated; a chunked capture refuses a missing quota schema. Inline/small
payloads keep their current behavior. Before enabling, verify the quota trigger
set, actual census/counter agreement, backup closure and replacement headroom.
This is an encoded-storage admission bound, not a physical-size, RAM or latency
claim. Malicious/administrative bypass of triggers is outside this writer's trust
boundary. Restores must recompute/verify the counter, rather than double-apply it.

There is deliberately no automatic chunk deletion. Successful replacements and
row retention can leave old parts, but they stay charged to the finite quota.
This preserves already-selected/in-flight rows: hot row selection and chunk
hydration are separate reads today. A zero-current-reference GC could delete a
chunk between those reads. Reclamation requires a separately qualified coherent
read or lease/snapshot protocol and private restoration proof. Until then, an
exhausted quota is explicit admission failure and requires operator recovery;
it does not justify increasing a limit or unsafe cleanup. Old unreferenced parts
are counted by the explicit initial census; that full scan's cost is an
application gate, not something CI or this preparation executes in production.

Private whole-source restore must carry the business rows, native chunk parts
and all referenced legacy R2 v1/v2 originals. Verify exact part census/order,
stored bytes, raw-byte SHA256, decompression limits and row-reference closure
before selecting the restored owner. Derive the quota counter from restored
parts with writers held. A public four-table projection is not that backup.
Do not widen public export to expose private control or closure state.

## Prepared reader-safe reclamation

The successor reader captures selected rows and their immutable chunk parts in
one D1 batch. Hydration consumes that owned snapshot and cannot fall back to a
later chunk lookup. Direct block/extrinsic/event readers and indexed hot-tail
readers use the same helper. Metadata-only/account/aggregate reads keep their
existing paths. Separate result rows preserve D1's per-row byte limit. Snapshot
parts have a 48MiB encoded and300-part transfer ceiling; an admitted32MiB raw
selection needs fewer than280 parts. Corrupt or oversized selections retain the
existing fail-closed digest/order/decompression checks.

The prepared quota bundle adds NUL-safe BLOB expression indexes for both native
reference owners and a bounded sweep cursor. `CHAIN_DETAIL_PAYLOAD_GC=enabled`
opts the existing prune tick into one pass of at most16hashes/192parts; no checked
in configuration enables it. The cursor scans forward through live hashes and
wraps, so a live prefix cannot permanently hide retired hashes. Reference checks,
chunk deletion, trigger-based quota release and cursor advance commit together.
A competing publisher serializes on the same D1 database; current references
protect shared hashes, while a later publication recreates exact deleted parts
inside its original atomic capture. Failed batches preserve cursor/counter/data.

This replaces the earlier deliberate no-GC source policy only after coordinated
activation. Do not enable reclamation while any deployed reader still performs
separate row/chunk reads or older invocations remain in flight. The standalone
hydration helper still supports offline callers; it is not a concurrent read
protocol without a supplied snapshot. Private coherent restores must retain the
new cursor/index schema and derive/verify the quota counter from original parts.
No schema bundle, flag, deployment or live deletion is activated here.

Native fixtures must verify racing readers, either family keeping a shared hash,
failed and competing sweeps, publication after candidate selection, cursor
fairness, repeated replacement, and restored source/counter/reader projections.
Actual sweep throughput versus retirement rate, DB/page/free-space amplification,
query plans, serving interference, RPO/RTO and whole-estate REST/MCP/UI corpus
remain separate measured acceptance. Fixed per-tick work is not a throughput or
capacity guarantee; quota exhaustion remains explicit admission failure.
