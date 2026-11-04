# Native subnet-status actor preparation

The current realtime owners have different lifetimes. `ChainFirehoseHub` owns
head cursors, polling alarms, live SSE and hibernatable WebSocket/GraphQL
connections. `McpSessionHub` owns per-session state, replay/coalescing, one
resident SSE stream, keepalives and idle/cleanup alarms. `SubnetStatusHub` owns
only the persisted `byNetuid` membership index and pointer notification fanout.
`AlerterHub` holds a process cache without durable storage; `NeonWriteBufferHub`
has chunked statement state and alarms but no current Wrangler binding. Their
legacy migration declarations alone are not evidence of active traffic.

`createPgSubnetStatusHub(runtime, options)` prepares only the subnet-status
actor. It instantiates the existing `SubnetStatusHub` for each request and uses
`realtime.subnet_status_actor` from migration `0031_subnet_status_actor.sql` for
its original keyed storage shape. Serialized JSON remains text, so valid session
strings containing NUL or lone surrogates are preserved rather than rejected by
PostgreSQL jsonb. The stored text is JSON-validated and its exact bytes are bounded. Membership changes acquire one row lock in
READ COMMITTED, hydrate the current index, and commit the existing handler's
writes atomically. Concurrent processes cannot overwrite each other's members.
Failed mutations roll back; a later request creates a fresh handler instance.

The caller supplies finite request, membership, state-byte, concurrency,
execution and drain bounds. Request bodies are collected within finite byte,
chunk-count and execution bounds before taking a database lock. A notification request reads
one consistent membership snapshot, releases its database connection, and only
then contacts sessions. Notification concurrency is bounded per request, while
request admission bounds the process total. The underlying notifier receives an
abort signal; an uncooperative call remains tracked and retains its request slot
until it finishes, even after an execution or drain timeout.

`SUBNET_STATUS_SERVICE` explicitly selects the native service for the health
producer and the MCP session's subscribe, unsubscribe and termination paths.
An absent capability retains the current Worker namespace path. A malformed
selected capability fails closed and cannot silently return to that namespace.
The existing health producer still reports failures without throwing into the
health write. MCP reverse-registration failures keep their existing errors.

The native service requires a session notifier supplied by its owner. It does
not implement or activate MCP sessions. The notifier's resolved response is a
completed call, matching the existing hub, including a resolved missing-session
response; rejection is not counted. The returned `delivered` count is therefore
not proof that a subscriber received or read an SSE event. State may change
after the membership snapshot, and process loss or client retry can duplicate
pointer notifications. These are the existing best-effort semantics; there is
no exactly-once delivery claim or durable notification outbox.

No listener, recurring alarm, production binding, imported state or fleet job
is installed by this preparation. Stop admission and await the service's
`close()` before closing its shared PostgreSQL pool. The service never closes
that pool. MCP resident SSE ownership, chain WebSocket/GraphQL transport and the
alarm-backed owners remain separate migration work.
