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
npm test                                            # pure-selection tests
```

Railway: add a service with **Root Directory = `deploy/wss-lb`** (the bundled
`railway.json` and `Dockerfile` do the rest). Put it behind Cloudflare DNS for
TLS + DDoS.

Env: `METAGRAPHED_API` (default `https://api.metagraph.sh`), `PORT` (8080),
`REFRESH_MS` (30000), `MAX_BLOCK_LAG` (50), `NETWORKS` (`finney,test`),
`HANDSHAKE_TIMEOUT_MS` (10000).

## Integration-pending + follow-ups

- The live ws-piping is verified on deploy; only the pure selection is unit-tested.
- **Before public exposure:** per-IP connection rate-limiting / abuse caps (a
  public wss proxy is a DoS amplifier), and optional API-key tiering.
- gRPC is intentionally **not** offered — Bittensor is Substrate (JSON-RPC + wss),
  not Cosmos-SDK gRPC.
- Optional next: an SSE fan-out for subnet streaming surfaces; per-upstream usage
  metrics mirrored into the existing `rpc_proxy_events` analytics.
