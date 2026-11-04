# Native subnet metagraph reads

The process composer can provide `NEURON_SNAPSHOT_STORE`, created by
`createPgNeuronSnapshotStore` from its existing PostgreSQL read handle and the
qualified SQLite document decoder. This capability owns the subnet metagraph
snapshot only. It does not claim that arbitrary queries against the original
`neurons` view work on PostgreSQL.

One PostgreSQL statement reads original documents and accepted members for the
requested subnet. The existing subnet projection then uses the same last-key
JSON parsing, metadata ownership, shard matching, validator filter and UID
ordering as the current source path. This deliberately differs from the
first-key behavior of the original point-read SQL view. Each document is
decoded once. No SQLite database persists application data.

The normal `/api/v1/subnets/:netuid/metagraph` handler selects this capability
when supplied, including its existing burn-hotkey logic. The compound MCP
snapshot-card helper shares the same rows and null ordering. Absent native
selection keeps the existing D1/Hyperdrive dispatch. A malformed explicit
capability throws; a native read failure retains the opaque 502 response.

The PostgreSQL source must contain `app.neurons_documents`,
`app.neurons_members`, `app.subnet_ownership` and `app.subnet_snapshots` with
their qualified source data. The factory does not create schema, select a
production store, own the pool lifecycle, or move any data. Other neuron
directory, economic, point-read and history callers require separate
capabilities and their own filter/aggregation fixtures.

The native PostgreSQL fixture compares the actual REST response bytes and
compound snapshot cards with the current source handler. It also covers
duplicate keys, nulls, orphan entries, wrong-shard membership, filtering, empty
subnets and the existing error envelope. The Worker graph checks exclude the
PostgreSQL implementation and SQLite decoder from the Worker bundle.
