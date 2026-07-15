import {
  GraphQLError,
  buildSchema,
  execute,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import { readArtifact, readHealthKv } from "../workers/storage.mjs";
import { contractVersion } from "../workers/responses.mjs";
import { tryPostgresTier } from "../workers/postgres-tier.mjs";
import {
  buildSubnetRegistrations,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "./subnet-registrations.mjs";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "./subnet-deregistrations.mjs";
import {
  buildSubnetServing,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "./subnet-serving.mjs";
import {
  buildSubnetAxonRemovals,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "./subnet-axon-removals.mjs";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "./subnet-weights.mjs";
import { buildSubnetYield } from "./subnet-yield.mjs";
import { buildSubnetPerformance } from "./subnet-performance.mjs";
import {
  analyticsWindow,
  loadGlobalIncidentsLedger,
} from "../workers/request-handlers/analytics.mjs";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import { loadSubnetIdentityHistory } from "./subnet-identity-history.mjs";
import {
  buildGlobalHealth,
  formatLeaderboards,
  resolveLiveEconomics,
  resolveLiveHealth,
  subnetBadgeStatus,
} from "./health-serving.mjs";
import {
  loadCompareSubnets,
  parseCompareDimensionList,
  parseCompareNetuidList,
} from "./analytics-live.mjs";
import { buildExtrinsic, buildExtrinsicFeed } from "./extrinsics.mjs";
import { buildBlock, buildBlockFeed } from "./blocks.mjs";
import { buildBlocksSummary } from "./blocks-summary.mjs";
import { buildChainYield } from "./chain-yield.mjs";
import { loadSubnetRecycled, isU16Netuid } from "./subnet-recycled.mjs";
import {
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  GLOBAL_VALIDATOR_SORTS,
  buildGlobalValidators,
  buildValidatorDetail,
  overlayFeaturedValidators,
} from "./metagraph-neurons.mjs";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  ACCOUNTS_LIST_SORTS,
  DEFAULT_ACCOUNTS_LIST_SORT,
  buildAccountsList,
} from "./accounts-list.mjs";
import { buildAccountSummary } from "./account-events.mjs";
import {
  DEFAULT_PROMETHEUS_WINDOW,
  PROMETHEUS_WINDOWS,
  buildAccountPrometheus,
} from "./account-prometheus.mjs";
import {
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_FLOW_WINDOWS,
  buildAccountStakeFlow,
} from "./account-stake-flow.mjs";
import {
  DEFAULT_STAKE_FLOW_DIRECTION,
  STAKE_FLOW_DIRECTIONS,
} from "./stake-flow.mjs";
import {
  buildAccountRegistrations,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "./account-registrations.mjs";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "./account-deregistrations.mjs";
import {
  buildAccountServing,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "./account-serving.mjs";
import {
  buildAccountAxonRemovals,
  AXON_REMOVAL_WINDOWS,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "./account-axon-removals.mjs";
import {
  buildAccountStakeMoves,
  ACCOUNT_STAKE_MOVES_WINDOWS,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "./account-stake-moves.mjs";
import { KV_HEALTH_META } from "./kv-keys.mjs";
import { SS58_ADDRESS_PATTERN } from "../workers/config.mjs";
import {
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "./neuron-history.mjs";
import { buildValidatorHistory } from "./validator-history.mjs";
import { loadEconomicsTrends } from "./economics-trends.mjs";
import {
  DEFAULT_MOVERS_SORT,
  DEFAULT_MOVERS_WINDOW,
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
  MOVERS_SORTS,
  MOVERS_WINDOWS,
  buildMovers,
} from "./movers.mjs";
import {
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
  CHAIN_WEIGHTS_LIMIT_MAX,
  CHAIN_WEIGHTS_WINDOWS,
  DEFAULT_CHAIN_WEIGHTS_WINDOW,
  loadChainWeights,
} from "./chain-weights.mjs";
import {
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
  CHAIN_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW,
  loadChainWeightSetters,
} from "./chain-weight-setters.mjs";
import { loadBulkHealthTrends } from "./bulk-health-trends.mjs";

export const GRAPHQL_MAX_DEPTH = 7;
export const GRAPHQL_MAX_COMPLEXITY = 50;
export const GRAPHQL_MAX_BODY_BYTES = 64 * 1024;
export const GRAPHQL_MAX_QUERY_BYTES = 16 * 1024;

// The read-only registry graph. Field names mirror the artifact JSON keys
// (snake_case) so the graphql-js default field resolver reads them straight off
// the artifact rows — relationship fields (the ones that resolve a *fresh*
// artifact and so cost a read / fan out per parent) are the only ones backed by
// explicit resolver thunks, and each carries a complexity weight below.
export const SDL = `
  "Opaque JSON value, for dynamic-keyed maps with no fixed field set (e.g. the incident summary's by_kind/by_provider/by_status count maps) -- matching how the MCP mirror serves them."
  scalar JSON

  type Query {
    "Paginated active-subnet index."
    subnets(limit: Int, cursor: String): SubnetList!
    "One subnet with its health, surfaces, endpoints, and economics."
    subnet(netuid: Int!): Subnet
    "Per-subnet neuron-registration activity over a 7d/30d window (distinct registrants, NeuronRegistered count, and registrations per registrant); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/registrations."
    subnet_registrations(netuid: Int!, window: String): SubnetRegistrations!
    "Per-subnet neuron-deregistration activity over a 7d/30d window (distinct deregistered hotkeys, NeuronDeregistered count, and deregistrations per hotkey); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/deregistrations."
    subnet_deregistrations(netuid: Int!, window: String): SubnetDeregistrations!
    "Per-subnet axon-serving activity over a 7d/30d window (distinct servers, AxonServed announcement count, and announcements per server); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/serving."
    subnet_serving(netuid: Int!, window: String): SubnetServing!
    "Per-subnet axon-removal activity over a 7d/30d window (distinct removers, AxonInfoRemoved count, and removals per remover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/axon-removals."
    subnet_axon_removals(netuid: Int!, window: String): SubnetAxonRemovals!
    "Per-subnet validator weight-setting activity over a 7d/30d window (distinct weight-setters, WeightsSet count, and sets per setter); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/weights."
    subnet_weights(netuid: Int!, window: String): SubnetWeights!
    "Per-subnet emission-per-stake yield over the current metagraph snapshot: each UID's yield plus the subnet-wide aggregate and p25/median/p75/p90 distribution; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/yield."
    subnet_yield(netuid: Int!): SubnetYield!
    "Per-subnet reward-distribution and score-spread card over the current neurons snapshot: incentive/dividends concentration plus p10–p90 trust/consensus/validator_trust; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/performance."
    subnet_performance(netuid: Int!): SubnetPerformance!
    "Append-only on-chain SubnetIdentitiesV3 change timeline for one subnet (name, symbol, description, repo, website, discord, logo), newest first; page with limit/offset or follow next_cursor. A subnet with no matching events resolves to a schema-stable empty timeline (entry_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/identity-history."
    subnet_identity_history(netuid: Int!, limit: Int, offset: Int, cursor: String): SubnetIdentityHistory!
    "Paginated provider/source registry."
    providers(limit: Int, cursor: String): ProviderList!
    "One provider with its subnets."
    provider(id: String!): Provider
    "Paginated per-subnet economic + validator metrics."
    economics(limit: Int, cursor: String): EconomicsList!
    "Curated public interface surfaces, optionally scoped to one subnet."
    surfaces(netuid: Int, limit: Int, cursor: String): SurfaceList!
    "Endpoint/resource registry, optionally scoped to one subnet."
    endpoints(netuid: Int, limit: Int, cursor: String): EndpointList!
    "Global operational health rollup with per-subnet summaries."
    health: GlobalHealth
    "Cross-subnet economic opportunity boards (where to register, what it costs, where the emission and validator headroom are)."
    opportunity_boards(limit: Int): OpportunityBoards!
    "Cross-subnet comparison: registry structure, live economics, and live health placed side by side for the requested netuids, in requested order. Mirrors GET /api/v1/compare."
    compare(netuids: [Int!]!, dimensions: [String!]): Compare!
    "Global endpoint-incident ledger over a 7d/30d window; degrades to a schema-stable empty ledger (never a GraphQL error) on a cold/retired health tier. Mirrors GET /api/v1/incidents."
    incidents(window: String): GlobalIncidents!
    "Recent-extrinsic feed (newest first), optionally filtered. Mirrors GET /api/v1/extrinsics."
    extrinsics(limit: Int, offset: Int, cursor: String, block: Int, signer: String, call_module: String, call_function: String, success: Boolean): ExtrinsicList!
    "One extrinsic by hash or composite block_number-extrinsic_index ref; extrinsic is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/extrinsics/{ref}."
    extrinsic(ref: String!): ExtrinsicDetail
    "Recent-block feed (newest first). Mirrors GET /api/v1/blocks."
    blocks(limit: Int, offset: Int, cursor: String): BlockList!
    "One block by numeric height or 0x block hash; block is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/{ref}."
    block(ref: String!): BlockDetail
    "Block-production summary over the recent-block window -- counts, inter-block timing, throughput, and author-concentration. Every aggregate is null (never a GraphQL error) when the retired-D1 store is cold. Mirrors GET /api/v1/blocks/summary."
    blocks_summary: BlocksSummary!
    "Network-wide validator/operator leaderboard, grouped by hotkey across every subnet it operates in. Mirrors GET /api/v1/validators."
    validators(sort: String, limit: Int): ValidatorList!
    "One validator's cross-subnet aggregate by hotkey; a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null. Mirrors GET /api/v1/validators/{hotkey}."
    validator(hotkey: String!): Validator
    "One validator's cross-subnet staked-over-time history: one point per day (window: 7d/30d/90d/1y/all, default 30d), summed across every subnet it validates in, plus a rewards-per-1000-TAO rate. A hotkey with no matching neuron_daily rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/validators/{hotkey}/history."
    validator_history(hotkey: String!, window: String): ValidatorHistory!
    "Site-wide accounts leaderboard -- every currently-registered hotkey, aggregated cross-subnet from the current neurons snapshot. Mirrors GET /api/v1/accounts."
    accounts(sort: String, limit: Int): AccountList!
    "One account's cross-subnet event-history summary by ss58 address; an address with no matching account_events rows resolves to a schema-stable zero summary, never null. Mirrors GET /api/v1/accounts/{ss58}."
    account(ss58: String!): AccountSummary
    "One account's Prometheus telemetry-serving footprint across subnets over a 7d/30d/90d window (default 30d) -- which subnets it announces a Prometheus endpoint on, how often, first/last announcement times, and an HHI concentration of where that activity is focused. An address with no matching announcements resolves to a schema-stable zeroed footprint, never null. Mirrors GET /api/v1/accounts/{ss58}/prometheus."
    account_prometheus(ss58: String!, window: String): AccountPrometheus!
    "One account's per-subnet registration footprint over a 7d/30d/90d window (default 30d): NeuronRegistered count and first/last timestamps per subnet, an HHI concentration of where its registration activity is focused, and the dominant subnet; an address with no registrations in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/registrations."
    account_registrations(ss58: String!, window: String): AccountRegistrations!
    "One account's per-subnet deregistration footprint over a 7d/30d/90d window (default 30d): NeuronDeregistered count and first/last timestamps per subnet, an HHI concentration of where its deregistration activity is focused, and the dominant subnet; an address with no deregistrations in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/deregistrations."
    account_deregistrations(ss58: String!, window: String): AccountDeregistrations!
    "One account's StakeAdded/StakeRemoved flow per subnet over a 7d/30d/90d window (default 30d) -- net + gross flow, a direction label (accumulating/exiting/churning/idle), and an HHI concentration of where its flow is focused. direction narrows to inflow (in) or outflow (out) only; all (default) reports both sides. An address with no flow in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-flow."
    account_stake_flow(ss58: String!, window: String, direction: String): AccountStakeFlow!
    "One account's per-subnet axon-serving footprint over a 7d/30d/90d window (default 30d): AxonServed announcement count and first/last timestamps per subnet, an HHI concentration of where its serving activity is focused, and the dominant subnet; an address with no announcements in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/serving."
    account_serving(ss58: String!, window: String): AccountServing!
    "One account's per-subnet axon-removal footprint over a 7d/30d/90d window (default 30d): AxonInfoRemoved count and first/last timestamps per subnet, an HHI concentration of where its teardown activity is focused, and the dominant subnet; an address with no removals in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/axon-removals."
    account_axon_removals(ss58: String!, window: String): AccountAxonRemovals!
    "One account's per-subnet StakeMoved footprint over a 7d/30d/90d window (default 30d): movement count, first/last timestamps, and the alpha price (TAO) at its most recent move per subnet, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet; an address with no moves in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-moves."
    account_stake_moves(ss58: String!, window: String): AccountStakeMoves!
    "Network-wide economics time series, aggregated per UTC day across all subnets; day_count is 0 and days is empty on a cold rollup, never null. Mirrors GET /api/v1/economics/trends."
    economics_trends(window: String): EconomicsTrends!
    "Cross-subnet momentum leaderboard: every subnet ranked by its stake/emission/validator change between a window's start and end snapshots; movers is empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/subnets/movers."
    subnet_movers(window: String, sort: String, limit: Int): SubnetMovers!
    "Network-wide validator weight-setting activity leaderboard over a 7d/30d window (default 7d): subnets ranked by WeightsSet events with each's distinct-setter count and sets-per-setter update intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. Mirrors GET /api/v1/chain/weights."
    chain_weights(window: String, limit: Int): ChainWeights!
    "Network-wide weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators driving consensus network-wide, each with its total WeightsSet count, share of the network total, and first/last set times, ranked by activity. The setter-level drill-in behind chain_weights. Mirrors GET /api/v1/chain/weights/setters."
    chain_weight_setters(window: String, limit: Int): ChainWeightSetters!
    "Compact all-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history (probed every ~15 minutes); a cold store still returns both windows, schema-stable and zeroed, never a GraphQL error. Mirrors GET /api/v1/health/trends."
    health_trends: HealthTrends!
    "Network-wide emission-yield (return rate) aggregated across every subnet's neurons -- the aggregate network return, the same split by validator vs miner role, and the distribution of the per-neuron return rate. Every aggregate is null (never a GraphQL error) on a cold store. Mirrors GET /api/v1/chain/yield."
    chain_yield: ChainYield!
    "Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC (not the Postgres tier). recycled_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/recycled."
    subnet_recycled(netuid: Int!): SubnetRecycled
  }

  type SubnetList {
    items: [Subnet!]!
    total: Int!
    next_cursor: String
  }

  type Subnet {
    netuid: Int!
    name: String
    slug: String
    description: String
    categories: [String!]
    status: String
    subnet_type: String
    lifecycle: String
    coverage_level: String
    curation_level: String
    integration_readiness: Int
    surface_count: Int
    official_surface_count: Int
    probed_surface_count: Int
    gap_count: Int
    first_party: Boolean
    symbol: String
    logo_url: String
    website_url: String
    docs_url: String
    "Live operational health summary for this subnet."
    health: SubnetHealth
    "Per-subnet economic + validator metrics."
    economics: SubnetEconomics
    "Curated public interface surfaces of this subnet."
    surfaces: [Surface!]!
    "Endpoint/resource registry rows for this subnet."
    endpoints: [Endpoint!]!
  }

  type ProviderList {
    items: [Provider!]!
    total: Int!
    next_cursor: String
  }

  type Provider {
    id: String!
    name: String
    kind: String
    authority: String
    docs_url: String
    github_url: String
    website_url: String
    contact_url: String
    logo_url: String
    notes: String
    public_notes: String
    endpoint_count: Int
    surface_count: Int
    subnet_count: Int
    netuids: [Int]!
    "The subnets this provider operates surfaces on."
    subnets: [Subnet!]!
  }

  type EconomicsList {
    subnets: [SubnetEconomics!]!
    total: Int!
    next_cursor: String
  }

  type SubnetEconomics {
    netuid: Int!
    name: String
    slug: String
    emission_share: Float
    alpha_price_tao: Float
    alpha_market_cap_tao: Float
    alpha_fdv_tao: Float
    registration_allowed: Boolean
    registration_cost_tao: Float
    open_slots: Int
    max_uids: Int
    miner_count: Int
    miner_readiness: Int
    validator_count: Int
    max_validators: Int
    total_stake_tao: Float
    max_stake_tao: Float
    subnet_volume_tao: Float
    tao_in_pool_tao: Float
    alpha_in_pool: Float
    alpha_out_pool: Float
    owner_coldkey: String
    owner_hotkey: String
  }

  type EconomicsTrends {
    schema_version: Int!
    window: String
    day_count: Int!
    days: [EconomicsTrendsDay!]!
  }

  "One UTC day of network-wide economics aggregated across every subnet with a snapshot that day. Sums are null only when no subnet reported a value that day."
  type EconomicsTrendsDay {
    snapshot_date: String!
    subnet_count: Int!
    "Lossless fixed 9-decimal (rao-precision) TAO string, summed across every subnet reporting that day -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float."
    total_stake_tao: String
    alpha_price_tao_weighted: Float
    alpha_price_tao_median: Float
    validator_count: Int
    miner_count: Int
    mean_emission_share: Float
  }

  type SubnetMovers {
    schema_version: Int!
    window: String
    start_date: String
    end_date: String
    sort: String!
    subnet_count: Int!
    network: SubnetMoversNetwork!
    movers: [SubnetMover!]!
  }

  "Network-wide boundary totals for the movers window, summed across every ranked subnet (not just the returned page)."
  type SubnetMoversNetwork {
    "Lossless fixed 9-decimal (rao-precision) TAO string -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float."
    total_stake_start_tao: String!
    total_stake_end_tao: String!
    total_stake_delta_tao: String!
    total_emission_start_tao: String!
    total_emission_end_tao: String!
    total_emission_delta_tao: String!
    total_validators_start: Int!
    total_validators_end: Int!
    total_validators_delta: Int!
    gainers: Int!
    losers: Int!
    unchanged: Int!
  }

  "One subnet's stake/emission/validator/neuron movement between the window's start and end snapshots."
  type SubnetMover {
    netuid: Int!
    stake_start_tao: Float!
    stake_end_tao: Float!
    stake_delta_tao: Float!
    "Null when the start snapshot's stake was 0 (growth from nothing is undefined)."
    stake_pct_change: Float
    "This subnet's share of network stake at the end snapshot; null when the network total is 0."
    stake_share_pct: Float
    emission_start_tao: Float!
    emission_end_tao: Float!
    emission_delta_tao: Float!
    emission_pct_change: Float
    emission_share_pct: Float
    validators_start: Int!
    validators_end: Int!
    validators_delta: Int!
    neurons_start: Int!
    neurons_end: Int!
    neurons_delta: Int!
  }

  "Network-wide validator weight-setting activity over a lookback window, summed live from the account_events WeightsSet stream. Mirrors GET /api/v1/chain/weights."
  type ChainWeights {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainWeightsNetwork!
    intensity_distribution: ChainWeightsIntensityDistribution
    subnets: [ChainWeightsSubnet!]!
  }

  "Network-wide weight-setting rollup: every subnet that set weights in the window, combined."
  type ChainWeightsNetwork {
    distinct_setters: Int!
    weight_sets: Int!
    "Null when distinct_setters is 0 (no defined intensity without setters)."
    sets_per_setter: Float
  }

  "Spread of per-subnet update intensity (WeightsSet events per validator) across every subnet that set weights in the window."
  type ChainWeightsIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's weight-setting activity in the window, ranked by weight_sets."
  type ChainWeightsSubnet {
    netuid: Int!
    distinct_setters: Int!
    weight_sets: Int!
    sets_per_setter: Float
  }

  "Network-wide weight-setter leaderboard over a lookback window, summed live from the account_events WeightsSet stream. The setter-level drill-in behind ChainWeights. Mirrors GET /api/v1/chain/weights/setters."
  type ChainWeightSetters {
    schema_version: Int!
    window: String
    observed_at: String
    distinct_setters: Int!
    weight_sets: Int!
    setter_count: Int!
    setters: [ChainWeightSetter!]!
  }

  "One validator's network-wide weight-setting activity in the window. netuid is set only when hotkey is null (a uid-only identity has no meaning outside its own subnet)."
  type ChainWeightSetter {
    hotkey: String
    netuid: Int
    uid: Int
    weight_sets: Int!
    "This setter's share of the network total weight_sets; null when the network total is 0."
    share: Float
    first_set_at: String
    last_set_at: String
  }

  "All-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history. Mirrors GET /api/v1/health/trends' data envelope."
  type HealthTrends {
    schema_version: Int!
    observed_at: String
    source: String
    "The 7d/30d windows keyed by window label (7d, 30d), each holding days/granularity/subnet_count and the per-subnet daily point series. Opaque JSON: dynamic-keyed by window label, matching the get_health_trends MCP/REST shape."
    windows: JSON!
  }

  type SurfaceList {
    items: [Surface!]!
    total: Int!
    next_cursor: String
  }

  type Surface {
    id: String!
    key: String
    netuid: Int
    name: String
    kind: String
    status: String
    classification: String
    authority: String
    provider: String
    url: String
    auth_required: Boolean
    public_safe: Boolean
    schema_status: String
    schema_url: String
    last_verified_at: String
    stale: Boolean
    subnet_name: String
    subnet_slug: String
    source_urls: [String!]
    notes: String
  }

  type EndpointList {
    items: [Endpoint!]!
    total: Int!
    next_cursor: String
  }

  type Endpoint {
    id: String!
    surface_id: String
    surface_key: String
    netuid: Int
    kind: String
    layer: String
    network: String
    status: String
    classification: String
    authority: String
    provider: String
    operator: String
    url: String
    auth_required: Boolean
    public_safe: Boolean
    latency_ms: Int
    latest_block: Int
    last_checked: String
    last_ok: String
    health_source: String
    score: Int
    pool_eligible: Boolean
    monitoring_status: String
    subnet_name: String
    subnet_slug: String
    source_urls: [String!]
  }

  type GlobalHealth {
    status: String
    surface_count: Int
    ok_count: Int
    degraded_count: Int
    failed_count: Int
    unknown_count: Int
    avg_latency_ms: Int
    latency_sample_count: Int
    last_checked: String
    last_ok: String
    generated_at: String
    operational_observed_at: String
    health_source: String
    scope: String
    subnets: [SubnetHealth!]!
  }

  type SubnetHealth {
    netuid: Int
    name: String
    slug: String
    status: String
    surface_count: Int
    ok_count: Int
    degraded_count: Int
    failed_count: Int
    unknown_count: Int
    avg_latency_ms: Int
    latency_sample_count: Int
    last_checked: String
    last_ok: String
  }

  type OpportunityBoards {
    observed_at: String
    with_economics_count: Int!
    open_slots: [OpportunityEntry!]!
    cheapest_registration: [OpportunityEntry!]!
    highest_emission: [OpportunityEntry!]!
    validator_headroom: [OpportunityEntry!]!
  }

  type OpportunityEntry {
    netuid: Int!
    slug: String
    name: String
    open_slots: Int
    max_uids: Int
    registration_cost_tao: Float
    registration_allowed: Boolean
    emission_share: Float
    total_stake_tao: Float
    validator_count: Int
    miner_count: Int
    validator_headroom: Int
    max_validators: Int
  }

  type Compare {
    schema_version: Int!
    source: String
    observed_at: String
    dimensions: [String!]!
    requested_netuids: [Int!]!
    subnets: [CompareSubnet!]!
  }

  type CompareSubnet {
    netuid: Int!
    name: String
    slug: String
    found: Boolean!
    structure: CompareStructure
    economics: CompareEconomics
    health: CompareHealth
  }

  type CompareStructure {
    completeness_score: Float
    surface_count: Int
    operational_interface_count: Int
  }

  type CompareEconomics {
    registration_cost_tao: Float
    registration_allowed: Boolean
    open_slots: Int
    emission_share: Float
    alpha_price_tao: Float
    validator_count: Int
    miner_count: Int
    total_stake_tao: Float
    miner_readiness: Int
  }

  type CompareHealth {
    surface_count: Int
    ok_count: Int
    avg_latency_ms: Int
  }

  "Append-only on-chain subnet identity timeline (#1647 / #5721). Empty entries on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/identity-history."
  type SubnetIdentityHistory {
    schema_version: Int!
    netuid: Int!
    entry_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    entries: [SubnetIdentityHistoryEntry!]!
  }

  "One SubnetIdentitiesV3 snapshot recorded when a tracked identity field changed."
  type SubnetIdentityHistoryEntry {
    block_number: Int
    observed_at: String
    subnet_name: String
    symbol: String
    description: String
    github_repo: String
    subnet_url: String
    discord: String
    logo_url: String
    identity_hash: String
  }

  "Per-subnet neuron-registration activity over a window (#5720). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/registrations."
  type SubnetRegistrations {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_registrants: Int!
    registrations: Int!
    registrations_per_registrant: Float
  }

  "Per-subnet neuron-deregistration activity over a window (#5719). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/deregistrations."
  type SubnetDeregistrations {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_deregistered_hotkeys: Int!
    deregistrations: Int!
    deregistrations_per_hotkey: Float
  }

  type SubnetServing {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_servers: Int!
    announcements: Int!
    announcements_per_server: Float
  }

  type SubnetAxonRemovals {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_removers: Int!
    removals: Int!
    removals_per_remover: Float
  }

  type SubnetWeights {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_setters: Int!
    weight_sets: Int!
    sets_per_setter: Float
  }

  "One UID's emission-per-stake yield within a subnet's current metagraph snapshot."
  type SubnetYieldNeuron {
    uid: Int!
    hotkey: String
    role: String!
    stake_tao: Float
    emission_tao: Float
    yield: Float
  }

  type SubnetYield {
    schema_version: Int!
    netuid: Int!
    captured_at: String
    block_number: Int
    neuron_count: Int!
    validator_count: Int!
    miner_count: Int!
    total_stake_tao: Float
    total_emission_tao: Float
    subnet_yield: Float
    mean_yield: Float
    median_yield: Float
    p25_yield: Float
    p75_yield: Float
    p90_yield: Float
    neurons: [SubnetYieldNeuron!]!
  }

  "0..1 score column spread (count/mean/min/max plus nearest-rank percentiles). Null when no neuron carries a finite value."
  type ScoreDistribution {
    count: Int!
    mean: Float
    min: Float
    max: Float
    p10: Float
    p25: Float
    p50: Float
    p75: Float
    p90: Float
  }

  "Per-subnet reward-distribution & score-spread card (#5714). Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/performance."
  type SubnetPerformance {
    schema_version: Int!
    netuid: Int!
    neuron_count: Int!
    validator_count: Int!
    active_count: Int!
    captured_at: String
    "Incentive concentration across all neurons with positive incentive."
    incentive: ConcentrationMetrics
    "Dividends concentration across permitted validators only."
    dividends: ConcentrationMetrics
    "Trust score spread across all neurons."
    trust: ScoreDistribution
    "Consensus score spread across all neurons."
    consensus: ScoreDistribution
    "Validator-trust score spread across permitted validators only."
    validator_trust: ScoreDistribution
  }

  "Global endpoint-incident ledger (#5660). Mirrors GET /api/v1/incidents' data envelope."
  type GlobalIncidents {
    schema_version: Int!
    window: String
    observed_at: String
    source: String
    "Aggregate counts -- incident_count, active_count, and by_kind/by_layer/by_provider/by_severity/by_status maps. Opaque JSON: the by_* maps are dynamic-keyed, matching the MCP get_global_incidents summary shape."
    summary: JSON
    surfaces: [EndpointIncident!]!
  }

  "One endpoint incident in the global ledger. Mirrors the REST EndpointIncident shape (enum-valued fields carried as their string values)."
  type EndpointIncident {
    id: String
    endpoint_id: String
    state: String
    severity: String
    status: String
    reason: String
    kind: String
    layer: String
    classification: String
    netuid: Int
    provider: String
    operator: String
    subnet_name: String
    subnet_slug: String
    surface_id: String
    surface_key: String
    detected_at: String
    last_checked: String
    last_ok: String
    observed_at: String
    health_stale: Boolean
    health_source: String
    pool_eligible: Boolean
    user_reported: Boolean
  }

  type ExtrinsicList {
    items: [Extrinsic!]!
    "Page count -- this feed has no cheap grand total, matching REST's extrinsic_count."
    total: Int!
    next_cursor: String
  }

  type Extrinsic {
    block_number: Int
    extrinsic_index: Int
    extrinsic_hash: String
    signer: String
    call_module: String
    call_function: String
    "JSON-encoded decoded call arguments."
    call_args: String
    success: Boolean
    fee_tao: Float
    tip_tao: Float
    observed_at: String
  }

  type ExtrinsicDetail {
    ref: String
    extrinsic: Extrinsic
  }

  type BlockList {
    items: [Block!]!
    "Page count -- this feed has no cheap grand total, matching REST's block_count."
    total: Int!
    next_cursor: String
  }

  type Block {
    block_number: Int
    block_hash: String
    parent_hash: String
    author: String
    extrinsic_count: Int
    event_count: Int
    spec_version: Int
    observed_at: String
  }

  "Network-wide emission-yield (return rate) card across every subnet's neurons. Aggregates are null on a cold store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/chain/yield."
  type ChainYield {
    schema_version: Int!
    subnet_count: Int!
    neuron_count: Int!
    validator_count: Int!
    miner_count: Int!
    captured_at: String
    total_stake_tao: Float!
    total_emission_tao: Float!
    network_yield: Float
    validator_yield: Float
    miner_yield: Float
    distribution: YieldDistribution
  }

  "Distribution of the per-neuron emission/stake return rate across the network."
  type YieldDistribution {
    count: Int!
    mean: Float!
    median: Float!
    min: Float!
    max: Float!
    p10: Float!
    p25: Float!
    p75: Float!
    p90: Float!
  }

  "Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC. recycled_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/subnets/{netuid}/recycled."
  type SubnetRecycled {
    schema_version: Int!
    netuid: Int!
    recycled_tao: Float
    queried_at: String!
  }

  "Block-production summary (#5664) over the recent-block window. Every aggregate is null on a cold retired-D1 store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/summary."
  type BlocksSummary {
    schema_version: Int!
    block_count: Int!
    first_block: Int
    last_block: Int
    first_observed_at: String
    last_observed_at: String
    block_time: BlockTimeDistribution
    throughput: BlocksThroughput
    distinct_authors: Int!
    author_concentration: ConcentrationMetrics
    distinct_spec_versions: Int!
    latest_spec_version: Int
  }

  "Inter-block interval distribution in milliseconds, over genuinely consecutive in-window blocks."
  type BlockTimeDistribution {
    count: Int!
    mean_ms: Float
    min_ms: Float
    max_ms: Float
    p50_ms: Float
    p90_ms: Float
  }

  "Extrinsic/event throughput across the summarized block window."
  type BlocksThroughput {
    total_extrinsics: Int!
    total_events: Int!
    mean_extrinsics_per_block: Float
    mean_events_per_block: Float
    max_extrinsics_in_block: Int!
  }

  "Concentration metrics over a value distribution -- Gini, HHI (raw + holder-count-normalized), Nakamoto coefficient, top-percentile shares, and Shannon entropy."
  type ConcentrationMetrics {
    holders: Int!
    total: Float
    gini: Float
    hhi: Float
    hhi_normalized: Float
    nakamoto_coefficient: Int
    top_1pct_share: Float
    top_5pct_share: Float
    top_10pct_share: Float
    top_20pct_share: Float
    entropy: Float
    entropy_normalized: Float
  }

  type BlockDetail {
    ref: String
    block: Block
    "Nearest STORED lower block height for chain-walk nav (detail only); null at the start of the retained window or when the ref didn't resolve."
    prev_block_number: Int
    "Nearest STORED higher block height for chain-walk nav (detail only); null at the head of the retained window or when the ref didn't resolve."
    next_block_number: Int
  }

  type ValidatorList {
    items: [Validator!]!
    total: Int!
    sort: String!
    captured_at: String
    block_number: Int
  }

  type Validator {
    hotkey: String!
    featured: Boolean!
    coldkey: String
    coldkey_identity: Identity
    coldkey_count: Int
    subnet_count: Int
    uid_count: Int
    take: Float
    total_stake_tao: Float
    root_stake_tao: Float
    alpha_stake_tao: Float
    total_emission_tao: Float
    nominator_count: Int
    apy_estimate: Float
    apy_estimate_eligible_subnet_count: Int
    avg_validator_trust: Float
    max_validator_trust: Float
    captured_at: String
    block_number: Int
    "Per-subnet membership rows for this validator. The global leaderboard entry caps this at the top 10 by stake; the single-validator lookup carries every subnet."
    subnets: [ValidatorSubnet!]!
  }

  "One validator's cross-subnet staked-over-time history. Mirrors GET /api/v1/validators/{hotkey}/history."
  type ValidatorHistory {
    schema_version: Int!
    hotkey: String!
    window: String
    point_count: Int!
    points: [ValidatorHistoryPoint!]!
  }

  "One day's cross-subnet rollup for a validator hotkey, summed across every subnet it validates in that day."
  type ValidatorHistoryPoint {
    snapshot_date: String!
    subnet_count: Int
    total_stake_tao: Float
    total_emission_tao: Float
    rewards_per_1000_tao: Float
  }

  type ValidatorSubnet {
    netuid: Int!
    uid: Int
    stake_tao: Float
    emission_tao: Float
    validator_trust: Float
  }

  "Self-reported on-chain identity (SubtensorModule::set_identity) for a coldkey."
  type Identity {
    has_identity: Boolean!
    name: String
    url: String
    github: String
    image: String
    discord: String
    description: String
    additional: String
    captured_at: String
  }

  type AccountList {
    items: [AccountEntry!]!
    total: Int!
    sort: String!
    captured_at: String
    block_number: Int
  }

  type AccountEntry {
    hotkey: String!
    coldkey: String
    coldkey_count: Int
    subnet_count: Int
    uid_count: Int
    validator_count: Int
    miner_count: Int
    total_stake_tao: Float
    total_emission_tao: Float
    stake_dominance: Float
    latest_captured_at: String
    latest_block_number: Int
    "Per-subnet stake/emission rows for this account, capped at the top 10 by stake."
    subnets: [AccountSubnet!]!
  }

  type AccountSubnet {
    netuid: Int!
    uid: Int
    stake_tao: Float
    emission_tao: Float
  }

  type AccountSummary {
    ss58: String!
    event_count: Int!
    subnet_count: Int!
    "True when this account has more events than the summary's scan window -- event_count/subnet_count/event_kinds are then a lower bound and first_block/first_seen_at are null."
    event_scan_capped: Boolean!
    first_block: Int
    last_block: Int
    first_seen_at: String
    last_seen_at: String
    event_kinds: [AccountEventKind!]!
    "Where this hotkey is currently registered + staked (the live cross-subnet footprint)."
    registrations: [AccountRegistration!]!
    recent_events: [AccountEvent!]!
    activity: AccountActivity!
  }

  type AccountEventKind {
    kind: String!
    count: Int!
  }

  type AccountRegistration {
    netuid: Int
    uid: Int
    stake_tao: Float
    validator_permit: Boolean!
    active: Boolean!
  }

  "One subnet's slice of an account's registration footprint over the window."
  type AccountRegistrationSubnet {
    netuid: Int!
    registrations: Int!
    first_registered_at: String
    last_registered_at: String
  }

  type AccountRegistrations {
    schema_version: Int!
    address: String!
    window: String
    total_registrations: Int!
    subnet_count: Int!
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountRegistrationSubnet!]!
  }

  "One subnet's slice of an account's deregistration footprint over the window."
  type AccountDeregistrationSubnet {
    netuid: Int!
    deregistrations: Int!
    first_deregistered_at: String
    last_deregistered_at: String
  }

  type AccountDeregistrations {
    schema_version: Int!
    address: String!
    window: String
    total_deregistrations: Int!
    subnet_count: Int!
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountDeregistrationSubnet!]!
  }

  "One subnet's slice of an account's axon-serving footprint over the window."
  type AccountServingSubnet {
    netuid: Int!
    announcements: Int!
    first_served_at: String
    last_served_at: String
  }

  type AccountServing {
    schema_version: Int!
    address: String!
    window: String
    total_announcements: Int!
    subnet_count: Int!
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountServingSubnet!]!
  }

  "One subnet's slice of an account's axon-removal footprint over the window."
  type AccountAxonRemovalSubnet {
    netuid: Int!
    removals: Int!
    first_removed_at: String
    last_removed_at: String
  }

  type AccountAxonRemovals {
    schema_version: Int!
    address: String!
    window: String
    total_removals: Int!
    subnet_count: Int!
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountAxonRemovalSubnet!]!
  }

  "One subnet's slice of an account's stake-movement footprint over the window."
  type AccountStakeMoveSubnet {
    netuid: Int!
    movements: Int!
    first_moved_at: String
    last_moved_at: String
    "Alpha price (TAO) on the UTC day of this subnet's most recent move; null when that day has no snapshot yet or there was no move."
    price_tao_at_last_move: Float
  }

  type AccountStakeMoves {
    schema_version: Int!
    address: String!
    window: String
    total_movements: Int!
    subnet_count: Int!
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountStakeMoveSubnet!]!
  }

  type AccountEvent {
    block_number: Int
    event_index: Int
    event_kind: String
    hotkey: String
    coldkey: String
    netuid: Int
    uid: Int
    amount_tao: Float
    alpha_amount: Float
    observed_at: String
    extrinsic_index: Int
  }

  "Signing-activity aggregate from the extrinsics tier, matched by signer only -- an account queried by a key that did not sign returns tx_count 0, other fields null/empty."
  type AccountActivity {
    tx_count: Int!
    last_tx_block: Int
    last_tx_at: String
    total_fee_tao: Float
    modules_called: [AccountModuleCall!]!
  }

  type AccountModuleCall {
    call_module: String!
    count: Int!
  }

  "One account's Prometheus telemetry-serving footprint (#5703) across subnets over a 7d/30d/90d window. Mirrors GET /api/v1/accounts/{ss58}/prometheus."
  type AccountPrometheus {
    schema_version: Int!
    address: String!
    window: String
    total_announcements: Int!
    subnet_count: Int!
    "Herfindahl-Hirschman index of announcements across subnets: 1 = all on one subnet, -> 1/n as it spreads evenly; null when the account has no announcements."
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountPrometheusSubnet!]!
  }

  "One subnet's Prometheus-announcement activity in an account's footprint, ranked most-active-first."
  type AccountPrometheusSubnet {
    netuid: Int!
    announcements: Int!
    first_announced_at: String
    last_announced_at: String
  }

  "One account's StakeAdded/StakeRemoved staking-behavior scorecard (#5706) across subnets over a 7d/30d/90d window. Mirrors GET /api/v1/accounts/{ss58}/stake-flow."
  type AccountStakeFlow {
    schema_version: Int!
    address: String!
    window: String
    total_staked_tao: Float!
    total_unstaked_tao: Float!
    net_flow_tao: Float!
    gross_flow_tao: Float!
    "net_flow_tao / gross_flow_tao, [-1, 1]; null when gross_flow_tao is 0 (no flow to rate)."
    flow_ratio: Float
    "accumulating / exiting / churning / idle, derived from flow_ratio."
    direction: String!
    stake_events: Int!
    unstake_events: Int!
    subnet_count: Int!
    "Herfindahl-Hirschman index of gross flow across subnets: 1 = all flow in one subnet, -> 1/n as it spreads evenly; null when there is no flow to concentrate."
    concentration: Float
    dominant_netuid: Int
    subnets: [AccountStakeFlowSubnet!]!
  }

  "One subnet's stake flow in an account's footprint, ranked most-active-first (highest gross flow)."
  type AccountStakeFlowSubnet {
    netuid: Int!
    staked_tao: Float!
    unstaked_tao: Float!
    net_flow_tao: Float!
    gross_flow_tao: Float!
    flow_ratio: Float
    direction: String!
    stake_events: Int!
    unstake_events: Int!
  }

  # Realtime chain-event firehose (#4983, ADR 0015) -- a thin protocol adapter
  # over the SAME ChainFirehoseHub Durable Object connection #4982's SSE/WS
  # transports use, not a second event pipeline. Reached over WebSocket only
  # (Sec-WebSocket-Protocol: graphql-transport-ws at this same /api/v1/graphql
  # path) -- POSTing a subscription operation to the regular query endpoint
  # returns a standard GraphQL error, same as any other GraphQL server.
  type Subscription {
    "Live chain events as they land (blocks/extrinsics/chain_events/account_events), optionally filtered to one or more tables. Field shape mirrors the #4980 NOTIFY payload -- only the fields relevant to the event's table are populated."
    chainEvents(tables: [ChainFirehoseTable!]): ChainEvent!
  }

  enum ChainFirehoseTable {
    blocks
    extrinsics
    chain_events
    account_events
  }

  type ChainEvent {
    table: ChainFirehoseTable!
    block_number: Int!
    observed_at: String
    "blocks only"
    block_hash: String
    "blocks only"
    extrinsic_count: Int
    "blocks only"
    event_count: Int
    "extrinsics only"
    extrinsic_index: Int
    "extrinsics only"
    call_module: String
    "extrinsics only"
    call_function: String
    "extrinsics only"
    signer: String
    "extrinsics only"
    success: Boolean
    "chain_events / account_events (event index within the block)"
    event_index: Int
    "chain_events only"
    pallet: String
    "chain_events only"
    method: String
    "account_events only -- the curated kind (e.g. Transfer, StakeAdded)"
    event_kind: String
    "account_events only"
    hotkey: String
    "account_events only"
    coldkey: String
    "account_events only"
    netuid: Int
    "account_events only"
    amount_tao: Float
  }
`;

// Exported so workers/chain-firehose-hub.mjs's graphql-ws server (#4983) can
// execute against the SAME schema -- not a copy, so the two transports never
// drift.
export const schema = buildSchema(SDL);

// SDL-only schemas (buildSchema) carry no resolver functions -- Query/Mutation
// fields read straight off rootValue/artifacts via the default field resolver,
// but a subscription root field needs an explicit `subscribe` (an
// AsyncIterable source), which SDL has no syntax for. Attached here, once, at
// module load, the same graphql-js technique used by every SDL-first server
// that also needs subscriptions. context.chainFirehose is supplied by
// whichever Durable Object drives the graphql-ws server (workers/chain-firehose-hub.mjs)
// -- see GRAPHQL_SUBSCRIPTION_CONTEXT_KEY below.
export const GRAPHQL_SUBSCRIPTION_CONTEXT_KEY = "chainFirehose";
schema.getSubscriptionType().getFields().chainEvents.subscribe =
  async function* chainEventsSubscribe(_source, args, context) {
    const hub = context?.[GRAPHQL_SUBSCRIPTION_CONTEXT_KEY];
    if (!hub) {
      throw new GraphQLError(
        "chainEvents is only reachable over the WebSocket transport (Sec-WebSocket-Protocol: graphql-transport-ws) at /api/v1/graphql.",
      );
    }
    // Distinguish omitted (undefined -> null, no filter, matches everything)
    // from an EXPLICIT empty list (tables: [] -> an empty Set, matches
    // nothing) -- consistent with the SSE/WS firehose's own
    // parseChainFirehoseTopics semantics (an all-unrecognized topics= string
    // also collapses to an empty Set, never silently falling back to
    // "everything"). Previously both cases collapsed to null.
    const topics = args.tables === undefined ? null : new Set(args.tables);
    // context.clientIp/context.graphqlWsConnection are set by
    // workers/chain-firehose-hub.mjs's graphqlWsServer context() callback
    // from ctx.extra.ip/ctx.extra.graphqlWsConnection (populated by
    // handleSubscribe's opened(adapterSocket, { ip, graphqlWsConnection })
    // call) -- threaded through so subscribeChainEvents can enforce its
    // per-IP (#5004 item 2) and per-socket subscription-count caps alongside
    // the global one.
    const repeater = hub.subscribeChainEvents(
      topics,
      context.clientIp,
      context.graphqlWsConnection,
    );
    if (!repeater) {
      throw new GraphQLError(
        "The realtime chain firehose has reached its maximum number of " +
          "concurrent GraphQL subscriptions; try again later.",
      );
    }
    try {
      for await (const payload of repeater) {
        yield { chainEvents: payload };
      }
    } finally {
      hub.unsubscribeChainEvents(repeater);
    }
  };

// --- Complexity weights ---

// Per-field weight against GRAPHQL_MAX_COMPLEXITY: read/fan-out fields cost more
// than scalars so the guard stays meaningful — one subnet with all its
// relationships fits, while greedily pulling many relationships across a page
// trips it. Keyed by field name; everything else defaults to 1.
export const DEFAULT_FIELD_COMPLEXITY = 1;
const RELATIONSHIP_FIELD_COMPLEXITY = 5;
// Live chain RPC (not the cached Postgres tier) -- costs more per-call than a
// relationship read, so it's weighted double.
const LIVE_RPC_FIELD_COMPLEXITY = 10;
export const FIELD_COMPLEXITY = {
  subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet: RELATIONSHIP_FIELD_COMPLEXITY,
  providers: RELATIONSHIP_FIELD_COMPLEXITY,
  provider: RELATIONSHIP_FIELD_COMPLEXITY,
  economics: RELATIONSHIP_FIELD_COMPLEXITY,
  surfaces: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  health: RELATIONSHIP_FIELD_COMPLEXITY,
  opportunity_boards: RELATIONSHIP_FIELD_COMPLEXITY,
  compare: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsic: RELATIONSHIP_FIELD_COMPLEXITY,
  validators: RELATIONSHIP_FIELD_COMPLEXITY,
  validator: RELATIONSHIP_FIELD_COMPLEXITY,
  validator_history: RELATIONSHIP_FIELD_COMPLEXITY,
  accounts: RELATIONSHIP_FIELD_COMPLEXITY,
  account: RELATIONSHIP_FIELD_COMPLEXITY,
  account_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  account_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  account_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  account_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  block: RELATIONSHIP_FIELD_COMPLEXITY,
  economics_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_movers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  health_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  account_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_recycled: LIVE_RPC_FIELD_COMPLEXITY,
};

function fieldComplexity(fieldName) {
  return FIELD_COMPLEXITY[fieldName] ?? DEFAULT_FIELD_COMPLEXITY;
}

// --- Validation rules ---

function buildFragmentMap(documentNode) {
  const fragments = new Map();
  for (const def of documentNode.definitions) {
    if (def.kind === "FragmentDefinition") {
      fragments.set(def.name.value, def);
    }
  }
  return fragments;
}

// Introspection root meta-fields (`__schema` / `__type`) resolve against the
// schema document only — they have no per-row data fan-out — so they carry none
// of the DoS risk the depth/complexity weights were sized for. Exempt them (and
// their subtree) from both counters so the standard getIntrospectionQuery() that
// every GraphQL tool sends (intrinsically deeper/wider than the data limits)
// stays enabled over POST, matching the documented contract. Sibling data fields
// in the same operation are still measured, so a mixed query stays bounded.
const INTROSPECTION_ROOT_FIELDS = new Set(["__schema", "__type"]);
function isIntrospectionRootField(sel) {
  return sel.kind === "Field" && INTROSPECTION_ROOT_FIELDS.has(sel.name?.value);
}

// Depth/complexity must follow named fragment spreads. Otherwise a client moves
// the whole (expensive) selection into a fragment and the operation's own
// selection set is just a single transparent spread — counting as depth 0 /
// complexity 1 and fully bypassing both limits. `visited` guards against
// fragment cycles: validate() reports those, but our rules run in the same pass
// and would otherwise recurse forever.
//
// Inline fragments (`... on Type { ... }`, or a bare `... @include(if:) { ... }`)
// are likewise transparent: a type condition is not a nesting level or an extra
// field. Counting them would over-measure a query relative to its equivalent
// inlined or named-fragment form, wrongly rejecting valid queries.
function selectionDepth(selectionSet, fragments, visited, memo, max) {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: depth 0
    let depth = 0;
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          depth = memo.get(fragName);
        } else {
          depth = selectionDepth(
            frag.selectionSet,
            fragments,
            new Set(visited).add(fragName),
            memo,
            max,
          );
          memo.set(fragName, depth);
        }
      }
    } else if (sel.kind === "InlineFragment") {
      // Transparent: recurse at the same depth (the type condition is not a level).
      depth = selectionDepth(sel.selectionSet, fragments, visited, memo, max);
    } else if (sel.selectionSet) {
      depth =
        1 + selectionDepth(sel.selectionSet, fragments, visited, memo, max);
    }
    if (depth > deepest) deepest = depth;
    if (deepest > max) return max + 1;
  }
  return deepest;
}

export function maxDepthRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const depth = selectionDepth(
              def.selectionSet,
              fragments,
              new Set(),
              new Map(),
              max,
            );
            if (depth > max) {
              context.reportError(
                new GraphQLError(
                  `Query depth ${depth} exceeds the limit of ${max}.`,
                  { extensions: { code: "DEPTH_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

function selectionComplexity(selectionSet, fragments, visited, memo, max) {
  let count = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: no complexity cost
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          count += memo.get(fragName);
        } else {
          const fragCount = selectionComplexity(
            frag.selectionSet,
            fragments,
            new Set(visited).add(fragName),
            memo,
            max,
          );
          memo.set(fragName, fragCount);
          count += fragCount;
        }
      }
    } else if (sel.kind === "InlineFragment") {
      // Transparent like a named spread: count the contained fields, not the
      // inline type condition itself.
      count += selectionComplexity(
        sel.selectionSet,
        fragments,
        visited,
        memo,
        max,
      );
    } else {
      count += fieldComplexity(sel.name.value);
      if (sel.selectionSet) {
        count += selectionComplexity(
          sel.selectionSet,
          fragments,
          visited,
          memo,
          max,
        );
      }
    }
    if (count > max) return max + 1;
  }
  return count;
}

export function maxComplexityRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const complexity = selectionComplexity(
              def.selectionSet,
              fragments,
              new Set(),
              new Map(),
              max,
            );
            if (complexity > max) {
              context.reportError(
                new GraphQLError(
                  `Query complexity ${complexity} exceeds the limit of ${max}.`,
                  { extensions: { code: "COMPLEXITY_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

// --- Pagination ---

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function paginate(items, limit, cursor, keyFn) {
  // A missing/blank/<1 limit falls back to the default — it must NOT clamp UP to
  // 1. An explicit `limit: 0` reaching `Math.max(1, …)` would return a single
  // result, which reads to an agent as "this registry knows one subnet" (the same
  // reasoning as clampLimit in src/mcp-server.mjs and src/ai-search.mjs).
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 1
      ? Math.min(MAX_PAGE_LIMIT, Math.floor(limit))
      : DEFAULT_PAGE_LIMIT;
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((item) => String(keyFn(item)) === cursor);
    if (idx >= 0) start = idx + 1;
  }
  const page = items.slice(start, start + safeLimit);
  const nextCursor =
    start + page.length < items.length
      ? String(keyFn(page[page.length - 1]))
      : null;
  return { page, total: items.length, nextCursor };
}

// --- Reads (per-request memoized) ---

// Registry-wide artifacts read by more than one resolver; named so the memo keys
// stay byte-identical. Per-subnet/provider detail paths are templated inline.
const ARTIFACT = {
  subnets: "/metagraph/subnets.json",
  providers: "/metagraph/providers.json",
  economics: "/metagraph/economics.json",
  surfaces: "/metagraph/surfaces.json",
  endpoints: "/metagraph/endpoints.json",
  profiles: "/metagraph/profiles.json",
};
const LIVE_HEALTH_KEY = "live:health";
const LIVE_ECONOMICS_KEY = "live:economics";

// Resolve an async value at most once per query: a page of subnets each pulling
// a relationship shares one read of each registry artifact (and one live health
// snapshot). The promise is cached so concurrent thunks collapse onto one read.
function once(context, key, load) {
  let pending = context.cache.get(key);
  if (!pending) {
    pending = load();
    context.cache.set(key, pending);
  }
  return pending;
}

// Artifact data, or null when cold/absent — resolvers degrade to empty shapes
// rather than erroring, like the REST handlers.
function loadArtifact(context, path) {
  return once(context, path, () =>
    readArtifact(context.env, path).then((res) => (res.ok ? res.data : null)),
  );
}

// Rows under `key`, filtered to one subnet when `netuid` is given.
async function loadRows(context, path, key, netuid) {
  const data = await loadArtifact(context, path);
  const rows = data?.[key];
  if (!Array.isArray(rows)) return [];
  return netuid == null ? rows : rows.filter((row) => row?.netuid === netuid);
}

// Live operational health (KV health:current → D1) — the build no longer
// publishes static health, so this mirrors the REST /api/v1/health source.
// Null when the live store is cold.
function loadLiveHealth(context) {
  return once(context, LIVE_HEALTH_KEY, () =>
    resolveLiveHealth({
      readHealthKv,
      env: context.env,
      db: context.env?.METAGRAPH_HEALTH_DB,
    }),
  );
}

// Economics blob, preferring the fresh KV tier over the committed R2 artifact —
// the same source REST (/api/v1/economics, registry leaderboards) serves, so the
// GraphQL rows and opportunity boards never lag it. Null when both are cold.
function loadEconomics(context) {
  return once(context, LIVE_ECONOMICS_KEY, async () => {
    const live = await resolveLiveEconomics({
      readHealthKv,
      env: context.env,
      contractVersion: contractVersion(context.env),
    });
    if (Array.isArray(live?.data?.subnets)) return live.data;
    const res = await readArtifact(context.env, ARTIFACT.economics);
    return res.ok ? res.data : null;
  });
}

// A (sql, params) => Promise<rows[]> runner over the health DB, mirroring REST's
// d1All and the MCP compare runner: a cold DB or query error yields [] so the
// compare health dimension degrades to null rows instead of erroring.
function graphqlD1(context) {
  return async (sql, params) => {
    const db = context.env?.METAGRAPH_HEALTH_DB;
    if (!db?.prepare) return [];
    try {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all();
      return result?.results || [];
    } catch {
      return [];
    }
  };
}

// Cron snapshot freshness stamp (KV health:meta) — the same observed_at REST
// compare stamps its envelope with. Null when the live store is cold.
function loadObservedAt(context) {
  return once(context, KV_HEALTH_META, async () => {
    const meta = await readHealthKv(context.env, KV_HEALTH_META);
    return meta?.last_run_at || null;
  });
}

// Economics subnet rows for compare, reusing the live-preferring economics memo
// (same source the `economics` root + opportunity boards serve).
async function loadEconomicsRows(context) {
  const data = await loadEconomics(context);
  return Array.isArray(data?.subnets) ? data.subnets : [];
}

// Synthesize the GET request tryPostgresTier forwards to the DATA_API service
// binding, keyed off the same origin as the inbound GraphQL POST (GraphQL has
// no REST-shaped request of its own to forward, unlike every REST handler
// that already owns one matching its own route). Same technique
// handleCompare's health dimension uses for its own internal compare-health
// forward (workers/request-handlers/analytics-routes.mjs) rather than
// forwarding the caller's request unchanged.
function postgresTierRequest(context, pathname, params) {
  const pgUrl = new URL(context.request.url);
  pgUrl.pathname = pathname;
  pgUrl.search = params ? params.toString() : "";
  return new Request(pgUrl);
}

// --- Node builders (attach lazy relationship resolvers to artifact rows) ---

// graphql-js' default field resolver invokes a source property when it is a
// function: `subnet.health(args, context, info)`. So a node is just the artifact
// row spread over lazy thunks for its relationships — scalar fields resolve
// straight off the row, relationships resolve on demand through the shared memo.
// `prefetch` lets the single-subnet path serve surfaces/endpoints from the
// detail artifact it already read; economics + health are not in that artifact.
function subnetNode(identity, prefetch = {}) {
  const netuid = identity.netuid;
  const bundledOr = (rows, load) =>
    rows !== undefined
      ? () => rows ?? []
      : (_args, context) => load(context, netuid);
  return {
    ...identity,
    health: (_args, context) => loadSubnetHealth(context, netuid),
    economics: (_args, context) => loadSubnetEconomics(context, netuid),
    surfaces: bundledOr(prefetch.surfaces, loadSubnetSurfaces),
    endpoints: bundledOr(prefetch.endpoints, loadSubnetEndpoints),
  };
}

// formatExtrinsic's call_args is a decoded JS value (object/array/null), but
// the SDL exposes it as an opaque JSON-encoded String (no custom JSON scalar
// exists in this schema yet) -- stringify it here rather than letting
// graphql-js' default String serializer coerce the object via `String(...)`
// (which would silently produce "[object Object]").
function extrinsicNode(extrinsic) {
  if (!extrinsic) return null;
  return {
    ...extrinsic,
    call_args:
      extrinsic.call_args == null ? null : JSON.stringify(extrinsic.call_args),
  };
}

// buildGlobalValidators' per-hotkey entries carry featured/uid_count/
// latest_captured_at/latest_block_number; buildValidatorDetail's single-hotkey
// aggregate has no featured/uid_count and names the same timestamps
// captured_at/block_number -- normalized here so both resolvers return the
// same Validator shape. Both builders always return an object (rows=[]
// degrades to a zeroed aggregate, never null/undefined), so there is no null
// case to guard. `subnets` entries are passed through as-is: the leaderboard's
// compact 5-field rows and the detail's full formatNeuron rows share the
// fields ValidatorSubnet declares, and graphql-js' default field resolver
// reads them straight off each row, the same technique this file's other node
// builders use for rows with more columns than any one GraphQL type exposes.
function validatorNode(validator) {
  return {
    ...validator,
    featured: validator.featured === true,
    captured_at: validator.latest_captured_at ?? validator.captured_at ?? null,
    block_number:
      validator.latest_block_number ?? validator.block_number ?? null,
  };
}

// buildAccountSummary always returns a full-shaped object (a cold/absent store
// still yields a zeroed summary, never a partial one), but a malformed
// Postgres-tier response body degrades to `{}` -- normalized here the same way
// extrinsicNode/ExtrinsicDetail's `data.ref ?? ref` fallback degrades a
// malformed extrinsic-detail body, so a bad upstream body still resolves to
// the same schema-stable zero shape as a genuinely cold store, not a
// Non-Null-field error.
function accountSummaryNode(data, ss58) {
  return {
    ss58: data.ss58 ?? ss58,
    event_count: data.event_count ?? 0,
    subnet_count: data.subnet_count ?? 0,
    event_scan_capped: data.event_scan_capped === true,
    first_block: data.first_block ?? null,
    last_block: data.last_block ?? null,
    first_seen_at: data.first_seen_at ?? null,
    last_seen_at: data.last_seen_at ?? null,
    event_kinds: data.event_kinds || [],
    registrations: data.registrations || [],
    recent_events: data.recent_events || [],
    activity: data.activity || { tx_count: 0, modules_called: [] },
  };
}

function providerNode(provider) {
  const netuids = provider?.netuids || [];
  return {
    ...provider,
    netuids,
    subnets: (_args, context) => loadProviderSubnets(context, netuids),
  };
}

async function loadSubnetHealth(context, netuid) {
  return subnetBadgeStatus(await loadLiveHealth(context), netuid);
}

async function loadSubnetEconomics(context, netuid) {
  const data = await loadEconomics(context);
  return data?.subnets?.find((row) => row?.netuid === netuid) ?? null;
}

function loadSubnetSurfaces(context, netuid) {
  return loadRows(context, ARTIFACT.surfaces, "surfaces", netuid);
}

function loadSubnetEndpoints(context, netuid) {
  return loadRows(context, ARTIFACT.endpoints, "endpoints", netuid);
}

async function loadProviderSubnets(context, netuids) {
  if (!netuids.length) return [];
  const rows = await loadRows(context, ARTIFACT.subnets, "subnets");
  const byNetuid = new Map(rows.map((row) => [row.netuid, row]));
  return netuids
    .map((netuid) => byNetuid.get(netuid))
    .filter(Boolean)
    .map((row) => subnetNode(row));
}

// --- Resolvers ---

// Shared list shape: load → optional netuid filter → paginate → wrap. `map`
// node-wraps rows; `resultKey` is the list field's name (economics uses
// `subnets`, the rest use `items`).
async function listPage(
  context,
  path,
  key,
  { limit, cursor, keyFn, netuid, map, resultKey = "items" },
) {
  const all = await loadRows(context, path, key, netuid);
  const { page, total, nextCursor } = paginate(all, limit, cursor, keyFn);
  return {
    [resultKey]: map ? page.map(map) : page,
    total,
    next_cursor: nextCursor,
  };
}

// readArtifact's static-asset tier resolves the path through a URL parser that
// collapses "../", so an unvalidated provider id could escape the providers/
// namespace. Constrain it to the safe slug charset the other id-bearing artifact
// paths use; subnet(netuid) is Int-typed and needs no guard.
const VALID_PROVIDER_ID = /^[A-Za-z0-9._:-]+$/;

const rootValue = {
  subnets({ limit, cursor }, context) {
    return listPage(context, ARTIFACT.subnets, "subnets", {
      limit,
      cursor,
      keyFn: (s) => s.netuid,
      map: subnetNode,
    });
  },

  async subnet({ netuid }, context) {
    const data = await loadArtifact(
      context,
      `/metagraph/subnets/${netuid}.json`,
    );
    if (!data) return null;
    // The detail artifact nests identity under `subnet` (flat shapes fall back)
    // and bundles surfaces/endpoints, so those resolve from this one read;
    // economics is overlaid live at serve time, so it loads lazily.
    const identity = data.subnet ?? data;
    // The detail artifact omits the list artifact's computed registry metrics
    // (integration_readiness, official_surface_count, gap_count, first_party),
    // so without this backfill the single-subnet path returns them null while
    // `subnets` populates them. Read the matching subnets.json row — memoized and
    // shared per request, so at most one extra read; the detail identity still
    // wins on any shared key.
    const listRow = (
      await loadRows(context, ARTIFACT.subnets, "subnets", netuid)
    )[0];
    return subnetNode(listRow ? { ...listRow, ...identity } : identity, {
      surfaces: data.surfaces,
      endpoints: data.endpoints,
    });
  },

  async subnet_registrations({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetRegistrations uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_REGISTRATIONS_WINDOW;
    if (!Object.hasOwn(SUBNET_REGISTRATIONS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_REGISTRATIONS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetRegistrations
    // zeroed-card fallback contract handleSubnetRegistrations uses; a subnet with no
    // NeuronRegistered events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/registrations`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetRegistrations(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_registrants: data.distinct_registrants ?? 0,
      registrations: data.registrations ?? 0,
      registrations_per_registrant: data.registrations_per_registrant ?? null,
    };
  },

  async subnet_deregistrations({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetDeregistrations uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW;
    if (!Object.hasOwn(SUBNET_DEREGISTRATIONS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_DEREGISTRATIONS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetDeregistrations
    // zeroed-card fallback contract handleSubnetDeregistrations uses; a subnet with no
    // NeuronDeregistered events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/deregistrations`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetDeregistrations(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_deregistered_hotkeys: data.distinct_deregistered_hotkeys ?? 0,
      deregistrations: data.deregistrations ?? 0,
      deregistrations_per_hotkey: data.deregistrations_per_hotkey ?? null,
    };
  },

  async subnet_serving({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetServing uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_SERVING_WINDOW;
    if (!Object.hasOwn(SUBNET_SERVING_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_SERVING_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetServing
    // zeroed-card fallback contract handleSubnetServing uses; a subnet with no
    // AxonServed events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/serving`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetServing(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_servers: data.distinct_servers ?? 0,
      announcements: data.announcements ?? 0,
      announcements_per_server: data.announcements_per_server ?? null,
    };
  },

  async subnet_axon_removals({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetAxonRemovals uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_AXON_REMOVALS_WINDOW;
    if (!Object.hasOwn(SUBNET_AXON_REMOVALS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_AXON_REMOVALS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetAxonRemovals
    // zeroed-card fallback contract handleSubnetAxonRemovals uses; a subnet with no
    // AxonInfoRemoved events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/axon-removals`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetAxonRemovals(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_removers: data.distinct_removers ?? 0,
      removals: data.removals ?? 0,
      removals_per_remover: data.removals_per_remover ?? null,
    };
  },

  async subnet_identity_history({ netuid, limit, offset, cursor }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    // Same tryPostgresTier(METAGRAPH_SUBNET_IDENTITY_SOURCE) ->
    // loadSubnetIdentityHistory fallback contract handleSubnetIdentityHistory
    // uses; a subnet with no matching events is a schema-stable empty
    // timeline (entry_count 0), never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/identity-history`,
          params,
        ),
        "METAGRAPH_SUBNET_IDENTITY_SOURCE",
      )) ??
      (await loadSubnetIdentityHistory(graphqlD1(context), netuid, {
        limit: safeLimit,
        offset: safeOffset,
        cursor,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      entry_count: data.entry_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      entries: data.entries || [],
    };
  },

  async subnet_performance({ netuid }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetPerformance([])
    // cold fallback contract handleSubnetPerformance / MCP get_subnet_performance
    // use: a subnet with no neurons is a schema-stable zeroed card (metric
    // blocks null), never a GraphQL error. No window — current snapshot only.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/performance`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildSubnetPerformance([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      neuron_count: data.neuron_count ?? 0,
      validator_count: data.validator_count ?? 0,
      active_count: data.active_count ?? 0,
      captured_at: data.captured_at ?? null,
      incentive: data.incentive ?? null,
      dividends: data.dividends ?? null,
      trust: data.trust ?? null,
      consensus: data.consensus ?? null,
      validator_trust: data.validator_trust ?? null,
    };
  },

  async subnet_yield({ netuid }, context) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetYield cold
    // fallback contract handleSubnetYield uses: a subnet with no neurons is a
    // schema-stable zeroed card, never a GraphQL error. No window param — the
    // route reads the CURRENT metagraph snapshot.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/yield`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildSubnetYield([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      neuron_count: data.neuron_count ?? 0,
      validator_count: data.validator_count ?? 0,
      miner_count: data.miner_count ?? 0,
      total_stake_tao: data.total_stake_tao ?? null,
      total_emission_tao: data.total_emission_tao ?? null,
      subnet_yield: data.subnet_yield ?? null,
      mean_yield: data.mean_yield ?? null,
      median_yield: data.median_yield ?? null,
      p25_yield: data.p25_yield ?? null,
      p75_yield: data.p75_yield ?? null,
      p90_yield: data.p90_yield ?? null,
      // buildSubnetYield's neuron shape matches SubnetYieldNeuron field-for-field,
      // so GraphQL resolves the nested selection off the raw rows directly.
      neurons: data.neurons ?? [],
    };
  },

  async subnet_weights({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetWeights uses -- an unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_WEIGHTS_WINDOW;
    if (!Object.hasOwn(SUBNET_WEIGHTS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_WEIGHTS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetWeights
    // zeroed-card fallback contract handleSubnetWeights uses; a subnet with no
    // WeightsSet events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/weights`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetWeights(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_setters: data.distinct_setters ?? 0,
      weight_sets: data.weight_sets ?? 0,
      sets_per_setter: data.sets_per_setter ?? null,
    };
  },

  providers({ limit, cursor }, context) {
    return listPage(context, ARTIFACT.providers, "providers", {
      limit,
      cursor,
      keyFn: (p) => p.id,
      map: providerNode,
    });
  },

  async provider({ id }, context) {
    if (typeof id !== "string" || !VALID_PROVIDER_ID.test(id)) return null;
    const data = await loadArtifact(context, `/metagraph/providers/${id}.json`);
    if (!data) return null;
    return providerNode(data.provider ?? data);
  },

  async economics({ limit, cursor }, context) {
    // Live-preferring source (not the static-only listPage), paginated like it.
    const data = await loadEconomics(context);
    const { page, total, nextCursor } = paginate(
      data?.subnets || [],
      limit,
      cursor,
      (s) => s.netuid,
    );
    return { subnets: page, total, next_cursor: nextCursor };
  },

  surfaces({ netuid, limit, cursor }, context) {
    return listPage(context, ARTIFACT.surfaces, "surfaces", {
      limit,
      cursor,
      netuid,
      keyFn: (s) => s.id ?? s.key,
    });
  },

  endpoints({ netuid, limit, cursor }, context) {
    return listPage(context, ARTIFACT.endpoints, "endpoints", {
      limit,
      cursor,
      netuid,
      keyFn: (e) => e.id ?? e.surface_id,
    });
  },

  async health(_args, context) {
    const snapshot = await loadLiveHealth(context);
    const result = snapshot ? buildGlobalHealth(snapshot, {}) : null;
    if (!result) return null;
    // GlobalHealth exposes the rollup counts flat; buildGlobalHealth nests them
    // under `global`.
    return {
      ...(result.global || {}),
      generated_at: result.generated_at,
      operational_observed_at: result.operational_observed_at,
      health_source: result.health_source,
      scope: result.scope,
      subnets: result.subnets || [],
    };
  },

  async opportunity_boards({ limit }, context) {
    const data = await loadEconomics(context);
    const rows = Array.isArray(data?.subnets) ? data.subnets : [];
    // Reuse the live economics tier + the leaderboard ranking, so the boards
    // match /api/v1/registry/leaderboards. With no health/rpc inputs, only the
    // economic boards are populated.
    const ranked = formatLeaderboards({
      limit,
      observedAt: data?.captured_at || data?.generated_at || null,
      economicsRows: rows,
      subnetMeta: new Map(),
    });
    const boards = ranked.boards;
    return {
      observed_at: ranked.observed_at,
      with_economics_count: rows.length,
      open_slots: boards["open-slots"] || [],
      cheapest_registration: boards["cheapest-registration"] || [],
      highest_emission: boards["highest-emission"] || [],
      validator_headroom: boards["validator-headroom"] || [],
    };
  },

  async compare({ netuids, dimensions }, context) {
    // Reuse the REST/MCP shared parsers so the GraphQL contract matches
    // /api/v1/compare and the compare_subnets MCP tool exactly (distinctness +
    // range + the dimension whitelist), then the shared loader composes the rows.
    const parsedNetuids = parseCompareNetuidList(netuids);
    if (!parsedNetuids) {
      throw new GraphQLError(
        "netuids must be a non-empty array of 1-128 distinct non-negative subnet ids.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const parsedDimensions = parseCompareDimensionList(dimensions);
    if (dimensions != null && parsedDimensions === null) {
      throw new GraphQLError(
        "dimensions must be a non-empty subset of structure, economics, health.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const profilesData = await loadArtifact(context, ARTIFACT.profiles);
    const profiles = Array.isArray(profilesData?.profiles)
      ? profilesData.profiles
      : [];
    return loadCompareSubnets(graphqlD1(context), {
      profiles,
      economicsRows: parsedDimensions.includes("economics")
        ? await loadEconomicsRows(context)
        : [],
      netuids: parsedNetuids,
      dimensions: parsedDimensions,
      observedAt: await loadObservedAt(context),
    });
  },

  async incidents({ window }, context) {
    // Reuse the exact analyticsWindow parse/validate REST's handleGlobalIncidents
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL BAD_USER_INPUT
    // error, not a silent empty result. analyticsWindow reads only the ?window param.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, days, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same METAGRAPH_HEALTH_SOURCE Postgres tier -> loadGlobalIncidentsLedger D1
    // fallback contract handleGlobalIncidents uses; the ledger is schema-stable on
    // a cold/retired tier (empty surfaces + zeroed summary), never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/incidents", params),
        "METAGRAPH_HEALTH_SOURCE",
      )) ??
      (await loadGlobalIncidentsLedger(context.env, { label, days })).data;
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      summary: data.summary ?? null,
      surfaces: data.surfaces ?? [],
    };
  },

  async extrinsics(
    {
      limit,
      offset,
      cursor,
      block,
      signer,
      call_module: callModule,
      call_function: callFunction,
      success,
    },
    context,
  ) {
    if (block != null && (!Number.isInteger(block) || block < 0)) {
      throw new GraphQLError("block must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, BLOCK_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    if (block != null) params.set("block", String(block));
    if (signer) params.set("signer", signer);
    if (callModule) params.set("call_module", callModule);
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/extrinsics", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ??
      buildExtrinsicFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: (data.extrinsics || []).map(extrinsicNode),
      total: data.extrinsic_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  async extrinsic({ ref }, context) {
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/extrinsics/${encodeURIComponent(ref)}`,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ?? buildExtrinsic(undefined, ref);
    return {
      ref: data.ref ?? ref,
      extrinsic: extrinsicNode(data.extrinsic),
    };
  },

  async blocks({ limit, offset, cursor }, context) {
    const safeLimit = clampLimit(limit, BLOCK_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    // #4909: blocks' D1 write path is retired and the table is dropped in
    // production, so the Postgres tier being cold is the expected steady state —
    // fall back to the same pure builder REST uses, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/blocks", params),
        "METAGRAPH_BLOCKS_SOURCE",
      )) ??
      buildBlockFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: data.blocks || [],
      total: data.block_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  async blocks_summary(_args, context) {
    // #5664: same tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) -> buildBlocksSummary([])
    // fallback contract handleBlocksSummary uses. blocks' D1 write path is retired
    // (#4909) so a cold Postgres tier is the steady state -- the empty builder
    // shape (block_count 0, every aggregate null) satisfies the non-null
    // BlocksSummary! contract, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/blocks/summary"),
        "METAGRAPH_BLOCKS_SOURCE",
      )) ?? buildBlocksSummary([]);
    return {
      schema_version: data.schema_version ?? 1,
      block_count: data.block_count ?? 0,
      first_block: data.first_block ?? null,
      last_block: data.last_block ?? null,
      first_observed_at: data.first_observed_at ?? null,
      last_observed_at: data.last_observed_at ?? null,
      block_time: data.block_time ?? null,
      throughput: data.throughput ?? null,
      distinct_authors: data.distinct_authors ?? 0,
      author_concentration: data.author_concentration ?? null,
      distinct_spec_versions: data.distinct_spec_versions ?? 0,
      latest_spec_version: data.latest_spec_version ?? null,
    };
  },

  async block({ ref }, context) {
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/blocks/${encodeURIComponent(ref)}`,
        ),
        "METAGRAPH_BLOCKS_SOURCE",
      )) ?? buildBlock(undefined, ref);
    return {
      ref: data.ref ?? ref,
      block: data.block ?? null,
      prev_block_number: data.prev_block_number ?? null,
      next_block_number: data.next_block_number ?? null,
    };
  },

  async validators({ sort, limit }, context) {
    const requestedSort = sort ?? DEFAULT_GLOBAL_VALIDATOR_SORT;
    if (!GLOBAL_VALIDATOR_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${GLOBAL_VALIDATOR_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: GLOBAL_VALIDATOR_LIMIT_DEFAULT,
      maxLimit: GLOBAL_VALIDATOR_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(safeLimit));
    const data = overlayFeaturedValidators(
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/validators", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
        buildGlobalValidators([], {
          sort: requestedSort,
          limit: safeLimit,
        }),
    );
    return {
      items: (data.validators || []).map(validatorNode),
      total: data.validator_count ?? 0,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async validator({ hotkey }, context) {
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildValidatorDetail([], hotkey);
    return validatorNode(data);
  },

  async validator_history({ hotkey, window }, context) {
    // Same parseHistoryWindow REST's handleValidatorHistory uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const { label, error } = parseHistoryWindow(window);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildValidatorHistory
    // fallback contract handleValidatorHistory uses; a hotkey with no
    // neuron_daily rows in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildValidatorHistory([], hotkey, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      hotkey: data.hotkey ?? hotkey,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async accounts({ sort, limit }, context) {
    const requestedSort = sort ?? DEFAULT_ACCOUNTS_LIST_SORT;
    if (!ACCOUNTS_LIST_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${ACCOUNTS_LIST_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: ACCOUNTS_LIST_LIMIT_DEFAULT,
      maxLimit: ACCOUNTS_LIST_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(safeLimit));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/accounts", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
      buildAccountsList([], {
        sort: requestedSort,
        limit: safeLimit,
      });
    return {
      items: data.accounts || [],
      total: data.account_count ?? 0,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async account({ ss58 }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}`,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildAccountSummary(ss58, {});
    return accountSummaryNode(data, ss58);
  },

  async account_prometheus({ ss58, window }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_PROMETHEUS_WINDOW;
    if (!Object.hasOwn(PROMETHEUS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, PROMETHEUS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // This account-footprint route's Postgres-tier body is { data, generatedAt }
    // (unlike account's own flat body) -- same shape REST's makeAccountEventHandler
    // destructures. No live D1 fallback exists for this route family (the account
    // event footprints' D1 write path is retired); a cold/absent tier degrades to
    // the pure builder over an empty row set, same as REST's own fallback.
    const pg = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/prometheus`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      pg?.data ?? buildAccountPrometheus([], ss58, { window: requestedWindow });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? requestedWindow,
      total_announcements: data.total_announcements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: data.subnets || [],
    };
  },

  async account_stake_flow({ ss58, window, direction }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_STAKE_FLOW_WINDOW;
    if (!Object.hasOwn(STAKE_FLOW_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, STAKE_FLOW_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const requestedDirection = direction ?? DEFAULT_STAKE_FLOW_DIRECTION;
    if (!STAKE_FLOW_DIRECTIONS.includes(requestedDirection)) {
      throw new GraphQLError(
        `direction must be one of: ${STAKE_FLOW_DIRECTIONS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("direction", requestedDirection);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data, generatedAt }
    // -> buildAccountStakeFlow([]) zeroed-card fallback contract handleAccountStakeFlow
    // uses. direction only narrows the live Postgres-tier query -- the fallback builder
    // takes no direction argument, so a cold/absent tier degrades to the same zeroed
    // card regardless of the requested direction.
    const pg = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/stake-flow`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      pg?.data ?? buildAccountStakeFlow([], ss58, { window: requestedWindow });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? requestedWindow,
      total_staked_tao: data.total_staked_tao ?? 0,
      total_unstaked_tao: data.total_unstaked_tao ?? 0,
      net_flow_tao: data.net_flow_tao ?? 0,
      gross_flow_tao: data.gross_flow_tao ?? 0,
      flow_ratio: data.flow_ratio ?? null,
      direction: data.direction ?? "idle",
      stake_events: data.stake_events ?? 0,
      unstake_events: data.unstake_events ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: data.subnets || [],
    };
  },

  async account_registrations({ ss58, window }, context) {
    // Same SS58 + window validation handleAccountRegistrations (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_REGISTRATION_WINDOW;
    if (!Object.hasOwn(REGISTRATION_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, REGISTRATION_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountRegistrations([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no NeuronRegistered events in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/registrations`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      tier?.data ??
      buildAccountRegistrations([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_registrations: data.total_registrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s) => ({
        netuid: s.netuid,
        registrations: s.registrations,
        first_registered_at: s.first_registered_at ?? null,
        last_registered_at: s.last_registered_at ?? null,
      })),
    };
  },

  async account_deregistrations({ ss58, window }, context) {
    // Same SS58 + window validation handleAccountDeregistrations (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_DEREGISTRATION_WINDOW;
    if (!Object.hasOwn(DEREGISTRATION_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, DEREGISTRATION_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountDeregistrations([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no NeuronDeregistered events in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/deregistrations`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      tier?.data ??
      buildAccountDeregistrations([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_deregistrations: data.total_deregistrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s) => ({
        netuid: s.netuid,
        deregistrations: s.deregistrations,
        first_deregistered_at: s.first_deregistered_at ?? null,
        last_deregistered_at: s.last_deregistered_at ?? null,
      })),
    };
  },

  async account_serving({ ss58, window }, context) {
    // Same SS58 + window validation handleAccountServing (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_SERVING_WINDOW;
    if (!Object.hasOwn(SERVING_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SERVING_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountServing([], ...) zeroed-card cold fallback) the REST
    // handler uses; an account with no AxonServed events in the window is a
    // schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/serving`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      tier?.data ?? buildAccountServing([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_announcements: data.total_announcements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s) => ({
        netuid: s.netuid,
        announcements: s.announcements,
        first_served_at: s.first_served_at ?? null,
        last_served_at: s.last_served_at ?? null,
      })),
    };
  },

  async account_axon_removals({ ss58, window }, context) {
    // Same SS58 + window validation handleAccountAxonRemovals (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_AXON_REMOVAL_WINDOW;
    if (!Object.hasOwn(AXON_REMOVAL_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, AXON_REMOVAL_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountAxonRemovals([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no AxonInfoRemoved events in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/axon-removals`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      tier?.data ?? buildAccountAxonRemovals([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_removals: data.total_removals ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s) => ({
        netuid: s.netuid,
        removals: s.removals,
        first_removed_at: s.first_removed_at ?? null,
        last_removed_at: s.last_removed_at ?? null,
      })),
    };
  },

  async account_stake_moves({ ss58, window }, context) {
    // Same SS58 + window validation handleAccountStakeMoves (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW;
    if (!Object.hasOwn(ACCOUNT_STAKE_MOVES_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, ACCOUNT_STAKE_MOVES_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountStakeMoves([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no StakeMoved events in the window is a
    // schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/stake-moves`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      tier?.data ?? buildAccountStakeMoves([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_movements: data.total_movements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s) => ({
        netuid: s.netuid,
        movements: s.movements,
        first_moved_at: s.first_moved_at ?? null,
        last_moved_at: s.last_moved_at ?? null,
        price_tao_at_last_move: s.price_tao_at_last_move ?? null,
      })),
    };
  },

  async economics_trends({ window }, context) {
    // Same parseHistoryWindow REST uses, so accepted window labels and the
    // resulting { label, days } stay identical between REST and GraphQL.
    const { label, days, error } = parseHistoryWindow(window);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same tier
    // and fallback contract REST's handleEconomicsTrends uses.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/economics/trends", params),
        "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
      )) ??
      (
        await loadEconomicsTrends(graphqlD1(context), {
          windowLabel: label,
          windowDays: days,
        })
      ).data;
    // Normalized the same way blocks/validators/accounts are (schema-stable,
    // never a GraphQL error), so a malformed/partial Postgres-tier body still
    // satisfies the non-null EconomicsTrends! contract.
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      day_count: data.day_count ?? 0,
      days: data.days || [],
    };
  },

  async subnet_movers({ window, sort, limit }, context) {
    const requestedWindow = window ?? DEFAULT_MOVERS_WINDOW;
    if (!Object.hasOwn(MOVERS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, MOVERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const requestedSort = sort ?? DEFAULT_MOVERS_SORT;
    if (!MOVERS_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${MOVERS_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const requestedLimit = limit ?? MOVERS_LIMIT_DEFAULT;
    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MOVERS_LIMIT_MAX
    ) {
      throw new GraphQLError(
        `limit must be an integer from 1 to ${MOVERS_LIMIT_MAX}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("sort", requestedSort);
    params.set("limit", String(requestedLimit));
    // Same tryPostgresTier + buildMovers([], [], ...) fallback contract REST's
    // handleSubnetMovers uses -- a cold/absent tier yields a schema-stable
    // empty leaderboard, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/subnets/movers", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
      buildMovers([], [], {
        window: requestedWindow,
        startDate: null,
        endDate: null,
        sort: requestedSort,
        limit: requestedLimit,
      });
    const network = data.network ?? {};
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      start_date: data.start_date ?? null,
      end_date: data.end_date ?? null,
      sort: data.sort ?? requestedSort,
      subnet_count: data.subnet_count ?? 0,
      network: {
        total_stake_start_tao: network.total_stake_start_tao ?? "0.000000000",
        total_stake_end_tao: network.total_stake_end_tao ?? "0.000000000",
        total_stake_delta_tao: network.total_stake_delta_tao ?? "0.000000000",
        total_emission_start_tao:
          network.total_emission_start_tao ?? "0.000000000",
        total_emission_end_tao: network.total_emission_end_tao ?? "0.000000000",
        total_emission_delta_tao:
          network.total_emission_delta_tao ?? "0.000000000",
        total_validators_start: network.total_validators_start ?? 0,
        total_validators_end: network.total_validators_end ?? 0,
        total_validators_delta: network.total_validators_delta ?? 0,
        gainers: network.gainers ?? 0,
        losers: network.losers ?? 0,
        unchanged: network.unchanged ?? 0,
      },
      movers: data.movers || [],
    };
  },

  async chain_weights({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_WEIGHTS_WINDOW;
    if (!Object.hasOwn(CHAIN_WEIGHTS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_WEIGHTS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_WEIGHTS_LIMIT_DEFAULT,
      maxLimit: CHAIN_WEIGHTS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainWeights
    // fallback contract REST's handleChainWeights uses -- a cold store yields a
    // schema-stable empty leaderboard, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/weights", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainWeights(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_WEIGHTS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_setters: 0,
        weight_sets: 0,
        sets_per_setter: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_weight_setters({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW;
    if (!Object.hasOwn(CHAIN_WEIGHT_SETTERS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_WEIGHT_SETTERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
      maxLimit: CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainWeightSetters
    // fallback contract REST's handleChainWeightSetters uses.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/weights/setters", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainWeightSetters(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_WEIGHT_SETTERS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      distinct_setters: data.distinct_setters ?? 0,
      weight_sets: data.weight_sets ?? 0,
      setter_count: data.setter_count ?? 0,
      setters: data.setters || [],
    };
  },

  async health_trends(_args, context) {
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadBulkHealthTrends
    // fallback contract REST's handleBulkHealthTrends and the get_health_trends
    // MCP tool share -- a cold store yields both windows zeroed, never a
    // GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/health/trends"),
        "METAGRAPH_HEALTH_SOURCE",
      )) ??
      (
        await loadBulkHealthTrends(graphqlD1(context), {
          observedAt: await loadObservedAt(context),
        })
      ).data;
    return {
      schema_version: data.schema_version ?? 1,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      windows: data.windows ?? {},
    };
  },

  async chain_yield(_args, context) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainYield([])
    // fallback contract handleChainYield uses -- a cold/absent tier yields a
    // schema-stable zeroed card (every aggregate null), never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/yield"),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildChainYield([]);
    const distribution = data.distribution ?? null;
    return {
      schema_version: data.schema_version ?? 1,
      subnet_count: data.subnet_count ?? 0,
      neuron_count: data.neuron_count ?? 0,
      validator_count: data.validator_count ?? 0,
      miner_count: data.miner_count ?? 0,
      captured_at: data.captured_at ?? null,
      total_stake_tao: data.total_stake_tao ?? 0,
      total_emission_tao: data.total_emission_tao ?? 0,
      network_yield: data.network_yield ?? null,
      validator_yield: data.validator_yield ?? null,
      miner_yield: data.miner_yield ?? null,
      distribution: distribution
        ? {
            count: distribution.count ?? 0,
            mean: distribution.mean ?? 0,
            median: distribution.median ?? 0,
            min: distribution.min ?? 0,
            max: distribution.max ?? 0,
            p10: distribution.p10 ?? 0,
            p25: distribution.p25 ?? 0,
            p75: distribution.p75 ?? 0,
            p90: distribution.p90 ?? 0,
          }
        : null,
    };
  },

  async subnet_recycled({ netuid }, context) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Live chain RPC, not the Postgres tier -- reuses loadSubnetRecycled's own
    // KV cache/TTL, matching REST's handleSubnetRecycled exactly. recycled_tao
    // stays null on RPC failure (schema-stable), never a GraphQL error.
    // loadSubnetRecycled always sets schema_version/netuid/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadSubnetRecycled(context.env, netuid);
  },
};

// --- Response helpers ---

const GRAPHQL_CONTENT_TYPE = "application/graphql-response+json";
const SDL_CONTENT_TYPE = "application/graphql; charset=utf-8";

const graphqlError = (message, status = 400, extraHeaders = {}) =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: graphqlHeaders(extraHeaders),
  });

const graphqlHeaders = (extra = {}) => ({
  "content-type": GRAPHQL_CONTENT_TYPE,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  ...extra,
});

// --- Handler ---

async function readLimitedJson(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) {
      return {
        error: graphqlError("Invalid Content-Length header."),
      };
    }
    if (length > GRAPHQL_MAX_BODY_BYTES) {
      return {
        error: graphqlError("GraphQL request body is too large.", 413),
      };
    }
  }

  if (!request.body) {
    return { value: null };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GRAPHQL_MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          error: graphqlError("GraphQL request body is too large.", 413),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      error: graphqlError("Request body must be valid JSON."),
    };
  }
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

// GET publishes the schema document so the shape is discoverable without a
// playground or introspection round-trip (a browser/curl GET used to 405).
// Introspection over POST stays enabled for tooling.
function sdlResponse() {
  return new Response(SDL.trim() + "\n", {
    status: 200,
    headers: graphqlHeaders({
      "content-type": SDL_CONTENT_TYPE,
      "cache-control": "public, max-age=300, stale-while-revalidate=300",
      allow: "GET, POST",
    }),
  });
}

export async function handleGraphQLRequest(request, env) {
  if (request.method === "GET") {
    return sdlResponse();
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        errors: [{ message: "GraphQL endpoint accepts GET (SDL) or POST." }],
      }),
      {
        status: 405,
        headers: graphqlHeaders({ allow: "GET, POST" }),
      },
    );
  }

  const { value: body, error: bodyError } = await readLimitedJson(request);
  if (bodyError) return bodyError;

  const { query, variables, operationName } = body || {};
  if (typeof query !== "string" || !query.trim()) {
    return new Response(
      JSON.stringify({
        errors: [{ message: "Missing required field: query." }],
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  if (utf8ByteLength(query) > GRAPHQL_MAX_QUERY_BYTES) {
    return graphqlError("GraphQL query is too large.", 413);
  }

  let document;
  try {
    document = parse(query);
  } catch (err) {
    return new Response(
      JSON.stringify({ errors: [{ message: err.message }] }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const validationErrors = validate(schema, document, [
    ...specifiedRules,
    maxDepthRule(GRAPHQL_MAX_DEPTH),
    maxComplexityRule(GRAPHQL_MAX_COMPLEXITY),
  ]);
  if (validationErrors.length > 0) {
    return new Response(
      JSON.stringify({
        errors: validationErrors.map((e) => ({
          message: e.message,
          extensions: e.extensions,
        })),
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const result = await execute({
    schema,
    document,
    rootValue,
    contextValue: { env, cache: new Map(), request },
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: graphqlHeaders({
      // A GraphQL error is a 200 with a populated `errors` array; never advertise
      // it as cacheable, or a fronting cache could pin a transient backend failure.
      "cache-control": result.errors?.length
        ? "no-store"
        : "public, max-age=60, stale-while-revalidate=300",
      vary: "Accept-Encoding",
    }),
  });
}
