# Indexed reads of retained Parquet history

The page reader is a foundation for retiring R2 SQL. It does not change a route's storage owner by itself. Keep the existing owner selected until a complete history generation and its incremental producer are qualified.

`schemas-src/artifacts/parquet-page-index.ts` defines version 1 of the physical index. Each index contains one object's key, unquoted R2 ETag, byte length, exact row count, original Parquet footer, and a complete page map for every flat column and row group. Page positions include their headers; row positions are relative to the containing row group. Nested and repeated columns are rejected.

`scripts/build-parquet-page-index.ts` constructs the index without decompressing the table. Fetch the footer with `parquetFooter`, then pass a forward-only view of the object's body from `sequentialParquetBuffer`. Always close that view in a `finally` block. Fetch both the footer and body conditionally against the same ETag. The builder skips compressed payloads and keeps only its current stream chunk and header window in memory.

`src/indexed-parquet.ts` validates every column's coverage before reading any data, then supplies the external page map to the pinned Parquet decoder. Every storage read must match the indexed ETag and exact requested range. A shared operation budget limits bytes and GETs across candidate files; actual page headers also limit decompressed bytes and value counts before allocation. Budget exhaustion, corrupted data, incomplete indexes, and replaced or missing objects throw. None of them means that a record does not exist.

The logical lookup manifest must bind each physical index to its network, table, source snapshot, and immutable generation. A hash or block lookup identifies a physical row; the table reader must verify that the decoded row matches the requested logical key and normalize its values through the existing table schema and formatter. This primitive preserves BigInt values without rounding them. It does not choose duplicate-hash semantics, infer freshness, or validate completeness of a logical lookup manifest.

Publish every source object, index, and lookup shard before atomically changing the generation pointer. Retain objects while any readable generation references them. A catalog retention or compaction policy must not remove indexed objects. New captures need an incremental generation before their older serving owner can be retired. Do not add an R2 SQL fallback to an indexed owner.

Some retained files have very large pages. A small logical result does not guarantee a small decompression allocation. Qualify retained files against the reader's limits and rewrite oversized pages into smaller row groups before selecting them for serving; increasing limits without measuring Worker memory is insufficient.

The synthetic fixtures exercise both data page versions, ZSTD and Snappy, dictionary encoding, nulls, multiple row groups, and integers above JavaScript's safe range. Miniflare exercises actual conditional R2 range reads. Source migration qualification additionally compares normalized record digests against the original decoder at the first, middle, and last rows of retained files.

Hash lookups use immutable, generation-scoped shards under
`metagraph/indexed-history/v1/<network>/<table>/generations/<generation>/hash/<prefix>.bin`.
The prefix is the first three hexadecimal hash digits. Each sorted 40-byte record
contains the raw 32-byte hash, then a little-endian uint32 source-file ordinal and
physical row position. Sorting includes the pointer bytes, making duplicate hashes
deterministic without dropping their other source records.

`findHistoryHash` validates the network, table, generation, shard prefix, object
identity, and physical pointer bounds. It searches with cached 1,024-record range
reads; large duplicate-heavy shards are never fetched wholesale. Publication must
verify every shard's sorting, checksum, row count, and source identity before its
complete generation is selected. A selected row must also match the requested
logical hash when the table-specific serving adapter decodes it. A missing or
changed object throws; only a valid complete index can establish absence.

For groups of at most 512 rows, the Parquet reader coalesces selected column spans
up to 1 MiB into one conditional GET. It retains page pruning for larger spans and
legacy row groups, and still applies the shared transfer and decoded-memory budgets.
On the verified retained-file middle row, this exchanges 11 reads totaling 54,688
bytes for one 151,135-byte read, with the same 221,317 decoded bytes and exact row
digest. Both avoid the original 7,988,142-byte read and 32,402,230-byte decompression.
No serving route is selected by these primitives alone.

Block-number indexes use a separate complete manifest and 16-bit block prefixes
under `generations/<generation>/blocks/<prefix>.bin`. Each sorted 24-byte record
contains four little-endian uint32 values (block, source-file ordinal, first row,
row count), followed by the uint64 observation timestamp. Every physical row is
covered by exactly one run during publication. Repeated observations remain
separate runs, preserving the serving adapter's existing deduplication choices.

`validateHistoryBlockIndex` requires a complete source-row census, scoped and
ordered shard descriptors, matching run counts, and valid block ranges before
even a missing shard may answer a lookup. `findHistoryBlockRuns` uses cached
1,024-run range reads and shares the caller's transfer/request budget. It rejects
invalid physical ranges, timestamps that cannot be represented exactly, and
results over 4,096 runs or 65,536 physical rows. It never returns a partial result
after a budget failure. The table adapter must decode each returned range and
verify its logical block before serving it; this primitive does not select a
production generation or change any REST, GraphQL or MCP route.
