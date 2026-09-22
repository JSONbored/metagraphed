# Indexed reads of retained Parquet history

The page reader is a foundation for retiring R2 SQL. It does not change a route's storage owner by itself. Keep the existing owner selected until a complete history generation and its incremental producer are qualified.

`schemas-src/artifacts/parquet-page-index.ts` defines version 1 of the physical index. Each index contains one object's key, unquoted R2 ETag, byte length, exact row count, original Parquet footer, and a complete page map for every flat column and row group. Page positions include their headers; row positions are relative to the containing row group. Nested and repeated columns are rejected.

`scripts/build-parquet-page-index.ts` constructs the index without decompressing the table. Fetch the footer with `parquetFooter`, then pass a forward-only view of the object's body from `sequentialParquetBuffer`. Always close that view in a `finally` block. Fetch both the footer and body conditionally against the same ETag. The builder skips compressed payloads and keeps only its current stream chunk and header window in memory.

`src/indexed-parquet.ts` validates every column's coverage before reading any data, then supplies the external page map to the pinned Parquet decoder. Every storage read must match the indexed ETag and exact requested range. A shared operation budget limits bytes and GETs across candidate files; actual page headers also limit decompressed bytes and value counts before allocation. Budget exhaustion, corrupted data, incomplete indexes, and replaced or missing objects throw. None of them means that a record does not exist.

The logical lookup manifest must bind each physical index to its network, table, source snapshot, and immutable generation. A hash or block lookup identifies a physical row; the table reader must verify that the decoded row matches the requested logical key and normalize its values through the existing table schema and formatter. This primitive preserves BigInt values without rounding them. It does not choose duplicate-hash semantics, infer freshness, or validate completeness of a logical lookup manifest.

Publish every source object, index, and lookup shard before atomically changing the generation pointer. Retain objects while any readable generation references them. A catalog retention or compaction policy must not remove indexed objects. New captures need an incremental generation before their older serving owner can be retired. Do not add an R2 SQL fallback to an indexed owner.

Some retained files have very large pages. A small logical result does not guarantee a small decompression allocation. Qualify retained files against the reader's limits and rewrite oversized pages into smaller row groups before selecting them for serving; increasing limits without measuring Worker memory is insufficient.

The synthetic fixtures exercise both data page versions, ZSTD and Snappy, dictionary encoding, nulls, multiple row groups, and integers above JavaScript's safe range. Miniflare exercises actual conditional R2 range reads. Source migration qualification additionally compares normalized record digests against the original decoder at the first, middle, and last rows of retained files.
