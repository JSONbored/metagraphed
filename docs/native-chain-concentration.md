# Native chain concentration rollup

`CHAIN_CONCENTRATION_STORE` selects the complete native source for the existing
hourly concentration rollup: pending closed days, raw daily rows and stored
cards. The main scheduled handler selects this capability before consulting the
generic producer store. A partial capability rejects; the generic native writer
continues to reject the logical `neuron_daily` table without this adapter.

`createPgChainConcentrationStore` receives the process-owned read/producer
handles and the pinned SQLite document decoder. It creates no connection,
timer, schema or migration. The final source manifest must place
`neuron_daily_documents`, `neuron_daily_members` and
`chain_concentration_daily` under this same writable source. A single statement
reads documents and accepted memberships in one PostgreSQL snapshot. The target
write must affect one row before a day is reported as rolled.

The raw document remains the authority for metric values. The adapter retains
every matching `json_each` entry, including duplicate object keys, aliases that
cast to the same integer UID, and integer array keys. It uses the membership
row's identity and subnet ID. The canonical member-view reader would discard these
duplicate entries and is not a substitute for this source query. Unmatched
primitive values do not enter extraction; malformed values that match a member
still fail the day. Documents follow netuid/shard order and entries retain their
SQLite order, preserving floating-point aggregation order. SQLite scalars cross
the same numeric wire boundary before the existing JavaScript builder runs.

The existing rollup owns the builder, JSON serialization, source capture time,
schema version, three-day catch-up default and per-day failure behavior. Today
remains excluded; an empty or failed day stays pending. This preparation does
not activate a schedule, migrate historical rows or establish production
read/write acceptance.
