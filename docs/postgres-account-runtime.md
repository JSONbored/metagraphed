# Native account state

`createNativeAccountState(runtime)` constructs the complete `ACCOUNT_STATE_STORE`
capability over one process-owned PostgreSQL pool. It includes account/key SQL,
usage writes and reads, daily quotas, and durable block lookup. Its selector
rejects a present partial family instead of falling back to another backend.
The existing `CONTROL_KV_STORE` supplies wallet challenges, caches and block
snapshots. Rate-limit bindings retain the native auth-control factory.

Account and key statements each finish their transaction before returning to a
handler. Unkey requests therefore do not retain a database lease. Revocation
intent commits before provider mutation, remains effective when the provider
reply fails, and survives the confirmation retry. Identity/key result numbers
cross the same JavaScript-number boundary as D1.

Usage counters retain SQLite INTEGER/REAL storage behavior in numeric columns.
Rollup writes group the serialized JSON tokens, apply SQLite SUM and integer
affinity, and commit every group with one receipt. A transport retry reuses the
original batch ID, payload digest and expiry. Other account mutations do not
retry implicitly. Pool refusal, expired receipts and a later-group failure do
not commit partial usage.

The source row identities from migrations 0035/0036 are required before native
usage writes. Writers never accept `source_row_id` from an HTTP caller. Native
inserts use the non-cycling defaults, and the runtime role needs `USAGE` on both
identity sequences. Dashboard rows retain day/rowid order; shape aggregates
retain shape/day/rowid order. Family aggregates retain their source key and
day order. Exact numeric sorting precedes D1's JSON conversion, which maps an
infinite result to null. The existing handlers then perform their original
number coercions.

Native block enforcement consults durable account state when the KV snapshot
is missing, expired, malformed or unreadable. A failure of that authority does
not become an access grant or a fabricated abuse verdict. Valid snapshots keep
their existing behavior, and account IDs retain the source's numeric matching.

The PostgreSQL fixtures compare actual D1 and native HTTP bytes through wallet
login, GitHub upsert, key issuance/listing, tier promotion, usage/quota reports,
blocking, and pending/retried revocation. Separate fixtures exercise exact
numeric storage, ordered reads, concurrent counters, atomic rollback, receipt
replay and saturation. These fixtures prepare the capability; they do not
provision a database, import source data or activate a production binding.

Raw PostgreSQL `text` cannot store embedded NUL. The existing handlers accept
that character in fields such as GitHub logins, block notes and usage labels;
this capability does not normalize or remove it. The shared text-boundary work
must qualify those values before claiming complete source/write compatibility.
