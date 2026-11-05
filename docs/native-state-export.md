# Native state export

`createPgStateExport(source, decoder, { identity })` prepares the existing
authenticated `POST /api/v1/internal/state-export` table protocol on the shared
PostgreSQL runtime. Bind the result as `NATIVE_STATE_EXPORT`. The existing
`STATE_EXPORT_SECRET` and `x-state-export-token` authentication remain required.
History-object, basket and dead-letter operations keep their separate owners.

The source must own every physical dependency of the 34 approved table families
and `app.native_export_revisions`. It needs `read-write` access for PostgreSQL
table locks; the exporter performs no data mutation. Construction opens no
connection and starts no listener, timer, export or migration.

## Revision and schema ownership

`0040_native_export_revisions.sql` creates native counters;
`0041_native_export_revisions_activate.sql` attaches their source dependencies.
Load and qualify the original tables before activating those effects. Imported
D1 counters remain separate custody evidence in `archive_export_revisions`.
There is no automatic schema activation in the application factory.

Each page takes SHARE locks on its precise source tables, then reads its revision
and rows under READ COMMITTED. The locks cover data and schema changes, including
TRUNCATE, which a repeatable-read snapshot alone cannot safely cover. Locks end
with the page transaction. Later pages must present the same family or closed-day
revision; a changed source returns 409 instead of acknowledging a mixed snapshot.
Unrelated open-day writes do not invalidate a closed-day export.

The exporter checks the required trigger identities, enabled state, arguments
and source column types. Missing or incompatible ownership fails closed. Source
tables and columns remain the fixed approved export set; requests supply no SQL.

`scripts/generate-export-projection.ts` derives the column metadata from the
committed source schema using the pinned SQLite runtime in an offline fixture.
Its `--check` mode detects stale generated metadata. The native application loads
only the generated metadata, not a SQLite schema or a second persistent database.
The existing read-only decoder handles original binary JSON document values.

## Bounds and identities

Pages contain at most 2,000 rows and 2 MiB of encoded row data. PostgreSQL bounds
the source response before driver buffering. Individual source documents are
limited to 512 KiB, with an 8 MiB per-page document cache. Day inventories are also
bounded and fail instead of silently omitting dates. Configure finite pool,
statement, request and drain limits in the owning runtime.

Ordinary values preserve the existing JSON response behavior. `lossless-v1`
preserves integer text, scalar storage kinds, text, binary values and finite
IEEE-754 values, with the source protocol's existing zero normalization. A
REAL's round-trippable decimal spelling can differ between SQLite builds;
qualification compares its exact bits. Native exports carry
their own projection identity, binding the source identity, generated schema,
native implementation, decoder identity and actual PostgreSQL column types.
They must not be treated as original D1 source-custody receipts.

The actual PostgreSQL/D1 fixtures exercise all approved schemas, populated
relational families, document-backed views, pagination, closed days, exceptional
text cursors, resource limits and mutation/rollback behavior. This preparation
does not transfer production data or select a deployment destination.
