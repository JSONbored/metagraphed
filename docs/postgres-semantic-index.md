# PostgreSQL semantic index

`createPgSemanticIndex(runtime, options)` supplies the explicit `SEMANTIC_INDEX`
capability consumed by embedding synchronization and semantic search. The
capability uses the process-owned PostgreSQL pool and the `search` schema from
`0029_search_index.sql`. It does not start a service or own pool shutdown.

Index identity includes its name, embedding model and dimensions. Opening an
existing index with different settings fails. A separate name is required for
a new model or embedding shape. The configured capacity is checked against the
durable row count when opened; database triggers maintain that count and enforce
the limit during concurrent writes. A failed batch rolls back its earlier writes.

Vectors use finite float32 values and exact cosine ranking with a deterministic
ID tie order. A zero vector scores zero. This bounded implementation scans at
most 10,000 vectors of at most 4,096 dimensions and needs no PostgreSQL extension.
Query latency and capacity still require qualification against the intended
catalog and resource budget before deployment.

The adapter accepts the application's current query contract: top K from 1 to
20, optional `type` equality or allow-list filtering, optional returned values,
and all or no metadata. It preserves serialized metadata text, including NUL
escapes, and stores the filter field separately because PostgreSQL JSON field
access rejects those escapes. Metadata values are checked on writes and reads:
strings, numbers, booleans, string arrays and the application's existing null
values are supported. Upsert and delete batches accept at most 100 IDs.
Nonempty Vectorize namespaces and indexed-only metadata are rejected explicitly.

Without an explicit capability the existing Worker still uses Vectorize. A
malformed selected capability fails instead of falling back. Embedding and
answer generation continue to use the separately supplied `AI.run` capability;
this index does not supply or activate an inference provider. The embedding
model must agree with the index configuration. Existing vectors must be loaded
or regenerated before transferring synchronization or serving ownership.

Synthetic PostgreSQL 18 integration covers ranking, metadata preservation,
concurrent capacity enforcement, transaction rollback, model isolation and the
ordinary embedding-sync/semantic-search callers. This prepares the storage
boundary; it does not perform a production export, model download or cutover.
