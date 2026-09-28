# Cloudflare Backend

Metagraphed uses Cloudflare as the serving, cache, and artifact-history layer. GitHub-reviewed registry inputs remain canonical. Generated registry artifacts are staged locally, verified, and published to the existing control KV namespace. R2 registry uploads are retired; the remaining chain-history R2 retirement is a separate migration.

## Runtime Shape

- Workers serve `metagraph.sh/api/v1/*` and `metagraph.sh/metagraph/*.json` routes over canonical artifact paths so API consumers get consistent CORS, cache headers, and storage-tier headers.
- Workers Static Assets serve compact checked-in artifacts from `public/metagraph`.
- KV stores immutable registry objects at `registry:v1:object:<sha256>` and their path/size/digest indexes at `registry:v1:manifest:<sha256>`. The staging directory retains its historical name, `dist/metagraph-r2/metagraph`; that name does not select an R2 upload.
- The `metagraph:latest` pointer selects the complete current registry generation and its previous generation. Once it selects KV, registry reads never fall back to R2. The previous generation can bridge propagation gaps; a path explicitly absent from the current manifest remains a 404.
- Dated health history and successful per-surface schema/fixture captures survive subsequent publications. A failed capture does not erase the previous successful capture.
- KV also stores the live tiers: the 15-minute prober's health snapshots and the live economics blob. D1 remains the first operational-surface source for the health prober, followed by static assets and the published KV registry.
- The registry's canonical truth is the committed source, never a database.
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
- Static assets binding: `ASSETS`
- Registry and live-tier KV binding: `METAGRAPH_CONTROL`
- KV keys: `metagraph:latest` (publish pointer); `registry:v1:*` (immutable registry objects, manifests and retention metadata); `health:current` / `health:rpc-pool` / `health:meta` (15-minute prober live tier); `economics:current` (live economics tier)
- The `METAGRAPH_ARCHIVE` R2 binding remains for other storage paths pending their separate retirement. Its presence does not mean published registry requests use R2.
- Health migrations live in `migrations/`. `0006_surface_key_rekey.sql` must be applied before deploying the prober cutover that upserts `surface_status` and `surface_uptime_daily` by stable `surface_key`.

Production registry publication requires the existing KV namespace and a verified initial generation. Historical artifact-tier names and compatibility flags still occur in the code, but the selected registry backend reports `kv` in response headers. Removing a KV binding is not a supported rollback procedure.

## Local Commands

- `npm run validate:api`: validate Worker API routes against local artifacts.
- `npm run worker:deploy:dry-run`: validate `wrangler.jsonc` and Worker entrypoint shape.
- `npm run r2:manifest`: regenerate the publication manifest from compact `public/metagraph` artifacts plus the ignored staging tree. The legacy command name is retained for existing build callers.
- `npm run r2:manifest:dry-run`: validate and summarize the current manifest.
- `npm run r2:upload`: verify every staged artifact's size and SHA-256 locally; writes no Cloudflare data. This compatibility command is the existing workflow's staging gate.
- `npm run r2:upload:dry-run`: verify and summarize staged registry artifacts without writing to Cloudflare.
- `npm run kv:publish:dry-run`: verify and summarize the staged registry without remote writes.

Registry publication requires the existing Cloudflare credentials and explicit write configuration:

- `METAGRAPH_ALLOW_KV_WRITE=1 METAGRAPH_KV_NAMESPACE_ID=... npm run kv:publish`

The publisher checks existing object identity, uploads missing content, independently verifies bytes, and only then selects the completed manifest. Readback retries accommodate KV propagation without repeating writes. Failed integrity checks prevent successful publication. Changelog and surface-alias generation read the previous published KV artifacts rather than old R2 copies.

The registry store is capped at 700 MiB. Collection preserves the selected and previous generations, retained stable history, and a 24-hour propagation/retirement grace period. A first publication requires an independently verified stable-history inventory; normal publication never infers an empty history from a failed read.

`METAGRAPH_ALLOW_R2_UPLOAD`, `METAGRAPH_R2_UPLOAD_HISTORY`, and related legacy upload flags no longer enable registry writes. Invoking `scripts/r2-upload.ts` directly fails with the replacement command. Existing R2 download tools are migration utilities for old objects, not the restore path for a KV publication: use its manifest and exact object digests to recover the selected bytes.

## Safety Boundary

Owned Bittensor lite/archive nodes are not part of this backend yet. Public endpoint pools only score and describe public endpoints. Before any public proxy/load-balancer route is enabled, Cloudflare WAF and rate limiting must be configured and the Worker must keep write and unsafe RPC methods blocked.
