# Realtime chain-event firehose (#2114, ADR 0015)

The `chain_firehose` Postgres channel: a compact, best-effort NOTIFY stream of
every row landing in `blocks`/`extrinsics`/`chain_events`, decoupled from
`indexer-rs`'s own write path so nothing downstream of it can ever affect
whether `indexer-rs` keeps following the chain head. See ADR 0015 for why this
shape was chosen over a direct push from `indexer-rs` (the retired
`metagraphed-streamer`'s exact failure mode, documented in ADR 0014).

## How it works

```
indexer-rs → (writes, as it always has) → Postgres
                                              │
                              AFTER INSERT trigger (deploy/postgres/schema.sql)
                                              │
                                    pg_notify('chain_firehose', <payload>)
                                              │
                          box-side relay (LISTEN, #4981) → Cloudflare Durable Object (#4982, live)
                                                                          │
                                              SSE / WS (#4982, live) / GraphQL subs / MCP (#4983, live)
```

`indexer-rs` requires **zero code changes** and has **zero awareness** any of
this exists — a firehose outage (relay down, Cloudflare unreachable, the
Durable Object itself failing) has exactly one consequence: the live
subscription feed stalls. `indexer-rs`'s writes are unaffected in every
_normal_ failure mode of the downstream firehose (relay/Cloudflare/DO issues
never reach Postgres at all — they're purely downstream of the already-fired
`NOTIFY`).

One caveat, corrected 2026-07-13 after an earlier overstated claim here (found
by adversarial review): the trigger fires _within_ the same transaction as
the insert, before commit — not "after the row is already durably committed."
Its own `EXCEPTION` handler catches errors in its own logic, but Postgres's
commit-time NOTIFY-queue-capacity check happens after the trigger returns and
isn't catchable by it; if that shared queue is ever full at commit, the whole
transaction (including the row insert) fails. See
`deploy/postgres/schema.sql`'s own comment for why this is a narrow,
low-likelihood tail risk given this deployment's single listener (the #4981
relay), not a zero-risk guarantee.

## The trigger (`deploy/postgres/schema.sql`)

`notify_chain_firehose()` is a single `plpgsql` function, reused by three
`AFTER INSERT ... FOR EACH ROW` triggers (one per table), each passed its
logical table name as an explicit trigger argument (`EXECUTE FUNCTION
notify_chain_firehose('blocks')`, read inside as `TG_ARGV[0]`). This is
deliberate, not stylistic: on a TimescaleDB hypertable, `TG_TABLE_NAME`
inside the function body resolves to the physical per-time-range CHUNK name
(e.g. `_hyper_1_379_chunk`), never the logical hypertable name — an earlier
version of this function branched on `TG_TABLE_NAME` and was a silent no-op
on every real insert as a result (verified live 2026-07-12). Payload is a
compact reference — table name + primary-key fields + a couple of headline
columns — not the full row, to stay well under Postgres's 8000-byte `NOTIFY`
payload cap. A subscriber that wants full row detail re-fetches by primary
key. Any error raised inside the trigger (e.g. a future oversized payload) is
swallowed, not propagated — firehose delivery must never be able to fail an
insert.

Row-level, not statement-level: simpler for a first cut, at the cost of one
`NOTIFY` per row rather than one per batch insert. If per-block NOTIFY volume
becomes a real bottleneck, the documented fast-follow is a statement-level
trigger with a `REFERENCING NEW TABLE AS new_rows` transition table.

## The relay (#4981, not yet built)

A new, small, self-hosted process on the indexer box — `LISTEN
chain_firehose;`, forward each notification to the Durable Object over HTTP,
bounded retry/drop-oldest under sustained Cloudflare-side unavailability.
Deployed via the same Ansible-managed convention as the (retired) `streamer`
role — see [`JSONbored/metagraphed-infra`](https://github.com/JSONbored/metagraphed-infra)
— not an ad-hoc SSH-installed process. Unlike the old streamer, this relay is
a pure consumer: it never writes to Postgres and is never in `indexer-rs`'s
critical path, so there is no equivalent of the old blocking-retry-starves-the-subscription
failure mode to guard against here. Its target is the ingest endpoint
documented below.

## The hub + SSE/WS transports (#4982, live)

A single Cloudflare Durable Object, `ChainFirehoseHub`
(`workers/chain-firehose-hub.mjs`) — the first Durable Object this codebase
has used — co-located with the main `metagraphed` Worker (`wrangler.jsonc`'s
`durable_objects`/`migrations` blocks) rather than a dedicated Worker, since
it serves this Worker's own public route directly.

One global instance (`idFromName("global")`) owns two endpoints:

- `POST /api/v1/internal/chain-firehose-ingest` — the #4981 relay's target.
  Shared-secret authenticated (`x-chain-firehose-sync-token` header,
  `timingSafeEqual` against `CHAIN_FIREHOSE_SYNC_SECRET`, matching every
  other `/api/v1/internal/*-sync` route's convention), 503 if the secret
  isn't provisioned, 401 if the token is missing/wrong. The auth check lives
  in `workers/api.mjs`, not inside the Durable Object itself — a DO is never
  internet-addressable on its own, so this Worker's binding is the only path
  in, and the one place a forged request could be rejected.
- `GET /api/v1/chain/stream` — the public read side, no auth (the same
  public data `/api/v1/chain-events` already serves, pushed instead of
  polled). SSE by default (`event: chain` frames, JSON payload matching the
  trigger's NOTIFY shape); a WebSocket `Upgrade` header on the same path gets
  the WS transport instead. Both support `?topics=blocks,extrinsics,chain_events`
  (comma-separated, defaults to all three) to avoid forcing a client to
  consume the full firehose.

Bounded per-connection buffering: an SSE client whose `ReadableStream`
controller falls behind (`desiredSize < 0` against a 64-frame
`CountQueuingStrategy` high-water mark) is dropped rather than left to grow
memory unboundedly. Total concurrent SSE subscribers are capped
(`CHAIN_FIREHOSE_MAX_SSE_CONNECTIONS`) before a new stream is admitted,
bounding the global hub fanout set. WebSocket connections use the hibernation API
(`state.acceptWebSocket`, `WebSocket.serializeAttachment`/
`deserializeAttachment` for the per-connection topic filter,
`state.getWebSockets()` for fanout) so an idle subscriber doesn't pin the
DO's compute — Cloudflare's WebSocket object exposes no confirmed
backpressure signal for hibernatable sockets (no verified `bufferedAmount`
equivalent), so instead of relying on one, total concurrent WS connections
are capped (`CHAIN_FIREHOSE_MAX_WS_CONNECTIONS`) and a dead socket is
reconciled via try/catch around `send()` plus the hibernation runtime's own
`state.getWebSockets()` pruning.

**Hibernation survival (found by adversarial review, 2026-07-13):** a
Durable Object is reconstructed from scratch (constructor runs again) on
every hibernation wake, idle eviction, and Worker code deploy. The
`WebSocket` objects themselves survive that cycle (`state.getWebSockets()`,
tag included), but `graphqlWsSockets`/`graphqlWsServer` are fresh,
in-memory-only state that does not -- an earlier version of this class let a
graphql-ws socket that survived reconstruction but was no longer in the
fresh `graphqlWsSockets` WeakMap silently fall through to the plain-firehose
send path, corrupting the wire protocol for that client (raw JSON instead of
a framed `graphql-transport-ws` message) on every redeploy a graphql-ws
client happened to be connected across. Fixed: `broadcast()`/
`webSocketMessage` now detect this case (tagged via
`state.getWebSockets(GRAPHQL_WS_SOCKET_TAG)`, absent from `graphqlWsSockets`)
and close the socket with `1012` ("Service Restart") instead, so the
client's own reconnect logic re-establishes a fresh handshake -- graphql-ws
has no session-resumption mechanism, so silently trying to "fix" the stale
connection in place isn't an option.

GraphQL `chainEvents` subscriptions are ALSO capped
(`CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS`, also found by adversarial
review): graphql-ws multiplexes many independent subscriptions over one
WebSocket connection and only rejects a _duplicate_ operation id, never a
total count, so the WS connection cap alone doesn't bound subscription count
-- a single connection could otherwise open unboundedly many subscriptions,
each one costing a real `execute()`+`send()` on every future `broadcast()`.
`subscribeChainEvents` returns `null` at the cap; `src/graphql.mjs`'s
resolver turns that into a clear `GraphQLError` rather than hanging the
client on a stream that will never yield.

Testability: this repo has no Durable Object-capable test harness (no
`@cloudflare/vitest-pool-workers`/Miniflare). Every actual decision the hub
makes (topic parsing/matching, ingest payload validation, SSE framing) is a
plain pure function, unit-tested directly
(`tests/chain-firehose-hub.test.mjs`). Most of the DO class itself is ALSO
Node-testable against a stubbed `state` object — `ReadableStream`/
`CountQueuingStrategy`/`TextEncoder` are real Web Streams APIs under plain
Node/vitest, and `state.getWebSockets()` is trivially stubbable — so only the
literal `WebSocketPair`/`state.acceptWebSocket` upgrade branch (no Node
equivalent) is `/* v8 ignore */`-marked, not the whole class.
`tests/chain-firehose-routes.test.mjs` covers the `workers/api.mjs`
routing/auth boundary (mirroring the existing `*-sync-proxy` test shape).

## GraphQL subscriptions (#4983, live)

`Subscription.chainEvents(tables: [ChainFirehoseTable!]): ChainEvent!`
(`src/graphql.mjs`) is a thin protocol adapter over this SAME hub, not a
second event pipeline -- exactly like SSE/WS are. Reached over WebSocket at
the SAME `/api/v1/graphql` path the existing POST query layer uses,
negotiated via `Sec-WebSocket-Protocol: graphql-transport-ws`
([graphql-ws](https://github.com/enisdenjo/graphql-ws)'s wire protocol);
POSTing a subscription operation to the regular query endpoint returns a
standard GraphQL error, same as any other GraphQL server.

`ChainFirehoseHub` owns a `graphql-ws` `Server` instance (`makeServer`) and
adapts it onto the hibernation API: a graphql-ws connection is tagged
(`GRAPHQL_WS_SOCKET_TAG`) and tracked separately from plain firehose sockets
(`graphqlWsSockets`, a `WeakMap` from socket to that connection's graphql-ws
callbacks) so the two populations never cross-contaminate -- a raw firehose
JSON payload landing on a graphql-ws socket would corrupt the wire protocol
for any real client. Each active `chainEvents` subscription is backed by
`createAsyncRepeater()`, a minimal push-based async iterator `broadcast()`
feeds directly (`chainEventSubscribers`), which graphql-js's own `subscribe()`
consumes to produce properly-framed `{type: "next", payload: {...}}` messages.

**Security-reviewed and fixed before merge**: graphql-ws's wire protocol
accepts query/mutation operations over the same `subscribe` message as
subscriptions, not just subscriptions -- left unchecked, a WS client could
execute the full read `Query` type over this transport, bypassing both the
POST endpoint's rate limiter (`graphqlRateLimited`, never consulted for an
upgraded connection) and its `maxDepthRule`/`maxComplexityRule` guards
entirely (graphql-ws only applies bare `specifiedRules` by default).
`makeServer`'s `onSubscribe` hook now runs `validateChainEventsSubscribePayload`
(pure, unit-tested), which rejects any non-subscription operation outright
and otherwise validates with the SAME rule set POST uses.

Unit-tested against graphql-js's real `subscribe()` engine (not a hand-rolled
simulation) and against a stubbed Durable Object `state`. Cloudflare has a
[documented history](https://github.com/cloudflare/workers-sdk/issues/1767)
of not always echoing `Sec-WebSocket-Protocol` on upgrade responses in some
contexts, so this was checked for real rather than assumed from docs alone:
a real `wss` client (Node's native `WebSocket`, requesting the
`graphql-transport-ws` subprotocol) against the live deployment completed
the full `connection_init` → `connection_ack` → `subscribe` → `next`
handshake, `ws.protocol` correctly negotiated as `"graphql-transport-ws"`,
and received a real chain event (block 8608447) as a properly-framed `next`
message -- confirmed 2026-07-13. (The first few attempts immediately after
merge failed with a generic connection error; that was Cloudflare's global
edge propagation lag for the new Worker version, not a protocol bug --
retrying a couple of minutes later succeeded cleanly.)

## MCP resource subscriptions (#4983, live)

Exposes the firehose as an MCP resource (`metagraph://chain/stream`) an agent
client can subscribe to per the MCP resource-subscription spec
(`resources/subscribe` + `notifications/resources/updated`). Unlike GraphQL
subscriptions above, this is deliberately NOT another population on
`ChainFirehoseHub` -- it is a separate Durable Object, `McpSessionHub`
(`workers/mcp-session-hub.mjs`), one instance per `Mcp-Session-Id`. See that
file's own header comment for the full reasoning; in short: MCP's
`resources/subscribe` is a one-shot POST, while the actual push channel is a
separate, reconnect-tolerant GET correlated by session id -- a different
lifecycle primitive than "fan out to whoever's holding a socket right now",
which is what `ChainFirehoseHub`'s other three populations all are.
`ChainFirehoseHub` stays the single source of truth for "an event happened":
a subscribed session is tracked in `mcpSubscribedSessions`, and `broadcast()`
pings each subscribed session's `McpSessionHub` (`POST .../notify`) after the
three existing fan-out loops, best-effort and awaited inline (an unreachable
session DO never blocks ingest).

**Transport**: MCP's ratified transport (2025-06-18 spec) is Streamable
HTTP -- POST for JSON-RPC, plus an optional GET for a standalone SSE push
stream -- not WebSocket (no ratified WS transport exists as of this writing).
`handleMcpRequest` (`src/mcp-server.mjs`) now branches on method: POST is the
pre-existing stateless JSON-RPC path (unaffected for every method other than
`resources/subscribe`/`resources/unsubscribe`); GET forwards to the session's
`McpSessionHub` `/stream` route; DELETE forwards to `/terminate` for explicit
client-initiated cleanup. A session id is minted (`crypto.randomUUID()`, sent
back as an `Mcp-Session-Id` response header) only off a successful
`initialize` call -- every other method stays session-optional, matching the
spec's "session is a feature a server MAY offer" framing. `MCP-Protocol-Version`
is validated when present (absent is treated as the spec's `2025-03-26`
default, not rejected).

**Bounded stream duration, not indefinite hold**: unlike WebSocket, an
SSE-holding Durable Object has no hibernation exemption (hibernation is a
WebSocket-only billing mechanism) -- it stays fully resident for the life of
the stream. The MCP spec's 2025-11-25 revision explicitly added "support
polling SSE streams by allowing servers to disconnect at will", so
`McpSessionHub` closes its stream after `MCP_SESSION_MAX_STREAM_DURATION_MS`
(5 minutes) and expects the client to reconnect via GET again, coalescing any
notification that arrived while no stream was open into one pending marker
per uri (matches `resources/read` always returning current state regardless
of how many events fired in between). A session with no subscribe/stream/
touch activity for `MCP_SESSION_IDLE_TTL_MS` (30 minutes) self-terminates via
a Durable Object alarm.

Both `workers/mcp-session-hub.mjs` and the `src/mcp-server.mjs` additions are
unit-tested at effectively 100% (no `WebSocketPair`-shaped code here, unlike
`ChainFirehoseHub` -- `state.storage` is a plain async KV API and
`ReadableStream` is a real Web Streams API under Node/vitest).

## The alerter (#4984, not yet built)

A consumer of the same hub: evaluates user-defined trigger conditions against
the stream and delivers matches via webhook (reusing the existing
`/api/v1/webhooks/subscriptions` infrastructure), email, Telegram, or
Discord.

## Verifying the trigger locally

```sh
psql "$DATABASE_URL" -c "LISTEN chain_firehose;"
# in another session, insert (or wait for indexer-rs to insert) a row into
# blocks/extrinsics/chain_events — the LISTENing session prints a Notification
```

## Provisioning + verifying the hub (#4982)

The ingest secret is provisioned the same way every other `*_SYNC_SECRET`
is, on the MAIN Worker (the hub is co-located there, not on
`wrangler.data.jsonc`):

```sh
wrangler secret put CHAIN_FIREHOSE_SYNC_SECRET
```

Until #4981's relay is deployed, the ingest endpoint can be exercised
directly to confirm the hub itself is live end-to-end:

```sh
# terminal 1: subscribe (SSE)
curl -N https://api.metagraph.sh/api/v1/chain/stream

# terminal 2: push a synthetic notification
curl -X POST https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest \
  -H "x-chain-firehose-sync-token: $CHAIN_FIREHOSE_SYNC_SECRET" \
  -H "content-type: application/json" \
  -d '{"table":"blocks","block_number":1,"observed_at":"2026-07-12T00:00:00.000Z"}'
# terminal 1 should immediately print the matching `event: chain` frame
```

Full path (`indexer-rs` block → trigger → relay → hub → a real subscriber)
can only be live-verified once #4981 ships and points at this endpoint.
