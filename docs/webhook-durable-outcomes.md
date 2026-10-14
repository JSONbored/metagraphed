# Durable webhook outcomes

The existing D1 state owner records delivery intent and each attempt before
HTTP. The existing queue still owns eight attempts and its exponential backoff;
the retry default remains at least once. Payload bytes, event ids, signatures
and idempotency keys remain stable. A subscription is reread on each attempt,
so deletion stops delivery and repointing changes the next attempt's target.
Targets are recorded per attempt; signing secrets are never stored in this
ledger.

Migration0042 adds shared event payloads, per-subscription intents and ordered
attempt evidence to the existing database. Complete event identity is checked
against both the existing32-hex event id and the full SHA256/body. A native
atomic claim fences simultaneous attempts with a60-second lease. An expired
in-flight attempt is retained as ambiguous before another attempt is admitted.
The status reader exposes that uncertainty; an HTTP error can also follow a
receiver effect and its attempt is therefore ambiguous unless no request was
made. A later success may resolve an ambiguous attempt.

Outcome persistence precedes queue acknowledgment. A lost successful commit
reply is resolved from immutable successful attempt evidence, including when an
aggregate update was ignored. Any known success takes precedence over later
failure, replay or dead-letter messages. Exact known legacy KV successes can be
adopted without resending; native status takes precedence over its optional KV
projection. A broken bound native store reports unavailable, not healthy empty
status. No new write fallback is introduced.

Initial enqueue failure leaves reconstructable original bytes. The existing
webhook dispatcher recovers at most four unqueued ready intents per tick before
its usual change-feed dispatch. It does not schedule business retries beside
the queue. Every selected recipient's intent is admitted in one native transaction
before queue sends begin. A committed-but-lost verification reply retains the
whole recipient set, rather than a prefix or an in-memory admission cursor. Serialized UTF-8 envelope size is checked, including multibyte payloads;
an existing unsendable outbox item becomes durably terminal without blocking
other owed or new events. Payloads, outcomes and deduplication evidence retain the existing
180-day status horizon, refreshed by activity. Bounded cleanup removes at most
1024 expired intents and1024 orphaned payloads per tick. This is cleanup
eligibility, not a strict physical lifetime: outages or arrivals beyond cleanup
throughput can retain an expired backlog. At48 scheduled ticks/day the ceiling
is49,152 intents/day; admission, deletion throughput and backlog still need
measurement before release. No hand-maintained subscriber cap is introduced. Once evidence expires,
redelivery may repeat an effect. This is not perpetual replay retention. Dead
events remain terminal across automatic queue duplicates. A persisted round
must advance and its due time must pass before another automatic attempt can
claim. Manual requeue first requires `authorizeReplay` on the native owner,
called by an authenticated operator with a stable operation token, then sends
the returned generation. No new unauthenticated replay route is introduced.
Old queue messages and dead letters cannot claim or terminate that generation;
lost authorization replies reuse the same token. Known success is never
readmitted within its retention horizon.

Exactly-once remote effects require receiver deduplication. A process can stop
after a receiver acts and before local outcome persistence; the default retry
may repeat that effect. The stable idempotency header enables a cooperating
receiver to resolve it. This change does not silently introduce quarantine or
change the public attempt/retention policy.

Native Miniflare fixtures apply the real DDL and exercise concurrent claims,
ignored writes, lost replies, expired leases, late success, stale failure,
dead-lettering, payload identity, retention, REST/MCP status and actual producer/
consumer wiring. Source qualification is distinct from production acceptance.
Migration0038 is already applied,0040/0041 are held preceding proposals, and
0042 must not be merged or applied as an incidental source change.

Before release, qualify current D1 write/space headroom, retained intent/payload
growth, queue fanout and per-message database cost, coherent D1/control and
referenced-asset recovery, actual backup retention/key custody and required
physical-schema/full-CI/99% branch-counted patch coverage. The database's
reported near10GB file size establishes no reusable write headroom. Existing
main migration workflow applies remote DDL and runtime builds deploy
independently: coordinate the explicit schema/runtime boundary and old-consumer
fence before live adoption. Old consumers bypass this protocol and cannot be a
safe rollback while new retained delivery state is active. Rollback requires
stopping/fencing delivery, preserving accepted outcomes and an explicitly
qualified compatible image; deleting success evidence is not rollback.

The DLQ has five bounded storage-finalization retries with a300-second default
delay and no recursive DLQ. The dispatcher also finalizes at most four native
queued intents inactive for32days without making an HTTP request. Cloudflare's
[retry documentation](https://github.com/cloudflare/cloudflare-docs/blob/cd4a0dc718b360c96a5848f2a3e18f2777884885/src/content/docs/queues/configuration/batching-retries.mdx)
states that retries beyond the maximum are deleted when no DLQ exists;
[queue limits](https://developers.cloudflare.com/queues/platform/limits/)
cap each queue's retention at14days. The32-day fence exceeds both delivery and
DLQ horizons. The native original survives a transient/outlasting D1 outage,
and a later healthy dispatcher exposes terminal uncertainty without restarting
business retries. Finalization and recovery require the database and dispatcher
to recover before the180-day evidence horizon. No finite transport retry count
provides perpetual retention during an indefinite database outage.

Status reconciles every included legacy event against native ownership, even
outside the newest256 rows. An unresolved prior receiver effect remains
`outcome-unknown` after a later no-request failure; later positive evidence
resolves it. Never-attempted/null timestamps do not supersede real failures.

Exhausting one duplicate transport is not authority to terminalize another
copy's pending logical retry or a queued initial intent. DLQ handling preserves
that native state and acknowledges the stale transport; expired in-flight
attempts retain ambiguity. Only the native eighth effective round or the
separate post-retention finalization fence may terminate such a retry. Failed
subscription reads use the published delayed retry policy rather than an
implicit immediate batch retry. Expiry and event-leading indexes support
bounded cleanup and orphan checks; the deletion cap is not a production latency
proof, and native representative query-plan/SQL-work measurements remain
separate from actual D1 workload acceptance.
