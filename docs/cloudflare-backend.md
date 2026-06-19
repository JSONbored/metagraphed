# Cloudflare Backend

Metagraphed uses Cloudflare as the serving, cache, and artifact-history layer. GitHub-reviewed registry inputs, compact generated indexes, and compact release manifests remain canonical; volatile generated detail is staged locally and published to R2.

## Runtime Shape

- Workers serve `metagraph.sh/api/v1/*` and `metagraph.sh/metagraph/*.json` routes over canonical artifact paths so API consumers get consistent CORS, cache headers, storage-tier headers, and R2 fallback.
- Workers Static Assets serve compact checked-in artifacts from `public/metagraph`.
- R2 stores high-churn/detail artifacts staged under `dist/metagraph-r2/metagraph`, plus current artifact copies under `latest/`; versioned artifact history under `runs/{generated_at}/` is opt-in for publish jobs that set `METAGRAPH_R2_UPLOAD_HISTORY=1`.
- KV stores small latest pointers, feature flags, endpoint-pool summaries, and source-freshness summaries when configured.
- D1 is not used for canonical registry truth in v1.
- The read-only RPC proxy/load-balancer prototype exists behind `METAGRAPH_ENABLE_RPC_PROXY=false`; write and unsafe RPC methods remain blocked by default.

## Worker Routes

- `/api/v1/subnets`
- `/api/v1/subnets/{netuid}`
- `/api/v1/surfaces`
- `/api/v1/endpoints`
- `/api/v1/subnets/{netuid}/endpoints`
- `/api/v1/candidates`
- `/api/v1/providers`
- `/api/v1/providers/{slug}/endpoints`
- `/api/v1/coverage`
- `/api/v1/curation`
- `/api/v1/gaps`
- `/api/v1/health`
- `/api/v1/freshness`
- `/api/v1/source-health`
- `/api/v1/evidence`
- `/api/v1/changelog`
- `/api/v1/source-snapshots`
- `/api/v1/rpc/endpoints`
- `/api/v1/rpc/pools`
- `/api/v1/endpoint-pools`
- `/api/v1/endpoint-incidents`
- `/api/v1/schemas`
- `/api/v1/adapters/{slug}`
- `/api/v1/search`
- `/api/v1/contracts`
- `/api/v1/build`

All API responses use a stable JSON envelope with `ok`, `schema_version`, `data`, `meta`, and `error` fields.
Worker responses include CORS, cache-control, ETags, and `x-metagraph-contract-version`.

## Cloudflare Resources

- Worker name: `metagraphed`
- R2 bucket: `metagraphed-artifacts`
- R2 binding: `METAGRAPH_ARCHIVE`
- Static assets binding: `ASSETS`
- Optional KV binding: `METAGRAPH_CONTROL`
- KV keys: `metagraph:latest`, `metagraph:feature-flags`, `metagraph:endpoint-pools`, `metagraph:source-freshness`
- D1 health migrations live in `migrations/`. `0006_surface_key_rekey.sql` must be applied before deploying the prober cutover that upserts `surface_status` and `surface_uptime_daily` by stable `surface_key`.

If no KV binding is configured, the Worker falls back to `METAGRAPH_R2_LATEST_PREFIX` for R2 reads. R2-tier artifacts are read from R2 first; static fallback is only allowed when `METAGRAPH_ALLOW_R2_STATIC_FALLBACK=true` is set for local migration/testing.

## Local Commands

- `npm run validate:api`: validate Worker API routes against local artifacts.
- `npm run worker:deploy:dry-run`: validate `wrangler.jsonc` and Worker entrypoint shape.
- `npm run r2:manifest`: regenerate the R2 upload manifest from compact `public/metagraph` artifacts plus the ignored R2 staging tree.
- `npm run r2:manifest:dry-run`: validate and summarize the current manifest.
- `npm run r2:upload:dry-run`: summarize the upload without writing to Cloudflare.
- `npm run r2:download:dry-run`: summarize a restore/download without writing local files.
- `npm run kv:publish:dry-run`: summarize KV control records without writing to Cloudflare.

Write operations require explicit environment flags:

- `METAGRAPH_ALLOW_R2_UPLOAD=1 npm run r2:upload` uploads only artifacts whose SHA-256 differs from `latest/r2-manifest.json`, plus the current `latest/r2-manifest.json` and `latest/build-summary.json` control files.
- `METAGRAPH_ALLOW_R2_UPLOAD=1 METAGRAPH_R2_UPLOAD_HISTORY=1 npm run r2:upload` also writes run-prefix copies for all planned artifacts and control files.
- `METAGRAPH_ALLOW_R2_UPLOAD=1 METAGRAPH_R2_UPLOAD_FORCE=1 npm run r2:upload` bypasses remote manifest comparison and republishes all planned artifacts.
- `METAGRAPH_ALLOW_R2_UPLOAD=1 METAGRAPH_R2_UPLOAD_LIMIT=5 npm run r2:upload` can be used for a remote permission smoke. Limited smoke uploads skip `latest/r2-manifest.json` and `latest/build-summary.json` control files so the latest manifest cannot claim that unuploaded artifacts exist.
- `METAGRAPH_ALLOW_R2_DOWNLOAD=1 npm run r2:download`
- `METAGRAPH_ALLOW_KV_WRITE=1 METAGRAPH_KV_NAMESPACE_ID=... npm run kv:publish`

If `latest/r2-manifest.json` is missing or unreadable, the uploader falls back to uploading all planned artifacts. Full historical backfills should use `METAGRAPH_R2_UPLOAD_FORCE=1 METAGRAPH_R2_UPLOAD_HISTORY=1` deliberately rather than relying on the normal delta publish path.

## Safety Boundary

Owned Bittensor lite/archive nodes are not part of this backend yet. Public endpoint pools only score and describe public endpoints. Before any public proxy/load-balancer route is enabled, Cloudflare WAF and rate limiting must be configured and the Worker must keep write and unsafe RPC methods blocked.
