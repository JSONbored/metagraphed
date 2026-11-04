# Native resident MCP session preparation

`createNativeMcpSessions(runtime, options)` prepares the existing
`McpSessionHub` as a resident native service. It does not start an HTTP listener,
a fleet job or a recurring alarm poller. The caller supplies the shared
PostgreSQL runtime and explicit chain/subnet reverse services. Lease renewal and
idle-eviction timers exist only while a session is resident.

Each session has one cached hub instance so `/stream` and `/notify` share the
same live SSE controller. Membership, pending URI, sequence, session identity
and termination fields keep their original schema. State and encoded session
keys are JSON text, preserving NUL and lone-surrogate strings that JSONB would
reject. Database-enforced total session and state-byte capacity and a per-state byte bound
prevent unbounded durable growth. Unknown read-only sessions discard their
unchanged empty row; terminated records remain durable until separately reviewed
retention work removes them.

A fresh random token exclusively leases each resident session. Short database
transactions check that token and the database expiry before state/alarm writes.
No pool connection stays open with an SSE stream or during a reverse-service
call. The local safe deadline uses the database lease duration minus the full
monotonic request roundtrip; it does not compare client and database wall clocks.
Renewals that fail, arrive late or have uncertain ownership close the stream and
refuse further writes. A guard checks that deadline before every queued frame,
so a paused timer cannot let the old owner continue sending after expiry.

Calls to a resident hub serialize through a bounded queue. Issued storage work
and background work finish before a call leaves that queue. Successful calls
persist the current sequence and conservatively retain previously durable pending
markers before returning. Only the owner's subscription mutations acknowledge
those markers, preserving its preference for a duplicate over a missed update. A
live native notification also retains its URI until explicit unsubscribe or
termination. The bridge waits for the serial state commit before exposing a
frame; disconnecting between that commit and the enqueue leaves a replayable
marker. This intentionally strengthens delivery to at least once relative to the
Worker path, so reconnecting may repeat a URI with a newer sequence number. A
process failure during delivery can still duplicate a pointer notification;
there is no exactly-once delivery claim, and the existing Last-Event-ID replay
placeholder is unchanged. The native stream has a finite frame queue and the
bridge prefetches at most one chunk. Backpressure closes a stalled stream while
retaining its undelivered URI for reconnect. Replacing or canceling an older
stream cannot clear its newer replacement.

`runDueAlarms(limit)` is an explicit bounded invocation of the real idle/cleanup
handler. Alarm versions and claim tokens preserve a new `setAlarm` made during
an older firing. Callback failures retry with bounded exponential delays;
exhaustion is recorded durably. The existing handler's own five-minute reverse-
cleanup re-arm remains authoritative and is reported as re-armed, not as a
completed session expiry. Process loss leaves the alarm claim recoverable after
its session lease expires.

The service exposes finite resident, call, body, state, queue, renewal, idle and
drain limits. An execution timeout closes the affected resident; an
uncooperative callback remains tracked until it really exits. `close()` stops
admission, closes streams, stops timers and drains owned work. A drain timeout
keeps the service closing so the owner cannot mistake it for completed shutdown.
The shared PostgreSQL pool remains the caller's responsibility.

`MCP_SESSION_SERVICE` selects this service at the existing MCP initialize,
subscribe, unsubscribe, stream, termination and realtime notification callers.
An absent capability retains the current Worker namespace path; a malformed
selected one fails closed. `CHAIN_FIREHOSE_SERVICE` provides the existing
reverse-subscription protocol without emulating a Durable Object namespace.
The chain's native WebSocket/GraphQL transport and head-polling actor remain
separate work.
