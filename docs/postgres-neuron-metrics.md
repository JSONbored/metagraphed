# Native neuron metric-entry reads

`createPgNeuronMetricStore(runtime, decoder)` supplies the explicit
`NEURON_METRIC_STORE` capability for shared chain-performance and bounded
daily-metric readers. The chain-performance and subnet-performance-history REST
paths select it directly. Selection failures remain errors; they never revive
a legacy backend.

These query owners expand every top-level document entry before joining its
exact text key to accepted membership. Duplicate top-level keys therefore
remain separate rows, while repeated properties inside one entry retain the
source's first-property extraction. Missing metric entries retain their member
row with null metrics. A key such as `02` does not match UID `2`. The ordinary
point-history and subnet-snapshot readers have different documented semantics.

The bounded daily read limits accepted memberships before expanding entries,
preserving both duplicate multiplication and the original date/UID ordering.
Document and member inputs share one PostgreSQL statement. Each selected shard
is decoded once. Scalar integers become numbers at the existing D1 result
boundary; text, including embedded NUL, remains text.

The native format decoder uses fixed read-only JSON extraction on an ephemeral
in-memory connection. It does not load application tables, accept caller SQL,
or persist data. PostgreSQL remains the only application database.

Synthetic tests compare PostgreSQL results and actual REST response bytes with
the existing D1 queries. Other aggregate, directory, comparison and producer
callers remain separate migration work. This capability does not activate a
destination or move production data or traffic.
