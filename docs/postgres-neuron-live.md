# Native live-neuron reads

`createPgNeuronLiveStore(runtime, decoder)` supplies `NEURON_LIVE_STORE` to the
existing freshness, economics and account-directory readers. Selection is
explicit: an invalid or failed selected store is an error. Without this
capability, the existing D1/legacy path remains active.

Each read fetches current documents and their accepted memberships in one
PostgreSQL statement. PostgreSQL owns persistence; the pinned, read-only
in-memory SQLite codec only decodes the bounded SQLite JSONB documents and their
scalar projections. No SQLite database file or second application datastore is
created. Stored documents are not rewritten by reads.

The readers retain their existing source semantics:

- Freshness uses canonical text UID keys. Numeric array keys and keys such as
  `"01"` do not match UID 1. Maximum values are compared in SQLite storage-class
  order, with exact INTEGER/REAL comparison and original text bytes, before D1
  wire conversion and the existing JavaScript `Number` conversion.
- Economics and directories use SQLite `CAST(key AS INTEGER)`. Multiple matching
  entries, noncanonical keys and array keys retain their original multiplicity.
  Identities come from accepted membership rows and must match the document's
  shard.
- Economics keeps multi-path JSON extraction and the existing JSON parse step.
  This preserves nested duplicate-key collapse, boolean conversion, original
  number spelling, structured values and malformed-entry failures. Full-network
  economics excludes netuid zero; scoped reads retain it. The final sort matches
  the existing numeric JavaScript sort.
- Directories exclude null hotkeys and use the source's strict numeric validator
  predicate. Ordering is hotkey UTF-8 bytes, descending stake in SQLite scalar
  order, then exact netuid and UID. Sorting happens before scalar values cross
  the D1 wire boundary. Predicate validation also preserves failures on
  malformed orphan entries, because the source evaluates this predicate
  before looking up membership.

`tests/pg-neuron-live.pg18.ts` compares these public readers against actual D1 and
PostgreSQL 18 using the same synthetic documents and memberships. This includes
noncanonical keys, arrays, duplicate keys, large integers, infinities, malformed
records and text replacement behavior. Unit tests separately cover selection,
invalid capabilities, metadata loss, scope validation and unavailable storage.

This adapter does not choose a host, initialize a database, transfer writers,
select itself in a running process or change public routing. It is one reusable
capability in the native composition; activation remains a separate operation.
