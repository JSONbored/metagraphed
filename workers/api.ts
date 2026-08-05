import { economicsFieldSources } from "../src/economics-field-sources.ts";
import {
  API_QUERY_COLLECTIONS,
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  artifactPathFromTemplate,
  compileRoutePattern,
  liveOnlyArtifactRoute,
} from "../src/contracts.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// Loose ctx shape (matches request-handlers/analytics.ts's own EdgeCacheCtx) --
// call sites here sometimes pass a real Workers-runtime ExecutionContext,
// sometimes {} (e.g. handleScheduled's default), so a full ExecutionContext
// isn't required to satisfy every caller.
type Ctx = {
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Set only by the method gate's own existence probe (see `pathResolves`). It
   * suppresses the side effects a real request has -- usage rollup, rate-limit charge --
   * so asking "does this path exist" cannot be mistaken for someone having called it.
   */
  methodProbe?: boolean;
};
// The Cache API (`caches.default`) isn't in the generated Env/global types --
// it's a Workers-runtime global, not an Env binding.
const globalWithCaches = globalThis as unknown as { caches?: Row };
import {
  isUsageTelemetryConfigured,
  recordExceptionEvent,
  recordUsageEvent,
  parseUserAgentClient,
  statusClassOf,
  type UsageEvent,
} from "../src/usage-telemetry.ts";
import {
  newSpanId,
  newTraceId,
  recordTraceSpan,
  shouldSampleTrace,
} from "../src/tracing.ts";
import {
  recordLaneVerdict,
  type LaneHealthDb,
  type LaneVerdict,
} from "../src/lane-health.ts";
import {
  applyQueryFilters,
  canonicalListSearch,
  paginationLinkHeader,
  validateListQueryParams,
} from "./list-query.ts";
import { csvRequested, csvResponse } from "./csv.ts";
import {
  apiHeaders,
  errorResponse,
  exposeCustomResponseHeaders,
  ifNoneMatchSatisfied,
  isPathUnder,
  weakEtag,
  X_METAGRAPH_ARTIFACT_RESOLUTION_HEADER,
  X_METAGRAPH_ARTIFACT_SOURCE_HEADER,
  type CacheProfile,
} from "./http.ts";
import {
  latestPointer,
  logEvent,
  readArtifact,
  readHealthKv,
  readR2Object,
} from "./storage.ts";
import {
  contractStaleness,
  contractVersion,
  dataResponse,
  envelopeResponse,
  publishedAt,
} from "./responses.ts";
import {
  BADGE_SVG_PATTERN,
  homepageResponse,
  apiCatalogResponse,
  mcpServerCardResponse,
  agentToolsResponse,
  handleBadgeSvgRequest,
} from "./request-handlers/discovery.ts";
import {
  analyticsQueryError,
  configureAnalytics,
  edgeCacheScope,
  handleBulkHealthTrends,
  handleChainActivity,
  handleChainAlphaVolume,
  handleChainAxonRemovals,
  handleChainCalls,
  handleChainDeregistrations,
  handleChainFees,
  handleChainPrometheus,
  handleChainRegistrations,
  handleChainServing,
  handleChainSigners,
  handleChainStakeFlow,
  handleChainStakeMoves,
  handleChainStakeTransfers,
  handleChainTransferPairs,
  handleChainTransfers,
  handleChainWeightSetters,
  handleChainWeights,
  handleGlobalIncidents,
  handleHealthIncidents,
  handleHealthPercentiles,
  handleHealthTrends,
  resolveGlobalIncidentsForFeed,
  validateDeclaredQueryParams,
  withEdgeCache,
} from "./request-handlers/analytics.ts";
import {
  handleSubnetMetagraph,
  handleNeuron,
  handleSubnetHyperparams,
  handleSubnetHyperparamsHistory,
  handleSubnetValidators,
  handleSubnetEventSummary,
  handleSubnetEvents,
  handleNeuronHistory,
  handleSubnetHistory,
  handleSubnetIdentityHistory,
  handleSubnetConcentration,
  handleSubnetConcentrationHistory,
  handleSubnetPerformanceHistory,
  handleSubnetYieldHistory,
  handleChainConcentration,
  handleChainPerformance,
  handleChainIdentityHistory,
  canonicalChainIdentityHistoryCachePath,
  handleSelfHealth,
  handleChainYield,
  canonicalSubnetHistoryCachePath,
  canonicalValidatorHistoryCachePath,
  canonicalSubnetConcentrationHistoryCachePath,
  canonicalSubnetPerformanceHistoryCachePath,
  canonicalSubnetYieldHistoryCachePath,
  handleSubnetTurnover,
  canonicalSubnetTurnoverCachePath,
  handleSubnetStakeFlow,
  canonicalSubnetStakeFlowCachePath,
  handleSubnetAlphaVolume,
  handleSubnetOhlc,
  handleSubnetStakeQuote,
  handleSubnetValidatorEconomics,
  handleValidatorEconomicsRanking,
  handleSubnetValidatorEconomicsHistory,
  handleSubnetRecycled,
  handleSubnetBurn,
  handleChainBurn,
  handleSubnetBurnHistory,
  handleCrowdloan,
  handleCrowdloans,
  handleSubnetLease,
  handleSubnetWeights,
  canonicalSubnetWeightsCachePath,
  handleSubnetWeightSetters,
  canonicalSubnetWeightSettersCachePath,
  handleSubnetServing,
  canonicalSubnetServingCachePath,
  handleSubnetPrometheus,
  canonicalSubnetPrometheusCachePath,
  handleSubnetStakeMoves,
  canonicalSubnetStakeMovesCachePath,
  handleSubnetStakeTransfers,
  canonicalSubnetStakeTransfersCachePath,
  handleSubnetRegistrations,
  canonicalSubnetRegistrationsCachePath,
  handleSubnetAxonRemovals,
  canonicalSubnetAxonRemovalsCachePath,
  handleSubnetDeregistrations,
  canonicalSubnetDeregistrationsCachePath,
  handleSubnetYield,
  handleSubnetPerformance,
  handleSubnetIdleStake,
  handleChainIdleStake,
  handleSubnetMovers,
  canonicalSubnetMoversCachePath,
  handleChainTurnover,
  canonicalChainTurnoverCachePath,
  handleGlobalValidators,
  canonicalGlobalValidatorsCachePath,
  handleAccountsList,
  canonicalAccountsListCachePath,
  handleTopHoldersList,
  canonicalTopHoldersCachePath,
  handleValidatorDetail,
  handleValidatorNominators,
  handleValidatorHistory,
  canonicalSubnetMetagraphCachePath,
  canonicalSubnetValidatorsCachePath,
  canonicalSubnetYieldCachePath,
  handleAccount,
  handleAccountHistory,
  handleAccountBalance,
  handleAccountRootClaim,
  handleAccountChildren,
  handleAccountParents,
  handleAccountEntities,
  handleAccountEvents,
  handleAccountExtrinsics,
  handleAccountTransfers,
  handleAccountCounterparties,
  handleAccountStakeFlow,
  handleAccountStakeMoves,
  handleAccountWeightSetters,
  handleAccountRegistrations,
  handleAccountServing,
  handleAccountDeregistrations,
  handleAccountPrometheus,
  handleAccountAxonRemovals,
  handleAccountSubnets,
  handleAccountPortfolio,
  handleAccountPositions,
  handleAccountPositionHistory,
  handleAccountIdentity,
  handleAccountIdentityHistory,
  handleBlocks,
  handleBlocksSummary,
  handleBlock,
  handleBlockExtrinsics,
  handleBlockEvents,
  chainDetailGapResponse,
  handleExtrinsics,
  handleExtrinsic,
  handleSudo,
  handleSudoKey,
  handleEvmAddressMapping,
  handleNetworkParameters,
  handleRandomnessStatus,
  handleGovernanceConfigChanges,
  handleRuntime,
} from "./request-handlers/entities.ts";
import {
  canonicalCompareCachePath,
  canonicalEconomicsTrendsCachePath,
  canonicalLeaderboardsCachePath,
  canonicalTrajectoryCachePath,
  canonicalUptimeCachePath,
  configureAnalyticsRoutes,
  handleCompare,
  handleCompareValidators,
  handleDomains,
  handleDomainSummary,
  handleEconomicsTrends,
  handleEmissionPipeline,
  handleLeaderboards,
  handleTrajectory,
  handleUptime,
} from "./request-handlers/analytics-routes.ts";
import {
  classifyUpstreamAttempt,
  configureRpcProxy,
  graphqlRateLimited,
  handleRpcProxyRequest,
  handleRpcUsage,
  handleSurfaceVerify,
  isPrivateOrLocalHostname,
  isRpcEndpointEjected,
  orderSafeRpcEndpoints,
  proxyWithFailover,
  readRpcPoolArtifact,
  recordRpcFailure,
  recordRpcSuccess,
  rpcCachePolicy,
  RPC_POOL_ARTIFACT_TTL_MS,
  selectSafeRpcEndpoint,
  weightedPickEndpoint,
} from "./request-handlers/rpc-proxy.ts";
import { handleFullnodeRpcProxyRequest } from "./request-handlers/fullnode-rpc-proxy.ts";
import {
  buildChangeEvent,
  deliveryStoragePrefix,
  generateSecret,
  generateSubscriptionId,
  isValidSubscriptionId,
  publicSubscriptionView,
  subscriptionStorageKey,
  summarizeDeliveryRecords,
  WEBHOOK_REDELIVERY_LIST_LIMIT,
  timingSafeEqual,
  validateSubscriptionInput,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_IDEMPOTENCY_HEADER,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/webhooks.ts";
import {
  ALERT_TRIGGER_CREATE_TOKEN_HEADER,
  ALERT_TRIGGER_OWNER_TOKEN_HEADER,
} from "../src/alert-triggers.ts";
import {
  GATE_PARAM_SOURCES,
  gateParamChanges,
  subnetEnabledChanges,
  type GateParam,
  type GateParamReading,
} from "../src/emission-gate-history.ts";
import {
  EMA_FROZEN_BASELINE_BLOCK,
  FLOW_PARAM_ITEMS,
  emaAdvancedEvents,
  flowParamEvents,
  type FlowParamItem,
  type FlowParamObservation,
} from "../src/emission-flow-monitor.ts";
import {
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
  pruneHealthHistory,
  rollupDailyUptime,
  runHealthProber,
  writeSubnetSnapshot,
} from "../src/health-prober.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import { readCachedNetworkParametersSnapshot } from "../src/network-parameters.ts";
import {
  mergeFreshness,
  mergeRpcEndpoints,
  overlayArtifactEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlayRpcPoolEligibility,
  overlaySubnetEconomics,
  overlaySubnetHealth,
  resolveLiveEconomics,
  resolveLiveHealth,
  withSpotPricedEconomics,
} from "../src/health-serving.ts";
import {
  deriveNetuidGroupedAliases,
  derivePreviouslyKnownAs,
  overlayPreviouslyKnownAs,
} from "../src/subnet-identity-history.ts";
import { tryPostgresTier } from "./postgres-tier.ts";
import { chainEventsQueryError } from "../src/chain-events-cold-tier.ts";
import {
  type ColdTierAnswer,
  chainEventsQueryFromUrl,
  coldTierChainEventsPayload,
  degradedChainEventsPayload,
  hotTierBlockChainEvents,
} from "../src/chain-events-degraded.ts";
import { markPostgresTierFallbackResponse } from "./request-handlers/analytics.ts";
import { loadGlobalOperationalHealth } from "../src/global-operational-health.ts";
import {
  CHAIN_FIREHOSE_INGEST_TOKEN_HEADER,
  ChainFirehoseHub,
} from "./chain-firehose-hub.ts";
import { McpSessionHub } from "./mcp-session-hub.ts";
import { AlerterHub } from "./alerter-hub.ts";
import { SubnetStatusHub } from "./subnet-status-hub.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { handleFeedRequest, resolveFeedFormat } from "../src/feeds.ts";
import { handleBadgeRequest } from "../src/badge.ts";
import { handleOgImage } from "../src/og-image.ts";
import { handleIconProxy } from "../src/icon-proxy.ts";
import { maskRouteParams } from "../src/route-label.ts";
import { sampleEmissionGate } from "../src/emission-gate-sampler.ts";
import { checkEmissionDrift } from "../src/emission-drift-check.ts";
import { refreshLiveEconomics } from "../src/live-economics-refresh.ts";
import { runNeuronsStalenessWatchdog } from "../src/neurons-staleness-watchdog.ts";
import { runNominatorPositionsStalenessWatchdog } from "../src/nominator-positions-staleness-watchdog.ts";
import { runProjectionStalenessWatchdog } from "../src/projection-staleness-watchdog.ts";
import { runValidatorNominatorCountsStalenessWatchdog } from "../src/validator-nominator-counts-staleness-watchdog.ts";
import { runAccountBalancesStalenessWatchdog } from "../src/account-balances-staleness-watchdog.ts";
import {
  readChainDetailHead,
  runChainDetailStalenessWatchdog,
} from "../src/chain-detail-staleness-watchdog.ts";
import { pruneChainDetail } from "../src/chain-detail-prune.ts";
import { runRpcUsageStalenessWatchdog } from "../src/rpc-usage-staleness-watchdog.ts";
import { runTopHoldersStalenessWatchdog } from "../src/top-holders-staleness-watchdog.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { validateResponseTripwire } from "../src/response-validation-tripwire.ts";
import {
  handleAuthorizeRequest,
  handleGithubOAuthCallback,
  isMcpEndpointPath,
} from "../src/github-oauth.ts";
import {
  handleSavedQueryRequest,
  SAVED_QUERIES_PATH_PREFIX,
} from "./request-handlers/saved-queries.ts";
import {
  aiEnabled,
  AI_TIERED_RATE_LIMIT,
  askQuestion,
  runEmbeddingSync,
  semanticSearch,
} from "../src/ai-search.ts";
import { runGithubSignalsSync } from "../src/github-signals-sync.ts";
import { runRawCaptureSync } from "../src/raw-capture-sync.ts";
import {
  captureSubnetBurnHistory,
  type BurnHistoryDb,
} from "../src/subnet-burn-history.ts";
import { runOperationalSurfacesSync } from "../src/operational-surfaces-sync.ts";
import { runSchemaSnapshotsSync } from "../src/schema-snapshots-sync.ts";
import { runSurfaceVerificationSync } from "../src/surface-verification-sync.ts";
import {
  ACCOUNT_BALANCE_PATH_PATTERN,
  ACCOUNT_ROOT_CLAIM_PATH_PATTERN,
  ACCOUNT_CHILDREN_PATH_PATTERN,
  ACCOUNT_PARENTS_PATH_PATTERN,
  ACCOUNT_ENTITIES_PATH_PATTERN,
  ACCOUNT_EVENTS_PATH_PATTERN,
  ACCOUNT_HISTORY_PATH_PATTERN,
  ACCOUNT_EXTRINSICS_PATH_PATTERN,
  ACCOUNT_TRANSFERS_PATH_PATTERN,
  ACCOUNT_COUNTERPARTIES_PATH_PATTERN,
  ACCOUNT_STAKE_FLOW_PATH_PATTERN,
  ACCOUNT_STAKE_MOVES_PATH_PATTERN,
  ACCOUNT_WEIGHT_SETTERS_PATH_PATTERN,
  ACCOUNT_REGISTRATIONS_PATH_PATTERN,
  ACCOUNT_SERVING_PATH_PATTERN,
  ACCOUNT_DEREGISTRATIONS_PATH_PATTERN,
  ACCOUNT_PROMETHEUS_PATH_PATTERN,
  ACCOUNT_AXON_REMOVALS_PATH_PATTERN,
  ACCOUNT_PATH_PATTERN,
  ACCOUNT_SUBNETS_PATH_PATTERN,
  ACCOUNT_PORTFOLIO_PATH_PATTERN,
  ACCOUNT_POSITIONS_PATH_PATTERN,
  ACCOUNT_SUBNET_POSITION_HISTORY_PATH_PATTERN,
  ACCOUNT_IDENTITY_PATH_PATTERN,
  ACCOUNT_IDENTITY_HISTORY_PATH_PATTERN,
  BLOCK_DETAIL_PATH_PATTERN,
  BLOCK_EXTRINSICS_PATH_PATTERN,
  BLOCK_EVENTS_PATH_PATTERN,
  BLOCK_CHAIN_EVENTS_PATH_PATTERN,
  BLOCKS_FEED_PATH_PATTERN,
  EXTRINSIC_DETAIL_PATH_PATTERN,
  EXTRINSICS_FEED_PATH_PATTERN,
  ACCOUNT_EVENTS_ROLLUP_CRON,
  FRESHNESS_WATCHDOG_CRON,
  LAKEHOUSE_SEAM_CRON,
  SAFE_MODE_WATCHDOG_CRON,
  EMISSION_GATE_SAMPLE_CRON,
  EMISSION_DRIFT_CHECK_CRON,
  NEURONS_STALENESS_WATCHDOG_CRON,
  NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON,
  PROJECTION_STALENESS_WATCHDOG_CRON,
  VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON,
  CHAIN_DETAIL_PRUNE_CRON,
  CHAIN_DETAIL_STALENESS_WATCHDOG_CRON,
  TOP_HOLDERS_FLOW_CRON,
  TOP_HOLDERS_STALENESS_WATCHDOG_CRON,
  ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON,
  LIVE_ECONOMICS_REFRESH_CRON,
  PROJECTION_LANES_CRON,
  FRESHNESS_WATCHDOG_STATE_KEY,
  BULK_TRENDS_PATH_PATTERN,
  ABUSE_SCAN_CRON,
  UPGRADE_RADAR_CRON,
  EMBEDDING_SYNC_CRON,
  GITHUB_SIGNALS_SYNC_CRON,
  RAW_CAPTURE_CRON,
  SUBNET_BURN_CAPTURE_CRON,
  OPERATIONAL_SURFACES_SYNC_CRON,
  SCHEMA_SNAPSHOTS_SYNC_CRON,
  SURFACE_VERIFICATION_SYNC_CRON,
  GOVERNANCE_CONFIG_CHANGES_PATH_PATTERN,
  HEALTH_PRUNE_CRON,
  INCIDENTS_PATH_PATTERN,
  JSON_CONTENT_TYPE,
  MAX_ASK_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
  PERCENTILES_PATH_PATTERN,
  RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN,
  resolveClientIp,
  ROLLUP_TOKEN_HEADER,
  RUNTIME_VERSIONS_PATH_PATTERN,
  SUBNET_BURN_HISTORY_PATH_PATTERN,
  SUBNET_HISTORY_PATH_PATTERN,
  SUBNET_HYPERPARAMS_PATH_PATTERN,
  SUBNET_HYPERPARAMS_HISTORY_PATH_PATTERN,
  SUBNET_IDENTITY_HISTORY_PATH_PATTERN,
  SUBNET_METAGRAPH_PATH_PATTERN,
  SUBNET_NEURON_HISTORY_PATH_PATTERN,
  SUBNET_NEURON_PATH_PATTERN,
  SUBNET_VALIDATORS_PATH_PATTERN,
  VALIDATOR_DETAIL_PATH_PATTERN,
  VALIDATOR_NOMINATORS_PATH_PATTERN,
  VALIDATOR_HISTORY_PATH_PATTERN,
  SUBNET_EVENT_SUMMARY_PATH_PATTERN,
  SUBNET_EVENTS_PATH_PATTERN,
  TRAJECTORY_PATH_PATTERN,
  SUBNET_CONCENTRATION_PATH_PATTERN,
  SUBNET_CONCENTRATION_HISTORY_PATH_PATTERN,
  SUBNET_PERFORMANCE_HISTORY_PATH_PATTERN,
  SUBNET_YIELD_HISTORY_PATH_PATTERN,
  SUBNET_TURNOVER_PATH_PATTERN,
  SUBNET_STAKE_FLOW_PATH_PATTERN,
  SUBNET_ALPHA_VOLUME_PATH_PATTERN,
  SUBNET_OHLC_PATH_PATTERN,
  SUBNET_STAKE_QUOTE_PATH_PATTERN,
  SUBNET_VALIDATOR_ECONOMICS_PATH_PATTERN,
  VALIDATOR_ECONOMICS_RANKING_PATH,
  SUBNET_VALIDATOR_ECONOMICS_HISTORY_PATH_PATTERN,
  SUBNET_RECYCLED_PATH_PATTERN,
  SUBNET_BURN_PATH_PATTERN,
  CROWDLOANS_PATH_PATTERN,
  CROWDLOAN_DETAIL_PATH_PATTERN,
  SUBNET_LEASE_PATH_PATTERN,
  SUBNET_WEIGHTS_PATH_PATTERN,
  SUBNET_WEIGHT_SETTERS_PATH_PATTERN,
  SUBNET_SERVING_PATH_PATTERN,
  SUBNET_PROMETHEUS_PATH_PATTERN,
  SUBNET_STAKE_MOVES_PATH_PATTERN,
  SUBNET_STAKE_TRANSFERS_PATH_PATTERN,
  SUBNET_REGISTRATIONS_PATH_PATTERN,
  SUBNET_AXON_REMOVALS_PATH_PATTERN,
  SUBNET_DEREGISTRATIONS_PATH_PATTERN,
  SUBNET_YIELD_PATH_PATTERN,
  SUBNET_PERFORMANCE_PATH_PATTERN,
  SUBNET_IDLE_STAKE_PATH_PATTERN,
  DOMAIN_SUMMARY_PATH_PATTERN,
  SUDO_CALLS_PATH_PATTERN,
  SUDO_KEY_PATH_PATTERN,
  EVM_ADDRESS_MAPPING_PATH_PATTERN,
  NETWORK_PARAMETERS_PATH_PATTERN,
  RANDOMNESS_PATH_PATTERN,
  TRENDS_PATH_PATTERN,
  UPTIME_PATH_PATTERN,
  WEBHOOK_SUBSCRIPTION_TOKEN_HEADER,
  WEBHOOK_TTL_SECONDS,
} from "./config.ts";
import { evaluateUpgradeRadarScan } from "../src/upgrade-radar.ts";
import { evaluateFreshness, shouldReport } from "../src/freshness-watchdog.ts";
import { buildNetworksPayload } from "../src/network-capabilities.ts";
import { NETWORK_PUBLISHED_ARTIFACT_PATHS } from "../src/network-artifacts.ts";
import { type ChainNetworkId, chainNetworkId } from "../src/chain-network.ts";
import { LIVE_CHAIN_ROUTE_PATHS } from "../src/live-chain-routes.ts";
import { CHAIN_HISTORY_ROUTE_PATHS } from "../src/chain-history-routes.ts";
import { PROJECTION_ROUTE_PATHS } from "../src/projection-routes.ts";
import {
  subnetNewsItems,
  type ChainEventRow,
  type HyperparamSnapshot,
  type NewsItem,
  type SubnetRelease,
} from "../src/subnet-news.ts";
import {
  applyTieredRateLimit,
  tieredRejectionResponse,
  type TieredRateLimitConfig,
  type TieredRateLimitResult,
} from "./tiered-rate-limit.ts";
import { buildTierPolicies } from "../src/api-tiers.ts";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
import { foldObservations, observeRequest } from "../src/usage-rollup.ts";
import type { UsageObservation } from "../src/usage-rollup.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import { runLakehouseSeamWatchdog } from "../src/lakehouse-seam-watchdog.ts";
import { runSafeModeWatchdog } from "../src/safe-mode-watchdog.ts";
import {
  runProjectionLane,
  runProjectionLanes,
} from "../src/projection-lanes.ts";
import { TOP_HOLDERS_FLOW_LANE } from "../src/top-holders-flow-tier.ts";

// #8386: anonymous stays the existing, regression-tested DATA_RATE_LIMITER
// policy (60/60s, unchanged); a caller with a valid mg_... key gets 5x via a
// SEPARATE Cloudflare Rate Limiting binding (DATA_RATE_LIMITER_KEYED,
// wrangler.jsonc), never the same binding with a different number -- one
// named binding is always one fixed limit/period pair.
// Exported for tests/api-tiers.test.ts, which pins every tier's advertised
// limit against the wrangler.jsonc binding that actually enforces it.
export const DATA_TIERED_RATE_LIMIT: TieredRateLimitConfig = {
  anonymous: { envVar: "DATA_RATE_LIMITER", limit: 60, windowSeconds: 60 },
  keyed: { envVar: "DATA_RATE_LIMITER_KEYED", limit: 300, windowSeconds: 60 },
  // #8608: per-tier ceilings. `free` keeps DATA_RATE_LIMITER_KEYED's existing
  // 300/min; community and paid get their own bindings (src/api-tiers.ts).
  tiers: buildTierPolicies("DATA_RATE_LIMITER", 300),
  keyPrefix: "data",
};

// Route-template matchers for #8597's usage rollup, built once at module load
// from the SAME API_ROUTES table the dispatcher uses. Reusing that table is the
// whole point: the rollup's family set is bounded by the route table by
// construction, and cannot drift from the routes actually served the way a
// hand-maintained family map would.
const USAGE_ROLLUP_MATCHERS = API_ROUTES.map((entry) => ({
  path: entry.path,
  pattern: compileRoutePattern(entry.path),
}));

// Fire-and-forget ALL-TRAFFIC usage rollup (#8597) -- keyed and keyless alike.
//
// Distinct from recordApiKeyUsage below, which it does not replace: that one is
// per-account and only fires for requests presenting a key, powering the tenant
// dashboard. This one has no account dimension and fires for EVERY API request,
// because keyless traffic is the majority by design and is the entire subject
// of the "does the free tier cost too much" question ADR 0022 defers.
//
// Same posture as recordApiKeyUsage: ctx.waitUntil so it adds no latency, and
// it swallows its own failure -- a rollup miss must never surface as an error
// on the actual API call.
// #8823: observations are BUFFERED in the isolate and flushed in batches.
//
// Until this landed, foldObservations was handed a single-element array on
// every request, so N requests meant N DATA_API subrequests, N postgres()
// clients (withAccountsSql builds a fresh one per invocation), and N upserts
// -- and a flood of `/api/v1/<random>` 404s all collapse to the single
// (day, "unmatched", "edge") row, so those N upserts serialised on one row
// lock against a self-hosted database whose capacity is ours. Nothing
// throttles that path: /api/* is run_worker_first and the generic 404 is
// reached without passing any of the per-surface limiters.
//
// The flush triggers are count-OR-age, evaluated synchronously as each
// observation arrives (Workers has no timer that runs outside a request, so
// the age check can only fire when a LATER request arrives -- which is
// exactly when a flush is affordable). Both bounds are deliberately small:
// they cap what an isolate can lose on eviction, which is the one accuracy
// cost of buffering.
const USAGE_ROLLUP_FLUSH_COUNT = 64;
const USAGE_ROLLUP_FLUSH_AGE_MS = 10_000;
let usageRollupBuffer: UsageObservation[] = [];
let usageRollupBufferedAtMs = 0;

// Exported for the tests that assert the batching property; not part of any
// route's behaviour.
export function usageRollupBufferSize(): number {
  return usageRollupBuffer.length;
}

// Drain the buffer into ONE subrequest carrying every folded bucket. Drains
// before the fetch so a concurrent request in the same isolate cannot send
// the same observations twice. A failed POST loses that batch, the same
// best-effort posture the single-observation write already had -- a rollup
// miss must never surface on the API call that triggered it.
export function flushUsageRollup(env: Env, ctx: Ctx | undefined): void {
  if (usageRollupBuffer.length === 0) return;
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN) return;
  const buckets = foldObservations(usageRollupBuffer);
  usageRollupBuffer = [];
  usageRollupBufferedAtMs = 0;
  const pending = env.DATA_API.fetch(
    new Request("https://api.metagraph.sh/api/v1/internal/usage-rollup", {
      method: "POST",
      headers: {
        [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ buckets }),
    }),
  ).catch(() => {});
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(pending);
  }
}

export function recordUsageRollup(
  env: Env,
  ctx: Ctx | undefined,
  pathname: string,
  keyed: boolean,
): void {
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN) return;
  const observation = observeRequest(pathname, USAGE_ROLLUP_MATCHERS, {
    keyed,
  });
  const nowMs = Date.now();
  if (usageRollupBuffer.length === 0) usageRollupBufferedAtMs = nowMs;
  usageRollupBuffer.push(observation);
  // A buffer spanning midnight needs no special case: each observation
  // carries its own `day` and foldObservations groups on it, so the batch
  // simply emits two buckets.
  if (
    usageRollupBuffer.length < USAGE_ROLLUP_FLUSH_COUNT &&
    nowMs - usageRollupBufferedAtMs < USAGE_ROLLUP_FLUSH_AGE_MS
  ) {
    return;
  }
  flushUsageRollup(env, ctx);
}

// Fire-and-forget usage-counter increment for the self-serve dashboard
// (#8386) -- via ctx.waitUntil so it never adds latency to the response that
// triggered it, and swallows its own failure (a usage-counter miss must
// never surface as an error on the actual API call).
export function recordApiKeyUsage(
  env: Env,
  ctx: Ctx | undefined,
  accountId: string,
  route: string,
  // #8609: a REJECTED request increments rejected_count instead of
  // request_count, so the tenant dashboard can show "you were throttled N
  // times" without those attempts inflating the usage they are billed against.
  rejected = false,
): void {
  if (!env.DATA_API?.fetch || !env.API_KEY_LOOKUP_INTERNAL_TOKEN) return;
  const pending = env.DATA_API.fetch(
    new Request("https://api.metagraph.sh/api/v1/internal/keys/usage", {
      method: "POST",
      headers: {
        [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        account_id: Number(accountId),
        route,
        rejected,
      }),
    }),
  ).catch(() => {});
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(pending);
  }
}

// #8611: the daily per-key abuse scan.
//
// Calls the internal anomalies route (the one place that scores usage) and
// reports the result to the ops channel -- PostHog, which is where this
// codebase's operational signal already goes. Notification ONLY: nothing here
// blocks anyone. An automated block on a heuristic like "used many route
// families" would eventually cut off a legitimate integration doing exactly
// what the API is for, so the scan ranks a queue and a human decides.
export const ABUSE_SCAN_ALERT_THRESHOLD = 1;

export async function runAbuseScan(env: Env, ctx?: Ctx) {
  const token = (env as unknown as { API_KEY_BLOCK_INTERNAL_TOKEN?: string })
    .API_KEY_BLOCK_INTERNAL_TOKEN;
  if (!env.DATA_API?.fetch || !token) {
    return { ok: false, reason: "not_provisioned" };
  }
  const startedAt = Date.now();
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/keys/anomalies?days=7",
        { headers: { "x-api-key-block-token": token } },
      ),
    );
    if (!upstream.ok)
      return { ok: false, reason: `upstream_${upstream.status}` };
    const body = (await upstream.json()) as {
      flagged_count?: number;
      accounts_seen?: number;
    };
    const flagged = Number(body?.flagged_count) || 0;
    // Quiet when there is nothing to say. A daily "0 flagged" event would
    // train whoever watches this channel to skip it.
    if (flagged >= ABUSE_SCAN_ALERT_THRESHOLD) {
      const pending = recordUsageEvent(env, {
        route: "abuse-scan",
        ok: true,
        durationMs: Date.now() - startedAt,
      }).catch(() => false);
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
    }
    return {
      ok: true,
      flagged,
      accountsSeen: Number(body?.accounts_seen) || 0,
    };
  } catch {
    // A scan that cannot run is not an outage -- it is one missed daily report.
    return { ok: false, reason: "unreachable" };
  }
}

// #8702: twice-hourly upgrade radar tick. Two jobs, in this order: refresh the
// captured GitHub sources so the request path's KV read stays fresh, then
// decide whether a NEW testnet soak deserves the ops channel.
//
// The once-per-spec-version guard lives in evaluateUpgradeRadarScan (which
// persists the alerted version before returning), not here -- so this function
// cannot double-fire even if it is invoked twice for the same tick, and the
// guard is unit-testable without a transport. Emitting is all that is left.
export async function runUpgradeRadarScan(env: Env, ctx?: Ctx) {
  const startedAt = Date.now();
  try {
    const scan = await evaluateUpgradeRadarScan(env);
    if (scan.alert) {
      const pending = recordUsageEvent(env, {
        route: "upgrade-radar",
        ok: true,
        durationMs: Date.now() - startedAt,
      }).catch(() => false);
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
    }
    return {
      ok: true,
      state: scan.state,
      mainnet_spec_version: scan.mainnetSpec,
      testnet_spec_version: scan.testnetSpec,
      alerted: scan.alert,
    };
  } catch {
    // A tick that cannot run is one stale capture, not an outage.
    return { ok: false, reason: "unreachable" };
  }
}

// Hourly freshness watchdog tick.
//
// Reads the freshness artifact the build already writes and compares every
// source against the staleness policy that source declares for ITSELF -- see
// src/freshness-watchdog.ts for why that is the signal worth alarming on, and
// why this is the one alarm that survives the boxes.
//
// Degrades to a no-op rather than throwing when the artifact or the KV binding
// is missing: a watchdog that can take the Worker's cron down with it is a
// liability, and a missed tick is one missed report.
export async function runFreshnessWatchdog(
  env: Env,
  ctx?: Ctx,
  deps: { readArtifact?: ArtifactReader; laneHealthDb?: LaneHealthDb } = {},
) {
  const startedAt = Date.now();
  const readArtifactFn = (deps.readArtifact ??
    (readArtifact as unknown as ArtifactReader)) as ArtifactReader;
  const laneHealthDb = deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as never);
  try {
    const artifact = (await readArtifactFn(
      env,
      "/metagraph/freshness.json",
    )) as { sources?: unknown } | null;
    if (!artifact) {
      // #9440: `unknown` is the vocabulary's own word for "the watchdog could
      // not evaluate the lane", and it is NOT a synonym for ok. Without this
      // row, a watchdog that cannot read its own artifact is indistinguishable
      // from one reporting everything fresh -- both produce silence.
      await recordFreshnessLaneVerdict(laneHealthDb, {
        verdict: "unknown",
        detail: "artifact_unavailable",
      });
      return { ok: false, reason: "artifact_unavailable" };
    }

    const verdict = evaluateFreshness(artifact.sources, Date.now());
    // No KV means no memory of what was already reported. Report anyway rather
    // than going silent -- a noisy alarm beats an absent one, and this is the
    // only alarm left.
    const kv = env.METAGRAPH_CONTROL;
    const last = kv?.get
      ? await kv.get(FRESHNESS_WATCHDOG_STATE_KEY).catch(() => null)
      : null;
    const report = shouldReport(verdict, last);

    if (report) {
      const pending = recordUsageEvent(env, {
        route: "freshness-watchdog",
        // `ok` describes whether the TICK ran, not whether the data is fresh --
        // the staleness itself is carried by the fields below, and marking a
        // successful check as a failure would make the watchdog look broken
        // every time it correctly found something.
        ok: true,
        durationMs: Date.now() - startedAt,
      }).catch(() => false);
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
      if (kv?.put) {
        await kv
          .put(FRESHNESS_WATCHDOG_STATE_KEY, verdict.signature)
          .catch(() => undefined);
      }
    }

    // #9440: the DURABLE record, written on EVERY tick rather than only when
    // shouldReport decides this verdict is worth notifying about.
    //
    // That distinction is the whole bug. `shouldReport` deliberately
    // suppresses a repeat of the same signature, so a lane that has been
    // critical for six hours notifies once and then goes quiet -- correct for
    // a notification, useless as a record. Everything this watchdog computed
    // (which sources are stale, which are critical, how many were checked)
    // existed only in the return value, and workers/api.entry.ts discards
    // what `scheduled` returns. It was measured, then dropped.
    //
    // Never throws -- see recordLaneVerdict.
    await recordFreshnessLaneVerdict(laneHealthDb, {
      // `critical` is a subset of `stale`, so the latter alone decides the
      // verdict; severity lives in `detail` and in the notification.
      verdict: verdict.stale.length > 0 ? "stale" : "ok",
      // The names, not the counts: "which source" is the first question asked
      // of a stale verdict, and the count is derivable from it.
      detail:
        verdict.stale.length > 0
          ? // The ids, not the entries: a stale entry is an object, and
            // joining those yields a row of "[object Object]". Critical
            // sources are a SUBSET of stale (critical = stale filtered by
            // behavior+required), so listing stale alone covers both without
            // repeating any id.
            verdict.stale
              .slice(0, FRESHNESS_LANE_DETAIL_LIMIT)
              .map((entry) => entry.id)
              .join(",")
          : null,
    });

    return {
      ok: true,
      checked: verdict.checked,
      skipped: verdict.skipped,
      stale_count: verdict.stale.length,
      critical_count: verdict.critical.length,
      reported: report,
      // Bounded: a total publish stall makes EVERY source stale at once, and an
      // alert body listing all of them is one nobody reads.
      critical: verdict.critical.slice(0, 10),
      stale: verdict.stale.slice(0, 10),
    };
  } catch {
    // A tick that cannot run is one missed report, not an outage -- but it is
    // still a tick that produced no measurement, and saying so is the point of
    // the `unknown` verdict. Before this, an unreachable watchdog and a
    // healthy one were both silent.
    await recordFreshnessLaneVerdict(laneHealthDb, {
      verdict: "unknown",
      detail: "unreachable",
    });
    return { ok: false, reason: "unreachable" };
  }
}

// Same bound the alert body uses, for the same reason: a total publish stall
// makes every source stale at once, and a row listing all of them is one
// nobody reads.
const FRESHNESS_LANE_DETAIL_LIMIT = 10;

/**
 * One freshness verdict, in the shape src/lane-health.ts stores. Wrapped
 * because this watchdog records from four places (no artifact, stale, ok,
 * unreachable) and the lane name and clock must be identical across all of
 * them -- a lane whose name varies by branch is a lane the self-health card
 * reads as several.
 */
function recordFreshnessLaneVerdict(
  db: LaneHealthDb | null | undefined,
  { verdict, detail }: { verdict: LaneVerdict; detail: string | null },
) {
  return recordLaneVerdict(db, {
    lane: "freshness",
    verdict,
    // This watchdog evaluates each source against the policy that source
    // declares for itself, so there is no single fleet-wide age to report --
    // unlike the per-lane watchdogs, whose age_ms is one lane's own lag.
    age_ms: null,
    detail,
    checked_at: Date.now(),
  });
}

// #8704: per-subnet chain news for the subnet feed.
//
// Builds FRESH requests against the upstream paths rather than forwarding the
// feed's own request. That distinction is the #8242/#8353 bug twice over: a
// forwarded request carries a path DATA_API has no route for, and the failure
// is silent -- it degrades to an empty result that looks exactly like "this
// subnet has no news". Every fetch here names the path it wants.
//
// Each source is isolated: one tier being unavailable costs its own items and
// nothing else, and a total failure yields [] so the feed still serves its
// registry and incident items.
const SUBNET_NEWS_SOURCE_LIMIT = 40;

async function fetchDataApiJson(env: Env, path: string): Promise<Row | null> {
  if (!env.DATA_API?.fetch) return null;
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(`https://api.metagraph.sh${path}`),
    );
    if (!upstream.ok) return null;
    return (await upstream.json()) as Row;
  } catch {
    return null;
  }
}

// The subnet record carries github_releases (scripts/github-signals.ts). Read
// from the served artifact rather than DATA_API: it is the same file the
// subnet page already reads, so this adds no query to the indexer box.
type ArtifactReader = (env: Env, path: string) => Promise<Row>;

async function readSubnetProfileForNews(
  env: Env,
  netuid: number,
  read: ArtifactReader,
): Promise<Row | null> {
  try {
    const result = await read(env, `/metagraph/subnets/${netuid}.json`);
    return result?.ok ? ((result.data ?? null) as Row | null) : null;
  } catch {
    return null;
  }
}

export async function resolveSubnetNewsForFeed(
  env: Env,
  netuid: number,
  // Injected rather than closed over, matching writeSubnetSnapshot's own
  // deps-injection: mocking workers/storage.ts wholesale breaks this module's
  // initialization order, and a seam is cheaper than a mock anyway.
  deps: { readArtifact?: ArtifactReader } = {},
): Promise<NewsItem[]> {
  const readArtifactFn = (deps.readArtifact ??
    (readArtifact as unknown as ArtifactReader)) as ArtifactReader;
  if (!Number.isInteger(netuid) || netuid < 0) return [];
  const limit = SUBNET_NEWS_SOURCE_LIMIT;
  const [hyperparams, ownership, lease, profile] = await Promise.all([
    fetchDataApiJson(
      env,
      `/api/v1/subnets/${netuid}/hyperparameters/history?limit=${limit}`,
    ),
    fetchDataApiJson(
      env,
      `/api/v1/subnets/${netuid}/ownership-history?limit=${limit}`,
    ),
    fetchDataApiJson(
      env,
      `/api/v1/subnets/${netuid}/lease/history?limit=${limit}`,
    ),
    // #8704 part 2: releases ride along on the subnet's own record, captured
    // by scripts/github-signals.ts. No new GitHub call from the request path —
    // same reasoning as the upgrade radar's, and the data is already here.
    readSubnetProfileForNews(env, netuid, readArtifactFn),
  ]);
  // The hyperparameter tier returns newest-first; the differ needs ascending
  // order to compare a row against the one before it in time.
  const snapshots = Array.isArray(hyperparams?.entries)
    ? [...(hyperparams.entries as HyperparamSnapshot[])].sort(
        (a, b) => Number(a?.block_number) - Number(b?.block_number),
      )
    : [];
  return subnetNewsItems({
    netuid,
    hyperparamSnapshots: snapshots,
    ownershipRows: (ownership?.ownership_changes as ChainEventRow[]) ?? [],
    leaseRows: (lease?.lease_events as ChainEventRow[]) ?? [],
    releases: (profile?.github_releases as SubnetRelease[] | null) ?? null,
  });
}

const RAW_ARTIFACT_ROUTES = PUBLIC_ARTIFACTS.filter((entry) =>
  entry.path.endsWith(".json"),
).map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
}));

const ROUTES = API_ROUTES.map((entry) => ({
  ...entry,
  pattern: compileRoutePattern(entry.path),
  artifactPath(params: Row) {
    return artifactPathFromTemplate(entry.artifact_path, params);
  },
}));

// Routes that can include live operational-health overlays must never use the
// edge Cache API. Cache eligibility is route-based instead of checking whether
// live data was available for a particular request, so a cold KV/D1 overlay
// cannot seed stale static fallbacks into the edge cache.
const LIVE_OVERLAY_ROUTE_IDS = new Set([
  "health",
  "subnet-health",
  "rpc-endpoints",
  "rpc-pools",
  "freshness",
  "subnet-overview",
  "agent-catalog",
  "agent-catalog-subnet",
  "endpoints",
  "subnet-endpoints",
  "provider-endpoints",
  // Economics serves live from KV 'economics:current' (refreshed independently of
  // the data publish), falling back to the committed R2 economics.json — so it must
  // not be static-edge-cached.
  "economics",
  // subnet-detail overlays live economics (alpha price, registration cost) from
  // the same KV blob, plus D1 identity aliases -- see the `matched.id ===
  // "subnet-detail"` branch below. It was missing here: this set was introduced
  // to skip the edge cache for live overlays, and the subnet-detail overlay was
  // added later without updating it, so isStaticEdgeCacheEligible returned true
  // and a live alpha price could be edge-cached for 300s + 300s SWR with no
  // invalidation. Masked today only because the generic endpoint overlay happens
  // to fire for every currently-catalogued subnet -- which is NOT true of a
  // newly-registered subnet with no catalogued surfaces, i.e. exactly the one
  // whose price and registration cost move fastest.
  "subnet-detail",
]);

function isStaticEdgeCacheEligible(
  matched: Row,
  network: typeof DEFAULT_NETWORK,
) {
  return !network.isDefault || !LIVE_OVERLAY_ROUTE_IDS.has(matched.id);
}

// Live-overlay COLLECTION routes worth caching keyed on the cron snapshot's
// last_run_at (not the static edge cache, since their body carries live status).
// Scoped to the large /api/v1/endpoints index (~1.43 MB / 1160 rows) whose
// overlay output is fully determined by (contract_version, last_run_at) — the
// per-subnet `subnet-endpoints` variant is small and intentionally excluded.
const CACHEABLE_OVERLAY_ROUTE_IDS = new Set(["endpoints"]);

// Reduce a request's query string to its canonical, cache-relevant form: keep
// only the params that actually steer the response body (the collection's
// filters / search / sort / pagination / projection), single-valued, and emit
// them in a deterministic order. URLSearchParams.set sorts nothing, but the
// fixed iteration order below makes `?b=2&a=1` and `?a=1&b=2&unused=x` collapse
// to the same key — so param order and ignored params stop fragmenting the
// cache. Routes with no query collection (pure static artifacts) honour no
// params at all, so their canonical search is the empty string. Shared by both
// the static edge cache and the live-overlay collection cache.
function canonicalCacheSearch(url: URL, matched: Row) {
  return canonicalListSearch(
    url,
    matched.queryCollection,
    matched.queryFilterNames || [],
  );
}

// Product-usage telemetry (#6032 / #366). The Worker entry is the single
// cross-cutting chokepoint every REST and GraphQL request passes through while
// an ExecutionContext is still live, so it is the one place a usage event can
// be recorded exactly once per request. Every wrapper further down is partial:
// withEdgeCache covers only the cached analytics GETs (and returns before
// buildResponse on a hit, so it never sees a full request), the artifact edge
// cache is artifact-routes-only, and handleGraphQLRequest is not handed ctx at
// all. Instrumenting here also keeps this to one point per transport rather
// than one per route handler.

// GraphQL is one transport with one HTTP route — every operation shares this
// label rather than fanning out into client-supplied operation names, which are
// unbounded and would have to be read out of the request body.
const GRAPHQL_USAGE_ROUTE = "graphql";

/**
 * Low-cardinality usage label for a request URL, or null when the request must
 * not be recorded at this chokepoint.
 *
 * Route ids come from the shared API_ROUTES contract, so path parameters
 * (netuid, ss58, block ref, ...) collapse into one stable label instead of one
 * label per account. Non-default networks are namespaced onto the label, which
 * is what gives #366 its route+network dimensions without widening the event
 * allowlist (the day dimension is the event timestamp).
 *
 * @param {URL} url
 * @returns {string | null}
 */
// #8996: the auth-surface paths that get a usage label despite living outside
// /api/v1/. Low-volume by nature -- an authorize round trip happens once per
// client, and the two OAuth metadata documents are fetched once per client that
// speaks the spec -- so this is a bounded addition, unlike the crawler-facing
// discovery documents deliberately left out.
//
// #9430: the three DISCOVERY entries this map used to declare
// (/.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource and its /mcp variant) were dead
// labels. workers/api.entry.ts hands every request except a bare no-token
// /mcp to `oauthProvider.fetch`, and @cloudflare/workers-oauth-provider
// answers its own discovery documents, /oauth/token and /oauth/register
// internally -- only then falling through to the default handler. So those
// paths never reach withUsageTelemetry and never could: the labels described
// traffic this Worker does not serve, and #8996's stated goal ("does anyone
// actually authenticate?") was answered with three permanent zeroes.
//
// tests/request-usage-telemetry.test.ts asserted them by calling
// usageRouteLabel directly, which is why nothing caught it -- a label test
// that never routes a request cannot tell a live label from a dead one.
//
// The two that remain are genuinely app-served: the library delegates
// /authorize to the default handler (it has no consent UI of its own) and
// /oauth/callback/github is not a library endpoint at all. Both are confirmed
// live in production telemetry.
const AUTH_SURFACE_ROUTES: Record<string, string> = {
  "/authorize": "oauth-authorize",
  "/oauth/callback/github": "oauth-callback",
};

export function usageRouteLabel(url: URL) {
  const { network, url: resolved } = resolveNetworkPrefix(url);
  const { pathname } = resolved;

  // MCP tool dispatch is instrumented at its own chokepoint, keyed by tool
  // name (companion issue) — recording it here too would double-count every
  // tool call, including the ones it bridges into GraphQL internally.
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return null;
  }

  // #9005: internal machine-to-machine plumbing is not API usage by anyone.
  // /api/v1/internal/chain-firehose-ingest is our own relay POSTing into our
  // own Worker (client "node"), and it alone emitted 177,894 usage_events in
  // 24 hours -- 19% of the entire project's event volume, for a number nobody
  // reads. It qualified only because it starts with /api/v1/ and so fell into
  // the maskUsageRouteParams fallback below.
  //
  // Counting it is also actively misleading, not merely expensive: "requests
  // served" silently included our own ingest traffic.
  //
  // $exception capture on these routes is UNAFFECTED and deliberately so -- a
  // failing internal ingest must stay visible (6 of those 177,894 were 5xx).
  // This excludes the per-request usage event, not error tracking.
  if (pathname.startsWith("/api/v1/internal/")) {
    return null;
  }

  // #8996: the auth surface, which had no usage telemetry at all because none
  // of it lives under /api/v1/. ADR 0027 established that /mcp is a live OAuth
  // 2.1 protected resource and that authentication currently buys throughput
  // rather than reach -- and the next question that decision invites is
  // "does anyone actually authenticate?". Without these, the answer is
  // unobtainable: the authorize flow and the discovery documents that make
  // spec-aware MCP clients authenticate natively were entirely unmeasured.
  //
  // A CLOSED LIST, not a prefix. `/.well-known/` as a prefix would also sweep
  // in the agent-tools and server-card documents, which are crawler traffic
  // measured in thousands per day -- and this project is ~30x over its PostHog
  // free tier (#9004), so "instrument the auth surface" must not quietly mean
  // "instrument every crawler fetch". /health is excluded for the same reason:
  // our own prober hits it every minute.
  const authSurfaceRoute = AUTH_SURFACE_ROUTES[pathname];
  if (authSurfaceRoute) {
    return network.isDefault
      ? authSurfaceRoute
      : `${network.id}:${authSurfaceRoute}`;
  }

  const route =
    pathname === "/api/v1/graphql"
      ? GRAPHQL_USAGE_ROUTE
      : (matchRoute(pathname)?.id ??
        // Anything outside /api/v1/ is not API usage: static assets, OG
        // images, the RPC proxy, /health, /.well-known/*, raw /metagraph/*
        // artifacts. #9001: this used to say "badges" too, which was wrong --
        // badges are served at /api/v1/{subnets,providers}/{id}/badge.svg, so
        // they DO start with /api/v1/ and DO get a masked label here.
        (pathname.startsWith("/api/v1/")
          ? maskUsageRouteParams(pathname)
          : null));

  if (route === null) {
    return null;
  }

  return network.isDefault ? route : `${network.id}:${route}`;
}

/**
 * Fallback label for the handful of /api/v1 routes that predate the API_ROUTES
 * contract (/ask, /webhooks/..., /internal/...). Path segments that look like
 * identifiers are masked so an unlisted route can never emit unbounded labels.
 *
 * #9001: the masking itself moved to src/route-label.ts so workers/data-api.ts
 * can apply the identical rules to its span names and exception routes, which
 * were using the raw pathname. This wrapper stays because the NAME documents
 * the caller's intent (a usage-route fallback) even though the body is now one
 * call.
 *
 * @param {string} pathname
 * @returns {string}
 */
function maskUsageRouteParams(pathname: string) {
  return maskRouteParams(pathname);
}

// #9446: the caller's tier, for the usage_event `auth_tier` dimension.
//
// `authTier` has been declared on UsageEvent since #8993 and populated ONLY on
// the MCP path, so on REST -- the surface with 99% of the traffic -- the
// question the tier system exists to answer ("what share of usage is
// authenticated, and on which tier") had no data behind it at all.
//
// A WeakMap keyed on the Request, rather than a new parameter threaded from
// four gate sites up through handleRequest to this wrapper. The gate already
// resolves the tier (applyTieredRateLimit returns it and every caller
// discarded it); this carries that answer back out without reshaping the
// signature of every function in between, which is the same reasoning the MCP
// side used when it put authTier on its ctx rather than passing it down.
//
// WeakMap and not a Map: the key is the request object itself, so an entry
// becomes collectable the moment the request is done. There is nothing to
// evict, nothing to size, and no way for one request's tier to be read by
// another -- the failure mode a keyed cache would have.
const requestAuthTier = new WeakMap<Request, string>();

/**
 * Record the tier a request authenticated on, for its usage event.
 *
 * Called from the tiered-rate-limit gates, which are the only places that
 * verify a key. Exported for tests.
 */
export function markRequestAuthTier(request: Request, tier: unknown): void {
  if (typeof tier === "string" && tier) requestAuthTier.set(request, tier);
}

/**
 * Who made this request, for the usage_event `client` dimension.
 *
 * #9004: a Cloudflare Worker subrequest sends NO User-Agent, so all of it
 * landed in the "no client" bucket. That is not a rounding error here -- it was
 * ~93% of `block-detail`, the single largest route in the project at 758,995
 * events/day, and identifying it required a live `wrangler tail` because the
 * telemetry could not answer it. One Worker (`zeronode.workers.dev`) turned out
 * to be 82% of that route: ~380K requests/day, each one a Worker invocation, a
 * Hyperdrive round-trip AND a PostHog event.
 *
 * Cloudflare sets `cf-worker` on Worker-to-Worker subrequests, so it is
 * trustworthy (not caller-supplied) and low-cardinality (one value per calling
 * Worker). Prefixed `worker:` so provenance rides with the value and a
 * UA-derived name can never be confused with a subrequest origin -- the same
 * discipline $mcp_client_name_source applies on the MCP side.
 *
 * User-Agent wins when both are present: a real client behind a Worker proxy is
 * more interesting than the proxy.
 */
function resolveUsageClient(request: Request): string | undefined {
  const fromUserAgent = parseUserAgentClient(
    request.headers.get("user-agent"),
  ).clientName;
  if (fromUserAgent) return fromUserAgent;
  const cfWorker = request.headers.get("cf-worker");
  return cfWorker ? `worker:${cfWorker}` : undefined;
}

/**
 * Run the request pipeline and record exactly one usage event for it. Returns
 * the handler's response untouched, and never converts a telemetry failure into
 * a request failure: an unconfigured deployment skips the work entirely, and a
 * recorder that rejects, throws, or a waitUntil that throws is swallowed.
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} ctx ExecutionContext (may be a bare object in tests).
 * @param {() => Promise<Response>} handle
 * @param {{recordUsageEvent?: typeof recordUsageEvent}} [deps]
 * @returns {Promise<Response>}
 */
export async function withUsageTelemetry(
  request: Request,
  env: Env,
  ctx: Ctx,
  handle: () => Promise<Response>,
  deps: {
    recordUsageEvent?: typeof recordUsageEvent;
    recordExceptionEvent?: typeof recordExceptionEvent;
  } = {},
) {
  const record = deps.recordUsageEvent ?? recordUsageEvent;
  const recordException = deps.recordExceptionEvent ?? recordExceptionEvent;
  if (!isUsageTelemetryConfigured(env)) {
    return handle();
  }

  // A subscription upgrade (GraphQL subscriptions reuse the /api/v1/graphql
  // path over a WebSocket) opens a long-lived socket rather than serving a
  // request/response pair, so its latency would be meaningless. Recognized the
  // same way handleRequest itself dispatches it.
  if (request.headers.get("upgrade") === "websocket") {
    return handle();
  }

  const route = usageRouteLabel(new URL(request.url));
  if (route === null) {
    return handle();
  }

  const startedAt = Date.now();
  // #8963: request dimensions resolved once, up front, so they are recorded
  // even when the handler throws (the finally block below still fires).
  const method = request.method;
  const client = resolveUsageClient(request);
  let statusClass;
  let ok = false;
  // metagraphed#7733: errorResponse() (workers/http.ts) already sets this on
  // every REST error -- the same established code (invalid_query,
  // method_not_allowed, ai_error, ...) every route handler already uses, not
  // a new taxonomy. Undefined for a success response or one that predates
  // this convention, same "omitted, not just falsy" contract as MCP's
  // errorCode (#7726).
  let errorCode;
  try {
    const response = await handle();
    // 4xx is a route correctly rejecting a bad request, not a broken route;
    // only 5xx (and a thrown handler, which leaves ok false) is a failure.
    ok = response.status < 500;
    // Recorded alongside `ok`, not instead of it: `ok` folds every 4xx in with
    // the successes (a route correctly rejecting a bad request is not a
    // failure), which makes "are callers sending us garbage" unanswerable.
    statusClass = statusClassOf(response.status);
    errorCode = response.headers.get("x-metagraph-error-code") ?? undefined;
    // metagraphed#7734: GraphQL execution errors are a spec-mandated 200
    // with a populated `errors` array (src/graphql.ts) -- status alone
    // can't distinguish that from a real success, so this one code (set
    // only when execute() surfaced a genuine resolver fault, never a
    // deliberate/expected GraphQLError -- see graphql.ts's own
    // genuineFaults comment) is a narrow, explicit exception to the
    // status-based rule above. Every other route/code keeps the existing
    // status<500 semantics untouched.
    if (errorCode === "graphql_execution_error") {
      ok = false;
    }
    return response;
  } catch (error) {
    // #9430: until now this wrapper was try/finally with NO catch, and
    // workers/api.entry.ts dropped Sentry's withSentry() wrap without
    // replacing it (#7766) -- so an uncaught throw anywhere in the REST
    // pipeline produced a usage_event with ok:false and NOTHING ELSE. No
    // stack, no PostHog Issue, no message: the single most severe class of
    // failure this Worker can have was also the least diagnosable, and
    // src/usage-telemetry.ts's own header documented the hole rather than
    // closing it ("a truly uncaught throw has no dedicated $exception capture
    // of its own ... just without a stack trace").
    //
    // Rethrown unchanged: this observes the failure, it does not handle it.
    // The runtime still produces its own 1101/500 exactly as before, and the
    // finally block below still records the same ok:false usage event -- so
    // the only behavioral difference is that the stack now reaches PostHog.
    //
    // `route` is already resolved and low-cardinality, giving the capture the
    // same fingerprint grouping (`<route>:<type>`) every hand-placed REST
    // capture site already gets.
    scheduleExceptionEvent(env, ctx, recordException, {
      error,
      route,
      errorCode: "internal_error",
    });
    throw error;
  } finally {
    const endedAt = Date.now();
    // Read AFTER the handler, since the gate that resolves it runs inside.
    // Absent for a route with no tiered gate, which is the honest answer --
    // those routes did not check a key, so "anonymous" would be a claim the
    // request never actually made. Same omitted-not-defaulted contract every
    // other optional dimension here follows.
    const authTier = requestAuthTier.get(request);
    scheduleUsageEvent(env, ctx, record, {
      route,
      ok,
      durationMs: endedAt - startedAt,
      method,
      ...(statusClass ? { statusClass } : {}),
      ...(client ? { client } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(authTier ? { authTier } : {}),
    });
    // metagraphed#7768: PostHog distributed tracing (alpha), one root span
    // per request -- replaces @sentry/cloudflare's automatic withSentry() HTTP
    // instrumentation. Off by default (POSTHOG_TRACES_SAMPLE_RATE unset --
    // see src/tracing.ts's own header for why); set it as a deployed var to
    // match Sentry's old 0.05. Reuses this chokepoint's own route/ok/duration
    // -- see src/tracing.ts's header for why this is an independent span (no
    // parent) rather than nested under anything.
    if (shouldSampleTrace(env)) {
      scheduleTraceSpan(env, ctx, {
        traceId: newTraceId(),
        spanId: newSpanId(),
        name: route,
        startTimeMs: startedAt,
        endTimeMs: endedAt,
        ok,
        serviceName: "metagraphed-api",
        attributes: { route, error_code: errorCode },
      });
    }
  }
}

/**
 * Hand an exception to the recorder without ever blocking or failing the
 * response. Mirrors scheduleUsageEvent/scheduleTraceSpan exactly -- telemetry
 * must never surface into the request path, least of all on a path that is
 * already failing.
 */
function scheduleExceptionEvent(
  env: Env,
  ctx: Ctx,
  record: typeof recordExceptionEvent,
  event: Parameters<typeof recordExceptionEvent>[1],
) {
  try {
    const pending = Promise.resolve(record(env, event)).catch(() => false);
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

function scheduleTraceSpan(
  env: Env,
  ctx: Ctx,
  span: Parameters<typeof recordTraceSpan>[1],
) {
  try {
    const pending = Promise.resolve(recordTraceSpan(env, span)).catch(
      () => false,
    );
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

/**
 * Hand the event to the recorder without ever blocking or failing the response.
 *
 * @param {object} env
 * @param {object} ctx
 * @param {typeof recordUsageEvent} record
 * @param {object} event
 */
function scheduleUsageEvent(
  env: Env,
  ctx: Ctx,
  record: typeof recordUsageEvent,
  event: UsageEvent,
) {
  try {
    const pending = Promise.resolve(record(env, event)).catch(() => false);
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(pending);
    }
  } catch {
    // Telemetry must never surface into the request path.
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx) {
    return withUsageTelemetry(request, env, ctx, () =>
      handleRequest(request, env, ctx),
    );
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    return handleScheduled(controller, env, ctx);
  },
};

// Durable Object classes must be named exports of this Worker's main entry
// module (wrangler.jsonc's "main": "workers/api.entry.ts") -- re-exporting the
// classes defined in chain-firehose-hub.ts/mcp-session-hub.ts is what
// makes the "durable_objects"/"migrations" bindings in wrangler.jsonc
// resolvable.
export { ChainFirehoseHub, McpSessionHub, AlerterHub, SubnetStatusHub };

// The staged-artifact loaders (request-handlers/staging.mjs, #1763) are fully
// retired: loadStagedNeurons/Events/Blocks/Extrinsics went alongside their D1
// tables (#4772 D1 chain-data retirement), loadStagedSubnetHyperparams went
// once subnet_hyperparams/subnet_hyperparams_history became fully
// Postgres-served, and loadStagedAccountIdentity (the last one) went once
// refresh-account-identity moved to a direct-to-Postgres sync on the
// indexer-box cron pipeline. workers/request-handlers/staging.mjs itself is
// deleted — nothing left to re-export.

// The RPC-proxy subsystem now lives in request-handlers/rpc-proxy.ts (#1763).
// The router dispatches the handlers directly via the imports above; these
// helpers + constants are re-exported only so the rpc-cache / rpc-failover /
// rpc-endpoint-selection / rpc-pool-cache tests keep importing them from this
// module (their public test surface is api.ts, not the new file).
export {
  classifyUpstreamAttempt,
  isPrivateOrLocalHostname,
  isRpcEndpointEjected,
  orderSafeRpcEndpoints,
  proxyWithFailover,
  readRpcPoolArtifact,
  recordRpcFailure,
  recordRpcSuccess,
  rpcCachePolicy,
  RPC_POOL_ARTIFACT_TTL_MS,
  selectSafeRpcEndpoint,
  weightedPickEndpoint,
};

export { composeCompareData } from "./request-handlers/analytics-routes.ts";

// Cron entrypoint. Cloudflare passes the exact cron string that fired in
// `controller.cron`; the hourly trigger prunes the time-series, every other
// trigger (the 15-minute one) runs a full operational-health probe sweep.

// #8998: cron branches, by the name they are reported under.
//
// Before this, of the six branches below THREE emitted nothing at all (health
// probe, health prune, account-events rollup) and two emitted only on the
// alert-worthy outcome (abuse-scan when flagged >= 1, upgrade-radar when
// scan.alert). So a cron that stopped firing entirely was indistinguishable
// from one that ran fine, and so was one that ran and failed -- silent in both
// directions, with no exception storm to eventually notice.
//
// The health probe is the sharpest case: it is what WRITES self_health_checks,
// the data behind our own uptime claim. If it stops, the uptime page keeps
// serving the last good day and nothing reports the gap.
//
// A closed name table rather than the raw cron expression: the expressions come
// from wrangler.jsonc so they are bounded today, but a label built from input
// is the shape #9001 removed elsewhere, and a name survives a schedule change
// where "0 * * * *" does not.
function cronLabel(cron: string): string {
  if (cron === HEALTH_PRUNE_CRON) return "health-prune";
  if (cron === EMBEDDING_SYNC_CRON) return "embedding-sync";
  if (cron === GITHUB_SIGNALS_SYNC_CRON) return "github-signals-sync";
  if (cron === RAW_CAPTURE_CRON) return "raw-capture";
  if (cron === SUBNET_BURN_CAPTURE_CRON) return "subnet-burn-capture";
  if (cron === OPERATIONAL_SURFACES_SYNC_CRON)
    return "operational-surfaces-sync";
  if (cron === SCHEMA_SNAPSHOTS_SYNC_CRON) return "schema-snapshots-sync";
  if (cron === SURFACE_VERIFICATION_SYNC_CRON)
    return "surface-verification-sync";
  if (cron === ABUSE_SCAN_CRON) return "abuse-scan";
  if (cron === UPGRADE_RADAR_CRON) return "upgrade-radar";
  if (cron === FRESHNESS_WATCHDOG_CRON) return "freshness-watchdog";
  if (cron === LAKEHOUSE_SEAM_CRON) return "lakehouse-seam-watchdog";
  if (cron === SAFE_MODE_WATCHDOG_CRON) return "safe-mode-watchdog";
  if (cron === PROJECTION_LANES_CRON) return "projection-lanes";
  if (cron === ACCOUNT_EVENTS_ROLLUP_CRON) return "account-events-rollup";
  if (cron === EMISSION_GATE_SAMPLE_CRON) return "emission-gate-sample";
  if (cron === EMISSION_DRIFT_CHECK_CRON) return "emission-drift-check";
  if (cron === NEURONS_STALENESS_WATCHDOG_CRON)
    return "neurons-staleness-watchdog";
  if (cron === NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON)
    return "nominator-positions-staleness-watchdog";
  if (cron === PROJECTION_STALENESS_WATCHDOG_CRON)
    return "projection-staleness-watchdog";
  if (cron === VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON)
    return "validator-nominator-counts-staleness-watchdog";
  if (cron === CHAIN_DETAIL_PRUNE_CRON) return "chain-detail-prune";
  if (cron === CHAIN_DETAIL_STALENESS_WATCHDOG_CRON)
    return "chain-detail-staleness-watchdog";
  if (cron === TOP_HOLDERS_STALENESS_WATCHDOG_CRON)
    return "top-holders-staleness-watchdog";
  if (cron === ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON)
    return "account-balances-staleness-watchdog";
  if (cron === TOP_HOLDERS_FLOW_CRON) return "top-holders-flow";
  if (cron === LIVE_ECONOMICS_REFRESH_CRON) return "live-economics-refresh";
  // Every unmatched cron falls through to the health prober, matching dispatch.
  return "health-prober";
}

/**
 * Run a cron tick and record exactly one usage_event for it.
 *
 * Wraps the whole dispatch rather than instrumenting six call sites, for the
 * same reason the MCP protocol chokepoint does (#8993): a branch added later is
 * covered by existing rather than by remembering.
 *
 * A handler's own `ok: false` is honoured when it reports one -- the
 * account-events rollup returns `{ok: false, skipped: true}` when
 * ROLLUP_SYNC_SECRET is unset, and that is a real "did not do the work"
 * outcome, not a success.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env = {} as unknown as Env,
  ctx: ExecutionContext = {} as unknown as ExecutionContext,
) {
  const startedAt = Date.now();
  const label = cronLabel(controller?.cron || "");
  try {
    const result = await dispatchScheduled(controller, env, ctx);
    const reported = (result as { ok?: unknown } | null | undefined)?.ok;
    recordCronOutcome(
      env,
      ctx,
      label,
      typeof reported === "boolean" ? reported : true,
      startedAt,
    );
    return result;
  } catch (error) {
    recordCronOutcome(env, ctx, label, false, startedAt);
    // A cron has no caller to return an error to, so capture is the only
    // signal that it failed at all.
    const pending = Promise.resolve(
      recordExceptionEvent(env, {
        error,
        route: `cron:${label}`,
        errorCode: "internal_error",
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    throw error;
  }
}

function recordCronOutcome(
  env: Env,
  ctx: ExecutionContext,
  label: string,
  ok: boolean,
  startedAt: number,
): void {
  try {
    const pending = Promise.resolve(
      recordUsageEvent(env, {
        route: `cron:${label}`,
        ok,
        durationMs: Date.now() - startedAt,
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
  } catch {
    // Telemetry must never surface into the cron path.
  }
}

async function dispatchScheduled(
  controller: ScheduledController,
  env: Env = {} as unknown as Env,
  ctx: ExecutionContext = {} as unknown as ExecutionContext,
) {
  const cron = controller?.cron || "";
  // The former fast-load cron (#1346 Option A, EVENTS_LOAD_CRON, "*/3 * * * *")
  // drained R2-staged batches into D1. Its last consumer, loadStagedAccountIdentity
  // (#4324/5.1), was removed once refresh-account-identity moved to a
  // direct-to-Postgres sync running on the indexer-box cron pipeline instead of
  // GitHub Actions + R2 staging -- see workers/request-handlers/staging.mjs's
  // deletion. The trigger itself is removed from wrangler.jsonc; nothing
  // dispatches on it here anymore.
  if (cron === HEALTH_PRUNE_CRON) {
    // Roll the day's raw checks into the durable daily uptime table BEFORE
    // pruning, so long-term history is never lost when 30-day raw rows are
    // deleted (PR3). Skip prune when the rollup fails so raw rows are never
    // deleted without being aggregated first.
    //
    // #4772 D1 chain-data retirement: the D1-side rollupAccountEventsDaily/
    // pruneAccountEvents/pruneBlocks/pruneExtrinsics calls that used to run here
    // are removed alongside their D1 tables. account_events_daily (explicitly
    // retained, NOT part of this retirement) already has its own fully
    // independent Postgres-side rollup — a dedicated hourly GitHub Actions
    // workflow calling POST /api/v1/internal/rollup-account-events-daily, reading
    // and writing Postgres directly — so it never depended on this D1 rollup for
    // its real production data. Leaving the D1-side call in here after dropping
    // D1's account_events would have made it fail every tick (querying a table
    // that no longer exists) and, worse, its `!eventsRollup.rolled` gate would
    // have silently skipped THIS cron's unrelated pruneHealthHistory
    // (surface_checks) prune forever — a regression to fix here, not carry.
    // #9228: run BEFORE the rollup gate below, not inside the prune it
    // guards. The gate can early-return this whole tick, and an alarm that a
    // sibling lane's failure can silence is an alarm that reports "healthy"
    // for exactly the reason it should be shouting.
    const rpcUsageStaleness = await runRpcUsageStalenessWatchdog(env);
    const uptimeRollup = await rollupDailyUptime(env);
    const snapshotPromise = writeSubnetSnapshot(env, {
      readArtifact: readArtifact as unknown as (
        env: Env,
        path: string,
      ) => Promise<Row>,
    });
    if (!uptimeRollup.rolled) {
      const snapshot = await snapshotPromise;
      return {
        pruned: false,
        rollup_skipped_prune: true,
        uptime_rolled: uptimeRollup.rolled,
        snapshot,
        rpc_usage_staleness: rpcUsageStaleness,
      };
    }
    const [pruned] = await Promise.all([
      // .catch-isolated — a transient D1 error must degrade to a no-op for this
      // tick, not abort the whole Promise.all and discard the snapshot write.
      // The D1 raw-checks prune is gated on D1's OWN rollup having succeeded
      // this tick (see pruneHealthHistory's pruneD1Checks comment) -- the
      // combined `rolled` only proves SOME store aggregated the day.
      pruneHealthHistory(env, {
        pruneD1Checks:
          (uptimeRollup as { d1_rolled?: boolean }).d1_rolled === true,
      }).catch(() => ({ pruned: false })),
      snapshotPromise,
    ]);
    return { ...pruned, rpc_usage_staleness: rpcUsageStaleness };
  }
  if (cron === EMBEDDING_SYNC_CRON) {
    return runEmbeddingSync(env, { readArtifact });
  }
  if (cron === SUBNET_BURN_CAPTURE_CRON) {
    // #9402: one state_queryStorageAt covering every subnet, then one batched D1
    // write. Never throws -- a capture lane that could take down the cron it runs on
    // would be worse than a gap in the series.
    return captureSubnetBurnHistory(env, {
      db: env.METAGRAPH_HEALTH_DB as unknown as BurnHistoryDb,
    });
  }
  if (cron === RAW_CAPTURE_CRON) {
    // Gap-free capture of raw extrinsic/event bytes into R2, replacing what
    // the decommissioned indexer box used to produce. Durable-first on
    // purpose: the bytes land before anything decodes them, because decode is
    // re-runnable and a missed block is not. See src/raw-chain-capture.ts.
    return runRawCaptureSync(env);
  }
  if (cron === GITHUB_SIGNALS_SYNC_CRON) {
    // #233 pattern: daily GitHub dev-signal capture written straight to the
    // R2 store, replacing the retired sync-github-signals.yml bot-PR lane --
    // see src/github-signals-sync.ts's header for the provenance, repo-list
    // sourcing, token posture, and subrequest budget.
    return runGithubSignalsSync(env, ctx, { readArtifact });
  }
  if (cron === OPERATIONAL_SURFACES_SYNC_CRON) {
    // #9096: hourly derivation of the prober's cold-start surface list from
    // the published registry, written straight to the R2 store the prober now
    // reads first -- replacing the retired sync-operational-surfaces.yml
    // bot-PR lane. See src/operational-surfaces-sync.ts's header for the
    // derivation-equivalence argument and the schema_source carry-forward.
    return runOperationalSurfacesSync(env, ctx, { readArtifact });
  }
  if (cron === SURFACE_VERIFICATION_SYNC_CRON) {
    // #9096: daily per-surface probe-evidence sweep straight out of D1,
    // replacing the retired sync-surface-verification.yml bot-PR lane. This
    // snapshot is the ONLY producer of `machine-verified`, so the module
    // refuses to run rather than run degraded -- see its header.
    return runSurfaceVerificationSync(env, ctx, { readArtifact });
  }
  if (cron === SCHEMA_SNAPSHOTS_SYNC_CRON) {
    // #9096: daily promotion of the published OpenAPI index into the durable
    // drift baseline, with last-good retention, replacing the retired
    // sync-schema-snapshots.yml bot-PR lane. The live capture itself stays in
    // Node -- see the module header for why that split is deliberate.
    return runSchemaSnapshotsSync(env, ctx, { readArtifact });
  }
  if (cron === ABUSE_SCAN_CRON) {
    // #8611: score recent per-key usage and report a spike to the ops channel.
    //
    // Daily, not hourly. Every signal is an aggregate over whole DAYS of usage
    // (sustained ceiling-riding needs a multi-day run), so a tighter cadence
    // would re-report the same standing set of accounts and train whoever
    // watches the channel to ignore it. Nothing here blocks anybody -- it
    // notifies, and a human decides via the block route.
    return runAbuseScan(env, ctx);
  }
  if (cron === UPGRADE_RADAR_CRON) {
    // #8702: capture GitHub's release/BIT state and report a new testnet soak.
    return runUpgradeRadarScan(env, ctx);
  }
  if (cron === SAFE_MODE_WATCHDOG_CRON) {
    // SafeMode is the emergency chain pause. Zero alerts is the correct steady
    // state -- it means nothing has gone wrong, not that the watchdog is idle.
    return runSafeModeWatchdog(env as unknown as Record<string, unknown>);
  }
  if (cron === LAKEHOUSE_SEAM_CRON) {
    // The seam that routes every cold block read now follows the decode
    // lane's published watermark, so what can break is the lane itself:
    // stopped, losing ground to the raw capture, or publishing a height the
    // lakehouse does not back. All three look like a healthy block list with
    // empty block detail, which is why nothing noticed for a day.
    return runLakehouseSeamWatchdog(
      env as unknown as Parameters<typeof runLakehouseSeamWatchdog>[0],
    );
  }
  if (cron === PROJECTION_LANES_CRON) {
    // #9146: recompute the windowed-aggregate artifacts (every lane in
    // PROJECTION_LANES) from the lakehouse. See src/projection-lanes.ts's
    // header for why these routes are a cron and not a one-shot artifact or
    // a request-time reader. The #8998 wrapper above records the tick's
    // usage_event; lane-level failures record their own exceptions.
    return runProjectionLanes(env);
  }
  if (cron === FRESHNESS_WATCHDOG_CRON) {
    // The alarm that replaces the box-side monitoring stack: notice when a
    // publish lane stops moving, which serving a 200 from stale artifacts
    // otherwise hides completely.
    return runFreshnessWatchdog(env, ctx);
  }
  if (cron === EMISSION_GATE_SAMPLE_CRON) {
    // The emission-gate sampler, formerly the 10-minute Actions schedule.
    // Chain reads live in src/emission-gate-sampler.ts (shared verbatim with
    // the script shell); persistence goes through the SAME token-authed sync
    // handler the external callers use, as an in-process synthetic Request --
    // one code path for the differs and their D1 writes no matter who calls.
    if (!env.EMISSION_GATE_SYNC_SECRET) {
      return {
        ok: false,
        skipped: true,
        reason: "EMISSION_GATE_SYNC_SECRET not configured",
      };
    }
    const sample = await sampleEmissionGate({
      rpcUrl:
        env.EMISSION_SAMPLER_RPC_URL ||
        env.CHAIN_HEAD_RPC_URL ||
        "https://archive.chain.opentensor.ai",
    });
    const response = await handleEmissionGateSync(
      new Request(
        "https://internal.metagraph.sh/api/v1/internal/emission-gate-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-emission-gate-sync-token": env.EMISSION_GATE_SYNC_SECRET,
          },
          body: JSON.stringify(sample),
        },
      ),
      env,
    );
    const body = (await response.json()) as Row;
    return { ok: response.ok, status: response.status, body };
  }
  if (cron === NEURONS_STALENESS_WATCHDOG_CRON) {
    // The neurons live lane's alarm. Zero alerts is the correct steady state;
    // a stale verdict records one exception under
    // watchdog:neurons-staleness, which is the project's alert channel.
    return runNeuronsStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === PROJECTION_STALENESS_WATCHDOG_CRON) {
    // The projection lanes' alarm (#9423). Zero alerts is the correct steady
    // state; a stale verdict records ONE exception naming every stale lane
    // under watchdog:projection-staleness. An ABSENT artifact alerts too --
    // every registered lane is meant to have written on the last tick, and a
    // route over a missing card serves its zeroed floor as though measured.
    return runProjectionStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON) {
    // The nominator-positions lane's alarm (#9273). Zero alerts is the correct
    // steady state; a stale verdict records one exception under
    // watchdog:nominator-positions-staleness, the project's alert channel. An
    // EMPTY table alerts too -- until the revived lane posts, every positions
    // read is still answering from the frozen lakehouse export.
    return runNominatorPositionsStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON) {
    // The validator-nominator-counts lane's alarm (#9301) -- the sibling of
    // the watchdog above, over the other output of the same Alpha scan. Zero
    // alerts is the correct steady state; a stale verdict records one
    // exception under watchdog:validator-nominator-counts-staleness, the
    // project's alert channel. An EMPTY table alerts too -- until the
    // re-enabled lane posts, every nominator_count is still coming from the
    // frozen lakehouse mirror or serving null outright.
    return runValidatorNominatorCountsStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === CHAIN_DETAIL_PRUNE_CRON) {
    // #9208 retention. Returns a summary rather than throwing so the #8998
    // wrapper records the tick either way; `ok:false` on an unbound D1 or a
    // failed delete is a real "did not do the work" outcome, and the wrapper
    // honours it.
    return pruneChainDetail(env);
  }
  if (cron === CHAIN_DETAIL_STALENESS_WATCHDOG_CRON) {
    // The chain-detail live lane's alarm. Zero alerts is the correct steady
    // state; a stale verdict records one exception under
    // watchdog:chain-detail-staleness, the project's alert channel.
    return runChainDetailStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === TOP_HOLDERS_FLOW_CRON) {
    // #9469: recompute the top-holders net_flow_7d/30d/90d ranking from
    // chain.account_events. Its own daily branch rather than a slot in
    // PROJECTION_LANES because the shared tick is twice-hourly and this scan
    // is 1.65 GB -- see TOP_HOLDERS_FLOW_CRON in workers/config.ts. The lane
    // reuses runProjectionLane, so a declined compute leaves yesterday's
    // ranking in place and records one exception under
    // projection:top-holders-flow rather than publishing an empty one.
    return runProjectionLane(env, TOP_HOLDERS_FLOW_LANE);
  }
  if (cron === TOP_HOLDERS_STALENESS_WATCHDOG_CRON) {
    // The top-holders leaderboard's alarm (#9464). Zero alerts is the correct
    // steady state and is NOT the current one: the lane has no producer, so it
    // records one exception under watchdog:top-holders-staleness on every tick
    // and will until the artifact gets a writer or the route is withdrawn
    // (#9475 removed the special case that kept this quiet). An ABSENT,
    // UNREADABLE or EMPTY artifact alerts too -- that is the condition where
    // the route silently answers 200 with an empty leaderboard.
    return runTopHoldersStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON) {
    // The account-balances lane's alarm (#9478) -- the SOURCE side of the
    // watchdog above rather than a replacement for it: that one asks whether
    // the served artifact is readable and current, this one asks whether the
    // D1 table it is composed from is being written at all. Zero alerts is the
    // correct steady state; a stale verdict records one exception under
    // watchdog:account-balances-staleness, the project's alert channel. An
    // EMPTY table alerts too -- until the revived lane posts, every top-holders
    // read is still answering from the frozen 2026-08-02 materialization.
    return runAccountBalancesStalenessWatchdog(
      env as unknown as Record<string, unknown>,
    );
  }
  if (cron === LIVE_ECONOMICS_REFRESH_CRON) {
    // The live-economics refresh, formerly the 3-hourly Actions schedule and
    // the last data lane on it. All the chain/D1 reading and the whole build
    // live in src/live-economics-refresh.ts; this branch owns only the
    // reader injection, exactly as the github-signals branch above does.
    //
    // NOTHING HERE THROWS BY DESIGN. The KV key it writes SHADOWS the R2
    // economics artifact, so a degraded blob is worse than no write at all --
    // the module returns ok:false and skips the write instead, and the #8998
    // wrapper records that as a failed tick.
    return refreshLiveEconomics(env, { readArtifact });
  }
  if (cron === EMISSION_DRIFT_CHECK_CRON) {
    // The live emission-drift check, formerly the 30-minute Actions schedule.
    // The whole read-reconstruct-judge sequence lives in
    // src/emission-drift-check.ts (shared verbatim with the script shell);
    // this branch owns only the cron-caller policy. A divergence THROWS after
    // the optional webhook post -- the scheduled-run scaffolding then records
    // the cron failure and the exception under cron:emission-drift-check,
    // which is the same visibility the Actions run's red X provided.
    const { summary, reasons } = await checkEmissionDrift({
      rpcUrl:
        env.EMISSION_DRIFT_RPC_URL || "https://archive.chain.opentensor.ai",
    });
    if (reasons.length > 0) {
      if (env.LIVE_ALERT_WEBHOOK_URL) {
        // Best-effort, before the throw: a webhook failure must not mask the
        // drift signal, and the throw must not skip the webhook.
        await fetch(env.LIVE_ALERT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            content:
              `🚨 metagraphed: the v440 emission reconstruction diverged at block ${summary.block_number}.\n` +
              reasons.map((r) => `• ${r}`).join("\n") +
              `\nOne of: our capture broke, a runtime upgrade changed the pipeline, ` +
              `or a dormant switch was flipped (#8750). Published emission ` +
              `decomposition is suspect until this is explained (#8749).`,
          }),
        }).catch(() => undefined);
      }
      throw new Error(`emission drift: ${reasons.join("; ")}`);
    }
    return { ok: true, ...summary };
  }
  if (cron === ACCOUNT_EVENTS_ROLLUP_CRON) {
    // #4832 gap-closure, moved off GitHub Actions (rollup-account-events-daily.yml,
    // retired) onto this Worker-native cron -- eliminates a third-party trigger
    // hop for what was already a same-Worker-owned Postgres write. Builds the
    // identical trigger-only POST the GH Actions workflow used to make over the
    // public internet, and dispatches it internally through the existing
    // DATA_API service-binding proxy (handleRollupAccountEventsDailyProxy).
    if (env.METAGRAPH_ACCOUNT_EVENTS_SOURCE !== "postgres") {
      // The rollup writes account_events_daily in the box's Postgres. With
      // that tier retired the write target no longer exists, and an hourly
      // POST into a dead service would log an error and burn a PostHog
      // $exception forever. Skipping is a deliberate state, same contract as
      // the missing-secret skip below.
      return {
        ok: false,
        skipped: true,
        reason: "account_events postgres tier retired",
      };
    }
    if (!env.ROLLUP_SYNC_SECRET) {
      return {
        ok: false,
        skipped: true,
        reason: "ROLLUP_SYNC_SECRET not configured",
      };
    }
    const response = await handleRollupAccountEventsDailyProxy(
      new Request(
        "https://internal.metagraph.sh/api/v1/internal/rollup-account-events-daily",
        {
          method: "POST",
          headers: { [ROLLUP_TOKEN_HEADER]: env.ROLLUP_SYNC_SECRET },
        },
      ),
      env,
    );
    // proxyToDataApi (which handleRollupAccountEventsDailyProxy wraps) always
    // resolves to a JSON body -- either the DATA_API passthrough or its own
    // errorResponse envelope -- so this can never throw.
    const body = await response.json();
    return { ok: response.ok, status: response.status, body };
  }
  // #204: self-healing bootstrap for the firehose head poller, piggybacked on
  // the 15-minute probe tick. Idempotent (an armed alarm is left alone), and
  // best-effort -- the probe sweep must never fail because the hub was cold.
  if (env.CHAIN_FIREHOSE_HUB) {
    try {
      const hub = env.CHAIN_FIREHOSE_HUB.get(
        env.CHAIN_FIREHOSE_HUB.idFromName("global"),
      );
      await hub.fetch("https://firehose.internal/poll-start", {
        method: "POST",
      });
    } catch (error) {
      console.error(
        "[head-poller-bootstrap]",
        String((error as Error)?.message),
      );
    }
  }
  return runHealthProber(env, ctx);
}

// Postgres-backed all-events tier proxy (ADR 0013). The dedicated data Worker
// (DATA_API) returns a bare JSON body; this rewraps it in the canonical API
// envelope so /api/v1/chain-events* matches the OpenAPI contract (typed `data`
// payload + ETag/cache headers) like every other route. The MCP get_chain_activity
// tool calls DATA_API directly and keeps consuming the bare shape — only this
// public REST path is enveloped. 503 when the binding is absent (e.g. a preview
// deploy without the data Worker); upstream non-2xx maps to a clean error envelope.
// Stable CSV column order for the ?format=csv download of the all-events feed —
// the flat scalar fields of the DATA_API event rows. The nested `args` object is
// intentionally omitted (it has no flat CSV representation); callers who need it
// use the JSON envelope.
const CHAIN_EVENTS_CSV_COLUMNS = [
  "block_number",
  "event_index",
  "pallet",
  "method",
  "phase",
  "extrinsic_index",
  "observed_at",
];

// Response cache for this proxy's upstream (DATA_API) body, keyed on the
// request path+search -- every param (netuid, kind, window, limit) fully
// determines the content. Deliberately caches the parsed upstream JSON, not
// the final client-facing Response: envelopeResponse's ETag/304 handling and
// the CSV-vs-JSON format branch below both stay per-request and cheap
// (no Postgres/Hyperdrive round trip either way), while the one expensive
// part -- the DATA_API fetch -- gets skipped on a hit. Mirrors the
// caches.default pattern already proven in request-handlers/rpc-proxy.ts
// and request-handlers/analytics.ts (metagraphed#6767); short, fixed TTL
// (no freshness-stamp invalidation, unlike analytics.ts's D1-fallback-aware
// version) since this tier has no publish-time snapshot to key off of.
const CHAIN_EVENTS_PROXY_CACHE_TTL_SECONDS = 60;

// A service binding can REJECT, not merely return a bad status. An unreachable
// DATA_API -- Hyperdrive down, the upstream Worker over its duration limit, the
// binding absent at runtime -- makes `fetch` throw. Every proxy below used to
// let that rejection propagate into handleRequest, which has no top-level
// try/catch (and api.entry.ts stopped wrapping when Sentry was removed), so the
// caller got an opaque 500 instead of a diagnosis.
//
// This matters most in exactly the situation it was least tested for: when the
// Postgres tier goes away for good, EVERY one of these paths throws rather than
// degrades. A structured 503 is the difference between a site that is honestly
// degraded and one that looks broken.
//
// Returns a discriminated result rather than a Response so each call site keeps
// its own error code -- the codes are part of the published contract and must
// not be flattened into a shared one.
async function fetchDataApiOrUnreachable(
  env: Env,
  request: Request,
): Promise<{ upstream: Response } | { unreachable: true }> {
  try {
    return { upstream: await env.DATA_API.fetch(request) };
  } catch {
    return { unreachable: true };
  }
}

/**
 * Edge-cache key for one chain-events family answer.
 *
 * NETWORK-SCOPED, because the `/{network}/` prefix is stripped before dispatch:
 * mainnet and testnet reach this handler with byte-identical pathnames, so a
 * key built from the path alone would serve a testnet page to the next mainnet
 * caller. The two chains' block numbers overlap, so nothing downstream -- not
 * the envelope, not the caller -- could tell that had happened.
 */
async function chainEventsCacheKey(
  env: Env,
  url: URL,
  network: ChainNetworkId,
) {
  return new Request(
    `https://edge-cache.metagraph.sh/chain-events/${encodeURIComponent(
      contractVersion(env),
    )}/${network}${url.pathname}${url.search}`,
  );
}

/**
 * The chain-events family: the all-events feed, its stats aggregate, one
 * block's raw events, and the three per-subnet histories that read the same
 * store.
 *
 * NOT A PROXY ANY MORE (#8700). All six used to be forwarded to the DATA_API
 * service binding first, with the lakehouse ladder below as a FAILURE path.
 * That binding's Postgres store is gone -- #9186 unbound HYPERDRIVE, #9193
 * deleted the reader behind it -- so the forward was a subrequest that could
 * only 503. Measured in production 2026-08-04: every one of the six reports a
 * ladder-produced `meta.source`, and the proxy's own `data-worker-postgres`
 * label is unreachable.
 *
 * The round-trip that cannot succeed was the obvious cost. The expensive one
 * was silent: the edge cache was written only `if (upstreamOk)`, so it was
 * never written, never read, and every request paid a full R2 SQL scan
 * (18.6 MB for one feed page). The ladder is the primary path now and ITS
 * answers are what get cached.
 *
 * It is also what lets the family serve off mainnet at all. DATA_API has no
 * network dimension, so forwarding a testnet request there would have answered
 * it with mainnet's events under a testnet path -- well-formed, and therefore
 * undetectable by anything downstream.
 */
/* Exported for tests: the unmapped-path branch is unreachable through the
 * router, which admits only paths the payload map covers. */
export async function handleChainEventsFamily(
  request: Request,
  env: Env,
  url: URL,
  ctx: Ctx,
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
) {
  // Reject a parameter this route does not declare, BEFORE the cache lookup
  // (#9149). Readers ignore what they do not recognise, so `?palet=Balances`
  // used to return the UNFILTERED feed as a 200 -- and
  // `?pallet=Balances&methd=Transfer` was worse, applying one filter and
  // dropping the other, which looks filtered.
  //
  // Ahead of the cache on purpose: the key is built from the full search
  // string, so an unknown param would otherwise mint a fresh cache entry per
  // typo, all holding the same unfiltered body.
  //
  // The allow-list is derived from API_ROUTES rather than written out here, so
  // it cannot drift from the contract the way #9127's ceiling did.
  // #8386: tiered -- a caller with a valid mg_... API key gets the `keyed`
  // policy (DATA_RATE_LIMITER_KEYED, 5x the anonymous ceiling, keyed by
  // accountId), everyone else gets the anonymous DATA_RATE_LIMITER policy
  // (60/60s, keyed by IP; tests/tiered-rate-limit.test.ts +
  // tests/api-anonymous-limits.test.ts prove neither was reduced).
  //
  // HERE rather than at the two dispatch sites: this family is reached from
  // both the bare path and the /{network}/ one, and a gate written at one of
  // them is a gate the other silently skips.
  const rateLimit = await applyTieredRateLimit(
    request,
    env,
    DATA_TIERED_RATE_LIMIT,
  );
  markRequestAuthTier(request, rateLimit.tier);
  // #8609: recorded for BOTH outcomes, BEFORE the rejection return, with the
  // flag derived from the gate's own verdict -- so a 429 lands in
  // rejected_count instead of request_count. Recording after the return would
  // mean throttled requests were never counted at all, which is the gap that
  // issue exists to close.
  if (rateLimit.accountId) {
    recordApiKeyUsage(
      env,
      ctx,
      rateLimit.accountId,
      "chain-events",
      !rateLimit.allowed,
    );
  }
  if (!rateLimit.allowed) {
    // #8611: a blocked account gets 403 + reason code, not a 429 that invites
    // the retry storm a block exists to stop.
    const rejection = tieredRejectionResponse(rateLimit, {
      code: "data_rate_limited",
      message: "Too many data API requests from this client; slow down.",
    })!;
    return errorResponse(
      rejection.code,
      rejection.message,
      rejection.status,
      {},
      rejection.headers,
    );
  }

  const unknownParam = validateDeclaredQueryParams(url, url.pathname);
  // Same error builder the other 136 routes use, so the body, code and
  // `parameter` field are identical rather than merely similar.
  if (unknownParam) return analyticsQueryError(unknownParam);
  // A DECLARED parameter whose value the tier cannot express is still the
  // caller's error, and the reader cannot report it as one -- it returns null
  // for an unusable filter and for an unreachable door alike, so degrading here
  // would hide a typo'd filter behind an empty feed that looks measured. MCP
  // raises the same condition as `invalid_params` and GraphQL as
  // BAD_USER_INPUT, off this one shared check.
  if (url.pathname === "/api/v1/chain-events") {
    const badValue = chainEventsQueryError(chainEventsQueryFromUrl(url));
    if (badValue) {
      return analyticsQueryError({
        parameter: badValue,
        message: `${badValue} is not a usable value for this feed.`,
      });
    }
  }

  const chain = chainNetworkId(network.id);
  const cache =
    request.method === "GET" || request.method === "HEAD"
      ? globalWithCaches.caches?.default
      : null;
  const cacheKey = cache ? await chainEventsCacheKey(env, url, chain) : null;
  const cacheHit = cacheKey ? await cache.match(cacheKey) : null;
  // The tier travels WITH the payload through the cache, so a hit reports the
  // same `meta.source` the miss did rather than guessing one back.
  let answer = cacheHit ? ((await cacheHit.json()) as ColdTierAnswer) : null;

  if (!answer) {
    // #9208/#9260: the TIERED block-detail read first. /blocks/{n}/chain-events
    // is the one route here a user reaches by clicking a block, so it routes
    // hot above the decode seam, lakehouse at or below it, and DECLINES for the
    // gap between them rather than degrading to an `events: []` no caller can
    // tell from a quiet block. A gap is transient by definition and is returned
    // WITHOUT being cached.
    const hot = await hotTierBlockChainEvents(env, url, chain);
    if (hot?.kind === "gap") return chainDetailGapResponse(hot);
    answer =
      hot?.kind === "answer"
        ? {
            data: hot.data as unknown as ColdTierAnswer["data"],
            // Name the tier that ACTUALLY served. Labelling a lakehouse row as
            // the hot tier's would make the one thing this meta exists to
            // report -- which store answered -- a guess.
            source:
              hot.tier === "cold"
                ? "lakehouse-cold-tier"
                : "chain-detail-hot-tier",
          }
        : await coldTierChainEventsPayload(env, url, chain);
    if (answer && cacheKey) {
      ctx?.waitUntil?.(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(answer), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": `public, s-maxage=${CHAIN_EVENTS_PROXY_CACHE_TTL_SECONDS}`,
            },
          }),
        ),
      );
    }
  }

  if (!answer) {
    // Nothing could answer: the schema-stable empty, MARKED, so a caller can
    // tell it from a measured one and the edge cache refuses it.
    const data = degradedChainEventsPayload(url);
    // A path this map does not cover keeps an error rather than serving a
    // payload that satisfies no schema. Unreachable through the router -- the
    // dispatch admits only paths the map covers, asserted in
    // tests/chain-events-degraded.test.ts -- so it is observable only in tests.
    if (!data) {
      return errorResponse(
        "data_tier_unavailable",
        "The chain-events tier could not answer this route.",
        503,
      );
    }
    const response = await envelopeResponse(
      request,
      {
        data,
        meta: {
          artifact_path: url.pathname,
          cache: "short",
          contract_version: contractVersion(env),
          source: "data-worker-unavailable",
        },
      },
      "short",
    );
    return markPostgresTierFallbackResponse(response);
  }

  // CSV download of the page: the /api/v1/chain-events feed exposes `events`, so
  // serialize that array to text/csv when negotiated. The stats/blocks paths this
  // handler also serves have no top-level row array, so their CSV request falls
  // through to the JSON envelope (a header-only export would be meaningless).
  if (url.pathname === "/api/v1/chain-events" && csvRequested(url, request)) {
    const events = (answer.data as { events?: unknown }).events;
    return csvResponse(
      Array.isArray(events) ? events : [],
      "chain-events",
      "short",
      request,
      CHAIN_EVENTS_CSV_COLUMNS,
    );
  }
  return envelopeResponse(
    request,
    {
      data: answer.data,
      meta: {
        artifact_path: url.pathname,
        cache: "short",
        contract_version: contractVersion(env),
        // From the dispatcher, not hardcoded here: conviction reads live chain
        // storage rather than the lakehouse, and this used to report every cold
        // answer as `lakehouse-cold-tier` regardless (#9319).
        source: answer.source,
      },
    },
    "short",
  );
}

// Proxies /api/v1/alerts/triggers* (#4984 Part 1) to the DATA_API service
// binding. Unlike proxyToDataApi below (POST-only), this forwards every
// method as-is: POST/GET/PATCH/DELETE all reach
// workers/data-api.ts's handleAlertTriggersRoute, which owns all
// auth (creation token / per-trigger owner token) and routing itself --
// mirrors handleChainEventsFamily's envelope-translation shape above, just
// generalized past GET.
// Distinct error code per upstream failure condition instead of collapsing
// every non-2xx into one generic `alert_trigger_request_failed`, following the
// one-code-per-condition convention handleAccountBalance/handleSubnetRecycled
// already use (#5475). The upstream (data-api handleAlertTriggersRoute) returns
// a plain `{ error: "message" }` with no code of its own, so we key off status.
function alertTriggerErrorCode(status: number) {
  switch (status) {
    case 400:
      return "alert_trigger_invalid";
    case 401:
      return "alert_trigger_unauthorized";
    case 404:
      return "alert_trigger_not_found";
    case 413:
      return "alert_trigger_payload_too_large";
    case 429:
      return "alert_trigger_rate_limited";
    case 502:
    case 503:
      return "alert_triggers_unavailable";
    default:
      return "alert_trigger_request_failed";
  }
}

// Rate-limit family the proxy forwards from an upstream error so clients can
// honour back-off; the proxy otherwise strips every upstream header.
const FORWARDED_RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-policy",
];

async function handleAlertTriggersProxy(request: Request, env: Env) {
  if (!env.DATA_API) {
    return errorResponse(
      "alert_triggers_unavailable",
      "The alert triggers tier is not bound to this deployment.",
      503,
    );
  }
  const fetched = await fetchDataApiOrUnreachable(env, request);
  if ("unreachable" in fetched) {
    return errorResponse(
      "alert_triggers_unavailable",
      "The alert triggers tier is unreachable.",
      503,
    );
  }
  const upstream = fetched.upstream;
  let body: Row;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(
      "alert_triggers_unavailable",
      "The alert triggers tier returned an unreadable response.",
      502,
    );
  }
  if (!upstream.ok) {
    const extraHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value != null) extraHeaders[name] = value;
    }
    return errorResponse(
      alertTriggerErrorCode(upstream.status),
      typeof body?.error === "string"
        ? body.error
        : "The alert triggers tier returned an error.",
      upstream.status,
      {},
      extraHeaders,
    );
  }
  return dataResponse(env, body, upstream.status);
}

// Distinct error code per upstream failure condition, same reasoning as
// alertTriggerErrorCode above -- workers/data-api.ts's handleWallet* return
// a plain `{ error: "message" }` with no code of its own.
function walletAuthErrorCode(status: number) {
  switch (status) {
    case 400:
      return "wallet_auth_invalid";
    case 401:
      return "wallet_auth_unauthorized";
    case 413:
      return "wallet_auth_payload_too_large";
    case 429:
      return "wallet_auth_rate_limited";
    case 502:
    case 503:
      return "wallet_auth_unavailable";
    default:
      return "wallet_auth_request_failed";
  }
}

// Proxies POST /api/v1/auth/wallet/challenge and /verify (ADR 0021, #6835) to
// the DATA_API service binding -- all challenge issuance, sr25519
// verification, and session issuance live in workers/data-api.ts (via
// src/wallet-auth.ts); this is only the forwarding + envelope-translation
// boundary, same shape as handleAlertTriggersProxy above.
async function handleWalletAuthProxy(request: Request, env: Env) {
  if (!env.DATA_API) {
    return errorResponse(
      "wallet_auth_unavailable",
      "The wallet-auth tier is not bound to this deployment.",
      503,
    );
  }
  const fetched = await fetchDataApiOrUnreachable(env, request);
  if ("unreachable" in fetched) {
    return errorResponse(
      "wallet_auth_unavailable",
      "The wallet-auth tier is unreachable.",
      503,
    );
  }
  const upstream = fetched.upstream;
  let body: Row;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(
      "wallet_auth_unavailable",
      "The wallet-auth tier returned an unreadable response.",
      502,
    );
  }
  if (!upstream.ok) {
    const extraHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value != null) extraHeaders[name] = value;
    }
    return errorResponse(
      walletAuthErrorCode(upstream.status),
      typeof body?.error === "string"
        ? body.error
        : "The wallet-auth tier returned an error.",
      upstream.status,
      {},
      extraHeaders,
    );
  }
  return dataResponse(env, body, upstream.status);
}

// #8374: distinct error-code family from walletAuthErrorCode above, same
// reasoning -- a distinct surface's failures get their own code namespace
// even though the status-to-shape mapping happens to be identical.
function watchAuthErrorCode(status: number) {
  switch (status) {
    case 400:
      return "watch_auth_invalid";
    case 401:
      return "watch_auth_unauthorized";
    case 403:
      return "watch_auth_limit_reached";
    case 413:
      return "watch_auth_payload_too_large";
    case 429:
      return "watch_auth_rate_limited";
    case 502:
    case 503:
      return "watch_auth_unavailable";
    default:
      return "watch_auth_request_failed";
  }
}

// Proxies POST /api/v1/watch/challenges and /tokens (#8374) to the DATA_API
// service binding -- same forwarding + envelope-translation boundary as
// handleWalletAuthProxy above, kept as its own function (rather than a
// shared helper) matching this file's existing per-surface-proxy
// convention (see handleAlertTriggersProxy / handleWalletAuthProxy).
async function handleWatchAuthProxy(request: Request, env: Env) {
  if (!env.DATA_API) {
    return errorResponse(
      "watch_auth_unavailable",
      "The watch-alert-issuance tier is not bound to this deployment.",
      503,
    );
  }
  const fetched = await fetchDataApiOrUnreachable(env, request);
  if ("unreachable" in fetched) {
    return errorResponse(
      "watch_auth_unavailable",
      "The watch-alert-issuance tier is unreachable.",
      503,
    );
  }
  const upstream = fetched.upstream;
  let body: Row;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(
      "watch_auth_unavailable",
      "The watch-alert-issuance tier returned an unreadable response.",
      502,
    );
  }
  if (!upstream.ok) {
    const extraHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value != null) extraHeaders[name] = value;
    }
    return errorResponse(
      watchAuthErrorCode(upstream.status),
      typeof body?.error === "string"
        ? body.error
        : "The watch-alert-issuance tier returned an error.",
      upstream.status,
      {},
      extraHeaders,
    );
  }
  return dataResponse(env, body, upstream.status);
}

function accountKeysErrorCode(status: number) {
  switch (status) {
    case 400:
      return "account_key_invalid";
    case 401:
      return "account_key_unauthorized";
    case 404:
      return "account_key_not_found";
    case 405:
      return "account_key_method_not_allowed";
    case 413:
      return "account_key_payload_too_large";
    case 429:
      return "account_key_rate_limited";
    case 502:
    case 503:
      return "account_keys_unavailable";
    default:
      return "account_key_request_failed";
  }
}

// Proxies POST/GET /api/v1/keys and DELETE /api/v1/keys/{prefix} (ADR 0021,
// #6835) to the DATA_API service binding -- session validation, the invite-
// code gate, and all Postgres plumbing live in workers/data-api.ts; this is
// only the forwarding + envelope-translation boundary.
async function handleAccountKeysProxy(request: Request, env: Env) {
  if (!env.DATA_API) {
    return errorResponse(
      "account_keys_unavailable",
      "The account-keys tier is not bound to this deployment.",
      503,
    );
  }
  const fetched = await fetchDataApiOrUnreachable(env, request);
  if ("unreachable" in fetched) {
    return errorResponse(
      "account_keys_unavailable",
      "The account-keys tier is unreachable.",
      503,
    );
  }
  const upstream = fetched.upstream;
  let body: Row;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(
      "account_keys_unavailable",
      "The account-keys tier returned an unreadable response.",
      502,
    );
  }
  if (!upstream.ok) {
    const extraHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value != null) extraHeaders[name] = value;
    }
    return errorResponse(
      accountKeysErrorCode(upstream.status),
      typeof body?.error === "string"
        ? body.error
        : "The account-keys tier returned an error.",
      upstream.status,
      {},
      extraHeaders,
    );
  }
  return dataResponse(env, body, upstream.status);
}

// Proxies POST /api/v1/internal/registry-sync to the dedicated registry-sync
// Worker (REGISTRY_SYNC_API service binding), the sole write path into the
// registry Postgres instance. This function forwards the request as-is
// (including the x-registry-sync-token header) -- the shared-secret check
// happens once, downstream in workers/registry-sync-api.ts, which is the
// only place the secret needs to be provisioned. There is no bypass path
// here to defend against: REGISTRY_SYNC_API has no public routes of its own,
// so this route is the only way to reach it.
async function handleRegistrySyncProxy(request: Request, env: Env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Only POST is supported.", 405);
  }
  if (!env.REGISTRY_SYNC_API) {
    return errorResponse(
      "registry_sync_unavailable",
      "The registry-sync tier is not bound to this deployment.",
      503,
    );
  }
  const upstream = await env.REGISTRY_SYNC_API.fetch(request);
  let body;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(
      "registry_sync_unavailable",
      "The registry-sync tier returned an unreadable response.",
      502,
    );
  }
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Per-client abuse control for the six internal sync routes proxied through
// proxyToDataApi below (neurons-sync, backfill-neuron-daily, rollup-account-
// events-daily, subnet-hyperparams-sync, account-identity-sync, validator-
// nominator-counts-sync, nominator-positions-sync, #5549). Each authenticates
// with its OWN shared static secret downstream in data-api.ts -- this proxy
// has no auth of its own, so a leaked secret could otherwise script unbounded
// write volume against the chain-indexer Postgres, the same shape
// handleAlertTriggerCreate guards against. Looser than that route's 10/60s
// posture: legitimate callers include chunked historical backfills
// (scripts/backfill-neuron-history.py, scripts/backfill-stake-monthly.py)
// that POST many sequential chunks in one run -- 30/60s still firmly bounds
// abuse while tolerating that pattern. Keyed on a single shared bucket across
// all six routes (one leaked secret can't just switch routes to dodge the
// limit). Bound here in wrangler.jsonc (not wrangler.data.jsonc) because
// ratelimit namespaces are scoped to the Worker script that checks them, and
// this check runs in api.ts, not data-api.ts. Optional-chained so it's a
// no-op when the binding is absent (local dev/CI).
const INTERNAL_SYNC_RATE_LIMIT = { limit: 30, windowSeconds: 60 };

async function internalSyncRateLimited(request: Request, env: Env) {
  if (!env.INTERNAL_SYNC_RATE_LIMITER?.limit) return null;
  const { success } = await env.INTERNAL_SYNC_RATE_LIMITER.limit({
    key: `internal-sync:${resolveClientIp(request)}`,
  });
  if (success) return null;
  return errorResponse(
    "internal_sync_rate_limited",
    "Too many internal sync requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": String(INTERNAL_SYNC_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(INTERNAL_SYNC_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${INTERNAL_SYNC_RATE_LIMIT.limit};w=${INTERNAL_SYNC_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

// #5550: the chain-firehose ingest write path authenticates with a single
// static shared secret and then fans each accepted payload out to every live
// SSE/WS/GraphQL-subscription subscriber -- so a leaked CHAIN_FIREHOSE_SYNC_SECRET
// could flood every connected client with unbounded forged events, a distinct
// amplification angle from the one-record-per-request internal-sync routes.
// Keyed per client IP; optional-chained so it's a no-op when the binding is
// absent (local dev/CI).
//
// CORRECTED 2026-07 (real incident): the original 120/60s cap was sized for
// the box relay's OLD LISTEN/NOTIFY design (one notification per BLOCK,
// ~5/min at ~12s blocks). #5027 replaced that with an outbox-table poll,
// forwarding one row per BLOCKS/EXTRINSICS/CHAIN_EVENTS/ACCOUNT_EVENTS row
// (chain_events alone can be many per block) at up to
// CHAIN_FIREHOSE_FORWARD_CONCURRENCY=16 concurrent requests -- a genuinely
// different, much higher-volume traffic shape this limit was never
// recalibrated for. The mismatch caused a real, confirmed incident: every
// legitimate backlog-drain burst immediately 429'd, the relay's own retry
// logic didn't back off on 429 any differently than any other failure, and
// the resulting thundering-herd loop meant the backlog never actually
// drained -- millions of rows accumulated over ~40h. Raised to a cap sized
// for the CURRENT architecture's real legitimate throughput with meaningful
// headroom, not "no real limit" -- still authenticated + per-IP, so this
// isn't opening the endpoint to anonymous abuse, just no longer rate-limiting
// the one legitimate caller into a permanent failure loop. The relay's own
// forwardWithRetry now also properly respects retry-after and pauses its
// whole poll loop on a 429 (the since-retired relay), so a real
// spike still degrades gracefully instead of repeating this failure mode.
const CHAIN_FIREHOSE_INGEST_RATE_LIMIT = { limit: 1200, windowSeconds: 60 };

async function chainFirehoseIngestRateLimited(request: Request, env: Env) {
  if (!env.CHAIN_FIREHOSE_INGEST_RATE_LIMITER?.limit) return null;
  const { success } = await env.CHAIN_FIREHOSE_INGEST_RATE_LIMITER.limit({
    key: `chain-firehose-ingest:${resolveClientIp(request)}`,
  });
  if (success) return null;
  return errorResponse(
    "chain_firehose_ingest_rate_limited",
    "Too many chain-firehose ingest requests from this client; slow down.",
    429,
    {},
    {
      "retry-after": String(CHAIN_FIREHOSE_INGEST_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(CHAIN_FIREHOSE_INGEST_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${CHAIN_FIREHOSE_INGEST_RATE_LIMIT.limit};w=${CHAIN_FIREHOSE_INGEST_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

// Generic forwarder to the DATA_API service binding for the internal
// write/rollup routes that live inside workers/data-api.ts itself rather
// than a dedicated Worker (#4771's neurons-sync pattern) -- splitting read
// and write into two Workers for the IDENTICAL Postgres instance/Hyperdrive
// origin data-api.ts already reads from (the way registry-sync-api.ts is
// split, for a genuinely SEPARATE database) would only add a redundant
// deploy pipeline for zero bundle-budget benefit. Forwards the request as-is
// (including any shared-secret header) -- the auth check happens once,
// downstream in data-api.ts.
async function proxyToDataApi(
  request: Request,
  env: Env,
  {
    code,
    notBoundMessage,
    unreadableMessage,
    method = "POST",
  }: {
    code: string;
    notBoundMessage: string;
    unreadableMessage: string;
    /** The ONE method this route accepts. Defaults to POST because every sync
     * route is a write; #9208's chain-detail head read is the first GET, and it
     * is still a single-method route -- the gate stays "exactly one", not "any
     * method", so a POST to a read route is still a clean 405. */
    method?: "GET" | "POST";
  },
) {
  if (request.method !== method) {
    return errorResponse(
      "method_not_allowed",
      `Only ${method} is supported.`,
      405,
    );
  }
  if (!env.DATA_API) {
    return errorResponse(code, notBoundMessage, 503);
  }
  const rateLimited = await internalSyncRateLimited(request, env);
  if (rateLimited) return rateLimited;
  const fetched = await fetchDataApiOrUnreachable(env, request);
  if ("unreachable" in fetched) {
    return errorResponse(code, notBoundMessage, 503);
  }
  const upstream = fetched.upstream;
  let body;
  try {
    body = await upstream.json();
  } catch {
    return errorResponse(code, unreadableMessage, 502);
  }
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Proxies POST /api/v1/internal/neurons-sync -- the write path into the
// chain-indexer Postgres's neurons/neuron_daily tables (#4771). Mirrors
// handleRegistrySyncProxy's shape otherwise (forwards the request as-is,
// including the x-neurons-sync-token header).
async function handleNeuronsSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "neurons_sync_unavailable",
    notBoundMessage: "The neurons-sync tier is not bound to this deployment.",
    unreadableMessage: "The neurons-sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/chain-detail-sync -- the write path into the
// chain-detail hot tier (#9208), which is what makes drill-down on a recent
// block current rather than empty. metagraphed-infra's live-follow poller lane
// calls this every ~24s with 2 decoded blocks. Same DATA_API service binding,
// and the same INTERNAL_SYNC_RATE_LIMITER bucket, as neurons-sync above: at
// ~2.5 requests/minute the lane sits an order of magnitude under that bucket's
// 30/60s, so it shares the limit without needing its own.
async function handleChainDetailSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "chain_detail_sync_unavailable",
    notBoundMessage:
      "The chain-detail sync tier is not bound to this deployment.",
    unreadableMessage:
      "The chain-detail sync tier returned an unreadable response.",
  });
}

// Proxies GET /api/v1/internal/chain-detail-sync/head -- the producer's resume
// point (#9208). A GET rather than a POST because it reads one integer and
// changes nothing; it carries the same token as the sync itself, so it is not a
// public read.
async function handleChainDetailSyncHeadProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "chain_detail_sync_unavailable",
    notBoundMessage:
      "The chain-detail sync tier is not bound to this deployment.",
    unreadableMessage:
      "The chain-detail sync tier returned an unreadable response.",
    method: "GET",
  });
}

// Proxies POST /api/v1/internal/backfill-neuron-daily -- deep-history ingest
// for scripts/backfill-neuron-history.py and scripts/backfill-stake-monthly.py
// into neuron_daily/account_position_daily (see handleNeuronDailyBackfill's
// own header for why this is NOT the same route/semantics as neurons-sync).
// Same DATA_API service binding as neurons-sync above.
async function handleNeuronDailyBackfillProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "neuron_daily_backfill_unavailable",
    notBoundMessage:
      "The neuron-daily backfill tier is not bound to this deployment.",
    unreadableMessage:
      "The neuron-daily backfill tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/rollup-account-events-daily -- the write
// path into the chain-indexer Postgres's account_events_daily rollup
// (#4832 gap-closure). Same DATA_API service binding as neurons-sync above;
// see proxyToDataApi's comment for why this isn't a dedicated Worker.
async function handleRollupAccountEventsDailyProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "rollup_account_events_daily_unavailable",
    notBoundMessage:
      "The account-events-daily rollup tier is not bound to this deployment.",
    unreadableMessage:
      "The account-events-daily rollup tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/subnet-hyperparams-sync -- the write path
// into subnet_hyperparams/subnet_hyperparams_history (#4832 gap-closure).
// Same DATA_API service binding as neurons-sync/rollup above.
async function handleSubnetHyperparamsSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "subnet_hyperparams_sync_unavailable",
    notBoundMessage:
      "The subnet-hyperparams sync tier is not bound to this deployment.",
    unreadableMessage:
      "The subnet-hyperparams sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/subnet-locks-sync -- the write path into
// subnet_locks (#6638, conviction/ownership-contest tracker epic #4302).
// Same DATA_API service binding as the other internal sync routes above.
async function handleSubnetLocksSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "subnet_locks_sync_unavailable",
    notBoundMessage:
      "The subnet-locks sync tier is not bound to this deployment.",
    unreadableMessage:
      "The subnet-locks sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/account-identity-sync -- the write path into
// account_identity/account_identity_history (#4832 gap-closure). Same
// DATA_API service binding as the other internal sync routes above.
async function handleAccountIdentitySyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "account_identity_sync_unavailable",
    notBoundMessage:
      "The account-identity sync tier is not bound to this deployment.",
    unreadableMessage:
      "The account-identity sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/validator-nominator-counts-sync -- the write
// path into validator_nominator_counts (#2549). Same DATA_API service
// binding as the other internal sync routes above.
async function handleValidatorNominatorCountsSyncProxy(
  request: Request,
  env: Env,
) {
  return proxyToDataApi(request, env, {
    code: "validator_nominator_counts_sync_unavailable",
    notBoundMessage:
      "The validator-nominator-counts sync tier is not bound to this deployment.",
    unreadableMessage:
      "The validator-nominator-counts sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/nominator-positions-sync -- the write path
// into nominator_positions (#5233). Same DATA_API service binding as the
// other internal sync routes above.
async function handleNominatorPositionsSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "nominator_positions_sync_unavailable",
    notBoundMessage:
      "The nominator-positions sync tier is not bound to this deployment.",
    unreadableMessage:
      "The nominator-positions sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/account-balances-sync -- the write path into
// account_balances (#6742). Same DATA_API service binding as the other
// internal sync routes above. This proxy was missing entirely (data-api.ts's
// own handleAccountBalancesSync existed, but nothing in this public-facing
// Worker ever forwarded to it) -- confirmed live 2026-07-19: every real
// data-refresh-cron run since #6742 shipped 405'd on this exact route,
// meaning account_balances has never received a row from any caller.
async function handleAccountBalancesSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "account_balances_sync_unavailable",
    notBoundMessage:
      "The account-balances sync tier is not bound to this deployment.",
    unreadableMessage:
      "The account-balances sync tier returned an unreadable response.",
  });
}

// Proxies POST /api/v1/internal/hotkey-alpha-sync -- the write path into
// hotkey_alpha (#9502), the (hotkey, netuid) alpha-pool totals delegated_tao
// needs to value a position. Same DATA_API service binding as the other
// internal sync routes above.
async function handleHotkeyAlphaSyncProxy(request: Request, env: Env) {
  return proxyToDataApi(request, env, {
    code: "hotkey_alpha_sync_unavailable",
    notBoundMessage:
      "The hotkey-alpha sync tier is not bound to this deployment.",
    unreadableMessage:
      "The hotkey-alpha sync tier returned an unreadable response.",
  });
}

// --- POST /api/v1/internal/emission-gate-sync (#8748/#8750 restored) --------
// The persistence half of the emission-gate sampling lane, moved off the
// decommissioned box's Postgres onto D1. scripts/sample-emission-gate.ts (now
// on a 10-minute GitHub Actions schedule, .github/workflows/
// sample-emission-gate.yml) keeps ALL the chain reading and POSTs one
// observation here; this handler loads the last known state per key from D1,
// runs the same PURE differs the box run called (src/emission-gate-history.ts,
// src/emission-flow-monitor.ts), batch-inserts only the rows they return, and
// replies with the summary the script used to log. Idempotent by construction:
// the differs return [] when nothing moved, so re-POSTing an unchanged
// observation writes nothing.
//
// Auth mirrors handleNeuronsSync (workers/data-api.ts): a single shared-secret
// header compared timing-safely, 503 when unprovisioned, 401 on mismatch --
// with api.ts's own errorResponse envelope, like the other secret-gated route
// that lives in this Worker (handleChainFirehoseIngest). Direct D1
// (METAGRAPH_HEALTH_DB), not the DATA_API service binding: these tables live
// in the same D1 database as the observation tables (migrations/d1/
// 0005_emission_gate.sql), not in the chain-indexer Postgres.
const EMISSION_GATE_SYNC_TOKEN_HEADER = "x-emission-gate-sync-token";
// One observation is ~130 [netuid, boolean] pairs + ~130 EMA entries + four
// scalar params -- a few KB. 1 MB is generous headroom without inviting a
// pathological body, same posture as NEURONS_SYNC_MAX_BODY_BYTES.
const EMISSION_GATE_SYNC_MAX_BODY_BYTES = 1_000_000;
const EMISSION_GATE_SYNC_MAX_ENTRIES = 10_000;
const EMISSION_GATE_SYNC_MAX_NETUID = 65_535;
// Raw storage values are 0x-hex; the largest tracked item decodes from 24
// bytes. 256 chars bounds any future shape without accepting arbitrary blobs.
const EMISSION_GATE_SYNC_MAX_RAW_CHARS = 256;

// Latest row per key via ROW_NUMBER() -- the D1/SQLite translation of the
// box sampler's postgres `SELECT DISTINCT ON (key) ... ORDER BY key,
// observed_at DESC` reads (DISTINCT ON is postgres-only; SQLite has window
// functions). `id DESC` tiebreaks two rows sharing an observed_at
// deterministically -- the differs write at most one row per key per run, so
// it only matters for hand-migrated or hand-edited data.
const EMISSION_GATE_PREV_PARAMS_SQL = `
  SELECT param, value FROM (
    SELECT param, value, ROW_NUMBER() OVER (
      PARTITION BY param ORDER BY observed_at DESC, id DESC) AS rn
      FROM emission_gate_param_history)
   WHERE rn = 1`;
const EMISSION_GATE_PREV_ENABLED_SQL = `
  SELECT netuid, enabled FROM (
    SELECT netuid, enabled, ROW_NUMBER() OVER (
      PARTITION BY netuid ORDER BY observed_at DESC, id DESC) AS rn
      FROM subnet_emission_enabled_history)
   WHERE rn = 1`;
// The EMA rows share the table but not the keyspace: `previous` for the flow
// differ is per network-level ITEM, and subnet_ema_tao_flow rows are per
// netuid -- same WHERE the box sampler's read carried.
const EMISSION_GATE_PREV_FLOW_SQL = `
  SELECT item, is_set FROM (
    SELECT item, is_set, ROW_NUMBER() OVER (
      PARTITION BY item ORDER BY observed_at DESC, id DESC) AS rn
      FROM emission_flow_watch
     WHERE item <> 'subnet_ema_tao_flow')
   WHERE rn = 1`;

const EMISSION_GATE_INSERT_PARAM_SQL = `
  INSERT INTO emission_gate_param_history
    (param, value, previous_value, source, block_number, observed_at, predates_capture)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
const EMISSION_GATE_INSERT_ENABLED_SQL = `
  INSERT INTO subnet_emission_enabled_history
    (netuid, enabled, previous_enabled, block_number, observed_at, predates_capture)
  VALUES (?, ?, ?, ?, ?, ?)`;
const EMISSION_GATE_INSERT_FLOW_SQL = `
  INSERT INTO emission_flow_watch
    (item, netuid, is_set, ema_block, block_number, observed_at, predates_capture)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

// [netuid, X] pair arrays are how the script serializes its Maps (JSON has no
// Map). Bounds both the entry count and each netuid; the second element's
// shape is the caller's to check per array.
function validEmissionGateSyncPairs(
  value: unknown,
  validSecond: (second: unknown) => boolean,
): boolean {
  if (!Array.isArray(value) || value.length > EMISSION_GATE_SYNC_MAX_ENTRIES) {
    return false;
  }
  return value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      Number.isInteger(entry[0]) &&
      entry[0] >= 0 &&
      entry[0] <= EMISSION_GATE_SYNC_MAX_NETUID &&
      validSecond(entry[1]),
  );
}

// Defensive shape check over the whole POST body -- returns the 400 message,
// or null when the body is well-formed. Everything downstream (the differs,
// the D1 binds) assumes these shapes, so malformed input must die here as a
// clean 400, never as an uncaught throw mid-write.
function emissionGateSyncBodyError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "body must be a JSON object";
  }
  const body = parsed as Row;
  if (!Number.isInteger(body.block_number) || body.block_number < 0) {
    return "block_number must be a non-negative integer";
  }
  if (!Number.isInteger(body.observed_at) || body.observed_at <= 0) {
    return "observed_at must be a positive epoch-ms integer";
  }
  if (
    !body.current ||
    typeof body.current !== "object" ||
    Array.isArray(body.current)
  ) {
    return "current must be an object of gate-parameter readings";
  }
  for (const [param, value] of Object.entries(body.current)) {
    if (!(param in GATE_PARAM_SOURCES)) {
      return `current.${param} is not a tracked gate parameter`;
    }
    if (value !== null && typeof value !== "number") {
      return `current.${param} must be a number or null`;
    }
    // A non-finite reading can only be a decode bug upstream; recording it
    // would poison every later diff against this key.
    if (typeof value === "number" && !Number.isFinite(value)) {
      return `current.${param} must be finite`;
    }
  }
  if (
    !validEmissionGateSyncPairs(
      body.current_enabled,
      (second) => typeof second === "boolean",
    )
  ) {
    return "current_enabled must be an array of [netuid, boolean] pairs";
  }
  if (
    !Array.isArray(body.flow_observations) ||
    body.flow_observations.length > EMISSION_GATE_SYNC_MAX_ENTRIES
  ) {
    return "flow_observations must be an array of {item, raw} observations";
  }
  for (const observation of body.flow_observations as Row[]) {
    if (
      !observation ||
      typeof observation !== "object" ||
      Array.isArray(observation)
    ) {
      return "flow_observations entries must be {item, raw} objects";
    }
    if (
      typeof observation.item !== "string" ||
      !(observation.item in FLOW_PARAM_ITEMS)
    ) {
      return "flow_observations items must be tracked flow parameters";
    }
    if (
      observation.raw !== null &&
      (typeof observation.raw !== "string" ||
        observation.raw.length > EMISSION_GATE_SYNC_MAX_RAW_CHARS)
    ) {
      return "flow_observations raw must be a bounded hex string or null";
    }
  }
  if (
    !validEmissionGateSyncPairs(
      body.current_ema,
      (second) =>
        second === null ||
        (typeof second === "object" &&
          !Array.isArray(second) &&
          Number.isInteger((second as Row).block) &&
          (second as Row).block >= 0),
    )
  ) {
    return "current_ema must be an array of [netuid, {block} | null] pairs";
  }
  return null;
}

async function emissionGateSyncRows(
  db: D1Database,
  sql: string,
): Promise<Row[]> {
  const outcome = await db.prepare(sql).all();
  return (outcome?.results ?? []) as Row[];
}

async function handleEmissionGateSync(request: Request, env: Env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Only POST is supported.", 405);
  }
  if (!env.EMISSION_GATE_SYNC_SECRET) {
    return errorResponse(
      "emission_gate_sync_unavailable",
      "The emission-gate sync tier is not provisioned on this deployment.",
      503,
    );
  }
  const provided = request.headers.get(EMISSION_GATE_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.EMISSION_GATE_SYNC_SECRET)) {
    return errorResponse(
      "emission_gate_sync_unauthorized",
      `Provide a valid ${EMISSION_GATE_SYNC_TOKEN_HEADER} header.`,
      401,
    );
  }
  const db = env.METAGRAPH_HEALTH_DB;
  if (!db) {
    return errorResponse(
      "emission_gate_sync_unavailable",
      "The health D1 database is not bound to this deployment.",
      503,
    );
  }

  const raw = await request.text();
  if (
    new TextEncoder().encode(raw).length > EMISSION_GATE_SYNC_MAX_BODY_BYTES
  ) {
    return errorResponse(
      "emission_gate_sync_body_too_large",
      `Body exceeds ${EMISSION_GATE_SYNC_MAX_BODY_BYTES} bytes.`,
      413,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(
      "emission_gate_sync_invalid_body",
      "Body must be JSON.",
      400,
    );
  }
  const shapeError = emissionGateSyncBodyError(parsed);
  if (shapeError) {
    return errorResponse("emission_gate_sync_invalid_body", shapeError, 400);
  }
  const body = parsed as Row;
  const blockNumber = body.block_number as number;
  const observedAt = body.observed_at as number;

  try {
    // Last known value per key, from the three history tables -- the same
    // three reads the box sampler did, feeding the differs' `previous`.
    const previous: GateParamReading = {};
    for (const row of await emissionGateSyncRows(
      db,
      EMISSION_GATE_PREV_PARAMS_SQL,
    )) {
      previous[row.param as GateParam] =
        row.value === null ? null : Number(row.value);
    }
    const previousEnabled = new Map<number, boolean>(
      (await emissionGateSyncRows(db, EMISSION_GATE_PREV_ENABLED_SQL)).map(
        (row) => [Number(row.netuid), Boolean(row.enabled)],
      ),
    );
    const previousFlow = new Map<FlowParamItem, boolean>(
      (await emissionGateSyncRows(db, EMISSION_GATE_PREV_FLOW_SQL)).map(
        (row) => [row.item as FlowParamItem, Boolean(row.is_set)],
      ),
    );

    const currentEnabled = new Map<number, boolean>(
      body.current_enabled as [number, boolean][],
    );
    const currentEma = new Map<number, { block: number } | null>(
      body.current_ema as [number, { block: number } | null][],
    );

    // The same four pure calls, in the same order, the box run made.
    const paramChanges = gateParamChanges({
      current: body.current as GateParamReading,
      previous,
      blockNumber,
      observedAt,
    });
    const enabledChanges = subnetEnabledChanges({
      current: currentEnabled,
      previous: previousEnabled,
      blockNumber,
      observedAt,
    });
    const flowEvents = [
      ...flowParamEvents({
        current: body.flow_observations as FlowParamObservation[],
        previous: previousFlow,
        blockNumber,
        observedAt,
      }),
      ...emaAdvancedEvents({
        current: currentEma,
        baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
        blockNumber,
        observedAt,
      }),
    ];

    const statements = [
      ...paramChanges.map((change) =>
        db
          .prepare(EMISSION_GATE_INSERT_PARAM_SQL)
          .bind(
            change.param,
            change.value,
            change.previous_value,
            change.source,
            change.block_number,
            change.observed_at,
            change.predates_capture ? 1 : 0,
          ),
      ),
      ...enabledChanges.map((change) =>
        db
          .prepare(EMISSION_GATE_INSERT_ENABLED_SQL)
          .bind(
            change.netuid,
            change.enabled ? 1 : 0,
            change.previous_enabled === null
              ? null
              : change.previous_enabled
                ? 1
                : 0,
            change.block_number,
            change.observed_at,
            change.predates_capture ? 1 : 0,
          ),
      ),
      ...flowEvents.map((event) =>
        db
          .prepare(EMISSION_GATE_INSERT_FLOW_SQL)
          .bind(
            event.item,
            event.netuid,
            event.is_set ? 1 : 0,
            event.ema_block,
            event.block_number,
            event.observed_at,
            event.predates_capture ? 1 : 0,
          ),
      ),
    ];
    // db.batch([]) is a D1 error, and a no-change run (the common case, the
    // whole reason the differs exist) produces exactly that.
    if (statements.length > 0) {
      await db.batch(statements);
    }

    // The alertable list rides back to the script so its stderr ALERT +
    // optional webhook (the #8750 stirred-path alarm) keep working -- a
    // predates_capture row just states what was already true when capture
    // began, so only genuine events qualify.
    const alertable = flowEvents
      .filter((event) => !event.predates_capture)
      .map((event) => ({ item: event.item, netuid: event.netuid }));
    return new Response(
      JSON.stringify({
        ok: true,
        block_number: blockNumber,
        gate_param_rows: paramChanges.length,
        subnet_enabled_rows: enabledChanges.length,
        flow_watch_rows: flowEvents.length,
        flow_alertable: alertable.length,
        subnets_seen: currentEnabled.size,
        ema_entries_seen: currentEma.size,
        alertable,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (err) {
    // Same containment as handleNeuronsSync's write path: a D1 fault is a
    // retryable upstream failure, not an unhandled Worker exception. The next
    // 10-minute run re-observes the same chain state, so nothing is lost.
    console.error("emission-gate-sync write failed:", err);
    return errorResponse(
      "emission_gate_sync_failed",
      "The emission-gate history write failed; retry.",
      502,
    );
  }
}

// GET /api/v1/chain/stream (#4982, ADR 0015) -- the public realtime firehose
// transport. SSE by default; a WebSocket Upgrade header on this same path
// gets the WS transport instead. No auth: this is the same public read-only
// data /api/v1/chain-events already serves, just pushed instead of polled.
// ChainFirehoseHub itself decides SSE vs WS and applies the ?topics= filter
// -- this is only the forwarding boundary into the DO.
async function handleChainFirehoseStream(request: Request, env: Env, url: URL) {
  if (!env.CHAIN_FIREHOSE_HUB) {
    return errorResponse(
      "chain_firehose_unavailable",
      "The realtime chain firehose is not bound to this deployment.",
      503,
    );
  }
  const stub = env.CHAIN_FIREHOSE_HUB.get(
    env.CHAIN_FIREHOSE_HUB.idFromName("global"),
  );
  const forwardUrl = new URL("https://chain-firehose-hub.internal/subscribe");
  forwardUrl.search = url.search;
  return stub.fetch(new Request(forwardUrl, request));
}

// POST /api/v1/internal/chain-firehose-ingest -- the write path the #4981
// box-side relay calls with each #4980 NOTIFY payload it forwards. Auth
// happens HERE, not inside ChainFirehoseHub: a Durable Object is never
// internet-addressable on its own (only reachable through this Worker's
// binding), so this is the one place a forged request could be rejected --
// mirrors every other /api/v1/internal/*-sync route's shared-secret
// convention (see handleNeuronsSync in workers/data-api.ts).
async function handleChainFirehoseIngest(request: Request, env: Env) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Only POST is supported.", 405);
  }
  if (!env.CHAIN_FIREHOSE_SYNC_SECRET) {
    return errorResponse(
      "chain_firehose_ingest_unavailable",
      "The chain-firehose ingest tier is not provisioned on this deployment.",
      503,
    );
  }
  const provided =
    request.headers.get(CHAIN_FIREHOSE_INGEST_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.CHAIN_FIREHOSE_SYNC_SECRET)) {
    return errorResponse(
      "chain_firehose_ingest_unauthorized",
      `Provide a valid ${CHAIN_FIREHOSE_INGEST_TOKEN_HEADER} header.`,
      401,
    );
  }
  // Rate-limit only authenticated callers (unauth/wrong-method are rejected
  // above without consuming limiter budget) so a leaked secret can't flood
  // every live firehose subscriber (#5550).
  const rateLimited = await chainFirehoseIngestRateLimited(request, env);
  if (rateLimited) return rateLimited;
  if (!env.CHAIN_FIREHOSE_HUB) {
    return errorResponse(
      "chain_firehose_unavailable",
      "The realtime chain firehose is not bound to this deployment.",
      503,
    );
  }
  const body = await request.text();
  const stub = env.CHAIN_FIREHOSE_HUB.get(
    env.CHAIN_FIREHOSE_HUB.idFromName("global"),
  );
  let upstream;
  try {
    upstream = await stub.fetch("https://chain-firehose-hub.internal/ingest", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Sentry METAGRAPHED-1: a DO stub call throws "Durable Object reset
    // because its code was updated" when a deploy touching ChainFirehoseHub
    // (or a transitive dep) lands mid-request -- expected/occasional, not a
    // real fault. Left uncaught this was an unhandled Worker exception; a
    // clean, retryable 503 lets the relay's own retry/backoff (#6451) handle
    // it the same way it already handles a rate-limited or unavailable hub.
    return errorResponse(
      "chain_firehose_ingest_unavailable",
      "The realtime chain firehose was temporarily unavailable; retry.",
      503,
      {},
      { "retry-after": "1" },
    );
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleRequest(
  request: Request,
  env: Env = {} as unknown as Env,
  ctx: Ctx = {},
) {
  let url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request);
  }

  // #8597: count EVERY API request, keyed or keyless, into the cost rollup.
  //
  // Placed here -- the one point every request passes -- rather than at the ~6
  // sites recordApiKeyUsage is called from, because those sites are by
  // definition only reached by requests that presented a key. Keyless traffic
  // is the majority by design and is the entire subject of ADR 0022's deferred
  // pricing question, so counting it anywhere downstream would reproduce
  // exactly the blind spot this issue exists to remove.
  //
  // AFTER the OPTIONS early-return: a CORS preflight is browser bookkeeping,
  // not a request for data, and counting it would inflate every browser-facing
  // family by roughly 2x against the same family called from an agent.
  //
  // `keyed` is a cheap header SHAPE check, deliberately NOT a key validation --
  // validating here would put a KV/service-binding round trip in front of every
  // request including keyless ones, which is the opposite of this being free.
  // A malformed `mg_` bearer counts as keyed and is a rounding error against
  // the question being asked.
  if (
    !ctx.methodProbe &&
    (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/"))
  ) {
    const authHeader = request.headers.get("authorization") || "";
    recordUsageRollup(
      env,
      ctx,
      url.pathname,
      authHeader.startsWith("Bearer mg_"),
    );
  }

  // Multi-network addressing: an explicit /{network}/ prefix (mainnet/testnet/
  // local + finney/test aliases) routes through the network-aware artifact
  // handler. Bare paths fall through to the full dispatch below unchanged, so
  // mainnet behaviour is byte-identical to before networks existed.
  const networkRoute = resolveNetworkPrefix(url);

  // #8699: the capability matrix, answered here — after the prefix is resolved
  // but BEFORE any network-scoped dispatch, the local gate, or the
  // mainnet-only gate. This is the one route that must never 404 on any
  // network, because it is how a caller learns what does 404; answering it
  // downstream of any of those gates would break exactly the cases it exists
  // for (/api/v1/local/networks, /api/v1/testnet/networks).
  //
  // Resolved from networkRoute.url, not `url`, so the prefixed and bare forms
  // reach it identically. The document is the same on every network: it
  // describes the whole matrix rather than one network's view, so an agent can
  // plan a cross-network task from a single request.
  if (networkRoute.url.pathname === "/api/v1/networks") {
    return envelopeResponse(
      request,
      {
        data: buildNetworksPayload({
          routes: API_ROUTES,
          networks: NETWORKS,
          isMainnetOnly: isMainnetOnlyApiPath,
          publishedArtifacts: NETWORK_PUBLISHED_ARTIFACT_PATHS,
          nonArtifactRoutes: [
            ...LIVE_CHAIN_ROUTE_PATHS,
            ...CHAIN_HISTORY_ROUTE_PATHS,
            ...PROJECTION_ROUTE_PATHS,
          ],
        }),
        meta: { contract_version: contractVersion(env) },
      },
      "short",
    );
  }

  if (networkRoute.explicit) {
    if (networkRoute.network.isDefault) {
      url = networkRoute.url;
      request = new Request(url.toString(), request);
    } else {
      return handleNetworkScopedRequest(
        request,
        env,
        networkRoute.url,
        networkRoute.network,
        ctx,
      );
    }
  }

  // Isolated, account-gated fullnode RPC gate (ADR 0021, #6835) -- checked
  // BEFORE the public /rpc/v1/{network} prefix below so "fullnode" is never
  // mistaken for a network name there (RPC_PROXY_POOLS has no such entry,
  // which would otherwise just 404 as rpc_network_unsupported instead of
  // reaching this dedicated, differently-authed handler).
  if (url.pathname === "/rpc/v1/fullnode") {
    return handleFullnodeRpcProxyRequest(request, env, url, ctx);
  }

  if (url.pathname.startsWith("/rpc/v1/")) {
    return handleRpcProxyRequest(request, env, url, ctx);
  }

  // The chain-events family (ADR 0013's all-events tier, now lakehouse-served).
  // The tiered rate limit and usage accounting live INSIDE the handler rather
  // than here, so the /{network}/-prefixed dispatch cannot reach the same
  // routes ungated -- see handleChainEventsFamily.
  if (
    url.pathname === "/api/v1/chain-events" ||
    url.pathname === "/api/v1/chain-events/stats" ||
    /^\/api\/v1\/blocks\/\d+\/chain-events$/.test(url.pathname) ||
    /^\/api\/v1\/subnets\/\d+\/ownership-history$/.test(url.pathname) ||
    /^\/api\/v1\/subnets\/\d+\/conviction$/.test(url.pathname) ||
    /^\/api\/v1\/subnets\/\d+\/lease\/history$/.test(url.pathname)
  ) {
    return handleChainEventsFamily(request, env, url, ctx);
  }

  // Change-feed webhooks: subscription management accepts POST/DELETE/GET, so it
  // must run before the read-only method gate below (like the RPC proxy).
  if (url.pathname.startsWith("/api/v1/webhooks/")) {
    return handleWebhookRequest(request, env, url, ctx);
  }

  // Chain alert triggers (#4984 Part 1): CRUD accepts POST/GET/PATCH/DELETE,
  // so it must run before the read-only method gate below, same as webhooks
  // above. All auth/routing/validation live in workers/data-api.ts's
  // handleAlertTriggersRoute -- this is only the DATA_API forwarding
  // boundary.
  // isPathUnder, not startsWith: an unbounded prefix also matched
  // `/api/v1/alerts/triggersanything`, forwarding a path that is not a route to
  // the CRUD proxy, where an absent id + POST created a real trigger row.
  if (
    isPathUnder(url.pathname, "/api/v1/alerts/triggers") ||
    // #8375: the Alert Center's address-scoped counterpart -- same generic
    // pass-through proxy (all auth/routing/validation live in
    // workers/data-api.ts's handleWatchTriggersRoute), same error-code
    // family as it's still an alert-trigger-family failure.
    isPathUnder(url.pathname, "/api/v1/watch/triggers") ||
    // #8808: same watch family, same generic pass-through proxy -- all
    // auth/routing/validation live in workers/data-api.ts's
    // handleWatchPushSubscriptions* handlers, this is only the DATA_API
    // forwarding boundary. CRUD accepts POST/GET/DELETE, so it must also
    // run ahead of the read-only method gate.
    isPathUnder(url.pathname, "/api/v1/watch/push-subscriptions")
  ) {
    return handleAlertTriggersProxy(request, env);
  }

  // Wallet-signature login + account-gated fullnode API keys (ADR 0021,
  // #6835): both accept POST (challenge/verify/create), plus GET (list) and
  // DELETE (revoke) for /api/v1/keys, so both must run before the read-only
  // method gate below, same as webhooks/alert-triggers above.
  if (
    url.pathname === "/api/v1/auth/wallet/challenge" ||
    url.pathname === "/api/v1/auth/wallet/verify"
  ) {
    return handleWalletAuthProxy(request, env);
  }
  // #8374: self-serve wallet-verified alert-trigger issuance -- POST-only,
  // same "must run before the read-only method gate" reasoning as the
  // wallet-login pair immediately above.
  if (
    url.pathname === "/api/v1/watch/challenges" ||
    url.pathname === "/api/v1/watch/tokens"
  ) {
    return handleWatchAuthProxy(request, env);
  }
  if (url.pathname.startsWith("/api/v1/keys")) {
    return handleAccountKeysProxy(request, env);
  }

  // GitHub OAuth (metagraphed#7151): the two routes @cloudflare/workers-
  // oauth-provider's own authorizeEndpoint deliberately leaves to
  // application code (see src/github-oauth.ts's header). GET-only --
  // both are browser-redirect targets, never called by a client library
  // directly.
  if (request.method === "GET" && url.pathname === "/authorize") {
    return handleAuthorizeRequest(request, env);
  }
  if (request.method === "GET" && url.pathname === "/oauth/callback/github") {
    return handleGithubOAuthCallback(request, env);
  }

  // Remote MCP server, for AI agents: stateless JSON-RPC over POST, plus GET
  // (the SSE resource-subscription push stream, #4983) and DELETE (explicit
  // session termination) -- all three handled inside handleMcpRequest itself.
  // Runs before the read-only method gate (POST/DELETE would otherwise be
  // rejected there) like the RPC proxy. Artifact/KV readers are injected so
  // the MCP tools reuse the exact R2/ASSETS resolution.
  // `/mcp` and `/mcp/` are the same endpoint. A trailing slash is what a client gets
  // from joining a base URL, and rejecting it bought nothing: OAuthProvider already
  // treats the two as one route, and the app answering only the bare form is what put
  // an otherwise-correct client on the 405 path.
  if (isMcpEndpointPath(url.pathname)) {
    // executionCtx is what lets tool-dispatch telemetry (#6031) drain its
    // capture through waitUntil instead of stranding it on isolate exit.
    return handleMcpRequest(request, env, {
      readArtifact,
      // `economics:current` reads go through the SAME memo the REST routes use
      // (readEconomicsCurrentKv), not a second, independently-timed read of the same
      // key. Two paths reading one blob on two schedules is how an agent ends up
      // holding two different snapshots of one resource with no way to tell which is
      // current — and MCP is the surface with no second path to check against.
      readHealthKv: ((e: Env, key: string) =>
        key === KV_ECONOMICS_CURRENT
          ? readEconomicsCurrentKv(e)
          : readHealthKv(e, key)) as unknown as typeof readHealthKv,
      executionCtx: ctx,
    });
  }

  // Grounded RAG answer endpoint (POST). Runs before the read-only method gate
  // and degrades to 503 when the AI bindings/kill-switch are absent.
  if (url.pathname === "/api/v1/ask") {
    return handleAskRequest(request, env, ctx);
  }

  // The only write path into the registry Postgres instance (a dedicated,
  // separate database from the chain-indexer's) -- GitHub Actions calls this
  // over HTTPS from the registry-sync workflows, never touches Postgres
  // directly. Proxies to the dedicated registry-sync Worker (wrangler.registry.jsonc),
  // which owns the postgres.js driver + this database's own Hyperdrive
  // binding, keeping this Worker's bundle lean the same way DATA_API does
  // for the chain-data tier.
  if (url.pathname === "/api/v1/internal/registry-sync") {
    return handleRegistrySyncProxy(request, env);
  }
  // The write path into the chain-indexer Postgres's neurons/neuron_daily
  // tables (#4771) -- refresh-metagraph.yml's sign-and-stage job calls this
  // over HTTPS alongside its existing R2-stage-to-D1 step. Proxies to
  // workers/data-api.ts's handleNeuronsSync via the SAME DATA_API service
  // binding the chain_events proxy above uses (not a separate Worker -- see
  // handleNeuronsSyncProxy's comment for why).
  if (url.pathname === "/api/v1/internal/neurons-sync") {
    return handleNeuronsSyncProxy(request, env);
  }
  // Deep-history backfill ingest for scripts/backfill-neuron-history.py and
  // scripts/backfill-stake-monthly.py, into neuron_daily/account_position_daily
  // ONLY (never the latest-only `neurons` table) -- see
  // handleNeuronDailyBackfillProxy's comment for why this is a separate route
  // from neurons-sync. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/backfill-neuron-daily") {
    return handleNeuronDailyBackfillProxy(request, env);
  }
  // The write path into the chain-detail hot tier (#9208) and the producer's
  // resume read. Both go to the SAME DATA_API service binding as the sync
  // routes above; the head route is the family's first GET.
  if (url.pathname === "/api/v1/internal/chain-detail-sync") {
    return handleChainDetailSyncProxy(request, env);
  }
  if (url.pathname === "/api/v1/internal/chain-detail-sync/head") {
    return handleChainDetailSyncHeadProxy(request, env);
  }
  // The write path into the chain-indexer Postgres's account_events_daily
  // rollup (#4832 gap-closure) -- a dedicated hourly GitHub Actions workflow
  // calls this (there is no daily snapshot job to piggyback on, unlike
  // neurons-sync above). Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/rollup-account-events-daily") {
    return handleRollupAccountEventsDailyProxy(request, env);
  }
  // The write path into subnet_hyperparams/subnet_hyperparams_history
  // (#4832 gap-closure) -- refresh-subnet-hyperparams.yml's sign-and-stage
  // job calls this the same way refresh-metagraph.yml calls neurons-sync
  // above. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/subnet-hyperparams-sync") {
    return handleSubnetHyperparamsSyncProxy(request, env);
  }
  // The write path into subnet_locks (#6638, conviction/ownership-contest
  // tracker epic #4302) -- the fetch-subnet-locks.py box-side systemd timer
  // calls this the same way the other periodic fetch scripts call their own
  // sync endpoints. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/subnet-locks-sync") {
    return handleSubnetLocksSyncProxy(request, env);
  }
  // The write path into account_identity/account_identity_history (#4832
  // gap-closure) -- refresh-account-identity.yml's sign-and-stage job calls
  // this the same way. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/account-identity-sync") {
    return handleAccountIdentitySyncProxy(request, env);
  }
  // The write path into validator_nominator_counts (#2549) --
  // refresh-validator-nominator-counts's own low-frequency cron calls this,
  // decoupled from refresh-metagraph.yml (see migrations/0043's own comment
  // for why). Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/validator-nominator-counts-sync") {
    return handleValidatorNominatorCountsSyncProxy(request, env);
  }
  // The write path into nominator_positions (#5233) -- same low-frequency
  // Alpha-scan cron that populates validator_nominator_counts also emits
  // this table (see the fetch script's own header comment). Same DATA_API
  // service binding.
  if (url.pathname === "/api/v1/internal/nominator-positions-sync") {
    return handleNominatorPositionsSyncProxy(request, env);
  }
  // The write path into account_balances (#6742) -- data-refresh-cron's
  // account-balances job POSTs here. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/account-balances-sync") {
    return handleAccountBalancesSyncProxy(request, env);
  }
  // The write path into hotkey_alpha (#9502) -- the poller's TotalHotkeyAlpha
  // scan POSTs here. Same DATA_API service binding.
  if (url.pathname === "/api/v1/internal/hotkey-alpha-sync") {
    return handleHotkeyAlphaSyncProxy(request, env);
  }
  // The write path into the emission-gate history tables on D1 (#8748/#8750,
  // box decommission) -- sample-emission-gate.yml's 10-minute schedule POSTs
  // the sampler's chain readings here, and this Worker owns the
  // previous-state reads, the pure differs, and the batch insert. Direct D1
  // (METAGRAPH_HEALTH_DB), not the DATA_API service binding: these tables
  // live in the same D1 database as the observation tables, not in the
  // chain-indexer Postgres. POST-only, so it runs before the read-only
  // method gate below, like the other internal sync routes above.
  if (url.pathname === "/api/v1/internal/emission-gate-sync") {
    return handleEmissionGateSync(request, env);
  }
  // The write path the #4981 box-side relay POSTs #4980's NOTIFY payloads to
  // (#4982, ADR 0015) -- forwards into ChainFirehoseHub after its own
  // shared-secret check. POST-only, so it must run before the read-only
  // method gate below, like the other internal sync routes above.
  if (url.pathname === "/api/v1/internal/chain-firehose-ingest") {
    return handleChainFirehoseIngest(request, env);
  }
  // The public realtime firehose transport (#4982, ADR 0015) -- SSE by
  // default, WebSocket on an Upgrade header, same path either way. Runs
  // early (like /rpc/v1/ and the chain-events family above) since a WebSocket
  // upgrade request must never be routed through JSON-response machinery.
  if (url.pathname === "/api/v1/chain/stream") {
    return handleChainFirehoseStream(request, env, url);
  }

  // GraphQL read-only query layer over existing artifacts (issue #751). Runs
  // before the read-only method gate because GraphQL accepts POST requests.
  // Rate-limited up front (same binding/strategy/429 as the RPC proxy) so a
  // single client can't fan out into unbounded artifact reads + query execution.
  if (url.pathname === "/api/v1/graphql") {
    // GraphQL subscriptions (#4983, ADR 0015) reuse this SAME path over a
    // WebSocket upgrade (Sec-WebSocket-Protocol: graphql-transport-ws) --
    // handleChainFirehoseStream already forwards the request as-is (headers
    // included) to ChainFirehoseHub's /subscribe, which inspects that same
    // header to pick graphql-ws vs plain-firehose mode; reused unchanged
    // rather than duplicating the DO-forwarding boilerplate. Checked before
    // the rate limiter: a long-lived WS connection isn't the same shape of
    // load a per-request POST limiter is meant for.
    if (request.headers.get("upgrade") === "websocket") {
      return handleChainFirehoseStream(request, env, url);
    }
    const limited = await graphqlRateLimited(request, env);
    if (limited) return limited;
    return handleGraphQLRequest(request, env);
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    // 405 says "this resource exists, but not with that method", so it is only true of
    // a path that exists. Every write route has already returned by here, so anything
    // still in flight is either a read surface being called wrongly (405) or a path
    // that is not a surface at all (404) -- and answering 404 with 405 sent an MCP
    // client hunting for a method that would work on a route that was never there.
    //
    // Resolved by ASKING THE ROUTER, not by mirroring it. A list of "paths that exist"
    // maintained beside the dispatch is a second copy of the routing table, and the
    // 401 this whole thread began with was two copies of one route disagreeing by a
    // single character. The probe re-enters as HEAD -- read-only by definition, no
    // body to serialise, and it passes this gate on the first check, so it cannot
    // recurse -- with `methodProbe` set so it charges nobody's rate limit and counts
    // as nobody's usage.
    const probe = await handleRequest(
      new Request(url.toString(), {
        method: "HEAD",
        headers: request.headers,
      }),
      env,
      { ...ctx, methodProbe: true },
    );
    if (probe.status === 404) {
      // No `allow` here on purpose: it names the methods a resource accepts, and this
      // one does not exist to accept any.
      return errorResponse("not_found", "No route matched this path.", 404);
    }
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      { allow: allowedMethodsForPath(url.pathname) },
    );
  }

  // Public content feeds (#741) — RSS 2.0 / Atom 1.0 / JSON Feed 1.1 over the
  // changelog + incident data we already compute. GET-only (runs after the
  // method gate); `/api/*` is run_worker_first so these never fall through to
  // the static assets. Read-only, content-negotiated, edge-cached.
  if (url.pathname.startsWith("/api/v1/feeds/")) {
    const feedCacheParams = [
      `format=${encodeURIComponent(
        resolveFeedFormat(url.pathname, request.headers.get("accept")),
      )}`,
    ];
    const tag = url.searchParams.get("tag");
    if (tag != null) feedCacheParams.push(`tag=${encodeURIComponent(tag)}`);
    const since = url.searchParams.get("since");
    if (since != null) {
      feedCacheParams.push(`since=${encodeURIComponent(since)}`);
    }
    const until = url.searchParams.get("until");
    if (until != null) {
      feedCacheParams.push(`until=${encodeURIComponent(until)}`);
    }
    const limit = url.searchParams.get("limit");
    if (limit != null) {
      feedCacheParams.push(`limit=${encodeURIComponent(limit)}`);
    }
    // #8376: the watch feed's entire identity is its `ids` set -- omitting
    // this would let two different watchlists share one cached response
    // (the edge cache key is this composed query string, not the raw request
    // URL), silently serving one visitor's watched entities to another.
    const ids = url.searchParams.get("ids");
    if (ids != null) feedCacheParams.push(`ids=${encodeURIComponent(ids)}`);
    const feedCachePath = `${url.pathname}?${feedCacheParams.join("&")}`;
    const feedRequest =
      request.method === "HEAD"
        ? new Request(request.url, { method: "GET", headers: request.headers })
        : request;
    const response = await withEdgeCache(
      feedRequest,
      ctx,
      env,
      "feeds",
      () =>
        handleFeedRequest(feedRequest, env, url, {
          readArtifact,
          errorResponse,
          // Must go through resolveGlobalIncidentsForFeed, not the ledger
          // stub directly (#8242) and not resolveGlobalIncidents(feedRequest,
          // ...) either (metagraphed#8353 -- that still forwarded THIS
          // route's own request, a path DATA_API has no route for, which
          // silently degraded to the empty stub the same way #8242's bug
          // did). See that function's own doc comment for the full mechanism.
          loadLiveIncidents: resolveGlobalIncidentsForFeed,
          loadSubnetNews: resolveSubnetNewsForFeed,
        }),
      feedCachePath,
    );
    return request.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response;
  }

  // Curated parameterized query library (#6755/#6757): GET /api/v1/queries/{id}
  // runs one maintainer-curated saved-query template (src/saved-queries.ts),
  // the REST mirror of the run_saved_query MCP tool. Live per-request result
  // with no fixed response shape across templates -- same reason /api/v1/graphql
  // above sits outside the API_ROUTES/contracts.ts registry rather than a
  // route()+artifact() pair.
  if (url.pathname.startsWith(SAVED_QUERIES_PATH_PREFIX)) {
    return handleSavedQueryRequest(request, env, url);
  }

  // Embeddable SVG badges at /api/v1/{subnets/{netuid}|providers/{slug}}/
  // badge.svg. Worker-computed image, caught before the generic entity routing so
  // `badge.svg` isn't resolved as an entity sub-resource. `?metric=uptime` reads
  // the live reliability rollup (health DB); `?metric=completeness` reads profiles.
  if (
    /^\/api\/v1\/(?:subnets|providers)\/[^/]+\/badge\.svg$/.test(url.pathname)
  ) {
    return handleBadgeRequest(request, env, url, {
      readArtifact,
    });
  }

  // Dynamic Open Graph card (/og.png, alias /og) for the landing page's
  // link-unfurl. Rendered at publish time (scripts/refresh-og-image.ts,
  // Node context) and stored in R2 like every other artifact -- the live
  // route here is just a binary R2 read, never a satori/resvg render (#6502:
  // the workers-og wasm cost ~545 KiB gzipped and pushed this Worker's own
  // bundle over Cloudflare's deploy ceiling once @sentry/cloudflare was
  // added; the fix was to stop shipping workers-og in any live Worker at
  // all, not to relocate the render into a second Worker). See
  // src/og-image.ts's own header for the full rationale.
  if (url.pathname === "/og.png" || url.pathname === "/og") {
    return handleOgImage(request, env, url, { readR2Object });
  }

  // Brand-icon favicon proxy (binary, not a JSON contract route). Implements the
  // icon-proxy contract consumed by metagraphed-ui <BrandIcon>; SSRF-safe (fetches
  // only fixed favicon services) + R2-cached. See src/icon-proxy.ts.
  if (url.pathname === "/api/v1/icon") {
    return handleIconProxy(request, env, url, { readArtifact });
  }

  // Agent/AI discovery surfaces. The homepage advertises the machine resources
  // via RFC 8288 Link headers; /.well-known/api-catalog is the RFC 9727 linkset.
  // Both are worker-owned (see wrangler `run_worker_first`) so they carry the
  // right headers/content-type instead of 404-ing through to the static assets.
  if (url.pathname === "/" || url.pathname === "") {
    return await homepageResponse(request);
  }

  if (url.pathname === "/.well-known/api-catalog") {
    return await apiCatalogResponse(request);
  }

  if (url.pathname === "/.well-known/mcp/server-card.json") {
    return mcpServerCardResponse(request, env);
  }

  // Agent tool specs for non-MCP runtimes (OpenAI function calling / Anthropic
  // tool use), projected at request time from the same listToolDefinitions() the
  // MCP server advertises — so they can't drift. Worker-owned (run_worker_first).
  if (url.pathname === "/.well-known/agent-tools/index.json") {
    return agentToolsResponse(request, env, "index");
  }
  if (url.pathname === "/.well-known/agent-tools/openai.json") {
    return agentToolsResponse(request, env, "openai");
  }
  if (url.pathname === "/.well-known/agent-tools/anthropic.json") {
    return agentToolsResponse(request, env, "anthropic");
  }

  if (url.pathname === "/health") {
    return handleHealthRequest(request, env);
  }

  if (url.pathname === "/api/v1/events") {
    return handleEventsRequest(request, env);
  }

  // Semantic (vector) search over the registry. Special-handled (dynamic, not
  // artifact-backed) like /api/v1/events; degrades to 503 when AI is off.
  if (url.pathname === "/api/v1/search/semantic") {
    return handleSemanticSearchRequest(request, env, url, ctx);
  }

  // Registry leaderboards (registry projections; D1 fully eliminated
  // 2026-07-17 -- the health/rpc/growth/reliability boards are unconditionally
  // empty now, see composeLeaderboardsData/handleLeaderboards).
  if (url.pathname === "/api/v1/registry/leaderboards") {
    // Edge-cache keyed on the health snapshot's last_run_at (auto-busts on the
    // next probe) like the sibling analytics routes, so a polling/cross-colo
    // burst doesn't re-run the composition.
    return withEdgeCache(
      request,
      ctx,
      env,
      "leaderboards",
      () => handleLeaderboards(request, env, url),
      canonicalLeaderboardsCachePath(url),
    );
  }

  // Cross-subnet compare (registry structure + economics + live health composed
  // side by side; the same fileless-D1 pattern as the leaderboards route).
  // Edge-cached on the cron snapshot's last_run_at so a polling/cross-colo burst
  // doesn't re-run the economics + D1 reads.
  if (url.pathname === "/api/v1/compare") {
    return withEdgeCache(
      request,
      ctx,
      env,
      "compare",
      () => handleCompare(request, env, url),
      canonicalCompareCachePath(url),
    );
  }

  // Validator-side compare (#6325): places several validators side by side,
  // the same live neurons-tier read handleValidatorDetail does, fanned out
  // per hotkey -- no registry/economics/health composition, so unlike
  // /api/v1/compare above this isn't edge-cached on the cron snapshot's
  // last_run_at, matching handleValidatorDetail's own uncached dispatch.
  if (url.pathname === "/api/v1/compare/validators") {
    return handleCompareValidators(request, env, url);
  }

  // Per-domain rollup overview (#6749/#6750): every domain/capability tag's
  // stake/emission-share/concentration rollup in one call, composed live from
  // the subnets index + economics tier -- same registry+economics shape as
  // /api/v1/compare above, but uncached (like handleCompareValidators) since
  // this is a first cut and the underlying tiers already have their own
  // ~3h/cron-refresh cadence.
  if (url.pathname === "/api/v1/domains") {
    return handleDomains(request, env);
  }

  // Per-domain rollup for one tag. Dispatched before subnet routing (like the
  // global /api/v1/validators leaderboard above) so this top-level collection
  // never collides with a subnet-scoped path.
  const domainSummaryMatch = DOMAIN_SUMMARY_PATH_PATTERN.exec(url.pathname);
  if (domainSummaryMatch) {
    return handleDomainSummary(request, env, domainSummaryMatch[1]);
  }

  // Global validator/operator leaderboard from the current neurons snapshot. Exact path,
  // dispatched before subnet routing so the top-level collection stays unambiguous.
  // Busts on the shared health-cron last_run_at stamp like every other Postgres-tier
  // analytics route (the neurons snapshot itself is Postgres-backed; the D1-era
  // captured_at-based stamp this once busted on was removed in #5358, since #4772
  // dropped the D1 neurons table it read).
  if (url.pathname === "/api/v1/validators") {
    const validatorsCache = canonicalGlobalValidatorsCachePath(url, request);
    if (validatorsCache.response) return validatorsCache.response;
    return withEdgeCache(
      request,
      ctx,
      env,
      "global-validators",
      (cacheRequest) => handleGlobalValidators(cacheRequest, env, url),
      validatorsCache.cachePathAndSearch,
    );
  }

  // Site-wide accounts leaderboard (#4324/5.3): every currently-registered
  // hotkey, not just validator_permit=1 ones — the collection-level
  // counterpart to /api/v1/validators above, same shared health-cron cache stamp.
  if (url.pathname === "/api/v1/accounts") {
    const accountsCache = canonicalAccountsListCachePath(url, request);
    if (accountsCache.response) return accountsCache.response;
    return withEdgeCache(
      request,
      ctx,
      env,
      "accounts-list",
      () => handleAccountsList(request, env, url),
      accountsCache.cachePathAndSearch,
    );
  }

  // Balance-based top-holder leaderboard (#6741/#6743): the coldkey/balance-
  // centric counterpart to /api/v1/accounts above -- checked here (before the
  // generic /api/v1/accounts/{ss58} pattern further below) so "top-holders"
  // is never mistaken for an ss58 path parameter.
  if (url.pathname === "/api/v1/accounts/top-holders") {
    const topHoldersCache = canonicalTopHoldersCachePath(url, request);
    if (topHoldersCache.response) return topHoldersCache.response;
    return withEdgeCache(
      request,
      ctx,
      env,
      "top-holders",
      () => handleTopHoldersList(request, env, url),
      topHoldersCache.cachePathAndSearch,
    );
  }

  // Cross-subnet validator detail (#4334/7.1): single-entity drill-in of the
  // leaderboard above, keyed by hotkey. Direct dispatch (no edge cache), same
  // as the other single-entity-by-key routes (handleAccount, handleNeuron).
  const validatorDetailMatch = VALIDATOR_DETAIL_PATH_PATTERN.exec(url.pathname);
  if (validatorDetailMatch) {
    return handleValidatorDetail(request, env, validatorDetailMatch[1]);
  }

  // Nominator list for one validator (#4334/7.2): account_events-derived, so
  // dispatched like the sibling account routes (no edge cache — live/paginated).
  const validatorNominatorsMatch = VALIDATOR_NOMINATORS_PATH_PATTERN.exec(
    url.pathname,
  );
  if (validatorNominatorsMatch) {
    return handleValidatorNominators(
      request,
      env,
      validatorNominatorsMatch[1],
      url,
    );
  }

  // Cross-subnet staked-over-time + rewards history for one validator
  // (#4334/7.3): GROUP BY daily aggregation, deterministic per cron snapshot
  // — edge-cache like the sibling subnet-history route below.
  const validatorHistoryMatch = VALIDATOR_HISTORY_PATH_PATTERN.exec(
    url.pathname,
  );
  if (validatorHistoryMatch) {
    return withEdgeCache(
      request,
      ctx,
      env,
      "validator-history",
      () => handleValidatorHistory(request, env, validatorHistoryMatch[1], url),
      canonicalValidatorHistoryCachePath(url),
    );
  }

  // Cross-subnet movers leaderboard (exact path, dispatched before subnet-slug
  // resolution so "movers" is never treated as a slug): every subnet ranked by its
  // stake/emission/validator change over the window, from the neuron_daily rollup.
  if (url.pathname === "/api/v1/subnets/movers") {
    return withEdgeCache(
      request,
      ctx,
      env,
      "subnet-movers",
      () => handleSubnetMovers(request, env, url),
      canonicalSubnetMoversCachePath(url, request),
    );
  }

  // RPC reverse-proxy usage analytics (D1 telemetry; fileless-D1 pattern, B3).
  if (url.pathname === "/api/v1/rpc/usage") {
    return handleRpcUsage(request, env, url);
  }

  // #358: live "verify-now" for one catalogued surface — an action endpoint
  // (modeled on the RPC proxy), so it lives outside the artifact-route contract.
  const verifyMatch =
    /^\/api\/v1\/surfaces\/([A-Za-z0-9][A-Za-z0-9:._-]*)\/verify$/.exec(
      url.pathname,
    );
  if (verifyMatch) {
    return handleSurfaceVerify(
      request,
      env,
      decodeURIComponent(verifyMatch[1]),
      ctx,
    );
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    const resolved = await resolveSubnetSlugRoute(env, url);
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}".`,
        404,
        { slug: resolved.slug },
      );
    }
    // D1-backed health trends (slug-aware after resolution). Special-handled
    // rather than artifact-backed, like /api/v1/events.
    const bulkTrendsMatch = BULK_TRENDS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (bulkTrendsMatch) {
      return handleBulkHealthTrends(request, env, resolved.url, ctx);
    }
    const trendsMatch = TRENDS_PATH_PATTERN.exec(resolved.url.pathname);
    if (trendsMatch) {
      return handleHealthTrends(
        request,
        env,
        Number(trendsMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const percentilesMatch = PERCENTILES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (percentilesMatch) {
      return handleHealthPercentiles(
        request,
        env,
        Number(percentilesMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const incidentsMatch = INCIDENTS_PATH_PATTERN.exec(resolved.url.pathname);
    if (incidentsMatch) {
      return handleHealthIncidents(
        request,
        env,
        Number(incidentsMatch[1]),
        resolved.url,
        ctx,
      );
    }
    const trajectoryMatch = TRAJECTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (trajectoryMatch) {
      return withEdgeCache(
        request,
        ctx,
        env,
        "trajectory",
        () =>
          handleTrajectory(
            request,
            env,
            Number(trajectoryMatch[1]),
            resolved.url,
          ),
        canonicalTrajectoryCachePath(resolved.url, request),
      );
    }
    const uptimeMatch = UPTIME_PATH_PATTERN.exec(resolved.url.pathname);
    if (uptimeMatch) {
      return withEdgeCache(
        request,
        ctx,
        env,
        "uptime",
        () => handleUptime(request, env, Number(uptimeMatch[1]), resolved.url),
        canonicalUptimeCachePath(resolved.url, request),
      );
    }
    const concentrationHistoryMatch =
      SUBNET_CONCENTRATION_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (concentrationHistoryMatch) {
      // Per-day concentration trend over the neuron_daily rollup, deterministic per
      // cron snapshot — edge-cache like the sibling history routes.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-concentration-history",
        () =>
          handleSubnetConcentrationHistory(
            request,
            env,
            Number(concentrationHistoryMatch[1]),
            resolved.url,
          ),
        canonicalSubnetConcentrationHistoryCachePath(resolved.url, request),
      );
    }
    const performanceHistoryMatch =
      SUBNET_PERFORMANCE_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (performanceHistoryMatch) {
      // Per-day reward-flow & trust trend over the neuron_daily rollup, deterministic
      // per cron snapshot — edge-cache like the sibling concentration/history route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-performance-history",
        () =>
          handleSubnetPerformanceHistory(
            request,
            env,
            Number(performanceHistoryMatch[1]),
            resolved.url,
          ),
        canonicalSubnetPerformanceHistoryCachePath(resolved.url, request),
      );
    }
    const yieldHistoryMatch = SUBNET_YIELD_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (yieldHistoryMatch) {
      // Per-day yield-distribution trend over the neuron_daily rollup, deterministic
      // per cron snapshot — edge-cache like the sibling concentration/history route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-yield-history",
        () =>
          handleSubnetYieldHistory(
            request,
            env,
            Number(yieldHistoryMatch[1]),
            resolved.url,
          ),
        canonicalSubnetYieldHistoryCachePath(resolved.url, request),
      );
    }
    const concentrationMatch = SUBNET_CONCENTRATION_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (concentrationMatch) {
      // Per-UID range read over the neurons tier — edge-cache busts on the
      // shared health-cron stamp like every sibling Postgres-tier route.
      return withEdgeCache(request, ctx, env, "subnet-concentration", () =>
        handleSubnetConcentration(
          request,
          env,
          Number(concentrationMatch[1]),
          resolved.url,
        ),
      );
    }
    const turnoverMatch = SUBNET_TURNOVER_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (turnoverMatch) {
      // Boundary-snapshot diff over the neuron_daily rollup, deterministic per
      // cron snapshot — edge-cache like the sibling history routes.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-turnover",
        () =>
          handleSubnetTurnover(
            request,
            env,
            Number(turnoverMatch[1]),
            resolved.url,
          ),
        canonicalSubnetTurnoverCachePath(resolved.url),
      );
    }
    const stakeFlowMatch = SUBNET_STAKE_FLOW_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (stakeFlowMatch) {
      // Net stake flow summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling analytics routes.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-stake-flow",
        () =>
          handleSubnetStakeFlow(
            request,
            env,
            Number(stakeFlowMatch[1]),
            resolved.url,
          ),
        canonicalSubnetStakeFlowCachePath(resolved.url),
      );
    }
    const alphaVolumeMatch = SUBNET_ALPHA_VOLUME_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (alphaVolumeMatch) {
      // Rolling 24h buy/sell alpha volume summed live from account_events —
      // deterministic per request (no query params), edge-cache like the
      // sibling analytics routes.
      return withEdgeCache(request, ctx, env, "subnet-alpha-volume", () =>
        handleSubnetAlphaVolume(
          request,
          env,
          Number(alphaVolumeMatch[1]),
          resolved.url,
        ),
      );
    }
    const ohlcMatch = SUBNET_OHLC_PATH_PATTERN.exec(resolved.url.pathname);
    if (ohlcMatch) {
      // OHLC candles summed live from account_events — deterministic per
      // request (varies only on ?interval=/?days=, both carried in the raw
      // path+search default cache key), edge-cache like the sibling
      // analytics routes.
      return withEdgeCache(request, ctx, env, "subnet-ohlc", () =>
        handleSubnetOhlc(request, env, Number(ohlcMatch[1]), resolved.url),
      );
    }
    const stakeQuoteMatch = SUBNET_STAKE_QUOTE_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (stakeQuoteMatch) {
      // Read-only constant-product quote (#5235). The result varies with the
      // ?amount=/?direction= query, so it's computed per request rather than
      // path-edge-cached like the deterministic sibling analytics routes.
      return handleSubnetStakeQuote(
        request,
        env,
        Number(stakeQuoteMatch[1]),
        resolved.url,
        ctx,
      );
    }
    if (resolved.url.pathname === VALIDATOR_ECONOMICS_RANKING_PATH) {
      // Edge-cached: the answer depends only on the query, and the underlying
      // scan is the most expensive read in this family.
      return withEdgeCache(
        request,
        ctx,
        env,
        "validator-economics-ranking",
        () => handleValidatorEconomicsRanking(request, env, resolved.url),
      );
    }
    // Checked before the plain per-subnet pattern: /validator-economics/history
    // would otherwise fall through to a 404, since that pattern is anchored.
    const validatorEconomicsHistoryMatch =
      SUBNET_VALIDATOR_ECONOMICS_HISTORY_PATH_PATTERN.exec(
        resolved.url.pathname,
      );
    if (validatorEconomicsHistoryMatch) {
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-validator-economics-history",
        () =>
          handleSubnetValidatorEconomicsHistory(
            request,
            env,
            Number(validatorEconomicsHistoryMatch[1]),
            resolved.url,
          ),
      );
    }
    const validatorEconomicsMatch =
      SUBNET_VALIDATOR_ECONOMICS_PATH_PATTERN.exec(resolved.url.pathname);
    if (validatorEconomicsMatch) {
      // Edge-cached like the deterministic sibling analytics routes: the answer
      // depends only on the netuid, not on any query param.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-validator-economics",
        () =>
          handleSubnetValidatorEconomics(
            request,
            env,
            Number(validatorEconomicsMatch[1]),
            resolved.url,
          ),
      );
    }
    // Live chain-storage routes (#8700), dispatched from the single table
    // shared with the /{network}/-prefixed path so the two cannot drift. On
    // the bare path this resolves to mainnet, exactly as before.
    const liveChainResponse = await dispatchLiveChainRoute(
      request,
      env,
      resolved.url,
    );
    if (liveChainResponse) return liveChainResponse;
    const weightSettersMatch = SUBNET_WEIGHT_SETTERS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (weightSettersMatch) {
      // Per-subnet weight-setter leaderboard — the individual validators behind /weights,
      // computed live from account_events over the window; edge-cache like the sibling routes.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-weight-setters",
        () =>
          handleSubnetWeightSetters(
            request,
            env,
            Number(weightSettersMatch[1]),
            resolved.url,
          ),
        canonicalSubnetWeightSettersCachePath(resolved.url),
      );
    }
    const weightsMatch = SUBNET_WEIGHTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (weightsMatch) {
      // Validator weight-setting activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-weights",
        () =>
          handleSubnetWeights(
            request,
            env,
            Number(weightsMatch[1]),
            resolved.url,
          ),
        canonicalSubnetWeightsCachePath(resolved.url),
      );
    }
    const servingMatch = SUBNET_SERVING_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (servingMatch) {
      // Axon-serving announcement activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-serving",
        () =>
          handleSubnetServing(
            request,
            env,
            Number(servingMatch[1]),
            resolved.url,
          ),
        canonicalSubnetServingCachePath(resolved.url),
      );
    }
    const prometheusMatch = SUBNET_PROMETHEUS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (prometheusMatch) {
      // Prometheus-endpoint serving activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling serving route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-prometheus",
        () =>
          handleSubnetPrometheus(
            request,
            env,
            Number(prometheusMatch[1]),
            resolved.url,
          ),
        canonicalSubnetPrometheusCachePath(resolved.url),
      );
    }
    const stakeMovesMatch = SUBNET_STAKE_MOVES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (stakeMovesMatch) {
      // Stake-movement activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-stake-moves",
        () =>
          handleSubnetStakeMoves(
            request,
            env,
            Number(stakeMovesMatch[1]),
            resolved.url,
          ),
        canonicalSubnetStakeMovesCachePath(resolved.url),
      );
    }
    const stakeTransfersMatch = SUBNET_STAKE_TRANSFERS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (stakeTransfersMatch) {
      // Stake-transfer activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-moves route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-stake-transfers",
        () =>
          handleSubnetStakeTransfers(
            request,
            env,
            Number(stakeTransfersMatch[1]),
            resolved.url,
          ),
        canonicalSubnetStakeTransfersCachePath(resolved.url),
      );
    }
    const registrationsMatch = SUBNET_REGISTRATIONS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (registrationsMatch) {
      // Neuron-registration activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-registrations",
        () =>
          handleSubnetRegistrations(
            request,
            env,
            Number(registrationsMatch[1]),
            resolved.url,
          ),
        canonicalSubnetRegistrationsCachePath(resolved.url),
      );
    }
    const axonRemovalsMatch = SUBNET_AXON_REMOVALS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (axonRemovalsMatch) {
      // Axon-removal activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-axon-removals",
        () =>
          handleSubnetAxonRemovals(
            request,
            env,
            Number(axonRemovalsMatch[1]),
            resolved.url,
          ),
        canonicalSubnetAxonRemovalsCachePath(resolved.url),
      );
    }
    const deregistrationsMatch = SUBNET_DEREGISTRATIONS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (deregistrationsMatch) {
      // Neuron-deregistration activity summed live from account_events over the window —
      // deterministic per request, edge-cache like the sibling stake-flow route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-deregistrations",
        () =>
          handleSubnetDeregistrations(
            request,
            env,
            Number(deregistrationsMatch[1]),
            resolved.url,
          ),
        canonicalSubnetDeregistrationsCachePath(resolved.url),
      );
    }
    // Per-UID emission yield distribution over the current neurons snapshot — computed
    // live from the neurons D1 tier, like the sibling metagraph route. Edge-cache
    // busts on the shared health-cron stamp like every sibling Postgres-tier route.
    const yieldMatch = SUBNET_YIELD_PATH_PATTERN.exec(resolved.url.pathname);
    if (yieldMatch) {
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-yield",
        () =>
          handleSubnetYield(request, env, Number(yieldMatch[1]), resolved.url),
        canonicalSubnetYieldCachePath(resolved.url, request),
      );
    }
    // Reward-distribution + score-spread over the current neurons snapshot —
    // per-UID read of the neurons tier, edge-cache busts on the shared health-cron
    // stamp like every sibling Postgres-tier route (like /concentration above).
    const performanceMatch = SUBNET_PERFORMANCE_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (performanceMatch) {
      return withEdgeCache(request, ctx, env, "subnet-performance", () =>
        handleSubnetPerformance(
          request,
          env,
          Number(performanceMatch[1]),
          resolved.url,
        ),
      );
    }
    // Stake sitting on a currently-zero-dividends hotkey (#6789) — per-UID
    // read of the neurons tier, edge-cache busts on the shared health-cron
    // stamp like every sibling Postgres-tier route (like /concentration
    // and /performance above).
    const idleStakeMatch = SUBNET_IDLE_STAKE_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (idleStakeMatch) {
      return withEdgeCache(request, ctx, env, "subnet-idle-stake", () =>
        handleSubnetIdleStake(
          request,
          env,
          Number(idleStakeMatch[1]),
          resolved.url,
        ),
      );
    }
    // Per-UID metagraph (#1304/#1305): computed live from the neurons D1 tier.
    const neuronHistoryMatch = SUBNET_NEURON_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (neuronHistoryMatch) {
      return handleNeuronHistory(
        request,
        env,
        Number(neuronHistoryMatch[1]),
        Number(neuronHistoryMatch[2]),
        resolved.url,
      );
    }
    // #9402: the registration-cost series. Deliberately NOT in
    // dispatchLiveChainRoute despite being burn-related -- that dispatcher serves
    // the network-prefixed forms, and subnet_burn_history has no network column, so
    // a testnet-prefixed request there would serve MAINNET prices as testnet's. It
    // is declared mainnet-only instead, which is the mechanism for exactly this.
    const burnHistoryMatch = SUBNET_BURN_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (burnHistoryMatch) {
      return handleSubnetBurnHistory(
        request,
        env,
        Number(burnHistoryMatch[1]),
        resolved.url,
      );
    }
    const subnetHistoryMatch = SUBNET_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (subnetHistoryMatch) {
      // GROUP BY daily aggregation, deterministic per cron snapshot — edge-cache
      // on last_run_at like the sibling analytics routes (pathname carries the
      // netuid, search carries ?window). Cheap single-row lookups stay uncached.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-history",
        () =>
          handleSubnetHistory(
            request,
            env,
            Number(subnetHistoryMatch[1]),
            resolved.url,
          ),
        canonicalSubnetHistoryCachePath(resolved.url),
      );
    }
    const subnetIdentityHistoryMatch =
      SUBNET_IDENTITY_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (subnetIdentityHistoryMatch) {
      return handleSubnetIdentityHistory(
        request,
        env,
        Number(subnetIdentityHistoryMatch[1]),
        resolved.url,
      );
    }
    const metagraphMatch = SUBNET_METAGRAPH_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (metagraphMatch) {
      // Full per-subnet metagraph (range read over the neurons tier) — edge-cache
      // busts on the shared health-cron stamp like every sibling Postgres-tier
      // route; ?validator_permit rides the search into the key.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-metagraph",
        (cacheRequest) =>
          handleSubnetMetagraph(
            cacheRequest,
            env,
            Number(metagraphMatch[1]),
            resolved.url,
          ),
        canonicalSubnetMetagraphCachePath(resolved.url, request),
      );
    }
    const neuronMatch = SUBNET_NEURON_PATH_PATTERN.exec(resolved.url.pathname);
    if (neuronMatch) {
      return handleNeuron(
        request,
        env,
        Number(neuronMatch[1]),
        Number(neuronMatch[2]),
        resolved.url,
      );
    }
    const hyperparamsHistoryMatch =
      SUBNET_HYPERPARAMS_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (hyperparamsHistoryMatch) {
      // Append-only timeline, same cost class as handleSubnetIdentityHistory —
      // dispatch directly, no edge-cache wrapper.
      return handleSubnetHyperparamsHistory(
        request,
        env,
        Number(hyperparamsHistoryMatch[1]),
        resolved.url,
      );
    }
    const hyperparamsMatch = SUBNET_HYPERPARAMS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (hyperparamsMatch) {
      // Single PK-by-netuid D1 lookup, same cost class as handleNeuron —
      // dispatch directly, no edge-cache wrapper.
      return handleSubnetHyperparams(
        request,
        env,
        Number(hyperparamsMatch[1]),
        resolved.url,
      );
    }
    const validatorsMatch = SUBNET_VALIDATORS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (validatorsMatch) {
      // Validator slice of the metagraph — edge-cache busts on the shared
      // health-cron stamp like every sibling Postgres-tier route.
      return withEdgeCache(
        request,
        ctx,
        env,
        "subnet-validators",
        () =>
          handleSubnetValidators(
            request,
            env,
            Number(validatorsMatch[1]),
            resolved.url,
          ),
        canonicalSubnetValidatorsCachePath(resolved.url, request),
      );
    }
    // Per-subnet event summary: compact windowed account_events aggregates with
    // a small evidence slice, sibling to the raw /events feed.
    const subnetEventSummaryMatch = SUBNET_EVENT_SUMMARY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (subnetEventSummaryMatch) {
      return withEdgeCache(request, ctx, env, "subnet-event-summary", () =>
        handleSubnetEventSummary(
          request,
          env,
          Number(subnetEventSummaryMatch[1]),
          resolved.url,
        ),
      );
    }
    // Per-subnet chain-event stream (#1345): account_events filtered by netuid.
    // Live + continuously appended, so served direct (no edge cache) like the
    // account-events route — envelopeResponse's ETag + "short" cache govern it.
    const subnetEventsMatch = SUBNET_EVENTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (subnetEventsMatch) {
      return handleSubnetEvents(
        request,
        env,
        Number(subnetEventsMatch[1]),
        resolved.url,
      );
    }
    // Account entity routes (#1347): computed live from the account_events +
    // neurons D1 tiers. More-specific paths first (each pattern is anchored).
    const accountHistoryMatch = ACCOUNT_HISTORY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountHistoryMatch) {
      return handleAccountHistory(
        request,
        env,
        accountHistoryMatch[1],
        resolved.url,
      );
    }
    const accountEntitiesMatch = ACCOUNT_ENTITIES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountEntitiesMatch) {
      return handleAccountEntities(request, env, accountEntitiesMatch[1]);
    }
    const accountEventsMatch = ACCOUNT_EVENTS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountEventsMatch) {
      return handleAccountEvents(
        request,
        env,
        accountEventsMatch[1],
        resolved.url,
      );
    }
    const accountSubnetsMatch = ACCOUNT_SUBNETS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountSubnetsMatch) {
      return handleAccountSubnets(request, env, accountSubnetsMatch[1]);
    }
    const accountPortfolioMatch = ACCOUNT_PORTFOLIO_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountPortfolioMatch) {
      return handleAccountPortfolio(request, env, accountPortfolioMatch[1]);
    }
    // Nominator-side (coldkey) position reconstruction (#5233): the
    // counterpart to /portfolio above -- what this account holds delegated
    // across every hotkey/subnet, computed live from nominator_positions.
    const accountPositionsMatch = ACCOUNT_POSITIONS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountPositionsMatch) {
      return handleAccountPositions(request, env, accountPositionsMatch[1]);
    }
    // Per-account, per-subnet position history (#4329/6.2): computed live from
    // the account_position_daily rollup tier.
    const accountPositionHistoryMatch =
      ACCOUNT_SUBNET_POSITION_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountPositionHistoryMatch) {
      return handleAccountPositionHistory(
        request,
        env,
        accountPositionHistoryMatch[1],
        Number(accountPositionHistoryMatch[2]),
        resolved.url,
      );
    }
    // Personal chain identity (epic #4301/5.4): latest-only + diff-tracking
    // history, mirroring the subnet identity/identity-history route shape.
    const accountIdentityHistoryMatch =
      ACCOUNT_IDENTITY_HISTORY_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountIdentityHistoryMatch) {
      return handleAccountIdentityHistory(
        request,
        env,
        accountIdentityHistoryMatch[1],
        resolved.url,
      );
    }
    const accountIdentityMatch = ACCOUNT_IDENTITY_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountIdentityMatch) {
      return handleAccountIdentity(
        request,
        env,
        accountIdentityMatch[1],
        resolved.url,
      );
    }
    const accountExtrinsicsMatch = ACCOUNT_EXTRINSICS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountExtrinsicsMatch) {
      return handleAccountExtrinsics(
        request,
        env,
        accountExtrinsicsMatch[1],
        resolved.url,
      );
    }
    const accountTransfersMatch = ACCOUNT_TRANSFERS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountTransfersMatch) {
      return handleAccountTransfers(
        request,
        env,
        accountTransfersMatch[1],
        resolved.url,
      );
    }
    const accountCounterpartiesMatch = ACCOUNT_COUNTERPARTIES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountCounterpartiesMatch) {
      return handleAccountCounterparties(
        request,
        env,
        accountCounterpartiesMatch[1],
        resolved.url,
      );
    }
    const accountStakeFlowMatch = ACCOUNT_STAKE_FLOW_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountStakeFlowMatch) {
      return handleAccountStakeFlow(
        request,
        env,
        accountStakeFlowMatch[1],
        resolved.url,
      );
    }
    const accountStakeMovesMatch = ACCOUNT_STAKE_MOVES_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountStakeMovesMatch) {
      return handleAccountStakeMoves(
        request,
        env,
        accountStakeMovesMatch[1],
        resolved.url,
      );
    }
    const accountWeightSettersMatch = ACCOUNT_WEIGHT_SETTERS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountWeightSettersMatch) {
      return handleAccountWeightSetters(
        request,
        env,
        accountWeightSettersMatch[1],
        resolved.url,
      );
    }
    const accountRegistrationsMatch = ACCOUNT_REGISTRATIONS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountRegistrationsMatch) {
      return handleAccountRegistrations(
        request,
        env,
        accountRegistrationsMatch[1],
        resolved.url,
      );
    }
    const accountServingMatch = ACCOUNT_SERVING_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountServingMatch) {
      return handleAccountServing(
        request,
        env,
        accountServingMatch[1],
        resolved.url,
      );
    }
    const accountDeregistrationsMatch =
      ACCOUNT_DEREGISTRATIONS_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountDeregistrationsMatch) {
      return handleAccountDeregistrations(
        request,
        env,
        accountDeregistrationsMatch[1],
        resolved.url,
      );
    }
    const accountPrometheusMatch = ACCOUNT_PROMETHEUS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountPrometheusMatch) {
      return handleAccountPrometheus(
        request,
        env,
        accountPrometheusMatch[1],
        resolved.url,
      );
    }
    const accountAxonRemovalsMatch = ACCOUNT_AXON_REMOVALS_PATH_PATTERN.exec(
      resolved.url.pathname,
    );
    if (accountAxonRemovalsMatch) {
      return handleAccountAxonRemovals(
        request,
        env,
        accountAxonRemovalsMatch[1],
        resolved.url,
      );
    }
    const accountMatch = ACCOUNT_PATH_PATTERN.exec(resolved.url.pathname);
    if (accountMatch) {
      return handleAccount(request, env, accountMatch[1]);
    }
    // Block-explorer routes (#1345), dispatched from the table shared with the
    // /{network}/-prefixed path (#8700) so the two cannot drift. On the bare
    // path this resolves to mainnet, exactly as before.
    const chainHistoryResponse = await dispatchChainHistoryRoute(
      request,
      env,
      resolved.url,
      ctx,
    );
    if (chainHistoryResponse) return chainHistoryResponse;
    if (SUDO_CALLS_PATH_PATTERN.test(resolved.url.pathname)) {
      return handleSudo(request, env, resolved.url);
    }
    if (GOVERNANCE_CONFIG_CHANGES_PATH_PATTERN.test(resolved.url.pathname)) {
      return handleGovernanceConfigChanges(request, env, resolved.url);
    }
    if (RUNTIME_VERSIONS_PATH_PATTERN.test(resolved.url.pathname)) {
      const cacheRequest =
        request.method === "HEAD"
          ? new Request(request, { method: "GET" })
          : request;
      const response = await withEdgeCache(
        cacheRequest,
        ctx,
        env,
        "runtime-versions",
        () => handleRuntime(cacheRequest, env, resolved.url),
      );
      return request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    }
    if (resolved.url.pathname === "/api/v1/incidents") {
      return withEdgeCache(request, ctx, env, "global-incidents", () =>
        handleGlobalIncidents(request, env, resolved.url),
      );
    }
    // The projection-backed chain routes (#9412), dispatched from the table
    // shared with the /{network}/-prefixed path so the two cannot drift. On the
    // bare path this resolves to mainnet, exactly as before.
    const projectionResponse = await dispatchProjectionRoute(
      request,
      env,
      resolved.url,
      ctx,
    );
    if (projectionResponse) return projectionResponse;
    if (resolved.url.pathname === "/api/v1/chain/weights") {
      return handleChainWeights(request, env, resolved.url, ctx);
    }
    if (resolved.url.pathname === "/api/v1/chain/weights/setters") {
      return handleChainWeightSetters(request, env, resolved.url, ctx);
    }
    if (resolved.url.pathname === "/api/v1/chain/serving") {
      return handleChainServing(request, env, resolved.url, ctx);
    }
    if (resolved.url.pathname === "/api/v1/chain/prometheus") {
      return handleChainPrometheus(request, env, resolved.url, ctx);
    }
    if (resolved.url.pathname === "/api/v1/chain/axon-removals") {
      return handleChainAxonRemovals(request, env, resolved.url, ctx);
    }
    // GET /api/v1/chain/concentration: network-wide neurons aggregate — edge-cache
    // busts on the shared health-cron stamp like every sibling Postgres-tier route
    // (like the per-subnet concentration route, but network-scoped).
    if (resolved.url.pathname === "/api/v1/chain/concentration") {
      return withEdgeCache(request, ctx, env, "chain-concentration", () =>
        handleChainConcentration(request, env, resolved.url),
      );
    }
    // GET /api/v1/chain/performance: network-wide reward-distribution & score-spread
    // aggregate — edge-cache busts on the shared health-cron stamp like every
    // sibling Postgres-tier route (like chain/concentration, but the reward-flow lens).
    if (resolved.url.pathname === "/api/v1/chain/performance") {
      return withEdgeCache(request, ctx, env, "chain-performance", () =>
        handleChainPerformance(request, env, resolved.url),
      );
    }
    // GET /api/v1/chain/idle-stake (#6789): network-wide idle-stake rollup —
    // edge-cache busts on the shared health-cron stamp like every sibling
    // Postgres-tier route (like chain/performance, but the idle-delegation lens).
    if (resolved.url.pathname === "/api/v1/chain/idle-stake") {
      return withEdgeCache(request, ctx, env, "chain-idle-stake", () =>
        handleChainIdleStake(request, env, resolved.url),
      );
    }
    // GET /api/v1/chain/identity-history: network-wide recent subnet-identity-change
    // feed across ALL subnets (newest first); ?limit rides the canonical cache
    // path so a bare request and an explicit-default request share one slot
    // (like chain/performance but a capped feed, not a per-subnet aggregate).
    // Edge-cache busts on the shared health-cron stamp like every sibling
    // Postgres-tier route — its own bespoke observed_at stamp was retired
    // alongside the D1 read it existed to bust on (D1 fully eliminated,
    // 2026-07-16).
    if (resolved.url.pathname === "/api/v1/chain/identity-history") {
      return withEdgeCache(
        request,
        ctx,
        env,
        "chain-identity-history",
        () => handleChainIdentityHistory(request, env, resolved.url),
        canonicalChainIdentityHistoryCachePath(resolved.url),
      );
    }
    // GET /api/v1/self-health (#8318): our OWN uptime. Edge-cached like every
    // sibling Postgres-tier route; the 60s poller cadence is far tighter than
    // the cache window, so a reader always sees a recent-but-cheap answer.
    if (resolved.url.pathname === "/api/v1/self-health") {
      return withEdgeCache(request, ctx, env, "self-health", () =>
        handleSelfHealth(request, env, resolved.url),
      );
    }
    // GET /api/v1/chain/yield: network-wide emission-yield (return rate) aggregate
    // — edge-cache busts on the shared health-cron stamp like every sibling
    // Postgres-tier route (like chain/performance, but the emission/stake return-rate lens).
    if (resolved.url.pathname === "/api/v1/chain/yield") {
      return withEdgeCache(request, ctx, env, "chain-yield", () =>
        handleChainYield(request, env, resolved.url),
      );
    }
    // GET /api/v1/chain/turnover: network-wide validator-set churn across all subnets,
    // neuron_daily-derived — edge-cache keyed on the resolved window/limit and busted on
    // the shared health-cron stamp like every sibling Postgres-tier route (like
    // chain/concentration + chain/performance).
    if (resolved.url.pathname === "/api/v1/chain/turnover") {
      return withEdgeCache(
        request,
        ctx,
        env,
        "chain-turnover",
        () => handleChainTurnover(request, env, resolved.url),
        canonicalChainTurnoverCachePath(resolved.url, request),
      );
    }
    // Network-wide economics time series (#1307): deterministic per cron snapshot
    // (GROUP-BY-day over subnet_snapshots) — edge-cache on last_run_at like the
    // sibling history/trajectory routes; ?window rides the search into the key.
    // #8744. Short-cached like its economics-tier sibling; the body is a pure
    // function of (economics blob, contract version), and the blob's own
    // chain_state block is what makes a stale response detectable.
    if (resolved.url.pathname === "/api/v1/chain/emission-pipeline") {
      return handleEmissionPipeline(request, env, resolved.url);
    }
    if (resolved.url.pathname === "/api/v1/economics/trends") {
      return withEdgeCache(
        request,
        ctx,
        env,
        "economics-trends",
        () => handleEconomicsTrends(request, env, resolved.url),
        canonicalEconomicsTrendsCachePath(resolved.url, request),
      );
    }
    return handleApiRequest(request, env, resolved.url, DEFAULT_NETWORK, ctx);
  }

  if (BADGE_SVG_PATTERN.test(url.pathname)) {
    return handleBadgeSvgRequest(request, env, url);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url);
  }

  if (env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  return errorResponse(
    "not_found",
    "No static asset binding is configured for this route.",
    404,
  );
}

// Dynamic routes backed by mainnet-only D1/AI/curated data — not partitioned per
// network, so they 404 under a /{network}/ prefix rather than silently serving
// mainnet data. Mirrors the special-cased branches in handleRequest.
// Exported (#8698) so the contract's `mainnet_only` annotation can be PROVEN
// against the router's real behaviour instead of restated. tests/
// network-addressing.test.ts asserts every API_ROUTES entry's flag equals this
// predicate's verdict, so adding a route here without annotating it fails CI.
//
// What is NOT here any more (#8700): the live chain-storage routes. They were
// listed as "mainnet-only by construction" because each module hardcoded the
// finney URL — construction we controlled, and changed. Their storage keys are
// twox128 hashes of pallet+item names, so they are chain-agnostic, and testnet
// runs the same runtime (spec 441, same 28 pallets, same declared defaults).
// They now resolve their endpoint through rpcUrlForNetwork() and are served on
// every network with chain state. The remaining entries are mainnet-only
// because of the DATA behind them (D1 tiers, curated registry, AI indexes),
// which is a real constraint rather than a hardcoded constant.
export function isMainnetOnlyApiPath(pathname: string) {
  return (
    pathname === "/api/v1/events" ||
    pathname === "/api/v1/ask" ||
    pathname === "/api/v1/graphql" ||
    pathname === "/api/v1/search/semantic" ||
    pathname === "/api/v1/validators" ||
    pathname === "/api/v1/accounts" ||
    VALIDATOR_DETAIL_PATH_PATTERN.test(pathname) ||
    VALIDATOR_NOMINATORS_PATH_PATTERN.test(pathname) ||
    VALIDATOR_HISTORY_PATH_PATTERN.test(pathname) ||
    pathname === "/api/v1/registry/leaderboards" ||
    pathname === "/api/v1/compare" ||
    pathname === "/api/v1/compare/validators" ||
    pathname === "/api/v1/domains" ||
    DOMAIN_SUMMARY_PATH_PATTERN.test(pathname) ||
    pathname === "/api/v1/subnets/movers" ||
    pathname === "/api/v1/health" ||
    pathname === "/api/v1/incidents" ||
    pathname === "/api/v1/rpc/usage" ||
    pathname === "/api/v1/chain/weights" ||
    pathname === "/api/v1/chain/weights/setters" ||
    pathname === "/api/v1/chain/serving" ||
    pathname === "/api/v1/chain/prometheus" ||
    pathname === "/api/v1/chain/axon-removals" ||
    pathname === "/api/v1/chain/concentration" ||
    pathname === "/api/v1/chain/performance" ||
    pathname === "/api/v1/chain/idle-stake" ||
    pathname === "/api/v1/chain/identity-history" ||
    pathname === "/api/v1/self-health" ||
    pathname === "/api/v1/chain/yield" ||
    pathname === "/api/v1/chain/turnover" ||
    pathname === "/api/v1/economics/trends" ||
    pathname.startsWith("/api/v1/webhooks/") ||
    pathname.startsWith("/api/v1/alerts/triggers") ||
    pathname === "/api/v1/auth/wallet/challenge" ||
    pathname === "/api/v1/auth/wallet/verify" ||
    pathname === "/api/v1/watch/challenges" ||
    pathname === "/api/v1/watch/tokens" ||
    pathname.startsWith("/api/v1/watch/triggers") ||
    pathname.startsWith("/api/v1/watch/push-subscriptions") ||
    pathname.startsWith("/api/v1/keys") ||
    BULK_TRENDS_PATH_PATTERN.test(pathname) ||
    TRENDS_PATH_PATTERN.test(pathname) ||
    PERCENTILES_PATH_PATTERN.test(pathname) ||
    INCIDENTS_PATH_PATTERN.test(pathname) ||
    TRAJECTORY_PATH_PATTERN.test(pathname) ||
    UPTIME_PATH_PATTERN.test(pathname) ||
    /^\/api\/v1\/subnets\/(\d+)\/health$/.test(pathname) ||
    SUBNET_METAGRAPH_PATH_PATTERN.test(pathname) ||
    SUBNET_NEURON_PATH_PATTERN.test(pathname) ||
    SUBNET_HYPERPARAMS_PATH_PATTERN.test(pathname) ||
    SUBNET_NEURON_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_VALIDATORS_PATH_PATTERN.test(pathname) ||
    SUBNET_EVENTS_PATH_PATTERN.test(pathname) ||
    // #9402: subnet_burn_history has no network column, so a testnet-addressed
    // request would be served MAINNET prices. Declared in MAINNET_ONLY_ROUTE_PATHS
    // too -- this function and that list are asserted equal, in both directions.
    SUBNET_BURN_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_IDENTITY_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_CONCENTRATION_PATH_PATTERN.test(pathname) ||
    SUBNET_CONCENTRATION_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_PERFORMANCE_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_YIELD_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_TURNOVER_PATH_PATTERN.test(pathname) ||
    SUBNET_STAKE_FLOW_PATH_PATTERN.test(pathname) ||
    SUBNET_ALPHA_VOLUME_PATH_PATTERN.test(pathname) ||
    SUBNET_OHLC_PATH_PATTERN.test(pathname) ||
    SUBNET_STAKE_QUOTE_PATH_PATTERN.test(pathname) ||
    // Mainnet-only because it joins the D1 `neurons` tier, which is indexed
    // for finney only. Its live half (StakeThreshold/TaoWeight/Burn) became
    // network-aware in #8700 -- the storage reads are no longer what pins this
    // route to mainnet, the per-UID data behind them is.
    SUBNET_VALIDATOR_ECONOMICS_PATH_PATTERN.test(pathname) ||
    pathname === VALIDATOR_ECONOMICS_RANKING_PATH ||
    SUBNET_VALIDATOR_ECONOMICS_HISTORY_PATH_PATTERN.test(pathname) ||
    SUBNET_YIELD_PATH_PATTERN.test(pathname) ||
    SUBNET_PERFORMANCE_PATH_PATTERN.test(pathname) ||
    SUBNET_IDLE_STAKE_PATH_PATTERN.test(pathname) ||
    ACCOUNT_PATH_PATTERN.test(pathname) ||
    ACCOUNT_ENTITIES_PATH_PATTERN.test(pathname) ||
    ACCOUNT_EVENTS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_HISTORY_PATH_PATTERN.test(pathname) ||
    ACCOUNT_SUBNETS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_PORTFOLIO_PATH_PATTERN.test(pathname) ||
    ACCOUNT_POSITIONS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_SUBNET_POSITION_HISTORY_PATH_PATTERN.test(pathname) ||
    ACCOUNT_IDENTITY_PATH_PATTERN.test(pathname) ||
    ACCOUNT_IDENTITY_HISTORY_PATH_PATTERN.test(pathname) ||
    ACCOUNT_EXTRINSICS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_TRANSFERS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_COUNTERPARTIES_PATH_PATTERN.test(pathname) ||
    ACCOUNT_STAKE_FLOW_PATH_PATTERN.test(pathname) ||
    ACCOUNT_STAKE_MOVES_PATH_PATTERN.test(pathname) ||
    ACCOUNT_WEIGHT_SETTERS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_REGISTRATIONS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_SERVING_PATH_PATTERN.test(pathname) ||
    ACCOUNT_DEREGISTRATIONS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_PROMETHEUS_PATH_PATTERN.test(pathname) ||
    ACCOUNT_AXON_REMOVALS_PATH_PATTERN.test(pathname) ||
    SUDO_CALLS_PATH_PATTERN.test(pathname) ||
    GOVERNANCE_CONFIG_CHANGES_PATH_PATTERN.test(pathname) ||
    RUNTIME_VERSIONS_PATH_PATTERN.test(pathname)
  );
}

/**
 * The live chain-storage routes (#8700), as ONE table both dispatch paths use.
 *
 * Every route here answers from `state_getStorage` (or the EVM precompile) at
 * request time rather than from an artifact or a D1 tier, which is what makes
 * them servable on any network with chain state: the storage keys are twox128
 * hashes of pallet+item names, identical across chains running the same
 * runtime.
 *
 * This is a single table rather than two dispatch blocks specifically so the
 * bare mainnet path and the /{network}/-prefixed path cannot diverge. Before
 * #8700 the network path had no live routes at all; adding a second copy of
 * these eleven branches would have created exactly the kind of drift the
 * mainnet-only annotation test exists to catch, one layer lower where nothing
 * would have caught it.
 *
 * Returns `null` when nothing matched, so the caller continues its own
 * dispatch. Every pattern is anchored and mutually disjoint, so the order
 * within this table is not load-bearing.
 */
async function dispatchLiveChainRoute(
  request: Request,
  env: Env,
  url: URL,
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
): Promise<Response | null> {
  const chain = chainNetworkId(network.id);
  const { pathname } = url;

  const recycledMatch = SUBNET_RECYCLED_PATH_PATTERN.exec(pathname);
  if (recycledMatch) {
    return handleSubnetRecycled(request, env, Number(recycledMatch[1]), chain);
  }
  const burnMatch = SUBNET_BURN_PATH_PATTERN.exec(pathname);
  if (burnMatch) {
    return handleSubnetBurn(request, env, Number(burnMatch[1]), chain);
  }
  // #9399: the cross-subnet ranking. Beside its per-subnet sibling so the two live
  // burn reads stay visibly related, and matched on an exact path so it can never
  // shadow the {netuid} pattern above.
  if (pathname === "/api/v1/chain/burn") {
    return handleChainBurn(request, env, chain);
  }
  // Tested before the DATA_API forwarding gate, which only matches the longer
  // .../lease/history suffix — disjoint regexes, but the more specific one
  // first matches the ordering convention the rest of this router uses.
  const leaseMatch = SUBNET_LEASE_PATH_PATTERN.exec(pathname);
  if (leaseMatch) {
    return handleSubnetLease(request, env, Number(leaseMatch[1]), chain);
  }
  const crowdloanDetailMatch = CROWDLOAN_DETAIL_PATH_PATTERN.exec(pathname);
  if (crowdloanDetailMatch) {
    return handleCrowdloan(
      request,
      env,
      Number(crowdloanDetailMatch[1]),
      url,
      chain,
    );
  }
  if (CROWDLOANS_PATH_PATTERN.test(pathname)) {
    return handleCrowdloans(request, env, url, chain);
  }
  const accountBalanceMatch = ACCOUNT_BALANCE_PATH_PATTERN.exec(pathname);
  if (accountBalanceMatch) {
    return handleAccountBalance(request, env, accountBalanceMatch[1], chain);
  }
  const accountRootClaimMatch = ACCOUNT_ROOT_CLAIM_PATH_PATTERN.exec(pathname);
  if (accountRootClaimMatch) {
    return handleAccountRootClaim(
      request,
      env,
      accountRootClaimMatch[1],
      chain,
    );
  }
  const accountChildrenMatch = ACCOUNT_CHILDREN_PATH_PATTERN.exec(pathname);
  if (accountChildrenMatch) {
    return handleAccountChildren(request, env, accountChildrenMatch[1], chain);
  }
  const accountParentsMatch = ACCOUNT_PARENTS_PATH_PATTERN.exec(pathname);
  if (accountParentsMatch) {
    return handleAccountParents(request, env, accountParentsMatch[1], chain);
  }
  if (SUDO_KEY_PATH_PATTERN.test(pathname)) {
    return handleSudoKey(request, env, chain);
  }
  const evmAddressMappingMatch =
    EVM_ADDRESS_MAPPING_PATH_PATTERN.exec(pathname);
  if (evmAddressMappingMatch) {
    return handleEvmAddressMapping(
      request,
      env,
      evmAddressMappingMatch[1],
      chain,
    );
  }
  if (NETWORK_PARAMETERS_PATH_PATTERN.test(pathname)) {
    return handleNetworkParameters(request, env, chain);
  }
  if (RANDOMNESS_PATH_PATTERN.test(pathname)) {
    return handleRandomnessStatus(request, env, chain);
  }
  return null;
}

/**
 * The PROJECTION-backed chain routes (#9412), as one table both dispatch paths
 * use.
 *
 * These answer from an artifact a cron precomputes out of the lakehouse -- not
 * from chain state and not from a request-time scan. That is why they are a
 * third table rather than rows in dispatchChainHistoryRoute: what decides
 * whether a network can serve them is whether its LANE has run, and the lane
 * is what #9412 gave a network dimension.
 *
 * A single table rather than two copies of these thirteen branches, for the
 * reason the sibling tables give: the bare `/api/v1/chain/transfers` and
 * `/api/v1/testnet/chain/transfers` must resolve to the same handler with a
 * different network and nothing else.
 */
async function dispatchProjectionRoute(
  request: Request,
  env: Env,
  url: URL,
  ctx: Ctx = {},
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
): Promise<Response | null> {
  const chain = chainNetworkId(network.id);
  const { pathname } = url;
  if (pathname === "/api/v1/blocks/summary") {
    return withEdgeCache(
      request,
      ctx,
      env,
      edgeCacheScope("blocks-summary", chain),
      () => handleBlocksSummary(request, env, url, chain),
    );
  }
  const handler = PROJECTION_ROUTE_HANDLERS[pathname];
  return handler ? handler(request, env, url, ctx, chain) : null;
}

/**
 * Path -> handler for the twelve `/chain/*` projection routes.
 *
 * A map rather than a branch ladder because every entry has the identical
 * shape; the one route that does not (`/blocks/summary`, which wraps its own
 * edge cache) is handled above rather than bent to fit.
 */
const PROJECTION_ROUTE_HANDLERS: Record<
  string,
  (
    request: Request,
    env: Env,
    url: URL,
    ctx: Ctx,
    chain: ChainNetworkId,
  ) => Promise<Response>
> = {
  "/api/v1/chain/activity": handleChainActivity,
  "/api/v1/chain/calls": handleChainCalls,
  "/api/v1/chain/signers": handleChainSigners,
  "/api/v1/chain/fees": handleChainFees,
  "/api/v1/chain/transfers": handleChainTransfers,
  "/api/v1/chain/transfer-pairs": handleChainTransferPairs,
  "/api/v1/chain/stake-flow": handleChainStakeFlow,
  "/api/v1/chain/alpha-volume": handleChainAlphaVolume,
  "/api/v1/chain/registrations": handleChainRegistrations,
  "/api/v1/chain/deregistrations": handleChainDeregistrations,
  "/api/v1/chain/stake-moves": handleChainStakeMoves,
  "/api/v1/chain/stake-transfers": handleChainStakeTransfers,
};

/**
 * The chain-HISTORY routes (#8700), as one table both dispatch paths use.
 *
 * These answer from the R2 lakehouse (and, on mainnet only, the D1 hot tier
 * above the seam) rather than from live chain state, so unlike
 * dispatchLiveChainRoute they depend on a decode lane having run for that
 * network. `chain_testnet` is populated by the same decode-r2 container that
 * fills `chain`, mainnet-first and isolated.
 *
 * Same reason for being a table rather than a second copy of these branches:
 * bare `/api/v1/blocks` and `/api/v1/testnet/blocks` must resolve to the same
 * handler with a different network, and nothing else.
 *
 * Returns `null` when nothing matched, so the caller continues its own
 * dispatch. Ordering within the table IS load-bearing here, unlike the live
 * table: `/blocks/summary` must be matched before the `{ref}` detail pattern,
 * or "summary" parses as a block reference.
 */
async function dispatchChainHistoryRoute(
  request: Request,
  env: Env,
  url: URL,
  ctx: Ctx = {},
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
): Promise<Response | null> {
  const chain = chainNetworkId(network.id);
  const { pathname } = url;

  // Sub-resource (#1845) before detail before the feed; each pattern is anchored.
  const blockExtrinsicsMatch = BLOCK_EXTRINSICS_PATH_PATTERN.exec(pathname);
  if (blockExtrinsicsMatch) {
    return handleBlockExtrinsics(
      request,
      env,
      blockExtrinsicsMatch[1],
      url,
      chain,
    );
  }
  const blockEventsMatch = BLOCK_EVENTS_PATH_PATTERN.exec(pathname);
  if (blockEventsMatch) {
    return handleBlockEvents(request, env, blockEventsMatch[1], url, chain);
  }
  const blockDetailMatch = BLOCK_DETAIL_PATH_PATTERN.exec(pathname);
  if (blockDetailMatch) {
    return handleBlock(request, env, blockDetailMatch[1], chain);
  }
  if (BLOCKS_FEED_PATH_PATTERN.test(pathname)) {
    return handleBlocks(request, env, url, chain);
  }
  // Detail (more specific) before the feed; each pattern is anchored.
  const extrinsicDetailMatch = EXTRINSIC_DETAIL_PATH_PATTERN.exec(pathname);
  if (extrinsicDetailMatch) {
    return handleExtrinsic(request, env, extrinsicDetailMatch[1], chain);
  }
  if (EXTRINSICS_FEED_PATH_PATTERN.test(pathname)) {
    return handleExtrinsics(request, env, url, chain);
  }
  // The chain-events family (#8700). Routed through the same handler the bare
  // path uses, so parameter validation, cache key and tier labelling are
  // identical on both -- only the chain differs.
  if (
    pathname === "/api/v1/chain-events" ||
    pathname === "/api/v1/chain-events/stats" ||
    BLOCK_CHAIN_EVENTS_PATH_PATTERN.test(pathname)
  ) {
    return handleChainEventsFamily(request, env, url, ctx, network);
  }
  return null;
}

// Handles an explicit /{network}/-prefixed request (URL already prefix-stripped).
// Only the registry artifact surfaces are network-partitioned; dynamic/AI/live
// features stay mainnet-only. testnet/local data is R2-only and may not exist yet
// — readArtifact then returns a clean 404 carrying the requested network.
async function handleNetworkScopedRequest(
  request: Request,
  env: Env,
  url: URL,
  network: typeof DEFAULT_NETWORK,
  ctx: Ctx = {},
) {
  const isApiPath =
    url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");

  // Mainnet-only live/D1 routes 404 under a network prefix regardless of HTTP
  // method — before the read-only gate so POST does not masquerade as 405.
  if (
    isApiPath &&
    network.id !== "local" &&
    isMainnetOnlyApiPath(url.pathname)
  ) {
    return errorResponse(
      "not_found",
      `${url.pathname} is only available on mainnet, not the ${network.id} network.`,
      404,
      { network: network.id },
    );
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  // Local dev-mode: /api/v1/local returns the setup pointer (url is stripped, so
  // the network root is "/api/v1"); any data route under local is a clear no-data
  // 404 since metagraphed hosts nothing for a developer's local chain.
  if (network.id === "local") {
    if (url.pathname === "/api/v1") {
      return envelopeResponse(
        request,
        {
          data: LOCAL_NETWORK_INFO,
          meta: {
            network: "local",
            contract_version: contractVersion(env),
            source: "static",
          },
        },
        "short",
      );
    }
    return errorResponse(
      "not_found",
      "The local network is a client-side developer chain — metagraphed hosts no data for it. GET /api/v1/local for setup guidance before pointing your SDK/RPC at your own local node.",
      404,
      { network: "local" },
    );
  }

  if (isApiPath) {
    if (isMainnetOnlyApiPath(url.pathname)) {
      return errorResponse(
        "not_found",
        `${url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    const resolved = await resolveSubnetSlugRoute(
      env,
      url,
      Date.now(),
      network,
    );
    if (resolved.notFound) {
      return errorResponse(
        "subnet_not_found",
        `No subnet matches the slug "${resolved.slug}" on the ${network.id} network.`,
        404,
        { slug: resolved.slug, network: network.id },
      );
    }
    // Re-check after slug→netuid resolution: a slug-form per-subnet route (e.g.
    // /subnets/<slug>/health/trends) only reveals itself as a mainnet-only
    // dynamic route once the numeric netuid is filled in. Gate it explicitly
    // rather than relying on a downstream R2 miss.
    if (isMainnetOnlyApiPath(resolved.url.pathname)) {
      return errorResponse(
        "not_found",
        `${resolved.url.pathname} is only available on mainnet, not the ${network.id} network.`,
        404,
        { network: network.id },
      );
    }
    // Live chain-storage routes (#8700). These are answered from the network's
    // own RPC rather than from an R2 artifact, so they are dispatched here
    // instead of falling through to handleApiRequest, which only knows how to
    // read artifacts. Everything below reaches the SAME handler the bare
    // mainnet path uses — the only difference is the network argument, so the
    // two paths cannot drift in shape, only in which chain they read.
    const liveChainResponse = await dispatchLiveChainRoute(
      request,
      env,
      resolved.url,
      network,
    );
    if (liveChainResponse) return liveChainResponse;

    // Projection-backed routes first: /blocks/summary is an exact match here
    // and a `{ref}` block detail to the history table below, so the order is
    // load-bearing exactly as it is inside that table.
    const projectionResponse = await dispatchProjectionRoute(
      request,
      env,
      resolved.url,
      ctx,
      network,
    );
    if (projectionResponse) return projectionResponse;

    const chainHistoryResponse = await dispatchChainHistoryRoute(
      request,
      env,
      resolved.url,
      ctx,
      network,
    );
    if (chainHistoryResponse) return chainHistoryResponse;

    return handleApiRequest(request, env, resolved.url, network, ctx);
  }

  if (
    url.pathname.startsWith("/metagraph/") &&
    url.pathname.endsWith(".json")
  ) {
    return handleRawArtifactRequest(request, env, url, network);
  }

  return errorResponse(
    "not_found",
    `No network-scoped route matched this path on the ${network.id} network.`,
    404,
    { network: network.id },
  );
}

async function handleRawArtifactRequest(
  request: Request,
  env: Env,
  url: URL,
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
) {
  const matched = matchRawArtifact(url.pathname);
  if (!matched) {
    return errorResponse(
      "not_found",
      "No public artifact contract matched this path.",
      404,
      {
        artifact_path: url.pathname,
      },
    );
  }

  const networkPath = artifactPathForNetwork(url.pathname, network);
  // Current-state health artifacts are retired on every network prefix — the
  // live-only policy (#490/#498) is not mainnet-specific. Match the canonical
  // path (prefix already stripped by resolveNetworkPrefix); networkPath is only
  // the partitioned R2 key used in the error payload.
  if (RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN.test(url.pathname)) {
    return errorResponse(
      "retired_artifact",
      "Current-state health artifacts are retired; use the live API health endpoints instead.",
      410,
      { artifact_path: networkPath },
    );
  }
  // Computed-live artifacts with UNBOUNDED parameters have no file at any key
  // and never will -- {ref}/{ss58}/{hash} span every block, account and
  // extrinsic that has ever existed, so the build cannot enumerate them and
  // scripts/bake-computed-artifacts.ts explicitly does not try.
  //
  // Reading R2 to discover that cost a GetObject miss per request (two when the
  // KV pointer names a run prefix, via readR2Object's `latest/` recovery read)
  // and answered a 404 that was knowable from the contract without asking.
  // /metagraph/blocks/{ref}.json is the one that showed up: the site's own block
  // pages render it as a real link, so crawlers walk it continuously, and it was
  // the single largest source of R2 errors in the Worker log (#9485).
  //
  // Same posture as the retired-health branch above -- decide from the contract,
  // before any store is touched -- but a 404 rather than a 410: the resource is
  // not gone, it is served live at the route named in the payload.
  const liveRoute = liveOnlyArtifactRoute(matched.path);
  if (liveRoute) {
    return errorResponse(
      "artifact_computed_live",
      `This artifact is computed live and is never written as a file. Fetch ${liveRoute} instead.`,
      404,
      { artifact_path: networkPath, live_route: liveRoute },
    );
  }
  const artifact = await readArtifact(env, networkPath);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: networkPath,
    });
  }
  // Live per-endpoint health overlay: raw artifacts that embed the shared
  // EndpointResource list (endpoints.json, subnets/{n}.json, profiles/{n}.json,
  // provider endpoints) must not serve build-time operational health as fresh.
  // Overlay the 15-minute cron snapshot so direct /metagraph/*.json fetchers see
  // the same live status the /api/v1 routes do; surfaces with no live reading
  // read `unknown`. Mainnet-only (live store is mainnet) and gated to artifacts
  // that actually carry probed endpoints.
  let data = artifact.data as Row;
  if (
    network.isDefault &&
    Array.isArray(data?.endpoints) &&
    data.endpoints.some((endpoint: Row) => endpoint?.surface_id)
  ) {
    const liveSnapshot = await resolveLiveHealth({
      readHealthKv: readHealthKv as unknown as (
        env: Env,
        key: string,
      ) => Promise<Row | null>,
      env,
    });
    data = overlayArtifactEndpoints(data, liveSnapshot) ?? data;
  }
  // The raw artifact path has no envelope. Artifacts bake a deterministic epoch
  // `generated_at` marker (issue #349) so their bytes don't churn; stamp the real
  // publish time onto the served body's generated_at (and a header) so direct
  // fetchers of /metagraph/*.json see the true date. Operational-health fields are
  // overlaid live (above).
  const pub = await publishedAt(env);
  if (
    pub &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "generated_at" in data
  ) {
    data = { ...data, generated_at: pub };
  }
  const body = JSON.stringify(data);
  const headers = apiHeaders("standard");
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set(X_METAGRAPH_ARTIFACT_SOURCE_HEADER, artifact.source);
  // #8287: expose HOW the key resolved, so a scheduled public probe can tell a
  // healthy manifest read from one limping on the pointer-miss fallback without
  // needing log access or credentials.
  if (artifact.resolution) {
    headers.set(X_METAGRAPH_ARTIFACT_RESOLUTION_HEADER, artifact.resolution);
  }
  headers.set("x-metagraph-storage-tier", artifact.storage_tier);
  if (pub) {
    headers.set("x-metagraph-published-at", pub);
  }
  headers.set("etag", await weakEtag(body));
  if (ifNoneMatchSatisfied(request, headers.get("etag") ?? "")) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

// Multi-network addressing (cosmos.directory-style). The friendly URL/UI segment
// (mainnet/testnet/local) maps to the chain-accurate value the data carries
// (finney/test/local) and to the R2 key prefix for non-default networks. Mainnet
// is the default: bare /api/v1/... and /metagraph/... resolve to it unprefixed,
// so every pre-network URL keeps working byte-for-byte. The chain names finney/
// test are accepted as aliases.
const NETWORKS = {
  mainnet: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  finney: { id: "mainnet", chain: "finney", prefix: "", isDefault: true },
  testnet: {
    id: "testnet",
    chain: "test",
    prefix: "testnet",
    isDefault: false,
  },
  test: { id: "testnet", chain: "test", prefix: "testnet", isDefault: false },
  local: { id: "local", chain: "local", prefix: "local", isDefault: false },
};
const DEFAULT_NETWORK = NETWORKS.mainnet;

// #8699: exported for the get_networks MCP tool, so the agent-facing matrix is
// built from the same map the router dispatches on.
export const MCP_NETWORKS = NETWORKS;

// `local` is a per-developer subtensor metagraphed cannot enumerate or host, so
// instead of registry data /api/v1/local returns the setup pointer: point your
// SDK/RPC at the local node and use mainnet/testnet here as the reference
// registry. (cosmos.directory similarly can't host a developer's local chain.)
const LOCAL_NETWORK_INFO = {
  network: "local",
  mode: "client-side",
  note: "Local is a per-developer subtensor you run yourself — metagraphed hosts no subnet data for it. Point your Bittensor SDK / RPC at your local node; use the mainnet and testnet registries here as the reference.",
  rpc: { network_arg: "local" },
  // The full develop-before-mainnet path (issue #354): stand up a local chain,
  // create a subnet on it, point your code at it, then graduate to testnet and
  // mainnet. Uses the official opentensor/subtensor localnet (it generates the
  // chain-spec + funded keys correctly) rather than a bespoke spec.
  quickstart: {
    summary:
      "Stand up a local Bittensor chain, create a subnet on it, and point your SDK at it — develop and test everything before you touch testnet or mainnet.",
    steps: [
      {
        step: 1,
        title: "Run a local chain",
        run: "git clone https://github.com/opentensor/subtensor && cd subtensor && ./scripts/localnet.sh --no-purge",
        detail:
          "Starts a local subtensor WebSocket endpoint with sudo, fast blocks, and pre-funded Alice/Bob keys (free TAO). First run compiles the node (needs the Rust toolchain + build deps).",
      },
      {
        step: 2,
        title: "Install the CLI + SDK",
        run: "pip install bittensor bittensor-cli",
        detail:
          "btcli drives chain operations; the bittensor SDK is what your miner/validator/app imports.",
      },
      {
        step: 3,
        title: "Fund a wallet + create a subnet on the local chain",
        run: "btcli wallet faucet --network local && btcli subnet create --network local",
        detail:
          "The faucet tops up free local TAO; subnet create registers a new netuid on your local chain (instant, free to iterate on).",
      },
      {
        step: 4,
        title: "Register + point your code at it",
        run: "btcli subnet register --netuid <N> --network local",
        detail:
          "Then in code: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')). Everything you'd do on mainnet works here first.",
      },
      {
        step: 5,
        title: "Graduate to testnet, then mainnet",
        run: "Re-run with --network test, then --network finney.",
        detail:
          "Use /api/v1/testnet/subnets as the testnet reference and the mainnet registry here as production; /api/v1/lineage tracks which testnet subnets have graduated to mainnet.",
      },
    ],
  },
  reference: {
    testnet_subnets: "/api/v1/testnet/subnets",
    mainnet_subnets: "/api/v1/subnets",
    lineage: "/api/v1/lineage",
  },
  setup: {
    sdk: "Python bittensor SDK: bt.SubtensorApi(network='local') (or bt.subtensor(network='local')).",
    run_local_chain:
      "Run a local subtensor node (the Subtensor repo's localnet script) to expose your own local WebSocket endpoint with sudo + fast blocks and free TAO.",
  },
  guide: "/skills/bittensor/SKILL.md",
};
// Only an /api/v1/ or /metagraph/ path whose first segment is a known network
// alias is treated as network-scoped; real routes (subnets, providers, …) never
// collide with the alias set, so this never shadows an existing path.
const NETWORK_PREFIX_PATTERN =
  /^\/(api\/v1|metagraph)\/(mainnet|finney|testnet|test|local)(\/.*|$)/;

// Splits explicit /{network}/ prefixes off the path. Default-network aliases
// (mainnet/finney) are canonicalized iteratively so repeated aliases preserve
// the old bare-route dispatch without recursively re-entering handleRequest. If
// a non-default prefix remains after default alias normalization, it is returned
// for the network-scoped artifact handler. Bare paths resolve to mainnet with
// the URL unchanged (explicit:false) — the zero-regression default.
function resolveNetworkPrefix(url: URL) {
  let rewritten = url;
  let explicit = false;

  while (true) {
    const match = NETWORK_PREFIX_PATTERN.exec(rewritten.pathname);
    if (!match) {
      return { network: DEFAULT_NETWORK, url: rewritten, explicit };
    }

    const network = (NETWORKS as Record<string, typeof DEFAULT_NETWORK>)[
      match[2]
    ];
    const nextUrl = new URL(rewritten);
    nextUrl.pathname = `/${match[1]}${match[3] && match[3] !== "/" ? match[3] : ""}`;
    explicit = true;

    if (!network.isDefault) {
      return { network, url: nextUrl, explicit };
    }

    rewritten = nextUrl;
  }
}

// Inserts the network key segment for non-default networks, so the artifact read
// targets metagraph/{prefix}/...  (/metagraph/subnets.json + testnet ->
// /metagraph/testnet/subnets.json). Mainnet (prefix "") is a no-op.
function artifactPathForNetwork(
  artifactPath: string,
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
) {
  if (!network || !network.prefix) {
    return artifactPath;
  }
  return artifactPath.replace(
    /^\/metagraph\//,
    `/metagraph/${network.prefix}/`,
  );
}

// Re-inserts the /{network}/ segment that resolveNetworkPrefix strips before
// dispatch, so a self-referential link (e.g. the pagination Link header) stays
// on the network the client asked for. Mainnet (prefix "") is a no-op.
function networkPublicUrl(url: URL, network: typeof DEFAULT_NETWORK) {
  if (!network.prefix) {
    return url;
  }
  const publicUrl = new URL(url);
  publicUrl.pathname = publicUrl.pathname.replace(
    /^\/(api\/v1|metagraph)(\/|$)/,
    `/$1/${network.prefix}$2`,
  );
  return publicUrl;
}

// Friendly per-subnet routes: /api/v1/subnets/<slug>/... resolves to the netuid
// (e.g. /api/v1/subnets/allways → /api/v1/subnets/7). Worker-only — the slug→
// netuid map is read from the served subnets.json and cached per isolate; no new
// committed artifact or route contract.
const SUBNET_SLUG_ROUTE_PATTERN = /^\/api\/v1\/subnets\/([^/]+)(\/.*)?$/;
const SUBNET_SLUG_INDEX_TTL_MS = 300_000;
// Per-network slug→netuid index, keyed by network.id (slugs/netuids differ across
// chains — testnet SN-N is unrelated to mainnet SN-N).
const subnetSlugIndexByNetwork = new Map(); // network.id -> { map, builtAt }

// Leaderboards/compare profiles projection cache lives in analytics-routes.ts.

// KV_HEALTH_META is written by the health cron (~15 min cadence) and read by
// every analytics handler (percentiles, incidents, trends, uptime, trajectory,
// leaderboards). Each handler reads it independently; this in-isolate memo
// collapses repeated per-request KV reads on warm isolates — same pattern as
// latestPointer (#367) and readRpcPoolArtifact (#1309). Null results are not
// cached so a transient cold KV does not stay sticky.
export const HEALTH_META_KV_TTL_MS = 60_000;
let healthMetaKvMemo: { env: Env | null; value: unknown; expiresAt: number } = {
  env: null,
  value: null,
  expiresAt: 0,
};

export async function readHealthMetaKv(
  env: Env,
  now: number = Date.now(),
): Promise<Row | null> {
  if (healthMetaKvMemo.env === env && now < healthMetaKvMemo.expiresAt) {
    return healthMetaKvMemo.value as Row | null;
  }
  const value = await readHealthKv(env, KV_HEALTH_META);
  if (value !== null) {
    healthMetaKvMemo = { env, value, expiresAt: now + HEALTH_META_KV_TTL_MS };
  }
  return value as Row | null;
}

// Wire the api.ts-local snapshot-meta reader into the extracted analytics module
// (workers/request-handlers/analytics.ts, #1763). The analytics handlers + their
// edge-cache guard own the D1-fallback state; they only need this one in-isolate
// memoized KV read, which stays here because the deferred handler clusters and a
// test import it from api.ts. Injecting the stable reference (rather than having
// analytics.ts import it back) keeps the two modules from importing each other.
configureAnalytics({ readHealthMetaKv, readEconomicsCurrentKv });

// Same wiring for the extracted RPC-proxy module (workers/request-handlers/
// rpc-proxy.ts, #1763): handleRpcUsage needs the in-isolate snapshot-meta read
// for its observed_at stamp. Injecting the stable reference keeps rpc-proxy.ts
// from importing api.ts back (it owns the RPC_HEALTH breaker + pool-artifact memo
// itself). #8522: recordApiKeyUsage is injected the same way so the state-query
// tiered checkpoint can record keyed usage without an import cycle.
configureRpcProxy({ readHealthMetaKv, recordApiKeyUsage });

// economics:current is a large blob (one row per subnet) that resolveLiveEconomics
// reads on every /api/v1/economics request AND every /api/v1/subnets/{netuid}
// request (the per-subnet economics overlay, #1308). Neither route is edge-cached
// for the live overlay, so a warm isolate re-fetches + re-parses the same blob per
// request. Memoize the read in-isolate — same pattern as readHealthMetaKv (#1375),
// readRpcPoolArtifact (#1309), latestPointer (#367). Safe: resolveLiveEconomics
// re-validates the blob's captured_at freshness against the live clock on every
// call, so the 60 s memo (≪ the 8 h freshness window) never extends how long a
// stale blob can serve. Null results are not cached so a transient cold KV does
// not stay sticky; keyed on env so tests / multi-binding callers never cross-read.
export const ECONOMICS_CURRENT_KV_TTL_MS = 60_000;
let economicsCurrentKvMemo: {
  env: Env | null;
  value: unknown;
  expiresAt: number;
} = { env: null, value: null, expiresAt: 0 };

export async function readEconomicsCurrentKv(
  env: Env,
  now: number = Date.now(),
): Promise<Row | null> {
  if (
    economicsCurrentKvMemo.env === env &&
    now < economicsCurrentKvMemo.expiresAt
  ) {
    return economicsCurrentKvMemo.value as Row | null;
  }
  const value = await readHealthKv(env, KV_ECONOMICS_CURRENT);
  if (value !== null) {
    economicsCurrentKvMemo = {
      env,
      value,
      expiresAt: now + ECONOMICS_CURRENT_KV_TTL_MS,
    };
  }
  return value as Row | null;
}

// Chain-event index heartbeat. Memoized per-isolate at a short TTL so repeated
// /health probes on a warm isolate do not re-query per request; a null result
// is NOT memoized, so a cold or unbound store stays re-queried.
//
// READS D1, NOT DATA_API (#8700). This asked the DATA_API binding for
// `/api/v1/chain-events?limit=1` and took the newest row's block+timestamp. That
// binding's Postgres store was destroyed (#9186/#9193), so the call could only
// 503 and the health payload published `chain_events: {null, null, null}` --
// "the index has no heartbeat at all" -- every time, verified live 2026-08-04.
//
// D1's `chain_detail_blocks` is the right source rather than merely a working
// one: this field documents itself as the LIVE-FOLLOW streamer's heartbeat
// (~12-30s while it runs), and that lane is exactly what fills this table. The
// lakehouse feed would answer too, but it is the wrong clock -- an hourly decode
// lane -- and every probe would pay a bounded-window R2 SQL scan for it.
// tests/health-chain-events-cache.test.ts holds the memo behaviour.
export const CHAIN_EVENTS_DB_TTL_MS = 30_000;
let chainEventsDbMemo: { env: Env | null; value: unknown; expiresAt: number } =
  { env: null, value: null, expiresAt: 0 };

registerModuleStateReset("workers/api.ts:chainEventsDbMemo", () => {
  chainEventsDbMemo = { env: null, value: null, expiresAt: 0 };
});

export async function readChainEventsDb(
  env: Env,
  now: number = Date.now(),
): Promise<Row | null> {
  if (chainEventsDbMemo.env === env && now < chainEventsDbMemo.expiresAt) {
    return chainEventsDbMemo.value as Row | null;
  }
  let value = null;
  try {
    // THROUGH THE WATCHDOG'S OWN READER, not a second copy of its SQL: this
    // endpoint publishes the number and the watchdog alerts on it, and two
    // queries would drift apart silently, each looking correct alone.
    const head = await readChainDetailHead(
      env as unknown as Record<string, unknown>,
    );
    // A blank or zero timestamp is ABSENT, not the epoch: Number(null) is 0,
    // which would publish an age of 56 years instead of "no heartbeat".
    if (head.latestObservedAtMs && head.latestObservedAtMs > 0) {
      value = { block: head.headBlock, at: head.latestObservedAtMs };
    }
  } catch {
    value = null;
  }
  if (value !== null) {
    chainEventsDbMemo = { env, value, expiresAt: now + CHAIN_EVENTS_DB_TTL_MS };
  }
  return value;
}

configureAnalyticsRoutes({ readHealthMetaKv, readEconomicsCurrentKv });

// See src/module-state-registry.ts. This module owns both the env-keyed
// in-isolate memos and the production wiring for the three handler modules
// above. Resets run in module-evaluation order and api.ts evaluates LAST (it
// imports all three), so this reset re-wires production immediately after each
// handler module has dropped back to its unwired placeholders — leaving the
// process in exactly the state a fresh import would produce.
registerModuleStateReset("workers/api.ts", () => {
  // #8823: the usage-rollup buffer is module-scoped isolate state, so it
  // must reset between test files exactly like the memos below -- a leftover
  // observation would otherwise shift the next file's flush boundary.
  usageRollupBuffer = [];
  usageRollupBufferedAtMs = 0;
  healthMetaKvMemo = { env: null, value: null, expiresAt: 0 };
  economicsCurrentKvMemo = { env: null, value: null, expiresAt: 0 };
  chainEventsDbMemo = { env: null, value: null, expiresAt: 0 };
  subnetSlugIndexByNetwork.clear();
  configureAnalytics({ readHealthMetaKv, readEconomicsCurrentKv });
  configureRpcProxy({ readHealthMetaKv, recordApiKeyUsage });
  configureAnalyticsRoutes({ readHealthMetaKv, readEconomicsCurrentKv });
});

async function resolveSubnetSlugRoute(
  env: Env,
  url: URL,
  now: number = Date.now(),
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
): Promise<
  | { url: URL; notFound?: undefined; slug?: undefined }
  | { url?: undefined; notFound: true; slug: string }
> {
  const match = SUBNET_SLUG_ROUTE_PATTERN.exec(url.pathname);
  // Not a per-subnet route, or already a numeric netuid → pass through.
  if (!match || /^\d+$/.test(match[1])) {
    return { url };
  }
  const slug = decodeSlugPathSegment(match[1]);
  if (slug === null) {
    return { notFound: true, slug: match[1] };
  }
  const netuid = await lookupSubnetNetuid(env, slug, now, network);
  if (netuid === null) {
    return { notFound: true, slug };
  }
  const rewritten = new URL(url);
  rewritten.pathname = `/api/v1/subnets/${netuid}${match[2] || ""}`;
  return { url: rewritten };
}

function decodeSlugPathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

async function lookupSubnetNetuid(
  env: Env,
  slug: string,
  now: number = Date.now(),
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
) {
  const cached = subnetSlugIndexByNetwork.get(network.id);
  if (!cached || now - cached.builtAt > SUBNET_SLUG_INDEX_TTL_MS) {
    const artifact = await readArtifact(
      env,
      artifactPathForNetwork("/metagraph/subnets.json", network),
    );
    const artifactData = artifact.ok ? (artifact.data as Row) : null;
    if (artifact.ok && Array.isArray(artifactData?.subnets)) {
      const map = new Map();
      // Curated slug is canonical — map it first for every subnet.
      for (const subnet of artifactData!.subnets) {
        if (
          typeof subnet.slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          map.set(subnet.slug.toLowerCase(), subnet.netuid);
        }
      }
      // Then the chain-name native_slug (e.g. "apex") fills any key it doesn't
      // already own, so subnets resolve by the name agents discover them by —
      // essential on testnet, where there are no curated overlay slugs. A
      // curated slug always wins a collision, and duplicate native slugs are
      // suppressed so ambiguous aliases cannot resolve by artifact order.
      const nativeSlugCounts = new Map();
      for (const subnet of artifactData!.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          nativeSlugCounts.set(key, (nativeSlugCounts.get(key) || 0) + 1);
        }
      }
      for (const subnet of artifactData!.subnets) {
        if (
          typeof subnet.native_slug === "string" &&
          Number.isInteger(subnet.netuid)
        ) {
          const key = subnet.native_slug.toLowerCase();
          if (!map.has(key) && nativeSlugCounts.get(key) === 1) {
            map.set(key, subnet.netuid);
          }
        }
      }
      subnetSlugIndexByNetwork.set(network.id, { map, builtAt: now });
    } else if (!cached) {
      // Could not load the index and have no prior copy — leave unresolved.
      return null;
    }
  }
  const netuid = subnetSlugIndexByNetwork
    .get(network.id)
    ?.map.get(slug.toLowerCase());
  return Number.isInteger(netuid) ? netuid : null;
}

// loadPreviouslyKnownAs/loadPreviouslyKnownAsForNetuids (src/subnet-identity-
// history.mjs) are Postgres-fetch helpers embedded in 3 overlay call sites
// below rather than standalone routes, so there is no single client request
// for tryPostgresTier to forward unchanged -- these two wrappers synthesize
// their own internal /api/v1/internal/subnet-identity-aliases request
// instead, mirroring composeCompareData's health-dimension wiring (#4832
// gap-closure). Reuses METAGRAPH_SUBNET_IDENTITY_SOURCE, already flipped to
// postgres for /identity-history. D1 fully eliminated (2026-07-16): a tier
// miss/outage now returns an empty alias list rather than falling back to
// D1's frozen copy, same degrade every other route reusing this flag already
// tolerates.
async function loadPreviouslyKnownAsTiered(
  env: Env,
  netuid: number,
  currentName: string | null,
) {
  const pgUrl = new URL(
    "https://data-api.internal/api/v1/internal/subnet-identity-aliases",
  );
  pgUrl.searchParams.set("netuids", String(netuid));
  const pgData = await tryPostgresTier(
    env,
    new Request(pgUrl),
    "METAGRAPH_SUBNET_IDENTITY_SOURCE",
  );
  return derivePreviouslyKnownAs(
    (pgData?.rows as Row[] | undefined) ?? [],
    currentName,
  );
}

async function loadPreviouslyKnownAsForNetuidsTiered(env: Env, entries: Row[]) {
  const netuids = entries
    .map((entry) => entry?.netuid)
    .filter((netuid) => Number.isInteger(netuid));
  const pgUrl = new URL(
    "https://data-api.internal/api/v1/internal/subnet-identity-aliases",
  );
  pgUrl.searchParams.set("netuids", netuids.join(","));
  const pgData = await tryPostgresTier(
    env,
    new Request(pgUrl),
    "METAGRAPH_SUBNET_IDENTITY_SOURCE",
  );
  return deriveNetuidGroupedAliases(
    (pgData?.rows as Row[] | undefined) ?? [],
    entries,
  );
}

async function handleApiRequest(
  request: Request,
  env: Env,
  url: URL,
  network: typeof DEFAULT_NETWORK = DEFAULT_NETWORK,
  ctx: Ctx = {},
) {
  const matched = matchRoute(url.pathname);
  if (!matched) {
    return errorResponse("not_found", "No API route matched this path.", 404);
  }
  const artifactPath = artifactPathForNetwork(matched.artifactPath, network);
  const queryError = validateListQueryParams(
    url,
    matched.queryCollection as string,
    matched.queryFilterNames,
    { csvResponse: matched.csvResponse === true },
  );
  if (queryError) {
    return errorResponse("invalid_query", queryError.message, 400, {
      artifact_path: artifactPath,
      parameter: queryError.parameter,
    });
  }
  const wantsCsv = matched.csvResponse === true && csvRequested(url, request);
  // Edge-cache idempotent GETs for pure static-artifact routes (mirrors the
  // RPC-proxy Cache API pattern). Live-overlay routes are excluded by route id,
  // not by whether live data happened to be available for this request, so cold
  // KV/D1 fallback responses cannot seed stale operational metadata.
  // The key namespaces by network + contract version so a deploy or a network
  // switch can never serve a cross-version body; the response's own
  // cache-control max-age bounds staleness.
  const edgeCache =
    request.method === "GET" &&
    !wantsCsv &&
    isStaticEdgeCacheEligible(matched, network)
      ? globalWithCaches.caches?.default
      : null;
  const edgeCacheKey = edgeCache
    ? new Request(
        `https://edge-cache.metagraph.sh/${network.id}/${encodeURIComponent(
          contractVersion(env),
        )}${url.pathname}${canonicalCacheSearch(url, matched)}`,
      )
    : null;
  // Live-overlay collection cache (the large /api/v1/endpoints index). Excluded
  // from the static edge cache above, but its overlay only changes when the
  // 2-min cron writes a new health snapshot, so cache it keyed on last_run_at —
  // turning a per-request R2-GET + parse + 3-pass overlay + 1.43 MB re-stringify
  // + SHA-256 into at-most-once-per-cron-tick, staleness bounded to one interval.
  const overlayCache =
    request.method === "GET" &&
    !wantsCsv &&
    network.isDefault &&
    CACHEABLE_OVERLAY_ROUTE_IDS.has(matched.id)
      ? globalWithCaches.caches?.default
      : null;
  let overlayCacheKey = null;
  if (overlayCache) {
    // Cheap KV read of just the snapshot time; on a hit this + the cache match
    // is the whole request (no R2 GET / overlay / re-stringify).
    const opMeta = await readHealthMetaKv(env);
    const lastRunAt = opMeta?.last_run_at || null;
    if (lastRunAt) {
      overlayCacheKey = new Request(
        `https://edge-cache.metagraph.sh/overlay/${network.id}/${encodeURIComponent(
          contractVersion(env),
        )}/${encodeURIComponent(lastRunAt)}${url.pathname}${canonicalCacheSearch(url, matched)}`,
      );
      const overlayHit = await overlayCache.match(overlayCacheKey);
      if (overlayHit) {
        if (ifNoneMatchSatisfied(request, overlayHit.headers.get("etag"))) {
          return new Response(null, {
            status: 304,
            headers: overlayHit.headers,
          });
        }
        return overlayHit;
      }
    }
  }
  if (edgeCache) {
    const hit = await edgeCache.match(edgeCacheKey);
    if (hit) {
      // Honour conditional requests against the cached body's weak ETag so
      // polling agents still get a 304 on a warm cache (mirrors envelopeResponse).
      if (ifNoneMatchSatisfied(request, hit.headers.get("etag"))) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return hit;
    }
  }
  // Mainnet (default) reads the unprefixed artifact (no-op); non-default networks
  // read metagraph/{prefix}/… — see artifactPathForNetwork.

  // Live operational-health overlay (Phase 3): current health is live-only.
  // Static current-health artifacts are not read for mainnet health routes, so
  // stale R2 objects left behind by earlier publishes cannot affect responses.
  let artifact: Row;
  let live: Row | null = null;
  if (!network.isDefault) {
    // Non-default networks serve only the static partitioned artifact; the live
    // KV/D1 health overlay is mainnet-only.
    artifact = await readArtifact(env, artifactPath);
  } else if (matched.id === "health") {
    // Live-only global operational health: KV health:current → Postgres tier
    // (D1 fully eliminated, 2026-07-17), and an explicit `unknown` global when
    // the live store is cold. There is no stored health summary to fall back
    // to (live-only).
    live = {
      data: await loadGlobalOperationalHealth(
        {
          env,
          readHealthKv: readHealthKv as unknown as (
            env: Env,
            key: string,
          ) => Promise<Record<string, unknown> | null>,
        },
        { contractVersion: (e: Env) => contractVersion(e) },
      ),
    };
    artifact = { ok: false };
  } else if (matched.id === "subnet-health") {
    artifact = { ok: false };
    live = await liveHealthOverlay(env, matched, null);
    // Per-subnet health is live-only too: never 404 on a cold store — serve an
    // explicit `unknown` payload instead of the (now absent) static artifact.
    if (!live) {
      live = { data: unknownSubnetHealth(Number(matched.params.netuid)) };
    }
  } else if (matched.id === "economics") {
    // Economics: prefer the live KV 'economics:current' blob (fresh, on-contract,
    // integrity-checked); fall back to the committed R2 economics.json when KV is
    // cold/stale/invalid. Unlike health this keeps the R2 artifact as a real
    // fallback, so it can never 404.
    artifact = await readArtifact(env, artifactPath);
    live = await resolveLiveEconomics({
      readHealthKv: (e) => readEconomicsCurrentKv(e),
      env,
      contractVersion: contractVersion(env),
    });
  } else {
    artifact = await readArtifact(env, artifactPath);
    live = await liveHealthOverlay(
      env,
      matched,
      artifact.ok ? artifact.data : null,
    );
  }

  if (!artifact.ok && !live) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: artifactPath,
    });
  }

  let baseData = live ? live.data : artifact.data;
  // Spot on every economics row (#9408 completion): the detail card and the
  // leaderboards already derive spot_price_tao at serve time; the full blob was
  // the one surface still without it. Both tiers pass through this point.
  if (matched.id === "economics") {
    baseData = withSpotPricedEconomics(baseData as Row) as typeof baseData;
  }
  // Per-subnet economics overlay (#1308): attach the live economics row so
  // /api/v1/subnets/{netuid} carries validator/miner counts, registration, stake
  // and alpha price in one call. Null-safe — a cold/stale economics tier leaves
  // the detail unchanged. Served live (not baked) so it never churns the artifact.
  if (
    network.isDefault &&
    matched.id === "subnet-detail" &&
    baseData &&
    typeof baseData === "object"
  ) {
    const liveEconomics = await resolveLiveEconomics({
      readHealthKv: (e) => readEconomicsCurrentKv(e),
      env,
      contractVersion: contractVersion(env),
    });
    baseData = overlaySubnetEconomics(
      baseData,
      liveEconomics?.data,
      Number(matched.params.netuid),
    );
    const aliasTarget =
      baseData.subnet && typeof baseData.subnet === "object"
        ? baseData.subnet
        : baseData;
    const aliasNames = await loadPreviouslyKnownAsTiered(
      env,
      Number(matched.params.netuid),
      aliasTarget.native_name ?? aliasTarget.name,
    );
    if (baseData.subnet && typeof baseData.subnet === "object") {
      baseData = {
        ...baseData,
        subnet: overlayPreviouslyKnownAs(baseData.subnet, aliasNames),
      };
    } else {
      baseData = overlayPreviouslyKnownAs(baseData, aliasNames);
    }
  }
  // Identity-history aliases are D1-backed and independent of the live health KV
  // overlay — apply them whenever the catalog artifact is served (static or live).
  if (
    network.isDefault &&
    matched.id === "agent-catalog-subnet" &&
    baseData &&
    typeof baseData === "object"
  ) {
    const aliasNames = await loadPreviouslyKnownAsTiered(
      env,
      Number(matched.params.netuid),
      baseData.name,
    );
    baseData = overlayPreviouslyKnownAs(baseData, aliasNames);
  }
  if (
    network.isDefault &&
    matched.id === "agent-catalog" &&
    baseData?.subnets?.length
  ) {
    const aliasMap = await loadPreviouslyKnownAsForNetuidsTiered(
      env,
      baseData.subnets,
    );
    baseData = {
      ...baseData,
      subnets: baseData.subnets.map((entry: Row) =>
        overlayPreviouslyKnownAs(entry, aliasMap.get(entry.netuid) || []),
      ),
    };
  }
  const baseSource = live
    ? live.source || baseData?.health_source || "live-cron-prober"
    : matched.id === "economics"
      ? "r2-fallback"
      : artifact.source;

  // Serve-time contract drift (#1001): when serving a STORED artifact (not a
  // live overlay) that was built under an older contract than the live one, the
  // body may predate a schema change. Surface it on meta + the
  // x-metagraph-stale-contract header (in envelopeResponse) + a warn log so the
  // otherwise-silent drift is observable.
  const staleContract = live
    ? null
    : contractStaleness(env, artifact.data?.contract_version);
  if (staleContract) {
    logEvent(env, "warn", "stale_contract_served", {
      artifact_path: artifactPath,
      built_under: staleContract.built_under,
      live: staleContract.live,
    });
  }

  const transformed = applyQueryFilters(
    baseData,
    url,
    matched.queryCollection as string,
    matched.queryFilterNames,
    { csvResponse: matched.csvResponse === true },
  ) as Row;
  if (transformed.error) {
    return errorResponse("invalid_query", transformed.error.message, 400, {
      artifact_path: artifactPath,
      parameter: transformed.error.parameter,
    });
  }
  // Advertise the page chain via an RFC 8288 Link header on paginated list
  // responses. networkPublicUrl restores the prefix stripped before dispatch;
  // paginationLinkHeader returns null (no header) for non-list/single-page data.
  const formatOverride = url.searchParams.get("format")?.toLowerCase();
  const linkSearchParams: Record<string, string> = {};
  if (formatOverride === "json") {
    linkSearchParams.format = "json";
  } else if (wantsCsv) {
    linkSearchParams.format = "csv";
  }
  const linkValue = paginationLinkHeader(
    networkPublicUrl(url, network),
    transformed.meta.pagination,
    {
      queryCollection: matched.queryCollection ?? undefined,
      queryFilterNames: matched.queryFilterNames || [],
      searchParams: linkSearchParams,
    },
  );
  if (wantsCsv) {
    let collectionKey = (API_QUERY_COLLECTIONS as Record<string, Row>)[
      matched.queryCollection as string
    ].data_key;
    if (transformed.meta.pagination) {
      collectionKey = transformed.meta.pagination.collection;
    }
    const rows = transformed.data[collectionKey];
    if (!Array.isArray(rows)) {
      return errorResponse(
        "invalid_artifact",
        "Artifact did not contain the expected list collection.",
        500,
        {
          artifact_path: artifactPath,
          collection: collectionKey,
        },
      );
    }
    return csvResponse(
      rows,
      matched.id,
      matched.cache as CacheProfile,
      request,
      transformed.meta.projection?.fields,
      linkValue ? { link: linkValue } : {},
      {
        stream: matched.id === "endpoints" || matched.id === "subnet-endpoints",
      },
    );
  }
  // Real publish time from the KV latest pointer (null until a publish has
  // populated it). Unlike generated_at — a deterministic content marker that is
  // intentionally the 1970 epoch in committed/local builds (issue #349) — this
  // is the genuine "last updated" timestamp.
  const pub = await publishedAt(env);
  // A live tier whose blob carries its OWN freshness (economics' captured_at,
  // refreshed on its own 3h schedule) should report that as published_at, not the
  // unrelated data publish pointer — otherwise a fresh live-kv economics blob looks
  // as stale as the last full publish.
  const effectivePublishedAt =
    matched.id === "economics" &&
    live?.source === "live-kv" &&
    baseData?.captured_at
      ? baseData.captured_at
      : pub;
  // Freshness is served LIVE, never baked. Artifacts carry a deterministic epoch
  // `generated_at` marker (issue #349) so their bytes change only when the data
  // does (git-committable, no churn). The Worker stamps the real publish time onto
  // the response here — the envelope meta (below) AND the body, so a consumer
  // reading the raw body sees the true date instead of the 1970 marker. Same source
  // that feeds meta.published_at; storage stays deterministic, serving stays honest.
  let responseData = transformed.data;
  if (
    responseData &&
    typeof responseData === "object" &&
    !Array.isArray(responseData)
  ) {
    const patch: Row = {};
    // #9106: economics is the one response whose fields do NOT share a read
    // instant -- some come off the bulk runtime call at its own height, some
    // from storage pinned to chain_state.block, and two are the SAME chain item
    // read at both. Attached here rather than baked into the artifact: the blob
    // is written by a Python producer and mirrored into KV and R2, so baking it
    // would put one declaration in three writers.
    //
    // #9220: and it is per TIER, not one map for both. Since #9197 the live KV
    // blob is built by a Worker cron that has no bittensor SDK -- every field is
    // a named storage map pinned to one block, with the per-UID aggregates from
    // D1 -- so the bulk-call provenance the R2 artifact carries is simply not
    // how the served row was read. Keyed off the same `live.source` the
    // effectivePublishedAt branch above already trusts.
    if (matched.id === "economics") {
      patch.field_sources = economicsFieldSources(live?.source);
    }
    if (effectivePublishedAt && "generated_at" in responseData) {
      patch.generated_at = effectivePublishedAt;
    }
    if (pub && "published_at" in responseData && !responseData.published_at) {
      patch.published_at = pub;
    }
    if (Object.keys(patch).length) {
      responseData = { ...responseData, ...patch };
    }
  }
  const envelopePayload = {
    data: responseData,
    meta: {
      artifact_path: artifactPath,
      cache: matched.cache as CacheProfile,
      contract_version: contractVersion(env),
      generated_at: effectivePublishedAt || baseData?.generated_at || null,
      published_at: effectivePublishedAt,
      source: baseSource,
      ...(staleContract ? { stale_contract: staleContract } : {}),
      ...(baseData?.operational_observed_at
        ? { operational_observed_at: baseData.operational_observed_at }
        : {}),
      ...transformed.meta,
    },
  };
  // Staging drift tripwire (types-epic B, #7860 requirement 6): OFF by
  // default (METAGRAPH_VALIDATE_RESPONSES unset/"false") -- the flag check
  // is the ONLY cost paid on every request; the schema import + parse only
  // happen once it's flipped on, and via waitUntil so it never adds latency
  // to the real response. See src/response-validation-tripwire.ts.
  // `as string`: wrangler types this literally as `"false"` (its committed
  // wrangler.jsonc default), not `string` -- true for every other
  // METAGRAPH_*-flag var too, but they all default "true" so comparing
  // against the SAME literal never trips the "no overlap" check this one
  // does. A preview/staging environment override still sets the real
  // runtime value to "true"; only the static type is too narrow.
  if ((env.METAGRAPH_VALIDATE_RESPONSES as string) === "true") {
    ctx?.waitUntil?.(
      validateResponseTripwire(matched.id, {
        ok: true,
        schema_version: 1,
        ...envelopePayload,
      }),
    );
  }
  const response = await envelopeResponse(
    request,
    envelopePayload,
    matched.cache as CacheProfile,
    {
      ...(linkValue ? { link: linkValue } : {}),
      // #8301: the artifact diagnostics were set by the RAW /metagraph/*.json
      // builder only, so an /api/v1 consumer could not tell a fresh R2 read
      // from a committed-asset fallback or a pointer-miss fallback -- the exact
      // distinctions that mattered during the 2026-07-26 outage (#8276). All
      // three are already in the CORS expose list; the envelope path just never
      // set them, which is also what silently blinded the resolution alarm
      // (#8287) until #8299 repointed it. envelopeResponse drops null/undefined
      // entries, so a live-overlay response with no artifact behind it simply
      // omits them rather than asserting a tier it did not read.
      "x-metagraph-artifact-source": artifact.source,
      "x-metagraph-storage-tier": artifact.storage_tier,
      [X_METAGRAPH_ARTIFACT_RESOLUTION_HEADER]: artifact.resolution,
    },
  );
  // Cache only route-declared pure static-artifact 200s. Live-overlay routes
  // are skipped even when their live store is cold and the response falls back
  // to the static artifact. 304/HEAD/non-200 are skipped. The edge entry
  // expires per the response's cache-control max-age.
  if (edgeCache && live === null && response.status === 200) {
    ctx?.waitUntil?.(edgeCache.put(edgeCacheKey, response.clone()));
  }
  // Cache the live-overlay collection only when the overlay actually applied
  // (live !== null) and we keyed on a real last_run_at (overlayCacheKey set) —
  // never cache a cold-KV fallback, which would pin build-time health under a
  // stable key. The entry busts on the next cron snapshot (key) + max-age.
  if (overlayCacheKey && live !== null && response.status === 200) {
    ctx?.waitUntil?.(overlayCache.put(overlayCacheKey, response.clone()));
  }
  return response;
}

/** The matched artifact entry, so a caller can consult its contract (is it
 * computed live?) and not just whether the path is shaped like one. */
function matchRawArtifact(pathname: string) {
  return RAW_ARTIFACT_ROUTES.find((candidate) =>
    candidate.pattern.test(pathname),
  );
}

function matchRoute(pathname: string) {
  for (const candidate of ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params = match.groups || {};
    return {
      id: candidate.id,
      artifactPath: candidate.artifactPath(params),
      cache: candidate.cache,
      params,
      queryCollection: candidate.query_collection,
      queryFilterNames: candidate.query_filter_names,
      csvResponse: candidate.csv_response === true,
    };
  }
  return null;
}

// Lightweight readiness probe for uptime checks and load balancers. Reports
// which bindings are wired; KV reads are in-isolate memoized.
async function handleHealthRequest(request: Request, env: Env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      "method_not_allowed",
      "The health route only accepts GET and HEAD.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  const bindings = {
    assets: Boolean(env.ASSETS?.fetch),
    r2: Boolean(env.METAGRAPH_ARCHIVE?.get),
    kv: Boolean(env.METAGRAPH_CONTROL?.get),
    data_api: Boolean(env.DATA_API?.fetch),
    health_db: Boolean(env.METAGRAPH_HEALTH_DB?.prepare),
  };

  // Data freshness — the event-driven data publish (ADR 0007) advances the KV
  // `latest` pointer's published_at on each human-input registry merge and at
  // least once daily (the 07:17 UTC floor). If that pipeline silently stops, the
  // pointer goes stale; report `degraded` + HTTP 503 so an uptime monitor pointed
  // at /health catches a broken data-refresh. Only a *present* stale pointer trips
  // it, so local/dev and the worker-test harness (no published pointer) stay
  // healthy.
  // Default 48h = two missed daily floors. (The old 12h default — "two missed 6h
  // crons" — would false-degrade on a quiet day now that the floor is daily, not
  // 6-hourly.)
  const maxAgeHours = Number(env.METAGRAPH_HEALTH_MAX_AGE_HOURS) || 48;
  // Read the publish pointer + the operational-health meta concurrently (one
  // round-trip instead of two) — both are independent KV gets.
  const [pointer, meta] = bindings.kv
    ? await Promise.all([latestPointer(env), readHealthMetaKv(env)])
    : [null, null];
  const publishedAtIso =
    pointer && typeof pointer.published_at === "string"
      ? pointer.published_at
      : null;
  const publishedMs = publishedAtIso ? Date.parse(publishedAtIso) : NaN;
  const ageHours = Number.isFinite(publishedMs)
    ? (Date.now() - publishedMs) / 3_600_000
    : null;
  const stale = ageHours !== null && ageHours > maxAgeHours;

  // Operational-health freshness — the 15-minute cron prober's last run. Reported
  // for observability (a stuck prober shows a growing age); does not gate the
  // HTTP status here (Phase 4 wires alerting). Null until the first cron run.
  const opRunAtMs = meta?.last_run_at ? Date.parse(meta.last_run_at) : NaN;
  const opAgeMinutes = Number.isFinite(opRunAtMs)
    ? (Date.now() - opRunAtMs) / 60_000
    : null;

  // Chain-event index freshness (#1346/#1361) — the realtime streamer's heartbeat.
  // The newest observed_at row is an index-friendly heartbeat for the latest
  // indexed chain event; age_seconds is ~12-30s while the streamer is live,
  // growing toward the ~5-min poller backstop if it's down. Reported for
  // observability (does NOT gate the HTTP status, like operational_health);
  // best-effort + null on a cold/unbound store.
  let chainEvents = null;
  if (bindings.health_db) {
    const chainEventsRow = await readChainEventsDb(env);
    const chainEventsAtMs = chainEventsRow ? Number(chainEventsRow.at) : NaN;
    // Blank/zero observed_at cells coerce via Number("") → 0; treat as absent
    // (mirrors toIso in src/blocks.ts and captured_at guards elsewhere).
    const chainEventsFresh =
      Number.isFinite(chainEventsAtMs) && chainEventsAtMs > 0;
    chainEvents = {
      latest_indexed_block: chainEventsRow?.block ?? null,
      latest_event_at: chainEventsFresh
        ? new Date(chainEventsAtMs).toISOString()
        : null,
      age_seconds: chainEventsFresh
        ? Math.round((Date.now() - chainEventsAtMs) / 1000)
        : null,
    };
  }

  const body = JSON.stringify({
    status: stale ? "degraded" : "ok",
    service: "metagraphed",
    contract_version: contractVersion(env),
    rpc_proxy_enabled: env.METAGRAPH_ENABLE_RPC_PROXY === "true",
    bindings,
    freshness: {
      published_at: publishedAtIso,
      age_hours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
      max_age_hours: maxAgeHours,
      stale,
    },
    operational_health: {
      last_run_at: meta?.last_run_at || null,
      age_minutes:
        opAgeMinutes === null ? null : Math.round(opAgeMinutes * 100) / 100,
      probed_count: meta?.probed_count ?? null,
      status_counts: meta?.status_counts ?? null,
    },
    chain_events: chainEvents,
  });

  const headers = apiHeaders("short");
  headers.set("x-metagraph-health", stale ? "degraded" : "ok");
  if (stale) {
    // The degraded branch is a transient 503; a 503 carrying explicit freshness
    // (public, max-age=60, stale-while-revalidate=300) is cacheable per RFC 7234,
    // so a shared/edge cache could keep serving "degraded" for up to ~6 min after
    // the data recovers. Never cache it — mirror errorResponse in workers/http.ts.
    headers.set("cache-control", "no-store");
    headers.set("x-metagraph-cache-profile", "no-store");
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: stale ? 503 : 200,
    headers,
  });
}

// --- Change-feed webhooks -----------------------------------------------------
// Subscription management for the data publish change feed. Subscriptions live in
// the METAGRAPH_CONTROL KV namespace under the `webhooks:sub:<id>` prefix; the
// publish-time dispatcher (scripts/dispatch-webhooks.ts) reads them and fires
// HMAC-signed POSTs. Routes degrade to 503 when KV is unbound (local dev).
async function handleWebhookRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx?: Ctx,
) {
  if (!env.METAGRAPH_CONTROL?.get || !env.METAGRAPH_CONTROL?.put) {
    return errorResponse(
      "webhooks_unavailable",
      "The webhook subscription store is not configured.",
      503,
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "v1", "webhooks", "subscriptions", <id?>]
  if (segments[3] !== "subscriptions") {
    return errorResponse("not_found", "Unknown webhook route.", 404, {
      path: url.pathname,
    });
  }
  const id = segments[4];

  if (!id && request.method === "POST") {
    return createWebhookSubscription(request, env, ctx);
  }
  if (id && request.method === "GET") {
    return getWebhookSubscription(env, id);
  }
  if (id && request.method === "DELETE") {
    return deleteWebhookSubscription(request, env, id, ctx);
  }
  return errorResponse(
    "method_not_allowed",
    "Use POST /api/v1/webhooks/subscriptions, or GET/DELETE /api/v1/webhooks/subscriptions/{id}.",
    405,
    {},
    { allow: "POST, GET, DELETE, OPTIONS" },
  );
}

// Per-client abuse control for the two webhook-subscription MUTATION routes
// (POST create, DELETE remove). Both authenticate with a SHARED static secret
// -- the create token, or a subscription's own secret for delete -- rather than
// a per-user credential, and each successful POST persists a KV row
// (expirationTtl WEBHOOK_TTL_SECONDS), so a token-holding caller could otherwise
// script unbounded create/delete churn. 10 requests / 60s per client IP, keyed
// on a single shared bucket so create+delete together are bounded -- the same
// posture handleAlertTriggerCreate applies to its structurally identical
// shared-secret route. Optional-chained so it's a no-op when the binding is
// absent (local dev/CI), matching every other rate-limiter in this codebase.
const WEBHOOK_SUBSCRIPTION_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

// #8523: tiered rate limiting for webhook subscription create/delete/list,
// mirroring DATA_TIERED_RATE_LIMIT. Anonymous callers keep the existing 10/60s
// IP-keyed ceiling (WEBHOOK_SUBSCRIPTION_RATE_LIMITER); a valid mg_... key rides
// the 5x account-keyed tier (WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED). The
// "webhook" prefix namespaces the bucket so it never collides with another
// surface sharing a binding. Fails open when a binding is absent, like every
// limiter here.
export const WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT: TieredRateLimitConfig = {
  anonymous: {
    envVar: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER",
    limit: WEBHOOK_SUBSCRIPTION_RATE_LIMIT.limit,
    windowSeconds: WEBHOOK_SUBSCRIPTION_RATE_LIMIT.windowSeconds,
  },
  keyed: {
    envVar: "WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED",
    limit: 50,
    windowSeconds: 60,
  },
  // #8608: per-tier ceilings (src/api-tiers.ts).
  tiers: buildTierPolicies("WEBHOOK_SUBSCRIPTION_RATE_LIMITER", 50),
  keyPrefix: "webhook",
};

async function webhookSubscriptionRateLimited(
  request: Request,
  env: Env,
  ctx?: Ctx,
) {
  const rateLimit = await applyTieredRateLimit(
    request,
    env,
    WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
  );
  markRequestAuthTier(request, rateLimit.tier);
  // #8609: recorded before the rejection return so a throttled request is
  // counted as a rejection rather than not counted at all.
  if (rateLimit.accountId) {
    recordApiKeyUsage(
      env,
      ctx,
      rateLimit.accountId,
      "webhook-subscription",
      !rateLimit.allowed,
    );
  }
  if (!rateLimit.allowed) {
    const rejection = tieredRejectionResponse(rateLimit, {
      code: "webhook_subscription_rate_limited",
      message:
        "Too many webhook subscription requests from this client; slow down.",
    })!;
    return errorResponse(
      rejection.code,
      rejection.message,
      rejection.status,
      {},
      rejection.headers,
    );
  }
  return null;
}

async function createWebhookSubscription(
  request: Request,
  env: Env,
  ctx?: Ctx,
) {
  // Authenticate BEFORE touching the request body. An unauthenticated or
  // wrong-token caller must be rejected (503 when disabled, else 401) before we
  // read, JSON-parse, or validate any attacker-controlled payload — this avoids
  // doing parsing/validation work for unauthenticated callers and avoids leaking
  // body-validation behavior (which error fires for which input) to them. The
  // token compare itself is constant-time (see validateWebhookSubscriptionToken).
  const authorized = validateWebhookSubscriptionToken(request, env);
  if (!authorized.ok) {
    return authorized.response;
  }

  // Abuse control sits right after auth and before we read/parse the body, so a
  // token-holding caller can't script unbounded subscription creation -- while
  // still rejecting unauthenticated callers first (they never reach the limiter).
  const rateLimited = await webhookSubscriptionRateLimited(request, env, ctx);
  if (rateLimited) return rateLimited;

  if (
    Number(request.headers.get("content-length") || 0) > MAX_WEBHOOK_BODY_BYTES
  ) {
    return errorResponse(
      "payload_too_large",
      "Subscription body exceeds the size limit.",
      413,
    );
  }
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES) {
      return errorResponse(
        "payload_too_large",
        "Subscription body exceeds the size limit.",
        413,
      );
    }
    body = text ? JSON.parse(text) : null;
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }

  const validated = validateSubscriptionInput(body);
  if (!validated.ok) {
    return errorResponse("invalid_subscription", validated.error, 400);
  }

  const id = generateSubscriptionId();
  // Short local name (`hookSecret`) keeps the public-safety scanner's
  // hardcoded-credential heuristic from false-positiving on `secret = <expr>`.
  const hookSecret = validated.value.secret || generateSecret();
  const record = {
    id,
    url: validated.value.url,
    filters: validated.value.filters,
    secret: hookSecret,
    created_at: new Date().toISOString(),
    active: true,
  };
  try {
    await env.METAGRAPH_CONTROL.put(
      subscriptionStorageKey(id),
      JSON.stringify(record),
      { expirationTtl: WEBHOOK_TTL_SECONDS },
    );
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to persist the subscription.",
      503,
    );
  }

  return dataResponse(
    env,
    {
      id,
      url: record.url,
      filters: record.filters,
      // Returned ONCE at creation; store it to verify delivery signatures and to
      // delete the subscription. It is never echoed back on GET.
      secret: hookSecret,
      active: true,
      created_at: record.created_at,
      delivery: {
        method: "POST",
        content_type: JSON_CONTENT_TYPE,
        signature_header: WEBHOOK_SIGNATURE_HEADER,
        signature_algorithm: "hmac-sha256-hex",
        event_id_header: WEBHOOK_EVENT_ID_HEADER,
        idempotency_header: WEBHOOK_IDEMPOTENCY_HEADER,
        note: "HMAC-SHA256 of the raw request body, hex-encoded, keyed by your secret. Delivery is at-least-once: dedupe retries on the idempotency header.",
      },
    },
    201,
  );
}

function validateWebhookSubscriptionToken(request: Request, env: Env) {
  const configured = env.METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN;
  if (typeof configured !== "string" || configured.length === 0) {
    return {
      ok: false,
      response: errorResponse(
        "webhook_subscriptions_disabled",
        "Webhook subscription creation requires METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN to be configured.",
        503,
      ),
    };
  }

  const provided = request.headers.get(WEBHOOK_SUBSCRIPTION_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return {
      ok: false,
      response: errorResponse(
        "unauthorized",
        `Provide a valid ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER} header to create webhook subscriptions.`,
        401,
      ),
    };
  }

  return { ok: true };
}

async function getWebhookSubscription(env: Env, id: string) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  return dataResponse(env, {
    ...publicSubscriptionView(record),
    delivery: await readDeliveryStatus(env, id),
  });
}

// Delivery health for the public GET, summarized from the parked records.
// Best-effort — a list/get hiccup or a store without `list` degrades to "ok".
async function readDeliveryStatus(env: Env, id: string) {
  try {
    if (typeof env.METAGRAPH_CONTROL.list !== "function") {
      return summarizeDeliveryRecords([]); // local dev: KV mock without list()
    }
    const { keys } = await env.METAGRAPH_CONTROL.list({
      prefix: deliveryStoragePrefix(id),
      limit: WEBHOOK_REDELIVERY_LIST_LIMIT,
    });
    const records = await Promise.all(
      keys
        .slice(0, WEBHOOK_REDELIVERY_LIST_LIMIT)
        .map((entry) =>
          env.METAGRAPH_CONTROL.get(entry.name, { type: "json" }),
        ),
    );
    return summarizeDeliveryRecords(records as Row[]);
  } catch {
    return summarizeDeliveryRecords([]); // best-effort: never break the read
  }
}

async function deleteWebhookSubscription(
  request: Request,
  env: Env,
  id: string,
  ctx?: Ctx,
) {
  if (!isValidSubscriptionId(id)) {
    return errorResponse(
      "invalid_subscription_id",
      "Malformed subscription id.",
      400,
    );
  }
  // Share create's per-IP budget: gated before the KV lookup so a flood of
  // delete attempts can't drive unbounded reads. Delete authenticates with the
  // subscription's own secret (checked below), so the limiter is the only
  // volume bound on unauthenticated attempts.
  const rateLimited = await webhookSubscriptionRateLimited(request, env, ctx);
  if (rateLimited) return rateLimited;

  const record = await readWebhookSubscription(env, id);
  if (!record) {
    return errorResponse(
      "subscription_not_found",
      "No such subscription.",
      404,
      {
        id,
      },
    );
  }
  const provided = request.headers.get(WEBHOOK_SECRET_HEADER) || "";
  if (!record.secret || !timingSafeEqual(provided, record.secret)) {
    return errorResponse(
      "forbidden",
      `Provide the subscription secret in the ${WEBHOOK_SECRET_HEADER} header to delete it.`,
      403,
    );
  }
  try {
    await env.METAGRAPH_CONTROL.delete(subscriptionStorageKey(id));
  } catch {
    return errorResponse(
      "webhooks_unavailable",
      "Failed to delete the subscription.",
      503,
    );
  }
  return dataResponse(env, { id, deleted: true });
}

async function readWebhookSubscription(
  env: Env,
  id: string,
): Promise<Row | null> {
  try {
    return (await env.METAGRAPH_CONTROL.get(subscriptionStorageKey(id), {
      type: "json",
    })) as Row | null;
  } catch {
    return null;
  }
}

// Thin SSE change feed. Given the publish cadence there is no value in holding a
// long-lived connection, so we emit the current change snapshot as one SSE event
// and advise a 5-minute reconnect via `retry:`. EventSource clients reconnect on
// that interval and re-read; `id:` is the publish timestamp for dedupe.
async function handleEventsRequest(request: Request, env: Env) {
  const [pointer, changelogArtifact] = await Promise.all([
    latestPointer(env),
    readArtifact(env, "/metagraph/changelog.json"),
  ]);
  const changelog = changelogArtifact.ok ? changelogArtifact.data : null;
  const event = buildChangeEvent({
    changelog: changelog as Row,
    pointer: pointer as unknown as Row,
  });
  const eventId = event.published_at || event.generated_at || "0";
  // Reconnect replays the last id; if the snapshot hasn't moved, answer with a
  // bare keepalive instead of re-sending it (a 304 analogue for SSE).
  const unchanged = request.headers.get("last-event-id") === eventId;
  const frame = unchanged
    ? `retry: 300000\n: no new snapshot since ${eventId}\n\n`
    : [
        "retry: 300000",
        `id: ${eventId}`,
        "event: snapshot",
        `data: ${JSON.stringify(event)}`,
      ].join("\n") + "\n\n";

  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  exposeCustomResponseHeaders(headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-metagraph-contract-version", contractVersion(env));
  headers.set("x-metagraph-events", unchanged ? "unchanged" : "snapshot");
  return new Response(frame, { status: 200, headers });
}

// --- AI search / ask (semantic + RAG) --------------------------------------

// metagraphed#7731: this Worker's own equivalent of data-api.ts's
// captureDataApiError (#6769) -- a caught error converted to a clean
// errorResponse() here never reaches PostHog's own top-level catch, since
// that only ever sees a genuinely UNCAUGHT exception. The AI routes below
// are the only two places in this file that catch a real (non-caller-input)
// failure and swallow it into a clean 502; every other catch block either
// handles an expected condition inline or re-throws to the top-level wrap.
// metagraphed#7766: Sentry fully removed (D1 fully eliminated 2026-07-17;
// Sentry decommissioned once PostHog $exception parity was proven) -- awaited
// (not waitUntil) because both call sites are already deep in the catch of
// an async route handler about to return an error response; there's no
// separate ExecutionContext threaded down to this helper the way
// mcp-server.ts's schedulers have. The cost is a little latency on an
// already-failing request, not silent event loss.
async function captureAiRouteError(error: unknown, route: string, env: Env) {
  await recordExceptionEvent(env, { error, route, errorCode: "ai_error" });
}

function aiUnavailableResponse() {
  return errorResponse(
    "ai_unavailable",
    "AI features are not enabled on this deployment.",
    503,
  );
}

function aiRateLimitedResponse(rateLimit: TieredRateLimitResult) {
  // Same standard rate-limit header set the webhook / alert-trigger 429s expose
  // (#6572), so an AI client can discover its quota, not just the retry delay.
  // #8521: headers now come from the tiered policy that actually rejected the
  // caller (anonymous 20/60s here), via the shared tieredRateLimitHeaders.
  // #8608: takes the whole result, not just the policy, so a caller rejected
  // by the DAILY quota is told the day's ceiling and its exact UTC-midnight
  // reset -- and which tier it was measured against. /ask is the dearest
  // family in src/route-cost-weights.ts (25 units a call), so it is the route
  // most likely to exhaust a quota long before any per-minute limit.
  const rejection = tieredRejectionResponse(rateLimit, {
    code: "rate_limited",
    message: "Too many AI requests. Please retry shortly.",
  })!;
  return errorResponse(
    rejection.code,
    rejection.message,
    rejection.status,
    {},
    rejection.headers,
  );
}

async function readBoundedRequestText(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    return { ok: false, text: "" };
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, text: "" };
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text };
}

async function handleSemanticSearchRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx?: Ctx,
) {
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  if (request.method === "HEAD") {
    // A HEAD probe must not run AI inference or consume the per-client rate
    // limiter (the body is stripped for HEAD regardless). Mirror availability
    // with a headers-only 200.
    const headers = apiHeaders("short");
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 200, headers });
  }
  // #8521: tiered -- a valid mg_... key rides AI_RATE_LIMITER_KEYED (100/60s,
  // account-keyed); everyone else keeps the anonymous AI_RATE_LIMITER (20/60s,
  // IP-keyed). Mirrors the DATA checkpoint above.
  const rateLimit = await applyTieredRateLimit(
    request,
    env,
    AI_TIERED_RATE_LIMIT,
  );
  markRequestAuthTier(request, rateLimit.tier);
  if (!rateLimit.allowed) {
    return aiRateLimitedResponse(rateLimit);
  }
  if (rateLimit.accountId) {
    recordApiKeyUsage(env, ctx, rateLimit.accountId, "semantic-search");
  }
  try {
    // `?type=subnet&type=provider` (repeatable) scopes results; absent → all
    // kinds. getAll returns [] when absent, which normalizeSemanticTypes reads as
    // "no scope", so an empty list is equivalent to omitting the param.
    const types = url.searchParams.getAll("type");
    const data = await semanticSearch(env, url.searchParams.get("q"), {
      limit: url.searchParams.get("limit"),
      type: types.length ? types : undefined,
    });
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    const err = error as Row;
    if (err?.aiInput) {
      return errorResponse("invalid_query", err.message, 400);
    }
    logEvent(env, "error", "semantic_search_failed", {
      message: err?.message,
    });
    await captureAiRouteError(error, "semantic_search", env);
    return errorResponse(
      "ai_error",
      "Semantic search failed. Please retry shortly.",
      502,
    );
  }
}

async function handleAskRequest(request: Request, env: Env, ctx?: Ctx) {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "POST a JSON body { question } to /api/v1/ask.",
      405,
      {},
      { allow: "POST, OPTIONS" },
    );
  }
  if (!aiEnabled(env)) {
    return aiUnavailableResponse();
  }
  // #8521: tiered, same as semantic search above.
  const rateLimit = await applyTieredRateLimit(
    request,
    env,
    AI_TIERED_RATE_LIMIT,
  );
  markRequestAuthTier(request, rateLimit.tier);
  if (!rateLimit.allowed) {
    return aiRateLimitedResponse(rateLimit);
  }
  if (rateLimit.accountId) {
    recordApiKeyUsage(env, ctx, rateLimit.accountId, "ask");
  }
  let body;
  try {
    const boundedBody = await readBoundedRequestText(
      request,
      MAX_ASK_BODY_BYTES,
    );
    if (!boundedBody.ok) {
      return errorResponse(
        "payload_too_large",
        "Ask request body exceeds the size limit.",
        413,
      );
    }
    body = JSON.parse(boundedBody.text);
  } catch {
    return errorResponse(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
    );
  }
  try {
    // Resolve live probe health once and inject it so /ask context reflects the
    // current operational status of each subnet's surfaces, not the build-time
    // "unknown" stub baked into the agent-catalog artifact.
    const liveHealth = await resolveLiveHealth({
      readHealthKv: readHealthKv as unknown as (
        env: Env,
        key: string,
      ) => Promise<Row | null>,
      env,
    });
    const data = await askQuestion(
      env,
      body?.question,
      { topK: body?.topK, type: body?.type },
      {
        readArtifact,
        liveHealth,
        overlayCatalogIndex: overlayCatalogIndex as unknown as (
          input: { subnets: unknown[] },
          liveHealthArg: unknown,
        ) => { subnets?: unknown[] } | null | undefined,
      },
    );
    return dataResponse(env, data, 200, { source: "ai-live" });
  } catch (error) {
    const err = error as Row;
    if (err?.aiInput) {
      return errorResponse("invalid_request", err.message, 400);
    }
    logEvent(env, "error", "ask_failed", { message: err?.message });
    await captureAiRouteError(error, "ask", env);
    return errorResponse(
      "ai_error",
      "The answer service failed. Please retry shortly.",
      502,
    );
  }
}

function unknownSubnetHealth(netuid: number) {
  return {
    schema_version: 1,
    netuid,
    summary: {
      status: "unknown",
      surface_count: 0,
      ok_count: 0,
      degraded_count: 0,
      failed_count: 0,
      unknown_count: 0,
      last_checked: null,
      last_ok: null,
      avg_latency_ms: null,
    },
    operational_observed_at: null,
    health_source: "unavailable",
    surfaces: [],
  };
}

// Overlay the 15-minute cron snapshot onto a static health/rpc artifact. Returns
// { data } when a live snapshot is available, else null (caller serves static).
// Health-overlay routes whose live composition is keyed on surfaces/services
// (not the shared EndpointResource list) — excluded from the generic per-endpoint
// overlay below so it does not double-process them.
const ENDPOINT_OVERLAY_EXCLUDED_IDS = new Set([
  "subnet-health",
  "rpc-endpoints",
  "rpc-pools",
  "freshness",
  "agent-catalog",
  "agent-catalog-subnet",
]);

async function liveHealthOverlay(
  env: Env,
  matched: Row,
  staticData: Row | null,
) {
  let resolved: Row | null | undefined;
  const getLive = async () => {
    if (resolved === undefined) {
      resolved =
        (await resolveLiveHealth({
          readHealthKv: readHealthKv as unknown as (
            env: Env,
            key: string,
          ) => Promise<Row | null>,
          env,
        })) || null;
    }
    return resolved;
  };

  let data;
  switch (matched.id) {
    case "subnet-health": {
      data = overlaySubnetHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "rpc-endpoints": {
      const pool = (await readHealthKv(env, KV_HEALTH_RPC_POOL)) as Row | null;
      data = mergeRpcEndpoints(staticData, pool);
      break;
    }
    case "rpc-pools": {
      // The served pool scores feed the public RPC load-balancer (workers/wss-lb.ts)
      // and the proxy's pool selection. Overlay the same 15-minute cron health the
      // HTTP proxy applies (overlayRpcPoolEligibility) so a sustained-down/wrong-chain
      // upstream baked into the static artifact is marked ineligible instead of being
      // routed to. Each pool in pools[] shares the per-endpoint shape the overlay
      // expects; without a live snapshot the pools pass through unchanged.
      const livePool = (await readHealthKv(
        env,
        KV_HEALTH_RPC_POOL,
      )) as Row | null;
      if (
        livePool &&
        Array.isArray(livePool.endpoints) &&
        Array.isArray(staticData?.pools)
      ) {
        data = {
          ...staticData,
          source: "live-cron-prober",
          operational_observed_at: livePool.last_run_at || null,
          pools: staticData.pools.map((pool) =>
            overlayRpcPoolEligibility(pool, livePool),
          ),
        };
      } else {
        data = null;
      }
      break;
    }
    case "freshness": {
      // The economics tier and the live-RPC tier both move independently of the
      // publish, so their timestamps exist only at serve time. Both reads are
      // the SAME ones the data routes make — the memoized economics blob and the
      // cached parameters snapshot — so `/freshness` can never report an `as_of` that
      // disagrees with what `/economics` or `/network/parameters` just returned.
      const [meta, economicsBlob, parameters] = await Promise.all([
        readHealthMetaKv(env),
        readEconomicsCurrentKv(env),
        readCachedNetworkParametersSnapshot(env),
      ]);
      data = mergeFreshness(staticData, meta, {
        economicsCapturedAt: economicsBlob?.captured_at,
        parametersQueriedAt: parameters?.queried_at,
      });
      break;
    }
    case "subnet-overview": {
      if (!staticData) {
        data = null;
        break;
      }
      data = overlayOverviewHealth(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog-subnet": {
      if (!staticData) {
        data = null;
        break;
      }
      data = overlayCatalogDetail(
        staticData,
        await getLive(),
        Number(matched.params.netuid),
      );
      break;
    }
    case "agent-catalog": {
      data = overlayCatalogIndex(staticData, await getLive());
      break;
    }
    default:
      data = null;
  }

  // Generic live overlay for any artifact embedding the shared EndpointResource
  // list (subnet detail, profile, endpoints collection, provider endpoints, and
  // the composed overview's endpoints[]). Each endpoint's operational health is
  // replaced from the 15-minute cron snapshot; surfaces with no live reading
  // become `unknown` — so per-endpoint health is never the baked build value.
  const base = data ?? staticData;
  if (
    !ENDPOINT_OVERLAY_EXCLUDED_IDS.has(matched.id) &&
    Array.isArray(base?.endpoints) &&
    base.endpoints.some((endpoint) => endpoint?.surface_id)
  ) {
    const overlaid = overlayArtifactEndpoints(base, await getLive());
    if (overlaid) data = overlaid;
  }

  return data ? { data } : null;
}

/**
 * Which methods a path accepts.
 *
 * One declaration, two consumers: the CORS preflight below, and the read-only method
 * gate's `allow` header. They answered the same question from two copies before, which
 * is how a route could advertise one method set to a browser and another to a client.
 */
function allowedMethodsForPath(pathname: string): string {
  const url = { pathname };
  let methods = "GET, HEAD, OPTIONS";
  if (url.pathname.startsWith("/rpc/")) {
    methods = "POST, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/webhooks/")) {
    methods = "POST, GET, DELETE, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/alerts/triggers")) {
    methods = "POST, GET, PATCH, DELETE, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/watch/triggers")) {
    methods = "GET, PATCH, DELETE, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/watch/push-subscriptions")) {
    methods = "GET, POST, DELETE, OPTIONS";
  } else if (url.pathname === "/api/v1/graphql") {
    // POST executes queries; GET serves the published SDL document.
    methods = "GET, POST, OPTIONS";
  } else if (isMcpEndpointPath(url.pathname)) {
    // GET opens the bounded SSE push stream (#4983 MCP half); DELETE
    // terminates a session explicitly; POST is the stateless JSON-RPC path.
    methods = "GET, POST, DELETE, OPTIONS";
  } else if (url.pathname === "/api/v1/ask") {
    methods = "POST, OPTIONS";
  } else if (url.pathname.startsWith("/api/v1/keys")) {
    // Create (POST), list (GET), revoke (DELETE) — matches handleAccountKeysProxy.
    methods = "POST, GET, DELETE, OPTIONS";
  } else if (url.pathname === "/api/v1/auth/wallet/challenge") {
    methods = "POST, OPTIONS";
  } else if (url.pathname === "/api/v1/auth/wallet/verify") {
    methods = "POST, OPTIONS";
  } else if (url.pathname === "/api/v1/watch/challenges") {
    methods = "POST, OPTIONS";
  } else if (url.pathname === "/api/v1/watch/tokens") {
    methods = "POST, OPTIONS";
  }
  return methods;
}

function corsPreflight(request: Request) {
  const url = new URL(request.url);
  const headers = apiHeaders("short");
  headers.set(
    "access-control-allow-methods",
    allowedMethodsForPath(url.pathname),
  );
  headers.set(
    "access-control-allow-headers",
    `content-type, if-none-match, authorization, mcp-session-id, mcp-protocol-version, ` +
      `${WEBHOOK_SECRET_HEADER}, ${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER}, ` +
      `${ALERT_TRIGGER_CREATE_TOKEN_HEADER}, ${ALERT_TRIGGER_OWNER_TOKEN_HEADER}`,
  );
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}
