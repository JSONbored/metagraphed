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
