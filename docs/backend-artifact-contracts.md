# Metagraphed Backend Artifact Contracts

Metagraphed v1 is backend-first. The public contract is static JSON under `https://api.metagraph.sh/metagraph/*`; UI work can consume these artifacts later without changing the registry pipeline.

## Contract Rules

- `registry/native/finney-subnets.json` is canonical for active Finney subnet existence.
- `registry/subnets/**/*.json` is canonical for curated public interface metadata.
- `registry/candidates/**/*.json` is discovery-only. Candidates are not verified registry surfaces until promotion.
- `registry/adapters/latest/*.json` stores safe adapter snapshots for subnet-specific public metrics.
- `registry/reviews/maintainer-reviewed.json` stores public-safe maintainer review decisions.
- `schemas/components/*.schema.json` is canonical for public API/artifact component schemas.
- `schemas/api-components.schema.json` is a generated bundle and should not be edited by hand.
- `/metagraph/openapi.json`, `/metagraph/types.d.ts`, `generated/metagraphed-api.d.ts`, and `generated/metagraphed-client.ts` are generated from the canonical schema and route metadata.
- `public/metagraph/*` files are compact generated projections and should not be edited by hand. R2-only artifacts must not be committed there.
- `dist/metagraph-r2/metagraph/*` is the ignored staging tree for volatile/detail generated projections that are uploaded to R2.
- Artifact contracts carry `storage_tier`: `dual` for compact Git-plus-R2 artifacts, `r2` for volatile/detail artifacts, and `git` for local-only generated support artifacts.
- Health, RPC, adapter, and schema-drift artifacts are operational observations, not protocol authority.
- No secrets, wallet data, PATs, private dashboards, or validator-sensitive flows belong in any public artifact.
- Zod is not backend contract authority in v1. Zod helpers can be generated later for frontend consumers, but JSON Schema plus AJV remains canonical.

## Core Artifacts

- `/metagraph/contracts.json`: current public artifact contract version and artifact map.
- `/metagraph/providers.json`: provider/source registry.
- `/metagraph/providers/{slug}.json`: per-provider detail payload. R2-backed.
- `/metagraph/providers/{slug}/endpoints.json`: endpoint resources for one provider or operator. R2-backed.
- `/metagraph/api-index.json`: Worker API route map and response-envelope contract.
- `/metagraph/openapi.json`: OpenAPI 3.1 contract for backend API consumers.
- `/metagraph/types.d.ts`: generated TypeScript definitions for consumers.
- `/metagraph/changelog.json`: reviewable generated artifact and subnet-change summary.
- `/metagraph/subnets.json`: compact all-subnet index.
- `/metagraph/metagraph/latest.json`: latest normalized all-subnet metagraph index. R2-backed.
- `/metagraph/subnets/{netuid}.json`: per-subnet detail with native data, curated surfaces, candidates, curation, and gaps. R2-backed.
- `/metagraph/profiles.json`: public-safe subnet identity and completeness profiles.
- `/metagraph/profiles/{netuid}.json`: per-subnet public-safe profile detail. R2-backed.
- `/metagraph/surfaces.json`: curated public surfaces only.
- `/metagraph/surfaces/{netuid}.json`: curated public surfaces for one subnet. R2-backed.
- `/metagraph/surface-aliases.json`: publish-time deprecated `surface_id` alias map for renamed surfaces. The deterministic build emits an empty placeholder; Cloudflare publish fills it from the previous R2 `surfaces.json` + prior alias map before upload.
- `/metagraph/endpoints.json`: generalized endpoint/resource registry derived from curated surfaces and probe observations. Endpoint `id` values derive from stable `surface_key` values; `surface_id` remains the human-readable surface alias.
- `/metagraph/endpoints/{netuid}.json`: generalized endpoint/resource registry for one subnet. R2-backed. Endpoint `id` values derive from stable `surface_key` values; `surface_id` remains the human-readable surface alias.
- Live health overlays, trends, percentiles, incidents, and uptime rollups join/group by `surface_key` when present and keep `surface_id` as the served display alias, so display-name/slug renames do not split probe history.
- `/metagraph/candidates.json`: unpromoted candidate surfaces from public discovery. R2-backed.
- `/metagraph/candidates/{netuid}.json`: unpromoted candidate surfaces for one subnet. R2-backed.
- `/metagraph/review-queue.json`: candidate surfaces queued for maintainer review. R2-backed.
- `/metagraph/search.json`: compact search index for subnets, surfaces, and providers.
- `/metagraph/coverage.json`: count parity and coverage levels.
- `/metagraph/economics.json`: per-subnet validator/economic metrics (counts, stake, registration cost, alpha price, emission share).
- `/metagraph/curation.json`: curation state for every active subnet.
- `/metagraph/gaps.json`: missing public interface facets by subnet.
- `/metagraph/verification/latest.json`: latest candidate verification results. R2-backed.
- `/metagraph/verification/subnets/{netuid}.json`: latest candidate verification results for one subnet. R2-backed.
- `/metagraph/freshness.json`: freshness and staleness metadata for generated backend data. It exposes `native_data_as_of`, `candidate_discovery_as_of`, `verification_as_of`, `health_probe_as_of`, `adapter_snapshot_as_of`, and stale-window requirements.
- `/metagraph/source-health.json`: source/provider health summary.
- `/metagraph/source-snapshots.json`: compact hashes and counts for canonical source inputs. R2-backed.
- `/metagraph/evidence-ledger.json`: public evidence ledger for material registry claims.
- `/metagraph/evidence/{netuid}.json`: public evidence ledger claims for one subnet. R2-backed.
- `/metagraph/overview/{netuid}.json`: composed per-subnet overview (profile + health + curation + gaps + counts). R2-backed.
- `/metagraph/registry-summary.json`: registry-wide summary (completeness, top subnets, level counts, latest changes). R2-backed.
- `/metagraph/coverage-depth.json`: machine-usable coverage depth scorecard with one row per subnet, blocker/gap summaries, and a ranked enrichment queue. R2-backed.
- `/metagraph/lineage.json`: cross-network subnet lineage — maintainer-approved mainnet ↔ testnet pairs with reviewed match evidence, plus the testnet-only (deploying-soon) count.
- `/metagraph/fixtures.json`: index of captured live request/response fixtures (which surfaces carry a sanitized sample).
- `/metagraph/agent-resources.json`: machine index of every AI resource — the copyable agent, the MCP server + tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs.
- `/metagraph/fixtures/{surface_id}.json`: a captured, sanitized live request/response sample for one surface. R2-backed.
- `/metagraph/health/latest.json`: latest live or build-time surface health snapshot. R2-backed.
- `/metagraph/health/summary.json`: global and per-subnet health rollup.
- `/metagraph/health/history/{date}.json`: compact daily health-history snapshot. R2-backed.
- `/metagraph/health/subnets/{netuid}.json`: per-subnet health detail. R2-backed.
- `/metagraph/health/badges/{netuid}.json`: badge data for future metagraph.sh renderers. R2-backed.
- `/metagraph/rpc-endpoints.json`: Bittensor base-layer RPC/WSS endpoint registry and probe status.
- `/metagraph/rpc/pools.json`: endpoint pool scoring for future read-only routing.
- `/metagraph/endpoint-pools.json`: generalized endpoint pool scoring for future read-only routing; pool entries include `surface_id` and `surface_key` when backed by catalogued surfaces.
- `/metagraph/endpoint-incidents.json`: probe-derived endpoint incident summary and active endpoint failures; incidents include the human `surface_id` alias plus stable `surface_key`.
- `/metagraph/operational-surfaces.json`: operational surfaces (RPC/WSS/subnet-api/SSE/data-artifact) probed live by the 15-minute Cloudflare cron health prober; the prober's R2-backed input list.
- `/metagraph/agent-catalog.json`: compact index of subnets exposing callable services for AI agents (per subnet: service kinds + callable count). Committed.
- `/metagraph/agent-catalog/{netuid}.json`: per-subnet agent capability catalog — each callable service with base URL, auth, machine-readable schema, and build-time health/eligibility. R2-backed.
- `/metagraph/health/trends.json`: schema for the compact all-subnet 7d/30d daily uptime + latency trend matrix served live from D1 at `GET /api/v1/health/trends` (no static file is written).
- `/metagraph/health/trends/{netuid}.json`: schema for the computed 7d/30d uptime + latency trends served live from D1 at `GET /api/v1/subnets/{netuid}/health/trends` (no static file is written).
- `/metagraph/health/percentiles/{netuid}.json`: schema for per-surface latency percentiles (p50/p95/p99) served live from D1 at `GET /api/v1/subnets/{netuid}/health/percentiles` (no static file).
- `/metagraph/health/incidents/{netuid}.json`: schema for per-surface SLA + reconstructed downtime incidents served live from D1 at `GET /api/v1/subnets/{netuid}/health/incidents` (no static file).
- `/metagraph/subnets/{netuid}/trajectory.json`: schema for the week-over-week structural trajectory served live from D1 at `GET /api/v1/subnets/{netuid}/trajectory` (no static file).
- `/metagraph/subnets/{netuid}/uptime.json`: schema for the long-term daily uptime history per operational surface (90d/1y window), served live from the `surface_uptime_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/uptime` (no static file).
- `/metagraph/subnets/{netuid}/metagraph.json`: schema for the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/metagraph` (no static file).
- `/metagraph/subnets/{netuid}/neurons/{uid}.json`: schema for a single neuron's metagraph state served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/neurons/{uid}` (no static file).
- `/metagraph/subnets/{netuid}/validators.json`: schema for a subnet's validators (validator_permit) ranked by stake, served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/validators` (no static file).
- `/metagraph/subnets/{netuid}/events.json`: schema for a subnet's first-party chain-event stream (registrations, stake, weights, axon, delegation, lifecycle, transfers) newest first, served live from the `account_events` D1 tier filtered by netuid at `GET /api/v1/subnets/{netuid}/events` (no static file).
- `/metagraph/subnets/{netuid}/neurons/{uid}/history.json`: schema for a UID's per-day metagraph time series served live from the `neuron_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/neurons/{uid}/history` (no static file).
- `/metagraph/subnets/{netuid}/history.json`: schema for a subnet's per-day metagraph history (one snapshot/day) served live from the `neuron_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/history` (no static file).
- `/metagraph/accounts/{ss58}.json`: schema for a cross-subnet account summary (chain-event aggregates joined to current registrations), served live from the `account_events` + `neurons` D1 tiers at `GET /api/v1/accounts/{ss58}` (no static file).
- `/metagraph/accounts/{ss58}/events.json`: schema for an account's paginated chain-event history, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/events` (no static file).
- `/metagraph/accounts/{ss58}/subnets.json`: schema for the subnets where an account's hotkey is currently registered, served live from the `neurons` D1 tier at `GET /api/v1/accounts/{ss58}/subnets` (no static file).
- `/metagraph/accounts/{ss58}/balance.json`: schema for an account's live TAO balance (free + reserved), queried from the finney RPC at request time with a 60s KV cache, served at `GET /api/v1/accounts/{ss58}/balance` (no static file).
- `/metagraph/blocks.json`: schema for the recent-block feed (newest first) of the block explorer, served live from the first-party `blocks` D1 tier at `GET /api/v1/blocks` (no static file).
- `/metagraph/blocks/{ref}.json`: schema for per-block detail (by numeric `block_number` or `0x` `block_hash`), served live from the first-party `blocks` D1 tier at `GET /api/v1/blocks/{ref}` (no static file).
- `/metagraph/extrinsics.json`: schema for the recent-extrinsic feed (newest first) of the block explorer, served live from the first-party `extrinsics` D1 tier at `GET /api/v1/extrinsics` (no static file).
- `/metagraph/extrinsics/{hash}.json`: schema for per-extrinsic detail (by `0x` `extrinsic_hash`), served live from the first-party `extrinsics` D1 tier at `GET /api/v1/extrinsics/{hash}` (no static file).
- `/metagraph/incidents.json`: schema for recent cross-subnet downtime incidents reconstructed from probe history, served live from D1 at `GET /api/v1/incidents` (no static file).
- `/metagraph/registry/leaderboards.json`: schema for the registry leaderboards — operational (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing) and economic opportunity (open-slots, cheapest-registration, highest-emission, validator-headroom) — served live from D1 + registry projections + the economics tier at `GET /api/v1/registry/leaderboards` (no static file).
- `/metagraph/compare.json`: schema for the cross-subnet comparison — registry structure (completeness + surface counts), the live economics tier, and the live per-subnet health rollup placed side by side for the requested netuids — served live at `GET /api/v1/compare` (no static file).
- `/metagraph/rpc/usage.json`: schema for RPC reverse-proxy usage analytics (request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets), served live from the `rpc_proxy_events` D1 telemetry at `GET /api/v1/rpc/usage` (no static file). `7d` uses 1-hour buckets; `30d` uses 6-hour buckets.
- `/metagraph/schema-drift.json`: OpenAPI snapshot/drift status.
- `/metagraph/schemas/index.json`: captured machine-readable schema index.
- `/metagraph/schemas/{surface_id}.json`: captured machine-readable OpenAPI/Swagger schema snapshot detail. R2-backed.
- `/metagraph/adapters/{slug}.json`: adapter-backed public metrics snapshot. R2-backed.
- `/metagraph/r2-manifest.json`: compact committed Cloudflare R2 upload manifest. The full upload manifest is generated under `dist/metagraph-r2/metagraph/r2-manifest.json`.
- `/metagraph/review/curation.json`: maintainer review and adapter candidate report.
- `/metagraph/review/gap-priorities.json`: prioritized backend curation gaps.
- `/metagraph/review/gaps/{netuid}.json`: interface gap priorities and enrichment queue for one subnet. R2-backed.
- `/metagraph/review/profile-completeness.json`: profile completeness and contributor targeting report.
- `/metagraph/review/adapter-candidates.json`: subnets likely worth custom adapters.
- `/metagraph/review/enrichment-queue.json`: prioritized all-subnet enrichment queue with direct-submission, maintainer-review, adapter, and monitoring lanes.
- `/metagraph/review/enrichment-evidence.json`: detailed candidate evidence by missing or contributor-target surface kind. R2-backed.
- `/metagraph/review/enrichment-targets.json`: contributor-ready enrichment target pack grouped by surface kind, review route, and evidence action.
- `/metagraph/review/maintainer-decisions.json`: public-safe maintainer decision ledger.
- `/metagraph/build-summary.json`: generated build summary.

## API Routes

- `/api/v1`: list backend API routes and response-envelope metadata.
- `/api/v1/subnets`: list active Finney subnets.
- `/api/v1/subnets/{netuid}`: fetch per-subnet detail.
- `/api/v1/profiles`: list public-safe subnet profiles and completeness scores.
- `/api/v1/subnets/{netuid}/profile`: fetch public-safe profile detail for one subnet.
- `/api/v1/subnets/{netuid}/overview`: fetch a composed overview (profile + health + curation + gaps + counts) for one subnet.
- `/api/v1/agent-catalog`: list subnets exposing callable services for AI agents (compact index: service kinds + callable count per subnet).
- `/api/v1/agent-catalog/{netuid}`: fetch one subnet's agent capability catalog — each callable service with base URL, auth, machine-readable schema, and health/eligibility.
- `/api/v1/registry/summary`: fetch the registry-wide summary (completeness, top subnets, level counts, latest changes).
- `/api/v1/coverage-depth`: fetch the machine-usable scorecard and ranked enrichment queue for prioritizing schema, fixture, example, provenance, and review work.
- `/api/v1/lineage`: fetch maintainer-approved cross-network subnet lineage (graduated subnets + the deploying-soon testnet pipeline).
- `/api/v1/fixtures`: fetch the index of captured live request/response fixtures (per-surface samples are at `/metagraph/fixtures/{surface_id}.json`, also via the `get_fixture` MCP tool).
- `/api/v1/agent-resources`: fetch the AI-resources index (the copyable agent at `/agent.md`, the MCP server + tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs).
- `/api/v1/subnets/{netuid}/health/percentiles`: fetch p50/p95/p99 latency percentiles per operational surface over a 7d/30d window (live from D1).
- `/api/v1/subnets/{netuid}/health/incidents`: fetch SLA (uptime ratio) + reconstructed downtime incidents per operational surface over a 7d/30d window (live from D1).
- `/api/v1/subnets/{netuid}/trajectory`: fetch the week-over-week structural trajectory (completeness + counts) from daily snapshots (live from D1).
- `/api/v1/subnets/{netuid}/uptime`: fetch long-term daily uptime history per operational surface over a 90d/1y window (live from the `surface_uptime_daily` D1 rollup).
- `/api/v1/subnets/{netuid}/metagraph`: fetch the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon); `?validator_permit=true` for validators only (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/neurons/{uid}`: fetch a single neuron's metagraph state by UID (live from the `neurons` D1 tier; 200 with `neuron:null` when cold/absent).
- `/api/v1/subnets/{netuid}/validators`: fetch the validators (validator_permit) ranked by stake (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/events`: fetch the first-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers) newest first; `?kind=` filter, `?limit` (<=1000) / `?offset` (live from the `account_events` D1 tier filtered by netuid).
- `/api/v1/subnets/{netuid}/neurons/{uid}/history`: fetch a UID's per-day metagraph time series over a `?window=7d|30d|90d|1y|all` window (live from the `neuron_daily` D1 rollup).
- `/api/v1/subnets/{netuid}/history`: fetch a subnet's per-day metagraph history over a `?window=7d|30d|90d|1y|all` window (live from the `neuron_daily` D1 rollup).
- `/api/v1/accounts/{ss58}`: fetch a cross-subnet account summary (chain-event aggregates joined to current registrations + stake) for a hotkey or coldkey (live from the `account_events` + `neurons` D1 tiers).
- `/api/v1/accounts/{ss58}/events`: fetch an account's paginated chain-event history, newest first; `?kind=` filter, `?limit` (<=1000) / `?offset` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/subnets`: fetch the subnets where an account's hotkey is currently registered (live from the `neurons` D1 tier).
- `/api/v1/accounts/{ss58}/balance`: fetch an account's live TAO balance (free + reserved, in TAO), queried from the finney RPC at request time with a 60s KV cache; `balance_tao` is null on RPC failure.
- `/api/v1/blocks`: fetch the recent-block feed (newest first) for the block explorer; `?limit` (<=100) / `?offset` (live from the first-party `blocks` D1 tier).
- `/api/v1/blocks/{ref}`: fetch per-block detail by numeric `block_number` or `0x` `block_hash` (live from the first-party `blocks` D1 tier; 200 with `block:null` when cold/unknown).
- `/api/v1/extrinsics`: fetch the recent-extrinsic feed (newest first) for the block explorer; `?limit` (<=100) / `?offset` / optional `?block=<n>` (live from the first-party `extrinsics` D1 tier).
- `/api/v1/extrinsics/{hash}`: fetch per-extrinsic detail by `0x` `extrinsic_hash` (live from the first-party `extrinsics` D1 tier; 200 with `extrinsic:null` when cold/unknown).
- `/api/v1/registry/leaderboards`: fetch registry leaderboards (`board=healthiest|fastest-rpc|most-complete|most-enriched|fastest-growing|open-slots|cheapest-registration|highest-emission|validator-headroom`, or omit for all). The four economic boards rank cross-subnet miner/validator opportunity from the economics tier; pairs with the `find_subnet_opportunities` MCP tool.
- `/api/v1/compare`: compare several subnets side by side across registry structure, the economics tier, and the live per-subnet health rollup. `netuids` (required) is a comma-separated list of 1-128 subnet ids; `dimensions` (optional) selects a subset of `structure,economics,health` (default all). Returns one entry per requested netuid in requested order, with `found:false` for unknown ids.
- `/api/v1/rpc/usage`: fetch RPC reverse-proxy usage analytics (request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets) over a 7d/30d window (live from the `rpc_proxy_events` D1 telemetry). `7d` uses 1-hour buckets; `30d` uses 6-hour buckets.
- `/api/v1/surfaces`: list curated public surfaces.
- `/api/v1/subnets/{netuid}/surfaces`: list curated public surfaces for one subnet.
- `/api/v1/endpoints`: list generalized endpoint resources and monitored public surfaces.
- `/api/v1/subnets/{netuid}/endpoints`: list generalized endpoint resources for one subnet.
- `/api/v1/candidates`: list unpromoted candidate surfaces.
- `/api/v1/subnets/{netuid}/candidates`: list unpromoted candidate surfaces for one subnet.
- `/api/v1/providers`: list providers and sources.
- `/api/v1/providers/{slug}`: fetch per-provider detail.
- `/api/v1/providers/{slug}/endpoints`: list endpoint resources for one provider or operator.
- `/api/v1/coverage`: fetch registry coverage summary.
- `/api/v1/economics`: list per-subnet validator/economic metrics, ordered by emission share.
- `/api/v1/curation`: fetch curation states by subnet.
- `/api/v1/gaps`: fetch interface gap report.
- `/api/v1/review/gaps`: fetch contributor-targeted subnet gap priorities.
- `/api/v1/subnets/{netuid}/gaps`: fetch interface gap priorities and enrichment queue for one subnet.
- `/api/v1/review/profile-completeness`: fetch profile completeness gaps for contributor targeting.
- `/api/v1/review/adapter-candidates`: fetch subnets worth deeper adapter work.
- `/api/v1/review/enrichment-queue`: fetch the prioritized all-subnet enrichment queue.
- `/api/v1/review/enrichment-evidence`: fetch detailed candidate evidence behind the enrichment queue.
- `/api/v1/review/enrichment-targets`: fetch contributor-ready enrichment targets grouped by missing surface kind and review route.
- `/api/v1/health`: fetch global health summary.
- `/api/v1/health/history/{date}`: fetch compact daily health history.
- `/api/v1/subnets/{netuid}/health`: fetch health detail for one subnet.
- `/api/v1/health/trends`: fetch compact all-subnet 7d/30d daily uptime and latency trends (live from D1).
- `/api/v1/freshness`: fetch freshness and staleness state.
- `/api/v1/source-health`: fetch upstream source health.
- `/api/v1/evidence`: fetch public evidence ledger.
- `/api/v1/subnets/{netuid}/evidence`: fetch public evidence ledger claims for one subnet.
- `/api/v1/changelog`: fetch latest generated change summary.
- `/api/v1/source-snapshots`: fetch source input hashes and counts.
- `/api/v1/rpc/endpoints`: fetch Bittensor RPC endpoint status.
- `/api/v1/rpc/pools`: fetch endpoint pool scores.
- `/api/v1/endpoint-pools`: fetch generalized endpoint pool scores.
- `/api/v1/endpoint-incidents`: fetch probe-derived endpoint incidents.
- `/api/v1/incidents`: fetch recent cross-subnet downtime incidents reconstructed from probe history over a 7d/30d window (live from D1).
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
- `npm run discover:candidates`: refresh public-source candidate discovery from chain-adjacent enrichment sources, third-party subnet dashboards, subnet metagraph explorer pages, GitHub README links, and public project websites. GitHub README-derived links are capped, de-duplicated by kind/domain, and limited to project-affiliated provenance before they enter the generated candidate bundle.
- `npm run verify:candidates`: safely verify public candidates.
- `npm run curate:baseline`: derive generated overlays from verified candidates, commit only compact checksum metadata, and stage expanded generated overlays outside Git for R2.
- `npm run review:promote`: apply public-safe maintainer review decisions to overlays.
- `npm run schemas:snapshot`: fetch machine-readable OpenAPI/Swagger JSON snapshots and update schema drift.
- `npm run schemas:bundle`: bundle canonical modular JSON Schema components into `schemas/api-components.schema.json`.
- `npm run adapters:snapshot`: capture safe Allways/Gittensor public adapter summaries.
- `METAGRAPH_WRITE_PROBE_RESULTS=1 npm run probes:smoke`: run live read-only probes and persist health/RPC history.
- `npm run r2:manifest`: regenerate the Cloudflare R2 manifest from current public artifacts.
- `npm run r2:download:dry-run`: summarize an R2 restore/download without writing local files.
- `npm run kv:publish:dry-run`: summarize KV latest pointer, feature flags, endpoint pool, and freshness control records.
- `npm run validate:schemas`: run strict JSON Schema validation over registry inputs and public artifacts.
- `npm run validate:api`: validate Worker API routes over local artifacts.
- `npm run validate:contract-drift`: validate schema bundle, OpenAPI, generated TypeScript, generated client, and typed route response parity.
- `npm run validate:schema-enums`: validate enum parity between canonical schemas and route/query validation.
- `npm run validate:openapi-examples`: validate real artifact-backed response examples against OpenAPI.
- `npm run validate:generated-client`: validate the generated TypeScript client helper is current.
- `npm run contract:summary`: compare schema contracts against a base ref and classify changes as additive, risky, or breaking.
- `npm run validate:docs`: validate public docs against current artifact and API contracts.
- `npm run validate:intake`: validate GitHub issue intake templates.
- `npm run surface:add`: append a community surface to a subnet's file.
- `npm run validate:workflows`: validate workflow hardening rules.
- `npm run worker:deploy:dry-run`: validate Worker/Wrangler deployment shape without contacting Cloudflare.
- `npm run sync:summary`: generate a registry-refresh PR summary from actual artifact diffs.

Local generated artifacts default to the deterministic review timestamp. Use
`METAGRAPH_BUILD_TIMESTAMP=<iso-8601>` only when a refresh needs an explicit
shared `generated_at` across discovery, build, schema, and R2 manifest
artifacts.

Production publish validation can enforce operational freshness with:

```bash
METAGRAPH_REQUIRE_PROBE_HEALTH=1 METAGRAPH_REQUIRE_FRESHNESS=1 npm run validate
```

Those gates require fresh native subnet data, candidate discovery, candidate
verification, probe-derived health, and adapter snapshots. Schema drift remains
warning-only until more subnets expose machine-readable schemas.

## Cloudflare Runtime

`workers/api.mjs` serves stable `/api/v1/*` JSON envelopes over the canonical artifact tree. It reads from Workers Static Assets first and can fall back to R2 through `METAGRAPH_ARCHIVE` when configured. If the optional `METAGRAPH_CONTROL` KV binding exists, the Worker reads `metagraph:latest` to resolve the current R2 prefix.

The RPC proxy route is intentionally disabled unless `METAGRAPH_ENABLE_RPC_PROXY=true`. When enabled for controlled testing, it only accepts single JSON-RPC POST bodies and blocks write/unsafe methods before any upstream request is made.

## Change-Feed Webhooks + SSE

metagraph.sh regenerates its dataset on an event-driven publish — on each human-input registry merge, plus a daily floor (ADR 0007) — so the realtime surface is a **change feed**: a notification within seconds of each publish, not a sub-second tail. These routes live outside the artifact contract (dynamic, KV-backed) and degrade to `503 webhooks_unavailable` when the `METAGRAPH_CONTROL` KV binding is absent.

- `POST /api/v1/webhooks/subscriptions` — register `{ url, filters?: { netuids?: integer[], kinds?: ("subnets"|"artifacts")[] }, secret? }`. The `url` must be a public `https://` endpoint (private/loopback/link-local hosts and non-default ports are rejected). Returns `{ id, secret, ... }` once; the secret is never echoed again.
- `GET /api/v1/webhooks/subscriptions/{id}` — fetch a subscription's public view (no secret), including a `delivery` health summary (`status` `ok`/`retrying`/`dead_letter`, `pending`/`dead_letter` counts, and a `last_failure` with attempt count, reason, and next-attempt time).
- `DELETE /api/v1/webhooks/subscriptions/{id}` — delete; requires the secret in the `x-metagraph-webhook-secret` header.
- `GET /api/v1/events` — thin SSE change feed: emits the current change snapshot (derived from `changelog.json` + the KV `latest` pointer) as one `event: snapshot`, with `retry: 300000` advising a 5-minute reconnect. There is no value in holding a connection open between publishes.

At publish time the dispatcher reads `changelog.json`, matches each subscription's filters, and `POST`s the change event signed with `HMAC-SHA256` (hex) over the raw body in the `x-metagraph-signature` header. Each delivery also carries `x-metagraph-event-id` (stable per event content) and `x-metagraph-idempotency-key` (stable per subscription + event), so subscribers can dedupe retries safely.

Delivery is **at-least-once**. Within a run a transient failure (network/timeout/5xx/429) is retried with short backoff; if it still fails it is parked per-(subscription, event) under the `webhooks:delivery:<id>:<event_id>` KV prefix and re-attempted on subsequent publish runs with bounded exponential spacing (5 min → 12 h). Each publish redelivery sweep is budgeted to a limited key sample, 64 attempts per run, and 8 attempts per subscription. After 8 failed rounds — or on a deterministic rejection (4xx/redirect) — the delivery becomes a dead letter, surfaced via the `delivery` summary on GET. Successful (re)delivery clears the parked record. Parked records (like subscriptions) auto-expire after 180 days. The SSRF guard is best-effort and cannot prevent DNS rebinding; the dispatcher runs on GitHub-hosted runners with no access to the project's network, which bounds the residual risk.

## Remote MCP Server (AI agents)

`POST /mcp` is a stateless [Model Context Protocol](https://modelcontextprotocol.io) server (Streamable HTTP transport, JSON-RPC 2.0) that exposes the registry to AI agents (Claude Desktop/Code, Cursor, autonomous agents). It is read-only, so there is no session id, Durable Object, or server-initiated stream; `GET /mcp` returns `405`. The handler (`src/mcp-server.mjs`) is dispatched before the read-only method gate (it is POST-only, like the RPC proxy) and reuses the exact R2/ASSETS artifact resolution via injected readers, so MCP tools and REST routes always agree.

Tools (thin wrappers over the artifact contract): `search_subnets`, `find_subnets_by_capability`, `get_subnet`, `get_subnet_health`, `list_subnet_apis`, `get_api_schema`, `get_agent_catalog`, `get_best_rpc_endpoint` (live-health-filtered), `registry_summary`, the AI-layer pair `semantic_search` (vector/meaning-based discovery) + `ask` (grounded RAG Q&A with citations), and the goal-shaped pair `find_subnet_for_task` (plain-language task → callable subnets, ranked semantically when AI is present, by keyword otherwise) + `how_do_i_call` (one subnet, by netuid or slug → concrete call instructions: base URL, auth, schema pointer, health). The two AI tools require the VECTORIZE + AI bindings and degrade to a graceful `isError` result (pointing at the keyword tools) when the AI layer is unavailable. `tools/call` returns the MCP result envelope (`content[]` text + `structuredContent`); argument and artifact failures degrade to an `isError: true` result rather than a transport error. The server is validated by `npm run validate:mcp` (lifecycle + one `tools/call` per tool against a cold local env) and smoke-checked live by `scripts/smoke-live-api.mjs`. The endpoint is excluded from the `validate-api` route-count invariant and is added to `assets.run_worker_first`.

`serverInfo.version` is the MCP server's own **SemVer** (`MCP_SERVER_VERSION` in `src/mcp-server.mjs`, also surfaced in the generated `server-card.json`) — deliberately distinct from the date-based `CONTRACT_VERSION` (the REST/data contract), since the tool surface is a separate public contract agents depend on. Bump policy: **add a tool / additive field → minor**; **change or remove a tool's I/O → major**; behavioral-only fix → patch. `validate:mcp` asserts `serverInfo.version` is SemVer and matches the constant.

## AI Search + Ask (semantic + RAG)

Two **out-of-contract dynamic routes** (special-handled like `/api/v1/events`, so they are not in `API_ROUTES`, OpenAPI, or the `validate-api` route-count invariant) power natural-language discovery, backed by Workers AI + a Vectorize index:

- `GET /api/v1/search/semantic?q=&limit=` — embeds the query (`@cf/qwen/qwen3-embedding-0.6b`, 1024-dim) and returns the nearest registry entries `{ score, type, netuid, slug, title, subtitle, url }` (limit ≤ 20). Vector search, so it matches intent without exact keywords.
- `POST /api/v1/ask` — body `{ question }`. Retrieves the top-6 registry entries and prompts `@cf/meta/llama-4-scout-17b-16e-instruct` with a cite-only system prompt, returning `{ question, answer, citations[], context_count, model }`. The answer is grounded in registry context and cites sources as `[n]`.

Both live in `src/ai-search.mjs`, return the standard `{ ok, schema_version, data, meta }` envelope, and are gated three ways: the `METAGRAPH_ENABLE_AI` kill-switch, the presence of the `AI` + `VECTORIZE` bindings (absent in local/CI → `503 ai_unavailable`), and the `AI_RATE_LIMITER` binding (20 req/60s per client IP; absent → allow). Hard caps bound cost: result/context size and a 1000-char question limit. The Vectorize index (`metagraphed-registry-v2`, 1024-dim/cosine) is kept warm by a daily embedding-sync cron (`37 3 * * *`) that diffs the `search.json` index against a content-hash manifest in KV and re-embeds only the deltas. Response shapes are validated by `npm run validate:ai` (disabled→503, stubbed-enabled→200 against `schemas/ai/*.schema.json`, negatives + rate-limit); see ADR 0003.

## Current Domain Scope

Use `metagraph.sh` for the current launch. Do not use `subnet.health` for v1 registry, status, badge, health, or probe contracts.
