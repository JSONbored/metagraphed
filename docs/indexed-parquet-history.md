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

## Bounded account-feed compaction

`scripts/compact-account-feed.ts` exports `compactAccountFeed(manifest, selection,
store, options)`. It converts one selected account-feed subtree to the deployed
`account-mixed-gzip-v2` format. The store supplies conditional `read(key, etag,
offset, length)` and immutable `write(key, bytes)` operations; `write` returns only
the object's `{ key, etag, bytes }` descriptor. The primitive has no credentials,
manifest-publication operation, or deletion operation.

The optional `path` is a sequence of directory child indexes from the root. Before
payload reads, the converter validates directory content hashes, scope, order,
identities, and row/block bounds. It groups selected pages by source pack and
reads adjacent ranges together, without fetching gaps. Full reads verify the
content-addressed filename; partial reads rely on the store's conditional ETag
and exact-range contract, gzip integrity, and the directory's exact page census.
They cannot verify the hash of bytes outside the requested range.

Each page is validated against the serving row schema. Compact encoding preserves
every token and field, including nulls, negative zero, and UTF-16 strings. Pages
whose encoded dictionary exceeds the decoder limit, or whose compressed encoding
does not shrink, retain their original compressed bytes. When at least one page
shrinks, **all** selected pages are repacked so an unchanged page does not keep a
source pack referenced unnecessarily. A batch with no savings writes nothing and
returns the original manifest. Untouched sibling descriptors are preserved.

Defaults limit each call to 64 MiB read (including output verification), 64 MiB
written, 4,096 storage reads, 8,192 tree nodes, and 4,096 pages. Overrides cannot
exceed 128 MiB read/written, 16,384 reads/nodes, or 8,192 pages. Packs are at most
16 MiB, directories 128 KiB, and decoded pages 256 KiB. The optional
`maxPackBytes` setting accepts 1–16 MiB (default 16 MiB), allowing a bounded
uploader to transfer smaller independent packs concurrently. It changes only
pack boundaries; page contents, ordering, and reference checks are preserved.
Compressed page staging
also uses the write-byte limit; the converter does not accumulate decoded rows.
Every output is read back and verified before a replacement manifest is returned.
If a call fails after staging objects, the caller owns cleanup of those staged
objects; it must never publish a partial result.

The result contains a candidate `manifest`, I/O `budget`, byte/page `stats`,
`originals`, verified `outputs`, and exact original leaf descriptors in
`replacedPages`. `entryDigest` uses `sha256-ordered-page-digests-v1`: each page
fingerprints its tokens and typed values (exact float64 bits and UTF-16 strings),
then SHA-256 hashes are concatenated as raw 32-byte digests in tree order and
hashed again. Old and new page fingerprints must match. This digest describes
the selected pages and their boundaries, not a whole generation or a flat JSON
serialization.

Typed fingerprinting reuses a 64 KiB scratch buffer across pages; large strings
stream through that buffer without changing UTF-16 code units or numeric bits.
The encoder validates source rows once, including pages whose original bytes
are retained. This avoids duplicate schema validation and per-field buffer
allocation while preserving the digest format and all round-trip checks.

Publication requires a separate fence against the currently selected manifest
and concurrent producers, plus a verified consumer/reference inventory. Neither
`originals` nor `replacedPages` is a deletion allowlist: an unselected page or
another retained manifest can still reference the same pack. Retire an old pack
only after all its consumers have moved to verified replacements. Preserve the
canonical source objects and rollback references until that proof is complete.

## Bounded extrinsic-feed compaction

`scripts/compact-extrinsic-feed.ts` exports `compactExtrinsicFeed` with the same
arguments, limits, staging contract and publication requirements as the account
compactor. Both use `scripts/lib/compact-history-feed.ts`; account output and its
existing digest format remain unchanged.

The `extrinsic-mixed-gzip-v1` marker permits legacy JSONL pages and MGE1 binary
pages in one tree. MGE1 stores the eight existing filter/pointer fields, query
hash, source hash and source ordinal as eleven float64 little-endian columns,
with an exact JSON string dictionary. Only canonical quiet NaN represents null;
the success column accepts only 0/1 as false/true. The reader checks dimensions,
dictionary indices, physical identity and the existing row schema before the
shared tree reader verifies ordering, census and query predicates. Responses,
filters, cursors, deduplication and canonical-row hydration do not change.

The compactor checks every token and value through the production decoder. Its
typed page digest maps the schema's boolean-only success field to 0/1; null has a
separate tag. Small pages and oversized dictionaries retain legacy bytes when
conversion would not save space. Tests include independently encoded wire bytes,
normal-sized pages rebuilt from the native producer fixture, mixed subtrees,
selector/intersection/cursor parity and unchanged account-compactor fixtures.

Deploy compatible readers before publishing an extrinsic mixed-format manifest.
The producer must also accept the marker when maintaining an already-complete
selected generation; a legacy-only validation branch would otherwise stop tail
ingestion. Qualify both consumers before changing the selected manifest. This
library does not update production producers or retire any objects by itself.

## Optional immutable extrinsic assets

`src/history-asset-source.ts` can serve byte-identical extrinsic feed directories
and packs through a `HISTORY_ASSETS` fetch binding. Activation also requires
`HISTORY_ASSET_RELEASE`, formatted as `<sha256>:<byte-length>` for a release
manifest of at most 128 KiB. With neither setting present, the original reader
is returned unchanged. Partial or malformed activation fails closed.

Every asset is served at `/<sha256>.mgpack`. The version-1 release maps two-digit
prefixes of SHA-256(original R2 key) to `{ sha256, bytes }` metadata shards.
Each shard maps complete key digests to the original `{ key, etag, bytes }` and
an ordered array of `{ sha256, bytes }` chunks. Chunks must cover the complete
original object and cannot exceed 4 MiB each. The schemas are defined in
`schemas-src/artifacts/history-assets.ts`. The publisher must verify the original
conditional identity and complete byte-for-byte reconstruction before signing
off on that mapping; a successful upload alone is insufficient.

The reader verifies release, shard and payload hashes, exact sizes, original
ETags and requested ranges. It cancels oversized bodies while streaming. A
separate operation budget counts actual asset transfers, including chunk
over-read: 128 MiB and 1,024 requests. Payload caching is confined to the current
operation and bounded to 8 MiB/256 entries; parsed shard retention is also bounded.
Choose chunk sizes against the largest supported query and cursor workloads,
not only the average page size. Asset file limits, deployment retention, worker
CPU and transfer budgets remain cutover qualification requirements.

A release can declare `partitionCount: 16` to use smaller payload files without
exhausting a single deployment's file allowance. Release and mapping shards stay
on `HISTORY_ASSETS`; payload chunks are routed by the first hexadecimal digit of
their SHA-256 to `HISTORY_ASSETS_0` through `HISTORY_ASSETS_f`. All sixteen fetch
bindings are required before reading any payload, and every payload chunk is
limited to 128 KiB. Missing partitions and oversized chunks fail closed. The
partitioned release allows at most 512 MiB transferred and 4,096 asset requests
per operation, counting metadata and repeated reads after eviction. This does
not raise the native query's logical byte/request budgets or the 8 MiB payload
cache. Publishers must qualify the largest supported query, preserve every
selected partition together, and verify complete reconstruction before removal
of the original objects. A partitioned release is optional; existing single-store
releases keep their original limits and routing.

When supplied through a service binding, the platform's per-request limit on
Worker invocations also applies, including calls elsewhere in the API/MCP chain.
The 1,024-read byte-source budget does not override that limit. Qualify maximum
supported query sizes through the complete call chain; use a native asset
binding or delegate a complete query to the asset-owning Worker if individual
range requests would exceed the service-invocation limit.

Only immutable, content-addressed objects under an extrinsic generation's
`feeds/v1/` tree are eligible. Mutable selections and source ceilings, canonical
Parquet, account history and unmapped keys keep their existing readers. A missing
mapping permits staged adoption; a corrupt or unavailable mapped asset throws
instead of returning an empty or partial answer. Source-ceiling checks, native
filters, cursor ordering, deduplication and canonical-row verification remain in
the existing table adapter. Tests remove all immutable feed objects from the R2
fixture and still compare complete hydrated results across these query shapes.

This change does not provision an asset store, activate a release, or delete R2
data. Before retiring any original object, qualify its complete asset mapping,
all consumers and restoration paths, both deployed API readers, public API/MCP
parity, worst-case query budgets, and the ability to preserve the selected asset
release through subsequent deployments. Preserve the selected feed manifest and
its encoding for producers that still use it as their completion record.
