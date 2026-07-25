// Equivalence-diff audit for the Zod-generated MCP tool schemas (types-epic
// E, #7863 requirement 3): compares each converted tool's Zod-generated
// input/output JSON Schema against the hand-written literal it replaces,
// after normalizing the specific cosmetic differences z.toJSONSchema()
// introduces (documented inline below, mirroring
// scripts/diff-openapi-zod-components.ts's methodology for types-epic B).
// Anything left after normalization is a real difference and must be
// resolved before merge, not silenced here.
//
// The "old" schemas are hand-transcribed from the literals each batch's
// conversion commit replaced (see that commit's diff for src/mcp-server.ts /
// src/global-operational-health.ts / src/network-economics.ts /
// src/health-history-mcp.ts) -- there is no structured old artifact to read
// (unlike B's hand-edited JSON Schema files), since the originals were
// inline JS object literals inside .ts source, not their own JSON files.
// Kept here as the audit's fixed baseline; add a new OLD_SCHEMAS entry
// (never edit an existing one) for each future batch under this issue.
// Batch 1 (pilot, #7863, PR #8087): search_subnets, list_subnets,
// get_subnet, get_network_health, get_subnet_stake_quote, get_economics.
// Batch 2 (#8065): find_subnets_by_capability, get_subnet_detail,
// get_subnet_snapshot, get_subnet_health(+trends/percentiles/incidents),
// get_health_trends, get_subnet_economics, get_stake_action_preview,
// get_subnet_trajectory, get_subnet_concentration, get_subnet_performance,
// get_subnet_idle_stake, get_subnet_movers, get_subnet_uptime,
// get_health_history.
import { z } from "zod";
import {
  SearchSubnetsInputSchema,
  SearchSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/search-subnets.ts";
import {
  ListSubnetsInputSchema,
  ListSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/list-subnets.ts";
import {
  GetSubnetInputSchema,
  GetSubnetOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet.ts";
import {
  GetNetworkHealthInputSchema,
  GetNetworkHealthOutputSchema,
} from "../schemas-src/mcp-tools/get-network-health.ts";
import {
  GetSubnetStakeQuoteInputSchema,
  GetSubnetStakeQuoteOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-stake-quote.ts";
import {
  GetEconomicsInputSchema,
  GetEconomicsOutputSchema,
} from "../schemas-src/mcp-tools/get-economics.ts";
import {
  FindSubnetsByCapabilityInputSchema,
  FindSubnetsByCapabilityOutputSchema,
} from "../schemas-src/mcp-tools/find-subnets-by-capability.ts";
import {
  GetSubnetDetailInputSchema,
  GetSubnetDetailOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-detail.ts";
import {
  GetSubnetSnapshotInputSchema,
  GetSubnetSnapshotOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-snapshot.ts";
import {
  GetSubnetHealthInputSchema,
  GetSubnetHealthOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health.ts";
import {
  GetSubnetHealthTrendsInputSchema,
  GetSubnetHealthTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-trends.ts";
import {
  GetHealthTrendsInputSchema,
  GetHealthTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-health-trends.ts";
import {
  GetSubnetHealthPercentilesInputSchema,
  GetSubnetHealthPercentilesOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-percentiles.ts";
import {
  GetSubnetHealthIncidentsInputSchema,
  GetSubnetHealthIncidentsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-incidents.ts";
import {
  GetSubnetEconomicsInputSchema,
  GetSubnetEconomicsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-economics.ts";
import {
  GetStakeActionPreviewInputSchema,
  GetStakeActionPreviewOutputSchema,
} from "../schemas-src/mcp-tools/get-stake-action-preview.ts";
import {
  GetSubnetTrajectoryInputSchema,
  GetSubnetTrajectoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-trajectory.ts";
import {
  GetSubnetConcentrationInputSchema,
  GetSubnetConcentrationOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-concentration.ts";
import {
  GetSubnetPerformanceInputSchema,
  GetSubnetPerformanceOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-performance.ts";
import {
  GetSubnetIdleStakeInputSchema,
  GetSubnetIdleStakeOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-idle-stake.ts";
import {
  GetSubnetMoversInputSchema,
  GetSubnetMoversOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-movers.ts";
import {
  GetSubnetUptimeInputSchema,
  GetSubnetUptimeOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-uptime.ts";
import {
  GetHealthHistoryInputSchema,
  GetHealthHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-health-history.ts";
import {
  GetBlocksSummaryInputSchema,
  GetBlocksSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-blocks-summary.ts";
import {
  GetSubnetConcentrationHistoryInputSchema,
  GetSubnetConcentrationHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-concentration-history.ts";
import {
  GetSubnetTurnoverInputSchema,
  GetSubnetTurnoverOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-turnover.ts";
import {
  GetSubnetYieldInputSchema,
  GetSubnetYieldOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-yield.ts";
import {
  GetSubnetYieldHistoryInputSchema,
  GetSubnetYieldHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-yield-history.ts";
import {
  GetSubnetStakeFlowInputSchema,
  GetSubnetStakeFlowOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-stake-flow.ts";
import {
  GetSubnetEventSummaryInputSchema,
  GetSubnetEventSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-event-summary.ts";
import {
  GetSubnetWeightsInputSchema,
  GetSubnetWeightsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-weights.ts";
import {
  GetSubnetWeightSettersInputSchema,
  GetSubnetWeightSettersOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-weight-setters.ts";
import {
  GetSubnetRegistrationsInputSchema as GetSubnetRegistrationsMcpInputSchema,
  GetSubnetRegistrationsOutputSchema as GetSubnetRegistrationsMcpOutputSchema,
  GetSubnetStakeMovesInputSchema,
  GetSubnetStakeMovesOutputSchema,
  GetSubnetStakeTransfersInputSchema,
  GetSubnetStakeTransfersOutputSchema,
  GetSubnetAxonRemovalsInputSchema as GetSubnetAxonRemovalsMcpInputSchema,
  GetSubnetAxonRemovalsOutputSchema as GetSubnetAxonRemovalsMcpOutputSchema,
  GetSubnetServingInputSchema as GetSubnetServingMcpInputSchema,
  GetSubnetServingOutputSchema as GetSubnetServingMcpOutputSchema,
  GetSubnetPrometheusInputSchema,
  GetSubnetPrometheusOutputSchema,
  GetSubnetDeregistrationsInputSchema as GetSubnetDeregistrationsMcpInputSchema,
  GetSubnetDeregistrationsOutputSchema as GetSubnetDeregistrationsMcpOutputSchema,
} from "../schemas-src/mcp-tools/subnet-activity.ts";
import {
  GetSubnetPerformanceHistoryInputSchema,
  GetSubnetPerformanceHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-performance-history.ts";
import {
  GetEconomicsTrendsInputSchema,
  GetEconomicsTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-economics-trends.ts";
import {
  GetRegistryLeaderboardsInputSchema,
  GetRegistryLeaderboardsOutputSchema,
} from "../schemas-src/mcp-tools/get-registry-leaderboards.ts";
import {
  GetDomainSummaryInputSchema,
  GetDomainSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-domain-summary.ts";
import {
  ListProfilesInputSchema,
  ListProfilesOutputSchema,
  GetSubnetProfileInputSchema,
  GetSubnetProfileOutputSchema,
} from "../schemas-src/mcp-tools/profiles.ts";
import {
  CompareSubnetsInputSchema,
  CompareSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/compare-subnets.ts";
import {
  GetSubnetMetagraphInputSchema,
  GetSubnetMetagraphOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-metagraph.ts";
import {
  GetSubnetHistoryInputSchema,
  GetSubnetHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-history.ts";
import {
  GetSubnetIdentityHistoryInputSchema,
  GetSubnetIdentityHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-identity-history.ts";
import {
  GetSubnetEventsInputSchema,
  GetSubnetEventsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-events.ts";
import {
  GetSubnetHyperparamsInputSchema,
  GetSubnetHyperparamsOutputSchema,
  GetSubnetHyperparamsHistoryInputSchema,
  GetSubnetHyperparamsHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-hyperparams.ts";
import {
  GetSubnetVolumeInputSchema,
  GetSubnetVolumeOutputSchema,
  GetSubnetOhlcInputSchema,
  GetSubnetOhlcOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-volume-ohlc.ts";
import {
  GetSubnetOwnershipHistoryInputSchema,
  GetSubnetOwnershipHistoryOutputSchema,
  GetSubnetConvictionInputSchema,
  GetSubnetConvictionOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-ownership-conviction.ts";
import {
  GetSubnetRecycledInputSchema,
  GetSubnetRecycledOutputSchema,
  GetSubnetBurnInputSchema,
  GetSubnetBurnOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-recycled-burn.ts";
import {
  GetSubnetLeaseInputSchema,
  GetSubnetLeaseOutputSchema,
  GetSubnetLeaseHistoryInputSchema,
  GetSubnetLeaseHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-lease.ts";
import {
  GetGlobalIncidentsInputSchema,
  GetGlobalIncidentsOutputSchema,
} from "../schemas-src/mcp-tools/get-global-incidents.ts";
import {
  ListSubnetValidatorsInputSchema,
  ListSubnetValidatorsOutputSchema,
  ListGlobalValidatorsInputSchema,
  ListGlobalValidatorsOutputSchema,
  GetValidatorDetailInputSchema,
  GetValidatorDetailOutputSchema,
  CompareValidatorsInputSchema,
  CompareValidatorsOutputSchema,
  GetValidatorNominatorsInputSchema,
  GetValidatorNominatorsOutputSchema,
  GetValidatorHistoryInputSchema,
  GetValidatorHistoryOutputSchema,
} from "../schemas-src/mcp-tools/validators.ts";
import {
  GetWebhookSubscriptionInputSchema,
  GetWebhookSubscriptionOutputSchema,
} from "../schemas-src/mcp-tools/get-webhook-subscription.ts";
import {
  GetAlertTriggerInputSchema,
  GetAlertTriggerOutputSchema,
} from "../schemas-src/mcp-tools/get-alert-trigger.ts";
import {
  GetNeuronInputSchema,
  GetNeuronOutputSchema,
  GetNeuronHistoryInputSchema,
  GetNeuronHistoryOutputSchema,
} from "../schemas-src/mcp-tools/neurons.ts";
import {
  GetAccountInputSchema,
  GetAccountOutputSchema,
  GetAccountEntitiesInputSchema,
  GetAccountEntitiesOutputSchema,
  GetAccountEventsInputSchema,
  GetAccountEventsOutputSchema,
  GetAccountSubnetsInputSchema,
  GetAccountSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/account-summary.ts";
import {
  GetAccountBalanceInputSchema,
  GetAccountBalanceOutputSchema,
} from "../schemas-src/mcp-tools/account-balance.ts";
import {
  GetAccountRootClaimInputSchema,
  GetAccountRootClaimOutputSchema,
} from "../schemas-src/mcp-tools/account-root-claim.ts";
import {
  GetAccountChildrenInputSchema,
  GetAccountChildrenOutputSchema,
  GetAccountParentsInputSchema,
  GetAccountParentsOutputSchema,
} from "../schemas-src/mcp-tools/account-delegation.ts";
import {
  GetAccountPortfolioInputSchema,
  GetAccountPortfolioOutputSchema,
  GetAccountPositionsInputSchema,
  GetAccountPositionsOutputSchema,
  GetAccountSnapshotInputSchema,
  GetAccountSnapshotOutputSchema,
} from "../schemas-src/mcp-tools/account-portfolio.ts";
import {
  GetAccountIdentityInputSchema,
  GetAccountIdentityOutputSchema,
  GetAccountIdentityHistoryInputSchema,
  GetAccountIdentityHistoryOutputSchema,
} from "../schemas-src/mcp-tools/account-identity.ts";
import {
  GetAccountPositionHistoryInputSchema,
  GetAccountPositionHistoryOutputSchema,
} from "../schemas-src/mcp-tools/account-position-history.ts";
import {
  GetAccountStakeFlowInputSchema,
  GetAccountStakeFlowOutputSchema,
} from "../schemas-src/mcp-tools/account-stake-flow.ts";
import {
  GetAccountStakeMovesInputSchema,
  GetAccountStakeMovesOutputSchema,
  GetAccountAxonRemovalsInputSchema,
  GetAccountAxonRemovalsOutputSchema,
  GetAccountPrometheusInputSchema,
  GetAccountPrometheusOutputSchema,
  GetAccountRegistrationsInputSchema,
  GetAccountRegistrationsOutputSchema,
  GetAccountWeightSettersInputSchema,
  GetAccountWeightSettersOutputSchema,
  GetAccountServingInputSchema,
  GetAccountServingOutputSchema,
  GetAccountDeregistrationsInputSchema,
  GetAccountDeregistrationsOutputSchema,
} from "../schemas-src/mcp-tools/account-footprints.ts";
import {
  GetAccountHistoryInputSchema,
  GetAccountHistoryOutputSchema,
} from "../schemas-src/mcp-tools/account-history.ts";
import {
  GetAccountExtrinsicsInputSchema,
  GetAccountExtrinsicsOutputSchema,
} from "../schemas-src/mcp-tools/account-extrinsics.ts";
import {
  GetAccountTransfersInputSchema,
  GetAccountTransfersOutputSchema,
  GetAccountCounterpartiesInputSchema,
  GetAccountCounterpartiesOutputSchema,
} from "../schemas-src/mcp-tools/account-transfers.ts";
import {
  ListAccountsInputSchema,
  ListAccountsOutputSchema,
  GetTopHoldersInputSchema,
  GetTopHoldersOutputSchema,
} from "../schemas-src/mcp-tools/accounts-leaderboards.ts";
import {
  DecodeEvmCallInputSchema,
  DecodeEvmCallOutputSchema,
  GetEvmAddressMappingInputSchema,
  GetEvmAddressMappingOutputSchema,
} from "../schemas-src/mcp-tools/evm.ts";
import {
  ListBlocksInputSchema,
  ListBlocksOutputSchema,
  GetBlockInputSchema,
  GetBlockOutputSchema,
  ListBlockExtrinsicsInputSchema,
  ListBlockExtrinsicsOutputSchema,
  GetBlockEventsInputSchema,
  GetBlockEventsOutputSchema,
} from "../schemas-src/mcp-tools/blocks.ts";
import {
  ListExtrinsicsInputSchema,
  ListExtrinsicsOutputSchema,
  GetExtrinsicInputSchema,
  GetExtrinsicOutputSchema,
} from "../schemas-src/mcp-tools/extrinsics.ts";
import {
  GetSudoInputSchema,
  GetSudoOutputSchema,
  GetSudoKeyInputSchema,
  GetSudoKeyOutputSchema,
  GetGovernanceConfigChangesInputSchema,
  GetGovernanceConfigChangesOutputSchema,
} from "../schemas-src/mcp-tools/governance-feeds.ts";
import {
  GetNetworkParametersInputSchema,
  GetNetworkParametersOutputSchema,
  GetRandomnessStatusInputSchema,
  GetRandomnessStatusOutputSchema,
} from "../schemas-src/mcp-tools/network-live.ts";
import {
  GetRuntimeInputSchema,
  GetRuntimeOutputSchema,
} from "../schemas-src/mcp-tools/runtime.ts";
import {
  GetBlockChainEventsInputSchema,
  GetBlockChainEventsOutputSchema,
  GetExtrinsicChainEventsInputSchema,
  GetExtrinsicChainEventsOutputSchema,
} from "../schemas-src/mcp-tools/chain-events.ts";
import {
  GetChainConcentrationInputSchema,
  GetChainConcentrationOutputSchema,
  GetChainPerformanceInputSchema,
  GetChainPerformanceOutputSchema,
  GetChainIdleStakeInputSchema,
  GetChainIdleStakeOutputSchema,
  GetChainYieldInputSchema,
  GetChainYieldOutputSchema,
} from "../schemas-src/mcp-tools/chain-scorecards.ts";
import {
  GetChainIdentityHistoryInputSchema,
  GetChainIdentityHistoryOutputSchema,
} from "../schemas-src/mcp-tools/chain-identity-history.ts";
import {
  GetChainTurnoverInputSchema,
  GetChainTurnoverOutputSchema,
  GetChainStakeFlowInputSchema,
  GetChainStakeFlowOutputSchema,
  GetChainAlphaVolumeInputSchema,
  GetChainAlphaVolumeOutputSchema,
  GetChainWeightsInputSchema,
  GetChainWeightsOutputSchema,
  GetChainWeightSettersInputSchema,
  GetChainWeightSettersOutputSchema,
  GetChainStakeMovesInputSchema,
  GetChainStakeMovesOutputSchema,
  GetChainStakeTransfersInputSchema,
  GetChainStakeTransfersOutputSchema,
  GetChainAxonRemovalsInputSchema,
  GetChainAxonRemovalsOutputSchema,
  GetChainServingInputSchema,
  GetChainServingOutputSchema,
  GetChainPrometheusInputSchema,
  GetChainPrometheusOutputSchema,
} from "../schemas-src/mcp-tools/chain-leaderboards.ts";
import {
  GetChainRegistrationsInputSchema,
  GetChainRegistrationsOutputSchema,
  GetChainDeregistrationsInputSchema,
  GetChainDeregistrationsOutputSchema,
} from "../schemas-src/mcp-tools/chain-registrations.ts";
import {
  GetChainActivityInputSchema,
  GetChainActivityOutputSchema,
  ListChainEventsInputSchema,
  ListChainEventsOutputSchema,
  GetNetworkActivityInputSchema,
  GetNetworkActivityOutputSchema,
} from "../schemas-src/mcp-tools/chain-events-activity.ts";
import {
  GetChainCallsInputSchema,
  GetChainCallsOutputSchema,
  GetChainSignersInputSchema,
  GetChainSignersOutputSchema,
  GetChainFeesInputSchema,
  GetChainFeesOutputSchema,
} from "../schemas-src/mcp-tools/chain-calls-fees.ts";
import {
  GetChainTransfersInputSchema,
  GetChainTransfersOutputSchema,
  GetChainTransferPairsInputSchema,
  GetChainTransferPairsOutputSchema,
} from "../schemas-src/mcp-tools/chain-transfers.ts";
import {
  ListSubnetApisInputSchema,
  ListSubnetApisOutputSchema,
  GetApiSchemaInputSchema,
  GetApiSchemaOutputSchema,
  GetFixtureInputSchema,
  GetFixtureOutputSchema,
  GetProviderDetailInputSchema,
  GetProviderDetailOutputSchema,
} from "../schemas-src/mcp-tools/catalog-detail.ts";
import {
  ListEndpointsInputSchema,
  ListEndpointsOutputSchema,
  GetSubnetEndpointsInputSchema,
  GetSubnetEndpointsOutputSchema,
} from "../schemas-src/mcp-tools/endpoints-catalog.ts";
import {
  ListProvidersInputSchema,
  ListProvidersOutputSchema,
  ListSurfacesInputSchema,
  ListSurfacesOutputSchema,
  ListCandidatesInputSchema,
  ListCandidatesOutputSchema,
} from "../schemas-src/mcp-tools/registry-catalogs-1.ts";
import {
  ListEvidenceInputSchema,
  ListEvidenceOutputSchema,
  ListRpcEndpointsInputSchema,
  ListRpcEndpointsOutputSchema,
  ListRpcPoolsInputSchema,
  ListRpcPoolsOutputSchema,
  ListSourceSnapshotsInputSchema,
  ListSourceSnapshotsOutputSchema,
  ListProfileCompletenessInputSchema,
  ListProfileCompletenessOutputSchema,
} from "../schemas-src/mcp-tools/registry-catalogs-2.ts";
import {
  ListSubnetEndpointsInputSchema,
  ListSubnetEndpointsOutputSchema,
  ListSubnetSurfacesInputSchema,
  ListSubnetSurfacesOutputSchema,
  ListSubnetHealthInputSchema,
  ListSubnetHealthOutputSchema,
} from "../schemas-src/mcp-tools/subnet-scoped-lists.ts";
import {
  GetSubnetCandidatesInputSchema,
  GetSubnetCandidatesOutputSchema,
  ListSubnetCandidatesInputSchema,
  ListSubnetCandidatesOutputSchema,
  GetSubnetEvidenceInputSchema,
  GetSubnetEvidenceOutputSchema,
  ListSubnetEvidenceInputSchema,
  ListSubnetEvidenceOutputSchema,
  GetSubnetSurfacesInputSchema,
  GetSubnetSurfacesOutputSchema,
} from "../schemas-src/mcp-tools/subnet-registry-lists.ts";
import {
  ListFixturesInputSchema,
  ListFixturesOutputSchema,
  ListSchemasInputSchema,
  ListSchemasOutputSchema,
} from "../schemas-src/mcp-tools/catalog-indexes.ts";
import {
  ListSearchIndexInputSchema,
  ListSearchIndexOutputSchema,
  ListSearchInputSchema,
  ListSearchOutputSchema,
} from "../schemas-src/mcp-tools/search-documents.ts";
import {
  ListCurationInputSchema,
  ListCurationOutputSchema,
  ListGapsInputSchema,
  ListGapsOutputSchema,
} from "../schemas-src/mcp-tools/curation-and-gaps.ts";
import {
  ListEnrichmentQueueInputSchema,
  ListEnrichmentQueueOutputSchema,
  ListAdapterCandidatesInputSchema,
  ListAdapterCandidatesOutputSchema,
} from "../schemas-src/mcp-tools/enrichment-queue-and-candidates.ts";
import {
  ListEnrichmentEvidenceInputSchema,
  ListEnrichmentEvidenceOutputSchema,
  ListReviewGapsInputSchema,
  ListReviewGapsOutputSchema,
  ListReviewEnrichmentTargetsInputSchema,
  ListReviewEnrichmentTargetsOutputSchema,
} from "../schemas-src/mcp-tools/enrichment-evidence-and-targets.ts";
import {
  ListEndpointPoolsInputSchema,
  ListEndpointPoolsOutputSchema,
  ListEndpointIncidentsInputSchema,
  ListEndpointIncidentsOutputSchema,
  ListProviderEndpointsInputSchema,
  ListProviderEndpointsOutputSchema,
} from "../schemas-src/mcp-tools/endpoint-pools-and-provider.ts";
import {
  GetLineageInputSchema,
  GetLineageOutputSchema,
  GetFreshnessInputSchema,
  GetFreshnessOutputSchema,
  GetContractsInputSchema,
  GetContractsOutputSchema,
  GetSourceHealthInputSchema,
  GetSourceHealthOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-1.ts";
import {
  GetChangelogInputSchema,
  GetChangelogOutputSchema,
  GetBuildInputSchema,
  GetBuildOutputSchema,
  GetCoverageInputSchema,
  GetCoverageOutputSchema,
  GetCoverageDepthInputSchema,
  GetCoverageDepthOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";
import {
  GetFeedInputSchema,
  GetFeedOutputSchema,
} from "../schemas-src/mcp-tools/feed.ts";
import {
  GetAdapterInputSchema,
  GetAdapterOutputSchema,
} from "../schemas-src/mcp-tools/get-adapter.ts";
import {
  GetAgentCatalogInputSchema,
  GetAgentCatalogOutputSchema,
  GetAgentResourcesInputSchema,
  GetAgentResourcesOutputSchema,
} from "../schemas-src/mcp-tools/agent-catalog-resources.ts";
import {
  GetRpcUsageInputSchema,
  GetRpcUsageOutputSchema,
  GetBestRpcEndpointInputSchema,
  GetBestRpcEndpointOutputSchema,
  CallRpcInputSchema,
  CallRpcOutputSchema,
} from "../schemas-src/mcp-tools/rpc-tools.ts";
import {
  QueryGraphqlInputSchema,
  QueryGraphqlOutputSchema,
  RunSavedQueryInputSchema,
  RunSavedQueryOutputSchema,
} from "../schemas-src/mcp-tools/query-tools.ts";
import {
  RegistrySummaryInputSchema,
  RegistrySummaryOutputSchema,
  ListEnrichmentTargetsInputSchema,
  ListEnrichmentTargetsOutputSchema,
  GetSubnetGapsInputSchema,
  GetSubnetGapsOutputSchema,
  ListSubnetGapsInputSchema,
  ListSubnetGapsOutputSchema,
} from "../schemas-src/mcp-tools/registry-summary-gaps.ts";
import {
  FindSubnetOpportunitiesInputSchema,
  FindSubnetOpportunitiesOutputSchema,
  SemanticSearchInputSchema,
  SemanticSearchOutputSchema,
  AskInputSchema,
  AskOutputSchema,
  FindSubnetForTaskInputSchema,
  FindSubnetForTaskOutputSchema,
} from "../schemas-src/mcp-tools/ai-discovery.ts";
import {
  HowDoICallInputSchema,
  HowDoICallOutputSchema,
  VerifyIntegrationInputSchema,
  VerifyIntegrationOutputSchema,
  CallSubnetSurfaceInputSchema,
  CallSubnetSurfaceOutputSchema,
} from "../schemas-src/mcp-tools/ai-integration.ts";

type Row = Record<string, unknown>;

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };
const ANY = {};
const objectItems = (properties: Row = {}) => ({
  type: "array",
  items: { type: "object", additionalProperties: true, properties },
});

// Resolved literal values for the enums the old schemas referenced
// symbolically (QUERY_ENUMS.*, API_QUERY_COLLECTIONS.economics.sort_fields)
// -- see src/contracts.ts, cross-checked against the actual runtime arrays
// at the time of writing.
const COVERAGE_LEVEL = ["native-only", "manifested", "probed"];
const CURATION_LEVEL = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
];
const LIST_SUBNETS_SORT_FIELDS = [
  "netuid",
  "integration_readiness",
  "surface_count",
  "name",
];
const LIST_SUBNETS_ORDERS = ["asc", "desc"];
const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"];
const ECONOMICS_SORT_FIELDS = [
  "alpha_fdv_tao",
  "alpha_market_cap_tao",
  "alpha_price_change_1d",
  "alpha_price_change_1h",
  "alpha_price_change_1m",
  "alpha_price_change_7d",
  "alpha_price_tao",
  "block",
  "emission_share",
  "max_stake_tao",
  "max_uids",
  "max_validators",
  "miner_count",
  "miner_readiness",
  "name",
  "netuid",
  "open_slots",
  "registration_cost_tao",
  "subnet_volume_tao",
  "total_stake_tao",
  "validator_count",
];
// Batch-2 (#8065) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/movers.ts's MOVERS_WINDOWS/MOVERS_SORTS,
// src/contracts.ts's QUERY_ENUMS/API_QUERY_COLLECTIONS), cross-checked
// against the actual runtime source at the time of writing.
const HEALTH_WINDOWS = ["7d", "30d"];
const UPTIME_WINDOWS = ["90d", "1y"];
const MOVERS_WINDOW_KEYS = ["7d", "30d", "90d"];
const MOVERS_SORTS = ["stake", "emission", "validators", "neurons"];
const MOVERS_LIMIT_MAX = 100;
const SURFACE_KIND = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
];
const HEALTH_STATUS = ["ok", "degraded", "failed", "unknown"];
const HEALTH_CLASSIFICATION = [
  "auth-required",
  "content-mismatch",
  "dead",
  "live",
  "rate-limited",
  "redirected",
  "timeout",
  "transient",
  "unsupported",
  "unsafe",
  "wrong-chain",
];
const HEALTH_SURFACE_SORT_FIELDS = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
];

// Batch 3 (#8066) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (each tool's own src/subnet-*.ts WINDOWS
// constant, src/stake-flow.ts's STAKE_FLOW_WINDOWS/DIRECTIONS,
// src/neuron-history.ts's HISTORY_WINDOWS), cross-checked against the
// actual runtime source at the time of writing.
const ACTIVITY_WINDOWS = ["7d", "30d"];
const HISTORY_WINDOWS_3 = ["7d", "30d", "90d"];
const HISTORY_WINDOWS_5 = ["7d", "30d", "90d", "1y", "all"];
const STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"];
const STAKE_FLOW_DIRECTIONS = ["all", "in", "out"];
// Batch 4 (#8067) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/health-serving.ts's LEADERBOARD_BOARDS,
// src/domain-tags.ts's DOMAIN_TAGS, src/contracts.ts's QUERY_ENUMS + the
// "profiles" query collection's sort_fields, src/subnet-ohlc.ts's
// OHLC_INTERVALS, src/neuron-history.ts's HISTORY_WINDOWS), cross-checked
// against the actual runtime source at the time of writing.
const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
];
const DOMAIN_TAGS = [
  "agents",
  "compute",
  "data",
  "finance",
  "inference",
  "media",
  "prediction",
  "privacy",
  "robotics",
  "science",
  "search",
  "security",
  "storage",
  "training",
];
const PROFILE_SUBNET_TYPE = ["root", "application"];
const PROFILE_CURATION_LEVEL = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
];
const PROFILE_LEVEL = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
];
const PROFILES_SORT_FIELDS_4 = [
  "candidate_count",
  "completeness_score",
  "curation_level",
  "interface_count",
  "missing_critical_count",
  "name",
  "netuid",
  "operational_interface_count",
  "profile_level",
  "review_state",
];
const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const HISTORY_WINDOWS_4 = ["7d", "30d", "90d", "1y", "all"];
const OHLC_INTERVALS_4 = ["1h", "1d"];

// Batch 5 (#8068) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/contracts.ts's
// API_QUERY_COLLECTIONS.incidents.sort_fields, src/metagraph-neurons.ts's
// GLOBAL_VALIDATOR_SORTS, src/validator-nominators.ts's NOMINATOR_SORTS;
// NOMINATOR_WINDOWS' keys and get_validator_history/get_neuron_history's
// window sets reuse HISTORY_WINDOWS_3/HISTORY_WINDOWS_5 above -- same literal
// value sets), cross-checked against the actual runtime source at the time
// of writing.
const GLOBAL_INCIDENTS_SORT_FIELDS = [
  "downtime_ms",
  "incident_count",
  "netuid",
  "surface_id",
];
const GLOBAL_VALIDATOR_SORTS = [
  "avg_validator_trust",
  "max_validator_trust",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
];
const NOMINATOR_SORTS = ["net_staked", "gross_staked", "last_activity"];
// Mirrors workers/config.ts's SS58_ADDRESS_PATTERN.source (src/mcp-server.ts's
// SS58_PATTERN_SOURCE), cross-checked against the actual runtime value at the
// time of writing.
const SS58_PATTERN = "^[1-9A-HJ-NP-Za-km-z]{47,48}$";

// Batch 6 (#8070) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (each account-footprint tool's own
// src/account-*.ts *_WINDOWS constant, src/accounts-list.ts's
// ACCOUNTS_LIST_SORTS, src/top-holders.ts's TOP_HOLDERS_SORTS), cross-checked
// against the actual runtime source at the time of writing. Mirrors
// src/mcp-server.ts's H160_PATTERN.source for the two EVM tools.
const ACCOUNT_FOOTPRINT_WINDOWS_3 = ["7d", "30d", "90d"];
const ACCOUNT_WEIGHT_SETTERS_WINDOWS_2 = ["7d", "30d"];
const ACCOUNTS_LIST_SORTS = [
  "total_stake",
  "total_emission",
  "subnet_count",
  "uid_count",
  "validator_count",
  "stake_dominance",
  "last_active",
];
const TOP_HOLDERS_SORTS = [
  "total_tao",
  "free_tao",
  "delegated_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
];
const H160_PATTERN = "^0x[0-9a-fA-F]{40}$";

// Batch 9 (#8072) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (each chain-* leaderboard tool's own
// src/chain-*.ts *_WINDOWS/*_LIMIT_MAX/*_LIMIT_DEFAULT constants, cross-
// checked against the actual runtime source at the time of writing).
// get_chain_calls/signers/fees/registrations/network_activity/list_chain_events
// use a LITERAL inline ["7d","30d"] enum in their own hand-written originals
// (no symbolic *_WINDOWS import there either) -- CHAIN_ANALYTICS_WINDOWS_2
// covers both cases since the values are identical.
const CHAIN_ANALYTICS_WINDOWS_2 = ["7d", "30d"];
// The 8-field distribution-stats shape (count/mean/min/p25/median/p75/p90/
// max) 9 of this batch's "chain leaderboard" tools use identically for their
// `*_distribution` field -- mirrors schemas-src/mcp-tools/shared.ts's
// DistributionStatsSchema.
const DISTRIBUTION_STATS = {
  type: "object",
  additionalProperties: false,
  required: ["count", "mean", "min", "p25", "median", "p75", "p90", "max"],
  properties: {
    count: { type: "integer" },
    mean: { type: "number" },
    min: { type: "number" },
    p25: { type: "number" },
    median: { type: "number" },
    p75: { type: "number" },
    p90: { type: "number" },
    max: { type: "number" },
  },
};

// Batch 9 (#8073) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/contracts.ts's QUERY_ENUMS.* and
// API_QUERY_COLLECTIONS.{providers,curated-surfaces,candidates,claims,
// rpc-pools,sources,profile-completeness}.sort_fields), cross-checked
// against the actual runtime source at the time of writing. Reuses
// SURFACE_KIND/HEALTH_STATUS/HEALTH_CLASSIFICATION/HEALTH_SURFACE_SORT_FIELDS/
// PROFILE_LEVEL already defined above (batches 2-4) -- confirmed identical to
// this batch's own QUERY_ENUMS.surfaceKind/healthStatus/healthClassification/
// API_QUERY_COLLECTIONS["health-surfaces"].sort_fields/QUERY_ENUMS.profileLevel
// values, not just reused by name.
const PROVIDER_KINDS = [
  "data-provider",
  "docs-provider",
  "infrastructure-provider",
  "registry",
  "subnet-team",
];
const PROVIDER_AUTHORITIES = [
  "community",
  "official",
  "provider-claimed",
  "registry-observed",
];
const PROVIDER_SORT_FIELDS = ["authority", "id", "kind", "name"];
const SURFACE_SORT_FIELDS = ["id", "kind", "name", "netuid", "provider"];
const CANDIDATE_STATES = [
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected",
];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];
const CANDIDATES_SORT_FIELDS = [
  "confidence",
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
  "state",
];
const CLAIM_SORT_FIELDS = ["claim", "source_url", "subject", "verified_at"];
const ENDPOINT_LAYERS = [
  "bittensor-base",
  "data-provider",
  "docs-provider",
  "subnet-app",
];
const ENDPOINT_PUBLICATION_STATES = [
  "candidate",
  "verified",
  "monitored",
  "pool-eligible",
  "disabled",
  "rejected",
];
const ENDPOINT_SORT_FIELDS = [
  "kind",
  "last_checked",
  "latency_ms",
  "layer",
  "netuid",
  "pool_eligible",
  "provider",
  "publication_state",
  "score",
  "status",
];
const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"];
const POOL_SORT_FIELDS = ["eligible_count", "endpoint_count", "id", "kind"];
const SOURCE_SORT_FIELDS = ["id", "kind", "path", "record_count"];
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"];
const NATIVE_NAME_QUALITIES = ["chain", "placeholder", "empty"];
const PROFILE_SORT_FIELDS = [
  "candidate_count",
  "completeness_score",
  "identity_level",
  "identity_promotion_kind_count",
  "identity_surface_count",
  "live_identity_candidate_kind_count",
  "missing_critical_count",
  "name",
  "native_identity_signal_count",
  "native_name_quality",
  "netuid",
  "priority_score",
  "profile_level",
  "stale_identity_candidate_kind_count",
];
const BOOLEAN_STRINGS = ["true", "false"];

// Batch 10 (#8074) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/contracts.ts's QUERY_ENUMS.* and
// API_QUERY_COLLECTIONS.{documents,curation,gaps,enrichment-queue,
// adapter-candidates,enrichment-evidence,review-gap-priorities,
// enrichment-targets,endpoint-pools,endpoint-incidents,endpoints}.sort_fields),
// cross-checked against the actual runtime source at the time of writing.
// Reuses SURFACE_KIND/COVERAGE_LEVEL/CURATION_LEVEL/PROFILE_LEVEL/
// CANDIDATE_STATES/CONFIDENCE_LEVELS/CANDIDATES_SORT_FIELDS/CLAIM_SORT_FIELDS/
// ENDPOINT_LAYERS/ENDPOINT_PUBLICATION_STATES/ENDPOINT_SORT_FIELDS/
// POOL_KINDS/POOL_SORT_FIELDS/IDENTITY_LEVELS/BOOLEAN_STRINGS already
// defined above (batches 1-9) -- confirmed identical to this batch's own
// symbolic references, not just reused by name.
const DOCUMENT_TYPES = ["subnet", "surface", "provider"];
const DOCUMENT_SORT_FIELDS = ["netuid", "slug", "title", "type"];
const CURATION_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "name",
  "netuid",
];
const GAPS_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "gap_count",
  "name",
  "netuid",
];
const EVIDENCE_ACTIONS = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
];
const LANES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
];
const QUEUE_SORT_FIELDS = [
  "adapter_score",
  "candidate_count",
  "completeness_score",
  "curation_level",
  "endpoint_count",
  "evidence_action",
  "identity_level",
  "identity_surface_count",
  "lane",
  "name",
  "netuid",
  "operational_interface_count",
  "priority_score",
  "profile_level",
  "review_state",
  "stale_candidate_count",
  "surface_count",
  "verified_candidate_count",
];
const RECOMMENDED_ADAPTER_KINDS = [
  "custom-adapter",
  "data-artifact-adapter",
  "generic-openapi-or-custom",
  "stream-adapter",
];
const ADAPTER_CANDIDATES_SORT_FIELDS = [
  "candidate_api_count",
  "candidate_api_kinds",
  "curation_level",
  "name",
  "netuid",
  "operational_kinds",
  "operational_surface_count",
  "priority_score",
  "recommended_adapter_kind",
];
const EVIDENCE_SORT_FIELDS = [
  "evidence_action",
  "lane",
  "name",
  "netuid",
  "priority_score",
];
const PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
];
const SUBMISSION_ROUTES = [
  "direct-candidate-pr",
  "adapter-request",
  "maintainer-review",
  "status-report",
];
const TARGET_ACTIONS = [
  "submit-new-candidate",
  "replace-stale-candidate",
  "verify-existing-candidate",
  "review-existing-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
];
const TARGET_TYPES = [
  "surface-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
];
const TARGET_SORT_FIELDS = [
  "auto_review_candidate",
  "evidence_action",
  "identity_level",
  "kind",
  "lane",
  "manual_review_required",
  "name",
  "netuid",
  "priority_score",
  "profile_level",
  "submission_route",
  "target_action",
  "target_type",
];
const INCIDENT_SEVERITIES = ["critical", "warning", "info"];
const INCIDENT_STATES = ["active", "resolved"];
const INCIDENT_SORT_FIELDS = [
  "detected_at",
  "endpoint_id",
  "kind",
  "last_checked",
  "netuid",
  "provider",
  "severity",
  "state",
  "status",
];

// Batch 12 (#8075) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/contracts.ts's
// QUERY_ENUMS.agentReadinessStatus, mcp-server.ts's own
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES constants, src/feed-mcp.ts's
// FEED_KINDS/FEED_MAX_ITEMS, and src/saved-queries.ts's
// SAVED_QUERY_TEMPLATES.map((t) => t.id)), cross-checked against the actual
// runtime source at the time of writing. Reuses SURFACE_KIND/CURATION_LEVEL
// already defined above (batches 1-4) -- confirmed identical to this
// batch's own symbolic references, not just reused by name.
const AGENT_READINESS_STATUSES = [
  "callable",
  "base-layer",
  "candidate",
  "needs-evidence",
  "blocked",
];
const COVERAGE_DEPTH_TIERS_12 = [
  "agent-ready",
  "machine-usable",
  "candidate-review",
  "needs-evidence",
  "hard-blocked",
  "missing-interface",
];
const COVERAGE_DEPTH_SEVERITIES_12 = ["hard", "missing-data", "needs-review"];
const FEED_KINDS = ["registry", "incidents", "gaps", "subnet"];
const FEED_MAX_ITEMS = 50;
const SAVED_QUERY_IDS = ["subnet-leaderboard", "chain-registrations-window"];
const GAP_PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
];

// Batch 12 (#8076) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/health-serving.ts's
// ECONOMIC_BOARD_SPECS[].key and src/ai-search.ts's SEMANTIC_TYPES),
// cross-checked against the actual runtime source at the time of writing.
const ECONOMIC_LEADERBOARD_BOARDS = [
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
];
const SEMANTIC_TYPES = ["subnet", "surface", "provider"];
// mcp-server.ts's own semanticTypeSchema() helper shape (removed by this
// batch's conversion, once the sole call sites -- ask, semantic_search --
// were converted): one kind or a list of kinds.
const SEMANTIC_TYPE_SCHEMA = {
  oneOf: [
    { type: "string", enum: SEMANTIC_TYPES },
    { type: "array", items: { type: "string", enum: SEMANTIC_TYPES } },
  ],
};

const OLD_SCHEMAS: Record<string, { input: Row; output: Row }> = {
  search_subnets: {
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "query",
        "total",
        "count",
        "cursor",
        "limit",
        "next_cursor",
        "results",
      ],
      properties: {
        query: { type: "string" },
        total: { type: "integer" },
        count: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        next_cursor: { type: ["integer", "null"] },
        results: objectItems({
          netuid: { type: "integer" },
          slug: { type: "string" },
          title: NULLABLE_STRING,
          description: NULLABLE_STRING,
          url: NULLABLE_STRING,
        }),
      },
    },
  },
  list_subnets: {
    input: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        status: { type: "string" },
        subnet_type: { type: "string" },
        domain: { type: "string" },
        not_status: { type: "string" },
        not_subnet_type: { type: "string" },
        not_domain: { type: "string" },
        coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        not_coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        not_curation_level: { type: "string", enum: CURATION_LEVEL },
        min_readiness: { type: "integer", minimum: 0, maximum: 100 },
        max_readiness: { type: "integer", minimum: 0, maximum: 100 },
        min_surface_count: { type: "integer", minimum: 0 },
        max_surface_count: { type: "integer", minimum: 0 },
        min_block: { type: "number" },
        max_block: { type: "number" },
        min_candidate_count: { type: "integer", minimum: 0 },
        max_candidate_count: { type: "integer", minimum: 0 },
        min_mechanism_count: { type: "integer", minimum: 0 },
        max_mechanism_count: { type: "integer", minimum: 0 },
        min_participant_count: { type: "integer", minimum: 0 },
        max_participant_count: { type: "integer", minimum: 0 },
        min_probed_surface_count: { type: "integer", minimum: 0 },
        max_probed_surface_count: { type: "integer", minimum: 0 },
        min_tempo: { type: "integer", minimum: 0 },
        max_tempo: { type: "integer", minimum: 0 },
        min_netuid: { type: "integer", minimum: 0 },
        max_netuid: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: LIST_SUBNETS_SORT_FIELDS },
        order: { type: "string", enum: LIST_SUBNETS_ORDERS },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "total",
        "returned",
        "cursor",
        "limit",
        "next_cursor",
        "subnets",
      ],
      properties: {
        total: { type: "integer" },
        returned: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
        next_cursor: { type: ["integer", "null"] },
        subnets: objectItems({
          netuid: { type: "integer" },
          slug: NULLABLE_STRING,
          title: NULLABLE_STRING,
          subnet_type: NULLABLE_STRING,
          status: NULLABLE_STRING,
          integration_readiness: { type: ["number", "null"] },
          surface_count: { type: ["integer", "null"] },
        }),
      },
    },
  },
  get_subnet: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid"],
      properties: {
        netuid: { type: "integer" },
        name: NULLABLE_STRING,
        slug: NULLABLE_STRING,
        status: NULLABLE_STRING,
        health: { type: ["object", "null"] },
        profile: { type: ["object", "null"] },
        counts: { type: "object" },
        curation: { type: ["object", "null"] },
        gaps: { type: ["object", "null"] },
        gap_priorities: { type: "array" },
        operational_observed_at: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
      },
    },
  },
  get_network_health: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "scope", "global", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: { type: ["integer", "string", "null"] },
        generated_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
        scope: { type: "string" },
        operational_observed_at: NULLABLE_STRING,
        global: { type: "object" },
        subnets: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_stake_quote: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        amount: { type: "number", exclusiveMinimum: 0 },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
      },
      required: ["netuid", "amount"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "netuid",
        "direction",
        "amount",
        "expected_out",
        "expected_out_unit",
        "spot_price_tao",
        "effective_price_tao",
        "price_impact_pct",
        "tao_in_pool_tao",
        "alpha_in_pool",
        "is_root",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
        // Bucket-(a): the original left `amount` an unbounded
        // {type:"number"}; the Zod schema reuses
        // SubnetStakeQuoteArtifactSchema, which carries the SAME .gt(0) the
        // input side already enforces, and the value is always an echo of
        // an already-validated input -- a deliberate, verified tightening
        // (see get-subnet-stake-quote.ts's header), not an oversight. NOT
        // normalized away: `amount` here intentionally omits the bound so
        // this diff shows it, and the PR body calls it out explicitly.
        amount: { type: "number" },
        expected_out: { type: "number" },
        expected_out_unit: { type: "string", enum: ["alpha", "tao"] },
        spot_price_tao: { type: "number" },
        effective_price_tao: { type: "number" },
        price_impact_pct: { type: "number" },
        tao_in_pool_tao: { type: ["number", "null"] },
        alpha_in_pool: { type: ["number", "null"] },
        is_root: { type: "boolean" },
      },
    },
  },
  get_economics: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        registration_allowed: { type: "string", enum: ["true", "false"] },
        q: { type: "string" },
        sort: { type: "string", enum: ECONOMICS_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["source", "subnets"],
      properties: {
        source: NULLABLE_STRING,
        captured_at: NULLABLE_STRING,
        network: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        subnets: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  find_subnets_by_capability: {
    input: {
      type: "object",
      properties: {
        capability: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["capability"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "capability",
        "total",
        "count",
        "cursor",
        "limit",
        "next_cursor",
        "results",
      ],
      properties: {
        capability: { type: "string" },
        total: { type: "integer" },
        count: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        next_cursor: { type: ["integer", "null"] },
        results: objectItems({
          netuid: { type: "integer" },
          slug: { type: "string" },
          name: NULLABLE_STRING,
          categories: { type: "array" },
          service_kinds: { type: "array" },
          callable_count: { type: "integer" },
          integration_readiness: ANY,
        }),
      },
    },
  },
  get_subnet_detail: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet"],
      properties: {
        schema_version: { type: "integer" },
        generated_at: NULLABLE_STRING,
        subnet: { type: "object" },
        candidate_surfaces: { type: "array" },
        candidates: { type: "array" },
        endpoints: { type: "array" },
        gaps: ANY,
        surfaces: { type: "array" },
        verified_surfaces: { type: "array" },
        economics: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_snapshot: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        top_validators_limit: { type: "integer", minimum: 1 },
        recent_events_limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "hyperparameters",
        "concentration",
        "performance",
        "top_validators",
        "recent_events",
      ],
      properties: {
        netuid: { type: "integer" },
        hyperparameters: { type: "object" },
        concentration: { type: "object" },
        performance: { type: "object" },
        top_validators: { type: "object" },
        recent_events: { type: "object" },
      },
    },
  },
  get_subnet_health: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "summary", "surfaces"],
      properties: {
        netuid: { type: "integer" },
        summary: { type: "object" },
        operational_observed_at: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: { type: "string" },
          netuid: { type: "integer" },
          kind: NULLABLE_STRING,
          status: { type: "string" },
          latency_ms: NULLABLE_INT,
          last_checked: NULLABLE_STRING,
          last_ok: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_health_trends: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "windows"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        windows: { type: "object" },
      },
    },
  },
  get_health_trends: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["windows"],
      properties: {
        schema_version: { type: "integer" },
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        windows: { type: "object" },
      },
    },
  },
  get_subnet_health_percentiles: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HEALTH_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: NULLABLE_STRING,
          samples: { type: "integer" },
          latency_ms: {
            type: "object",
            additionalProperties: true,
            properties: {
              p50: NULLABLE_INT,
              p95: NULLABLE_INT,
              p99: NULLABLE_INT,
              avg: NULLABLE_INT,
              min: NULLABLE_INT,
              max: NULLABLE_INT,
            },
          },
        }),
      },
    },
  },
  get_subnet_health_incidents: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HEALTH_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: NULLABLE_STRING,
          samples: { type: "integer" },
          uptime_ratio: { type: ["number", "null"] },
          incident_count: { type: "integer" },
          downtime_ms: { type: "integer" },
          incidents: objectItems({
            started_at: NULLABLE_INT,
            ended_at: NULLABLE_INT,
            duration_ms: NULLABLE_INT,
            failed_samples: { type: "integer" },
          }),
        }),
      },
    },
  },
  get_subnet_economics: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "economics"],
      properties: {
        netuid: { type: "integer" },
        source: NULLABLE_STRING,
        captured_at: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        economics: { type: ["object", "null"] },
      },
    },
  },
  get_stake_action_preview: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        amount: { type: "number", exclusiveMinimum: 0 },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
      },
      required: ["netuid", "amount"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        netuid: { type: "integer" },
        direction: { type: "string" },
        amount: { type: "number" },
        summary: { type: "string" },
        estimated_out: {
          type: "object",
          properties: {
            amount: { type: "number" },
            unit: { type: "string" },
          },
          required: ["amount", "unit"],
          additionalProperties: false,
        },
        spot_price_tao: { type: "number" },
        effective_price_tao: { type: "number" },
        price_impact_pct: { type: "number" },
        warnings: { type: "array", items: { type: "string" } },
        ok: { type: "boolean" },
        disclaimer: { type: "string" },
      },
      required: [
        "netuid",
        "direction",
        "amount",
        "summary",
        "warnings",
        "ok",
        "disclaimer",
      ],
      additionalProperties: true,
    },
  },
  get_subnet_trajectory: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
        deltas: { type: "object" },
      },
    },
  },
  get_subnet_concentration: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        entity_count: { type: "integer" },
        uids_per_entity: { type: ["number", "null"] },
        captured_at: NULLABLE_STRING,
        stake: { type: ["object", "null"] },
        emission: { type: ["object", "null"] },
        entity_stake: { type: ["object", "null"] },
        entity_emission: { type: ["object", "null"] },
        validator_stake: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_performance: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        active_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        incentive: { type: ["object", "null"] },
        dividends: { type: ["object", "null"] },
        trust: { type: ["object", "null"] },
        consensus: { type: ["object", "null"] },
        validator_trust: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_idle_stake: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "neuron_count",
        "idle_neuron_count",
        "idle_stake_tao",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        neuron_count: { type: "integer" },
        idle_neuron_count: { type: "integer" },
        idle_stake_tao: { type: "number" },
      },
    },
  },
  get_subnet_movers: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: MOVERS_WINDOW_KEYS },
        sort: { type: "string", enum: MOVERS_SORTS },
        limit: { type: "integer", minimum: 1, maximum: MOVERS_LIMIT_MAX },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "sort", "subnet_count", "movers"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        start_date: NULLABLE_STRING,
        end_date: NULLABLE_STRING,
        sort: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        movers: objectItems({
          netuid: { type: "integer" },
          stake_start_tao: ANY,
          stake_end_tao: ANY,
          stake_delta_tao: ANY,
          stake_pct_change: { type: ["number", "null"] },
          emission_start_tao: ANY,
          emission_end_tao: ANY,
          emission_delta_tao: ANY,
          emission_pct_change: { type: ["number", "null"] },
          validators_start: { type: "integer" },
          validators_end: { type: "integer" },
          validators_delta: { type: "integer" },
          neurons_start: { type: "integer" },
          neurons_end: { type: "integer" },
          neurons_delta: { type: "integer" },
        }),
      },
    },
  },
  get_subnet_uptime: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: UPTIME_WINDOWS },
        min_samples: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        surfaces: { type: "array", items: { type: "object" } },
        reliability: { type: ["object", "null"] },
      },
    },
  },
  get_health_history: {
    input: {
      type: "object",
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        status: { type: "string", enum: HEALTH_STATUS },
        classification: { type: "string", enum: HEALTH_CLASSIFICATION },
        sort: { type: "string", enum: HEALTH_SURFACE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["date"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["date", "surfaces"],
      properties: {
        date: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_blocks_summary: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["block_count"],
      properties: {
        schema_version: { type: "integer" },
        block_count: { type: "integer" },
        first_block: { type: ["integer", "null"] },
        last_block: { type: ["integer", "null"] },
        first_observed_at: NULLABLE_STRING,
        last_observed_at: NULLABLE_STRING,
        block_time: { type: ["object", "null"] },
        throughput: { type: ["object", "null"] },
        distinct_authors: { type: "integer" },
        author_concentration: { type: ["object", "null"] },
        distinct_spec_versions: { type: "integer" },
        latest_spec_version: { type: ["integer", "null"] },
      },
    },
  },
  get_subnet_concentration_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: objectItems({
          snapshot_date: NULLABLE_STRING,
          neuron_count: NULLABLE_INT,
          stake_gini: ANY,
          stake_nakamoto_coefficient: ANY,
          stake_top_10pct_share: ANY,
          emission_gini: ANY,
          emission_nakamoto_coefficient: ANY,
          emission_top_10pct_share: ANY,
        }),
      },
    },
  },
  get_subnet_turnover: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
        changes: { type: "boolean" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "comparable",
        "validators_start",
        "validators_end",
        "validators_entered",
        "validators_exited",
        "neurons_start",
        "neurons_end",
        "uids_deregistered",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        start_date: NULLABLE_STRING,
        end_date: NULLABLE_STRING,
        comparable: { type: "boolean" },
        validators_start: { type: "integer" },
        validators_end: { type: "integer" },
        validators_entered: { type: "integer" },
        validators_exited: { type: "integer" },
        validator_retention: { type: ["number", "null"] },
        neurons_start: { type: "integer" },
        neurons_end: { type: "integer" },
        uids_deregistered: { type: "integer" },
        neuron_retention: { type: ["number", "null"] },
        stability_score: { type: ["integer", "null"] },
        changes: {
          type: "object",
          properties: {
            validators_entered_count: { type: "integer" },
            validators_exited_count: { type: "integer" },
            uid_reassignment_count: { type: "integer" },
            validators_entered: { type: "array", items: { type: "object" } },
            validators_exited: { type: "array", items: { type: "object" } },
            uid_reassignments: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
  get_subnet_yield: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count", "neurons"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        miner_count: { type: "integer" },
        total_stake_tao: { type: ["number", "null"] },
        total_emission_tao: { type: ["number", "null"] },
        subnet_yield: { type: ["number", "null"] },
        mean_yield: { type: ["number", "null"] },
        median_yield: { type: ["number", "null"] },
        p25_yield: { type: ["number", "null"] },
        p75_yield: { type: ["number", "null"] },
        p90_yield: { type: ["number", "null"] },
        neurons: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_yield_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_stake_flow: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: STAKE_FLOW_WINDOWS },
        direction: { type: "string", enum: STAKE_FLOW_DIRECTIONS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "total_staked_tao",
        "total_unstaked_tao",
        "net_flow_tao",
        "stake_events",
        "unstake_events",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        total_staked_tao: ANY,
        total_unstaked_tao: ANY,
        net_flow_tao: ANY,
        stake_events: { type: "integer" },
        unstake_events: { type: "integer" },
      },
    },
  },
  get_subnet_event_summary: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "total_events",
        "kind_count",
        "recent_event_count",
        "categories",
        "event_kinds",
        "recent_events",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        total_events: { type: "integer" },
        kind_count: { type: "integer" },
        category_count: { type: "integer" },
        recent_event_count: { type: "integer" },
        limit: NULLABLE_INT,
        categories: objectItems({
          category: NULLABLE_STRING,
          event_count: { type: "integer" },
          kind_count: { type: "integer" },
          amount_tao: ANY,
          alpha_amount: ANY,
          first_block: NULLABLE_INT,
          last_block: NULLABLE_INT,
          first_observed_at: NULLABLE_STRING,
          last_observed_at: NULLABLE_STRING,
        }),
        event_kinds: objectItems({
          event_kind: NULLABLE_STRING,
          category: NULLABLE_STRING,
          event_count: { type: "integer" },
          hotkey_count: { type: "integer" },
          coldkey_count: { type: "integer" },
          amount_tao: ANY,
          alpha_amount: ANY,
          first_block: NULLABLE_INT,
          last_block: NULLABLE_INT,
          first_observed_at: NULLABLE_STRING,
          last_observed_at: NULLABLE_STRING,
        }),
        recent_events: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_weights: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_setters",
        "weight_sets",
        "sets_per_setter",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_setters: { type: "integer" },
        weight_sets: { type: "integer" },
        sets_per_setter: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_weight_setters: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_setters",
        "weight_sets",
        "setter_count",
        "setters",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_setters: { type: "integer" },
        weight_sets: { type: "integer" },
        setter_count: { type: "integer" },
        setters: objectItems({
          hotkey: NULLABLE_STRING,
          uid: NULLABLE_INT,
          weight_sets: { type: "integer" },
          share: ANY,
          first_set_at: NULLABLE_STRING,
          last_set_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_registrations: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_registrants", "registrations"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_registrants: { type: "integer" },
        registrations: { type: "integer" },
        registrations_per_registrant: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_stake_moves: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_movers", "movements"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_movers: { type: "integer" },
        movements: { type: "integer" },
        movements_per_mover: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_stake_transfers: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_senders", "transfers"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_senders: { type: "integer" },
        transfers: { type: "integer" },
        transfers_per_sender: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_axon_removals: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_removers",
        "removals",
        "removals_per_remover",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_removers: { type: "integer" },
        removals: { type: "integer" },
        removals_per_remover: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_serving: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_servers",
        "announcements",
        "announcements_per_server",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_servers: { type: "integer" },
        announcements: { type: "integer" },
        announcements_per_server: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_prometheus: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_exporters",
        "announcements",
        "announcements_per_exporter",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_exporters: { type: "integer" },
        announcements: { type: "integer" },
        announcements_per_exporter: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_deregistrations: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_deregistered_hotkeys",
        "deregistrations",
        "deregistrations_per_hotkey",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_deregistered_hotkeys: { type: "integer" },
        deregistrations: { type: "integer" },
        deregistrations_per_hotkey: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_performance_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_economics_trends: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "day_count", "days"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        day_count: { type: "integer" },
        days: objectItems({
          snapshot_date: NULLABLE_STRING,
          subnet_count: NULLABLE_INT,
          total_stake_tao: { type: ["number", "null"] },
          alpha_price_tao_weighted: { type: ["number", "null"] },
          alpha_price_tao_median: { type: ["number", "null"] },
          validator_count: NULLABLE_INT,
          miner_count: NULLABLE_INT,
          mean_emission_share: { type: ["number", "null"] },
        }),
      },
    },
  },
  get_registry_leaderboards: {
    input: {
      type: "object",
      properties: {
        board: { type: "string", enum: LEADERBOARD_BOARDS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["boards"],
      properties: {
        schema_version: { type: "integer" },
        board: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        boards: { type: "object" },
      },
    },
  },
  get_domain_summary: {
    input: {
      type: "object",
      properties: {
        domain: { type: "string", enum: DOMAIN_TAGS },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version"],
      properties: {
        schema_version: { type: "integer" },
        domain: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        netuids: { type: "array", items: { type: "integer" } },
        total_stake_tao: { type: ["number", "null"] },
        total_emission_share: { type: ["number", "null"] },
        emission_concentration: { type: ["object", "null"] },
        domain_count: { type: "integer" },
        domains: { type: "array", items: { type: "object" } },
      },
    },
  },
  list_profiles: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        subnet_type: { type: "string", enum: PROFILE_SUBNET_TYPE },
        curation_level: { type: "string", enum: PROFILE_CURATION_LEVEL },
        review_state: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        profile_level: { type: "string", enum: PROFILE_LEVEL },
        q: { type: "string" },
        sort: { type: "string", enum: PROFILES_SORT_FIELDS_4 },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["profiles"],
      properties: {
        captured_at: NULLABLE_STRING,
        profiles: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_profile: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        subnet: { type: ["object", "null"] },
        profile: { type: ["object", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        endpoints: { type: "array", items: { type: "object" } },
        gaps: { type: ["object", "null"] },
      },
    },
  },
  compare_subnets: {
    input: {
      type: "object",
      properties: {
        netuids: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
          maxItems: 128,
        },
        dimensions: {
          type: "array",
          items: { type: "string", enum: COMPARE_DIMENSIONS },
        },
      },
      required: ["netuids"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["requested_netuids", "subnets", "dimensions"],
      properties: {
        schema_version: { type: "integer" },
        requested_netuids: { type: "array", items: { type: "integer" } },
        dimensions: { type: "array", items: { type: "string" } },
        subnets: { type: "array", items: { type: "object" } },
        observed_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_metagraph: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        validator_permit: { type: "boolean" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count", "neurons"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        neurons: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_4 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: objectItems({
          snapshot_date: NULLABLE_STRING,
          neuron_count: NULLABLE_INT,
          validator_count: NULLABLE_INT,
          total_stake_tao: ANY,
          total_emission_tao: ANY,
        }),
      },
    },
  },
  get_subnet_identity_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "netuid", "entry_count", "entries"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        entry_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        entries: objectItems({
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
          subnet_name: NULLABLE_STRING,
          symbol: NULLABLE_STRING,
          description: NULLABLE_STRING,
          github_repo: NULLABLE_STRING,
          subnet_url: NULLABLE_STRING,
          discord: NULLABLE_STRING,
          logo_url: NULLABLE_STRING,
          identity_hash: { type: "string" },
        }),
      },
    },
  },
  get_subnet_events: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string" },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "event_count", "events"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        event_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
      },
    },
  },
  get_subnet_hyperparams: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        hyperparameters: {
          type: ["object", "null"],
          additionalProperties: true,
        },
      },
    },
  },
  get_subnet_hyperparams_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "entry_count", "entries"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        entry_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        entries: objectItems({
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
          hyperparameters: {
            type: ["object", "null"],
            additionalProperties: true,
          },
          hyperparams_hash: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_volume: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: { type: "string" },
        buy_volume_alpha: ANY,
        sell_volume_alpha: ANY,
        total_volume_alpha: ANY,
        buy_volume_tao: ANY,
        sell_volume_tao: ANY,
        total_volume_tao: ANY,
        buy_count: { type: "integer" },
        sell_count: { type: "integer" },
        net_volume_alpha: ANY,
        sentiment_ratio: { type: ["number", "null"] },
        sentiment: NULLABLE_STRING,
        vol_mcap_ratio: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_ohlc: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        interval: { type: "string", enum: OHLC_INTERVALS_4 },
        days: { type: "integer", minimum: 1, maximum: 365 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "interval", "candles", "root_excluded"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        interval: { type: "string" },
        candles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              bucket_start: { type: "integer" },
              bucket_start_iso: { type: "string" },
              open: ANY,
              high: ANY,
              low: ANY,
              close: ANY,
              volume_alpha: ANY,
              volume_tao: ANY,
              event_count: { type: "integer" },
            },
          },
        },
        root_excluded: { type: "boolean" },
      },
    },
  },
  get_subnet_ownership_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "ownership_changes"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        count: { type: "integer" },
        ownership_changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              netuid: { type: ["integer", "null"] },
              old_coldkey: { type: ["string", "null"] },
              new_coldkey: { type: ["string", "null"] },
              block_number: { type: ["integer", "null"] },
              observed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_subnet_conviction: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "leaderboard"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        queried_at_block: { type: ["integer", "null"] },
        unlock_rate: { type: ["integer", "null"] },
        maturity_rate: { type: ["integer", "null"] },
        king: { type: ["string", "null"] },
        count: { type: "integer" },
        leaderboard: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              hotkey: { type: "string" },
              is_owner: { type: "boolean" },
              locked_mass: { type: "number" },
              conviction: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_subnet_recycled: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        recycled_tao: { type: ["number", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_burn: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        burn_tao: { type: ["number", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_lease: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "leased"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        leased: { type: ["boolean", "null"] },
        lease: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            lease_id: { type: "integer" },
            beneficiary: { type: "string" },
            coldkey: { type: "string" },
            hotkey: { type: "string" },
            emissions_share_percent: { type: "integer" },
            end_block: { type: ["integer", "null"] },
            netuid: { type: "integer" },
            cost_tao: { type: "number" },
            accumulated_dividends_alpha: { type: ["number", "null"] },
          },
        },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_lease_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "lease_events"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        count: { type: "integer" },
        lease_events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              event_kind: { type: "string" },
              beneficiary: { type: ["string", "null"] },
              block_number: { type: ["integer", "null"] },
              observed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_global_incidents: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["7d", "30d"] },
        netuid: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: GLOBAL_INCIDENTS_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["summary", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        summary: { type: "object" },
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_subnet_validators: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
        min_stake_tao: { type: "number", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "validator_count", "validators"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        validator_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        validators: { type: "array", items: { type: "object" } },
      },
    },
  },
  list_global_validators: {
    input: {
      type: "object",
      properties: {
        sort: { type: "string", enum: GLOBAL_VALIDATOR_SORTS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["sort", "limit", "validator_count", "validators"],
      properties: {
        schema_version: { type: "integer" },
        sort: { type: "string", enum: GLOBAL_VALIDATOR_SORTS },
        limit: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        validator_count: { type: "integer" },
        validators: objectItems({
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          coldkey_count: { type: "integer" },
          subnet_count: { type: "integer" },
          uid_count: { type: "integer" },
          total_stake_tao: ANY,
          total_emission_tao: ANY,
          avg_validator_trust: { type: ["number", "null"] },
          max_validator_trust: { type: ["number", "null"] },
          latest_captured_at: NULLABLE_STRING,
          latest_block_number: NULLABLE_INT,
          stake_dominance: { type: ["number", "null"] },
          subnets: objectItems({
            netuid: NULLABLE_INT,
            uid: NULLABLE_INT,
            stake_tao: ANY,
            emission_tao: ANY,
            validator_trust: { type: ["number", "null"] },
          }),
        }),
      },
    },
  },
  get_validator_detail: {
    input: {
      type: "object",
      properties: {
        hotkey: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["hotkey"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["hotkey", "subnet_count", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        hotkey: { type: "string" },
        coldkey: NULLABLE_STRING,
        coldkey_count: { type: "integer" },
        subnet_count: { type: "integer" },
        take: { type: ["number", "null"] },
        total_stake_tao: ANY,
        total_emission_tao: ANY,
        avg_validator_trust: { type: ["number", "null"] },
        max_validator_trust: { type: ["number", "null"] },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        subnets: { type: "array", items: { type: "object" } },
      },
    },
  },
  compare_validators: {
    input: {
      type: "object",
      properties: {
        hotkeys: {
          type: "array",
          items: { type: "string", pattern: SS58_PATTERN },
          minItems: 1,
          maxItems: 16,
        },
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["hotkeys"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["validator_count", "validators"],
      properties: {
        schema_version: { type: "integer" },
        netuid: NULLABLE_INT,
        validator_count: { type: "integer" },
        validators: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_webhook_subscription: {
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["id", "url", "active"],
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        filters: { type: "object" },
        created_at: NULLABLE_STRING,
        active: { type: "boolean" },
        delivery: {
          type: "object",
          required: ["status", "pending", "dead_letter"],
          properties: {
            status: { type: "string", enum: ["ok", "retrying", "dead_letter"] },
            pending: { type: "integer" },
            dead_letter: { type: "integer" },
            last_failure: {
              type: ["object", "null"],
              properties: {
                event_id: { type: "string" },
                attempts: { type: "integer" },
                reason: NULLABLE_STRING,
                status_code: NULLABLE_INT,
                state: { type: "string" },
                last_attempt_at: NULLABLE_STRING,
                next_attempt_at: NULLABLE_STRING,
              },
            },
          },
        },
      },
    },
  },
  get_alert_trigger: {
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        owner_token: { type: "string" },
      },
      required: ["id", "owner_token"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["id", "active"],
      properties: {
        id: { type: "string" },
        name: NULLABLE_STRING,
        table_filter: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        event_kind: NULLABLE_STRING,
        account: NULLABLE_STRING,
        min_amount_tao: { type: ["number", "null"] },
        channel: { type: "string" },
        destination: { type: "string" },
        active: { type: "boolean" },
        created_at: NULLABLE_STRING,
        updated_at: NULLABLE_STRING,
        last_matched_at: NULLABLE_STRING,
        match_count: { type: "integer" },
      },
    },
  },
  get_validator_nominators: {
    input: {
      type: "object",
      properties: {
        hotkey: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
        sort: { type: "string", enum: NOMINATOR_SORTS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        coldkey: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["hotkey"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["hotkey", "nominator_count", "nominators"],
      properties: {
        schema_version: { type: "integer" },
        hotkey: { type: "string" },
        window: NULLABLE_STRING,
        sort: { type: "string", enum: NOMINATOR_SORTS },
        limit: { type: "integer" },
        offset: { type: "integer" },
        nominator_count: { type: "integer" },
        nominators: objectItems({
          coldkey: { type: "string" },
          staked_tao: ANY,
          unstaked_tao: ANY,
          net_staked_tao: ANY,
          gross_staked_tao: ANY,
          event_count: { type: "integer" },
          last_observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_validator_history: {
    input: {
      type: "object",
      properties: {
        hotkey: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
      },
      required: ["hotkey"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["hotkey", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        hotkey: { type: "string" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: objectItems({
          snapshot_date: NULLABLE_STRING,
          subnet_count: NULLABLE_INT,
          total_stake_tao: ANY,
          total_emission_tao: ANY,
          rewards_per_1000_tao: { type: ["number", "null"] },
        }),
      },
    },
  },
  get_neuron: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        uid: { type: "integer", minimum: 0 },
      },
      required: ["netuid", "uid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        neuron: { type: ["object", "null"] },
      },
    },
  },
  get_neuron_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        uid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
      },
      required: ["netuid", "uid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "uid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        uid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_account: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "ss58",
        "event_count",
        "subnet_count",
        "event_kinds",
        "registrations",
        "recent_events",
      ],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        event_count: { type: "integer" },
        subnet_count: { type: "integer" },
        first_block: NULLABLE_INT,
        last_block: NULLABLE_INT,
        first_seen_at: NULLABLE_STRING,
        last_seen_at: NULLABLE_STRING,
        event_kinds: objectItems({
          kind: { type: "string" },
          count: { type: "integer" },
        }),
        registrations: objectItems({
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          stake_tao: ANY,
          validator_permit: { type: "boolean" },
          active: { type: "boolean" },
        }),
        recent_events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
        activity: { type: "object", additionalProperties: true },
        labels: objectItems({
          name: NULLABLE_STRING,
          category: NULLABLE_STRING,
          notes: NULLABLE_STRING,
          source_urls: { type: "array", items: { type: "string" } },
        }),
      },
    },
  },
  get_account_entities: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "labels", "ownership_tie_count", "ownership_ties"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        labels: objectItems({
          name: NULLABLE_STRING,
          category: NULLABLE_STRING,
          notes: NULLABLE_STRING,
          source_urls: { type: "array", items: { type: "string" } },
        }),
        ownership_tie_count: { type: "integer" },
        ownership_ties: objectItems({
          netuid: NULLABLE_INT,
          role: { type: "string" },
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_account_balance: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "balance_tao", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        balance_tao: { type: ["number", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_account_root_claim: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        claim_type: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: { type: "string" },
                subnets: {
                  type: "array",
                  items: { type: "integer" },
                },
              },
            },
            { type: "null" },
          ],
        },
        hotkeys: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["hotkey", "entries"],
            properties: {
              hotkey: { type: "string" },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "netuid",
                    "claimable_rate",
                    "claimed",
                    "threshold",
                  ],
                  properties: {
                    netuid: { type: "integer" },
                    claimable_rate: { type: "number" },
                    claimed: { type: "string" },
                    threshold: { type: "number" },
                  },
                },
              },
            },
          },
        },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_account_children: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["account"],
      properties: {
        schema_version: { type: "integer" },
        account: { type: "string" },
        subnets: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              netuid: { type: "integer" },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    child: { type: ["string", "null"] },
                    proportion: { type: "string" },
                    proportion_fraction: { type: "number" },
                  },
                },
              },
            },
          },
        },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_account_parents: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["account"],
      properties: {
        schema_version: { type: "integer" },
        account: { type: "string" },
        subnets: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              netuid: { type: "integer" },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    parent: { type: ["string", "null"] },
                    proportion: { type: "string" },
                    proportion_fraction: { type: "number" },
                  },
                },
              },
            },
          },
        },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_account_events: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        kind: { type: "string" },
        netuid: { type: "integer", minimum: 0 },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "event_count", "events"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        event_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
      },
    },
  },
  get_account_subnets: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "subnet_count", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        subnet_count: { type: "integer" },
        subnets: objectItems({
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          stake_tao: ANY,
          validator_permit: { type: "boolean" },
          active: { type: "boolean" },
        }),
      },
    },
  },
  get_account_portfolio: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "position_count", "positions"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        captured_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        position_count: { type: "integer" },
        validator_count: { type: "integer" },
        miner_count: { type: "integer" },
        total_stake_tao: { type: "number" },
        total_emission_tao: { type: "number" },
        overall_yield: { type: ["number", "null"] },
        stake_concentration: { type: ["object", "null"] },
        positions: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_account_positions: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "position_count", "total_stake_tao", "positions"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        captured_at: NULLABLE_STRING,
        position_count: { type: "integer" },
        total_stake_tao: { type: "number" },
        positions: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_account_snapshot: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        recent_events_limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "ss58",
        "balance",
        "portfolio",
        "subnets",
        "positions",
        "recent_events",
      ],
      properties: {
        ss58: { type: "string" },
        balance: { type: "object" },
        portfolio: { type: "object" },
        subnets: { type: "object" },
        positions: { type: "object" },
        recent_events: { type: "object" },
      },
    },
  },
  get_account_identity: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["account", "has_identity"],
      properties: {
        schema_version: { type: "integer" },
        account: { type: "string" },
        has_identity: { type: "boolean" },
        name: NULLABLE_STRING,
        url: NULLABLE_STRING,
        github: NULLABLE_STRING,
        image: NULLABLE_STRING,
        discord: NULLABLE_STRING,
        description: NULLABLE_STRING,
        additional: NULLABLE_STRING,
        captured_at: NULLABLE_STRING,
      },
    },
  },
  get_account_identity_history: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["account", "entry_count", "entries"],
      properties: {
        schema_version: { type: "integer" },
        account: { type: "string" },
        entry_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        entries: objectItems({
          observed_at: NULLABLE_STRING,
          name: NULLABLE_STRING,
          url: NULLABLE_STRING,
          github: NULLABLE_STRING,
          image: NULLABLE_STRING,
          discord: NULLABLE_STRING,
          description: NULLABLE_STRING,
          additional: NULLABLE_STRING,
          identity_hash: NULLABLE_STRING,
        }),
      },
    },
  },
  get_account_position_history: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
      },
      required: ["ss58", "netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_account_stake_flow: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ["7d", "30d", "90d"] },
        direction: { type: "string", enum: ["all", "in", "out"] },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_staked_tao",
        "total_unstaked_tao",
        "net_flow_tao",
        "gross_flow_tao",
        "direction",
        "stake_events",
        "unstake_events",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_staked_tao: ANY,
        total_unstaked_tao: ANY,
        net_flow_tao: ANY,
        gross_flow_tao: ANY,
        flow_ratio: { type: ["number", "null"] },
        direction: NULLABLE_STRING,
        stake_events: { type: "integer" },
        unstake_events: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: objectItems({
          netuid: { type: "integer" },
          staked_tao: ANY,
          unstaked_tao: ANY,
          net_flow_tao: ANY,
          gross_flow_tao: ANY,
          flow_ratio: { type: ["number", "null"] },
          direction: NULLABLE_STRING,
          stake_events: { type: "integer" },
          unstake_events: { type: "integer" },
        }),
      },
    },
  },
  get_account_stake_moves: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_movements",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_movements: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "movements",
              "first_moved_at",
              "last_moved_at",
              "price_tao_at_last_move",
            ],
            properties: {
              netuid: { type: "integer" },
              movements: { type: "integer" },
              first_moved_at: NULLABLE_STRING,
              last_moved_at: NULLABLE_STRING,
              price_tao_at_last_move: { type: ["number", "null"] },
            },
          },
        },
      },
    },
  },
  get_account_axon_removals: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_removals",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_removals: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "removals",
              "first_removed_at",
              "last_removed_at",
            ],
            properties: {
              netuid: { type: "integer" },
              removals: { type: "integer" },
              first_removed_at: NULLABLE_STRING,
              last_removed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_prometheus: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_announcements",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_announcements: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "announcements",
              "first_announced_at",
              "last_announced_at",
            ],
            properties: {
              netuid: { type: "integer" },
              announcements: { type: "integer" },
              first_announced_at: NULLABLE_STRING,
              last_announced_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_registrations: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_registrations",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_registrations: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "registrations",
              "first_registered_at",
              "last_registered_at",
            ],
            properties: {
              netuid: { type: "integer" },
              registrations: { type: "integer" },
              first_registered_at: NULLABLE_STRING,
              last_registered_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_weight_setters: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_WEIGHT_SETTERS_WINDOWS_2 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_weight_sets",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_weight_sets: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["netuid", "weight_sets", "first_set_at", "last_set_at"],
            properties: {
              netuid: { type: "integer" },
              weight_sets: { type: "integer" },
              first_set_at: NULLABLE_STRING,
              last_set_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_serving: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_announcements",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_announcements: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "announcements",
              "first_served_at",
              "last_served_at",
            ],
            properties: {
              netuid: { type: "integer" },
              announcements: { type: "integer" },
              first_served_at: NULLABLE_STRING,
              last_served_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_deregistrations: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        window: { type: "string", enum: ACCOUNT_FOOTPRINT_WINDOWS_3 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "address",
        "window",
        "total_deregistrations",
        "subnet_count",
        "subnets",
      ],
      properties: {
        schema_version: { type: "integer" },
        address: { type: "string" },
        window: NULLABLE_STRING,
        total_deregistrations: { type: "integer" },
        subnet_count: { type: "integer" },
        concentration: { type: ["number", "null"] },
        dominant_netuid: NULLABLE_INT,
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "deregistrations",
              "first_deregistered_at",
              "last_deregistered_at",
            ],
            properties: {
              netuid: { type: "integer" },
              deregistrations: { type: "integer" },
              first_deregistered_at: NULLABLE_STRING,
              last_deregistered_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_account_history: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        netuid: { type: "integer", minimum: 0 },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "day_count", "days"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        day_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        days: objectItems({
          day: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          event_count: NULLABLE_INT,
          event_kinds: { type: "array", items: { type: "string" } },
          first_block: NULLABLE_INT,
          last_block: NULLABLE_INT,
        }),
      },
    },
  },
  get_account_extrinsics: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "extrinsic_count", "extrinsics"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        extrinsic_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        extrinsics: objectItems({
          block_number: NULLABLE_INT,
          extrinsic_index: NULLABLE_INT,
          extrinsic_hash: NULLABLE_STRING,
          signer: NULLABLE_STRING,
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          call_args: ANY,
          success: { type: ["boolean", "null"] },
          fee_tao: ANY,
          tip_tao: ANY,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_account_transfers: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        direction: { type: "string", enum: ["sent", "received"] },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "transfer_count", "transfers"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        transfer_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        transfers: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          from: NULLABLE_STRING,
          to: NULLABLE_STRING,
          amount_tao: ANY,
          direction: NULLABLE_STRING,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_account_counterparties: {
    input: {
      type: "object",
      properties: {
        ss58: { type: "string", pattern: SS58_PATTERN },
        counterparty: { type: "string", pattern: SS58_PATTERN },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["ss58"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ss58", "counterparty_count", "counterparties"],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string" },
        counterparty_count: { type: "integer" },
        transfers_scanned: NULLABLE_INT,
        scan_capped: { type: "boolean" },
        total_sent_tao: ANY,
        total_received_tao: ANY,
        counterparties: objectItems({
          address: NULLABLE_STRING,
          sent_tao: ANY,
          received_tao: ANY,
          net_tao: ANY,
          transfer_count: NULLABLE_INT,
          last_block: NULLABLE_INT,
        }),
        relationship: { type: "object", additionalProperties: true },
      },
    },
  },
  list_accounts: {
    input: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ACCOUNTS_LIST_SORTS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["sort", "limit", "account_count", "accounts"],
      properties: {
        schema_version: { type: "integer" },
        sort: { type: "string", enum: ACCOUNTS_LIST_SORTS },
        limit: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        account_count: { type: "integer" },
        accounts: objectItems({
          hotkey: { type: "string" },
          coldkey: NULLABLE_STRING,
          coldkey_count: { type: "integer" },
          subnet_count: { type: "integer" },
          uid_count: { type: "integer" },
          validator_count: { type: "integer" },
          miner_count: { type: "integer" },
          total_stake_tao: ANY,
          total_emission_tao: ANY,
          latest_captured_at: NULLABLE_STRING,
          latest_block_number: NULLABLE_INT,
          subnets: { type: "array", items: { type: "object" } },
        }),
      },
    },
  },
  get_top_holders: {
    input: {
      type: "object",
      properties: {
        sort: { type: "string", enum: TOP_HOLDERS_SORTS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["sort", "limit", "account_count", "accounts"],
      properties: {
        schema_version: { type: "integer" },
        sort: { type: "string", enum: TOP_HOLDERS_SORTS },
        limit: { type: "integer" },
        captured_at: NULLABLE_STRING,
        account_count: { type: "integer" },
        accounts: objectItems({
          ss58: { type: "string" },
          free_tao: ANY,
          delegated_tao: ANY,
          total_tao: ANY,
          net_flow_7d: ANY,
          net_flow_30d: ANY,
          net_flow_90d: ANY,
          last_updated: NULLABLE_STRING,
        }),
      },
    },
  },
  decode_evm_call: {
    input: {
      type: "object",
      required: ["to", "input"],
      properties: {
        to: { type: "string", pattern: H160_PATTERN },
        input: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["precompile", "address", "function"],
      properties: {
        precompile: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        function: { type: ["string", "null"] },
        signature: { type: "string" },
        args: { type: "object" },
      },
    },
  },
  get_evm_address_mapping: {
    input: {
      type: "object",
      required: ["h160"],
      properties: {
        h160: { type: "string", pattern: H160_PATTERN },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["schema_version", "h160", "ss58", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        h160: { type: "string" },
        ss58: { type: ["string", "null"] },
        queried_at: { type: ["string", "null"] },
      },
    },
  },
  list_blocks: {
    input: {
      type: "object",
      properties: {
        author: { type: "string", pattern: SS58_PATTERN },
        spec_version: { type: "integer", minimum: 0 },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        min_extrinsics: { type: "integer", minimum: 0 },
        min_events: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["block_count", "blocks"],
      properties: {
        schema_version: { type: "integer" },
        block_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        blocks: objectItems({
          block_number: NULLABLE_INT,
          block_hash: NULLABLE_STRING,
          parent_hash: NULLABLE_STRING,
          author: NULLABLE_STRING,
          extrinsic_count: NULLABLE_INT,
          event_count: NULLABLE_INT,
          spec_version: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_block: {
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ref"],
      properties: {
        schema_version: { type: "integer" },
        ref: ANY,
        block: { type: ["object", "null"], additionalProperties: true },
        prev_block_number: NULLABLE_INT,
        next_block_number: NULLABLE_INT,
      },
    },
  },
  list_block_extrinsics: {
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ref", "extrinsic_count", "extrinsics"],
      properties: {
        schema_version: { type: "integer" },
        ref: ANY,
        block_number: NULLABLE_INT,
        extrinsic_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        extrinsics: objectItems({
          block_number: NULLABLE_INT,
          extrinsic_index: NULLABLE_INT,
          extrinsic_hash: NULLABLE_STRING,
          signer: NULLABLE_STRING,
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          call_args: ANY,
          success: { type: ["boolean", "null"] },
          fee_tao: ANY,
          tip_tao: ANY,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_block_events: {
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ref", "event_count", "events"],
      properties: {
        schema_version: { type: "integer" },
        ref: ANY,
        block_number: NULLABLE_INT,
        event_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
      },
    },
  },
  list_extrinsics: {
    input: {
      type: "object",
      properties: {
        block: { type: "integer", minimum: 0 },
        signer: { type: "string", pattern: SS58_PATTERN },
        call_module: { type: "string" },
        call_function: { type: "string" },
        call_hash: { type: "string" },
        success: { type: "boolean" },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["extrinsic_count", "extrinsics"],
      properties: {
        schema_version: { type: "integer" },
        extrinsic_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        extrinsics: objectItems({
          block_number: NULLABLE_INT,
          extrinsic_index: NULLABLE_INT,
          extrinsic_hash: NULLABLE_STRING,
          signer: NULLABLE_STRING,
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          call_args: ANY,
          success: { type: ["boolean", "null"] },
          fee_tao: ANY,
          tip_tao: ANY,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_extrinsic: {
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["ref"],
      properties: {
        schema_version: { type: "integer" },
        ref: ANY,
        extrinsic: { type: ["object", "null"], additionalProperties: true },
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
      },
    },
  },
  get_sudo: {
    input: {
      type: "object",
      properties: {
        block: { type: "integer", minimum: 0 },
        call_function: { type: "string" },
        success: { type: "boolean" },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["extrinsic_count", "extrinsics"],
      properties: {
        schema_version: { type: "integer" },
        extrinsic_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        extrinsics: objectItems({
          block_number: NULLABLE_INT,
          extrinsic_index: NULLABLE_INT,
          extrinsic_hash: NULLABLE_STRING,
          signer: NULLABLE_STRING,
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          call_args: ANY,
          success: { type: ["boolean", "null"] },
          fee_tao: ANY,
          tip_tao: ANY,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_sudo_key: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["hotkey", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        hotkey: NULLABLE_STRING,
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_network_parameters: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "tao_weight",
        "stake_threshold_tao",
        "pending_childkey_cooldown_blocks",
        "queried_at",
      ],
      properties: {
        schema_version: { type: "integer" },
        tao_weight: { type: ["number", "null"] },
        stake_threshold_tao: { type: ["number", "null"] },
        pending_childkey_cooldown_blocks: { type: ["integer", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_randomness_status: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "last_stored_round",
        "oldest_stored_round",
        "stored_round_span",
        "queried_at",
      ],
      properties: {
        schema_version: { type: "integer" },
        last_stored_round: { type: ["integer", "null"] },
        oldest_stored_round: { type: ["integer", "null"] },
        stored_round_span: { type: ["integer", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_governance_config_changes: {
    input: {
      type: "object",
      properties: {
        block: { type: "integer", minimum: 0 },
        call_function: { type: "string" },
        success: { type: "boolean" },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["extrinsic_count", "extrinsics"],
      properties: {
        schema_version: { type: "integer" },
        extrinsic_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        extrinsics: objectItems({
          block_number: NULLABLE_INT,
          extrinsic_index: NULLABLE_INT,
          extrinsic_hash: NULLABLE_STRING,
          signer: NULLABLE_STRING,
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          call_args: ANY,
          success: { type: ["boolean", "null"] },
          fee_tao: ANY,
          tip_tao: ANY,
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_runtime: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["transition_count", "transitions"],
      properties: {
        schema_version: { type: "integer" },
        transition_count: { type: "integer" },
        current_spec_version: NULLABLE_INT,
        coverage_from_block: NULLABLE_INT,
        coverage_from_at: NULLABLE_STRING,
        transitions: objectItems({
          spec_version: { type: "integer" },
          block_number: { type: "integer" },
          observed_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_block_chain_events: {
    input: {
      type: "object",
      properties: {
        block_number: { type: "integer", minimum: 0 },
      },
      required: ["block_number"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["block_number", "event_count", "events"],
      properties: {
        schema_version: { type: "integer" },
        block_number: NULLABLE_INT,
        event_count: { type: "integer" },
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          pallet: NULLABLE_STRING,
          method: NULLABLE_STRING,
          args: ANY,
          phase: ANY,
          extrinsic_index: NULLABLE_INT,
          observed_at: { type: ["integer", "null"] },
        }),
      },
    },
  },
  get_extrinsic_chain_events: {
    input: {
      type: "object",
      properties: {
        ref: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "ref",
        "block_number",
        "extrinsic_index",
        "event_count",
        "events",
      ],
      properties: {
        schema_version: { type: "integer" },
        ref: ANY,
        block_number: NULLABLE_INT,
        extrinsic_index: NULLABLE_INT,
        limit: NULLABLE_INT,
        event_count: { type: "integer" },
        next_cursor: NULLABLE_STRING,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          pallet: NULLABLE_STRING,
          method: NULLABLE_STRING,
          args: ANY,
          phase: ANY,
          extrinsic_index: NULLABLE_INT,
          observed_at: { type: ["integer", "null"] },
        }),
      },
    },
  },
  get_chain_concentration: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        subnet_count: { type: "integer" },
        neuron_count: { type: "integer" },
        entity_count: { type: "integer" },
        uids_per_entity: { type: ["number", "null"] },
        captured_at: NULLABLE_STRING,
        stake: { type: ["object", "null"] },
        emission: { type: ["object", "null"] },
        entity_stake: { type: ["object", "null"] },
        entity_emission: { type: ["object", "null"] },
        validator_stake: { type: ["object", "null"] },
      },
    },
  },
  get_chain_performance: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        subnet_count: { type: "integer" },
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        active_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        incentive: { type: ["object", "null"] },
        dividends: { type: ["object", "null"] },
        trust: { type: ["object", "null"] },
        consensus: { type: ["object", "null"] },
        validator_trust: { type: ["object", "null"] },
      },
    },
  },
  get_chain_idle_stake: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "total_idle_stake_tao", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        captured_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        total_idle_stake_tao: { type: "number" },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: [
              "netuid",
              "neuron_count",
              "idle_neuron_count",
              "idle_stake_tao",
            ],
            properties: {
              netuid: { type: "integer" },
              neuron_count: { type: "integer" },
              idle_neuron_count: { type: "integer" },
              idle_stake_tao: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_identity_history: {
    input: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "count", "subnet_count", "changes"],
      properties: {
        schema_version: { type: "integer" },
        count: { type: "integer" },
        subnet_count: { type: "integer" },
        changes: objectItems({
          netuid: NULLABLE_INT,
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
          subnet_name: NULLABLE_STRING,
          symbol: NULLABLE_STRING,
          description: NULLABLE_STRING,
          github_repo: NULLABLE_STRING,
          subnet_url: NULLABLE_STRING,
          discord: NULLABLE_STRING,
          logo_url: NULLABLE_STRING,
          identity_hash: NULLABLE_STRING,
        }),
      },
    },
  },
  get_chain_yield: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        subnet_count: { type: "integer" },
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        miner_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        total_stake_tao: { type: "number" },
        total_emission_tao: { type: "number" },
        network_yield: { type: ["number", "null"] },
        validator_yield: { type: ["number", "null"] },
        miner_yield: { type: ["number", "null"] },
        distribution: { type: ["object", "null"] },
      },
    },
  },
  get_chain_turnover: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["7d", "30d", "90d"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["comparable", "subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        start_date: NULLABLE_STRING,
        end_date: NULLABLE_STRING,
        comparable: { type: "boolean" },
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "validators_start",
            "validators_end",
            "validators_entered",
            "validators_exited",
            "validator_retention",
            "stability_score",
          ],
          properties: {
            validators_start: { type: "integer" },
            validators_end: { type: "integer" },
            validators_entered: { type: "integer" },
            validators_exited: { type: "integer" },
            validator_retention: { type: ["number", "null"] },
            stability_score: { type: ["integer", "null"] },
          },
        },
        stability_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "validators_start",
              "validators_end",
              "validators_entered",
              "validators_exited",
              "validator_retention",
              "stability_score",
            ],
            properties: {
              netuid: { type: "integer" },
              validators_start: { type: "integer" },
              validators_end: { type: "integer" },
              validators_entered: { type: "integer" },
              validators_exited: { type: "integer" },
              validator_retention: { type: "number" },
              stability_score: { type: "integer" },
            },
          },
        },
      },
    },
  },
  get_chain_stake_flow: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "total_staked_tao",
            "total_unstaked_tao",
            "net_flow_tao",
            "gross_flow_tao",
            "stake_events",
            "unstake_events",
            "gaining",
            "losing",
            "flat",
          ],
          properties: {
            total_staked_tao: { type: "number" },
            total_unstaked_tao: { type: "number" },
            net_flow_tao: { type: "number" },
            gross_flow_tao: { type: "number" },
            stake_events: { type: "integer" },
            unstake_events: { type: "integer" },
            gaining: { type: "integer" },
            losing: { type: "integer" },
            flat: { type: "integer" },
          },
        },
        net_flow_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "total_staked_tao",
              "total_unstaked_tao",
              "net_flow_tao",
              "gross_flow_tao",
              "stake_events",
              "unstake_events",
              "direction",
            ],
            properties: {
              netuid: { type: "integer" },
              total_staked_tao: { type: "number" },
              total_unstaked_tao: { type: "number" },
              net_flow_tao: { type: "number" },
              gross_flow_tao: { type: "number" },
              stake_events: { type: "integer" },
              unstake_events: { type: "integer" },
              direction: { type: "string" },
            },
          },
        },
      },
    },
  },
  get_chain_alpha_volume: {
    input: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "buy_volume_alpha",
            "sell_volume_alpha",
            "total_volume_alpha",
            "buy_volume_tao",
            "sell_volume_tao",
            "total_volume_tao",
            "buy_count",
            "sell_count",
            "net_volume_alpha",
            "sentiment_ratio",
            "sentiment",
          ],
          properties: {
            buy_volume_alpha: ANY,
            sell_volume_alpha: ANY,
            total_volume_alpha: ANY,
            buy_volume_tao: ANY,
            sell_volume_tao: ANY,
            total_volume_tao: ANY,
            buy_count: { type: "integer" },
            sell_count: { type: "integer" },
            net_volume_alpha: ANY,
            sentiment_ratio: { type: ["number", "null"] },
            sentiment: { type: "string" },
          },
        },
        volume_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["netuid", "window"],
            properties: {
              schema_version: { type: "integer" },
              netuid: { type: "integer" },
              window: { type: "string" },
              buy_volume_alpha: ANY,
              sell_volume_alpha: ANY,
              total_volume_alpha: ANY,
              buy_volume_tao: ANY,
              sell_volume_tao: ANY,
              total_volume_tao: ANY,
              buy_count: { type: "integer" },
              sell_count: { type: "integer" },
              net_volume_alpha: ANY,
              sentiment_ratio: { type: ["number", "null"] },
              sentiment: NULLABLE_STRING,
              vol_mcap_ratio: { type: ["number", "null"] },
            },
          },
        },
      },
    },
  },
  get_chain_weights: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: ["distinct_setters", "weight_sets", "sets_per_setter"],
          properties: {
            distinct_setters: { type: "integer" },
            weight_sets: { type: "integer" },
            sets_per_setter: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_setters",
              "weight_sets",
              "sets_per_setter",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_setters: { type: "integer" },
              weight_sets: { type: "integer" },
              sets_per_setter: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_weight_setters: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "window",
        "distinct_setters",
        "weight_sets",
        "setter_count",
        "setters",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_setters: { type: "integer" },
        weight_sets: { type: "integer" },
        setter_count: { type: "integer" },
        setters: objectItems({
          hotkey: NULLABLE_STRING,
          uid: NULLABLE_INT,
          weight_sets: { type: "integer" },
          share: ANY,
          first_set_at: NULLABLE_STRING,
          last_set_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_chain_stake_moves: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: ["distinct_movers", "movements", "movements_per_mover"],
          properties: {
            distinct_movers: { type: "integer" },
            movements: { type: "integer" },
            movements_per_mover: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_movers",
              "movements",
              "movements_per_mover",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_movers: { type: "integer" },
              movements: { type: "integer" },
              movements_per_mover: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_stake_transfers: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: ["distinct_senders", "transfers", "transfers_per_sender"],
          properties: {
            distinct_senders: { type: "integer" },
            transfers: { type: "integer" },
            transfers_per_sender: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_senders",
              "transfers",
              "transfers_per_sender",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_senders: { type: "integer" },
              transfers: { type: "integer" },
              transfers_per_sender: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_axon_removals: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: ["distinct_removers", "removals", "removals_per_remover"],
          properties: {
            distinct_removers: { type: "integer" },
            removals: { type: "integer" },
            removals_per_remover: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_removers",
              "removals",
              "removals_per_remover",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_removers: { type: "integer" },
              removals: { type: "integer" },
              removals_per_remover: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_serving: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "distinct_servers",
            "announcements",
            "announcements_per_server",
          ],
          properties: {
            distinct_servers: { type: "integer" },
            announcements: { type: "integer" },
            announcements_per_server: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_servers",
              "announcements",
              "announcements_per_server",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_servers: { type: "integer" },
              announcements: { type: "integer" },
              announcements_per_server: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_prometheus: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "distinct_exporters",
            "announcements",
            "announcements_per_exporter",
          ],
          properties: {
            distinct_exporters: { type: "integer" },
            announcements: { type: "integer" },
            announcements_per_exporter: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_exporters",
              "announcements",
              "announcements_per_exporter",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_exporters: { type: "integer" },
              announcements: { type: "integer" },
              announcements_per_exporter: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_activity: {
    input: {
      type: "object",
      properties: {
        blocks: { type: "integer", minimum: 1, maximum: 5000 },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window_blocks", "groups", "activity"],
      properties: {
        window_blocks: { type: "integer" },
        groups: { type: "integer" },
        activity: objectItems({
          pallet: NULLABLE_STRING,
          method: NULLABLE_STRING,
          count: NULLABLE_INT,
        }),
      },
    },
  },
  list_chain_events: {
    input: {
      type: "object",
      properties: {
        pallet: { type: "string" },
        method: { type: "string" },
        block: { type: "integer", minimum: 0 },
        extrinsic: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
        before: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["count", "events"],
      properties: {
        count: { type: "integer" },
        next_before: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          pallet: NULLABLE_STRING,
          method: NULLABLE_STRING,
          args: ANY,
          phase: ANY,
          extrinsic_index: NULLABLE_INT,
          observed_at: ANY,
        }),
      },
    },
  },
  get_chain_calls: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        group_by: { type: "string", enum: ["module", "module_function"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        call_module: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "schema_version",
        "window",
        "group_by",
        "total_extrinsics",
        "call_count",
        "calls",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        group_by: { type: "string" },
        observed_at: NULLABLE_STRING,
        total_extrinsics: { type: "integer" },
        call_count: { type: "integer" },
        calls: objectItems({
          call_module: NULLABLE_STRING,
          call_function: NULLABLE_STRING,
          count: NULLABLE_INT,
          share: ANY,
        }),
      },
    },
  },
  get_chain_signers: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        sort: { type: "string", enum: ["tx_count", "total_fee_tao"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        call_module: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "sort", "signer_count", "signers"],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        sort: { type: "string", enum: ["tx_count", "total_fee_tao"] },
        observed_at: NULLABLE_STRING,
        signer_count: { type: "integer" },
        signers: objectItems({
          signer: NULLABLE_STRING,
          tx_count: NULLABLE_INT,
          total_fee_tao: { type: ["number", "null"] },
          total_tip_tao: { type: ["number", "null"] },
          last_tx_block: NULLABLE_INT,
        }),
      },
    },
  },
  get_chain_fees: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        call_module: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "day_count", "daily", "top_fee_payers"],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        observed_at: NULLABLE_STRING,
        day_count: { type: "integer" },
        daily: objectItems({
          day: NULLABLE_STRING,
          extrinsic_count: NULLABLE_INT,
          total_fee_tao: { type: ["number", "null"] },
          avg_fee_tao: { type: ["number", "null"] },
          median_fee_tao: { type: ["number", "null"] },
          total_tip_tao: { type: ["number", "null"] },
          avg_tip_tao: { type: ["number", "null"] },
          median_tip_tao: { type: ["number", "null"] },
        }),
        top_fee_payers: objectItems({
          signer: NULLABLE_STRING,
          total_fee_tao: { type: ["number", "null"] },
          total_tip_tao: { type: ["number", "null"] },
          extrinsic_count: NULLABLE_INT,
        }),
      },
    },
  },
  get_chain_registrations: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          properties: {
            distinct_registrants: NULLABLE_INT,
            registrations: NULLABLE_INT,
            registrations_per_registrant: { type: ["number", "null"] },
          },
        },
        intensity_distribution: { type: ["object", "null"] },
        subnets: objectItems({
          netuid: NULLABLE_INT,
          distinct_registrants: NULLABLE_INT,
          registrations: NULLABLE_INT,
          registrations_per_registrant: { type: ["number", "null"] },
        }),
      },
    },
  },
  get_chain_deregistrations: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "network", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "distinct_deregistered_hotkeys",
            "deregistrations",
            "deregistrations_per_hotkey",
          ],
          properties: {
            distinct_deregistered_hotkeys: { type: "integer" },
            deregistrations: { type: "integer" },
            deregistrations_per_hotkey: { type: ["number", "null"] },
          },
        },
        intensity_distribution: {
          ...DISTRIBUTION_STATS,
          type: ["object", "null"],
        },
        subnets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "netuid",
              "distinct_deregistered_hotkeys",
              "deregistrations",
              "deregistrations_per_hotkey",
            ],
            properties: {
              netuid: { type: "integer" },
              distinct_deregistered_hotkeys: { type: "integer" },
              deregistrations: { type: "integer" },
              deregistrations_per_hotkey: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_chain_transfers: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "window",
        "observed_at",
        "total_volume_tao",
        "transfer_count",
        "unique_senders",
        "unique_receivers",
        "top_sender_share",
        "top_senders",
        "top_receivers",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: {
          type: ["string", "null"],
          enum: [...CHAIN_ANALYTICS_WINDOWS_2, null],
        },
        observed_at: NULLABLE_STRING,
        total_volume_tao: { type: "number" },
        transfer_count: { type: "integer", minimum: 0 },
        unique_senders: { type: "integer", minimum: 0 },
        unique_receivers: { type: "integer", minimum: 0 },
        top_sender_share: { type: ["number", "null"] },
        top_senders: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["address", "volume_tao", "transfer_count"],
            properties: {
              address: { type: "string" },
              volume_tao: { type: "number" },
              transfer_count: { type: "integer", minimum: 0 },
            },
          },
        },
        top_receivers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["address", "volume_tao", "transfer_count"],
            properties: {
              address: { type: "string" },
              volume_tao: { type: "number" },
              transfer_count: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
  },
  get_chain_transfer_pairs: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
        sort: { type: "string", enum: ["volume", "count"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "window",
        "sort",
        "observed_at",
        "total_volume_tao",
        "transfer_count",
        "unique_pairs",
        "pair_count",
        "top_pair_share",
        "pairs",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: {
          type: ["string", "null"],
          enum: [...CHAIN_ANALYTICS_WINDOWS_2, null],
        },
        sort: { type: "string", enum: ["volume", "count"] },
        observed_at: NULLABLE_STRING,
        total_volume_tao: { type: "number" },
        transfer_count: { type: "integer", minimum: 0 },
        unique_pairs: { type: "integer", minimum: 0 },
        pair_count: { type: "integer", minimum: 0 },
        top_pair_share: { type: ["number", "null"] },
        pairs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "from",
              "to",
              "volume_tao",
              "transfer_count",
              "last_block",
              "last_observed_at",
            ],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              volume_tao: { type: "number" },
              transfer_count: { type: "integer", minimum: 0 },
              last_block: { type: ["integer", "null"] },
              last_observed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_network_activity: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: CHAIN_ANALYTICS_WINDOWS_2 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "day_count", "days"],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        observed_at: NULLABLE_STRING,
        day_count: { type: "integer" },
        days: objectItems({
          day: NULLABLE_STRING,
          block_count: NULLABLE_INT,
          extrinsic_count: NULLABLE_INT,
          event_count: NULLABLE_INT,
          successful_extrinsics: NULLABLE_INT,
          success_rate: { type: ["number", "null"] },
          unique_signers: NULLABLE_INT,
        }),
      },
    },
  },
  list_subnet_apis: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "service_count", "services"],
      properties: {
        netuid: { type: "integer" },
        service_count: { type: "integer" },
        services: { type: "array", items: { type: "object" } },
        operational_observed_at: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
      },
    },
  },
  get_api_schema: {
    input: {
      type: "object",
      properties: {
        surface_id: { type: "string" },
      },
      required: ["surface_id"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surface_id"],
      properties: {
        surface_id: { type: "string" },
        kind: NULLABLE_STRING,
        base_url: NULLABLE_STRING,
        auth_required: { type: ["boolean", "null"] },
        auth_schemes: { type: "array" },
        drift_status: NULLABLE_STRING,
        document: { type: ["object", "null"] },
      },
    },
  },
  get_fixture: {
    input: {
      type: "object",
      properties: {
        surface_id: { type: "string" },
      },
      required: ["surface_id"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surface_id"],
      properties: { surface_id: { type: "string" } },
    },
  },
  get_provider_detail: {
    input: {
      type: "object",
      properties: {
        slug: { type: "string" },
        include_endpoints: { type: "boolean" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        id: NULLABLE_STRING,
        slug: NULLABLE_STRING,
        name: NULLABLE_STRING,
        authority: NULLABLE_STRING,
        kind: NULLABLE_STRING,
        provider: { type: ["object", "null"] },
        endpoints: { type: ["object", "array", "null"] },
      },
    },
  },
  list_providers: {
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: PROVIDER_KINDS },
        authority: { type: "string", enum: PROVIDER_AUTHORITIES },
        sort: { type: "string", enum: PROVIDER_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["providers"],
      properties: {
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
        providers: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_surfaces: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        id: { type: "string" },
        sort: { type: "string", enum: SURFACE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surfaces"],
      properties: {
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_candidates: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        state: { type: "string", enum: CANDIDATE_STATES },
        id: { type: "string" },
        confidence: { type: "string", enum: CONFIDENCE_LEVELS },
        sort: { type: "string", enum: CANDIDATES_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["candidates"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        schema_version: { type: ["string", "integer", "null"] },
        candidates: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_endpoints: {
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SURFACE_KIND },
        layer: { type: "string", enum: ENDPOINT_LAYERS },
        netuid: { type: "integer", minimum: 0 },
        provider: { type: "string" },
        publication_state: {
          type: "string",
          enum: ENDPOINT_PUBLICATION_STATES,
        },
        status: { type: "string", enum: HEALTH_STATUS },
        pool_eligible: { type: "boolean" },
        min_latency_ms: { type: "number" },
        max_latency_ms: { type: "number" },
        min_score: { type: "number" },
        max_score: { type: "number" },
        sort: { type: "string", enum: ENDPOINT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        endpoints: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        next_cursor: { type: ["integer", "null"] },
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
      },
    },
  },
  list_evidence: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        sort: { type: "string", enum: CLAIM_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["claims"],
      properties: {
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
        summary: { type: ["object", "null"] },
        claims: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_rpc_endpoints: {
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SURFACE_KIND },
        layer: { type: "string", enum: ENDPOINT_LAYERS },
        netuid: { type: "integer", minimum: 0 },
        provider: { type: "string" },
        publication_state: {
          type: "string",
          enum: ENDPOINT_PUBLICATION_STATES,
        },
        status: { type: "string", enum: HEALTH_STATUS },
        pool_eligible: { type: "boolean" },
        min_latency_ms: { type: "number" },
        max_latency_ms: { type: "number" },
        min_score: { type: "number" },
        max_score: { type: "number" },
        sort: { type: "string", enum: ENDPOINT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        limit: { type: "integer", minimum: 1 },
        cursor: {
          oneOf: [{ type: "integer", minimum: 0 }, { type: "string" }],
        },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["endpoints"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        schema_version: NULLABLE_INT,
        summary: { type: ["object", "null"] },
        source: NULLABLE_STRING,
        operational_observed_at: NULLABLE_STRING,
        endpoints: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_source_snapshots: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        sort: { type: "string", enum: SOURCE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["sources"],
      properties: {
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
        summary: { type: ["object", "null"] },
        sources: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_profile_completeness: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        profile_level: { type: "string", enum: PROFILE_LEVEL },
        confidence: { type: "string", enum: CONFIDENCE_LEVELS },
        identity_level: { type: "string", enum: IDENTITY_LEVELS },
        identity_promotion_kinds: { type: "string", enum: SURFACE_KIND },
        native_name_quality: { type: "string", enum: NATIVE_NAME_QUALITIES },
        sort: { type: "string", enum: PROFILE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["profiles"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        summary: { type: ["object", "null"], additionalProperties: true },
        profiles: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_rpc_pools: {
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: POOL_KINDS },
        min_eligible_count: { type: "number" },
        max_eligible_count: { type: "number" },
        min_endpoint_count: { type: "number" },
        max_endpoint_count: { type: "number" },
        sort: { type: "string", enum: POOL_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["pools"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        source: NULLABLE_STRING,
        operational_observed_at: NULLABLE_STRING,
        pools: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_endpoints: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        netuid: { type: ["integer", "null"] },
        endpoints: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
      },
    },
  },
  list_subnet_endpoints: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        layer: { type: "string", enum: ENDPOINT_LAYERS },
        provider: { type: "string" },
        publication_state: {
          type: "string",
          enum: ENDPOINT_PUBLICATION_STATES,
        },
        status: { type: "string", enum: HEALTH_STATUS },
        pool_eligible: { type: "string", enum: BOOLEAN_STRINGS },
        min_latency_ms: { type: "number" },
        max_latency_ms: { type: "number" },
        min_score: { type: "number" },
        max_score: { type: "number" },
        sort: { type: "string", enum: ENDPOINT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["endpoints"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        endpoints: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_subnet_surfaces: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        id: { type: "string" },
        sort: { type: "string", enum: SURFACE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surfaces"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_subnet_health: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        status: { type: "string", enum: HEALTH_STATUS },
        classification: { type: "string", enum: HEALTH_CLASSIFICATION },
        sort: { type: "string", enum: HEALTH_SURFACE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surfaces"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_candidates: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        netuid: { type: ["integer", "null"] },
        candidates: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
      },
    },
  },
  list_subnet_candidates: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        state: { type: "string", enum: CANDIDATE_STATES },
        id: { type: "string" },
        confidence: { type: "string", enum: CONFIDENCE_LEVELS },
        sort: { type: "string", enum: CANDIDATES_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["candidates"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        candidates: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_evidence: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        netuid: { type: ["integer", "null"] },
        claims: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
      },
    },
  },
  list_subnet_evidence: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        q: { type: "string" },
        sort: { type: "string", enum: CLAIM_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["claims"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        claims: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_surfaces: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        netuid: { type: ["integer", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
        schema_version: { type: ["string", "integer", "null"] },
      },
    },
  },
  list_fixtures: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        candidate_count: { type: "integer" },
        coverage: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
      },
    },
  },
  list_schemas: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        schemas: { type: "array", items: { type: "object" } },
        observed_at: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        notes: NULLABLE_STRING,
      },
    },
  },
  list_search_index: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        type: { type: "string", enum: DOCUMENT_TYPES },
        netuid: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: DOCUMENT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["documents"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        documents: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_search: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        type: { type: "string", enum: DOCUMENT_TYPES },
        netuid: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: DOCUMENT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["documents"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        documents: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_curation: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        sort: { type: "string", enum: CURATION_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["curation"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: NULLABLE_STRING,
        curation: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_gaps: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        sort: { type: "string", enum: GAPS_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["gaps"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: NULLABLE_STRING,
        gaps: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_enrichment_queue: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        netuid: { type: "integer", minimum: 0 },
        lane: { type: "string", enum: LANES },
        evidence_action: { type: "string", enum: EVIDENCE_ACTIONS },
        identity_level: { type: "string", enum: IDENTITY_LEVELS },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        profile_level: { type: "string", enum: PROFILE_LEVEL },
        direct_submission_kinds: { type: "string", enum: SURFACE_KIND },
        missing_kinds: { type: "string", enum: SURFACE_KIND },
        manual_review_required: { type: "string", enum: BOOLEAN_STRINGS },
        reason_codes: { type: "string" },
        review_state: { type: "string" },
        sort: { type: "string", enum: QUEUE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["queue"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        queue: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_adapter_candidates: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        candidate_api_kinds: { type: "string", enum: SURFACE_KIND },
        operational_kinds: { type: "string", enum: SURFACE_KIND },
        recommended_adapter_kind: {
          type: "string",
          enum: RECOMMENDED_ADAPTER_KINDS,
        },
        reason_codes: { type: "string" },
        sort: { type: "string", enum: ADAPTER_CANDIDATES_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["candidates"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        candidates: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_enrichment_evidence: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        netuid: { type: "integer", minimum: 0 },
        lane: { type: "string", enum: LANES },
        evidence_action: { type: "string", enum: EVIDENCE_ACTIONS },
        direct_submission_kinds: { type: "string", enum: SURFACE_KIND },
        missing_kinds: { type: "string", enum: SURFACE_KIND },
        sort: { type: "string", enum: EVIDENCE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["entries"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        entries: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_review_gaps: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        missing_kinds: { type: "string", enum: SURFACE_KIND },
        review_state: { type: "string" },
        sort: { type: "string", enum: PRIORITY_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["priorities"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        priorities: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_review_enrichment_targets: {
    input: {
      type: "object",
      properties: {
        q: { type: "string" },
        netuid: { type: "integer", minimum: 0 },
        target_type: { type: "string", enum: TARGET_TYPES },
        target_action: { type: "string", enum: TARGET_ACTIONS },
        kind: { type: "string", enum: SURFACE_KIND },
        lane: { type: "string", enum: LANES },
        evidence_action: { type: "string", enum: EVIDENCE_ACTIONS },
        identity_level: { type: "string", enum: IDENTITY_LEVELS },
        profile_level: { type: "string", enum: PROFILE_LEVEL },
        submission_route: { type: "string", enum: SUBMISSION_ROUTES },
        auto_review_candidate: { type: "string", enum: BOOLEAN_STRINGS },
        manual_review_required: { type: "string", enum: BOOLEAN_STRINGS },
        missing_kinds: { type: "string", enum: SURFACE_KIND },
        reason_codes: { type: "string" },
        sort: { type: "string", enum: TARGET_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["targets"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        targets: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_endpoint_pools: {
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: POOL_KINDS },
        min_eligible_count: { type: "number" },
        max_eligible_count: { type: "number" },
        min_endpoint_count: { type: "number" },
        max_endpoint_count: { type: "number" },
        sort: { type: "string", enum: POOL_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["pools"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        pools: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_endpoint_incidents: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        status: { type: "string", enum: HEALTH_STATUS },
        severity: { type: "string", enum: INCIDENT_SEVERITIES },
        state: { type: "string", enum: INCIDENT_STATES },
        sort: { type: "string", enum: INCIDENT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["incidents"],
      properties: {
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        summary: { type: ["object", "null"] },
        incidents: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  list_provider_endpoints: {
    input: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9-]+$" },
        kind: { type: "string", enum: SURFACE_KIND },
        layer: { type: "string", enum: ENDPOINT_LAYERS },
        netuid: { type: "integer", minimum: 0 },
        publication_state: {
          type: "string",
          enum: ENDPOINT_PUBLICATION_STATES,
        },
        status: { type: "string", enum: HEALTH_STATUS },
        pool_eligible: { type: "boolean" },
        min_latency_ms: { type: "number" },
        max_latency_ms: { type: "number" },
        min_score: { type: "number" },
        max_score: { type: "number" },
        sort: { type: "string", enum: ENDPOINT_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["slug", "endpoints"],
      properties: {
        slug: { type: "string" },
        generated_at: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        endpoints: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_lineage: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        link_count: { type: "integer" },
        graduated_subnet_count: { type: "integer" },
        broken_link_count: { type: "integer" },
        links: { type: "array", items: { type: "object" } },
        broken_links: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
      },
    },
  },
  get_freshness: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["sources"],
      properties: {
        schema_version: { type: "integer" },
        sources: { type: "array", items: { type: "object" } },
        summary: { type: ["object", "null"] },
        generated_at: NULLABLE_STRING,
      },
    },
  },
  get_contracts: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "artifacts"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        name: NULLABLE_STRING,
        base_path: NULLABLE_STRING,
        primary_domain: NULLABLE_STRING,
        openapi_url: NULLABLE_STRING,
        type_definitions_url: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        artifacts: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_source_health: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["providers"],
      properties: {
        providers: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
      },
    },
  },
  get_changelog: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["source", "summary", "artifacts", "subnets"],
      properties: {
        generated_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        summary: { type: "object" },
        artifacts: { type: "object" },
        subnets: { type: "object" },
        coverage_delta: { type: ["object", "null"] },
      },
    },
  },
  get_feed: {
    input: {
      type: "object",
      properties: {
        kind: { type: "string", enum: FEED_KINDS },
        netuid: { type: "integer", minimum: 0 },
        tag: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: FEED_MAX_ITEMS },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["kind", "returned", "items"],
      properties: {
        kind: { type: "string", enum: FEED_KINDS },
        netuid: NULLABLE_INT,
        filters: {
          type: "object",
          additionalProperties: true,
          properties: {
            tag: NULLABLE_STRING,
            since: NULLABLE_STRING,
            until: NULLABLE_STRING,
            limit: { type: "integer" },
          },
        },
        returned: { type: "integer" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "url", "title", "summary", "timestamp", "tags"],
            properties: {
              id: { type: "string" },
              url: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              timestamp: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
  get_build: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "artifact_count"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        published_at: NULLABLE_STRING,
        adapter_count: { type: ["integer", "null"] },
        artifact_count: { type: "integer" },
        artifact_size_bytes: { type: ["integer", "null"] },
        subnet_count: { type: ["integer", "null"] },
        surface_count: { type: ["integer", "null"] },
        provider_count: { type: ["integer", "null"] },
        artifacts: {
          type: ["array", "null"],
          items: { type: "object" },
        },
        coverage: { type: ["object", "null"] },
        artifact_budget_summary: { type: ["object", "null"] },
      },
    },
  },
  get_adapter: {
    input: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9-]+$" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "slug"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        slug: { type: "string" },
        subnet: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        notes: {
          type: ["array", "string", "null"],
          items: { type: "string" },
        },
        snapshot: { type: ["object", "null"] },
        extensions: { type: ["object", "null"] },
      },
    },
  },
  get_agent_catalog: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [],
      properties: {
        subnet_count: { type: "integer" },
        total_subnet_count: { type: "integer" },
        callable_service_count: { type: "integer" },
        content_hash: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        published_at: NULLABLE_STRING,
        subnets: { type: "array", items: { type: "object" } },
        operational_observed_at: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
      },
    },
  },
  get_agent_resources: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["resources", "mcp"],
      properties: {
        generated_at: NULLABLE_STRING,
        published_at: NULLABLE_STRING,
        content_hash: NULLABLE_STRING,
        summary: { type: "object" },
        copyable_agent: { type: "object" },
        mcp: { type: "object" },
        resources: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_rpc_usage: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["7d", "30d"] },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "schema_version",
        "source",
        "summary",
        "endpoints",
        "networks",
        "buckets",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        bucket_granularity: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: { type: "string" },
        summary: {
          type: "object",
          additionalProperties: true,
          required: [
            "total_requests",
            "ok_requests",
            "error_requests",
            "latency_ms",
          ],
          properties: {
            total_requests: { type: "integer", minimum: 0 },
            ok_requests: { type: "integer", minimum: 0 },
            error_requests: { type: "integer", minimum: 0 },
            error_rate: { type: ["number", "null"] },
            failover_requests: { type: "integer", minimum: 0 },
            failover_rate: { type: ["number", "null"] },
            cache_hits: { type: "integer", minimum: 0 },
            cache_hit_rate: { type: ["number", "null"] },
            latency_ms: {
              type: "object",
              additionalProperties: true,
              required: ["p50", "p95", "avg"],
              properties: {
                p50: NULLABLE_INT,
                p95: NULLABLE_INT,
                avg: NULLABLE_INT,
              },
            },
          },
        },
        endpoints: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["endpoint_id", "requests", "ok_requests"],
            properties: {
              rank: { type: "integer", minimum: 1 },
              endpoint_id: NULLABLE_STRING,
              provider: NULLABLE_STRING,
              requests: { type: "integer", minimum: 0 },
              ok_requests: { type: "integer", minimum: 0 },
              error_rate: { type: ["number", "null"] },
              avg_latency_ms: NULLABLE_INT,
            },
          },
        },
        networks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["network", "requests", "ok_requests"],
            properties: {
              network: { type: "string" },
              requests: { type: "integer", minimum: 0 },
              ok_requests: { type: "integer", minimum: 0 },
              error_rate: { type: ["number", "null"] },
            },
          },
        },
        buckets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["ts", "requests", "errors", "avg_latency_ms"],
            properties: {
              ts: { type: "integer", minimum: 0 },
              requests: { type: "integer", minimum: 0 },
              errors: { type: "integer", minimum: 0 },
              avg_latency_ms: NULLABLE_INT,
            },
          },
        },
      },
    },
  },
  get_best_rpc_endpoint: {
    input: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["eligible_count", "endpoints"],
      properties: {
        eligible_count: { type: "integer" },
        live_health: ANY,
        endpoints: objectItems({
          id: { type: "string" },
          url: NULLABLE_STRING,
          provider: NULLABLE_STRING,
          kind: NULLABLE_STRING,
          score: ANY,
          latency_ms: NULLABLE_INT,
          status: NULLABLE_STRING,
          health_source: NULLABLE_STRING,
        }),
      },
    },
  },
  call_rpc: {
    input: {
      type: "object",
      properties: {
        method: { type: "string" },
        params: { type: "array" },
        network: { type: "string", enum: ["finney", "test"] },
      },
      required: ["method"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["network", "method", "jsonrpc"],
      properties: {
        network: { type: "string" },
        method: { type: "string" },
        jsonrpc: { type: "string" },
        result: ANY,
        error: { type: ["object", "null"] },
        endpoint_id: NULLABLE_STRING,
        provider: NULLABLE_STRING,
        cache: NULLABLE_STRING,
      },
    },
  },
  query_graphql: {
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        variables: { type: "object", additionalProperties: true },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        data: {
          type: "object",
          additionalProperties: true,
          nullable: true,
        },
        errors: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      additionalProperties: true,
    },
  },
  registry_summary: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet_count", "counts"],
      properties: {
        subnet_count: { type: "integer" },
        counts: { type: "object" },
        coverage: { type: "object" },
        curation_level_counts: { type: "object" },
        profile_level_counts: { type: "object" },
        recent_changes: { type: "object" },
        top_subnets: { type: "array", items: { type: "object" } },
        generated_at: NULLABLE_STRING,
      },
    },
  },
  get_coverage: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surface_count", "completeness"],
      properties: {
        generated_at: NULLABLE_STRING,
        surface_count: { type: "integer" },
        official_surface_count: { type: "integer" },
        first_party_subnet_count: { type: "integer" },
        chain_subnet_count: { type: "integer" },
        candidate_count: { type: "integer" },
        probed_count: { type: "integer" },
        domain_coverage: { type: "object" },
        completeness: { type: "object" },
        subnets_without_official_surface: { type: "integer" },
      },
    },
  },
  get_coverage_depth: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "integer" },
        generated_at: NULLABLE_STRING,
        coverage_depth_version: { type: ["string", "null"] },
        rows: { type: "array", items: { type: "object" } },
        ranked_queue: { type: "array", items: { type: "object" } },
      },
    },
  },
  list_enrichment_targets: {
    input: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        tier: { type: "string", enum: COVERAGE_DEPTH_TIERS_12 },
        severity: { type: "string", enum: COVERAGE_DEPTH_SEVERITIES_12 },
        gap_code: { type: "string", pattern: "^[a-z0-9-]+$" },
        agent_status: { type: "string", enum: AGENT_READINESS_STATUSES },
        netuid: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["total_rows", "queue_count", "returned", "targets"],
      properties: {
        generated_at: NULLABLE_STRING,
        coverage_depth_version: ANY,
        total_rows: { type: "integer" },
        queue_count: { type: "integer" },
        returned: { type: "integer" },
        filters: { type: "object" },
        note: { type: "string" },
        targets: objectItems({
          rank: NULLABLE_INT,
          netuid: { type: "integer" },
          slug: NULLABLE_STRING,
          name: NULLABLE_STRING,
          tier: { type: "string" },
          score: { type: "integer" },
          priority_score: { type: "integer" },
          agent_status: { type: "string" },
          blocker_level: { type: "string" },
          top_gap_codes: { type: "array" },
          top_gaps: { type: "array", items: { type: "object" } },
          recommended_next_action: NULLABLE_STRING,
          dimensions: { type: "object" },
        }),
      },
    },
  },
  get_subnet_gaps: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "priorities", "enrichment_queue"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        netuid: { type: "integer" },
        slug: NULLABLE_STRING,
        name: NULLABLE_STRING,
        priorities: { type: "array", items: { type: "object" } },
        enrichment_queue: { type: "array", items: { type: "object" } },
      },
    },
  },
  list_subnet_gaps: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        missing_kinds: { type: "string", enum: SURFACE_KIND },
        review_state: { type: "string" },
        sort: { type: "string", enum: GAP_PRIORITY_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["priorities"],
      properties: {
        generated_at: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        priorities: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  run_saved_query: {
    input: {
      type: "object",
      required: ["query_id"],
      properties: {
        query_id: { type: "string", enum: SAVED_QUERY_IDS },
        params: { type: "object" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["query_id", "params", "data"],
      properties: {
        query_id: { type: "string" },
        params: { type: "object" },
        data: {},
      },
    },
  },
  find_subnet_opportunities: {
    input: {
      type: "object",
      properties: {
        board: {
          type: "string",
          enum: [...ECONOMIC_LEADERBOARD_BOARDS],
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["boards", "with_economics_count"],
      properties: {
        board: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        with_economics_count: { type: "integer" },
        boards: {
          type: "object",
          additionalProperties: objectItems({
            netuid: { type: "integer" },
            slug: NULLABLE_STRING,
            name: NULLABLE_STRING,
          }),
        },
      },
    },
  },
  semantic_search: {
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        type: SEMANTIC_TYPE_SCHEMA,
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["query", "count", "results"],
      properties: {
        query: { type: "string" },
        count: { type: "integer" },
        model: NULLABLE_STRING,
        results: objectItems({
          score: ANY,
          type: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          slug: NULLABLE_STRING,
          title: NULLABLE_STRING,
          subtitle: NULLABLE_STRING,
          url: NULLABLE_STRING,
        }),
      },
    },
  },
  ask: {
    input: {
      type: "object",
      properties: {
        question: { type: "string" },
        type: SEMANTIC_TYPE_SCHEMA,
      },
      required: ["question"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["question", "answer"],
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        model: NULLABLE_STRING,
        context_count: NULLABLE_INT,
        citations: objectItems({
          ref: ANY,
          score: { type: "number" },
          title: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          slug: NULLABLE_STRING,
          url: NULLABLE_STRING,
        }),
      },
    },
  },
  find_subnet_for_task: {
    input: {
      type: "object",
      properties: {
        task: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["task"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["task", "count", "results"],
      properties: {
        task: { type: "string" },
        count: { type: "integer" },
        discovery: ANY,
        note: NULLABLE_STRING,
        results: { type: "array", items: { type: "object" } },
      },
    },
  },
  how_do_i_call: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        subnet: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "callable", "services"],
      properties: {
        netuid: { type: "integer" },
        name: NULLABLE_STRING,
        slug: NULLABLE_STRING,
        integration_readiness: ANY,
        callable: { type: "boolean" },
        callable_count: { type: "integer" },
        guidance: ANY,
        services: { type: "array", items: { type: "object" } },
        next_steps: { type: "array" },
        operational_observed_at: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
      },
    },
  },
  verify_integration: {
    input: {
      type: "object",
      properties: {
        surface_id: { type: "string" },
        netuid: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surface_id", "status", "callable"],
      properties: {
        surface_id: { type: "string" },
        surface_key: NULLABLE_STRING,
        netuid: NULLABLE_INT,
        kind: { type: "string" },
        url: { type: "string" },
        provider: NULLABLE_STRING,
        status: { type: "string" },
        classification: NULLABLE_STRING,
        callable: { type: "boolean" },
        latency_ms: NULLABLE_INT,
        status_code: NULLABLE_INT,
        error: NULLABLE_STRING,
        probed_at: NULLABLE_STRING,
        from_cache: { type: "boolean" },
      },
    },
  },
  call_subnet_surface: {
    input: {
      type: "object",
      properties: {
        surface_id: { type: "string" },
        query: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        path: { type: "string" },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT"] },
        body: { type: ["object", "string"] },
        content_type: { type: "string" },
        credential: { type: ["string", "object"] },
      },
      required: ["surface_id"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["surface_id", "url", "status_code", "truncated"],
      properties: {
        surface_id: { type: "string" },
        url: { type: "string" },
        status_code: { type: "integer" },
        content_type: NULLABLE_STRING,
        latency_ms: NULLABLE_INT,
        body: {},
        truncated: { type: "boolean" },
        parse_error: NULLABLE_STRING,
      },
    },
  },
};

const NEW_SCHEMAS: Record<string, { input: z.ZodType; output: z.ZodType }> = {
  search_subnets: {
    input: SearchSubnetsInputSchema,
    output: SearchSubnetsOutputSchema,
  },
  list_subnets: {
    input: ListSubnetsInputSchema,
    output: ListSubnetsOutputSchema,
  },
  get_subnet: { input: GetSubnetInputSchema, output: GetSubnetOutputSchema },
  get_network_health: {
    input: GetNetworkHealthInputSchema,
    output: GetNetworkHealthOutputSchema,
  },
  get_subnet_stake_quote: {
    input: GetSubnetStakeQuoteInputSchema,
    output: GetSubnetStakeQuoteOutputSchema,
  },
  get_economics: {
    input: GetEconomicsInputSchema,
    output: GetEconomicsOutputSchema,
  },
  find_subnets_by_capability: {
    input: FindSubnetsByCapabilityInputSchema,
    output: FindSubnetsByCapabilityOutputSchema,
  },
  get_subnet_detail: {
    input: GetSubnetDetailInputSchema,
    output: GetSubnetDetailOutputSchema,
  },
  get_subnet_snapshot: {
    input: GetSubnetSnapshotInputSchema,
    output: GetSubnetSnapshotOutputSchema,
  },
  get_subnet_health: {
    input: GetSubnetHealthInputSchema,
    output: GetSubnetHealthOutputSchema,
  },
  get_subnet_health_trends: {
    input: GetSubnetHealthTrendsInputSchema,
    output: GetSubnetHealthTrendsOutputSchema,
  },
  get_health_trends: {
    input: GetHealthTrendsInputSchema,
    output: GetHealthTrendsOutputSchema,
  },
  get_subnet_health_percentiles: {
    input: GetSubnetHealthPercentilesInputSchema,
    output: GetSubnetHealthPercentilesOutputSchema,
  },
  get_subnet_health_incidents: {
    input: GetSubnetHealthIncidentsInputSchema,
    output: GetSubnetHealthIncidentsOutputSchema,
  },
  get_subnet_economics: {
    input: GetSubnetEconomicsInputSchema,
    output: GetSubnetEconomicsOutputSchema,
  },
  get_stake_action_preview: {
    input: GetStakeActionPreviewInputSchema,
    output: GetStakeActionPreviewOutputSchema,
  },
  get_subnet_trajectory: {
    input: GetSubnetTrajectoryInputSchema,
    output: GetSubnetTrajectoryOutputSchema,
  },
  get_subnet_concentration: {
    input: GetSubnetConcentrationInputSchema,
    output: GetSubnetConcentrationOutputSchema,
  },
  get_subnet_performance: {
    input: GetSubnetPerformanceInputSchema,
    output: GetSubnetPerformanceOutputSchema,
  },
  get_subnet_idle_stake: {
    input: GetSubnetIdleStakeInputSchema,
    output: GetSubnetIdleStakeOutputSchema,
  },
  get_subnet_movers: {
    input: GetSubnetMoversInputSchema,
    output: GetSubnetMoversOutputSchema,
  },
  get_subnet_uptime: {
    input: GetSubnetUptimeInputSchema,
    output: GetSubnetUptimeOutputSchema,
  },
  get_health_history: {
    input: GetHealthHistoryInputSchema,
    output: GetHealthHistoryOutputSchema,
  },
  get_blocks_summary: {
    input: GetBlocksSummaryInputSchema,
    output: GetBlocksSummaryOutputSchema,
  },
  get_subnet_concentration_history: {
    input: GetSubnetConcentrationHistoryInputSchema,
    output: GetSubnetConcentrationHistoryOutputSchema,
  },
  get_subnet_turnover: {
    input: GetSubnetTurnoverInputSchema,
    output: GetSubnetTurnoverOutputSchema,
  },
  get_subnet_yield: {
    input: GetSubnetYieldInputSchema,
    output: GetSubnetYieldOutputSchema,
  },
  get_subnet_yield_history: {
    input: GetSubnetYieldHistoryInputSchema,
    output: GetSubnetYieldHistoryOutputSchema,
  },
  get_subnet_stake_flow: {
    input: GetSubnetStakeFlowInputSchema,
    output: GetSubnetStakeFlowOutputSchema,
  },
  get_subnet_event_summary: {
    input: GetSubnetEventSummaryInputSchema,
    output: GetSubnetEventSummaryOutputSchema,
  },
  get_subnet_weights: {
    input: GetSubnetWeightsInputSchema,
    output: GetSubnetWeightsOutputSchema,
  },
  get_subnet_weight_setters: {
    input: GetSubnetWeightSettersInputSchema,
    output: GetSubnetWeightSettersOutputSchema,
  },
  get_subnet_registrations: {
    input: GetSubnetRegistrationsMcpInputSchema,
    output: GetSubnetRegistrationsMcpOutputSchema,
  },
  get_subnet_stake_moves: {
    input: GetSubnetStakeMovesInputSchema,
    output: GetSubnetStakeMovesOutputSchema,
  },
  get_subnet_stake_transfers: {
    input: GetSubnetStakeTransfersInputSchema,
    output: GetSubnetStakeTransfersOutputSchema,
  },
  get_subnet_axon_removals: {
    input: GetSubnetAxonRemovalsMcpInputSchema,
    output: GetSubnetAxonRemovalsMcpOutputSchema,
  },
  get_subnet_serving: {
    input: GetSubnetServingMcpInputSchema,
    output: GetSubnetServingMcpOutputSchema,
  },
  get_subnet_prometheus: {
    input: GetSubnetPrometheusInputSchema,
    output: GetSubnetPrometheusOutputSchema,
  },
  get_subnet_deregistrations: {
    input: GetSubnetDeregistrationsMcpInputSchema,
    output: GetSubnetDeregistrationsMcpOutputSchema,
  },
  get_subnet_performance_history: {
    input: GetSubnetPerformanceHistoryInputSchema,
    output: GetSubnetPerformanceHistoryOutputSchema,
  },
  get_economics_trends: {
    input: GetEconomicsTrendsInputSchema,
    output: GetEconomicsTrendsOutputSchema,
  },
  get_registry_leaderboards: {
    input: GetRegistryLeaderboardsInputSchema,
    output: GetRegistryLeaderboardsOutputSchema,
  },
  get_domain_summary: {
    input: GetDomainSummaryInputSchema,
    output: GetDomainSummaryOutputSchema,
  },
  list_profiles: {
    input: ListProfilesInputSchema,
    output: ListProfilesOutputSchema,
  },
  get_subnet_profile: {
    input: GetSubnetProfileInputSchema,
    output: GetSubnetProfileOutputSchema,
  },
  compare_subnets: {
    input: CompareSubnetsInputSchema,
    output: CompareSubnetsOutputSchema,
  },
  get_subnet_metagraph: {
    input: GetSubnetMetagraphInputSchema,
    output: GetSubnetMetagraphOutputSchema,
  },
  get_subnet_history: {
    input: GetSubnetHistoryInputSchema,
    output: GetSubnetHistoryOutputSchema,
  },
  get_subnet_identity_history: {
    input: GetSubnetIdentityHistoryInputSchema,
    output: GetSubnetIdentityHistoryOutputSchema,
  },
  get_subnet_events: {
    input: GetSubnetEventsInputSchema,
    output: GetSubnetEventsOutputSchema,
  },
  get_subnet_hyperparams: {
    input: GetSubnetHyperparamsInputSchema,
    output: GetSubnetHyperparamsOutputSchema,
  },
  get_subnet_hyperparams_history: {
    input: GetSubnetHyperparamsHistoryInputSchema,
    output: GetSubnetHyperparamsHistoryOutputSchema,
  },
  get_subnet_volume: {
    input: GetSubnetVolumeInputSchema,
    output: GetSubnetVolumeOutputSchema,
  },
  get_subnet_ohlc: {
    input: GetSubnetOhlcInputSchema,
    output: GetSubnetOhlcOutputSchema,
  },
  get_subnet_ownership_history: {
    input: GetSubnetOwnershipHistoryInputSchema,
    output: GetSubnetOwnershipHistoryOutputSchema,
  },
  get_subnet_conviction: {
    input: GetSubnetConvictionInputSchema,
    output: GetSubnetConvictionOutputSchema,
  },
  get_subnet_recycled: {
    input: GetSubnetRecycledInputSchema,
    output: GetSubnetRecycledOutputSchema,
  },
  get_subnet_burn: {
    input: GetSubnetBurnInputSchema,
    output: GetSubnetBurnOutputSchema,
  },
  get_subnet_lease: {
    input: GetSubnetLeaseInputSchema,
    output: GetSubnetLeaseOutputSchema,
  },
  get_subnet_lease_history: {
    input: GetSubnetLeaseHistoryInputSchema,
    output: GetSubnetLeaseHistoryOutputSchema,
  },
  get_global_incidents: {
    input: GetGlobalIncidentsInputSchema,
    output: GetGlobalIncidentsOutputSchema,
  },
  list_subnet_validators: {
    input: ListSubnetValidatorsInputSchema,
    output: ListSubnetValidatorsOutputSchema,
  },
  list_global_validators: {
    input: ListGlobalValidatorsInputSchema,
    output: ListGlobalValidatorsOutputSchema,
  },
  get_validator_detail: {
    input: GetValidatorDetailInputSchema,
    output: GetValidatorDetailOutputSchema,
  },
  compare_validators: {
    input: CompareValidatorsInputSchema,
    output: CompareValidatorsOutputSchema,
  },
  get_webhook_subscription: {
    input: GetWebhookSubscriptionInputSchema,
    output: GetWebhookSubscriptionOutputSchema,
  },
  get_alert_trigger: {
    input: GetAlertTriggerInputSchema,
    output: GetAlertTriggerOutputSchema,
  },
  get_validator_nominators: {
    input: GetValidatorNominatorsInputSchema,
    output: GetValidatorNominatorsOutputSchema,
  },
  get_validator_history: {
    input: GetValidatorHistoryInputSchema,
    output: GetValidatorHistoryOutputSchema,
  },
  get_neuron: {
    input: GetNeuronInputSchema,
    output: GetNeuronOutputSchema,
  },
  get_neuron_history: {
    input: GetNeuronHistoryInputSchema,
    output: GetNeuronHistoryOutputSchema,
  },
  get_account: {
    input: GetAccountInputSchema,
    output: GetAccountOutputSchema,
  },
  get_account_entities: {
    input: GetAccountEntitiesInputSchema,
    output: GetAccountEntitiesOutputSchema,
  },
  get_account_balance: {
    input: GetAccountBalanceInputSchema,
    output: GetAccountBalanceOutputSchema,
  },
  get_account_root_claim: {
    input: GetAccountRootClaimInputSchema,
    output: GetAccountRootClaimOutputSchema,
  },
  get_account_children: {
    input: GetAccountChildrenInputSchema,
    output: GetAccountChildrenOutputSchema,
  },
  get_account_parents: {
    input: GetAccountParentsInputSchema,
    output: GetAccountParentsOutputSchema,
  },
  get_account_events: {
    input: GetAccountEventsInputSchema,
    output: GetAccountEventsOutputSchema,
  },
  get_account_subnets: {
    input: GetAccountSubnetsInputSchema,
    output: GetAccountSubnetsOutputSchema,
  },
  get_account_portfolio: {
    input: GetAccountPortfolioInputSchema,
    output: GetAccountPortfolioOutputSchema,
  },
  get_account_positions: {
    input: GetAccountPositionsInputSchema,
    output: GetAccountPositionsOutputSchema,
  },
  get_account_snapshot: {
    input: GetAccountSnapshotInputSchema,
    output: GetAccountSnapshotOutputSchema,
  },
  get_account_identity: {
    input: GetAccountIdentityInputSchema,
    output: GetAccountIdentityOutputSchema,
  },
  get_account_identity_history: {
    input: GetAccountIdentityHistoryInputSchema,
    output: GetAccountIdentityHistoryOutputSchema,
  },
  get_account_position_history: {
    input: GetAccountPositionHistoryInputSchema,
    output: GetAccountPositionHistoryOutputSchema,
  },
  get_account_stake_flow: {
    input: GetAccountStakeFlowInputSchema,
    output: GetAccountStakeFlowOutputSchema,
  },
  get_account_stake_moves: {
    input: GetAccountStakeMovesInputSchema,
    output: GetAccountStakeMovesOutputSchema,
  },
  get_account_axon_removals: {
    input: GetAccountAxonRemovalsInputSchema,
    output: GetAccountAxonRemovalsOutputSchema,
  },
  get_account_prometheus: {
    input: GetAccountPrometheusInputSchema,
    output: GetAccountPrometheusOutputSchema,
  },
  get_account_registrations: {
    input: GetAccountRegistrationsInputSchema,
    output: GetAccountRegistrationsOutputSchema,
  },
  get_account_weight_setters: {
    input: GetAccountWeightSettersInputSchema,
    output: GetAccountWeightSettersOutputSchema,
  },
  get_account_serving: {
    input: GetAccountServingInputSchema,
    output: GetAccountServingOutputSchema,
  },
  get_account_deregistrations: {
    input: GetAccountDeregistrationsInputSchema,
    output: GetAccountDeregistrationsOutputSchema,
  },
  get_account_history: {
    input: GetAccountHistoryInputSchema,
    output: GetAccountHistoryOutputSchema,
  },
  get_account_extrinsics: {
    input: GetAccountExtrinsicsInputSchema,
    output: GetAccountExtrinsicsOutputSchema,
  },
  get_account_transfers: {
    input: GetAccountTransfersInputSchema,
    output: GetAccountTransfersOutputSchema,
  },
  get_account_counterparties: {
    input: GetAccountCounterpartiesInputSchema,
    output: GetAccountCounterpartiesOutputSchema,
  },
  list_accounts: {
    input: ListAccountsInputSchema,
    output: ListAccountsOutputSchema,
  },
  get_top_holders: {
    input: GetTopHoldersInputSchema,
    output: GetTopHoldersOutputSchema,
  },
  decode_evm_call: {
    input: DecodeEvmCallInputSchema,
    output: DecodeEvmCallOutputSchema,
  },
  get_evm_address_mapping: {
    input: GetEvmAddressMappingInputSchema,
    output: GetEvmAddressMappingOutputSchema,
  },
  list_blocks: {
    input: ListBlocksInputSchema,
    output: ListBlocksOutputSchema,
  },
  get_block: {
    input: GetBlockInputSchema,
    output: GetBlockOutputSchema,
  },
  list_block_extrinsics: {
    input: ListBlockExtrinsicsInputSchema,
    output: ListBlockExtrinsicsOutputSchema,
  },
  get_block_events: {
    input: GetBlockEventsInputSchema,
    output: GetBlockEventsOutputSchema,
  },
  list_extrinsics: {
    input: ListExtrinsicsInputSchema,
    output: ListExtrinsicsOutputSchema,
  },
  get_extrinsic: {
    input: GetExtrinsicInputSchema,
    output: GetExtrinsicOutputSchema,
  },
  get_sudo: {
    input: GetSudoInputSchema,
    output: GetSudoOutputSchema,
  },
  get_sudo_key: {
    input: GetSudoKeyInputSchema,
    output: GetSudoKeyOutputSchema,
  },
  get_network_parameters: {
    input: GetNetworkParametersInputSchema,
    output: GetNetworkParametersOutputSchema,
  },
  get_randomness_status: {
    input: GetRandomnessStatusInputSchema,
    output: GetRandomnessStatusOutputSchema,
  },
  get_governance_config_changes: {
    input: GetGovernanceConfigChangesInputSchema,
    output: GetGovernanceConfigChangesOutputSchema,
  },
  get_runtime: {
    input: GetRuntimeInputSchema,
    output: GetRuntimeOutputSchema,
  },
  get_block_chain_events: {
    input: GetBlockChainEventsInputSchema,
    output: GetBlockChainEventsOutputSchema,
  },
  get_extrinsic_chain_events: {
    input: GetExtrinsicChainEventsInputSchema,
    output: GetExtrinsicChainEventsOutputSchema,
  },
  get_chain_concentration: {
    input: GetChainConcentrationInputSchema,
    output: GetChainConcentrationOutputSchema,
  },
  get_chain_performance: {
    input: GetChainPerformanceInputSchema,
    output: GetChainPerformanceOutputSchema,
  },
  get_chain_idle_stake: {
    input: GetChainIdleStakeInputSchema,
    output: GetChainIdleStakeOutputSchema,
  },
  get_chain_identity_history: {
    input: GetChainIdentityHistoryInputSchema,
    output: GetChainIdentityHistoryOutputSchema,
  },
  get_chain_yield: {
    input: GetChainYieldInputSchema,
    output: GetChainYieldOutputSchema,
  },
  get_chain_turnover: {
    input: GetChainTurnoverInputSchema,
    output: GetChainTurnoverOutputSchema,
  },
  get_chain_stake_flow: {
    input: GetChainStakeFlowInputSchema,
    output: GetChainStakeFlowOutputSchema,
  },
  get_chain_alpha_volume: {
    input: GetChainAlphaVolumeInputSchema,
    output: GetChainAlphaVolumeOutputSchema,
  },
  get_chain_weights: {
    input: GetChainWeightsInputSchema,
    output: GetChainWeightsOutputSchema,
  },
  get_chain_weight_setters: {
    input: GetChainWeightSettersInputSchema,
    output: GetChainWeightSettersOutputSchema,
  },
  get_chain_stake_moves: {
    input: GetChainStakeMovesInputSchema,
    output: GetChainStakeMovesOutputSchema,
  },
  get_chain_stake_transfers: {
    input: GetChainStakeTransfersInputSchema,
    output: GetChainStakeTransfersOutputSchema,
  },
  get_chain_axon_removals: {
    input: GetChainAxonRemovalsInputSchema,
    output: GetChainAxonRemovalsOutputSchema,
  },
  get_chain_serving: {
    input: GetChainServingInputSchema,
    output: GetChainServingOutputSchema,
  },
  get_chain_prometheus: {
    input: GetChainPrometheusInputSchema,
    output: GetChainPrometheusOutputSchema,
  },
  get_chain_activity: {
    input: GetChainActivityInputSchema,
    output: GetChainActivityOutputSchema,
  },
  list_chain_events: {
    input: ListChainEventsInputSchema,
    output: ListChainEventsOutputSchema,
  },
  get_chain_calls: {
    input: GetChainCallsInputSchema,
    output: GetChainCallsOutputSchema,
  },
  get_chain_signers: {
    input: GetChainSignersInputSchema,
    output: GetChainSignersOutputSchema,
  },
  get_chain_fees: {
    input: GetChainFeesInputSchema,
    output: GetChainFeesOutputSchema,
  },
  get_chain_registrations: {
    input: GetChainRegistrationsInputSchema,
    output: GetChainRegistrationsOutputSchema,
  },
  get_chain_deregistrations: {
    input: GetChainDeregistrationsInputSchema,
    output: GetChainDeregistrationsOutputSchema,
  },
  get_chain_transfers: {
    input: GetChainTransfersInputSchema,
    output: GetChainTransfersOutputSchema,
  },
  get_chain_transfer_pairs: {
    input: GetChainTransferPairsInputSchema,
    output: GetChainTransferPairsOutputSchema,
  },
  get_network_activity: {
    input: GetNetworkActivityInputSchema,
    output: GetNetworkActivityOutputSchema,
  },
  list_subnet_apis: {
    input: ListSubnetApisInputSchema,
    output: ListSubnetApisOutputSchema,
  },
  get_api_schema: {
    input: GetApiSchemaInputSchema,
    output: GetApiSchemaOutputSchema,
  },
  get_fixture: {
    input: GetFixtureInputSchema,
    output: GetFixtureOutputSchema,
  },
  get_provider_detail: {
    input: GetProviderDetailInputSchema,
    output: GetProviderDetailOutputSchema,
  },
  list_providers: {
    input: ListProvidersInputSchema,
    output: ListProvidersOutputSchema,
  },
  list_surfaces: {
    input: ListSurfacesInputSchema,
    output: ListSurfacesOutputSchema,
  },
  list_candidates: {
    input: ListCandidatesInputSchema,
    output: ListCandidatesOutputSchema,
  },
  list_endpoints: {
    input: ListEndpointsInputSchema,
    output: ListEndpointsOutputSchema,
  },
  list_evidence: {
    input: ListEvidenceInputSchema,
    output: ListEvidenceOutputSchema,
  },
  list_rpc_endpoints: {
    input: ListRpcEndpointsInputSchema,
    output: ListRpcEndpointsOutputSchema,
  },
  list_source_snapshots: {
    input: ListSourceSnapshotsInputSchema,
    output: ListSourceSnapshotsOutputSchema,
  },
  list_profile_completeness: {
    input: ListProfileCompletenessInputSchema,
    output: ListProfileCompletenessOutputSchema,
  },
  list_rpc_pools: {
    input: ListRpcPoolsInputSchema,
    output: ListRpcPoolsOutputSchema,
  },
  get_subnet_endpoints: {
    input: GetSubnetEndpointsInputSchema,
    output: GetSubnetEndpointsOutputSchema,
  },
  list_subnet_endpoints: {
    input: ListSubnetEndpointsInputSchema,
    output: ListSubnetEndpointsOutputSchema,
  },
  list_subnet_surfaces: {
    input: ListSubnetSurfacesInputSchema,
    output: ListSubnetSurfacesOutputSchema,
  },
  list_subnet_health: {
    input: ListSubnetHealthInputSchema,
    output: ListSubnetHealthOutputSchema,
  },
  get_subnet_candidates: {
    input: GetSubnetCandidatesInputSchema,
    output: GetSubnetCandidatesOutputSchema,
  },
  list_subnet_candidates: {
    input: ListSubnetCandidatesInputSchema,
    output: ListSubnetCandidatesOutputSchema,
  },
  get_subnet_evidence: {
    input: GetSubnetEvidenceInputSchema,
    output: GetSubnetEvidenceOutputSchema,
  },
  list_subnet_evidence: {
    input: ListSubnetEvidenceInputSchema,
    output: ListSubnetEvidenceOutputSchema,
  },
  get_subnet_surfaces: {
    input: GetSubnetSurfacesInputSchema,
    output: GetSubnetSurfacesOutputSchema,
  },
  list_fixtures: {
    input: ListFixturesInputSchema,
    output: ListFixturesOutputSchema,
  },
  list_schemas: {
    input: ListSchemasInputSchema,
    output: ListSchemasOutputSchema,
  },
  list_search_index: {
    input: ListSearchIndexInputSchema,
    output: ListSearchIndexOutputSchema,
  },
  list_search: {
    input: ListSearchInputSchema,
    output: ListSearchOutputSchema,
  },
  list_curation: {
    input: ListCurationInputSchema,
    output: ListCurationOutputSchema,
  },
  list_gaps: {
    input: ListGapsInputSchema,
    output: ListGapsOutputSchema,
  },
  list_enrichment_queue: {
    input: ListEnrichmentQueueInputSchema,
    output: ListEnrichmentQueueOutputSchema,
  },
  list_adapter_candidates: {
    input: ListAdapterCandidatesInputSchema,
    output: ListAdapterCandidatesOutputSchema,
  },
  list_enrichment_evidence: {
    input: ListEnrichmentEvidenceInputSchema,
    output: ListEnrichmentEvidenceOutputSchema,
  },
  list_review_gaps: {
    input: ListReviewGapsInputSchema,
    output: ListReviewGapsOutputSchema,
  },
  list_review_enrichment_targets: {
    input: ListReviewEnrichmentTargetsInputSchema,
    output: ListReviewEnrichmentTargetsOutputSchema,
  },
  list_endpoint_pools: {
    input: ListEndpointPoolsInputSchema,
    output: ListEndpointPoolsOutputSchema,
  },
  list_endpoint_incidents: {
    input: ListEndpointIncidentsInputSchema,
    output: ListEndpointIncidentsOutputSchema,
  },
  list_provider_endpoints: {
    input: ListProviderEndpointsInputSchema,
    output: ListProviderEndpointsOutputSchema,
  },
  get_lineage: {
    input: GetLineageInputSchema,
    output: GetLineageOutputSchema,
  },
  get_freshness: {
    input: GetFreshnessInputSchema,
    output: GetFreshnessOutputSchema,
  },
  get_contracts: {
    input: GetContractsInputSchema,
    output: GetContractsOutputSchema,
  },
  get_source_health: {
    input: GetSourceHealthInputSchema,
    output: GetSourceHealthOutputSchema,
  },
  get_changelog: {
    input: GetChangelogInputSchema,
    output: GetChangelogOutputSchema,
  },
  get_feed: {
    input: GetFeedInputSchema,
    output: GetFeedOutputSchema,
  },
  get_build: {
    input: GetBuildInputSchema,
    output: GetBuildOutputSchema,
  },
  get_adapter: {
    input: GetAdapterInputSchema,
    output: GetAdapterOutputSchema,
  },
  get_agent_catalog: {
    input: GetAgentCatalogInputSchema,
    output: GetAgentCatalogOutputSchema,
  },
  get_agent_resources: {
    input: GetAgentResourcesInputSchema,
    output: GetAgentResourcesOutputSchema,
  },
  get_rpc_usage: {
    input: GetRpcUsageInputSchema,
    output: GetRpcUsageOutputSchema,
  },
  get_best_rpc_endpoint: {
    input: GetBestRpcEndpointInputSchema,
    output: GetBestRpcEndpointOutputSchema,
  },
  call_rpc: {
    input: CallRpcInputSchema,
    output: CallRpcOutputSchema,
  },
  query_graphql: {
    input: QueryGraphqlInputSchema,
    output: QueryGraphqlOutputSchema,
  },
  registry_summary: {
    input: RegistrySummaryInputSchema,
    output: RegistrySummaryOutputSchema,
  },
  get_coverage: {
    input: GetCoverageInputSchema,
    output: GetCoverageOutputSchema,
  },
  get_coverage_depth: {
    input: GetCoverageDepthInputSchema,
    output: GetCoverageDepthOutputSchema,
  },
  list_enrichment_targets: {
    input: ListEnrichmentTargetsInputSchema,
    output: ListEnrichmentTargetsOutputSchema,
  },
  get_subnet_gaps: {
    input: GetSubnetGapsInputSchema,
    output: GetSubnetGapsOutputSchema,
  },
  list_subnet_gaps: {
    input: ListSubnetGapsInputSchema,
    output: ListSubnetGapsOutputSchema,
  },
  run_saved_query: {
    input: RunSavedQueryInputSchema,
    output: RunSavedQueryOutputSchema,
  },
  find_subnet_opportunities: {
    input: FindSubnetOpportunitiesInputSchema,
    output: FindSubnetOpportunitiesOutputSchema,
  },
  semantic_search: {
    input: SemanticSearchInputSchema,
    output: SemanticSearchOutputSchema,
  },
  ask: {
    input: AskInputSchema,
    output: AskOutputSchema,
  },
  find_subnet_for_task: {
    input: FindSubnetForTaskInputSchema,
    output: FindSubnetForTaskOutputSchema,
  },
  how_do_i_call: {
    input: HowDoICallInputSchema,
    output: HowDoICallOutputSchema,
  },
  verify_integration: {
    input: VerifyIntegrationInputSchema,
    output: VerifyIntegrationOutputSchema,
  },
  call_subnet_surface: {
    input: CallSubnetSurfaceInputSchema,
    output: CallSubnetSurfaceOutputSchema,
  },
};

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;

// Known, verified, DELIBERATE tightenings -- excluded from normalization so
// the diff surfaces them (as intended), and documented instead of silently
// erased. Keyed `${tool}.output.${dotted.property.path}`.
//
// get_subnet_stake_quote.output reuses SubnetStakeQuoteArtifactSchema
// wholesale (schemas-src/routes/stake-quote.ts) rather than re-declaring the
// shape -- the deliberate, documented full-fidelity-mirror case (see
// get-subnet-stake-quote.ts's header). That REST schema carries 5 numeric
// lower bounds (amount>0, matching the input side's own constraint;
// effective_price_tao/expected_out/price_impact_pct/spot_price_tao/netuid
// >= 0, real mathematical invariants of computeStakeQuote()'s output) the
// original
// bare MCP output schema never declared. None can ever reject a REAL
// response (computeStakeQuote() cannot produce a value outside these
// bounds) -- verified, not assumed.
// query_graphql.output.data's hand-written original declares `nullable:
// true` -- an OpenAPI-3.0-ism with NO effect under JSON Schema draft
// 2020-12 (which has no `nullable` keyword at all), so under the target
// spec's own semantics `data` was already (inertly) a plain non-nullable
// object. The Zod conversion (batch 12, #8075) declares `data` as a plain
// non-nullable object to match that literal 2020-12 reading, rather than
// translating the inert marker into a real `.nullable()` -- doing so would
// make the NEW schema accept something the OLD one's actual declared
// semantics didn't, the wrong direction for this epic's wire-compatibility
// mandate. Stripping the dead `nullable` key here just lets both sides
// compare as the equivalent-under-2020-12 objects they already are.
const ACCEPTED_TIGHTENINGS = new Set([
  "get_subnet_stake_quote.output.amount",
  "get_subnet_stake_quote.output.effective_price_tao",
  "get_subnet_stake_quote.output.expected_out",
  "get_subnet_stake_quote.output.price_impact_pct",
  "get_subnet_stake_quote.output.spot_price_tao",
  "get_subnet_stake_quote.output.netuid",
  "query_graphql.output.data",
]);

function normalize(node: unknown, path: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => normalize(item, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Row;

  // `type: [X, Y, ...]` (hand-written, one schema node, N-way union of bare
  // types), possibly with sibling constraint keys that apply ONLY to the
  // non-null branch (e.g. batch 4's get_subnet_lease.lease:
  // {type:["object","null"], properties:{...9 fields...}}) vs Zod's
  // `anyOf: [{type:X, ...siblings}, {type:Y}, ...]`. Earlier batches never
  // exercised the sibling case (their type:[X,Y] nodes were always bare,
  // e.g. NULLABLE_STRING) so this rewrite used to drop siblings outright;
  // batch 4 needs them carried into the first (non-null) branch, mirroring
  // scripts/diff-openapi-zod-components.ts's equivalent rule.
  if (Array.isArray(obj.type) && obj.type.length > 1) {
    const { type: _t, ...siblings } = obj;
    // A hand-written `enum:[...values, null]` sibling on a `type:[X,"null"]`
    // node (e.g. batch 9's get_chain_transfers.window: `{type:["string",
    // "null"], enum:[...CHAIN_TRANSFER_WINDOW_KEYS, null]}`) carries a
    // redundant literal `null` into the non-null branch once split -- the
    // null case is already the separate `{type:"null"}` branch below, and
    // Zod's own `z.enum(...).nullable()` output never repeats it there.
    // Strip it so both sides produce the same anyOf shape.
    if (Array.isArray(siblings.enum) && obj.type.includes("null")) {
      siblings.enum = siblings.enum.filter((v: unknown) => v !== null);
    }
    return normalize(
      {
        anyOf: obj.type.map((t, i) =>
          i === 0 ? { type: t, ...siblings } : { type: t },
        ),
      },
      path,
    );
  }

  const out: Row = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "description") continue; // issue-sanctioned cosmetic (#7863's own wording)

    // `propertyNames: {type:"string"}` (Zod's z.record(z.string(), ...)
    // always emits this alongside `additionalProperties`) is a no-op
    // constraint under JSON Schema -- every object key IS already a string
    // by the JSON spec itself, so this never rejects anything
    // additionalProperties wouldn't already reject on its own. Drop it, the
    // same treatment $schema/$id get above (batch 12, #8076's
    // find_subnet_opportunities.output.boards and
    // call_subnet_surface.input.query, the epic's first z.record() uses).
    if (
      key === "propertyNames" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Row).length === 1 &&
      (value as Row).type === "string"
    ) {
      continue;
    }

    // `oneOf` (hand-written, e.g. batch 9's list_rpc_endpoints fields/cursor
    // params: string-or-array, integer-or-string) vs Zod's `anyOf` for the
    // equivalent z.union([...]). For branches of distinct JSON Schema
    // `type`s, the two keywords accept exactly the same values here -- a
    // value can never simultaneously match two different-`type` branches --
    // so treat the keyword itself as cosmetic rather than a real difference.
    if (key === "oneOf") {
      out.anyOf = normalize(value, `${path}.anyOf`);
      continue;
    }

    if (
      ACCEPTED_TIGHTENINGS.has(path) &&
      (key === "exclusiveMinimum" || key === "minimum" || key === "nullable")
    ) {
      continue;
    }

    // `required: []` (hand-written, e.g. list_blocks/list_extrinsics's
    // explicit empty array) and omitting `required` entirely (Zod's
    // z.toJSONSchema output when nothing is required, e.g. get_sudo/
    // list_accounts's hand-written originals which never declared the key
    // either) both mean "nothing required" -- the SAME as the
    // additionalProperties/items normalizations above. Drop the key outright
    // rather than keeping an empty array on one side only (batch 8, #8071).
    if (key === "required" && Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = [...(value as string[])].sort();
      continue;
    }

    if (
      (key === "maximum" && value === MAX_SAFE_INT) ||
      (key === "minimum" && value === -MAX_SAFE_INT)
    ) {
      continue;
    }

    // additionalProperties: {} (Zod's .passthrough()) and
    // additionalProperties: true (hand-written) both mean "unrestricted" --
    // the SAME as omitting the key entirely (JSON Schema's own default).
    // Drop it outright rather than coercing to `true`, so a bare
    // `{type:"object"}` (hand-written, no properties/additionalProperties
    // at all) compares equal to Zod's `{type:"object", properties:{},
    // additionalProperties:{}}` for the same empty-passthrough-object case.
    if (
      key === "additionalProperties" &&
      (value === true ||
        (value && typeof value === "object" && Object.keys(value).length === 0))
    ) {
      continue;
    }

    // `items: {}` (Zod's z.array(z.unknown())) means "any item type" -- the
    // same as omitting `items` entirely (hand-written `{type:"array"}` with
    // no items constraint, e.g. get_subnet's gap_priorities).
    if (
      key === "items" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    if (
      key === "properties" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    out[key] = normalize(value, key === "properties" ? path : `${path}.${key}`);
  }

  if (Array.isArray(out.anyOf)) {
    // Flatten a nested `anyOf: [{anyOf: [...]}, ...]` -- Zod's
    // `z.union([A, B, ...]).nullable()` always produces this nested shape
    // (the union's own anyOf, wrapped in an outer anyOf with the null
    // branch), where the hand-written original instead declares one flat
    // N-way `type: [...]` array (already rewritten to a single flat anyOf by
    // the type-split rule above, e.g. batch 9's schema_version:
    // {type:["string","integer","null"]} vs
    // z.union([z.string(), z.int()]).nullable()). OR distributes over OR, so
    // a nested and a flattened anyOf accept exactly the same values --
    // splice a branch's own sub-list into the parent when that branch is
    // NOTHING but an anyOf (no other sibling keys that would make inlining
    // lossy), batch 9, #8073.
    const flattened = (out.anyOf as unknown[]).flatMap((branch) =>
      branch &&
      typeof branch === "object" &&
      !Array.isArray(branch) &&
      Object.keys(branch as Row).length === 1 &&
      Array.isArray((branch as Row).anyOf)
        ? ((branch as Row).anyOf as unknown[])
        : [branch],
    );
    out.anyOf = flattened;
    if (flattened.length === 1) {
      Object.assign(out, flattened[0]);
      delete out.anyOf;
    }
  }

  return sortKeys(out);
}

function sortKeys(obj: Row): Row {
  const sorted: Row = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

let diffCount = 0;
for (const [name, { input: oldInput, output: oldOutput }] of Object.entries(
  OLD_SCHEMAS,
)) {
  const { input: newInputSchema, output: newOutputSchema } = NEW_SCHEMAS[name];
  for (const [kind, oldSchema, newSchema] of [
    ["input", oldInput, newInputSchema] as const,
    ["output", oldOutput, newOutputSchema] as const,
  ]) {
    const generated = z.toJSONSchema(newSchema, { target: "draft-2020-12" });
    const path = `${name}.${kind}`;
    const normalizedOld = JSON.stringify(
      sortKeys(normalize(oldSchema, path) as Row),
    );
    const normalizedNew = JSON.stringify(
      sortKeys(normalize(generated, path) as Row),
    );
    if (normalizedOld === normalizedNew) {
      console.log(`${path}: PASS`);
    } else {
      diffCount++;
      console.log(`${path}: DIFF`);
      console.log("  old (normalized):", normalizedOld);
      console.log("  new (normalized):", normalizedNew);
    }
  }
}

console.log(
  `\n${Object.keys(OLD_SCHEMAS).length * 2 - diffCount}/${Object.keys(OLD_SCHEMAS).length * 2} schemas PASS; ${diffCount} DIFF.`,
);
if (diffCount > 0) process.exit(1);
