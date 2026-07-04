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
- `/metagraph/search-index.json`: slim search index — the same documents as `search.json` without the per-document token blobs, for fast browser typeahead and listing.
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
- `/metagraph/subnets/{netuid}/concentration.json`: schema for stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) across per-UID, per-entity (coldkeys collapsed), and validator-only lenses, served live from the neurons D1 tier at `GET /api/v1/subnets/{netuid}/concentration` (no static file).
- `/metagraph/subnets/{netuid}/concentration/history.json`: schema for the per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) over a 7d/30d/90d window, served live from the neuron_daily D1 rollup at `GET /api/v1/subnets/{netuid}/concentration/history` (no static file).
- `/metagraph/subnets/{netuid}/performance/history.json`: schema for the per-day reward-flow & trust trend (incentive/dividends Gini, Nakamoto coefficient, top-10% share, plus trust/consensus/validator_trust mean & median) over a 7d/30d/90d window — the reward-flow twin of `concentration/history` — served live from the neuron_daily D1 rollup at `GET /api/v1/subnets/{netuid}/performance/history` (no static file).
- `/metagraph/subnets/{netuid}/performance.json`: schema for a subnet's reward-distribution & score-spread metrics — reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores — served live from the neurons D1 tier at `GET /api/v1/subnets/{netuid}/performance` (no static file).
- `/metagraph/subnets/{netuid}/turnover.json`: schema for validator-set & registration turnover (validators entered/exited + retention, UID deregistrations, stability score) between a window's start and end snapshots, served live from the neuron_daily D1 rollup at `GET /api/v1/subnets/{netuid}/turnover` (no static file).
- `/metagraph/subnets/{netuid}/stake-flow.json`: schema for net stake flow (total TAO staked vs unstaked, net flow, and stake/unstake event counts) over a 7d/30d/90d window, served live from the account_events D1 stream at `GET /api/v1/subnets/{netuid}/stake-flow` (no static file).
- `/metagraph/subnets/{netuid}/weights.json`: schema for a subnet's validator weight-setting activity (distinct weight-setting validators, WeightsSet event count, and average updates per validator) over a 7d/30d window, served live from the account_events D1 WeightsSet stream at `GET /api/v1/subnets/{netuid}/weights` (no static file).
- `/metagraph/subnets/{netuid}/weights/setters.json`: schema for a subnet's weight-setter leaderboard (the individual validators behind `/weights`, each with its WeightsSet count, share of the subnet total, and first/last set time, ranked by activity) over a 7d/30d window, served live from the account_events D1 WeightsSet stream at `GET /api/v1/subnets/{netuid}/weights/setters` (no static file).
- `/metagraph/subnets/{netuid}/serving.json`: schema for a subnet's axon-serving announcement activity (distinct servers, AxonServed event count, and average announcements per server) over a 7d/30d window, served live from the account_events D1 AxonServed stream at `GET /api/v1/subnets/{netuid}/serving` (no static file).
- `/metagraph/subnets/{netuid}/prometheus.json`: schema for a subnet's Prometheus-endpoint serving activity (distinct exporters, PrometheusServed event count, and average announcements per exporter) over a 7d/30d window — the telemetry-endpoint sibling of `subnets/{netuid}/serving` — served live from the account_events D1 PrometheusServed stream at `GET /api/v1/subnets/{netuid}/prometheus` (no static file).
- `/metagraph/subnets/{netuid}/stake-moves.json`: schema for a subnet's stake-movement (re-delegation) activity (distinct movers, StakeMoved event count, and average movements per mover) over a 7d/30d window — the re-delegation-churn sibling of `subnets/{netuid}/stake-flow` — served live from the account_events D1 StakeMoved stream at `GET /api/v1/subnets/{netuid}/stake-moves` (no static file).
- `/metagraph/subnets/{netuid}/registrations.json`: schema for a subnet's neuron-registration activity (distinct registrants, NeuronRegistered event count, and average registrations per registrant) over a 7d/30d window, served live from the account_events D1 NeuronRegistered stream at `GET /api/v1/subnets/{netuid}/registrations` (no static file).
- `/metagraph/subnets/{netuid}/axon-removals.json`: schema for a subnet's axon-removal activity (distinct removers, AxonInfoRemoved event count, and average removals per remover) over a 7d/30d window, served live from the account_events D1 AxonInfoRemoved stream at `GET /api/v1/subnets/{netuid}/axon-removals` (no static file).
- `/metagraph/subnets/{netuid}/deregistrations.json`: schema for a subnet's neuron-deregistration activity (distinct deregistered hotkeys, NeuronDeregistered event count, and average deregistrations per hotkey) over a 7d/30d window, served live from the account_events D1 NeuronDeregistered stream at `GET /api/v1/subnets/{netuid}/deregistrations` (no static file).
- `/metagraph/subnets/movers.json`: schema for the cross-subnet momentum leaderboard (every subnet ranked by stake, emission, and validator-count change between a window's start and end snapshots), served live from the neuron_daily D1 rollup at `GET /api/v1/subnets/movers` (no static file).
- `/metagraph/validators.json`: schema for the network-wide validator/operator footprint leaderboard (validator-permit identities grouped across all current subnet memberships; per-membership stake/emission remains scoped to `subnets[]`), served live from the `neurons` D1 tier at `GET /api/v1/validators` (no static file).
- `/metagraph/subnets/{netuid}/uptime.json`: schema for the long-term daily uptime history per operational surface (90d/1y window), served live from the `surface_uptime_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/uptime` (no static file).
- `/metagraph/subnets/{netuid}/metagraph.json`: schema for the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/metagraph` (no static file).
- `/metagraph/subnets/{netuid}/neurons/{uid}.json`: schema for a single neuron's metagraph state served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/neurons/{uid}` (no static file).
- `/metagraph/subnets/{netuid}/validators.json`: schema for a subnet's validators (validator_permit) ranked by stake, served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/validators` (no static file).
- `/metagraph/subnets/{netuid}/yield.json`: schema for a subnet's per-UID emission yield (emission/stake return rate) over the current metagraph snapshot, ranked high to low with a distribution summary (subnet aggregate yield, mean, p25/median/p75/p90), a validator/miner split, and a per-UID above/below-median label, served live from the `neurons` D1 tier at `GET /api/v1/subnets/{netuid}/yield` (no static file).
- `/metagraph/subnets/{netuid}/yield/history.json`: schema for the per-day emission-yield distribution trend (subnet-wide return plus the mean/median/p25/p75/p90 of the per-UID emission-per-stake yields) over a 7d/30d/90d window — the time-series companion to `yield` and the return-rate twin of `concentration/history` — served live from the neuron_daily D1 rollup at `GET /api/v1/subnets/{netuid}/yield/history` (no static file).
- `/metagraph/subnets/{netuid}/events.json`: schema for a subnet's first-party chain-event stream (registrations, stake, weights, axon, delegation, lifecycle, transfers) newest first, served live from the `account_events` D1 tier filtered by netuid at `GET /api/v1/subnets/{netuid}/events` (no static file).
- `/metagraph/subnets/{netuid}/event-summary.json`: schema for a subnet's windowed event summary (counts by event kind/category, distinct hotkey/coldkey counts, TAO/alpha sums, first/last evidence bounds, and recent evidence), served live from the `account_events` D1 tier at `GET /api/v1/subnets/{netuid}/event-summary` (no static file).
- `/metagraph/subnets/{netuid}/neurons/{uid}/history.json`: schema for a UID's per-day metagraph time series served live from the `neuron_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/neurons/{uid}/history` (no static file).
- `/metagraph/subnets/{netuid}/history.json`: schema for a subnet's per-day metagraph history (one snapshot/day) served live from the `neuron_daily` D1 rollup at `GET /api/v1/subnets/{netuid}/history` (no static file).
- `/metagraph/subnets/{netuid}/identity-history.json`: schema for a subnet's append-only on-chain identity timeline (SubnetIdentitiesV3 snapshots on change), served live from the `subnet_identity_history` D1 tier at `GET /api/v1/subnets/{netuid}/identity-history` (no static file).
- `/metagraph/accounts/{ss58}.json`: schema for a cross-subnet account summary (chain-event aggregates joined to current registrations), served live from the `account_events` + `neurons` D1 tiers at `GET /api/v1/accounts/{ss58}` (no static file).
- `/metagraph/accounts/{ss58}/events.json`: schema for an account's paginated chain-event history, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/events` (no static file).
- `/metagraph/accounts/{ss58}/history.json`: schema for an account's durable per-day activity series (hotkey-keyed, newest day first), served live from the `account_events_daily` rollup at `GET /api/v1/accounts/{ss58}/history` (no static file).
- `/metagraph/accounts/{ss58}/extrinsics.json`: schema for the extrinsics an account signed (by signer), served live from the `extrinsics` D1 tier at `GET /api/v1/accounts/{ss58}/extrinsics` (no static file).
- `/metagraph/accounts/{ss58}/transfers.json`: schema for the native-TAO Balances.Transfer feed for an account (directional), served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/transfers` (no static file).
- `/metagraph/accounts/{ss58}/counterparties.json`: schema for the per-counterparty fund-flow rollup for an account (transfers aggregated by counterparty into sent/received/net, ranked by volume), served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/counterparties` (no static file).
- `/metagraph/accounts/{ss58}/stake-flow.json`: schema for an account's StakeAdded vs StakeRemoved flow per subnet over a 7d/30d/90d window (per-subnet net/gross flow with a direction label, account totals, an HHI concentration, and the dominant subnet), served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/stake-flow` (no static file).
- `/metagraph/accounts/{ss58}/registrations.json`: schema for an account's neuron-registration footprint per subnet over a 7d/30d/90d window (per-subnet NeuronRegistered count with first/last registration timestamps, account totals, an HHI concentration, and the dominant subnet) — the account-level companion to `chain/registrations`, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/registrations` (no static file).
- `/metagraph/accounts/{ss58}/serving.json`: schema for an account's axon-serving footprint per subnet over a 7d/30d/90d window (per-subnet AxonServed announcement count with first/last announcement timestamps, account totals, an HHI concentration, and the dominant subnet) — the account-level companion to `chain/serving`, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/serving` (no static file).
- `/metagraph/accounts/{ss58}/axon-removals.json`: schema for an account's axon-removal footprint per subnet over a 7d/30d/90d window (per-subnet AxonInfoRemoved count with first/last removal timestamps, account totals, an HHI concentration, and the dominant subnet) — the teardown-side complement to `accounts/{ss58}/serving` and the account-level companion to `chain/axon-removals`, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/axon-removals` (no static file).
- `/metagraph/accounts/{ss58}/prometheus.json`: schema for an account's Prometheus-endpoint serving footprint per subnet over a 7d/30d/90d window (per-subnet PrometheusServed announcement count with first/last announcement timestamps, account totals, an HHI concentration, and the dominant subnet) — the telemetry sibling of `accounts/{ss58}/serving` and the account-level companion to `chain/prometheus`, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/prometheus` (no static file).
- `/metagraph/accounts/{ss58}/deregistrations.json`: schema for an account's neuron-deregistration footprint per subnet over a 7d/30d/90d window (per-subnet NeuronDeregistered eviction count with first/last eviction timestamps, account totals, an HHI concentration, and the dominant subnet) — the eviction-side complement to `accounts/{ss58}/registrations` and the account-level companion to `chain/deregistrations`, served live from the `account_events` D1 tier at `GET /api/v1/accounts/{ss58}/deregistrations` (no static file).
- `/metagraph/accounts/{ss58}/subnets.json`: schema for the subnets where an account's hotkey is currently registered, served live from the `neurons` D1 tier at `GET /api/v1/accounts/{ss58}/subnets` (no static file).
- `/metagraph/accounts/{ss58}/portfolio.json`: schema for a wallet's cross-subnet neuron portfolio — each position's economics (stake, emission, rank, trust, incentive, dividends, role) and yield, plus aggregates (totals, subnet/validator counts, overall return, stake concentration) — served live from the `neurons` D1 tier at `GET /api/v1/accounts/{ss58}/portfolio` (no static file).
- `/metagraph/accounts/{ss58}/balance.json`: schema for an account's live TAO balance (free + reserved), queried from the finney RPC at request time with a 60s KV cache, served at `GET /api/v1/accounts/{ss58}/balance` (no static file).
- `/metagraph/blocks.json`: schema for the recent-block feed (newest first) of the block explorer, served live from the first-party `blocks` D1 tier at `GET /api/v1/blocks` (no static file).
- `/metagraph/blocks/summary.json`: schema for block-production analytics over the most recent blocks — inter-block time distribution, extrinsic/event throughput, block-author decentralization, and the runtime spec-version spread — computed live from the first-party `blocks` D1 tier at `GET /api/v1/blocks/summary` (no static file).
- `/metagraph/blocks/{ref}.json`: schema for per-block detail (by numeric `block_number` or `0x` `block_hash`), served live from the first-party `blocks` D1 tier at `GET /api/v1/blocks/{ref}` (no static file).
- `/metagraph/blocks/{ref}/extrinsics.json`: schema for the extrinsics in one block (by numeric `block_number` or `0x` `block_hash`), served live from the first-party `extrinsics` D1 tier at `GET /api/v1/blocks/{ref}/extrinsics` (no static file).
- `/metagraph/blocks/{ref}/events.json`: schema for the decoded chain events in one block (by numeric `block_number` or `0x` `block_hash`), served live from the first-party `account_events` D1 tier filtered by block_number at `GET /api/v1/blocks/{ref}/events` (no static file).
- `/metagraph/extrinsics.json`: schema for the recent-extrinsic feed (newest first) of the block explorer, served live from the first-party `extrinsics` D1 tier at `GET /api/v1/extrinsics` (no static file).
- `/metagraph/extrinsics/{hash}.json`: schema for per-extrinsic detail (by `0x` `extrinsic_hash`), served live from the first-party `extrinsics` D1 tier at `GET /api/v1/extrinsics/{hash}` (no static file).
- `/metagraph/chain/activity.json`: schema for the daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d/30d window, computed live from the first-party chain D1 tiers at `GET /api/v1/chain/activity` (no static file).
- `/metagraph/chain/calls.json`: schema for the extrinsic call-mix breakdown (count + share per `call_module`/`call_function`) over a 7d/30d window, computed live from the first-party `extrinsics` D1 tier at `GET /api/v1/chain/calls` (no static file).
- `/metagraph/chain/signers.json`: schema for the windowed most-active-account leaderboard (signers by extrinsic count, with fees/tips + newest block) over a 7d/30d window, computed live from the first-party `extrinsics` D1 tier at `GET /api/v1/chain/signers` (no static file).
- `/metagraph/chain/transfers.json`: schema for network-wide native-TAO transfer analytics over a 7d/30d window (total Balances.Transfer volume + count, distinct senders/receivers, top senders + receivers by volume, and the top senders' share of total volume), computed live from the `account_events` Transfer feed at `GET /api/v1/chain/transfers` (no static file).
- `/metagraph/chain/transfer-pairs.json`: schema for network-wide directed native-TAO transfer-pair analytics over a 7d/30d window (total pairable Balances.Transfer volume + count, unique sender/receiver pairs, returned pair count, top-pair share, and top sender-to-receiver pairs ranked by volume or count), computed live from the `account_events` Transfer feed at `GET /api/v1/chain/transfer-pairs` (no static file).
- `/metagraph/chain/stake-flow.json`: schema for network-wide cross-subnet capital flow over a 7d/30d window — every subnet that moved stake in the window ranked by net StakeAdded minus StakeRemoved TAO (quiet subnets excluded) (per-subnet staked/unstaked/net/gross + direction, a network rollup, and a net-flow distribution) — computed live from the `account_events` stake stream at `GET /api/v1/chain/stake-flow` (no static file).
- `/metagraph/chain/weights.json`: schema for network-wide validator weight-setting activity over a 7d/30d window across the subnets with observed weight-setting activity — a per-subnet leaderboard (distinct setters, WeightsSet count, updates per validator), a network rollup with the true distinct setter count, and a distribution of per-subnet update intensity — computed live from the `account_events` WeightsSet stream at `GET /api/v1/chain/weights` (no static file).
- `/metagraph/chain/weights/setters.json`: schema for the network-wide weight-setter leaderboard — the individual validators driving consensus across every subnet, each with its total WeightsSet count (summed across every subnet it operates on), its share of the network total, and its first/last set time — computed live from the `account_events` WeightsSet stream at `GET /api/v1/chain/weights/setters` (no static file).
- `/metagraph/chain/serving.json`: schema for network-wide axon-serving announcement activity over a 7d/30d window across the subnets with observed serving activity — a per-subnet leaderboard (AxonServed count, distinct servers, announcements per server), a network rollup with the true distinct server count, and a distribution of per-subnet re-announcement intensity — computed live from the `account_events` AxonServed stream at `GET /api/v1/chain/serving` (no static file).
- `/metagraph/chain/prometheus.json`: schema for network-wide Prometheus-endpoint serving activity over a 7d/30d window across the subnets with observed telemetry activity — a per-subnet leaderboard (PrometheusServed count, distinct exporters, announcements per exporter), a network rollup with the true distinct exporter count, and a distribution of per-subnet re-announcement intensity — the telemetry-endpoint companion to `chain/serving`, computed live from the `account_events` PrometheusServed stream at `GET /api/v1/chain/prometheus` (no static file).
- `/metagraph/chain/axon-removals.json`: schema for network-wide axon-removal activity over a 7d/30d window across the subnets with observed removal activity — a per-subnet leaderboard (AxonInfoRemoved count, distinct removers, removals per remover), a network rollup with the true distinct remover count, and a distribution of per-subnet re-teardown intensity — the teardown-side companion to `chain/serving` and the network-wide companion to `subnets/{netuid}/axon-removals`, computed live from the `account_events` AxonInfoRemoved stream at `GET /api/v1/chain/axon-removals` (no static file).
- `/metagraph/chain/registrations.json`: schema for network-wide neuron-registration activity over a 7d/30d window across the subnets with observed registration activity — a per-subnet leaderboard (NeuronRegistered count, distinct registrants, registrations per registrant), a network rollup with the true distinct registrant count, and a distribution of per-subnet re-registration intensity — computed live from the `account_events` NeuronRegistered stream at `GET /api/v1/chain/registrations` (no static file).
- `/metagraph/chain/deregistrations.json`: schema for network-wide neuron-deregistration activity over a 7d/30d window across the subnets with observed deregistration activity — a per-subnet leaderboard (NeuronDeregistered count, distinct deregistered hotkeys, deregistrations per hotkey), a network rollup with the true distinct hotkey count, and a distribution of per-subnet re-deregistration intensity — computed live from the `account_events` NeuronDeregistered stream at `GET /api/v1/chain/deregistrations` (no static file).
- `/metagraph/chain/stake-moves.json`: schema for network-wide stake-movement (re-delegation) activity over a 7d/30d window across the subnets with observed movement activity — a per-subnet leaderboard (StakeMoved count, distinct movers, movements per mover), a network rollup with the true distinct mover count, and a distribution of per-subnet re-move intensity — the re-delegation-churn companion to `chain/stake-flow` (net capital flow), computed live from the `account_events` StakeMoved stream at `GET /api/v1/chain/stake-moves` (no static file).
- `/metagraph/chain/fees.json`: schema for the fee/tip market analytics (per-day totals, averages, exact medians, and a top-fee-payer list) over a 7d/30d window, computed live from the first-party `extrinsics` D1 tier at `GET /api/v1/chain/fees` (no static file).
- `/metagraph/chain/concentration.json`: schema for the network-wide stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) aggregated across every subnet's neurons — per-UID, per-entity (coldkeys collapsed across subnets), and validator-only lenses — computed live from the `neurons` D1 tier at `GET /api/v1/chain/concentration` (no static file).
- `/metagraph/chain/performance.json`: schema for the network-wide reward-distribution & score-spread metrics aggregated across every subnet's neurons — reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores — computed live from the `neurons` D1 tier at `GET /api/v1/chain/performance` (no static file).
- `/metagraph/chain/identity-history.json`: schema for the network-wide recent subnet-identity-change feed (newest first) aggregated across every subnet — the most-recent SubnetIdentitiesV3 changes, each carrying the `netuid` it belongs to plus the same tracked identity fields as the per-subnet identity-history route, capped to `?limit` (default 50, max 200) with the distinct `subnet_count` the feed spans — computed live from the `subnet_identity_history` D1 tier at `GET /api/v1/chain/identity-history` (no static file).
- `/metagraph/chain/yield.json`: schema for the network-wide emission-yield (return rate) aggregated across every subnet's neurons — the aggregate network return (total emission / total stake), the same split by validator vs miner role, and the count/mean/median/min/max plus p10–p90 spread of the per-neuron emission/stake return — computed live from the `neurons` D1 tier at `GET /api/v1/chain/yield` (no static file).
- `/metagraph/chain/turnover.json`: schema for the network-wide validator-set turnover across every subnet between a window's boundary `neuron_daily` snapshots — a per-subnet leaderboard (validators entered/exited, Jaccard retention, 0-100 stability score) plus a network rollup over the union validator set — computed live from the `neuron_daily` D1 rollup at `GET /api/v1/chain/turnover` (no static file).
- `/metagraph/chain-events.json`: schema for the recent all-events feed (newest first) — every raw pallet.method event from the Postgres-backed all-events tier (ADR 0013), served live by the data Worker at `GET /api/v1/chain-events` (no static file). Distinct from the curated account-attributed `/blocks/{ref}/events` stream.
- `/metagraph/chain-events/stats.json`: schema for the chain-activity aggregate (pallet.method event distribution over the most recent N blocks) from the Postgres-backed all-events tier (ADR 0013), served live at `GET /api/v1/chain-events/stats` (no static file) and consumed by the `get_chain_activity` MCP tool.
- `/metagraph/blocks/{ref}/chain-events.json`: schema for every raw pallet-level event in one block (by numeric `block_number`, `event_index` ascending) from the Postgres-backed all-events tier (ADR 0013), served live at `GET /api/v1/blocks/{ref}/chain-events` (no static file).
- `/metagraph/economics/trends.json`: schema for the network-wide economics time series (per UTC day across all subnets: total stake, stake-weighted + median alpha price, total validator/miner counts, mean emission share) aggregated live from the daily `subnet_snapshots` D1 rollup at `GET /api/v1/economics/trends` (no static file).
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
- `/api/v1/fixtures`: fetch the index of captured live request/response fixtures (per-surface samples are available through `/api/v1/fixtures/{surface_id}`, `/metagraph/fixtures/{surface_id}.json`, and the `get_fixture` MCP tool).
- `/api/v1/fixtures/{surface_id}`: fetch one captured, sanitized live request/response fixture by surface id.
- `/api/v1/agent-resources`: fetch the AI-resources index (the copyable agent at `/agent.md`, the MCP server + tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs).
- `/api/v1/subnets/{netuid}/health/percentiles`: fetch p50/p95/p99 latency percentiles per operational surface over a 7d/30d window (live from D1).
- `/api/v1/subnets/{netuid}/health/incidents`: fetch SLA (uptime ratio) + reconstructed downtime incidents per operational surface over a 7d/30d window (live from D1).
- `/api/v1/subnets/{netuid}/trajectory`: fetch the week-over-week structural trajectory (completeness + counts) from daily snapshots (live from D1).
- `/api/v1/subnets/{netuid}/concentration`: fetch stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for one subnet across per-UID, per-entity (coldkeys collapsed), and validator-only consensus-power lenses (live from the neurons D1 tier).
- `/api/v1/subnets/{netuid}/performance`: fetch a subnet's reward-distribution & score-spread metrics — reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores (live from the neurons D1 tier).
- `/api/v1/subnets/{netuid}/concentration/history`: fetch the per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) for one subnet over a `?window=7d|30d|90d` (live from the neuron_daily D1 rollup).
- `/api/v1/subnets/{netuid}/performance/history`: fetch the per-day reward-flow & trust trend (incentive/dividends Gini, Nakamoto coefficient, top-10% share, plus trust/consensus/validator_trust mean & median) for one subnet over a `?window=7d|30d|90d` — the reward-flow twin of `concentration/history` (live from the neuron_daily D1 rollup).
- `/api/v1/subnets/{netuid}/turnover`: fetch validator-set & registration turnover (validators entered/exited + retention, UID deregistrations, stability score) for one subnet over a `?window=7d|30d|90d|1y|all` (live from the neuron_daily D1 rollup).
- `/api/v1/subnets/{netuid}/stake-flow`: fetch net stake flow (total TAO staked vs unstaked, net flow, stake/unstake event counts) for one subnet over a `?window=7d|30d|90d` (live from the account_events D1 stream).
- `/api/v1/subnets/{netuid}/weights`: fetch validator weight-setting activity (distinct weight-setting validators, WeightsSet event count, average updates per validator) for one subnet over a `?window=7d|30d` (live from the account_events D1 WeightsSet stream).
- `/api/v1/subnets/{netuid}/weights/setters`: fetch the per-subnet weight-setter leaderboard — the individual validators behind `/weights` ranked by activity, each with its WeightsSet count, share of the subnet total, and first/last set time — for one subnet over a `?window=7d|30d` (live from the account_events D1 WeightsSet stream).
- `/api/v1/subnets/{netuid}/serving`: fetch axon-serving announcement activity (distinct servers, AxonServed event count, average announcements per server) for one subnet over a `?window=7d|30d` (live from the account_events D1 AxonServed stream).
- `/api/v1/subnets/{netuid}/prometheus`: fetch Prometheus-endpoint serving activity (distinct exporters, PrometheusServed event count, average announcements per exporter) for one subnet over a `?window=7d|30d` — the telemetry-endpoint sibling of `subnets/{netuid}/serving` (live from the account_events D1 PrometheusServed stream).
- `/api/v1/subnets/{netuid}/stake-moves`: fetch stake-movement (re-delegation) activity (distinct movers, StakeMoved event count, average movements per mover) for one subnet over a `?window=7d|30d` — the re-delegation-churn sibling of `subnets/{netuid}/stake-flow` (live from the account_events D1 StakeMoved stream).
- `/api/v1/subnets/{netuid}/registrations`: fetch neuron-registration activity (distinct registrants, NeuronRegistered event count, average registrations per registrant) for one subnet over a `?window=7d|30d` (live from the account_events D1 NeuronRegistered stream).
- `/api/v1/subnets/{netuid}/axon-removals`: fetch axon-removal activity (distinct removers, AxonInfoRemoved event count, average removals per remover) for one subnet over a `?window=7d|30d` (live from the account_events D1 AxonInfoRemoved stream).
- `/api/v1/subnets/{netuid}/deregistrations`: fetch neuron-deregistration activity (distinct deregistered hotkeys, NeuronDeregistered event count, average deregistrations per hotkey) for one subnet over a `?window=7d|30d` (live from the account_events D1 NeuronDeregistered stream).
- `/api/v1/subnets/movers`: fetch the cross-subnet momentum leaderboard (subnets ranked by stake/emission/validator change over a `?window=7d|30d|90d`, `?sort=stake|emission|validators`, `?limit`) (live from the neuron_daily D1 rollup).
- `/api/v1/validators`: fetch the network-wide validator/operator footprint leaderboard (validator identities grouped across current subnet memberships; `?sort=subnet_count|uid_count|avg_validator_trust|max_validator_trust`, `?limit`) (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/uptime`: fetch long-term daily uptime history per operational surface over a 90d/1y window (live from the `surface_uptime_daily` D1 rollup).
- `/api/v1/subnets/{netuid}/metagraph`: fetch the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon); `?validator_permit=true` for validators only (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/neurons/{uid}`: fetch a single neuron's metagraph state by UID (live from the `neurons` D1 tier; 200 with `neuron:null` when cold/absent).
- `/api/v1/subnets/{netuid}/validators`: fetch the validators (validator_permit) ranked by stake (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/yield`: fetch the per-UID emission yield (emission/stake return rate) for one subnet over the current metagraph snapshot, ranked high to low with a distribution summary (subnet aggregate yield, mean, p25/median/p75/p90), a validator/miner split, and a per-UID above/below-median label (live from the `neurons` D1 tier).
- `/api/v1/subnets/{netuid}/yield/history`: fetch the per-day emission-yield distribution trend (subnet-wide return plus the mean/median/p25/p75/p90 of the per-UID emission-per-stake yields) for one subnet over a `?window=7d|30d|90d` — the time-series companion to `yield` and the return-rate twin of `concentration/history` (live from the neuron_daily D1 rollup).
- `/api/v1/subnets/{netuid}/events`: fetch the first-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers) newest first; `?kind=` filter, `?limit` (<=1000) / `?offset` (live from the `account_events` D1 tier filtered by netuid).
- `/api/v1/subnets/{netuid}/event-summary`: fetch a windowed event summary for one subnet — counts by event kind/category, distinct hotkey/coldkey counts, TAO/alpha sums, first/last evidence bounds, plus recent evidence; `?window=7d|30d|90d`, `?limit` <=50 (live from the `account_events` D1 tier).
- `/api/v1/subnets/{netuid}/neurons/{uid}/history`: fetch a UID's per-day metagraph time series over a `?window=7d|30d|90d|1y|all` window (live from the `neuron_daily` D1 rollup).
- `/api/v1/subnets/{netuid}/history`: fetch a subnet's per-day metagraph history over a `?window=7d|30d|90d|1y|all` window (live from the `neuron_daily` D1 rollup).
- `/api/v1/subnets/{netuid}/identity-history`: fetch a subnet's append-only on-chain identity timeline (SubnetIdentitiesV3 snapshots recorded when any tracked field changes), newest first; `?limit` (<=1000) / `?offset`, or `?cursor=` for stable keyset paging (live from the `subnet_identity_history` D1 tier).
- `/api/v1/accounts/{ss58}`: fetch a cross-subnet account summary (chain-event aggregates joined to current registrations + stake) for a hotkey or coldkey (live from the `account_events` + `neurons` D1 tiers).
- `/api/v1/accounts/{ss58}/events`: fetch an account's paginated chain-event history, newest first; `?kind=` filter, `?limit` (<=1000) / `?offset` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/history`: fetch an account's durable per-day activity series (hotkey-keyed, newest day first); `?netuid=` / `?from=` / `?to=` (YYYY-MM-DD) narrow, `?limit` (<=1000) / `?offset` (live from the `account_events_daily` rollup; an ss58 with no hotkey activity returns zero days, since the rollup is hotkey-attributed).
- `/api/v1/accounts/{ss58}/extrinsics`: fetch the extrinsics an account signed (matched by signer), newest first; `?limit` (<=1000) / `?offset` (live from the `extrinsics` D1 tier).
- `/api/v1/accounts/{ss58}/transfers`: fetch the native-TAO Balances.Transfer feed for an account, newest first; `?direction=all|sent|received`, `?limit` (<=1000) / `?offset` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/counterparties`: fetch the per-counterparty fund-flow rollup for an account — transfers aggregated by counterparty into sent/received/net + count, ranked by total volume; `?limit` (<=100) (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/stake-flow`: fetch an account's StakeAdded vs StakeRemoved flow per subnet over a `?window=7d|30d|90d` — per-subnet net/gross flow with a direction label (accumulating/exiting/churning/idle), account totals, an HHI concentration of where the flow is focused, and the dominant subnet (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/registrations`: fetch an account's neuron-registration footprint per subnet over a `?window=7d|30d|90d` — per-subnet NeuronRegistered count with the first/last registration timestamps, account totals, an HHI concentration of where its registration activity is focused, and the dominant subnet — the account-level companion to `chain/registrations` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/serving`: fetch an account's axon-serving footprint per subnet over a `?window=7d|30d|90d` — per-subnet AxonServed announcement count with the first/last announcement timestamps, account totals, an HHI concentration of where its serving activity is focused, and the dominant subnet — the account-level companion to `chain/serving` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/axon-removals`: fetch an account's axon-removal footprint per subnet over a `?window=7d|30d|90d` — per-subnet AxonInfoRemoved count with the first/last removal timestamps, account totals, an HHI concentration of where its teardown activity is focused, and the dominant subnet — the teardown-side complement to `accounts/{ss58}/serving` and the account-level companion to `chain/axon-removals` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/prometheus`: fetch an account's Prometheus-endpoint serving footprint per subnet over a `?window=7d|30d|90d` — per-subnet PrometheusServed announcement count with the first/last announcement timestamps, account totals, an HHI concentration of where its telemetry activity is focused, and the dominant subnet — the telemetry sibling of `accounts/{ss58}/serving` and the account-level companion to `chain/prometheus` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/deregistrations`: fetch an account's neuron-deregistration footprint per subnet over a `?window=7d|30d|90d` — per-subnet NeuronDeregistered eviction count with the first/last eviction timestamps, account totals, an HHI concentration of where its deregistration activity is focused, and the dominant subnet — the eviction-side complement to `accounts/{ss58}/registrations` and the account-level companion to `chain/deregistrations` (live from the `account_events` D1 tier).
- `/api/v1/accounts/{ss58}/subnets`: fetch the subnets where an account's hotkey is currently registered (live from the `neurons` D1 tier).
- `/api/v1/accounts/{ss58}/portfolio`: fetch a wallet's cross-subnet neuron portfolio — per-position economics + yield and wallet-level aggregates (totals, subnet/validator counts, overall return, stake concentration) — live from the `neurons` D1 tier.
- `/api/v1/accounts/{ss58}/balance`: fetch an account's live TAO balance (free + reserved, in TAO), queried from the finney RPC at request time with a 60s KV cache; `balance_tao` is null on RPC failure.
- `/api/v1/blocks`: fetch the recent-block feed (newest first) for the block explorer; `?limit` (<=100) / `?offset` (live from the first-party `blocks` D1 tier).
- `/api/v1/blocks/summary`: fetch block-production analytics over the most recent blocks — inter-block time distribution (count/mean/min/max/p50/p90 ms), extrinsic/event throughput, block-author decentralization (Gini/HHI/Nakamoto/top-share/entropy over each author's block count), and the runtime spec-version spread (live from the first-party `blocks` D1 tier; schema-stable zeroed card when cold).
- `/api/v1/blocks/{ref}`: fetch per-block detail by numeric `block_number` or `0x` `block_hash` (live from the first-party `blocks` D1 tier; 200 with `block:null` when cold/unknown).
- `/api/v1/blocks/{ref}/extrinsics`: fetch the extrinsics in one block by numeric `block_number` or `0x` `block_hash`, natural order; `?limit` (<=100) / `?offset` (live from the first-party `extrinsics` D1 tier; 200 with `extrinsics:[]` when cold/unknown).
- `/api/v1/blocks/{ref}/events`: fetch the decoded chain events in one block by numeric `block_number` or `0x` `block_hash`, natural order; `?limit` (<=1000) / `?offset` (live from the first-party `account_events` D1 tier filtered by block_number; 200 with `events:[]` when cold/unknown).
- `/api/v1/extrinsics`: fetch the recent-extrinsic feed (newest first) for the block explorer; `?limit` (<=100) / `?offset` / optional `?block=<n>` (live from the first-party `extrinsics` D1 tier).
- `/api/v1/extrinsics/{hash}`: fetch per-extrinsic detail by `0x` `extrinsic_hash` (live from the first-party `extrinsics` D1 tier; 200 with `extrinsic:null` when cold/unknown).
- `/api/v1/chain/activity`: fetch daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a `?window=7d|30d`, newest day first (computed live from the first-party chain D1 tiers; schema-stable `day_count:0`/`days:[]` when cold).
- `/api/v1/chain/calls`: fetch the extrinsic call-mix breakdown (count + share per `call_module`, or per `call_module`/`call_function` with `?group_by=module_function`) over a `?window=7d|30d`; `?limit` (<=100) caps the long tail (computed live from the first-party `extrinsics` D1 tier; share denominator is the full-window total).
- `/api/v1/chain/signers`: fetch the windowed most-active-account leaderboard (signers by extrinsic count, with total fees/tips + newest signed block) over a `?window=7d|30d`; `?limit` (<=100) (computed live from the first-party `extrinsics` D1 tier; schema-stable empty when cold).
- `/api/v1/chain/transfers`: fetch network-wide native-TAO transfer analytics over a `?window=7d|30d` — total Balances.Transfer volume + count, distinct senders/receivers, the top senders and receivers by volume (`?limit` <=100), and the top senders' share of total volume (computed live from the `account_events` Transfer feed; schema-stable zeros + empty leaderboards when cold).
- `/api/v1/chain/transfer-pairs`: fetch network-wide directed native-TAO transfer-pair analytics over a `?window=7d|30d` — total pairable Balances.Transfer volume + count, unique sender/receiver pairs, returned pair count, top-pair share, and top sender-to-receiver pairs ranked by `?sort=volume|count` (`?limit` <=100) (computed live from the `account_events` Transfer feed; schema-stable zeros + an empty pairs list when cold).
- `/api/v1/chain/stake-flow`: fetch network-wide cross-subnet capital flow over a `?window=7d|30d` — every subnet that moved stake in the window ranked by net StakeAdded minus StakeRemoved TAO (quiet subnets excluded) (`?limit` <=100), with per-subnet staked/unstaked/net/gross totals + a direction label, a network rollup, and a net-flow distribution (computed live from the `account_events` stake stream; schema-stable zeros + empty leaderboard when cold).
- `/api/v1/chain/weights`: fetch network-wide validator weight-setting activity over a `?window=7d|30d` across the subnets with observed weight-setting activity — a per-subnet leaderboard (distinct weight-setting validators, WeightsSet event count, updates per validator) ranked by total events (`?limit` <=100), a network rollup with the true distinct setter count, and a distribution of per-subnet update intensity (computed live from the `account_events` WeightsSet stream; schema-stable empty block when cold).
- `/api/v1/chain/weights/setters`: fetch the network-wide weight-setter leaderboard over a `?window=7d|30d` — the individual validators driving consensus across every subnet, each with its total WeightsSet count, its share of the network total, and its first/last set time, ranked by activity (`?limit` <=100 caps the returned page; `distinct_setters` always reports the true network-wide total). The network-wide companion to `GET /api/v1/subnets/{netuid}/weights/setters` (computed live from the `account_events` WeightsSet stream; schema-stable empty leaderboard when cold).
- `/api/v1/chain/serving`: fetch network-wide axon-serving announcement activity over a `?window=7d|30d` across the subnets with observed serving activity — a per-subnet leaderboard (AxonServed event count, distinct servers, announcements per server) ranked by total announcements (`?limit` <=100), a network rollup with the true distinct server count, and a distribution of per-subnet re-announcement intensity (computed live from the `account_events` AxonServed stream; schema-stable empty block when cold).
- `/api/v1/chain/prometheus`: fetch network-wide Prometheus-endpoint serving activity over a `?window=7d|30d` across the subnets with observed telemetry activity — a per-subnet leaderboard (PrometheusServed event count, distinct exporters, announcements per exporter) ranked by total announcements (`?limit` <=100), a network rollup with the true distinct exporter count, and a distribution of per-subnet re-announcement intensity — the telemetry-endpoint companion to `chain/serving` (computed live from the `account_events` PrometheusServed stream; schema-stable empty block when cold).
- `/api/v1/chain/axon-removals`: fetch network-wide axon-removal activity over a `?window=7d|30d` across the subnets with observed removal activity — a per-subnet leaderboard (AxonInfoRemoved event count, distinct removers, removals per remover) ranked by total removals (`?limit` <=100), a network rollup with the true distinct remover count, and a distribution of per-subnet re-teardown intensity — the teardown-side companion to `chain/serving` and the network-wide companion to `subnets/{netuid}/axon-removals` (computed live from the `account_events` AxonInfoRemoved stream; schema-stable empty block when cold).
- `/api/v1/chain/registrations`: fetch network-wide neuron-registration activity over a `?window=7d|30d` across the subnets with observed registration activity — a per-subnet leaderboard (NeuronRegistered event count, distinct registrants, registrations per registrant) ranked by total registrations (`?limit` <=100), a network rollup with the true distinct registrant count, and a distribution of per-subnet re-registration intensity (computed live from the `account_events` NeuronRegistered stream; schema-stable empty block when cold).
- `/api/v1/chain/deregistrations`: fetch network-wide neuron-deregistration activity over a `?window=7d|30d` across the subnets with observed deregistration activity — a per-subnet leaderboard (NeuronDeregistered event count, distinct deregistered hotkeys, deregistrations per hotkey) ranked by total deregistrations (`?limit` <=100), a network rollup with the true distinct hotkey count, and a distribution of per-subnet re-deregistration intensity (computed live from the `account_events` NeuronDeregistered stream; schema-stable empty block when cold).
- `/api/v1/chain/stake-moves`: fetch network-wide stake-movement (re-delegation) activity over a `?window=7d|30d` across the subnets with observed movement activity — a per-subnet leaderboard (StakeMoved event count, distinct movers, movements per mover) ranked by total movements (`?limit` <=100), a network rollup with the true distinct mover count, and a distribution of per-subnet re-move intensity — the re-delegation-churn companion to `chain/stake-flow` (computed live from the `account_events` StakeMoved stream; schema-stable empty block when cold).
- `/api/v1/chain/fees`: fetch fee/tip market analytics — a per-UTC-day fee series (totals, averages, and exact ordered-offset medians) plus a `?limit`-capped top-fee-payer list — over a `?window=7d|30d` (computed live from the first-party `extrinsics` D1 tier).
- `/api/v1/chain/concentration`: fetch network-wide stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) aggregated across every subnet's neurons across per-UID, per-entity (coldkeys collapsed across subnets to the true network control distribution), and validator-only consensus-power lenses (computed live from the `neurons` D1 tier; schema-stable nulls when cold).
- `/api/v1/chain/performance`: fetch network-wide reward-distribution & score-spread metrics aggregated across every subnet's neurons — reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores (computed live from the `neurons` D1 tier; schema-stable nulls when cold).
- `/api/v1/chain/identity-history`: fetch the network-wide recent subnet-identity-change feed (newest first) aggregated across every subnet — the most-recent SubnetIdentitiesV3 changes, each carrying the `netuid` it belongs to plus the same tracked identity fields as the per-subnet identity-history route; `?limit` (default 50, max 200) caps the feed and `subnet_count` reports the distinct subnets it spans (computed live from the `subnet_identity_history` D1 tier; schema-stable empty feed when cold).
- `/api/v1/chain/yield`: fetch network-wide emission-yield (return rate) aggregated across every subnet's neurons — the aggregate network return (total emission / total stake), the same split by validator vs miner role, and the count/mean/median/min/max plus p10–p90 spread of the per-neuron emission/stake return (computed live from the `neurons` D1 tier; schema-stable nulls when cold).
- `/api/v1/chain/turnover`: fetch network-wide validator-set turnover across every subnet between a window's boundary `neuron_daily` snapshots — a per-subnet leaderboard (validators entered/exited, Jaccard retention, 0-100 stability score) ranked by gross churn, plus a network rollup over the union validator set (`window=7d|30d|90d`, `limit` up to 100; computed live from the `neuron_daily` D1 rollup; schema-stable zeros when cold).
- `/api/v1/chain-events`: fetch the recent all-events feed (newest first) — every raw pallet.method event from the Postgres-backed all-events tier (ADR 0013). `?pallet`/`?method` narrow by event id (`?method` requires `?pallet` unless `?block` is set); `?block` (+ optional `?extrinsic`) scopes to one block/extrinsic; `?before` is a `block_number` keyset cursor; `?limit` (<=200, default 50). Served live by the data Worker; empty before the all-events backfill runs.
- `/api/v1/chain-events/stats`: fetch the chain-activity aggregate — the pallet.method event distribution over the most recent N blocks (`?blocks` default 1000, capped 5000) — from the Postgres-backed all-events tier (ADR 0013). Backs the `get_chain_activity` MCP tool.
- `/api/v1/blocks/{ref}/chain-events`: fetch every raw pallet-level event in one block (by numeric `block_number`, `event_index` ascending) from the Postgres-backed all-events tier (ADR 0013). Distinct from `/api/v1/blocks/{ref}/events` (the curated account-attributed stream).
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
- `/api/v1/economics`: list per-subnet validator/economic metrics, default ordered by emission share descending. Sort with `sort=<field>&order=asc|desc` — two separate params (e.g. `?sort=total_stake_tao&order=desc`), not a combined `field:desc` token.
- `/api/v1/economics/trends`: fetch the network-wide economics time series (per UTC day across all subnets: total stake, stake-weighted + median alpha price, total validator/miner counts, mean emission share) over a `?window=7d|30d|90d|1y|all` (default 30d), aggregated live from the daily `subnet_snapshots` D1 rollup; schema-stable `day_count:0`/`days:[]` when cold.
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
- `/api/v1/search-index`: fetch the slim search index — the same documents as `/api/v1/search` without the per-document token blobs, for fast browser typeahead and listing.
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
- `npm run subnet:new`: scaffold a missing subnet manifest before adding its
  first surface in the same file.
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
