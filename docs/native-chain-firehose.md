# Native chain transport preparation

The native chain service owns one leased resident instance of the existing
chain hub. Durable state contains its MCP membership and the separate live and
write-repair head cursors. Short PostgreSQL transactions protect state and alarm
claims; RPC work and every connected SSE/WebSocket client remain outside them.

The chain service requires explicit MCP-session, alerter and head-source
capabilities. Missing or malformed native capabilities are a readiness failure.
Native readiness loads the existing GraphQL schema before accepting a socket;
the Worker retains its lazy startup behavior. Long-lived GraphQL subscription
promises are tracked through close without blocking later protocol messages or
unrelated ingestion calls.
Completing a quiet subscription ends its source iterator immediately; it does
not wait for the next chain event to release its slot. A disconnected upload
never reaches the shared actor, while a mutation already accepted by the actor
drains independently of that caller's connection.
Constructing the head source sends no RPC request. Its reads reuse the existing
validated head-poller client and its writes reuse the existing blocks_head
statement, including COALESCE preservation of event count and author.

Native upgrades use the existing HTTP listener through an explicit upgrade
handler. The listener remains opt-in, with an explicit origin, bind address and
limits. Peer identity comes from its socket; incoming forwarding and Cloudflare
identity headers are discarded. The public paths remain the chain stream and
GraphQL paths. Socket admission, payloads, pending writes, subscriptions and
shutdown all have finite bounds.

Constructing the chain service acquires its database lease and arms bounded
lease-renewal and expiry timers. It sends no chain request and starts no alarm
scanner or head-poll loop. The caller explicitly invokes `runDueAlarm()`; the
source poller retains its live cursor, oldest pending write and retry semantics.
Listening also requires an explicit `listenNativeApi()` call. Process
composition, placement, applying the migration and runtime acceptance remain
separate work.

Activation must preserve or explicitly drain the old owner's durable state.
The three keys are `mcp:subscribed-sessions`, `head:last_seen`, and
`head:write_next`. The last key is the oldest unfinished persistence work; the
live cursor cannot substitute for it. Restore a verified source snapshot through
the store's validated, exclusively leased `save` before admitting the new owner,
or prove the prior owner drained every pending write. Starting from an empty
row follows the source's first-start-at-head behavior and is not proof that
historical pending writes were preserved. Live sockets reconnect; they are not
serialized into this state.
