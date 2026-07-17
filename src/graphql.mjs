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
  loadChainAxonRemovals,
  CHAIN_AXON_REMOVALS_WINDOWS,
  DEFAULT_CHAIN_AXON_REMOVALS_WINDOW,
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
} from "./chain-axon-removals.mjs";
import {
  loadChainDeregistrations,
  CHAIN_DEREGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW,
  CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_DEREGISTRATIONS_LIMIT_MAX,
} from "./chain-deregistrations.mjs";
import {
  loadChainRegistrations,
  CHAIN_REGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_REGISTRATIONS_LIMIT_MAX,
} from "./chain-registrations.mjs";
import {
  loadChainPrometheus,
  CHAIN_PROMETHEUS_WINDOWS,
  DEFAULT_CHAIN_PROMETHEUS_WINDOW,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
  CHAIN_PROMETHEUS_LIMIT_MAX,
} from "./chain-prometheus.mjs";
import { buildSubnetHyperparams } from "./subnet-hyperparams.mjs";
import { buildSubnetHyperparamsHistory } from "./subnet-hyperparams-history.mjs";
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
import {
  buildSubnetStakeMoves,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "./subnet-stake-moves.mjs";
import {
  buildSubnetStakeTransfers,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "./subnet-stake-transfers.mjs";
import {
  buildSubnetWeightSetters,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
} from "./subnet-weight-setters.mjs";
import { buildSubnetYield } from "./subnet-yield.mjs";
import { buildSubnetPerformance } from "./subnet-performance.mjs";
import {
  buildConcentration,
  buildConcentrationHistory,
  CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
} from "./concentration.mjs";
import {
  analyticsWindow,
  d1Runner,
  loadGlobalIncidentsLedger,
} from "../workers/request-handlers/analytics.mjs";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import { loadSubnetIdentityHistory } from "./subnet-identity-history.mjs";
import { loadChainIdentityHistory } from "./chain-identity-history.mjs";
import {
  buildGlobalHealth,
  formatLeaderboards,
  LEADERBOARD_BOARDS,
  loadSubnetTrajectory,
  resolveLiveEconomics,
  resolveLiveHealth,
  subnetBadgeStatus,
} from "./health-serving.mjs";
import { composeLeaderboardsData } from "../workers/request-handlers/analytics-routes.mjs";
import {
  loadCompareSubnets,
  loadSubnetHealthTrends,
  loadSubnetUptime,
  loadSubnetIncidents,
  parseCompareDimensionList,
  parseCompareNetuidList,
  parseUptimeWindow,
} from "./analytics-live.mjs";
import { UPTIME_WINDOWS } from "../workers/config.mjs";
import {
  buildAccountExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
} from "./extrinsics.mjs";
import { buildBlock, buildBlockFeed } from "./blocks.mjs";
import { buildBlocksSummary } from "./blocks-summary.mjs";
import { buildRuntimeVersionHistory } from "./runtime-versions.mjs";
import { buildChainYield } from "./chain-yield.mjs";
import { loadSubnetRecycled, isU16Netuid } from "./subnet-recycled.mjs";
import { loadAccountBalance, isFinneySs58Address } from "./account-balance.mjs";
import { loadSudoKey } from "./sudo-key.mjs";
import {
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  GLOBAL_VALIDATOR_SORTS,
  buildGlobalValidators,
  buildNeuronDetail,
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
import {
  buildAccountEvents,
  buildAccountSubnets,
  buildAccountSummary,
  buildAccountTransfers,
  loadAccountHistory,
} from "./account-events.mjs";
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
import { buildAccountPositionHistory } from "./account-position-history.mjs";
import {
  DEFAULT_STAKE_FLOW_DIRECTION,
  STAKE_FLOW_DIRECTIONS,
} from "./stake-flow.mjs";
import { buildAccountPortfolio } from "./account-portfolio.mjs";
import { buildAccountPositions } from "./account-nominator-positions.mjs";
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
import { loadAccountIdentity } from "./account-identity.mjs";
import { loadAccountIdentityHistory } from "./account-identity-history.mjs";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
} from "./counterparties.mjs";
import { KV_HEALTH_META } from "./kv-keys.mjs";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  SS58_ADDRESS_PATTERN,
} from "../workers/config.mjs";
import { loadRpcUsage } from "./rpc-usage-loader.mjs";
import {
  loadChainSigners,
  CHAIN_SIGNERS_SORTS,
  CHAIN_SIGNERS_LIMIT_DEFAULT,
  CHAIN_SIGNERS_LIMIT_MAX,
} from "./chain-query-loaders.mjs";
import {
  buildNeuronHistory,
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
  CHAIN_SERVING_LIMIT_DEFAULT,
  CHAIN_SERVING_LIMIT_MAX,
  CHAIN_SERVING_WINDOWS,
  DEFAULT_CHAIN_SERVING_WINDOW,
  loadChainServing,
} from "./chain-serving.mjs";
import {
  buildChainTurnover,
  CHAIN_TURNOVER_LIMIT_DEFAULT,
  CHAIN_TURNOVER_LIMIT_MAX,
  CHAIN_TURNOVER_WINDOWS,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
} from "./chain-turnover.mjs";
import { buildTurnover } from "./turnover.mjs";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
} from "./chain-analytics.mjs";
import { buildChainPerformance } from "./chain-performance.mjs";
import { buildChainConcentration } from "./concentration.mjs";
import {
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  loadValidatorNominators,
  NOMINATOR_SORTS,
  NOMINATOR_WINDOWS,
} from "./validator-nominators.mjs";
import {
  CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
  CHAIN_ALPHA_VOLUME_LIMIT_MAX,
  loadChainAlphaVolume,
} from "./chain-alpha-volume.mjs";
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
    subnets(netuid: Int, status: String, subnet_type: String, domain: String, coverage_level: String, curation_level: String, limit: Int, cursor: String): SubnetList!
    "One subnet with its health, surfaces, endpoints, and economics."
    subnet(netuid: Int!): Subnet
    "Per-subnet neuron-registration activity over a 7d/30d window (distinct registrants, NeuronRegistered count, and registrations per registrant); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/registrations."
    subnet_registrations(netuid: Int!, window: String): SubnetRegistrations!
    "One subnet's live on-chain hyperparameters (latest snapshot only). The hyperparameters block is null when the subnet has no captured row -- a schema-stable card, never a GraphQL error, matching the Query.block ref-lookup convention. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters."
    subnet_hyperparameters(netuid: Int!): SubnetHyperparameters
    "One subnet's append-only hyperparameter-change history, newest first, one entry per observed change. Forward-only: entries exist only from when the diff-on-change write started. A subnet with no recorded changes resolves to an empty entry list, never null. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters/history."
    subnet_hyperparameters_history(netuid: Int!, limit: Int, offset: Int): SubnetHyperparamsHistory!
    "Per-subnet neuron-deregistration activity over a 7d/30d window (distinct deregistered hotkeys, NeuronDeregistered count, and deregistrations per hotkey); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/deregistrations."
    subnet_deregistrations(netuid: Int!, window: String): SubnetDeregistrations!
    "Per-subnet axon-serving activity over a 7d/30d window (distinct servers, AxonServed announcement count, and announcements per server); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/serving."
    subnet_serving(netuid: Int!, window: String): SubnetServing!
    "One subnet's uptime + success-only latency trend windows (7d/30d) from the live health-probe history: per-window samples, uptime_ratio, latency sample count, and the per-surface uptime/latency series. A subnet with no probe history resolves to a schema-stable zeroed-windows card, never null. Mirrors GET /api/v1/subnets/{netuid}/health/trends."
    subnet_health_trends(netuid: Int!): SubnetHealthTrends!
    "One subnet's long-term daily uptime history for its operational surfaces from the live surface_uptime_daily rollup: per-surface day series, window-wide uptime ratios, and reliability scores for the requested window (90d or 1y, default 90d). Optional min_samples drops day rows whose daily probe count is below the threshold (including zero-sample 'unknown' days). A subnet with no history resolves to a schema-stable empty card (surfaces []), never null. Mirrors GET /api/v1/subnets/{netuid}/uptime."
    subnet_uptime(netuid: Int!, window: String, min_samples: Int): SubnetUptime!
    "One subnet's per-surface SLA (uptime ratio) and reconstructed downtime incidents over a 7d/30d window (default 7d), computed live from the health-probe history: each surface's sample count, uptime_ratio, incident_count, total downtime_ms, and the gap-island incident list. A subnet with no probe history resolves to a schema-stable empty surfaces list, never null. Mirrors GET /api/v1/subnets/{netuid}/health/incidents."
    subnet_health_incidents(netuid: Int!, window: String): SubnetHealthIncidents!
    "Per-subnet axon-removal activity over a 7d/30d window (distinct removers, AxonInfoRemoved count, and removals per remover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/axon-removals."
    subnet_axon_removals(netuid: Int!, window: String): SubnetAxonRemovals!
    "Per-subnet validator weight-setting activity over a 7d/30d window (distinct weight-setters, WeightsSet count, and sets per setter); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/weights."
    subnet_weights(netuid: Int!, window: String): SubnetWeights!
    "Per-subnet stake-movement (re-delegation) activity over a 7d/30d window (distinct movers, StakeMoved count, and movements per mover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-moves."
    subnet_stake_moves(netuid: Int!, window: String): SubnetStakeMoves!
    "Per-subnet stake-transfer activity over a 7d/30d window (distinct senders, StakeTransferred count, and transfers per sender); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-transfers."
    subnet_stake_transfers(netuid: Int!, window: String): SubnetStakeTransfers!
    "Per-subnet weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators behind /weights ranked by WeightsSet activity, each with count, share, and first/last set times; a subnet with no events resolves to a schema-stable empty leaderboard, never null. Mirrors GET /api/v1/subnets/{netuid}/weights/setters."
    subnet_weight_setters(netuid: Int!, window: String): SubnetWeightSetters!
    "Per-subnet emission-per-stake yield over the current metagraph snapshot: each UID's yield plus the subnet-wide aggregate and p25/median/p75/p90 distribution; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/yield."
    subnet_yield(netuid: Int!): SubnetYield!
    "Per-subnet reward-distribution and score-spread card over the current neurons snapshot: incentive/dividends concentration plus p10–p90 trust/consensus/validator_trust; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/performance."
    subnet_performance(netuid: Int!): SubnetPerformance!
    "Per-subnet stake and emission concentration over the current neurons snapshot: raw-UID and per-entity Gini/HHI/Nakamoto/top-K share for stake and emission, validator-only stake concentration, and a uids-per-entity Sybil signal; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration."
    subnet_concentration(netuid: Int!): SubnetConcentration!
    "Per-subnet per-day stake and emission concentration trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's stake/emission Gini, Nakamoto coefficient, and top-10% share, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration/history."
    subnet_concentration_history(netuid: Int!, window: String): SubnetConcentrationHistory!
    "One neuron in a subnet by UID: hot/cold keys, stake, rank, trust, consensus, incentive, dividends, emission, validator permit, immunity, axon, and take. The nested neuron field is null when that UID is absent from the latest snapshot -- a schema-stable card, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}."
    neuron(netuid: Int!, uid: Int!): Neuron!
    "One neuron's per-day metagraph history in a subnet by UID from the neuron_daily rollup (window: 7d/30d/90d/1y/all, default 30d), newest first: stake, rank, trust, consensus, incentive, dividends, emission, validator permit, and axon per snapshot_date. A UID with no matching rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history."
    neuron_history(netuid: Int!, uid: Int!, window: String): NeuronHistory!
    "Append-only on-chain SubnetIdentitiesV3 change timeline for one subnet (name, symbol, description, repo, website, discord, logo), newest first; page with limit/offset or follow next_cursor. A subnet with no matching events resolves to a schema-stable empty timeline (entry_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/identity-history."
    subnet_identity_history(netuid: Int!, limit: Int, offset: Int, cursor: String): SubnetIdentityHistory!
    "One subnet's weekly structural + economics trajectory from the daily snapshots: a chronological series of points (completeness/surface/endpoint counts plus validator/miner counts and economics — stake, alpha price, emission share, pool reserves, volume), and the latest-vs-window-ago deltas for the 7d and 30d windows. A subnet with no snapshots resolves to a schema-stable empty trajectory (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/trajectory."
    subnet_trajectory(netuid: Int!): SubnetTrajectory!
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
    "Subtensor's root-origin hyperparameter/network-config change feed (newest first) -- the extrinsics feed fixed to call_module=AdminUtils, so it takes no signer/call_module filter. Same ExtrinsicList shape as extrinsics. Mirrors GET /api/v1/governance/config-changes."
    governance_config_changes(limit: Int, offset: Int, cursor: String, block: Int, call_function: String, success: Boolean): ExtrinsicList!
    "Recent-block feed (newest first). Mirrors GET /api/v1/blocks."
    blocks(limit: Int, offset: Int, cursor: String): BlockList!
    "One block by numeric height or 0x block hash; block is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/{ref}."
    block(ref: String!): BlockDetail
    "Block-production summary over the recent-block window -- counts, inter-block timing, throughput, and author-concentration. Every aggregate is null (never a GraphQL error) when the retired-D1 store is cold. Mirrors GET /api/v1/blocks/summary."
    blocks_summary: BlocksSummary!
    "Site-wide runtime spec-version transition timeline: the earliest known block at each distinct spec_version observed (ascending), the current spec_version, and where coverage starts. The empty shape (transition_count 0, current_spec_version null) is schema-stable, never a GraphQL error, when the store has no reading yet. Mirrors GET /api/v1/runtime."
    runtime: RuntimeVersionHistory!
    "Network-wide validator/operator leaderboard, grouped by hotkey across every subnet it operates in. Mirrors GET /api/v1/validators."
    validators(sort: String, limit: Int): ValidatorList!
    "One validator's cross-subnet aggregate by hotkey; a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null. Mirrors GET /api/v1/validators/{hotkey}."
    validator(hotkey: String!): Validator
    "One validator's nominator leaderboard over a 7d/30d/90d window (default 30d): every coldkey that staked to or unstaked from this hotkey in the window, with its staked/unstaked/net/gross TAO, event count, and last-activity time, ranked by sort (net_staked | gross_staked | last_activity, default net_staked). An unsupported window/sort is a GraphQL error, not a silently substituted default; a hotkey with no nominators resolves to a schema-stable empty list, never null and never a GraphQL error. Mirrors GET /api/v1/validators/{hotkey}/nominators."
    validator_nominators(hotkey: String!, window: String, sort: String): NominatorList!
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
    "One account's per-subnet position (uid/role/active plus stake/emission/rank/trust/incentive/dividends/yield) day-by-day over a 7d/30d/90d/1y/all window (default 30d), newest first, one point per neuron_daily snapshot. An account with no rows for the subnet in the window resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history."
    account_position_history(ss58: String!, netuid: Int!, window: String): AccountPositionHistory!
    "One wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a registered neuron, each position's economics (stake, emission, rank, trust, incentive, dividends, role) and emission/stake yield, plus wallet-level aggregates (totals, counts, overall return, stake concentration). Richer than account.registrations (registration footprint only). An address with no registered neurons resolves to a schema-stable empty card, never null. Mirrors GET /api/v1/accounts/{ss58}/portfolio."
    account_portfolio(ss58: String!): AccountPortfolio!
    "This account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from account_portfolio's hotkey-scoped view (a pure delegator shows near-zero there since its stake lives on someone ELSE's hotkey row). Root (netuid 0) stake is not covered -- root has no alpha pool, so an address that only holds root-delegated stake resolves to a schema-stable empty positions[], never null. Mirrors GET /api/v1/accounts/{ss58}/positions."
    account_positions(ss58: String!): AccountPositions!
    "One account's live cross-subnet footprint: every subnet where the hotkey is currently registered as a neuron, each with its netuid, uid, stake, validator-permit and active flag, plus a subnet_count. The registration snapshot only (netuid/uid/stake/permit/active) -- account_portfolio is the richer economics view over the same neurons. An unregistered or never-seen address resolves to a schema-stable empty footprint (subnet_count 0, subnets []), never null. Mirrors GET /api/v1/accounts/{ss58}/subnets."
    account_subnets(ss58: String!): AccountSubnets!
    "One account's per-subnet axon-serving footprint over a 7d/30d/90d window (default 30d): AxonServed announcement count and first/last timestamps per subnet, an HHI concentration of where its serving activity is focused, and the dominant subnet; an address with no announcements in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/serving."
    account_serving(ss58: String!, window: String): AccountServing!
    "One account's per-subnet axon-removal footprint over a 7d/30d/90d window (default 30d): AxonInfoRemoved count and first/last timestamps per subnet, an HHI concentration of where its teardown activity is focused, and the dominant subnet; an address with no removals in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/axon-removals."
    account_axon_removals(ss58: String!, window: String): AccountAxonRemovals!
    "One account's per-subnet StakeMoved footprint over a 7d/30d/90d window (default 30d): movement count, first/last timestamps, and the alpha price (TAO) at its most recent move per subnet, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet; an address with no moves in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-moves."
    account_stake_moves(ss58: String!, window: String): AccountStakeMoves!
    "One account's on-chain identity (its latest set_identity values, sanitized at serve time). has_identity is false with every field null for an account that never set one -- the common case, so this is a schema-stable card, never null and never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/identity."
    account_identity(ss58: String!): AccountIdentity!
    "One account's on-chain identity change history, newest first -- an append-only diff-tracking timeline (name/url/github/image/discord/description/additional plus a stable hash per entry). Page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no identity-history rows resolves to a schema-stable empty timeline, never null. Mirrors GET /api/v1/accounts/{ss58}/identity-history."
    account_identity_history(ss58: String!, limit: Int, offset: Int, cursor: String): AccountIdentityHistory!
    "Rank who one account transacts native TAO with, by total transfer volume, from the Balances.Transfer feed: per counterparty the sent/received/net TAO, transfer count, and last block, plus scan totals. Pass counterparty=<ss58> (must differ from ss58) to drill into a single relationship instead -- its fund-flow totals plus direction-aware transfer evidence under relationship, newest first. limit caps the ranked list (default 20) or the relationship's transfer evidence (default 50); 1-100. An address with no transfers resolves to a schema-stable zero card, never null. Mirrors GET /api/v1/accounts/{ss58}/counterparties."
    account_counterparties(ss58: String!, counterparty: String, limit: Int): AccountCounterparties!
    "One account's native-TAO transfer feed from the Balances.Transfer event stream, newest first -- each event's block/index, from/to, amount_tao, a direction relative to the queried address (sent = it paid, received = it was paid), and observed_at. direction narrows to sent | received only (default both); block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no transfers resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/transfers."
    account_transfers(ss58: String!, limit: Int, offset: Int, cursor: String, direction: String, block_start: Int, block_end: Int): AccountTransfers!
    "One account's signed-extrinsic feed, newest first -- the extrinsics whose signer is this address (matched by signer only, not the hotkey/coldkey union account_events uses), each carrying its block/index, hash, call_module/call_function, decoded call_args, success flag, fee and tip. block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). extrinsic_count is the page count, not a grand total. An address that signed nothing resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/extrinsics."
    account_extrinsics(ss58: String!, limit: Int, offset: Int, cursor: String, block_start: Int, block_end: Int): AccountExtrinsics!
    "One account's first-party chain-event feed, newest first -- every event where this address is the hotkey OR coldkey (the union account_extrinsics does not use), each carrying its block/event index, event_kind, hotkey/coldkey, netuid/uid, amount_tao/alpha_amount, extrinsic_index and observed_at. kind filters to one event kind (e.g. StakeAdded, NeuronRegistered, AxonServed, WeightsSet); netuid scopes to one subnet; block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). event_count is the page count, not a grand total. An address with no matching events resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/events."
    account_events(ss58: String!, kind: String, netuid: Int, block_start: Int, block_end: Int, limit: Int, offset: Int, cursor: String): AccountEvents!
    "One account's durable per-day activity series from the hotkey-keyed account_events_daily rollup, newest day first -- each day's netuid, event_count, event_kinds, and first/last block. netuid filters to one subnet; from/to are YYYY-MM-DD bounds; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). day_count is the page count, not a grand total. Note: the rollup is hotkey-attributed only -- a coldkey-only address returns zero days even when account_events shows activity. An address with no matching days resolves to a schema-stable empty series, never null. Mirrors GET /api/v1/accounts/{ss58}/history."
    account_history(ss58: String!, netuid: Int, from: String, to: String, limit: Int, offset: Int, cursor: String): AccountHistory!
    "Network-wide economics time series, aggregated per UTC day across all subnets; day_count is 0 and days is empty on a cold rollup, never null. Mirrors GET /api/v1/economics/trends."
    economics_trends(window: String): EconomicsTrends!
    "Registry leaderboards: the operational boards (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable) and the economic-opportunity boards (open-slots, cheapest-registration, highest-emission, validator-headroom), composed live from the registry profiles projection plus D1 health/rpc/growth/reliability rows and the economics tier. Pass board to return just that board (default: every board); limit caps each board's entries (default 20, max 100). An unknown board is a BAD_USER_INPUT error, matching REST's invalid_query 400. Mirrors GET /api/v1/registry/leaderboards."
    registry_leaderboards(board: String, limit: Int): RegistryLeaderboards!
    "Cross-subnet momentum leaderboard: every subnet ranked by its stake/emission/validator change between a window's start and end snapshots; movers is empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/subnets/movers."
    subnet_movers(window: String, sort: String, limit: Int): SubnetMovers!
    "Network-wide validator-set churn across all subnets over a 7d/30d/90d window (default 30d): every subnet ranked by gross validator churn (entered + exited) between the window's start and end snapshots, each with its retention and 0-100 stability score, plus a network rollup and the network-wide stability spread. neuron_daily-derived; comparable is false and the leaderboard empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/chain/turnover."
    chain_turnover(window: String, limit: Int): ChainTurnover!
    "Network-wide identity-change feed: the most-recent SubnetIdentitiesV3 changes across every subnet (each entry carries its netuid), newest first, capped by limit; a cold/absent store resolves to a schema-stable empty feed (count 0), never null. Mirrors GET /api/v1/chain/identity-history."
    chain_identity_history(limit: Int): ChainIdentityHistory!
    "Network-wide validator weight-setting activity leaderboard over a 7d/30d window (default 7d): subnets ranked by WeightsSet events with each's distinct-setter count and sets-per-setter update intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. Mirrors GET /api/v1/chain/weights."
    chain_weights(window: String, limit: Int): ChainWeights!
    "Network-wide axon-serving announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonServed announcements with each's distinct-server count and announcements-per-server re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide counterpart of subnet_serving. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/serving."
    chain_serving(window: String, limit: Int): ChainServing!
    "Extrinsic call-mix breakdown over a 7d/30d window (default 7d): the extrinsic count and share per call_module, or per call_module+call_function when group_by is module_function (default module), optionally scoped to a single call_module, ranked by count (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty breakdown, never a GraphQL error. Mirrors GET /api/v1/chain/calls."
    chain_calls(window: String, group_by: String, limit: Int, call_module: String): ChainCalls!
    "Network-wide Prometheus telemetry-endpoint announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by PrometheusServed announcements with each's distinct-exporter count and announcements-per-exporter re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The telemetry-endpoint companion to chain_serving's axon endpoints -- which subnets run observability infrastructure. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/prometheus."
    chain_prometheus(window: String, limit: Int): ChainPrometheus!
    "Network-wide neuron-deregistration leaderboard over a 7d/30d window (default 7d): subnets ranked by NeuronDeregistered events with each's distinct-hotkey count and deregistrations-per-hotkey churn intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide, exit-side counterpart of subnet_deregistrations -- where neurons are being pushed out. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/deregistrations."
    chain_deregistrations(window: String, limit: Int): ChainDeregistrations!
    "Network-wide neuron-registration leaderboard over a 7d/30d window (default 7d): subnets ranked by NeuronRegistered events with each's distinct-hotkey count and registrations-per-registrant re-registration intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide, entry-side counterpart of subnet_registrations -- where neurons are joining. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/registrations."
    chain_registrations(window: String, limit: Int): ChainRegistrations!
    "Per-UTC-day network fee/tip series over a 7d/30d window (default 7d): each day's extrinsic count and total/avg/median fee + tip in TAO, plus the top fee-paying signers (limit default 25, max 100), optionally scoped to a single call_module. Computed live from the extrinsics tier; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/fees."
    chain_fees(window: String, limit: Int, call_module: String): ChainFees!
    "Per-UTC-day network activity series over a 7d/30d window (default 7d): each UTC day's block count, extrinsic count (with its successful-extrinsic count and success rate), on-chain event count, and distinct signer count, newest day first. Computed live from the extrinsics/blocks tiers; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/activity."
    chain_activity(window: String): ChainActivity!
    "Network-wide axon-removal (teardown) leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonInfoRemoved events with each's distinct-remover count and removals-per-remover teardown intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The teardown counterpart of chain_serving's announcements -- where neurons are tearing endpoints down. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/axon-removals."
    chain_axon_removals(window: String, limit: Int): ChainAxonRemovals!
    "Network-wide weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators driving consensus network-wide, each with its total WeightsSet count, share of the network total, and first/last set times, ranked by activity. The setter-level drill-in behind chain_weights. Mirrors GET /api/v1/chain/weights/setters."
    chain_weight_setters(window: String, limit: Int): ChainWeightSetters!
    "Most-active signer leaderboard over a 7d/30d window (default 7d): the accounts submitting the most extrinsics, each with its extrinsic count, total fees and tips paid in TAO, and last-seen block. Rank by tx_count (default) or total_fee_tao, optionally scoped to a single call_module pallet (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty leaderboard, never a GraphQL error. Mirrors GET /api/v1/chain/signers."
    chain_signers(window: String, limit: Int, sort: String, call_module: String): ChainSigners!
    "Compact all-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history (probed every ~15 minutes); a cold store still returns both windows, schema-stable and zeroed, never a GraphQL error. Mirrors GET /api/v1/health/trends."
    health_trends: HealthTrends!
    "RPC reverse-proxy usage analytics over a 7d/30d window (default 7d): total request volume, error + failover rates, cache-hit rate, latency p50/p95/avg, the per-endpoint and per-network request distribution, and bounded time buckets (1h for 7d, 6h for 30d), computed live from the rpc_proxy_events telemetry. A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/rpc/usage."
    rpc_usage(window: String): RpcUsage!
    "Network-wide reward-distribution & score-spread card across every subnet's neurons: incentive/dividends concentration (who actually captures rewards network-wide) plus the trust/consensus/validator_trust score spread. Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet_performance. Mirrors GET /api/v1/chain/performance."
    chain_performance: ChainPerformance!
    "Network-wide emission-yield (return rate) aggregated across every subnet's neurons -- the aggregate network return, the same split by validator vs miner role, and the distribution of the per-neuron return rate. Every aggregate is null (never a GraphQL error) on a cold store. Mirrors GET /api/v1/chain/yield."
    chain_yield: ChainYield!
    "Network-wide stake & emission decentralization across every subnet's neurons at once: the raw stake/emission distribution, the same two lenses collapsed per controlling entity (an operator running hotkeys in ten subnets counts once, not ten times), and the permitted-validator stake distribution -- each as gini/HHI/Nakamoto/top-share/entropy. uids_per_entity is the network consolidation signal (1.0 = every UID a distinct owner). Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet concentration. Mirrors GET /api/v1/chain/concentration."
    chain_concentration: ChainConcentration!
    "Network-wide rolling 24h buy/sell alpha-volume leaderboard: every subnet with StakeAdded (buy) or StakeRemoved (sell) volume in the last 24h ranked by total_volume_tao, each carrying its full buy/sell/total volume + sentiment scorecard (vol_mcap_ratio always null here -- no per-subnet market-cap input at the network level), plus a network rollup with its own net/gross sentiment reading and the per-subnet total-volume spread, summed live from the account_events stream. Fixed 24h window (no window arg); limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/alpha-volume."
    chain_alpha_volume(limit: Int): ChainAlphaVolume!
    "Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC (not the Postgres tier). recycled_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/recycled."
    subnet_recycled(netuid: Int!): SubnetRecycled
    "One subnet's validator/neuron-set turnover (entered/exited/retention/0-100 stability) between the boundary snapshots of a 7d/30d/90d/1y/all window (default 30d), from neuron_daily. comparable is false and the churn metrics zeroed on a single-snapshot or cold store, never null. Mirrors GET /api/v1/subnets/{netuid}/turnover."
    subnet_turnover(netuid: Int!, window: String): SubnetTurnover!
    "Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached, not the Postgres tier). balance_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/balance."
    account_balance(ss58: String!): AccountBalance
    "The network's on-chain sudo (superuser) key hotkey, read live from chain via RPC (not the Postgres tier). hotkey is null on RPC failure or a renounced sudo, schema-stable, never a GraphQL error. Mirrors GET /api/v1/sudo/key."
    sudo_key: SudoKey
    "Recent Sudo-pallet extrinsic feed (newest first): the chain's superuser governance calls, the same shape as the extrinsics feed with call_module fixed to Sudo (so no signer/call_module args). Mirrors GET /api/v1/sudo."
    sudo(limit: Int, offset: Int, cursor: String, block: Int, call_function: String, success: Boolean): ExtrinsicList!
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

  "One row of the extrinsic call-mix breakdown -- a call_module (plus call_function when group_by=module_function), its extrinsic count over the window, and its share of the window total (null when the window has no extrinsics)."
  type ChainCall {
    call_module: String!
    call_function: String
    count: Int!
    share: Float
  }

  "Extrinsic call-mix breakdown over the window. Mirrors GET /api/v1/chain/calls's data envelope."
  type ChainCalls {
    schema_version: Int!
    window: String!
    group_by: String!
    observed_at: String
    total_extrinsics: Int!
    call_count: Int!
    calls: [ChainCall!]!
  }

  "One UTC day's network activity: block/extrinsic/event counts, the successful-extrinsic count and its success rate (null on a zero-extrinsic day), and the distinct signer count."
  type ChainActivityDay {
    day: String!
    block_count: Int!
    extrinsic_count: Int!
    event_count: Int!
    successful_extrinsics: Int!
    success_rate: Float
    unique_signers: Int!
  }

  "Per-UTC-day network activity series (blocks, extrinsics, events, signers) over the window, newest day first. Mirrors GET /api/v1/chain/activity's data envelope."
  type ChainActivity {
    schema_version: Int!
    window: String!
    observed_at: String
    day_count: Int!
    days: [ChainActivityDay!]!
  }

  "One UTC day's fee/tip aggregate: extrinsic count, total/avg/median fee and tip in TAO (avg/median are null on a zero-extrinsic day)."
  type ChainFeesDay {
    day: String!
    extrinsic_count: Int!
    total_fee_tao: Float
    avg_fee_tao: Float
    median_fee_tao: Float
    total_tip_tao: Float
    avg_tip_tao: Float
    median_tip_tao: Float
  }

  "One top fee-paying signer over the window, with its total fee/tip and extrinsic count."
  type ChainFeePayer {
    signer: String!
    total_fee_tao: Float
    total_tip_tao: Float
    extrinsic_count: Int!
  }

  "Per-UTC-day network fee/tip series plus the top fee payers over the window. Mirrors GET /api/v1/chain/fees's data envelope."
  type ChainFees {
    schema_version: Int!
    window: String!
    observed_at: String
    day_count: Int!
    daily: [ChainFeesDay!]!
    top_fee_payers: [ChainFeePayer!]!
  }

  "Network-wide validator-set churn across all subnets (#5686). Mirrors GET /api/v1/chain/turnover's data envelope."
  type ChainTurnover {
    schema_version: Int!
    window: String
    "Start snapshot date; null on a cold store."
    start_date: String
    "End snapshot date; null on a cold store."
    end_date: String
    "False when the window resolved to fewer than two distinct snapshots, so start/end churn is not measurable."
    comparable: Boolean!
    subnet_count: Int!
    network: ChainTurnoverNetwork!
    "Null when no subnet had a stability score in the window (nothing to distribute)."
    stability_distribution: ChainTurnoverStabilityDistribution
    subnets: [ChainTurnoverSubnet!]!
  }

  "Network-wide validator-set rollup: every subnet's validators combined, deduplicated across the network."
  type ChainTurnoverNetwork {
    validators_start: Int!
    validators_end: Int!
    validators_entered: Int!
    validators_exited: Int!
    "Jaccard retention of the start set into the end set; null on a cold/non-comparable window."
    validator_retention: Float
    "0-100 stability score; null on a cold/non-comparable window."
    stability_score: Float
  }

  "Spread of per-subnet stability score across EVERY subnet in the window (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard)."
  type ChainTurnoverStabilityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's validator-set churn, ranked by gross churn (entered + exited) then netuid."
  type ChainTurnoverSubnet {
    netuid: Int!
    validators_start: Int!
    validators_end: Int!
    validators_entered: Int!
    validators_exited: Int!
    validator_retention: Float
    stability_score: Float
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

  "Network-wide axon-serving announcement leaderboard (#5873). The network-wide counterpart of subnet_serving. Mirrors GET /api/v1/chain/serving's data envelope."
  type ChainServing {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainServingNetwork!
    intensity_distribution: ChainServingIntensityDistribution
    subnets: [ChainServingSubnet!]!
  }

  "Network-wide axon-serving rollup: every subnet with AxonServed announcements in the window, combined."
  type ChainServingNetwork {
    distinct_servers: Int!
    announcements: Int!
    "Null when distinct_servers is 0 (no defined intensity without servers)."
    announcements_per_server: Float
  }

  "Spread of per-subnet re-announcement intensity (AxonServed events per server) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard."
  type ChainServingIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's axon-serving activity in the window, ranked by announcements."
  type ChainServingSubnet {
    netuid: Int!
    distinct_servers: Int!
    announcements: Int!
    announcements_per_server: Float
  }

  type ChainAxonRemovals {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainAxonRemovalsNetwork!
    intensity_distribution: ChainAxonRemovalsIntensityDistribution
    subnets: [ChainAxonRemovalsSubnet!]!
  }

  "Network-wide axon-removal rollup: every subnet with AxonInfoRemoved events in the window, combined. distinct_removers counts a hotkey once even when it tears endpoints down on several subnets, so it is NOT the sum of the per-subnet counts."
  type ChainAxonRemovalsNetwork {
    distinct_removers: Int!
    removals: Int!
    "Null when distinct_removers is 0 (no defined intensity without removers)."
    removals_per_remover: Float
  }

  "Spread of per-subnet teardown intensity (AxonInfoRemoved events per remover) across EVERY subnet with removals in the window -- network-wide even when limit truncates the leaderboard."
  type ChainAxonRemovalsIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's axon-removal activity in the window, ranked by removals."
  type ChainAxonRemovalsSubnet {
    netuid: Int!
    distinct_removers: Int!
    removals: Int!
    removals_per_remover: Float
  }

  type ChainRegistrations {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainRegistrationsNetwork!
    intensity_distribution: ChainRegistrationsIntensityDistribution
    subnets: [ChainRegistrationsSubnet!]!
  }

  "Network-wide registration rollup: every subnet with NeuronRegistered events in the window, combined. distinct_registrants counts a hotkey once even when it registers on several subnets, so it is NOT the sum of the per-subnet counts."
  type ChainRegistrationsNetwork {
    distinct_registrants: Int!
    registrations: Int!
    "Null when distinct_registrants is 0 (no defined intensity without hotkeys)."
    registrations_per_registrant: Float
  }

  "Spread of per-subnet registration intensity (NeuronRegistered events per hotkey) across EVERY subnet with registrations in the window -- network-wide even when limit truncates the leaderboard."
  type ChainRegistrationsIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's neuron-registration activity in the window, ranked by registrations."
  type ChainRegistrationsSubnet {
    netuid: Int!
    distinct_registrants: Int!
    registrations: Int!
    registrations_per_registrant: Float
  }

  type ChainDeregistrations {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainDeregistrationsNetwork!
    intensity_distribution: ChainDeregistrationsIntensityDistribution
    subnets: [ChainDeregistrationsSubnet!]!
  }

  "Network-wide deregistration rollup: every subnet with NeuronDeregistered events in the window, combined. distinct_deregistered_hotkeys counts a hotkey once even when it is deregistered from several subnets, so it is NOT the sum of the per-subnet counts."
  type ChainDeregistrationsNetwork {
    distinct_deregistered_hotkeys: Int!
    deregistrations: Int!
    "Null when distinct_deregistered_hotkeys is 0 (no defined intensity without hotkeys)."
    deregistrations_per_hotkey: Float
  }

  "Spread of per-subnet churn intensity (NeuronDeregistered events per hotkey) across EVERY subnet with deregistrations in the window -- network-wide even when limit truncates the leaderboard."
  type ChainDeregistrationsIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's neuron-deregistration activity in the window, ranked by deregistrations."
  type ChainDeregistrationsSubnet {
    netuid: Int!
    distinct_deregistered_hotkeys: Int!
    deregistrations: Int!
    deregistrations_per_hotkey: Float
  }

  type ChainPrometheus {
    schema_version: Int!
    window: String
    observed_at: String
    subnet_count: Int!
    network: ChainPrometheusNetwork!
    intensity_distribution: ChainPrometheusIntensityDistribution
    subnets: [ChainPrometheusSubnet!]!
  }

  "Network-wide Prometheus-serving rollup: every subnet with PrometheusServed announcements in the window, combined. distinct_exporters counts a hotkey once even when it announces on several subnets, so it is NOT the sum of the per-subnet counts."
  type ChainPrometheusNetwork {
    distinct_exporters: Int!
    announcements: Int!
    "Null when distinct_exporters is 0 (no defined intensity without exporters)."
    announcements_per_exporter: Float
  }

  "Spread of per-subnet re-announcement intensity (PrometheusServed events per exporter) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard."
  type ChainPrometheusIntensityDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's Prometheus telemetry-serving activity in the window, ranked by announcements."
  type ChainPrometheusSubnet {
    netuid: Int!
    distinct_exporters: Int!
    announcements: Int!
    announcements_per_exporter: Float
  }

  "Network-wide rolling 24h buy/sell alpha-volume leaderboard, summed live from the account_events StakeAdded/StakeRemoved stream. Mirrors GET /api/v1/chain/alpha-volume's data envelope."
  type ChainAlphaVolume {
    schema_version: Int!
    "Fixed rolling window label (always 24h)."
    window: String
    "Newest event observed_at across the window; null on a cold store."
    observed_at: String
    subnet_count: Int!
    network: ChainAlphaVolumeNetwork!
    "Spread of per-subnet total_volume_tao across every subnet with volume; null when no subnet had volume."
    volume_distribution: ChainAlphaVolumeDistribution
    subnets: [ChainAlphaVolumeSubnet!]!
  }

  "Network-wide buy/sell volume rollup across every subnet with volume in the window."
  type ChainAlphaVolumeNetwork {
    buy_volume_alpha: Float!
    sell_volume_alpha: Float!
    total_volume_alpha: Float!
    buy_volume_tao: Float!
    sell_volume_tao: Float!
    total_volume_tao: Float!
    buy_count: Int!
    sell_count: Int!
    net_volume_alpha: Float!
    "net/gross alpha lean in [-1, 1]; null when there was no volume in the window."
    sentiment_ratio: Float
    "Coarse sentiment label (bullish/bearish/neutral); neutral both for balanced volume and an empty window."
    sentiment: String!
  }

  "Spread of per-subnet total_volume_tao across EVERY subnet with volume (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard)."
  type ChainAlphaVolumeDistribution {
    count: Int!
    mean: Float!
    min: Float!
    p25: Float!
    median: Float!
    p75: Float!
    p90: Float!
    max: Float!
  }

  "One subnet's rolling 24h buy/sell volume scorecard, ranked by total_volume_tao then netuid."
  type ChainAlphaVolumeSubnet {
    schema_version: Int!
    netuid: Int!
    window: String
    buy_volume_alpha: Float!
    sell_volume_alpha: Float!
    total_volume_alpha: Float!
    buy_volume_tao: Float!
    sell_volume_tao: Float!
    total_volume_tao: Float!
    buy_count: Int!
    sell_count: Int!
    net_volume_alpha: Float!
    "net/gross alpha lean in [-1, 1]; null when this subnet had no volume."
    sentiment_ratio: Float
    "Coarse sentiment label (bullish/bearish/neutral)."
    sentiment: String!
    "24h volume / market-cap turnover ratio; always null here (no per-subnet market-cap input in scope at the network level)."
    vol_mcap_ratio: Float
  }

  "Network-wide weight-setter leaderboard over a lookback window, summed live from the account_events WeightsSet stream. The setter-level drill-in behind ChainWeights. Mirrors GET /api/v1/chain/weights/setters."
  type ChainSigners {
    schema_version: Int!
    window: String
    "The rank order actually applied: tx_count or total_fee_tao."
    sort: String!
    observed_at: String
    signer_count: Int!
    signers: [ChainSigner!]!
  }

  "One account's extrinsic-submission activity in the window, ranked by the requested sort."
  type ChainSigner {
    signer: String!
    tx_count: Int!
    "Total fees paid across the window's extrinsics; null when the tier has no fee data."
    total_fee_tao: Float
    total_tip_tao: Float
    last_tx_block: Int
  }

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

  "One subnet's uptime + latency trend windows. Mirrors GET /api/v1/subnets/{netuid}/health/trends's data envelope."
  type SubnetHealthTrends {
    schema_version: Int!
    netuid: Int!
    observed_at: String
    source: String
    "The 7d/30d windows keyed by window label, each holding this subnet's samples, uptime_ratio, latency_sample_count and the per-surface uptime/latency series. Opaque JSON: dynamic-keyed by window label, matching the get_subnet_health_trends MCP/REST shape."
    windows: JSON!
  }

  "One subnet's long-term daily uptime history (#5885). Mirrors GET /api/v1/subnets/{netuid}/uptime's data envelope."
  type SubnetUptime {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    source: String
    "Subnet-level sample-weighted reliability score over the window; null when there are no probe samples."
    reliability: UptimeReliability
    "Per-surface day series with window-wide uptime ratios and per-surface reliability scores."
    surfaces: [UptimeSurface!]!
  }

  "Window-wide reliability score (0-100) with letter grade. Surface-level scores omit window/surface_count/day_count/computed_at."
  type UptimeReliability {
    score: Int
    grade: String
    uptime_ratio: Float
    avg_latency_ms: Int
    sample_count: Int
    latency_sample_count: Int
    window: String
    surface_count: Int
    day_count: Int
    computed_at: String
  }

  "One operational surface's uptime history over the requested window."
  type UptimeSurface {
    surface_id: String
    day_count: Int
    samples: Int
    uptime_ratio: Float
    reliability: UptimeReliability
    days: [UptimeDay!]!
  }

  "One daily uptime point for a surface."
  type UptimeDay {
    day: String
    samples: Int
    uptime_ratio: Float
    avg_latency_ms: Int
    latency_sample_count: Int
    latency_ms: UptimeLatency
    status: String
  }

  "Percentile latency summary for one uptime day."
  type UptimeLatency {
    p50: Int
    p95: Int
    p99: Int
  }

  "RPC reverse-proxy usage analytics over a 7d/30d window. Mirrors GET /api/v1/rpc/usage's data envelope."
  type RpcUsage {
    schema_version: Int!
    window: String
    "Time-bucket granularity for buckets: 1h for the 7d window, 6h for 30d. Null on a cold store."
    bucket_granularity: String
    observed_at: String
    source: String
    summary: RpcUsageSummary!
    "Per-endpoint request distribution, ranked by request volume (top 50)."
    endpoints: [RpcUsageEndpoint!]!
    "Per-network request breakdown, ordered by request volume."
    networks: [RpcUsageNetwork!]!
    "Bounded time buckets over the window for heatmaps, oldest-first."
    buckets: [RpcUsageBucket!]!
  }

  "Window-total rollup for RPC reverse-proxy traffic."
  type RpcUsageSummary {
    total_requests: Int!
    ok_requests: Int!
    error_requests: Int!
    "Null when there are no requests in the window (no defined rate)."
    error_rate: Float
    failover_requests: Int!
    "Null when there are no requests in the window."
    failover_rate: Float
    cache_hits: Int!
    "Null when there are no requests in the window."
    cache_hit_rate: Float
    latency_ms: RpcUsageLatency!
  }

  "Window latency percentiles + average for RPC reverse-proxy traffic; each is null on a cold store."
  type RpcUsageLatency {
    p50: Int
    p95: Int
    avg: Int
  }

  "One endpoint's share of RPC reverse-proxy traffic in the window."
  type RpcUsageEndpoint {
    rank: Int!
    endpoint_id: String
    provider: String
    requests: Int!
    ok_requests: Int!
    "Null when the endpoint had no requests in the window."
    error_rate: Float
    avg_latency_ms: Int
  }

  "One network's share of RPC reverse-proxy traffic in the window."
  type RpcUsageNetwork {
    network: String
    requests: Int!
    ok_requests: Int!
    "Null when the network had no requests in the window."
    error_rate: Float
  }

  "One bounded time bucket of RPC reverse-proxy traffic (bucket_granularity wide)."
  type RpcUsageBucket {
    ts: Float!
    requests: Int!
    errors: Int!
    avg_latency_ms: Int
  }

  "Registry leaderboards over the operational + economic-opportunity boards. Mirrors GET /api/v1/registry/leaderboards."
  type RegistryLeaderboards {
    schema_version: Int!
    "The board filter that was applied, or null when every board is returned."
    board: String
    observed_at: String
    source: String
    "Every board keyed by board name, each an array of ranked subnet entries capped at limit. Opaque JSON like HealthTrends.windows: the keys are dynamic AND hyphenated (fastest-rpc, most-complete, open-slots, …) so they are not expressible as GraphQL field names, and each board carries its own metric columns (healthiest has uptime_ratio/surfaces_ok, fastest-rpc has latency_ms, fastest-growing has completeness_delta, …). Passing it through verbatim keeps the REST/MCP get_registry_leaderboards shape byte-for-byte."
    boards: JSON!
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

  "One subnet's weekly structural + economics trajectory from the daily snapshots (#5887). Mirrors GET /api/v1/subnets/{netuid}/trajectory's data envelope. The REST envelope's window-keyed deltas map (7d/30d) is exposed here as a list carrying each window label, since those keys are not valid GraphQL field names."
  type SubnetTrajectory {
    schema_version: Int!
    netuid: Int!
    point_count: Int!
    points: [SubnetTrajectoryPoint!]!
    "Latest-vs-window-ago deltas -- one entry per window (7d, 30d) that has a prior point to compare against; empty when the series is too short."
    deltas: [SubnetTrajectoryDelta!]!
  }

  "One daily-snapshot point on a subnet's trajectory (chronological). Economics fields are null on rows captured before those columns existed / when economics was unavailable that day."
  type SubnetTrajectoryPoint {
    date: String
    completeness_score: Int
    surface_count: Int
    endpoint_count: Int
    validator_count: Int
    miner_count: Int
    total_stake_tao: Float
    alpha_price_tao: Float
    emission_share: Float
    tao_in_pool_tao: Float
    alpha_in_pool: Float
    alpha_out_pool: Float
    subnet_volume_tao: Float
  }

  "Change in a subnet's key metrics over a trailing window (latest point minus the point at-or-before the window start). Pool-reserve deltas double as the net TAO/alpha flow over the window."
  type SubnetTrajectoryDelta {
    window: String!
    from_date: String
    to_date: String
    completeness_score: Int
    surface_count: Int
    endpoint_count: Int
    tao_in_pool_tao: Float
    alpha_in_pool: Float
    alpha_out_pool: Float
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

  "One cross-subnet identity change in the network-wide feed (carries its netuid)."
  type ChainIdentityHistoryEntry {
    netuid: Int
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

  type ChainIdentityHistory {
    schema_version: Int!
    count: Int!
    subnet_count: Int!
    changes: [ChainIdentityHistoryEntry!]!
  }

  "Per-subnet neuron-registration activity over a window (#5720). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/registrations."
  type SubnetHyperparameters {
    schema_version: Int!
    netuid: Int!
    captured_at: String
    block_number: Int
    hyperparameters: Hyperparameters
  }

  "One subnet's on-chain hyperparameter block. Every field is nullable: a value absent from the captured row stays null rather than being coerced. *_ratio fields are 0..1 U16-derived ratios; *_tao fields are rao-exact (9dp); bonds_moving_avg_raw is the unscaled on-chain integer."
  type Hyperparameters {
    kappa_ratio: Float
    immunity_period: Int
    min_allowed_weights: Int
    max_weight_limit_ratio: Float
    tempo: Int
    weights_version: Int
    weights_rate_limit: Int
    activity_cutoff: Int
    activity_cutoff_factor: Int
    registration_allowed: Boolean
    target_regs_per_interval: Int
    min_burn_tao: Float
    max_burn_tao: Float
    burn_half_life: Int
    burn_increase_mult: Float
    bonds_moving_avg_raw: Int
    max_regs_per_block: Int
    serving_rate_limit: Int
    max_validators: Int
    commit_reveal_period: Int
    commit_reveal_enabled: Boolean
    alpha_high_ratio: Float
    alpha_low_ratio: Float
    liquid_alpha_enabled: Boolean
    alpha_sigmoid_steepness: Float
    yuma_version: Int
    subnet_is_active: Boolean
    transfers_enabled: Boolean
    bonds_reset_enabled: Boolean
    user_liquidity_enabled: Boolean
    owner_cut_enabled: Boolean
    owner_cut_auto_lock_enabled: Boolean
    min_childkey_take_ratio: Float
  }

  type SubnetHyperparamsHistory {
    schema_version: Int!
    netuid: Int!
    entry_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    entries: [HyperparamsHistoryEntry!]!
  }

  "One observed hyperparameter change: the full block as of that block_number, plus the hash the diff-on-change writer keyed it by."
  type HyperparamsHistoryEntry {
    block_number: Int
    observed_at: String
    hyperparameters: Hyperparameters
    hyperparams_hash: String
  }

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

  type SubnetStakeMoves {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_movers: Int!
    movements: Int!
    movements_per_mover: Float
  }

  "Per-subnet stake-transfer activity (#5717) over a 7d/30d window. Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/stake-transfers."
  type SubnetStakeTransfers {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_senders: Int!
    transfers: Int!
    transfers_per_sender: Float
  }

  "Per-subnet weight-setter leaderboard (#5712). Empty setters on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/weights/setters."
  type SubnetWeightSetters {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    distinct_setters: Int!
    weight_sets: Int!
    setter_count: Int!
    setters: [SubnetWeightSetter!]!
  }

  "One validator's weight-setting activity within one subnet over the lookback window."
  type SubnetWeightSetter {
    hotkey: String
    uid: Int
    weight_sets: Int!
    "This setter's share of the subnet total weight_sets; null when the subnet total is 0."
    share: Float
    first_set_at: String
    last_set_at: String
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

  "One validator's nominator leaderboard (#5692). Mirrors GET /api/v1/validators/{hotkey}/nominators' data envelope."
  type NominatorList {
    schema_version: Int!
    hotkey: String!
    "The resolved window label; null only if the builder was handed no window."
    window: String
    "The resolved sort actually applied (an omitted sort resolves to net_staked)."
    sort: String!
    limit: Int!
    offset: Int!
    "Total distinct nominating coldkeys in the window, before limit/offset paging."
    nominator_count: Int!
    nominators: [Nominator!]!
  }

  "One nominating coldkey's staking activity toward a validator within the window."
  type Nominator {
    coldkey: String!
    staked_tao: Float!
    unstaked_tao: Float!
    "staked_tao - unstaked_tao."
    net_staked_tao: Float!
    "staked_tao + unstaked_tao (total churn, regardless of direction)."
    gross_staked_tao: Float!
    event_count: Int!
    "Most recent StakeAdded/StakeRemoved time for this coldkey; null when unstamped."
    last_observed_at: String
  }

  "Network-wide reward-distribution & score-spread card (#5688) -- the network analog of SubnetPerformance, spanning every subnet's neurons in one snapshot. Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/performance."
  type ChainPerformance {
    schema_version: Int!
    "Distinct subnets the snapshot spans."
    subnet_count: Int!
    neuron_count: Int!
    validator_count: Int!
    active_count: Int!
    captured_at: String
    "Incentive concentration across all neurons network-wide with positive incentive."
    incentive: ConcentrationMetrics
    "Dividends concentration across permitted validators network-wide only."
    dividends: ConcentrationMetrics
    "Trust score spread across all neurons network-wide."
    trust: ScoreDistribution
    "Consensus score spread across all neurons network-wide."
    consensus: ScoreDistribution
    "Validator-trust score spread across permitted validators network-wide only."
    validator_trust: ScoreDistribution
  }

  "Network-wide stake & emission decentralization card (#5872). Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/concentration."
  type ChainConcentration {
    schema_version: Int!
    "Distinct subnets the snapshot spans."
    subnet_count: Int!
    neuron_count: Int!
    "Distinct controlling entities (coldkeys) network-wide, collapsed across subnets."
    entity_count: Int!
    "UIDs per controlling entity network-wide -- a consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many). Null when no entities."
    uids_per_entity: Float
    captured_at: String
    "Raw stake concentration across every neuron network-wide."
    stake: ConcentrationMetrics
    "Raw emission concentration across every neuron network-wide."
    emission: ConcentrationMetrics
    "Stake concentration per controlling entity -- hotkeys collapsed across subnets, so one operator counts once."
    entity_stake: ConcentrationMetrics
    "Emission concentration per controlling entity -- hotkeys collapsed across subnets."
    entity_emission: ConcentrationMetrics
    "Stake concentration across permitted validators network-wide only."
    validator_stake: ConcentrationMetrics
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

  "Per-subnet stake & emission concentration card (#5901) over the current neurons snapshot. Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/concentration."
  type SubnetConcentration {
    schema_version: Int!
    netuid: Int!
    neuron_count: Int!
    "Distinct controlling entities (coldkeys) behind the subnet's UIDs."
    entity_count: Int!
    "UIDs per controlling entity -- a Sybil/consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many hotkeys). Null on an empty subnet."
    uids_per_entity: Float
    captured_at: String
    "Stake concentration across all UIDs."
    stake: ConcentrationMetrics
    "Emission concentration across all UIDs."
    emission: ConcentrationMetrics
    "Stake concentration collapsed to one holder per controlling entity."
    entity_stake: ConcentrationMetrics
    "Emission concentration collapsed to one holder per controlling entity."
    entity_emission: ConcentrationMetrics
    "Stake concentration across permitted validators only."
    validator_stake: ConcentrationMetrics
  }

  "One day's point in a subnet's concentration trend (#5901). Flattened (not nested) stake/emission metrics keep the series trivial to plot; each is null on a cold/empty day."
  type SubnetConcentrationHistoryPoint {
    snapshot_date: String!
    neuron_count: Int!
    stake_gini: Float
    stake_nakamoto_coefficient: Int
    stake_top_10pct_share: Float
    emission_gini: Float
    emission_nakamoto_coefficient: Int
    emission_top_10pct_share: Float
  }

  "Per-subnet per-day concentration trend (#5901) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/concentration/history."
  type SubnetConcentrationHistory {
    schema_version: Int!
    netuid: Int!
    "The resolved window label (7d/30d/90d)."
    window: String
    point_count: Int!
    points: [SubnetConcentrationHistoryPoint!]!
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

  "One subnet's per-surface SLA + reconstructed downtime incidents over the window. Mirrors GET /api/v1/subnets/{netuid}/health/incidents's data envelope."
  type SubnetHealthIncidents {
    schema_version: Int!
    netuid: Int!
    window: String
    observed_at: String
    source: String
    "Per operational surface: its sample count, uptime_ratio, incident_count, total downtime_ms, and gap-island incident list (started_at/ended_at/duration_ms/failed_samples, epoch-ms). Opaque JSON passed through verbatim, matching the get_subnet_health_incidents MCP/REST shape (like SubnetHealthTrends.windows)."
    surfaces: JSON!
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

  "One subnet's validator/neuron-set turnover between a window's boundary snapshots. The churn metrics are zeroed and the retentions/stability null on a single-snapshot or cold store (schema-stable). Mirrors GET /api/v1/subnets/{netuid}/turnover's default scorecard."
  type SubnetTurnover {
    schema_version: Int!
    netuid: Int!
    window: String
    start_date: String
    end_date: String
    comparable: Boolean!
    validators_start: Int!
    validators_end: Int!
    validators_entered: Int!
    validators_exited: Int!
    validator_retention: Float
    neurons_start: Int!
    neurons_end: Int!
    uids_deregistered: Int!
    neuron_retention: Float
    stability_score: Int
  }

  "Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached). balance_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/balance."
  type AccountBalance {
    schema_version: Int!
    ss58: String!
    balance_tao: Float
    queried_at: String!
  }

  "The network's on-chain sudo (superuser) key, read live from chain via RPC. hotkey is null on RPC failure or a renounced sudo (schema-stable). Mirrors GET /api/v1/sudo/key's data envelope."
  type SudoKey {
    schema_version: Int!
    hotkey: String
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

  "Site-wide runtime spec-version transition timeline. Mirrors GET /api/v1/runtime."
  type RuntimeVersionHistory {
    schema_version: Int!
    transitions: [RuntimeTransition!]!
    transition_count: Int!
    current_spec_version: Int
    coverage_from_block: Int
    coverage_from_at: String
  }

  "One runtime spec-version's first-seen block in the transition timeline."
  type RuntimeTransition {
    spec_version: Int!
    block_number: Int!
    observed_at: String
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

  "One neuron's live metagraph detail card (#5900). Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}: neuron is null when that UID is absent from the latest snapshot."
  type Neuron {
    schema_version: Int!
    netuid: Int!
    captured_at: String
    block_number: Int
    "The UID's live metagraph row; null when absent from the latest snapshot."
    neuron: NeuronState
  }

  "One UID's live metagraph state within a subnet (hot/cold keys, scores, stake/emission, axon, take)."
  type NeuronState {
    uid: Int
    hotkey: String
    coldkey: String
    active: Boolean
    validator_permit: Boolean
    rank: Float
    trust: Float
    validator_trust: Float
    consensus: Float
    incentive: Float
    dividends: Float
    emission_tao: Float
    stake_tao: Float
    registered_at_block: Int
    is_immunity_period: Boolean
    "Axon endpoint as host:port, or null when not served."
    axon: String
    "Validator take/commission (0..1) from SubtensorModule::Delegates; null when no Delegates entry at capture."
    take: Float
  }

  "One neuron's per-day metagraph history. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history."
  type NeuronHistory {
    schema_version: Int!
    netuid: Int!
    uid: Int!
    window: String
    point_count: Int!
    points: [NeuronHistoryPoint!]!
  }

  "One day's metagraph state for a single UID (NeuronState fields plus snapshot_date/captured_at/block_number)."
  type NeuronHistoryPoint {
    snapshot_date: String!
    captured_at: String
    block_number: Int
    uid: Int
    hotkey: String
    coldkey: String
    active: Boolean
    validator_permit: Boolean
    rank: Float
    trust: Float
    validator_trust: Float
    consensus: Float
    incentive: Float
    dividends: Float
    emission_tao: Float
    stake_tao: Float
    registered_at_block: Int
    is_immunity_period: Boolean
    axon: String
    take: Float
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

  "One diff-tracked snapshot of an account's on-chain identity, taken when any tracked field changed since the previous entry."
  type AccountIdentityHistoryEntry {
    observed_at: String
    name: String
    url: String
    github: String
    image: String
    discord: String
    description: String
    additional: String
    "Stable hash of this entry's tracked identity fields -- unchanged across entries where nothing actually differs."
    identity_hash: String
  }

  type AccountIdentity {
    schema_version: Int!
    account: String!
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

  type AccountIdentityHistory {
    schema_version: Int!
    account: String!
    entry_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    entries: [AccountIdentityHistoryEntry!]!
  }

  "One counterparty the account transacts native TAO with, aggregated over the scanned Transfer set."
  type AccountCounterparty {
    address: String!
    sent_tao: Float!
    received_tao: Float!
    net_tao: Float!
    transfer_count: Int!
    last_block: Int
  }

  "One direction-aware transfer between the account and the drilled-into counterparty."
  type AccountCounterpartyTransfer {
    block_number: Int
    event_index: Int
    netuid: Int
    from: String
    to: String
    amount_tao: Float!
    "sent (account = from) or received (account = to)."
    direction: String!
    observed_at: String
  }

  "Focused fund-flow summary for one account/counterparty relationship, with the bounded transfer evidence; only present when counterparty was supplied."
  type AccountCounterpartyRelationship {
    schema_version: Int!
    ss58: String!
    counterparty: String!
    transfer_count: Int!
    transfers_scanned: Int!
    scan_capped: Boolean!
    total_sent_tao: Float!
    total_received_tao: Float!
    net_tao: Float!
    "Oldest block/timestamp are null when the newest-first scan was truncated (scan_capped)."
    first_block: Int
    last_block: Int
    first_seen_at: String
    last_seen_at: String
    limit: Int!
    transfers: [AccountCounterpartyTransfer!]!
  }

  type AccountCounterparties {
    schema_version: Int!
    ss58: String!
    counterparty_count: Int!
    transfers_scanned: Int!
    scan_capped: Boolean!
    total_sent_tao: Float!
    total_received_tao: Float!
    counterparties: [AccountCounterparty!]!
    "Present only in relationship (counterparty) mode; null in list mode."
    relationship: AccountCounterpartyRelationship
  }

  "One native-TAO Balances.Transfer event on an account's feed. direction is relative to the queried address (sent = it paid, received = it was paid)."
  type AccountTransfer {
    block_number: Int
    event_index: Int
    from: String
    to: String
    amount_tao: Float
    direction: String
    observed_at: String
  }

  "One account's native-TAO transfer feed, keyset-paginated newest-first. Mirrors GET /api/v1/accounts/{ss58}/transfers' data envelope."
  type AccountTransfers {
    schema_version: Int!
    ss58: String!
    transfer_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    transfers: [AccountTransfer!]!
  }

  "One account's signed-extrinsic feed (newest first), backing account_extrinsics. Matched by the extrinsic signer only. extrinsic_count is the page count, matching the REST feed convention. Each item is a full Extrinsic (block/index/hash/call/success/fee/tip)."
  type AccountExtrinsics {
    schema_version: Int!
    ss58: String!
    extrinsic_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    extrinsics: [Extrinsic!]!
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

  "One account's first-party chain-event feed (matched by the hotkey OR coldkey union, newest first), keyset-paginated. event_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/events' data envelope. Each item is an AccountEvent."
  type AccountEvents {
    schema_version: Int!
    ss58: String!
    event_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    events: [AccountEvent!]!
  }

  "One day's rolled-up activity for an account on one subnet, from the account_events_daily tier. event_kinds is the distinct set of event ids seen that day."
  type AccountDay {
    day: String
    netuid: Int
    event_count: Int
    event_kinds: [String!]!
    first_block: Int
    last_block: Int
  }

  "One account's durable per-day activity series (hotkey-keyed, newest day first), keyset-paginated. day_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/history' data envelope. Each item is an AccountDay."
  type AccountHistory {
    schema_version: Int!
    ss58: String!
    day_count: Int!
    limit: Int
    offset: Int
    next_cursor: String
    days: [AccountDay!]!
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

  "One account's per-subnet position history over a lookback window, one point per neuron_daily snapshot. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history."
  type AccountPositionHistory {
    schema_version: Int!
    ss58: String!
    netuid: Int!
    window: String
    point_count: Int!
    points: [AccountPositionHistoryPoint!]!
  }

  "One day's position for an account in one subnet: the neuron's uid/role/active plus stake/emission and its rank/trust/incentive/dividends scores and emission-per-stake yield."
  type AccountPositionHistoryPoint {
    snapshot_date: String!
    captured_at: String
    uid: Int
    coldkey: String
    role: String!
    active: Boolean!
    stake_tao: Float
    emission_tao: Float
    rank: Float
    trust: Float
    incentive: Float
    dividends: Float
    yield: Float
  }

  "One account's live cross-subnet registration footprint (the neurons snapshot), backing account_subnets. The lightweight sibling of AccountPortfolio -- registration facts only, no economics rollup."
  type AccountSubnets {
    schema_version: Int!
    ss58: String!
    subnet_count: Int!
    "Where this hotkey is currently registered, ordered by netuid -- each an AccountRegistration (netuid/uid/stake/validator_permit/active)."
    subnets: [AccountRegistration!]!
  }

  "One wallet's cross-subnet neuron portfolio (#5702): every subnet where the hotkey is a registered neuron, plus wallet-level aggregates. Mirrors GET /api/v1/accounts/{ss58}/portfolio."
  type AccountPortfolio {
    schema_version: Int!
    ss58: String!
    captured_at: String
    subnet_count: Int!
    position_count: Int!
    validator_count: Int!
    miner_count: Int!
    total_stake_tao: Float!
    total_emission_tao: Float!
    "Total emission over total stake across every position; null when total stake is 0."
    overall_yield: Float
    "How concentrated the wallet's stake is across its subnets (Gini/HHI/etc); null with no positions."
    stake_concentration: ConcentrationMetrics
    positions: [AccountPortfolioPosition!]!
  }

  "One subnet position in a wallet's portfolio, ranked biggest-stake-first."
  type AccountPortfolioPosition {
    netuid: Int!
    uid: Int
    role: String!
    active: Boolean!
    stake_tao: Float!
    emission_tao: Float!
    rank: Float
    trust: Float
    incentive: Float
    dividends: Float
    "Emission over stake for this position; null when stake is 0."
    yield: Float
  }

  "This account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from AccountPortfolio's hotkey-scoped view. Mirrors GET /api/v1/accounts/{ss58}/positions."
  type AccountPositions {
    schema_version: Int!
    ss58: String!
    captured_at: String
    position_count: Int!
    total_stake_tao: Float!
    positions: [NominatorPosition!]!
  }

  "One (hotkey, netuid) delegation this account holds, reconstructed from the nominator-positions ledger joined against the hotkey's live stake_tao for that netuid."
  type NominatorPosition {
    hotkey: String!
    netuid: Int!
    "This account's share of the hotkey's total alpha-pool shares on this subnet (0..1), not a TAO amount."
    share_fraction: Float!
    stake_tao: Float!
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
  sudo: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsic: RELATIONSHIP_FIELD_COMPLEXITY,
  governance_config_changes: RELATIONSHIP_FIELD_COMPLEXITY,
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
  account_identity: RELATIONSHIP_FIELD_COMPLEXITY,
  account_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  account_counterparties: RELATIONSHIP_FIELD_COMPLEXITY,
  account_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  account_extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  account_events: RELATIONSHIP_FIELD_COMPLEXITY,
  account_history: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks: RELATIONSHIP_FIELD_COMPLEXITY,
  // A single latest-only row -- but it fans out into the full hyperparameter
  // block, so it is priced with the other per-subnet relationship fields.
  subnet_hyperparameters: RELATIONSHIP_FIELD_COMPLEXITY,
  // Paginated fan-out: one hyperparameter block per recorded change.
  subnet_hyperparameters_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_uptime: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration_history: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_trajectory: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  runtime: RELATIONSHIP_FIELD_COMPLEXITY,
  block: RELATIONSHIP_FIELD_COMPLEXITY,
  economics_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_movers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_calls: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_fees: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_activity: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_signers: RELATIONSHIP_FIELD_COMPLEXITY,
  health_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_usage: RELATIONSHIP_FIELD_COMPLEXITY,
  validator_nominators: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_concentration: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_alpha_volume: RELATIONSHIP_FIELD_COMPLEXITY,
  account_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  account_position_history: RELATIONSHIP_FIELD_COMPLEXITY,
  account_portfolio: RELATIONSHIP_FIELD_COMPLEXITY,
  account_positions: RELATIONSHIP_FIELD_COMPLEXITY,
  account_subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  // Fans out into leaderboardProfilesProjection plus several D1 reads and the
  // economics tier -- same cost class as the other relationship fields.
  registry_leaderboards: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_recycled: LIVE_RPC_FIELD_COMPLEXITY,
  account_balance: LIVE_RPC_FIELD_COMPLEXITY,
  sudo_key: LIVE_RPC_FIELD_COMPLEXITY,
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

// Exported so tests/docs-content-drift.test.mjs can assert
// content/docs/graphql.mdx documents the real values.
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

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

// Case-insensitive categorical filters for Query.subnets (#6251) — mirrors REST
// /api/v1/subnets list-query semantics (workers/list-query.mjs filterRows +
// contracts subnets.arrayFilters.domain). Unrecognized values simply match zero
// rows; GraphQL does not 400 on bad filter tokens.
function matchesSubnetListFilters(
  row,
  { status, subnet_type, domain, coverage_level, curation_level } = {},
) {
  for (const [key, raw] of [
    ["status", status],
    ["subnet_type", subnet_type],
    ["coverage_level", coverage_level],
    ["curation_level", curation_level],
  ]) {
    if (raw == null) continue;
    const expected = String(raw).toLowerCase();
    const value = row?.[key];
    if (value == null) return false;
    if (String(value).toLowerCase() !== expected) return false;
  }
  if (domain != null) {
    const expected = String(domain).toLowerCase();
    const tags = [
      ...(Array.isArray(row?.categories) ? row.categories : []),
      ...(Array.isArray(row?.derived_categories) ? row.derived_categories : []),
    ];
    if (!tags.map((tag) => String(tag).toLowerCase()).includes(expected)) {
      return false;
    }
  }
  return true;
}

// Shared list shape: load → optional netuid filter → paginate → wrap. `map`
// node-wraps rows; `resultKey` is the list field's name (economics uses
// `subnets`, the rest use `items`).
async function listPage(
  context,
  path,
  key,
  { limit, cursor, keyFn, netuid, map, resultKey = "items", filterFn },
) {
  let all = await loadRows(context, path, key, netuid);
  if (filterFn) {
    all = all.filter(filterFn);
  }
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
  subnets(
    {
      netuid,
      status,
      subnet_type,
      domain,
      coverage_level,
      curation_level,
      limit,
      cursor,
    },
    context,
  ) {
    const hasCategoricalFilters =
      status != null ||
      subnet_type != null ||
      domain != null ||
      coverage_level != null ||
      curation_level != null;
    return listPage(context, ARTIFACT.subnets, "subnets", {
      limit,
      cursor,
      netuid,
      keyFn: (s) => s.netuid,
      map: subnetNode,
      filterFn: hasCategoricalFilters
        ? (row) =>
            matchesSubnetListFilters(row, {
              status,
              subnet_type,
              domain,
              coverage_level,
              curation_level,
            })
        : undefined,
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

  async subnet_hyperparameters({ netuid }, context) {
    // Same tryPostgresTier(METAGRAPH_SUBNET_HYPERPARAMS_SOURCE) -> buildSubnetHyperparams
    // fallback contract handleSubnetHyperparams uses. The D1 write path is retired, so a
    // cold tier is an expected steady state, not an error: it yields a schema-stable card
    // with hyperparameters:null rather than a GraphQL error or a 404.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/hyperparameters`,
        ),
        "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
      )) ?? buildSubnetHyperparams(null, netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      // The hyperparameter block is passed through whole -- graphql's default
      // field resolver reads it, so an absent key surfaces as null without a
      // per-field fallback here.
      hyperparameters: data.hyperparameters ?? null,
    };
  },

  async subnet_hyperparameters_history({ netuid, limit, offset }, context) {
    // Same FEED_PAGINATION bounds parsePagination applies for REST, so a GraphQL
    // caller cannot request a wider page than the route allows.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/hyperparameters/history`,
          params,
        ),
        "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
      )) ??
      buildSubnetHyperparamsHistory([], netuid, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      entry_count: data.entry_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      entries: data.entries ?? [],
    };
  },

  async subnet_trajectory({ netuid }, context) {
    // Same tryPostgresTier(METAGRAPH_SUBNET_SNAPSHOTS_SOURCE) -> loadSubnetTrajectory
    // fallback contract handleTrajectory uses; a subnet with no daily snapshots is
    // a schema-stable empty trajectory, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/trajectory`),
        "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
      )) ?? (await loadSubnetTrajectory(graphqlD1(context), netuid));
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
      // The REST envelope keys deltas by window ("7d"/"30d") -- names that
      // aren't valid GraphQL fields -- so flatten to a list carrying the label,
      // dropping windows with no comparable prior point (null delta).
      deltas: Object.entries(data.deltas ?? {})
        .filter(([, delta]) => delta != null)
        .map(([window, delta]) => ({ window, ...delta })),
    };
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

  async chain_identity_history({ limit }, context) {
    // Same FEED_PAGINATION clamp REST applies. This chain-wide feed is
    // limit-only (no offset/cursor) -- the network view returns the most-recent
    // changes across every subnet in one pass.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_SUBNET_IDENTITY_SOURCE) ->
    // loadChainIdentityHistory fallback contract handleChainIdentityHistory
    // uses; a store with no identity changes is a schema-stable empty feed
    // (count 0), never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/identity-history", params),
        "METAGRAPH_SUBNET_IDENTITY_SOURCE",
      )) ??
      (await loadChainIdentityHistory(graphqlD1(context), {
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      count: data.count ?? 0,
      subnet_count: data.subnet_count ?? 0,
      changes: data.changes || [],
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

  async subnet_concentration({ netuid }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildConcentration([])
    // cold fallback contract handleSubnetConcentration / MCP get_subnet_concentration
    // use: a subnet with no neurons is a schema-stable zeroed card (metric blocks
    // null), never a GraphQL error. No window -- current snapshot only.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/concentration`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildConcentration([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      neuron_count: data.neuron_count ?? 0,
      entity_count: data.entity_count ?? 0,
      uids_per_entity: data.uids_per_entity ?? null,
      captured_at: data.captured_at ?? null,
      stake: data.stake ?? null,
      emission: data.emission ?? null,
      entity_stake: data.entity_stake ?? null,
      entity_emission: data.entity_emission ?? null,
      validator_stake: data.validator_stake ?? null,
    };
  },

  async subnet_concentration_history({ netuid, window }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same 7d/30d/90d window validation the REST route + MCP
    // get_subnet_concentration_history use -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_CONCENTRATION_HISTORY_WINDOW;
    if (!Object.hasOwn(CONCENTRATION_HISTORY_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, CONCENTRATION_HISTORY_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildConcentrationHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/concentration/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
      buildConcentrationHistory([], netuid, {
        window: windowParam,
        capped: false,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
    };
  },

  async neuron({ netuid, uid }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (!Number.isInteger(uid) || uid < 0) {
      throw new GraphQLError("uid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildNeuronDetail(null)
    // cold fallback contract handleNeuron / MCP get_neuron use: an absent UID
    // is a schema-stable card with neuron:null, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/neurons/${uid}`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildNeuronDetail(null, netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      neuron: data.neuron ?? null,
    };
  },

  async neuron_history({ netuid, uid, window }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (!Number.isInteger(uid) || uid < 0) {
      throw new GraphQLError("uid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow REST's handleNeuronHistory uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const { label, error } = parseHistoryWindow(window);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildNeuronHistory([])
    // fallback contract handleNeuronHistory / MCP get_neuron_history use; a
    // UID with no neuron_daily rows in the window is a schema-stable
    // empty-points card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/neurons/${uid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildNeuronHistory([], netuid, uid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      uid: data.uid ?? uid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
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

  async subnet_stake_moves({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetStakeMoves uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_STAKE_MOVES_WINDOW;
    if (!Object.hasOwn(SUBNET_STAKE_MOVES_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_STAKE_MOVES_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetStakeMoves
    // zeroed-card fallback contract handleSubnetStakeMoves uses; a subnet with no
    // StakeMoved events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/stake-moves`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetStakeMoves(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_movers: data.distinct_movers ?? 0,
      movements: data.movements ?? 0,
      movements_per_mover: data.movements_per_mover ?? null,
    };
  },

  async subnet_stake_transfers({ netuid, window }, context) {
    // Same 7d/30d window validation handleSubnetStakeTransfers uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW;
    if (!Object.hasOwn(SUBNET_STAKE_TRANSFERS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_STAKE_TRANSFERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetStakeTransfers zeroed-card fallback contract
    // handleSubnetStakeTransfers uses; a subnet with no StakeTransferred events
    // in the window is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/stake-transfers`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetStakeTransfers(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_senders: data.distinct_senders ?? 0,
      transfers: data.transfers ?? 0,
      transfers_per_sender: data.transfers_per_sender ?? null,
    };
  },

  async subnet_weight_setters({ netuid, window }, context) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same 7d/30d window validation handleSubnetWeightSetters uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW;
    if (!Object.hasOwn(SUBNET_WEIGHT_SETTERS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_WEIGHT_SETTERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetWeightSetters([], null, ...) empty-leaderboard fallback
    // contract handleSubnetWeightSetters / MCP get_subnet_weight_setters use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/weights/setters`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildSubnetWeightSetters([], null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_setters: data.distinct_setters ?? 0,
      weight_sets: data.weight_sets ?? 0,
      setter_count: data.setter_count ?? 0,
      setters: data.setters || [],
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

  async subnet_health_incidents({ netuid, window }, context) {
    // Reuse the exact analyticsWindow parse/validate REST's handleHealthIncidents
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetIncidents D1
    // fallback contract handleHealthIncidents and the get_subnet_health_incidents
    // MCP tool share -- the tier owns the gap-island incident reconstruction, so
    // nothing is duplicated here, and a subnet with no probe history yields a
    // schema-stable empty surfaces list, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/health/incidents`,
          params,
        ),
        "METAGRAPH_HEALTH_SOURCE",
      )) ??
      (await loadSubnetIncidents(graphqlD1(context), netuid, {
        window: label,
        observedAt: await loadObservedAt(context),
      }));
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
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

  async sudo(
    { limit, offset, cursor, block, call_function: callFunction, success },
    context,
  ) {
    // The Sudo governance feed is the /extrinsics feed with call_module fixed
    // to Sudo by the route itself, so it takes no signer/call_module args and
    // reuses the identical extrinsics source + ExtrinsicList shape.
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
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/sudo", params),
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

  async governance_config_changes(
    { limit, offset, cursor, block, call_function: callFunction, success },
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
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    // Same DATA_API extrinsics tier as Query.extrinsics, hitting the
    // /governance/config-changes path so the worker fixes call_module=AdminUtils
    // itself (see SUDO_GOVERNANCE_ROUTES in workers/data-api.mjs) -- no filter
    // logic duplicated here; the REST route and MCP tool share this exact path.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          "/api/v1/governance/config-changes",
          params,
        ),
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

  async runtime(_args, context) {
    // Same tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) -> buildRuntimeVersionHistory([])
    // fallback contract GET /api/v1/runtime and the get_runtime MCP tool use; blocks'
    // D1 write path is retired (#4909) so a cold Postgres tier is the steady state --
    // the empty builder shape (transition_count 0, current_spec_version null) satisfies
    // the non-null RuntimeVersionHistory! contract, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/runtime"),
        "METAGRAPH_BLOCKS_SOURCE",
      )) ?? buildRuntimeVersionHistory([]);
    return {
      schema_version: data.schema_version ?? 1,
      transitions: data.transitions || [],
      transition_count: data.transition_count ?? 0,
      current_spec_version: data.current_spec_version ?? null,
      coverage_from_block: data.coverage_from_block ?? null,
      coverage_from_at: data.coverage_from_at ?? null,
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

  async validator_nominators({ hotkey, window, sort }, context) {
    // Same window/sort allow-lists handleValidatorNominators validates against --
    // an unsupported value is a GraphQL BAD_USER_INPUT error, not a silently
    // substituted default. `sort` is optional: omitted resolves to
    // DEFAULT_NOMINATOR_SORT inside the builder, so only a SUPPLIED bad value errors.
    const requestedWindow = window ?? DEFAULT_NOMINATOR_WINDOW;
    if (!Object.hasOwn(NOMINATOR_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, NOMINATOR_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    if (sort != null && !NOMINATOR_SORTS.includes(sort)) {
      throw new GraphQLError(
        `"${sort}" is not a supported sort. Supported: ${NOMINATOR_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    if (sort != null) params.set("sort", sort);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadValidatorNominators
    // fallback contract REST uses. Both sides return the SAME { data, generatedAt }
    // envelope, so the destructure covers either tier; `generatedAt` is REST
    // envelope meta with no GraphQL field to carry it. A hotkey with no nominators
    // yields a schema-stable empty list, never a GraphQL error. limit/offset are
    // deliberately not GraphQL args, so the module's own defaults apply.
    const { data } =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}/nominators`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadValidatorNominators(graphqlD1(context), hotkey, {
        windowLabel: requestedWindow,
        sort: sort ?? undefined,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      hotkey: data.hotkey ?? hotkey,
      window: data.window ?? requestedWindow,
      sort: data.sort ?? sort ?? DEFAULT_NOMINATOR_SORT,
      limit: data.limit ?? 0,
      offset: data.offset ?? 0,
      nominator_count: data.nominator_count ?? 0,
      nominators: data.nominators || [],
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

  async account_position_history({ ss58, netuid, window }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError("netuid must be a u16 subnet id (0-65535).", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow the REST position-history handler uses, so
    // accepted window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const { label, error } = parseHistoryWindow(window);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountPositionHistory
    // fallback contract the REST handler uses; an account with no neuron_daily
    // rows for the subnet in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/subnets/${netuid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildAccountPositionHistory([], ss58, netuid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      netuid: data.netuid ?? netuid,
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

  async account_portfolio({ ss58 }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountPortfolio([])
    // fallback contract handleAccountPortfolio uses. This route's Postgres-tier
    // body is flat (like `account`'s own), not the { data, generatedAt } envelope
    // the account-event-footprint family uses.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/portfolio`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildAccountPortfolio([], ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      captured_at: data.captured_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      position_count: data.position_count ?? 0,
      validator_count: data.validator_count ?? 0,
      miner_count: data.miner_count ?? 0,
      total_stake_tao: data.total_stake_tao ?? 0,
      total_emission_tao: data.total_emission_tao ?? 0,
      overall_yield: data.overall_yield ?? null,
      stake_concentration: data.stake_concentration ?? null,
      positions: data.positions || [],
    };
  },

  async account_positions({ ss58 }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) ->
    // buildAccountPositions([], new Map(), ss58) fallback contract
    // handleAccountPositions uses -- Postgres-only (no D1 predecessor), flat
    // body (like account_portfolio's), not the { data, generatedAt } envelope
    // the account-event-footprint family uses.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/positions`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildAccountPositions([], new Map(), ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      captured_at: data.captured_at ?? null,
      position_count: data.position_count ?? 0,
      total_stake_tao: data.total_stake_tao ?? 0,
      positions: data.positions || [],
    };
  },

  async account_subnets({ ss58 }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountSubnets([])
    // fallback contract the REST route (/accounts/{ss58}/subnets) and the
    // get_account_subnets MCP tool use -- a flat body (like account_portfolio's),
    // not the { data, generatedAt } envelope the account-event footprint family
    // uses. An unregistered address is a schema-stable empty card, never null.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/subnets`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildAccountSubnets([], ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      subnet_count: data.subnet_count ?? 0,
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

  async account_identity({ ss58 }, context) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_IDENTITY_SOURCE) -> D1
    // (loadAccountIdentity) fallback handleAccountIdentity uses. Most accounts
    // have never called set_identity, so a row-less account is the common case:
    // has_identity:false with every field null, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/identity`,
        ),
        "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
      )) ?? (await loadAccountIdentity(d1Runner(context.env), ss58));
    return {
      schema_version: data.schema_version ?? 1,
      account: data.account ?? ss58,
      has_identity: data.has_identity ?? false,
      name: data.name ?? null,
      url: data.url ?? null,
      github: data.github ?? null,
      image: data.image ?? null,
      discord: data.discord ?? null,
      description: data.description ?? null,
      additional: data.additional ?? null,
      captured_at: data.captured_at ?? null,
    };
  },

  async account_identity_history({ ss58, limit, offset, cursor }, context) {
    // Same SS58 validation every account_* resolver uses -- a malformed
    // address is a GraphQL BAD_USER_INPUT error, not a silent empty timeline.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_IDENTITY_SOURCE) -> D1
    // (loadAccountIdentityHistory) fallback handleAccountIdentityHistory uses,
    // forwarding limit/offset/cursor as query params -- an address with no
    // identity-history rows is a schema-stable empty timeline, never a
    // GraphQL error.
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));
    if (cursor != null) params.set("cursor", cursor);
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/identity-history`,
          params,
        ),
        "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
      )) ??
      (await loadAccountIdentityHistory(d1Runner(context.env), ss58, {
        limit,
        offset,
        cursor,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      account: data.account ?? ss58,
      entry_count: data.entry_count ?? 0,
      limit: data.limit ?? null,
      offset: data.offset ?? null,
      next_cursor: data.next_cursor ?? null,
      entries: (data.entries ?? []).map((e) => ({
        observed_at: e.observed_at ?? null,
        name: e.name ?? null,
        url: e.url ?? null,
        github: e.github ?? null,
        image: e.image ?? null,
        discord: e.discord ?? null,
        description: e.description ?? null,
        additional: e.additional ?? null,
        identity_hash: e.identity_hash ?? null,
      })),
    };
  },

  async account_counterparties({ ss58, counterparty, limit }, context) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // The relationship drilldown needs a second, distinct SS58 -- the same two
    // guards the get_account_counterparties MCP tool applies to `counterparty`.
    if (counterparty != null) {
      if (!SS58_ADDRESS_PATTERN.test(counterparty)) {
        throw new GraphQLError("counterparty must be a valid SS58 address.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (counterparty === ss58) {
        throw new GraphQLError("counterparty must differ from ss58.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
    }
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP tool use, forwarding counterparty/limit as query params. The
    // account_events D1 write path is retired (#4772), so a tier miss resolves
    // to the pure builders over an empty scan -- a schema-stable zero card in
    // list mode, or the same composite envelope with an empty counterparties
    // list in relationship mode, never a GraphQL error.
    const params = new URLSearchParams();
    if (counterparty != null) params.set("counterparty", counterparty);
    if (limit != null) params.set("limit", String(limit));
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/counterparties`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    let data = tier;
    if (data == null) {
      if (counterparty != null) {
        const rel = buildCounterpartyRelationship([], ss58, counterparty, {
          limit,
        });
        data = {
          schema_version: 1,
          ss58,
          counterparty_count: 0,
          transfers_scanned: rel.transfers_scanned,
          scan_capped: rel.scan_capped,
          total_sent_tao: rel.total_sent_tao,
          total_received_tao: rel.total_received_tao,
          counterparties: [],
          relationship: rel,
        };
      } else {
        data = buildCounterparties([], ss58, { limit });
      }
    }
    const rel = data.relationship;
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      counterparty_count: data.counterparty_count ?? 0,
      transfers_scanned: data.transfers_scanned ?? 0,
      scan_capped: data.scan_capped ?? false,
      total_sent_tao: data.total_sent_tao ?? 0,
      total_received_tao: data.total_received_tao ?? 0,
      counterparties: (data.counterparties ?? []).map((c) => ({
        address: c.address,
        sent_tao: c.sent_tao ?? 0,
        received_tao: c.received_tao ?? 0,
        net_tao: c.net_tao ?? 0,
        transfer_count: c.transfer_count ?? 0,
        last_block: c.last_block ?? null,
      })),
      relationship: rel
        ? {
            schema_version: rel.schema_version ?? 1,
            ss58: rel.ss58 ?? ss58,
            counterparty: rel.counterparty ?? counterparty,
            transfer_count: rel.transfer_count ?? 0,
            transfers_scanned: rel.transfers_scanned ?? 0,
            scan_capped: rel.scan_capped ?? false,
            total_sent_tao: rel.total_sent_tao ?? 0,
            total_received_tao: rel.total_received_tao ?? 0,
            net_tao: rel.net_tao ?? 0,
            first_block: rel.first_block ?? null,
            last_block: rel.last_block ?? null,
            first_seen_at: rel.first_seen_at ?? null,
            last_seen_at: rel.last_seen_at ?? null,
            limit: rel.limit ?? 0,
            transfers: (rel.transfers ?? []).map((t) => ({
              block_number: t.block_number ?? null,
              event_index: t.event_index ?? null,
              netuid: t.netuid ?? null,
              from: t.from ?? null,
              to: t.to ?? null,
              amount_tao: t.amount_tao ?? 0,
              direction: t.direction,
              observed_at: t.observed_at ?? null,
            })),
          }
        : null,
    };
  },

  async account_transfers(
    { ss58, limit, offset, cursor, direction, block_start, block_end },
    context,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same FEED_PAGINATION bounds parsePagination applies for REST, so a GraphQL
    // caller cannot request a wider page than the /transfers route allows;
    // direction/cursor/block_start/block_end are forwarded verbatim for the
    // route to re-parse, matching the sibling feed resolvers.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor != null) params.set("cursor", cursor);
    if (direction != null) params.set("direction", direction);
    if (block_start != null) params.set("block_start", String(block_start));
    if (block_end != null) params.set("block_end", String(block_end));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP get_account_transfers tool use. The account_events D1 write path is
    // retired (#4772), so a tier miss resolves through buildAccountTransfers over
    // an empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/transfers`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      buildAccountTransfers([], ss58, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      transfer_count: data.transfer_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      transfers: (data.transfers ?? []).map((t) => ({
        block_number: t.block_number ?? null,
        event_index: t.event_index ?? null,
        from: t.from ?? null,
        to: t.to ?? null,
        amount_tao: t.amount_tao ?? null,
        direction: t.direction ?? null,
        observed_at: t.observed_at ?? null,
      })),
    };
  },

  async account_extrinsics(
    { ss58, limit, offset, cursor, block_start, block_end },
    context,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same FEED_PAGINATION bounds parsePagination applies for REST, so a GraphQL
    // caller cannot request a wider page than the /extrinsics route allows;
    // cursor/block_start/block_end are forwarded verbatim for the route to
    // re-parse, matching account_transfers and the sibling feed resolvers.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor != null) params.set("cursor", cursor);
    if (block_start != null) params.set("block_start", String(block_start));
    if (block_end != null) params.set("block_end", String(block_end));
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) the REST handler and MCP
    // get_account_extrinsics tool use. The extrinsics D1 write path is retired
    // (#4772), so a tier miss resolves through buildAccountExtrinsics over an
    // empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/extrinsics`,
          params,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ??
      buildAccountExtrinsics([], ss58, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    // Reuse extrinsicNode (the same mapper the extrinsics feed uses) so
    // call_args is JSON-encoded to the String field identically here.
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      extrinsic_count: data.extrinsic_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      extrinsics: (data.extrinsics || []).map(extrinsicNode),
    };
  },

  async account_events(
    { ss58, kind, netuid, block_start, block_end, limit, offset, cursor },
    context,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same FEED_PAGINATION bounds the /events route's clampEventsLimit applies,
    // so a GraphQL caller cannot request a wider page than REST allows;
    // kind/netuid/cursor/block_start/block_end are forwarded verbatim for the
    // route to re-parse, matching account_transfers and the sibling feeds.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (kind != null) params.set("kind", kind);
    if (netuid != null) params.set("netuid", String(netuid));
    if (cursor != null) params.set("cursor", cursor);
    if (block_start != null) params.set("block_start", String(block_start));
    if (block_end != null) params.set("block_end", String(block_end));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP get_account_events tool use. The account_events D1 write path is
    // retired (#4772), so a tier miss resolves through buildAccountEvents over an
    // empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/events`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      buildAccountEvents([], ss58, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      event_count: data.event_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      events: (data.events ?? []).map((e) => ({
        block_number: e.block_number ?? null,
        event_index: e.event_index ?? null,
        event_kind: e.event_kind ?? null,
        hotkey: e.hotkey ?? null,
        coldkey: e.coldkey ?? null,
        netuid: e.netuid ?? null,
        uid: e.uid ?? null,
        amount_tao: e.amount_tao ?? null,
        alpha_amount: e.alpha_amount ?? null,
        observed_at: e.observed_at ?? null,
        extrinsic_index: e.extrinsic_index ?? null,
      })),
    };
  },

  async account_history(
    { ss58, netuid, from, to, limit, offset, cursor },
    context,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty series.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same FEED_PAGINATION bounds the /history route's clamp applies, so a
    // GraphQL caller cannot request a wider page than REST allows;
    // netuid/from/to/cursor are forwarded verbatim for the route to re-parse,
    // matching account_events and the sibling feed resolvers.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (netuid != null) params.set("netuid", String(netuid));
    if (from != null) params.set("from", from);
    if (to != null) params.set("to", to);
    if (cursor != null) params.set("cursor", cursor);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> D1
    // (loadAccountHistory) fallback the REST handler and MCP get_account_history
    // tool use -- a cold store is a schema-stable empty series, never a
    // GraphQL error.
    const historyOptions = {
      netuid: netuid ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
      limit: safeLimit,
      offset: safeOffset,
      cursor: cursor ?? undefined,
    };
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/history`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadAccountHistory(d1Runner(context.env), ss58, historyOptions));
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      day_count: data.day_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      days: (data.days ?? []).map((d) => ({
        day: d.day ?? null,
        netuid: d.netuid ?? null,
        event_count: d.event_count ?? null,
        event_kinds: Array.isArray(d.event_kinds) ? d.event_kinds : [],
        first_block: d.first_block ?? null,
        last_block: d.last_block ?? null,
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

  async chain_turnover({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_TURNOVER_WINDOW;
    if (!Object.hasOwn(CHAIN_TURNOVER_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_TURNOVER_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_TURNOVER_LIMIT_DEFAULT,
      maxLimit: CHAIN_TURNOVER_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainTurnover([])
    // fallback contract REST's handleChainTurnover uses: unlike the chain_weights
    // family there is no D1 live-rollup loader here (the churn needs two
    // neuron_daily snapshots, which only the Postgres tier serves), so a cold
    // store yields the schema-stable empty/non-comparable envelope, never a
    // GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/turnover", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
      buildChainTurnover([], {
        window: requestedWindow,
        startDate: null,
        endDate: null,
        limit: safeLimit,
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      start_date: data.start_date ?? null,
      end_date: data.end_date ?? null,
      comparable: data.comparable ?? false,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        validators_start: 0,
        validators_end: 0,
        validators_entered: 0,
        validators_exited: 0,
        validator_retention: null,
        stability_score: null,
      },
      stability_distribution: data.stability_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_activity({ window }, context) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainActivity
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainActivity
    // fallback handleChainActivity uses; the tier owns the per-day extrinsic/block
    // rollup (no logic duplicated here), and a cold store yields a schema-stable
    // empty series.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/activity", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ?? buildChainActivity({ window: label });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      days: (data.days ?? []).map((d) => ({
        day: d.day,
        block_count: d.block_count ?? 0,
        extrinsic_count: d.extrinsic_count ?? 0,
        event_count: d.event_count ?? 0,
        successful_extrinsics: d.successful_extrinsics ?? 0,
        success_rate: d.success_rate ?? null,
        unique_signers: d.unique_signers ?? 0,
      })),
    };
  },

  async chain_calls(
    { window, group_by: groupBy, limit, call_module: callModule },
    context,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainCalls
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedGroupBy = groupBy ?? "module";
    if (
      requestedGroupBy !== "module" &&
      requestedGroupBy !== "module_function"
    ) {
      throw new GraphQLError(
        "group_by must be one of: module, module_function.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    if (callModule != null && callModule.length > 100) {
      throw new GraphQLError("call_module must be at most 100 characters.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, { defaultLimit: 50, maxLimit: 100 });
    const params = new URLSearchParams();
    params.set("window", label);
    params.set("group_by", requestedGroupBy);
    params.set("limit", String(safeLimit));
    if (callModule != null) params.set("call_module", callModule);
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainCalls fallback
    // handleChainCalls uses; the tier owns the call-mix aggregation (no logic
    // duplicated here), and a cold store yields a schema-stable empty breakdown.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/calls", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ?? buildChainCalls({ window: label, groupBy: requestedGroupBy });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      group_by: data.group_by ?? requestedGroupBy,
      observed_at: data.observed_at ?? null,
      total_extrinsics: data.total_extrinsics ?? 0,
      call_count: data.call_count ?? 0,
      calls: (data.calls ?? []).map((c) => ({
        call_module: c.call_module,
        call_function: c.call_function ?? null,
        count: c.count ?? 0,
        share: c.share ?? null,
      })),
    };
  },

  async chain_fees({ window, limit, call_module: callModule }, context) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainFees
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (callModule != null && callModule.length > 100) {
      throw new GraphQLError("call_module must be at most 100 characters.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, { defaultLimit: 25, maxLimit: 100 });
    const params = new URLSearchParams();
    params.set("window", label);
    params.set("limit", String(safeLimit));
    if (callModule != null) params.set("call_module", callModule);
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainFees fallback
    // handleChainFees uses; the tier owns the daily/median/payer aggregation (no
    // logic duplicated here), and a cold store yields a schema-stable empty series.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/fees", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ?? buildChainFees({ window: label });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      daily: (data.daily ?? []).map((d) => ({
        day: d.day,
        extrinsic_count: d.extrinsic_count ?? 0,
        total_fee_tao: d.total_fee_tao ?? null,
        avg_fee_tao: d.avg_fee_tao ?? null,
        median_fee_tao: d.median_fee_tao ?? null,
        total_tip_tao: d.total_tip_tao ?? null,
        avg_tip_tao: d.avg_tip_tao ?? null,
        median_tip_tao: d.median_tip_tao ?? null,
      })),
      top_fee_payers: (data.top_fee_payers ?? []).map((p) => ({
        signer: p.signer,
        total_fee_tao: p.total_fee_tao ?? null,
        total_tip_tao: p.total_tip_tao ?? null,
        extrinsic_count: p.extrinsic_count ?? 0,
      })),
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

  async chain_serving({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_SERVING_WINDOW;
    if (!Object.hasOwn(CHAIN_SERVING_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_SERVING_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_SERVING_LIMIT_DEFAULT,
      maxLimit: CHAIN_SERVING_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainServing
    // fallback contract REST's chainServing route uses -- a cold store yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/serving", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainServing(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_SERVING_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_servers: 0,
        announcements: 0,
        announcements_per_server: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_axon_removals({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_AXON_REMOVALS_WINDOW;
    if (!Object.hasOwn(CHAIN_AXON_REMOVALS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_AXON_REMOVALS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
      maxLimit: CHAIN_AXON_REMOVALS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainAxonRemovals
    // fallback contract REST's handleChainAxonRemovals uses -- a cold store yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/axon-removals", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainAxonRemovals(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_AXON_REMOVALS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_removers: 0,
        removals: 0,
        removals_per_remover: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_deregistrations({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW;
    if (!Object.hasOwn(CHAIN_DEREGISTRATIONS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(
          requestedWindow,
          CHAIN_DEREGISTRATIONS_WINDOWS,
        ),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
      maxLimit: CHAIN_DEREGISTRATIONS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainDeregistrations
    // fallback contract REST's handleChainDeregistrations uses -- a cold store yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/deregistrations", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainDeregistrations(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_DEREGISTRATIONS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_deregistered_hotkeys: 0,
        deregistrations: 0,
        deregistrations_per_hotkey: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_registrations({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_REGISTRATIONS_WINDOW;
    if (!Object.hasOwn(CHAIN_REGISTRATIONS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_REGISTRATIONS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
      maxLimit: CHAIN_REGISTRATIONS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainRegistrations
    // fallback contract REST's handleChainRegistrations uses -- a cold store yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/registrations", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainRegistrations(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_REGISTRATIONS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_registrants: 0,
        registrations: 0,
        registrations_per_registrant: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_prometheus({ window, limit }, context) {
    const requestedWindow = window ?? DEFAULT_CHAIN_PROMETHEUS_WINDOW;
    if (!Object.hasOwn(CHAIN_PROMETHEUS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_PROMETHEUS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_PROMETHEUS_LIMIT_DEFAULT,
      maxLimit: CHAIN_PROMETHEUS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainPrometheus
    // fallback contract REST's handleChainPrometheus uses -- a cold store yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/prometheus", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainPrometheus(graphqlD1(context), {
        windowLabel: requestedWindow,
        windowDays: CHAIN_PROMETHEUS_WINDOWS[requestedWindow],
        limit: safeLimit,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_exporters: 0,
        announcements: 0,
        announcements_per_exporter: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_signers(
    { window, limit, sort, call_module: callModule },
    context,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainSigners
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty leaderboard.
    const windowUrl = new URL(context.request.url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const { label, days, error } = analyticsWindow(windowUrl);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same CHAIN_SIGNERS_SORTS allow-list REST validates against; sort is
    // optional (null -> the loader's tx_count default), so only a non-null
    // value is checked.
    if (sort != null && !CHAIN_SIGNERS_SORTS.includes(sort)) {
      throw new GraphQLError(
        `"${sort}" is not a supported sort. Supported: ${CHAIN_SIGNERS_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    if (callModule != null && callModule.length > 100) {
      throw new GraphQLError("call_module must be at most 100 characters.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_SIGNERS_LIMIT_DEFAULT,
      maxLimit: CHAIN_SIGNERS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", label);
    params.set("limit", String(safeLimit));
    if (sort != null) params.set("sort", sort);
    if (callModule != null) params.set("call_module", callModule);
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> loadChainSigners
    // fallback contract handleChainSigners uses, including the KV health:meta
    // observed_at stamp REST passes; no ranking/aggregation logic is duplicated
    // here, and a cold store yields a schema-stable empty leaderboard.
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(context, "/api/v1/chain/signers", params),
      "METAGRAPH_EXTRINSICS_SOURCE",
    );
    const data =
      tier ??
      (
        await loadChainSigners(graphqlD1(context), {
          windowLabel: label,
          windowDays: days,
          observedAt: await loadObservedAt(context),
          limit: safeLimit,
          callModule,
          sort,
        })
      ).data;
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      sort: data.sort ?? CHAIN_SIGNERS_SORTS[0],
      observed_at: data.observed_at ?? null,
      signer_count: data.signer_count ?? 0,
      signers: (data.signers ?? []).map((entry) => ({
        signer: entry.signer,
        tx_count: entry.tx_count ?? 0,
        total_fee_tao: entry.total_fee_tao ?? null,
        total_tip_tao: entry.total_tip_tao ?? null,
        last_tx_block: entry.last_tx_block ?? null,
      })),
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

  async chain_alpha_volume({ limit }, context) {
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
      maxLimit: CHAIN_ALPHA_VOLUME_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> loadChainAlphaVolume
    // fallback contract REST's handleChainAlphaVolume uses -- a cold store yields
    // a schema-stable zeroed card (subnet_count 0, empty leaderboard, neutral
    // sentiment), never a GraphQL error. Fixed 24h window, no window arg.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/alpha-volume", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ??
      (await loadChainAlphaVolume(graphqlD1(context), { limit: safeLimit }));
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? "24h",
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        buy_volume_alpha: 0,
        sell_volume_alpha: 0,
        total_volume_alpha: 0,
        buy_volume_tao: 0,
        sell_volume_tao: 0,
        total_volume_tao: 0,
        buy_count: 0,
        sell_count: 0,
        net_volume_alpha: 0,
        sentiment_ratio: null,
        sentiment: "neutral",
      },
      volume_distribution: data.volume_distribution ?? null,
      subnets: data.subnets || [],
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

  async subnet_health_trends({ netuid }, context) {
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetHealthTrends D1
    // fallback contract REST's handleHealthTrends and the
    // get_subnet_health_trends MCP tool share -- the route takes no window arg
    // (it returns every configured window), and a subnet with no probe history
    // yields a schema-stable zeroed-windows card, never a GraphQL error. The
    // tier owns the per-surface uptime/latency aggregation; nothing is
    // duplicated here.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/health/trends`),
        "METAGRAPH_HEALTH_SOURCE",
      )) ??
      (await loadSubnetHealthTrends(graphqlD1(context), netuid, {
        observedAt: await loadObservedAt(context),
      }));
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      windows: data.windows ?? {},
    };
  },

  async subnet_uptime({ netuid, window, min_samples: minSamples }, context) {
    // Same 90d/1y window validation handleUptime / get_subnet_uptime use -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    // parseUptimeWindow(undefined) → "90d"; a supplied bad value → null.
    const windowParam = parseUptimeWindow(window);
    if (windowParam === null) {
      throw new GraphQLError(unsupportedWindowMessage(window, UPTIME_WINDOWS), {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same non-negative min_samples floor the REST route and MCP tool enforce
    // (GraphQL Int coercion already rejects non-integers at parse time).
    if (minSamples != null && minSamples < 0) {
      throw new GraphQLError("min_samples must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const sampleFloor = minSamples == null ? null : minSamples;
    const params = new URLSearchParams();
    params.set("window", windowParam);
    if (sampleFloor !== null) params.set("min_samples", String(sampleFloor));
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetUptime D1
    // fallback contract REST's handleUptime and the get_subnet_uptime MCP tool
    // share -- a subnet with no daily history yields a schema-stable empty
    // surfaces card, never a GraphQL error. The tier owns the
    // surface_uptime_daily aggregation; nothing is duplicated here.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/uptime`,
          params,
        ),
        "METAGRAPH_HEALTH_SOURCE",
      )) ??
      (await loadSubnetUptime(graphqlD1(context), netuid, {
        window: windowParam,
        observedAt: await loadObservedAt(context),
        minSamples: sampleFloor,
      }));
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      reliability: data.reliability ?? null,
      surfaces: data.surfaces ?? [],
    };
  },

  async rpc_usage({ window }, context) {
    const requestedWindow = window ?? DEFAULT_ANALYTICS_WINDOW;
    if (!Object.hasOwn(ANALYTICS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, ANALYTICS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // Same tryPostgresTier(METAGRAPH_RPC_USAGE_SOURCE) -> loadRpcUsage fallback
    // contract REST's handleRpcUsage and the get_rpc_usage MCP tool share -- a
    // cold store yields a schema-stable zeroed card, never a GraphQL error.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/rpc/usage", params),
        "METAGRAPH_RPC_USAGE_SOURCE",
      )) ??
      (await loadRpcUsage(graphqlD1(context), {
        window: requestedWindow,
        observedAt: await loadObservedAt(context),
      }));
    const summary = data.summary ?? {};
    const latency = summary.latency_ms ?? {};
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      bucket_granularity: data.bucket_granularity ?? null,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      summary: {
        total_requests: summary.total_requests ?? 0,
        ok_requests: summary.ok_requests ?? 0,
        error_requests: summary.error_requests ?? 0,
        error_rate: summary.error_rate ?? null,
        failover_requests: summary.failover_requests ?? 0,
        failover_rate: summary.failover_rate ?? null,
        cache_hits: summary.cache_hits ?? 0,
        cache_hit_rate: summary.cache_hit_rate ?? null,
        latency_ms: {
          p50: latency.p50 ?? null,
          p95: latency.p95 ?? null,
          avg: latency.avg ?? null,
        },
      },
      endpoints: data.endpoints ?? [],
      networks: data.networks ?? [],
      buckets: data.buckets ?? [],
    };
  },

  async registry_leaderboards({ board, limit }, context) {
    // Same board allowlist handleLeaderboards enforces -- an unknown board is a
    // GraphQL BAD_USER_INPUT error, mirroring REST's invalid_query 400 rather
    // than silently resolving to an empty board.
    if (board != null && !LEADERBOARD_BOARDS.includes(board)) {
      throw new GraphQLError(
        `Unknown board "${board}". Valid boards: ${LEADERBOARD_BOARDS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same default 20 / max 100 parseLimitParam gives REST. A non-integer or
    // out-of-range limit is rejected there, so reject it here too instead of
    // silently clamping.
    if (
      limit != null &&
      (!Number.isInteger(limit) || limit < 1 || limit > 100)
    ) {
      throw new GraphQLError(
        `\`limit\` must be an integer between 1 and 100. Received "${limit}".`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Reuses handleLeaderboards' own projection + D1 reads via the shared
    // composer, so REST and GraphQL can never drift apart on board composition.
    const { data } = await composeLeaderboardsData(context.env, {
      board: board ?? null,
      limit: limit ?? 20,
    });
    // formatLeaderboards always populates all five fields -- schema_version and
    // source are literals there, boards is always built, and board/observed_at
    // are already null-normalized. No `??` fallbacks: unlike the Postgres-tier
    // resolvers (whose upstream shape is arbitrary), this data has exactly one
    // producer, so a fallback would be an unreachable branch.
    return {
      schema_version: data.schema_version,
      board: data.board,
      observed_at: data.observed_at,
      source: data.source,
      boards: data.boards,
    };
  },

  async chain_performance(_args, context) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainPerformance([])
    // cold fallback contract handleChainPerformance / MCP get_chain_performance
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainPerformance validates
    // against an EMPTY param allowlist, so there is no window/limit arg to
    // mirror -- current snapshot only.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/performance"),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildChainPerformance([]);
    return {
      schema_version: data.schema_version ?? 1,
      subnet_count: data.subnet_count ?? 0,
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

  async chain_concentration(_args, context) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainConcentration([])
    // cold fallback contract handleChainConcentration / MCP get_chain_concentration
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainConcentration reads every
    // subnet's neurons with no netuid filter and validates against an EMPTY
    // param allowlist, so there is no window/limit arg to mirror -- current
    // snapshot only.
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/concentration"),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildChainConcentration([]);
    return {
      schema_version: data.schema_version ?? 1,
      subnet_count: data.subnet_count ?? 0,
      neuron_count: data.neuron_count ?? 0,
      entity_count: data.entity_count ?? 0,
      uids_per_entity: data.uids_per_entity ?? null,
      captured_at: data.captured_at ?? null,
      stake: data.stake ?? null,
      emission: data.emission ?? null,
      entity_stake: data.entity_stake ?? null,
      entity_emission: data.entity_emission ?? null,
      validator_stake: data.validator_stake ?? null,
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

  async subnet_turnover({ netuid, window }, context) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError("netuid must be a u16 subnet id (0-65535).", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow the REST turnover handler uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const { label, error } = parseHistoryWindow(window);
    if (error) {
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildTurnover([]) empty-card
    // fallback contract the REST handler uses (neuron_daily boundary snapshots); a
    // subnet with no boundary rows in the window is a schema-stable empty card,
    // never a GraphQL error. Mirrors the default scorecard (REST's ?changes=true
    // detail is omitted).
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/turnover`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildTurnover([], netuid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      start_date: data.start_date ?? null,
      end_date: data.end_date ?? null,
      comparable: data.comparable ?? false,
      validators_start: data.validators_start ?? 0,
      validators_end: data.validators_end ?? 0,
      validators_entered: data.validators_entered ?? 0,
      validators_exited: data.validators_exited ?? 0,
      validator_retention: data.validator_retention ?? null,
      neurons_start: data.neurons_start ?? 0,
      neurons_end: data.neurons_end ?? 0,
      uids_deregistered: data.uids_deregistered ?? 0,
      neuron_retention: data.neuron_retention ?? null,
      stability_score: data.stability_score ?? null,
    };
  },

  async account_balance({ ss58 }, context) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid Finney ss58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Live chain RPC, not the Postgres tier -- reuses loadAccountBalance's own
    // KV cache/TTL, matching REST's handleAccountBalance exactly. balance_tao
    // stays null on RPC failure (schema-stable), never a GraphQL error.
    // loadAccountBalance always sets schema_version/ss58/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadAccountBalance(context.env, ss58);
  },

  async sudo_key(_args, context) {
    // Live chain RPC, not the Postgres tier -- reuses loadSudoKey's own KV
    // cache/TTL, matching REST's sudo/key handler exactly. hotkey stays null
    // on RPC failure or a renounced sudo (schema-stable), never a GraphQL
    // error. loadSudoKey always sets schema_version/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadSudoKey(context.env);
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
