# Metagraphed Backend Operations

## Source Of Truth

GitHub-reviewed registry source, compact generated indexes, and compact release manifests are canonical for v1. High-churn generated detail is staged under `dist/metagraph-r2/metagraph` and published to R2; Cloudflare serves and stores artifacts, but it does not become the registry truth source.

## Routine Validation

```bash
npm run pipeline:check
```

This performs dry-run sync/discovery/verification, contract validation, Worker runtime checks, workflow validation, public-safety scanning, and tests.

The contract checks include schema bundle drift, schema/query enum parity, OpenAPI example validation, generated TypeScript freshness, and generated client freshness.

## Operator Briefs

Contributor curation:

```bash
npm run curation:brief
```

Endpoint operations:

```bash
npm run endpoint:brief
```

The endpoint brief summarizes monitored resources, root RPC/WSS/archive advisory pools, provider scores, incidents, and the disabled proxy contract from existing artifacts. Health, latency, latest block, incidents, and pool eligibility remain probe-derived only.

## Refreshing Artifacts

```bash
npm run pipeline:refresh
```

This updates native subnet data, candidates, verification, baseline curation, adapter snapshots, generated artifacts, schema snapshots, R2 manifest, and validation outputs.

The refresh keeps Git reviewable: compact artifacts remain in `public/metagraph`, while per-subnet candidates, verification details, health detail/history, adapter snapshots, schema snapshots, and provider detail outputs are staged for R2 and should not be committed.

Candidate discovery reads public enrichment sources such as TaoMarketCap,
Backprop Finance dashboard routes, Taostats metagraph dashboard routes,
Tensorplex `subnet-docs`, and Taopedia articles. Set `GITHUB_TOKEN` or
`GH_TOKEN` for authenticated read-only GitHub API requests during local
refreshes; scheduled sync and publish workflows already pass `GITHUB_TOKEN`
from GitHub Actions.

Live health probes are only written when explicitly enabled:

```bash
METAGRAPH_WRITE_PROBE_RESULTS=1 npm run pipeline:refresh
```

## Cloudflare Publish

The `Publish Cloudflare Backend` workflow is fail-closed for `main` pushes:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must be configured as
GitHub Actions secrets or the publish run fails before any upload/deploy step.
Manual `workflow_dispatch` runs can choose `publish_mode=dry-run` for
validation-only checks; dry-run mode must not upload to R2, publish KV, deploy
the Worker, or claim a production publish.

Before publishing:

```bash
npm run cloudflare:verify:dry-run
npm run r2:upload:dry-run
npm run kv:publish:dry-run
npm run worker:deploy:dry-run
```

Actual writes require explicit environment gates:

- `METAGRAPH_ALLOW_R2_UPLOAD=1`
- `METAGRAPH_R2_UPLOAD_HISTORY=1` when the publish job should also write run-prefix history copies for all planned artifacts and control files.
- `METAGRAPH_R2_UPLOAD_FORCE=1` when a publish job should ignore the remote `latest/r2-manifest.json` comparison and republish every planned artifact.
- `METAGRAPH_R2_UPLOAD_LIMIT` for smoke-only uploads against a small artifact subset. Limited smoke uploads skip control files so `latest/r2-manifest.json` continues to describe only a complete latest artifact set.
- `METAGRAPH_ALLOW_KV_WRITE=1`
- `METAGRAPH_KV_NAMESPACE_ID`
- Cloudflare account/API credentials

Normal R2 publishes are delta-based. The uploader reads `latest/r2-manifest.json`, compares artifact SHA-256 values, reads R2-tier files from the staging tree, skips unchanged artifact files, and refreshes `latest/r2-manifest.json` plus `latest/build-summary.json` on full uploads so Worker fallback and operator summaries stay current.

After the Worker is deployed, run the live smoke gate:

```bash
npm run smoke:live
```

The live smoke checks `metagraph.sh` API envelopes, Worker-mediated raw artifact routes, CORS/cache headers, R2-backed detail routes, invalid-query errors, and verifies the v1 RPC proxy still returns `rpc_proxy_disabled`.

## Restore From R2

Dry-run:

```bash
npm run r2:download:dry-run
```

Write mode verifies downloaded SHA-256 hashes against `public/metagraph/r2-manifest.json`.

```bash
METAGRAPH_ALLOW_R2_DOWNLOAD=1 npm run r2:download
```

## Health & Freshness Monitoring

`GET /health` is the readiness + freshness probe (no auth, lightweight, edge-cached
60s). It reports binding wiring and the age of the published data:

```json
{
  "status": "ok",
  "bindings": { "assets": true, "r2": true, "kv": true },
  "freshness": {
    "published_at": "…",
    "age_hours": 1.2,
    "max_age_hours": 12,
    "stale": false
  }
}
```

- `published_at` comes from the KV `metagraph:latest` pointer, which the scheduled
  refresh advances every ~6h.
- When the data is older than `max_age_hours` (default 12 — two missed 6h refreshes;
  override with `METAGRAPH_HEALTH_MAX_AGE_HOURS`), `status` becomes `degraded` and the
  route returns **HTTP 503**. Point an uptime monitor at `https://api.metagraph.sh/health`
  so a silently-broken data-refresh pages instead of serving stale data unnoticed.
- A present-but-stale pointer trips it; a missing pointer (local/dev) stays `ok`.

## Adapter Data-Quality Guard

`npm run validate:adapters` rejects an adapter snapshot that degraded to broken
GitHub auth / all-HTML-fallback (Finding 1). It **warns** in ordinary PR validation
and **fails** (exit 1) when `METAGRAPH_PRODUCTION_BUILD=1` or
`METAGRAPH_REQUIRE_ADAPTER_AUTH=1` — so the scheduled publish and `sync-subnets` runs
refuse to ship degraded adapter data after a token break.

## Enabling the RPC Proxy

The read-only Subtensor RPC proxy (`POST /rpc/v1/finney`, `/rpc/v1/finney/wss`) ships
**disabled** (`METAGRAPH_ENABLE_RPC_PROXY: "false"`). The Worker-side abuse controls
are in place; enable it only after the dashboard-side WAF step and a live smoke.

Already enforced in the Worker:

- **Method allowlist** — read-only `SAFE_RPC_METHODS` only; `DENIED_RPC_PREFIXES`
  (`author_`, `state_call`, `sudo_`, `payment_`, `contracts_`) and heavy reads
  (`state_getMetadata`, `state_getStorage`) stay blocked.
- **Upstream SSRF guard** — only `TRUSTED_RPC_UPSTREAM_ORIGINS`, https/wss, no private IPs.
- **Load balancing** — weighted-random across all eligible+safe pool endpoints.
- **Body cap** 64 KB, **upstream timeout** 10 s, single JSON-RPC object only.
- **Rate limit** — the `RPC_RATE_LIMITER` binding: 100 requests / 60 s per client IP
  (returns `429 rpc_rate_limited`). Enforced on Cloudflare; skipped locally.

Before flipping the flag:

1. **Cloudflare WAF (dashboard — required).** Add zone rules scoped to
   `http.request.uri.path contains "/rpc/"`:
   - a **Rate Limiting rule** as a coarse pre-Worker cap (e.g. 120 req / min per IP,
     action: managed challenge/block) to absorb distributed abuse;
   - a **custom rule** to block non-`POST` methods and oversized bodies on `/rpc/*`;
   - ensure the zone's Managed Ruleset / Bot Fight Mode is on.
2. **Verify the pool.** `curl https://api.metagraph.sh/metagraph/rpc/pools.json` and confirm
   at least one endpoint per pool has `"pool_eligible": true` (otherwise the proxy
   returns `503 rpc_endpoint_unavailable`).
3. **Flip the flag.** Set `METAGRAPH_ENABLE_RPC_PROXY` to `"true"` in `wrangler.jsonc`;
   the push deploys via Cloudflare Workers Builds.
4. **Smoke.** `POST /rpc/v1/finney` with `{"jsonrpc":"2.0","id":1,"method":"system_health"}`
   expects `200`; a blocked method (e.g. `author_submitExtrinsic`) expects
   `403 rpc_method_blocked`; a burst past the limit expects `429`.

To disable in an incident, set the flag back to `"false"` (or via env override) and redeploy.

## Rollback

Rollback is pointer-first:

- point KV `metagraph:latest` at a known-good R2 run prefix;
- verify `/api/v1/build`, `/api/v1/contracts`, `/api/v1/health`, `/api/v1/endpoint-pools`, and `/api/v1/rpc/pools`;
- disable `METAGRAPH_ENABLE_RPC_PROXY` immediately if proxy behavior is suspect.

## Known Non-Blocking Drift

`sync:subnets:dry-run` can report chain metadata changes, such as subnet names. These should become reviewed sync PRs, not silent direct pushes.
