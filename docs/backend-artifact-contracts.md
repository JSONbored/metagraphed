# Metagraphed Backend Artifact Contracts

Metagraphed v1 is backend-first. The public contract is static JSON under `https://metagraph.sh/metagraph/*`; UI work can consume these artifacts later without changing the registry pipeline.

## Contract Rules

- `registry/native/finney-subnets.json` is canonical for active Finney subnet existence.
- `registry/subnets/**/*.json` is canonical for curated public interface metadata.
- `registry/candidates/**/*.json` is discovery-only. Candidates are not verified registry surfaces until promotion.
- `registry/adapters/latest/*.json` stores safe adapter snapshots for subnet-specific public metrics.
- `registry/reviews/maintainer-reviewed.json` stores public-safe maintainer review decisions.
- `public/metagraph/*` files are generated projections and should not be edited by hand.
- Health, RPC, adapter, and schema-drift artifacts are operational observations, not protocol authority.
- No secrets, wallet data, PATs, private dashboards, or validator-sensitive flows belong in any public artifact.

## Core Artifacts

- `/metagraph/contracts.json`: current public artifact contract version and artifact map.
- `/metagraph/providers.json`: provider/source registry.
- `/metagraph/providers/{slug}.json`: per-provider detail payload.
- `/metagraph/api-index.json`: Worker API route map and response-envelope contract.
- `/metagraph/openapi.json`: OpenAPI 3.1 contract for backend API consumers.
- `/metagraph/types.d.ts`: generated TypeScript definitions for consumers.
- `/metagraph/changelog.json`: reviewable generated artifact and subnet-change summary.
- `/metagraph/subnets.json`: compact all-subnet index.
- `/metagraph/subnets/{netuid}.json`: per-subnet detail with native data, curated surfaces, candidates, curation, and gaps.
- `/metagraph/surfaces.json`: curated public surfaces only.
- `/metagraph/surfaces/{netuid}.json`: curated public surfaces for one subnet.
- `/metagraph/candidates.json`: unpromoted candidate surfaces from public discovery.
- `/metagraph/candidates/{netuid}.json`: unpromoted candidate surfaces for one subnet.
- `/metagraph/review-queue.json`: candidate surfaces queued for maintainer review.
- `/metagraph/search.json`: compact search index for subnets, surfaces, and providers.
- `/metagraph/coverage.json`: count parity and coverage levels.
- `/metagraph/curation.json`: curation state for every active subnet.
- `/metagraph/gaps.json`: missing public interface facets by subnet.
- `/metagraph/verification/latest.json`: latest candidate verification results.
- `/metagraph/verification/subnets/{netuid}.json`: latest candidate verification results for one subnet.
- `/metagraph/freshness.json`: freshness and staleness metadata for generated backend data.
- `/metagraph/source-health.json`: source/provider health summary.
- `/metagraph/source-snapshots.json`: compact hashes and counts for canonical source inputs.
- `/metagraph/evidence-ledger.json`: public evidence ledger for material registry claims.
- `/metagraph/health/latest.json`: latest live or build-time surface health snapshot.
- `/metagraph/health/summary.json`: global and per-subnet health rollup.
- `/metagraph/health/history/{date}.json`: compact daily health-history snapshot.
- `/metagraph/health/subnets/{netuid}.json`: per-subnet health detail.
- `/metagraph/health/badges/{netuid}.json`: badge data for future metagraph.sh renderers.
- `/metagraph/rpc-endpoints.json`: Bittensor base-layer RPC/WSS endpoint registry and probe status.
- `/metagraph/rpc/pools.json`: endpoint pool scoring for future read-only routing.
- `/metagraph/schema-drift.json`: OpenAPI snapshot/drift status.
- `/metagraph/schemas/index.json`: captured machine-readable schema index.
- `/metagraph/adapters/{slug}.json`: adapter-backed public metrics snapshot.
- `/metagraph/r2-manifest.json`: Cloudflare R2 upload manifest for artifact history.
- `/metagraph/review/curation.json`: maintainer review and adapter candidate report.
- `/metagraph/review/gap-priorities.json`: prioritized backend curation gaps.
- `/metagraph/review/adapter-candidates.json`: subnets likely worth custom adapters.
- `/metagraph/review/maintainer-decisions.json`: public-safe maintainer decision ledger.
- `/metagraph/build-summary.json`: generated build summary.

## API Routes

- `/api/v1`: list backend API routes and response-envelope metadata.
- `/api/v1/subnets`: list active Finney subnets.
- `/api/v1/subnets/{netuid}`: fetch per-subnet detail.
- `/api/v1/surfaces`: list curated public surfaces.
- `/api/v1/subnets/{netuid}/surfaces`: list curated public surfaces for one subnet.
- `/api/v1/candidates`: list unpromoted candidate surfaces.
- `/api/v1/subnets/{netuid}/candidates`: list unpromoted candidate surfaces for one subnet.
- `/api/v1/providers`: list providers and sources.
- `/api/v1/providers/{slug}`: fetch per-provider detail.
- `/api/v1/coverage`: fetch registry coverage summary.
- `/api/v1/curation`: fetch curation states by subnet.
- `/api/v1/gaps`: fetch interface gap report.
- `/api/v1/health`: fetch global health summary.
- `/api/v1/health/history/{date}`: fetch compact daily health history.
- `/api/v1/subnets/{netuid}/health`: fetch health detail for one subnet.
- `/api/v1/freshness`: fetch freshness and staleness state.
- `/api/v1/source-health`: fetch upstream source health.
- `/api/v1/evidence`: fetch public evidence ledger.
- `/api/v1/changelog`: fetch latest generated change summary.
- `/api/v1/source-snapshots`: fetch source input hashes and counts.
- `/api/v1/rpc/endpoints`: fetch Bittensor RPC endpoint status.
- `/api/v1/rpc/pools`: fetch endpoint pool scores.
- `/api/v1/schemas`: fetch captured schema index.
- `/api/v1/adapters/{slug}`: fetch adapter-backed public metrics.
- `/api/v1/search`: fetch compact search index.
- `/api/v1/contracts`: fetch artifact contract metadata.
- `/api/v1/openapi.json`: fetch OpenAPI 3.1 contract.
- `/api/v1/build`: fetch generated build summary.

## Backend Commands

- `npm run build`: regenerate deterministic public artifacts from current registry inputs.
- `npm run validate`: validate native snapshot, overlays, candidates, review decisions, generated artifacts, and required schemas.
- `npm run sync:subnets`: update the native Finney snapshot.
- `npm run discover:candidates`: refresh public-source candidate discovery.
- `npm run verify:candidates`: safely verify public candidates.
- `npm run curate:baseline`: promote verified candidates into generated overlays.
- `npm run review:promote`: apply public-safe maintainer review decisions to overlays.
- `npm run schemas:snapshot`: fetch machine-readable OpenAPI/Swagger JSON snapshots and update schema drift.
- `npm run adapters:snapshot`: capture safe Allways/Gittensor public adapter summaries.
- `METAGRAPH_WRITE_PROBE_RESULTS=1 npm run probes:smoke`: run live read-only probes and persist health/RPC history.
- `npm run r2:manifest`: regenerate the Cloudflare R2 manifest from current public artifacts.
- `npm run r2:download:dry-run`: summarize an R2 restore/download without writing local files.
- `npm run kv:publish:dry-run`: summarize KV latest pointer, feature flags, endpoint pool, and freshness control records.
- `npm run validate:schemas`: run strict JSON Schema validation over registry inputs and public artifacts.
- `npm run validate:api`: validate Worker API routes over local artifacts.
- `npm run validate:docs`: validate public docs against current artifact and API contracts.
- `npm run validate:intake`: validate GitHub issue intake templates.
- `npm run validate:workflows`: validate workflow hardening rules.
- `npm run worker:deploy:dry-run`: validate Worker/Wrangler deployment shape without contacting Cloudflare.
- `npm run sync:summary`: generate a registry-refresh PR summary from actual artifact diffs.

## Cloudflare Runtime

`workers/api.mjs` serves stable `/api/v1/*` JSON envelopes over the canonical artifact tree. It reads from Workers Static Assets first and can fall back to R2 through `METAGRAPH_ARCHIVE` when configured. If the optional `METAGRAPH_CONTROL` KV binding exists, the Worker reads `metagraph:latest` to resolve the current R2 prefix.

The RPC proxy route is intentionally disabled unless `METAGRAPH_ENABLE_RPC_PROXY=true`. When enabled for controlled testing, it only accepts single JSON-RPC POST bodies and blocks write/unsafe methods before any upstream request is made.

## Current Domain Scope

Use `metagraph.sh` for the current launch. Do not use `subnet.health` for v1 registry, status, badge, health, or probe contracts.
