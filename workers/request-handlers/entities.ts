// Single-entity chain-data handlers: the cheap per-key D1 lookups behind the
// metagraph, account, block, and extrinsic routes (extracted from workers/api.ts
// per #1763).
//
// These are the "fetch one entity by its key" reads — a subnet's metagraph, one
// UID's neuron + history, a per-subnet history rollup, an account summary/events/
// subnets, the block + extrinsic feeds and their detail rows. Every handler is
// null-safe by design: an unbound or a cold store returns a schema-stable empty/zero
// payload (never a 404 or a throw), matching the live tiers the analytics module
// already owns.
//
// Dependency wiring (the analytics.ts pattern): the query-param guards
// (`validateQueryParams` / `analyticsQueryError`) live in
// request-handlers/analytics.ts, which this module imports directly.
// analytics.ts imports nothing from here, so the two are a clean leaf chain
// with no cycle — no injected deps are needed. Everything else is imported
// straight from the src/* leaf modules + config. api.ts imports the
// handlers back and dispatches them from the router.

import { loadSubnetWeightSettersColdTier } from "../../src/subnet-weight-setters-loader.ts";
import { loadSubnetWeightsColdTier } from "../../src/subnet-weights-loader.ts";
import { loadSubnetEventCardColdTier } from "../../src/subnet-event-card-loader.ts";
import { CHAIN_PROMETHEUS_ROLLUP } from "../../src/chain-event-rollup-cold-tier.ts";
import {
  CHAIN_SERVING_ROLLUP,
  CHAIN_STAKE_MOVES_ROLLUP,
  CHAIN_STAKE_TRANSFERS_ROLLUP,
  CHAIN_REGISTRATIONS_ROLLUP,
} from "../../src/chain-event-rollup-cold-tier.ts";
import {
  DEFAULT_CHAIN_NETWORK,
  networkKvKey,
  type ChainNetworkId,
} from "../../src/chain-network.ts";
import { resolveClientIp } from "../config.ts";

import {
  errorResponse,
  X_METAGRAPH_ARTIFACT_SOURCE_HEADER,
  type CacheProfile,
} from "../http.ts";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.ts";
import { tryDataApiTier } from "../data-api-tier.ts";
import { csvRequested, csvResponse } from "../csv.ts";
import { recordExceptionEvent } from "../../src/usage-telemetry.ts";
import {
  ResponseSchemaDriftError,
  validateResponseTripwire,
} from "../../src/response-validation-tripwire.ts";
import {
  analyticsQueryError,
  markDataApiTierFallbackResponse,
} from "./analytics.ts";
import {
  overlayAccountPositionHistoryColdTier,
  overlayNeuronHistoryColdTier,
  overlaySubnetHistoryColdTier,
  overlayValidatorHistoryColdTier,
} from "../../src/neuron-daily-cold-tier.ts";
import {
  historyWindow,
  pageLimit,
  parseRouteQuery,
  resolvePage,
  resolveWindow,
  routeInt,
  routeQuery,
  routeText,
  routeValue,
} from "../../src/route-query.ts";
import type { QueryError } from "../list-query.ts";
import { projectionMeta } from "../../src/field-projection.ts";
import {
  buildGlobalValidators,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
  parseNeuronFields,
  projectNeuronPayload,
  buildValidatorDetail,
  NO_ALPHA_PRICES,
  overlayFeaturedValidators,
} from "../../src/metagraph-neurons.ts";
import { buildAccountsList } from "../../src/accounts-list.ts";
import { buildTopHoldersList } from "../../src/top-holders.ts";
import { buildSubnetHyperparams } from "../../src/subnet-hyperparams.ts";
import { buildSubnetHyperparamsHistory } from "../../src/subnet-hyperparams-history.ts";
import {
  buildSubnetLifecycle,
  loadSubnetLifecycle,
} from "../../src/subnet-lifecycle-read.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  DEFAULT_YIELD_HISTORY_WINDOW,
  YIELD_HISTORY_WINDOWS,
} from "../../src/subnet-yield.ts";
import { buildSubnetEmissionSplitHistory } from "../../src/emission-split.ts";
import { buildSubnetOwnerCapture } from "../../src/owner-capture.ts";
import {
  ownerCutFlowLegs,
  OWNER_CUT_FLOW_WINDOW,
} from "../../src/owner-cut-disposition.ts";
import { buildSubnetMinerFairness } from "../../src/miner-fairness.ts";
import {
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  DEFAULT_SUBNET_REVENUE_WINDOW,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
  SUBNET_REVENUE_WINDOW_DAYS,
} from "../../src/route-limits.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
} from "../../src/neuron-history.ts";
import {
  INGESTED_EVENT_KINDS,
  DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_WINDOWS,
  buildAccountHistory,
  buildAccountSummary,
  buildAccountEvents,
  buildSubnetEvents,
  buildSubnetEventSummary,
  buildAccountTransfers,
  buildAccountSubnets,
  buildBlockEvents,
} from "../../src/account-events.ts";
import { loadSubnetEventSummaryColdTier } from "../../src/subnet-event-summary-cold-tier.ts";
import { loadAccountHistoryColdTier } from "../../src/account-history-cold-tier.ts";
import { buildAccountPortfolio } from "../../src/account-portfolio.ts";
import {
  accountSummaryGapMessage,
  answerAccountSummary,
  ACCOUNT_SUMMARY_GAP_CODE,
} from "../../src/account-summary-card.ts";
import {
  buildAccountPositions,
  unavailableAccountPositions,
} from "../../src/account-nominator-positions.ts";
import { buildAccountPositionHistory } from "../../src/account-position-history.ts";
import { buildAccountIdentity } from "../../src/account-identity.ts";
import { buildAccountIdentityHistory } from "../../src/account-identity-history.ts";
import {
  isFinneySs58Address,
  loadAccountBalance,
} from "../../src/account-balance.ts";
import { loadAccountRootClaim } from "../../src/account-root-claim.ts";
import {
  loadAccountChildren,
  loadAccountParents,
} from "../../src/child-hotkey-delegation.ts";
import { loadSudoKey } from "../../src/sudo-key.ts";
import { H160_PATTERN, loadAddressMapping } from "../../src/address-mapping.ts";
import { loadNetworkParameters } from "../../src/network-parameters.ts";
import { loadRandomnessStatus } from "../../src/randomness.ts";
import {
  ENTITY_LABELS_ARTIFACT,
  entityLabelsIndex,
  labelsForSs58,
} from "../../src/entity-labels.ts";
import { isU16Netuid, loadSubnetRecycled } from "../../src/subnet-recycled.ts";
import { loadSubnetBurn } from "../../src/subnet-burn.ts";
import { loadChainBurn } from "../../src/chain-burn.ts";
import {
  BURN_HISTORY_WINDOWS,
  buildSubnetBurnHistory,
  loadSubnetBurnHistory,
} from "../../src/subnet-burn-history.ts";
import {
  buildSubnetHolders,
  loadSubnetHolders,
} from "../../src/subnet-holders.ts";
import {
  buildChainHolders,
  loadChainHolders,
  CHAIN_HOLDERS_SORTS,
} from "../../src/chain-holders.ts";
import { buildIndexerLag, loadIndexerLag } from "../../src/indexer-lag.ts";
import {
  buildChainConcentrationHistory,
  declineChainConcentrationHistory,
  loadChainConcentrationHistory,
} from "../../src/chain-concentration-history.ts";
import {
  buildPipelineHistory,
  declinePipelineHistory,
  loadPipelineHistory,
} from "../../src/emission-pipeline-history.ts";
import {
  buildEmissionChanges,
  loadEmissionChanges,
  EMISSION_CHANGE_KINDS,
} from "../../src/emission-gate-changes.ts";
import {
  buildNominatorPositions,
  loadNominatorPositions,
} from "../../src/validator-nominator-positions.ts";
import {
  buildFailureReasons,
  declineFailureReasons,
  loadFailureReasons,
} from "../../src/failure-reasons.ts";
import {
  buildTaoUsdSeries,
  loadTaoUsdSeries,
  TAO_USD_WINDOWS,
  usdPerTaoOrNull as sharedUsdPerTaoOrNull,
} from "../../src/tao-usd-series.ts";
import {
  buildSurfaceHistory,
  loadSurfaceHistory,
} from "../../src/surface-history.ts";
import {
  buildValidatorEconomics,
  buildValidatorEconomicsHistory,
  VALIDATOR_ECONOMICS_HISTORY_ROW_CAP,
  VALIDATOR_ECONOMICS_HISTORY_WINDOWS,
  groupNeuronsByNetuid,
  rankValidatorEconomics,
  type ValidatorEconomicsRow,
  type ValidatorNeuron,
} from "../../src/validator-economics.ts";
import { ATTRIBUTION_WINDOW_DAYS } from "../../src/route-limits.ts";
import { loadSubnetLease } from "../../src/subnet-lease.ts";
import {
  isCrowdloanId,
  loadCrowdloan,
  loadCrowdloans,
} from "../../src/crowdloans.ts";
import { computeStakeQuote } from "../../src/stake-quote.ts";
import { buildRuntimeVersionHistory } from "../../src/runtime-versions.ts";
import { loadRuntimeVersionHistoryColdTier } from "../../src/runtime-versions-cold-tier.ts";
import { loadUpgradeRadar } from "../../src/upgrade-radar.ts";
import { buildBlock, buildBlockFeed } from "../../src/blocks.ts";
import {
  loadBlockFeedColdTier,
  loadBlockColdTier,
} from "../../src/blocks-cold-tier.ts";
import {
  loadAccountExtrinsicsColdTier,
  loadBlockExtrinsicsColdTier,
  loadExtrinsicColdTier,
  loadExtrinsicFeedColdTier,
} from "../../src/extrinsics-cold-tier.ts";
import {
  loadAccountEventsColdTier,
  loadBlockEventsColdTier,
} from "../../src/events-cold-tier.ts";
import { answerSubnetEvents } from "../../src/subnet-events-answer.ts";
import {
  answerChainIdentityHistory,
  answerSubnetIdentityHistory,
} from "../../src/identity-history-answer.ts";
import {
  answerBlockDetail,
  answerExtrinsicDetail,
  chainDetailGapMessage,
  isEmptyEventPayload,
  isEmptyExtrinsicPayload,
  loadBlockEventsHotTier,
  loadBlockExtrinsicsHotTier,
  type ChainDetailAnswer,
} from "../../src/chain-detail-hot-tier.ts";
import {
  loadAccountRegistrationsColdTier,
  loadAccountPrometheusColdTier,
  loadAccountServingColdTier,
  loadAccountCounterpartiesColdTier,
  loadAccountStakeFlowColdTier,
  loadAccountStakeMovesColdTier,
  loadAccountTransfersColdTier,
  loadAccountWeightSettersColdTier,
  loadCounterpartyRelationshipColdTier,
  loadValidatorNominatorsColdTier,
} from "../../src/account-feeds-cold-tier.ts";
import { loadAccountPositionsColdTier } from "../../src/nominator-positions-cold-tier.ts";
import { loadAccountPositionsFromStore } from "../../src/nominator-positions-hot-tier.ts";
import {
  loadSubnetHyperparamsColdTier,
  loadSubnetHyperparamsHistoryColdTier,
} from "../../src/subnet-hyperparams-cold-tier.ts";
import {
  loadAccountIdentityColdTier,
  loadAccountIdentityHistoryColdTier,
} from "../../src/account-identity-cold-tier.ts";
import { answerAccountEntities } from "../../src/account-entities-answer.ts";
import { loadSelfHealthColdTier } from "../../src/self-health-cold-tier.ts";
import { loadLatestLaneHealth } from "../../src/lane-health.ts";
import { withLaneHealth } from "../../src/self-health.ts";
import {
  loadLaneMaxGap,
  LANE_ALARM_CADENCE_WINDOW_MS,
} from "../../src/lane-alarm.ts";
import { loadTopHoldersFlowTier } from "../../src/top-holders-flow-tier.ts";
import { buildBlocksSummary } from "../../src/blocks-summary.ts";
import { loadBlocksSummaryFromArtifact } from "../../src/blocks-summary-artifact.ts";
import {
  EXTRINSICS_CSV_COLUMNS,
  extrinsicsToCsvRows,
  buildExtrinsic,
  buildExtrinsicFeed,
  buildAccountExtrinsics,
  buildBlockExtrinsics,
} from "../../src/extrinsics.ts";
import {
  buildConcentration,
  buildChainConcentration,
  buildConcentrationHistory,
  buildSubnetConcentrationRanking,
  CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
  parseConcentrationRankingQuery,
} from "../../src/concentration.ts";
import {
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { buildChainPerformance } from "../../src/chain-performance.ts";
import { buildChainYield } from "../../src/chain-yield.ts";
import { buildSelfHealth } from "../../src/self-health.ts";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "../../src/subnet-idle-stake.ts";
import { buildChainIdentityHistory } from "../../src/chain-identity-history.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  DEFAULT_PERFORMANCE_HISTORY_WINDOW,
  PERFORMANCE_HISTORY_WINDOWS,
} from "../../src/subnet-performance.ts";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
} from "../../src/counterparties.ts";
import {
  buildTurnover,
  buildTurnoverChanges,
  turnoverChangeDetail,
} from "../../src/turnover.ts";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "../../src/subnet-weights.ts";
import {
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
  SUBNET_WEIGHT_SETTERS_LIMIT,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  buildSubnetWeightSetters,
} from "../../src/subnet-weight-setters.ts";
import {
  buildSubnetServing,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "../../src/subnet-serving.ts";
import {
  buildSubnetPrometheus,
  SUBNET_PROMETHEUS_WINDOWS,
  DEFAULT_SUBNET_PROMETHEUS_WINDOW,
} from "../../src/subnet-prometheus.ts";
import {
  buildSubnetStakeMoves,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "../../src/subnet-stake-moves.ts";
import {
  buildSubnetStakeTransfers,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "../../src/subnet-stake-transfers.ts";
import {
  buildSubnetRegistrations,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "../../src/subnet-registrations.ts";
import {
  buildSubnetAxonRemovals,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "../../src/subnet-axon-removals.ts";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "../../src/subnet-deregistrations.ts";
import {
  loadAccountDeregistrationsFromArtifact,
  loadSubnetDeregistrationsFromArtifact,
  markDeregistrationsNotDerived,
} from "../../src/chain-deregistrations-artifact.ts";
import {
  buildStakeFlow,
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
} from "../../src/stake-flow.ts";
import { buildAlphaVolume } from "../../src/alpha-volume.ts";
import { loadSubnetAlphaVolumeFromArtifact } from "../../src/subnet-alpha-volume-artifact.ts";
import {
  buildSubnetOhlc,
  normalizeInterval,
  OHLC_INTERVALS,
} from "../../src/subnet-ohlc.ts";
import {
  loadTaoUsdAtInstants,
  loadTaoUsdBuckets,
  ohlcUsdWindowStart,
  taoUsdBucketMap,
  withAlphaUsdCandles,
} from "../../src/alpha-usd-history.ts";
import { loadSubnetOhlcColdTier } from "../../src/subnet-ohlc-cold-tier.ts";
import {
  resolveLiveEconomics,
  subnetEconomicsRow,
} from "../../src/health-serving.ts";
import { KV_ECONOMICS_CURRENT } from "../../src/kv-keys.ts";
import { readArtifact, readHealthKv } from "../storage.ts";
import {
  SUBNET_REVENUE_FIELD_SOURCES,
  loadSubnetRevenue,
} from "../../src/revenue-load.ts";
import {
  loadSweepRecord,
  type SweepStoreDb,
} from "../../src/attribution-sweep.ts";
import { ATTRIBUTION_SWEEP_TABLES } from "../../src/read-store-tables.ts";
import {
  loadRevenueObservations,
  type RevenueStoreDb,
} from "../../src/revenue-observations.ts";
import {
  loadSubnetOwnerCut,
  subnetWalletRows,
  SUBNET_OWNER_CUT_FIELD_SOURCES,
  SUBNET_WALLETS_FIELD_SOURCES,
} from "../../src/wallets-load.ts";
import { withAlphaVolumeUsd } from "../../src/alpha-usd-overlay.ts";
import { withUsdAtTx } from "../../src/price-at-tx.ts";
import { readTaoUsdCurrentKv } from "../tao-usd-current.ts";
import { buildAccountStakeFlow } from "../../src/account-stake-flow.ts";
import { loadSubnetStakeFlowFromArtifact } from "../../src/subnet-stake-flow-artifact.ts";
import {
  buildValidatorNominators,
  NOMINATOR_WINDOWS,
  DEFAULT_NOMINATOR_WINDOW,
} from "../../src/validator-nominators.ts";
import { buildValidatorHistory } from "../../src/validator-history.ts";
import {
  buildAccountStakeMoves,
  ACCOUNT_STAKE_MOVES_WINDOWS,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "../../src/account-stake-moves.ts";
import {
  buildAccountWeightSetters,
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "../../src/account-weight-setters.ts";
import {
  buildAccountRegistrations,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "../../src/account-registrations.ts";
import {
  buildAccountServing,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "../../src/account-serving.ts";
import {
  buildAccountAxonRemovals,
  AXON_REMOVAL_WINDOWS,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "../../src/account-axon-removals.ts";
import {
  buildAccountPrometheus,
  PROMETHEUS_WINDOWS,
  DEFAULT_PROMETHEUS_WINDOW,
} from "../../src/account-prometheus.ts";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "../../src/account-deregistrations.ts";
import {
  buildMovers,
  MOVERS_WINDOWS,
  DEFAULT_MOVERS_WINDOW,
} from "../../src/movers.ts";
import {
  buildChainTurnover,
  CHAIN_TURNOVER_WINDOWS,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
} from "../../src/chain-turnover.ts";
import { buildSubnetIdentityHistory } from "../../src/subnet-identity-history.ts";
import { readStore, type ReadStoreDb } from "../../src/read-store.ts";
import { laneHealthStore } from "../../src/lane-health-store.ts";
import {
  ALPHA_PRICING_TABLES,
  CHAIN_CONCENTRATION_HISTORY_TABLES,
  EMISSION_CHANGES_TABLES,
  FAILURE_REASONS_TABLES,
  INDEXER_LAG_TABLES,
  SUBNET_BURN_HISTORY_TABLES,
  REVENUE_OBSERVATION_TABLES,
  SUBNET_SNAPSHOT_TABLES,
  SURFACE_HISTORY_TABLES,
  TAO_USD_TABLES,
  VALIDATOR_ECONOMICS_HISTORY_TABLES,
  VALIDATOR_ECONOMICS_RANKING_TABLES,
  VALIDATOR_ECONOMICS_TABLES,
} from "../../src/read-store-tables.ts";
import { loadSelfHealthNeon } from "../../src/self-health-neon.ts";
import { createPgSql } from "../../src/pg-sql.ts";

const RESPONSE_FORMATS = ["json", "csv"];
const NEURON_CSV_COLUMNS = [
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
];
const MOVERS_CSV_COLUMNS = [
  "netuid",
  "stake_start_tao",
  "stake_end_tao",
  "stake_delta_tao",
  "stake_pct_change",
  "emission_start_tao",
  "emission_end_tao",
  "emission_delta_tao",
  "emission_pct_change",
  "validators_start",
  "validators_end",
  "validators_delta",
  "neurons_start",
  "neurons_end",
  "neurons_delta",
];
const GLOBAL_VALIDATOR_CSV_COLUMNS = [
  "hotkey",
  "coldkey",
  "coldkey_count",
  "subnet_count",
  "uid_count",
  "total_stake_tao",
  "root_stake_tao",
  "alpha_stake_tao",
  "total_emission_tao",
  "nominator_count",
  "apy_estimate",
  "apy_estimate_eligible_subnet_count",
  "realized_return_1d",
  "realized_return_1w",
  "realized_return_1m",
  "stake_dominance",
  "avg_validator_trust",
  "max_validator_trust",
  "latest_captured_at",
  "latest_block_number",
  "subnets",
];
const ACCOUNTS_LIST_CSV_COLUMNS = [
  "hotkey",
  "coldkey",
  "coldkey_count",
  "subnet_count",
  "uid_count",
  "validator_count",
  "miner_count",
  "total_stake_tao",
  "total_emission_tao",
  "stake_dominance",
  "latest_captured_at",
  "latest_block_number",
  "subnets",
];
const TOP_HOLDERS_CSV_COLUMNS = [
  "ss58",
  "free_tao",
  "delegated_tao",
  "total_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
  "last_updated",
];
// Public per-nominator row shape from buildValidatorNominators (#5745); the
// internal `last_observed_ms` sort key is dropped before the response, so it is
// intentionally not a column here.
const VALIDATOR_NOMINATOR_CSV_COLUMNS = [
  "coldkey",
  "staked_tao",
  "unstaked_tao",
  "net_staked_tao",
  "gross_staked_tao",
  "event_count",
  "last_observed_at",
];
// CSV column order for the /api/v1/chain/turnover per-subnet churn leaderboard
// rows (the `subnets` array). The network rollup + stability distribution stay
// JSON-only, mirroring the chain-analytics leaderboard CSV exports.
const CHAIN_TURNOVER_CSV_COLUMNS = [
  "netuid",
  "validators_start",
  "validators_end",
  "validators_entered",
  "validators_exited",
  "validator_retention",
  "stability_score",
];
const SUBNET_YIELD_CSV_COLUMNS = [
  "uid",
  "hotkey",
  "role",
  "stake_tao",
  "emission_tao",
  "yield",
  "vs_median",
];
const SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "stake_gini",
  "stake_nakamoto_coefficient",
  "stake_top_10pct_share",
  "emission_gini",
  "emission_nakamoto_coefficient",
  "emission_top_10pct_share",
];

// CSV projection for the recent-block feed (#2528). The block rows are already
// flat (formatBlock), so the feed's own fields are the columns in read order.
const BLOCK_CSV_COLUMNS = [
  "block_number",
  "block_hash",
  "parent_hash",
  "author",
  "extrinsic_count",
  "event_count",
  "spec_version",
  "observed_at",
];
const SUBNET_YIELD_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "validator_count",
  "yield_count",
  "subnet_yield",
  "mean_yield",
  "median_yield",
  "p25_yield",
  "p75_yield",
  "p90_yield",
];

// Flat and explicitly ordered, like every other CSV column list here: the
// measured legs first, then the counts a reader compares them against, then
// the reconstructed absolutes. A chart and a spreadsheet consume the same row.
const SUBNET_EMISSION_SPLIT_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "validator_count",
  "miner_count",
  "earning_validator_count",
  "earning_miner_count",
  "validator_alpha",
  "miner_alpha",
  "uid_alpha",
  "validator_share_of_uid",
  "miner_share_of_uid",
  "owner_cut",
  "total_alpha",
  "owner_alpha",
  "owner_share",
  "validator_share",
  "miner_share",
  "alpha_price_tao",
  "total_tao",
];
// performanceHistoryPoint's flat row shape (src/subnet-performance.ts) — the
// reward-flow twin of SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS.
const SUBNET_PERFORMANCE_HISTORY_CSV_COLUMNS = [
  "snapshot_date",
  "neuron_count",
  "validator_count",
  "active_count",
  "incentive_gini",
  "incentive_nakamoto_coefficient",
  "incentive_top_10pct_share",
  "dividends_gini",
  "dividends_nakamoto_coefficient",
  "dividends_top_10pct_share",
  "trust_mean",
  "trust_median",
  "consensus_mean",
  "consensus_median",
  "validator_trust_mean",
  "validator_trust_median",
];
// formatHyperparamsHistoryEntry's row shape (src/subnet-hyperparams-history.ts);
// `hyperparameters` is the nested 33-field object, serialized as one JSON cell
// like the `axon` column on NEURON_CSV_COLUMNS.
const SUBNET_HYPERPARAMS_HISTORY_CSV_COLUMNS = [
  "block_number",
  "observed_at",
  "hyperparameters",
  "hyperparams_hash",
];
// The whole row (#10263) -- five flat scalars, no nested object to serialize.
// `netuid` is kept even on the per-subnet route, so a CSV saved from
// /subnets/7/lifecycle still says which subnet it describes once detached from
// the URL it came from.
const SUBNET_LIFECYCLE_CSV_COLUMNS = [
  "netuid",
  "event",
  "block_number",
  "observed_at",
  "predates_capture",
];
const ACCOUNT_EXTRINSICS_CSV_COLUMNS = [
  "extrinsic_id",
  "block_number",
  "extrinsic_index",
  "extrinsic_hash",
  "signer",
  "call_module",
  "call_function",
  "success",
  "fee_tao",
  "tip_tao",
  "observed_at",
];
// formatAccountDay row shape (#5741); event_kinds is a string[] that
// csvResponse serializes as a single cell, like the nested `subnets` column on
// the leaderboard exports.
const ACCOUNT_HISTORY_CSV_COLUMNS = [
  "day",
  "netuid",
  "event_count",
  "event_kinds",
  "first_block",
  "last_block",
];
const ACCOUNT_TRANSFERS_CSV_COLUMNS = [
  "block_number",
  "event_index",
  "from",
  "to",
  "amount_tao",
  "direction",
  "observed_at",
];
// The buildCounterparties row shape (list mode only -- the relationship
// drilldown's single-object shape doesn't map onto CSV rows, see
// handleAccountCounterparties).
const ACCOUNT_COUNTERPARTIES_CSV_COLUMNS = [
  "address",
  "sent_tao",
  "received_tao",
  "net_tao",
  "transfer_count",
  "last_block",
];
// Shared column order for the subnet + account event-stream feeds — the
// formatAccountEvent row shape, stable so a CSV consumer's columns never shift.
//
// This must stay COMPLETE, not merely stable: it is the only place the CSV
// projection is declared, so a field added to formatAccountEvent and not here
// is dropped from every ?format=csv export while the JSON contract keeps
// publishing it. That is how price_at_tx/price_basis went missing (#9537) --
// they were appended to the row and never to this list. Exported so
// tests/account-events pins the two against each other; a new field belongs in
// BOTH.
export const EVENTS_CSV_COLUMNS = [
  "block_number",
  "event_index",
  "event_kind",
  "hotkey",
  "coldkey",
  "netuid",
  "uid",
  "amount_tao",
  "alpha_amount",
  "observed_at",
  "extrinsic_index",
  // Appended, not interleaved: existing consumers' column positions are part
  // of the stability promise above.
  "price_at_tx",
  "price_basis",
  // The fiat companion (#8602). Empty for any event predating tao_usd_index --
  // an export that omitted the columns entirely would be a quietly different
  // answer to the same question, and CSV is the format most likely to be
  // charted offline where a missing column is least visible.
  "usd_at_tx",
  "usd_basis",
];
// The formatIdentityHistoryEntry row shape (src/subnet-identity-history.ts):
// one SubnetIdentitiesV3 snapshot per row, stable so a CSV consumer's columns
// never shift.
const SUBNET_IDENTITY_HISTORY_CSV_COLUMNS = [
  "block_number",
  "observed_at",
  "subnet_name",
  "symbol",
  "description",
  "github_repo",
  "subnet_url",
  "discord",
  "logo_url",
  "identity_hash",
];
// The formatAccountIdentityHistoryEntry row shape
// (src/account-identity-history.ts): keyed by account, so it carries no
// block_number (account_identity has no chain block height, only captured_at)
// and uses the account_identity field names rather than the subnet identity
// fields.
const ACCOUNT_IDENTITY_HISTORY_CSV_COLUMNS = [
  "observed_at",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "identity_hash",
];

function validateResponseFormat(url: URL) {
  const raw = url.searchParams.get("format");
  if (raw === null && !url.searchParams.has("format")) return null;
  const normalized = String(raw || "").toLowerCase();
  if (RESPONSE_FORMATS.includes(normalized)) return null;
  return {
    parameter: "format",
    message: `format must be one of: ${RESPONSE_FORMATS.join(", ")}.`,
  };
}

function csvCacheVariant(
  url: URL,
  request: Request | null,
  canonicalPath: string,
) {
  const format = url.searchParams.get("format")?.toLowerCase();
  const wantsCsv = format === "csv" || (request && csvRequested(url, request));
  if (!wantsCsv) return canonicalPath;
  const separator = canonicalPath.includes("?") ? "&" : "?";
  return `${canonicalPath}${separator}format=csv`;
}
/**
 * A strict boolean query parameter (#9720).
 *
 * STRICT on purpose. The `raw === "true"` idiom used elsewhere in this file is
 * fine for a tri-state flag where absent means "both", but wrong for a toggle
 * whose whole job is "send me less": `include_points=FALSE` or `=0` would read
 * as true and quietly return the 143 KB body the caller asked to avoid -- a
 * parameter accepted and ignored, which is the failure mode this route is being
 * changed to fix, not to reproduce.
 */
function parseBooleanParam(
  url: URL,
  parameter: string,
  def: boolean,
): { value: boolean } | { error: QueryError } {
  const raw = url.searchParams.get(parameter);
  if (raw == null || raw === "") return { value: def };
  if (raw !== "true" && raw !== "false") {
    return {
      error: {
        parameter,
        message: `${parameter} must be true or false.`,
      },
    };
  }
  return { value: raw === "true" };
}

// --- Per-UID metagraph (#1304/#1305) --- D1 fully eliminated (2026-07-17);
// neurons' D1 write path was retired in #4772/#4909 (see handleSubnetMetagraph
// below), so this now serves a schema-stable literal rather than a live
// query, like the other Postgres-backed analytics routes.
async function metagraphMeta(
  env: Env,
  artifactPath: string,
  generatedAt: unknown,
) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "metagraph-snapshot",
  };
}

export async function handleSubnetMetagraph(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // #9082. Parsed before the tier read so an unsupported field costs a 400
  // rather than a full 256-row fetch the caller never sees.
  const projection = parseNeuronFields(url.searchParams, "neurons");
  if (projection.error) return analyticsQueryError(projection.error);
  // #4909 D1 retirement: neurons' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  // Mirrors handleSubnetHyperparams's pattern below (a schema-stable literal,
  // not a live D1 query) rather than querying a table that no longer exists.
  // validator_permit is validated by the router against the route's published
  // one-value enum (#10060) and forwarded to Postgres via the proxied request
  // (tryDataApiTier passes the request through unchanged).
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetMetagraph> | null) ??
    buildSubnetMetagraph([], netuid);
  // CSV keeps its own fixed column set (NEURON_CSV_COLUMNS): a projected CSV
  // would be a second, caller-defined column contract for the same download.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.neurons as unknown[],
      "subnet-metagraph",
      "short",
      request,
      NEURON_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data: projectNeuronPayload(data, projection.fields),
      meta: {
        ...(await metagraphMeta(
          env,
          `/metagraph/subnets/${netuid}/metagraph.json`,
          data.captured_at,
        )),
        ...projectionMeta(projection.fields),
      },
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/yield: per-UID emission yield (emission/stake) over the
// current neurons snapshot, ranked, with a distribution summary (subnet aggregate yield,
// mean, p25/median/p75/p90), a validator/miner split, and a per-UID vs-median label.
// neurons-tier (source "metagraph-snapshot"). Cold/absent store → schema-stable empties.
export async function handleSubnetYield(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetYield> | null) ??
    buildSubnetYield([], netuid);
  if (csvRequested(url, request)) {
    return csvResponse(
      data.neurons as unknown[],
      `subnet-${netuid}-yield`,
      "short",
      request,
      SUBNET_YIELD_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/yield.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

export async function handleNeuron(
  request: Request,
  env: Env,
  netuid: number,
  uid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const projection = parseNeuronFields(url.searchParams, "neuron");
  if (projection.error) return analyticsQueryError(projection.error);
  // Cold/absent snapshot → 200 with neuron:null, consistent with the other live
  // tiers (health/economics never 404 on a cold store).
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildNeuronDetail> | null) ??
    buildNeuronDetail(null, netuid);
  return envelopeResponse(
    request,
    {
      data: projectNeuronPayload(data, projection.fields),
      meta: {
        ...(await metagraphMeta(
          env,
          `/metagraph/subnets/${netuid}/neurons/${uid}.json`,
          data.captured_at,
        )),
        ...projectionMeta(projection.fields),
      },
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/hyperparameters (#4307/1.4): one netuid's live
// consensus/economic/governance settings, served from Postgres
// (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE, refreshed daily by
// refresh-subnet-hyperparams.yml, #4306/1.3) — no static file, no query
// params (a single-row lookup, nothing to filter or paginate).
//
// D1 retirement: subnet_hyperparams's store write path (loadStagedSubnetHyperparams
// in workers/request-handlers/staging.mjs) is retired, so D1's copy is frozen,
// not actively wrong — but falling back to it here would silently serve an
// ever-staler snapshot instead of the same schema-stable-null cold shape every
// other cold/absent tier already returns. buildSubnetHyperparams(null, netuid)
// reproduces that cold shape directly, without querying D1 at all.
export async function handleSubnetHyperparams(
  request: Request,
  env: Env,
  netuid: number,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    )) as ReturnType<typeof buildSubnetHyperparams> | null) ??
    // Lakehouse cold tier (src/subnet-hyperparams-cold-tier.ts): the frozen
    // verified snapshot through the SAME formatter, so the payload is
    // identical whichever tier answered.
    (await loadSubnetHyperparamsColdTier(env, netuid)) ??
    buildSubnetHyperparams(null, netuid);
  // #10259: the card is retained for deregistered subnets rather than pruned,
  // so it has to say which it is. Read-only and best-effort -- a lifecycle
  // store that cannot be reached leaves the field null, which is "unknown"
  // rather than a claim that the subnet is live.
  const lifecycle = await loadSubnetLifecycle(env, netuid, {
    limit: 1,
    offset: 0,
  }).catch(() => null);
  (data as Record<string, unknown>).subnet_status = lifecycle?.[0]
    ? lifecycle[0].event === "deregistered"
      ? "deregistered"
      : "live"
    : null;
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/hyperparameters.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/hyperparameters/history (#4309/1.6): append-only
// hyperparameter-change timeline for one subnet, newest first, served from
// Postgres (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE). Forward-only — rows only
// exist from when the diff-on-change write started running (see
// handleSubnetHyperparamsSync's diff-and-append in workers/data-api.ts).
// Cold/absent store -> schema-stable zero, never 404.
//
// Tier retirement: see handleSubnetHyperparams above — the D1 fallback
// (loadSubnetHyperparamsHistory) is retired alongside subnet_hyperparams's D1
// write path; buildSubnetHyperparamsHistory([], ...) reproduces the same
// schema-stable empty-page shape a cold store returned, without querying D1.
export async function handleSubnetHyperparamsHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
    )) as ReturnType<typeof buildSubnetHyperparamsHistory> | null) ??
    // Lakehouse cold tier: same formatter, data-api's exact cursor token, so
    // a page started on one tier finishes correctly on the other.
    (await loadSubnetHyperparamsHistoryColdTier(env, netuid, {
      limit,
      offset,
      cursor: routeText(url, "cursor"),
    })) ??
    buildSubnetHyperparamsHistory([], netuid, {
      limit,
      offset,
      nextCursor: null,
    });
  // CSV mirrors handleAccountHistory: the page is already limit/offset-bounded,
  // so the CSV path carries the identical page the JSON path would. Cold store
  // -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries as unknown[],
      `subnet-${netuid}-hyperparameters-history`,
      "short",
      request,
      SUBNET_HYPERPARAMS_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/hyperparameters/history.json`,
        (data.entries as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/lifecycle: when this subnet was registered or
// deregistered (#10263), newest first, from the subnet_lifecycle Neon table.
//
// No tier cascade and no cold tier, deliberately. The sibling history routes
// fall back to the lakehouse for deep pages; this table holds a handful of rows
// per subnet per LIFETIME, so there is no depth at which Neon stops being the
// right answer, and a second tier would be a second place for the event list to
// disagree with itself.
//
// An unbound store yields a schema-stable empty page rather than a 404, the
// same shape the sibling routes return from a cold store: "this subnet has no
// recorded transitions" and "we cannot reach the store" are both 200 with
// `entries: []` here, and the loader's null is what distinguishes them for the
// watchdogs rather than for the caller.
export async function handleSubnetLifecycle(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // #10218: the router already parsed and rejected against the route's schema,
  // so this reads the result rather than re-checking it by hand.
  const { limit, offset } = resolvePage(url);
  const rows = await loadSubnetLifecycle(env, netuid, { limit, offset });
  const data = buildSubnetLifecycle(rows, netuid, { limit, offset });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries as unknown[],
      `subnet-${netuid}-lifecycle`,
      "short",
      request,
      SUBNET_LIFECYCLE_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/lifecycle.json`,
        (data.entries as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

export async function handleSubnetValidators(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const projection = parseNeuronFields(url.searchParams, "validators");
  if (projection.error) return analyticsQueryError(projection.error);
  // Featured-validator pin (#5166): applied once, right where the Postgres/D1
  // tiers converge, so it never needs duplicating per tier. This route has no
  // `sort` param at all -- its ranking is always the stake-DESC default -- so
  // the overlay always applies here (see overlayFeaturedValidators).
  const data = overlayFeaturedValidators(
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetValidators> | null) ??
      buildSubnetValidators([], netuid),
  )!;
  if (csvRequested(url, request)) {
    return csvResponse(
      data.validators as unknown[],
      "subnet-validators",
      "short",
      request,
      NEURON_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data: projectNeuronPayload(data, projection.fields),
      meta: {
        ...(await metagraphMeta(
          env,
          `/metagraph/subnets/${netuid}/validators.json`,
          data.captured_at,
        )),
        ...projectionMeta(projection.fields),
      },
    },
    "short",
  );
}

// GET /api/v1/validators?sort=subnet_count|uid_count|avg_validator_trust|max_validator_trust&limit=20:
// network-wide validator/operator leaderboard from the current neurons snapshot. This
// groups validator-permit UID rows by public identity, so consumers can see cross-subnet
// operator footprint rather than only one subnet at a time. Stake/emission values stay
// scoped to each membership row because those source units are not globally aggregated.
// A cold or absent store returns a schema-stable empty list.
function parseGlobalValidatorsQuery(
  url: URL,
): { sort: string; limit: number } | { error: QueryError } {
  const validationError = validateResponseFormat(url);
  if (validationError) return { error: validationError };

  const sort = routeValue<string>(url, "sort");
  const limit = pageLimit(url);

  return { sort, limit: limit };
}

export function canonicalGlobalValidatorsCachePath(
  url: URL,
  request: Request | null = null,
) {
  const parsed = parseGlobalValidatorsQuery(url);
  if ("error" in parsed) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleGlobalValidators(
  request: Request,
  env: Env,
  url: URL,
) {
  const parsed = parseGlobalValidatorsQuery(url);
  if ("error" in parsed) return analyticsQueryError(parsed.error);
  // Featured-validator pin (#5166), applied once at tier convergence -- see
  // handleSubnetValidators above. Unlike that route this one has a `sort`
  // param, so overlayFeaturedValidators only reorders the default (unsorted)
  // view; an explicit non-default ?sort= keeps the caller's exact order while
  // `featured` stays present on every row either way.
  const data = overlayFeaturedValidators(
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildGlobalValidators> | null) ??
      buildGlobalValidators([], {
        sort: parsed.sort,
        limit: parsed.limit,
        priceByNetuid: NO_ALPHA_PRICES,
      }),
  )!;
  if (csvRequested(url, request)) {
    return csvResponse(
      data.validators as unknown[],
      "global-validators",
      "short",
      request,
      GLOBAL_VALIDATOR_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/validators.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts?sort=total_stake|total_emission|subnet_count|uid_count|
// validator_count|stake_dominance|last_active&limit=20 (#4324/5.3): site-wide
// accounts leaderboard — every currently-registered hotkey, miners included,
// from the current neurons snapshot. The collection-level counterpart to
// /api/v1/validators (which this route follows as its precedent), generalized
// to every account rather than just validator_permit=1 rows. See
// src/accounts-list.ts's header for the "Free"/"Total" balance columns this
// deliberately does NOT carry (no balance-tracking tier exists to derive them
// from). A cold or absent store returns a schema-stable empty list.
function parseAccountsListQuery(
  url: URL,
): { sort: string; limit: number } | { error: QueryError } {
  const validationError = validateResponseFormat(url);
  if (validationError) return { error: validationError };

  const sort = routeValue<string>(url, "sort");
  const limit = pageLimit(url);

  return { sort, limit: limit };
}

export function canonicalAccountsListCachePath(
  url: URL,
  request: Request | null = null,
) {
  const parsed = parseAccountsListQuery(url);
  if ("error" in parsed) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleAccountsList(request: Request, env: Env, url: URL) {
  const parsed = parseAccountsListQuery(url);
  if ("error" in parsed) return analyticsQueryError(parsed.error);
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountsList> | null) ??
    buildAccountsList([], {
      sort: parsed.sort,
      limit: parsed.limit,
      priceByNetuid: NO_ALPHA_PRICES,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.accounts as unknown[],
      "accounts-list",
      "short",
      request,
      ACCOUNTS_LIST_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/accounts.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/top-holders?sort=total_tao|free_tao|delegated_tao&
// limit=20 (#6741/#6743): the balance-based top-holder leaderboard -- the
// coldkey/balance-centric counterpart to /api/v1/accounts above (hotkey/
// neuron-centric, explicitly missing the Free/Total columns this route
// exists to add -- see that route's own header). Cold/absent Postgres tier
// returns a schema-stable empty leaderboard, same posture as accounts-list.
function parseTopHoldersQuery(
  url: URL,
): { sort: string; limit: number } | { error: QueryError } {
  const validationError = validateResponseFormat(url);
  if (validationError) return { error: validationError };

  const sort = routeValue<string>(url, "sort");
  const limit = pageLimit(url);

  return { sort, limit: limit };
}

export function canonicalTopHoldersCachePath(
  url: URL,
  request: Request | null = null,
) {
  const parsed = parseTopHoldersQuery(url);
  if ("error" in parsed) {
    return { response: analyticsQueryError(parsed.error) };
  }
  const search = `sort=${encodeURIComponent(parsed.sort)}&limit=${parsed.limit}`;
  return {
    cachePathAndSearch: csvCacheVariant(
      url,
      request,
      `${url.pathname}?${search}`,
    ),
  };
}

export async function handleTopHoldersList(
  request: Request,
  env: Env,
  url: URL,
) {
  const parsed = parseTopHoldersQuery(url);
  if ("error" in parsed) return analyticsQueryError(parsed.error);
  // NO TIER READ (#10190): METAGRAPH_TOP_HOLDERS_SOURCE is retired and absent
  // from FORWARDABLE_TIER_FLAGS, so this arm resolved to null on every request.
  const data =
    // The LIVE leg (#9469): net_flow_7d/30d/90d, recomputed daily from
    // chain.account_events. Answers only those three sorts and declines the
    // holdings ones, so it takes precedence where it can genuinely rank and
    // never displaces the frozen artifact where it cannot. See
    // src/top-holders-flow-tier.ts.
    (await loadTopHoldersFlowTier(env, {
      sort: parsed.sort,
      limit: parsed.limit,
    })) ??
    buildTopHoldersList([], {
      sort: parsed.sort,
      limit: parsed.limit,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.accounts as unknown[],
      "top-holders",
      "short",
      request,
      TOP_HOLDERS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/top-holders.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}: a single validator's validator_permit=1
// rows aggregated across every subnet it operates in — the single-entity
// drill-in of the /api/v1/validators leaderboard above. Cold/absent hotkey
// (no permit=1 rows anywhere) returns 200 with a zeroed aggregate and an
// empty subnets array, consistent with handleNeuron's absent-uid contract
// (never 404 on a cold/absent live store tier).
export async function handleValidatorDetail(
  request: Request,
  env: Env,
  hotkey: string,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildValidatorDetail> | null) ??
    buildValidatorDetail([], hotkey, {
      priceByNetuid: NO_ALPHA_PRICES,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/validators/${hotkey}.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}/nominators?window=7d|30d|90d&sort=net_staked|
// gross_staked|last_activity&limit=&offset=&coldkey=: who has staked to this
// validator (across every subnet it operates in) over the window, ranked by
// net/gross flow or recency. account_events-derived (source "chain-events"),
// no new capture — StakeAdded/StakeRemoved already carry the hotkey/coldkey
// pair on every row. coldkey= narrows to one nominator's own flow (an
// exact-match lookup, not fuzzy search). Cold/absent → 200 with an empty
// list, never 404.
export async function handleValidatorNominators(
  request: Request,
  env: Env,
  hotkey: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  // #9617: `basis` selects WHICH QUESTION is answered, not how well. `flow`
  // (the default, unchanged) is TAO moved in a window; `positions` is alpha
  // held right now off the position ledger, which sees the dormant delegators
  // a window cannot. Different units over different time semantics, so the
  // default must not move -- it would silently change what every existing
  // caller's numbers mean.
  const basisParam = routeValue<string>(url, "basis");
  if (basisParam === "positions") {
    // window and sort belong to the flow aggregation and mean nothing here.
    // Accepting them silently would imply this basis honoured them.
    for (const unsupported of ["window", "sort"]) {
      if (url.searchParams.has(unsupported)) {
        return analyticsQueryError({
          parameter: unsupported,
          message: `"${unsupported}" applies to basis=flow only; the positions basis is a current-holdings snapshot, not a windowed aggregation.`,
        });
      }
    }
    const positionsLimit = pageLimit(url);
    const positionsOffset = routeInt(url, "offset") ?? 0;
    const read = await loadNominatorPositions(
      readStore(env, ALPHA_PRICING_TABLES) as never as unknown as Parameters<
        typeof loadNominatorPositions
      >[0],
      hotkey,
    );
    const positionsData = buildNominatorPositions(read, hotkey, {
      limit: positionsLimit,
      offset: positionsOffset,
    });
    return envelopeResponse(
      request,
      { data: positionsData, meta: { contract_version: contractVersion(env) } },
      "short",
    );
  }

  const { label: windowParam } = resolveWindow(
    url,
    NOMINATOR_WINDOWS,
    DEFAULT_NOMINATOR_WINDOW,
  );
  const sort = routeText(url, "sort");
  const limit = pageLimit(url);
  const offset = routeInt(url, "offset") ?? 0;
  const coldkeyParam = routeText(url, "coldkey");
  if (coldkeyParam !== null && !isFinneySs58Address(coldkeyParam)) {
    return analyticsQueryError({
      parameter: "coldkey",
      message: `"coldkey" must be a valid SS58 address.`,
    });
  }
  // Postgres → lakehouse cold tier → schema-stable empty stub, the same three
  // steps every account_events-derived route now takes.
  const {
    data,
    generatedAt,
  } = // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
    // and is absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // before it could touch DATA_API.

    (await loadValidatorNominatorsColdTier(env, hotkey, {
      window: windowParam,
      sort,
      limit: limit,
      offset: offset,
      coldkey: coldkeyParam,
    })) ?? {
      data: buildValidatorNominators([], hotkey, {
        window: windowParam,
        sort: sort ?? undefined,
        limit: limit,
        offset: offset,
      }),
      generatedAt: null,
    };
  // CSV export mirrors handleAccountsList / handleGlobalValidators: the rows are
  // already sorted/paginated/coldkey-filtered by buildValidatorNominators, so
  // the CSV path carries the identical set the JSON path would (#5745). A cold
  // result yields an empty array → a header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.nominators as unknown[],
      "validator-nominators",
      "short",
      request,
      VALIDATOR_NOMINATOR_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/validators/${hotkey}/nominators.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/{hotkey}/history?window=7d|30d|90d|1y|all: cross-
// subnet staked-over-time + a rewards-per-1000-TAO rate for one validator,
// one point per snapshot_date summed across every subnet it validates in
// that day. Rolled up from the neuron_daily tier (idx_neuron_daily_hotkey_date),
// the same tier the per-UID/per-subnet history routes below already use.
export async function handleValidatorHistory(
  request: Request,
  env: Env,
  hotkey: string,
  url: URL,
) {
  const { label, days } = historyWindow(url);
  // #9383: `netuid` scopes the series to one subnet and switches the points to
  // the per-subnet shape. The router rejects a typo'd netuid against the u16
  // bound the route publishes, so what reaches here is a subnet id or nothing
  // -- never a silently unscoped series that looks like an answer.
  const { netuid: requestedNetuid = null } = routeQuery(url);
  const hot =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildValidatorHistory> | null) ??
    buildValidatorHistory([], hotkey, {
      window: label,
      netuid: requestedNetuid,
    });
  // See handleNeuronHistory. This one needs chain.subnet_snapshots as well as
  // chain.neuron_daily -- the TAO pricing is a join -- which is why
  // metagraphed-infra#447 carries that table too.
  const data = await overlayValidatorHistoryColdTier(
    env,
    hot,
    hotkey,
    requestedNetuid as number | null,
    { label, days },
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/validators/${hotkey}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// ---- Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345) --
// Served from the dated neuron_daily rollup tier (D1). Cold/absent store → 200
// with empty points (never 404), consistent with the live metagraph tiers.

// GET /api/v1/subnets/{netuid}/neurons/{uid}/history?window=7d|30d|90d|1y|all
// Per-UID time series (one point per snapshot_date, newest first, bounded).
export async function handleNeuronHistory(
  request: Request,
  env: Env,
  netuid: number,
  uid: number,
  url: URL,
) {
  const { label, days } = historyWindow(url);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const hot =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildNeuronHistory> | null) ??
    buildNeuronHistory([], netuid, uid, {
      window: label,
    });
  // Days below Neon's floor, from the lakehouse. HERE and not in data-api
  // because R2_SQL_TOKEN is a secret on THIS Worker only -- the tier that
  // built `hot` cannot reach the lakehouse at all.
  const data = await overlayNeuronHistoryColdTier(env, hot, netuid, uid, {
    label,
    days,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/neurons/${uid}/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.captured_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/history?window=7d|30d|90d|1y|all
// Per-subnet daily aggregates over time (count + totals) for a history sparkline,
// without shipping every UID's row.
export async function handleSubnetHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label, days } = historyWindow(url);
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const hot =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetHistory> | null) ??
    buildSubnetHistory([], netuid, {
      window: label,
    });
  // See handleNeuronHistory: the cold leg lives on this Worker because the
  // lakehouse credential does.
  const data = await overlaySubnetHistoryColdTier(env, hot, netuid, {
    label,
    days,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/identity-history (#1647): append-only on-chain
// identity timeline, newest first. Cold/absent store → schema-stable zero.
export async function handleSubnetIdentityHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  // NO TIER READ (#10190). METAGRAPH_SUBNET_IDENTITY_SOURCE reads "retired" in every deployed
  // config and is absent from FORWARDABLE_TIER_FLAGS, so this resolved to
  // null on every request.
  // Through the composer (src/identity-history-answer.ts): same formatter and
  // data-api's exact cursor token, so a page started on one tier finishes
  // correctly on the other -- and MCP/GraphQL now reach it by the same route.
  const data = (await answerSubnetIdentityHistory(env, netuid, null, {
    limit,
    offset,
    cursor: routeText(url, "cursor"),
  })) as unknown as ReturnType<typeof buildSubnetIdentityHistory>;
  // CSV mirrors handleSubnetHyperparamsHistory: the page is already
  // limit/offset/cursor-bounded, so the CSV path carries the identical page the
  // JSON path would. Cold store -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries as unknown[],
      `subnet-${netuid}-identity-history`,
      "short",
      request,
      SUBNET_IDENTITY_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/identity-history.json`,
        (data.entries as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/concentration: stake & emission decentralization
// metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) over
// the subnet's live distribution (#2106), across three lenses — per-UID, per-entity
// (coldkeys collapsed, the true control distribution) and validator-only consensus
// power. Computed from the neurons store; a cold/absent store or empty
// subnet → 200 with null blocks (schema-stable, never 404), mirroring the sibling
// metagraph/history routes.
export async function handleSubnetConcentration(
  request: Request,
  env: Env,
  netuid: number,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildConcentration> | null) ??
    buildConcentration([], Number(netuid));
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/performance: reward-distribution + score-spread
// metrics for one subnet — how concentrated the actual REWARDS are (Gini/HHI/
// Nakamoto/top-share of incentive across neurons and dividends across validators)
// and how the 0..1 trust/consensus/validator_trust scores are spread (p10..p90).
// The reward-flow companion to /concentration (which measures stake/emission).
// Computed from the neurons store; a cold/absent store or empty subnet → 200
// with null blocks (schema-stable, never 404), mirroring the sibling routes.
export async function handleSubnetPerformance(
  request: Request,
  env: Env,
  netuid: number,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetPerformance> | null) ??
    buildSubnetPerformance([], netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/performance.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/concentration: network-wide stake & emission concentration
// across EVERY subnet's neurons — the same five lenses as the per-subnet route,
// but the entity lenses collapse an operator's hotkeys ACROSS subnets, so this is
// the true network-level control distribution. neurons-tier (source
// "metagraph-snapshot"), no params. Cold/absent store → schema-stable empties.
export async function handleChainConcentration(request: Request, env: Env) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildChainConcentration> | null) ??
    buildChainConcentration([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/concentration.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/concentration/subnets (#9717): every subnet RANKED by how
// widely one lens of its distribution is spread — the screening question a
// prospective miner asks, which used to cost 129 requests to /subnets/{netuid}/
// concentration. Reads the same neurons rows /chain/concentration already pulls
// and keeps them grouped by netuid instead of collapsing them into one
// aggregate; the per-subnet scorecard comes from buildConcentration, the SAME
// function the per-subnet route serves, so the two agree by construction.
export async function handleChainConcentrationSubnets(
  request: Request,
  env: Env,
  url: URL,
) {
  // Rejected HERE, before the tier read, so a bad parameter costs a 400 rather
  // than a ~30,000-row scan. The data-api side parses with this same function.
  const query = parseConcentrationRankingQuery(url.searchParams, {
    limitDefault: CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
    limitMax: CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
  });
  if ("error" in query) return analyticsQueryError(query.error);

  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetConcentrationRanking> | null) ??
    // A cold tier yields the schema-stable empty ranking rather than a 500 —
    // the same posture handleChainConcentration takes. Built through the real
    // builder so the shape is identical to a served one, echoing back the query
    // that was asked rather than inventing a default the caller did not send.
    buildSubnetConcentrationRanking([], query);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/concentration/subnets.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/performance: network-wide reward-distribution & score-spread
// across EVERY subnet's neurons — reward concentration (Gini/HHI/Nakamoto/
// top-share/entropy) for incentive across all neurons and dividends across
// validators, plus the p10–p90 spread of the 0–1 trust/consensus/validator_trust
// scores, computed live from the neurons store. The reward-flow companion to
// /chain/concentration. No params; a cold/absent store → 200 with null blocks.
export async function handleChainPerformance(request: Request, env: Env) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildChainPerformance> | null) ??
    buildChainPerformance([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/performance.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/idle-stake (#6789): stake delegated to a
// hotkey currently earning zero dividends -- the only stream delegated
// stake ever receives in dTAO (incentive goes to the hotkey owner alone),
// so a hotkey with no permit or a zero weight-setting output pays every
// delegator nothing right now. Computed from the neurons store; a
// cold/absent store or empty subnet -> 200 with a zeroed scorecard
// (schema-stable, never 404), mirroring /concentration and /performance.
export async function handleSubnetIdleStake(
  request: Request,
  env: Env,
  netuid: number,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetIdleStake> | null) ??
    buildSubnetIdleStake([], Number(netuid));
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/idle-stake.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/idle-stake (#6789): the network-wide rollup of the
// route above -- every subnet's own idle-stake scorecard ranked by
// idle_stake_tao descending, plus the network total. No params; a
// cold/absent store -> 200 with an empty ranking.
export async function handleChainIdleStake(request: Request, env: Env) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildChainIdleStake> | null) ??
    buildChainIdleStake([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/idle-stake.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/identity-history: the most-recent SubnetIdentitiesV3 changes
// aggregated across EVERY subnet (newest first), each entry shaped like the
// per-subnet /identity-history route plus its `netuid`. The network analog of
// handleSubnetIdentityHistory — a capped feed (`?limit` default 50, max 200), not a
// per-subnet timeline. A cold/absent store → 200 with an empty feed (schema-stable,
// never 404).
export async function handleChainIdentityHistory(
  request: Request,
  env: Env,
  url: URL,
) {
  const limit = pageLimit(url);
  // D1 retirement: subnet_identity_history's D1 write path is retired
  // (2026-07-16, syncSubnetIdentityToPostgres is the sole writer now), so a
  // Postgres miss/outage degrades to a schema-stable empty feed, never a
  // live store read.
  // NO TIER READ (#10190). METAGRAPH_SUBNET_IDENTITY_SOURCE reads "retired" in every deployed
  // config and is absent from FORWARDABLE_TIER_FLAGS, so this resolved to
  // null on every request.
  // Through the composer (src/identity-history-answer.ts): the frozen verified
  // history through the SAME formatter as the Postgres tier, for all three
  // surfaces rather than this one.
  const data = (await answerChainIdentityHistory(env, null, {
    limit,
  })) as unknown as ReturnType<typeof buildChainIdentityHistory>;
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/identity-history.json",
        // Freshness = the newest change's observed_at (feed is newest-first), else
        // null when the store is cold.
        (data.changes as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/self-health (#8318): metagraphed's OWN uptime -- the verdict plus
// each component's trailing-90-day series, from the self_health_* Postgres
// tier the indexer box's poller writes.
//
// Scoped strictly to our own components; never mixes in the third-party
// subnet-surface health that /api/v1/health covers.
//
// A cold or absent store returns the schema-stable empty shape (three
// components, current_ok null, verdict "degraded") rather than a 404 -- the
// same convention as every sibling Postgres-tier route, and the right answer
// besides: "we have no readings" is a real state, not a missing resource.
export async function handleSelfHealth(
  request: Request,
  env: Env,
  // Threaded so the Neon tier can release its Hyperdrive connection through
  // waitUntil (#9836). Optional because the route's own tests call this
  // without one, and a missing ctx means "skip the Neon tier", not "fail".
  ctx?: { waitUntil?(promise: Promise<unknown>): void },
) {
  // NO TIER READ (#10190): METAGRAPH_SELF_HEALTH_SOURCE is retired and absent
  // from FORWARDABLE_TIER_FLAGS, so this arm resolved to null on every request.
  // Neon is the first tier that can actually answer, which is what the comment
  // below already describes.
  const data =
    // Neon, where the prober writes now (#9836). Asked BEFORE the lakehouse:
    // the cold tier can only ever answer current_ok:null, and once the probe
    // lane is running there is a current reading to give.
    (await loadSelfHealthNeon(
      env.HYPERDRIVE && typeof ctx?.waitUntil === "function"
        ? createPgSql(env.HYPERDRIVE, ctx as never)
        : null,
    )) ??
    // Lakehouse cold tier (src/self-health-cold-tier.ts): the preserved daily
    // rollup, ending 2026-08-02, with NO current readings. Kept because those
    // 90 days are real history nothing else holds -- but second, because it
    // cannot answer "are we up right now".
    (await loadSelfHealthColdTier(env)) ??
    buildSelfHealth([], []);
  // #9330/#9340: the lane verdicts ride alongside whichever tier answered above.
  // They come from the store rather than from that tier, because the point of the change is
  // that a lane's health must be readable without depending on the analytics vendor --
  // or, here, on which serving tier happened to be reachable.
  const lanes = await loadLatestLaneHealth(
    // laneHealthStore, not the binding (#10155) -- lane_health is Neon's, and
    // this is /health's own lane floor. Reading it from the store would render an
    // empty result as "no alarms", which is the one answer a health endpoint
    // must never invent.
    laneHealthStore(env as unknown as Record<string, unknown>) as Parameters<
      typeof loadLatestLaneHealth
    >[0],
  );
  // The sample the silence bound needs (#10232), as the LONGEST observed gap
  // rather than the mean (#10333). One extra GROUP BY over the table the read
  // above already touched. loadLaneMaxGap declines to a {} on any failure, and
  // withLaneHealth then leaves every verdict alone -- so a failed read costs
  // today's behaviour, never a false alarm.
  const cadences = await loadLaneMaxGap(
    laneHealthStore(env as unknown as Record<string, unknown>) as Parameters<
      typeof loadLaneMaxGap
    >[0],
    Date.now() - LANE_ALARM_CADENCE_WINDOW_MS,
  );
  const withLanes = withLaneHealth(data, lanes, { cadences });
  return envelopeResponse(
    request,
    {
      data: withLanes,
      meta: await metagraphMeta(
        env,
        "/metagraph/self-health.json",
        withLanes.observed_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/chain/yield: network-wide emission-yield (return rate) across EVERY
// subnet's neurons — the aggregate network return (total emission / total stake),
// the same split by validator vs miner role, and the p10–p90 spread of the
// per-neuron emission/stake return, computed live from the neurons store. The
// return-rate companion to /chain/performance. No params; a cold/absent store →
// 200 with null blocks.
export async function handleChainYield(request: Request, env: Env) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildChainYield> | null) ?? buildChainYield([]);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/yield.json",
        data.captured_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the network identity-history feed: normalize `?limit`
// (its only response-changing param) to the default when omitted so a bare request
// and an explicit-default request share one cache slot; an invalid limit falls
// through to the raw search so the handler surfaces the 400.
export function canonicalChainIdentityHistoryCachePath(url: URL) {
  const parsed = parseRouteQuery(url);
  if ("error" in parsed) return `${url.pathname}${url.search}`;
  return `${url.pathname}?limit=${pageLimit(url)}`;
}

// Shared helper: build a canonical edge-cache key for a windowed route, so an
// omitted window and an explicit default-value window map to the same cache
// slot. A request the router will reject keys on its raw search instead, so a
// 400 is never served from -- or written to -- a valid request's slot.
function canonicalWindowedCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

export function canonicalSubnetHistoryCachePath(url: URL) {
  return canonicalWindowedCachePath(url);
}

export function canonicalValidatorHistoryCachePath(url: URL) {
  return canonicalWindowedCachePath(url);
}

export function canonicalSubnetConcentrationHistoryCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

export function canonicalSubnetPerformanceHistoryCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

export function canonicalSubnetYieldHistoryCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const formatError = validateResponseFormat(url);
  if (formatError) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

export function canonicalSubnetEmissionSplitHistoryCachePath(
  url: URL,
  request: Request | null = null,
) {
  // NO second `validateResponseFormat` guard here, unlike the older siblings.
  // `formatSchema` is `z.enum(["json","csv"])` and RESPONSE_FORMATS is the same
  // two values, so anything the format check would catch `parseRouteQuery` has
  // already rejected on the line above -- the guard cannot fire, and a branch
  // nothing can reach reads as a tested one.
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${encodeURIComponent(label)}`,
  );
}

// Canonical edge-cache key for the miner-fairness route (#10931): the window
// alone, so two callers asking the same question share one entry.
export function canonicalSubnetMinerFairnessCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = resolveWindow(
    url,
    SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
    DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  );
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

// Canonical edge-cache key for the owner-capture route (#10929). Same
// `?window=` vocabulary as its emission-split sibling and no CSV variant, so
// this is the window alone -- two callers asking for the same window must not
// be served from two cache entries.
export function canonicalSubnetOwnerCaptureCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = resolveWindow(
    url,
    SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
    DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  );
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

// Canonical edge-cache key for the subnet-turnover route (?window= via
// parseHistoryWindow). Distinct from canonicalSubnetConcentrationHistoryCachePath
// which uses a different parse function (parseConcentrationHistoryWindow).
export function canonicalSubnetTurnoverCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const { label } = historyWindow(url);
  const changes = routeText(url, "changes");
  if (changes != null && changes !== "true") {
    return `${url.pathname}${url.search}`;
  }
  const suffix = changes === "true" ? "&changes=true" : "";
  return `${url.pathname}?window=${encodeURIComponent(label)}${suffix}`;
}

// Canonical edge-cache key for the subnet-stake-flow route. ?window= (one of
// STAKE_FLOW_WINDOWS) and ?direction= (all|in|out) change the response; omitted
// window/direction and their explicit defaults must share one cache slot.
export function canonicalSubnetStakeFlowCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  const direction = routeText(url, "direction");
  let path = `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
  if (direction === "in" || direction === "out") {
    path += `&direction=${encodeURIComponent(direction)}`;
  }
  return path;
}

// Canonical edge-cache key for the cross-subnet movers route: window/sort/limit, each
// canonicalized to its default when omitted, so equivalent requests share one slot.
export function canonicalSubnetMoversCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const validationError = validateResponseFormat(url);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  const sortParam = routeValue<string>(url, "sort");
  const limit = pageLimit(url);
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${windowParam}&sort=${sortParam}&limit=${limit}`,
  );
}

// Canonical edge-cache key for the network turnover route: window + limit collapsed to
// their resolved defaults so ?window=30d and the bare path share one cached entry. Falls
// back to the raw path+search when validation fails (the handler will 400 it anyway).
export function canonicalChainTurnoverCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const validationError = validateResponseFormat(url);
  if (validationError) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  const limit = pageLimit(url);
  // CSV and JSON responses must not share one edge-cache entry.
  return csvCacheVariant(
    url,
    request,
    `${url.pathname}?window=${windowParam}&limit=${limit}`,
  );
}

// GET /api/v1/chain/turnover?window=7d|30d|90d&limit=20: network-wide validator-set churn
// across all subnets between the window's boundary neuron_daily snapshots — a per-subnet
// turnover leaderboard plus a network rollup over the union validator set.
export async function handleChainTurnover(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const { label: windowParam } = resolveWindow(
    url,
    CHAIN_TURNOVER_WINDOWS,
    DEFAULT_CHAIN_TURNOVER_WINDOW,
  );
  const limit = pageLimit(url);
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildChainTurnover> | null) ??
    buildChainTurnover([], {
      window: windowParam,
      startDate: null,
      endDate: null,
      limit: limit,
    });
  // CSV exports the row-shaped per-subnet churn leaderboard; the network rollup +
  // stability distribution stay JSON-only (mirrors the chain-analytics exports).
  if (csvRequested(url, request)) {
    return csvResponse(
      data.subnets as unknown[],
      "chain-turnover",
      "short",
      request,
      CHAIN_TURNOVER_CSV_COLUMNS,
    );
  }
  // neuron_daily-derived, so the meta reports the metagraph-snapshot source; generated_at
  // is the end snapshot date (string), matching the movers/turnover routes.
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/chain/turnover.json",
        data.end_date,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-metagraph route. Only
// ?validator_permit=true changes the response; omission and =false both serve
// the full metagraph and must share one cache slot.
export function canonicalSubnetMetagraphCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const validationError = validateResponseFormat(url);
  if (validationError) return `${url.pathname}${url.search}`;
  const validatorsOnly = routeText(url, "validator_permit") === "true";
  const canonicalPath = validatorsOnly
    ? `${url.pathname}?validator_permit=true`
    : url.pathname;
  return csvCacheVariant(url, request, canonicalPath);
}

// Canonical edge-cache key for the subnet validators route. The default JSON
// envelope and explicit ?format=json share one cache slot; CSV receives its own.
export function canonicalSubnetValidatorsCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const validationError = validateResponseFormat(url);
  if (validationError) return `${url.pathname}${url.search}`;
  return csvCacheVariant(url, request, url.pathname);
}

export function canonicalSubnetYieldCachePath(
  url: URL,
  request: Request | null = null,
) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const validationError = validateResponseFormat(url);
  if (validationError) return `${url.pathname}${url.search}`;
  return csvCacheVariant(url, request, url.pathname);
}

// GET /api/v1/subnets/{netuid}/concentration/history?window=7d|30d|90d: the per-day
// stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share)
// from the dated neuron_daily rollup — "is this subnet centralizing over time?".
// Each day needs its full per-UID distribution, so the read is the raw rows (not a
// GROUP BY) bounded by a row cap; a cold/absent store → 200 with points:[]
// (schema-stable, never 404).
export async function handleSubnetConcentrationHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label } = resolveWindow(
    url,
    CONCENTRATION_HISTORY_WINDOWS,
    DEFAULT_CONCENTRATION_HISTORY_WINDOW,
  );
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildConcentrationHistory> | null) ??
    buildConcentrationHistory([], Number(netuid), {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [
      ...(data.points as unknown as Array<Record<string, unknown>>),
    ].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-concentration-history`,
      "short",
      request,
      SUBNET_CONCENTRATION_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/performance/history?window=7d|30d|90d: the per-day
// reward-flow & trust trend (incentive/dividends Gini, Nakamoto, top-10% share +
// trust/consensus/validator_trust mean & median) from the dated neuron_daily rollup
// — "are this subnet's rewards consolidating over time?". The reward-flow twin of
// concentration/history: each day needs its full per-UID distribution, so the read
// is the raw rows (not a GROUP BY) bounded by a row cap; a cold/absent store → 200
// with points:[] (schema-stable, never 404).
export async function handleSubnetPerformanceHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label } = resolveWindow(
    url,
    PERFORMANCE_HISTORY_WINDOWS,
    DEFAULT_PERFORMANCE_HISTORY_WINDOW,
  );
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetPerformanceHistory> | null) ??
    buildSubnetPerformanceHistory([], Number(netuid), {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [
      ...(data.points as unknown as Array<Record<string, unknown>>),
    ].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-performance-history`,
      "short",
      request,
      SUBNET_PERFORMANCE_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/performance/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/yield/history?window=7d|30d|90d: the per-day
// emission-yield distribution trend (subnet-wide return + the mean/median/p25/p75/p90
// of the per-UID emission-per-stake yields) from the dated neuron_daily rollup — "is
// this subnet's return spread widening or its median falling?". The return-rate twin
// of concentration/history: each day needs its full per-UID distribution, so the read
// is the raw rows (not a GROUP BY) bounded by a row cap; a cold/absent store → 200
// with points:[] (schema-stable, never 404).
export async function handleSubnetYieldHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label } = resolveWindow(
    url,
    YIELD_HISTORY_WINDOWS,
    DEFAULT_YIELD_HISTORY_WINDOW,
  );
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetYieldHistory> | null) ??
    buildSubnetYieldHistory([], Number(netuid), {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [
      ...(data.points as unknown as Array<Record<string, unknown>>),
    ].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-yield-history`,
      "short",
      request,
      SUBNET_YIELD_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/yield/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/emission-split/history?window=7d|30d|90d
// (#10928): who received this subnet's emission, per day -- owner, validators,
// miners. A cold/absent store answers 200 with points:[] rather than 404,
// because a subnet with no daily rollup is a real state and the normal one for
// anything registered in the last day.
export async function handleSubnetEmissionSplitHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const formatError = validateResponseFormat(url);
  if (formatError) return analyticsQueryError(formatError);
  const { label } = resolveWindow(
    url,
    SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
    DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  );
  // Same DATA_API tier every neuron_daily-derived series reads through --
  // the SQL lives on the data Worker, and a null here degrades to the empty
  // builder rather than surfacing a store failure as a 500.
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetEmissionSplitHistory> | null) ??
    buildSubnetEmissionSplitHistory([], Number(netuid), {
      window: label,
      capped: false,
    });
  if (csvRequested(url, request)) {
    const points = [
      ...(data.points as unknown as Array<Record<string, unknown>>),
    ].sort((a, b) =>
      String(a.snapshot_date).localeCompare(String(b.snapshot_date)),
    );
    return csvResponse(
      points,
      `subnet-${netuid}-emission-split-history`,
      "short",
      request,
      SUBNET_EMISSION_SPLIT_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/emission-split/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/miner-fairness?window=7d|30d|90d (#10931):
// whether this subnet's registered miners actually earn, over the series. A
// cold/absent store answers 200 with days_covered:0 rather than 404 -- a
// subnet with no daily rollup is a real state and the normal one for anything
// registered in the last day.
export async function handleSubnetMinerFairness(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label } = resolveWindow(
    url,
    SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
    DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  );
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetMinerFairness> | null) ??
    buildSubnetMinerFairness([], Number(netuid), {
      window: label,
      capped: false,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/miner-fairness.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/owner-capture?window=7d|30d|90d (#10929): how
// much of this subnet's emission reaches its owner -- the protocol cut (L1) and
// emission on UIDs the `owner_coldkey` holds (L2), which are the two layers the
// chain shows. A cold/absent store answers 200 with points:[] and
// owner_coldkey:null rather than 404, for the same reason its emission-split
// sibling does: a subnet with no daily rollup is a real state.
//
// No CSV variant. The payload is a series PLUS a UID list PLUS an attribution
// list, and flattening three shapes into one sheet would have to drop two of
// them -- most likely the two that carry the epistemics.
export async function handleSubnetOwnerCapture(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label } = resolveWindow(
    url,
    SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
    DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  );
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildSubnetOwnerCapture> | null) ??
    buildSubnetOwnerCapture([], Number(netuid), {
      window: label,
      capped: false,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/owner-capture.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/turnover?window=7d|30d|90d|1y|all: validator-set &
// registration churn between the window's start and end neuron_daily snapshots.
// Add ?changes=true for validator hotkeys entered/exited and UID slots reassigned
// between the same boundary snapshots. Cold/absent store or a single snapshot →
// 200 with comparable:false + zeroed metrics (schema-stable, never 404).
export async function handleSubnetTurnover(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label } = historyWindow(url);
  const changes = routeText(url, "changes");
  if (changes != null && changes !== "true") {
    return analyticsQueryError({
      parameter: "changes",
      message: `"${changes}" is not a valid changes flag. Supported: true.`,
    });
  }
  // #4909 D1 retirement: neuron_daily's D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const turnoverOptions = { window: label, startDate: null, endDate: null };
  const data =
    (await tryDataApiTier(env, request, "METAGRAPH_NEURONS_SOURCE")) ??
    (changes === "true"
      ? {
          ...buildTurnover([], netuid, turnoverOptions),
          changes: turnoverChangeDetail(
            buildTurnoverChanges([], netuid, turnoverOptions),
          ),
        }
      : buildTurnover([], netuid, turnoverOptions));
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/turnover.json`,
        data.end_date,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-weights route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetWeightsCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/weights?window=7d|30d: validator weight-setting activity for
// one subnet over the window — distinct weight-setting validators, WeightsSet event count, and
// updates per validator — read live from the account_events WeightsSet stream. The per-subnet
// drill-in of /api/v1/chain/weights. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetWeights(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_WEIGHTS_WINDOWS,
    DEFAULT_SUBNET_WEIGHTS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // The cold tier its own /weights/setters sibling has had since #9267. Without
    // it this card answered a confident 0 for every subnet once the Postgres box
    // went away, while the leaderboard it summarises read 14 setters / 2,750 sets
    // from the same stream.
    (await loadSubnetWeightsColdTier(
      env as unknown as Parameters<typeof loadSubnetWeightsColdTier>[0],
      netuid,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_WEIGHTS_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetWeights(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed WeightsSet event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/weights.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-weight-setters route: only ?window= (7d/30d) changes
// the response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetWeightSettersCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/weights/setters?window=7d|30d: the per-subnet weight-setter
// leaderboard — the individual validators behind /weights, each with its WeightsSet count,
// share of the subnet's total, and first/last set time, ranked by activity. Read live from the
// account_events WeightsSet stream. Cold/absent store → 200 with an empty leaderboard (never 404).
export async function handleSubnetWeightSetters(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_WEIGHT_SETTERS_WINDOWS,
    DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9267: the same WeightsSet stream the chain-wide leaderboard reads
    // (#9251), narrowed to this subnet.
    (await loadSubnetWeightSettersColdTier(
      env as unknown as Parameters<typeof loadSubnetWeightSettersColdTier>[0],
      netuid,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_WEIGHT_SETTERS_WINDOWS[windowParam] ?? 7,
        limit: SUBNET_WEIGHT_SETTERS_LIMIT,
      },
    )) ?? buildSubnetWeightSetters([], null, netuid, { window: windowParam });
  // account_events-derived: the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed WeightsSet event, mirroring the sibling /weights route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/weights/setters.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-serving route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetServingCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/serving?window=7d|30d: axon-serving announcement activity for one
// subnet over the window — distinct servers (hotkeys), AxonServed event count, and announcements
// per server — read live from the account_events AxonServed stream. The per-subnet drill-in of
// /api/v1/chain/serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetServing(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_SERVING_WINDOWS,
    DEFAULT_SUBNET_SERVING_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9369: the cold tier this card never had. METAGRAPH_ACCOUNT_EVENTS_SOURCE
    // is "retired", so the tier above declines unconditionally and this was the
    // only thing left -- a confident 0 for every subnet.
    (await loadSubnetEventCardColdTier(
      env as unknown as Parameters<typeof loadSubnetEventCardColdTier>[0],
      CHAIN_SERVING_ROLLUP,
      netuid,
      buildSubnetServing,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_SERVING_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetServing(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed AxonServed event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/serving.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-prometheus route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetPrometheusCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/prometheus?window=7d|30d: Prometheus-endpoint serving activity for
// one subnet over the window — distinct exporters (hotkeys), PrometheusServed event count, and
// announcements per exporter — read live from the account_events PrometheusServed stream. The
// per-subnet drill-in of /api/v1/chain/prometheus and the telemetry-endpoint sibling of
// /api/v1/subnets/{netuid}/serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetPrometheus(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_PROMETHEUS_WINDOWS,
    DEFAULT_SUBNET_PROMETHEUS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #10322: the cold tier this card never had. METAGRAPH_ACCOUNT_EVENTS_SOURCE
    // reads "retired", so the tier above declines unconditionally and the zeroed
    // builder below was the only thing left -- a confident 0 for every subnet,
    // while /api/v1/chain/prometheus reads the SAME PrometheusServed stream
    // through CHAIN_PROMETHEUS_ROLLUP and answers. Measured 2026-08-10: the
    // chain card reported netuid 112 with 1 exporter and 1 announcement over
    // 30d while this route answered 0 for that same subnet, so the two
    // contradicted each other on one event stream.
    (await loadSubnetEventCardColdTier(
      env as unknown as Parameters<typeof loadSubnetEventCardColdTier>[0],
      CHAIN_PROMETHEUS_ROLLUP,
      netuid,
      buildSubnetPrometheus,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_PROMETHEUS_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetPrometheus(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed PrometheusServed event, mirroring the sibling serving route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/prometheus.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-stake-moves route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetStakeMovesCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/stake-moves?window=7d|30d: stake-movement (re-delegation) activity
// for one subnet over the window — distinct movers (accounts), StakeMoved event count, and
// movements per mover — read live from the account_events StakeMoved stream. The per-subnet drill-in
// of /api/v1/chain/stake-moves and the re-delegation-churn sibling of
// /api/v1/subnets/{netuid}/stake-flow. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetStakeMoves(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_STAKE_MOVES_WINDOWS,
    DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9369: the cold tier this card never had. METAGRAPH_ACCOUNT_EVENTS_SOURCE
    // is "retired", so the tier above declines unconditionally and this was the
    // only thing left -- a confident 0 for every subnet.
    (await loadSubnetEventCardColdTier(
      env as unknown as Parameters<typeof loadSubnetEventCardColdTier>[0],
      CHAIN_STAKE_MOVES_ROLLUP,
      netuid,
      buildSubnetStakeMoves,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_STAKE_MOVES_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetStakeMoves(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed StakeMoved event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-moves.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-stake-transfers route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetStakeTransfersCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/stake-transfers?window=7d|30d: stake-transfer activity for one subnet
// over the window — distinct senders (accounts), StakeTransferred event count, and transfers per
// sender — read live from the account_events StakeTransferred stream. The per-subnet drill-in of
// /api/v1/chain/stake-transfers and the between-coldkeys sibling of
// /api/v1/subnets/{netuid}/stake-moves. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetStakeTransfers(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_STAKE_TRANSFERS_WINDOWS,
    DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9369: the cold tier this card never had. METAGRAPH_ACCOUNT_EVENTS_SOURCE
    // is "retired", so the tier above declines unconditionally and this was the
    // only thing left -- a confident 0 for every subnet.
    (await loadSubnetEventCardColdTier(
      env as unknown as Parameters<typeof loadSubnetEventCardColdTier>[0],
      CHAIN_STAKE_TRANSFERS_ROLLUP,
      netuid,
      buildSubnetStakeTransfers,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_STAKE_TRANSFERS_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetStakeTransfers(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed StakeTransferred event, mirroring the sibling stake-moves route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-transfers.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-registrations route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetRegistrationsCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/registrations?window=7d|30d: neuron-registration activity for one
// subnet over the window — distinct registrants (hotkeys), NeuronRegistered event count, and
// registrations per registrant — read live from the account_events NeuronRegistered stream. The
// account_events companion to /turnover. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetRegistrations(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_REGISTRATIONS_WINDOWS,
    DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9369: the cold tier this card never had. METAGRAPH_ACCOUNT_EVENTS_SOURCE
    // is "retired", so the tier above declines unconditionally and this was the
    // only thing left -- a confident 0 for every subnet.
    (await loadSubnetEventCardColdTier(
      env as unknown as Parameters<typeof loadSubnetEventCardColdTier>[0],
      CHAIN_REGISTRATIONS_ROLLUP,
      netuid,
      buildSubnetRegistrations,
      {
        windowLabel: windowParam,
        windowDays: SUBNET_REGISTRATIONS_WINDOWS[windowParam] ?? 7,
      },
    )) ?? buildSubnetRegistrations(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed NeuronRegistered event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/registrations.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-axon-removals route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetAxonRemovalsCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/axon-removals?window=7d|30d: axon-removal activity for one subnet
// over the window — distinct removers (hotkeys), AxonInfoRemoved event count, and removals per
// remover — read live from the account_events AxonInfoRemoved stream. The removal-side companion
// to /serving. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetAxonRemovals(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_AXON_REMOVALS_WINDOWS,
    DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    buildSubnetAxonRemovals(null, netuid, { window: windowParam });
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest observed AxonInfoRemoved event, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/axon-removals.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// Canonical edge-cache key for the subnet-deregistrations route: only ?window= (7d/30d) changes the
// response, canonicalized to its default when omitted so equivalent requests share a slot.
export function canonicalSubnetDeregistrationsCachePath(url: URL) {
  if ("error" in parseRouteQuery(url)) return `${url.pathname}${url.search}`;
  const windowParam = routeValue<string>(url, "window");
  return `${url.pathname}?window=${encodeURIComponent(windowParam)}`;
}

// GET /api/v1/subnets/{netuid}/deregistrations?window=7d|30d: neuron-deregistration activity for one
// subnet over the window — distinct deregistered hotkeys, NeuronDeregistered event count, and
// deregistrations per hotkey — read live from the account_events NeuronDeregistered stream. The
// exit-side companion to /registrations. Cold/absent store → 200 with a zeroed card (never 404).
export async function handleSubnetDeregistrations(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    SUBNET_DEREGISTRATIONS_WINDOWS,
    DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
  );
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // #9307: derived from UID reuse in the NeuronRegistered stream, out of the
    // same projection rows the chain leaderboard ranks — NeuronDeregistered
    // has never been emitted, so the filter this card was built on matched
    // nothing and it published a permanent 0.
    (await loadSubnetDeregistrationsFromArtifact(env, netuid, {
      window: windowParam,
    })) ??
    markDeregistrationsNotDerived(
      buildSubnetDeregistrations(null, netuid, { window: windowParam }),
    );
  // account_events-derived, so the meta reports the event-stream source (accountMeta) with
  // generated_at the newest derived deregistration, mirroring the sibling stake-flow route.
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/deregistrations.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/stake-flow?window=7d|30d|90d&direction=all|in|out:
// net stake flow for one subnet over the window — TAO staked (StakeAdded) vs
// unstaked (StakeRemoved) and the net, summed live from the account_events stream
// (idx_account_events_netuid_kind). ?direction=in|out narrows to one side;
// omitted or all sums both. Windows (7d/30d/90d) match the concentration/history
// route. Cold/absent store → 200 with zeroed totals (schema-stable, never 404),
// mirroring the sibling routes.
export async function handleSubnetStakeFlow(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    STAKE_FLOW_WINDOWS,
    DEFAULT_STAKE_FLOW_WINDOW,
  );
  const direction = routeText(url, "direction");
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss
  // (#6016/#6017). Postgres → schema-stable empty stub.
  // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
  // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so the tier arm
  // below resolved to null on every request.
  //
  // #9146: slice this subnet out of the chain-stake-flow
  // projection rather than serving zeros -- that lane already groups by
  // (netuid, event_kind), so the numbers exist and were simply unread. The
  // reader declines (null) when it cannot answer faithfully, which keeps the
  // zeroed card as the floor.
  const projected = await loadSubnetStakeFlowFromArtifact(env, netuid, {
    window: windowParam,
    direction,
  });
  const { data, generatedAt } = projected ?? {
    data: buildStakeFlow([], netuid, { window: windowParam }),
    generatedAt: null,
  };
  // account_events-derived, so the meta reports source "chain-events" (via
  // accountMeta), not the metagraph snapshot; generated_at is the newest event in
  // the window.
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/stake-flow.json`,
        generatedAt,
      ),
    },
    "short",
  );
  return projected ? response : markDataApiTierFallbackResponse(response);
}

// One subnet's alpha_market_cap_tao (#4342/8.3), preferring the live economics
// KV tier and falling back to the committed R2 economics.json when the live
// tier is cold/stale — same fallback shape resolveEconomicsRows uses in
// request-handlers/analytics-routes.ts. Unmemoized (unlike api.ts's
// readEconomicsCurrentKv): this route's traffic doesn't warrant the isolate
// cache analytics-routes.ts's higher-traffic /economics + /subnets/{netuid}
// pair share, and entities.ts deliberately imports leaf modules directly
// rather than taking injected deps from api.ts (see this file's header).
// Null when neither tier has a row for this subnet.
async function resolveSubnetMarketCapTao(env: Env, netuid: number) {
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readHealthKv(e, KV_ECONOMICS_CURRENT),
    env,
    contractVersion: contractVersion(env),
  });
  const liveSubnets = live?.data?.subnets;
  let rows: Array<Record<string, unknown>> | null = Array.isArray(liveSubnets)
    ? (liveSubnets as Array<Record<string, unknown>>)
    : null;
  if (!rows) {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    const artifactSubnets = artifact.ok
      ? (artifact.data as Record<string, unknown> | undefined)?.subnets
      : undefined;
    rows = Array.isArray(artifactSubnets)
      ? (artifactSubnets as Array<Record<string, unknown>>)
      : [];
  }
  const row = rows.find((entry) => Number(entry?.netuid) === Number(netuid));
  const marketCap = row?.alpha_market_cap_tao;
  return typeof marketCap === "number" && Number.isFinite(marketCap)
    ? marketCap
    : null;
}

/**
 * The economics blob, from the LIVE tier if it has one and the published
 * artifact otherwise (#10307).
 *
 * ── Why the ladder is a function and not two copies ────────────────────────
 *
 * It was two copies, and they answered different numbers.
 * `get_subnet_validator_economics` overrides the economics reader because MCP
 * resolves artifacts through `ctx` rather than off `env` -- a correct fix for
 * #9229, which in making it dropped the LIVE rung and read the artifact alone.
 * REST and GraphQL kept both. The result, verified live for SN64 with both
 * values stable across repeated calls:
 *
 *   GET /api/v1/subnets/64/validator-economics   tao_inflow_per_day 89.4820752
 *   get_subnet_validator_economics {netuid: 64}  tao_inflow_per_day 91.0483919
 *
 * 1.7% apart -- large enough to be a different answer, small enough that
 * neither looks wrong to a reader. Both surfaces compute
 * `tao_in_emission_tao * BLOCKS_PER_DAY` from the same field; they were reading
 * it out of blobs refreshed on different cadences.
 *
 * The LADDER is the shared thing; the artifact READER is not. A caller supplies
 * its own, so MCP keeps the ctx-based read #9229 needed and still gets the live
 * rung first -- and a surface can no longer acquire one tier and miss the other
 * by overriding a loader, because the ORDER is not something a caller passes.
 */
export async function resolveEconomicsBlob(
  env: Env,
  readPublishedArtifact: () => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown> | null> {
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readHealthKv(e, KV_ECONOMICS_CURRENT),
    env,
    contractVersion: contractVersion(env),
  });
  if (Array.isArray(live?.data?.subnets)) return live.data;
  const artifact = await readPublishedArtifact();
  return artifact && Array.isArray(artifact.subnets) ? artifact : null;
}

// One subnet's live AMM pool reserves (#5235) — the constant-product inputs the
// stake-quote math needs — resolved from the same live-KV-then-committed-R2
// economics tiers as resolveSubnetMarketCapTao, plus the blob's freshness stamp
// for the response meta. Returns { row: null } when neither tier has a row.
export async function resolveSubnetEconomicsRow(env: Env, netuid: number) {
  const blob = await resolveEconomicsBlob(env, async () => {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    return artifact.ok
      ? ((artifact.data as Record<string, unknown> | undefined) ?? null)
      : null;
  });
  // The economics artifact's own rows, named. The trust boundary is the
  // `readArtifact` above, and `subnetEconomicsRow` is the ONE place the rows
  // cross it -- this used to keep its own copy of the find, so a third caller
  // (the MCP tool) kept a fourth (#10782).
  return {
    row: subnetEconomicsRow(blob, netuid),
    generatedAt: blob?.generated_at ?? blob?.captured_at ?? null,
  };
}

// GET /api/v1/subnets/{netuid}/stake-quote?amount=&direction=stake|unstake
// (#5235): a read-only constant-product slippage/price-impact estimate against
// the subnet's live AMM pool reserves — no chain write, no custody. Pure math in
// src/stake-quote.ts; this handler just resolves the reserves and maps its
// typed result onto the API envelope (400 for a bad request, 422 when the pool
// can't fill the requested swap).
export async function handleSubnetStakeQuote(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
  // The tripwire itself is AWAITED (a throw from `waitUntil` ships the bad
  // body anyway); ctx carries only the refusal's fault event (#10901), which
  // must never block or fail the response.
  ctx: { waitUntil?: (promise: Promise<unknown>) => void } = {},
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // A missing `amount` reads as 0, which computeStakeQuote rejects as
  // invalid_amount just like a non-numeric value — no separate null check. A
  // non-numeric one never reaches here: the router rejects it against the
  // published `number` first.
  const amount = (routeQuery(url).amount as number | undefined) ?? 0;
  const direction = routeValue<string>(url, "direction");
  const { row, generatedAt } = await resolveSubnetEconomicsRow(env, netuid);
  const result = computeStakeQuote({
    netuid: Number(netuid),
    taoInPool: row?.tao_in_pool_tao,
    alphaInPool: row?.alpha_in_pool,
    amount,
    direction,
  });
  if (!result.ok) {
    return errorResponse(result.code, result.error, result.status);
  }
  const envelopePayload = {
    data: { schema_version: 1, ...result.quote },
    meta: await metagraphMeta(
      env,
      `/metagraph/subnets/${netuid}/stake-quote.json`,
      generatedAt,
    ),
  };
  // Same opt-in staging tripwire as handleApiRequest's generic path (types-
  // epic B, #7860 requirement 6) -- this route bypasses that generic path
  // entirely (it's matched and returned early in workers/api.ts, before
  // handleApiRequest's envelope assembly), so without this call
  // "subnet-stake-quote" would never actually fire despite being one of the
  // 5 declared-covered pilot routes. See src/response-validation-tripwire.ts.
  if ((env.METAGRAPH_VALIDATE_RESPONSES as string) === "true") {
    // AWAITED for the same reason as handleApiRequest's call: the tripwire
    // throws on drift, and a throw from `waitUntil` ships the bad body anyway.
    try {
      await validateResponseTripwire(
        "subnet-stake-quote",
        { ok: true, schema_version: 1, ...envelopePayload },
        "/metagraph/subnets/{netuid}/stake-quote.json",
      );
    } catch (err) {
      if (err instanceof ResponseSchemaDriftError) {
        console.error(
          "[METAGRAPH_VALIDATE_RESPONSES] subnet-stake-quote refused:",
          err.detail,
        );
        // The dispatcher's refusal files a fault (#10897); this inline site
        // must too (#10901), or stake-quote is the one published route that
        // can 500 on every request while error tracking shows zero rows.
        // Same shape as workers/api.ts's scheduleExceptionEvent: fire and
        // forget, parked on waitUntil, never surfacing into a path that is
        // already failing. The drift detail rides in the message -- the
        // unrecognized keys ARE the diagnosis.
        try {
          const pending = Promise.resolve(
            recordExceptionEvent(env, {
              error: new Error(
                "response_schema_drift: subnet-stake-quote refused: " +
                  String(JSON.stringify(err.detail)).slice(0, 400),
              ),
              route: "subnet-stake-quote",
              errorCode: "response_schema_drift",
            }),
          ).catch(() => false);
          ctx?.waitUntil?.(pending);
        } catch {
          // Telemetry must never surface into the request path.
        }
        return errorResponse(
          "response_schema_drift",
          "The subnet-stake-quote response did not match its published schema and was not served.",
          500,
        );
      }
      throw err;
    }
  }
  return envelopeResponse(request, envelopePayload, "short");
}

// Field provenance for the validator-economics route (#9323). Nearly every field here
// is DERIVED — there is no storage item behind `permit_floor_units`, so labelling it
// `measured` would overstate what the chain actually says. `reconstructed` is reserved
// for exactly that, and the echoed governance parameters keep `measured` because they
// genuinely are single reads. The precedent is /network/parameters, which already marks
// three of its own fields reconstructed.
const VALIDATOR_ECONOMICS_FIELD_SOURCES = {
  permit_floor_units: { kind: "reconstructed", storage: null },
  permit_floor_cost_tao: { kind: "reconstructed", storage: null },
  permit_entry_cost_tao: { kind: "reconstructed", storage: null },
  earning_floor_units: { kind: "reconstructed", storage: null },
  earning_floor_cost_tao: { kind: "reconstructed", storage: null },
  earning_entry_cost_tao: { kind: "reconstructed", storage: null },
  permit_to_earning_multiple: { kind: "reconstructed", storage: null },
  root_tao_to_clear_threshold: { kind: "reconstructed", storage: null },
  uids_above_threshold: { kind: "reconstructed", storage: null },
  validator_slots_open: { kind: "reconstructed", storage: null },
  cap_binding: { kind: "reconstructed", storage: null },
  composition: { kind: "reconstructed", storage: null },
  takes: { kind: "measured", storage: "SubtensorModule.Delegates" },
  model_agreement: { kind: "reconstructed", storage: null },
  max_validators: {
    kind: "measured",
    storage: "SubtensorModule.MaxAllowedValidators",
  },
  min_childkey_take_ratio: {
    kind: "measured",
    storage: "SubtensorModule.MinChildkeyTake",
  },
  emission_gate_open: {
    kind: "measured",
    storage: "SubtensorModule.SubnetTaoInEmission",
  },
  tao_inflow_per_day: {
    kind: "reconstructed",
    storage: "SubtensorModule.SubnetTaoInEmission",
  },
  registration_cost_tao: { kind: "measured", storage: "SubtensorModule.Burn" },
  stake_threshold_units: {
    kind: "measured",
    storage: "SubtensorModule.StakeThreshold",
  },
  tao_weight: { kind: "measured", storage: "SubtensorModule.TaoWeight" },
} as const;

// The per-UID columns the derivation needs, and no more. `stake_tao` is the metagraph's
// `total_stake` — it ALREADY contains the root leg at tao_weight, so it is passed
// through untouched; recombining it from legs is the #9331 bug.
// `hotkey` is here only so the owner-exception path can find the owner's UID.
const VALIDATOR_ECONOMICS_NEURON_COLUMNS =
  "uid, hotkey, stake_tao, validator_permit, dividends, active, take";

function toValidatorNeurons(
  rows: Array<Record<string, unknown>>,
): ValidatorNeuron[] {
  return rows.map((row) => ({
    uid: Number(row.uid),
    hotkey: row.hotkey == null ? null : String(row.hotkey),
    totalStake: Number(row.stake_tao ?? 0),
    validatorPermit: Number(row.validator_permit) === 1,
    dividends: Number(row.dividends ?? 0),
    active: Number(row.active) === 1,
    // null stays null: a UID with no recorded take is excluded from the distribution
    // rather than counted as charging 0.
    take: row.take == null ? null : Number(row.take),
  }));
}

// GET /api/v1/subnets/{netuid}/validator-economics (#9323, #9327): what a validator
// permit costs on this subnet, whether holding one earns, and what the field charges.
//
// Reads D1 directly rather than forwarding through the DATA_API postgres tier, because
// the derivation needs three things that only live in THIS worker: the economics-tier
// pool reserves, the live governance parameters, and the burn. The neurons table is in
// the same D1 the health binding already points at, so a forward would split one
// derivation across two workers for no gain.
//
// Degrades field-by-field rather than 404ing. A confident 0 here reads as "free to
// validate", which is the specific wrong answer the module exists to avoid (#9285,
// #9114, #9121).
// The one composition, shared by REST, MCP and GraphQL. Wiring one surface and
// leaving the other two to reimplement it is the parity bug #9229 taught — three
// surfaces answering the identical question with no way for a caller to tell which
// was right. Returns the wire payload plus the artifact timestamp its meta needs.
export async function buildSubnetValidatorEconomicsPayload(
  env: Env,
  netuid: number,
  // Injection seam, same shape the watchdog family uses: the three non-store reads are
  // live RPC behind caches, and a test that cannot stub them exercises only the
  // degraded path — which would leave every real branch here unmeasured.
  deps: {
    loadParams?: typeof loadNetworkParameters;
    loadBurn?: typeof loadSubnetBurn;
    // The MCP surface reads artifacts through its own ctx reader rather than off
    // `env`, so it MUST pass this — without it the tool silently sees no reserves
    // and no cap, and answers degraded for every subnet.
    loadEconomicsRow?: typeof resolveSubnetEconomicsRow;
  } = {},
): Promise<{ data: Record<string, unknown>; generatedAt: unknown }> {
  const readParams = deps.loadParams ?? loadNetworkParameters;
  const readBurn = deps.loadBurn ?? loadSubnetBurn;
  const readEconomicsRow = deps.loadEconomicsRow ?? resolveSubnetEconomicsRow;
  const db = readStore(env, VALIDATOR_ECONOMICS_TABLES) as
    ReadStoreDb | undefined;
  const rows = db
    ? await db.query(
        `SELECT ${VALIDATOR_ECONOMICS_NEURON_COLUMNS} FROM neurons WHERE netuid = ? ORDER BY uid`,
        [netuid],
      )
    : [];

  const hyperRow = db
    ? await db.first(
        "SELECT max_validators, min_childkey_take_ratio FROM subnet_hyperparams WHERE netuid = ? LIMIT 1",
        [netuid],
      )
    : null;

  const { row: economics, generatedAt } = await readEconomicsRow(env, netuid);
  const params = await readParams(env);
  // The burn read is live RPC behind a KV cache and is allowed to fail: without it the
  // ENTRY costs degrade to null while the floors and their costs stay published, which
  // is a strictly better answer than withholding the whole row.
  let burnTao: number | null;
  try {
    const burn = (await readBurn(env, netuid)) as Record<string, unknown>;
    burnTao = typeof burn?.burn_tao === "number" ? burn.burn_tao : null;
  } catch {
    burnTao = null;
  }

  const maxValidators =
    hyperRow?.max_validators != null
      ? Number(hyperRow.max_validators)
      : economics?.max_validators != null
        ? Number(economics.max_validators)
        : null;

  const economicsResult = buildValidatorEconomics({
    neurons: toValidatorNeurons(rows as Array<Record<string, unknown>>),
    maxValidators,
    stakeThreshold: params?.stake_threshold_tao ?? null,
    taoWeight: params?.tao_weight ?? null,
    taoReserve:
      economics?.tao_in_pool_tao != null
        ? Number(economics.tao_in_pool_tao)
        : null,
    alphaReserve:
      economics?.alpha_in_pool != null ? Number(economics.alpha_in_pool) : null,
    taoInEmissionPerBlock:
      economics?.tao_in_emission_tao != null
        ? Number(economics.tao_in_emission_tao)
        : null,
    registrationCostTao: burnTao,
    minChildkeyTakeRatio:
      hyperRow?.min_childkey_take_ratio != null
        ? Number(hyperRow.min_childkey_take_ratio)
        : null,
    // the economics row is the only tier here that carries subnet ownership.
    ownerHotkey:
      economics?.owner_hotkey != null ? String(economics.owner_hotkey) : null,
  });

  const data = validatorEconomicsWire(
    { ...economicsResult, netuid: Number(netuid), maxValidators },
    maxValidators,
    params,
  );

  return { data, generatedAt };
}

// Shared by the per-subnet route and the ranking: the derived fields have no
// storage item behind them, so they are labelled `reconstructed` rather than
// claiming to be measured.
function validatorEconomicsWire(
  economicsResult: ValidatorEconomicsRow,
  maxValidators: number | null,
  params: {
    stake_threshold_tao: number | null;
    tao_weight: number | null;
  } | null,
): Record<string, unknown> {
  return {
    schema_version: 1,
    netuid: economicsResult.netuid,
    permit_floor_units: economicsResult.permitFloorUnits,
    permit_floor_cost_tao: economicsResult.permitFloorCostTao,
    permit_entry_cost_tao: economicsResult.permitEntryCostTao,
    earning_floor_units: economicsResult.earningFloorUnits,
    earning_floor_cost_tao: economicsResult.earningFloorCostTao,
    earning_entry_cost_tao: economicsResult.earningEntryCostTao,
    permit_to_earning_multiple: economicsResult.permitToEarningMultiple,
    root_tao_to_clear_threshold: economicsResult.rootTaoToClear,
    max_validators: maxValidators,
    validator_slots_open: economicsResult.validatorSlotsOpen,
    uids_above_threshold: economicsResult.uidsAboveThreshold,
    cap_binding: economicsResult.capBinding,
    composition: economicsResult.composition,
    takes: economicsResult.takes
      ? {
          median: economicsResult.takes.median,
          min: economicsResult.takes.min,
          max: economicsResult.takes.max,
          distribution: economicsResult.takes.distribution,
          median_earning: economicsResult.takes.medianEarning,
          sample_size: economicsResult.takes.sampleSize,
        }
      : null,
    min_childkey_take_ratio: economicsResult.minChildkeyTakeRatio,
    emission_gate_open: economicsResult.emissionGateOpen,
    tao_inflow_per_day: economicsResult.taoInflowPerDay,
    registration_cost_tao: economicsResult.registrationCostTao,
    stake_threshold_units: params?.stake_threshold_tao ?? null,
    tao_weight: params?.tao_weight ?? null,
    model_agreement: economicsResult.modelAgreement
      ? {
          matched: economicsResult.modelAgreement.matched,
          over_predicted: economicsResult.modelAgreement.overPredicted,
          under_predicted: economicsResult.modelAgreement.underPredicted,
          observed_permits: economicsResult.modelAgreement.observedPermits,
          agreement: economicsResult.modelAgreement.agreement,
          publishable: economicsResult.modelAgreement.publishable,
        }
      : null,
    degraded_reason: economicsResult.degradedReason,
    field_sources: VALIDATOR_ECONOMICS_FIELD_SOURCES,
  };
}

export async function handleSubnetValidatorEconomics(
  request: Request,
  env: Env,
  netuid: number,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const { data, generatedAt } = await buildSubnetValidatorEconomicsPayload(
    env,
    netuid,
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/validator-economics.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// Provenance for the history series. Every field here is OBSERVED off a daily
// snapshot rather than derived from a live parameter, which is exactly why the
// series is trustworthy across a governance change — see the schema header.
const VALIDATOR_ECONOMICS_HISTORY_FIELD_SOURCES = {
  permit_floor_alpha: { kind: "measured", storage: "SubtensorModule.Alpha" },
  earning_floor_alpha: { kind: "measured", storage: "SubtensorModule.Alpha" },
  validators_permitted: {
    kind: "measured",
    storage: "SubtensorModule.ValidatorPermit",
  },
  validators_active: { kind: "measured", storage: "SubtensorModule.Active" },
  validators_earning: {
    kind: "measured",
    storage: "SubtensorModule.Dividends",
  },
  emission_gate_open: {
    kind: "measured",
    storage: "SubtensorModule.SubnetTaoInEmission",
  },
  tao_inflow_per_day: {
    kind: "reconstructed",
    storage: "SubtensorModule.SubnetTaoInEmission",
  },
  // The cap is read live and stamped onto every point, so unlike its neighbours
  // it is NOT observed off that day's snapshot — a subnet whose cap moved inside the
  // window carries today's value on older points. That is still strictly better than
  // the join it replaces (the consumer had no cap at all), and labelling it `measured`
  // against the live storage item is what says so.
  max_validators: {
    kind: "measured",
    storage: "SubtensorModule.MaxAllowedValidators",
  },
  permit_set_full: {
    kind: "reconstructed",
    storage: "SubtensorModule.ValidatorPermit",
  },
} as const;

// GET /api/v1/subnets/{netuid}/validator-economics/history (#9326): the observed
// floors and set composition over time, so "is it getting more expensive to
// validate here" is answerable. Reads the daily rollups, not the live tier.
export async function buildSubnetValidatorEconomicsHistoryPayload(
  env: Env,
  netuid: number,
  windowLabel: string,
  // Same injection seam the per-subnet composer uses: the economics row is an artifact
  // read, and a test that cannot stub it exercises only the cap-unknown path.
  deps: {
    loadEconomicsRow?: typeof resolveSubnetEconomicsRow;
  } = {},
): Promise<{ data: Record<string, unknown> }> {
  const readEconomicsRow = deps.loadEconomicsRow ?? resolveSubnetEconomicsRow;
  const days = VALIDATOR_ECONOMICS_HISTORY_WINDOWS[windowLabel];
  const cutoff = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  // readStore, like the per-subnet composer two hundred lines up, NOT
  // observationsReadDb. That selector gates on the five surface_* tables --
  // none of which this reads -- and needs a `ctx` to park the connection
  // teardown on, which none of this function's three callers (the REST route,
  // the MCP tool, the GraphQL resolver) has ever passed. It therefore answered
  // `undefined` on every call, and `undefined` reads here as zero rows: an
  // empty series published for every subnet, edge-cached, with nothing marking
  // it a decline. readStore awaits its own teardown, so there is no ctx to
  // thread and no caller left that can forget one.
  const db = readStore(env, VALIDATOR_ECONOMICS_HISTORY_TABLES) as
    ReadStoreDb | undefined;

  const neuronRows = db
    ? await db.query(
        // `hotkey` is selected only so the owner's unconditional permit can be kept
        // out of the observed floor.
        "SELECT snapshot_date, hotkey, stake_tao, validator_permit, dividends, active " +
          "FROM neuron_daily WHERE netuid = ? AND snapshot_date >= ? " +
          "ORDER BY snapshot_date DESC LIMIT ?",
        [netuid, cutoff, VALIDATOR_ECONOMICS_HISTORY_ROW_CAP],
      )
    : [];

  const emissionRows = db
    ? await db.query(
        "SELECT snapshot_date, tao_in_emission_tao FROM subnet_snapshots " +
          "WHERE netuid = ? AND snapshot_date >= ? ORDER BY snapshot_date DESC",
        [netuid, cutoff],
      )
    : [];

  // The cap travels on every point so the observed floor is interpretable without a
  // join, and the owner is what keeps its unconditional permit out of that floor.
  //
  // The cap is resolved per day from the hyperparameter CHANGE-LOG, not stamped from the
  // live value: applying today's cap to an old snapshot manufactures a transition that
  // never happened. Rows before the window still matter — the cap in force on day one is
  // whatever the last change before it set — so this is not bounded by the cutoff.
  const capHistory = db
    ? await db.query(
        "SELECT observed_at, max_validators FROM subnet_hyperparams_history " +
          "WHERE netuid = ? AND max_validators IS NOT NULL ORDER BY observed_at ASC",
        [netuid],
      )
    : [];

  const { row: economics } = await readEconomicsRow(env, netuid);

  return {
    data: {
      schema_version: 1,
      netuid: Number(netuid),
      window: windowLabel,
      points: buildValidatorEconomicsHistory(
        neuronRows as never,
        emissionRows as never,
        {
          maxValidators:
            economics?.max_validators != null
              ? Number(economics.max_validators)
              : null,
          capHistory: capHistory as never,
          ownerHotkey:
            economics?.owner_hotkey != null
              ? String(economics.owner_hotkey)
              : null,
        },
      ),
      field_sources: VALIDATOR_ECONOMICS_HISTORY_FIELD_SOURCES,
    },
  };
}

export async function handleSubnetValidatorEconomicsHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const windowLabel = routeValue<string>(url, "window");
  const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
    env,
    netuid,
    windowLabel,
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/validator-economics-history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/validators/economics (#9324): one row per subnet, ranked by what it
// costs to become an EARNING validator there.
//
// ONE cross-subnet neuron scan plus ONE economics-artifact read, not 128 per-subnet
// round trips — the same shape `chain-yield` uses over this table. The registration
// burn is deliberately absent from the ranking: it is a live per-subnet chain read
// with no cached tier, so including it would mean ~128 RPC calls per request, and it
// is immaterial to the ORDER anyway (~0.15 TAO against floor costs of tens to
// hundreds). The per-subnet route reads it live and reports the true entry cost.
export async function buildValidatorEconomicsRankingPayload(
  env: Env,
  options: {
    sort?: string;
    limit?: number;
    offset?: number;
    emissionGateOpen?: boolean | null;
    capBinding?: boolean | null;
  } = {},
  deps: {
    loadParams?: typeof loadNetworkParameters;
    loadEconomics?: (env: Env) => Promise<{
      rows: Array<Record<string, unknown>>;
      generatedAt: unknown;
    }>;
  } = {},
): Promise<{ data: Record<string, unknown>; generatedAt: unknown }> {
  const readParams = deps.loadParams ?? loadNetworkParameters;
  const readEconomics =
    deps.loadEconomics ??
    (async (e: Env) => {
      // The whole blob in one read. `resolveSubnetEconomicsRow` resolves the same
      // blob and then picks a single row, so calling it per subnet would re-read
      // the artifact 128 times for data already in hand.
      const artifact = await readArtifact(e, "/metagraph/economics.json");
      const blob = artifact.ok
        ? (artifact.data as Record<string, unknown> | undefined)
        : undefined;
      return {
        rows: Array.isArray(blob?.subnets)
          ? (blob.subnets as Array<Record<string, unknown>>)
          : [],
        generatedAt: blob?.generated_at ?? blob?.captured_at ?? null,
      };
    });

  const db = readStore(env, VALIDATOR_ECONOMICS_RANKING_TABLES) as
    ReadStoreDb | undefined;
  const neuronRows = db
    ? await db.query(
        `SELECT netuid, ${VALIDATOR_ECONOMICS_NEURON_COLUMNS} FROM neurons WHERE netuid != 0 ORDER BY netuid, uid`,
      )
    : [];

  // Two bulk reads that make the ranking carry the SAME per-subnet fields the
  // detail route reports (#9455). Both are one query for every subnet, not one
  // per subnet -- the thing the original "128 per-subnet round trips" note
  // rules out. See buildValidatorEconomics's call below for what they feed.
  //
  // The burn read is why `permit_entry_cost_tao` / `earning_entry_cost_tao` /
  // `registration_cost_tao` used to publish null here. That was correct when
  // the burn existed only as a live per-subnet chain read with no cached tier;
  // `subnet_burn_history` (#9382) is that tier, refreshed continuously across
  // every subnet, so the cost argument no longer holds and the fields can carry
  // their real values instead of being dropped from the row.
  const latestBurnByNetuid = new Map<number, number>();
  const minChildkeyTakeByNetuid = new Map<number, number>();
  if (db) {
    // Newest observation per subnet. A window function rather than a
    // correlated subquery: one pass over the (netuid, observed_at DESC) index.
    const burnRows = await db.query(
      `SELECT netuid, burn_tao FROM (
         SELECT netuid, burn_tao,
           ROW_NUMBER() OVER (PARTITION BY netuid ORDER BY observed_at DESC) AS rn
         FROM subnet_burn_history
       ) WHERE rn = 1`,
    );
    for (const row of burnRows as Array<Record<string, unknown>>) {
      // burn_tao is NOT NULL in the table and a genuine 0 is a real price
      // (netuid 76 reads a true zero), so this must test for null, never falsy.
      if (row?.netuid != null && row.burn_tao != null) {
        latestBurnByNetuid.set(Number(row.netuid), Number(row.burn_tao));
      }
    }
    const hyperRows = await db.query(
      "SELECT netuid, min_childkey_take_ratio FROM subnet_hyperparams",
    );
    for (const row of hyperRows as Array<Record<string, unknown>>) {
      // Same rule: 0 is a real ratio, and the detail route reports it as 0.
      if (row?.netuid != null && row.min_childkey_take_ratio != null) {
        minChildkeyTakeByNetuid.set(
          Number(row.netuid),
          Number(row.min_childkey_take_ratio),
        );
      }
    }
  }

  const { rows: economicsRows, generatedAt } = await readEconomics(env);
  const params = await readParams(env);
  const economicsByNetuid = new Map<number, Record<string, unknown>>();
  for (const row of economicsRows) {
    economicsByNetuid.set(Number(row?.netuid), row);
  }

  const grouped = groupNeuronsByNetuid(
    (neuronRows as Array<Record<string, unknown>>).map((row) => ({
      netuid: Number(row.netuid),
      ...toValidatorNeurons([row])[0],
    })),
  );

  const rows: ValidatorEconomicsRow[] = [];
  for (const [netuid, neurons] of grouped) {
    const economics = economicsByNetuid.get(netuid);
    const maxValidators =
      economics?.max_validators != null
        ? Number(economics.max_validators)
        : null;
    rows.push({
      maxValidators,
      ...buildValidatorEconomics({
        neurons,
        maxValidators,
        stakeThreshold: params?.stake_threshold_tao ?? null,
        taoWeight: params?.tao_weight ?? null,
        taoReserve:
          economics?.tao_in_pool_tao != null
            ? Number(economics.tao_in_pool_tao)
            : null,
        alphaReserve:
          economics?.alpha_in_pool != null
            ? Number(economics.alpha_in_pool)
            : null,
        taoInEmissionPerBlock:
          economics?.tao_in_emission_tao != null
            ? Number(economics.tao_in_emission_tao)
            : null,
        // same owner exception the per-subnet route applies — without it this
        // route drops every owner-below-threshold subnet into `excluded`.
        ownerHotkey:
          economics?.owner_hotkey != null
            ? String(economics.owner_hotkey)
            : null,
        // Both `?? null` rather than `||`: a subnet whose burn or childkey
        // ratio is a genuine 0 must report 0, not fall through to null.
        registrationCostTao: latestBurnByNetuid.get(netuid) ?? null,
        minChildkeyTakeRatio: minChildkeyTakeByNetuid.get(netuid) ?? null,
      }),
      netuid,
    });
  }

  const ranked = rankValidatorEconomics(rows, {
    sort: options.sort,
    limit: options.limit,
    offset: options.offset,
    emissionGateOpen: options.emissionGateOpen ?? null,
    capBinding: options.capBinding ?? null,
  });

  return {
    data: {
      schema_version: 1,
      sort: ranked.sort,
      order: ranked.order,
      total: ranked.total,
      rows: ranked.rows.map((row) =>
        validatorEconomicsWire(row, row.maxValidators, params),
      ),
      excluded: ranked.excluded,
      stake_threshold_units: params?.stake_threshold_tao ?? null,
      tao_weight: params?.tao_weight ?? null,
      root_tao_to_clear_threshold:
        params?.stake_threshold_tao != null &&
        params?.tao_weight != null &&
        params.tao_weight > 0
          ? params.stake_threshold_tao / params.tao_weight
          : null,
      field_sources: VALIDATOR_ECONOMICS_FIELD_SOURCES,
    },
    generatedAt,
  };
}

export async function handleValidatorEconomicsRanking(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  // The enum is published and the router parses against it (#10060), so the
  // hand-rolled membership test that used to stand here is gone.
  const sortParam = routeText(url, "sort");
  const limit = pageLimit(url);
  const offset = routeInt(url, "offset") ?? 0;

  // A tri-state flag: absent means "both", which is not the same as false.
  const flag = (name: string) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    return raw === "true";
  };

  const { data, generatedAt } = await buildValidatorEconomicsRankingPayload(
    env,
    {
      sort: sortParam ?? undefined,
      limit: limit,
      offset: offset,
      emissionGateOpen: flag("emission_gate_open"),
      capBinding: flag("cap_binding"),
    },
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/validators/economics.json",
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/volume (#4339/8.1): rolling 24h buy (StakeAdded)
// vs sell (StakeRemoved) alpha volume for one subnet, summed live from the same
// account_events stream as stake-flow — unsigned (buy + sell), never netted, and
// a fixed 24h window (no ?window= param), matching the issue's framing as a
// canonical market-depth figure rather than a windowed analytics view. Cold/
// absent store → 200 with zeroed totals (schema-stable, never 404).
export async function handleSubnetAlphaVolume(
  request: Request,
  env: Env,
  netuid: number,
) {
  const marketCapTao = await resolveSubnetMarketCapTao(env, netuid);
  const {
    data,
    generatedAt,
  } = // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
    // and is absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // before it could touch DATA_API.

    // #9371: the projection tier its chain-wide sibling has had since #9146. The
    // Postgres tier is "retired" and declines unconditionally, so this card reported
    // 0 for every subnet while /chain/alpha-volume carried the same subnet's real
    // volume in its own per-subnet breakdown -- from these very rows.
    (await loadSubnetAlphaVolumeFromArtifact(env, Number(netuid), {
      marketCapTao,
    })) ?? {
      data: buildAlphaVolume([], Number(netuid), { marketCapTao }),
      generatedAt: null,
    };
  return envelopeResponse(
    request,
    {
      // USD on the 24h totals (#10383), overlaid after every tier has
      // converged. Priced at ONE named rate -- the window's close -- because
      // the window is fixed at 24h and the totals arrive already summed, so no
      // per-trade instant survives to here. See src/alpha-usd-overlay.ts.
      data: withAlphaVolumeUsd(
        data as unknown as Record<string, unknown>,
        await readTaoUsdCurrentKv(env),
        Date.now(),
      ),
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/volume.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/ohlc?interval=1h|1d&days=1-365 (#5655, Phase 1 of
// the OHLC epic #5304): open/high/low/close/volume candles for one subnet's
// alpha price, bucketed by ?interval= (default 1h) from the same account_events
// StakeAdded/StakeRemoved stream as /volume and /stake-flow -- each row is one
// executed trade, price = amount_tao / alpha_amount. ?days= bounds the
// Postgres-tier lookback window (default DEFAULT_OHLC_WINDOW_DAYS, max
// MAX_OHLC_WINDOW_DAYS); a wider opt-in beyond that is out of scope for this v1
// (#5304's scoping comment). Both params are validated here (a clear 400 for a
// bad value) even though buildSubnetOhlc also normalizes defensively -- mirrors
// handleSubnetStakeFlow's own window/direction validation. Root (netuid 0) has
// no AMM -- buildSubnetOhlc returns its root_excluded degenerate shape (no
// candles) rather than a meaningless flat-line series. Cold/absent store -> 200
// with an empty candle array (schema-stable, never 404), mirroring the sibling
// account_events routes.
export async function handleSubnetOhlc(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const interval = routeValue<string>(url, "interval");
  const daysResult = routeValue<number>(url, "days");
  const candleLimit = pageLimit(url);
  const {
    data,
    generatedAt,
  } = // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
    // and is absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // before it could touch DATA_API.

    // Lakehouse cold tier (src/subnet-ohlc-cold-tier.ts): the SAME
    // StakeAdded/StakeRemoved trades, bucketed in SQL instead of in a row
    // loop, ending in the SAME candle assembler. ?days= is finally load-
    // bearing here -- on the Postgres tier it only ever travelled as part of
    // the forwarded URL.
    (await loadSubnetOhlcColdTier(env, netuid, {
      interval,
      days: daysResult,
      limit: candleLimit,
    })) ?? {
      data: buildSubnetOhlc([], Number(netuid), {
        interval,
        limit: candleLimit,
      }),
      generatedAt: null,
    };
  // USD per candle (#10382). Overlaid HERE, after the tier resolves, so the
  // Postgres tier, the lakehouse cold tier and the empty fallback all gain it
  // from one place -- and so the shared candle assembler, which GraphQL and MCP
  // also call, keeps the shape those surfaces already publish.
  //
  // Each candle is priced by a reading from ITS OWN bucket; one older than the
  // index carries null rather than today's rate applied backwards. See
  // src/alpha-usd-history.ts for why that distinction is structural.
  // normalizeInterval is the assembler's OWN normalizer, so the rate buckets
  // and the candle buckets cannot disagree about what "1d" means.
  const bucketMs = OHLC_INTERVALS[normalizeInterval(interval)];
  // Null means there is nothing to price -- root (netuid 0) and a cold store
  // both yield empty candles, and querying the index for a window no point
  // falls in is a round trip whose rows nobody would read.
  const sinceMs = ohlcUsdWindowStart(data as Record<string, unknown>);
  const usdRows =
    sinceMs === null
      ? []
      : await loadTaoUsdBuckets(
          readStore(env, TAO_USD_TABLES) as never as unknown as Parameters<
            typeof loadTaoUsdBuckets
          >[0],
          { sinceMs, bucketMs },
        );
  return envelopeResponse(
    request,
    {
      data: withAlphaUsdCandles(
        data as Record<string, unknown>,
        usdRows === null ? null : taoUsdBucketMap(usdRows),
        bucketMs,
      ),
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/ohlc.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/movers?window=7d|30d|90d&sort=stake|emission|validators&limit=20:
// cross-subnet momentum leaderboard — every subnet ranked by its stake/emission/validator
// change between the window's start and end neuron_daily snapshots. Computed live from the
// neuron_daily rollup (idx_neuron_daily_netuid_date_agg covers the GROUP BY netuid,
// snapshot_date read). Cold/absent or single-snapshot store → 200 with movers:[]
// (schema-stable, never 404), mirroring the sibling history/turnover routes.
export async function handleSubnetMovers(request: Request, env: Env, url: URL) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const { label: windowParam } = resolveWindow(
    url,
    MOVERS_WINDOWS,
    DEFAULT_MOVERS_WINDOW,
  );
  const sortParam = routeValue<string>(url, "sort");
  const limit = pageLimit(url);
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildMovers> | null) ??
    buildMovers([], [], {
      window: windowParam,
      startDate: null,
      endDate: null,
      sort: sortParam,
      limit: limit,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.movers as unknown[],
      "subnet-movers",
      "short",
      request,
      MOVERS_CSV_COLUMNS,
    );
  }
  // neuron_daily-derived, so the meta reports the metagraph-snapshot source; generated_at
  // is the end snapshot date (string), matching the turnover/history routes.
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/subnets/movers.json",
        data.end_date,
      ),
    },
    "short",
  );
}

// ---- Account entity handlers (#1347) ---------------------------------------
// SQL + pagination live in src/account-events.ts (loadAccount*), shared with the
// MCP account tools; these handlers add only the REST envelope + meta.
async function accountMeta(
  env: Env,
  artifactPath: string,
  generatedAt: unknown,
) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "chain-events",
  };
}

// Account routes stamp meta.source but browsers need the CORS-exposed header too.
type EnvelopePayload = Parameters<typeof envelopeResponse>[1];

async function accountEnvelopeResponse(
  request: Request,
  payload: EnvelopePayload,
  cacheProfile: CacheProfile = "short",
  extraHeaders: Record<string, string> = {},
) {
  return envelopeResponse(request, payload, cacheProfile, {
    [X_METAGRAPH_ARTIFACT_SOURCE_HEADER]: payload.meta.source as string,
    ...extraHeaders,
  });
}

// GET /api/v1/accounts/{ss58}/stake-flow: the account's StakeAdded/StakeRemoved flow
// per subnet over a 7d/30d/90d window — net + gross flow, an HHI concentration of where
// its flow is focused, and a direction label. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export async function handleAccountStakeFlow(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const { label: windowParam } = resolveWindow(
    url,
    STAKE_FLOW_WINDOWS,
    DEFAULT_STAKE_FLOW_WINDOW,
  );
  // ?direction=all|in|out narrows to inflow/outflow only; omitted sums both.
  // Mirrors the subnet stake-flow route (#2694).
  const direction = routeText(url, "direction");
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss
  // (#6016/#6017). Postgres → lakehouse cold tier → schema-stable empty stub.
  const {
    data,
    generatedAt,
  } = // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
    // and is absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // before it could touch DATA_API.

    (await loadAccountStakeFlowColdTier(env, ss58, {
      window: windowParam,
      direction,
    })) ?? {
      data: buildAccountStakeFlow([], ss58, { window: windowParam }),
      generatedAt: null,
    };
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/stake-flow.json`,
        generatedAt,
      ),
    },
    "short",
  );
}

// Factory for the account-events handlers below (#5296): each GET /api/v1/accounts/{ss58}/<kind>
// endpoint validates ?window=, resolves via the Postgres tier with a schema-stable-zeros fallback,
// and wraps the result in the standard account envelope — identical control flow across all 7,
// differing only in the window enum, the shaping builder, and the response artifact's URL suffix.
function makeAccountEventHandler({
  windows,
  defaultWindow,
  build,
  urlSuffix,
  coldTier,
  markUnanswered,
}: {
  windows: Record<string, number>;
  defaultWindow: string;
  build: (
    rows: Array<Record<string, unknown>>,
    address: string,
    options: { window: string },
  ) => unknown;
  urlSuffix: string;
  /** Lakehouse reader tried between the Postgres tier and the schema-stable
   * empty (src/account-feeds-cold-tier.ts) -- returns the same wrapped
   * `{ data, generatedAt }` shape the Postgres tier does, or null to fall
   * through. Only the account_events-backed feeds with a wired reader set it. */
  coldTier?: (
    env: Env,
    ss58: string,
    window: string,
  ) => Promise<{ data: unknown; generatedAt: string | null } | null>;
  /** Applied to the schema-stable empty when NOTHING above answered, so the
   * zero carries the route's own statement that it is not a measurement
   * (#9307). Omitted by feeds whose empty really is a measured empty. */
  markUnanswered?: <T extends object>(payload: T) => T;
}) {
  return async function handleAccountEvent(
    request: Request,
    env: Env,
    ss58: string,
    url: URL,
  ) {
    const { label: windowParam } = resolveWindow(url, windows, defaultWindow);
    const { data, generatedAt } =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
      // and is absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
      // before it could touch DATA_API.

      (coldTier ? await coldTier(env, ss58, windowParam) : null) ??
      (() => {
        const empty = build([], ss58, { window: windowParam });
        return {
          data: markUnanswered ? markUnanswered(empty as object) : empty,
          generatedAt: null,
        };
      })();
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/${urlSuffix}.json`,
          generatedAt,
        ),
      },
      "short",
    );
  };
}

// GET /api/v1/accounts/{ss58}/stake-moves: the account's per-subnet StakeMoved footprint
// over a 7d/30d/90d window — movement count + first/last timestamps per subnet, an HHI
// concentration of where its re-delegation churn is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros.
export const handleAccountStakeMoves = makeAccountEventHandler({
  windows: ACCOUNT_STAKE_MOVES_WINDOWS,
  defaultWindow: DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
  build: buildAccountStakeMoves,
  urlSuffix: "stake-moves",
  coldTier: (env, ss58, window) =>
    loadAccountStakeMovesColdTier(env, ss58, { window }),
});

// GET /api/v1/accounts/{ss58}/weight-setters: the account's (validator's) per-subnet WeightsSet
// footprint over a 7d/30d window — weight-set count + first/last timestamps per subnet, an HHI
// concentration of where its weight-setting activity is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros.
export const handleAccountWeightSetters = makeAccountEventHandler({
  windows: ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  defaultWindow: DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
  build: buildAccountWeightSetters,
  urlSuffix: "weight-setters",
  coldTier: (env, ss58, window) =>
    loadAccountWeightSettersColdTier(env, ss58, { window }),
});

// GET /api/v1/accounts/{ss58}/registrations: the account's per-subnet NeuronRegistered footprint
// over a 7d/30d/90d window — registration count + first/last timestamps per subnet, an HHI
// concentration of where its registration activity is focused, and the dominant subnet.
// account_events-derived (source "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountRegistrations = makeAccountEventHandler({
  windows: REGISTRATION_WINDOWS,
  defaultWindow: DEFAULT_REGISTRATION_WINDOW,
  build: buildAccountRegistrations,
  urlSuffix: "registrations",
  coldTier: (env, ss58, window) =>
    loadAccountRegistrationsColdTier(env, ss58, { window }),
});

// GET /api/v1/accounts/{ss58}/serving: the account's per-subnet AxonServed footprint over a
// 7d/30d/90d window — announcement count + first/last timestamps per subnet, an HHI concentration
// of where its serving activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountServing = makeAccountEventHandler({
  windows: SERVING_WINDOWS,
  defaultWindow: DEFAULT_SERVING_WINDOW,
  build: buildAccountServing,
  urlSuffix: "serving",
  coldTier: (env, ss58, window) =>
    loadAccountServingColdTier(env, ss58, { window }),
});

// GET /api/v1/accounts/{ss58}/axon-removals: the account's per-subnet AxonInfoRemoved footprint over
// a 7d/30d/90d window — removal count + first/last timestamps per subnet, an HHI concentration of
// where its teardown activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountAxonRemovals = makeAccountEventHandler({
  windows: AXON_REMOVAL_WINDOWS,
  defaultWindow: DEFAULT_AXON_REMOVAL_WINDOW,
  build: buildAccountAxonRemovals,
  urlSuffix: "axon-removals",
});

// GET /api/v1/accounts/{ss58}/prometheus: the account's per-subnet PrometheusServed footprint over a
// 7d/30d/90d window — announcement count + first/last timestamps per subnet, an HHI concentration of
// where its telemetry activity is focused, and the dominant subnet. account_events-derived (source
// "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountPrometheus = makeAccountEventHandler({
  windows: PROMETHEUS_WINDOWS,
  defaultWindow: DEFAULT_PROMETHEUS_WINDOW,
  build: buildAccountPrometheus,
  urlSuffix: "prometheus",
  // #10322: the rung this family never had. Without it the handler fell to
  // `buildAccountPrometheus([])` for every account, because
  // METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" so the tier above declines
  // unconditionally -- a confident zero while the chain-level card answered
  // from the same PrometheusServed stream.
  coldTier: (env, ss58, window) =>
    loadAccountPrometheusColdTier(env, ss58, { window }),
});

// GET /api/v1/accounts/{ss58}/deregistrations: the account's per-subnet NeuronDeregistered footprint
// over a 7d/30d/90d window — eviction count + first/last timestamps per subnet, an HHI concentration
// of where its deregistration activity is focused, and the dominant subnet. account_events-derived
// (source "chain-events"). Cold/absent store → schema-stable zeros (never 404).
export const handleAccountDeregistrations = makeAccountEventHandler({
  windows: DEREGISTRATION_WINDOWS,
  defaultWindow: DEFAULT_DEREGISTRATION_WINDOW,
  build: buildAccountDeregistrations,
  urlSuffix: "deregistrations",
  // #9307: an account's deregistrations are the slots where it was the
  // PREVIOUS holder, derived from UID reuse. The lane derives 7d/30d; the 90d
  // this route also offers is not precomputed, so the reader declines it
  // rather than answering with another window's numbers, and the marked empty
  // below says so.
  coldTier: (env, ss58, window) =>
    loadAccountDeregistrationsFromArtifact(env, ss58, { window }),
  markUnanswered: markDeregistrationsNotDerived,
});

// GET /api/v1/accounts/{ss58}: cross-subnet summary — event-history aggregates
// (account_events, matched by hotkey OR coldkey) joined to current registrations
// (neurons, by hotkey). A deployment with no chain tier at all → schema-stable
// zero (never 404); a tier that exists and could not answer → 503, never a
// zeroed card (#9263 — see src/account-summary-card.ts).
export async function handleAccount(request: Request, env: Env, ss58: string) {
  // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
  // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read this branch
  // guarded resolved to null before it could touch DATA_API.
  // #9254/#9263: both non-Postgres legs of the card, assembled in ONE place
  // shared with MCP and GraphQL. Without it a single tier miss zeroed every
  // field at once while this account's own /events and /subnets routes read
  // real rows — and it zeroed them silently, reporting a source as though it
  // had measured them.
  const answer = await answerAccountSummary(env, ss58);
  if (answer?.kind === "gap") {
    return errorResponse(
      ACCOUNT_SUMMARY_GAP_CODE,
      accountSummaryGapMessage(ss58, answer.reasons),
      503,
      // #9386: the decline says WHICH leg failed and what the engine said. Without
      // it, a route failing half its requests produced a 503 whose cause could only
      // be guessed at from outside.
      { ss58, reasons: answer.reasons },
    );
  }
  const data =
    answer?.kind === "answer" ? answer.data : buildAccountSummary(ss58, {});
  // Community-contributable entity labels (#6739): additive field over the
  // baked entities.json artifact, joined by ss58 here rather than in either
  // upstream builder above (one join site instead of two). A missing/cold
  // artifact degrades to an empty label list, matching this route's own
  // never-404 contract.
  const entitiesArtifact = await readArtifact(env, ENTITY_LABELS_ARTIFACT);
  const artifactEntities = entitiesArtifact.ok
    ? ((entitiesArtifact.data as Record<string, unknown> | undefined)
        ?.entities as Array<Record<string, unknown>> | undefined)
    : [];
  const dataWithLabels = {
    ...data,
    labels: labelsForSs58(entityLabelsIndex(artifactEntities), ss58),
  };
  return accountEnvelopeResponse(
    request,
    {
      data: dataWithLabels,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}.json`,
        data.last_seen_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{coldkey}/entities (#6740): one address's own entity
// labels plus every subnet-ownership tie it has via the SubnetOwnerChanged
// chain_events stream (either side of the transfer) -- see
// src/entity-labels.ts's own header for the scope/limitation note (this
// only tracks AUTOMATIC ownership transfers, not genesis ownership).
//
// The DATA_API service binding (workers/data-api.ts) only carries the
// Postgres/Hyperdrive connection -- no R2/KV bindings of its own -- so it
// builds ownership_ties alone (entities: [] on its side); this handler then
// joins the entities.json artifact's `labels` on top, same join site as
// handleAccount above.
export async function handleAccountEntities(
  request: Request,
  env: Env,
  coldkey: string,
) {
  // NO TIER READ (#10190). METAGRAPH_SUBNET_OWNERSHIP_SOURCE is retired in every
  // deployed config and absent from FORWARDABLE_TIER_FLAGS, so this resolved to
  // null on every request. Note the `as keyof Env` the call needed: that cast was
  // the only thing letting a flag the helper can no longer accept be passed at
  // all, which is exactly the blindness #10190's type narrowing removes.
  const entitiesArtifact = await readArtifact(env, ENTITY_LABELS_ARTIFACT);
  // Through the composer (src/account-entities-answer.ts), which owns the tier
  // order and the empty floor for REST, MCP and GraphQL alike. It used to live
  // here only, which is exactly why the other two surfaces published an empty
  // ownership half. The labels join below applies identically to every tier.
  const data = await answerAccountEntities(env, coldkey, null);
  const artifactEntities = entitiesArtifact.ok
    ? ((entitiesArtifact.data as Record<string, unknown> | undefined)
        ?.entities as Array<Record<string, unknown>> | undefined)
    : [];
  const dataWithLabels = {
    ...data,
    labels: labelsForSs58(entityLabelsIndex(artifactEntities), coldkey),
  };
  return accountEnvelopeResponse(
    request,
    {
      data: dataWithLabels,
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/events: paginated event history (newest first),
// optional ?kind= filter, ?limit (<=1000) / ?offset.
export async function handleAccountEvents(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // Optional block-height range filter, parity with the extrinsics and
  // chain-events feeds. Index-satisfiable via idx_account_events_hotkey and
  // idx_account_events_coldkey (each leads block_number), so a bounded range
  // seeks rather than scans this public, ~60s-cached route.
  const kind = routeText(url, "kind");
  // Reject an unknown ?kind= up front, validated against the FULL ingested set
  // (not just INDEXED_EVENT_KINDS, which would wrongly reject Transfer/NetworkAdded
  // etc.). A typo/nonexistent kind otherwise matches nothing and forces a full
  // index walk on this public, ~60s-cached route — parity with handleSubnetEvents
  // (#2081).
  if (kind != null && !INGESTED_EVENT_KINDS.includes(kind)) {
    return analyticsQueryError({
      parameter: "kind",
      message: `"${kind}" is not a supported event kind. Supported: ${INGESTED_EVENT_KINDS.join(", ")}.`,
    });
  }
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const page = resolvePage(url);
  const { limit: parsedLimit, offset: parsedOffset } = page;
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    (await loadAccountEventsColdTier(
      env,
      ss58,
      {
        limit: parsedLimit,
        offset: parsedOffset,
        cursor: routeText(url, "cursor"),
        kind: routeText(url, "kind"),
        netuid: routeInt(url, "netuid"),
        blockStart: routeInt(url, "block_start"),
        blockEnd: routeInt(url, "block_end"),
      },
      network,
    )) ??
    buildAccountEvents([], ss58, {
      limit: parsedLimit,
      offset: parsedOffset,
      nextCursor: null,
    });
  // The fiat companion to price_at_tx (#8602), resolved for the WHOLE PAGE in
  // one query -- each event against the newest index reading at-or-before its
  // own instant, never a bucket it merely falls inside. Measured against
  // production for a 200-event page: 1.9ms, 200 probes on an index that
  // already exists. Events predating the index carry nulls rather than the
  // oldest rate carried backwards.
  const eventRows = Array.isArray(data?.events)
    ? (data.events as unknown as Record<string, unknown>[])
    : [];
  const usdByInstant = eventRows.length
    ? await loadTaoUsdAtInstants(
        readStore(env, TAO_USD_TABLES) as never as unknown as Parameters<
          typeof loadTaoUsdAtInstants
        >[0],
        eventRows
          .map((e) => Date.parse(String(e?.observed_at)))
          .filter((n) => Number.isFinite(n)),
      )
    : new Map();
  const priced = { ...data, events: withUsdAtTx(eventRows, usdByInstant) };
  if (csvRequested(url, request)) {
    return csvResponse(
      priced.events as unknown[],
      "account-events",
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data: priced,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/events.json`,
        (priced.events as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/history (#1854): the durable per-day activity
// series for an account, from the account_events_daily rollup. ?netuid filters
// to one subnet; ?from / ?to are YYYY-MM-DD bounds; ?limit (<=1000) / ?offset.
// Newest day first. D1 fully eliminated (2026-07-17): account_events_daily is
// Postgres-only now, so a tier miss (incl. inverted from>to bounds, which
// short-circuit before the tier call) always returns the schema-stable empty
// shape, never a live store query.
//
// SCOPE: the rollup writes only hotkey-attributed rows, so an ss58 with no
// hotkey activity returns zero days even when /events shows activity — a
// documented limitation of the hotkey-keyed rollup, not a bug (the contract
// description spells out the contrast with /events in full).

export async function handleAccountHistory(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const { from = null, to = null } = routeQuery(url);
  const page = resolvePage(url);
  const { limit, offset } = page;
  const netuid = routeInt(url, "netuid");
  // Inverted YYYY-MM-DD bounds are a deterministic no-match. Short-circuit before
  // D1 so callers cannot force a scan to prove an impossible empty page.
  if (from && to && from > to) {
    const data = buildAccountHistory([], ss58, {
      limit,
      offset,
      nextCursor: null,
    });
    // Honour ?format=csv on the short-circuit too, so an inverted range yields
    // a header-only CSV rather than a JSON body for a CSV request (#5741).
    if (csvRequested(url, request)) {
      return csvResponse(
        data.days as unknown[],
        "account-history",
        "short",
        request,
        ACCOUNT_HISTORY_CSV_COLUMNS,
      );
    }
    // Use the account envelope so this short-circuit exposes the
    // x-metagraph-artifact-source header too — the normal path below does (#2618),
    // and the payload stamps the same meta.source, so a browser must not lose the
    // CORS-exposed header just because the range was inverted.
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/history.json`,
          null,
        ),
      },
      "short",
    );
  }
  // Keyset (cursor) pagination over (day, netuid). day sorts as TEXT (YYYY-MM-DD
  // is chronological); the cursor encodes it as its natural sortable integer
  // (2026-06-25 -> 20260625) to fit the integer-only cursor codec, with netuid as
  // the within-day tiebreaker. netuid is NOT NULL (a primary-key column of
  // account_events_daily), so the cursor's netuid leg is always a real integer and
  // the seek never degrades to a NULL comparison. ORDER BY adds `netuid DESC` to
  // make same-day ordering deterministic — it was `day DESC` only before, where
  // same-day order was unspecified, so existing offset callers get a stable (not a
  // changed) page order. offset stays as a deprecated fallback; cursor wins. A
  // cursor that does not decode to a valid YYYYMMDD day is ignored (falls back to
  // the first page), preserving the never-throw contract.
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // The same account_events stream /events already reads, rolled up per UTC
    // day (#9315). Through the shared reader so MCP and GraphQL get it too.
    (await loadAccountHistoryColdTier(env, ss58, {
      limit,
      offset,
      netuid,
      from,
      to,
      cursor: routeText(url, "cursor"),
    })) ?? buildAccountHistory([], ss58, { limit, offset, nextCursor: null });
  // CSV export mirrors handleAccountEvents/Extrinsics/Transfers: the rows are
  // already range/netuid-filtered and paginated, so the CSV path carries the
  // identical set the JSON path would (#5741). Cold → empty array → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.days as unknown[],
      "account-history",
      "short",
      request,
      ACCOUNT_HISTORY_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/extrinsics: the extrinsics this account SIGNED
// (newest first), from the extrinsics store tier (#1844). Matched by the extrinsic
// signer only — NOT the hotkey or coldkey union the account_events routes use,
// since `extrinsics` carries a single `signer` column. ?block_start/?block_end
// constrain block height; ?limit (<=1000) / ?offset, or ?cursor=. Cold/absent store →
// schema-stable zero (never 404).
export async function handleAccountExtrinsics(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const page = resolvePage(url);
  const { limit: parsedLimit, offset: parsedOffset } = page;
  const data =
    // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    (await loadAccountExtrinsicsColdTier(env, ss58, {
      limit: parsedLimit,
      offset: parsedOffset,
      cursor: routeText(url, "cursor"),
      blockStart: routeInt(url, "block_start"),
      blockEnd: routeInt(url, "block_end"),
    })) ??
    buildAccountExtrinsics([], ss58, {
      limit: parsedLimit,
      offset: parsedOffset,
      nextCursor: null,
    });
  if (csvRequested(url, request)) {
    const csvRows = data.extrinsics.map((extrinsic) => ({
      ...extrinsic,
      extrinsic_id: `${extrinsic.block_number}-${extrinsic.extrinsic_index}`,
    }));
    return csvResponse(
      csvRows,
      "account-extrinsics",
      "short",
      request,
      ACCOUNT_EXTRINSICS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/extrinsics.json`,
        (data.extrinsics as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/accounts/{ss58}/transfers: the native-TAO Balances.Transfer feed for
// this account (#1850), newest first, from the account_events tier (event_kind=
// 'Transfer', where the poller stores hotkey=from / coldkey=to). ?direction=
// all|sent|received narrows by side; ?block_start/?block_end constrain block
// height; ?limit (<=1000) / ?offset, or ?cursor=. This is the native-TAO
// transfer feed only, NOT a full balance ledger. Cold/absent store →
// schema-stable zero (never 404).
export async function handleAccountTransfers(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const direction = routeText(url, "direction");
  if (
    direction !== null &&
    direction !== "all" &&
    direction !== "sent" &&
    direction !== "received"
  ) {
    return analyticsQueryError({
      parameter: "direction",
      message: `"${direction}" is not a valid direction. Supported: all, sent, received.`,
    });
  }
  const page = resolvePage(url);
  const { limit, offset } = page;
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  // Postgres → lakehouse cold tier → schema-stable empty stub.
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    (await loadAccountTransfersColdTier(env, ss58, {
      limit,
      offset,
      cursor: routeText(url, "cursor"),
      direction,
      blockStart: routeInt(url, "block_start"),
      blockEnd: routeInt(url, "block_end"),
    })) ??
    buildAccountTransfers([], ss58, {
      limit,
      offset,
      nextCursor: null,
      direction: undefined,
    });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.transfers as unknown[],
      "account-transfers",
      "short",
      request,
      ACCOUNT_TRANSFERS_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/transfers.json`,
        (data.transfers as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/accounts/{ss58}/counterparties?limit=N: who this account transacts
// with. Add ?counterparty=<ss58> to return a focused relationship drilldown on
// the same route without expanding the public path surface. ?format=csv exports
// the list-mode leaderboard (mirrors handleAccountsList); it's rejected alongside
// ?counterparty since the drilldown's single composite object has no CSV rows.
export async function handleAccountCounterparties(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const counterparty = routeText(url, "counterparty");
  const parsedLimit = pageLimit(url);
  const limit = parsedLimit;
  if (counterparty != null) {
    // CSV export only covers the list-mode leaderboard below -- the
    // relationship drilldown returns a single composite object, not rows.
    if (csvRequested(url, request)) {
      return analyticsQueryError({
        parameter: "format",
        message:
          "format=csv is not supported with counterparty; remove counterparty to export the list-mode counterparties CSV.",
      });
    }
    if (!isFinneySs58Address(counterparty)) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must be a valid SS58 account address.",
      });
    }
    if (ss58 === counterparty) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must differ from ss58.",
      });
    }
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
    // and the table is dropped in production, so a store query here would
    // always miss. An empty rows input always yields transfer_count: 0, so
    // this mirrors loadCounterpartyRelationship's composite shape with an
    // always-empty counterparties list, without querying D1 at all.
    const emptyRelationship = buildCounterpartyRelationship(
      [],
      ss58,
      counterparty,
      { limit },
    );
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadCounterpartyRelationshipColdTier(env, ss58, counterparty, {
        limit,
      })) ?? {
        schema_version: 1,
        ss58,
        counterparty_count: 0,
        transfers_scanned: emptyRelationship.transfers_scanned,
        scan_capped: emptyRelationship.scan_capped,
        total_sent_tao: emptyRelationship.total_sent_tao,
        total_received_tao: emptyRelationship.total_received_tao,
        counterparties: [],
        relationship: emptyRelationship,
      };
    return accountEnvelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/counterparties.json`,
          data.relationship.last_seen_at,
        ),
      },
      "short",
    );
  }
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    (await loadAccountCounterpartiesColdTier(env, ss58, { limit })) ??
    buildCounterparties([], ss58, { limit });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.counterparties as unknown[],
      "account-counterparties",
      "short",
      request,
      ACCOUNT_COUNTERPARTIES_CSV_COLUMNS,
    );
  }
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/counterparties.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets: the subnets where this hotkey is currently
// registered (the cross-subnet footprint), from the neurons tier.
export async function handleAccountSubnets(
  request: Request,
  env: Env,
  ss58: string,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountSubnets> | null) ??
    buildAccountSubnets([], ss58);
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/subnets.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/portfolio: the wallet's cross-subnet neuron
// positions with per-position economics + yield and wallet-level aggregates
// (totals, counts, overall return, stake concentration), from the neurons D1
// tier. Richer than /subnets (registration footprint only). Cold/absent → empty.
export async function handleAccountPortfolio(
  request: Request,
  env: Env,
  ss58: string,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountPortfolio> | null) ??
    buildAccountPortfolio([], ss58, { priceByNetuid: NO_ALPHA_PRICES });
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/portfolio.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/positions (#5233): this account's reconstructed
// nominator-side positions -- what it holds delegated across every
// hotkey/subnet, distinct from /portfolio above (hotkey-scoped). Reuses
// METAGRAPH_NEURONS_SOURCE (not a dedicated flag) since this route's stake_tao
// join reads the same neurons tier that flag already gates in production.
//
// Postgres → D1 hot tier → lakehouse cold tier → LABELLED empty card (#9273).
// The D1 leg is the live one: `nominator_positions` had no live writer at all
// between the box's decommission and #9273, so the lakehouse leg (#9266) is a
// frozen export whose `captured_at` can never advance. The hot leg declines
// while its table is empty, which makes the cutover a property of the data
// rather than of a deploy. The final card is `unavailableAccountPositions`,
// not a bare `buildAccountPositions([], ...)`: when every tier declines, this
// route's zero is a read failure, and it now says so instead of publishing a
// confident `total_stake_alpha: 0`.
export async function handleAccountPositions(
  request: Request,
  env: Env,
  ss58: string,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountPositions> | null) ??
    (await loadAccountPositionsFromStore(env, ss58)) ??
    (await loadAccountPositionsColdTier(env, ss58)) ??
    unavailableAccountPositions(ss58);
  return accountEnvelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/positions.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets/{netuid}/history?window=7d|30d|90d|1y|all
// (block-explorer Tier-1, #4329/6.2): one wallet's position on one subnet over
// time — the "Alpha Holdings chart" — read from the account_position_daily
// rollup tier (#4330/6.1). Source is metagraph-snapshot (rolled from
// `neurons`), not chain-events, so this uses envelopeResponse + metagraphMeta
// like the neuron/subnet history routes, not accountEnvelopeResponse.
// Postgres-only (#4839 shipped its write path + this read route; #4910's "no
// Postgres read route" premise was stale). No store fallback: D1's own
// account_position_daily rollup (rollupAccountPositionDaily,
// src/account-position-history.ts) has been permanently broken since #4908
// dropped D1's `neurons` table out from under it, so a D1 branch here could
// only ever serve data frozen at 2026-07-11 — worse than the schema-stable
// empty response below. Cold/absent store → 200 with empty points (never
// 404), matching every sibling history route.
export async function handleAccountPositionHistory(
  request: Request,
  env: Env,
  ss58: string,
  netuid: number,
  url: URL,
) {
  const { label, days } = historyWindow(url);
  const hot =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountPositionHistory> | null) ??
    buildAccountPositionHistory([], ss58, Number(netuid), { window: label });
  // See handleNeuronHistory: the cold leg lives on this Worker because the
  // lakehouse credential does.
  const data = await overlayAccountPositionHistoryColdTier(
    env,
    hot,
    ss58,
    Number(netuid),
    { label, days },
  );
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/subnets/${netuid}/history.json`,
        (data.points as unknown as Array<Record<string, unknown>>)[0]
          ?.captured_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/identity (epic #4301/5.4): the latest-only
// personal chain identity for one account, from the same
// MetagraphInfo.identities capture account-identity.ts's header documents
// (metagraph-snapshot sourced, like account position history above — not
// account_events, so metagraphMeta not accountMeta). has_identity is false
// for the common case (most accounts never call set_identity) — schema-stable,
// never 404.
//
// D1 retirement: account_identity's store write path (loadStagedAccountIdentity,
// formerly workers/request-handlers/staging.mjs, now deleted) is retired --
// refresh-account-identity writes Postgres only now (indexer-box cron
// pipeline). D1 fully eliminated (2026-07-16): a Postgres miss/outage now
// degrades to the schema-stable "no identity" shape, never a live store read of
// the frozen copy D1 left.
export async function handleAccountIdentity(
  request: Request,
  env: Env,
  ss58: string,
) {
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    )) as ReturnType<typeof buildAccountIdentity> | null) ??
    // Lakehouse cold tier (src/account-identity-cold-tier.ts): the frozen
    // verified snapshot through the SAME formatter, so the payload is
    // identical whichever tier answered.
    (await loadAccountIdentityColdTier(env, ss58)) ??
    buildAccountIdentity(null, ss58);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/identity.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/identity-history (epic #4301/5.4): append-only
// diff-tracking timeline for one account's identity (src/account-identity-
// history.mjs), newest first. Mirrors handleSubnetIdentityHistory's shape
// exactly, keyed by ss58 instead of netuid. Cold/absent store → schema-stable
// zero entries, never 404.
export async function handleAccountIdentityHistory(
  request: Request,
  env: Env,
  ss58: string,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  const data =
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
    )) as ReturnType<typeof buildAccountIdentityHistory> | null) ??
    // Lakehouse cold tier: same formatter, data-api's exact cursor token, so
    // a page started on one tier finishes correctly on the other.
    (await loadAccountIdentityHistoryColdTier(env, ss58, {
      limit,
      offset,
      cursor: routeText(url, "cursor"),
    })) ??
    buildAccountIdentityHistory([], ss58, { limit, offset, nextCursor: null });
  // CSV mirrors handleSubnetHyperparamsHistory: the page is already
  // limit/offset/cursor-bounded, so the CSV path carries the identical page the
  // JSON path would. Cold store -> empty entries -> header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.entries as unknown[],
      "account-identity-history",
      "short",
      request,
      ACCOUNT_IDENTITY_HISTORY_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/accounts/${ss58}/identity-history.json`,
        (data.entries as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/events (#1345 block explorer): the first-party
// chain-event stream for one subnet — account_events filtered by netuid, newest
// first (the idx_account_events_netuid index this tier was built for). Optional
// ?kind= filter; ?limit (<=1000)/?offset. Cold/absent store → schema-stable zero
// (never 404), mirroring handleAccountEvents.
export async function handleSubnetEvents(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const kind = routeText(url, "kind");
  // Reject an unknown ?kind= up front, validated against the FULL ingested set
  // (not just INDEXED_EVENT_KINDS, which would wrongly reject Transfer/NetworkAdded
  // etc.). A typo/nonexistent kind otherwise matches nothing and forces a full
  // index walk on this public, ~60s-cached route (#2081).
  if (kind != null && !INGESTED_EVENT_KINDS.includes(kind)) {
    return analyticsQueryError({
      parameter: "kind",
      message: `"${kind}" is not a supported event kind. Supported: ${INGESTED_EVENT_KINDS.join(", ")}.`,
    });
  }
  // Optional block-height range filter, parity with the extrinsics, chain-events
  // and account-events feeds. A bounded range stays index-satisfiable, so it
  // seeks rather than scans this public, ~60s-cached route.
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  const page = resolvePage(url);
  const { limit: parsedLimit, offset: parsedOffset } = page;
  const { block_start: blockStart, block_end: blockEnd } = routeQuery(url);
  // #9146: this feed has always read empty -- data-api never registered
  // /api/v1/subnets/:netuid/events, so the tier call below has never had a
  // handler to reach, even while the box was alive. Live proof of the gap:
  // /subnets/1/events reported event_count 0 while /subnets/1/stake-flow
  // counted 1,142 stake events over the same subnet and window, both derived
  // from this one stream. The lakehouse holds it -- chain.account_events,
  // 441,963,747 rows, genesis to head.
  //
  // The tier is still tried first and the cold read is awaited only on a miss:
  // it scans the largest table in the lakehouse, so it must not run when the
  // tier can answer.
  const tierResult =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    null;
  // Through the composer (src/subnet-events-answer.ts). This cascade used to
  // live here only, which is precisely why MCP and GraphQL published
  // event_count 0 for subnets this route served real rows for.
  const data = (await answerSubnetEvents(env, Number(netuid), tierResult, {
    limit: parsedLimit,
    offset: parsedOffset,
    cursor: routeText(url, "cursor"),
    kind,
    blockStart,
    blockEnd,
  })) as unknown as ReturnType<typeof buildSubnetEvents>;
  if (csvRequested(url, request)) {
    return csvResponse(
      data.events as unknown[],
      "subnet-events",
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/events.json`,
        (data.events as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/event-summary: compact windowed account_events
// aggregates by kind/category plus a small newest-first evidence slice. This is
// the dashboard-friendly companion to the raw /events feed.
export async function handleSubnetEventSummary(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const { label: windowLabel } = resolveWindow(
    url,
    SUBNET_EVENT_SUMMARY_WINDOWS,
    DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
  );
  const { limit: recentLimit = SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT } =
    routeQuery(url);
  const data =
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // The same account_events stream /subnets/{netuid}/events already reads,
    // rolled up by kind (#9303). Through the shared reader so MCP and GraphQL
    // get it too rather than being wired one surface at a time.
    (await loadSubnetEventSummaryColdTier(env, Number(netuid), {
      window: windowLabel,
      limit: recentLimit,
    })) ??
    buildSubnetEventSummary([], [], Number(netuid), {
      window: windowLabel,
      limit: recentLimit,
    });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/event-summary.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}

export const BALANCE_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// GET /api/v1/accounts/{ss58}/balance (#1818): live TAO balance (free+reserved)
// for one account, queried from the finney RPC at request time. 60s KV cache via
// METAGRAPH_CONTROL. Returns 400 on invalid ss58; 200 with balance_tao:null on
// RPC failure (schema-stable, consistent with blocks/extrinsics null-on-miss).
// Served through the shared envelopeResponse so it carries the same ok/data
// envelope, weak ETag, contract-version header, and 304/HEAD handling as every
// other route — the body matches the AccountBalanceArtifact data schema.
export async function handleAccountBalance(
  request: Request,
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`balance:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "balance_rate_limited",
        "Too many live balance requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountBalance(env, ss58, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/root-claim (#7229): live root-claim current
// state for one Finney ss58 account — claim type, per-hotkey claimable rates,
// cumulative claimed watermarks, and per-netuid thresholds. Read-only; never
// submits claim_root. Live RPC + KV-cache, same shape as handleAccountBalance.
export async function handleAccountRootClaim(
  request: Request,
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`root-claim:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "root_claim_rate_limited",
        "Too many live root-claim requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountRootClaim(env, ss58, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/children (#6723, part of the child-hotkey
// delegation graph epic #6721): every child hotkey this account currently
// delegates stake-weight to, per subnet, with the proportion charged. Live
// RPC + KV-cache route, same shape as handleAccountBalance just above —
// see src/child-hotkey-delegation.ts's header for the on-chain storage
// details.
export async function handleAccountChildren(
  request: Request,
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`children:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "children_rate_limited",
        "Too many live delegation-graph requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountChildren(env, ss58, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/parents (#6723): every hotkey currently
// delegating stake-weight to this account, per subnet. Same shape as
// handleAccountChildren just above, reading ParentKeys instead.
export async function handleAccountParents(
  request: Request,
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`parents:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "parents_rate_limited",
        "Too many live delegation-graph requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountParents(env, ss58, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/recycled (#4339/8.4): the live cumulative TAO
// recycled for registration on one subnet, queried from the chain's own
// RAORecycledForRegistration storage map at request time (600s KV cache via
// METAGRAPH_CONTROL) — see src/subnet-recycled.ts's header for why this
// isn't a log-layer/account_events aggregation. netuid is a per-request-
// controllable cache-busting parameter (like /accounts/{ss58}/balance's
// ss58), so it shares that route's rate limiter rather than sudo-key's
// no-limiter reasoning. recycled_tao is null on RPC failure (schema-stable).
export async function handleSubnetRecycled(
  request: Request,
  env: Env,
  netuid: number,
  network?: ChainNetworkId,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`recycled:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "recycled_rate_limited",
        "Too many live recycled-TAO requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetRecycled(env, netuid, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/burn (#6321): the live current registration/
// burn cost — the dynamic price between min_burn_tao/max_burn_tao's static
// bounds (subnet-hyperparams.ts). Same live-RPC + KV-cache + rate-limit
// shape as handleSubnetRecycled just above (a sibling storage-map read, not
// the same underlying value).
export async function handleSubnetBurn(
  request: Request,
  env: Env,
  netuid: number,
  network?: ChainNetworkId,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`burn:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "burn_rate_limited",
        "Too many live burn-cost requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetBurn(env, netuid, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/burn/history (#9402): how this subnet's registration
// cost has moved. The live routes answer "what does it cost"; this answers "is it
// getting more expensive", which is the question an operator deciding where and WHEN
// to register actually has. Served from the D1 series the capture cron writes.
export async function handleSubnetBurnHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const label = routeValue<string>(url, "window");
  const windowDays = BURN_HISTORY_WINDOWS[label];
  if (windowDays === undefined) {
    return analyticsQueryError({
      parameter: "window",
      message: `window must be one of ${Object.keys(BURN_HISTORY_WINDOWS).join(", ")}.`,
    });
  }
  const rows = await loadSubnetBurnHistory(
    readStore(
      env,
      SUBNET_BURN_HISTORY_TABLES,
    ) as never as unknown as Parameters<typeof loadSubnetBurnHistory>[0],
    netuid,
    { windowDays },
  );
  // A cold or unwritten table yields an EMPTY series, not a 404: "we have not been
  // recording this subnet" is a real state, and the same convention every sibling
  // history route already follows.
  const data = buildSubnetBurnHistory(rows, netuid, { window: label });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/holders (#9557): who owns this subnet's alpha.
//
// The reverse of /accounts/{ss58}/positions, which reads the same ledger one
// coldkey (one account) at a time. /subnets/{netuid}/concentration answers the
// neighbouring question off `neurons` and therefore sees registered UIDs only;
// this reads `nominator_positions`, which is keyed on (coldkey, hotkey, netuid)
// whether or not that hotkey holds a UID, so alpha parked on UNREGISTERED
// hotkeys is included -- the part no other public source carries.
//
// Declines rather than serving an empty ranking in two states (no complete pool
// pass, and root) -- see src/subnet-holders.ts for why an empty leaderboard here
// would read as a measurement.
export async function handleSubnetHolders(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const limit = pageLimit(url);

  const read = await loadSubnetHolders(
    readStore(env, ALPHA_PRICING_TABLES) as never as unknown as Parameters<
      typeof loadSubnetHolders
    >[0],
    netuid,
    { limit: limit },
  );
  const data = buildSubnetHolders(read, netuid, { limit: limit });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/network/tao-usd (#9609): the USD price of one TAO, with the
// derivation that produced it. The serving side of src/tao-usd-index.ts, whose
// output has been written to D1 once a minute since 2026-08-02 and never read.
//
// A null price is a stated outcome (`price_basis: insufficient_pools`), not a
// gap -- see src/tao-usd-series.ts for why this must never coalesce it.
export async function handleTaoUsd(request: Request, env: Env, url: URL) {
  // #9720. The series is 1,428 points and ~143 KB on the default window, while
  // every summary a caller usually wants -- latest, change_usd, change_pct, the
  // two counts -- is a top-level scalar beside it. REST keeps sending the
  // points unless asked not to; the MCP tool asks not to by default, because a
  // browser can stream 143 KB and a context window cannot (the same asymmetry
  // #9701 established for list_candidates).
  const includePoints = parseBooleanParam(url, "include_points", true);
  if ("error" in includePoints) return analyticsQueryError(includePoints.error);
  const label = routeValue<string>(url, "window");
  const windowHours = TAO_USD_WINDOWS[label];
  if (windowHours === undefined) {
    return analyticsQueryError({
      parameter: "window",
      message: `window must be one of ${Object.keys(TAO_USD_WINDOWS).join(", ")}.`,
    });
  }
  const rows = await loadTaoUsdSeries(
    readStore(env, TAO_USD_TABLES) as never as unknown as Parameters<
      typeof loadTaoUsdSeries
    >[0],
    { windowHours },
  );
  // A cold or unwritten table yields an EMPTY series with a null `latest`, not
  // a 404: "we have not priced this window" is a real state.
  const data = buildTaoUsdSeries(rows, {
    window: label,
    includePoints: includePoints.value,
  });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/surface-history (#9612): when this subnet's
// public surfaces were added, changed or removed, and in which commit. The
// registry says what a subnet exposes TODAY; this says when that became true.
export async function handleSubnetSurfaceHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const limit = pageLimit(url);

  const rows = await loadSurfaceHistory(
    readStore(env, SURFACE_HISTORY_TABLES) as never as unknown as Parameters<
      typeof loadSurfaceHistory
    >[0],
    netuid,
    { limit: limit },
  );
  // A subnet whose surfaces have never changed is an EMPTY trail, not a 404 --
  // stability is the common case and a real answer.
  const data = buildSurfaceHistory(rows, netuid, { limit: limit });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/chain/governance/emission-changes (#9615): every recorded change
// to the emission gate's parameters, the per-subnet emission switches, and the
// dormant TAO-flow path. /network/parameters serves these as CURRENT state;
// this says when they became that, and what they were before.
export async function handleEmissionChanges(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const kindParam = routeText(url, "kind");
  if (
    kindParam !== null &&
    !EMISSION_CHANGE_KINDS.includes(
      kindParam as (typeof EMISSION_CHANGE_KINDS)[number],
    )
  ) {
    return analyticsQueryError({
      parameter: "kind",
      message: `kind must be one of ${EMISSION_CHANGE_KINDS.join(", ")}.`,
    });
  }
  const limit = pageLimit(url);

  const rows = await loadEmissionChanges(
    readStore(env, EMISSION_CHANGES_TABLES) as never as unknown as Parameters<
      typeof loadEmissionChanges
    >[0],
    { limit: limit, kind: kindParam ?? undefined },
  );
  // These tables gain a row only when a value MOVED, so an empty feed is the
  // steady state -- never a 404.
  const data = buildEmissionChanges(rows, {
    limit: limit,
    kind: kindParam ?? undefined,
  });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/chain/holders (#9607): every subnet ranked by how concentrated its
// alpha ownership is -- the cross-subnet companion to /subnets/{netuid}/holders,
// which answers this one subnet at a time and so takes 129 requests to compare
// the network.
//
// Distinct from /chain/concentration, which reads neurons.stake_tao and
// therefore sees registered UIDs only. This reads the position ledger, so a
// subnet whose alpha sits on unregistered hotkeys is measured rather than
// invisible.
export async function handleChainHolders(request: Request, env: Env, url: URL) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const sort = routeValue<string>(url, "sort");
  if (
    !CHAIN_HOLDERS_SORTS.includes(sort as (typeof CHAIN_HOLDERS_SORTS)[number])
  ) {
    return analyticsQueryError({
      parameter: "sort",
      message: `"${sort}" is not a supported sort. Supported: ${CHAIN_HOLDERS_SORTS.join(", ")}.`,
    });
  }
  const limit = pageLimit(url);

  const read = await loadChainHolders(
    readStore(env, ALPHA_PRICING_TABLES) as never as unknown as Parameters<
      typeof loadChainHolders
    >[0],
  );
  const data = buildChainHolders(read, { sort, limit: limit });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/health/failure-reasons (#9622): why surfaces fail and whether the
// mix is changing, read from the daily rollup 0025 added -- the raw checks are
// pruned at 30 days and the pre-existing rollup kept no classification at all.
export async function handleFailureReasons(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const window = routeValue<string>(url, "window");
  const netuidParam = routeInt(url, "netuid");
  let netuid: number | undefined;
  if (netuidParam !== null) {
    const parsed = Number(netuidParam);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      return analyticsQueryError({
        parameter: "netuid",
        message: "netuid must be an integer between 0 and 65535.",
      });
    }
    netuid = parsed;
  }
  const kind = routeText(url, "kind") ?? undefined;

  const rows = await loadFailureReasons(
    readStore(env, FAILURE_REASONS_TABLES) as never as unknown as Parameters<
      typeof loadFailureReasons
    >[0],
    { window, netuid, kind },
  );
  // An empty window is a MEASUREMENT and reaches buildFailureReasons; only a
  // failed read declines, because "the prober recorded nothing" and "we could
  // not ask" are different answers.
  const data =
    rows === null
      ? declineFailureReasons("unavailable", { window, netuid, kind })
      : buildFailureReasons(rows, { window, netuid, kind });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/chain/indexer-lag (#9620): how long after a block is produced it
// becomes queryable here -- the write-latency distribution over the retained
// window, plus how far behind the lane is right now. Two different numbers; see
// src/indexer-lag.ts for why they are named separately.
export async function handleIndexerLag(request: Request, env: Env, url: URL) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const row = await loadIndexerLag(
    readStore(env, INDEXER_LAG_TABLES) as never as unknown as Parameters<
      typeof loadIndexerLag
    >[0],
  );
  // The handler owns the clock, so the module whose subject is two clocks does
  // not quietly introduce a third of its own.
  const data = buildIndexerLag(row, Date.now());
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/chain/concentration/history (#9628): is the NETWORK getting more
// concentrated? Reads the daily rollup, which ran the same builder
// /chain/concentration serves -- see src/chain-concentration-history.ts for why
// this is not computed live.
export async function handleChainConcentrationHistory(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const window = routeValue<string>(url, "window");
  const rows = await loadChainConcentrationHistory(
    readStore(
      env,
      CHAIN_CONCENTRATION_HISTORY_TABLES,
    ) as never as unknown as Parameters<
      typeof loadChainConcentrationHistory
    >[0],
    { window },
  );
  // An empty window is a MEASUREMENT -- a window narrower than the rollup's
  // depth returns nothing legitimately -- so only a failed read declines.
  const data =
    rows === null
      ? declineChainConcentrationHistory("unavailable", { window })
      : buildChainConcentrationHistory(rows, { window });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/emission-pipeline/history (#9625): one subnet's
// pipeline decomposition over time. /chain/emission-pipeline answers one block;
// this answers the series, with each point pinned to the block it came from.
export async function handleSubnetPipelineHistory(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const window = routeValue<string>(url, "window");
  const rows = await loadPipelineHistory(
    readStore(env, SUBNET_SNAPSHOT_TABLES) as never as unknown as Parameters<
      typeof loadPipelineHistory
    >[0],
    netuid,
    { window },
  );
  // An empty series is a MEASUREMENT -- a subnet registered after the capture
  // began returns one legitimately -- so only a failed read declines.
  const data =
    rows === null
      ? declinePipelineHistory("unavailable", netuid, { window })
      : buildPipelineHistory(rows, netuid, { window });
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/chain/burn (#9399): EVERY subnet's live registration cost in one
// response, ranked cheapest-first.
//
// The per-subnet sibling above answers "what does netuid N cost"; an operator's first
// question is "where is registration cheapest right now", and through that route it
// takes 129 requests. Served from ONE chain read -- Burn is Identity-hashed, so the
// keys are derivable and state_queryStorageAt returns them together (see
// src/chain-burn.ts). Same live-RPC + KV-cache + rate-limit shape as its sibling.
export async function handleChainBurn(
  request: Request,
  env: Env,
  network?: ChainNetworkId,
) {
  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`chain-burn:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "burn_rate_limited",
        "Too many live burn-cost requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadChainBurn(env, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/lease (#6719, part of the subnet-leasing/
// crowdloan-tracking epic #6717): whether a subnet is currently under a
// lease and, if so, its terms + accumulated-but-undistributed alpha
// dividends. Same live-RPC + KV-cache + rate-limit shape as handleSubnetBurn
// just above (a different set of storage items, same pattern). See
// src/subnet-lease.ts's header for the on-chain storage-key/struct-layout
// details. The companion /lease/history route (event log) is a Postgres-
// tier route in workers/data-api.ts, not here.
export async function handleSubnetLease(
  request: Request,
  env: Env,
  netuid: number,
  network?: ChainNetworkId,
) {
  if (!isU16Netuid(netuid)) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`lease:${resolveClientIp(request)}`, network),
    });
    if (!success) {
      return errorResponse(
        "lease_rate_limited",
        "Too many live lease-state requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadSubnetLease(env, netuid, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// Shared rate-limit guard for the two live-RPC crowdloan routes (#8696). Same
// live-RPC + KV-cache + rate-limit shape as handleSubnetLease above; factored
// out only because two routes need the identical check with a different key
// scope. Returns a 429 Response to return, or null to proceed.
async function crowdloanRateLimitResponse(
  request: Request,
  env: Env,
  scope: string,
  network?: ChainNetworkId,
): Promise<Response | null> {
  if (!env.RPC_RATE_LIMITER?.limit) return null;
  const { success } = await env.RPC_RATE_LIMITER.limit({
    key: networkKvKey(`${scope}:${resolveClientIp(request)}`, network),
  });
  if (success) return null;
  return errorResponse(
    "crowdloan_rate_limited",
    "Too many live crowdloan-state requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

// GET /api/v1/crowdloans (#8696): every crowdloan the chain has ever opened,
// with its terms and how much it raised, read from the Crowdloan pallet's own
// NextCrowdloanId + Crowdloans storage at request time. Not paginated: the
// collection is bounded by NextCrowdloanId (15 on finney at time of writing)
// and the whole set is one batched storage read, so a page cursor would cost
// more than it saves. See src/crowdloans.ts's header for why this is a
// storage read rather than an extrinsics feed.
export async function handleCrowdloans(
  request: Request,
  env: Env,
  url: URL,
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  const limited = await crowdloanRateLimitResponse(
    request,
    env,
    "crowdloans",
    network,
  );
  if (limited) return limited;

  const data = await loadCrowdloans(env, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/crowdloans/{id} (#8696): one crowdloan's live state. `exists` is
// null (not false) on RPC failure, distinct from a confirmed-absent id
// (exists:false) — an id can be absent legitimately, because `dissolve`
// removes the record while NextCrowdloanId keeps counting.
export async function handleCrowdloan(
  request: Request,
  env: Env,
  crowdloanId: number,
  url: URL,
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);

  if (!isCrowdloanId(crowdloanId)) {
    return errorResponse(
      "invalid_crowdloan_id",
      "crowdloan_id must be an integer in the u32 range 0..4294967295.",
      400,
    );
  }

  const limited = await crowdloanRateLimitResponse(
    request,
    env,
    "crowdloan",
    network,
  );
  if (limited) return limited;

  const data = await loadCrowdloan(env, crowdloanId, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/blocks: the recent-block feed (newest first), served live from the
// `blocks` store tier (#1345 block explorer). ?limit clamp <=100, ?offset. Cold/
// absent store → schema-stable zero (never throws). Reuses the chain-events meta
// (source:"chain-events") since the same first-party poller fills this tier.
export async function handleBlocks(
  request: Request,
  env: Env,
  url: URL,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  // When the Postgres tier misses (the self-hosted box is gone), the cold tier
  // answers from the two sources that outlive it: the R2 lakehouse for
  // verified history, and D1's blocks_head for everything the head poller has
  // seen since. They meet at a fixed seam, so every block comes from exactly
  // one of them -- see src/blocks-cold-tier.ts. All tiers feed the SAME
  // buildBlockFeed formatter, so the payload is identical whichever answered.
  const data =
    // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
    // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // on every request.
    (await loadBlockFeedColdTier(
      env,
      {
        limit,
        offset,
        cursor: routeText(url, "cursor"),
        author: routeText(url, "author"),
        specVersion: routeInt(url, "spec_version"),
        blockStart: routeInt(url, "block_start"),
        blockEnd: routeInt(url, "block_end"),
        // from/to are part of this route's contract too -- a filter the tier
        // never receives is a filter it silently ignores. `routeInt`, not
        // `routeText` (#10395): the two are declared `z.int()` like every
        // sibling bound here, so the parse hands back a NUMBER and the string
        // accessor answered null on every request -- `routeText`'s own doc
        // says so ("if a caller reaches for the wrong accessor, the answer is
        // null rather than a number wearing a string's type"). Measured
        // against production before the fix: `?to=8000000` and
        // `?to=1786000000000` both returned the newest blocks unfiltered,
        // while the same bound on /api/v1/extrinsics -- whose handler forwards
        // `routeQuery(url)` wholesale rather than per-parameter -- returned an
        // empty page. A published filter that has never once been applied.
        from: routeInt(url, "from"),
        to: routeInt(url, "to"),
        minExtrinsics: routeInt(url, "min_extrinsics"),
        minEvents: routeInt(url, "min_events"),
      } as never,
      network,
    )) ?? buildBlockFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      data.blocks as unknown[],
      "blocks",
      "short",
      request,
      BLOCK_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/blocks.json",
        (data.blocks as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
    { vary: "Accept, Accept-Encoding" },
  );
}

// GET /api/v1/blocks/summary: block-production analytics over the most recent
// blocks — inter-block time distribution, extrinsic/event throughput, block-author
// decentralization (concentration over each author's block count), and the runtime
// spec-version spread, computed live from the `blocks` store tier. No params; a
// cold/absent store → 200 with a schema-stable zeroed card.
export async function handleBlocksSummary(
  request: Request,
  env: Env,
  url: URL,
  /** Which chain's projection to serve (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
) {
  // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
  // config and absent from FORWARDABLE_TIER_FLAGS, so `pgData` was always null
  // and the projection below always the answer.
  //
  // #9146: serve the precomputed card from the blocks-summary projection rather
  // than a zeroed one. The reader declines (null) when it cannot answer
  // faithfully, which keeps buildBlocksSummary([]) as the floor.
  const projected = await loadBlocksSummaryFromArtifact(env, network);
  const data = projected ?? buildBlocksSummary([]);
  const response = await envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/blocks/summary.json",
        data.last_observed_at,
      ),
    },
    "short",
  );
  return projected ? response : markDataApiTierFallbackResponse(response);
}

// GET /api/v1/blocks/{ref}: per-block detail (#1345). ref is a numeric
// block_number OR a 0x block_hash. Served live from the `blocks` store tier; an
// unknown ref / cold store → 200 with block:null (schema-stable, mirrors the
// neuron detail route — NEVER 404/throw).
export async function handleBlock(
  request: Request,
  env: Env,
  ref: string,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  // #4909 D1 retirement: blocks' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  // #9115: same lakehouse fallback as the feed above; buildBlock is shared, so
  // a block served from R2 is byte-identical to one served from Postgres.
  const data =
    // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
    // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // on every request.
    (await loadBlockColdTier(env, ref, network)) ?? buildBlock(undefined, ref);
  // Finalized block detail is immutable once resolved; a cold/unknown ref stays
  // on the short profile so clients re-check when the block lands.
  const cacheProfile = data.block ? "static" : "short";
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}.json`,
        data.block?.observed_at ?? null,
      ),
    },
    cacheProfile,
  );
}

/**
 * The one response every chain-detail route emits for a gap between the
 * live-follow window and the decoded lakehouse (#9208).
 *
 * 503, NOT 200-with-an-empty-list, and not 404 either. An empty list is a lie
 * by omission: the caller cannot tell it from a block that genuinely had no
 * extrinsics, and that indistinguishability is the whole bug. A 404 would claim
 * the block does not exist, when the block list is serving its header right
 * now. 503 says what is true -- the data exists and this deployment cannot
 * currently read it -- and it is retryable, which a gap genuinely is: the
 * decode lane closes it within the hour.
 *
 * The meta carries both boundaries so the condition is diagnosable from the
 * response alone, without reading a dashboard.
 */
export function chainDetailGapResponse(
  gap: Extract<ChainDetailAnswer<unknown>, { kind: "gap" }>,
) {
  return errorResponse(
    "block_detail_unavailable",
    chainDetailGapMessage(gap),
    503,
    {
      block_number: gap.block,
      decoded_through: gap.seam,
      hot_window: gap.coverage
        ? { from: gap.coverage.floor, to: gap.coverage.head }
        : null,
    },
  );
}

// GET /api/v1/blocks/{ref}/extrinsics: the extrinsics in one block (#1845), in
// natural read order (extrinsic_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then extrinsics are read by the (block_number, extrinsic_index) PK prefix. ?limit
// (<=100) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// extrinsics:[] (schema-stable, never 404).
export async function handleBlockExtrinsics(
  request: Request,
  env: Env,
  ref: string,
  url: URL,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in wrangler.jsonc
  // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read this branch
  // guarded resolved to null before it could touch DATA_API.
  // #9208: hot tier above the decode seam, lakehouse at or below it, and a
  // DECLINE for a block neither can answer -- an empty extrinsics array is
  // indistinguishable from a block that genuinely had none, which is the exact
  // ambiguity this route used to produce for every recent block. Reached only
  // when the Postgres tier missed, so the lakehouse is still not queried on the
  // hot path.
  const answer = await answerBlockDetail(env, ref, {
    hot: (height) =>
      loadBlockExtrinsicsHotTier(env, ref, height, { limit, offset }),
    cold: () =>
      loadBlockExtrinsicsColdTier(env, ref, { limit, offset }, network),
    isEmpty: isEmptyExtrinsicPayload,
  });
  if (answer?.kind === "gap") return chainDetailGapResponse(answer);
  const data =
    answer?.kind === "answer"
      ? answer.data
      : buildBlockExtrinsics([], ref, null, { limit, offset });
  // CSV reuses handleExtrinsics's transform + columns — buildBlockExtrinsics maps
  // the same formatExtrinsic row shape (#5746). Cold block → empty → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(
        data.extrinsics as unknown as Array<Record<string, unknown>>,
      ),
      `block-${ref}-extrinsics`,
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/extrinsics.json`,
        (data.extrinsics as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/blocks/{ref}/events: the decoded chain events in one block (#1852),
// in natural read order (event_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then events are read by the (block_number, event_index) PK prefix. ?limit
// (<=1000) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// events:[] (schema-stable, never 404). Mirrors handleBlockExtrinsics.
export async function handleBlockEvents(
  request: Request,
  env: Env,
  ref: string,
  url: URL,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
  // the table is dropped in production, so a store query here would always miss.
  // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE is deleted from every config (#10228)
  // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read this branch
  // guarded resolved to null before it could touch DATA_API.
  // #9208, same hot/cold/decline routing as handleBlockExtrinsics above and for
  // the same reason -- and it matters more here, because a block CAN legitimately
  // emit zero account-scoped events, so an empty list is a plausible-looking lie.
  const answer = await answerBlockDetail(env, ref, {
    hot: (height) =>
      loadBlockEventsHotTier(env, ref, height, { limit, offset }),
    cold: () => loadBlockEventsColdTier(env, ref, { limit, offset }, network),
    isEmpty: isEmptyEventPayload,
  });
  if (answer?.kind === "gap") return chainDetailGapResponse(answer);
  const data =
    answer?.kind === "answer"
      ? answer.data
      : buildBlockEvents([], ref, null, { limit, offset });
  // CSV reuses the account-events EVENTS_CSV_COLUMNS — buildBlockEvents maps the
  // same formatAccountEvent row shape (#5746). Cold block → empty → header-only.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.events as unknown[],
      `block-${ref}-events`,
      "short",
      request,
      EVENTS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/events.json`,
        (data.events as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/extrinsics: the recent-extrinsic feed (newest first), served live
// from the `extrinsics` store tier (#1345 block explorer). ?limit clamp <=100,
// ?offset, and a conjunctive (AND-ed) filter set (#1846): ?block=<n>, ?signer=,
// ?call_module=, ?call_function=, ?success=true|false, ?block_start/?block_end
// (block range), ?from/?to (observed_at epoch-ms range). All optional; an inverted
// range simply matches nothing (never throws). Cold/absent store → schema-stable
// zero. Reuses the chain-events meta since the same first-party poller fills this
// tier. The per-row shape is bound, never interpolated.
// A 0x-prefixed 64-hex-char hash — the same shape as extrinsic_hash (#2063),
// reused here for call_hash (#4322). No `%`/`_` can appear in a valid match,
// so it's also safe to interpolate into a LIKE pattern below.

export async function handleExtrinsics(
  request: Request,
  env: Env,
  url: URL,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // The same cap the three chain-analytics feeds apply to `call_module`
  // (#10096). This route took the identical filter with no bound at all, so a
  // 150-character value was a 400 on /chain/calls and a 200 here.
  const page = resolvePage(url);
  const { limit, offset } = page;
  const query = routeQuery(url);
  const successRaw = (query.success as string | undefined) ?? null;
  const callHashRaw = (query.call_hash as string | undefined) ?? null;
  const callModule = (query.call_module as string | undefined) || undefined;
  // NOT a bound the contract publishes: `call_hash` is only selective within a
  // module, so the pair is required together. A cross-field rule has no JSON
  // Schema form, which is why this one guard survives where the per-parameter
  // ones did not.
  if (callHashRaw !== null && !callModule) {
    return analyticsQueryError({
      parameter: "call_module",
      message: "call_module is required when call_hash is provided.",
    });
  }
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const data =
    // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // call_hash has no column in the lakehouse table, so that filter cannot be
    // expressed there. Skipping the tier entirely when it is present is the
    // only honest option -- passing it through would silently ignore the
    // filter and return every extrinsic as though it matched.
    (callHashRaw === null
      ? await loadExtrinsicFeedColdTier(
          env,
          {
            limit,
            offset,
            // Every filter this route accepts is passed through -- a filter the
            // tier does not receive is a filter it silently ignores, which is
            // the one failure mode worse than declining. The tier validates
            // each one and declines the whole query on anything unsafe.
            cursor: page.cursor,
            signer: (query.signer as string | undefined) ?? null,
            module: callModule,
            callFunction: (query.call_function as string | undefined) ?? null,
            success: successRaw === null ? null : successRaw === "true",
            block: query.block ?? null,
            blockStart: query.block_start ?? null,
            blockEnd: query.block_end ?? null,
            from: query.from ?? null,
            to: query.to ?? null,
          },
          network,
        )
      : null) ?? buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(
        data.extrinsics as unknown as Array<Record<string, unknown>>,
      ),
      "extrinsics",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/extrinsics.json",
        (data.extrinsics as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/sudo (#4310/2.2): the root-origin call table. subtensor has no
// Council/Senate (confirmed live against finney, bittensor 10.5.0, 2026-07-08 —
// only the Sudo pallet exists from the generic-Substrate governance family), so
// this is the extrinsics feed hardcoded to call_module='Sudo' rather than a
// proposal-lifecycle route — same store tier + loader as handleExtrinsics, no
// signer/call_module query params (signer is always the current sudo key, see
// GET /api/v1/sudo/key; call_module is fixed).
export async function handleSudo(request: Request, env: Env, url: URL) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  const query = routeQuery(url);
  const successRaw = (query.success as string | undefined) ?? null;
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const data =
    // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // The category predicate is data-api's own pathname->module mapping
    // ("Sudo"), expressed against the lakehouse verbatim -- same feed, same
    // cursor, one fixed filter.
    (await loadExtrinsicFeedColdTier(env, {
      limit,
      offset,
      module: "Sudo",
      cursor: page.cursor,
      callFunction: (query.call_function as string | undefined) ?? null,
      success: successRaw === null ? null : successRaw === "true",
      block: query.block ?? null,
      blockStart: query.block_start ?? null,
      blockEnd: query.block_end ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    })) ?? buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(
        data.extrinsics as unknown as Array<Record<string, unknown>>,
      ),
      "sudo-calls",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/sudo.json",
        (data.extrinsics as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/governance/config-changes (#4310/2.3, re-scoped from the
// original Council/Senate framing — see #4310's audit): subtensor's own
// root-origin hyperparameter/network-config change pathway. Same shape as
// handleSudo, just call_module='AdminUtils' — most AdminUtils calls (77 of
// ~83) don't emit their own dedicated event, so the extrinsic + its decoded
// call_args is the reliable source, not chain_events.
export async function handleGovernanceConfigChanges(
  request: Request,
  env: Env,
  url: URL,
) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  const page = resolvePage(url);
  const { limit, offset } = page;
  const query = routeQuery(url);
  const successRaw = (query.success as string | undefined) ?? null;
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const data =
    // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    // The category predicate is data-api's own pathname->module mapping
    // ("AdminUtils"), expressed against the lakehouse verbatim -- same feed, same
    // cursor, one fixed filter.
    (await loadExtrinsicFeedColdTier(env, {
      limit,
      offset,
      module: "AdminUtils",
      cursor: page.cursor,
      callFunction: (query.call_function as string | undefined) ?? null,
      success: successRaw === null ? null : successRaw === "true",
      block: query.block ?? null,
      blockStart: query.block_start ?? null,
      blockEnd: query.block_end ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    })) ?? buildExtrinsicFeed([], { limit, offset, nextCursor: null });
  if (csvRequested(url, request)) {
    return csvResponse(
      extrinsicsToCsvRows(
        data.extrinsics as unknown as Array<Record<string, unknown>>,
      ),
      "governance-config-changes",
      "short",
      request,
      EXTRINSICS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/governance/config-changes.json",
        (data.extrinsics as unknown as Array<Record<string, unknown>>)[0]
          ?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// The three columns the /runtime page's table renders (Spec Version | Block |
// Observed), in that order, so the download matches what the reader sees.
const RUNTIME_VERSIONS_CSV_COLUMNS = [
  "spec_version",
  "block_number",
  "observed_at",
];

// GET /api/v1/runtime (#4316/3.1): the spec-version transition timeline — the
// earliest known block at each distinct spec_version, ascending by
// block_number. A single-row aggregate over the whole retained window, nothing
// to filter or paginate (?format=csv is the one accepted param, #6392).
//
// The coverage caveat in src/runtime-versions.ts is about the RETIRED D1 tier,
// where spec_version arrived via a never-back-filled nullable ALTER. The
// lakehouse tier this now reads (#9265) carries a reading on every block from
// genesis to head, so coverage_from_block/coverage_gaps describe a complete
// timeline rather than bounding a partial one.
export async function handleRuntime(request: Request, env: Env, url: URL) {
  const validationError = validateResponseFormat(url);
  if (validationError) return analyticsQueryError(validationError);
  // #4909 D1 retirement: blocks' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  const history =
    // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
    // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
    // on every request.
    // The same spec_version column, from the tier that actually has it
    // (#9265). Through the shared reader so MCP and GraphQL get the timeline
    // too rather than being wired one surface at a time.
    (await loadRuntimeVersionHistoryColdTier(
      env as unknown as Parameters<typeof loadRuntimeVersionHistoryColdTier>[0],
    )) ?? buildRuntimeVersionHistory([]);
  // #8702: the forward-looking half of the same question. `transitions` is
  // where the runtime has BEEN (first-party block observations); `current` is
  // where it IS and what is queued behind it (live chain reads + the captured
  // release feed). Extending this route rather than adding a parallel one keeps
  // one answer to "what runtime is the network on" — and the timeline is the
  // natural place a caller already looks. Null-safe and independently cached,
  // so a dead testnet RPC degrades `current.pending_upgrade` to "unknown"
  // without touching the historical timeline at all.
  const data = { ...history, current: await loadUpgradeRadar(env) };
  // CSV exports the row-shaped transition timeline -- the same three columns
  // the /runtime page's table renders (#6392). The rollup fields
  // (current_spec_version, coverage_from_block/at) describe the series rather
  // than belonging to any row, so they stay JSON-only, mirroring how
  // chain-signers/chain-fees export their leaderboard and keep their totals out
  // of the CSV. A cold store yields transitions: [] -> a header-only CSV.
  if (csvRequested(url, request)) {
    return csvResponse(
      data.transitions as unknown[],
      "runtime-versions",
      "short",
      request,
      RUNTIME_VERSIONS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/runtime.json",
        (data.transitions as unknown as Array<Record<string, unknown>>)[
          (data.transitions as unknown as Array<Record<string, unknown>>)
            .length - 1
        ]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/sudo/key (#4310/2.4, re-scoped from the original Senate/Council
// membership framing — see #4310's audit): the current Sudo::Key holder,
// queried live from finney RPC at request time. Sudo::Key changes extremely
// rarely, so a single fixed-key KV cache (1h TTL, same METAGRAPH_CONTROL
// binding as loadAccountBalance) means only the first request per hour ever
// reaches the live RPC — no per-request-controllable cache-busting parameter
// exists for this route (unlike /accounts/{ss58}/balance), so it doesn't need
// that route's rate limiter. hotkey is null on RPC failure or an unset sudo
// key (schema-stable, never throws).
export async function handleSudoKey(
  request: Request,
  env: Env,
  network?: ChainNetworkId,
) {
  const data = await loadSudoKey(env, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

export const EVM_ADDRESS_MAPPING_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// GET /api/v1/evm/address/{h160} (#6725/#6728): live H160 -> SS58 address
// mapping via the AddressMapping EVM precompile, queried from the finney RPC
// at request time. 1h KV cache via METAGRAPH_CONTROL (deterministic given
// h160, never changes). Returns 400 on invalid h160; 200 with ss58:null on
// RPC failure (schema-stable, consistent with handleAccountBalance below).
export async function handleEvmAddressMapping(
  request: Request,
  env: Env,
  h160: string,
  network?: ChainNetworkId,
) {
  if (!H160_PATTERN.test(h160)) {
    return errorResponse(
      "invalid_h160",
      "h160 must be a 20-byte 0x-prefixed hex address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(
        `evm-address-mapping:${resolveClientIp(request)}`,
        network,
      ),
    });
    if (!success) {
      return errorResponse(
        "evm_address_mapping_rate_limited",
        "Too many live address-mapping requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(EVM_ADDRESS_MAPPING_RATE_LIMIT.windowSeconds),
        },
      );
    }
  }

  const data = await loadAddressMapping(env, h160, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/network/parameters (#6343): live global Subtensor protocol/
// governance parameters (TaoWeight, StakeThreshold,
// PendingChildKeyCooldown) -- three parallel finney RPC reads, batched into
// one KV-cached response. Same shape as handleSudoKey just above (no path
// params, no dedicated rate limiter -- neither is a per-caller-scoped
// resource). Every field is independently null on RPC failure
// (schema-stable, never throws).
export async function handleNetworkParameters(
  request: Request,
  env: Env,
  network?: ChainNetworkId,
) {
  const data = await loadNetworkParameters(env, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/network/randomness (#6731): live drand randomness-beacon
// status -- LastStoredRound/OldestStoredRound -- a finney RPC read, KV-
// cached snapshot (not a history feed, pulses land ~3s apart). Same shape
// as handleNetworkParameters just above (no path params, no dedicated rate
// limiter). Every field is independently null on RPC failure
// (schema-stable, never throws).
export async function handleRandomnessStatus(
  request: Request,
  env: Env,
  network?: ChainNetworkId,
) {
  const data = await loadRandomnessStatus(env, network);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}

// GET /api/v1/extrinsics/{ref}: per-extrinsic detail (#1345/#1848). ref is EITHER
// a 0x extrinsic_hash OR the canonical composite id "<block_number>-<extrinsic_index>".
// The hash is best-effort/nullable in the decoder, so the composite id is the
// guaranteed-present identifier; the composite path does a direct (block_number,
// extrinsic_index) PK hit. Served live from the `extrinsics` store tier; an unknown
// ref / cold store / malformed composite → 200 with extrinsic:null (schema-stable,
// mirrors handleBlock's numeric-OR-hash branch — NEVER 404/throw).
//
// When the extrinsic resolves, the indexed account_events it emitted (#1849) are
// embedded via a second lookup on (block_number, extrinsic_index) — bounded to 50.
// Empty for pre-migration rows, non-ApplyExtrinsic events, or a cold store.
export async function handleExtrinsic(
  request: Request,
  env: Env,
  ref: string,
  /** Which chain's history to read (#8700). */
  network?: ChainNetworkId,
) {
  // #4909 D1 retirement: extrinsics' D1 write path is retired (#4772) and the
  // table is dropped in production, so a store query here would always miss.
  // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in wrangler.jsonc
  // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read this branch
  // guarded resolved to null before it could touch DATA_API.
  // #9208: the composite `<block>-<index>` form is a POSITION and follows the
  // seam, declining in the gap; the hash form asks hot-then-cold and keeps its
  // schema-stable `extrinsic: null`, because a hash absent from a few-thousand-
  // block window proves nothing. See answerExtrinsicDetail for the argument.
  const answer = await answerExtrinsicDetail(env, ref, () =>
    loadExtrinsicColdTier(env, ref, network),
  );
  if (answer?.kind === "gap") return chainDetailGapResponse(answer);
  const data =
    answer?.kind === "answer" ? answer.data : buildExtrinsic(undefined, ref);
  // #11001: name the immutability the tier already knows, the way handleBlock
  // above does. A COLD (lakehouse) answer is decoded and settled, so it cannot
  // change within a contract version and takes the `static` profile. Everything
  // else stays `short`: a HOT-window answer is still inside the live-follow
  // range and may yet move, and an unresolved hash keeps its schema-stable
  // `extrinsic: null` precisely because absence from that window proves nothing
  // — a client must re-check both. withChainDetailEdgeCache reads this profile
  // to decide what may be stored at the edge, so getting it wrong here would
  // cache a moving answer, not merely mis-advertise one.
  // ...and RESOLVED, not merely cold. `loadExtrinsicColdTier` returns the
  // schema-stable payload for a confirmed absence rather than null, so
  // `tier === "cold"` alone is true for "the lakehouse looked and this hash is
  // not there" — which is exactly the answer that must NOT be pinned for an
  // hour. A hash absent from the decoded range proves nothing (it may land, or
  // sit outside it), which is the same reason this route keeps its
  // `extrinsic: null` instead of 404ing. handleBlock draws the line in the same
  // place with `data.block ? "static" : "short"`.
  const cacheProfile =
    answer?.kind === "answer" && answer.tier === "cold" && data.extrinsic
      ? "static"
      : "short";
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/extrinsics/${ref}.json`,
        data.extrinsic?.observed_at ?? null,
      ),
    },
    cacheProfile,
  );
}

// #10447: one subnet's external revenue against the TAO the network emits to
// it, and the cross-subnet table.
//
// Composed rather than stored: the declarations come from the subnet's own
// surfaces (#10441), the denominator from the economics capture, the price from
// the tao-usd index, and the arithmetic from src/revenue-coverage.ts. The
// probe lane's observations (#10444) fill in `amount_usd` once it has run;
// until then every readable surface reports null, which is the honest state
// rather than a zero.
//
// NEVER 404s and never 500s on a subnet with no revenue data. 127 of 129 are in
// that state, so an error there would make the normal case look like a broken
// endpoint and a caller sweeping the network would see 127 failures instead of
// 127 answers.
// #10488: one subnet's declared wallets.
//
// NEVER 404s. Every subnet has an owner and almost none has a declared
// treasury, so "nothing attributed" is the normal answer and must not be served
// as an error -- a caller sweeping the network would see 128 failures instead
// of 128 answers.
//
// The flow rows are deliberately NOT loaded yet: the transfer index read is
// #10486's aggregation over a store this route does not own, and wiring it here
// before the registry has a single declared address would be plumbing with
// nothing to carry. Activity therefore reports empty legs, which is honest --
// the wallets and their evidence are the part that exists today.
export async function handleSubnetWallets(
  request: Request,
  env: Env,
  netuid: number,
) {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const { row } = await resolveSubnetEconomicsRow(env, netuid);
  const artifact = await readArtifact(env, ENTITY_LABELS_ARTIFACT);
  const entities = artifact.ok
    ? ((artifact.data as Record<string, unknown> | undefined)?.entities as
        Array<Record<string, unknown>> | undefined)
    : undefined;
  const wallets = subnetWalletRows(netuid, row, entities ?? null, null);
  // #10489-#10509: whether anyone has looked, and when. An empty wallet list on
  // its own says nothing about whether the subnet publishes an address -- it is
  // equally consistent with nobody having searched -- and an undated silence is
  // not evidence.
  const attributionSearch = await loadSweepRecord(
    readStore(env, ATTRIBUTION_SWEEP_TABLES) as SweepStoreDb | undefined,
    netuid,
  );
  return envelopeResponse(
    request,
    {
      data: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        netuid,
        window_days: ATTRIBUTION_WINDOW_DAYS,
        wallet_count: wallets.length,
        wallets,
        attribution_search: attributionSearch,
        field_sources: SUBNET_WALLETS_FIELD_SOURCES,
      },
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

// #10488: the accrual and what became of it.
//
// `flows_observed` is deliberately NOT set: the stake-move and transfer streams
// are not read here yet, so the disposition resolves the whole accrual to
// `unresolved` with a stated reason. That is the correct answer rather than a
// placeholder -- claiming `held-as-stake` from the absence of a read is exactly
// the false negative #10485 exists to prevent.
export async function handleSubnetOwnerCut(
  request: Request,
  env: Env,
  netuid: number,
  // Injected the same way /network/parameters' own siblings inject it, so the
  // share can be driven in a test without a KV binding or an RPC.
  deps: {
    loadParams?: typeof loadNetworkParameters;
    loadFlows?: typeof loadAccountStakeFlowColdTier;
  } = {},
) {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const { row } = await resolveSubnetEconomicsRow(env, netuid);
  // THE LIVE READ, NOT THE ARTIFACT. `/metagraph/network/parameters.json`
  // publishes no owner-cut field at all -- verified in production, where it
  // carries no key matching /owner/ -- so reading it here returned undefined
  // for all 129 subnets and every accrual served `owner cut share not read`.
  // That is the #10566 shape exactly: a correct-looking decline standing in
  // for a read that never happened. `/api/v1/network/parameters` computes the
  // effective share (0.17999...) and is KV-cached, so this costs a cache hit
  // rather than an RPC per request.
  const parameters = await (deps.loadParams ?? loadNetworkParameters)(env);
  const ownerCut = parameters?.subnet_owner_cut_effective;
  // #10930: THE FLOW STREAMS, FINALLY READ. The disposition classifier has been
  // complete since #10485 and was handed nothing, so every subnet answered
  // `unresolved` with a note saying the streams "were not read for this
  // window" -- accurate about the handler and wrong about what was possible.
  //
  // Reuses the stake-flow cold-tier read rather than adding a second one, and
  // takes its ALPHA leg: the buckets are alpha-denominated, and pricing the TAO
  // column into them would make the residual an artefact of the price rather
  // than a statement about the owner.
  //
  // ONE COLDKEY, the declared one. An owner operating several addresses is out
  // of scope and the payload says so rather than quietly under-reporting.
  const ownerColdkey =
    typeof row?.owner_coldkey === "string" && row.owner_coldkey
      ? row.owner_coldkey
      : null;
  const flows = ownerColdkey
    ? await (deps.loadFlows ?? loadAccountStakeFlowColdTier)(
        env,
        ownerColdkey,
        {
          // The SAME window as the accrual. A 30-day accrual against a 7-day flow
          // read is a reconciliation that cannot balance.
          window: OWNER_CUT_FLOW_WINDOW,
        },
      )
    : null;
  const legs = ownerCutFlowLegs(flows?.rows ?? null, netuid);
  const view = loadSubnetOwnerCut({
    netuid,
    window_days: ATTRIBUTION_WINDOW_DAYS,
    economics: row,
    owner_cut: typeof ownerCut === "number" ? ownerCut : null,
    usd_per_tao: await usdPerTaoOrNull(env),
    unstaked_alpha: legs.observed ? legs.unstaked_alpha : null,
    flows_observed: legs.observed,
  });
  return envelopeResponse(
    request,
    {
      data: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        ...view,
        field_sources: SUBNET_OWNER_CUT_FIELD_SOURCES,
      },
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

export async function handleSubnetRevenue(
  request: Request,
  env: Env,
  netuid: number,
  url: URL,
) {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535) {
    return errorResponse(
      "invalid_netuid",
      "netuid must be an integer in the u16 range 0..65535.",
      400,
    );
  }
  const { row } = await resolveSubnetEconomicsRow(env, netuid);
  // #10566: the observation series, so `amount_usd` is a real figure rather
  // than the null it was for as long as the probe lane had no producer. A read
  // failure comes back as null and degrades to "not observed" -- the same
  // output as an empty store, which is correct here: neither is a zero.
  const observations = await loadRevenueObservations(
    readStore(env, REVENUE_OBSERVATION_TABLES) as RevenueStoreDb | undefined,
    netuid,
  );
  // #10925: the window is a parameter now, not a constant. The DEFAULT is
  // still one day -- every caller quoting "the" coverage ratio today is
  // quoting a one-day one, and re-denominating them silently would be worse
  // than leaving the wider windows unreachable.
  const { days: windowDays } = resolveWindow(
    url,
    SUBNET_REVENUE_WINDOW_DAYS,
    DEFAULT_SUBNET_REVENUE_WINDOW,
  );
  const revenue = loadSubnetRevenue({
    netuid,
    window_days: windowDays,
    economics: row,
    surfaces: await subnetSurfacesFor(env, netuid),
    usd_per_tao: await usdPerTaoOrNull(env),
    observations: observations ?? null,
  });
  return envelopeResponse(
    request,
    {
      data: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        netuid,
        revenue,
        field_sources: SUBNET_REVENUE_FIELD_SOURCES,
      },
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

/** Every subnet's coverage in one response. Subnets with no observed revenue
 * are INCLUDED with null ratios rather than dropped: omitting them would make
 * the covered set look like the whole network. */
export async function handleChainRevenueCoverage(
  request: Request,
  env: Env,
  url: URL,
) {
  const { days: windowDays } = resolveWindow(
    url,
    SUBNET_REVENUE_WINDOW_DAYS,
    DEFAULT_SUBNET_REVENUE_WINDOW,
  );
  const blob = await resolveEconomicsBlob(env, async () => {
    const artifact = await readArtifact(env, "/metagraph/economics.json");
    return artifact.ok
      ? ((artifact.data as Record<string, unknown> | undefined) ?? null)
      : null;
  });
  const rows = Array.isArray(blob?.subnets)
    ? (blob.subnets as Array<Record<string, unknown>>)
    : [];
  const usd = await usdPerTaoOrNull(env);
  // ONE read for the whole network, not one per subnet: 129 round trips would
  // price this route out of existence, and the table is small enough that the
  // whole of it is cheaper than the first dozen queries.
  const allObservations = await loadRevenueObservations(
    readStore(env, REVENUE_OBSERVATION_TABLES) as RevenueStoreDb | undefined,
    null,
  );
  const subnets = [];
  for (const row of rows) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid)) continue;
    subnets.push(
      loadSubnetRevenue({
        netuid,
        window_days: windowDays,
        economics: row,
        surfaces: await subnetSurfacesFor(env, netuid),
        usd_per_tao: usd,
        observations: allObservations ?? null,
      }),
    );
  }
  return envelopeResponse(
    request,
    {
      data: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        window_days: windowDays,
        observed_count: subnets.filter((s) => s.revenue_usd !== null).length,
        subnet_count: subnets.length,
        subnets,
      },
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}

/** The subnet's surfaces from the published registry. Null on any read
 * failure, which loadSubnetRevenue reads as "no declarations". */
async function subnetSurfacesFor(
  env: Env,
  netuid: number,
): Promise<Array<Record<string, unknown>> | null> {
  const artifact = await readArtifact(env, `/metagraph/subnets/${netuid}.json`);
  if (!artifact.ok) return null;
  const data = artifact.data as Record<string, unknown> | undefined;
  const surfaces = data?.surfaces;
  return Array.isArray(surfaces)
    ? (surfaces as Array<Record<string, unknown>>)
    : null;
}

/**
 * Latest usable TAO/USD, or null when this moment is not priceable.
 *
 * READS THE INDEX, NOT AN ARTIFACT. This used to read
 * `/metagraph/network/tao-usd.json`, which is not published -- the artifact
 * 404s in R2 with `artifact_not_found`, so the price was null on EVERY request
 * and every USD leg of /revenue, /chain/revenue-coverage and /owner-cut went
 * with it. The identical #10566 shape: a decline standing in for a read that
 * could never have succeeded, indistinguishable from a genuine "no rate"
 * because null is the documented normal answer.
 *
 * `/api/v1/network/tao-usd` was healthy the whole time because it reads
 * `tao_usd_index` directly -- 1,433 of 1,433 points priced, ~1/minute since
 * 2026-08-02. Same store, same staleness rule as every other USD surface, so
 * this cannot drift from what /network/tao-usd reports.
 *
 * `taoUsdUsable` grades the reading rather than this function re-deriving the
 * bound: an unpriced reading (`insufficient_pools`), one past
 * TAO_USD_MAX_AGE_MS, and an empty table are three distinct outcomes that all
 * correctly converge on "no rate" -- and none of them is a rate of zero.
 */
async function usdPerTaoOrNull(env: Env): Promise<number | null> {
  return sharedUsdPerTaoOrNull(
    readStore(env, TAO_USD_TABLES) as never as unknown as Parameters<
      typeof sharedUsdPerTaoOrNull
    >[0],
  );
}
