// Component-name registry for the OpenAPI generator (types-epic B, #7860).
//
// Each entry here becomes a NAMED entry in public/metagraph/openapi.json's
// components.schemas, at the id given -- these ids are load-bearing: they
// must match the names schemaRefForArtifactPath() and the hand-edited
// schemas/components/*.schema.json files already use, or downstream
// consumers (src/contracts.ts's route wiring, packages/client's generated
// types, other still-hand-edited components that $ref these by name) break.
//
// What's registered, and why:
//   - The 5 pilot routes' top-level artifact schemas (subnets/A#7859) --
//     required: schemaRefForArtifactPath binds each API route to exactly
//     this name.
//   - SubnetIndexEntry -- required: scripts/generate-client.ts hard-codes
//     `components["schemas"]["SubnetIndexEntry"]`; if z.toJSONSchema()
//     inlined it (the default with no registration), that named component
//     would disappear and the client SDK's generated types would fail to
//     compile.
//   - Surface / CandidateSurface / EndpointResource / Gaps /
//     CurationMetadata / PartnershipMetadata / HealthSubnetSummary -- these
//     are sub-shapes of the subnet-detail/health pilot responses that
//     schemas-src/routes/subnet-detail.ts and health.ts ALREADY modeled in
//     full (their own header comments: "no field was left as z.unknown()").
//     They're also referenced BY NAME from several other, still-hand-edited
//     components (SubnetProfileArtifact, SurfacesArtifact, CandidatesArtifact,
//     VerificationArtifact, EndpointsArtifact, HealthSubnetArtifact, etc.).
//     Registering them under their existing component names means those
//     untouched routes keep resolving to a real, validated schema (upgraded
//     for free) instead of either duplicating the shape inline or leaving a
//     dangling $ref. This is why the issue's "5 pilot routes" scope expands
//     to this specific set of names, not further.
//   - SurfaceKind / Authority / Classification / BittensorNetwork /
//     HealthStatus / EndpointLayer / ProbeConfig / EndpointMonitoringPolicy /
//     EndpointScoreReason / VerificationResult / SourceTier / CurationLevel /
//     ReviewState -- enum and sub-object leaves used BY the pilot shapes
//     above. Registering them is REQUIRED, not optional: z.toJSONSchema()
//     with reused:"inline" only keeps a schema as its own named component
//     when it's a separately registered root; leaving these unregistered
//     silently inlined them everywhere they're used and deleted their
//     standalone `components.schemas.*` entries from the public contract --
//     a real regression caught in PR #8054 review (anyone importing
//     `components["schemas"]["SurfaceKind"]` etc. from the generated client
//     types would have lost that export). Registering them restores the
//     named refs exactly as the hand-edited schemas had them.
//
// Deliberately NOT registered (left to inline where used, verified safe by
// the types-epic B research pass): SubnetEconomics -- referenced only by the
// two now-replaced components (EconomicsArtifact, SubnetDetailArtifact), so
// inlining it into both costs nothing but a little document size, and it was
// the SAME safe-to-drop component recommended for deletion at the JSON layer.
// This is the ONLY intentionally-dropped component name in this file; every
// other component the hand-edited schemas named standalone is registered
// above, name for name.
import { z } from "zod";
import {
  BittensorNetworkSchema,
  ConcentrationMetricsSchema,
  CurationLevelSchema,
  HealthStatusSchema,
  PartnershipMetadataSchema,
  ScoreDistributionSchema,
} from "./shared.ts";
import { CountMapSchema } from "./envelope.ts";
import {
  SubnetsArtifactSchema,
  SubnetIndexEntrySchema,
} from "./routes/subnets.ts";
import {
  SubnetDetailArtifactSchema,
  SubnetDetailSchema,
  SurfaceSchema,
  CandidateSurfaceSchema,
  EndpointResourceSchema,
  GapsSchema,
  CurationMetadataSchema,
  SurfaceKindSchema,
  SourceTierSchema,
  ClassificationSchema,
  AuthoritySchema,
  EndpointLayerSchema,
  ProbeConfigSchema,
  EndpointMonitoringPolicySchema,
  EndpointScoreReasonSchema,
  VerificationResultSchema,
  ReviewStateSchema,
} from "./routes/subnet-detail.ts";
import { EconomicsArtifactSchema } from "./routes/economics.ts";
import {
  HealthSummaryArtifactSchema,
  HealthSubnetSummarySchema,
} from "./routes/health.ts";
import { SubnetStakeQuoteArtifactSchema } from "./routes/stake-quote.ts";
import {
  SubnetValidatorEconomicsArtifactSchema,
  ValidatorSetCompositionSchema,
  ValidatorPermitModelAgreementSchema,
  ValidatorTakeDistributionSchema,
  ValidatorEconomicsExclusionSchema,
  ValidatorEconomicsRankingArtifactSchema,
  ValidatorEconomicsHistoryPointSchema,
  SubnetValidatorEconomicsHistoryArtifactSchema,
} from "./routes/validator-economics.ts";
import { SubnetAlphaVolumeArtifactSchema } from "./routes/subnet-alpha-volume.ts";
import {
  SubnetAxonRemovalsArtifactSchema,
  SubnetDeregistrationsArtifactSchema,
  SubnetRegistrationsArtifactSchema,
  SubnetServingArtifactSchema,
} from "./routes/subnet-activity.ts";
import {
  SubnetBurnArtifactSchema,
  ChainBurnArtifactSchema,
  SubnetBurnHistoryArtifactSchema,
  SubnetBurnHistoryPointSchema,
  ChainBurnEntrySchema,
  SubnetRecycledArtifactSchema,
} from "./routes/subnet-registration-cost.ts";
import {
  SubnetHolderSchema,
  SubnetHoldersConcentrationSchema,
  SubnetHoldersDegradedSchema,
  SubnetHoldersArtifactSchema,
} from "./routes/subnet-holders.ts";
import {
  ChainHoldersSubnetSchema,
  ChainHoldersNetworkSchema,
  ChainHoldersArtifactSchema,
} from "./routes/chain-holders.ts";
import {
  EmissionParamChangeSchema,
  EmissionSubnetChangeSchema,
  EmissionFlowChangeSchema,
  EmissionGateChangesArtifactSchema,
} from "./routes/emission-gate-changes.ts";
import {
  FailureReasonSchema,
  FailureReasonsDaySchema,
  FailureReasonsArtifactSchema,
} from "./routes/failure-reasons.ts";
import {
  TaoUsdPointSchema,
  TaoUsdLatestSchema,
  TaoUsdArtifactSchema,
} from "./routes/tao-usd.ts";
import {
  SurfaceHistoryChangeSchema,
  SubnetSurfaceHistoryArtifactSchema,
} from "./routes/subnet-surface-history.ts";
import {
  AccountEventSchema,
  SubnetEventsArtifactSchema,
} from "./routes/subnet-events.ts";
import { SubnetEventSummaryArtifactSchema } from "./routes/subnet-event-summary.ts";
import { SubnetHistoryArtifactSchema } from "./routes/subnet-history.ts";
import { SubnetIdentityHistoryArtifactSchema } from "./routes/subnet-identity-history.ts";
import { SubnetIdleStakeArtifactSchema } from "./routes/subnet-idle-stake.ts";
import {
  DomainSummaryArtifactSchema,
  DomainsArtifactSchema,
} from "./routes/domains.ts";
import {
  IntegrationReadinessSchema,
  SubnetProfileIdentityEvidenceSchema,
  SubnetProfileSchema,
} from "./routes/subnet-profile.ts";
import { SubnetOverviewArtifactSchema } from "./routes/subnet-overview.ts";
import { EconomicsTrendsArtifactSchema } from "./routes/economics-trends.ts";
import { EmissionPipelineArtifactSchema } from "./routes/emission-pipeline.ts";
import {
  AskArtifactSchema,
  AskRequestSchema,
  SemanticSearchArtifactSchema,
  SurfaceVerifyArtifactSchema,
} from "./routes/ai-native.ts";
import {
  SubnetConcentrationArtifactSchema,
  SubnetConcentrationHistoryArtifactSchema,
} from "./routes/subnet-concentration.ts";
import { SubnetTurnoverArtifactSchema } from "./routes/subnet-turnover.ts";
import { SubnetStakeFlowArtifactSchema } from "./routes/subnet-stake-flow.ts";
import { SubnetStakeMovesArtifactSchema } from "./routes/subnet-stake-moves.ts";
import { SubnetStakeTransfersArtifactSchema } from "./routes/subnet-stake-transfers.ts";
import { SubnetOhlcArtifactSchema } from "./routes/subnet-ohlc.ts";
import {
  SubnetYieldArtifactSchema,
  SubnetYieldHistoryArtifactSchema,
} from "./routes/subnet-yield.ts";
import { SubnetMoversArtifactSchema } from "./routes/subnet-movers.ts";
import { SubnetTrajectoryArtifactSchema } from "./routes/subnet-trajectory.ts";
import {
  SubnetLeaseArtifactSchema,
  SubnetLeaseHistoryArtifactSchema,
} from "./routes/subnet-lease.ts";
import {
  CrowdloansArtifactSchema,
  CrowdloanDetailArtifactSchema,
} from "./routes/crowdloans.ts";
import { SubnetOwnershipHistoryArtifactSchema } from "./routes/subnet-ownership-history.ts";
import { SubnetConvictionArtifactSchema } from "./routes/subnet-conviction.ts";
import {
  SubnetMetagraphArtifactSchema,
  NeuronDetailArtifactSchema,
  SubnetValidatorsArtifactSchema,
  NeuronHistoryArtifactSchema,
} from "./routes/subnet-metagraph.ts";
import {
  SubnetHyperparametersArtifactSchema,
  SubnetHyperparamsHistoryArtifactSchema,
} from "./routes/subnet-hyperparameters.ts";
import {
  SubnetPerformanceArtifactSchema,
  SubnetPerformanceHistoryArtifactSchema,
} from "./routes/subnet-performance.ts";
import { SubnetPrometheusArtifactSchema } from "./routes/subnet-prometheus.ts";
import {
  SubnetWeightsArtifactSchema,
  SubnetWeightSettersArtifactSchema,
} from "./routes/subnet-weights.ts";
import {
  AccountSummaryArtifactSchema,
  AccountSubnetsArtifactSchema,
} from "./routes/account-summary.ts";
import { AccountsListArtifactSchema } from "./routes/accounts-list.ts";
import { TopHoldersArtifactSchema } from "./routes/top-holders.ts";
import { AccountBalanceArtifactSchema } from "./routes/account-balance.ts";
import { AccountPortfolioArtifactSchema } from "./routes/account-portfolio.ts";
import {
  AccountIdentityArtifactSchema,
  AccountIdentityHistoryArtifactSchema,
} from "./routes/account-identity.ts";
import {
  AccountPositionsArtifactSchema,
  AccountPositionHistoryArtifactSchema,
} from "./routes/account-positions.ts";
import { AccountRootClaimArtifactSchema } from "./routes/account-root-claim.ts";
import {
  AccountServingArtifactSchema,
  AccountPrometheusArtifactSchema,
  AccountStakeMovesArtifactSchema,
  AccountStakeFlowArtifactSchema,
} from "./routes/account-activity.ts";
import {
  AccountAxonRemovalsArtifactSchema,
  AccountDeregistrationsArtifactSchema,
  AccountRegistrationsArtifactSchema,
  AccountWeightSettersArtifactSchema,
} from "./routes/account-activity-registrations.ts";
import {
  AccountEventsArtifactSchema,
  AccountHistoryArtifactSchema,
  AccountTransfersArtifactSchema,
} from "./routes/account-events-feed.ts";
import { AccountExtrinsicsArtifactSchema } from "./routes/account-extrinsics.ts";
import { AccountCounterpartiesArtifactSchema } from "./routes/account-counterparties.ts";
import { AccountEntitiesArtifactSchema } from "./routes/account-entities.ts";
import {
  AccountChildrenArtifactSchema,
  AccountParentsArtifactSchema,
} from "./routes/account-child-delegation.ts";
import {
  EvmAddressMappingArtifactSchema,
  NetworkParametersArtifactSchema,
  RandomnessArtifactSchema,
  SudoKeyArtifactSchema,
} from "./routes/network-singletons.ts";
import {
  BlocksFeedArtifactSchema,
  BlockDetailArtifactSchema,
} from "./routes/blocks.ts";
import { BlocksSummaryArtifactSchema } from "./routes/blocks-summary.ts";
import { RuntimeVersionsArtifactSchema } from "./routes/runtime-versions.ts";
import { NetworkCapabilitiesArtifactSchema } from "./routes/network-capabilities.ts";
import {
  ExtrinsicsFeedArtifactSchema,
  ExtrinsicDetailArtifactSchema,
} from "./routes/extrinsics.ts";
import { BlockExtrinsicsArtifactSchema } from "./routes/block-extrinsics.ts";
import { BlockEventsArtifactSchema } from "./routes/block-events.ts";
import { BlockChainEventsArtifactSchema } from "./routes/block-chain-events.ts";
import { GlobalValidatorsArtifactSchema } from "./routes/global-validators.ts";
import { ValidatorDetailArtifactSchema } from "./routes/validator-detail.ts";
import { CompareValidatorsArtifactSchema } from "./routes/compare-validators.ts";
import { ValidatorHistoryArtifactSchema } from "./routes/validator-history.ts";
import { ValidatorNominatorsArtifactSchema } from "./routes/validator-nominators.ts";

import {
  ChainActivityArtifactSchema,
  ChainCallsArtifactSchema,
  ChainSignersArtifactSchema,
  ChainFeesArtifactSchema,
} from "./routes/chain-analytics.ts";
import {
  ChainAxonRemovalsArtifactSchema,
  ChainDeregistrationsArtifactSchema,
  ChainPrometheusArtifactSchema,
  ChainRegistrationsArtifactSchema,
  ChainServingArtifactSchema,
  ChainStakeMovesArtifactSchema,
  ChainStakeTransfersArtifactSchema,
  ChainWeightsArtifactSchema,
} from "./routes/chain-network-rollups.ts";
import { ChainAlphaVolumeArtifactSchema } from "./routes/chain-alpha-volume.ts";
import { ChainConcentrationArtifactSchema } from "./routes/chain-concentration.ts";
import {
  ChainEventsFeedArtifactSchema,
  ChainEventsStatsArtifactSchema,
} from "./routes/chain-events.ts";
import { ChainIdentityHistoryArtifactSchema } from "./routes/chain-identity-history.ts";
import { ChainIdleStakeArtifactSchema } from "./routes/chain-idle-stake.ts";
import { ChainPerformanceArtifactSchema } from "./routes/chain-performance.ts";
import { ChainStakeFlowArtifactSchema } from "./routes/chain-stake-flow.ts";
import {
  ChainTransferPairsArtifactSchema,
  ChainTransfersArtifactSchema,
} from "./routes/chain-transfers.ts";
import { ChainTurnoverArtifactSchema } from "./routes/chain-turnover.ts";
import { ChainWeightSettersArtifactSchema } from "./routes/chain-weight-setters.ts";
import { ChainYieldArtifactSchema } from "./routes/chain-yield.ts";
import {
  SelfHealthArtifactSchema,
  SelfHealthComponentSchema,
  SelfHealthDaySchema,
  SelfHealthLaneSchema,
} from "./routes/self-health.ts";
import { CompareArtifactSchema } from "./routes/compare.ts";
import {
  AgentReadinessBlockerSchema,
  CoverageArtifactSchema,
  CoverageDepthArtifactSchema,
  CoverageDepthRowSchema,
} from "./routes/coverage.ts";
import {
  CoverageLevelSchema,
  CurationArtifactSchema,
  GapsArtifactSchema,
} from "./routes/curation-gaps.ts";
import {
  FixtureArtifactSchema,
  FixturesIndexArtifactSchema,
  JsonObjectSchema,
} from "./routes/fixtures.ts";
import { LineageArtifactSchema } from "./routes/lineage.ts";
import {
  RegistryLeaderboardsArtifactSchema,
  RegistrySummaryArtifactSchema,
} from "./routes/registry-summary-leaderboards.ts";
import { AdapterArtifactSchema } from "./routes/adapter.ts";
import {
  ReviewAdapterCandidateSchema,
  ReviewAdapterCandidatesArtifactSchema,
  ReviewEnrichmentEvidenceArtifactSchema,
  ReviewEnrichmentQueueArtifactSchema,
  ReviewEnrichmentTargetsArtifactSchema,
} from "./routes/review-enrichment.ts";
import {
  ReviewGapPrioritiesArtifactSchema,
  ReviewGapPrioritySchema,
  ReviewProfileCompletenessArtifactSchema,
  SubnetGapsArtifactSchema,
} from "./routes/review-gaps-profile.ts";

import {
  ApiIndexArtifactSchema,
  ContractsArtifactSchema,
  OpenApiArtifactSchema,
  BuildSummaryArtifactSchema,
  ChangelogArtifactSchema,
} from "./routes/meta-contracts.ts";
import {
  FreshnessArtifactSchema,
  SourceHealthArtifactSchema,
  SourceSnapshotsArtifactSchema,
  SearchArtifactSchema,
  SearchIndexArtifactSchema,
} from "./routes/evidence-search.ts";
import {
  ProviderArtifactSchema,
  ProvidersArtifactSchema,
  ProviderEndpointsArtifactSchema,
  RpcEndpointsArtifactSchema,
  RpcPoolsArtifactSchema,
  RpcUsageArtifactSchema,
  ProviderSchema,
  RpcPoolSchema,
} from "./routes/providers-rpc.ts";
import {
  SubnetProfilesArtifactSchema,
  SubnetProfileArtifactSchema,
  SchemaIndexArtifactSchema,
} from "./routes/subnet-profiles.ts";
import {
  AgentCatalogArtifactSchema,
  AgentCatalogSubnetArtifactSchema,
  AgentResourcesArtifactSchema,
  AgentReadinessStatusSchema,
} from "./routes/agent-catalog.ts";

import {
  HealthHistoryArtifactSchema,
  BulkHealthTrendsArtifactSchema,
  GlobalIncidentsArtifactSchema,
  HealthSubnetArtifactSchema,
  HealthSurfaceSchema,
  HealthIncidentsArtifactSchema,
  HealthPercentilesArtifactSchema,
  HealthTrendsArtifactSchema,
  UptimeArtifactSchema,
} from "./routes/health-surfaces.ts";
import {
  SurfacesArtifactSchema,
  SubnetSurfacesArtifactSchema,
  EndpointsArtifactSchema,
  SubnetEndpointsArtifactSchema,
  EndpointIncidentSchema,
  EndpointIncidentsArtifactSchema,
  EndpointPoolsArtifactSchema,
} from "./routes/endpoints-pools.ts";
import { EndpointSummarySchema } from "./routes/providers-rpc.ts";
import {
  CandidatesArtifactSchema,
  SubnetCandidatesArtifactSchema,
  EvidenceClaimSchema,
  EvidenceLedgerArtifactSchema,
  SubnetEvidenceArtifactSchema,
} from "./routes/candidates-evidence.ts";

export const openApiComponentRegistry = z.registry<{ id: string }>();

const register = (schema: z.ZodType, id: string) => {
  openApiComponentRegistry.add(schema, { id });
};

register(SubnetsArtifactSchema, "SubnetsArtifact");
register(SubnetIndexEntrySchema, "SubnetIndexEntry");
register(SubnetDetailArtifactSchema, "SubnetDetailArtifact");
register(SurfaceSchema, "Surface");
register(CandidateSurfaceSchema, "CandidateSurface");
register(EndpointResourceSchema, "EndpointResource");
register(GapsSchema, "Gaps");
register(CurationMetadataSchema, "CurationMetadata");
register(PartnershipMetadataSchema, "PartnershipMetadata");
register(EconomicsArtifactSchema, "EconomicsArtifact");
register(HealthSummaryArtifactSchema, "HealthSummaryArtifact");
register(HealthSubnetSummarySchema, "HealthSubnetSummary");
register(SubnetStakeQuoteArtifactSchema, "SubnetStakeQuoteArtifact");
// The three sub-shapes are registered explicitly: this file's header warns that a named
// sub-shape left unregistered is silently INLINED rather than $ref'd, which would
// duplicate the composition/take/agreement objects into every route that carries them.
register(ValidatorSetCompositionSchema, "ValidatorSetComposition");
register(ValidatorPermitModelAgreementSchema, "ValidatorPermitModelAgreement");
register(ValidatorTakeDistributionSchema, "ValidatorTakeDistribution");
register(
  SubnetValidatorEconomicsArtifactSchema,
  "SubnetValidatorEconomicsArtifact",
);
register(ValidatorEconomicsExclusionSchema, "ValidatorEconomicsExclusion");
register(
  ValidatorEconomicsRankingArtifactSchema,
  "ValidatorEconomicsRankingArtifact",
);
register(
  ValidatorEconomicsHistoryPointSchema,
  "ValidatorEconomicsHistoryPoint",
);
register(
  SubnetValidatorEconomicsHistoryArtifactSchema,
  "SubnetValidatorEconomicsHistoryArtifact",
);
register(SurfaceKindSchema, "SurfaceKind");
register(SourceTierSchema, "SourceTier");
register(ClassificationSchema, "Classification");
register(AuthoritySchema, "Authority");
register(EndpointLayerSchema, "EndpointLayer");
register(ProbeConfigSchema, "ProbeConfig");
register(EndpointMonitoringPolicySchema, "EndpointMonitoringPolicy");
register(EndpointScoreReasonSchema, "EndpointScoreReason");
register(VerificationResultSchema, "VerificationResult");
register(ReviewStateSchema, "ReviewState");
register(BittensorNetworkSchema, "BittensorNetwork");
register(HealthStatusSchema, "HealthStatus");
register(CurationLevelSchema, "CurationLevel");

// Batch 1 (#8055) additions.
register(SubnetAlphaVolumeArtifactSchema, "SubnetAlphaVolumeArtifact");
register(SubnetAxonRemovalsArtifactSchema, "SubnetAxonRemovalsArtifact");
register(SubnetDeregistrationsArtifactSchema, "SubnetDeregistrationsArtifact");
register(SubnetRegistrationsArtifactSchema, "SubnetRegistrationsArtifact");
register(SubnetServingArtifactSchema, "SubnetServingArtifact");
register(SubnetBurnArtifactSchema, "SubnetBurnArtifact");
// Registered for the same reason as the sibling nested shapes: a named sub-shape
// referenced only from an array gets inlined rather than $ref'd.
register(ChainBurnEntrySchema, "ChainBurnEntry");
register(ChainBurnArtifactSchema, "ChainBurnArtifact");
register(SubnetBurnHistoryPointSchema, "SubnetBurnHistoryPoint");
register(SubnetBurnHistoryArtifactSchema, "SubnetBurnHistoryArtifact");
register(SubnetRecycledArtifactSchema, "SubnetRecycledArtifact");
register(SubnetHolderSchema, "SubnetHolder");
register(SubnetHoldersConcentrationSchema, "SubnetHoldersConcentration");
register(SubnetHoldersDegradedSchema, "SubnetHoldersDegraded");
register(SubnetHoldersArtifactSchema, "SubnetHoldersArtifact");
register(ChainHoldersSubnetSchema, "ChainHoldersSubnet");
register(ChainHoldersNetworkSchema, "ChainHoldersNetwork");
register(ChainHoldersArtifactSchema, "ChainHoldersArtifact");
register(EmissionParamChangeSchema, "EmissionParamChange");
register(EmissionSubnetChangeSchema, "EmissionSubnetChange");
register(EmissionFlowChangeSchema, "EmissionFlowChange");
register(EmissionGateChangesArtifactSchema, "EmissionGateChangesArtifact");
register(FailureReasonSchema, "FailureReason");
register(FailureReasonsDaySchema, "FailureReasonsDay");
register(FailureReasonsArtifactSchema, "FailureReasonsArtifact");
register(TaoUsdPointSchema, "TaoUsdPoint");
register(TaoUsdLatestSchema, "TaoUsdLatest");
register(TaoUsdArtifactSchema, "TaoUsdArtifact");
register(SurfaceHistoryChangeSchema, "SurfaceHistoryChange");
register(SubnetSurfaceHistoryArtifactSchema, "SubnetSurfaceHistoryArtifact");
register(AccountEventSchema, "AccountEvent");
register(SubnetEventsArtifactSchema, "SubnetEventsArtifact");
register(SubnetEventSummaryArtifactSchema, "SubnetEventSummaryArtifact");
register(SubnetHistoryArtifactSchema, "SubnetHistoryArtifact");
register(SubnetIdentityHistoryArtifactSchema, "SubnetIdentityHistoryArtifact");
register(SubnetIdleStakeArtifactSchema, "SubnetIdleStakeArtifact");
register(DomainSummaryArtifactSchema, "DomainSummaryArtifact");
register(DomainsArtifactSchema, "DomainsArtifact");
register(IntegrationReadinessSchema, "IntegrationReadiness");
register(SubnetProfileIdentityEvidenceSchema, "SubnetProfileIdentityEvidence");
register(SubnetProfileSchema, "SubnetProfile");
register(SubnetOverviewArtifactSchema, "SubnetOverviewArtifact");

// Batch 2 (#8056) additions.
register(EconomicsTrendsArtifactSchema, "EconomicsTrendsArtifact");
register(EmissionPipelineArtifactSchema, "EmissionPipelineArtifact");

// The AI-native layer (#9092): live since ADR 0003 and never registered, so
// absent from openapi.json and every generated client until now.
register(AskArtifactSchema, "AskArtifact");
// The only REQUEST-body component in the contract -- see route()'s
// requestBodySchema argument in src/contracts.ts.
register(AskRequestSchema, "AskRequest");
register(SemanticSearchArtifactSchema, "SemanticSearchArtifact");
register(SurfaceVerifyArtifactSchema, "SurfaceVerifyArtifact");
register(SubnetConcentrationArtifactSchema, "SubnetConcentrationArtifact");
register(
  SubnetConcentrationHistoryArtifactSchema,
  "SubnetConcentrationHistoryArtifact",
);
register(SubnetTurnoverArtifactSchema, "SubnetTurnoverArtifact");
register(SubnetStakeFlowArtifactSchema, "SubnetStakeFlowArtifact");
register(SubnetStakeMovesArtifactSchema, "SubnetStakeMovesArtifact");
register(SubnetStakeTransfersArtifactSchema, "SubnetStakeTransfersArtifact");
register(SubnetOhlcArtifactSchema, "SubnetOhlcArtifact");
register(SubnetYieldArtifactSchema, "SubnetYieldArtifact");
register(SubnetYieldHistoryArtifactSchema, "SubnetYieldHistoryArtifact");
register(SubnetMoversArtifactSchema, "SubnetMoversArtifact");
register(SubnetTrajectoryArtifactSchema, "SubnetTrajectoryArtifact");
register(SubnetLeaseArtifactSchema, "SubnetLeaseArtifact");
register(SubnetLeaseHistoryArtifactSchema, "SubnetLeaseHistoryArtifact");
register(CrowdloansArtifactSchema, "CrowdloansArtifact");
register(CrowdloanDetailArtifactSchema, "CrowdloanDetailArtifact");
register(
  SubnetOwnershipHistoryArtifactSchema,
  "SubnetOwnershipHistoryArtifact",
);
register(SubnetConvictionArtifactSchema, "SubnetConvictionArtifact");
register(AccountSummaryArtifactSchema, "AccountSummaryArtifact");
register(AccountSubnetsArtifactSchema, "AccountSubnetsArtifact");
register(AccountsListArtifactSchema, "AccountsListArtifact");
register(TopHoldersArtifactSchema, "TopHoldersArtifact");
register(AccountBalanceArtifactSchema, "AccountBalanceArtifact");
register(AccountPortfolioArtifactSchema, "AccountPortfolioArtifact");
register(AccountIdentityArtifactSchema, "AccountIdentityArtifact");
register(
  AccountIdentityHistoryArtifactSchema,
  "AccountIdentityHistoryArtifact",
);
register(AccountPositionsArtifactSchema, "AccountPositionsArtifact");
register(
  AccountPositionHistoryArtifactSchema,
  "AccountPositionHistoryArtifact",
);
register(AccountRootClaimArtifactSchema, "AccountRootClaimArtifact");
register(AccountServingArtifactSchema, "AccountServingArtifact");
register(AccountPrometheusArtifactSchema, "AccountPrometheusArtifact");
register(AccountStakeMovesArtifactSchema, "AccountStakeMovesArtifact");
register(AccountStakeFlowArtifactSchema, "AccountStakeFlowArtifact");
register(ChainActivityArtifactSchema, "ChainActivityArtifact");
register(ChainCallsArtifactSchema, "ChainCallsArtifact");
register(ChainSignersArtifactSchema, "ChainSignersArtifact");
register(ChainFeesArtifactSchema, "ChainFeesArtifact");
register(ChainAxonRemovalsArtifactSchema, "ChainAxonRemovalsArtifact");
register(ChainDeregistrationsArtifactSchema, "ChainDeregistrationsArtifact");
register(ChainPrometheusArtifactSchema, "ChainPrometheusArtifact");
register(ChainRegistrationsArtifactSchema, "ChainRegistrationsArtifact");
register(ChainServingArtifactSchema, "ChainServingArtifact");
register(ChainStakeMovesArtifactSchema, "ChainStakeMovesArtifact");
register(ChainStakeTransfersArtifactSchema, "ChainStakeTransfersArtifact");
register(ChainWeightsArtifactSchema, "ChainWeightsArtifact");
register(ChainAlphaVolumeArtifactSchema, "ChainAlphaVolumeArtifact");
register(ChainConcentrationArtifactSchema, "ChainConcentrationArtifact");
register(ChainEventsFeedArtifactSchema, "ChainEventsFeedArtifact");
register(ChainEventsStatsArtifactSchema, "ChainEventsStatsArtifact");
register(ChainIdentityHistoryArtifactSchema, "ChainIdentityHistoryArtifact");
register(ChainIdleStakeArtifactSchema, "ChainIdleStakeArtifact");
register(ChainPerformanceArtifactSchema, "ChainPerformanceArtifact");
register(ChainStakeFlowArtifactSchema, "ChainStakeFlowArtifact");
register(ChainTransferPairsArtifactSchema, "ChainTransferPairsArtifact");
register(ChainTransfersArtifactSchema, "ChainTransfersArtifact");
register(ChainTurnoverArtifactSchema, "ChainTurnoverArtifact");
register(ChainWeightSettersArtifactSchema, "ChainWeightSettersArtifact");
register(ChainYieldArtifactSchema, "ChainYieldArtifact");
// #8318: the two leaf shapes are registered explicitly, not just the artifact
// -- an unregistered named sub-shape is inlined rather than $ref'd.
register(SelfHealthDaySchema, "SelfHealthDay");
register(SelfHealthComponentSchema, "SelfHealthComponent");
// Registered for the same reason as its siblings above: a named sub-shape that is
// only referenced from a nested array gets silently inlined rather than $ref'd.
register(SelfHealthLaneSchema, "SelfHealthLane");
register(SelfHealthArtifactSchema, "SelfHealthArtifact");

// Batch 3 (#8057) additions.
register(SubnetMetagraphArtifactSchema, "SubnetMetagraphArtifact");
register(NeuronDetailArtifactSchema, "NeuronDetailArtifact");
register(SubnetValidatorsArtifactSchema, "SubnetValidatorsArtifact");
register(NeuronHistoryArtifactSchema, "NeuronHistoryArtifact");
register(SubnetHyperparametersArtifactSchema, "SubnetHyperparametersArtifact");
register(
  SubnetHyperparamsHistoryArtifactSchema,
  "SubnetHyperparamsHistoryArtifact",
);
register(SubnetPerformanceArtifactSchema, "SubnetPerformanceArtifact");
register(
  SubnetPerformanceHistoryArtifactSchema,
  "SubnetPerformanceHistoryArtifact",
);
register(SubnetPrometheusArtifactSchema, "SubnetPrometheusArtifact");
register(SubnetWeightsArtifactSchema, "SubnetWeightsArtifact");
register(SubnetWeightSettersArtifactSchema, "SubnetWeightSettersArtifact");
register(AccountAxonRemovalsArtifactSchema, "AccountAxonRemovalsArtifact");
register(
  AccountDeregistrationsArtifactSchema,
  "AccountDeregistrationsArtifact",
);
register(AccountRegistrationsArtifactSchema, "AccountRegistrationsArtifact");
register(AccountWeightSettersArtifactSchema, "AccountWeightSettersArtifact");
register(AccountEventsArtifactSchema, "AccountEventsArtifact");
register(AccountHistoryArtifactSchema, "AccountHistoryArtifact");
register(AccountTransfersArtifactSchema, "AccountTransfersArtifact");
register(AccountExtrinsicsArtifactSchema, "AccountExtrinsicsArtifact");
register(AccountCounterpartiesArtifactSchema, "AccountCounterpartiesArtifact");
register(AccountEntitiesArtifactSchema, "AccountEntitiesArtifact");
register(AccountChildrenArtifactSchema, "AccountChildrenArtifact");
register(AccountParentsArtifactSchema, "AccountParentsArtifact");
register(EvmAddressMappingArtifactSchema, "EvmAddressMappingArtifact");
register(NetworkParametersArtifactSchema, "NetworkParametersArtifact");
register(RandomnessArtifactSchema, "RandomnessArtifact");
register(SudoKeyArtifactSchema, "SudoKeyArtifact");
register(BlocksFeedArtifactSchema, "BlocksFeedArtifact");
register(BlockDetailArtifactSchema, "BlockDetailArtifact");
register(BlocksSummaryArtifactSchema, "BlocksSummaryArtifact");
register(RuntimeVersionsArtifactSchema, "RuntimeVersionsArtifact");
register(NetworkCapabilitiesArtifactSchema, "NetworkCapabilitiesArtifact");
register(ExtrinsicsFeedArtifactSchema, "ExtrinsicsFeedArtifact");
register(ExtrinsicDetailArtifactSchema, "ExtrinsicDetailArtifact");
register(BlockExtrinsicsArtifactSchema, "BlockExtrinsicsArtifact");
register(BlockEventsArtifactSchema, "BlockEventsArtifact");
register(BlockChainEventsArtifactSchema, "BlockChainEventsArtifact");
register(GlobalValidatorsArtifactSchema, "GlobalValidatorsArtifact");
register(ValidatorDetailArtifactSchema, "ValidatorDetailArtifact");
register(CompareValidatorsArtifactSchema, "CompareValidatorsArtifact");
register(ValidatorHistoryArtifactSchema, "ValidatorHistoryArtifact");
register(ValidatorNominatorsArtifactSchema, "ValidatorNominatorsArtifact");
// ConcentrationMetrics/ScoreDistribution: still referenced by name from
// AccountPortfolioArtifact/ChainConcentrationArtifact/ChainPerformanceArtifact,
// all still hand-edited (verified via repo-wide $ref grep) -- unlike this
// batch's other shared sub-shapes, these must stay registered, not orphaned.
// (BlocksSummaryArtifact used to be a 4th referrer before this batch/#8061
// converted it -- it now imports ConcentrationMetricsSchema directly instead
// of $ref'ing the hand-edited component, so it no longer counts.)
register(ConcentrationMetricsSchema, "ConcentrationMetrics");
register(ScoreDistributionSchema, "ScoreDistribution");

// Batch 8 (#8062) additions. Only the 18 top-level route artifacts (each
// required -- schemaRefForArtifactPath binds its route to exactly this
// name) plus AgentReadinessBlocker/CoverageLevel/CountMap (still
// referenced by name from AgentReadinessStatus/SubnetDetail/several
// SourceHealth*+Endpoint*+SubnetProfilesArtifact components respectively,
// all still hand-edited -- verified via repo-wide $ref grep) plus
// ReviewGapPriority/ReviewAdapterCandidate (still referenced by name from
// ReviewCurationArtifact, also still hand-edited and out of this batch's
// scope -- same test) plus JsonObject (hardcoded by name in
// src/contracts.ts's schema-snapshot artifact, same test as AdapterArtifact
// below) plus CoverageDepthRow (hardcoded by name in
// scripts/validate-schema-enums.ts's comparePropertyEnum, which resolves it
// as a top-level components.schemas entry, not via $ref) are registered
// here. Every other sub-shape this batch modeled (CompareSubnetEntry,
// CoverageDepthQueueEntry, CurationEntry, GapsEntry,
// ReviewEnrichmentQueueEntry, ReviewCandidateEvidence(+Summary),
// ReviewEnrichmentTargetQueueContext, ReviewEnrichmentTarget(+Group),
// ReviewProfileCompletenessEntry, and the 5 small Review* enums) is
// referenced only by this batch's own converted routes, all converted
// together here -- same as batch 7's Block/Extrinsic/ColdkeyIdentity/etc.
// treatment, see OPENAPI_ZOD_ORPHANED_COMPONENT_NAMES below.
register(CompareArtifactSchema, "CompareArtifact");
register(CoverageArtifactSchema, "CoverageArtifact");
register(CoverageDepthArtifactSchema, "CoverageDepthArtifact");
register(AgentReadinessBlockerSchema, "AgentReadinessBlocker");
register(CoverageLevelSchema, "CoverageLevel");
register(CurationArtifactSchema, "CurationArtifact");
register(GapsArtifactSchema, "GapsArtifact");
register(FixturesIndexArtifactSchema, "FixturesIndexArtifact");
register(FixtureArtifactSchema, "FixtureArtifact");
register(LineageArtifactSchema, "LineageArtifact");
register(RegistrySummaryArtifactSchema, "RegistrySummaryArtifact");
register(RegistryLeaderboardsArtifactSchema, "RegistryLeaderboardsArtifact");
// AdapterArtifact: hardcoded by name in scripts/generate-client.ts
// (AdapterSnapshot's type alias) -- must stay registered like
// SubnetIndexEntry, not just for a still-hand-edited $ref.
register(AdapterArtifactSchema, "AdapterArtifact");
register(ReviewGapPrioritiesArtifactSchema, "ReviewGapPrioritiesArtifact");
register(SubnetGapsArtifactSchema, "SubnetGapsArtifact");
register(
  ReviewProfileCompletenessArtifactSchema,
  "ReviewProfileCompletenessArtifact",
);
register(ReviewEnrichmentQueueArtifactSchema, "ReviewEnrichmentQueueArtifact");
register(
  ReviewEnrichmentEvidenceArtifactSchema,
  "ReviewEnrichmentEvidenceArtifact",
);
register(
  ReviewEnrichmentTargetsArtifactSchema,
  "ReviewEnrichmentTargetsArtifact",
);
register(
  ReviewAdapterCandidatesArtifactSchema,
  "ReviewAdapterCandidatesArtifact",
);
register(ReviewGapPrioritySchema, "ReviewGapPriority");
register(ReviewAdapterCandidateSchema, "ReviewAdapterCandidate");
// JsonObject: hardcoded by name in src/contracts.ts (the schema-snapshot
// artifact's schema_ref) -- must stay registered, same test/treatment as
// AdapterArtifact above.
register(JsonObjectSchema, "JsonObject");
// CoverageDepthRow: hardcoded by name in scripts/validate-schema-enums.ts
// (comparePropertyEnum("CoverageDepthRow", "tier", ...) looks it up as a
// top-level components.schemas entry, not via $ref) -- must stay
// registered for that drift check to see its `tier` enum at all.
register(CoverageDepthRowSchema, "CoverageDepthRow");
register(CountMapSchema, "CountMap");

// Batch 10 (#8064) additions.
register(ApiIndexArtifactSchema, "ApiIndexArtifact");
register(ContractsArtifactSchema, "ContractsArtifact");
register(OpenApiArtifactSchema, "OpenApiArtifact");
register(BuildSummaryArtifactSchema, "BuildSummaryArtifact");
register(ChangelogArtifactSchema, "ChangelogArtifact");
register(FreshnessArtifactSchema, "FreshnessArtifact");
register(SourceHealthArtifactSchema, "SourceHealthArtifact");
register(SourceSnapshotsArtifactSchema, "SourceSnapshotsArtifact");
register(SearchArtifactSchema, "SearchArtifact");
register(SearchIndexArtifactSchema, "SearchIndexArtifact");
register(ProviderArtifactSchema, "ProviderArtifact");
register(ProvidersArtifactSchema, "ProvidersArtifact");
register(ProviderEndpointsArtifactSchema, "ProviderEndpointsArtifact");
register(RpcEndpointsArtifactSchema, "RpcEndpointsArtifact");
register(RpcPoolsArtifactSchema, "RpcPoolsArtifact");
register(RpcUsageArtifactSchema, "RpcUsageArtifact");
// Provider/RpcPool: no remaining $ref, but generated/metagraphed-client.ts
// hardcodes a components["schemas"] type lookup against both by name (see
// providers-rpc.ts's own header) -- register so they stay real named
// components instead of being inlined.
register(ProviderSchema, "Provider");
register(RpcPoolSchema, "RpcPool");
register(SubnetProfilesArtifactSchema, "SubnetProfilesArtifact");
register(SubnetProfileArtifactSchema, "SubnetProfileArtifact");
// SubnetDetail (bare): same situation as Provider/RpcPool above --
// generated/metagraphed-client.ts hardcodes a lookup against it by name, and
// SubnetProfileArtifact (this batch) is now its only $ref'd use.
register(SubnetDetailSchema, "SubnetDetail");
register(SchemaIndexArtifactSchema, "SchemaIndexArtifact");
register(AgentCatalogArtifactSchema, "AgentCatalogArtifact");
register(AgentCatalogSubnetArtifactSchema, "AgentCatalogSubnetArtifact");
register(AgentResourcesArtifactSchema, "AgentResourcesArtifact");
// AgentReadinessBlocker is already registered above by batch 8 (imported
// from ./routes/coverage.ts, the same shape agent-catalog.ts reuses by
// import rather than redefining -- see that file's own header).
// AgentReadinessStatus: no remaining $ref, but
// scripts/validate-schema-enums.ts hardcodes a property-enum lookup against
// it by name (see agent-catalog.ts's own header) -- register so it stays a
// real named component instead of being inlined.
register(AgentReadinessStatusSchema, "AgentReadinessStatus");

// Batch 9 (#8063) additions.
register(HealthHistoryArtifactSchema, "HealthHistoryArtifact");
register(BulkHealthTrendsArtifactSchema, "BulkHealthTrendsArtifact");
register(GlobalIncidentsArtifactSchema, "GlobalIncidentsArtifact");
register(HealthSubnetArtifactSchema, "HealthSubnetArtifact");
// HealthSurface: no remaining $ref from THIS batch's own routes (see
// health-surfaces.ts's header for why HealthSubnetArtifact doesn't reuse
// it), but generate-client.ts hardcodes a components["schemas"]
// ["HealthSurface"] type lookup by name, and the still-hand-edited
// HealthLatestArtifact (a different, out-of-batch route) still $refs it --
// register so both keep resolving to a real, validated schema.
register(HealthSurfaceSchema, "HealthSurface");
register(HealthIncidentsArtifactSchema, "HealthIncidentsArtifact");
register(HealthPercentilesArtifactSchema, "HealthPercentilesArtifact");
register(HealthTrendsArtifactSchema, "HealthTrendsArtifact");
register(UptimeArtifactSchema, "UptimeArtifact");
register(SurfacesArtifactSchema, "SurfacesArtifact");
register(SubnetSurfacesArtifactSchema, "SubnetSurfacesArtifact");
register(EndpointsArtifactSchema, "EndpointsArtifact");
register(SubnetEndpointsArtifactSchema, "SubnetEndpointsArtifact");
// EndpointSummary: still referenced by name from ProviderArtifact/
// ProviderEndpointsArtifact (batch 10, providers-rpc.ts, exported there
// specifically for this reuse) in addition to this batch's own
// EndpointsArtifact/SubnetEndpointsArtifact -- register under its existing
// hand-edited name so all four keep resolving to one real, validated schema
// (same "upgraded for free" treatment as Surface/EndpointResource above).
register(EndpointSummarySchema, "EndpointSummary");
// EndpointIncident: no remaining $ref (1 referrer, this batch's own
// EndpointIncidentsArtifact), but scripts/validate-schema-enums.ts hardcodes
// comparePropertyEnum("EndpointIncident", "severity"/"state", ...) against
// it as a top-level components.schemas entry by name -- register so that
// drift check keeps seeing its enums at all.
register(EndpointIncidentSchema, "EndpointIncident");
register(EndpointIncidentsArtifactSchema, "EndpointIncidentsArtifact");
register(EndpointPoolsArtifactSchema, "EndpointPoolsArtifact");
register(CandidatesArtifactSchema, "CandidatesArtifact");
register(SubnetCandidatesArtifactSchema, "SubnetCandidatesArtifact");
// EvidenceClaim: no remaining $ref (1 referrer, this batch's own
// EvidenceLedgerArtifact), but generate-client.ts hardcodes
// `export type EvidenceClaim = components["schemas"]["EvidenceClaim"];` --
// register so that type alias keeps resolving to a real, validated schema.
register(EvidenceClaimSchema, "EvidenceClaim");
register(EvidenceLedgerArtifactSchema, "EvidenceLedgerArtifact");
register(SubnetEvidenceArtifactSchema, "SubnetEvidenceArtifact");

// The component names this registry owns -- used by the generator to know
// which hand-edited schemas/components/*.schema.json keys to drop (they'd
// otherwise shadow the generated ones) and by the diff-audit script to know
// which components to compare.
export const OPENAPI_ZOD_COMPONENT_NAMES = [
  "SubnetsArtifact",
  "SubnetIndexEntry",
  "SubnetDetailArtifact",
  "Surface",
  "CandidateSurface",
  "EndpointResource",
  "Gaps",
  "CurationMetadata",
  "PartnershipMetadata",
  "EconomicsArtifact",
  "HealthSummaryArtifact",
  "HealthSubnetSummary",
  "SubnetStakeQuoteArtifact",
  "ValidatorSetComposition",
  "ValidatorPermitModelAgreement",
  "ValidatorTakeDistribution",
  "SubnetValidatorEconomicsArtifact",
  "ValidatorEconomicsExclusion",
  "ValidatorEconomicsRankingArtifact",
  "ValidatorEconomicsHistoryPoint",
  "SubnetValidatorEconomicsHistoryArtifact",
  "SurfaceKind",
  "SourceTier",
  "Classification",
  "Authority",
  "EndpointLayer",
  "ProbeConfig",
  "EndpointMonitoringPolicy",
  "EndpointScoreReason",
  "VerificationResult",
  "ReviewState",
  "BittensorNetwork",
  "HealthStatus",
  "CurationLevel",
  "SubnetAlphaVolumeArtifact",
  "SubnetAxonRemovalsArtifact",
  "SubnetDeregistrationsArtifact",
  "SubnetRegistrationsArtifact",
  "SubnetServingArtifact",
  "SubnetBurnArtifact",
  "SubnetRecycledArtifact",
  "AccountEvent",
  "SubnetEventsArtifact",
  "SubnetEventSummaryArtifact",
  "SubnetHistoryArtifact",
  "SubnetIdentityHistoryArtifact",
  "SubnetIdleStakeArtifact",
  "DomainSummaryArtifact",
  "DomainsArtifact",
  "IntegrationReadiness",
  "SubnetProfileIdentityEvidence",
  "SubnetProfile",
  "SubnetOverviewArtifact",
  "EconomicsTrendsArtifact",
  "SubnetConcentrationArtifact",
  "SubnetConcentrationHistoryArtifact",
  "SubnetTurnoverArtifact",
  "SubnetStakeFlowArtifact",
  "SubnetStakeMovesArtifact",
  "SubnetStakeTransfersArtifact",
  "SubnetOhlcArtifact",
  "SubnetYieldArtifact",
  "SubnetYieldHistoryArtifact",
  "SubnetMoversArtifact",
  "SubnetTrajectoryArtifact",
  "SubnetLeaseArtifact",
  "SubnetLeaseHistoryArtifact",
  "CrowdloansArtifact",
  "CrowdloanDetailArtifact",
  "SubnetOwnershipHistoryArtifact",
  "SubnetConvictionArtifact",
  "SubnetMetagraphArtifact",
  "NeuronDetailArtifact",
  "SubnetValidatorsArtifact",
  "NeuronHistoryArtifact",
  "SubnetHyperparametersArtifact",
  "SubnetHyperparamsHistoryArtifact",
  "SubnetPerformanceArtifact",
  "SubnetPerformanceHistoryArtifact",
  "SubnetPrometheusArtifact",
  "SubnetWeightsArtifact",
  "SubnetWeightSettersArtifact",
  "ConcentrationMetrics",
  "ScoreDistribution",
  "AccountSummaryArtifact",
  "AccountSubnetsArtifact",
  "AccountsListArtifact",
  "TopHoldersArtifact",
  "AccountBalanceArtifact",
  "AccountPortfolioArtifact",
  "AccountIdentityArtifact",
  "AccountIdentityHistoryArtifact",
  "AccountPositionsArtifact",
  "AccountPositionHistoryArtifact",
  "AccountRootClaimArtifact",
  "AccountServingArtifact",
  "AccountPrometheusArtifact",
  "AccountStakeMovesArtifact",
  "AccountStakeFlowArtifact",
  "AccountAxonRemovalsArtifact",
  "AccountDeregistrationsArtifact",
  "AccountRegistrationsArtifact",
  "AccountWeightSettersArtifact",
  "AccountEventsArtifact",
  "AccountHistoryArtifact",
  "AccountTransfersArtifact",
  "AccountExtrinsicsArtifact",
  "AccountCounterpartiesArtifact",
  "AccountEntitiesArtifact",
  "AccountChildrenArtifact",
  "AccountParentsArtifact",
  "EvmAddressMappingArtifact",
  "NetworkParametersArtifact",
  "RandomnessArtifact",
  "SudoKeyArtifact",
  "ChainActivityArtifact",
  "ChainCallsArtifact",
  "ChainSignersArtifact",
  "ChainFeesArtifact",
  "ChainAxonRemovalsArtifact",
  "ChainDeregistrationsArtifact",
  "ChainPrometheusArtifact",
  "ChainRegistrationsArtifact",
  "ChainServingArtifact",
  "ChainStakeMovesArtifact",
  "ChainStakeTransfersArtifact",
  "ChainWeightsArtifact",
  "ChainAlphaVolumeArtifact",
  "ChainConcentrationArtifact",
  "ChainEventsFeedArtifact",
  "ChainEventsStatsArtifact",
  "ChainIdentityHistoryArtifact",
  "ChainIdleStakeArtifact",
  "ChainPerformanceArtifact",
  "ChainStakeFlowArtifact",
  "ChainTransferPairsArtifact",
  "ChainTransfersArtifact",
  "ChainTurnoverArtifact",
  "ChainWeightSettersArtifact",
  "ChainYieldArtifact",
  "SelfHealthDay",
  "SelfHealthComponent",
  "SelfHealthArtifact",
  "BlocksFeedArtifact",
  "BlockDetailArtifact",
  "BlocksSummaryArtifact",
  "RuntimeVersionsArtifact",
  "NetworkCapabilitiesArtifact",
  "ExtrinsicsFeedArtifact",
  "ExtrinsicDetailArtifact",
  "BlockExtrinsicsArtifact",
  "BlockEventsArtifact",
  "BlockChainEventsArtifact",
  "GlobalValidatorsArtifact",
  "ValidatorDetailArtifact",
  "CompareValidatorsArtifact",
  "ValidatorHistoryArtifact",
  "ValidatorNominatorsArtifact",
  // Batch 8 (#8062) additions.
  "CompareArtifact",
  "CoverageArtifact",
  "CoverageDepthArtifact",
  "AgentReadinessBlocker",
  "CoverageLevel",
  "CurationArtifact",
  "GapsArtifact",
  "FixturesIndexArtifact",
  "FixtureArtifact",
  "LineageArtifact",
  "RegistrySummaryArtifact",
  "RegistryLeaderboardsArtifact",
  "AdapterArtifact",
  "ReviewGapPrioritiesArtifact",
  "SubnetGapsArtifact",
  "ReviewProfileCompletenessArtifact",
  "ReviewEnrichmentQueueArtifact",
  "ReviewEnrichmentEvidenceArtifact",
  "ReviewEnrichmentTargetsArtifact",
  "ReviewAdapterCandidatesArtifact",
  "ReviewGapPriority",
  "ReviewAdapterCandidate",
  "JsonObject",
  "CoverageDepthRow",
  "CountMap",
  // Batch 10 (#8064) additions.
  "ApiIndexArtifact",
  "ContractsArtifact",
  "OpenApiArtifact",
  "BuildSummaryArtifact",
  "ChangelogArtifact",
  "FreshnessArtifact",
  "SourceHealthArtifact",
  "SourceSnapshotsArtifact",
  "SearchArtifact",
  "SearchIndexArtifact",
  "ProviderArtifact",
  "ProvidersArtifact",
  "ProviderEndpointsArtifact",
  "RpcEndpointsArtifact",
  "RpcPoolsArtifact",
  "RpcUsageArtifact",
  "Provider",
  "RpcPool",
  "SubnetProfilesArtifact",
  "SubnetProfileArtifact",
  "SubnetDetail",
  "SchemaIndexArtifact",
  "AgentCatalogArtifact",
  "AgentCatalogSubnetArtifact",
  "AgentResourcesArtifact",
  "AgentReadinessStatus",
  // Batch 9 (#8063) additions.
  "HealthHistoryArtifact",
  "BulkHealthTrendsArtifact",
  "GlobalIncidentsArtifact",
  "HealthSubnetArtifact",
  "HealthSurface",
  "HealthIncidentsArtifact",
  "HealthPercentilesArtifact",
  "HealthTrendsArtifact",
  "UptimeArtifact",
  "SurfacesArtifact",
  "SubnetSurfacesArtifact",
  "EndpointsArtifact",
  "SubnetEndpointsArtifact",
  "EndpointSummary",
  "EndpointIncident",
  "EndpointIncidentsArtifact",
  "EndpointPoolsArtifact",
  "CandidatesArtifact",
  "SubnetCandidatesArtifact",
  "EvidenceClaim",
  "EvidenceLedgerArtifact",
  "SubnetEvidenceArtifact",
  "AskArtifact",
  "AskRequest",
  "SemanticSearchArtifact",
  "SurfaceVerifyArtifact",
] as const;

// SubnetEconomics has no registry entry (see header) but its hand-edited
// component key must still be dropped -- nothing references it by name
// anymore once EconomicsArtifact/SubnetDetailArtifact are Zod-owned.
//
// Batch 1 (#8055) additions: SubnetProfileNativeIdentity/PrimaryLinks/
// SurfaceSummary/Completeness/Provenance, SubnetEventCategorySummary/
// KindSummary, and SubnetIdentityHistoryEntry are each referenced only by
// the one hand-edited component this batch replaces (SubnetProfile,
// SubnetEventSummaryArtifact, SubnetIdentityHistoryArtifact respectively --
// verified via repo-wide $ref grep, unlike SubnetProfile/IntegrationReadiness/
// SubnetProfileIdentityEvidence above, which stay registered because other
// still-hand-edited components reference them too). Not worth a standalone
// registry entry (matches the SubnetEconomics precedent exactly); their
// hand-edited keys become orphaned the moment their one referrer is
// Zod-owned and inlines them instead.
// Batch 2 (#8056) additions: EconomicsTrendsDay/SubnetOhlcCandle/SubnetLease/
// SubnetLeaseEvent/SubnetOwnershipChange/SubnetConvictionEntry are each
// referenced only by the one hand-edited component this batch replaces
// (EconomicsTrendsArtifact/SubnetOhlcArtifact/SubnetLeaseArtifact/
// SubnetLeaseHistoryArtifact/SubnetOwnershipHistoryArtifact/
// SubnetConvictionArtifact respectively -- verified via repo-wide $ref grep,
// same test as the batch 1 additions above). Not worth a standalone registry
// entry; their hand-edited keys become orphaned the moment their one
// referrer is Zod-owned and inlines them instead.
// Batch 3 (#8057) additions: Neuron is referenced only by
// SubnetMetagraphArtifact/NeuronDetailArtifact/SubnetValidatorsArtifact, all
// three converted together in this same batch (verified via repo-wide $ref
// grep) -- becomes orphaned once all three are Zod-owned and inline it
// instead. SubnetHyperparameters is referenced only by
// SubnetHyperparametersArtifact and SubnetHyperparamsHistoryEntry (itself
// referenced only by SubnetHyperparamsHistoryArtifact), all converted
// together here -- both SubnetHyperparameters and
// SubnetHyperparamsHistoryEntry become orphaned the same way.
// Batch 4 (#8058) additions: AccountRegistration/AccountEventKindCount/
// AccountActivity/AccountsListEntry/AccountsListSubnet/TopHoldersEntry/
// AccountIdentityHistoryEntry/NominatorPosition/RootClaimType/
// RootClaimHotkey/RootClaimEntry are each referenced only by the one (or,
// for AccountRegistration, exactly two, both converted together in this
// same batch) hand-edited component(s) this batch replaces -- verified via
// repo-wide $ref grep, same test as every prior batch's additions. Not
// worth a standalone registry entry; their hand-edited keys become orphaned
// the moment their referrer(s) are Zod-owned and inline them instead.
export const OPENAPI_ZOD_ORPHANED_COMPONENT_NAMES = [
  "SubnetEconomics",
  "SubnetProfileNativeIdentity",
  "SubnetProfilePrimaryLinks",
  "SubnetProfileSurfaceSummary",
  "SubnetProfileCompleteness",
  "SubnetProfileProvenance",
  "SubnetEventCategorySummary",
  "SubnetEventKindSummary",
  "SubnetIdentityHistoryEntry",
  "EconomicsTrendsDay",
  "SubnetOhlcCandle",
  "SubnetLease",
  "SubnetLeaseEvent",
  "SubnetOwnershipChange",
  "SubnetConvictionEntry",
  "Neuron",
  "SubnetHyperparameters",
  "SubnetHyperparamsHistoryEntry",
  "AccountRegistration",
  "AccountEventKindCount",
  "AccountActivity",
  "AccountsListEntry",
  "AccountsListSubnet",
  "TopHoldersEntry",
  "AccountIdentityHistoryEntry",
  "PortfolioPosition",
  "NominatorPosition",
  "RootClaimType",
  "RootClaimHotkey",
  "RootClaimEntry",
  // Batch 5 (#8059) additions: AccountDay/ChildDelegationEntry/
  // ChildDelegationSubnet/ParentDelegationEntry/ParentDelegationSubnet are
  // each referenced only by the one hand-edited component this batch
  // replaces (verified via repo-wide $ref grep). `Extrinsic` is deliberately
  // NOT here -- it still has referrers outside this batch (block/
  // extrinsic-detail routes, out of scope until batch 7) -- its hand-edited
  // component key stays registered untouched; this batch's own
  // AccountExtrinsicsArtifact models that shape with a local unregistered
  // copy instead (see account-extrinsics.ts's header). `EntityLabel` WAS in
  // the same situation (its other referrer, AccountSummaryArtifact, was
  // batch 4/#8058, not yet merged when this batch was originally written)
  // but batch 4 has since merged, and both its referrers now inline it
  // locally rather than $ref it -- so EntityLabel is added below too, as
  // part of resolving this batch's rebase conflict against batch 4.
  "AccountDay",
  "ChildDelegationEntry",
  "ChildDelegationSubnet",
  "ParentDelegationEntry",
  "ParentDelegationSubnet",
  "EntityLabel",
  // Batch 6 (#8060) additions: ChainActivityDay/ChainCallEntry/
  // ChainSignerEntry/ChainFeeDay/ChainFeePayer/ChainEventEntry/
  // ChainIdentityHistoryChange/ChainTransferPair/ChainTransferParty/
  // YieldDistribution are each referenced only by the one hand-edited
  // component this batch replaces (verified via repo-wide $ref grep --
  // ChainTransferParty's two refs are both within ChainTransfersArtifact
  // itself, an intra-component reuse, not a cross-component one). `Extrinsic`
  // deliberately stays registered/untouched here -- it still has referrers
  // outside this batch (block/extrinsic-detail routes, out of scope until
  // batch 7) -- this batch's own chain-events.ts models ChainEvent's shape
  // with a local unregistered copy instead (same pattern batch 5 used for
  // Extrinsic/EntityLabel). `ChainEvent` WAS in the same situation (its
  // other referrer, BlockChainEventsArtifact, was batch 7/#8061, not yet
  // merged when this batch was originally written) but batch 7 has since
  // merged, and both its referrers now inline it locally rather than $ref
  // it -- so ChainEvent is added below too, as part of resolving batch 7's
  // rebase conflict against this batch.
  "ChainActivityDay",
  "ChainCallEntry",
  "ChainSignerEntry",
  "ChainFeeDay",
  "ChainFeePayer",
  "ChainEventEntry",
  "ChainIdentityHistoryChange",
  "ChainTransferPair",
  "ChainTransferParty",
  "YieldDistribution",
  "ChainEvent",
  // Batch 7 (#8061) additions: Block/Extrinsic are each referenced only by
  // this batch's own converted routes (Block: BlocksFeedArtifact,
  // BlockDetailArtifact; Extrinsic: ExtrinsicsFeedArtifact,
  // ExtrinsicDetailArtifact, BlockExtrinsicsArtifact -- all converted
  // together here, verified via repo-wide $ref grep), so both hand-edited
  // component keys become fully orphaned. AccountEvent is NOT listed -- it's
  // already a registered Zod component (batch 1/#8055's subnet-events.ts),
  // reused directly by block-events.ts/extrinsics.ts, not $ref'd by name.
  // BlockTimeDistribution/RuntimeVersionTransition/ValidatorNominatorEntry
  // are each referenced only by the one hand-edited component this batch
  // replaces (verified via repo-wide $ref grep). ColdkeyIdentity/
  // GlobalValidatorSubnet/ValidatorDetailSubnet are each referenced only by
  // this batch's own converted routes (ColdkeyIdentity: GlobalValidatorEntry,
  // ValidatorDetailArtifact, CompareValidatorEntry; GlobalValidatorSubnet:
  // GlobalValidatorEntry; ValidatorDetailSubnet: ValidatorDetailArtifact,
  // CompareValidatorEntry -- all converted together here), so all three
  // become fully orphaned too. GlobalValidatorEntry/CompareValidatorEntry
  // are each referenced only by the one hand-edited component this batch
  // replaces (GlobalValidatorsArtifact/CompareValidatorsArtifact
  // respectively -- verified via repo-wide $ref grep). None of these twelve
  // are worth a standalone registry entry; their hand-edited keys become
  // orphaned the moment their referrer(s) are Zod-owned and inline them
  // instead.
  "Block",
  "Extrinsic",
  "BlockTimeDistribution",
  "RuntimeVersionTransition",
  "ValidatorNominatorEntry",
  "ColdkeyIdentity",
  "GlobalValidatorSubnet",
  "ValidatorDetailSubnet",
  "GlobalValidatorEntry",
  "CompareValidatorEntry",
  // Batch 8 (#8062) additions: CompareSubnetEntry/CoverageDepthQueueEntry/
  // CurationEntry/GapsEntry/ReviewEnrichmentQueueEntry/
  // ReviewCandidateEvidence(+Summary)/ReviewEnrichmentTargetQueueContext/
  // ReviewEnrichmentTarget(+Group)/ReviewProfileCompletenessEntry, and the
  // 5 small Review* enums (ReviewEnrichmentLane/ReviewEvidenceAction/
  // ReviewEnrichmentTargetType/ReviewEnrichmentSubmissionRoute/
  // ReviewEnrichmentTargetAction) are each referenced only by this batch's
  // own converted routes, all converted together here (verified via
  // repo-wide $ref grep) -- same pattern as batch 7's Block/Extrinsic/
  // ColdkeyIdentity/etc. above. None is hardcoded by name in
  // scripts/generate-client.ts, src/contracts.ts, or
  // scripts/validate-schema-enums.ts either (unlike AdapterArtifact, which
  // stays registered above). Not worth a standalone registry entry; their
  // hand-edited keys become orphaned the moment their referrer(s) are
  // Zod-owned and inline them instead. (ReviewGapPriority/
  // ReviewAdapterCandidate/JsonObject/CoverageDepthRow are deliberately
  // NOT here -- ReviewCurationArtifact [still hand-edited, out of this
  // batch's scope] $refs the first two by name, src/contracts.ts hardcodes
  // the third, and scripts/validate-schema-enums.ts hardcodes the fourth
  // -- see OPENAPI_ZOD_COMPONENT_NAMES above instead.)
  "CompareSubnetEntry",
  "CoverageDepthQueueEntry",
  "CurationEntry",
  "GapsEntry",
  "ReviewEnrichmentLane",
  "ReviewEvidenceAction",
  "ReviewEnrichmentTargetType",
  "ReviewEnrichmentSubmissionRoute",
  "ReviewEnrichmentTargetAction",
  "ReviewCandidateEvidence",
  "ReviewCandidateEvidenceSummary",
  "ReviewEnrichmentTargetQueueContext",
  "ReviewEnrichmentQueueEntry",
  "ReviewEnrichmentEvidenceEntry",
  "ReviewEnrichmentTarget",
  "ReviewEnrichmentTargetGroup",
  "ReviewProfileCompletenessEntry",
  // Batch 10 (#8064) additions: ArtifactContractEntry/ArtifactDiffEntry/
  // ApiRoute/ApiQueryParameter/ResponseEnvelopeContract/ArtifactSizeBudget/
  // CoverageDelta (meta-contracts.ts), FreshnessSource/SourceHealthProvider/
  // SourceSnapshot/SearchDocument/SearchIndexDocument (evidence-search.ts),
  // RpcEndpoint/RpcPoolEndpoint/EndpointProviderScore (providers-rpc.ts),
  // SchemaIndexEntry (subnet-profiles.ts), AgentServiceSchemaSource/
  // AgentServiceFixtureStatus/SurfaceFixtureReference (agent-catalog.ts) are
  // each referenced only by the one (or, where multiple components in this
  // batch share a name, only this batch's own) hand-edited component(s) this
  // batch replaces -- verified via repo-wide $ref grep, same test as every
  // prior batch's additions. CountMap/ProviderKind/EndpointSummary are
  // deliberately NOT here -- each still has a referrer outside this batch
  // (verified the same way); this batch's own local Zod copies stay
  // unregistered rather than orphaning the hand-edited original.
  // AgentReadinessStatus/Provider/RpcPool/SubnetDetail are also deliberately
  // NOT here despite this batch replacing their sole (or, for SubnetDetail,
  // only remaining) hand-edited $ref -- see their own register() calls
  // above: all three are required by validate-schema-enums.ts's hardcoded
  // property-enum lookup or generated/metagraphed-client.ts's hardcoded
  // components["schemas"] type lookups, caught by the full validate suite
  // and `npm run typecheck` respectively, not by $ref-grep alone.
  // (AgentReadinessBlocker isn't this batch's concern at all -- batch 8
  // already registers it from schemas-src/routes/coverage.ts, reused here
  // by import, not $ref.)
  "ArtifactContractEntry",
  "ArtifactDiffEntry",
  "ApiRoute",
  "ApiQueryParameter",
  "ResponseEnvelopeContract",
  "ArtifactSizeBudget",
  "CoverageDelta",
  "FreshnessSource",
  "SourceHealthProvider",
  "SourceSnapshot",
  "SearchDocument",
  "SearchIndexDocument",
  "RpcEndpoint",
  "RpcPoolEndpoint",
  "EndpointProviderScore",
  "SchemaIndexEntry",
  "AgentServiceSchemaSource",
  "AgentServiceFixtureStatus",
  "SurfaceFixtureReference",
  // Batch 9 (#8063) additions: HealthHistorySurface (1 referrer,
  // HealthHistoryArtifact, this batch's own) and ReliabilityScore (2
  // referrers, both within this batch's own UptimeArtifact -- intra-
  // component reuse, same treatment as batch 6's ChainTransferParty) are
  // each referenced only by this batch's own converted routes, verified via
  // repo-wide $ref grep. EndpointIncidentSummary is referenced only by this
  // batch's own EndpointIncidentsArtifact (verified the same way) -- not
  // worth a standalone registry entry, unlike EndpointIncident/EvidenceClaim/
  // EndpointSummary above (each hardcoded by name or referenced across
  // batches, see their own register() calls). None of these three is
  // hardcoded in scripts/generate-client.ts or
  // scripts/validate-schema-enums.ts either.
  "HealthHistorySurface",
  "ReliabilityScore",
  "EndpointIncidentSummary",
] as const;
