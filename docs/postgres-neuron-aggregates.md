# Native neuron aggregate reader

`createPgNeuronAggregateStore(runtime, decoder)` supplies the explicit
`NEURON_AGGREGATE_STORE` capability consumed by `readNeuronAggregates`. The
native selection owns the entire read and never falls back after an error.

One PostgreSQL statement reads current documents and accepted memberships.
Member counts remain separate from metric-entry counts: duplicate canonical
document keys contribute separately to metric aggregates, while missing metric
entries do not erase their accepted member. Noncanonical keys such as `01` do
not match UID `1` in this query family.

The pinned format decoder supplies SQLite numeric affinity, original scalar
types and original TEXT bytes. The shared SQLite SUM accumulator preserves
integer overflow, compensated floating arithmetic and indeterminate-infinity
behavior. MAX comparisons retain integer precision and the source storage-class
and byte ordering. Wire conversion happens after aggregation; it cannot replace
the original bytes used by a comparison. Missing requested text metadata is an
error rather than permission to compare an altered value.

The capability reads PostgreSQL and uses the existing ephemeral format decoder;
it does not create a persistent SQLite database. Production activation, source
custody and resource qualification remain separate requirements. Other neuron
query families retain their own semantics and are not selected by this adapter.
