# Native archive storage

The existing archive object format supports a PostgreSQL catalog and immutable
filesystem chunks without changing the public object reader. Supply
`ARCHIVE_CATALOG_STORE: createPgArchiveCatalog(runtime)` and
`ARCHIVE_CONTENT_STORE: await createFilesystemArchiveContent(options)` with
`ARCHIVE_OBJECT_STORAGE: "native"` to the existing `withArchiveObjects()` owner.
The process retains ownership of the PostgreSQL pool.

The catalog uses `app.generated_artifacts` in the same database as application
state. It preserves raw manifest text, immutable compressed payload records and
compare-and-swap pointer updates. Existing inline, compressed and multipart
manifests, object metadata, range reads, conditional writes and tombstones retain
their original behavior. Selected catalog/content failures propagate; they do
not select a legacy object or asset binding. A separate content capability takes
precedence over the partitioned Worker asset bindings. Without either native
capability, existing Worker behavior remains available.

Filesystem content uses the original SHA-256 chunk identities as filenames.
Each read verifies a regular file, the configured size bound and the checksum
before returning bytes. Nonblocking opens refuse restored FIFOs and other
non-regular files without waiting for a writer, and do not follow final symlinks.
Each operation has explicit admission bounds and accepts cancellation. A growing
file cannot cause an unbounded read allocation. The maximum chunk size is
512 KiB, matching the current manifest contract.

`publish(sha256, bytes, signal)` validates bytes, writes an exclusive temporary
file, syncs it and atomically links the immutable destination without replacing
an existing file. An existing destination must contain the expected bytes.
Publication syncs the directory before returning. Cancellation or failure can
leave a verified, unreferenced immutable file; it never advances a catalog
pointer. The caller must finish all content publications before publishing the
manifest that references them. No background garbage collection runs here.

The supplied directory must already exist, belong to the process user and reject
group/other writes. The adapter does not create a mount, allocate a volume,
install credentials, start a service or select a production location. Destination
disk capacity, backup consistency, restore and orphan-cleanup policy remain
deployment acceptance requirements. A coherent recovery set includes catalog
state and every referenced immutable file. Existing source manifests must be
preserved and their referenced chunk hashes verified during import before
serving ownership can change.

The application writer remains bounded to its existing 32 MiB text payload
contract. Small/compressed writes use PostgreSQL; imported historical multipart
objects use immutable files. This avoids introducing another database or an
object-storage service. Synthetic tests cover the normal object path with the
native catalog, concurrent conditional publication and actual filesystem
content, plus missing/corrupt content and atomic duplicate publication.
