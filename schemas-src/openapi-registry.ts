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
import {
  SubnetsArtifactSchema,
  SubnetIndexEntrySchema,
} from "./routes/subnets.ts";
import {
  SubnetDetailArtifactSchema,
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
import { SubnetAlphaVolumeArtifactSchema } from "./routes/subnet-alpha-volume.ts";
import {
  SubnetAxonRemovalsArtifactSchema,
  SubnetDeregistrationsArtifactSchema,
  SubnetRegistrationsArtifactSchema,
  SubnetServingArtifactSchema,
} from "./routes/subnet-activity.ts";
import {
  SubnetBurnArtifactSchema,
  SubnetRecycledArtifactSchema,
} from "./routes/subnet-registration-cost.ts";
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
register(SubnetRecycledArtifactSchema, "SubnetRecycledArtifact");
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
// ConcentrationMetrics/ScoreDistribution: still referenced by name from
// AccountPortfolioArtifact/BlocksSummaryArtifact/ChainConcentrationArtifact/
// ChainPerformanceArtifact, all still hand-edited (verified via repo-wide
// $ref grep) -- unlike this batch's other shared sub-shapes, these must stay
// registered, not orphaned.
register(ConcentrationMetricsSchema, "ConcentrationMetrics");
register(ScoreDistributionSchema, "ScoreDistribution");

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
  // and `ChainEvent` deliberately stay registered/untouched -- both have
  // referrers outside this batch (block/extrinsic-detail routes, out of
  // scope until batch 7) -- this batch's own chain-events.ts models
  // ChainEvent's shape with a local unregistered copy instead (same pattern
  // batch 5 used for Extrinsic/EntityLabel).
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
] as const;
