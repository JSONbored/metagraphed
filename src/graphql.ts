import { loadSubnetWeightSettersColdTier } from "./subnet-weight-setters-loader.ts";
import { asJsonObject } from "../schemas-src/json-request.ts";

import { observationsReadDb } from "./observations-read-runner.ts";
import { loadSubnetWeightsColdTier } from "./subnet-weights-loader.ts";
import { loadSubnetEventCardColdTier } from "./subnet-event-card-loader.ts";
import { loadSubnetAlphaVolumeFromArtifact } from "./subnet-alpha-volume-artifact.ts";
import {
  CHAIN_PROMETHEUS_ROLLUP,
  CHAIN_SERVING_ROLLUP,
  CHAIN_STAKE_MOVES_ROLLUP,
  CHAIN_STAKE_TRANSFERS_ROLLUP,
  CHAIN_REGISTRATIONS_ROLLUP,
} from "./chain-event-rollup-cold-tier.ts";
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLArgument,
  type GraphQLObjectType,
  buildSchema,
  execute,
  getNamedType,
  getNullableType,
  isListType,
  parse,
  specifiedRules,
  validate,
} from "graphql";
// Extracted to keep the firehose hub off this module at startup (#10900);
// re-exported so every pre-existing importer keeps working.
export * from "./graphql-limits.ts";
import {
  assertNetuidArgument,
  assertOptionalNetuidArgument,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_QUERY_BYTES,
  GRAPHQL_SUBSCRIPTION_CONTEXT_KEY,
  maxComplexityRule,
  maxDepthRule,
} from "./graphql-limits.ts";
import { readArtifact, readHealthKv } from "../workers/storage.ts";
import { loadChainStakeFlowFromArtifact } from "./chain-stake-flow-artifact.ts";
import { loadChainStakeMovesFromArtifact } from "./chain-stake-moves-artifact.ts";
import { loadChainStakeTransfersFromArtifact } from "./chain-stake-transfers-artifact.ts";
import { loadChainSignersFromArtifact } from "./chain-signers-artifact.ts";
import { loadChainTransferPairsFromArtifact } from "./chain-transfer-pairs-artifact.ts";
import { loadChainTransfersFromArtifact } from "./chain-transfers-artifact.ts";
import { loadChainAlphaVolumeFromArtifact } from "./chain-alpha-volume-artifact.ts";
import { resolveMarketCapIndex } from "./market-cap-index.ts";
import { loadChainCallsFromArtifact } from "./chain-calls-artifact.ts";
import { loadChainFeesFromArtifact } from "./chain-fees-artifact.ts";
import { loadChainActivityFromArtifact } from "./chain-activity-artifact.ts";
import { loadExtrinsicFeedColdTier } from "./extrinsics-cold-tier.ts";
import {
  loadAccountCounterpartiesColdTier,
  loadAccountRegistrationsColdTier,
  loadAccountPrometheusColdTier,
  loadAccountServingColdTier,
  loadAccountStakeFlowColdTier,
  loadAccountStakeMovesColdTier,
  loadAccountTransfersColdTier,
  loadAccountWeightSettersColdTier,
  loadCounterpartyRelationshipColdTier,
} from "./account-feeds-cold-tier.ts";
import { loadAccountEventsColdTier } from "./events-cold-tier.ts";
import { loadAccountExtrinsicsColdTier } from "./extrinsics-cold-tier.ts";
import { loadExtrinsicColdTier } from "./extrinsics-cold-tier.ts";
import {
  loadBlockColdTier,
  loadBlockFeedColdTier,
} from "./blocks-cold-tier.ts";
import { loadBlockExtrinsicsColdTier } from "./extrinsics-cold-tier.ts";
import { loadBlockEventsColdTier } from "./events-cold-tier.ts";
import {
  answerBlockDetail,
  answerExtrinsicDetail,
  chainDetailGapMessage,
  isEmptyEventPayload,
  isEmptyExtrinsicPayload,
  loadBlockEventsHotTier,
  loadBlockExtrinsicsHotTier,
  type ChainDetailAnswer,
} from "./chain-detail-hot-tier.ts";
// #7881: the same list-query helper the REST pipeline and the list_* MCP
// loaders use, so subnet_health's filter/sort/page allowlists cannot drift
// from GET /api/v1/subnets/{netuid}/health.
import { applyQueryFilters } from "../workers/list-query.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
// #6986: GraphQL parity for source-snapshots, reusing list_source_snapshots'
// own loader unchanged (same artifact read, filter, sort, and page logic REST
// and MCP already use) -- not a reimplementation.
import { loadSourceSnapshotsList } from "./source-snapshots-mcp.ts";
// #7171: GraphQL parity for GET /api/v1/gaps and /api/v1/evidence, reusing
// list_gaps / list_evidence loaders unchanged (same artifact + list-query
// transforms REST and MCP already use) -- not a reimplementation.
import { loadGapsList } from "./gaps-mcp.ts";
import { loadEvidenceList } from "./evidence-mcp.ts";
// #7876: GraphQL parity for the search field's type/netuid/q/sort/order
// filters, reusing list_search's own loadSearchList loader unchanged (same
// baked /metagraph/search.json read + list-query transforms REST and MCP
// already apply) -- not a reimplementation.
import { loadSearchList } from "./search-mcp.ts";
// #7877: GraphQL parity for the search_index field's type/netuid/q/sort/order
// filters, reusing list_search_index's own loadSearchIndexList loader unchanged
// (same baked /metagraph/search-index.json read + list-query transforms REST
// and MCP already apply) -- not a reimplementation.
import { loadSearchIndexList } from "./search-index-mcp.ts";
// #7171: GraphQL parity for GET /api/v1/chain-events (paginated Query feed),
// reusing loadChainEventsFeed that MCP list_chain_events already calls.
// Distinct from Subscription.chainEvents (live WebSocket firehose).
// #7432: GraphQL parity for GET /api/v1/chain-events/stats (the aggregate
// sibling), reusing loadChainActivity + optionalBlocksWindow that MCP's
// get_chain_activity already calls — both relocated here from mcp-server.ts.
import {
  loadChainActivity,
  loadChainEventsFeed,
  optionalBlocksWindow,
} from "./data-api-mcp.ts";
// #6992: GraphQL parity for profiles, reusing list_profiles' own loader
// unchanged (same artifact read, filter, sort, and page logic REST and MCP
// already use) -- not a reimplementation.
import { loadProfilesList } from "./profiles-mcp.ts";
import { contractVersion } from "../workers/responses.ts";
import { tryDataApiTier } from "../workers/data-api-tier.ts";
import {
  buildSubnetValidatorEconomicsPayload,
  buildSubnetValidatorEconomicsHistoryPayload,
  buildValidatorEconomicsRankingPayload,
} from "../workers/request-handlers/entities.ts";
import { DEFAULT_VALIDATOR_ECONOMICS_HISTORY_WINDOW } from "./validator-economics.ts";
// #6985: GraphQL parity for the endpoint-pools/rpc-pools/endpoint-incidents REST
// routes, reusing the same shaping functions list_endpoint_pools/list_rpc_pools/
// list_endpoint_incidents already call for MCP parity -- not a reimplementation.
import { loadEndpointPoolsList } from "./endpoint-pools-mcp.ts";
import { loadRpcPoolsList } from "./rpc-pools-mcp.ts";
import { loadEndpointIncidentsList } from "./endpoint-incidents-mcp.ts";
// #7175: GraphQL parity for GET /api/v1/providers/{slug}/endpoints, reusing the
// same loadProviderEndpointsList that MCP list_provider_endpoints already calls
// (#3289) -- not a reimplementation.
import { loadProviderEndpointsList } from "./provider-endpoints-mcp.ts";
// #8548: the same loadSurfacesList that MCP list_surfaces + REST /surfaces call,
// so the root surfaces field's filter/sort/page set can never drift from theirs.
import { loadSurfacesList } from "./surfaces-mcp.ts";
// #7886: GraphQL parity for GET /api/v1/rpc/endpoints filters — reuse
// loadRpcEndpointsList (live overlay + applyQueryFilters on the endpoints
// collection), matching endpoint_pools / rpc_pools / provider_endpoints.
import { loadRpcEndpointsList } from "./rpc-endpoints-mcp.ts";
// #7888: GraphQL parity for GET /api/v1/providers list filters (id/kind/
// authority/sort/order + limit/cursor), reusing loadProvidersList that
// MCP list_providers already calls -- not a reimplementation. The loader's
// `fields` projection stays MCP-only: the tool declares it (#9701 narrowing),
// GraphQL stopped publishing it when the selection set became the projection
// (#10214), and the route never had it.
import { loadProvidersList } from "./providers-mcp.ts";
// #7167: GraphQL parity for the /api/v1/review/* contributor-review family,
// reusing each list_* MCP loader unchanged (same artifact read, filter, sort,
// and page logic REST and MCP already use) -- not a reimplementation.
import { loadAdapterCandidatesList } from "./adapter-candidates-mcp.ts";
// #7871: GraphQL parity for GET /api/v1/candidates' id/confidence/sort/order
// filters, reusing loadCandidatesList that MCP list_candidates already calls --
// not a reimplementation.
import { loadCandidatesList } from "./candidates-mcp.ts";
import { loadEnrichmentEvidenceList } from "./enrichment-evidence-mcp.ts";
import { loadEnrichmentQueueList } from "./enrichment-queue-mcp.ts";
import { loadReviewEnrichmentTargetsList } from "./review-enrichment-targets-mcp.ts";
// #7878: GraphQL parity for GET /api/v1/subnets/{netuid}/candidates, reusing
// loadSubnetCandidatesList that MCP list_subnet_candidates already calls
// (#7899) -- not a reimplementation.
import { loadSubnetCandidatesList } from "./subnet-candidates-mcp.ts";
// #7869: GraphQL parity for GET /api/v1/subnets/{netuid}/endpoints, reusing
// loadSubnetEndpointsList that MCP list_subnet_endpoints already calls -- not
// a reimplementation.
import { loadSubnetEndpointsList } from "./subnet-endpoints-mcp.ts";
// #7879: GraphQL parity for GET /api/v1/subnets/{netuid}/evidence, reusing
// loadSubnetEvidenceList that MCP list_subnet_evidence already calls -- not a
// reimplementation.
import { loadSubnetEvidenceList } from "./subnet-evidence-mcp.ts";
import { loadReviewGapsList } from "./review-gaps-mcp.ts";
import { loadProfileCompletenessList } from "./profile-completeness-mcp.ts";
// #6984: GraphQL parity for GET /api/v1/adapters/{slug}, reusing loadAdapter that
// MCP get_adapter already calls (#3255) -- not a reimplementation.
import { loadAdapter } from "./adapters-mcp.ts";
// #7867: GraphQL parity for GET /api/v1/fixtures/{surface_id}, reusing
// loadFixture (same surface_id validation + alias resolve + artifact read
// get_fixture already performs).
import { loadFixture } from "./fixtures-mcp.ts";
// #7170: GraphQL parity for the changelog/contracts/health-history REST routes,
// reusing the same loaders MCP get_changelog/get_contracts/get_health_history
// already call -- not a reimplementation.
import { loadChangelog } from "./changelog-mcp.ts";
import { loadContracts } from "./contracts-mcp.ts";
// #7431: GraphQL parity for GET /api/v1/build, reusing loadBuildSummary that
// MCP get_build already calls -- not a reimplementation.
import { loadBuildSummary } from "./build-mcp.ts";
// #8422: GraphQL parity for GET /api/v1/self-health, reusing loadSelfHealth
// that MCP get_self_health already calls -- not a reimplementation.
import { loadSelfHealth } from "./self-health-mcp.ts";
import { loadHealthHistory } from "./health-history-mcp.ts";
import {
  buildChainAxonRemovals,
  CHAIN_AXON_REMOVALS_WINDOWS,
  DEFAULT_CHAIN_AXON_REMOVALS_WINDOW,
  CHAIN_AXON_REMOVALS_LIMIT_DEFAULT,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
} from "./chain-axon-removals.ts";
import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_DEREGISTRATIONS_WINDOW,
  CHAIN_DEREGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_DEREGISTRATIONS_LIMIT_MAX,
} from "./chain-deregistrations.ts";
import {
  buildChainRegistrations,
  CHAIN_REGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_REGISTRATIONS_LIMIT_MAX,
} from "./chain-registrations.ts";
import {
  buildChainPrometheus,
  CHAIN_PROMETHEUS_WINDOWS,
  DEFAULT_CHAIN_PROMETHEUS_WINDOW,
  CHAIN_PROMETHEUS_LIMIT_DEFAULT,
  CHAIN_PROMETHEUS_LIMIT_MAX,
} from "./chain-prometheus.ts";
import { buildSubnetHyperparams } from "./subnet-hyperparams.ts";
import { buildSubnetHyperparamsHistory } from "./subnet-hyperparams-history.ts";
import {
  buildChainSubnetLifecycle,
  buildSubnetLifecycle,
  CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX,
  DEFAULT_SUBNET_LIFECYCLE_WINDOW,
  loadChainSubnetLifecycle,
  loadSubnetLifecycle,
} from "./subnet-lifecycle-read.ts";
import {
  buildSubnetRegistrations,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "./subnet-registrations.ts";
import {
  buildSubnetDeregistrations,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "./subnet-deregistrations.ts";
import {
  buildSubnetServing,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "./subnet-serving.ts";
import {
  buildSubnetAxonRemovals,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "./subnet-axon-removals.ts";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "./subnet-weights.ts";
import {
  buildSubnetStakeMoves,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "./subnet-stake-moves.ts";
import {
  buildSubnetStakeTransfers,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "./subnet-stake-transfers.ts";
import {
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
  SUBNET_WEIGHT_SETTERS_LIMIT,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  buildSubnetWeightSetters,
} from "./subnet-weight-setters.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  YIELD_HISTORY_WINDOWS,
  DEFAULT_YIELD_HISTORY_WINDOW,
} from "./subnet-yield.ts";
import {
  buildSubnetEmissionSplitHistory,
  emissionSplitWindowLabel,
} from "./emission-split.ts";
import {
  buildSubnetOwnerCapture,
  ownerCaptureWindowLabel,
} from "./owner-capture.ts";
import { buildSubnetTreasury } from "./treasury-readings.ts";
import {
  buildSubnetCostToParticipate,
  entryCostFrom,
} from "./cost-to-participate.ts";
import {
  buildSubnetMinerFairness,
  minerFairnessWindowLabel,
} from "./miner-fairness.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  PERFORMANCE_HISTORY_WINDOWS,
  DEFAULT_PERFORMANCE_HISTORY_WINDOW,
} from "./subnet-performance.ts";
import {
  buildConcentration,
  buildConcentrationHistory,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
} from "./concentration.ts";
import { loadGlobalIncidentsLedger } from "../workers/request-handlers/analytics.ts";
import {
  parseRouteArgs,
  resolveRouteArgs,
  validateRouteArgs,
} from "./route-query.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "./route-limits.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.ts";
import {
  buildGlobalHealth,
  formatLeaderboards,
  mergeFreshness,
  overlayOverviewHealth,
  loadSubnetReliability,
  overlayCatalogDetail,
  overlayCatalogIndex,
  emptySubnetHealthSummary,
  overlaySubnetHealth,
  overlayArtifactEndpoints,
  resolveLiveEconomics,
  resolveLiveHealth,
  subnetBadgeStatus,
  withSpotPricedEconomics,
} from "./health-serving.ts";
import { loadSubnetProfile } from "./profiles-mcp.ts";
import {
  buildTopHoldersList,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "./top-holders.ts";
import {
  buildSubnetHolders,
  loadSubnetHolders,
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
} from "./subnet-holders.ts";
import {
  buildChainHolders,
  loadChainHolders,
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
  DEFAULT_CHAIN_HOLDERS_SORT,
} from "./chain-holders.ts";
import { buildIndexerLag, loadIndexerLag } from "./indexer-lag.ts";
import {
  buildChainConcentrationHistory,
  declineChainConcentrationHistory,
  loadChainConcentrationHistory,
} from "./chain-concentration-history.ts";
import { DEFAULT_CHAIN_CONCENTRATION_HISTORY_WINDOW } from "./route-limits.ts";
import {
  buildPipelineHistory,
  declinePipelineHistory,
  loadPipelineHistory,
} from "./emission-pipeline-history.ts";
import { DEFAULT_PIPELINE_HISTORY_WINDOW } from "./route-limits.ts";
import {
  buildEmissionChanges,
  loadEmissionChanges,
  EMISSION_CHANGES_LIMIT_DEFAULT,
  EMISSION_CHANGES_LIMIT_MAX,
} from "./emission-gate-changes.ts";
import {
  buildFailureReasons,
  declineFailureReasons,
  loadFailureReasons,
} from "./failure-reasons.ts";
import {
  DEFAULT_FAILURE_REASONS_WINDOW,
  EMISSION_PIPELINE_LIMIT_MAX,
} from "./route-limits.ts";
import {
  buildTaoUsdSeries,
  loadTaoUsdSeries,
  DEFAULT_TAO_USD_WINDOW,
  TAO_USD_WINDOWS,
} from "./tao-usd-series.ts";
import {
  NOMINATOR_BASES,
  DEFAULT_NOMINATOR_BASIS,
  loadNominatorPositions,
  buildNominatorPositions,
} from "./validator-nominator-positions.ts";
import {
  buildSurfaceHistory,
  loadSurfaceHistory,
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
} from "./surface-history.ts";
import { loadTopHoldersFlowTier } from "./top-holders-flow-tier.ts";
import { composeLeaderboardsData } from "../workers/request-handlers/analytics-routes.ts";
import {
  COMPARE_VALIDATORS_MAX,
  loadCompareSubnets,
  loadSubnetHealthTrends,
  parseCompareHotkeyList,
  loadSubnetPercentiles,
  loadSubnetUptime,
  loadSubnetIncidents,
  parseCompareDimensionList,
  parseCompareNetuidList,
  parseUptimeWindow,
} from "./analytics-live.ts";
import {
  buildAccountExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
  buildBlockExtrinsics,
} from "./extrinsics.ts";
import { buildBlock, buildBlockFeed } from "./blocks.ts";
import { loadBlockChainEvents } from "./data-api-mcp.ts";
import { buildBlocksSummary } from "./blocks-summary.ts";
import { loadBlocksSummaryFromArtifact } from "./blocks-summary-artifact.ts";
import { buildRuntimeVersionHistory } from "./runtime-versions.ts";
import { loadUpgradeRadar } from "./upgrade-radar.ts";
import { loadSubnetEventSummaryColdTier } from "./subnet-event-summary-cold-tier.ts";
import { loadRuntimeVersionHistoryColdTier } from "./runtime-versions-cold-tier.ts";
import { buildChainYield } from "./chain-yield.ts";
import { loadSubnetRecycled, isU16Netuid } from "./subnet-recycled.ts";
import { loadSubnetBurn } from "./subnet-burn.ts";
import { loadChainBurn } from "./chain-burn.ts";
import {
  BURN_HISTORY_WINDOWS,
  DEFAULT_BURN_HISTORY_WINDOW,
  buildSubnetBurnHistory,
  loadSubnetBurnHistory,
} from "./subnet-burn-history.ts";
import {
  DEFAULT_CHAIN_NETWORK,
  chainNetworkFromChainName,
  networkScopedRoute,
  type ChainNetworkId,
} from "./chain-network.ts";
import { loadSubnetLease } from "./subnet-lease.ts";
import { loadAccountBalance, isFinneySs58Address } from "./account-balance.ts";
import { loadAccountRootClaim } from "./account-root-claim.ts";
// #6976: GraphQL parity for the children/parents/weight-setters/entities account
// relationship routes, reusing the same loaders/builders REST + MCP already call.
import {
  loadAccountChildren,
  loadAccountParents,
} from "./child-hotkey-delegation.ts";
import {
  buildAccountWeightSetters,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "./account-weight-setters.ts";
import {
  ENTITY_LABELS_ARTIFACT,
  entityLabelsIndex,
  labelsForSs58,
} from "./entity-labels.ts";
import { loadSudoKey } from "./sudo-key.ts";
// #7642: saved_query reuses the same maintainer-curated template executor the
// GET /api/v1/queries/{id} route and run_saved_query MCP tool already share.
import { runSavedQuery } from "./saved-queries.ts";
import { loadNetworkParameters } from "./network-parameters.ts";
import { loadRandomnessStatus } from "./randomness.ts";
import { loadAddressMapping, H160_PATTERN } from "./address-mapping.ts";
import {
  NO_ALPHA_PRICES,
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  GLOBAL_VALIDATOR_SORTS,
  buildGlobalValidators,
  buildNeuronDetail,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildValidatorDetail,
  composeValidatorComparison,
  overlayFeaturedValidators,
} from "./metagraph-neurons.ts";
import { buildAlphaVolume } from "./alpha-volume.ts";
import { AGENT_RESOURCES_ARTIFACT } from "./agent-resources-mcp.ts";
// #8550: the same loadCurationList that MCP list_curation + REST /curation call,
// so the curation field's filter/sort/page set can never drift from theirs.
import { loadCurationList } from "./curation-mcp.ts";
import { buildDomainOverview, buildDomainSummary } from "./domain-summary.ts";
import { DOMAIN_TAGS } from "./domain-tags.ts";
import {
  OHLC_INTERVALS,
  OHLC_INTERVAL_DEFAULT,
  DEFAULT_OHLC_WINDOW_DAYS,
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
} from "./subnet-ohlc.ts";
import { answerSubnetOhlc } from "./subnet-ohlc-answer.ts";
import { answerSubnetEvents } from "./subnet-events-answer.ts";
import {
  answerChainIdentityHistory,
  answerSubnetIdentityHistory,
} from "./identity-history-answer.ts";
import { answerAccountEntities } from "./account-entities-answer.ts";
import { loadValidatorNominatorsColdTier } from "./account-feeds-cold-tier.ts";
import { loadAccountPositionsColdTier } from "./nominator-positions-cold-tier.ts";
import { loadAccountPositionsFromStore } from "./nominator-positions-hot-tier.ts";
import {
  coldTierChainEventsPayload,
  markedChainEventsPayloadOrThrow,
} from "./chain-events-degraded.ts";
import { subnetOwnershipHistoryNode } from "./subnet-ownership-answer.ts";
import { SUBNET_CONVICTION_FIELD_SOURCES } from "./subnet-conviction.ts";
import { buildSubnetLeaseHistory } from "./subnet-lease-history.ts";
import { computeStakeQuote, STAKE_QUOTE_DIRECTIONS } from "./stake-quote.ts";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  DEFAULT_ACCOUNTS_LIST_SORT,
  buildAccountsList,
} from "./accounts-list.ts";
import {
  buildAccountEvents,
  buildAccountSubnets,
  buildAccountSummary,
  buildAccountTransfers,
  buildSubnetEventSummary,
  loadAccountHistory,
  DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW,
  SUBNET_EVENT_SUMMARY_WINDOWS,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  buildBlockEvents,
} from "./account-events.ts";
import {
  DEFAULT_PROMETHEUS_WINDOW,
  buildAccountPrometheus,
} from "./account-prometheus.ts";
import {
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_FLOW_WINDOWS,
  buildAccountStakeFlow,
} from "./account-stake-flow.ts";
import { buildAccountPositionHistory } from "./account-position-history.ts";
import { DEFAULT_STAKE_FLOW_DIRECTION, buildStakeFlow } from "./stake-flow.ts";
import { loadChainRegistrationsFromArtifact } from "./chain-registrations-artifact.ts";
import {
  loadAccountDeregistrationsFromArtifact,
  loadChainDeregistrationsFromArtifact,
  loadSubnetDeregistrationsFromArtifact,
  markDeregistrationsNotDerived,
} from "./chain-deregistrations-artifact.ts";
import { loadSubnetStakeFlowFromArtifact } from "./subnet-stake-flow-artifact.ts";
import { buildAccountPortfolio } from "./account-portfolio.ts";
import { unavailableAccountPositions } from "./account-nominator-positions.ts";
import {
  buildAccountRegistrations,
  DEFAULT_REGISTRATION_WINDOW,
} from "./account-registrations.ts";
import {
  buildAccountDeregistrations,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "./account-deregistrations.ts";
import {
  buildAccountServing,
  DEFAULT_SERVING_WINDOW,
} from "./account-serving.ts";
import {
  buildAccountAxonRemovals,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "./account-axon-removals.ts";
import {
  buildAccountStakeMoves,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "./account-stake-moves.ts";
import { buildAccountIdentity } from "./account-identity.ts";
import { buildAccountIdentityHistory } from "./account-identity-history.ts";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
} from "./counterparties.ts";
import { KV_HEALTH_META } from "./kv-keys.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
} from "../workers/config.ts";
import { answerRpcUsage } from "./rpc-usage-answer.ts";
import { loadChainServingColdTier } from "./chain-serving-loader.ts";
import { loadChainServingFromArtifact } from "./chain-serving-artifact.ts";
import { loadChainPrometheusColdTier } from "./chain-prometheus-loader.ts";
import { loadChainPrometheusFromArtifact } from "./chain-prometheus-artifact.ts";
import {
  accountSummaryGapMessage,
  answerAccountSummary,
  ACCOUNT_SUMMARY_GAP_CODE,
} from "./account-summary-card.ts";
import { loadChainWeightsColdTier } from "./chain-weights-loader.ts";
import { loadChainWeightsFromArtifact } from "./chain-weights-artifact.ts";
import { loadChainWeightSettersColdTier } from "./chain-weight-setters-loader.ts";
import { loadChainWeightSettersFromArtifact } from "./chain-weight-setters-artifact.ts";
import {
  CHAIN_SIGNERS_SORTS,
  CHAIN_SIGNERS_LIMIT_DEFAULT,
  CHAIN_SIGNERS_LIMIT_MAX,
} from "./chain-query-loaders.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  parseHistoryWindow,
  unsupportedWindowMessage,
} from "./neuron-history.ts";
import {
  overlayAccountPositionHistoryColdTier,
  overlayNeuronHistoryColdTier,
  overlaySubnetHistoryColdTier,
  overlayValidatorHistoryColdTier,
} from "./neuron-daily-cold-tier.ts";
import { buildValidatorHistory } from "./validator-history.ts";
import { loadEconomicsTrends } from "./economics-trends.ts";
import { loadSubnetTrajectory } from "./analytics-live.ts";
import {
  EMISSION_PIPELINE_UNAVAILABLE_CODE,
  EMISSION_PIPELINE_UNAVAILABLE_MESSAGE,
  projectEmissionPipeline,
  parseEmissionPipelineNarrowing,
  narrowEmissionPipeline,
} from "./emission-pipeline-surface.ts";
import {
  DEFAULT_MOVERS_SORT,
  DEFAULT_MOVERS_WINDOW,
  buildMovers,
} from "./movers.ts";
import {
  CHAIN_WEIGHTS_LIMIT_DEFAULT,
  CHAIN_WEIGHTS_LIMIT_MAX,
  CHAIN_WEIGHTS_WINDOWS,
  DEFAULT_CHAIN_WEIGHTS_WINDOW,
  buildChainWeights,
} from "./chain-weights.ts";
import {
  CHAIN_SERVING_LIMIT_DEFAULT,
  CHAIN_SERVING_LIMIT_MAX,
  CHAIN_SERVING_WINDOWS,
  DEFAULT_CHAIN_SERVING_WINDOW,
  buildChainServing,
} from "./chain-serving.ts";
import {
  buildChainTurnover,
  CHAIN_TURNOVER_LIMIT_DEFAULT,
  CHAIN_TURNOVER_LIMIT_MAX,
  CHAIN_TURNOVER_WINDOWS,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
} from "./chain-turnover.ts";
import { buildTurnover } from "./turnover.ts";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainFees,
  buildChainSigners,
  trimChainActivityToWindow,
  trimChainFeesToWindow,
} from "./chain-analytics.ts";
import { buildChainPerformance } from "./chain-performance.ts";
import { buildChainConcentration } from "./concentration.ts";
// #8423: reuse list_subnets' own network-scoping + categorical/range/sort
// helpers directly rather than reimplementing them here. mcp-server.ts already
// imports handleGraphQLRequest from this file, so this reverse import closes a
// cycle -- safe because every binding on both sides is referenced only at
// call time (resolver / request handler), never during module evaluation.
import {
  categoricalFilterSubnets,
  networkArtifactPath,
  rangeFilterSubnets,
  sortSubnets,
} from "./mcp-server.ts";
import {
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  buildValidatorNominators,
} from "./validator-nominators.ts";
import {
  CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
  CHAIN_ALPHA_VOLUME_LIMIT_MAX,
  buildChainAlphaVolume,
} from "./chain-alpha-volume.ts";
import {
  buildChainWeightSetters,
  CHAIN_WEIGHT_SETTERS_LIMIT_DEFAULT,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
  CHAIN_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW,
} from "./chain-weight-setters.ts";
import {
  buildChainIdleStake,
  buildSubnetIdleStake,
} from "./subnet-idle-stake.ts";
import {
  buildSubnetPrometheus,
  SUBNET_PROMETHEUS_WINDOWS,
  DEFAULT_SUBNET_PROMETHEUS_WINDOW,
} from "./subnet-prometheus.ts";
import {
  buildChainStakeFlow,
  CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
  CHAIN_STAKE_FLOW_LIMIT_MAX,
  CHAIN_STAKE_FLOW_WINDOWS,
  DEFAULT_CHAIN_STAKE_FLOW_WINDOW,
} from "./chain-stake-flow.ts";
import {
  buildChainStakeMoves,
  CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
  CHAIN_STAKE_MOVES_LIMIT_MAX,
  CHAIN_STAKE_MOVES_WINDOWS,
  DEFAULT_CHAIN_STAKE_MOVES_WINDOW,
} from "./chain-stake-moves.ts";
import {
  buildChainStakeTransfers,
  CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
  CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
  CHAIN_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_CHAIN_STAKE_TRANSFERS_WINDOW,
} from "./chain-stake-transfers.ts";
import {
  buildChainTransfers,
  CHAIN_TRANSFER_LIMIT_DEFAULT,
  CHAIN_TRANSFER_LIMIT_MAX,
  CHAIN_TRANSFER_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_WINDOW,
} from "./chain-transfers.ts";
import {
  buildChainTransferPairs,
  CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
  CHAIN_TRANSFER_PAIR_SORTS,
  DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
} from "./chain-transfer-pairs.ts";
import { loadBulkHealthTrends } from "./bulk-health-trends.ts";
import { SDL } from "../generated/graphql/schema.ts";
// Types only -- erased at build, so naming the Durable Object's contract here
// costs the bundle nothing (#10782).
import type { EconomicsArtifact } from "../schemas-src/routes/economics.ts";
import type { SubnetRevenueView } from "./revenue-serving.ts";
import type {
  ChainFirehoseHub,
  GraphqlWsConnectionInfo,
} from "../workers/chain-firehose-hub.ts";
// types-epic D pilot adoption (#7862): the generated arg types for the 5
// Query fields with a Zod-covered REST mirror from types-epic A (#7859).
// NOT the generated `QueryResolvers['field']` Resolver function type itself
// -- that assumes graphql-codegen's apollo-style 4-arg
// (parent, args, context, info) resolver-map convention, but this file's
// rootValue is graphql-js's OWN default-field-resolver convention: a plain
// object whose function-valued properties are called as (args, context,
// info) with no leading parent. The two are incompatible calling
// conventions, not just an arity difference (args and context would bind to
// the wrong parameter positions) -- so only the real Args types are adopted
// here, not the Resolver wrapper. Same class of codegen/runtime-convention
// mismatch the epic already anticipated for the Subscription resolver.
import type {
  QueryAccountArgs,
  QueryAccountsArgs,
  QueryAccount_BalanceArgs,
  QueryAccount_Axon_RemovalsArgs,
  QueryAccount_ChildrenArgs,
  QueryAccount_CounterpartiesArgs,
  QueryAccount_DeregistrationsArgs,
  QueryAccount_EntitiesArgs,
  QueryAccount_EventsArgs,
  QueryAccount_ExtrinsicsArgs,
  QueryAccount_HistoryArgs,
  QueryAccount_IdentityArgs,
  QueryAccount_Identity_HistoryArgs,
  QueryAccount_ParentsArgs,
  QueryAccount_PortfolioArgs,
  QueryAccount_Position_HistoryArgs,
  QueryAccount_PositionsArgs,
  QueryAccount_PrometheusArgs,
  QueryAccount_RegistrationsArgs,
  QueryAccount_Root_ClaimArgs,
  QueryAccount_ServingArgs,
  QueryAccount_Stake_FlowArgs,
  QueryAccount_Stake_MovesArgs,
  QueryAccount_SubnetsArgs,
  QueryAccount_TransfersArgs,
  QueryAccount_Weight_SettersArgs,
  QueryAdapterArgs,
  QueryAgent_CatalogArgs,
  QueryBlockArgs,
  QueryBlocksArgs,
  QueryCoverageArgs,
  QueryBlocks_SummaryArgs,
  QueryBlock_Chain_EventsArgs,
  QueryBlock_EventsArgs,
  QueryBlock_ExtrinsicsArgs,
  QueryCandidatesArgs,
  QueryChain_ActivityArgs,
  QueryChain_Alpha_VolumeArgs,
  QueryChain_Axon_RemovalsArgs,
  QueryChain_CallsArgs,
  QueryChain_DeregistrationsArgs,
  QueryChain_EventsArgs,
  QueryChain_Events_StatsArgs,
  QueryChain_FeesArgs,
  QueryChain_Identity_HistoryArgs,
  QueryChain_PrometheusArgs,
  QueryChain_RegistrationsArgs,
  QueryChain_ServingArgs,
  QueryChain_SignersArgs,
  QueryChain_Stake_FlowArgs,
  QueryChain_Stake_MovesArgs,
  QueryChain_Stake_TransfersArgs,
  QueryChain_Transfer_PairsArgs,
  QueryChain_TransfersArgs,
  QueryChain_BurnArgs,
  QuerySubnet_Burn_HistoryArgs,
  QueryChain_TurnoverArgs,
  QueryChain_Weight_SettersArgs,
  QueryChain_WeightsArgs,
  QueryCompareArgs,
  QueryCompare_ValidatorsArgs,
  QueryCurationArgs,
  QueryDomain_SummaryArgs,
  QueryEconomicsArgs,
  QueryEconomics_TrendsArgs,
  QueryEmission_PipelineArgs,
  QueryEndpoint_IncidentsArgs,
  QueryEndpoint_PoolsArgs,
  QueryEndpointsArgs,
  QueryEvidenceArgs,
  QueryEvm_AddressArgs,
  QueryEvm_Address_MappingArgs,
  QueryExtrinsicArgs,
  QueryExtrinsicsArgs,
  QueryFixtureArgs,
  QueryGapsArgs,
  QueryGlobal_IncidentsArgs,
  QueryGovernance_Config_ChangesArgs,
  QueryHealth_HistoryArgs,
  QueryIncidentsArgs,
  QueryNeuronArgs,
  QueryNeuron_HistoryArgs,
  QueryOpportunity_BoardsArgs,
  QueryProfilesArgs,
  QueryProviderArgs,
  QueryProvider_EndpointsArgs,
  QueryProvidersArgs,
  QueryReview_Adapter_CandidatesArgs,
  QueryReview_Enrichment_EvidenceArgs,
  QueryReview_Enrichment_QueueArgs,
  QueryReview_Enrichment_TargetsArgs,
  QueryReview_GapsArgs,
  QueryReview_Profile_CompletenessArgs,
  QueryRegistry_LeaderboardsArgs,
  QueryRpc_EndpointsArgs,
  QueryRpc_PoolsArgs,
  QueryRpc_UsageArgs,
  QuerySaved_QueryArgs,
  QuerySearchArgs,
  QuerySearch_IndexArgs,
  QuerySource_SnapshotsArgs,
  QuerySubnetArgs,
  QuerySudoArgs,
  QuerySudo_KeyArgs,
  QueryNetwork_ParametersArgs,
  QueryNetwork_RandomnessArgs,
  QueryRandomness_StatusArgs,
  QuerySubnet_Axon_RemovalsArgs,
  QuerySubnet_BurnArgs,
  QuerySubnet_CandidatesArgs,
  QuerySubnet_ConcentrationArgs,
  QuerySubnet_Concentration_HistoryArgs,
  QuerySubnet_ConvictionArgs,
  QuerySubnet_DeregistrationsArgs,
  QuerySubnet_EndpointsArgs,
  QuerySubnet_Event_SummaryArgs,
  QuerySubnet_EventsArgs,
  QueryTao_UsdArgs,
  QueryCoverage_DepthArgs,
  QueryHealth_TrendsArgs,
  QuerySubnet_EvidenceArgs,
  QuerySubnet_GapsArgs,
  QuerySubnet_HealthArgs,
  QuerySubnet_Health_IncidentsArgs,
  QuerySubnet_Health_PercentilesArgs,
  QuerySubnet_Health_TrendsArgs,
  QuerySubnet_HistoryArgs,
  QuerySubnet_HyperparametersArgs,
  QueryChain_Subnet_LifecycleArgs,
  QuerySubnet_LifecycleArgs,
  QuerySubnet_Hyperparameters_HistoryArgs,
  QuerySubnet_Identity_HistoryArgs,
  QuerySubnet_Idle_StakeArgs,
  QuerySubnet_LeaseArgs,
  QuerySubnet_Lease_HistoryArgs,
  QuerySubnet_MetagraphArgs,
  QuerySubnet_MoversArgs,
  QuerySubnet_OhlcArgs,
  QuerySubnet_Ownership_HistoryArgs,
  QuerySubnet_OverviewArgs,
  QuerySubnet_PerformanceArgs,
  QuerySubnet_Performance_HistoryArgs,
  QuerySubnet_ProfileArgs,
  QuerySubnet_PrometheusArgs,
  QuerySubnet_RecycledArgs,
  QuerySubnet_RegistrationsArgs,
  QuerySubnet_ServingArgs,
  QuerySubnet_Stake_FlowArgs,
  QuerySubnet_Stake_MovesArgs,
  QuerySubnet_Stake_QuoteArgs,
  QuerySubnet_Stake_TransfersArgs,
  QuerySubnet_TrajectoryArgs,
  QuerySubnet_TurnoverArgs,
  QuerySubnet_UptimeArgs,
  QuerySubnet_ValidatorsArgs,
  QuerySubnet_VolumeArgs,
  QuerySubnet_Weight_SettersArgs,
  QuerySubnet_WeightsArgs,
  QuerySubnet_YieldArgs,
  QuerySubnet_Emission_Split_HistoryArgs,
  QuerySubnet_Owner_CaptureArgs,
  QuerySubnet_TreasuryArgs,
  QuerySubnet_Cost_To_ParticipateArgs,
  QuerySubnet_Miner_FairnessArgs,
  QuerySubnet_Yield_HistoryArgs,
  QuerySubnetsArgs,
  QuerySurfacesArgs,
  QueryTop_HoldersArgs,
  QueryValidatorArgs,
  QueryValidatorsArgs,
  QueryValidator_HistoryArgs,
  QueryValidator_NominatorsArgs,
} from "../generated/graphql/types.ts";
import { readStore } from "./read-store.ts";
import {
  ALL_SURFACES_ARTIFACT,
  SUBNET_REVENUE_FIELD_SOURCES,
  loadSubnetRevenue,
  revenueWindowDays,
  surfacesByNetuidMemoized,
} from "./revenue-load.ts";
import { loadRevenueObservations } from "./revenue-observations.ts";
import { REVENUE_OBSERVATION_TABLES } from "./read-store-tables.ts";
import {
  ALPHA_PRICING_TABLES,
  CHAIN_CONCENTRATION_HISTORY_TABLES,
  EMISSION_CHANGES_TABLES,
  FAILURE_REASONS_TABLES,
  INDEXER_LAG_TABLES,
  SUBNET_BURN_HISTORY_TABLES,
  SUBNET_SNAPSHOT_TABLES,
  SURFACE_HISTORY_TABLES,
  TAO_USD_TABLES,
} from "./read-store-tables.ts";
import { loadAxonRemovals } from "./axon-removals-loader.ts";
import {
  accountAxonRemovalRows,
  subnetAxonRemovalRow,
} from "./axon-removals-loader.ts";

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// The contextValue handleGraphQLRequest passes to execute() (env + a
// per-request memo Map + the raw Request), plus the extra fields the
// graphql-ws subscription path stamps on (clientIp/graphqlWsConnection).
// Kept loose (all optional except env) because different entry points
// populate different subsets. Exported (types-epic D, #7862) as the
// `contextType` graphql-codegen's typescript-resolvers plugin is configured
// against.
export interface GqlContext {
  env: Env;
  cache: Map<string, unknown>;
  /**
   * The artifact reader every MCP loader reached for.
   *
   * DECLARED, not asserted (#11339). This used to be absent from the context
   * and bolted on at each of 33 call sites by an `mcpCtx()` cast, on the
   * reasoning that the loaders never dereference it because graphql.ts always
   * passes its own through their `deps` override. That held right up until it
   * didn't: the two rpc resolvers spread `{ ...context, readHealthKv }`
   * instead, and the cast was the only thing hiding that they were handing the
   * loaders a ctx with no reader at all.
   */
  readArtifact: (env: Env, path: string) => ReturnType<typeof readArtifact>;
  request?: Request;
  /** The request's ExecutionContext, threaded so resolvers can select a store
   * (#10086). createPgSql returns its connection via waitUntil, so a resolver
   * without one cannot read Neon and correctly falls back to the store. */
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  clientIp?: string | null;
  graphqlWsConnection?: unknown;
  chainFirehose?: unknown;
}

// The SDL is GENERATED (#10214): scripts/generate-graphql-types.ts prints it
// from the Zod-built schema into generated/graphql/schema.ts, which is also
// what @graphql-codegen reads. Re-exported so every existing
// `import { SDL } from "./graphql.ts"` keeps working.
export { SDL };

// Exported so workers/chain-firehose-hub.ts's graphql-ws server (#4983) can
// execute against the SAME schema -- not a copy, so the two transports never
// drift.
export const schema = buildSchema(SDL);

// SDL-only schemas (buildSchema) carry no resolver functions -- Query/Mutation
// fields read straight off rootValue/artifacts via the default field resolver,
// but a subscription root field needs an explicit `subscribe` (an
// AsyncIterable source), which SDL has no syntax for. Attached here, once, at
// module load, the same graphql-js technique used by every SDL-first server
// that also needs subscriptions. context.chainFirehose is supplied by
// whichever Durable Object drives the graphql-ws server (workers/chain-firehose-hub.ts)
// -- see GRAPHQL_SUBSCRIPTION_CONTEXT_KEY below.
// #7885: the nested Subnet.surfaces field takes the same filter/sort/page
// arguments as GET /api/v1/subnets/{netuid}/surfaces. A nested field needs an
// explicit resolve to see its own args (the default field resolver ignores
// them and just reads the parent property), attached here the same way the
// subscription's `subscribe` is below -- buildSchema carries no resolver map.
// The query itself runs through applyQueryFilters against the same
// curated-surfaces collection the REST route uses, so the allowlists cannot
// drift; with no arguments the parent's surfaces pass through untouched.
const SUBNET_SURFACES_FILTER_NAMES = ["kind", "provider", "id"];

/**
 * A `Subnet` as `subnetNode` builds it: a row plus the two lazy list thunks.
 *
 * The two resolvers below invoke `parent.surfaces(...)` / `parent.endpoints
 * (...)` directly rather than letting the default field resolver do it, so
 * they depend on those being FUNCTIONS -- which `Row` did not say and
 * `Record<string, any>` let them assume (#10782).
 */
interface SubnetNodeParent extends Row {
  surfaces: (args: Row, context: GqlContext, info: unknown) => unknown;
  endpoints: (args: Row, context: GqlContext, info: unknown) => unknown;
}
(schema.getType("Subnet") as GraphQLObjectType).getFields().surfaces.resolve =
  async function subnetSurfaces(
    parent: SubnetNodeParent,
    args: Row,
    context: GqlContext,
    info: unknown,
  ) {
    // subnetNode -- the only producer of Subnet objects -- always exposes
    // `surfaces` as a thunk (bundled rows via `() => rows ?? []`, or a lazy
    // per-netuid artifact load), which the default field resolver would have
    // invoked. Do the same here so adding arguments does not turn the lazy path
    // into an empty list.
    const surfaces = (await parent.surfaces(args, context, info)) as Row[];
    const queryUrl = new URL("https://graphql.internal/subnets/surfaces");
    for (const [name, value] of [
      ["kind", args?.kind],
      ["provider", args?.provider],
      ["id", args?.id],
      ["sort", args?.sort],
      ["order", args?.order],
      ["limit", args?.limit],
      ["cursor", args?.cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    if ([...queryUrl.searchParams].length === 0) return surfaces;
    const transformed = applyQueryFilters(
      { surfaces },
      queryUrl,
      "curated-surfaces",
      SUBNET_SURFACES_FILTER_NAMES,
    );
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return (transformed.data as Row).surfaces;
  };

// #7869: the nested Subnet.endpoints field takes the same filter/sort/page
// arguments as GET /api/v1/subnets/{netuid}/endpoints, mirroring the nested
// Subnet.surfaces field above. A nested field needs an explicit resolve to see
// its own args (the default field resolver ignores them and just reads the
// parent property). Filtering runs through applyQueryFilters against the same
// "endpoints" query-collection config the root endpoints(...) field (#7887) and
// the REST route use, so the allowlists cannot drift and an unsupported
// filter/sort value is a BAD_USER_INPUT GraphQL error rather than a silently
// substituted default. With no arguments the parent's endpoints pass through
// untouched. cursor is Int, matching the list query's offset cursor and the
// sibling nested Subnet.surfaces field.
(schema.getType("Subnet") as GraphQLObjectType).getFields().endpoints.resolve =
  async function subnetEndpoints(
    parent: SubnetNodeParent,
    args: Row,
    context: GqlContext,
    info: unknown,
  ) {
    // subnetNode -- the only producer of Subnet objects -- always exposes
    // `endpoints` as a thunk (bundled rows via `() => rows ?? []`, or a lazy
    // per-netuid artifact load), which the default field resolver would have
    // invoked. Do the same here so adding arguments does not turn the lazy path
    // into an empty list.
    const endpoints = await currentEndpointRows(
      context,
      (await parent.endpoints(args, context, info)) as Row[],
    );
    const queryUrl = new URL("https://graphql.internal/subnets/endpoints");
    for (const [name, value] of [
      ["q", args?.q],
      ["kind", args?.kind],
      ["layer", args?.layer],
      ["provider", args?.provider],
      ["publication_state", args?.publication_state],
      ["status", args?.status],
      ["known_status", args?.known_status],
      ["pool_eligible", args?.pool_eligible],
      ["min_latency_ms", args?.min_latency_ms],
      ["max_latency_ms", args?.max_latency_ms],
      ["min_score", args?.min_score],
      ["max_score", args?.max_score],
      ["sort", args?.sort],
      ["order", args?.order],
      ["limit", args?.limit],
      ["cursor", args?.cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    if ([...queryUrl.searchParams].length === 0) return endpoints;
    const transformed = applyQueryFilters(
      { endpoints },
      queryUrl,
      "endpoints",
      [],
    );
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return (transformed.data as Row).endpoints;
  };

/**
 * What `chainEvents.subscribe` reads off its context, named (#10782).
 *
 * It was `Row`, and while `Row` was `Record<string, any>` that read as a full
 * type: `context[KEY].subscribeChainEvents(...)` type-checked because `any`
 * has every method. The hub crosses the `src/` <-> `workers/` boundary here
 * with no declaration on either side of it, so nothing said which two methods
 * this file depends on -- renaming either in the Durable Object would have
 * compiled and failed at runtime, on the one transport no REST test covers.
 *
 * `import type` is fully erased, so naming the real class costs the bundle
 * nothing and cannot drift from it.
 */
interface ChainEventsSubscriptionContext {
  [GRAPHQL_SUBSCRIPTION_CONTEXT_KEY]?: Pick<
    ChainFirehoseHub,
    "subscribeChainEvents" | "unsubscribeChainEvents"
  >;
  /** Set by the graphqlWsServer context() callback from ctx.extra.ip. */
  clientIp?: string;
  /** The per-socket record the connection-count cap is keyed on. */
  graphqlWsConnection?: GraphqlWsConnectionInfo;
}

schema.getSubscriptionType()!.getFields().chainEvents.subscribe =
  async function* chainEventsSubscribe(
    _source: unknown,
    args: Row,
    context: ChainEventsSubscriptionContext,
  ) {
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
    // `undefined` (no filter) stays distinct from `[]` (match nothing) --
    // see the comment above; `stringsOf` only changes what a NON-list or a
    // non-string element does, which the published `[ChainFirehoseTable!]`
    // already forbids.
    const topics =
      args.tables === undefined ? null : new Set(stringsOf(args.tables));
    // context.clientIp/context.graphqlWsConnection are set by
    // workers/chain-firehose-hub.ts's graphqlWsServer context() callback
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

/**
 * Check a resolver's arguments against the REST route the field mirrors
 * (#10218).
 *
 * The SDL types an argument; the ROUTE narrows it. `window: String` says
 * nothing about which windows /api/v1/chain/activity computes, and an
 * `Int` says nothing about a page-size ceiling -- so the two published
 * surfaces agreed on the shape and disagreed on the values. This closes that
 * by parsing with the route's own Zod object, the same one `openapi.json` is
 * emitted from, rather than with a vocabulary restated here.
 *
 * The route path is stated per call site because a field's mirrored route is
 * per field; `scripts/validate-graphql-tier-parity.ts` already pairs the two
 * from the SDL's `Mirrors GET …` annotation, so a wrong path here is visible
 * to that gate rather than only at runtime.
 */
function assertRouteArgs(routePath: string, args: Record<string, unknown>) {
  const error = validateRouteArgs(routePath, args);
  if (!error) return;
  throw new GraphQLError(error.message, {
    extensions: { code: "BAD_USER_INPUT" },
  });
}

// --- Pagination ---

// Exported so tests/docs-content-drift.test.ts can assert
// content/docs/graphql.mdx documents the real values.
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

function paginate(
  items: Row[],
  limit: unknown,
  cursor: unknown,
  keyFn: (row: Row) => unknown,
) {
  // A missing/blank/<1 limit falls back to the default — it must NOT clamp UP to
  // 1. An explicit `limit: 0` reaching `Math.max(1, …)` would return a single
  // result, which reads to an agent as "this registry knows one subnet" (the same
  // reasoning as clampLimit in src/mcp-server.ts and src/ai-search.ts).
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 1
      ? Math.min(MAX_PAGE_LIMIT, Math.floor(limit))
      : DEFAULT_PAGE_LIMIT;
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((item: Row) => String(keyFn(item)) === cursor);
    // A cursor that matches no row is STALE, not absent. Leaving `start` at 0
    // silently restarted the caller at page 1 and still emitted a next_cursor,
    // so a client walked page 1 -> page 1 -> page 1 forever while `total` kept
    // reporting thousands. These lists are keyed by identity (e.g. `validators`
    // by hotkey) over rows read live and ordered by a live metric, so a row
    // disappearing between two page fetches is ordinary, not exceptional.
    //
    // Terminating is the honest answer available here: the key is opaque, so
    // there is no order to seek to an insertion point with, and the alternatives
    // are an infinite loop or a hard error on a condition the client did nothing
    // wrong to cause. An empty final page with next_cursor: null ends the walk
    // cleanly; the client re-queries from the start if it wants the remainder.
    if (idx < 0) return { page: [], total: items.length, nextCursor: null };
    start = idx + 1;
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
  search: "/metagraph/search.json",
  searchIndex: "/metagraph/search-index.json",
};
const LIVE_HEALTH_KEY = "live:health";
const LIVE_ECONOMICS_KEY = "live:economics";

// Resolve an async value at most once per query: a page of subnets each pulling
// a relationship shares one read of each registry artifact (and one live health
// snapshot). The promise is cached so concurrent thunks collapse onto one read.
/**
 * Memoise one load per request, KEEPING ITS TYPE.
 *
 * This returned `Promise<Row | null>` regardless of what it was handed, so
 * every loader that went through it came out an untyped bag -- and with `Row`
 * as `Record<string, any>` that bag then satisfied any shape a caller wanted.
 * It is the choke point the whole file's typing runs through: 17 of the errors
 * this generic removes are callers doing `data?.subnets?.find(...)` on a value
 * nothing described (#10782).
 *
 * The cast remains and is the load-bearing one: the cache is a single map
 * shared by loads of different shapes, keyed by string, so its value type
 * cannot be expressed without a per-key registry. `key` and `load` agreeing is
 * the caller's invariant -- the same one the old signature had, now visible in
 * exactly one place instead of erased at every call site.
 */
function once<T>(
  context: GqlContext,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let pending = context.cache.get(key);
  if (!pending) {
    pending = load();
    context.cache.set(key, pending);
  }
  return pending as Promise<T>;
}

/**
 * The rows under an untyped value, or empty.
 *
 * Replaces `rowsOf(data.x).map(...)`, which was two bugs wearing one idiom:
 * `??` only substitutes for null/undefined, so a truthy NON-array (an object
 * where the producer meant a list, a cold tier answering `{}`) sailed through
 * to `.map` and threw at runtime. And with `Row` as `Record<string, any>` the
 * type system had nothing to say about it. This checks what the idiom only
 * looked like it checked (#10782).
 */
function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

/**
 * The single row under an untyped value, or null.
 *
 * The scalar sibling of {@link rowsOf}, and it closes the same hole: a bare
 * `value ? value.field : …` accepts any truthy value, so a string or a number
 * where the producer meant an object reached the property access and answered
 * `undefined` for every field. An ARRAY is rejected too -- reading `.field`
 * off a list is the same mistake with a different shape.
 */
/**
 * A thrown value's message.
 *
 * `catch (e)` gives `unknown`, correctly -- anything can be thrown. This file
 * was casting each one to a `Row` and reading `.message` off it, which with
 * `Row` as `Record<string, any>` compiled and would have printed `undefined`
 * for a thrown string. Same idiom the watchdogs already use
 * (`err instanceof Error ? err.message : String(err)`), in one place.
 */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** A typed empty row, so `rowOf(x) ?? EMPTY_ROW` needs no cast. */
const EMPTY_ROW: Row = {};

/**
 * A declared object, viewed as a row.
 *
 * An `interface` has no index signature, so TypeScript will not accept one as
 * `Record<string, unknown>` even though every property is assignable to
 * `unknown`. That is the rule, not a smell -- an interface can be augmented.
 * Spreading produces a fresh object literal, which IS assignable, so this is
 * the structural conversion rather than an assertion over it. Used where a
 * producer that HAS a real type meets a resolver path that still speaks rows
 * (#10782); each call is a place the row-shaped path should eventually take
 * the producer's type instead (#10784).
 */
function toRow(value: object): Row {
  // The one assertion this file keeps, and the reason it cannot be removed:
  // TypeScript refuses `interface -> Record<string, unknown>` because an
  // interface is open to declaration merging, so a later augmentation could
  // add a property the index signature does not describe. Every property of
  // every caller here IS assignable to `unknown`; the rule is about what
  // could be added later, not about the value. Spreading first makes the
  // result a fresh literal, so nothing aliases the producer's object.
  return { ...value } as Row;
}

/** The numbers under an untyped value, or empty. */
function numbersOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : [];
}

/** The strings under an untyped value, or empty. The scalar-list sibling of
 *  {@link rowsOf}. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function rowOf(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

// Artifact data, or null when cold/absent — resolvers degrade to empty shapes
// rather than erroring, like the REST handlers.
//
// GENERIC, and the type parameter is a CLAIM, not a proof: `readArtifact`
// honestly returns `data: unknown`, because a baked artifact is data crossing
// a trust boundary. Naming the expected shape at the call site is strictly
// better than the `Row` this returned before -- every USE of the value is now
// checked against the shape the caller says it is, where previously
// `Record<string, any>` accepted any use at all. It is not a substitute for
// parsing the boundary, which is #10789's job; REST already parses its own
// side (`src/response-validation-tripwire.ts`).
// The default is `Row` -- `Record<string, unknown>` -- because that is what a
// parsed JSON artifact honestly is: an object whose values are not yet known.
// It keeps property ACCESS legal (a JSON object has arbitrary keys) while
// keeping every USE checked, which is the split `unknown` gets wrong in one
// direction and `any` in the other. A caller that knows the shape names it.
function loadArtifact<T = Row>(
  context: GqlContext,
  path: string,
): Promise<T | null> {
  return once(context, path, () =>
    readArtifact(context.env, path).then((res) =>
      res.ok ? (res.data as T) : null,
    ),
  );
}

// Rows under `key`, filtered to one subnet when `netuid` is given.
async function loadRows(
  context: GqlContext,
  path: string,
  key: string,
  netuid?: number | null,
) {
  const data = await loadArtifact(context, path);
  const rows = rowsOf(data?.[key]);
  return netuid == null ? rows : rows.filter((row) => row?.netuid === netuid);
}

// Live operational health (KV health:current → Postgres tier) — the build no
// longer publishes static health, so this mirrors the REST /api/v1/health
// source. Null when the live store is cold.
function loadLiveHealth(context: GqlContext) {
  return once(context, LIVE_HEALTH_KEY, () =>
    resolveLiveHealth({
      readHealthKv: readHealthKv as (
        env: Env,
        key: string,
      ) => Promise<Row | null>,
      env: context.env,
    }),
  );
}

// Economics blob, preferring the fresh KV tier over the committed R2 artifact —
// the same source REST (/api/v1/economics, registry leaderboards) serves, so the
// GraphQL rows and opportunity boards never lag it. Null when both are cold.
function loadEconomics(
  context: GqlContext,
  // #10394: which chain's card. The memo key carries it too -- sharing one
  // entry between the two networks would serve whichever asked first.
  network?: "finney" | "test",
) {
  const testnet = network === "test";
  const key = testnet ? `${LIVE_ECONOMICS_KEY}:test` : LIVE_ECONOMICS_KEY;
  return once(context, key, async () => {
    // The live economics KV is written by the mainnet cron and carries no
    // network column, so off mainnet there is no live tier to prefer -- the
    // network's own artifact is the whole answer. Same asymmetry
    // `answerBlockDetail` applies to the hot tier.
    if (!testnet) {
      const live = await resolveLiveEconomics({
        readHealthKv,
        env: context.env,
        contractVersion: contractVersion(context.env),
      });
      // Spot on every row (#9408 completion), on whichever tier answered.
      if (Array.isArray(live?.data?.subnets)) {
        return withSpotPricedEconomics(live.data as EconomicsArtifact);
      }
    }
    const res = await readArtifact(
      context.env,
      networkArtifactPath(ARTIFACT.economics, network),
    );
    return res.ok
      ? withSpotPricedEconomics(res.data as EconomicsArtifact)
      : null;
  });
}

// Cron snapshot freshness stamp (KV health:meta) — the same observed_at REST
// compare stamps its envelope with. Null when the live store is cold.
function loadObservedAt(context: GqlContext): Promise<string | null> {
  return once(context, KV_HEALTH_META, async () => {
    const meta = (await readHealthKv(
      context.env,
      KV_HEALTH_META,
    )) as Row | null;
    return meta?.last_run_at || null;
  }) as Promise<string | null>;
}

// Economics subnet rows for compare, reusing the live-preferring economics memo
// (same source the `economics` root + opportunity boards serve).
/** One subnet's declared surfaces, from the per-subnet artifact the REST
 * handler reads. Null rather than [] on a miss, so revenueSourcesFor treats it
 * as "no declarations" rather than "declared nothing". */
async function surfacesForNetuid(
  context: GqlContext,
  netuid: number,
): Promise<Row[] | null> {
  const artifact = await readArtifact(
    context.env,
    `/metagraph/subnets/${netuid}.json`,
  );
  if (!artifact.ok) return null;
  const surfaces = (artifact.data as Row | undefined)?.surfaces;
  return Array.isArray(surfaces) ? (surfaces as Row[]) : null;
}

/** Latest TAO/USD, or null. A missing rate prices the emission at 0 USD, which
 * computeCoverage turns into null ratios -- the honest output, since without a
 * rate there is no USD comparison to make. */
async function taoUsdForRevenue(context: GqlContext): Promise<number | null> {
  const artifact = await readArtifact(
    context.env,
    "/metagraph/network/tao-usd.json",
  );
  if (!artifact.ok) return null;
  const latest = (artifact.data as Row | undefined)?.latest as Row | undefined;
  const usd = Number(latest?.usd);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** One subnet's composed revenue view, shared by the per-subnet field and any
 * future caller. Never throws on a missing piece. */
async function revenueForNetuid(
  context: GqlContext,
  netuid: number,
  window?: unknown,
): Promise<SubnetRevenueView> {
  const rows = (await loadEconomicsRows(context)) as Row[];
  const economics = rows.find((row) => Number(row?.netuid) === netuid) ?? null;
  const observations = await loadRevenueObservations(
    readStore(context.env, REVENUE_OBSERVATION_TABLES),
    netuid,
  );
  return loadSubnetRevenue({
    netuid,
    window_days: revenueWindowDays(window),
    economics,
    surfaces: await surfacesForNetuid(context, netuid),
    usd_per_tao: await taoUsdForRevenue(context),
    observations: observations ?? null,
  });
}

async function loadEconomicsRows(context: GqlContext) {
  const data = await loadEconomics(context);
  return Array.isArray(data?.subnets) ? data.subnets : [];
}

// Synthesize the GET request tryDataApiTier forwards to the DATA_API service
// binding, keyed off the same origin as the inbound GraphQL POST (GraphQL has
// no REST-shaped request of its own to forward, unlike every REST handler
// that already owns one matching its own route). Same technique
// handleCompare's health dimension uses for its own internal compare-health
// forward (workers/request-handlers/analytics-routes.ts) rather than
// forwarding the caller's request unchanged.
function postgresTierRequest(
  context: GqlContext,
  pathname: string,
  // URLSearchParams, which is what every one of the 70+ call sites passes and
  // the only thing the body uses (`params.toString()`). It was typed `Row`,
  // and `Row` was `Record<string, any>` -- so the signature said "a row bag"
  // while the contract was "a query string builder", and `any` let the two
  // coexist (#10782).
  params?: URLSearchParams,
  // #10394: which chain's rows to read. Mainnet keeps the base path, so every
  // existing caller is unchanged; testnet reaches the `/api/v1/{network}/…`
  // twin the router already serves and REST callers already use.
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
) {
  const pgUrl = new URL((context.request as Request).url);
  pgUrl.pathname = networkScopedRoute(pathname, network);
  pgUrl.search = params ? params.toString() : "";
  return new Request(pgUrl);
}

// #6978: the ownership-history/conviction/lease-history routes are
// Postgres-only all-events tier -- unlike every tryDataApiTier(flagName)
// call above, there is no D1 predecessor and so no per-table flag to gate on
// (workers/api.ts forwards these three paths to DATA_API unconditionally).
// Mirrors MCP's own loadSubnetOwnershipHistory/loadSubnetConviction/
// loadSubnetLeaseHistory proxies (src/mcp-server.ts) byte-for-byte --
// including their lakehouse fallback, see the wrapper below; reimplemented
// here rather than imported since mcp-server.ts already imports this file's
// handleGraphQLRequest and importing back would be circular.
async function fetchAllEventsTier(
  context: GqlContext,
  pathname: string,
): Promise<Row | null> {
  try {
    return await fetchAllEventsTierFromDataApi(context, pathname);
  } catch (err) {
    // The lakehouse before the error: a DATA_API failure is only the END of the
    // road for a path with no cold-tier reader. /subnets/{netuid}/ownership-
    // history has one, and it is the SAME reader REST reaches through
    // dataApiFailureResponse and MCP through loadSubnetOwnershipHistory, so the
    // three surfaces cannot disagree about a subnet's transfers.
    //
    // Layered around the reader rather than threaded into its three throw
    // sites, mirroring MCP's own split for the same reason: one check replaces
    // three, and DATA_API stays the primary tier. A path the reader does not
    // cover, or a lakehouse that declines, keeps the original error.
    //
    // The origin is synthetic (as it is in MCP's call) because
    // coldTierChainEventsPayload matches on the PATH alone -- unlike
    // postgresTierRequest, this needs no inbound request to key off, so the
    // fallback cannot itself fail on a context that has none.
    const cold = await coldTierChainEventsPayload(
      context.env,
      new URL(`https://d${pathname}`),
    );
    // `.data`, not the envelope: the dispatcher now reports which tier answered
    // alongside the payload, and returning the wrapper here would hand every
    // resolver a `{ data, source }` object that structurally satisfies Row and
    // would therefore fail at runtime rather than at the type level (#9319).
    if (cold) return cold.data;
    // THE DEGRADED EMPTY REST AND MCP ALREADY SERVE (#11423).
    //
    // Without this, GraphQL was the only surface that ERRORED where the other
    // two answered. Measured live 2026-08-16 on `/subnets/64/lease/history`:
    // MCP returned `count: 0, lease_events: [], degraded: {reason:
    // "tier_unavailable"}` while `subnet_lease_history` returned `data: null`
    // with a 503 error -- same route, same instant, two contracts. It is the
    // one operation the latency sweep reports as "did not answer".
    //
    // The resolvers were written expecting this: `subnet_lease_history` ends
    // `?? empty` and the other two spell `data?.field ?? default` throughout.
    // Those fallbacks were unreachable, because a throw here never lets a null
    // reach them.
    //
    // `markedChainEventsPayload` is the same map the REST proxy and MCP read,
    // so all THREE surfaces now answer one route the same way. A path the map
    // does not cover keeps the original error, which is what stops a seventh
    // proxied route silently acquiring an empty that satisfies no schema.
    return markedChainEventsPayloadOrThrow(pathname, err);
  }
}

async function fetchAllEventsTierFromDataApi(
  context: GqlContext,
  pathname: string,
): Promise<Row | null> {
  const dataApi = context.env?.DATA_API;
  if (!dataApi?.fetch) {
    throw new GraphQLError(
      "The chain-events tier is unavailable (the all-events data Worker is not bound to this deployment). Try again against the production endpoint.",
    );
  }
  let response;
  try {
    response = await dataApi.fetch(postgresTierRequest(context, pathname));
  } catch {
    throw new GraphQLError(
      "The chain-events tier could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    throw new GraphQLError(
      `The chain-events tier returned an error (status ${response.status}). Try again shortly.`,
    );
  }
  return asJsonObject(await response.json());
}

// --- Node builders (attach lazy relationship resolvers to artifact rows) ---

// graphql-js' default field resolver invokes a source property when it is a
// function: `subnet.health(args, context, info)`. So a node is just the artifact
// row spread over lazy thunks for its relationships — scalar fields resolve
// straight off the row, relationships resolve on demand through the shared memo.
// `prefetch` lets the single-subnet path serve surfaces/endpoints from the
// detail artifact it already read; economics + health are not in that artifact.
function subnetNode(identity: Row, prefetch: Row = {}) {
  // Every consumer below takes a number, and the identity row's value is
  // whatever the artifact carried. `Number(...)` is what each loader did to it
  // internally anyway; doing it once here is the same coercion, stated.
  const netuid = Number(identity.netuid);
  const bundledOr = (
    rows: Row[] | undefined,
    load: (context: GqlContext, netuid: number) => unknown,
  ) =>
    rows !== undefined
      ? () => rows ?? []
      : (_args: unknown, context: GqlContext) => load(context, netuid);
  return {
    ...identity,
    health: (_args: unknown, context: GqlContext) =>
      loadSubnetHealth(context, netuid),
    economics: (_args: unknown, context: GqlContext) =>
      loadSubnetEconomics(context, netuid),
    surfaces: bundledOr(
      prefetch.surfaces === undefined ? undefined : rowsOf(prefetch.surfaces),
      loadSubnetSurfaces,
    ),
    endpoints: bundledOr(
      prefetch.endpoints === undefined ? undefined : rowsOf(prefetch.endpoints),
      loadSubnetEndpoints,
    ),
  };
}

// REST's turnoverChangeDetail block, normalized into the SubnetTurnoverChanges
// type. Absent when the caller did not set the changes toggle and on the cold
// buildTurnover([]) fallback, both of which resolve the field to null rather
// than a fabricated empty block. Counts fall back to their own list lengths so
// a body carrying lists but no counts still answers consistently, and entries
// missing a hotkey/uid are dropped rather than surfaced as nulls inside the
// non-nullable list items.
function turnoverChangesNode(detail: Row | null | undefined) {
  if (!detail || typeof detail !== "object") return null;
  const validatorList = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .filter((entry: Row) => typeof entry?.hotkey === "string")
      .map((entry: Row) => ({
        hotkey: entry.hotkey,
        uid: Number.isInteger(entry.uid) ? entry.uid : null,
      }));
  const entered = validatorList(detail.validators_entered);
  const exited = validatorList(detail.validators_exited);
  const reassignments = (
    Array.isArray(detail.uid_reassignments) ? detail.uid_reassignments : []
  )
    .filter(
      (entry: Row) =>
        Number.isInteger(entry?.uid) &&
        typeof entry?.from_hotkey === "string" &&
        typeof entry?.to_hotkey === "string",
    )
    .map((entry: Row) => ({
      uid: entry.uid,
      from_hotkey: entry.from_hotkey,
      to_hotkey: entry.to_hotkey,
    }));
  return {
    validators_entered_count: detail.validators_entered_count ?? entered.length,
    validators_exited_count: detail.validators_exited_count ?? exited.length,
    uid_reassignment_count:
      detail.uid_reassignment_count ?? reassignments.length,
    validators_entered: entered,
    validators_exited: exited,
    uid_reassignments: reassignments,
  };
}

// A malformed/absent row resolves to null rather than an empty object, which
// is what the nullable `Extrinsic` positions expect.
//
// `call_args` used to be JSON.stringify'd here, because the SDL declared it a
// String and graphql-js' String serializer would have coerced the decoded
// object via `String(...)` into "[object Object]". It is the JSON scalar now
// (#10391): REST and MCP both serve the decoded value, GraphQL served a
// JSON-encoded copy of it, and the comment justifying that said "no custom
// JSON scalar exists in this schema yet" -- `scalar JSON` is the SDL's first
// declaration and 116 fields already use it, `ChainEvent.args` (the sibling
// with the same object-or-array duality) among them.
// Takes the nullish it was already written to handle: the body is
// `extrinsic ?? null`, and the parameter said `Row`. Callers pass a value that
// may be absent (a malformed tier body has no `extrinsic` key).
function extrinsicNode(extrinsic: Row | null | undefined) {
  return extrinsic ?? null;
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
function validatorNode(validator: Row) {
  return {
    ...validator,
    // `featured` is absent from the validator DETAIL artifact by design --
    // buildValidatorDetail never passes featuredHotkeys (src/metagraph-neurons.ts:362),
    // which keeps that artifact's shape unchanged. `=== true` turned that
    // absence into a confident `false`, indistinguishable from a real "this
    // validator is not featured" and set to contradict the list outright the
    // moment anything is featured (#9892). Absent now means null: unknown.
    //
    // The LIST builder always emits a boolean here, so this preserves it.
    featured:
      typeof validator.featured === "boolean" ? validator.featured : null,
    captured_at: validator.latest_captured_at ?? validator.captured_at ?? null,
    block_number:
      validator.latest_block_number ?? validator.block_number ?? null,
  };
}

// buildValidatorDetail always returns a full-shaped object (rows=[] yields a
// zeroed aggregate), but a malformed Postgres-tier response body degrades to
// `{}` -- merged here with the cold-safe base the same way accountSummaryNode
// normalizes a bad upstream body into the schema-stable zero card.
function validatorDetailNode(data: Row, hotkey: string) {
  const base = buildValidatorDetail([], hotkey, {
    priceByNetuid: NO_ALPHA_PRICES,
  });
  const raw = data && typeof data === "object" ? data : {};
  const subnets: unknown[] = Array.isArray(raw.subnets)
    ? raw.subnets
    : (base.subnets as unknown[]);
  return validatorNode({
    ...base,
    ...raw,
    hotkey:
      typeof raw.hotkey === "string" && raw.hotkey.length > 0
        ? raw.hotkey
        : hotkey,
    subnets,
    // The detail artifact carries no `uid_count` (it is the list builder's
    // entry.uidCount, which buildValidatorDetail has no counterpart for), so
    // GraphQL answered null while the LIST answered 117 for the same hotkey
    // (#9892). The detail's `subnets` is the UNCAPPED per-membership row list
    // -- one entry per UID -- so its length is uid_count exactly; verified
    // 117 == 117 against production.
    //
    // This derivation belongs here rather than in validatorNode because the
    // list caps `subnets` at the top 10 by stake (GLOBAL_VALIDATOR_SUBNET_LIMIT),
    // where the same length would be wrong -- and the list already carries a
    // real uid_count anyway.
    // `subnets` is always an array here (raw's own array, else base's, and
    // buildValidatorDetail always returns one), so no second guard.
    uid_count:
      typeof raw.uid_count === "number" ? raw.uid_count : subnets.length,
  });
}

// buildAccountSummary always returns a full-shaped object (a cold/absent store
// still yields a zeroed summary, never a partial one), but a malformed
// Postgres-tier response body degrades to `{}` -- normalized here the same way
// extrinsicNode/ExtrinsicDetail's `data.ref ?? ref` fallback degrades a
// malformed extrinsic-detail body, so a bad upstream body still resolves to
// the same schema-stable zero shape as a genuinely cold store, not a
// Non-Null-field error.
function accountSummaryNode(data: Row, ss58: string) {
  return {
    schema_version: data.schema_version ?? 1,
    ss58: data.ss58 ?? ss58,
    // The entity labels the artifact carries (name/category/url/source_urls).
    // Enumerating the return shape dropped them, so GraphQL could not tell a
    // client that a coldkey is a known exchange while REST could.
    labels: data.labels ?? null,
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
    activity: data.activity || {
      tx_count: 0,
      modules_called: [],
      modules_called_capped: false,
    },
  };
}

function providerNode(provider: Row) {
  // The artifact's own list; `numbersOf` is what `|| []` only looked like it
  // was doing -- a truthy non-list reached `loadProviderSubnets` before.
  const netuids = numbersOf(provider?.netuids);
  return {
    ...provider,
    netuids,
    subnets: (_args: unknown, context: GqlContext) =>
      loadProviderSubnets(context, netuids),
    endpoints: (_args: unknown, context: GqlContext) =>
      loadProviderEndpoints(context, String(provider.id)),
  };
}

// #7175: a provider's endpoint rows, reusing loadProviderEndpointsList (the same
// loader MCP list_provider_endpoints / REST /api/v1/providers/{slug}/endpoints
// call) unchanged over the baked per-provider artifact. Called with no page/
// filter args so it returns the provider's full endpoint list, matching
// Subnet.endpoints' unbounded [Endpoint!]! shape. A cold/absent per-provider
// artifact (the loader's not_found throw) degrades to an empty list rather than
// erroring the parent query -- the same schema-stable convention Subnet.endpoints
// and the provider node's own cold-artifact paths follow.
async function loadProviderEndpoints(context: GqlContext, slug: string) {
  try {
    const result = await loadProviderEndpointsList(
      context,
      { slug },
      { readArtifact, loadHealth: () => loadLiveHealth(context) },
    );
    return result.endpoints;
  } catch {
    return [];
  }
}

async function loadSubnetHealth(context: GqlContext, netuid: number) {
  return subnetBadgeStatus(await loadLiveHealth(context), netuid);
}

async function loadSubnetEconomics(context: GqlContext, netuid: number) {
  const data = await loadEconomics(context);
  return data?.subnets?.find((row: Row) => row?.netuid === netuid) ?? null;
}

function loadSubnetSurfaces(context: GqlContext, netuid: number) {
  return loadRows(context, ARTIFACT.surfaces, "surfaces", netuid);
}

function loadSubnetEndpoints(context: GqlContext, netuid: number) {
  return loadRows(context, ARTIFACT.endpoints, "endpoints", netuid);
}

async function loadProviderSubnets(context: GqlContext, netuids: number[]) {
  if (!netuids.length) return [];
  const rows = await loadRows(context, ARTIFACT.subnets, "subnets");
  const byNetuid = new Map(rows.map((row) => [row.netuid, row]));
  return (
    netuids
      .map((netuid: number) => byNetuid.get(netuid))
      // `.filter(Boolean)` does not narrow the type -- a netuid the index does
      // not carry yielded `undefined` and reached `subnetNode`, which read
      // `identity.netuid` off it. The predicate says what the filter meant.
      .filter((row): row is Row => Boolean(row))
      .map((row: Row) => subnetNode(row))
  );
}

// --- Resolvers ---

// #8423: the sort fields Query.subnets accepts, mirroring MCP's
// LIST_SUBNETS_SORT_FIELDS. Categorical inclusion/negation + range filtering are
// delegated wholesale to list_subnets' own categoricalFilterSubnets/
// rangeFilterSubnets (imported), so the earlier hand-rolled inclusion-only
// matchesSubnetListFilters is retired in favor of that shared, negation-aware

// Shared list shape: load → optional netuid filter → paginate → wrap. `map`
// node-wraps rows; `resultKey` is the list field's name (economics uses
/**
 * `listPage`'s options, declared rather than destructured out of a `Row`.
 *
 * A local options bag is one of the few shapes that legitimately has no
 * contract behind it -- but destructuring it from `Record<string, any>` gave
 * every field `any`, so `filterFn` could have been a number and `limit` a
 * function and both would have compiled (#10782).
 */
interface ListPageOptions {
  limit?: unknown;
  cursor?: unknown;
  /** REQUIRED: `paginate` calls it unconditionally to mint the next cursor,
   *  so an omitted one threw the moment a list outgrew a page. */
  keyFn: (row: Row) => unknown;
  netuid?: number | null;
  map?: (row: Row) => unknown;
  /** `subnets` for the subnet index, `items` everywhere else. */
  resultKey?: string;
  filterFn?: (row: Row) => boolean;
  /** A whole-list transform (multi-filter + sort) applied before pagination. */
  transform?: (rows: Row[]) => Row[];
  /**
   * Artifact-level keys lifted onto the page beside the rows (#10790).
   *
   * A list view drops the build envelope -- `generated_at`, `schema_version`,
   * `contract_version` say nothing about the rows -- but a CAPTURE stamp is
   * not envelope: it is the only answer to "how old is this snapshot", and a
   * projection that drops it leaves a GraphQL caller no way to ask. `subnets`
   * is the case; `ProfileList.captured_at` is the precedent.
   *
   * Read from the same memoized `loadArtifact` the rows come from, so this is
   * one read, not two.
   *
   * REQUIRED, with `[]` for a view that lifts nothing. There is one caller
   * today and it lifts two fields, so an optional parameter left a fallback
   * arm nothing could reach -- and "what does this view republish from the
   * artifact" is a question a list view should have to answer out loud.
   */
  envelope: readonly string[];
}

// `subnets`, the rest use `items`).
async function listPage(
  context: GqlContext,
  path: string,
  key: string,
  {
    limit,
    cursor,
    keyFn,
    netuid,
    map,
    resultKey = "items",
    filterFn,
    transform,
    envelope,
  }: ListPageOptions,
) {
  let all = await loadRows(context, path, key, netuid);
  if (filterFn) {
    all = all.filter(filterFn);
  }
  // #8423: an optional whole-list transform (multi-filter + sort) applied after
  // any row-wise filterFn and before pagination, so a sort orders the full
  // matching set rather than a single page.
  if (transform) {
    all = transform(all);
  }
  const { page, total, nextCursor } = paginate(all, limit, cursor, keyFn);
  // `?? null`, never omitted: the SDL declares these nullable, and a key the
  // artifact has not stamped must read as "not stamped" rather than as the
  // field being absent from the response.
  //
  // UNCONDITIONAL, and it costs nothing to be: `loadArtifact` is memoized per
  // request and `loadRows` above has already read this path, so an empty
  // envelope spreads `{}` without a second read. Guarding it with
  // `envelope?.length` bought no reads and left an arm no caller could reach.
  const artifact = await loadArtifact(context, path);
  const lifted = Object.fromEntries(
    envelope.map((field) => [field, artifact?.[field] ?? null]),
  );
  return {
    ...lifted,
    [resultKey]: map ? page.map(map) : page,
    total,
    next_cursor: nextCursor,
  };
}

// #7887: full REST filter parity for the root `endpoints` field, mirroring
// the sibling rpc_endpoints (#7886)/endpoint_pools/rpc_pools fields. The baked
// endpoints collection is filtered/sorted/projected by applyQueryFilters over
// the very same "endpoints" query-collection config the REST route (GET
// /api/v1/endpoints) and the list_endpoints MCP tool use -- kind/layer/
// provider/publication_state/status/pool_eligible, the min_/max_latency_ms and
// min_/max_score ranges, sort/order, and the fields projection -- so the
// The list-query URL for a document-shaped collection route (#9981).
//
// /contracts, /fixtures, /agent-catalog and /subnets/{netuid}/trajectory served
// a whole baked document until they declared a query collection. GraphQL takes
// the same arguments so the three surfaces stay one contract -- the alternative
// was a declared divergence, which is the thing this epic exists to remove.
//
// UNLIKE endpointsListQueryUrl above, limit/cursor ARE handed to
// applyQueryFilters: these fields have no bespoke keyFn paginate() wrapping
// them, so the collection's own pagination is the whole implementation and its
// meta is what the caller reads.
function documentListQueryUrl(args: Row): URL {
  const url = new URL("https://graphql.internal/document-collection");
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  };
  set("limit", args.limit);
  set("cursor", args.cursor);
  set("sort", args.sort);
  set("order", args.order);
  set("fields", args.fields);
  return url;
}

/**
 * Page a document-shaped artifact through its declared collection.
 *
 * A null/absent document passes through untouched -- these fields resolve to
 * null for a cold artifact and paging nothing is not an error.
 *
 * EXPORTED for its test. The rejection path is unreachable through the four
 * fields that use it today -- they declare no filters, so the only rejectable
 * values are `sort`/`order` and parseArgumentsAtDispatch catches those first --
 * but it stops being unreachable the moment one declares a filter, and a
 * `v8 ignore` here would be counted by codecov/patch anyway. Injecting the
 * collection is what makes it provable.
 */
export function pageDocumentCollection(
  data: unknown,
  collection: string,
  args: Row,
): unknown {
  if (data === null || data === undefined) return data;
  const transformed = applyQueryFilters(
    data as Row,
    documentListQueryUrl(args),
    collection,
    [],
  );
  if (transformed.error) {
    throw new GraphQLError(transformed.error.message, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return transformed.data;
}

// GraphQL filter allowlist cannot drift from REST. Only the filter/sort/
// projection params are handed to applyQueryFilters (never limit/cursor): with
// neither present it returns the full matching set unpaged, and the existing
// keyFn string-cursor paginate() below then owns paging, preserving
// EndpointList's items/total/next_cursor shape and its backward-compatible
// String cursor unchanged. An unsupported filter/sort surfaces as a
// BAD_USER_INPUT GraphQL error, matching endpoint_pools/rpc_pools/rpc_endpoints
// "not a silently substituted default" convention.
function endpointsListQueryUrl(args: Row): URL {
  const url = new URL("https://graphql.internal/endpoints");
  const set = (key: string, value: unknown) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  };
  set("q", args.q);
  set("netuid", args.netuid);
  set("kind", args.kind);
  set("layer", args.layer);
  set("provider", args.provider);
  set("publication_state", args.publication_state);
  set("status", args.status);
  set("known_status", args.known_status ?? undefined);
  set("pool_eligible", args.pool_eligible);
  set("min_latency_ms", args.min_latency_ms);
  set("max_latency_ms", args.max_latency_ms);
  set("min_score", args.min_score);
  set("max_score", args.max_score);
  set("sort", args.sort);
  set("order", args.order);
  set("fields", args.fields);
  return url;
}

async function currentEndpointRows(context: GqlContext, endpoints: Row[]) {
  if (!endpoints.some((endpoint) => endpoint?.surface_id)) return endpoints;
  return overlayArtifactEndpoints({ endpoints }, await loadLiveHealth(context))!
    .endpoints as Row[];
}

async function loadEndpointsPage(context: GqlContext, args: Row) {
  const blob = await loadArtifact(context, ARTIFACT.endpoints);
  const rows = await currentEndpointRows(
    context,
    Array.isArray(blob?.endpoints) ? (blob.endpoints as Row[]) : [],
  );
  const transformed = applyQueryFilters(
    { endpoints: rows },
    endpointsListQueryUrl(args),
    "endpoints",
    [],
  );
  if (transformed.error) {
    throw new GraphQLError(transformed.error.message, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const filtered = (transformed.data as Row).endpoints as Row[];
  const { page, total, nextCursor } = paginate(
    filtered,
    args.limit,
    args.cursor,
    (e: Row) => e.id ?? e.surface_id,
  );
  return { items: page, total, next_cursor: nextCursor };
}

// readArtifact's static-asset tier resolves the path through a URL parser that
// collapses "../", so an unvalidated provider id could escape the providers/
// namespace. Constrain it to the safe slug charset the other id-bearing artifact
// paths use; subnet(netuid) is Int-typed and needs no guard.
const VALID_PROVIDER_ID = /^[A-Za-z0-9._:-]+$/;

// Backs both evm_address and its get_evm_address_mapping-aligned alias
// evm_address_mapping (#7648), so the two fields cannot drift apart. Same
// H160_PATTERN validation the REST route + MCP get_evm_address_mapping use --
// a malformed address is a GraphQL BAD_USER_INPUT error, not a card. The read
// itself is live chain RPC, not the Postgres tier, reusing loadAddressMapping's
// own KV cache/TTL, matching REST's /evm/address/{h160} handler exactly; ss58 is
// null on an unresolved mapping (schema-stable), never a GraphQL error.
function resolveEvmAddressMapping(
  h160: string,
  context: GqlContext,
  network?: string | null,
) {
  if (typeof h160 !== "string" || !H160_PATTERN.test(h160)) {
    throw new GraphQLError("h160 must be a 20-byte 0x-prefixed hex address.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return loadAddressMapping(
    context.env,
    h160,
    chainNetworkFromChainName(network),
  );
}

// Row-erased (types-epic D, #7862, batches #8158-#8166 -- see PR #8005 for
// the pilot conversion + the codegen mechanism). Every Query root field on
// this object is now typed against the generated Query<Field>Args types
// below rather than a Row-typed destructured param.
/**
 * A block-scoped detail answer, with the GAP case raised rather than flattened
 * to an empty (#9540).
 *
 * `answerBlockDetail` distinguishes three outcomes and only two of them mean
 * "no rows". A `gap` is a ref falling between the decoded seam and the hot
 * window: the data exists and this deployment cannot currently read it. REST
 * answers that 503 `block_detail_unavailable` and MCP throws a tool error, so
 * GraphQL must not be the one surface reporting it as an empty block.
 *
 * `miss` -- a ref that genuinely resolves to nothing -- still degrades to the
 * schema-stable empty, which is this surface's existing convention.
 */
function gapAwareBlockDetail<T>(
  answer: ChainDetailAnswer<T>,
  empty: () => T,
): T {
  if (answer.kind === "answer") return answer.data;
  if (answer.kind === "gap") {
    throw new GraphQLError(chainDetailGapMessage(answer), {
      extensions: {
        code: "BLOCK_DETAIL_UNAVAILABLE",
        block_number: answer.block,
        decoded_through: answer.seam,
      },
    });
  }
  return empty();
}

const rootValue = {
  subnets(args: QuerySubnetsArgs, context: GqlContext) {
    // #8423: full parity with the list_subnets MCP tool over the same static
    // /metagraph/subnets.json artifact -- network scoping, categorical
    // inclusion + negation, min_/max_ range bounds, and sort/order -- by reusing
    // its exact shared helpers rather than reimplementing the filter logic.
    const { netuid, network, limit, cursor, sort, order } = args;
    if (order != null && order !== "asc" && order !== "desc") {
      throw new GraphQLError(
        `"${order}" is not a supported order. Supported: asc, desc.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    return listPage(
      context,
      networkArtifactPath(
        ARTIFACT.subnets,
        (network ?? undefined) as "finney" | "test" | undefined,
      ),
      "subnets",
      {
        limit,
        cursor,
        netuid,
        keyFn: (s: Row) => s.netuid,
        map: subnetNode,
        // The two capture stamps the index carries, published rather than
        // dropped with the build envelope (#10790): they date the CHAIN
        // snapshot the rows were read from, and the identity overlay merged
        // onto it, which `generated_at` does not.
        envelope: ["captured_at", "native_snapshot_captured_at"],
        // list_subnets' own pipeline: categorical inclusion + negation, then the
        // numeric range bounds, then the optional sort -- applied to the full
        // matching set before pagination via the shared helpers.
        transform: (rows: Row[]) => {
          const filtered = rangeFilterSubnets(
            categoricalFilterSubnets(rows, args as Row),
            args as Row,
          );
          return sort ? sortSubnets(filtered, sort, order ?? "asc") : filtered;
        },
      },
    );
  },

  async subnet({ netuid, network }: QuerySubnetArgs, context: GqlContext) {
    const scopedNetwork = (network ?? undefined) as
      "finney" | "test" | undefined;
    const data = await loadArtifact(
      context,
      networkArtifactPath(`/metagraph/subnets/${netuid}.json`, scopedNetwork),
    );
    if (!data) return null;
    // The detail artifact nests identity under `subnet` (flat shapes fall back)
    // and bundles surfaces/endpoints, so those resolve from this one read;
    // economics is overlaid live at serve time, so it loads lazily.
    const identity = rowOf(data.subnet) ?? data;
    // The detail artifact omits the list artifact's computed registry metrics
    // (integration_readiness, official_surface_count, gap_count, first_party),
    // so without this backfill the single-subnet path returns them null while
    // `subnets` populates them. Read the matching subnets.json row — memoized and
    // shared per request, so at most one extra read; the detail identity still
    // wins on any shared key.
    const listRow = (
      await loadRows(
        context,
        networkArtifactPath(ARTIFACT.subnets, scopedNetwork),
        "subnets",
        netuid,
      )
    )[0];
    return subnetNode(listRow ? { ...listRow, ...identity } : identity, {
      surfaces: data.surfaces,
      endpoints: data.endpoints,
    });
  },

  async subnet_hyperparameters(
    { netuid }: QuerySubnet_HyperparametersArgs,
    context: GqlContext,
  ) {
    // Same tryDataApiTier(METAGRAPH_SUBNET_HYPERPARAMS_SOURCE) -> buildSubnetHyperparams
    // fallback contract handleSubnetHyperparams uses. The D1 write path is retired, so a
    // cold tier is an expected steady state, not an error: it yields a schema-stable card
    // with hyperparameters:null rather than a GraphQL error or a 404.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/hyperparameters`,
        ),
        "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
      )) as Row | null) ?? buildSubnetHyperparams(null, netuid);
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

  async subnet_lifecycle(
    { netuid, limit, offset }: QuerySubnet_LifecycleArgs,
    context: GqlContext,
  ) {
    // Same FEED_PAGINATION bounds parsePagination applies for REST, so a
    // GraphQL caller cannot request a wider page than the route allows.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const rows = await loadSubnetLifecycle(context.env, Number(netuid), {
      limit: safeLimit,
      offset: safeOffset,
    });
    // Reads Neon directly rather than through a tier request: this route has
    // no tier cascade and no cold tier (see src/subnet-lifecycle-read.ts), so
    // there is nothing to forward to.
    return buildSubnetLifecycle(rows, Number(netuid), {
      limit: safeLimit,
      offset: safeOffset,
    });
  },

  async chain_subnet_lifecycle(
    { window, limit }: QueryChain_Subnet_LifecycleArgs,
    context: GqlContext,
  ) {
    // The shared parser, with this route's own default passed explicitly so
    // the helper's 30d default never applies -- see DEFAULT_SUBNET_LIFECYCLE_WINDOW.
    const parsed = parseHistoryWindow(
      window ?? DEFAULT_SUBNET_LIFECYCLE_WINDOW,
    );
    if ("error" in parsed) throw new Error(parsed.error.message);
    const { days } = parsed;
    const safeLimit = clampLimit(limit, {
      defaultLimit: 50,
      maxLimit: CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX,
    });
    const rows = await loadChainSubnetLifecycle(context.env, {
      limit: safeLimit,
      offset: 0,
      sinceMs: days === null ? null : Date.now() - days * 86_400_000,
    });
    return buildChainSubnetLifecycle(rows, { limit: safeLimit, offset: null });
  },

  async subnet_hyperparameters_history(
    { netuid, limit, offset, cursor }: QuerySubnet_Hyperparameters_HistoryArgs,
    context: GqlContext,
  ) {
    // Same FEED_PAGINATION bounds parsePagination applies for REST, so a GraphQL
    // caller cannot request a wider page than the route allows.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    // #7882: forward the keyset cursor the route already accepts. The feed is
    // append-only and ordered (observed_at, id) DESC, so the route switches to
    // the keyset comparison and ignores OFFSET whenever a cursor is present --
    // this field just hands the opaque token back, exactly as REST does, so a
    // client can page with the next_cursor already returned below. An
    // empty/absent cursor stays offset-paged, unchanged.
    if (cursor != null && cursor !== "") params.set("cursor", String(cursor));
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/hyperparameters/history`,
          params,
        ),
        "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
      )) as Row | null) ??
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

  // #7169: the three composed subnet routes that had no GraphQL mirror. Each
  // reuses exactly what REST/MCP already call, so the three surfaces can't
  // drift.
  async subnet_metagraph(
    { netuid, validator_permit, fields }: QuerySubnet_MetagraphArgs,
    context: GqlContext,
  ) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetMetagraph
    // fallback contract get_subnet_metagraph uses; a subnet with no indexed
    // neurons is a schema-stable empty metagraph, never a GraphQL error.
    const params = new URLSearchParams();
    if (validator_permit) params.set("validator_permit", "true");
    // #10065: the payload is opaque JSON, so the selection set cannot narrow
    // it and `fields` is the only projection a caller has.
    if (fields != null && fields !== "") params.set("fields", fields);
    return (
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/metagraph`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetMetagraph([], netuid)
    );
  },

  async subnet_overview(
    { netuid }: QuerySubnet_OverviewArgs,
    context: GqlContext,
  ) {
    // Same baked-overview + overlayOverviewHealth composition the REST
    // "subnet-overview" case and the get_subnet MCP tool perform. An
    // un-baked netuid resolves to null rather than a GraphQL error.
    const overview = await loadArtifact(
      context,
      `/metagraph/overview/${netuid}.json`,
    );
    if (!overview) return null;
    const live = await loadLiveHealth(context);
    return overlayOverviewHealth(overview, live, netuid) || overview;
  },

  async subnet_profile(
    { netuid }: QuerySubnet_ProfileArgs,
    context: GqlContext,
  ) {
    // Reuse loadSubnetProfile (the loader get_subnet_profile already calls)
    // unchanged; its deps.readArtifact is invoked as (ctx, path) -- exactly
    // loadArtifact's shape -- so the read shares the request-scoped once()
    // cache. Its only throw is an invalid netuid, which becomes BAD_USER_INPUT
    // (mirroring REST's invalid_params 400); an un-baked profile is null.
    try {
      return await loadSubnetProfile(context, netuid, {
        readArtifact: loadArtifact as AnyFn,
      });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (err?.profilesMcp) {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      throw err;
    }
  },

  // #6991: five registry-meta routes that had an MCP tool but no GraphQL
  // field. Each reads the same baked artifact (and applies the same overlay /
  // builder) its MCP tool does, so REST, MCP, and GraphQL can't drift.
  // #7871: reuse list_candidates' own loader unchanged so REST, MCP, and
  // GraphQL share one filter/sort/page contract -- id/confidence/sort/order now
  // included, matching GET /api/v1/candidates. An invalid filter/sort value or a
  // cold/absent artifact throws, becoming a GraphQL error (matching the sibling
  // gaps / subnet_candidates convention), rather than a silent default.
  candidates(args: QueryCandidatesArgs, context: GqlContext) {
    return loadCandidatesList(context, args, { readArtifact });
  },

  async fixtures(args: Row, context: GqlContext) {
    return pageDocumentCollection(
      await loadArtifact(context, "/metagraph/fixtures.json"),
      "fixtures",
      args,
    );
  },

  // #7867: reuse loadFixture (the same loader get_fixture uses) unchanged --
  // same surface_id charset gate, deprecated-id alias resolve, and artifact
  // path as REST GET /api/v1/fixtures/{surface_id}. invalid_params becomes
  // BAD_USER_INPUT; any other loader miss (not_found / cold R2) resolves to
  // null, matching adapter's cold/absent convention.
  async fixture(args: QueryFixtureArgs, context: GqlContext) {
    try {
      return await loadFixture(context, args, { readArtifact });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (err?.toolError) return null;
      throw err;
    }
  },

  async agent_catalog(
    { netuid, ...page }: QueryAgent_CatalogArgs & Row,
    context: GqlContext,
  ) {
    const live = await loadLiveHealth(context);
    if (netuid == null) {
      const index = await loadArtifact(
        context,
        "/metagraph/agent-catalog.json",
      );
      // Paged only on the INDEX. With a netuid this is one subnet's full
      // catalog, which is a detail document rather than the `subnets`
      // collection the route declares.
      return (
        index &&
        pageDocumentCollection(
          overlayCatalogIndex(index, live) || index,
          "agent-catalog",
          page,
        )
      );
    }
    const detail = await loadArtifact(
      context,
      `/metagraph/agent-catalog/${netuid}.json`,
    );
    return detail && (overlayCatalogDetail(detail, live, netuid) || detail);
  },

  async freshness(_args: unknown, context: GqlContext) {
    // Same baked-artifact + live KV meta merge loadFreshness performs for MCP.
    const base = await loadArtifact(context, "/metagraph/freshness.json");
    if (!base) return null;
    const meta = (await readHealthKv(
      context.env,
      KV_HEALTH_META,
    )) as Row | null;
    return mergeFreshness(base, meta) ?? base;
  },

  async top_holders(
    { sort, limit }: QueryTop_HoldersArgs,
    context: GqlContext,
  ) {
    const safeSort = sort ?? DEFAULT_TOP_HOLDERS_SORT;
    const safeLimit = clampLimit(limit, {
      defaultLimit: TOP_HOLDERS_LIMIT_DEFAULT,
      maxLimit: TOP_HOLDERS_LIMIT_MAX,
    });
    // `params` used to be built here for the removed tier's upstream request;
    // the live flow lane takes `sort`/`limit` directly.
    return (
      // NO TIER READ (#10190): METAGRAPH_TOP_HOLDERS_SOURCE is retired and
      // absent from FORWARDABLE_TIER_FLAGS, so that arm resolved to null on
      // every request.
      //
      // The live flow lane below is the tier the REST handler and the MCP tool
      // read (#9469). This resolver had NEITHER, so it answered a schema-stable
      // EMPTY list while /api/v1/accounts/top-holders served a leaderboard --
      // the same shape of dead fallback ladder as the arm just removed above,
      // one layer down.
      (await loadTopHoldersFlowTier(context.env, {
        sort: safeSort,
        limit: safeLimit,
      })) ?? buildTopHoldersList([], { sort: safeSort, limit: safeLimit })
    );
  },

  async subnet_trajectory(
    { netuid, ...page }: QuerySubnet_TrajectoryArgs & Row,
    context: GqlContext,
  ) {
    // Same contract handleTrajectory uses: a subnet with no daily snapshots is a
    // schema-stable empty trajectory, never a GraphQL error.
    //
    // NO TIER READ (#10190). METAGRAPH_SUBNET_SNAPSHOTS_SOURCE reads "retired" in
    // every deployed config and is absent from FORWARDABLE_TIER_FLAGS, so that
    // arm resolved to null on every request.
    const data = await loadSubnetTrajectory(netuid, {
      db: observationsReadDb(context.env, context.ctx),
    });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      // point_count keeps spanning the UNFILTERED series while `points` pages,
      // the convention every other paged card here uses -- a caller asking for
      // 20 points must not lose the denominator.
      point_count: data.point_count ?? 0,
      points:
        ((
          pageDocumentCollection(
            { points: (data.points as Row[]) ?? [] },
            "subnet-trajectory",
            page,
          ) as Row
        ).points as Row[]) ?? [],
      // The REST envelope keys deltas by window ("7d"/"30d") -- names that
      // aren't valid GraphQL fields -- so flatten to a list carrying the label,
      // dropping windows with no comparable prior point (null delta).
      deltas: Object.entries(data.deltas ?? {})
        .filter(([, delta]) => delta != null)
        .map(([window, delta]) => ({ window, ...(delta as Row) })),
    };
  },

  async subnet_registrations(
    { netuid, window }: QuerySubnet_RegistrationsArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetRegistrations uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_REGISTRATIONS_WINDOW;
    if (!Object.hasOwn(SUBNET_REGISTRATIONS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_REGISTRATIONS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetRegistrations
    // zeroed-card fallback contract handleSubnetRegistrations uses; a subnet with no
    // NeuronRegistered events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetEventCardColdTier(
        context.env,
        CHAIN_REGISTRATIONS_ROLLUP,
        netuid,
        buildSubnetRegistrations,
        {
          windowLabel: windowParam,
          windowDays: SUBNET_REGISTRATIONS_WINDOWS[windowParam] ?? 7,
        },
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

  async subnet_deregistrations(
    { netuid, window }: QuerySubnet_DeregistrationsArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetDeregistrations uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW;
    if (!Object.hasOwn(SUBNET_DEREGISTRATIONS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_DEREGISTRATIONS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetDeregistrations
    // zeroed-card fallback contract handleSubnetDeregistrations uses; a subnet with no
    // NeuronDeregistered events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9307: same UID-reuse derivation REST's handleSubnetDeregistrations
      // reads, then the same MARKED empty when nothing derived it.
      (await loadSubnetDeregistrationsFromArtifact(context.env, netuid, {
        window: windowParam,
      })) ??
      markDeregistrationsNotDerived(
        buildSubnetDeregistrations(null, netuid, { window: windowParam }),
      );
    return {
      events: data.events ?? null,
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_deregistered_hotkeys: data.distinct_deregistered_hotkeys ?? 0,
      deregistrations: data.deregistrations ?? 0,
      deregistrations_per_hotkey: data.deregistrations_per_hotkey ?? null,
      derivation: data.derivation ?? null,
      degraded: data.degraded ?? null,
    };
  },

  async subnet_serving(
    { netuid, window }: QuerySubnet_ServingArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetServing uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_SERVING_WINDOW;
    if (!Object.hasOwn(SUBNET_SERVING_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_SERVING_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetServing
    // zeroed-card fallback contract handleSubnetServing uses; a subnet with no
    // AxonServed events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetEventCardColdTier(
        context.env,
        CHAIN_SERVING_ROLLUP,
        netuid,
        buildSubnetServing,
        {
          windowLabel: windowParam,
          windowDays: SUBNET_SERVING_WINDOWS[windowParam] ?? 7,
        },
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

  async subnet_axon_removals(
    { netuid, window }: QuerySubnet_Axon_RemovalsArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetAxonRemovals uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_AXON_REMOVALS_WINDOW;
    if (!Object.hasOwn(SUBNET_AXON_REMOVALS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_AXON_REMOVALS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetAxonRemovals
    // zeroed-card fallback contract handleSubnetAxonRemovals uses; a subnet with no
    // AxonInfoRemoved events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    // DERIVED FROM STATE (#10805), the same rollup REST and MCP read.
    const removalsRollup = await loadAxonRemovals(context.env);
    const data = buildSubnetAxonRemovals(
      subnetAxonRemovalRow(removalsRollup, netuid),
      netuid,
      { window: windowParam },
    );
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_removers: data.distinct_removers ?? 0,
      removals: data.removals ?? 0,
      removals_per_remover: data.removals_per_remover ?? null,
      // #9307: AxonInfoRemoved has zero occurrences in the complete stream,
      // ever, so this card's zero has never measured this subnet.
      degraded: data.degraded ?? null,
    };
  },

  async subnet_identity_history(
    { netuid, limit, offset, cursor }: QuerySubnet_Identity_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    // Same tryDataApiTier(METAGRAPH_SUBNET_IDENTITY_SOURCE) ->
    // D1 retirement: subnet_identity_history's D1 write/read path is fully
    // retired (2026-07-16), so a Postgres miss/outage degrades straight to
    // the schema-stable empty timeline (entry_count 0), never a GraphQL
    // error and never a live store read.
    // NO TIER READ (#10190). METAGRAPH_SUBNET_IDENTITY_SOURCE reads "retired" in every deployed
    // config and is absent from FORWARDABLE_TIER_FLAGS, so this resolved to
    // null on every request. The composer's lakehouse leg
    // is what answers, and it is now asked with no tier result rather than one
    // that never arrives.
    // Through the composer (src/identity-history-answer.ts) -- the lakehouse leg
    // it owns is why this resolver no longer answers entry_count 0 while REST
    // serves the timeline.
    const data = await answerSubnetIdentityHistory(context.env, netuid, null, {
      limit: safeLimit,
      offset: safeOffset,
      cursor: null,
    });
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

  async chain_identity_history(
    { limit }: QueryChain_Identity_HistoryArgs,
    context: GqlContext,
  ) {
    // The ROUTE's page size, not the generic feed profile. This resolver
    // clamped against FEED_PAGINATION -- default 100, cap 1000 -- while
    // /api/v1/chain/identity-history publishes 50/200, so the two surfaces
    // answered the same question with different pages: 100 changes across 88
    // subnets over GraphQL against 50 across 45 over REST, in the same second
    // (#10215). This feed is limit-only (no offset/cursor); the network view
    // returns the most-recent changes across every subnet in one pass.
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
      maxLimit: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // D1 retirement: subnet_identity_history's D1 write path is retired
    // (2026-07-16), so a Postgres miss/outage degrades to a schema-stable
    // empty feed (count 0), never a GraphQL error.
    // NO TIER READ (#10190). METAGRAPH_SUBNET_IDENTITY_SOURCE reads "retired" in every deployed
    // config and is absent from FORWARDABLE_TIER_FLAGS, so this resolved to
    // null on every request.
    const data = await answerChainIdentityHistory(context.env, null, {
      limit: safeLimit,
    });
    return {
      schema_version: data.schema_version ?? 1,
      count: data.count ?? 0,
      subnet_count: data.subnet_count ?? 0,
      changes: data.changes || [],
    };
  },

  async subnet_performance(
    { netuid }: QuerySubnet_PerformanceArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetPerformance([])
    // cold fallback contract handleSubnetPerformance / MCP get_subnet_performance
    // use: a subnet with no neurons is a schema-stable zeroed card (metric
    // blocks null), never a GraphQL error. No window — current snapshot only.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/performance`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetPerformance([], netuid);
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

  async tao_usd(
    { window, include_points }: QueryTao_UsdArgs,
    context: GqlContext,
  ) {
    // #9609. Same loader REST and MCP use -- see chain_holders above for why a
    // resolver-local query is the thing this surface has historically got wrong.
    const label = window ?? DEFAULT_TAO_USD_WINDOW;
    if (!Object.hasOwn(TAO_USD_WINDOWS, label)) {
      throw new GraphQLError(unsupportedWindowMessage(label, TAO_USD_WINDOWS), {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const rows = await loadTaoUsdSeries(
      readStore(context.env, TAO_USD_TABLES),
      { windowHours: TAO_USD_WINDOWS[label] },
    );
    // #10065: the same opt-out REST and MCP take. REST defaults to sending the
    // points and MCP to omitting them (the 143 KB asymmetry #9720 records);
    // GraphQL follows REST, because a caller who does not want the points can
    // already leave them out of the selection set -- the argument exists so the
    // SERVER can skip building them, not so the client can hide them.
    return buildTaoUsdSeries(rows, {
      window: label,
      includePoints: include_points ?? true,
    });
  },

  async subnet_surface_history(
    { netuid, limit }: { netuid: number; limit?: number | null },
    context: GqlContext,
  ) {
    // #9612. Shares the REST/MCP loader for #9540's reason -- a resolver with
    // its own query is free to drift into answering an empty trail.
    if (
      limit != null &&
      (!Number.isInteger(limit) ||
        limit < 1 ||
        limit > SURFACE_HISTORY_LIMIT_MAX)
    ) {
      throw new GraphQLError(
        `limit must be an integer between 1 and ${SURFACE_HISTORY_LIMIT_MAX}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = limit ?? SURFACE_HISTORY_LIMIT_DEFAULT;
    const rows = await loadSurfaceHistory(
      readStore(context.env, SURFACE_HISTORY_TABLES),
      netuid,
      { limit: safeLimit },
    );
    return buildSurfaceHistory(rows, netuid, { limit: safeLimit });
  },

  async emission_changes(
    { kind, limit }: { kind?: string | null; limit?: number | null },
    context: GqlContext,
  ) {
    // #9615. Shares the REST/MCP loader for #9540's reason.
    if (
      limit != null &&
      (!Number.isInteger(limit) ||
        limit < 1 ||
        limit > EMISSION_CHANGES_LIMIT_MAX)
    ) {
      throw new GraphQLError(
        `limit must be an integer between 1 and ${EMISSION_CHANGES_LIMIT_MAX}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = limit ?? EMISSION_CHANGES_LIMIT_DEFAULT;
    const safeKind = kind ?? undefined;
    const rows = await loadEmissionChanges(
      readStore(context.env, EMISSION_CHANGES_TABLES),
      { limit: safeLimit, kind: safeKind },
    );
    return buildEmissionChanges(rows, { limit: safeLimit, kind: safeKind });
  },

  async chain_holders(
    { sort, limit }: { sort?: string | null; limit?: number | null },
    context: GqlContext,
  ) {
    // #9607. Shares the REST/MCP loader rather than querying here, for the
    // reason #9540 exists: a resolver with its own ladder is free to drift into
    // answering a confident zero while its siblings serve rows.
    if (
      limit != null &&
      (!Number.isInteger(limit) || limit < 1 || limit > CHAIN_HOLDERS_LIMIT_MAX)
    ) {
      throw new GraphQLError(
        `limit must be an integer between 1 and ${CHAIN_HOLDERS_LIMIT_MAX}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const read = await loadChainHolders(
      readStore(context.env, ALPHA_PRICING_TABLES),
    );
    return buildChainHolders(read, {
      sort: sort ?? DEFAULT_CHAIN_HOLDERS_SORT,
      limit: limit ?? CHAIN_HOLDERS_LIMIT_DEFAULT,
    });
  },

  async failure_reasons(
    {
      window,
      netuid,
      kind,
    }: { window?: string | null; netuid?: number | null; kind?: string | null },
    context: GqlContext,
  ) {
    // #9622. Shares the REST/MCP loader for #9540's reason.
    if (
      netuid != null &&
      (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
    ) {
      throw new GraphQLError("netuid must be an integer between 0 and 65535.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const args = {
      window: window ?? DEFAULT_FAILURE_REASONS_WINDOW,
      netuid: netuid ?? undefined,
      kind: kind ?? undefined,
    };
    const rows = await loadFailureReasons(
      readStore(context.env, FAILURE_REASONS_TABLES),
      args,
    );
    return rows === null
      ? declineFailureReasons("unavailable", args)
      : buildFailureReasons(rows, args);
  },

  async indexer_lag(_args: Record<string, never>, context: GqlContext) {
    // #9620. Shares the REST/MCP loader for #9540's reason.
    const row = await loadIndexerLag(
      readStore(context.env, INDEXER_LAG_TABLES),
    );
    return buildIndexerLag(row, Date.now());
  },

  async chain_concentration_history(
    { window }: { window?: string | null },
    context: GqlContext,
  ) {
    // #9628. Shares the REST/MCP loader for #9540's reason.
    const args = {
      window: window ?? DEFAULT_CHAIN_CONCENTRATION_HISTORY_WINDOW,
    };
    const rows = await loadChainConcentrationHistory(
      readStore(context.env, CHAIN_CONCENTRATION_HISTORY_TABLES),
      args,
    );
    return rows === null
      ? declineChainConcentrationHistory("unavailable", args)
      : buildChainConcentrationHistory(rows, args);
  },

  async subnet_emission_pipeline_history(
    { netuid, window }: { netuid: number; window?: string | null },
    context: GqlContext,
  ) {
    // #9625. Shares the REST/MCP loader for #9540's reason.
    const args = { window: window ?? DEFAULT_PIPELINE_HISTORY_WINDOW };
    const rows = await loadPipelineHistory(
      readStore(context.env, SUBNET_SNAPSHOT_TABLES),
      netuid,
      args,
    );
    return rows === null
      ? declinePipelineHistory("unavailable", netuid, args)
      : buildPipelineHistory(rows, netuid, args);
  },

  async subnet_holders(
    { netuid, limit }: { netuid: number; limit?: number | null },
    context: GqlContext,
  ) {
    // #9595. Reads the SAME loader REST and MCP do rather than a resolver-local
    // query -- the defect this surface has a history of is a field that answers
    // a confident zero off a tier its siblings stopped using, and one shared
    // loader is what makes that impossible rather than merely unlikely.
    //
    // The limit is VALIDATED, not clamped: REST returns 400 on an over-ceiling
    // limit, and a GraphQL field that silently substituted a different number
    // would answer a question the caller did not ask.
    if (
      limit != null &&
      (!Number.isInteger(limit) ||
        limit < 1 ||
        limit > SUBNET_HOLDERS_LIMIT_MAX)
    ) {
      throw new GraphQLError(
        `limit must be an integer between 1 and ${SUBNET_HOLDERS_LIMIT_MAX}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = limit ?? SUBNET_HOLDERS_LIMIT_DEFAULT;
    const read = await loadSubnetHolders(
      readStore(context.env, ALPHA_PRICING_TABLES),
      netuid,
      { limit: safeLimit },
    );
    // buildSubnetHolders already returns the decline shape (empty holders, a
    // degraded block, null counts), so there is nothing to translate here -- and
    // nothing that could turn a decline into a zero on the way through.
    return buildSubnetHolders(read, netuid, { limit: safeLimit });
  },

  async subnet_concentration(
    { netuid }: QuerySubnet_ConcentrationArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildConcentration([])
    // cold fallback contract handleSubnetConcentration / MCP get_subnet_concentration
    // use: a subnet with no neurons is a schema-stable zeroed card (metric blocks
    // null), never a GraphQL error. No window -- current snapshot only.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/concentration`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildConcentration([], netuid);
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

  async subnet_performance_history(
    { netuid, window }: QuerySubnet_Performance_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d/90d window validation the REST route + MCP
    // get_subnet_performance_history use -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_PERFORMANCE_HISTORY_WINDOW;
    if (!Object.hasOwn(PERFORMANCE_HISTORY_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, PERFORMANCE_HISTORY_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetPerformanceHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/performance/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildSubnetPerformanceHistory([], netuid, {
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

  async subnet_yield_history(
    { netuid, window }: QuerySubnet_Yield_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d/90d window validation the REST route + MCP
    // get_subnet_yield_history use -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_YIELD_HISTORY_WINDOW;
    if (!Object.hasOwn(YIELD_HISTORY_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, YIELD_HISTORY_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetYieldHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/yield/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildSubnetYieldHistory([], netuid, {
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
  async subnet_miner_fairness(
    { netuid, window }: QuerySubnet_Miner_FairnessArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // No hand-written window check: parseArgumentsAtDispatch has already
    // parsed this field's arguments against the route's published query
    // schema, same as its emission-split sibling.
    const windowParam = minerFairnessWindowLabel(window);
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/miner-fairness`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildSubnetMinerFairness([], netuid, {
        window: windowParam,
        capped: false,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      days_covered: data.days_covered ?? 0,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
      miner_uid_count: data.miner_uid_count ?? 0,
      persistence: data.persistence ?? null,
      entity_count: data.entity_count ?? 0,
      uids_per_entity: data.uids_per_entity ?? null,
      concentration: data.concentration ?? null,
    };
  },
  async subnet_cost_to_participate(
    { netuid }: QuerySubnet_Cost_To_ParticipateArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/cost-to-participate`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetCostToParticipate([], netuid);
    // The tier cannot reach the validator-economics composer, so the entry
    // costs merge here through the same projection the REST handler and the
    // MCP tool use -- one shape, three surfaces, no chance of this field
    // answering null on one of them alone.
    const entryCost = entryCostFrom(
      (await buildSubnetValidatorEconomicsPayload(context.env, netuid)).data,
    );
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      entry_cost: entryCost,
      declarations_read: data.declarations_read ?? 0,
      declared_compute: data.declared_compute ?? {
        miner: null,
        validator: null,
        unscoped: null,
        evidence: null,
      },
      declarations: data.declarations ?? [],
      earnings: data.earnings ?? null,
      not_modelled: data.not_modelled ?? [],
    };
  },
  async subnet_treasury(
    { netuid }: QuerySubnet_TreasuryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/treasury`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetTreasury([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      repos_read: data.repos_read ?? 0,
      reviewed_count: data.reviewed_count ?? 0,
      pending_review_count: data.pending_review_count ?? 0,
      declared_share: data.declared_share ?? null,
      observed_share: data.observed_share ?? null,
      declared_matches_observed: data.declared_matches_observed ?? null,
      readings: data.readings ?? [],
    };
  },
  async subnet_owner_capture(
    { netuid, window }: QuerySubnet_Owner_CaptureArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same reasoning as its emission-split sibling: no hand-written window
    // check, because parseArgumentsAtDispatch has already parsed this field's
    // arguments against the route's published query schema.
    const windowParam = ownerCaptureWindowLabel(window);
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/owner-capture`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildSubnetOwnerCapture([], netuid, {
        window: windowParam,
        capped: false,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      owner_coldkey: data.owner_coldkey ?? null,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
      owner_uid_count: data.owner_uid_count ?? null,
      owner_uids: data.owner_uids ?? [],
      attribution: data.attribution ?? [],
      attribution_vocabulary: data.attribution_vocabulary ?? [],
      blind_spots: data.blind_spots ?? [],
    };
  },
  async subnet_emission_split_history(
    { netuid, window }: QuerySubnet_Emission_Split_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // NO hand-written window check. `parseArgumentsAtDispatch` already parses
    // this field's arguments against the route's published query schema, so an
    // unsupported window is rejected before this resolver runs. Restating the
    // enum here would put a second copy of a published fact where the contract
    // cannot see it -- the drift #10060 removed.
    const windowParam = emissionSplitWindowLabel(window);
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/emission-split/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildSubnetEmissionSplitHistory([], netuid, {
        window: windowParam,
        capped: false,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
      field_sources: data.field_sources ?? null,
    };
  },

  async subnet_concentration_history(
    { netuid, window }: QuerySubnet_Concentration_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d/90d window validation the REST route + MCP
    // get_subnet_concentration_history use -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_CONCENTRATION_HISTORY_WINDOW;
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildConcentrationHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/concentration/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
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

  async neuron({ netuid, uid }: QueryNeuronArgs, context: GqlContext) {
    assertNetuidArgument(netuid);
    if (!Number.isInteger(uid) || uid < 0) {
      throw new GraphQLError("uid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildNeuronDetail(null)
    // cold fallback contract handleNeuron / MCP get_neuron use: an absent UID
    // is a schema-stable card with neuron:null, never a GraphQL error.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/neurons/${uid}`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildNeuronDetail(null, netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      neuron: data.neuron ?? null,
    };
  },

  async neuron_history(
    { netuid, uid, window }: QueryNeuron_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    if (!Number.isInteger(uid) || uid < 0) {
      throw new GraphQLError("uid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow REST's handleNeuronHistory uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label, days } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildNeuronHistory([])
    // fallback contract handleNeuronHistory / MCP get_neuron_history use; a
    // UID with no neuron_daily rows in the window is a schema-stable
    // empty-points card, never a GraphQL error.
    const hot =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/neurons/${uid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildNeuronHistory([], netuid, uid, { window: label });
    // The cold leg, on the third surface. All three wire it because a caller
    // must not get a different depth of history depending on which door they
    // came through.
    const data = await overlayNeuronHistoryColdTier(
      context.env as Env,
      hot,
      netuid,
      uid,
      { label, days },
    );
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      uid: data.uid ?? uid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      // Explicit, because this object is BUILT rather than spread: the parity
      // gate compares the SDL to the component and cannot see a resolver that
      // drops a field, so a declared-but-unlisted non-null field would resolve
      // to undefined and error at request time.
      days_covered: data.days_covered ?? 0,
      oldest_day: data.oldest_day ?? null,
      newest_day: data.newest_day ?? null,
      points: data.points || [],
    };
  },

  async subnet_yield({ netuid }: QuerySubnet_YieldArgs, context: GqlContext) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetYield cold
    // fallback contract handleSubnetYield uses: a subnet with no neurons is a
    // schema-stable zeroed card, never a GraphQL error. No window param — the
    // route reads the CURRENT metagraph snapshot.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/yield`,
          new URLSearchParams(),
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetYield([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      neuron_count: data.neuron_count ?? 0,
      validator_count: data.validator_count ?? 0,
      miner_count: data.miner_count ?? 0,
      // THE PRODUCER (#10786). buildSubnetYield accumulates these in rao and
      // converts once at the end, so an empty subnet yields 0 -- there is no
      // arm on which it declines to answer, and `?? null` nulled the two
      // totals the card is FOR. The fallback stays (unlike the sibling cards
      // below, whose value never leaves this Worker) because the other leg is
      // a DATA_API body, and the schema's own zero is what an empty subnet
      // means -- matching the counts on the line above.
      total_stake_alpha: data.total_stake_alpha ?? 0,
      total_emission_alpha: data.total_emission_alpha ?? 0,
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

  async subnet_weights(
    { netuid, window }: QuerySubnet_WeightsArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetWeights uses -- an unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_WEIGHTS_WINDOW;
    if (!Object.hasOwn(SUBNET_WEIGHTS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_WEIGHTS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetWeights
    // zeroed-card fallback contract handleSubnetWeights uses; a subnet with no
    // WeightsSet events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetWeightsColdTier(context.env, netuid, {
        windowLabel: windowParam,
        windowDays: SUBNET_WEIGHTS_WINDOWS[windowParam] ?? 7,
      })) ?? buildSubnetWeights(null, netuid, { window: windowParam });
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

  async subnet_stake_moves(
    { netuid, window }: QuerySubnet_Stake_MovesArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetStakeMoves uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_STAKE_MOVES_WINDOW;
    if (!Object.hasOwn(SUBNET_STAKE_MOVES_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_STAKE_MOVES_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildSubnetStakeMoves
    // zeroed-card fallback contract handleSubnetStakeMoves uses; a subnet with no
    // StakeMoved events in the window is a schema-stable zeroed card, never a
    // GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetEventCardColdTier(
        context.env,
        CHAIN_STAKE_MOVES_ROLLUP,
        netuid,
        buildSubnetStakeMoves,
        {
          windowLabel: windowParam,
          windowDays: SUBNET_STAKE_MOVES_WINDOWS[windowParam] ?? 7,
        },
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

  async subnet_stake_transfers(
    { netuid, window }: QuerySubnet_Stake_TransfersArgs,
    context: GqlContext,
  ) {
    // Same 7d/30d window validation handleSubnetStakeTransfers uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW;
    if (!Object.hasOwn(SUBNET_STAKE_TRANSFERS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_STAKE_TRANSFERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetStakeTransfers zeroed-card fallback contract
    // handleSubnetStakeTransfers uses; a subnet with no StakeTransferred events
    // in the window is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetEventCardColdTier(
        context.env,
        CHAIN_STAKE_TRANSFERS_ROLLUP,
        netuid,
        buildSubnetStakeTransfers,
        {
          windowLabel: windowParam,
          windowDays: SUBNET_STAKE_TRANSFERS_WINDOWS[windowParam] ?? 7,
        },
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

  async subnet_idle_stake(
    { netuid }: QuerySubnet_Idle_StakeArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetIdleStake([])
    // zeroed-card fallback handleSubnetIdleStake + the get_subnet_idle_stake MCP
    // tool use; a subnet with no neurons is a schema-stable zeroed card, never a
    // GraphQL error.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/idle-stake`),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetIdleStake([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      captured_at: data.captured_at ?? null,
      neuron_count: data.neuron_count ?? 0,
      idle_neuron_count: data.idle_neuron_count ?? 0,
      idle_stake_alpha: data.idle_stake_alpha ?? 0,
    };
  },

  async subnet_stake_flow(
    { netuid, window, direction }: QuerySubnet_Stake_FlowArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same window/direction validation handleSubnetStakeFlow + the
    // get_subnet_stake_flow MCP tool apply -- an unsupported value is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_STAKE_FLOW_WINDOW;
    if (!Object.hasOwn(STAKE_FLOW_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, STAKE_FLOW_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // No direction guard here: parseArgumentsAtDispatch already rejected a
    // value outside the route's published enum before this resolver ran
    // (#10065's rule -- a resolver must not re-validate its own params), and
    // the guard this replaces was dead code wearing a different error message
    // than the one a caller actually gets. tests/graphql.test.ts pins the
    // dispatch-level rejection.
    const directionParam = direction ?? DEFAULT_STAKE_FLOW_DIRECTION;
    const params = new URLSearchParams();
    params.set("window", windowParam);
    params.set("direction", directionParam);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } ->
    // buildStakeFlow([]) zeroed-card fallback handleSubnetStakeFlow uses;
    // direction only narrows the live query, so a cold tier degrades to the same
    // zeroed card the direction-less builder produces.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9146: same chain-stake-flow projection slice REST and MCP read.
      ((
        await loadSubnetStakeFlowFromArtifact(context.env, netuid, {
          window: windowParam,
          direction: directionParam,
        })
      )?.data as Row | undefined) ??
      buildStakeFlow([], netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      total_staked_tao: data.total_staked_tao ?? 0,
      total_unstaked_tao: data.total_unstaked_tao ?? 0,
      net_flow_tao: data.net_flow_tao ?? 0,
      stake_events: data.stake_events ?? 0,
      unstake_events: data.unstake_events ?? 0,
    };
  },

  async subnet_events(
    {
      netuid,
      kind,
      block_start,
      block_end,
      limit,
      offset,
      cursor,
    }: QuerySubnet_EventsArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same FEED_PAGINATION bounds the /events route's parsePagination applies, so
    // a GraphQL caller cannot request a wider page than REST allows;
    // kind/block_start/block_end are forwarded verbatim for the route to
    // re-parse, matching account_events and the sibling feeds.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (kind != null) params.set("kind", kind);
    if (block_start != null) params.set("block_start", String(block_start));
    if (block_end != null) params.set("block_end", String(block_end));
    // #10065: the keyset cursor the route has always accepted, forwarded the
    // same way the sibling account_events field forwards its own -- an opaque
    // token handed back verbatim, not a number to construct.
    if (cursor != null && cursor !== "") params.set("cursor", cursor);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) handleSubnetEvents and
    // the get_subnet_events MCP tool use. The events list passes through whole;
    // graphql's default resolver reads each AccountEvent field, matching
    // account_events' shaped rows.
    //
    // The cold-tier leg below is what makes that sentence true again. #9212 added
    // it to the REST handler only, and account_events' D1 write path is retired
    // (#4772) so the tier above always declines -- which left this resolver
    // falling straight to an empty buildSubnetEvents while REST served real rows
    // from chain.account_events for the same netuid. A schema-stable empty feed
    // is the right shape for "no events"; it is the wrong answer for "441M rows
    // exist and nobody asked the table that holds them".
    const tierResult =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      null;
    const data = await answerSubnetEvents(context.env, netuid, tierResult, {
      limit: safeLimit,
      offset: safeOffset,
      cursor: null,
      kind: kind ?? null,
      blockStart: block_start ?? null,
      blockEnd: block_end ?? null,
    });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      event_count: data.event_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      events: data.events ?? [],
    };
  },

  async subnet_history(
    { netuid, window }: QuerySubnet_HistoryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same parseHistoryWindow handleSubnetHistory + loadSubnetHistory (MCP) use,
    // so accepted window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label, days } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetHistory([])
    // empty-series fallback handleSubnetHistory uses; a subnet with no daily
    // rollup is a schema-stable point_count:0 series, never a GraphQL error.
    const hot =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetHistory([], netuid, { window: label });
    // See the neuron-history resolver: same seam, same reason.
    const data = await overlaySubnetHistoryColdTier(
      context.env as Env,
      hot,
      netuid,
      { label, days },
    );
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      // See the neuron-history resolver: built object, so the coverage fields
      // have to be listed or the SDL declares what nothing returns.
      days_covered: data.days_covered ?? 0,
      oldest_day: data.oldest_day ?? null,
      newest_day: data.newest_day ?? null,
      points: data.points ?? [],
    };
  },

  async subnet_prometheus(
    { netuid, window }: QuerySubnet_PrometheusArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d window validation handleSubnetPrometheus + the
    // get_subnet_prometheus MCP tool use -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_PROMETHEUS_WINDOW;
    if (!Object.hasOwn(SUBNET_PROMETHEUS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_PROMETHEUS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", windowParam);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetPrometheus(null) zeroed-card fallback handleSubnetPrometheus
    // uses; a subnet with no PrometheusServed events is a schema-stable zeroed
    // card, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #10322: the same cold-tier rung REST's handleSubnetPrometheus gained.
      // Without it this resolver bottomed out in the zeroed builder while
      // `chain_prometheus` answered from the same PrometheusServed stream.
      ((await loadSubnetEventCardColdTier(
        context.env,
        CHAIN_PROMETHEUS_ROLLUP,
        netuid,
        buildSubnetPrometheus,
        {
          windowLabel: windowParam,
          windowDays: SUBNET_PROMETHEUS_WINDOWS[windowParam] ?? 7,
        },
      )) as Row | null) ??
      buildSubnetPrometheus(null, netuid, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      distinct_exporters: data.distinct_exporters ?? 0,
      announcements: data.announcements ?? 0,
      announcements_per_exporter: data.announcements_per_exporter ?? null,
      // Preserve the shared loader's source-availability verdict.
      degraded: data.degraded ?? null,
    };
  },

  async subnet_weight_setters(
    { netuid, window }: QuerySubnet_Weight_SettersArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d window validation handleSubnetWeightSetters uses -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW;
    if (!Object.hasOwn(SUBNET_WEIGHT_SETTERS_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_WEIGHT_SETTERS_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetWeightSetters([], null, ...) empty-leaderboard fallback
    // contract handleSubnetWeightSetters / MCP get_subnet_weight_setters use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      ((await loadSubnetWeightSettersColdTier(context.env, netuid, {
        windowLabel: windowParam,
        windowDays: SUBNET_WEIGHT_SETTERS_WINDOWS[windowParam] ?? 7,
        limit: SUBNET_WEIGHT_SETTERS_LIMIT,
      })) as Row | null) ??
      buildSubnetWeightSetters([], null, netuid, { window: windowParam });
    return {
      tempo: data.tempo ?? null,
      // THE PRODUCER, and the fallback is DELETED rather than corrected
      // (#10786). Both legs above end in a card this Worker built:
      // `loadSubnetWeightSettersColdTier` shapes the lakehouse rows, and
      // `buildSubnetWeightSetters` stamps `overdue_tempo_multiple` from a
      // module constant (it is the DEFINITION of overdue, not a measurement)
      // and `overdue_setter_count` from a `.filter().length`. Neither can omit
      // them, so `?? null` was not a safety net -- it was an unreachable arm
      // that turned a non-null field nullable for nothing.
      overdue_tempo_multiple: data.overdue_tempo_multiple,
      overdue_setter_count: data.overdue_setter_count,
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

  // #7888: add REST/MCP list-query filters (id/kind/authority/sort/order/fields)
  // by reusing loadProvidersList for validate+filter+sort, while preserving the
  // pre-existing GraphQL providers contract the gate flagged as a breaker on
  // #7920: opaque string id-keyset cursor/next_cursor (not REST's Int offset)
  // and schema-stable empty list on a cold/absent artifact (not a GraphQL
  // error). limit/cursor are applied here via paginate, not the loader.
  async providers(args: QueryProvidersArgs, context: GqlContext) {
    const { limit, cursor, ...filters } = args;
    // Default empty list; only overwrite on a successful load. Cold/absent
    // (or any non-invalid_params loader failure) keeps this historical contract.
    let rows: Row[] = [];
    try {
      // Omit GraphQL limit/cursor so the loader returns the full filtered set.
      // An id-prefixing branch for a `fields` projection lived here until
      // #10214 removed the argument (the selection set is the projection on a
      // typed return); the spread into `Row` had kept the dead read compiling,
      // which is exactly what #10864 was filed about.
      const data = await loadProvidersList(
        context,
        { ...filters },
        {
          readArtifact,
        },
      );
      rows = data.providers as Row[];
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
    }
    const { page, total, nextCursor } = paginate(
      rows,
      limit,
      cursor,
      (p: Row) => p.id,
    );
    return {
      items: page.map(providerNode),
      total,
      next_cursor: nextCursor,
    };
  },

  async provider({ id }: QueryProviderArgs, context: GqlContext) {
    if (typeof id !== "string" || !VALID_PROVIDER_ID.test(id)) return null;
    const data = await loadArtifact(context, `/metagraph/providers/${id}.json`);
    if (!data) return null;
    return providerNode(rowOf(data.provider) ?? data);
  },

  // #6984: reuse loadAdapter (the same loader MCP get_adapter already calls)
  // unchanged -- same slug validation and artifact path as REST
  // /api/v1/adapters/{slug}. invalid_params becomes BAD_USER_INPUT; any other
  // loader miss (not_found / cold R2 / unavailable) resolves to null
  // (schema-stable), matching provider's cold/absent convention -- never a
  // GraphQL error for an unregistered slug.
  async adapter({ slug }: QueryAdapterArgs, context: GqlContext) {
    try {
      return await loadAdapter(context, { slug }, { readArtifact });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (err?.toolError) return null;
      throw err;
    }
  },

  async economics(args: QueryEconomicsArgs, context: GqlContext) {
    // #8549: full REST/MCP filter parity (netuid/registration_allowed/q/sort/order
    // + limit/cursor) applied to the SAME live-preferring loadEconomics source,
    // reusing the shared applyQueryFilters engine over the "economics" collection
    // (the same read + filter/sort/page get_economics runs) rather than re-deriving
    // it. An invalid filter/sort is a GraphQL BAD_USER_INPUT error, not a silently
    // substituted default. The cursor is REST's positional offset, like every other
    // applyQueryFilters-backed list field.
    const data = await loadEconomics(
      context,
      (args.network ?? undefined) as "finney" | "test" | undefined,
    );
    const queryUrl = new URL("https://graphql.internal/economics");
    for (const [name, value] of [
      ["netuid", args?.netuid],
      ["registration_allowed", args?.registration_allowed],
      ["q", args?.q],
      ["sort", args?.sort],
      ["order", args?.order],
      ["limit", args?.limit],
      ["cursor", args?.cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    const transformed = applyQueryFilters(
      { subnets: data?.subnets ?? [] },
      queryUrl,
      "economics",
      [],
    );
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // applyQueryFilters always returns the economics collection as an array plus
    // a pagination meta block (total/next_cursor), even for an empty/cold input,
    // so no defensive shape fallbacks are needed here.
    const filtered = transformed.data as Row;
    const page = (transformed.meta as Row).pagination as Row;
    return {
      subnets: filtered.subnets as Row[],
      total: page.total as number,
      next_cursor: (page.next_cursor as string | number | null) ?? null,
      summary: data?.summary ?? null,
    };
  },

  // #8548: delegate to loadSurfacesList -- the same read + filter/sort/page the
  // REST route and MCP list_surfaces run over the baked curated-surfaces artifact
  // -- rather than re-deriving a GraphQL-only filter set in listPage. It validates
  // its own args and throws on an invalid filter/sort (or a cold/absent artifact);
  // that throw becomes a GraphQL error, matching provider_endpoints' convention.
  async surfaces(args: QuerySurfacesArgs, context: GqlContext) {
    const list = await loadSurfacesList(context, args, {
      readArtifact,
    });
    // loadSurfacesList's envelope names the rows `surfaces`; the GraphQL
    // SurfaceList type calls them `items`. Adapt that one key only -- all
    // filtering, sorting and paging still live in the shared loader.
    return { ...list, items: list.surfaces };
  },

  endpoints(args: QueryEndpointsArgs, context: GqlContext) {
    return loadEndpointsPage(context, args);
  },

  // #7868: reuse list_provider_endpoints' own loader unchanged (provider-
  // endpoints-mcp.ts) -- the same read + filter/sort/page the REST route and
  // MCP tool run over the baked per-provider artifact. It validates its own
  // args and throws on an invalid one (or a cold/absent provider artifact) --
  // that throw becomes a GraphQL error, matching endpoint_pools/gaps' "an
  // unsupported filter/sort is a GraphQL error, not a silently substituted
  // default" convention.
  provider_endpoints(args: QueryProvider_EndpointsArgs, context: GqlContext) {
    return loadProviderEndpointsList(context, args, {
      readArtifact,
      loadHealth: () => loadLiveHealth(context),
    });
  },

  // #6985: reuse list_endpoint_pools's/list_rpc_pools's/list_endpoint_incidents's
  // own loaders unchanged (same artifact read, filter, sort, and page logic REST
  // and MCP already use) rather than re-deriving a GraphQL-only filterFn. Each
  // loader validates its own args and throws on an invalid one -- that throw
  // (inside these async functions) becomes a rejected promise, which the graphql
  // executor surfaces as a normal GraphQL error, matching every other field's
  // "an unsupported filter/sort is a GraphQL error, not a silently substituted
  // default" convention.
  endpoint_pools(args: QueryEndpoint_PoolsArgs, context: GqlContext) {
    return loadEndpointPoolsList(context, args, { readArtifact });
  },

  rpc_pools(args: QueryRpc_PoolsArgs, context: GqlContext) {
    // rpc-pools' loader additionally reads ctx.readHealthKv for its live
    // 15-minute cron eligibility overlay (rpc-pools-mcp.ts) -- graphql.ts's
    // own context has no such property, so it's supplied here from the same
    // module-level import loadLiveHealth/loadEconomics already use.
    return loadRpcPoolsList({ ...context, readHealthKv }, args, {
      readArtifact,
    });
  },

  endpoint_incidents(args: QueryEndpoint_IncidentsArgs, context: GqlContext) {
    return loadEndpointIncidentsList(context, args, { readArtifact });
  },

  // #6986: reuse list_source_snapshots' own loader unchanged. It validates its
  // own args and throws on an invalid one -- that throw (inside this async
  // function) becomes a rejected promise, which the graphql executor surfaces
  // as a normal GraphQL error, matching every other field's "an unsupported
  // filter/sort is a GraphQL error, not a silently substituted default"
  // convention.
  source_snapshots(args: QuerySource_SnapshotsArgs, context: GqlContext) {
    return loadSourceSnapshotsList(context, args, { readArtifact });
  },

  // #7171: reuse list_gaps / list_evidence loaders unchanged. Each validates
  // its own args and throws on an invalid one -- that throw becomes a GraphQL
  // error, matching source_snapshots' "unsupported filter/sort is a GraphQL
  // error, not a silently substituted default" convention. A cold/absent
  // artifact is likewise a GraphQL error (matching REST/MCP not_found).
  gaps(args: QueryGapsArgs, context: GqlContext) {
    return loadGapsList(context, args, { readArtifact });
  },

  evidence(args: QueryEvidenceArgs, context: GqlContext) {
    return loadEvidenceList(context, args, { readArtifact });
  },

  // #6992: reuse list_profiles' own loader unchanged. Its readOptionalArtifact
  // dep is called as (ctx, path) and expects data-or-null on a cold artifact
  // (not a throw) -- this file's own loadArtifact(context, path) already has
  // exactly that shape (readArtifact(context.env, path), null if not ok), so
  // it's reused directly rather than adding a redundant wrapper.
  profiles(args: QueryProfilesArgs, context: GqlContext) {
    return loadProfilesList(context, args, {
      readOptionalArtifact: loadArtifact as AnyFn,
    });
  },

  registry_summary(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST route + registry_summary MCP tool read.
    // Degrades to null when cold instead of erroring, matching every other
    // artifact-backed resolver here.
    return loadArtifact(context, "/metagraph/registry-summary.json");
  },

  async saved_query({ id, params }: QuerySaved_QueryArgs, context: GqlContext) {
    // #7642: the same maintainer-curated template executor the REST route and
    // run_saved_query MCP tool share (src/saved-queries.ts) -- template
    // lookup, param coercion/validation, and execution are all its. Its
    // not_found (unknown id) and invalid_params toolErrors map to
    // BAD_USER_INPUT, matching this file's invalid-argument convention; any
    // other executor failure surfaces as a normal GraphQL error.
    try {
      // params is the JSON scalar (unknown); runSavedQuery's Row param is the
      // same "read for template-defined coercion, never trusted for control
      // flow" contract as every other opaque-JSON boundary in this file.
      return await runSavedQuery(context.env, id, (params ?? {}) as Row);
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (
        err?.toolError &&
        (err.code === "not_found" || err.code === "invalid_params")
      ) {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      throw err;
    }
  },

  source_health(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST route + get_source_health MCP tool read.
    return loadArtifact(context, "/metagraph/source-health.json");
  },

  lineage(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST route + get_lineage MCP tool read.
    return loadArtifact(context, "/metagraph/lineage.json");
  },

  rpc_endpoints(args: QueryRpc_EndpointsArgs, context: GqlContext) {
    // #7886: reuse loadRpcEndpointsList — same live 15-minute cron overlay +
    // endpoints-collection list-query transforms REST applies. The loader
    // validates its own args and throws on an invalid filter/sort or a cold
    // artifact; that throw becomes a GraphQL error, matching endpoint_pools /
    // rpc_pools' "an unsupported filter/sort is a GraphQL error, not a
    // silently substituted default" convention.
    return loadRpcEndpointsList({ ...context, readHealthKv }, args, {
      readArtifact,
    });
  },

  // #7170: reuse get_changelog's/get_contracts's own loaders unchanged (the same
  // baked artifact read REST and MCP already use). Each takes { readArtifact }
  // as the module-level storage reader -- exactly what MCP's own registrations
  // pass. A cold/absent artifact makes the loader throw, which the graphql
  // executor surfaces as a normal GraphQL error, matching REST's 404 and the
  // source_snapshots convention for a missing artifact.
  // `coverage_delta` is declared at the top level of type Changelog, but the
  // artifact nests it INSIDE `summary` -- so the flattened path never existed
  // and the field resolved null on every call, reading as "this changelog has
  // no coverage delta" when in fact every changelog has one (#9892).
  //
  // Flattened here rather than taught to a field resolver because the schema is
  // built with buildSchema(SDL) and carries no resolver map: reshaping in the
  // Query resolver is the only hook there is, and the same one subnet_trajectory
  // already uses for its window-keyed deltas.
  async changelog(_args: unknown, context: GqlContext) {
    const data = (await loadChangelog(context, {
      readArtifact,
    })) as Row;
    // loadChangelog throws on a cold/absent artifact (the test below pins that
    // it surfaces as a GraphQL error), so `data` is always an object here.
    const { summary } = data;
    const nested =
      summary !== null && typeof summary === "object"
        ? (summary as Row).coverage_delta
        : undefined;
    return { ...data, coverage_delta: data.coverage_delta ?? nested ?? null };
  },

  async contracts(args: Row, context: GqlContext) {
    return pageDocumentCollection(
      await loadContracts(context, { readArtifact }),
      "contracts",
      args,
    );
  },

  // #7431: reuse get_build's own loader unchanged (the same baked artifact read
  // REST and MCP already use). A cold/absent artifact makes the loader throw,
  // which the graphql executor surfaces as a normal GraphQL error.
  build(_args: unknown, context: GqlContext) {
    return loadBuildSummary(context, { readArtifact });
  },

  // #8422: reuse get_self_health's own loader unchanged (the same baked
  // /metagraph/self-health.json read REST and MCP already use). A cold/absent
  // artifact makes the loader throw, surfaced as a normal GraphQL error --
  // matching build/changelog/contracts.
  self_health(_args: unknown, context: GqlContext) {
    return loadSelfHealth(context, { readArtifact });
  },

  // #7170: reuse get_health_history's own loader unchanged. It takes deps as
  // { readArtifact } called (ctx, path) returning data-or-null -- this file's
  // own loadArtifact has exactly that shape, so it's reused directly (like
  // profiles' readOptionalArtifact). The loader validates its date + filters
  // and throws invalid_params on a bad one / not_found on a missing snapshot;
  // that throw becomes a GraphQL error, matching every other field's "an
  // unsupported filter/sort is a GraphQL error, not a silent default".
  health_history(args: QueryHealth_HistoryArgs, context: GqlContext) {
    return loadHealthHistory(context, args, {
      readArtifact: loadArtifact as AnyFn,
    });
  },

  // #7167: reuse each review-family list_* MCP loader unchanged. Each validates
  // its own args and throws on an invalid one -- that throw (inside these async
  // functions) becomes a rejected promise, which the graphql executor surfaces
  // as a normal GraphQL error, matching every other field's "an unsupported
  // filter/sort is a GraphQL error, not a silently substituted default"
  // convention. A cold/missing artifact is also a GraphQL error (matches
  // REST 404 / MCP not_found); an empty filtered page is a success with total 0.
  review_adapter_candidates(
    args: QueryReview_Adapter_CandidatesArgs,
    context: GqlContext,
  ) {
    return loadAdapterCandidatesList(context, args, { readArtifact });
  },

  review_enrichment_evidence(
    args: QueryReview_Enrichment_EvidenceArgs,
    context: GqlContext,
  ) {
    return loadEnrichmentEvidenceList(context, args, { readArtifact });
  },

  review_enrichment_queue(
    args: QueryReview_Enrichment_QueueArgs,
    context: GqlContext,
  ) {
    return loadEnrichmentQueueList(context, args, { readArtifact });
  },

  review_enrichment_targets(
    args: QueryReview_Enrichment_TargetsArgs,
    context: GqlContext,
  ) {
    return loadReviewEnrichmentTargetsList(context, args, {
      readArtifact,
    });
  },

  review_gaps(args: QueryReview_GapsArgs, context: GqlContext) {
    return loadReviewGapsList(context, args, { readArtifact });
  },

  review_profile_completeness(
    args: QueryReview_Profile_CompletenessArgs,
    context: GqlContext,
  ) {
    return loadProfileCompletenessList(context, args, { readArtifact });
  },

  async health(_args: unknown, context: GqlContext) {
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

  async opportunity_boards(
    { limit }: QueryOpportunity_BoardsArgs,
    context: GqlContext,
  ) {
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
    const boards = ranked.boards as Row;
    return {
      observed_at: ranked.observed_at,
      with_economics_count: rows.length,
      open_slots: boards["open-slots"] || [],
      cheapest_registration: boards["cheapest-registration"] || [],
      highest_emission: boards["highest-emission"] || [],
      validator_headroom: boards["validator-headroom"] || [],
      // formatLeaderboards always materializes every economic board key (possibly
      // as []), so no `|| []` fallback — that branch is unreachable here and
      // would trip codecov/patch partials on new lines (#7227).
      biggest_alpha_gain_1d: boards["biggest-alpha-gain-1d"],
      biggest_alpha_gain_7d: boards["biggest-alpha-gain-7d"],
    };
  },

  async compare(
    { netuids, dimensions }: QueryCompareArgs,
    context: GqlContext,
  ) {
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
    return loadCompareSubnets({
      profiles,
      economicsRows: parsedDimensions!.includes("economics")
        ? await loadEconomicsRows(context)
        : [],
      netuids: parsedNetuids,
      dimensions: parsedDimensions!,
      observedAt: await loadObservedAt(context),
      db: observationsReadDb(context.env, context.ctx),
    });
  },

  async incidents(
    { window, netuid, sort, order, limit, cursor }: QueryIncidentsArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/incidents
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/incidents", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    // Same METAGRAPH_HEALTH_SOURCE Postgres tier -> loadGlobalIncidentsLedger D1
    // fallback contract handleGlobalIncidents uses; the ledger is schema-stable on
    // a cold/retired tier (empty surfaces + zeroed summary), never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadGlobalIncidentsLedger(context.env, { label })).data;
    const ledger = {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      source: data.source,
      summary: data.summary ?? null,
      surfaces: data.surfaces ?? [],
    };
    // #7875: apply the same list query GET /api/v1/incidents runs over the
    // ledger's surfaces (listQueryWith("incidents", [window])) -- the netuid
    // filter plus sort/order and limit/cursor paging. applyQueryFilters is the
    // same helper the REST pipeline and the list_* MCP loaders use, so the
    // allowlists cannot drift; an unsupported sort/limit/cursor is a GraphQL
    // error rather than a silently substituted default.
    assertOptionalNetuidArgument(netuid);
    const queryUrl = new URL("https://graphql.internal/incidents");
    for (const [name, value] of [
      ["netuid", netuid],
      // `fields` was here while the rows were opaque JSON and a selection set
      // could not project them (#10065). #10214 gave them a named type, so the
      // selection set IS the projection now and the argument was removed from
      // the SDL -- the rule that `fields` belongs only where the return type
      // carries a JSON member, applied in the direction that retires one.
      ["sort", sort],
      ["order", order],
      ["limit", limit],
      ["cursor", cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    const transformed = applyQueryFilters(ledger, queryUrl, "incidents", [
      "netuid",
    ]);
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const filtered = transformed.data as Row;
    const page = ((transformed.meta as Row)?.pagination ?? {}) as Row;
    const surfaces = Array.isArray(filtered.surfaces) ? filtered.surfaces : [];
    return {
      ...ledger,
      surfaces,
      total: page.total ?? surfaces.length,
      returned: page.returned ?? surfaces.length,
      limit: page.limit ?? surfaces.length,
      cursor: page.cursor ?? 0,
      next_cursor: page.next_cursor ?? null,
      sort: page.sort ?? null,
      order: page.order ?? null,
    };
  },

  // #7643: the get_global_incidents-aligned name for the same downtime-incident
  // ledger -- a thin delegate so MCP tool names and GraphQL fields line up.
  // Identical window validation (7d/30d -> BAD_USER_INPUT), Postgres-tier ->
  // retired-store fallback, and schema-stable cold-tier degradation; nothing
  // re-derived. Distinct from endpoint_incidents (the active endpoint feed).
  async global_incidents(args: QueryGlobal_IncidentsArgs, context: GqlContext) {
    return rootValue.incidents(args, context);
  },

  // #7876: GraphQL parity for the search field's REST/MCP filters. Reuse
  // list_search's own loadSearchList loader unchanged -- the same baked
  // /metagraph/search.json read plus the q/type/netuid/sort/order/limit/cursor
  // list-query transforms REST and MCP already apply -- so the GraphQL search
  // field cannot drift from them. An unsupported filter/sort or a cold artifact
  // is a GraphQL error, matching source_snapshots/evidence/profiles.
  search(args: QuerySearchArgs, context: GqlContext) {
    return loadSearchList(context, args, { readArtifact });
  },

  // #7877: reuse loadSearchIndexList (the same loader MCP list_search_index +
  // REST GET /api/v1/search-index call) unchanged. type/netuid/q/sort/order/
  // limit/cursor validation and filtering are all handled by the loader --
  // an invalid arg throws and becomes a GraphQL error, matching every other
  // filtered field's convention (search/source_snapshots/evidence/profiles).
  search_index(args: QuerySearch_IndexArgs, context: GqlContext) {
    return loadSearchIndexList(context, args, { readArtifact });
  },

  async domains(_args: unknown, context: GqlContext) {
    // Composed live from the subnets index + economics tier (no static file),
    // via the same buildDomainOverview the REST route calls.
    const [subnetRows, economicsRows] = await Promise.all([
      loadRows(context, ARTIFACT.subnets, "subnets"),
      loadEconomicsRows(context),
    ]);
    return buildDomainOverview(subnetRows, economicsRows);
  },

  async domain_summary({ tag }: QueryDomain_SummaryArgs, context: GqlContext) {
    // The same fixed 14-tag enum ?domain= validates on subnets -- an unknown
    // tag is a GraphQL BAD_USER_INPUT error, not an empty rollup.
    if (!DOMAIN_TAGS.includes(tag)) {
      throw new GraphQLError(`tag must be one of: ${DOMAIN_TAGS.join(", ")}.`, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const [subnetRows, economicsRows] = await Promise.all([
      loadRows(context, ARTIFACT.subnets, "subnets"),
      loadEconomicsRows(context),
    ]);
    return buildDomainSummary(tag, subnetRows, economicsRows);
  },

  async compare_validators(
    { hotkeys, netuid }: QueryCompare_ValidatorsArgs,
    context: GqlContext,
  ) {
    // Same parse/validate contract the REST route + compare_validators MCP
    // tool share: 1..COMPARE_VALIDATORS_MAX distinct SS58 addresses.
    const parsed = parseCompareHotkeyList(hotkeys);
    if (!parsed) {
      throw new GraphQLError(
        `hotkeys must be a non-empty list of 1-${COMPARE_VALIDATORS_MAX} distinct valid SS58 validator addresses.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    assertOptionalNetuidArgument(netuid);
    // One detail load per hotkey via the exact Postgres-tier-or-empty path the
    // validator detail field uses -- no new data source, just the same
    // cross-subnet aggregate fetched per compared validator, then projected
    // side by side. Sequential to keep the request pattern identical to the
    // REST/MCP fan-out.
    const details = [];
    for (const hotkey of parsed) {
      details.push(
        ((await tryDataApiTier(
          context.env,
          postgresTierRequest(
            context,
            `/api/v1/validators/${encodeURIComponent(hotkey)}`,
          ),
          "METAGRAPH_NEURONS_SOURCE",
        )) as Row | null) ??
          buildValidatorDetail([], hotkey, {
            priceByNetuid: NO_ALPHA_PRICES,
          }),
      );
    }
    return composeValidatorComparison(details, { netuid: netuid ?? null });
  },

  async agent_resources(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST route + get_agent_resources MCP tool read.
    // The MCP tool raises not_found when it is absent; GraphQL degrades to
    // null instead, matching every other artifact-backed resolver here.
    return loadArtifact(context, AGENT_RESOURCES_ARTIFACT);
  },

  // #8550: full REST/MCP filter parity -- delegate to loadCurationList (the same
  // read + filter/sort/page list_curation runs over the curation artifact),
  // mirroring evidence, rather than an opaque passthrough. BREAKING: the return
  // type moves from opaque JSON to the CurationList envelope, so a consumer that
  // selected `curation` as raw JSON must now select fields. The loader validates
  // its own args and throws on an invalid filter/sort (or a cold/absent artifact);
  // that throw becomes a GraphQL error, matching provider_endpoints/evidence.
  curation(args: QueryCurationArgs, context: GqlContext) {
    return loadCurationList(context, args, { readArtifact });
  },

  async coverage({ network }: QueryCoverageArgs, context: GqlContext) {
    // Same baked artifact the REST /api/v1/coverage route + get_coverage MCP
    // tool read; GraphQL degrades to null when cold, like agent_resources.
    // Network-scoped the way `subnets` and every MCP artifact read are: the
    // testnet card lives in its own keyspace, so a `network: test` query cannot
    // be answered from mainnet's (#10394).
    return loadArtifact(
      context,
      networkArtifactPath(
        "/metagraph/coverage.json",
        (network ?? undefined) as "finney" | "test" | undefined,
      ),
    );
  },

  schemas(_args: unknown, context: GqlContext) {
    // #7866: the same baked schema-index artifact the REST /api/v1/schemas
    // route + list_schemas MCP tool read; opaque-JSON passthrough degrading to
    // null when cold, like coverage/curation above.
    return loadArtifact(context, "/metagraph/schemas/index.json");
  },

  // #10065: /api/v1/coverage-depth publishes ten query parameters and this
  // field took NONE of them -- a raw passthrough of the whole artifact, with
  // nothing to filter, project or page by. `coverage-depth` is a declared
  // query collection (API_QUERY_COLLECTIONS), so the shared applyQueryFilters
  // engine already knows its filters, sorts and projection; running that same
  // engine here is parity by construction rather than a GraphQL-only
  // reimplementation -- the shape `economics` and `incidents` already use.
  // Still degrades to null when the artifact is cold.
  async coverage_depth(args: QueryCoverage_DepthArgs, context: GqlContext) {
    const data = await loadArtifact(context, "/metagraph/coverage-depth.json");
    if (!data) return data;
    const queryUrl = new URL("https://graphql.internal/coverage-depth");
    for (const [name, value] of [
      ["netuid", args?.netuid],
      ["tier", args?.tier],
      ["agent_status", args?.agent_status],
      ["blocker_level", args?.blocker_level],
      ["q", args?.q],
      ["fields", args?.fields],
      ["sort", args?.sort],
      ["order", args?.order],
      ["limit", args?.limit],
      ["cursor", args?.cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    const transformed = applyQueryFilters(
      data as Row,
      queryUrl,
      "coverage-depth",
      [],
    );
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return transformed.data;
  },

  async subnet_volume({ netuid }: QuerySubnet_VolumeArgs, context: GqlContext) {
    assertNetuidArgument(netuid);
    // The vol/mcap ratio needs the subnet's alpha market cap, which lives in the
    // economics artifact rather than the trade stream -- same two-source shape
    // the REST route and get_subnet_volume MCP tool use.
    const economics = await loadSubnetEconomics(context, netuid);
    const marketCapTao =
      typeof economics?.alpha_market_cap_tao === "number" &&
      Number.isFinite(economics.alpha_market_cap_tao)
        ? economics.alpha_market_cap_tao
        : null;
    // The tier serves this route inside a { data } envelope (unlike the flat
    // cards), so unwrap it before falling back to the zeroed build.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (
        await loadSubnetAlphaVolumeFromArtifact(context.env, netuid, {
          marketCapTao,
        })
      )?.data ?? buildAlphaVolume([], netuid, { marketCapTao });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? null,
      buy_volume_alpha: data.buy_volume_alpha ?? 0,
      sell_volume_alpha: data.sell_volume_alpha ?? 0,
      total_volume_alpha: data.total_volume_alpha ?? 0,
      buy_volume_tao: data.buy_volume_tao ?? 0,
      sell_volume_tao: data.sell_volume_tao ?? 0,
      total_volume_tao: data.total_volume_tao ?? 0,
      buy_count: data.buy_count ?? 0,
      sell_count: data.sell_count ?? 0,
      net_volume_alpha: data.net_volume_alpha ?? 0,
      sentiment_ratio: data.sentiment_ratio ?? null,
      // THE PRODUCER (#10786), and here the compiler settles it outright.
      // `buildAlphaVolume` returns the inferred artifact type since #10782, so
      // the checker types this expression `AlphaVolumeSentiment` -- the `??`
      // has no reachable right side, on either leg. That is why the nullability
      // report does not flag it while the sibling clusters were real: it is
      // reading the same producer and can see the difference.
      //
      // Its siblings above stay `?? null` because their declared type IS
      // `number | null`; the bucket is a closed enum the builder always picks
      // from, so the card cannot be missing a reading of a ratio it has.
      sentiment: data.sentiment,
      vol_mcap_ratio: data.vol_mcap_ratio ?? null,
    };
  },

  async subnet_ohlc(
    { netuid, interval, days, limit }: QuerySubnet_OhlcArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same interval/days validation the REST route + get_subnet_ohlc MCP tool
    // apply -- out-of-contract input is a GraphQL BAD_USER_INPUT error rather
    // than a silently-clamped card.
    const intervalParam = interval ?? OHLC_INTERVAL_DEFAULT;
    if (!Object.hasOwn(OHLC_INTERVALS, intervalParam)) {
      throw new GraphQLError(
        `interval must be one of: ${Object.keys(OHLC_INTERVALS).join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const daysParam = days ?? DEFAULT_OHLC_WINDOW_DAYS;
    if (!Number.isInteger(daysParam) || daysParam < 1) {
      throw new GraphQLError("days must be a positive integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (daysParam > MAX_OHLC_WINDOW_DAYS) {
      throw new GraphQLError(`days must be at most ${MAX_OHLC_WINDOW_DAYS}.`, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // #10318: the candle ceiling is published now, so this surface has to
    // forward it -- otherwise a GraphQL caller asking for 24 candles gets the
    // route's 2,000 and the three surfaces disagree about the page.
    //
    // PARSED BY THE ROUTE'S OWN SCHEMA, not by a bound restated here.
    // `assertRouteArgs` safeParses against the same Zod object `openapi.json`
    // is emitted from, so the ceiling lives in one place and this resolver
    // cannot disagree with it. Only 8 of the 165 resolvers in this file do
    // that today and the other 250 checks are hand-written (#10313) -- adding
    // a 251st would have been the easy thing and the wrong one.
    assertRouteArgs("/api/v1/subnets/{netuid}/ohlc", { limit });
    // The published default, read back rather than restated -- the same rule
    // `pageLimit` follows for a URL, applied to a resolver's arguments.
    const limitParam =
      parseRouteArgs<{ limit?: number }>("/api/v1/subnets/{netuid}/ohlc", {
        limit,
      })?.limit ?? MAX_CANDLES;
    const params = new URLSearchParams();
    params.set("interval", intervalParam);
    params.set("days", String(daysParam));
    params.set("limit", String(limitParam));
    // The tier serves this route inside a { data, generatedAt } envelope (same
    // as subnet_volume above, unlike the flat cards), so unwrap it. Reading the
    // envelope as the payload made `candles` always undefined, so this resolver
    // answered with an empty series even when the tier had returned a full one.
    const { data } =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so that arm
      // resolved to null before it could touch DATA_API.
      // The SAME shared answer REST's handleSubnetOhlc and MCP's
      // get_subnet_ohlc use, so the three surfaces cannot disagree about a
      // subnet's candles -- nor about what a FAILED read publishes (#10312).
      await answerSubnetOhlc(context.env, netuid, {
        interval: intervalParam,
        days: daysParam,
        limit: limitParam,
      });
    // RETURNED WHOLE, like every sibling resolver that reads a shared builder.
    // This used to hand-project all six fields with a `?? fallback` each, and
    // that projection was not a safety net -- it was the defect: `candle_count:
    // data.candle_count ?? 0` would have coerced a decline's null straight back
    // to the confident zero the decline exists to stop publishing, so this
    // surface would have kept the bug after the other two were fixed. Every
    // field the SDL marks non-null is set unconditionally by both builders, so
    // there was nothing for the fallbacks to catch.
    return data;
  },

  async subnet_validator_economics_history(
    { netuid, window }: { netuid: number; window?: string | null },
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    const windowLabel = window ?? DEFAULT_VALIDATOR_ECONOMICS_HISTORY_WINDOW;
    const { data } = await buildSubnetValidatorEconomicsHistoryPayload(
      context.env,
      netuid,
      windowLabel,
    );
    return data;
  },
  async validator_economics(
    args: {
      sort?: string | null;
      limit?: number | null;
      offset?: number | null;
      emission_gate_open?: boolean | null;
      cap_binding?: boolean | null;
    },
    context: GqlContext,
  ) {
    // Same composer the REST route and the list_validator_economics MCP tool run.
    const { data } = await buildValidatorEconomicsRankingPayload(context.env, {
      sort: args.sort ?? undefined,
      limit: args.limit ?? undefined,
      offset: args.offset ?? undefined,
      emissionGateOpen: args.emission_gate_open ?? null,
      capBinding: args.cap_binding ?? null,
    });
    return data;
  },
  async subnet_validator_economics(
    { netuid }: { netuid: number },
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // The same composer the REST route and the get_subnet_validator_economics MCP
    // tool run — one derivation across all three surfaces, so they cannot drift
    // into different answers for the identical question (#9229's parity lesson).
    const { data } = await buildSubnetValidatorEconomicsPayload(
      context.env,
      netuid,
    );
    return data;
  },
  async subnet_stake_quote(
    { netuid, amount, direction }: QuerySubnet_Stake_QuoteArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    const directionParam = direction ?? "stake";
    if (!STAKE_QUOTE_DIRECTIONS.includes(directionParam)) {
      throw new GraphQLError(
        `direction must be one of: ${STAKE_QUOTE_DIRECTIONS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same pure computeStakeQuote over the live pool reserves the REST route +
    // get_subnet_stake_quote MCP tool run -- no economics logic duplicated, and
    // still strictly read-only (nothing is built, signed, or submitted).
    const economics = await loadSubnetEconomics(context, netuid);
    const result = computeStakeQuote({
      netuid,
      taoInPool: economics?.tao_in_pool_tao,
      alphaInPool: economics?.alpha_in_pool,
      amount,
      direction: directionParam,
    });
    if (!result.ok) {
      // The shared calculator's own contract errors (bad amount, dead pool)
      // surface as BAD_USER_INPUT rather than a partially-filled card.
      throw new GraphQLError(result.error, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return { schema_version: 1, ...result.quote };
  },

  async subnet_validators(
    { netuid }: QuerySubnet_ValidatorsArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetValidators([])
    // empty-snapshot fallback the REST route and list_subnet_validators share.
    // REST takes no filter params here, so neither does this mirror.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/validators`),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetValidators([], netuid);
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      validator_count: data.validator_count ?? 0,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
      validators: data.validators ?? [],
    };
  },

  async subnet_health_percentiles(
    { netuid, window }: QuerySubnet_Health_PercentilesArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/subnets/{netuid}/health/percentiles
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/subnets/{netuid}/health/percentiles", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    // Same tryDataApiTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetPercentiles
    // fallback the REST route and the get_subnet_health_percentiles MCP tool
    // share -- the tier owns the percentile computation, so nothing is
    // duplicated here, and a subnet with no probe history yields a
    // schema-stable empty surfaces list, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      await loadSubnetPercentiles(netuid, {
        window: label,
        observedAt: await loadObservedAt(context),
        db: observationsReadDb(context.env, context.ctx),
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      // NOT `?? null` (#10786). `formatPercentiles` and its siblings in
      // src/health-serving.ts stamp `source` unconditionally -- it is a literal
      // in their return object -- so the fallback was dead code left over from
      // the untyped `Row`, and it published a nullable field the route has
      // never actually answered null. Verified live: every one of these six
      // routes serves the live-cron-prober label. The one that answers null is
      // rpc-usage, and there the SCHEMA is what moved.
      source: data.source,
      surfaces: data.surfaces ?? [],
    };
  },

  async subnet_event_summary(
    { netuid, window, limit }: QuerySubnet_Event_SummaryArgs,
    context: GqlContext,
  ) {
    assertNetuidArgument(netuid);
    // Same 7d/30d/90d window set the REST route + get_subnet_event_summary MCP
    // tool accept (default 30d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent card.
    const windowParam = window ?? DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW;
    if (!Object.hasOwn(SUBNET_EVENT_SUMMARY_WINDOWS, windowParam)) {
      throw new GraphQLError(
        unsupportedWindowMessage(windowParam, SUBNET_EVENT_SUMMARY_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same 1..50 clamp (default 10) the REST route + MCP tool apply to the
    // recent-event list, so an out-of-range limit is bounded rather than
    // rejected -- matching their contract exactly.
    const limitParam =
      limit == null
        ? SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT
        : Math.min(
            Math.max(Math.trunc(limit), 1),
            SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
          );
    const params = new URLSearchParams();
    params.set("window", windowParam);
    params.set("limit", String(limitParam));
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9303: same stream, same rollup -- the non-null contract below is now
      // satisfied with real numbers rather than only with the empty shape.
      ((await loadSubnetEventSummaryColdTier(context.env, netuid, {
        window: windowParam,
        limit: limitParam,
      })) as Row | null) ??
      buildSubnetEventSummary([], [], netuid, {
        window: windowParam,
        limit: limitParam,
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      total_events: data.total_events ?? 0,
      kind_count: data.kind_count ?? 0,
      category_count: data.category_count ?? 0,
      recent_event_count: data.recent_event_count ?? 0,
      limit: data.limit ?? limitParam,
      categories: data.categories ?? [],
      event_kinds: data.event_kinds ?? [],
      recent_events: data.recent_events ?? [],
    };
  },

  async subnet_gaps(args: QuerySubnet_GapsArgs, context: GqlContext) {
    const { netuid } = args;
    assertNetuidArgument(netuid);
    // Same baked review-gaps artifact the REST route + get_subnet_gaps MCP tool
    // read; null when no report has been baked, matching how every other
    // artifact-backed resolver here treats a cold/absent artifact.
    const report = (await loadArtifact(
      context,
      `/metagraph/review/gaps/${netuid}.json`,
    )) as Row | null;
    if (!report) return null;
    // #7880: apply the same list query GET /api/v1/subnets/{netuid}/gaps runs
    // over the report's priorities (csvListQuery("review-gap-priorities", {
    // exclude: ["netuid"] })) -- curation_level/missing_kinds/review_state
    // filters plus sort/order, fields projection, and limit/cursor paging.
    // applyQueryFilters is the same helper the REST pipeline and
    // list_subnet_gaps (#7900) run on, so the allowlists cannot drift.
    //
    // The whole report is returned, with only `priorities` filtered -- the
    // envelope also carries `enrichment_queue`, which list_subnet_gaps' own
    // narrower result drops, and existing consumers still read it.
    const queryUrl = new URL("https://graphql.internal/subnets/gaps");
    for (const [name, value] of [
      ["curation_level", args?.curation_level],
      ["missing_kinds", args?.missing_kinds],
      ["review_state", args?.review_state],
      ["sort", args?.sort],
      ["order", args?.order],
      ["fields", args?.fields],
      ["limit", args?.limit],
      ["cursor", args?.cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    const transformed = applyQueryFilters(
      report,
      queryUrl,
      "review-gap-priorities",
      ["curation_level", "missing_kinds", "review_state"],
    );
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const data = transformed.data as Row;
    const page = ((transformed.meta as Row)?.pagination ?? {}) as Row;
    const priorities = Array.isArray(data.priorities) ? data.priorities : [];
    return {
      ...data,
      total: page.total ?? priorities.length,
      returned: page.returned ?? priorities.length,
      limit: page.limit ?? priorities.length,
      cursor: page.cursor ?? 0,
      next_cursor: page.next_cursor ?? null,
      sort: page.sort ?? null,
      order: page.order ?? null,
    };
  },

  async subnet_evidence(args: QuerySubnet_EvidenceArgs, context: GqlContext) {
    const { netuid } = args;
    assertNetuidArgument(netuid);
    // #7879: reuse loadSubnetEvidenceList -- the same loader MCP
    // list_subnet_evidence calls -- rather than reimplementing the
    // search/sort/page pass here, so this field cannot drift from
    // GET /api/v1/subnets/{netuid}/evidence. It reads the same baked
    // per-subnet artifact and validates every sort/limit/cursor value against
    // the REST allowlists, throwing on an unsupported one.
    try {
      return await loadSubnetEvidenceList(context, args, {
        readArtifact,
      });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      // An unsupported sort/limit/cursor is BAD_USER_INPUT, matching every
      // other field's "not a silently substituted default" convention.
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // Any other loader miss (not baked / cold R2 / unavailable) stays null,
      // preserving this field's documented cold-artifact contract --
      // loadArtifact, which this resolver used before, swallowed those the
      // same way.
      if (err?.toolError) return null;
      throw err;
    }
  },

  async subnet_candidates(
    args: QuerySubnet_CandidatesArgs,
    context: GqlContext,
  ) {
    const { netuid } = args;
    assertNetuidArgument(netuid);
    // #7878: reuse loadSubnetCandidatesList -- the same loader the
    // list_subnet_candidates MCP tool calls (#7899) -- rather than
    // reimplementing the filter/sort/page pass here, so this field cannot
    // drift from GET /api/v1/subnets/{netuid}/candidates. It reads the same
    // baked per-subnet artifact (distinct from the network-wide candidates(...)
    // catalog) and validates every filter/sort value against the REST
    // allowlists, throwing on an unsupported one; that throw surfaces as a
    // normal GraphQL error, matching the review_* family's convention.
    try {
      return await loadSubnetCandidatesList(context, args, {
        readArtifact,
      });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      // An unsupported filter/sort value is BAD_USER_INPUT, matching every
      // other field's "not a silently substituted default" convention.
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // Any other loader miss (not baked / cold R2 / unavailable) stays null,
      // preserving this field's documented cold-artifact contract --
      // loadArtifact, which this resolver used before, swallowed those the
      // same way.
      if (err?.toolError) return null;
      throw err;
    }
  },

  // #7869: reuse loadSubnetEndpointsList -- the same loader the
  // list_subnet_endpoints MCP tool calls -- rather than reimplementing the
  // filter/sort/page pass here, so this field cannot drift from
  // GET /api/v1/subnets/{netuid}/endpoints. It reads the same baked per-subnet
  // artifact (distinct from the network-wide endpoints(...) registry) and
  // validates netuid and every filter/sort value against the REST allowlists,
  // throwing on an unsupported one; that throw surfaces as a BAD_USER_INPUT
  // GraphQL error, matching the subnet_candidates sibling's convention. A cold/
  // absent per-subnet artifact stays null (the documented per-subnet contract),
  // never a silently substituted empty list.
  async subnet_endpoints(args: QuerySubnet_EndpointsArgs, context: GqlContext) {
    try {
      return await loadSubnetEndpointsList(context, args, {
        readArtifact,
        loadHealth: () => loadLiveHealth(context),
      });
    } catch (rawErr) {
      const err = rowOf(rawErr);
      // An invalid netuid or unsupported filter/sort value is BAD_USER_INPUT,
      // matching every other field's "not a silently substituted default"
      // convention.
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // Any other loader miss (not baked / cold R2 / unavailable) stays null,
      // preserving this field's documented cold-artifact contract.
      if (err?.toolError) return null;
      throw err;
    }
  },

  async subnet_health_incidents(
    { netuid, window }: QuerySubnet_Health_IncidentsArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/subnets/{netuid}/health/incidents
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/subnets/{netuid}/health/incidents", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    // Same tryDataApiTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetIncidents D1
    // fallback contract handleHealthIncidents and the get_subnet_health_incidents
    // MCP tool share -- the tier owns the gap-island incident reconstruction, so
    // nothing is duplicated here, and a subnet with no probe history yields a
    // schema-stable empty surfaces list, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      await loadSubnetIncidents(netuid, {
        window: label,
        observedAt: await loadObservedAt(context),
        db: observationsReadDb(context.env, context.ctx),
      });
    return {
      // THE PRODUCER (#10786). MIN_INCIDENT_SAMPLES is the threshold this
      // ledger APPLIES, stamped unconditionally by both of health-serving's
      // builders, so there is no arm on which `loadSubnetIncidents` omits it.
      // Nulling it dropped the caveat that says how many samples an incident
      // needed -- the confident-zeros class (#9803) by another route.
      min_incident_samples: data.min_incident_samples,
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      source: data.source,
      surfaces: data.surfaces ?? [],
    };
  },

  async extrinsics(
    {
      network,
      limit,
      offset,
      cursor,
      block,
      signer,
      call_module: callModule,
      call_function: callFunction,
      success,
      call_hash: callHash,
      block_start: blockStart,
      block_end: blockEnd,
      from,
      to,
    }: QueryExtrinsicsArgs,
    context: GqlContext,
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
    // #7872: mirror list_extrinsics' filter set — call_hash plus block_start/
    // block_end (inclusive height range) and from/to (observed_at epoch-ms
    // range), forwarded to the same /api/v1/extrinsics route. from/to are String
    // args (epoch-ms overflows GraphQL Int's 32 bits), matching account_history.
    if (callHash) params.set("call_hash", callHash);
    if (blockStart != null) params.set("block_start", String(blockStart));
    if (blockEnd != null) params.set("block_end", String(blockEnd));
    if (from != null) params.set("from", from);
    if (to != null) params.set("to", to);
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The extrinsics cold tier REST and MCP both read (#9540).
      //
      // call_hash matches INSIDE call_args, which the lakehouse cannot express,
      // so its presence skips the tier entirely rather than silently ignoring
      // the filter and serving unfiltered rows under a filtered label -- the
      // same gate REST's handleExtrinsics and MCP's list_extrinsics apply.
      ((callHash == null
        ? await loadExtrinsicFeedColdTier(
            context.env,
            {
              limit: safeLimit,
              offset: safeOffset,
              cursor,
              signer,
              module: callModule,
              callFunction,
              success,
              block,
              blockStart,
              blockEnd,
              from,
              to,
            },
            chainNetworkFromChainName(network),
          )
        : null) as Row | null) ??
      buildExtrinsicFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: rowsOf(data.extrinsics).map(extrinsicNode),
      total: data.extrinsic_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  // #7171: reuse loadChainEventsFeed (the same DATA_API path MCP
  // list_chain_events already calls). invalid_params (bad filter combo) is
  // BAD_USER_INPUT; a cold/unbound/rate-limited tier degrades to a
  // schema-stable empty feed, never a GraphQL error — matching extrinsics'
  // cold-empty convention. Distinct from Subscription.chainEvents.
  async chain_events(
    {
      pallet,
      method,
      block,
      extrinsic,
      cursor,
      before,
      limit,
      network,
    }: QueryChain_EventsArgs,
    context: GqlContext,
  ) {
    try {
      const data = await loadChainEventsFeed(
        context,
        {
          pallet,
          method,
          block,
          extrinsic,
          cursor,
          before,
          limit,
        },
        // Already validated against the published Network enum by the GraphQL
        // layer itself, so this is the translation and never the gate.
        chainNetworkFromChainName(network),
      );
      // loadChainEventsFeed always returns count/next_*/events (array); map
      // sparse event rows so every GraphQL field is present.
      return {
        count: data.count,
        next_before: data.next_before,
        next_cursor: data.next_cursor,
        events: (data.events as Row[]).map((event) => ({
          block_number: event.block_number ?? null,
          event_index: event.event_index ?? null,
          pallet: event.pallet ?? null,
          method: event.method ?? null,
          args: event.args ?? null,
          phase: event.phase ?? null,
          extrinsic_index: event.extrinsic_index ?? null,
          observed_at: event.observed_at ?? null,
          // #8525: loadChainEventsFeed's underlying rows already carry
          // summary (coerceEvent computes it once, server-side); map it
          // through the same explicit-field pattern as every other column
          // here.
          summary: event.summary ?? null,
        })),
      };
    } catch (rawErr) {
      const err = rowOf(rawErr);
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(errorMessage(rawErr), {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // tier_unavailable / data_rate_limited (and any other loader failure):
      // schema-stable empty feed, never a GraphQL error.
      return {
        count: 0,
        next_before: null,
        next_cursor: null,
        events: [],
      };
    }
  },

  // #7432: the aggregate sibling of chain_events. Reuses optionalBlocksWindow
  // (the same 1000-default/positive-integer/1-5000-cap validation MCP's
  // get_chain_activity applies) then loadChainActivity — both relocated to
  // data-api-mcp.ts beside loadChainEventsFeed.
  async chain_events_stats(
    { blocks, network }: QueryChain_Events_StatsArgs,
    context: GqlContext,
  ) {
    let window;
    try {
      window = optionalBlocksWindow({ blocks });
    } catch (rawErr) {
      // optionalBlocksWindow's only failure is invalid_params (a non-positive
      // or non-integer blocks) — surface it as BAD_USER_INPUT, mirroring how
      // chain_events maps the sibling feed's invalid-filter error.
      throw new GraphQLError(errorMessage(rawErr), {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    try {
      return await loadChainActivity(
        context,
        window,
        chainNetworkFromChainName(network),
      );
    } catch {
      // A cold/unbound/rate-limited tier degrades to a schema-stable empty
      // aggregate (echoing the validated window), never a GraphQL error —
      // matching chain_events' cold-empty convention.
      return { window_blocks: window, groups: 0, activity: [] };
    }
  },

  async sudo(
    {
      limit,
      offset,
      cursor,
      block,
      block_start: blockStart,
      block_end: blockEnd,
      from,
      to,
      call_function: callFunction,
      success,
    }: QuerySudoArgs,
    context: GqlContext,
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
    // #7874: block_start/block_end (inclusive height range) and from/to
    // (observed_at epoch-ms range) forwarded straight through to the same
    // /api/v1/sudo route get_sudo uses. from/to are String args (epoch-ms
    // overflows GraphQL Int's 32 bits), matching account_history's from/to.
    if (blockStart != null) params.set("block_start", String(blockStart));
    if (blockEnd != null) params.set("block_end", String(blockEnd));
    if (from != null) params.set("from", from);
    if (to != null) params.set("to", to);
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The extrinsics cold tier REST and MCP both read (#9540). `module` is
      // the pathname->pallet predicate data-api applies to this route
      // (SUDO_GOVERNANCE_ROUTES), expressed against the lakehouse verbatim --
      // not a filter reinvented here. from/to arrive as Strings (epoch-ms
      // overflows GraphQL Int); the loader coerces them via safeBlockNumber.
      ((await loadExtrinsicFeedColdTier(context.env, {
        limit: safeLimit,
        offset: safeOffset,
        module: "Sudo",
        cursor,
        callFunction,
        success,
        block,
        blockStart,
        blockEnd,
        from,
        to,
      })) as Row | null) ??
      buildExtrinsicFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: rowsOf(data.extrinsics).map(extrinsicNode),
      total: data.extrinsic_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  async extrinsic({ ref }: QueryExtrinsicArgs, context: GqlContext) {
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The same hot/cold cascade REST and MCP run (#9540). A composite
      // "<block>-<index>" ref routes through answerBlockDetail, so it inherits
      // the gap case -- raised, not flattened to an empty extrinsic.
      toRow(
        gapAwareBlockDetail(
          await answerExtrinsicDetail(context.env, ref, () =>
            loadExtrinsicColdTier(context.env, ref),
          ),
          () => buildExtrinsic(undefined, ref),
        ),
      );
    return {
      ref: data.ref ?? ref,
      extrinsic: extrinsicNode(rowOf(data.extrinsic)),
    };
  },

  async governance_config_changes(
    {
      limit,
      offset,
      cursor,
      block,
      call_function: callFunction,
      success,
      block_start: blockStart,
      block_end: blockEnd,
      from,
      to,
    }: QueryGovernance_Config_ChangesArgs,
    context: GqlContext,
  ) {
    if (block != null && (!Number.isInteger(block) || block < 0)) {
      throw new GraphQLError("block must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // #7873: the same block-range (block_start/block_end -> block_number) and
    // time-range (from/to -> observed_at) bounds the REST route and MCP
    // get_governance_config_changes accept. All four are parsed by the tier's
    // nonNegativeIntegerParam, so a negative value is BAD_USER_INPUT here
    // rather than being silently dropped by the tier.
    for (const [name, value] of [
      ["block_start", blockStart],
      ["block_end", blockEnd],
      ["from", from],
      ["to", to],
    ] as const) {
      if (value != null && (!Number.isInteger(value) || value < 0)) {
        throw new GraphQLError(`${name} must be a non-negative integer.`, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
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
    if (blockStart != null) params.set("block_start", String(blockStart));
    if (blockEnd != null) params.set("block_end", String(blockEnd));
    if (from != null) params.set("from", String(from));
    if (to != null) params.set("to", String(to));
    // Same DATA_API extrinsics tier as Query.extrinsics, hitting the
    // /governance/config-changes path so the worker fixes call_module=AdminUtils
    // itself (see SUDO_GOVERNANCE_ROUTES in workers/data-api.ts) -- no filter
    // logic duplicated here; the REST route and MCP tool share this exact path.
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The extrinsics cold tier REST and MCP both read (#9540). `module` is
      // the pathname->pallet predicate data-api applies to this route
      // (SUDO_GOVERNANCE_ROUTES), expressed against the lakehouse verbatim --
      // not a filter reinvented here. from/to arrive as Strings (epoch-ms
      // overflows GraphQL Int); the loader coerces them via safeBlockNumber.
      ((await loadExtrinsicFeedColdTier(context.env, {
        limit: safeLimit,
        offset: safeOffset,
        module: "AdminUtils",
        cursor,
        callFunction,
        success,
        block,
        blockStart,
        blockEnd,
        from,
        to,
      })) as Row | null) ??
      buildExtrinsicFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: rowsOf(data.extrinsics).map(extrinsicNode),
      total: data.extrinsic_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  async blocks(
    {
      network,
      limit,
      offset,
      cursor,
      author,
      spec_version: specVersion,
      block_start: blockStart,
      block_end: blockEnd,
      from,
      to,
      min_extrinsics: minExtrinsics,
      min_events: minEvents,
    }: QueryBlocksArgs,
    context: GqlContext,
  ) {
    const safeLimit = clampLimit(limit, BLOCK_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    // #7870: forward the same optional filters MCP list_blocks / GET /api/v1/blocks
    // accept, straight through to the Postgres tier (no duplicated filtering logic).
    // block_start/block_end are block heights and min_* are counts, all within Int
    // range; from/to are observed_at epoch-ms and overflow GraphQL Int's 32 bits, so
    // they are String args passed verbatim (mirroring account_history's from/to).
    if (author) params.set("author", author);
    if (specVersion != null) params.set("spec_version", String(specVersion));
    if (blockStart != null) params.set("block_start", String(blockStart));
    if (blockEnd != null) params.set("block_end", String(blockEnd));
    if (from != null) params.set("from", from);
    if (to != null) params.set("to", to);
    if (minExtrinsics != null)
      params.set("min_extrinsics", String(minExtrinsics));
    if (minEvents != null) params.set("min_events", String(minEvents));
    // #4909: blocks' D1 write path is retired and the table is dropped in
    // production, so the Postgres tier being cold is the expected steady state —
    // fall back to the same pure builder REST uses, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
      // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
      // on every request.
      // The blocks cold tier REST and MCP both read (#9540). Every filter is
      // forwarded, so the tier does the filtering -- the empty builder below
      // ignores them, which is why reaching it silently dropped a filtered
      // query's meaning as well as its rows.
      ((await loadBlockFeedColdTier(
        context.env,
        {
          limit: safeLimit,
          offset: safeOffset,
          cursor,
          author,
          specVersion,
          blockStart,
          blockEnd,
          from,
          to,
          minExtrinsics,
          minEvents,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
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

  async blocks_summary(
    { network }: QueryBlocks_SummaryArgs,
    context: GqlContext,
  ) {
    // #5664: same projection -> buildBlocksSummary([]) fallback contract
    // handleBlocksSummary uses. blocks' D1 write path is retired (#4909) and the
    // Postgres tier that briefly replaced it is retired too (#10190), so the
    // empty builder shape (block_count 0, every aggregate null) satisfies the
    // non-null BlocksSummary! contract, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
      // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
      // on every request.
      // #9146: same blocks-summary projection REST and MCP read -- on the SAME
      // chain as the tier above, because a fallback that changed network would
      // answer mainnet under a testnet label (#10394).
      ((await loadBlocksSummaryFromArtifact(
        context.env,
        chainNetworkFromChainName(network),
      )) as Row | null) ?? buildBlocksSummary([]);
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

  async runtime(_args: unknown, context: GqlContext) {
    // Same cold-tier -> buildRuntimeVersionHistory([]) fallback contract
    // GET /api/v1/runtime and the get_runtime MCP tool use; blocks' store write
    // path is retired (#4909) and the Postgres tier that replaced it is retired
    // too (#10190) -- the empty builder shape (transition_count 0,
    // current_spec_version null) satisfies the non-null RuntimeVersionHistory!
    // contract, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
      // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
      // on every request.
      // #9265: `chain.blocks` carries the same spec_version column, so the
      // non-null contract below is now satisfied with the real timeline
      // rather than only with the empty shape.
      ((await loadRuntimeVersionHistoryColdTier(context.env)) as Row | null) ??
      buildRuntimeVersionHistory([]);
    return {
      // THE PRODUCER (#10786). `coverage_complete` is `gaps.length === 0` and
      // `coverage_gaps` is the array it counted -- buildRuntimeVersionHistory
      // computes both from the same pass and the cold reader returns its card,
      // so no arm omits them. These two are the caveat that says whether the
      // timeline has holes; nulling them left the transitions readable and the
      // warning about them gone (#9803).
      coverage_complete: data.coverage_complete,
      coverage_gaps: data.coverage_gaps,
      // PARITY, not a new capability (#10790): /api/v1/runtime has composed
      // the radar beside the timeline since #8702 and this field served the
      // timeline alone, so a GraphQL caller could read where the chain HAS
      // been and not where it is going.
      //
      // A THUNK, so it costs nothing unless it is SELECTED. graphql-js's
      // default resolver calls a function-valued property only when the field
      // is in the query, and this one is not free on a cold KV: it reads a
      // spec version off each chain. Awaiting it here instead made every
      // `runtime { transition_count }` pay for a radar nobody asked for.
      current: () => loadUpgradeRadar(context.env),
      schema_version: data.schema_version ?? 1,
      transitions: data.transitions || [],
      transition_count: data.transition_count ?? 0,
      current_spec_version: data.current_spec_version ?? null,
      coverage_from_block: data.coverage_from_block ?? null,
      coverage_from_at: data.coverage_from_at ?? null,
    };
  },

  async block({ ref, network }: QueryBlockArgs, context: GqlContext) {
    const chain = chainNetworkFromChainName(network);
    const data =
      // NO TIER READ (#10190): METAGRAPH_BLOCKS_SOURCE is retired in every deployed
      // config and absent from FORWARDABLE_TIER_FLAGS, so this arm resolved to null
      // on every request.
      // The block cold tier REST and MCP both read (#9540), on the SAME chain
      // as the tier above (#10394).
      ((await loadBlockColdTier(context.env, ref, chain)) as Row | null) ??
      buildBlock(undefined, ref);
    return {
      // THE PRODUCER (#10786). `loadBlockColdTier` and `buildBlock` both stamp
      // the envelope version, so this never had a second arm to take -- and a
      // null schema_version is not a value any client can read.
      schema_version: data.schema_version,
      ref: data.ref ?? ref,
      block: data.block ?? null,
      prev_block_number: data.prev_block_number ?? null,
      next_block_number: data.next_block_number ?? null,
    };
  },

  // #6977: block-scoped extrinsics/events/chain-events lists, mirroring the same
  // Postgres tier + schema-stable fallback builder REST and MCP already use. The
  // /blocks/:ref/{extrinsics,events} routes wrap their body in `{ data }` (unlike
  // the flat /blocks/:ref route), so the tier result is destructured accordingly.
  async block_extrinsics(
    { ref, limit, offset, network }: QueryBlock_ExtrinsicsArgs,
    context: GqlContext,
  ) {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.min(100, Math.floor(limit)))
        : 50;
    const safeOffset =
      typeof offset === "number" && Number.isFinite(offset)
        ? Math.max(0, Math.floor(offset))
        : 0;
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    const { data } =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      {
        // The hot/cold cascade REST and MCP both run (#9540). Not a plain loader:
        // a ref can land in the GAP between the decoded seam and the hot window,
        // and that is a decline, not an empty -- REST answers it 503
        // block_detail_unavailable and MCP throws. Returning the empty builder
        // there would state "this block has no extrinsics", which is the confident
        // zero this whole change exists to remove.
        data: gapAwareBlockDetail(
          await answerBlockDetail(
            context.env,
            ref,
            {
              hot: (height) =>
                loadBlockExtrinsicsHotTier(context.env, ref, height, {
                  limit: safeLimit,
                  offset: safeOffset,
                }),
              // #10394: the network reaches the COLD leg too. It was passed to
              // answerBlockDetail (which uses it to skip the mainnet-only hot
              // tier) but not to the reader underneath, so `network: test`
              // skipped mainnet's hot tier and then read mainnet's lakehouse --
              // an answer labelled testnet built from mainnet rows. Hidden until
              // now because the test asserted the path of a tier that never
              // answered (#10190).
              cold: () =>
                loadBlockExtrinsicsColdTier(
                  context.env,
                  ref,
                  { limit: safeLimit, offset: safeOffset },
                  chainNetworkFromChainName(network),
                ),
              isEmpty: isEmptyExtrinsicPayload,
              coldCoverageTable: "extrinsics",
            },
            // Off mainnet `answerBlockDetail` skips the hot tier entirely --
            // blocks_head and the whole hot path are written by the mainnet
            // firehose poller and carry no network column -- so a testnet ref
            // resolves from that chain's lakehouse instead of being looked up in
            // mainnet's store (#10394).
            chainNetworkFromChainName(network),
          ),
          () =>
            buildBlockExtrinsics([], ref, null, {
              limit: safeLimit,
              offset: safeOffset,
            }),
        ),
      };
    return data;
  },

  async block_events(
    { ref, limit, offset, network }: QueryBlock_EventsArgs,
    context: GqlContext,
  ) {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.min(1000, Math.floor(limit)))
        : 100;
    const safeOffset =
      typeof offset === "number" && Number.isFinite(offset)
        ? Math.max(0, Math.floor(offset))
        : 0;
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    const { data } =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      {
        // The hot/cold cascade REST and MCP both run (#9540). Not a plain loader:
        // a ref can land in the GAP between the decoded seam and the hot window,
        // and that is a decline, not an empty -- REST answers it 503
        // block_detail_unavailable and MCP throws. Returning the empty builder
        // there would state "this block has no events", which is the confident
        // zero this whole change exists to remove.
        data: gapAwareBlockDetail(
          await answerBlockDetail(
            context.env,
            ref,
            {
              hot: (height) =>
                loadBlockEventsHotTier(context.env, ref, height, {
                  limit: safeLimit,
                  offset: safeOffset,
                }),
              // #10394, same as block_extrinsics above: the cold leg needs the
              // network or a testnet ref resolves out of mainnet's lakehouse.
              cold: () =>
                loadBlockEventsColdTier(
                  context.env,
                  ref,
                  { limit: safeLimit, offset: safeOffset },
                  chainNetworkFromChainName(network),
                ),
              isEmpty: isEmptyEventPayload,
              coldCoverageTable: "account_events",
            },
            // Off mainnet `answerBlockDetail` skips the hot tier entirely --
            // blocks_head and the whole hot path are written by the mainnet
            // firehose poller and carry no network column -- so a testnet ref
            // resolves from that chain's lakehouse instead of being looked up in
            // mainnet's store (#10394).
            chainNetworkFromChainName(network),
          ),
          () =>
            buildBlockEvents([], ref, null, {
              limit: safeLimit,
              offset: safeOffset,
            }),
        ),
      };
    return data;
  },

  // Reuses loadBlockChainEvents (the get_block_chain_events tool's own loader);
  // it throws invalid_params on a bad block_number and tier_unavailable where
  // the tiers do not cover the height -- both surface as normal GraphQL errors.
  block_chain_events(
    { block_number: blockNumber, network }: QueryBlock_Chain_EventsArgs,
    context: GqlContext,
  ) {
    return loadBlockChainEvents(
      context,
      blockNumber,
      chainNetworkFromChainName(network),
    );
  },

  async validators(
    { sort, limit, cursor }: QueryValidatorsArgs,
    context: GqlContext,
  ) {
    const requestedSort = sort ?? DEFAULT_GLOBAL_VALIDATOR_SORT;
    if (!GLOBAL_VALIDATOR_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${GLOBAL_VALIDATOR_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same leaderboard computation REST/MCP use; fetch the max REST window once,
    // then paginate in-process like providers/economics (cursor keyed by hotkey).
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(GLOBAL_VALIDATOR_LIMIT_MAX));
    const data = overlayFeaturedValidators(
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/validators", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
        buildGlobalValidators([], {
          sort: requestedSort,
          limit: GLOBAL_VALIDATOR_LIMIT_MAX,
          priceByNetuid: NO_ALPHA_PRICES,
        }),
    )! as Row;
    const nodes = rowsOf(data.validators).map(validatorNode);
    const { page, total, nextCursor } = paginate(
      nodes,
      limit,
      cursor,
      (v: Row) => v.hotkey,
    );
    return {
      items: page,
      total: data.validator_count ?? total,
      next_cursor: nextCursor,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async validator_nominators(
    {
      hotkey,
      window,
      basis,
      sort,
      coldkey,
      limit,
      offset,
    }: QueryValidator_NominatorsArgs,
    context: GqlContext,
  ) {
    // Same window/sort allow-lists handleValidatorNominators validates against --
    // an unsupported value is a GraphQL BAD_USER_INPUT error, not a silently
    // substituted default. `sort` is optional: omitted resolves to
    // DEFAULT_NOMINATOR_SORT inside the builder, so only a SUPPLIED bad value errors.
    // #10065: the same two questions the REST route answers. `positions` is a
    // current-holdings snapshot off the position ledger and `flow` a windowed
    // aggregation, so window/sort mean nothing under `positions` -- accepting
    // them silently would imply the basis honoured them, which is the exact
    // condition handleValidatorNominators rejects with.
    const requestedBasis = basis ?? DEFAULT_NOMINATOR_BASIS;
    if (!NOMINATOR_BASES.includes(requestedBasis as "flow" | "positions")) {
      throw new GraphQLError(
        `basis must be one of ${NOMINATOR_BASES.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    if (requestedBasis === "positions") {
      for (const [name, value] of [
        ["window", window],
        ["sort", sort],
      ] as const) {
        if (value != null) {
          throw new GraphQLError(
            `"${name}" applies to basis=flow only; the positions basis is a ` +
              "current-holdings snapshot, not a windowed aggregation.",
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }
      // Through readStore, matching the REST route's own call in
      // workers/request-handlers/entities.ts (#10179). This resolver was the
      // last reader still handed the raw binding, so it kept asking the store
      // the alpha-pricing tables had already left -- and a frozen table answers
      // with a schema-stable wrong number rather than an error.
      const positions = await loadNominatorPositions(
        readStore(context.env, ALPHA_PRICING_TABLES),
        hotkey,
      );
      return buildNominatorPositions(positions, hotkey, {
        limit: limit ?? GLOBAL_VALIDATOR_LIMIT_DEFAULT,
        offset: offset ?? 0,
      });
    }
    const requestedWindow = window ?? DEFAULT_NOMINATOR_WINDOW;
    // #7884: narrow to one nominator, mirroring the REST route's `coldkey` query
    // param + MCP get_validator_nominators. A supplied non-SS58 value is a
    // BAD_USER_INPUT error (same guard MCP applies), not a silent no-op. The
    // filter is applied at the Postgres tier's SQL WHERE, so it only needs to
    // ride the request params; the empty-rows builder fallback is unaffected.
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    if (sort != null) params.set("sort", sort);
    if (coldkey != null) params.set("coldkey", coldkey);
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildValidatorNominators
    // fallback contract REST uses. The Postgres tier's response is a REST-style
    // { data, generatedAt } envelope, so only its `.data` is taken; `generatedAt` is
    // REST envelope meta with no GraphQL field to carry it. A hotkey with no
    // nominators yields a schema-stable empty list, never a GraphQL error. limit/offset
    // ride the same request params REST parses (#8547); an omitted arg uses the
    // module's own default (20/0). #4772 D1
    // retirement: the `account_events` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live store query.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The SAME lakehouse reader REST's handleValidatorNominators and MCP's
      // get_validator_nominators fall to, so the three surfaces cannot
      // disagree about who is behind a validator. An omitted limit/offset
      // takes the module's own REST defaults here rather than the builder's,
      // because the reader needs a concrete SQL LIMIT.
      ((
        await loadValidatorNominatorsColdTier(context.env, hotkey, {
          window: requestedWindow,
          sort,
          limit: limit ?? GLOBAL_VALIDATOR_LIMIT_DEFAULT,
          offset: offset ?? 0,
          coldkey,
        })
      )?.data as Row | undefined) ??
      buildValidatorNominators([], hotkey, {
        window: requestedWindow,
        sort: sort ?? undefined,
        limit: limit ?? undefined,
        offset: offset ?? undefined,
      });
    return {
      // THE PRODUCER (#10786). This is the caveat that says whether the three
      // shares below were computed over the WHOLE nominator set, and both legs
      // answer it unconditionally -- the cold reader's card and
      // buildValidatorNominators alike. Nulling it left `nominator_gini`
      // quotable with nothing saying it was computed over a partial set.
      concentration_complete: data.concentration_complete,
      top_nominator_share: data.top_nominator_share ?? null,
      top5_nominator_share: data.top5_nominator_share ?? null,
      nominator_gini: data.nominator_gini ?? null,
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

  async validator({ hotkey }: QueryValidatorArgs, context: GqlContext) {
    const data = await tryDataApiTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/validators/${encodeURIComponent(hotkey)}`,
      ),
      "METAGRAPH_NEURONS_SOURCE",
    );
    return validatorDetailNode(data as Row, hotkey);
  },

  async validator_history(
    { hotkey, window, netuid }: QueryValidator_HistoryArgs,
    context: GqlContext,
  ) {
    // Same parseHistoryWindow REST's handleValidatorHistory uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label, days } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // #9383: the same optional netuid scope the REST route and the MCP tool take.
    // Validated as a u16 here for the reason the sibling resolvers do it -- a bad
    // netuid is an input error, not a silently unscoped series that looks like data.
    if (netuid != null) {
      if (!isU16Netuid(netuid)) {
        throw new GraphQLError("netuid must be a u16 subnet id (0-65535).", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      params.set("netuid", String(netuid));
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildValidatorHistory
    // fallback contract handleValidatorHistory uses; a hotkey with no
    // neuron_daily rows in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const hot =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildValidatorHistory([], hotkey, {
        window: label,
        netuid: netuid ?? null,
      });
    // The cold leg, third surface. Needs chain.subnet_snapshots as well as
    // chain.neuron_daily, because the TAO pricing is a join.
    const data = await overlayValidatorHistoryColdTier(
      context.env as Env,
      hot,
      hotkey,
      netuid ?? null,
      { label, days },
    );
    return {
      take_u16: data.take_u16 ?? null,
      take_last_changed_date: data.take_last_changed_date ?? null,
      next_take_change_eligible_date:
        data.next_take_change_eligible_date ?? null,
      // THE PRODUCER (#10786). This flag is the whole reason a null
      // `take_last_changed_date` is readable -- it separates "the take has not
      // changed" from "we cannot see whether it changed" -- and
      // overlayValidatorHistoryColdTier answers it on every leg. Nulling it
      // erased the distinction the field exists to draw.
      take_change_observable: data.take_change_observable,
      schema_version: data.schema_version ?? 1,
      hotkey: data.hotkey ?? hotkey,
      window: data.window ?? label,
      netuid: (data.netuid as number | null) ?? null,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async account_position_history(
    { ss58, netuid, window }: QueryAccount_Position_HistoryArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
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
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label, days } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountPositionHistory
    // fallback contract the REST handler uses; an account with no neuron_daily
    // rows for the subnet in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const hot =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/subnets/${netuid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildAccountPositionHistory([], ss58, netuid, { window: label });
    // See the validator resolver: same seam, same reason to wire every surface.
    const data = await overlayAccountPositionHistoryColdTier(
      context.env as Env,
      hot as ReturnType<typeof buildAccountPositionHistory>,
      ss58,
      netuid,
      { label, days },
    );
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async accounts({ sort, limit }: QueryAccountsArgs, context: GqlContext) {
    const requestedSort = sort ?? DEFAULT_ACCOUNTS_LIST_SORT;
    const safeLimit = clampLimit(limit, {
      defaultLimit: ACCOUNTS_LIST_LIMIT_DEFAULT,
      maxLimit: ACCOUNTS_LIST_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(safeLimit));
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/accounts", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildAccountsList([], {
        sort: requestedSort,
        limit: safeLimit,
        priceByNetuid: NO_ALPHA_PRICES,
      });
    return {
      items: data.accounts || [],
      total: data.account_count ?? 0,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async account({ ss58 }: QueryAccountArgs, context: GqlContext) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in wrangler.jsonc
    // and is absent from FORWARDABLE_TIER_FLAGS, so the tier read this branch
    // guarded resolved to null before it could touch DATA_API.
    // #9254/#9263: the SAME composition REST and MCP run. The zeroed card stays
    // the answer only where there is no tier to ask at all; a tier that exists
    // and could not answer raises, because a card reading zero events for an
    // account whose own events field would return 100 is a wrong answer, not a
    // degraded one.
    const answer = await answerAccountSummary(context.env, ss58);
    if (answer?.kind === "gap") {
      throw new GraphQLError(accountSummaryGapMessage(ss58, answer.reasons), {
        // #9386: the decline names which leg failed, so a client sees the same
        // diagnosis REST and MCP get rather than a bare code.
        extensions: {
          code: ACCOUNT_SUMMARY_GAP_CODE,
          reasons: answer.reasons,
        },
      });
    }
    // Both changes: #10802's toRow() typing over the tier deletion's shape, plus
    // the entity-label join below.
    const data =
      answer?.kind === "answer"
        ? toRow(answer.data)
        : toRow(buildAccountSummary(ss58, {}));
    // #6739's entity labels, joined HERE. handleAccount and get_account both do
    // this join; this resolver never did -- it read `labels` out of the Postgres
    // tier's own payload, which is where data-api put them. That flag reads
    // "retired" and cannot forward (#10190), so `account.labels` has been null
    // over GraphQL while REST served the same account's exchange label. The
    // enumerated return shape is exactly what #10214 was about.
    //
    // A missing or cold artifact degrades to an empty list, matching the
    // never-404 contract the sibling surfaces keep.
    const entitiesArtifact = await readArtifact(
      context.env,
      ENTITY_LABELS_ARTIFACT,
    );
    return accountSummaryNode(
      {
        ...data,
        labels: labelsForSs58(
          entityLabelsIndex(
            // rowsOf, not a bare property read: a cold or malformed artifact can
            // put a non-array under `entities`, and #10782's typing is what
            // makes that visible here rather than at the first `.map`.
            entitiesArtifact.ok
              ? rowsOf(rowOf(entitiesArtifact.data)?.entities)
              : [],
          ),
          ss58,
        ),
      },
      ss58,
    );
  },

  async account_prometheus(
    { ss58, window }: QueryAccount_PrometheusArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_PROMETHEUS_WINDOW;
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // This account-footprint route's Postgres-tier body is { data, generatedAt }
    // (unlike account's own flat body) -- same shape REST's makeAccountEventHandler
    // destructures. No live store fallback exists for this route family (the account
    // event footprints' D1 write path is retired); a cold/absent tier degrades to
    // the pure builder over an empty row set, same as REST's own fallback.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #10322: the same cold-tier rung REST's handleAccountPrometheus gained.
      // Without it this resolver answered a confident zero for every account.
      ((
        await loadAccountPrometheusColdTier(context.env, ss58, {
          window: requestedWindow,
        })
      )?.data as Row | undefined) ??
      buildAccountPrometheus([], ss58, { window: requestedWindow });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? requestedWindow,
      total_announcements: data.total_announcements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: data.subnets || [],
      // Preserve the shared loader's source-availability verdict.
      degraded: data.degraded ?? null,
    };
  },

  async account_stake_flow(
    { ss58, window, direction }: QueryAccount_Stake_FlowArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_STAKE_FLOW_WINDOW;
    // No direction guard here -- same reasoning as subnet_stake_flow above:
    // the dispatch validator rejects against the published enum first (#10065),
    // and the copy this replaces was unreachable.
    const requestedDirection = direction ?? DEFAULT_STAKE_FLOW_DIRECTION;
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("direction", requestedDirection);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data, generatedAt }
    // -> buildAccountStakeFlow([]) zeroed-card fallback contract handleAccountStakeFlow
    // uses. direction only narrows the live Postgres-tier query -- the fallback builder
    // takes no direction argument, so a cold/absent tier degrades to the same zeroed
    // card regardless of the requested direction.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540); the loader
      // returns the same { data } envelope the retired tier did.
      ((
        (await loadAccountStakeFlowColdTier(context.env, ss58, {
          window: requestedWindow,
          direction: requestedDirection,
        })) as Row | null
      )?.data as Row | undefined) ??
      buildAccountStakeFlow([], ss58, { window: requestedWindow });
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

  async account_portfolio(
    { ss58 }: QueryAccount_PortfolioArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountPortfolio([])
    // fallback contract handleAccountPortfolio uses. This route's Postgres-tier
    // body is flat (like `account`'s own), not the { data, generatedAt } envelope
    // the account-event-footprint family uses.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/portfolio`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildAccountPortfolio([], ss58, {
        priceByNetuid: NO_ALPHA_PRICES,
      });
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

  async account_positions(
    { ss58 }: QueryAccount_PositionsArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Hot store -> lakehouse cold tier -> labelled empty card, which is the
    // chain REST's handleAccountPositions and MCP's get_account_positions both
    // resolve. The cold-tier reader is the SAME one they fall to, so the three
    // surfaces cannot disagree about what a coldkey holds. Flat body (like
    // account_portfolio's), not the { data, generatedAt } envelope the
    // account-event-footprint family uses.
    //
    // NO DATA_API LEG, and this was the SECOND one. #11290 removed it from the
    // REST handler after measuring that DATA_API has no branch for
    // /accounts/:ss58/positions -- 55 of 55 captured neurons-tier declines were
    // that single path -- and this resolver kept its own copy, so the tier
    // fallbacks carried on: 09:11Z, 09:17Z and 10:04Z on 2026-08-15, all after
    // the REST fix deployed at 09:54Z. The comment here even asserted parity
    // with a handler that had stopped forwarding, which is how a duplicated
    // contract goes stale without anything failing.
    //
    // Checked exhaustively rather than by handler this time: of the 36 distinct
    // paths any caller hands `postgresTierRequest`, this is the only one
    // DATA_API's dispatcher does not claim. Two surfaces named it; both are
    // now off it.
    const data =
      ((await loadAccountPositionsFromStore(
        context.env,
        ss58,
      )) as Row | null) ??
      ((await loadAccountPositionsColdTier(context.env, ss58)) as Row | null) ??
      unavailableAccountPositions(ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      captured_at: data.captured_at ?? null,
      position_count: data.position_count ?? 0,
      total_stake_alpha: data.total_stake_alpha ?? 0,
      positions: data.positions || [],
      // The caveat that makes the zero readable. unavailableAccountPositions
      // sets this (`positions_unpriceable` / `tier_unavailable` /
      // `snapshot_predates_stake_activity`), and enumerating the return shape
      // dropped it -- so GraphQL served `position_count: 0` with nothing to
      // distinguish "holds nothing" from "we could not price what it holds".
      // REST and MCP both carry it (#9803); this is the same fix for the third
      // surface.
      degraded: data.degraded ?? null,
    };
  },

  async account_subnets(
    { ss58 }: QueryAccount_SubnetsArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountSubnets([])
    // fallback contract the REST route (/accounts/{ss58}/subnets) and the
    // get_account_subnets MCP tool use -- a flat body (like account_portfolio's),
    // not the { data, generatedAt } envelope the account-event footprint family
    // uses. An unregistered address is a schema-stable empty card, never null.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/subnets`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildAccountSubnets([], ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      subnet_count: data.subnet_count ?? 0,
      subnets: data.subnets || [],
    };
  },

  async account_registrations(
    { ss58, window }: QueryAccount_RegistrationsArgs,
    context: GqlContext,
  ) {
    // Same SS58 + window validation handleAccountRegistrations (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_REGISTRATION_WINDOW;
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountRegistrations([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no NeuronRegistered events in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540); the loader
      // returns the same { data } envelope the retired tier did.
      ((
        (await loadAccountRegistrationsColdTier(context.env, ss58, {
          window: windowParam,
        })) as Row | null
      )?.data as Row | undefined) ??
      buildAccountRegistrations([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_registrations: data.total_registrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: rowsOf(data.subnets).map((s: Row) => ({
        netuid: s.netuid,
        registrations: s.registrations,
        first_registered_at: s.first_registered_at ?? null,
        last_registered_at: s.last_registered_at ?? null,
      })),
    };
  },

  async account_deregistrations(
    { ss58, window }: QueryAccount_DeregistrationsArgs,
    context: GqlContext,
  ) {
    // Same SS58 + window validation handleAccountDeregistrations (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_DEREGISTRATION_WINDOW;
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountDeregistrations([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no derived deregistration in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9307: an account's deregistrations are the slots where it was the
      // PREVIOUS holder, derived from UID reuse — the same reader REST's
      // handleAccountDeregistrations uses, then the same MARKED empty.
      ((
        await loadAccountDeregistrationsFromArtifact(context.env, ss58, {
          window: windowParam,
        })
      )?.data as Row | undefined) ??
      toRow(
        markDeregistrationsNotDerived(
          buildAccountDeregistrations([], ss58, { window: windowParam }),
        ),
      );
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_deregistrations: data.total_deregistrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: rowsOf(data.subnets).map((s: Row) => ({
        netuid: s.netuid,
        deregistrations: s.deregistrations,
        first_deregistered_at: s.first_deregistered_at ?? null,
        last_deregistered_at: s.last_deregistered_at ?? null,
      })),
      derivation: data.derivation ?? null,
      degraded: data.degraded ?? null,
    };
  },

  async account_serving(
    { ss58, window }: QueryAccount_ServingArgs,
    context: GqlContext,
  ) {
    // Same SS58 + window validation handleAccountServing (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_SERVING_WINDOW;
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountServing([], ...) zeroed-card cold fallback) the REST
    // handler uses; an account with no AxonServed events in the window is a
    // schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540); the loader
      // returns the same { data } envelope the retired tier did.
      ((
        (await loadAccountServingColdTier(context.env, ss58, {
          window: windowParam,
        })) as Row | null
      )?.data as Row | undefined) ??
      buildAccountServing([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_announcements: data.total_announcements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: rowsOf(data.subnets).map((s: Row) => ({
        netuid: s.netuid,
        announcements: s.announcements,
        first_served_at: s.first_served_at ?? null,
        last_served_at: s.last_served_at ?? null,
      })),
    };
  },

  async account_axon_removals(
    { ss58, window }: QueryAccount_Axon_RemovalsArgs,
    context: GqlContext,
  ) {
    // Same SS58 + window validation handleAccountAxonRemovals (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_AXON_REMOVAL_WINDOW;
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountAxonRemovals([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no AxonInfoRemoved events in the window
    // is a schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    // DERIVED FROM STATE (#10805), the same rollup REST and MCP read.
    const removalsRollup = await loadAxonRemovals(context.env);
    const data = buildAccountAxonRemovals(
      accountAxonRemovalRows(removalsRollup, ss58) ?? [],
      ss58,
      { window: windowParam },
    );
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_removals: data.total_removals ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: rowsOf(data.subnets).map((s: Row) => ({
        netuid: s.netuid,
        removals: s.removals,
        first_removed_at: s.first_removed_at ?? null,
        last_removed_at: s.last_removed_at ?? null,
      })),
      // #9307: AxonInfoRemoved has zero occurrences in the complete stream,
      // ever, so this footprint's zero has never measured this account.
      degraded: data.degraded ?? null,
    };
  },

  async account_stake_moves(
    { ss58, window }: QueryAccount_Stake_MovesArgs,
    context: GqlContext,
  ) {
    // Same SS58 + window validation handleAccountStakeMoves (via
    // makeAccountEventHandler) uses -- a malformed address or unsupported
    // window is a GraphQL BAD_USER_INPUT error, not a silent card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const windowParam = window ?? DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW;
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } envelope
    // (with the buildAccountStakeMoves([], ...) zeroed-card cold fallback) the
    // REST handler uses; an account with no StakeMoved events in the window is a
    // schema-stable zeroed card, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540); the loader
      // returns the same { data } envelope the retired tier did.
      ((
        (await loadAccountStakeMovesColdTier(context.env, ss58, {
          window: windowParam,
        })) as Row | null
      )?.data as Row | undefined) ??
      buildAccountStakeMoves([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_movements: data.total_movements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: rowsOf(data.subnets).map((s: Row) => ({
        netuid: s.netuid,
        movements: s.movements,
        first_moved_at: s.first_moved_at ?? null,
        last_moved_at: s.last_moved_at ?? null,
        price_tao_at_last_move: s.price_tao_at_last_move ?? null,
      })),
    };
  },

  async account_weight_setters(
    { ss58, window }: QueryAccount_Weight_SettersArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW;
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data, generatedAt }
    // envelope handleAccountWeightSetters (makeAccountEventHandler) uses; a cold
    // or absent tier degrades to buildAccountWeightSetters' own zeroed card.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540); the loader
      // returns the same { data } envelope the retired tier did.
      ((
        (await loadAccountWeightSettersColdTier(context.env, ss58, {
          window: requestedWindow,
        })) as Row | null
      )?.data as Row | undefined) ??
      buildAccountWeightSetters([], ss58, { window: requestedWindow });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? requestedWindow,
      total_weight_sets: data.total_weight_sets ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: data.subnets || [],
    };
  },

  async account_entities(
    { ss58 }: QueryAccount_EntitiesArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same R2 entities.json + Postgres-tier ownership join handleAccountEntities
    // uses (workers/request-handlers/entities.ts): the entity-label artifact
    // read and the SubnetOwnerChanged ownership-tie lookup are independent
    // sources, fetched in parallel. A cold/absent Postgres tier degrades to
    // buildAccountEntities' own zeroed card; a cold/absent R2 artifact degrades
    // to an empty labels list.
    // NO TIER READ (#10190). METAGRAPH_SUBNET_OWNERSHIP_SOURCE reads "retired"
    // in every deployed config and is absent from FORWARDABLE_TIER_FLAGS, so
    // tryDataApiTier resolved to null on every request -- a subrequest that
    // could not be made, awaited on the critical path. The composer's own
    // lakehouse leg is what has been answering; it is now asked with no tier
    // result rather than one that never arrives.
    const entitiesArtifact = await readArtifact(
      context.env,
      ENTITY_LABELS_ARTIFACT,
    );
    // Through the composer (src/account-entities-answer.ts): it owns the tier
    // order and the empty floor, so this resolver cannot drift from REST/MCP
    // the way it did while the lakehouse leg lived in entities.ts alone.
    const data = await answerAccountEntities(context.env, ss58, null);
    const labels = labelsForSs58(
      entityLabelsIndex(
        entitiesArtifact.ok
          ? rowsOf(rowOf(entitiesArtifact.data)?.entities)
          : [],
      ),
      ss58,
    );
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      labels,
      ownership_tie_count: data.ownership_tie_count ?? 0,
      ownership_ties: data.ownership_ties || [],
      // #9313: this object is built field by field, so a new one on the
      // composer does NOT arrive here by itself -- it would resolve to null on
      // every request, which for this field means "we could not read who owns
      // what". Defaulted to null explicitly rather than left out, because that
      // is the honest value when the composer genuinely had no snapshot.
      owners_observed_at: data.owners_observed_at ?? null,
    };
  },

  async account_identity(
    { ss58 }: QueryAccount_IdentityArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // D1 retirement: account_identity's D1 write/read path is fully retired
    // (2026-07-16). Most accounts have never called set_identity, so a
    // row-less account is already the common case: has_identity:false with
    // every field null, never a GraphQL error -- a Postgres miss/outage
    // degrades to that exact same schema-stable shape, never a live store read.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/identity`,
        ),
        "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
      )) as Row | null) ?? buildAccountIdentity(null, ss58);
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

  async account_identity_history(
    { ss58, limit, offset, cursor }: QueryAccount_Identity_HistoryArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed
    // address is a GraphQL BAD_USER_INPUT error, not a silent empty timeline.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // D1 retirement: account_identity_history's D1 write/read path is fully
    // retired (2026-07-16), forwarding limit/offset/cursor as query params --
    // an address with no identity-history rows is a schema-stable empty
    // timeline, never a GraphQL error, and a Postgres miss/outage now
    // degrades to that same shape, never a live store read.
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));
    if (cursor != null) params.set("cursor", cursor);
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/identity-history`,
          params,
        ),
        "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
      )) as Row | null) ??
      buildAccountIdentityHistory([], ss58, {
        limit,
        offset,
        nextCursor: null,
      });
    return {
      schema_version: data.schema_version ?? 1,
      account: data.account ?? ss58,
      entry_count: data.entry_count ?? 0,
      limit: data.limit ?? null,
      offset: data.offset ?? null,
      next_cursor: data.next_cursor ?? null,
      entries: rowsOf(data.entries).map((e: Row) => ({
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

  async account_counterparties(
    { ss58, counterparty, limit }: QueryAccount_CounterpartiesArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty card.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // The relationship drilldown needs a second, distinct SS58 -- the same two
    // guards the get_account_counterparties MCP tool applies to `counterparty`.
    if (counterparty != null) {
      if (counterparty === ss58) {
        throw new GraphQLError("counterparty must differ from ss58.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
    }
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP tool use, forwarding counterparty/limit as query params. The
    // account_events D1 write path is retired (#4772), so a tier miss resolves
    // to the pure builders over an empty scan -- a schema-stable zero card in
    // list mode, or the same composite envelope with an empty counterparties
    // list in relationship mode, never a GraphQL error.
    const params = new URLSearchParams();
    if (counterparty != null) params.set("counterparty", counterparty);
    if (limit != null) params.set("limit", String(limit));
    // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
    // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
    // resolved to null before it could touch DATA_API.
    let data: Row | null = null;
    // The cold tiers REST and MCP both read (#9540). Two of them, because this
    // resolver has two modes and they are not interchangeable: a counterparty
    // argument asks about ONE relationship, and answering it from the list
    // reader would return a different question's answer.
    if (data == null) {
      data = (
        counterparty != null
          ? await loadCounterpartyRelationshipColdTier(
              context.env,
              ss58,
              counterparty,
              { limit: limit ?? undefined },
            )
          : await loadAccountCounterpartiesColdTier(context.env, ss58, {
              limit: limit ?? undefined,
            })
      ) as Row | null;
    }
    if (data == null) {
      if (counterparty != null) {
        const rel = buildCounterpartyRelationship([], ss58, counterparty, {
          limit: limit ?? undefined,
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
        data = toRow(
          buildCounterparties([], ss58, { limit: limit ?? undefined }),
        );
      }
    }
    const rel = rowOf(data.relationship);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      counterparty_count: data.counterparty_count ?? 0,
      transfers_scanned: data.transfers_scanned ?? 0,
      scan_capped: data.scan_capped ?? false,
      total_sent_tao: data.total_sent_tao ?? 0,
      total_received_tao: data.total_received_tao ?? 0,
      counterparties: rowsOf(data.counterparties).map((c: Row) => ({
        address: c.address,
        sent_tao: c.sent_tao ?? 0,
        received_tao: c.received_tao ?? 0,
        net_tao: c.net_tao ?? 0,
        transfer_count: c.transfer_count ?? 0,
        last_block: c.last_block ?? null,
      })),
      // THE PRODUCER (#10786), and the fallback is DELETED rather than
      // guarded. `rel` only exists on the drill-down leg, where
      // buildCounterpartyRelationship takes the counterparty as a REQUIRED
      // parameter and writes it back unchanged -- so `?? counterparty` could
      // only fire on a leg that never runs, and the argument it fell back to
      // is itself optional, which is the one thing that made this non-null
      // field answer null.
      relationship: rel
        ? {
            schema_version: rel.schema_version ?? 1,
            ss58: rel.ss58 ?? ss58,
            counterparty: rel.counterparty,
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
            transfers: rowsOf(rel.transfers).map((t: Row) => ({
              block_number: t.block_number ?? null,
              event_index: t.event_index ?? null,
              netuid: t.netuid ?? null,
              // Same call (#10786), and this pair is the one no probe could
              // settle -- `AccountCounterpartyTransfer.from`/`.to` were the
              // two UNPROVED tightenings in report:graphql-tightening-evidence
              // because production is never on this arm. The builder pushes a
              // row only after `from === ss58 && to === counterparty` (or the
              // mirror) holds, so both sides equal a non-empty address by
              // construction and the null was unreachable.
              from: t.from,
              to: t.to,
              amount_tao: t.amount_tao ?? 0,
              direction: t.direction,
              observed_at: t.observed_at ?? null,
            })),
          }
        : null,
    };
  },

  async account_transfers(
    {
      ss58,
      limit,
      offset,
      cursor,
      direction,
      block_start,
      block_end,
    }: QueryAccount_TransfersArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!isFinneySs58Address(ss58)) {
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
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP get_account_transfers tool use. The account_events store write path is
    // retired (#4772), so a tier miss resolves through buildAccountTransfers over
    // an empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540). Every filter is
      // forwarded, so the tier filters -- the empty builder below ignores them.
      ((await loadAccountTransfersColdTier(context.env, ss58, {
        limit: safeLimit,
        offset: safeOffset,
        cursor,
        direction,
        blockStart: block_start,
        blockEnd: block_end,
      })) as Row | null) ??
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
      transfers: rowsOf(data.transfers).map((t: Row) => ({
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
    {
      ss58,
      limit,
      offset,
      cursor,
      block_start,
      block_end,
    }: QueryAccount_ExtrinsicsArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!isFinneySs58Address(ss58)) {
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
    // Same tryDataApiTier(METAGRAPH_EXTRINSICS_SOURCE) the REST handler and MCP
    // get_account_extrinsics tool use. The extrinsics D1 write path is retired
    // (#4772), so a tier miss resolves through buildAccountExtrinsics over an
    // empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540). Every filter is
      // forwarded, so the tier filters -- the empty builder below ignores them.
      ((await loadAccountExtrinsicsColdTier(context.env, ss58, {
        limit: safeLimit,
        offset: safeOffset,
        cursor,
        blockStart: block_start,
        blockEnd: block_end,
      })) as Row | null) ??
      buildAccountExtrinsics([], ss58, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    // Reuse extrinsicNode (the same mapper the extrinsics feed uses) so a
    // malformed row degrades identically here.
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      extrinsic_count: data.extrinsic_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      extrinsics: rowsOf(data.extrinsics).map(extrinsicNode),
    };
  },

  async account_events(
    {
      ss58,
      kind,
      netuid,
      block_start,
      block_end,
      limit,
      offset,
      cursor,
    }: QueryAccount_EventsArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty feed.
    if (!isFinneySs58Address(ss58)) {
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
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) the REST handler and
    // MCP get_account_events tool use. The account_events store write path is
    // retired (#4772), so a tier miss resolves through buildAccountEvents over an
    // empty scan -- a schema-stable empty feed, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The account cold tier REST and MCP both read (#9540). Every filter is
      // forwarded, so the tier filters -- the empty builder below ignores them.
      ((await loadAccountEventsColdTier(context.env, ss58, {
        limit: safeLimit,
        offset: safeOffset,
        cursor,
        kind,
        netuid,
        blockStart: block_start,
        blockEnd: block_end,
      })) as Row | null) ??
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
      events: rowsOf(data.events).map((e: Row) => ({
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
    { ss58, netuid, from, to, limit, offset, cursor }: QueryAccount_HistoryArgs,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty series.
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same DAY_PATTERN guard REST's parseDateRange and MCP's optionalDayArg
    // apply to this capability (#6353). Without it a malformed bound is passed
    // straight through: the Postgres tier re-parses and rejects it, but the D1
    // fallback binds it into `day >= ?` / `day <= ?` against a TEXT column,
    // which silently yields a wrong (typically empty) series instead of an
    // error. The message is REST's parseDateRange verbatim, so the two HTTP
    // surfaces agree. (MCP's optionalDayArg names the offending argument
    // instead -- its own file's validator convention, see #6355.)
    // Same FEED_PAGINATION bounds the /history route's clamp applies, so a
    // GraphQL caller cannot request a wider page than REST allows;
    // netuid/cursor are forwarded verbatim for the route to re-parse,
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
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> D1
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
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      await loadAccountHistory(context.env, ss58, historyOptions);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      day_count: data.day_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      days: rowsOf(data.days).map((d: Row) => ({
        day: d.day ?? null,
        netuid: d.netuid ?? null,
        event_count: d.event_count ?? null,
        event_kinds: Array.isArray(d.event_kinds) ? d.event_kinds : [],
        first_block: d.first_block ?? null,
        last_block: d.last_block ?? null,
      })),
    };
  },

  async economics_trends(
    { window }: QueryEconomics_TrendsArgs,
    context: GqlContext,
  ) {
    // Same parseHistoryWindow REST uses, so accepted window labels and the
    // resulting { label, days } stay identical between REST and GraphQL.
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label, days } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same tier
    // and fallback contract REST's handleEconomicsTrends uses.
    // NO TIER READ (#10190): METAGRAPH_SUBNET_SNAPSHOTS_SOURCE is retired and
    // absent from FORWARDABLE_TIER_FLAGS, so that arm resolved to null on every
    // request.
    const data = (
      await loadEconomicsTrends({
        windowLabel: label,
        windowDays: days,
        db: observationsReadDb(context.env, context.ctx),
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

  // #10476: the coverage ratio, mirrored onto GraphQL.
  //
  // A THIN PROJECTION over the same src/revenue-load.ts the REST route and the
  // MCP tool compose from, so the three surfaces cannot disagree about a
  // subnet's ratio. Nothing is recomputed here.
  //
  // Deliberately schema-stable rather than erroring: 127 of 129 subnets have no
  // readable figure, so an error would make the NORMAL case look like a broken
  // endpoint and a caller sweeping the network would see 127 failures instead
  // of 127 answers. Every missing piece degrades to a null ratio with the
  // emission side still served.
  async subnet_revenue(
    { netuid, window }: { netuid: number; window?: string | null },
    context: GqlContext,
  ) {
    const revenue = await revenueForNetuid(context, netuid, window);
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      netuid,
      revenue,
      field_sources: SUBNET_REVENUE_FIELD_SOURCES,
    };
  },

  // The network-wide table. Subnets with no observed revenue are INCLUDED with
  // null ratios rather than dropped -- omitting them would make the covered set
  // look like the whole network, which is the single most misleading thing this
  // field could do.
  async chain_revenue_coverage(args: Row, context: GqlContext) {
    const windowDays = revenueWindowDays(args?.window);
    const rows = await loadEconomicsRows(context);
    const usd = await taoUsdForRevenue(context);
    // ONE observation read for the whole network rather than one per subnet:
    // 129 round trips would price this field out of existence.
    const observations = await loadRevenueObservations(
      readStore(context.env, REVENUE_OBSERVATION_TABLES),
      null,
    );
    // ONE READ, matching the observations read above (#11422). #11478 made the
    // 129 per-subnet reads concurrent (7.5s -> 1.0s); this removes them. See
    // `groupSurfacesByNetuid` for why the bulk artifact is an exact substitute.
    const surfacesByNetuid = await surfacesByNetuidMemoized(async () => {
      const allSurfaces = await readArtifact(
        context.env,
        ALL_SURFACES_ARTIFACT,
      );
      return allSurfaces.ok
        ? ((allSurfaces.data as Row | undefined)?.surfaces as Row[] | undefined)
        : null;
    });

    const subnets = [];
    for (const row of rows as Row[]) {
      const netuid = Number(row?.netuid);
      if (!Number.isInteger(netuid)) continue;
      subnets.push(
        loadSubnetRevenue({
          netuid,
          window_days: windowDays,
          economics: row,
          surfaces: surfacesByNetuid.get(netuid) ?? null,
          usd_per_tao: usd,
          observations: observations ?? null,
        }),
      );
    }
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      observed_count: subnets.filter((s) => s.revenue_usd !== null).length,
      subnet_count: subnets.length,
      subnets,
    };
  },

  // The v440 emission decomposition (#8744). A thin projection over the SAME
  // src/emission-pipeline-surface.ts REST and the get_emission_pipeline MCP
  // tool project, reading the live-preferring economics memo this file already
  // shares with the `economics` root and the opportunity boards — so the three
  // surfaces cannot decompose the same capture differently.
  //
  // Deliberately NOT schema-stable-on-cold the way blocks/validators are. Those
  // return an empty page because "no rows" is a real, honest answer; here the
  // capture's chain_state is what makes every reconstructed share checkable at
  // all, so an absent one has no honest body — only an error.
  async emission_pipeline(
    { netuid, sort, order, limit }: QueryEmission_PipelineArgs,
    context: GqlContext,
  ) {
    const economics = await loadEconomics(context);
    const data = projectEmissionPipeline(economics, netuid ?? null);
    if (!data) {
      throw new GraphQLError(EMISSION_PIPELINE_UNAVAILABLE_MESSAGE, {
        // The REST error code, uppercased — GraphQL's extensions.code
        // convention — so a client hitting both surfaces sees one condition,
        // not two unrelated-looking failures.
        extensions: {
          code: EMISSION_PIPELINE_UNAVAILABLE_CODE.toUpperCase(),
        },
      });
    }
    // #10065: the same narrowing handleEmissionPipeline applies, through the
    // same helper -- minus `fields`, which #10214 stopped publishing here: the
    // return is a named object type, so the selection set is the projection
    // (`fieldsArgumentApplies`), and REST keeps the parameter for the caller
    // who has no selection set.
    const narrowingParams = new URLSearchParams();
    for (const [name, value] of [
      ["sort", sort],
      ["order", order],
      ["limit", limit],
    ] as const) {
      if (value != null) narrowingParams.set(name, String(value));
    }
    const narrowing = parseEmissionPipelineNarrowing(
      narrowingParams,
      data.subnets,
      { limitMax: EMISSION_PIPELINE_LIMIT_MAX },
    );
    if ("error" in narrowing) {
      throw new GraphQLError(narrowing.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return narrowEmissionPipeline(data, narrowing);
  },

  async subnet_movers(
    { window, sort, limit }: QuerySubnet_MoversArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_MOVERS_WINDOW;
    const requestedSort = sort ?? DEFAULT_MOVERS_SORT;
    // `limit` arrives clamped and defaulted by the dispatch parse (#10316), so
    // neither the `?? MOVERS_LIMIT_DEFAULT` nor the range check that used to
    // stand here can do anything: the value is already inside the range the
    // route publishes.
    const requestedLimit = limit;
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("sort", requestedSort);
    params.set("limit", String(requestedLimit));
    // Same tryDataApiTier + buildMovers([], [], ...) fallback contract REST's
    // handleSubnetMovers uses -- a cold/absent tier yields a schema-stable
    // empty leaderboard, never a GraphQL error.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/subnets/movers", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildMovers([], [], {
        window: requestedWindow,
        startDate: null,
        endDate: null,
        sort: requestedSort,
        limit: requestedLimit,
      });
    const network = rowOf(data.network) ?? EMPTY_ROW;
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      start_date: data.start_date ?? null,
      end_date: data.end_date ?? null,
      sort: data.sort ?? requestedSort,
      subnet_count: data.subnet_count ?? 0,
      network: {
        total_stake_start_alpha:
          network.total_stake_start_alpha ?? "0.000000000",
        total_stake_end_alpha: network.total_stake_end_alpha ?? "0.000000000",
        total_stake_delta_alpha:
          network.total_stake_delta_alpha ?? "0.000000000",
        total_emission_start_alpha:
          network.total_emission_start_alpha ?? "0.000000000",
        total_emission_end_alpha:
          network.total_emission_end_alpha ?? "0.000000000",
        total_emission_delta_alpha:
          network.total_emission_delta_alpha ?? "0.000000000",
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

  async chain_turnover(
    { window, limit }: QueryChain_TurnoverArgs,
    context: GqlContext,
  ) {
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
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildChainTurnover([])
    // fallback contract REST's handleChainTurnover uses: unlike the chain_weights
    // family there is no D1 live-rollup loader here (the churn needs two
    // neuron_daily snapshots, which only the Postgres tier serves), so a cold
    // store yields the schema-stable empty/non-comparable envelope, never a
    // GraphQL error.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/turnover", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
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

  async chain_activity(
    { network, window }: QueryChain_ActivityArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/chain/activity
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/chain/activity", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    const days =
      ANALYTICS_WINDOW_DAYS[label as keyof typeof ANALYTICS_WINDOW_DAYS];
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryDataApiTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainActivity
    // fallback handleChainActivity uses; the tier owns the per-day extrinsic/block
    // rollup (no logic duplicated here), and a cold store yields a schema-stable
    // empty series.
    // #8421: mirror handleChainActivity's #8242 fix -- the UTC-day buckets span
    // one extra calendar day, so trim the resolved result to the requested
    // window before returning, keeping day_count consistent with the label.
    const data = trimChainActivityToWindow(
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST reads (#9540). Window-based like REST's
      // handleChainActivity, NOT the blocks-based loadChainActivity MCP's
      // get_chain_activity uses -- that tool takes a block count and answers a
      // different question, so borrowing its loader would change this
      // resolver's contract rather than fill it.
      ((await loadChainActivityFromArtifact(
        context.env,
        {
          window: label,
        },
        chainNetworkFromChainName(network),
      )) as ReturnType<typeof buildChainActivity> | null) ??
        buildChainActivity({ window: label }),
      days,
    );
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      days: rowsOf(data.days).map((d: Row) => ({
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
    {
      network,
      window,
      group_by: groupBy,
      limit,
      call_module: callModule,
    }: QueryChain_CallsArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/chain/calls
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/chain/calls", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
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
    // Same tryDataApiTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainCalls fallback
    // handleChainCalls uses; the tier owns the call-mix aggregation (no logic
    // duplicated here), and a cold store yields a schema-stable empty breakdown.
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540). callModule is
      // threaded rather than dropped: the reader DECLINES a pallet-scoped call
      // by contract (its value space is not precomputed), so passing it keeps
      // GraphQL's answer identical to REST's instead of quietly serving the
      // unfiltered mix under a filtered label.
      ((await loadChainCallsFromArtifact(
        context.env,
        {
          window: label,
          groupBy: requestedGroupBy,
          limit: safeLimit,
          callModule,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainCalls({ window: label, groupBy: requestedGroupBy });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      group_by: data.group_by ?? requestedGroupBy,
      observed_at: data.observed_at ?? null,
      total_extrinsics: data.total_extrinsics ?? 0,
      call_count: data.call_count ?? 0,
      calls: rowsOf(data.calls).map((c: Row) => ({
        call_module: c.call_module,
        call_function: c.call_function ?? null,
        count: c.count ?? 0,
        share: c.share ?? null,
      })),
    };
  },

  async chain_fees(
    { network, window, limit, call_module: callModule }: QueryChain_FeesArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/chain/fees
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/chain/fees", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    const days =
      ANALYTICS_WINDOW_DAYS[label as keyof typeof ANALYTICS_WINDOW_DAYS];
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
    // Same tryDataApiTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainFees fallback
    // handleChainFees uses; the tier owns the daily/median/payer aggregation (no
    // logic duplicated here), and a cold store yields a schema-stable empty series.
    // #8421: mirror handleChainFees's #8242 fix -- trim the UTC-day buckets to
    // the requested window so a 7d request never reports 8 days.
    const data = trimChainFeesToWindow(
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540); same
      // declines-a-scoped-call contract as chain_calls above.
      ((await loadChainFeesFromArtifact(
        context.env,
        {
          window: label,
          limit: safeLimit,
          callModule,
        },
        chainNetworkFromChainName(network),
      )) as ReturnType<typeof buildChainFees> | null) ??
        buildChainFees({ window: label }),
      days,
    );
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      daily: rowsOf(data.daily).map((d: Row) => ({
        day: d.day,
        extrinsic_count: d.extrinsic_count ?? 0,
        signed_extrinsic_count: d.signed_extrinsic_count ?? 0,
        total_fee_tao: d.total_fee_tao ?? null,
        avg_fee_tao: d.avg_fee_tao ?? null,
        median_fee_tao: d.median_fee_tao ?? null,
        total_tip_tao: d.total_tip_tao ?? null,
        avg_tip_tao: d.avg_tip_tao ?? null,
        median_tip_tao: d.median_tip_tao ?? null,
      })),
      top_fee_payers: rowsOf(data.top_fee_payers).map((p: Row) => ({
        signer: p.signer,
        total_fee_tao: p.total_fee_tao ?? null,
        total_tip_tao: p.total_tip_tao ?? null,
        extrinsic_count: p.extrinsic_count ?? 0,
      })),
    };
  },

  async chain_weights(
    { window, limit }: QueryChain_WeightsArgs,
    context: GqlContext,
  ) {
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
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildChainWeights
    // fallback contract REST's handleChainWeights uses -- a cold store yields a
    // schema-stable empty leaderboard, never a GraphQL error. #4772 D1 retirement:
    // the `account_events` D1 table is dropped in production, so the fallback goes
    // straight to the pure builder with no rows, never a live store query.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // Same shared loader REST and MCP use; GraphQL keeps its own
      // schema-stable card below because that contract is this surface's own.
      // The projection tier first, the same ladder the route reads (#11418).
      ((await loadChainWeightsFromArtifact(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      ((await loadChainWeightsColdTier(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      buildChainWeights([], {
        window: requestedWindow,
        limit: safeLimit,
        networkDistinct: undefined,
      });
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

  async chain_serving(
    { window, limit }: QueryChain_ServingArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
    // the table is dropped in production, so a store query here would always miss
    // (#6013). Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's chainServing route uses, never
    // a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // Same shared loader REST and MCP use. GraphQL keeps its own fallback
      // below because answering with the schema-stable card rather than an
      // error is this surface's deliberate contract, not the loader's call.
      // THE PROJECTION TIER FIRST (#11419), the same ladder
      // handleChainServing reads -- tests/graphql-tier-parity.test.ts is the
      // gate that holds the three surfaces to one order, because a field that
      // skips a tier its route reads answers a confident zero.
      ((await loadChainServingFromArtifact(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      ((await loadChainServingColdTier(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      buildChainServing([], { window: requestedWindow, limit: safeLimit });
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

  async chain_axon_removals(
    { window, limit }: QueryChain_Axon_RemovalsArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
    // the table is dropped in production, so a store query here would always miss
    // (#6013). Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainAxonRemovals uses,
    // never a GraphQL error.
    // DERIVED FROM STATE (#10805), the same read REST and MCP make, so the
    // three surfaces cannot drift. A null rollup is "no store", not "no
    // removals" -- the builder keeps its degraded empty for that.
    const rollup = await loadAxonRemovals(context.env);
    const data = buildChainAxonRemovals(rollup?.subnets ?? [], {
      window: requestedWindow,
      limit: safeLimit,
      networkDistinct: rollup?.network,
      derivation: rollup?.derivation,
    });
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
      // #9307: AxonInfoRemoved was never emitted, so an empty answer here is
      // not a measurement. The builder marks it; this projection must carry
      // the marker through or GraphQL alone keeps publishing a confident 0.
      degraded: data.degraded ?? null,
    };
  },

  async chain_deregistrations(
    { network, window, limit }: QueryChain_DeregistrationsArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
    // the table is dropped in production, so a store query here would always miss
    // (#6013). Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainDeregistrations
    // uses, never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9307: same UID-reuse derivation REST's handleChainDeregistrations
      // reads, then the same MARKED empty when nothing derived it.
      ((await loadChainDeregistrationsFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      toRow(
        markDeregistrationsNotDerived(
          buildChainDeregistrations([], {
            window: requestedWindow,
            limit: safeLimit,
          }),
        ),
      );
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
      derivation: data.derivation ?? null,
      degraded: data.degraded ?? null,
    };
  },

  async chain_registrations(
    { network, window, limit }: QueryChain_RegistrationsArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
    // the table is dropped in production, so a store query here would always miss
    // (#6013). Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainRegistrations uses,
    // never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // #9146: same chain-registrations projection REST reads, so the two
      // surfaces cannot report different registration activity.
      ((await loadChainRegistrationsFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainRegistrations([], {
        window: requestedWindow,
        limit: safeLimit,
      });
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

  async chain_prometheus(
    { window, limit }: QueryChain_PrometheusArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772) and
    // the table is dropped in production, so a store query here would always miss
    // (#6013). Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainPrometheus uses,
    // never a GraphQL error.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The same lakehouse rung REST and MCP now use (#10248). Wiring one
      // surface and not the others is exactly the drift chain-serving-loader.ts
      // was extracted to stop.
      // THE PROJECTION TIER FIRST (#11419), the same ladder
      // handleChainPrometheus reads -- tests/graphql-tier-parity.test.ts is the
      // gate that holds the three surfaces to one order, because a field that
      // skips a tier its route reads answers a confident zero.
      ((await loadChainPrometheusFromArtifact(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      ((await loadChainPrometheusColdTier(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      buildChainPrometheus([], { window: requestedWindow, limit: safeLimit });
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
      // Preserve the shared loader's source-availability verdict.
      degraded: data.degraded ?? null,
    };
  },

  async chain_signers(
    {
      network,
      window,
      limit,
      sort,
      call_module: callModule,
    }: QueryChain_SignersArgs,
    context: GqlContext,
  ) {
    // Checked against the window enum the ROUTE publishes, not against
    // every window the API knows: /api/v1/chain/signers
    // narrows the vocabulary, and reading it from that route's own schema is
    // what makes the two surfaces accept the same set. An unsupported window
    // is a GraphQL BAD_USER_INPUT error, not a silent empty result.
    assertRouteArgs("/api/v1/chain/signers", { window });
    const label = window ?? DEFAULT_ANALYTICS_WINDOW;
    // Same CHAIN_SIGNERS_SORTS allow-list REST validates against; sort is
    // optional (null -> the loader's tx_count default), so only a non-null
    // value is checked.
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
    // Same tryDataApiTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainSigners
    // fallback contract handleChainSigners uses, including the KV health:meta
    // observed_at stamp REST passes; no ranking/aggregation logic is duplicated
    // here, and a cold store yields a schema-stable empty leaderboard. #4772 D1
    // retirement: the `extrinsics` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live store query.
    const data =
      // NO TIER READ (#10190): METAGRAPH_EXTRINSICS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier (#9146) REST reads and this field skipped. The
      // loader declines a pallet-scoped call itself (serving the unfiltered
      // leaderboard under a filtered label would be a wrong answer), so
      // call_module is passed through rather than gated here.
      ((await loadChainSignersFromArtifact(
        context.env,
        {
          window: label,
          sort,
          limit: safeLimit,
          callModule,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainSigners({
        window: label,
        sort: sort ?? undefined,
        observedAt: await loadObservedAt(context),
        rows: [],
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      sort: data.sort ?? CHAIN_SIGNERS_SORTS[0],
      observed_at: data.observed_at ?? null,
      signer_count: data.signer_count ?? 0,
      signers: rowsOf(data.signers).map((entry: Row) => ({
        signer: entry.signer,
        tx_count: entry.tx_count ?? 0,
        total_fee_tao: entry.total_fee_tao ?? null,
        total_tip_tao: entry.total_tip_tao ?? null,
        last_tx_block: entry.last_tx_block ?? null,
      })),
    };
  },

  async chain_weight_setters(
    { window, limit }: QueryChain_Weight_SettersArgs,
    context: GqlContext,
  ) {
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
    // #4909 D1 retirement: account_events' D1 write path is retired (#4772)
    // and the table is dropped in production, so a store query here would
    // always miss. Postgres → schema-stable empty stub, never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // Same lakehouse reader REST and MCP use; the zeroed card below stays the
      // fallback because this resolver's contract is a schema-stable card
      // rather than an error, which is why the loader declines with null.
      // The projection tier first, the same ladder the route reads (#11418).
      ((await loadChainWeightSettersFromArtifact(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      ((await loadChainWeightSettersColdTier(context.env, {
        window: requestedWindow,
        limit: safeLimit,
      })) as Row | null) ??
      buildChainWeightSetters([], null, {
        window: requestedWindow,
        limit: safeLimit,
      });
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

  async chain_alpha_volume(
    { network, limit }: QueryChain_Alpha_VolumeArgs,
    context: GqlContext,
  ) {
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
      maxLimit: CHAIN_ALPHA_VOLUME_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildChainAlphaVolume
    // fallback contract REST's handleChainAlphaVolume uses -- a cold store yields
    // a schema-stable zeroed card (subnet_count 0, empty leaderboard, neutral
    // sentiment), never a GraphQL error. Fixed 24h window, no window arg. #4772 D1
    // retirement: the `account_events` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live store query.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540); without it this
      // resolver's whole answer was the empty card below. The market-cap index
      // rides along so vol_mcap_ratio is not null on GraphQL alone (#9526).
      ((await loadChainAlphaVolumeFromArtifact(
        context.env,
        {
          limit: safeLimit,
          marketCapByNetuid: await resolveMarketCapIndex(context.env),
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ?? buildChainAlphaVolume([], { limit: safeLimit });
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

  async chain_idle_stake(_args: unknown, context: GqlContext) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildChainIdleStake([])
    // cold fallback contract handleChainIdleStake / MCP get_chain_idle_stake
    // use: a cold/absent tier yields a schema-stable empty ranking, never a
    // GraphQL error. No window/limit args -- current snapshot only.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/idle-stake"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainIdleStake([]);
    return {
      schema_version: data.schema_version ?? 1,
      captured_at: data.captured_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      total_idle_stake_alpha: data.total_idle_stake_alpha ?? 0,
      subnets: data.subnets || [],
    };
  },

  async chain_stake_flow(
    { network, window, limit }: QueryChain_Stake_FlowArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_STAKE_FLOW_WINDOW;
    if (!Object.hasOwn(CHAIN_STAKE_FLOW_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_STAKE_FLOW_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_STAKE_FLOW_LIMIT_DEFAULT,
      maxLimit: CHAIN_STAKE_FLOW_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeFlow empty-card fallback REST's handleChainStakeFlow
    // uses. #4909 D1 retirement: never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540). Without this rung
      // the ladder below is the whole answer, and the retired flag above
      // guarantees we reach it -- a confident zero, with no error to say so.
      ((await loadChainStakeFlowFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainStakeFlow([], {
        window: requestedWindow,
        limit: safeLimit,
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        total_staked_tao: 0,
        total_unstaked_tao: 0,
        net_flow_tao: 0,
        gross_flow_tao: 0,
        stake_events: 0,
        unstake_events: 0,
        gaining: 0,
        losing: 0,
        flat: 0,
      },
      net_flow_distribution: data.net_flow_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_stake_moves(
    { network, window, limit }: QueryChain_Stake_MovesArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_STAKE_MOVES_WINDOW;
    if (!Object.hasOwn(CHAIN_STAKE_MOVES_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_STAKE_MOVES_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_STAKE_MOVES_LIMIT_DEFAULT,
      maxLimit: CHAIN_STAKE_MOVES_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeMoves empty-card fallback REST's handleChainStakeMoves
    // uses. #4909 D1 retirement: never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540). Without this rung
      // the ladder below is the whole answer, and the retired flag above
      // guarantees we reach it -- a confident zero, with no error to say so.
      ((await loadChainStakeMovesFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainStakeMoves([], {
        window: requestedWindow,
        limit: safeLimit,
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_movers: 0,
        movements: 0,
        movements_per_mover: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_stake_transfers(
    { network, window, limit }: QueryChain_Stake_TransfersArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_STAKE_TRANSFERS_WINDOW;
    if (!Object.hasOwn(CHAIN_STAKE_TRANSFERS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(
          requestedWindow,
          CHAIN_STAKE_TRANSFERS_WINDOWS,
        ),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_STAKE_TRANSFERS_LIMIT_DEFAULT,
      maxLimit: CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeTransfers empty-card fallback REST's
    // handleChainStakeTransfers uses. #4909 D1 retirement: never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier REST and MCP both read (#9540). Without this rung
      // the ladder below is the whole answer, and the retired flag above
      // guarantees we reach it -- a confident zero, with no error to say so.
      ((await loadChainStakeTransfersFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainStakeTransfers([], {
        window: requestedWindow,
        limit: safeLimit,
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      network: data.network ?? {
        distinct_senders: 0,
        transfers: 0,
        transfers_per_sender: null,
      },
      intensity_distribution: data.intensity_distribution ?? null,
      subnets: data.subnets || [],
    };
  },

  async chain_transfer_pairs(
    { network, window, sort, limit }: QueryChain_Transfer_PairsArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW;
    // Same CHAIN_TRANSFER_PAIR_SORTS allow-list REST validates against; sort is
    // optional (null -> volume default), so only a non-null value is checked.
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
      maxLimit: CHAIN_TRANSFER_PAIR_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    if (sort != null) params.set("sort", sort);
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainTransferPairs empty-card fallback REST uses, including the KV
    // health:meta observed_at stamp. #4909 D1 retirement: never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier (#9146) REST reads and this field skipped.
      ((await loadChainTransferPairsFromArtifact(
        context.env,
        {
          window: requestedWindow,
          sort,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainTransferPairs({
        window: requestedWindow,
        sort,
        observedAt: await loadObservedAt(context),
        totals: null,
        pairs: [],
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      sort: data.sort ?? CHAIN_TRANSFER_PAIR_SORTS[0],
      observed_at: data.observed_at ?? null,
      total_volume_tao: data.total_volume_tao ?? 0,
      transfer_count: data.transfer_count ?? 0,
      unique_pairs: data.unique_pairs ?? 0,
      pair_count: data.pair_count ?? 0,
      top_pair_share: data.top_pair_share ?? null,
      pairs: data.pairs || [],
    };
  },

  async chain_transfers(
    { network, window, limit }: QueryChain_TransfersArgs,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_TRANSFER_WINDOW;
    if (!Object.hasOwn(CHAIN_TRANSFER_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_TRANSFER_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_TRANSFER_LIMIT_DEFAULT,
      maxLimit: CHAIN_TRANSFER_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    // Same tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainTransfers empty-card fallback REST's handleChainTransfers
    // uses, including the KV health:meta observed_at stamp. #4909 D1
    // retirement: never a live store read.
    const data =
      // NO TIER READ (#10190): METAGRAPH_ACCOUNT_EVENTS_SOURCE reads "retired" in
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      // The projection tier (#9146): a cron recomputes this window's scorecard
      // from the lakehouse and REST reads it here. GraphQL was never given the
      // rung, so it fell straight past the tier that HAS the data to the empty
      // card -- serving transfer_count 0 while REST answered 2,883,743 for the
      // same window in the same second, and without a degraded marker to say
      // so. The three fields left off when #9146 landed are exactly the three
      // that disagreed: this, chain_transfer_pairs and chain_signers.
      ((await loadChainTransfersFromArtifact(
        context.env,
        {
          window: requestedWindow,
          limit: safeLimit,
        },
        chainNetworkFromChainName(network),
      )) as Row | null) ??
      buildChainTransfers({
        window: requestedWindow,
        observedAt: await loadObservedAt(context),
        totals: null,
        senders: [],
        receivers: [],
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      observed_at: data.observed_at ?? null,
      total_volume_tao: data.total_volume_tao ?? 0,
      transfer_count: data.transfer_count ?? 0,
      unique_senders: data.unique_senders ?? 0,
      unique_receivers: data.unique_receivers ?? 0,
      top_sender_share: data.top_sender_share ?? null,
      top_senders: data.top_senders || [],
      top_receivers: data.top_receivers || [],
    };
  },

  async health_trends(
    { window, limit, offset }: QueryHealth_TrendsArgs,
    context: GqlContext,
  ) {
    // Same tryDataApiTier(METAGRAPH_HEALTH_SOURCE) -> loadBulkHealthTrends
    // fallback contract REST's handleBulkHealthTrends and the get_health_trends
    // MCP tool share -- a cold store yields both windows zeroed, never a
    // GraphQL error.
    //
    // #10065: the three narrowing parameters #9989 gave the route. This field
    // took none of them, so a GraphQL caller always got every window for every
    // surface. Validated the same way the sibling fields validate an enum --
    if (offset != null && offset < 0) {
      throw new GraphQLError("offset must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const trendsParams = new URLSearchParams();
    for (const [name, value] of [
      ["window", window],
      ["limit", limit],
      ["offset", offset],
    ] as const) {
      if (value != null) trendsParams.set(name, String(value));
    }
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (
        await loadBulkHealthTrends({
          observedAt: await loadObservedAt(context),
          db: observationsReadDb(context.env, context.ctx),
          window: window ?? null,
          limit: limit ?? null,
          offset: offset ?? 0,
        })
      ).data;
    return {
      schema_version: data.schema_version ?? 1,
      observed_at: data.observed_at ?? null,
      source: data.source,
      windows: data.windows ?? {},
    };
  },

  async subnet_health_trends(
    { netuid }: QuerySubnet_Health_TrendsArgs,
    context: GqlContext,
  ) {
    // Same tryDataApiTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetHealthTrends D1
    // fallback contract REST's handleHealthTrends and the
    // get_subnet_health_trends MCP tool share -- the route takes no window arg
    // (it returns every configured window), and a subnet with no probe history
    // yields a schema-stable zeroed-windows card, never a GraphQL error. The
    // tier owns the per-surface uptime/latency aggregation; nothing is
    // duplicated here.
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      await loadSubnetHealthTrends(netuid, {
        observedAt: await loadObservedAt(context),
        db: observationsReadDb(context.env, context.ctx),
      });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      observed_at: data.observed_at ?? null,
      source: data.source,
      windows: data.windows ?? {},
    };
  },

  async subnet_health(args: QuerySubnet_HealthArgs, context: GqlContext) {
    const {
      netuid,
      kind,
      provider,
      status,
      classification,
      sort,
      order,
      fields,
      limit,
      cursor,
    } = args;
    // Same non-negative netuid gate the other per-subnet resolvers use --
    // GraphQL Int coercion rejects non-integers at parse time; a negative
    // netuid is a BAD_USER_INPUT error, not a silent card.
    assertNetuidArgument(netuid);
    // Same live composition REST's subnet-health route (workers/api.ts's
    // subnet-health overlay) and the get_subnet_health MCP tool share: the
    // latest ~15-minute cron snapshot (resolveLiveHealth) overlaid per subnet
    // (overlaySubnetHealth), plus the cross-window reliability summary
    // (loadSubnetReliability). A subnet with no live rows overlays to null, so
    // it resolves to the identical schema-stable "unknown" card the MCP tool
    // returns on a cold store -- never a GraphQL error. Nothing is re-derived.
    const [live, reliability] = await Promise.all([
      resolveLiveHealth({
        readHealthKv: readHealthKv as (
          env: Env,
          key: string,
        ) => Promise<Row | null>,
        env: context.env,
      }),
      loadSubnetReliability(),
    ]);
    const overlaid = overlaySubnetHealth(null, live, netuid);
    const card = overlaid
      ? { ...overlaid, reliability }
      : {
          schema_version: 1,
          netuid,
          // Same builder as the MCP arms (#9797): the cold summary must
          // carry every count HealthSubnetSummarySchema requires.
          summary: emptySubnetHealthSummary(),
          operational_observed_at: null,
          health_source: "unavailable",
          reliability,
          surfaces: [],
        };
    // #7881: apply the same list query GET /api/v1/subnets/{netuid}/health runs
    // over the card's surfaces (listQuery("health-surfaces", { exclude:
    // ["netuid"] })) -- kind/provider/status/classification filters plus
    // sort/order, fields projection, and limit/cursor paging. applyQueryFilters
    // is the same helper the REST pipeline and the list_* MCP loaders use, so
    // the allowlists cannot drift; an unsupported value is a GraphQL error
    // rather than a silently substituted default. With no filter args the card
    // passes through with its surfaces intact.
    const queryUrl = new URL("https://graphql.internal/subnets/health");
    for (const [name, value] of [
      ["kind", kind],
      ["provider", provider],
      ["status", status],
      ["classification", classification],
      ["sort", sort],
      ["order", order],
      ["fields", fields],
      ["limit", limit],
      ["cursor", cursor],
    ] as const) {
      if (value != null) queryUrl.searchParams.set(name, String(value));
    }
    const transformed = applyQueryFilters(card, queryUrl, "health-surfaces", [
      "kind",
      "provider",
      "status",
      "classification",
    ]);
    if (transformed.error) {
      throw new GraphQLError(transformed.error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const filtered = transformed.data as Row;
    const page = ((transformed.meta as Row)?.pagination ?? {}) as Row;
    const surfaces = Array.isArray(filtered.surfaces) ? filtered.surfaces : [];
    return {
      ...card,
      surfaces,
      total: page.total ?? surfaces.length,
      returned: page.returned ?? surfaces.length,
      limit: page.limit ?? surfaces.length,
      cursor: page.cursor ?? 0,
      next_cursor: page.next_cursor ?? null,
      sort: page.sort ?? null,
      order: page.order ?? null,
    };
  },

  async subnet_uptime(
    { netuid, window, min_samples: minSamples }: QuerySubnet_UptimeArgs,
    context: GqlContext,
  ) {
    // Same 90d/1y window validation handleUptime / get_subnet_uptime use -- an
    // unsupported window is a GraphQL BAD_USER_INPUT error, not a silent card.
    // parseUptimeWindow(undefined) → "90d"; a bad value cannot reach here --
    // parseArgumentsAtDispatch rejected it against the route's published enum
    // before this resolver ran (#10993), so the null arm is an assertion, not
    // a guard wearing a message no caller ever received.
    const windowParam = parseUptimeWindow(window)!;
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
    // Same tryDataApiTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetUptime D1
    // fallback contract REST's handleUptime and the get_subnet_uptime MCP tool
    // share -- a subnet with no daily history yields a schema-stable empty
    // surfaces card, never a GraphQL error. The tier owns the
    // surface_uptime_daily aggregation; nothing is duplicated here.
    const data =
      // NO TIER READ (#10190): METAGRAPH_HEALTH_SOURCE is deleted from
      // wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS, so this arm
      // resolved to null before it could touch DATA_API.
      (await loadSubnetUptime(netuid, {
        window: windowParam,
        observedAt: await loadObservedAt(context),
        db: observationsReadDb(context.env, context.ctx),
      })) as Row;
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? windowParam,
      observed_at: data.observed_at ?? null,
      source: data.source,
      reliability: data.reliability ?? null,
      surfaces: data.surfaces ?? [],
    };
  },

  async rpc_usage({ window }: QueryRpc_UsageArgs, context: GqlContext) {
    const requestedWindow = window ?? DEFAULT_ANALYTICS_WINDOW;
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // The tier cascade is src/rpc-usage-answer.ts's, shared verbatim with
    // REST's handleRpcUsage and the get_rpc_usage MCP tool. This resolver used
    // to run its own `tryDataApiTier -> loadRpcUsage` copy, which -- with the
    // Postgres box gone -- resolved to the zeroed floor while REST served the
    // real numbers from two live stores (#9269). A cold store still yields a
    // schema-stable zeroed card, never a GraphQL error.
    const data = (await answerRpcUsage(context.env, {
      window: requestedWindow,
      observedAt: await loadObservedAt(context),
    })) as Row;
    const summary = rowOf(data.summary) ?? EMPTY_ROW;
    const latency = rowOf(summary.latency_ms) ?? EMPTY_ROW;
    const coverage = rowOf(data.coverage) ?? EMPTY_ROW;
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? requestedWindow,
      bucket_granularity: data.bucket_granularity ?? null,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      coverage: {
        start: coverage.start ?? null,
        end: coverage.end ?? null,
        segments: coverage.segments ?? [],
        latency_percentiles: coverage.latency_percentiles ?? null,
      },
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

  async registry_leaderboards(
    { board, limit }: QueryRegistry_LeaderboardsArgs,
    context: GqlContext,
  ) {
    // Same board allowlist handleLeaderboards enforces -- an unknown board is a
    // GraphQL BAD_USER_INPUT error, mirroring REST's invalid_query 400 rather
    // than silently resolving to an empty board.
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
    // Reuses handleLeaderboards' own projection + store reads via the shared
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

  async chain_performance(_args: unknown, context: GqlContext) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildChainPerformance([])
    // cold fallback contract handleChainPerformance / MCP get_chain_performance
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainPerformance validates
    // against an EMPTY param allowlist, so there is no window/limit arg to
    // mirror -- current snapshot only.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/performance"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainPerformance([]);
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

  async chain_yield(_args: unknown, context: GqlContext) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildChainYield([])
    // fallback contract handleChainYield uses -- a cold/absent tier yields a
    // schema-stable zeroed card (every aggregate null), never a GraphQL error.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/yield"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainYield([]);
    const distribution = rowOf(data.distribution);
    return {
      schema_version: data.schema_version ?? 1,
      subnet_count: data.subnet_count ?? 0,
      neuron_count: data.neuron_count ?? 0,
      validator_count: data.validator_count ?? 0,
      miner_count: data.miner_count ?? 0,
      captured_at: data.captured_at ?? null,
      total_stake_alpha: data.total_stake_alpha ?? 0,
      total_emission_alpha: data.total_emission_alpha ?? 0,
      network_yield: data.network_yield ?? null,
      validator_yield: data.validator_yield ?? null,
      miner_yield: data.miner_yield ?? null,
      distribution: distribution
        ? {
            count: distribution.count ?? 0,
            mean: distribution.mean ?? 0,
            p50: distribution.p50 ?? 0,
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

  async chain_concentration(_args: unknown, context: GqlContext) {
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildChainConcentration([])
    // cold fallback contract handleChainConcentration / MCP get_chain_concentration
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainConcentration reads every
    // subnet's neurons with no netuid filter and validates against an EMPTY
    // param allowlist, so there is no window/limit arg to mirror -- current
    // snapshot only.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/concentration"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainConcentration([]);
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

  async subnet_recycled(
    { netuid, network }: QuerySubnet_RecycledArgs,
    context: GqlContext,
  ) {
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
    return loadSubnetRecycled(
      context.env,
      netuid,
      chainNetworkFromChainName(network),
    );
  },

  async subnet_burn(
    { netuid, network }: QuerySubnet_BurnArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Live chain RPC, not the Postgres tier -- reuses loadSubnetBurn's own
    // KV cache/TTL, matching REST's handleSubnetBurn exactly. burn_tao
    // stays null on RPC failure (schema-stable), never a GraphQL error.
    // loadSubnetBurn always sets schema_version/netuid/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadSubnetBurn(
      context.env,
      netuid,
      chainNetworkFromChainName(network),
    );
  },

  async subnet_burn_history(
    { netuid, window }: QuerySubnet_Burn_HistoryArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError("netuid must be a u16 subnet id (0-65535).", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const label = window ?? DEFAULT_BURN_HISTORY_WINDOW;
    // Non-null by dispatch (#10993): a label outside BURN_HISTORY_WINDOWS was
    // rejected against the route's published enum before this resolver ran.
    const windowDays = BURN_HISTORY_WINDOWS[label]!;
    // A cold or unwritten table is an EMPTY series, never an error: "we have not
    // been recording this subnet" is a real state, and the same convention the
    // sibling history fields already follow.
    const rows = await loadSubnetBurnHistory(
      readStore(context.env, SUBNET_BURN_HISTORY_TABLES),
      netuid,
      { windowDays },
    );
    return buildSubnetBurnHistory(rows, netuid, { window: label });
  },

  async chain_burn({ network }: QueryChain_BurnArgs, context: GqlContext) {
    // #9399. Live chain RPC, not a tier -- reuses loadChainBurn's own KV cache and
    // TTL, matching REST's handleChainBurn exactly. A failed read yields an empty
    // ranking with read_count 0 rather than a GraphQL error, so the field stays
    // schema-stable like its per-subnet sibling.
    return loadChainBurn(context.env, chainNetworkFromChainName(network));
  },

  async subnet_turnover(
    { netuid, window, changes }: QuerySubnet_TurnoverArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError("netuid must be a u16 subnet id (0-65535).", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow the REST turnover handler uses, so accepted
    // window labels (7d/30d/90d/1y/all, default 30d) match exactly.
    const windowResult = parseHistoryWindow(window);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // Opt into REST's ?changes=true per-neuron detail. Only forward the param
    // when true, so the default scorecard request stays byte-identical.
    if (changes === true) params.set("changes", "true");
    // Same tryDataApiTier(METAGRAPH_NEURONS_SOURCE) -> buildTurnover([]) empty-card
    // fallback contract the REST handler uses (neuron_daily boundary snapshots); a
    // subnet with no boundary rows in the window is a schema-stable empty card,
    // never a GraphQL error. The cold fallback carries no `changes` block, so the
    // field resolves to null even when the toggle is set.
    const data =
      ((await tryDataApiTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/turnover`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildTurnover([], netuid, { window: label });
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
      changes: turnoverChangesNode(data.changes as Row | null | undefined),
    };
  },

  async subnet_ownership_history(
    { netuid }: QuerySubnet_Ownership_HistoryArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const data = await fetchAllEventsTier(
      context,
      `/api/v1/subnets/${netuid}/ownership-history`,
    );
    // Shaped by the composer's own node builder, not here. The inline reshape
    // this replaces kept four fields, so every field REST's payload gained
    // reached REST alone -- the per-surface drift #9296 fixed for /rpc/usage.
    return subnetOwnershipHistoryNode(data, netuid);
  },

  async subnet_conviction(
    { netuid }: QuerySubnet_ConvictionArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const data = await fetchAllEventsTier(
      context,
      `/api/v1/subnets/${netuid}/conviction`,
    );
    return {
      // THE PRODUCER (#10786). `field_sources` is the per-field measured/
      // reconstructed provenance map, and buildSubnetConviction stamps the
      // SAME module constant on every card -- cold, degraded or live. It is a
      // description of the derivation, not a reading, so falling back to it is
      // restating what the builder would have said; nulling it strips ADR
      // 0023's provenance from the one arm where a caller most needs it.
      field_sources: data?.field_sources ?? SUBNET_CONVICTION_FIELD_SOURCES,
      schema_version: data?.schema_version ?? 1,
      netuid,
      queried_at_block: data?.queried_at_block ?? null,
      unlock_rate: data?.unlock_rate ?? null,
      maturity_rate: data?.maturity_rate ?? null,
      king: data?.king ?? null,
      count: data?.count ?? 0,
      leaderboard: Array.isArray(data?.leaderboard) ? data.leaderboard : [],
      degraded: data?.degraded ?? null,
    };
  },

  async subnet_lease_history(
    { netuid }: QuerySubnet_Lease_HistoryArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // The same builder the cold tier runs for this path
    // (coldTierChainEventsPayload -> buildSubnetLeaseHistory), so the two
    // constants below come from ONE place rather than being restated here.
    const empty = buildSubnetLeaseHistory([], netuid);
    const data =
      (await fetchAllEventsTier(
        context,
        `/api/v1/subnets/${netuid}/lease/history`,
      )) ?? empty;
    return {
      // THE PRODUCER (#10786), and here the fallback STAYS. Both fields are
      // fixed vocabulary -- the pallet these events come from and the two
      // event ids this feed is made of -- which buildSubnetLeaseHistory stamps
      // unconditionally. Unlike the cards whose value never leaves this
      // Worker, the other leg is a DATA_API body, so the fallback is a real
      // arm rather than dead code; it now falls back to the SAME builder
      // instead of to null, which is what made a non-null field answerable
      // with one. subnet-lease.ts records the schema half of this: an earlier
      // hand-written schema left both out of its required set even though the
      // builder always sets them.
      event_pallet: data.event_pallet ?? empty.event_pallet,
      event_kinds: data.event_kinds ?? empty.event_kinds,
      schema_version: data.schema_version ?? 1,
      netuid,
      count: data.count ?? 0,
      lease_events: Array.isArray(data.lease_events) ? data.lease_events : [],
      // FORWARDED, not dropped (#11423). The tier's marked empty says the read
      // could not be made, and a projection that kept everything except the
      // marker would restate on this surface the confident zero the marker
      // exists to prevent.
      degraded: data.degraded ?? null,
    };
  },

  async subnet_lease(
    { netuid, network }: QuerySubnet_LeaseArgs,
    context: GqlContext,
  ) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Live chain RPC, not the Postgres tier -- reuses loadSubnetLease's own
    // KV cache/TTL, matching REST's handleSubnetLease and MCP's
    // get_subnet_lease exactly. leased/lease stay null on RPC failure
    // (schema-stable), never a GraphQL error.
    return loadSubnetLease(
      context.env,
      netuid,
      chainNetworkFromChainName(network),
    );
  },

  async account_balance(
    { ss58, network }: QueryAccount_BalanceArgs,
    context: GqlContext,
  ) {
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
    return loadAccountBalance(
      context.env,
      ss58,
      chainNetworkFromChainName(network),
    );
  },

  async account_root_claim(
    { ss58, network }: QueryAccount_Root_ClaimArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid Finney ss58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Live chain RPC — reuses loadAccountRootClaim's KV cache/TTL, matching
    // REST's handleAccountRootClaim. claim_type/hotkeys stay null on RPC
    // failure (schema-stable), never a GraphQL error. Read-only.
    return loadAccountRootClaim(
      context.env,
      ss58,
      chainNetworkFromChainName(network),
    );
  },

  async account_children(
    { ss58, network }: QueryAccount_ChildrenArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid Finney ss58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Live chain RPC, not the Postgres tier -- reuses loadAccountChildren's own
    // KV cache/TTL, matching REST's handleAccountChildren exactly. subnets stays
    // null on RPC failure (schema-stable), distinct from a confirmed-empty [].
    // loadAccountChildren always sets schema_version/account/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadAccountChildren(
      context.env,
      ss58,
      chainNetworkFromChainName(network),
    );
  },

  async account_parents(
    { ss58, network }: QueryAccount_ParentsArgs,
    context: GqlContext,
  ) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid Finney ss58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Live chain RPC, not the Postgres tier -- reuses loadAccountParents' own
    // KV cache/TTL, matching REST's handleAccountParents exactly. subnets stays
    // null on RPC failure (schema-stable), distinct from a confirmed-empty [].
    // loadAccountParents always sets schema_version/account/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadAccountParents(
      context.env,
      ss58,
      chainNetworkFromChainName(network),
    );
  },

  async sudo_key({ network }: QuerySudo_KeyArgs, context: GqlContext) {
    // Live chain RPC, not the Postgres tier -- reuses loadSudoKey's own KV
    // cache/TTL, matching REST's sudo/key handler exactly. hotkey stays null
    // on RPC failure or a renounced sudo (schema-stable), never a GraphQL
    // error. loadSudoKey always sets schema_version/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadSudoKey(context.env, chainNetworkFromChainName(network));
  },

  async network_parameters(
    { network }: QueryNetwork_ParametersArgs,
    context: GqlContext,
  ) {
    // Live chain RPC, not the Postgres tier -- reuses loadNetworkParameters'
    // own KV cache/TTL, matching REST's /network/parameters handler exactly.
    // Each field stays independently null on its own RPC failure
    // (schema-stable), never a GraphQL error. loadNetworkParameters always
    // sets schema_version/queried_at unconditionally, so no `??` fallback is
    // needed for those.
    return loadNetworkParameters(
      context.env,
      chainNetworkFromChainName(network),
    );
  },
  async network_randomness(
    { network }: QueryNetwork_RandomnessArgs,
    context: GqlContext,
  ) {
    // Live chain RPC, not the Postgres tier -- reuses loadRandomnessStatus'
    // own KV cache/TTL, matching REST's /network/randomness handler exactly.
    // Each round field stays independently null on RPC failure (schema-stable),
    // never a GraphQL error; schema_version/queried_at are always set.
    return loadRandomnessStatus(
      context.env,
      chainNetworkFromChainName(network),
    );
  },
  // #7649: the get_randomness_status-aligned name for the same beacon snapshot
  // -- a thin delegate so MCP tool names and GraphQL fields line up. Identical
  // loader, KV cache/TTL, and independently-null RPC-failure behavior; nothing
  // re-implemented.
  async randomness_status(
    args: QueryRandomness_StatusArgs,
    context: GqlContext,
  ) {
    // Delegates, so the network argument rides along untouched — the two
    // fields must never diverge on which chain they read.
    return rootValue.network_randomness(args, context);
  },
  async evm_address(
    { h160, network }: QueryEvm_AddressArgs,
    context: GqlContext,
  ) {
    return resolveEvmAddressMapping(h160, context, network);
  },
  // Same resolver as evm_address, under the get_evm_address_mapping tool name so
  // MCP and GraphQL agree; delegating rather than duplicating keeps the two
  // fields from ever drifting apart.
  async evm_address_mapping(
    { h160, network }: QueryEvm_Address_MappingArgs,
    context: GqlContext,
  ) {
    return resolveEvmAddressMapping(h160, context, network);
  },
};

/**
 * Every Query field parses its arguments against its route's schema, ONCE, on
 * the way in (#10316).
 *
 * ── The shape of the problem ───────────────────────────────────────────────
 *
 * REST got this at #10218: `workers/api.ts` parses a GET's query string against
 * the route's Zod object before dispatch, and the seven hand-rolled parsers
 * that each restated a published bound were deleted. GraphQL got the same
 * `validateRouteArgs` function and OPT-IN adoption -- 8 of 165 resolvers call
 * it, and the other 250 checks are written by hand, one `if` at a time. Every
 * session adds a few more, because adding one is easier than finding the
 * shared thing.
 *
 * A wrapper here is not tidier than 250 `if`s; it is a DIFFERENT KIND of
 * thing. One call site cannot be half-adopted the way 165 resolvers can, and
 * `validate:graphql-hand-written-checks` fails the 251st.
 *
 * ── Why it is keyed on QUERY_BINDINGS ──────────────────────────────────────
 *
 * The binding from a field to the route it mirrors is already declared and
 * already gated (`validate:graphql-route-parity`, 656 argument pairs). A field
 * with `route: null` -- the eight that compose several routes or none -- passes
 * through untouched, because there is no single published schema to parse it
 * against and inventing one would be the hand-writing this replaces.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * It does not enforce the page ceiling. `resolveRouteArgs` clamps `limit` and
 * leaves the rest to the schema, for the reason recorded there: #10174 settled
 * that this surface clamps, and a parse that rejected instead would flip a
 * published behaviour for every caller passing a large page.
 */
type Resolver = (args: Record<string, unknown>, context: GqlContext) => unknown;

/**
 * A published default, in the type the SDL argument declares.
 *
 * The inverse of `toRouteShape`, and it has to exist: the route publishes a
 * boolean filter as the `["true","false"]` strings a query string can carry,
 * and handing `"true"` to a resolver that tests `changes === true` would be
 * this wrapper introducing the bug it exists to prevent.
 */
function fromRouteShape(value: unknown, argument: GraphQLArgument): unknown {
  const named = getNamedType(argument.type);
  if (named === GraphQLBoolean) return value === true || value === "true";
  if (isListType(getNullableType(argument.type))) {
    return typeof value === "string" ? value.split(",") : value;
  }
  return value;
}

export function parseArgumentsAtDispatch(
  resolvers: Record<string, unknown>,
): Record<string, unknown> {
  const queryType = schema.getQueryType();
  const wrapped: Record<string, unknown> = { ...resolvers };
  for (const binding of QUERY_BINDINGS) {
    const resolver = resolvers[binding.field];
    if (binding.route === null || typeof resolver !== "function") continue;
    const route = binding.route;
    const field = binding.field;
    const declared = queryType?.getFields()[field];
    /* v8 ignore next -- QUERY_BINDINGS is gated against the SDL, so every
       bound field exists on the Query type. */
    if (!declared) continue;
    const argumentsByName = new Map(
      declared.args.map((argument) => [argument.name, argument]),
    );
    const inner = resolver as Resolver;
    wrapped[field] = function parsed(
      args: Record<string, unknown>,
      context: GqlContext,
    ) {
      const { value, error, clamped } = resolveRouteArgs(
        route,
        field,
        args ?? {},
      );
      if (error) {
        throw new GraphQLError(error.message, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // The caller's arguments win, EXCEPT where the parse resolved something
      // the caller cannot see: a clamped page bound, or a published default for
      // an argument they omitted. Merging the parse wholesale would hand the
      // resolver route-shaped values for arguments it received in GraphQL shape
      // -- `changes: "true"` to a resolver that tests `changes === true`.
      const resolved: Record<string, unknown> = { ...args };
      for (const [name, parsedValue] of Object.entries(
        (value ?? {}) as Record<string, unknown>,
      )) {
        const argument = argumentsByName.get(name);
        if (!argument) continue;
        const supplied = args?.[name];
        const omitted = supplied === null || supplied === undefined;
        // A page bound is always the parse's, because clamping is the answer
        // this surface gives and the caller's raw value is what got clamped.
        if (omitted || clamped.has(name)) {
          resolved[name] = fromRouteShape(parsedValue, argument);
        }
      }
      return inner(resolved, context);
    };
  }
  return wrapped;
}

const parsedRootValue = parseArgumentsAtDispatch(rootValue);

// --- Response helpers ---

const GRAPHQL_CONTENT_TYPE = "application/graphql-response+json";
const SDL_CONTENT_TYPE = "application/graphql; charset=utf-8";

// metagraphed#7734: `code` mirrors errorResponse()'s own x-metagraph-error-code
// convention (workers/http.ts, #7733) so withUsageTelemetry can categorize a
// GraphQL transport-level rejection the same way it already does for every
// REST route -- this file had no such header at all before. Required (every
// call site below already has one), not optional -- no path should ever
// produce an error response with no category.
const graphqlError = (
  message: string,
  status: number,
  code: string,
  extraHeaders: Row = {},
) =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: graphqlHeaders({
      "x-metagraph-error-code": code,
      ...extraHeaders,
    }),
  });

const graphqlHeaders = (extra = {}) => ({
  "content-type": GRAPHQL_CONTENT_TYPE,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  ...extra,
});

// --- Handler ---

async function readLimitedJson(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) {
      return {
        error: graphqlError(
          "Invalid Content-Length header.",
          400,
          "graphql_invalid_json",
        ),
      };
    }
    if (length > GRAPHQL_MAX_BODY_BYTES) {
      return {
        error: graphqlError(
          "GraphQL request body is too large.",
          413,
          "graphql_payload_too_large",
        ),
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
          error: graphqlError(
            "GraphQL request body is too large.",
            413,
            "graphql_payload_too_large",
          ),
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
      error: graphqlError(
        "Request body must be valid JSON.",
        400,
        "graphql_invalid_json",
      ),
    };
  }
}

function utf8ByteLength(value: unknown) {
  return new TextEncoder().encode(value as string).byteLength;
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

export async function handleGraphQLRequest(
  request: Request,
  env: Env,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
) {
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
        headers: graphqlHeaders({
          allow: "GET, POST",
          "x-metagraph-error-code": "graphql_bad_method",
        }),
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
      {
        status: 400,
        headers: graphqlHeaders({
          "x-metagraph-error-code": "graphql_missing_query",
        }),
      },
    );
  }

  if (utf8ByteLength(query) > GRAPHQL_MAX_QUERY_BYTES) {
    return graphqlError(
      "GraphQL query is too large.",
      413,
      "graphql_payload_too_large",
    );
  }

  let document;
  try {
    document = parse(query);
  } catch (err) {
    return new Response(
      JSON.stringify({ errors: [{ message: (err as Error).message }] }),
      {
        status: 400,
        headers: graphqlHeaders({
          "x-metagraph-error-code": "graphql_parse_error",
        }),
      },
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
      {
        status: 400,
        headers: graphqlHeaders({
          "x-metagraph-error-code": "graphql_validation_error",
        }),
      },
    );
  }

  const result = await execute({
    schema,
    document,
    rootValue: parsedRootValue,
    contextValue: { env, cache: new Map(), request, ctx, readArtifact },
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });

  // metagraphed#7734: execute() catches every resolver throw into
  // result.errors rather than letting it propagate -- api.entry.ts's
  // top-level handler (uncaught exceptions only) never sees any of these, so
  // this is the only place a genuine resolver fault can be captured at all. A
  // deliberately-thrown `new GraphQLError(...)` (validation, "netuid must be
  // non-negative", etc. -- expected, caller-fixable, the GraphQL analogue of
  // a REST 4xx) is NOT the same as a resolver's raw Error wrapping a real
  // backend failure -- both get an `originalError`, so presence alone can't
  // tell them apart (confirmed directly against graphql-js's own execute(),
  // not assumed). The one reliable signal: a deliberate throw's
  // originalError is ITSELF a GraphQLError instance; a wrapped raw
  // exception's is not.
  const genuineFaults =
    result.errors?.filter(
      (e) => e.originalError && !(e.originalError instanceof GraphQLError),
    ) ?? [];
  for (const fault of genuineFaults) {
    // metagraphed#7758/#7766: PostHog $exception capture (Sentry.captureException
    // removed once parity was proven). handleGraphQLRequest has no
    // ExecutionContext (see this function's own comment in workers/api.ts),
    // so this is awaited inline rather than fire-and-forget via waitUntil --
    // the only real cost is a little latency on this already-failing
    // response, not silent event loss from an isolate torn down mid-fetch.
    await recordExceptionEvent(env, {
      error: fault.originalError,
      route: "graphql",
      errorCode: "graphql_execution_error",
    });
  }
  const errorCode =
    genuineFaults.length > 0
      ? "graphql_execution_error"
      : result.errors?.length
        ? "graphql_field_error"
        : undefined;

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: graphqlHeaders({
      // A GraphQL error is a 200 with a populated `errors` array; never advertise
      // it as cacheable, or a fronting cache could pin a transient backend failure.
      "cache-control": result.errors?.length
        ? "no-store"
        : "public, max-age=60, stale-while-revalidate=300",
      vary: "Accept-Encoding",
      ...(errorCode ? { "x-metagraph-error-code": errorCode } : {}),
    }),
  });
}
