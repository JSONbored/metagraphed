# ADR 0002 — Live operational health (15-minute cron prober → D1/KV → served live)

- **Status:** Accepted — implemented (Phases 1–5, PRs #252–#257).
- **Date:** 2026-06-10
- **Relates to:** ADR 0001 (R2-only data artifacts, 6h scheduled publish).

## Context

The backend served **all** health from the same 6h batch as structural data:
`scripts/probes-smoke.mjs` probed ~1,140 surfaces during `sync-subnets.yml`
(2×/day), and the results were baked into static R2 artifacts. Two problems:

1. **Staleness.** Operational health (RPC/WSS chain nodes, subnet APIs, SSE) was
   only as fresh as the last successful 6h publish — a 6h-old "endpoint is up" is
   operationally useless.
2. **Coupling cascade.** `surface-health` was a **blocking** publish-freshness
   source, and the publish gate also blocks on `native-subnets`. When
   `sync-subnets` fell behind on chain-RPC rate-limits, native data went >24h
   stale → the freshness gate aborted the **entire** publish → **all data,
   including health, froze** for ~a day before anyone noticed.

Operational health and structural data have fundamentally different freshness
needs, but shared one pipeline.

## Decision

Split the two data classes. Keep slow/structural data on the 6h build. Move the
**~49–58 operational surfaces** (`subtensor-rpc`, `subtensor-wss`, `archive`,
`subnet-api`, `sse`, `data-artifact`) onto a **dedicated live pipeline**:

```
EVERY 15 MIN (Cloudflare Cron Trigger, workers/api.mjs scheduled())
  load operational-surfaces.json (committed) → probe with the shared isomorphic
  core (src/health-probe-core.ts) under bounded concurrency →
    D1 surface_checks  (append-only time-series → /health/trends)
    D1 surface_status  (latest row + circuit-breaker counter)
    KV health:current / health:rpc-pool / health:meta  (hot snapshots)

SERVING (workers/api.mjs): /api/v1/health, /subnets/{n}/health, badges,
  /rpc/endpoints + the RPC proxy pool, and /freshness OVERLAY the live snapshot
  onto the static artifact, falling back to static when the snapshot is cold.
  NEW /api/v1/subnets/{n}/health/trends reads D1 directly.
```

Key properties:

- **Isomorphic probe core.** `src/health-probe-core.ts` holds the probe +
  classification logic, shared verbatim by the Node 6h build and the Worker cron
  (fetch / SSRF guard / WebSocket connector injected). WSS is probed from the
  Worker via `fetch(Upgrade: websocket)` (Workers have no `new WebSocket()` for
  outbound).
- **Fallback everywhere.** Every live read returns null/unchanged when KV/D1 is
  cold and the caller serves the static artifact — zero-downtime, regression-proof
  rollout; the live path engages automatically once the cron warms KV.
- **Decoupled gate.** `surface-health` is now **warn-only** (`required_for_publish
= false`); operational health can never block publish again. The structural
  freshness windows are env-configurable (`METAGRAPH_FRESHNESS_BLOCKING_HOURS`).
- **Hardened sync.** The chain-RPC native fetch retries with backoff
  (`METAGRAPH_NATIVE_FETCH_ATTEMPTS`); `sync-subnets` runs every 6h; publish/sync
  failures alert via `METAGRAPH_ALERT_WEBHOOK_URL`.

## Why not alternatives

- **Real-time per-request probing** — a Worker can't crawl hundreds of
  third-party endpoints per request (rate limits, latency, subrequest caps).
- **Durable Object / Queue prober** — overkill at ~58 endpoints; one 15-minute
  cron with bounded concurrency sits far under the 30s CPU / 15-min duration /
  10k-subrequest limits. Revisit if per-endpoint staggered scheduling is needed.
- **Probe everything live** — the ~1,091 docs/website/repo surfaces rarely change
  and stay on the 6h build; only operational surfaces need minute-level freshness.

## Outcome

Operational health is fresh to **~15 minutes** (was 6h). `/health` reports
`operational_health.last_run_at` for monitoring. D1 time-series powers
`/health/trends` (7d/30d uptime + latency). The cascade is structurally
impossible: health no longer depends on the publish, the freshness gate, or
`sync-subnets`. Cost stays within free/cheap Cloudflare limits (cron + D1 + KV).
