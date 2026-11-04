# Native neuron document preparation

The load migration `0024_neuron_documents.sql` preserves the ten remaining
document, membership, receipt, pass and historical audit tables. Document payloads
remain exact `bytea`. Historical audit payloads have no live-document size cap.
The original fifteen indexes remain explicit.

`neuron_daily_members.axon_index` has BLOB affinity in SQLite, but its triggers
store text, integer, REAL, BLOB and null values. Its PostgreSQL `json` column uses
the explicit `sqlite_value` encoding: `[storage-class, encoded-value]`, or SQL
NULL. Integers are signed-int64 decimal strings; REALs retain sixteen hexadecimal
binary64 digits; BLOBs retain hexadecimal bytes; text is a JSON-quoted string
inside the tuple. Quoting preserves embedded NUL without passing it through a
PostgreSQL text column. Native callers use `readSqliteValue` to recover the value.

## Decoder and derived receipts

`createSqliteDocumentDecoder` uses Node's bundled SQLite only as a format
decoder. Its connection is read-only and in memory, creates no tables, disables
extensions and accepts only parameter values for fixed statements. PostgreSQL
owns persistent application data. The decoder refuses any version or source
identity other than SQLite 3.54.1, source ID
`2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`.

Live documents require the original strict `json_valid(payload,8)` check and
524288-byte limit. Historical decoding has a separate explicit caller budget;
crossing it refuses preparation without truncating or dropping the original
row. A malformed historical blob can load as original data, but cannot acquire
a successful decode receipt. Text crosses the Node SQLite boundary as BLOB
bytes to preserve embedded NUL. Decoding invalid UTF-8 or an unsupported scalar
escape refuses conversion rather than replacing bytes. Exact `json(payload)`
text retains duplicate keys and numeric spelling.

`prepareNeuronDocument` produces the SHA-256-bound receipt stored in
`app.neuron_document_projections`: exact decoded text, original first-key axon
values, and decoder identity. The source payload remains in its original table.
The native write transaction upserts this receipt before its source document.
The activation migration requires every source document's receipt and checks
imported axon projections before installing maintenance. A source write requires
its matching receipt immediately; deferred checks reject a source/receipt
mismatch at commit. Identical source bytes cannot acquire changed decoded text
or axon values.

The receipt certifies execution of the reviewed decoder by the trusted import
or native producer. Its hash and SQL checks do not independently execute SQLite
inside PostgreSQL. The writer role and native composition must retain that
boundary; arbitrary clients must not receive direct write access to receipts.

## Query and trigger semantics

The original views expose dynamically typed SQLite values. A generic PostgreSQL
view cannot preserve that contract through a fixed SQL column type. The native
query owner selects the original member/document join, then calls
`projectNeuronDocument` or `projectAccountDocument`. The latter uses uppercase
hexadecimal UTF-8 account keys. Both preserve the first matching JSON key, SQL
null, integer/REAL distinctions, 0/1 booleans and compact text for objects or
arrays. Other consumers that use `JSON.parse` or `json_each` retain their own
last-key or all-entry behavior through the decoder's separate operations.

The four axon triggers use the original first `json_each` entry for each key.
Numeric comparison follows SQLite `IS`: integer 1 and REAL 1.0 are equal, so a
storage-class-only change does not spuriously update a member or increment its
closed-day revision. Document and member writes share the closed-day statement
lock and require READ COMMITTED. The native fixture compares the original
triggers with the PostgreSQL effects, including nested member updates and all
fifteen closed-day trigger families.

These are preparation components. The four source views' application callers,
native producer transaction boundaries, full source receipts and production
placement still need their own integration and acceptance evidence before a
database cutover.
