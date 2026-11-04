# Native neuron and account daily history

`createPgNeuronHistoryStore(runtime, decoder)` supplies the explicit
`NEURON_HISTORY_STORE` capability for per-UID and per-account daily history.
The two REST history routes and their shared cold-history readers select it
before the legacy SQL reader. A selected capability failure remains an error or
an unavailable cold leg; it does not revive another backend.

Each read joins the accepted member to its original document in one PostgreSQL
statement. Missing documents and mismatched shards remain absent. The date floor
is inclusive, the optional cold seam is exclusive, and the row limit applies in
descending day order.

These query owners use the source SQL view's first-key JSON extraction behavior.
The pinned SQLite format decoder preserves it, including duplicate keys and
dynamic scalar values. Exact integers become JavaScript numbers at the existing
D1 result boundary. This differs from the subnet snapshot reader, whose existing
`JSON.parse` behavior uses the last key. The Node implementation and decoder stay
outside the Worker graph; only the capability selector is portable.

Synthetic PostgreSQL 18.6 and SQLite fixtures compare actual REST response bytes,
member/shard handling, wide JSON integers and shared history seams. Other neuron
and account queries retain their own migration owners. This capability does not
activate a database, import data or change public routing.
