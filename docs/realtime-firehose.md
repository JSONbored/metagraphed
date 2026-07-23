# Realtime chain-event firehose (#2114, ADR 0015)

The `chain_firehose_outbox` table is a compact, best-effort stream source for
every row landing in `blocks`/`extrinsics`/`chain_events`/`account_events`
(the last added for #4984 -- see below), decoupled from `indexer-rs`'s own
process so downstream delivery cannot block the chain follower. See ADR 0015
for why this shape was chosen over a direct push from `indexer-rs` (the
retired `metagraphed-streamer`'s exact failure mode, documented in ADR 0014).

## How it works

```
indexer-rs → (writes, as it always has) → Postgres
                                              │
                              AFTER INSERT trigger (deploy/postgres/schema.sql)
                                              │
                                 INSERT chain_firehose_outbox(payload)
                                              │
              box-side relay (poll/claim rows, #4981/#5027, live) → Cloudflare Durable Object (#4982, live)
                                                                          │
                                              SSE / WS (#4982, live) / GraphQL subs / MCP (#4983, live)
```

this exists. The trigger writes compact references into a normal Postgres
outbox table in the same transaction as the indexed row. Downstream consumers
never use `LISTEN`/`NOTIFY`, so a stuck relay or any other listener cannot pin
Postgres's global async notification queue and make source-table commits fail
at commit time. Ordinary local database failures (for example disk exhaustion)
remain database failures; relay, Cloudflare, or Durable Object outages only
leave outbox rows pending.

## The trigger (`deploy/postgres/schema.sql`)

`enqueue_chain_firehose()` is a single `plpgsql` function, reused by three
`AFTER INSERT ... FOR EACH ROW` triggers (one per table), each passed its
logical table name as an explicit trigger argument (`EXECUTE FUNCTION
enqueue_chain_firehose('blocks')`, read inside as `TG_ARGV[0]`). This is
deliberate, not stylistic: on a TimescaleDB hypertable, `TG_TABLE_NAME`
inside the function body resolves to the physical per-time-range CHUNK name
(e.g. `_hyper_1_379_chunk`), never the logical hypertable name — an earlier
version of this function branched on `TG_TABLE_NAME` and was a silent no-op
on every real insert as a result (verified live 2026-07-12).

Payload is a compact reference — table name + primary-key fields + a couple
of headline columns — not the full row. A subscriber that wants full row detail
re-fetches by primary key. The function inserts that payload into
`chain_firehose_outbox`; the relay claims pending rows using the indexed
`delivered_at IS NULL` view of the table and then forwards them.

Row-level, not statement-level: simpler for a first cut, at the cost of one
outbox row per source row rather than one per batch insert. Per-block volume
DID become a real bottleneck (#6672: sustained production outgrew the
ingest endpoint's rate limit by ~3.5-4x) — the fix taken was downstream
request-level batching (see the relay section below), not a statement-level
trigger; the row-level outbox design here is unchanged. A
`REFERENCING NEW TABLE AS new_rows` transition table remains a possible
future fast-follow if outbox INSERT volume itself (not ingest-request volume)
ever becomes the bottleneck instead.

## The relay (#4981, live)

A new, small, self-hosted process on the indexer box polls and claims pending
`chain_firehose_outbox` rows, groups them into `CHAIN_FIREHOSE_INGEST_BATCH_SIZE`-sized
chunks and forwards each chunk as one JSON-array POST body to the Durable
Object over HTTP (#6672 -- the ingest rate limit costs by request, not
payload size, so batching multiplies effective throughput without touching
that limit), and uses bounded retry/drop-oldest behavior under sustained
Cloudflare-side unavailability. It does **not** `LISTEN` on a Postgres channel:
PostgreSQL delivers `NOTIFY` at transaction commit and its global notification
queue can be held back by a listener that remains in a transaction; if that
queue fills, committing transactions that executed `NOTIFY` can fail outside a
trigger-local exception block.

The relay is deployed via the same Ansible-managed convention as the (retired)
`streamer` role — see [`JSONbored/metagraphed-infra`](https://github.com/JSONbored/metagraphed-infra)
— not an ad-hoc SSH-installed process. Unlike the old streamer, this relay is
a pure consumer: it only ever writes to `chain_firehose_outbox` itself
(claiming rows via `delivered_at`, cleanup deletes), never to `indexer-rs`'s
source tables, and is never in `indexer-rs`'s process-level critical path, so
there is no equivalent of the old blocking-retry-starves-the-subscription
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
  in, and the one place a forged request could be rejected. The body is
  either one payload object (broadcast once) or a JSON array of up to
  `CHAIN_FIREHOSE_MAX_INGEST_BATCH_SIZE` payload objects (#6672, broadcast
  in order, sequentially) — additive, so older single-object callers are
  unaffected.
- `GET /api/v1/chain/stream` — the public read side, no auth (the same
  public data `/api/v1/chain-events` already serves, pushed instead of
  polled). SSE by default (`event: chain` frames, JSON payload matching the
  trigger's outbox payload shape); a WebSocket `Upgrade` header on the same path gets
  the WS transport instead. Both support
  `?topics=blocks,extrinsics,chain_events,account_events` (comma-separated,
  defaults to all four) to avoid forcing a client to consume the full
  firehose.

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

**Per-IP sub-quotas (#5004):** every cap above is global, so one actor
looping past it could otherwise lock out every other client of that
transport. `CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP` (20, `resolveClientIp`)
bounds SSE connections, plain-firehose WS connections, and graphql-ws
socket upgrades per IP -- well under the global caps, tracked via
`sseClientsByIp`/`wsClientsByIp` and released on the same
connect/disconnect lifecycle hooks the underlying `sseClients`/
`state.getWebSockets()` bookkeeping already uses, so the two can never
drift apart. Because hibernatable WebSockets survive Durable Object
reconstruction while in-memory Maps do not, the WS per-IP count is rebuilt
from each surviving socket's serialized `{ ip }` attachment before every WS
admission check. A WS-connection cap alone doesn't bound how many `chainEvents`
subscriptions get multiplexed onto one already-open graphql-ws socket
(graphql-ws itself imposes no per-socket subscription limit), so
`CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS_PER_IP` (20) is a second,
independent sub-quota on subscription count, with the connecting IP
threaded from the WS upgrade through graphql-ws's own `opened()`/`context()`
extension point (`ctx.extra.ip` -> `context.clientIp`) into
`subscribeChainEvents`. The SSE and GraphQL-subscription per-IP Maps remain
in-memory only; unlike accepted WebSockets, those live stream/subscription
objects do not survive Durable Object reconstruction.

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
`ReadableStream` is a real Web Streams API under Node/vitest), and
`scripts/validate-mcp.ts` runs the full `subscribe -> ingest -> notify ->
read` round trip through two real (in-memory-backed) Durable Object
instances on every CI run.

**Verified live against the deployed Worker** (same bar as #4982's SSE/WS and
this issue's own GraphQL-subscriptions verification, both above): a real
client completed the full `initialize` (session minted) -> `resources/
subscribe` -> `GET` (SSE stream opens) -> `resources/read` -> `resources/
unsubscribe` -> `DELETE` (terminate) -> `GET` (404, session gone) lifecycle
against `https://api.metagraph.sh/mcp`, and the push itself carried a real
chain event: block 8608870, a `Balances.Deposit` `chain_events` row --
confirmed 2026-07-13, immediately after #5007 merged and propagated (no
Cloudflare edge-propagation retry needed this time, unlike the graphql-ws
verification above).

## The alerter (#4984, live)

A consumer of the same hub: evaluates user-defined trigger conditions against
the stream and delivers matches via webhook, email, Telegram, or Discord.
Landed in three parts, each its own PR (matching every other piece of this
epic):

**Part 1 (live): trigger storage + CRUD.** A new `chain_alert_triggers`
Postgres table (`deploy/postgres/schema.sql`) and public CRUD routes at
`/api/v1/alerts/triggers` (`workers/data-api.mjs`, proxied through
`workers/api.mjs`). Ownership is a bearer `owner_token` (returned once, at
creation) -- matching the webhook-subscription secret model, since no
user-account system exists here -- and unlike webhook subscriptions there is
NO public GET: a trigger's `destination` can itself be a capability
credential (a Discord incoming-webhook URL). Trigger conditions
(netuid/event_kind/account/min_amount_tao) are drawn from `account_events`'
own columns, which is exactly why that table got its own firehose-tee
prerequisite above -- none of `blocks`/`extrinsics`/`chain_events` carry
those fields.

**Part 2 (live): the AlerterHub evaluator.** A new singleton Durable Object
(`workers/alerter-hub.mjs`, `idFromName("global")`) that `ChainFirehoseHub`
pings unconditionally on every `broadcast()` -- mirroring the #4983
MCP-notify loop's shape, but without a per-session Set, since there is
exactly one evaluator. Caches active trigger definitions (refreshed from
Postgres via `DATA_API`'s internal-only active-list route, TTL
`ALERTER_HUB_TRIGGER_CACHE_TTL_MS` = 5 minutes) rather than a per-event
Postgres round-trip, since evaluation shares the same `broadcast()` call
every other consumer (SSE/WS/GraphQL/MCP) is waiting on.

**Part 3 (live): delivery.** `deliverAlertMatch` (`workers/alerter-hub.mjs`)
dispatches to all four channels via pure request builders in the new
`src/alert-delivery.mjs`: webhook (a `metagraph.alert` JSON envelope POSTed
to the trigger's own `destination`, re-validated against
`isPublicWebhookUrl` at delivery time as defense in depth), Discord (a
`{content}` POST to the trigger's own incoming-webhook URL, truncated to
Discord's 2000-char cap), Telegram (`sendMessage` against a single
per-deployment bot -- `TELEGRAM_BOT_TOKEN` -- targeting the trigger's own
`chat_id`), and email (Resend's HTTP API, `RESEND_API_KEY` +
`RESEND_FROM_ADDRESS`). Telegram/email silently no-op when their secret
isn't provisioned, matching every other optional integration's convention
here.

Two deliberate v1 scope cuts, both documented rather than silent: delivery
is single-attempt (no retry/dead-letter, unlike `src/webhooks.mjs`'s own
`deliverChangeEvent` -- these are lower-stakes "ping me" notifications, not
a change feed automated pipelines depend on), and webhook payloads are NOT
HMAC-signed (signing would need the per-trigger `owner_token` threaded
through the evaluator's trusted-internal cache, which
`evaluatorAlertTriggerView` deliberately never exposes past the CRUD layer
today). Both are easy fast-follows if real-world use surfaces a need.

**Burst rate-limiting** (`AlerterHub.evaluate()`, `src/alert-delivery.mjs`'s
`isDeliveryRateLimited`): at most one delivery per trigger per
`ALERT_DELIVERY_MIN_INTERVAL_MS` (1 minute), in-memory per DO instance. A
burst of matching events within the window still counts toward `matched` in
the evaluation response (an owner asking "did this fire?" gets the true
answer) but only the first delivers -- the rest are reported as
`rate_limited`, not silently dropped from the response shape.

**Part 4 (live): adversarial-review remediation.** After Part 3 merged, a
dedicated adversarial-review pass (independent security/correctness/
resource-exhaustion lenses, each candidate finding re-verified by two
skeptical agents before being treated as real) surfaced six confirmed
issues, all fixed on top of the merged code rather than folded silently into
Part 3's own history:

- **PATCH-as-full-replace on `chain_alert_triggers`** (the most severe
  finding): `handleAlertTriggerUpdate` originally validated a PATCH body
  directly against the CREATE-shared validator, so any condition field the
  caller didn't resend was silently defaulted to unset -- unintentionally
  _widening_ a trigger's match scope on every partial edit (e.g. renaming a
  netuid-scoped trigger without resending `netuid` dropped the netuid filter
  entirely). Fixed by merging the incoming body onto the existing row before
  validating (`omitNullValues` + merge in `workers/data-api.mjs`). An
  explicit `null` in a PATCH body is a no-op (keeps the existing value), not
  a clear -- `validateAlertTriggerInput` rejects a real `null` for most
  fields, so there's currently no supported way to explicitly clear an
  optional condition field via PATCH short of delete + recreate.
- **Existence oracle via differentiated 403/404**: GET/PATCH/DELETE all
  returned 403 for "wrong owner token" vs 404 for "no such trigger",
  letting an unauthenticated caller enumerate trigger existence over
  sequential ids with zero credentials. `requireAlertTriggerOwner` now
  returns the same 404 either way.
- **Unbounded trigger creation**: `ALERT_TRIGGER_CREATE_TOKEN` is a shared
  anti-abuse secret, not a per-user credential -- it didn't bound request
  _volume_ from a legitimate holder, and every created row is a permanent
  per-event cost in `AlerterHub.matchingTriggers()`'s scan. A
  Workers-native rate limiter (`ALERT_TRIGGER_CREATE_RATE_LIMITER`, 10/min
  per IP, `wrangler.data.jsonc`) now gates creation; skipped when unbound
  (local dev/CI).
- **Two missing timeouts**: `AlerterHub.refreshTriggers()`'s Hyperdrive
  fetch (`ALERT_TRIGGER_REFRESH_TIMEOUT_MS`, 4s) and
  `ChainFirehoseHub.broadcast()`'s own ping to the `AlerterHub` singleton
  (`ALERTER_HUB_EVALUATE_TIMEOUT_MS`, 15s, `workers/chain-firehose-hub.mjs`)
  both had no independent ceiling -- a slow Postgres query or a slow
  delivery fan-out could stall `broadcast()` itself, delaying every OTHER
  firehose consumer's (SSE/WS/GraphQL/MCP) response, not just the alerter's.
- **Unbounded delivery-fan-out concurrency**: a single chain event can match
  many distinct triggers; `evaluate()`'s delivery loop now runs through
  `mapBounded` (exported from `src/webhooks.mjs`, `ALERT_DELIVERY_CONCURRENCY`
  = 8) instead of an unbounded `Promise.all`.

One finding remains deliberately deferred as its own tracked issue rather
than rushed in under time pressure:

- [#5021](https://github.com/JSONbored/metagraphed/issues/5021) -- neither
  this alerter's webhook/Discord delivery nor the pre-existing
  webhook-subscription delivery (`src/webhooks.mjs`) actually re-resolves
  DNS at request time; the codebase's own `resolveHostnames`-based SSRF
  defense turns out to be Node-only (`scripts/dispatch-webhooks.mjs`'s cron
  script) and was never reachable from the live Worker in the first place.
  A real fix needs DNS-over-HTTPS via `fetch()`, shared across both paths.

Three more findings from the same review -- [#5022](https://github.com/JSONbored/metagraphed/issues/5022)
(`match_count`/`last_matched_at` were schema columns nothing wrote to),
[#5023](https://github.com/JSONbored/metagraphed/issues/5023) (the burst
rate-limit timestamp was set before delivery was even attempted, so a
failed delivery silently consumed the window as if it had succeeded), and
[#5024](https://github.com/JSONbored/metagraphed/issues/5024) (the
`lastDeliveredAt` Map was never pruned) -- have since shipped. `evaluate()`
now writes match counts back to Postgres concurrently with the delivery
fan-out (bounded by its own `ALERT_TRIGGER_MATCH_WRITEBACK_TIMEOUT_MS`,
best-effort, never adding to the fan-out's own latency), rolls the
rate-limit timestamp back on a failed/non-2xx/timed-out delivery so the
very next match retries immediately instead of waiting out the window, and
prunes `lastDeliveredAt` of any trigger id no longer active at the end of
every successful `refreshTriggers()`.

## Verifying the trigger locally

```sh
psql "$DATABASE_URL" -c "SELECT count(*) FROM chain_firehose_outbox WHERE delivered_at IS NULL;"
# in another session, insert (or wait for indexer-rs to insert) a row into
# blocks/extrinsics/chain_events/account_events, then query the pending
# outbox rows again.
```

## Provisioning + verifying the hub (#4982)

The ingest secret is provisioned the same way every other `*_SYNC_SECRET`
is, on the MAIN Worker (the hub is co-located there, not on
`wrangler.data.jsonc`):

```sh
wrangler secret put CHAIN_FIREHOSE_SYNC_SECRET
```

The #4981 relay is deployed and live — verified directly against the running
infrastructure: `chain_firehose_outbox` on the indexer box's Postgres has zero
pending rows, with the most recent row delivered within ~7s of being written.
The ingest endpoint below can still be exercised directly to isolate the hub
itself from the rest of the path when debugging:

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

Full path (`indexer-rs` block → trigger → relay → hub → a real subscriber) is
live-verified: 284,248 outbox rows delivered as of this writing, zero
pending, newest row delivered ~7s after being written.
