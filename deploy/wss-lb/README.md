# WSS load balancer (ADR 0013)

A health-aware **WebSocket** reverse proxy that fans client connections out
across the registry's healthy `subtensor-wss` endpoints — the cosmos.directory-
style shared endpoint for the protocol the Cloudflare HTTP proxy can't serve
(`workers/request-handlers/rpc-proxy.mjs` explicitly returns _"WebSocket
JSON-RPC is not available through this HTTP proxy"_).

```
client ──wss──▶  wss-lb  ──wss──▶  healthiest registered subtensor-wss node
                   │
                   └─ refreshes the pool from GET /api/v1/rpc/pools
                      (the `<network>-wss` pool, pool_eligible, fresh tip)
```

## How it routes

- Refreshes from the live `/api/v1/rpc/pools` every `REFRESH_MS` (reuses your
  prober's health — no second health system) and picks the `<network>-wss` pool.
- `selectWssUpstreams` (pure, unit-tested) keeps the pool's `pool_eligible`
  endpoints within `MAX_BLOCK_LAG` of the freshest tip, ordered by score
  (cosmos.directory's "route to the most up-to-date node"). `pool_eligible` is the
  gate — not `status==='ok'` — so the static, unmonitored **testnet** wss pool
  (which the HTTP proxy can't serve at all) is included.
- **Connect-time** selection with handshake failover to the next upstream. A
  mid-session upstream drop closes the client (it reconnects → a fresh upstream);
  JSON-RPC subscription state can't be transparently migrated.

## Endpoints

- `wss://<host>/finney`, `wss://<host>/test` — the load-balanced wss per network.
- `GET /healthz` — `{ ok, pools: {finney: N, …}, last_refresh_ms }` (503 when the
  pool refresh is stale; wired to Railway's healthcheck).

## Run

```bash
cd deploy/wss-lb && npm install && npm start        # local
npm test                                            # selection + proxy-failover tests
```

Railway — one **service** in the shared **metagraphed-core** project (see
[`../README.md`](../README.md#railway-one-project-many-services) for the full
topology):

- Source repo `JSONbored/metagraphed`, branch `main`, **auto-deploy on push**
  (same as metagraphed-streamer). Leave **Root Directory unset**.
- Set the service's **Config-as-code → Railway Config File** to
  `/deploy/wss-lb/railway.json` (absolute path — it does **not** follow Root
  Directory). That config builds `deploy/wss-lb/Dockerfile` from the repo root and
  only redeploys on `deploy/wss-lb/**` changes (`watchPatterns`).
- `railway domain` to mint the public WSS endpoint, then point Cloudflare DNS at it
  for TLS + DDoS.

```bash
# from a clone linked to the metagraphed-core project (railway link)
railway add --service wss-lb --repo JSONbored/metagraphed --branch main
# set Config File = /deploy/wss-lb/railway.json (dashboard), then:
railway domain
```

It needs **no siblings** (it reads only the public API), but lives in the same
project so it shares one dashboard/bill and can later use private DNS.

Env: `METAGRAPHED_API` (default `https://api.metagraph.sh`), `PORT` (8080),
`REFRESH_MS` (30000), `MAX_BLOCK_LAG` (50), `NETWORKS` (`finney,test`),
`HANDSHAKE_TIMEOUT_MS` (10000), `MAX_CONNECTIONS_PER_IP` (20),
`CONNECT_RATE_LIMIT` (30), `CONNECT_RATE_WINDOW_MS` (60000).

## Abuse control (#6444)

Per-IP connection cap + rolling connect-rate limit, checked at CONNECT time
before any upstream dial (`src/rate-limit.mjs`). Client IP is
`cf-connecting-ip` (Cloudflare terminates in front of this service), falling
back to `x-forwarded-for` then the raw socket address. A rejected upgrade
gets `429 Too Many Requests` with `Retry-After`. In-memory, single-instance —
matches this service's own single-container deploy model.

## Integration-pending + follow-ups

- The live ws-piping is verified on deploy; only the pure selection is unit-tested.
- Optional API-key tiering (higher budgets for known/trusted callers).
- gRPC is intentionally **not** offered — Bittensor is Substrate (JSON-RPC + wss),
  not Cosmos-SDK gRPC.
- Optional next: an SSE fan-out for subnet streaming surfaces; per-upstream usage
  metrics mirrored into the existing `rpc_proxy_events` analytics.
