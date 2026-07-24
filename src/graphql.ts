import {
  GraphQLError,
  buildSchema,
  execute,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import * as Sentry from "@sentry/cloudflare";
import { readArtifact, readHealthKv } from "../workers/storage.ts";
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
// #7171: GraphQL parity for GET /api/v1/chain-events (paginated Query feed),
// reusing loadChainEventsFeed that MCP list_chain_events already calls.
// Distinct from Subscription.chainEvents (live WebSocket firehose).
// #7432: GraphQL parity for GET /api/v1/chain-events/stats (the aggregate
// sibling), reusing loadChainActivity + optionalBlocksWindow that MCP's
// get_chain_activity already calls — both relocated here from mcp-server.mjs.
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
import { tryPostgresTier } from "../workers/postgres-tier.ts";
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
// #7886: GraphQL parity for GET /api/v1/rpc/endpoints filters — reuse
// loadRpcEndpointsList (live overlay + applyQueryFilters on the endpoints
// collection), matching endpoint_pools / rpc_pools / provider_endpoints.
import { loadRpcEndpointsList } from "./rpc-endpoints-mcp.ts";
// #7888: GraphQL parity for GET /api/v1/providers list filters (id/kind/
// authority/sort/order/fields + limit/cursor), reusing loadProvidersList that
// MCP list_providers already calls -- not a reimplementation.
import { loadProvidersList } from "./providers-mcp.ts";
// #7167: GraphQL parity for the /api/v1/review/* contributor-review family,
// reusing each list_* MCP loader unchanged (same artifact read, filter, sort,
// and page logic REST and MCP already use) -- not a reimplementation.
import { loadAdapterCandidatesList } from "./adapter-candidates-mcp.ts";
import { loadEnrichmentEvidenceList } from "./enrichment-evidence-mcp.ts";
import { loadEnrichmentQueueList } from "./enrichment-queue-mcp.ts";
import { loadReviewEnrichmentTargetsList } from "./review-enrichment-targets-mcp.ts";
// #7878: GraphQL parity for GET /api/v1/subnets/{netuid}/candidates, reusing
// loadSubnetCandidatesList that MCP list_subnet_candidates already calls
// (#7899) -- not a reimplementation.
import { loadSubnetCandidatesList } from "./subnet-candidates-mcp.ts";
// #7879: GraphQL parity for GET /api/v1/subnets/{netuid}/evidence, reusing
// loadSubnetEvidenceList that MCP list_subnet_evidence already calls -- not a
// reimplementation.
import { loadSubnetEvidenceList } from "./subnet-evidence-mcp.ts";
import { loadReviewGapsList } from "./review-gaps-mcp.ts";
import { loadProfileCompletenessList } from "./profile-completeness-mcp.ts";
// #6984: GraphQL parity for GET /api/v1/adapters/{slug}, reusing loadAdapter that
// MCP get_adapter already calls (#3255) -- not a reimplementation.
import { loadAdapter } from "./adapters-mcp.ts";
// #7170: GraphQL parity for the changelog/contracts/health-history REST routes,
// reusing the same loaders MCP get_changelog/get_contracts/get_health_history
// already call -- not a reimplementation.
import { loadChangelog } from "./changelog-mcp.ts";
import { loadContracts } from "./contracts-mcp.ts";
// #7431: GraphQL parity for GET /api/v1/build, reusing loadBuildSummary that
// MCP get_build already calls -- not a reimplementation.
import { loadBuildSummary } from "./build-mcp.ts";
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
  buildSubnetWeightSetters,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
} from "./subnet-weight-setters.ts";
import {
  buildSubnetYield,
  buildSubnetYieldHistory,
  YIELD_HISTORY_WINDOWS,
  DEFAULT_YIELD_HISTORY_WINDOW,
} from "./subnet-yield.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
  PERFORMANCE_HISTORY_WINDOWS,
  DEFAULT_PERFORMANCE_HISTORY_WINDOW,
} from "./subnet-performance.ts";
import {
  buildConcentration,
  buildConcentrationHistory,
  CONCENTRATION_HISTORY_WINDOWS,
  DEFAULT_CONCENTRATION_HISTORY_WINDOW,
} from "./concentration.ts";
import {
  analyticsWindow,
  loadGlobalIncidentsLedger,
} from "../workers/request-handlers/analytics.ts";
import {
  BLOCK_PAGINATION,
  DAY_PATTERN,
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.ts";
import { buildSubnetIdentityHistory } from "./subnet-identity-history.ts";
import { buildChainIdentityHistory } from "./chain-identity-history.ts";
import {
  buildGlobalHealth,
  formatLeaderboards,
  LEADERBOARD_BOARDS,
  loadSubnetTrajectory,
  mergeFreshness,
  overlayOverviewHealth,
  loadSubnetReliability,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlaySubnetHealth,
  resolveLiveEconomics,
  resolveLiveHealth,
  subnetBadgeStatus,
} from "./health-serving.ts";
import { loadSubnetProfile } from "./profiles-mcp.ts";
import {
  buildTopHoldersList,
  DEFAULT_TOP_HOLDERS_SORT,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
  TOP_HOLDERS_SORTS,
} from "./top-holders.ts";
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
import { UPTIME_WINDOWS } from "../workers/config.ts";
import {
  buildAccountExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
  buildBlockExtrinsics,
} from "./extrinsics.ts";
import { buildBlock, buildBlockFeed } from "./blocks.ts";
import { loadBlockChainEvents } from "./data-api-mcp.ts";
import { buildBlocksSummary } from "./blocks-summary.ts";
import { buildRuntimeVersionHistory } from "./runtime-versions.ts";
import { buildChainYield } from "./chain-yield.ts";
import { loadSubnetRecycled, isU16Netuid } from "./subnet-recycled.ts";
import { loadSubnetBurn } from "./subnet-burn.ts";
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
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "./account-weight-setters.ts";
import {
  ENTITY_LABELS_ARTIFACT,
  buildAccountEntities,
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
  DEFAULT_GLOBAL_VALIDATOR_SORT,
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
import { CURATION_ARTIFACT } from "./curation-mcp.ts";
import { buildDomainOverview, buildDomainSummary } from "./domain-summary.ts";
import { DOMAIN_TAGS } from "./domain-tags.ts";
import {
  buildSubnetOhlc,
  OHLC_INTERVALS,
  OHLC_INTERVAL_DEFAULT,
  DEFAULT_OHLC_WINDOW_DAYS,
  MAX_OHLC_WINDOW_DAYS,
} from "./subnet-ohlc.ts";
import { computeStakeQuote, STAKE_QUOTE_DIRECTIONS } from "./stake-quote.ts";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  ACCOUNTS_LIST_SORTS,
  DEFAULT_ACCOUNTS_LIST_SORT,
  buildAccountsList,
} from "./accounts-list.ts";
import {
  buildAccountEvents,
  buildSubnetEvents,
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
  PROMETHEUS_WINDOWS,
  buildAccountPrometheus,
} from "./account-prometheus.ts";
import {
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_FLOW_WINDOWS,
  buildAccountStakeFlow,
} from "./account-stake-flow.ts";
import { buildAccountPositionHistory } from "./account-position-history.ts";
import {
  DEFAULT_STAKE_FLOW_DIRECTION,
  STAKE_FLOW_DIRECTIONS,
  buildStakeFlow,
} from "./stake-flow.ts";
import { buildAccountPortfolio } from "./account-portfolio.ts";
import { buildAccountPositions } from "./account-nominator-positions.ts";
import {
  buildAccountRegistrations,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "./account-registrations.ts";
import {
  buildAccountDeregistrations,
  DEREGISTRATION_WINDOWS,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "./account-deregistrations.ts";
import {
  buildAccountServing,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "./account-serving.ts";
import {
  buildAccountAxonRemovals,
  AXON_REMOVAL_WINDOWS,
  DEFAULT_AXON_REMOVAL_WINDOW,
} from "./account-axon-removals.ts";
import {
  buildAccountStakeMoves,
  ACCOUNT_STAKE_MOVES_WINDOWS,
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
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  SS58_ADDRESS_PATTERN,
} from "../workers/config.ts";
import { loadRpcUsage } from "./rpc-usage-loader.ts";
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
import { buildValidatorHistory } from "./validator-history.ts";
import { loadEconomicsTrends } from "./economics-trends.ts";
import {
  DEFAULT_MOVERS_SORT,
  DEFAULT_MOVERS_WINDOW,
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
  MOVERS_SORTS,
  MOVERS_WINDOWS,
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
} from "./chain-analytics.ts";
import { buildChainPerformance } from "./chain-performance.ts";
import { buildChainConcentration } from "./concentration.ts";
import {
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  buildValidatorNominators,
  NOMINATOR_SORTS,
  NOMINATOR_WINDOWS,
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
  CHAIN_TRANSFER_PAIR_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
} from "./chain-transfer-pairs.ts";
import { loadBulkHealthTrends } from "./bulk-health-trends.ts";
import { SDL } from "./graphql-sdl.ts";
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
  QueryEconomicsArgs,
  QuerySubnetArgs,
  QuerySubnetsArgs,
  QuerySubnet_HealthArgs,
  QuerySubnet_Stake_QuoteArgs,
} from "../generated/graphql/types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// The MCP loaders' ctx parameter requires a readArtifact field, but every
// call site in this file supplies readArtifact through the loaders' own deps
// override (`read = deps.readArtifact ?? ctx.readArtifact`), so ctx.readArtifact
// is never dereferenced here. This cast bridges that gap without weakening the
// loaders' own signatures.
const mcpCtx = (context: GqlContext) =>
  context as GqlContext & {
    readArtifact: (env: Env, path: string) => ReturnType<typeof readArtifact>;
  };

// The contextValue handleGraphQLRequest passes to execute() (env + a
// per-request memo Map + the raw Request), plus the extra fields the
// graphql-ws subscription path stamps on (clientIp/graphqlWsConnection) and
// the Sentry hook. Kept loose (all optional except env) because different
// entry points populate different subsets. Exported (types-epic D, #7862)
// as the `contextType` graphql-codegen's typescript-resolvers plugin is
// configured against.
export interface GqlContext {
  env: Env;
  cache: Map<string, unknown>;
  request?: Request;
  clientIp?: string | null;
  graphqlWsConnection?: unknown;
  chainFirehose?: unknown;
  reportError?: (err: unknown) => void;
}

export const GRAPHQL_MAX_DEPTH = 7;
export const GRAPHQL_MAX_COMPLEXITY = 50;
export const GRAPHQL_MAX_BODY_BYTES = 64 * 1024;
export const GRAPHQL_MAX_QUERY_BYTES = 16 * 1024;

// SDL moved to src/graphql-sdl.ts (types-epic D, #7862) so @graphql-codegen
// can import it without pulling in this file's full resolver map. Re-exported
// so every existing `import { SDL } from "./graphql.ts"` keeps working.
export { SDL };

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
schema.getSubscriptionType()!.getFields().chainEvents.subscribe =
  async function* chainEventsSubscribe(
    _source: unknown,
    args: Row,
    context: Row,
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
  adapter: RELATIONSHIP_FIELD_COMPLEXITY,
  economics: RELATIONSHIP_FIELD_COMPLEXITY,
  surfaces: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  provider_endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoint_pools: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_pools: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoint_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  source_snapshots: RELATIONSHIP_FIELD_COMPLEXITY,
  gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  block_extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  block_events: RELATIONSHIP_FIELD_COMPLEXITY,
  block_chain_events: RELATIONSHIP_FIELD_COMPLEXITY,
  profiles: RELATIONSHIP_FIELD_COMPLEXITY,
  review_adapter_candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_queue: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_targets: RELATIONSHIP_FIELD_COMPLEXITY,
  review_gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  review_profile_completeness: RELATIONSHIP_FIELD_COMPLEXITY,
  registry_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  source_health: RELATIONSHIP_FIELD_COMPLEXITY,
  lineage: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  changelog: RELATIONSHIP_FIELD_COMPLEXITY,
  contracts: RELATIONSHIP_FIELD_COMPLEXITY,
  build: RELATIONSHIP_FIELD_COMPLEXITY,
  health_history: RELATIONSHIP_FIELD_COMPLEXITY,
  health: RELATIONSHIP_FIELD_COMPLEXITY,
  opportunity_boards: RELATIONSHIP_FIELD_COMPLEXITY,
  compare: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_events: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_events_stats: RELATIONSHIP_FIELD_COMPLEXITY,
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
  subnet_health_percentiles: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health: RELATIONSHIP_FIELD_COMPLEXITY,
  agent_resources: RELATIONSHIP_FIELD_COMPLEXITY,
  curation: RELATIONSHIP_FIELD_COMPLEXITY,
  candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  saved_query: RELATIONSHIP_FIELD_COMPLEXITY,
  fixtures: RELATIONSHIP_FIELD_COMPLEXITY,
  agent_catalog: RELATIONSHIP_FIELD_COMPLEXITY,
  freshness: RELATIONSHIP_FIELD_COMPLEXITY,
  top_holders: RELATIONSHIP_FIELD_COMPLEXITY,
  search: RELATIONSHIP_FIELD_COMPLEXITY,
  search_index: RELATIONSHIP_FIELD_COMPLEXITY,
  domains: RELATIONSHIP_FIELD_COMPLEXITY,
  domain_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  compare_validators: RELATIONSHIP_FIELD_COMPLEXITY,
  coverage: RELATIONSHIP_FIELD_COMPLEXITY,
  schemas: RELATIONSHIP_FIELD_COMPLEXITY,
  coverage_depth: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_volume: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_ohlc: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_quote: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_validators: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_event_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_idle_stake: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_events: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration_history: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_trajectory: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_metagraph: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_overview: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_profile: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  global_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  runtime: RELATIONSHIP_FIELD_COMPLEXITY,
  block: RELATIONSHIP_FIELD_COMPLEXITY,
  economics_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_movers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_ownership_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_conviction: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_lease_history: RELATIONSHIP_FIELD_COMPLEXITY,
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
  chain_idle_stake: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_transfer_pairs: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  account_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  account_position_history: RELATIONSHIP_FIELD_COMPLEXITY,
  account_portfolio: RELATIONSHIP_FIELD_COMPLEXITY,
  account_positions: RELATIONSHIP_FIELD_COMPLEXITY,
  account_subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  account_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  account_entities: RELATIONSHIP_FIELD_COMPLEXITY,
  // Fans out into leaderboardProfilesProjection plus several D1 reads and the
  // economics tier -- same cost class as the other relationship fields.
  registry_leaderboards: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_recycled: LIVE_RPC_FIELD_COMPLEXITY,
  subnet_burn: LIVE_RPC_FIELD_COMPLEXITY,
  subnet_lease: LIVE_RPC_FIELD_COMPLEXITY,
  account_balance: LIVE_RPC_FIELD_COMPLEXITY,
  account_root_claim: LIVE_RPC_FIELD_COMPLEXITY,
  account_children: LIVE_RPC_FIELD_COMPLEXITY,
  account_parents: LIVE_RPC_FIELD_COMPLEXITY,
  sudo_key: LIVE_RPC_FIELD_COMPLEXITY,
  network_parameters: LIVE_RPC_FIELD_COMPLEXITY,
  network_randomness: LIVE_RPC_FIELD_COMPLEXITY,
  randomness_status: LIVE_RPC_FIELD_COMPLEXITY,
  evm_address: LIVE_RPC_FIELD_COMPLEXITY,
  evm_address_mapping: LIVE_RPC_FIELD_COMPLEXITY,
};

function fieldComplexity(fieldName: string) {
  return (
    (FIELD_COMPLEXITY as Record<string, number>)[fieldName] ??
    DEFAULT_FIELD_COMPLEXITY
  );
}

// --- Validation rules ---

function buildFragmentMap(documentNode: Row) {
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
function isIntrospectionRootField(sel: Row) {
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
function selectionDepth(
  selectionSet: Row,
  fragments: Map<string, Row>,
  visited: Set<string>,
  memo: Map<string, number>,
  max: number,
) {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: depth 0
    let depth = 0;
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          depth = memo.get(fragName)!;
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

export function maxDepthRule(max: number) {
  return (context: Row) => ({
    Document: {
      leave(node: Row) {
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

function selectionComplexity(
  selectionSet: Row,
  fragments: Map<string, Row>,
  visited: Set<string>,
  memo: Map<string, number>,
  max: number,
) {
  let count = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: no complexity cost
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          count += memo.get(fragName)!;
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

export function maxComplexityRule(max: number) {
  return (context: Row) => ({
    Document: {
      leave(node: Row) {
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

function paginate(
  items: Row[],
  limit: unknown,
  cursor: unknown,
  keyFn: (row: Row) => unknown,
) {
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
    const idx = items.findIndex((item: Row) => String(keyFn(item)) === cursor);
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
  search: "/metagraph/search.json",
  searchIndex: "/metagraph/search-index.json",
};
const LIVE_HEALTH_KEY = "live:health";
const LIVE_ECONOMICS_KEY = "live:economics";

// Resolve an async value at most once per query: a page of subnets each pulling
// a relationship shares one read of each registry artifact (and one live health
// snapshot). The promise is cached so concurrent thunks collapse onto one read.
function once(
  context: GqlContext,
  key: string,
  load: AnyFn,
): Promise<Row | null> {
  let pending = context.cache.get(key);
  if (!pending) {
    pending = load();
    context.cache.set(key, pending);
  }
  return pending as Promise<Row | null>;
}

// Artifact data, or null when cold/absent — resolvers degrade to empty shapes
// rather than erroring, like the REST handlers.
function loadArtifact(context: GqlContext, path: string) {
  return once(context, path, () =>
    readArtifact(context.env, path).then((res) => (res.ok ? res.data : null)),
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
  const rows = data?.[key];
  if (!Array.isArray(rows)) return [];
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
function loadEconomics(context: GqlContext) {
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
async function loadEconomicsRows(context: GqlContext) {
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
function postgresTierRequest(
  context: GqlContext,
  pathname: string,
  params?: Row,
) {
  const pgUrl = new URL((context.request as Request).url);
  pgUrl.pathname = pathname;
  pgUrl.search = params ? params.toString() : "";
  return new Request(pgUrl);
}

// #6978: the ownership-history/conviction/lease-history routes are
// Postgres-only all-events tier -- unlike every tryPostgresTier(flagName)
// call above, there is no D1 predecessor and so no per-table flag to gate on
// (workers/api.mjs forwards these three paths to DATA_API unconditionally).
// Mirrors MCP's own loadSubnetOwnershipHistory/loadSubnetConviction/
// loadSubnetLeaseHistory proxies (src/mcp-server.mjs) byte-for-byte;
// reimplemented here rather than imported since mcp-server.mjs already
// imports this file's handleGraphQLRequest and importing back would be
// circular.
async function fetchAllEventsTier(
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
  return response.json() as Promise<Row | null>;
}

// --- Node builders (attach lazy relationship resolvers to artifact rows) ---

// graphql-js' default field resolver invokes a source property when it is a
// function: `subnet.health(args, context, info)`. So a node is just the artifact
// row spread over lazy thunks for its relationships — scalar fields resolve
// straight off the row, relationships resolve on demand through the shared memo.
// `prefetch` lets the single-subnet path serve surfaces/endpoints from the
// detail artifact it already read; economics + health are not in that artifact.
function subnetNode(identity: Row, prefetch: Row = {}) {
  const netuid = identity.netuid;
  const bundledOr = (rows: Row[] | undefined, load: AnyFn) =>
    rows !== undefined
      ? () => rows ?? []
      : (_args: unknown, context: GqlContext) => load(context, netuid);
  return {
    ...identity,
    health: (_args: unknown, context: GqlContext) =>
      loadSubnetHealth(context, netuid),
    economics: (_args: unknown, context: GqlContext) =>
      loadSubnetEconomics(context, netuid),
    surfaces: bundledOr(prefetch.surfaces, loadSubnetSurfaces),
    endpoints: bundledOr(prefetch.endpoints, loadSubnetEndpoints),
  };
}

// formatExtrinsic's call_args is a decoded JS value (object/array/null), but
// the SDL exposes it as an opaque JSON-encoded String (no custom JSON scalar
// exists in this schema yet) -- stringify it here rather than letting
// graphql-js' default String serializer coerce the object via `String(...)`
// (which would silently produce "[object Object]").
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

function extrinsicNode(extrinsic: Row) {
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
function validatorNode(validator: Row) {
  return {
    ...validator,
    featured: validator.featured === true,
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
  const base = buildValidatorDetail([], hotkey);
  const raw = data && typeof data === "object" ? data : {};
  return validatorNode({
    ...base,
    ...raw,
    hotkey:
      typeof raw.hotkey === "string" && raw.hotkey.length > 0
        ? raw.hotkey
        : hotkey,
    subnets: Array.isArray(raw.subnets) ? raw.subnets : base.subnets,
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

function providerNode(provider: Row) {
  const netuids = provider?.netuids || [];
  return {
    ...provider,
    netuids,
    subnets: (_args: unknown, context: GqlContext) =>
      loadProviderSubnets(context, netuids),
    endpoints: (_args: unknown, context: GqlContext) =>
      loadProviderEndpoints(context, provider.id),
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
      mcpCtx(context),
      { slug },
      { readArtifact },
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
  return netuids
    .map((netuid: number) => byNetuid.get(netuid))
    .filter(Boolean)
    .map((row: Row) => subnetNode(row));
}

// --- Resolvers ---

// Case-insensitive categorical filters for Query.subnets (#6251) — mirrors REST
// /api/v1/subnets list-query semantics (workers/list-query.mjs filterRows +
// contracts subnets.arrayFilters.domain). Unrecognized values simply match zero
// rows; GraphQL does not 400 on bad filter tokens.
function matchesSubnetListFilters(
  row: Row,
  { status, subnet_type, domain, coverage_level, curation_level }: Row = {},
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
  context: GqlContext,
  path: string,
  key: string,
  { limit, cursor, keyFn, netuid, map, resultKey = "items", filterFn }: Row,
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

// Backs both evm_address and its get_evm_address_mapping-aligned alias
// evm_address_mapping (#7648), so the two fields cannot drift apart. Same
// H160_PATTERN validation the REST route + MCP get_evm_address_mapping use --
// a malformed address is a GraphQL BAD_USER_INPUT error, not a card. The read
// itself is live chain RPC, not the Postgres tier, reusing loadAddressMapping's
// own KV cache/TTL, matching REST's /evm/address/{h160} handler exactly; ss58 is
// null on an unresolved mapping (schema-stable), never a GraphQL error.
function resolveEvmAddressMapping(h160: string, context: GqlContext) {
  if (typeof h160 !== "string" || !H160_PATTERN.test(h160)) {
    throw new GraphQLError("h160 must be a 20-byte 0x-prefixed hex address.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return loadAddressMapping(context.env, h160);
}

// Row-erased: pending D batch N (types-epic D, #7862 tracks follow-up
// batches). Only the 5 Query fields with a Zod-covered REST mirror from
// types-epic A (subnets, subnet, subnet_health, subnet_stake_quote,
// economics) are typed against the generated Args types below; the
// remaining ~150 root fields on this object keep their `Row`-typed
// destructured params for now, adopted incrementally in later batches
// rather than all at once here.
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
    }: QuerySubnetsArgs,
    context: GqlContext,
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
      keyFn: (s: Row) => s.netuid,
      map: subnetNode,
      filterFn: hasCategoricalFilters
        ? (row: Row) =>
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

  async subnet({ netuid }: QuerySubnetArgs, context: GqlContext) {
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

  async subnet_hyperparameters({ netuid }: Row, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_SUBNET_HYPERPARAMS_SOURCE) -> buildSubnetHyperparams
    // fallback contract handleSubnetHyperparams uses. The D1 write path is retired, so a
    // cold tier is an expected steady state, not an error: it yields a schema-stable card
    // with hyperparameters:null rather than a GraphQL error or a 404.
    const data =
      ((await tryPostgresTier(
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

  async subnet_hyperparameters_history(
    { netuid, limit, offset, cursor }: Row,
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
      ((await tryPostgresTier(
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
    { netuid, validator_permit }: Row,
    context: GqlContext,
  ) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetMetagraph
    // fallback contract get_subnet_metagraph uses; a subnet with no indexed
    // neurons is a schema-stable empty metagraph, never a GraphQL error.
    const params = new URLSearchParams();
    if (validator_permit) params.set("validator_permit", "true");
    return (
      ((await tryPostgresTier(
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

  async subnet_overview({ netuid }: Row, context: GqlContext) {
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

  async subnet_profile({ netuid }: Row, context: GqlContext) {
    // Reuse loadSubnetProfile (the loader get_subnet_profile already calls)
    // unchanged; its deps.readArtifact is invoked as (ctx, path) -- exactly
    // loadArtifact's shape -- so the read shares the request-scoped once()
    // cache. Its only throw is an invalid netuid, which becomes BAD_USER_INPUT
    // (mirroring REST's invalid_params 400); an un-baked profile is null.
    try {
      return await loadSubnetProfile(mcpCtx(context), netuid, {
        readArtifact: loadArtifact as AnyFn,
      });
    } catch (rawErr) {
      const err = rawErr as Row;
      if (err?.profilesMcp) {
        throw new GraphQLError(err.message, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      throw err;
    }
  },

  // #6991: five registry-meta routes that had an MCP tool but no GraphQL
  // field. Each reads the same baked artifact (and applies the same overlay /
  // builder) its MCP tool does, so REST, MCP, and GraphQL can't drift.
  async candidates(
    { netuid, kind, provider, state, limit, cursor }: Row,
    context: GqlContext,
  ) {
    const data = await loadArtifact(context, "/metagraph/candidates.json");
    const all = Array.isArray(data?.candidates) ? data.candidates : [];
    const filtered = all.filter(
      (c: Row) =>
        (netuid == null || c.netuid === netuid) &&
        (kind == null || c.kind === kind) &&
        (provider == null || c.provider === provider) &&
        (state == null || c.state === state),
    );
    const { page, total, nextCursor } = paginate(
      filtered,
      limit,
      cursor,
      (c: Row) => c.id ?? c.key,
    );
    return { items: page, total, next_cursor: nextCursor };
  },

  fixtures(_args: unknown, context: GqlContext) {
    return loadArtifact(context, "/metagraph/fixtures.json");
  },

  async agent_catalog({ netuid }: Row, context: GqlContext) {
    const live = await loadLiveHealth(context);
    if (netuid == null) {
      const index = await loadArtifact(
        context,
        "/metagraph/agent-catalog.json",
      );
      return index && (overlayCatalogIndex(index, live) || index);
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

  async top_holders({ sort, limit }: Row, context: GqlContext) {
    // Same allowlist REST enforces -- an unknown sort is BAD_USER_INPUT rather
    // than silently falling back, mirroring the route's invalid_query 400.
    if (sort != null && !TOP_HOLDERS_SORTS.includes(sort)) {
      throw new GraphQLError(
        `sort must be one of: ${TOP_HOLDERS_SORTS.join(", ")}.`,
        {
          extensions: { code: "BAD_USER_INPUT" },
        },
      );
    }
    const safeSort = sort ?? DEFAULT_TOP_HOLDERS_SORT;
    const safeLimit = clampLimit(limit, {
      defaultLimit: TOP_HOLDERS_LIMIT_DEFAULT,
      maxLimit: TOP_HOLDERS_LIMIT_MAX,
    });
    const params = new URLSearchParams({
      sort: safeSort,
      limit: String(safeLimit),
    });
    return (
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/accounts/top-holders", params),
        "METAGRAPH_TOP_HOLDERS_SOURCE",
      )) as Row | null) ??
      buildTopHoldersList([], { sort: safeSort, limit: safeLimit })
    );
  },

  async subnet_trajectory({ netuid }: Row, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_SUBNET_SNAPSHOTS_SOURCE) -> loadSubnetTrajectory
    // fallback contract handleTrajectory uses; a subnet with no daily snapshots is
    // a schema-stable empty trajectory, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/trajectory`),
        "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
      )) as Row | null) ?? (await loadSubnetTrajectory(netuid));
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
        .map(([window, delta]) => ({ window, ...(delta as Row) })),
    };
  },

  async subnet_registrations({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/registrations`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetRegistrations(null, netuid, { window: windowParam });
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

  async subnet_deregistrations({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/deregistrations`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetDeregistrations(null, netuid, { window: windowParam });
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

  async subnet_serving({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/serving`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetServing(null, netuid, { window: windowParam });
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

  async subnet_axon_removals({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/axon-removals`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetAxonRemovals(null, netuid, { window: windowParam });
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

  async subnet_identity_history(
    { netuid, limit, offset, cursor }: Row,
    context: GqlContext,
  ) {
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
    // D1 retirement: subnet_identity_history's D1 write/read path is fully
    // retired (2026-07-16), so a Postgres miss/outage degrades straight to
    // the schema-stable empty timeline (entry_count 0), never a GraphQL
    // error and never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/identity-history`,
          params,
        ),
        "METAGRAPH_SUBNET_IDENTITY_SOURCE",
      )) as Row | null) ??
      buildSubnetIdentityHistory([], netuid, {
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
      entries: data.entries || [],
    };
  },

  async chain_identity_history({ limit }: Row, context: GqlContext) {
    // Same FEED_PAGINATION clamp REST applies. This chain-wide feed is
    // limit-only (no offset/cursor) -- the network view returns the most-recent
    // changes across every subnet in one pass.
    const safeLimit = clampLimit(limit, FEED_PAGINATION);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // D1 retirement: subnet_identity_history's D1 write path is retired
    // (2026-07-16), so a Postgres miss/outage degrades to a schema-stable
    // empty feed (count 0), never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/identity-history", params),
        "METAGRAPH_SUBNET_IDENTITY_SOURCE",
      )) as Row | null) ?? buildChainIdentityHistory([], { limit: safeLimit });
    return {
      schema_version: data.schema_version ?? 1,
      count: data.count ?? 0,
      subnet_count: data.subnet_count ?? 0,
      changes: data.changes || [],
    };
  },

  async subnet_performance({ netuid }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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

  async subnet_concentration({ netuid }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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
    { netuid, window }: Row,
    context: GqlContext,
  ) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetPerformanceHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryPostgresTier(
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

  async subnet_yield_history({ netuid, window }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetYieldHistory([])
    // empty-series fallback the neuron_daily-derived REST route + MCP tool use.
    const params = new URLSearchParams();
    params.set("window", windowParam);
    const data =
      ((await tryPostgresTier(
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

  async subnet_concentration_history(
    { netuid, window }: Row,
    context: GqlContext,
  ) {
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
      ((await tryPostgresTier(
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

  async neuron({ netuid, uid }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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

  async neuron_history({ netuid, uid, window }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildNeuronHistory([])
    // fallback contract handleNeuronHistory / MCP get_neuron_history use; a
    // UID with no neuron_daily rows in the window is a schema-stable
    // empty-points card, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/neurons/${uid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildNeuronHistory([], netuid, uid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      uid: data.uid ?? uid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async subnet_yield({ netuid }: Row, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetYield cold
    // fallback contract handleSubnetYield uses: a subnet with no neurons is a
    // schema-stable zeroed card, never a GraphQL error. No window param — the
    // route reads the CURRENT metagraph snapshot.
    const data =
      ((await tryPostgresTier(
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

  async subnet_weights({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/weights`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetWeights(null, netuid, { window: windowParam });
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

  async subnet_stake_moves({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/stake-moves`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetStakeMoves(null, netuid, { window: windowParam });
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

  async subnet_stake_transfers({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/stake-transfers`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetStakeTransfers(null, netuid, { window: windowParam });
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

  async subnet_idle_stake({ netuid }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetIdleStake([])
    // zeroed-card fallback handleSubnetIdleStake + the get_subnet_idle_stake MCP
    // tool use; a subnet with no neurons is a schema-stable zeroed card, never a
    // GraphQL error.
    const data =
      ((await tryPostgresTier(
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
      idle_stake_tao: data.idle_stake_tao ?? 0,
    };
  },

  async subnet_stake_flow(
    { netuid, window, direction }: Row,
    context: GqlContext,
  ) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    const directionParam = direction ?? DEFAULT_STAKE_FLOW_DIRECTION;
    if (!STAKE_FLOW_DIRECTIONS.includes(directionParam)) {
      throw new GraphQLError(
        `"${directionParam}" is not a valid direction. Supported: ${STAKE_FLOW_DIRECTIONS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", windowParam);
    params.set("direction", directionParam);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data } ->
    // buildStakeFlow([]) zeroed-card fallback handleSubnetStakeFlow uses;
    // direction only narrows the live query, so a cold tier degrades to the same
    // zeroed card the direction-less builder produces.
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/subnets/${netuid}/stake-flow`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      (tier?.data as Row | undefined) ??
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
    { netuid, kind, block_start, block_end, limit, offset }: Row,
    context: GqlContext,
  ) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) handleSubnetEvents and
    // the get_subnet_events MCP tool use; the account_events D1 write path is
    // retired (#4772), so a tier miss resolves through buildSubnetEvents over an
    // empty scan -- a schema-stable empty feed, never a GraphQL error. The events
    // list passes through whole; graphql's default resolver reads each AccountEvent
    // field, matching account_events' shaped rows.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/events`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetEvents([], netuid, {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
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

  async subnet_history({ netuid, window }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same parseHistoryWindow handleSubnetHistory + loadSubnetHistory (MCP) use,
    // so accepted window labels (7d/30d/90d/1y/all, default 30d) match exactly.
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetHistory([])
    // empty-series fallback handleSubnetHistory uses; a subnet with no daily
    // rollup is a schema-stable point_count:0 series, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildSubnetHistory([], netuid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points ?? [],
    };
  },

  async subnet_prometheus({ netuid, window }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildSubnetPrometheus(null) zeroed-card fallback handleSubnetPrometheus
    // uses; a subnet with no PrometheusServed events is a schema-stable zeroed
    // card, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/prometheus`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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
    };
  },

  async subnet_weight_setters({ netuid, window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/weights/setters`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetWeightSetters([], null, netuid, { window: windowParam });
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

  // #7888: add REST/MCP list-query filters (id/kind/authority/sort/order/fields)
  // by reusing loadProvidersList for validate+filter+sort, while preserving the
  // pre-existing GraphQL providers contract the gate flagged as a breaker on
  // #7920: opaque string id-keyset cursor/next_cursor (not REST's Int offset)
  // and schema-stable empty list on a cold/absent artifact (not a GraphQL
  // error). limit/cursor are applied here via paginate, not the loader.
  async providers(args: Row, context: GqlContext) {
    const { limit, cursor, ...filters } = args;
    // Default empty list; only overwrite on a successful load. Cold/absent
    // (or any non-invalid_params loader failure) keeps this historical contract.
    let rows: Row[] = [];
    try {
      // Omit GraphQL limit/cursor so the loader returns the full filtered set.
      // When a fields projection is supplied, keep/force `id` so the opaque
      // string keyset cursor still resolves.
      const loadArgs: Row = { ...filters };
      if (typeof loadArgs.fields === "string" && loadArgs.fields.trim()) {
        const trimmed = loadArgs.fields.trim();
        loadArgs.fields = /(^|,)\s*id\s*(,|$)/i.test(trimmed)
          ? trimmed
          : `id,${trimmed}`;
      }
      const data = await loadProvidersList(mcpCtx(context), loadArgs, {
        readArtifact,
      });
      rows = data.providers as Row[];
    } catch (rawErr) {
      const err = rawErr as Row;
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(err.message, {
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

  async provider({ id }: Row, context: GqlContext) {
    if (typeof id !== "string" || !VALID_PROVIDER_ID.test(id)) return null;
    const data = await loadArtifact(context, `/metagraph/providers/${id}.json`);
    if (!data) return null;
    return providerNode(data.provider ?? data);
  },

  // #6984: reuse loadAdapter (the same loader MCP get_adapter already calls)
  // unchanged -- same slug validation and artifact path as REST
  // /api/v1/adapters/{slug}. invalid_params becomes BAD_USER_INPUT; any other
  // loader miss (not_found / cold R2 / unavailable) resolves to null
  // (schema-stable), matching provider's cold/absent convention -- never a
  // GraphQL error for an unregistered slug.
  async adapter({ slug }: Row, context: GqlContext) {
    try {
      return await loadAdapter(mcpCtx(context), { slug }, { readArtifact });
    } catch (rawErr) {
      const err = rawErr as Row;
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(err.message, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (err?.toolError) return null;
      throw err;
    }
  },

  async economics({ limit, cursor }: QueryEconomicsArgs, context: GqlContext) {
    // Live-preferring source (not the static-only listPage), paginated like it.
    const data = await loadEconomics(context);
    const { page, total, nextCursor } = paginate(
      data?.subnets || [],
      limit,
      cursor,
      (s: Row) => s.netuid,
    );
    return {
      subnets: page,
      total,
      next_cursor: nextCursor,
      summary: data?.summary ?? null,
    };
  },

  surfaces({ netuid, limit, cursor }: Row, context: GqlContext) {
    return listPage(context, ARTIFACT.surfaces, "surfaces", {
      limit,
      cursor,
      netuid,
      keyFn: (s: Row) => s.id ?? s.key,
    });
  },

  endpoints({ netuid, limit, cursor }: Row, context: GqlContext) {
    return listPage(context, ARTIFACT.endpoints, "endpoints", {
      limit,
      cursor,
      netuid,
      keyFn: (e: Row) => e.id ?? e.surface_id,
    });
  },

  // #7868: reuse list_provider_endpoints' own loader unchanged (provider-
  // endpoints-mcp.ts) -- the same read + filter/sort/page the REST route and
  // MCP tool run over the baked per-provider artifact. It validates its own
  // args and throws on an invalid one (or a cold/absent provider artifact) --
  // that throw becomes a GraphQL error, matching endpoint_pools/gaps' "an
  // unsupported filter/sort is a GraphQL error, not a silently substituted
  // default" convention.
  provider_endpoints(args: Row, context: GqlContext) {
    return loadProviderEndpointsList(mcpCtx(context), args, { readArtifact });
  },

  // #6985: reuse list_endpoint_pools's/list_rpc_pools's/list_endpoint_incidents's
  // own loaders unchanged (same artifact read, filter, sort, and page logic REST
  // and MCP already use) rather than re-deriving a GraphQL-only filterFn. Each
  // loader validates its own args and throws on an invalid one -- that throw
  // (inside these async functions) becomes a rejected promise, which the graphql
  // executor surfaces as a normal GraphQL error, matching every other field's
  // "an unsupported filter/sort is a GraphQL error, not a silently substituted
  // default" convention.
  endpoint_pools(args: Row, context: GqlContext) {
    return loadEndpointPoolsList(mcpCtx(context), args, { readArtifact });
  },

  rpc_pools(args: Row, context: GqlContext) {
    // rpc-pools' loader additionally reads ctx.readHealthKv for its live
    // 15-minute cron eligibility overlay (rpc-pools-mcp.ts) -- graphql.mjs's
    // own context has no such property, so it's supplied here from the same
    // module-level import loadLiveHealth/loadEconomics already use.
    return loadRpcPoolsList(
      { ...context, readHealthKv } as unknown as Parameters<
        typeof loadRpcPoolsList
      >[0],
      args,
      { readArtifact },
    );
  },

  endpoint_incidents(args: Row, context: GqlContext) {
    return loadEndpointIncidentsList(mcpCtx(context), args, { readArtifact });
  },

  // #6986: reuse list_source_snapshots' own loader unchanged. It validates its
  // own args and throws on an invalid one -- that throw (inside this async
  // function) becomes a rejected promise, which the graphql executor surfaces
  // as a normal GraphQL error, matching every other field's "an unsupported
  // filter/sort is a GraphQL error, not a silently substituted default"
  // convention.
  source_snapshots(args: Row, context: GqlContext) {
    return loadSourceSnapshotsList(mcpCtx(context), args, { readArtifact });
  },

  // #7171: reuse list_gaps / list_evidence loaders unchanged. Each validates
  // its own args and throws on an invalid one -- that throw becomes a GraphQL
  // error, matching source_snapshots' "unsupported filter/sort is a GraphQL
  // error, not a silently substituted default" convention. A cold/absent
  // artifact is likewise a GraphQL error (matching REST/MCP not_found).
  gaps(args: Row, context: GqlContext) {
    return loadGapsList(mcpCtx(context), args, { readArtifact });
  },

  evidence(args: Row, context: GqlContext) {
    return loadEvidenceList(mcpCtx(context), args, { readArtifact });
  },

  // #6992: reuse list_profiles' own loader unchanged. Its readOptionalArtifact
  // dep is called as (ctx, path) and expects data-or-null on a cold artifact
  // (not a throw) -- this file's own loadArtifact(context, path) already has
  // exactly that shape (readArtifact(context.env, path), null if not ok), so
  // it's reused directly rather than adding a redundant wrapper.
  profiles(args: Row, context: GqlContext) {
    return loadProfilesList(mcpCtx(context), args, {
      readOptionalArtifact: loadArtifact as AnyFn,
    });
  },

  registry_summary(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST route + registry_summary MCP tool read.
    // Degrades to null when cold instead of erroring, matching every other
    // artifact-backed resolver here.
    return loadArtifact(context, "/metagraph/registry-summary.json");
  },

  async saved_query({ id, params }: Row, context: GqlContext) {
    // #7642: the same maintainer-curated template executor the REST route and
    // run_saved_query MCP tool share (src/saved-queries.ts) -- template
    // lookup, param coercion/validation, and execution are all its. Its
    // not_found (unknown id) and invalid_params toolErrors map to
    // BAD_USER_INPUT, matching this file's invalid-argument convention; any
    // other executor failure surfaces as a normal GraphQL error.
    try {
      return await runSavedQuery(context.env, id, params ?? {});
    } catch (rawErr) {
      const err = rawErr as Row;
      if (
        err?.toolError &&
        (err.code === "not_found" || err.code === "invalid_params")
      ) {
        throw new GraphQLError(err.message, {
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

  rpc_endpoints(args: Row, context: GqlContext) {
    // #7886: reuse loadRpcEndpointsList — same live 15-minute cron overlay +
    // endpoints-collection list-query transforms REST applies. The loader
    // validates its own args and throws on an invalid filter/sort or a cold
    // artifact; that throw becomes a GraphQL error, matching endpoint_pools /
    // rpc_pools' "an unsupported filter/sort is a GraphQL error, not a
    // silently substituted default" convention.
    return loadRpcEndpointsList(
      { ...context, readHealthKv } as unknown as Parameters<
        typeof loadRpcEndpointsList
      >[0],
      args,
      { readArtifact },
    );
  },

  // #7170: reuse get_changelog's/get_contracts's own loaders unchanged (the same
  // baked artifact read REST and MCP already use). Each takes { readArtifact }
  // as the module-level storage reader -- exactly what MCP's own registrations
  // pass. A cold/absent artifact makes the loader throw, which the graphql
  // executor surfaces as a normal GraphQL error, matching REST's 404 and the
  // source_snapshots convention for a missing artifact.
  changelog(_args: unknown, context: GqlContext) {
    return loadChangelog(mcpCtx(context), { readArtifact });
  },

  contracts(_args: unknown, context: GqlContext) {
    return loadContracts(mcpCtx(context), { readArtifact });
  },

  // #7431: reuse get_build's own loader unchanged (the same baked artifact read
  // REST and MCP already use). A cold/absent artifact makes the loader throw,
  // which the graphql executor surfaces as a normal GraphQL error.
  build(_args: unknown, context: GqlContext) {
    return loadBuildSummary(mcpCtx(context), { readArtifact });
  },

  // #7170: reuse get_health_history's own loader unchanged. It takes deps as
  // { readArtifact } called (ctx, path) returning data-or-null -- this file's
  // own loadArtifact has exactly that shape, so it's reused directly (like
  // profiles' readOptionalArtifact). The loader validates its date + filters
  // and throws invalid_params on a bad one / not_found on a missing snapshot;
  // that throw becomes a GraphQL error, matching every other field's "an
  // unsupported filter/sort is a GraphQL error, not a silent default".
  health_history(args: Row, context: GqlContext) {
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
  review_adapter_candidates(args: Row, context: GqlContext) {
    return loadAdapterCandidatesList(mcpCtx(context), args, { readArtifact });
  },

  review_enrichment_evidence(args: Row, context: GqlContext) {
    return loadEnrichmentEvidenceList(mcpCtx(context), args, { readArtifact });
  },

  review_enrichment_queue(args: Row, context: GqlContext) {
    return loadEnrichmentQueueList(mcpCtx(context), args, { readArtifact });
  },

  review_enrichment_targets(args: Row, context: GqlContext) {
    return loadReviewEnrichmentTargetsList(mcpCtx(context), args, {
      readArtifact,
    });
  },

  review_gaps(args: Row, context: GqlContext) {
    return loadReviewGapsList(mcpCtx(context), args, { readArtifact });
  },

  review_profile_completeness(args: Row, context: GqlContext) {
    return loadProfileCompletenessList(mcpCtx(context), args, { readArtifact });
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

  async opportunity_boards({ limit }: Row, context: GqlContext) {
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

  async compare({ netuids, dimensions }: Row, context: GqlContext) {
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
    });
  },

  async incidents({ window }: Row, context: GqlContext) {
    // Reuse the exact analyticsWindow parse/validate REST's handleGlobalIncidents
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL BAD_USER_INPUT
    // error, not a silent empty result. analyticsWindow reads only the ?window param.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
    // Same METAGRAPH_HEALTH_SOURCE Postgres tier -> loadGlobalIncidentsLedger D1
    // fallback contract handleGlobalIncidents uses; the ledger is schema-stable on
    // a cold/retired tier (empty surfaces + zeroed summary), never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/incidents", params),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      (await loadGlobalIncidentsLedger(context.env, { label })).data;
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      source: data.source ?? null,
      summary: data.summary ?? null,
      surfaces: data.surfaces ?? [],
    };
  },

  // #7643: the get_global_incidents-aligned name for the same downtime-incident
  // ledger -- a thin delegate so MCP tool names and GraphQL fields line up.
  // Identical window validation (7d/30d -> BAD_USER_INPUT), Postgres-tier ->
  // retired-D1 fallback, and schema-stable cold-tier degradation; nothing
  // re-derived. Distinct from endpoint_incidents (the active endpoint feed).
  async global_incidents({ window }: Row, context: GqlContext) {
    return rootValue.incidents({ window }, context);
  },

  search({ limit, cursor }: Row, context: GqlContext) {
    // Same baked search artifact + list-window the REST route serves, paged
    // through the shared listPage helper the other artifact lists use.
    return listPage(context, ARTIFACT.search, "documents", {
      limit,
      cursor,
      resultKey: "documents",
      keyFn: (d: Row) => d.id,
    });
  },

  search_index({ limit, cursor }: Row, context: GqlContext) {
    // The slim companion: identical documents minus the per-document token
    // blobs, served from its own artifact exactly as REST serves it.
    return listPage(context, ARTIFACT.searchIndex, "documents", {
      limit,
      cursor,
      resultKey: "documents",
      keyFn: (d: Row) => d.id,
    });
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

  async domain_summary({ tag }: Row, context: GqlContext) {
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

  async compare_validators({ hotkeys, netuid }: Row, context: GqlContext) {
    // Same parse/validate contract the REST route + compare_validators MCP
    // tool share: 1..COMPARE_VALIDATORS_MAX distinct SS58 addresses.
    const parsed = parseCompareHotkeyList(hotkeys);
    if (!parsed) {
      throw new GraphQLError(
        `hotkeys must be a non-empty list of 1-${COMPARE_VALIDATORS_MAX} distinct valid SS58 validator addresses.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    if (netuid != null && (!Number.isInteger(netuid) || netuid < 0)) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // One detail load per hotkey via the exact Postgres-tier-or-empty path the
    // validator detail field uses -- no new data source, just the same
    // cross-subnet aggregate fetched per compared validator, then projected
    // side by side. Sequential to keep the request pattern identical to the
    // REST/MCP fan-out.
    const details = [];
    for (const hotkey of parsed) {
      details.push(
        ((await tryPostgresTier(
          context.env,
          postgresTierRequest(
            context,
            `/api/v1/validators/${encodeURIComponent(hotkey)}`,
          ),
          "METAGRAPH_NEURONS_SOURCE",
        )) as Row | null) ?? buildValidatorDetail([], hotkey),
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

  async curation(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST /api/v1/curation route + list_curation MCP
    // tool read; opaque-JSON passthrough degrading to null on cold.
    return loadArtifact(context, CURATION_ARTIFACT);
  },

  async coverage(_args: unknown, context: GqlContext) {
    // Same baked artifact the REST /api/v1/coverage route + get_coverage MCP
    // tool read; GraphQL degrades to null when cold, like agent_resources.
    return loadArtifact(context, "/metagraph/coverage.json");
  },

  schemas(_args: unknown, context: GqlContext) {
    // #7866: the same baked schema-index artifact the REST /api/v1/schemas
    // route + list_schemas MCP tool read; opaque-JSON passthrough degrading to
    // null when cold, like coverage/curation above.
    return loadArtifact(context, "/metagraph/schemas/index.json");
  },

  async coverage_depth(_args: unknown, context: GqlContext) {
    // Raw passthrough of the /api/v1/coverage-depth artifact (the same one the
    // list_enrichment_targets MCP tool shapes); degrades to null when cold.
    return loadArtifact(context, "/metagraph/coverage-depth.json");
  },

  async subnet_volume({ netuid }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(context, `/api/v1/subnets/${netuid}/volume`),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      (tier?.data as Row | undefined) ??
      buildAlphaVolume([], netuid, { marketCapTao });
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
      sentiment: data.sentiment ?? null,
      vol_mcap_ratio: data.vol_mcap_ratio ?? null,
    };
  },

  async subnet_ohlc({ netuid, interval, days }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
    const params = new URLSearchParams();
    params.set("interval", intervalParam);
    params.set("days", String(daysParam));
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/ohlc`, params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildSubnetOhlc([], netuid, { interval: intervalParam });
    return {
      schema_version: data.schema_version ?? 1,
      netuid: data.netuid ?? netuid,
      interval: data.interval ?? intervalParam,
      candles: data.candles ?? [],
      root_excluded: data.root_excluded ?? false,
    };
  },

  async subnet_stake_quote(
    { netuid, amount, direction }: QuerySubnet_Stake_QuoteArgs,
    context: GqlContext,
  ) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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

  async subnet_validators({ netuid }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildSubnetValidators([])
    // empty-snapshot fallback the REST route and list_subnet_validators share.
    // REST takes no filter params here, so neither does this mirror.
    const data =
      ((await tryPostgresTier(
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
    { netuid, window }: Row,
    context: GqlContext,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's percentiles handler
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result, matching
    // subnet_health_incidents.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetPercentiles
    // fallback the REST route and the get_subnet_health_percentiles MCP tool
    // share -- the tier owns the percentile computation, so nothing is
    // duplicated here, and a subnet with no probe history yields a
    // schema-stable empty surfaces list, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/health/percentiles`,
          params,
        ),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      (await loadSubnetPercentiles(netuid, {
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

  async subnet_event_summary(
    { netuid, window, limit }: Row,
    context: GqlContext,
  ) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/event-summary`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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

  async subnet_gaps({ netuid }: Row, context: GqlContext) {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same baked review-gaps artifact the REST route + get_subnet_gaps MCP tool
    // read. The MCP tool raises not_found for a netuid with no report; GraphQL
    // degrades to null instead, matching how every other artifact-backed
    // resolver here treats a cold/absent artifact.
    return loadArtifact(context, `/metagraph/review/gaps/${netuid}.json`);
  },

  async subnet_evidence(args: Row, context: GqlContext) {
    const { netuid } = args;
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // #7879: reuse loadSubnetEvidenceList -- the same loader MCP
    // list_subnet_evidence calls -- rather than reimplementing the
    // search/sort/page pass here, so this field cannot drift from
    // GET /api/v1/subnets/{netuid}/evidence. It reads the same baked
    // per-subnet artifact and validates every sort/limit/cursor value against
    // the REST allowlists, throwing on an unsupported one.
    try {
      return await loadSubnetEvidenceList(mcpCtx(context), args, {
        readArtifact,
      });
    } catch (rawErr) {
      const err = rawErr as Row;
      // An unsupported sort/limit/cursor is BAD_USER_INPUT, matching every
      // other field's "not a silently substituted default" convention.
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(err.message, {
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

  async subnet_candidates(args: Row, context: GqlContext) {
    const { netuid } = args;
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // #7878: reuse loadSubnetCandidatesList -- the same loader the
    // list_subnet_candidates MCP tool calls (#7899) -- rather than
    // reimplementing the filter/sort/page pass here, so this field cannot
    // drift from GET /api/v1/subnets/{netuid}/candidates. It reads the same
    // baked per-subnet artifact (distinct from the network-wide candidates(...)
    // catalog) and validates every filter/sort value against the REST
    // allowlists, throwing on an unsupported one; that throw surfaces as a
    // normal GraphQL error, matching the review_* family's convention.
    try {
      return await loadSubnetCandidatesList(mcpCtx(context), args, {
        readArtifact,
      });
    } catch (rawErr) {
      const err = rawErr as Row;
      // An unsupported filter/sort value is BAD_USER_INPUT, matching every
      // other field's "not a silently substituted default" convention.
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(err.message, {
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

  async subnet_health_incidents({ netuid, window }: Row, context: GqlContext) {
    // Reuse the exact analyticsWindow parse/validate REST's handleHealthIncidents
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetIncidents D1
    // fallback contract handleHealthIncidents and the get_subnet_health_incidents
    // MCP tool share -- the tier owns the gap-island incident reconstruction, so
    // nothing is duplicated here, and a subnet with no probe history yields a
    // schema-stable empty surfaces list, never a GraphQL error.
    const params = new URLSearchParams();
    params.set("window", label);
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/health/incidents`,
          params,
        ),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      (await loadSubnetIncidents(netuid, {
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
    }: Row,
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
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/extrinsics", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ??
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

  // #7171: reuse loadChainEventsFeed (the same DATA_API path MCP
  // list_chain_events already calls). invalid_params (bad filter combo) is
  // BAD_USER_INPUT; a cold/unbound/rate-limited tier degrades to a
  // schema-stable empty feed, never a GraphQL error — matching extrinsics'
  // cold-empty convention. Distinct from Subscription.chainEvents.
  async chain_events(
    { pallet, method, block, extrinsic, cursor, before, limit }: Row,
    context: GqlContext,
  ) {
    try {
      const data = await loadChainEventsFeed(mcpCtx(context), {
        pallet,
        method,
        block,
        extrinsic,
        cursor,
        before,
        limit,
      });
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
        })),
      };
    } catch (rawErr) {
      const err = rawErr as Row;
      if (err?.toolError && err.code === "invalid_params") {
        throw new GraphQLError(err.message, {
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
  async chain_events_stats({ blocks }: Row, context: GqlContext) {
    let window;
    try {
      window = optionalBlocksWindow({ blocks });
    } catch (rawErr) {
      const err = rawErr as Row;
      // optionalBlocksWindow's only failure is invalid_params (a non-positive
      // or non-integer blocks) — surface it as BAD_USER_INPUT, mirroring how
      // chain_events maps the sibling feed's invalid-filter error.
      throw new GraphQLError(err.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    try {
      return await loadChainActivity(mcpCtx(context), window);
    } catch {
      // A cold/unbound/rate-limited tier degrades to a schema-stable empty
      // aggregate (echoing the validated window), never a GraphQL error —
      // matching chain_events' cold-empty convention.
      return { window_blocks: window, groups: 0, activity: [] };
    }
  },

  async sudo(
    { limit, offset, cursor, block, call_function: callFunction, success }: Row,
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
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/sudo", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ??
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

  async extrinsic({ ref }: Row, context: GqlContext) {
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/extrinsics/${encodeURIComponent(ref)}`,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ?? buildExtrinsic(undefined, ref);
    return {
      ref: data.ref ?? ref,
      extrinsic: extrinsicNode(data.extrinsic),
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
    }: Row,
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
    // itself (see SUDO_GOVERNANCE_ROUTES in workers/data-api.mjs) -- no filter
    // logic duplicated here; the REST route and MCP tool share this exact path.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          "/api/v1/governance/config-changes",
          params,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ??
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

  async blocks(
    {
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
    }: Row,
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/blocks", params),
        "METAGRAPH_BLOCKS_SOURCE",
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

  async blocks_summary(_args: unknown, context: GqlContext) {
    // #5664: same tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) -> buildBlocksSummary([])
    // fallback contract handleBlocksSummary uses. blocks' D1 write path is retired
    // (#4909) so a cold Postgres tier is the steady state -- the empty builder
    // shape (block_count 0, every aggregate null) satisfies the non-null
    // BlocksSummary! contract, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/blocks/summary"),
        "METAGRAPH_BLOCKS_SOURCE",
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
    // Same tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) -> buildRuntimeVersionHistory([])
    // fallback contract GET /api/v1/runtime and the get_runtime MCP tool use; blocks'
    // D1 write path is retired (#4909) so a cold Postgres tier is the steady state --
    // the empty builder shape (transition_count 0, current_spec_version null) satisfies
    // the non-null RuntimeVersionHistory! contract, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/runtime"),
        "METAGRAPH_BLOCKS_SOURCE",
      )) as Row | null) ?? buildRuntimeVersionHistory([]);
    return {
      schema_version: data.schema_version ?? 1,
      transitions: data.transitions || [],
      transition_count: data.transition_count ?? 0,
      current_spec_version: data.current_spec_version ?? null,
      coverage_from_block: data.coverage_from_block ?? null,
      coverage_from_at: data.coverage_from_at ?? null,
    };
  },

  async block({ ref }: Row, context: GqlContext) {
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/blocks/${encodeURIComponent(ref)}`,
        ),
        "METAGRAPH_BLOCKS_SOURCE",
      )) as Row | null) ?? buildBlock(undefined, ref);
    return {
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
  async block_extrinsics({ ref, limit, offset }: Row, context: GqlContext) {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit)))
      : 50;
    const safeOffset = Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : 0;
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    const { data } = ((await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/blocks/${encodeURIComponent(ref)}/extrinsics`,
        params,
      ),
      "METAGRAPH_EXTRINSICS_SOURCE",
    )) as Row | null) ?? {
      data: buildBlockExtrinsics([], ref, null, {
        limit: safeLimit,
        offset: safeOffset,
      }),
    };
    return data;
  },

  async block_events({ ref, limit, offset }: Row, context: GqlContext) {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(1000, Math.floor(limit)))
      : 100;
    const safeOffset = Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : 0;
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    const { data } = ((await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/blocks/${encodeURIComponent(ref)}/events`,
        params,
      ),
      "METAGRAPH_EXTRINSICS_SOURCE",
    )) as Row | null) ?? {
      data: buildBlockEvents([], ref, null, {
        limit: safeLimit,
        offset: safeOffset,
      }),
    };
    return data;
  },

  // Reuses loadBlockChainEvents unchanged (the get_block_chain_events tool's own
  // loader); it throws invalid_params on a bad block_number and tier_unavailable
  // where the all-events Worker is absent -- both surface as normal GraphQL errors.
  block_chain_events({ block_number: blockNumber }: Row, context: GqlContext) {
    return loadBlockChainEvents(mcpCtx(context), blockNumber);
  },

  async validators({ sort, limit, cursor }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/validators", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
        buildGlobalValidators([], {
          sort: requestedSort,
          limit: GLOBAL_VALIDATOR_LIMIT_MAX,
        }),
    )! as Row;
    const nodes = (data.validators || []).map(validatorNode);
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
    { hotkey, window, sort, coldkey }: Row,
    context: GqlContext,
  ) {
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
    // #7884: narrow to one nominator, mirroring the REST route's `coldkey` query
    // param + MCP get_validator_nominators. A supplied non-SS58 value is a
    // BAD_USER_INPUT error (same guard MCP applies), not a silent no-op. The
    // filter is applied at the Postgres tier's SQL WHERE, so it only needs to
    // ride the request params; the empty-rows builder fallback is unaffected.
    if (coldkey != null && !SS58_ADDRESS_PATTERN.test(coldkey)) {
      throw new GraphQLError("coldkey must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    if (sort != null) params.set("sort", sort);
    if (coldkey != null) params.set("coldkey", coldkey);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildValidatorNominators
    // fallback contract REST uses. The Postgres tier's response is a REST-style
    // { data, generatedAt } envelope, so only its `.data` is taken; `generatedAt` is
    // REST envelope meta with no GraphQL field to carry it. A hotkey with no
    // nominators yields a schema-stable empty list, never a GraphQL error. limit/offset
    // are deliberately not GraphQL args, so the module's own defaults apply. #4772 D1
    // retirement: the `account_events` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live D1 query.
    const data =
      ((
        await tryPostgresTier(
          context.env,
          postgresTierRequest(
            context,
            `/api/v1/validators/${encodeURIComponent(hotkey)}/nominators`,
            params,
          ),
          "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
        )
      )?.data as Row | undefined) ??
      buildValidatorNominators([], hotkey, {
        window: requestedWindow,
        sort: sort ?? undefined,
      });
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

  async validator({ hotkey }: Row, context: GqlContext) {
    const data = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/validators/${encodeURIComponent(hotkey)}`,
      ),
      "METAGRAPH_NEURONS_SOURCE",
    );
    return validatorDetailNode(data as Row, hotkey);
  },

  async validator_history({ hotkey, window }: Row, context: GqlContext) {
    // Same parseHistoryWindow REST's handleValidatorHistory uses, so accepted
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildValidatorHistory
    // fallback contract handleValidatorHistory uses; a hotkey with no
    // neuron_daily rows in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildValidatorHistory([], hotkey, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      hotkey: data.hotkey ?? hotkey,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async account_position_history(
    { ss58, netuid, window }: Row,
    context: GqlContext,
  ) {
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildAccountPositionHistory
    // fallback contract the REST handler uses; an account with no neuron_daily
    // rows for the subnet in the window is a schema-stable empty-points card,
    // never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/subnets/${netuid}/history`,
          params,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
      buildAccountPositionHistory([], ss58, netuid, { window: label });
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      netuid: data.netuid ?? netuid,
      window: data.window ?? label,
      point_count: data.point_count ?? 0,
      points: data.points || [],
    };
  },

  async accounts({ sort, limit }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/accounts", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ??
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

  async account({ ss58 }: Row, context: GqlContext) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}`,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ?? buildAccountSummary(ss58, {});
    return accountSummaryNode(data, ss58);
  },

  async account_prometheus({ ss58, window }: Row, context: GqlContext) {
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
      (pg?.data as Row | undefined) ??
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
    };
  },

  async account_stake_flow(
    { ss58, window, direction }: Row,
    context: GqlContext,
  ) {
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
      (pg?.data as Row | undefined) ??
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

  async account_portfolio({ ss58 }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/portfolio`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildAccountPortfolio([], ss58);
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

  async account_positions({ ss58 }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/positions`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildAccountPositions([], new Map(), ss58);
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      captured_at: data.captured_at ?? null,
      position_count: data.position_count ?? 0,
      total_stake_tao: data.total_stake_tao ?? 0,
      positions: data.positions || [],
    };
  },

  async account_subnets({ ss58 }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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

  async account_registrations({ ss58, window }: Row, context: GqlContext) {
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
      (tier?.data as Row | undefined) ??
      buildAccountRegistrations([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_registrations: data.total_registrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s: Row) => ({
        netuid: s.netuid,
        registrations: s.registrations,
        first_registered_at: s.first_registered_at ?? null,
        last_registered_at: s.last_registered_at ?? null,
      })),
    };
  },

  async account_deregistrations({ ss58, window }: Row, context: GqlContext) {
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
      (tier?.data as Row | undefined) ??
      buildAccountDeregistrations([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_deregistrations: data.total_deregistrations ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s: Row) => ({
        netuid: s.netuid,
        deregistrations: s.deregistrations,
        first_deregistered_at: s.first_deregistered_at ?? null,
        last_deregistered_at: s.last_deregistered_at ?? null,
      })),
    };
  },

  async account_serving({ ss58, window }: Row, context: GqlContext) {
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
      (tier?.data as Row | undefined) ??
      buildAccountServing([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_announcements: data.total_announcements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s: Row) => ({
        netuid: s.netuid,
        announcements: s.announcements,
        first_served_at: s.first_served_at ?? null,
        last_served_at: s.last_served_at ?? null,
      })),
    };
  },

  async account_axon_removals({ ss58, window }: Row, context: GqlContext) {
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
      (tier?.data as Row | undefined) ??
      buildAccountAxonRemovals([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_removals: data.total_removals ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s: Row) => ({
        netuid: s.netuid,
        removals: s.removals,
        first_removed_at: s.first_removed_at ?? null,
        last_removed_at: s.last_removed_at ?? null,
      })),
    };
  },

  async account_stake_moves({ ss58, window }: Row, context: GqlContext) {
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
      (tier?.data as Row | undefined) ??
      buildAccountStakeMoves([], ss58, { window: windowParam });
    return {
      schema_version: data.schema_version ?? 1,
      address: data.address ?? ss58,
      window: data.window ?? windowParam,
      total_movements: data.total_movements ?? 0,
      subnet_count: data.subnet_count ?? 0,
      concentration: data.concentration ?? null,
      dominant_netuid: data.dominant_netuid ?? null,
      subnets: (data.subnets ?? []).map((s: Row) => ({
        netuid: s.netuid,
        movements: s.movements,
        first_moved_at: s.first_moved_at ?? null,
        last_moved_at: s.last_moved_at ?? null,
        price_tao_at_last_move: s.price_tao_at_last_move ?? null,
      })),
    };
  },

  async account_weight_setters({ ss58, window }: Row, context: GqlContext) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const requestedWindow = window ?? DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW;
    if (!Object.hasOwn(ACCOUNT_WEIGHT_SETTERS_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(
          requestedWindow,
          ACCOUNT_WEIGHT_SETTERS_WINDOWS,
        ),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> { data, generatedAt }
    // envelope handleAccountWeightSetters (makeAccountEventHandler) uses; a cold
    // or absent tier degrades to buildAccountWeightSetters' own zeroed card.
    const pg = await tryPostgresTier(
      context.env,
      postgresTierRequest(
        context,
        `/api/v1/accounts/${encodeURIComponent(ss58)}/weight-setters`,
        params,
      ),
      "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
    );
    const data =
      (pg?.data as Row | undefined) ??
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

  async account_entities({ ss58 }: Row, context: GqlContext) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same R2 entities.json + Postgres-tier ownership join handleAccountEntities
    // uses (workers/request-handlers/entities.mjs): the entity-label artifact
    // read and the SubnetOwnerChanged ownership-tie lookup are independent
    // sources, fetched in parallel. A cold/absent Postgres tier degrades to
    // buildAccountEntities' own zeroed card; a cold/absent R2 artifact degrades
    // to an empty labels list.
    const [entitiesArtifact, ownershipData] = await Promise.all([
      readArtifact(context.env, ENTITY_LABELS_ARTIFACT),
      tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/entities`,
        ),
        "METAGRAPH_SUBNET_OWNERSHIP_SOURCE",
      ),
    ]);
    const data = ownershipData ?? buildAccountEntities(ss58, { entities: [] });
    const labels = labelsForSs58(
      entityLabelsIndex(
        entitiesArtifact.ok ? (entitiesArtifact.data as Row)?.entities : [],
      ),
      ss58,
    );
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      labels,
      ownership_tie_count: data.ownership_tie_count ?? 0,
      ownership_ties: data.ownership_ties || [],
    };
  },

  async account_identity({ ss58 }: Row, context: GqlContext) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty card.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // D1 retirement: account_identity's D1 write/read path is fully retired
    // (2026-07-16). Most accounts have never called set_identity, so a
    // row-less account is already the common case: has_identity:false with
    // every field null, never a GraphQL error -- a Postgres miss/outage
    // degrades to that exact same schema-stable shape, never a live D1 read.
    const data =
      ((await tryPostgresTier(
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
    { ss58, limit, offset, cursor }: Row,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed
    // address is a GraphQL BAD_USER_INPUT error, not a silent empty timeline.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // D1 retirement: account_identity_history's D1 write/read path is fully
    // retired (2026-07-16), forwarding limit/offset/cursor as query params --
    // an address with no identity-history rows is a schema-stable empty
    // timeline, never a GraphQL error, and a Postgres miss/outage now
    // degrades to that same shape, never a live D1 read.
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));
    if (cursor != null) params.set("cursor", cursor);
    const data =
      ((await tryPostgresTier(
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
      entries: (data.entries ?? []).map((e: Row) => ({
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
    { ss58, counterparty, limit }: Row,
    context: GqlContext,
  ) {
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
    let data = tier as Row | null;
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
      counterparties: (data.counterparties ?? []).map((c: Row) => ({
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
            transfers: (rel.transfers ?? []).map((t: Row) => ({
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
    { ss58, limit, offset, cursor, direction, block_start, block_end }: Row,
    context: GqlContext,
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/transfers`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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
      transfers: (data.transfers ?? []).map((t: Row) => ({
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
    { ss58, limit, offset, cursor, block_start, block_end }: Row,
    context: GqlContext,
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/extrinsics`,
          params,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ??
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
    { ss58, kind, netuid, block_start, block_end, limit, offset, cursor }: Row,
    context: GqlContext,
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/events`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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
      events: (data.events ?? []).map((e: Row) => ({
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
    { ss58, netuid, from, to, limit, offset, cursor }: Row,
    context: GqlContext,
  ) {
    // Same SS58 validation every account_* resolver uses -- a malformed address
    // is a GraphQL BAD_USER_INPUT error, not a silent empty series.
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
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
    if (
      (from != null && !DAY_PATTERN.test(from)) ||
      (to != null && !DAY_PATTERN.test(to))
    ) {
      throw new GraphQLError("from/to must be YYYY-MM-DD dates.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}/history`,
          params,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ?? (await loadAccountHistory(ss58, historyOptions));
    return {
      schema_version: data.schema_version ?? 1,
      ss58: data.ss58 ?? ss58,
      day_count: data.day_count ?? 0,
      limit: data.limit ?? safeLimit,
      offset: data.offset ?? safeOffset,
      next_cursor: data.next_cursor ?? null,
      days: (data.days ?? []).map((d: Row) => ({
        day: d.day ?? null,
        netuid: d.netuid ?? null,
        event_count: d.event_count ?? null,
        event_kinds: Array.isArray(d.event_kinds) ? d.event_kinds : [],
        first_block: d.first_block ?? null,
        last_block: d.last_block ?? null,
      })),
    };
  },

  async economics_trends({ window }: Row, context: GqlContext) {
    // Same parseHistoryWindow REST uses, so accepted window labels and the
    // resulting { label, days } stay identical between REST and GraphQL.
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
    // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same tier
    // and fallback contract REST's handleEconomicsTrends uses.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/economics/trends", params),
        "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
      )) as Row | null) ??
      (await loadEconomicsTrends({ windowLabel: label })).data;
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

  async subnet_movers({ window, sort, limit }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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

  async chain_turnover({ window, limit }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
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

  async chain_activity({ window }: Row, context: GqlContext) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainActivity
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
    const params = new URLSearchParams();
    params.set("window", label);
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainActivity
    // fallback handleChainActivity uses; the tier owns the per-day extrinsic/block
    // rollup (no logic duplicated here), and a cold store yields a schema-stable
    // empty series.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/activity", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ?? buildChainActivity({ window: label });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      days: (data.days ?? []).map((d: Row) => ({
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
    { window, group_by: groupBy, limit, call_module: callModule }: Row,
    context: GqlContext,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainCalls
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/calls", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ??
      buildChainCalls({ window: label, groupBy: requestedGroupBy });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      group_by: data.group_by ?? requestedGroupBy,
      observed_at: data.observed_at ?? null,
      total_extrinsics: data.total_extrinsics ?? 0,
      call_count: data.call_count ?? 0,
      calls: (data.calls ?? []).map((c: Row) => ({
        call_module: c.call_module,
        call_function: c.call_function ?? null,
        count: c.count ?? 0,
        share: c.share ?? null,
      })),
    };
  },

  async chain_fees(
    { window, limit, call_module: callModule }: Row,
    context: GqlContext,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainFees
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty result.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/fees", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) as Row | null) ?? buildChainFees({ window: label });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      observed_at: data.observed_at ?? null,
      day_count: data.day_count ?? 0,
      daily: (data.daily ?? []).map((d: Row) => ({
        day: d.day,
        extrinsic_count: d.extrinsic_count ?? 0,
        total_fee_tao: d.total_fee_tao ?? null,
        avg_fee_tao: d.avg_fee_tao ?? null,
        median_fee_tao: d.median_fee_tao ?? null,
        total_tip_tao: d.total_tip_tao ?? null,
        avg_tip_tao: d.avg_tip_tao ?? null,
        median_tip_tao: d.median_tip_tao ?? null,
      })),
      top_fee_payers: (data.top_fee_payers ?? []).map((p: Row) => ({
        signer: p.signer,
        total_fee_tao: p.total_fee_tao ?? null,
        total_tip_tao: p.total_tip_tao ?? null,
        extrinsic_count: p.extrinsic_count ?? 0,
      })),
    };
  },

  async chain_weights({ window, limit }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildChainWeights
    // fallback contract REST's handleChainWeights uses -- a cold store yields a
    // schema-stable empty leaderboard, never a GraphQL error. #4772 D1 retirement:
    // the `account_events` D1 table is dropped in production, so the fallback goes
    // straight to the pure builder with no rows, never a live D1 query.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/weights", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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

  async chain_serving({ window, limit }: Row, context: GqlContext) {
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
    // the table is dropped in production, so a D1 query here would always miss
    // (#6013). Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's chainServing route uses, never
    // a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/serving", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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

  async chain_axon_removals({ window, limit }: Row, context: GqlContext) {
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
    // the table is dropped in production, so a D1 query here would always miss
    // (#6013). Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainAxonRemovals uses,
    // never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/axon-removals", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildChainAxonRemovals([], { window: requestedWindow, limit: safeLimit });
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

  async chain_deregistrations({ window, limit }: Row, context: GqlContext) {
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
    // the table is dropped in production, so a D1 query here would always miss
    // (#6013). Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainDeregistrations
    // uses, never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/deregistrations", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
      buildChainDeregistrations([], {
        window: requestedWindow,
        limit: safeLimit,
      });
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

  async chain_registrations({ window, limit }: Row, context: GqlContext) {
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
    // the table is dropped in production, so a D1 query here would always miss
    // (#6013). Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainRegistrations uses,
    // never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/registrations", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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

  async chain_prometheus({ window, limit }: Row, context: GqlContext) {
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
    // the table is dropped in production, so a D1 query here would always miss
    // (#6013). Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> the
    // schema-stable zeroed card contract REST's handleChainPrometheus uses,
    // never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/prometheus", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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
    };
  },

  async chain_signers(
    { window, limit, sort, call_module: callModule }: Row,
    context: GqlContext,
  ) {
    // Reuse the exact analyticsWindow parse/validate REST's handleChainSigners
    // uses (7d/30d, default 7d) -- an unsupported window is a GraphQL
    // BAD_USER_INPUT error, not a silent empty leaderboard.
    const windowUrl = new URL((context.request as Request).url);
    windowUrl.search = "";
    if (window != null) windowUrl.searchParams.set("window", window);
    const windowResult = analyticsWindow(windowUrl);
    if ("error" in windowResult) {
      const { error } = windowResult;
      throw new GraphQLError(error.message, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const { label } = windowResult;
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
    // Same tryPostgresTier(METAGRAPH_EXTRINSICS_SOURCE) -> buildChainSigners
    // fallback contract handleChainSigners uses, including the KV health:meta
    // observed_at stamp REST passes; no ranking/aggregation logic is duplicated
    // here, and a cold store yields a schema-stable empty leaderboard. #4772 D1
    // retirement: the `extrinsics` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live D1 query.
    const tier = await tryPostgresTier(
      context.env,
      postgresTierRequest(context, "/api/v1/chain/signers", params),
      "METAGRAPH_EXTRINSICS_SOURCE",
    );
    const data =
      (tier as Row | null) ??
      buildChainSigners({
        window: label,
        sort,
        observedAt: await loadObservedAt(context),
        rows: [],
      });
    return {
      schema_version: data.schema_version ?? 1,
      window: data.window ?? label,
      sort: data.sort ?? CHAIN_SIGNERS_SORTS[0],
      observed_at: data.observed_at ?? null,
      signer_count: data.signer_count ?? 0,
      signers: (data.signers ?? []).map((entry: Row) => ({
        signer: entry.signer,
        tx_count: entry.tx_count ?? 0,
        total_fee_tao: entry.total_fee_tao ?? null,
        total_tip_tao: entry.total_tip_tao ?? null,
        last_tx_block: entry.last_tx_block ?? null,
      })),
    };
  },

  async chain_weight_setters({ window, limit }: Row, context: GqlContext) {
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
    // and the table is dropped in production, so a D1 query here would
    // always miss. Postgres → schema-stable empty stub, never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/weights/setters", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) as Row | null) ??
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

  async chain_alpha_volume({ limit }: Row, context: GqlContext) {
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_ALPHA_VOLUME_LIMIT_DEFAULT,
      maxLimit: CHAIN_ALPHA_VOLUME_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) -> buildChainAlphaVolume
    // fallback contract REST's handleChainAlphaVolume uses -- a cold store yields
    // a schema-stable zeroed card (subnet_count 0, empty leaderboard, neutral
    // sentiment), never a GraphQL error. Fixed 24h window, no window arg. #4772 D1
    // retirement: the `account_events` D1 table is dropped in production, so the
    // fallback goes straight to the pure builder with no rows, never a live D1 query.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/alpha-volume", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainIdleStake([])
    // cold fallback contract handleChainIdleStake / MCP get_chain_idle_stake
    // use: a cold/absent tier yields a schema-stable empty ranking, never a
    // GraphQL error. No window/limit args -- current snapshot only.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/idle-stake"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainIdleStake([]);
    return {
      schema_version: data.schema_version ?? 1,
      captured_at: data.captured_at ?? null,
      subnet_count: data.subnet_count ?? 0,
      total_idle_stake_tao: data.total_idle_stake_tao ?? 0,
      subnets: data.subnets || [],
    };
  },

  async chain_stake_flow({ window, limit }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeFlow empty-card fallback REST's handleChainStakeFlow
    // uses. #4909 D1 retirement: never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/stake-flow", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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

  async chain_stake_moves({ window, limit }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeMoves empty-card fallback REST's handleChainStakeMoves
    // uses. #4909 D1 retirement: never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/stake-moves", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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

  async chain_stake_transfers({ window, limit }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainStakeTransfers empty-card fallback REST's
    // handleChainStakeTransfers uses. #4909 D1 retirement: never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/stake-transfers", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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
    { window, sort, limit }: Row,
    context: GqlContext,
  ) {
    const requestedWindow = window ?? DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW;
    if (!Object.hasOwn(CHAIN_TRANSFER_PAIR_WINDOWS, requestedWindow)) {
      throw new GraphQLError(
        unsupportedWindowMessage(requestedWindow, CHAIN_TRANSFER_PAIR_WINDOWS),
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    // Same CHAIN_TRANSFER_PAIR_SORTS allow-list REST validates against; sort is
    // optional (null -> volume default), so only a non-null value is checked.
    if (sort != null && !CHAIN_TRANSFER_PAIR_SORTS.includes(sort)) {
      throw new GraphQLError(
        `"${sort}" is not a supported sort. Supported: ${CHAIN_TRANSFER_PAIR_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT,
      maxLimit: CHAIN_TRANSFER_PAIR_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("window", requestedWindow);
    params.set("limit", String(safeLimit));
    if (sort != null) params.set("sort", sort);
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainTransferPairs empty-card fallback REST uses, including the KV
    // health:meta observed_at stamp. #4909 D1 retirement: never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/transfer-pairs", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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

  async chain_transfers({ window, limit }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ->
    // buildChainTransfers empty-card fallback REST's handleChainTransfers
    // uses, including the KV health:meta observed_at stamp. #4909 D1
    // retirement: never a live D1 read.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/transfers", params),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
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

  async health_trends(_args: unknown, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadBulkHealthTrends
    // fallback contract REST's handleBulkHealthTrends and the get_health_trends
    // MCP tool share -- a cold store yields both windows zeroed, never a
    // GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/health/trends"),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      (
        await loadBulkHealthTrends({
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

  async subnet_health_trends({ netuid }: Row, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_HEALTH_SOURCE) -> loadSubnetHealthTrends D1
    // fallback contract REST's handleHealthTrends and the
    // get_subnet_health_trends MCP tool share -- the route takes no window arg
    // (it returns every configured window), and a subnet with no probe history
    // yields a schema-stable zeroed-windows card, never a GraphQL error. The
    // tier owns the per-surface uptime/latency aggregation; nothing is
    // duplicated here.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, `/api/v1/subnets/${netuid}/health/trends`),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      (await loadSubnetHealthTrends(netuid, {
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

  async subnet_health({ netuid }: QuerySubnet_HealthArgs, context: GqlContext) {
    // Same non-negative netuid gate the other per-subnet resolvers use --
    // GraphQL Int coercion rejects non-integers at parse time; a negative
    // netuid is a BAD_USER_INPUT error, not a silent card.
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new GraphQLError("netuid must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Same live composition REST's subnet-health route (workers/api.mjs's
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
    if (overlaid) {
      return { ...overlaid, reliability };
    }
    return {
      schema_version: 1,
      netuid,
      summary: { status: "unknown", surface_count: 0 },
      operational_observed_at: null,
      health_source: "unavailable",
      reliability,
      surfaces: [],
    };
  },

  async subnet_uptime(
    { netuid, window, min_samples: minSamples }: Row,
    context: GqlContext,
  ) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/subnets/${netuid}/uptime`,
          params,
        ),
        "METAGRAPH_HEALTH_SOURCE",
      )) as Row | null) ??
      ((await loadSubnetUptime(netuid, {
        window: windowParam,
        observedAt: await loadObservedAt(context),
      })) as Row);
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

  async rpc_usage({ window }: Row, context: GqlContext) {
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
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/rpc/usage", params),
        "METAGRAPH_RPC_USAGE_SOURCE",
      )) as Row | null) ??
      (await loadRpcUsage({
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

  async registry_leaderboards({ board, limit }: Row, context: GqlContext) {
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

  async chain_performance(_args: unknown, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainPerformance([])
    // cold fallback contract handleChainPerformance / MCP get_chain_performance
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainPerformance validates
    // against an EMPTY param allowlist, so there is no window/limit arg to
    // mirror -- current snapshot only.
    const data =
      ((await tryPostgresTier(
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainYield([])
    // fallback contract handleChainYield uses -- a cold/absent tier yields a
    // schema-stable zeroed card (every aggregate null), never a GraphQL error.
    const data =
      ((await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/chain/yield"),
        "METAGRAPH_NEURONS_SOURCE",
      )) as Row | null) ?? buildChainYield([]);
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

  async chain_concentration(_args: unknown, context: GqlContext) {
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildChainConcentration([])
    // cold fallback contract handleChainConcentration / MCP get_chain_concentration
    // use: a cold/absent tier yields a schema-stable zeroed card (every metric
    // block null), never a GraphQL error. handleChainConcentration reads every
    // subnet's neurons with no netuid filter and validates against an EMPTY
    // param allowlist, so there is no window/limit arg to mirror -- current
    // snapshot only.
    const data =
      ((await tryPostgresTier(
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

  async subnet_recycled({ netuid }: Row, context: GqlContext) {
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

  async subnet_burn({ netuid }: Row, context: GqlContext) {
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
    return loadSubnetBurn(context.env, netuid);
  },

  async subnet_turnover({ netuid, window, changes }: Row, context: GqlContext) {
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
    // Same tryPostgresTier(METAGRAPH_NEURONS_SOURCE) -> buildTurnover([]) empty-card
    // fallback contract the REST handler uses (neuron_daily boundary snapshots); a
    // subnet with no boundary rows in the window is a schema-stable empty card,
    // never a GraphQL error. The cold fallback carries no `changes` block, so the
    // field resolves to null even when the toggle is set.
    const data =
      ((await tryPostgresTier(
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

  async subnet_ownership_history({ netuid }: Row, context: GqlContext) {
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
    return {
      schema_version: data?.schema_version ?? 1,
      netuid,
      count: data?.count ?? 0,
      ownership_changes: Array.isArray(data?.ownership_changes)
        ? data.ownership_changes
        : [],
    };
  },

  async subnet_conviction({ netuid }: Row, context: GqlContext) {
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
      schema_version: data?.schema_version ?? 1,
      netuid,
      queried_at_block: data?.queried_at_block ?? null,
      unlock_rate: data?.unlock_rate ?? null,
      maturity_rate: data?.maturity_rate ?? null,
      king: data?.king ?? null,
      count: data?.count ?? 0,
      leaderboard: Array.isArray(data?.leaderboard) ? data.leaderboard : [],
    };
  },

  async subnet_lease_history({ netuid }: Row, context: GqlContext) {
    if (!isU16Netuid(netuid)) {
      throw new GraphQLError(
        "netuid must be an integer in the u16 range 0..65535.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const data = await fetchAllEventsTier(
      context,
      `/api/v1/subnets/${netuid}/lease/history`,
    );
    return {
      schema_version: data?.schema_version ?? 1,
      netuid,
      count: data?.count ?? 0,
      lease_events: Array.isArray(data?.lease_events) ? data.lease_events : [],
    };
  },

  async subnet_lease({ netuid }: Row, context: GqlContext) {
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
    return loadSubnetLease(context.env, netuid);
  },

  async account_balance({ ss58 }: Row, context: GqlContext) {
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

  async account_root_claim({ ss58 }: Row, context: GqlContext) {
    if (!isFinneySs58Address(ss58)) {
      throw new GraphQLError("ss58 must be a valid Finney ss58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // Live chain RPC — reuses loadAccountRootClaim's KV cache/TTL, matching
    // REST's handleAccountRootClaim. claim_type/hotkeys stay null on RPC
    // failure (schema-stable), never a GraphQL error. Read-only.
    return loadAccountRootClaim(context.env, ss58);
  },

  async account_children({ ss58 }: Row, context: GqlContext) {
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
    return loadAccountChildren(context.env, ss58);
  },

  async account_parents({ ss58 }: Row, context: GqlContext) {
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
    return loadAccountParents(context.env, ss58);
  },

  async sudo_key(_args: unknown, context: GqlContext) {
    // Live chain RPC, not the Postgres tier -- reuses loadSudoKey's own KV
    // cache/TTL, matching REST's sudo/key handler exactly. hotkey stays null
    // on RPC failure or a renounced sudo (schema-stable), never a GraphQL
    // error. loadSudoKey always sets schema_version/queried_at
    // unconditionally, so no `??` fallback is needed for those.
    return loadSudoKey(context.env);
  },

  async network_parameters(_args: unknown, context: GqlContext) {
    // Live chain RPC, not the Postgres tier -- reuses loadNetworkParameters'
    // own KV cache/TTL, matching REST's /network/parameters handler exactly.
    // Each field stays independently null on its own RPC failure
    // (schema-stable), never a GraphQL error. loadNetworkParameters always
    // sets schema_version/queried_at unconditionally, so no `??` fallback is
    // needed for those.
    return loadNetworkParameters(context.env);
  },
  async network_randomness(_args: unknown, context: GqlContext) {
    // Live chain RPC, not the Postgres tier -- reuses loadRandomnessStatus'
    // own KV cache/TTL, matching REST's /network/randomness handler exactly.
    // Each round field stays independently null on RPC failure (schema-stable),
    // never a GraphQL error; schema_version/queried_at are always set.
    return loadRandomnessStatus(context.env);
  },
  // #7649: the get_randomness_status-aligned name for the same beacon snapshot
  // -- a thin delegate so MCP tool names and GraphQL fields line up. Identical
  // loader, KV cache/TTL, and independently-null RPC-failure behavior; nothing
  // re-implemented.
  async randomness_status(_args: unknown, context: GqlContext) {
    return rootValue.network_randomness(_args, context);
  },
  async evm_address({ h160 }: Row, context: GqlContext) {
    return resolveEvmAddressMapping(h160, context);
  },
  // Same resolver as evm_address, under the get_evm_address_mapping tool name so
  // MCP and GraphQL agree; delegating rather than duplicating keeps the two
  // fields from ever drifting apart.
  async evm_address_mapping({ h160 }: Row, context: GqlContext) {
    return resolveEvmAddressMapping(h160, context);
  },
};

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

export async function handleGraphQLRequest(request: Request, env: Env) {
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
    rootValue,
    contextValue: { env, cache: new Map(), request },
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });

  // metagraphed#7734: execute() catches every resolver throw into
  // result.errors rather than letting it propagate -- api.sentry.ts's
  // withSentry() (uncaught exceptions only) never sees any of these, so this
  // is the only place a genuine resolver fault can reach Sentry at all. A
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
    Sentry.captureException(fault.originalError, {
      tags: { route: "graphql" },
    });
    // metagraphed#7758: PostHog $exception capture, parallel-run alongside
    // Sentry above. handleGraphQLRequest has no ExecutionContext (see this
    // function's own comment in workers/api.mjs), so this is awaited inline
    // rather than fire-and-forget via waitUntil -- the only real cost is a
    // little latency on this already-failing response, not silent event
    // loss from an isolate torn down mid-fetch.
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
