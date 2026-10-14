# Durable webhook outcomes

The existing D1 state owner records delivery intent and each attempt before
HTTP. The existing queue still owns eight attempts and its exponential backoff;
the retry default remains at least once. Payload bytes, event ids, signatures
and idempotency keys remain stable. A subscription is reread on each attempt,
so deletion stops delivery and repointing changes the next attempt's target.
Targets are recorded per attempt; signing secrets are never stored in this
ledger.

Migration0041 adds shared event payloads, per-subscription intents and ordered
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
the queue. Payloads, outcomes and deduplication evidence retain the existing
180-day status horizon, refreshed by activity. Bounded cleanup removes at most
64 expired intents and64 orphaned payloads per tick. Once evidence expires,
redelivery may repeat an effect. This is not perpetual replay retention. Dead
events remain terminal for the same queue delivery; a newly admitted normal
queue message at round1 retains the previous manual requeue behavior. Known
success is never readmitted within its retention horizon.

Exactly-once remote effects require receiver deduplication. A process can stop
after a receiver acts and before local outcome persistence; the default retry
may repeat that effect. The stable idempotency header enables a cooperating
receiver to resolve it. This change does not silently introduce quarantine or
change the public attempt/retention policy.

Native Miniflare fixtures apply the real DDL and exercise concurrent claims,
ignored writes, lost replies, expired leases, late success, stale failure,
dead-lettering, payload identity, retention, REST/MCP status and actual producer/
consumer wiring. Source qualification is distinct from production acceptance.
Migration0038 is already applied,0039/0040 are held preceding proposals, and
0041 must not be merged or applied as an incidental source change.

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
