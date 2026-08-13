// The published GraphQL names, declared (#10214).
//
// WHY THIS FILE EXISTS. `validate-graphql-component-parity.ts` pairs an SDL
// type with the Zod component it mirrors by COMPUTING the pairing: it seeds
// from each Query field's `Mirrors GET …` annotation and propagates through
// same-named fields. That works only while the hand-written SDL exists, and it
// is the artefact #10214 deletes. No rule derives the published name `Subnet`
// from the component name `SubnetIndexEntry` -- the names ARE the public
// contract, so they are declared here rather than inferred.
//
// Extracted from `src/graphql-sdl.ts` at the commit that added this file and
// then frozen: from here the map is the source and the SDL is checked against
// IT, not the other way round. The gate asserts both directions, so an entry
// that stops matching the SDL fails, and so does an SDL type with no entry.
//
// MANY COMPONENTS, ONE PUBLISHED NAME is normal and intended: `DegradedInfo`
// is the published name of 11 separate `…Degraded` sub-shapes that are
// structurally identical. The generator collapses them, which is what the SDL
// already does by hand.
//
// ONE COMPONENT, TWO PUBLISHED NAMES happens exactly once and is a defect the
// hand-written SDL carries: `SubnetAlphaVolumeArtifact` is published as
// `SubnetVolume` from its own route and as `ChainAlphaVolumeSubnet` from
// inside the chain rollup, with identical fields. Declared below so the
// generator reproduces today's contract byte-for-byte; collapsing the two is a
// published-schema change and belongs in its own issue.

import {
  GRAPHQL_EXPOSURES,
  SUBSCRIPTION_EXPOSURES,
  type GraphqlExposure,
} from "./query-exposures.ts";
import { operationPath } from "../../src/operations.ts";

/**
 * The one component the published schema names TWICE, and its second name.
 *
 * `SubnetAlphaVolumeArtifact` is `SubnetVolume` when reached from its own route
 * and `ChainAlphaVolumeSubnet` when reached from inside the chain rollup, with
 * field-for-field identical shapes. Declared rather than fixed: collapsing them
 * removes a type from the published schema, which is a breaking change for any
 * client that names it, and belongs in its own issue.
 */
export const ALIASED_TYPE_NAMES: Readonly<Record<string, string>> = {
  SubnetAlphaVolumeArtifact: "ChainAlphaVolumeSubnet",
};

/** Component id -> the name the published schema gives it. */
export const PUBLISHED_TYPE_NAMES: Readonly<Record<string, string>> = {
  // The seven a `route: null` binding kept out of this check until #10772:
  // the field named no route, so its response component was never paired
  // with the type the SDL publishes for it. Naming the route surfaced all
  // seven at once -- they are not new types, they are the ones that were
  // never compared.
  BlockChainEventsArtifact: "BlockChainEvents",
  ExtrinsicDetailArtifact: "ExtrinsicDetail",
  HealthSummaryArtifact: "GlobalHealth",
  ProvidersArtifact: "ProviderList",
  SubnetsArtifact: "SubnetList",
  AccountPortfolioArtifactStakeConcentration: "ConcentrationMetrics",
  BlocksSummaryArtifactAuthorConcentration: "ConcentrationMetrics",
  ChainConcentrationArtifactEmission: "ConcentrationMetrics",
  ChainConcentrationArtifactEntityEmission: "ConcentrationMetrics",
  ChainConcentrationArtifactEntityStake: "ConcentrationMetrics",
  ChainConcentrationArtifactStake: "ConcentrationMetrics",
  ChainConcentrationArtifactValidatorStake: "ConcentrationMetrics",
  ChainPerformanceArtifactConsensus: "ScoreDistribution",
  ChainPerformanceArtifactDividends: "ConcentrationMetrics",
  ChainPerformanceArtifactIncentive: "ConcentrationMetrics",
  ChainPerformanceArtifactTrust: "ScoreDistribution",
  ChainPerformanceArtifactValidatorTrust: "ScoreDistribution",
  SubnetConcentrationArtifactEmission: "ConcentrationMetrics",
  SubnetConcentrationArtifactEntityEmission: "ConcentrationMetrics",
  SubnetConcentrationArtifactEntityStake: "ConcentrationMetrics",
  SubnetConcentrationArtifactStake: "ConcentrationMetrics",
  SubnetConcentrationArtifactValidatorStake: "ConcentrationMetrics",
  SubnetPerformanceArtifactConsensus: "ScoreDistribution",
  SubnetPerformanceArtifactDividends: "ConcentrationMetrics",
  SubnetPerformanceArtifactIncentive: "ConcentrationMetrics",
  SubnetPerformanceArtifactTrust: "ScoreDistribution",
  SubnetPerformanceArtifactValidatorTrust: "ScoreDistribution",
  // The two meta documents' own vocabulary, published for the first time in
  // #10790 -- /api/v1/contracts has always served `feeds` and `networks` and
  // neither component declared them, so GraphQL could not select either.
  //
  // The emitter names a nested shape after the FIELD that holds it, so one Zod
  // schema reached through two fields comes out as two components:
  // `ApiQueryParameterSchema` is `ContractsArtifactFeedsPathParameters` under
  // one and `...QueryParameters` under the other. Both land on ONE published
  // name, which is sound precisely because it is one schema -- there is no
  // second declaration that could drift away from the first.
  ContractsArtifactFeeds: "ContractsFeed",
  ContractsArtifactFeedsPathParameters: "ContractsFeedParameter",
  ContractsArtifactFeedsQueryParameters: "ContractsFeedParameter",
  ContractsArtifactNetworks: "ContractsNetworks",
  BuildSummaryArtifactSchemaIndexDiscard: "BuildSummarySchemaIndexDiscard",
  // The upgrade radar (#10790), published on GraphQL for the first time. The
  // emitter names a nested shape after the field that holds it; these are the
  // names the published schema gives them.
  RuntimeVersionsArtifactCurrent: "UpgradeRadar",
  RuntimeVersionsArtifactCurrentMainnet: "ChainSpecReading",
  RuntimeVersionsArtifactCurrentTestnet: "ChainSpecReading",
  RuntimeVersionsArtifactCurrentLatestRelease: "SubtensorRelease",
  ChainBurnArtifact: "ChainBurn",
  ChainBurnEntry: "ChainBurnEntry",
  ChainState: "EmissionPipelineChainState",
  DegradedInfo: "DegradedInfo",
  DeregistrationDerivation: "DeregistrationDerivation",
  IntensityDistribution: "IntensityDistribution",
  SubnetBurnHistoryArtifact: "SubnetBurnHistory",
  SubnetBurnHistoryPoint: "SubnetBurnHistoryPoint",
  UnavailableDegraded: "UnavailableDegraded",
  AccountAxonRemovalsArtifact: "AccountAxonRemovals",
  AccountAxonRemovalsArtifactSubnets: "AccountAxonRemovalSubnet",
  AccountBalanceArtifact: "AccountBalance",
  AccountChildrenArtifact: "AccountChildren",
  AccountChildrenArtifactSubnets: "AccountChildSubnet",
  AccountChildrenArtifactSubnetsEntries: "AccountChildEntry",
  AccountCounterpartiesArtifact: "AccountCounterparties",
  AccountCounterpartiesArtifactCounterparties: "AccountCounterparty",
  AccountCounterpartiesArtifactRelationship: "AccountCounterpartyRelationship",
  AccountCounterpartiesArtifactRelationshipTransfers:
    "AccountCounterpartyTransfer",
  AccountDeregistrationsArtifact: "AccountDeregistrations",
  AccountDeregistrationsArtifactSubnets: "AccountDeregistrationSubnet",
  AccountEntitiesArtifact: "AccountEntities",
  AccountEntitiesArtifactLabels: "AccountEntityLabel",
  AccountEntitiesArtifactOwnershipTies: "AccountOwnershipTie",
  AccountEvent: "AccountEvent",
  AccountEventsArtifact: "AccountEvents",
  AccountExtrinsicsArtifact: "AccountExtrinsics",
  AccountExtrinsicsArtifactExtrinsics: "Extrinsic",
  // The same row shape reached three ways -- an account's extrinsics, the
  // global feed, and one extrinsic's detail -- published under one name. All
  // three components emit the identical twelve fields; naming only the first
  // left the other two reading as a type mismatch the moment the projection
  // pass started comparing types at all (#10409).
  ExtrinsicsFeedArtifactExtrinsics: "Extrinsic",
  ExtrinsicDetailArtifactExtrinsic: "Extrinsic",
  AccountHistoryArtifact: "AccountHistory",
  AccountHistoryArtifactDays: "AccountDay",
  AccountIdentityArtifact: "AccountIdentity",
  AccountIdentityHistoryArtifact: "AccountIdentityHistory",
  AccountIdentityHistoryArtifactEntries: "AccountIdentityHistoryEntry",
  AccountParentsArtifact: "AccountParents",
  AccountParentsArtifactSubnets: "AccountParentSubnet",
  AccountParentsArtifactSubnetsEntries: "AccountParentEntry",
  AccountPortfolioArtifact: "AccountPortfolio",
  AccountPortfolioArtifactPositions: "AccountPortfolioPosition",
  AccountsListArtifactAccountsSubnets: "AccountSubnet",
  // The one GraphQL-only component whose published name differs from its
  // own (#10409): the component is named for the firehose that produces
  // it, the type for what a subscriber reads. `OpportunityBoards` and
  // `EmissionGateChange` are published under their component names and so
  // need no entry.
  ChainFirehoseEvent: "ChainEvent",
  EndpointIncident: "EndpointIncident",
  AccountPositionHistoryArtifact: "AccountPositionHistory",
  AccountPositionHistoryArtifactPoints: "AccountPositionHistoryPoint",
  AccountPositionsArtifact: "AccountPositions",
  AccountPositionsArtifactDegraded: "AccountPositionsDegraded",
  AccountPositionsArtifactPositions: "NominatorPosition",
  AccountPrometheusArtifact: "AccountPrometheus",
  AccountPrometheusArtifactSubnets: "AccountPrometheusSubnet",
  AccountRegistrationsArtifact: "AccountRegistrations",
  AccountRegistrationsArtifactSubnets: "AccountRegistrationSubnet",
  AccountRootClaimArtifact: "AccountRootClaim",
  AccountRootClaimArtifactClaimType: "RootClaimType",
  AccountRootClaimArtifactHotkeys: "RootClaimHotkey",
  AccountRootClaimArtifactHotkeysEntries: "RootClaimEntry",
  AccountServingArtifact: "AccountServing",
  AccountServingArtifactSubnets: "AccountServingSubnet",
  AccountStakeFlowArtifact: "AccountStakeFlow",
  AccountStakeFlowArtifactSubnets: "AccountStakeFlowSubnet",
  AccountStakeMovesArtifact: "AccountStakeMoves",
  AccountStakeMovesArtifactSubnets: "AccountStakeMoveSubnet",
  AccountSubnetsArtifact: "AccountSubnets",
  AccountSubnetsArtifactSubnets: "AccountRegistration",
  AccountSummaryArtifact: "AccountSummary",
  AccountSummaryArtifactActivity: "AccountActivity",
  AccountSummaryArtifactActivityModulesCalled: "AccountModuleCall",
  AccountSummaryArtifactEventKinds: "AccountEventKind",
  AccountSummaryArtifactLabels: "AccountLabel",
  AccountSummaryArtifactRegistrations: "AccountRegistration",
  AccountTransfersArtifact: "AccountTransfers",
  AccountTransfersArtifactTransfers: "AccountTransfer",
  AccountWeightSettersArtifact: "AccountWeightSetters",
  AccountWeightSettersArtifactSubnets: "AccountWeightSettersSubnet",
  AccountsListArtifact: "AccountList",
  AdapterArtifact: "Adapter",
  BlockDetailArtifact: "BlockDetail",
  BlockDetailArtifactBlock: "Block",
  // Field for field the same eight as the detail component.
  BlocksFeedArtifactBlocks: "Block",
  BlockEventsArtifact: "BlockEvents",
  BlockExtrinsicsArtifact: "BlockExtrinsics",
  BlocksFeedArtifact: "BlockList",
  BlocksSummaryArtifact: "BlocksSummary",
  BlocksSummaryArtifactBlockTime: "BlockTimeDistribution",
  BlocksSummaryArtifactThroughput: "BlocksThroughput",
  BuildSummaryArtifact: "BuildSummary",
  BuildSummaryArtifactArtifactBudgets: "BuildArtifactBudget",
  BuildSummaryArtifactPublicContract: "BuildPublicContract",
  BulkHealthTrendsArtifact: "HealthTrends",
  ChainActivityArtifact: "ChainActivity",
  ChainActivityArtifactDays: "ChainActivityDay",
  ChainAlphaVolumeArtifact: "ChainAlphaVolume",
  ChainAlphaVolumeArtifactNetwork: "ChainAlphaVolumeNetwork",
  // Several routes emit structurally identical inline components, so each set
  // maps onto ONE published type rather than N types with different names.
  // Declared rather than left as JSON: these shapes are fixed and small, and an
  // under-typing is a field a caller cannot select.
  SubnetOhlcArtifactFieldSourcesUsd: "AlphaUsdFieldSource",
  EconomicsTrendsArtifactFieldSourcesUsd: "AlphaUsdFieldSource",
  ChainAlphaVolumeArtifactTaoUsd: "TaoUsdConversion",
  SubnetAlphaVolumeArtifactTaoUsd: "TaoUsdConversion",
  ChainAxonRemovalsArtifact: "ChainAxonRemovals",
  ChainAxonRemovalsArtifactNetwork: "ChainAxonRemovalsNetwork",
  ChainAxonRemovalsArtifactSubnets: "ChainAxonRemovalsSubnet",
  ChainCallsArtifact: "ChainCalls",
  ChainCallsArtifactCalls: "ChainCall",
  ChainConcentrationArtifact: "ChainConcentration",
  ChainConcentrationHistoryArtifact: "ChainConcentrationHistory",
  ChainConcentrationHistoryPoint: "ChainConcentrationHistoryPoint",
  ChainDeregistrationsArtifact: "ChainDeregistrations",
  ChainDeregistrationsArtifactNetwork: "ChainDeregistrationsNetwork",
  ChainDeregistrationsArtifactNetworkTenure: "DeregistrationTenure",
  ChainDeregistrationsArtifactSubnets: "ChainDeregistrationsSubnet",
  ChainDeregistrationsArtifactSubnetsTenure: "DeregistrationTenure",
  ChainEventsFeedArtifact: "ChainEventsFeed",
  ChainEventsFeedArtifactEvents: "ChainEventRow",
  ChainEventsStatsArtifact: "ChainEventsStats",
  ChainEventsStatsArtifactActivity: "ChainEventsStatsRow",
  ChainFeesArtifact: "ChainFees",
  ChainFeesArtifactDaily: "ChainFeesDay",
  ChainFeesArtifactTopFeePayers: "ChainFeePayer",
  ChainHoldersArtifact: "ChainHolders",
  ChainHoldersArtifactDegraded: "DegradedInfo",
  ChainHoldersNetwork: "ChainHoldersNetwork",
  ChainHoldersSubnet: "ChainHoldersSubnet",
  ChainIdentityHistoryArtifact: "ChainIdentityHistory",
  ChainIdentityHistoryArtifactChanges: "ChainIdentityHistoryEntry",
  ChainIdleStakeArtifact: "ChainIdleStake",
  ChainIdleStakeArtifactSubnets: "ChainIdleStakeSubnet",
  ChainPerformanceArtifact: "ChainPerformance",
  ChainPrometheusArtifact: "ChainPrometheus",
  ChainPrometheusArtifactNetwork: "ChainPrometheusNetwork",
  ChainPrometheusArtifactSubnets: "ChainPrometheusSubnet",
  ChainRegistrationsArtifact: "ChainRegistrations",
  ChainRegistrationsArtifactNetwork: "ChainRegistrationsNetwork",
  ChainRegistrationsArtifactSubnets: "ChainRegistrationsSubnet",
  ChainServingArtifact: "ChainServing",
  ChainServingArtifactNetwork: "ChainServingNetwork",
  ChainServingArtifactSubnets: "ChainServingSubnet",
  ChainSignersArtifact: "ChainSigners",
  ChainSignersArtifactSigners: "ChainSigner",
  ChainStakeFlowArtifact: "ChainStakeFlow",
  ChainStakeFlowArtifactNetFlowDistribution: "ChainStakeFlowDistribution",
  ChainStakeFlowArtifactNetwork: "ChainStakeFlowNetwork",
  ChainStakeFlowArtifactSubnets: "ChainStakeFlowSubnet",
  ChainStakeMovesArtifact: "ChainStakeMoves",
  ChainStakeMovesArtifactNetwork: "ChainStakeMovesNetwork",
  ChainStakeMovesArtifactSubnets: "ChainStakeMovesSubnet",
  ChainStakeTransfersArtifact: "ChainStakeTransfers",
  ChainStakeTransfersArtifactNetwork: "ChainStakeTransfersNetwork",
  ChainStakeTransfersArtifactSubnets: "ChainStakeTransfersSubnet",
  ChainSubnetLifecycleArtifact: "ChainSubnetLifecycle",
  ChainSubnetLifecycleArtifactEntries: "SubnetLifecycleEntry",
  ChainTransferPairsArtifact: "ChainTransferPairs",
  ChainTransferPairsArtifactPairs: "ChainTransferPair",
  ChainTransfersArtifact: "ChainTransfers",
  ChainTransfersArtifactTopReceivers: "ChainTransferParty",
  ChainTransfersArtifactTopSenders: "ChainTransferParty",
  ChainTurnoverArtifact: "ChainTurnover",
  ChainTurnoverArtifactNetwork: "ChainTurnoverNetwork",
  ChainTurnoverArtifactStabilityDistribution:
    "ChainTurnoverStabilityDistribution",
  ChainTurnoverArtifactSubnets: "ChainTurnoverSubnet",
  ChainWeightSettersArtifact: "ChainWeightSetters",
  ChainWeightSettersArtifactSetters: "ChainWeightSetter",
  ChainWeightsArtifact: "ChainWeights",
  ChainWeightsArtifactNetwork: "ChainWeightsNetwork",
  ChainWeightsArtifactSubnets: "ChainWeightsSubnet",
  ChainYieldArtifact: "ChainYield",
  ChainYieldArtifactDistribution: "YieldDistribution",
  ChangelogArtifact: "Changelog",
  CompareArtifact: "Compare",
  CompareArtifactSubnets: "CompareSubnet",
  CompareArtifactSubnetsEconomics: "CompareEconomics",
  CompareArtifactSubnetsHealth: "CompareHealth",
  CompareArtifactSubnetsStructure: "CompareStructure",
  CompareValidatorsArtifact: "ValidatorComparison",
  CompareValidatorsArtifactValidators: "ComparedValidator",
  ContractsArtifact: "Contracts",
  CurationArtifact: "CurationList",
  DomainSummaryArtifact: "DomainSummary",
  DomainSummaryArtifactEmissionConcentration: "ConcentrationMetrics",
  DomainsArtifact: "DomainOverview",
  EconomicsArtifact: "EconomicsList",
  SubnetEconomics: "SubnetEconomics",
  EconomicsArtifactSummary: "EconomicsSummary",
  EconomicsTrendsArtifact: "EconomicsTrends",
  EconomicsTrendsArtifactDays: "EconomicsTrendsDay",
  EmissionGateChangesArtifact: "EmissionGateChanges",
  // #10476: the coverage ratio. Both artifacts nest the SAME SubnetRevenue
  // shape, so the per-subnet card and the network table resolve to one type
  // rather than two structurally identical ones.
  SubnetRevenueArtifact: "SubnetRevenueCard",
  SubnetRevenueArtifactRevenue: "SubnetRevenue",
  SubnetRevenueArtifactRevenueEmission: "RevenueEmission",
  SubnetRevenueArtifactRevenueEmissionAlternates: "RevenueEmissionAlternates",
  SubnetRevenueArtifactRevenueEmissionAlternatesAlphaOutPriced:
    "RevenueCoverageBasis",
  SubnetRevenueArtifactRevenueEmissionAlternatesOwnerTake:
    "RevenueCoverageBasis",
  SubnetRevenueArtifactRevenueSources: "RevenueSource",
  SubnetRevenueArtifactRevenueVerification: "RevenueVerification",
  SubnetRevenueArtifactRevenueVerificationChecks: "RevenueVerificationCheck",
  ChainRevenueCoverageArtifact: "ChainRevenueCoverage",
  ChainRevenueCoverageArtifactSubnets: "SubnetRevenue",
  ChainRevenueCoverageArtifactSubnetsEmission: "RevenueEmission",
  ChainRevenueCoverageArtifactSubnetsEmissionAlternates:
    "RevenueEmissionAlternates",
  ChainRevenueCoverageArtifactSubnetsEmissionAlternatesAlphaOutPriced:
    "RevenueCoverageBasis",
  ChainRevenueCoverageArtifactSubnetsEmissionAlternatesOwnerTake:
    "RevenueCoverageBasis",
  ChainRevenueCoverageArtifactSubnetsSources: "RevenueSource",
  ChainRevenueCoverageArtifactSubnetsVerification: "RevenueVerification",
  ChainRevenueCoverageArtifactSubnetsVerificationChecks:
    "RevenueVerificationCheck",
  EmissionPipelineArtifact: "EmissionPipeline",
  EmissionPipelineArtifactAggregate: "EmissionPipelineAggregate",
  EmissionPipelineArtifactSubnets: "SubnetEmissionDecomposition",
  EmissionPipelineArtifactVerification: "EmissionPipelineVerification",
  EmissionPipelineArtifactVerificationChecks: "EmissionIdentityCheck",
  EndpointIncidentsArtifact: "IncidentList",
  EndpointPoolsArtifact: "EndpointPoolList",
  EndpointsArtifact: "EndpointList",
  EvidenceLedgerArtifact: "EvidenceList",
  EvmAddressMappingArtifact: "EvmAddressMapping",
  ExtrinsicsFeedArtifact: "ExtrinsicList",
  FailureReason: "FailureReason",
  FailureReasonsArtifact: "FailureReasons",
  FailureReasonsDay: "FailureReasonsDay",
  GapsArtifact: "GapsList",
  GlobalIncidentsArtifact: "GlobalIncidents",
  // A per-surface incident ROLLUP (surface_id/netuid/incident_count/
  // downtime_ms), not an endpoint incident. Mapping it to
  // `EndpointIncident` published rows that answered null for all 18 of that
  // type's own fields, on every one of 232 sampled -- harmless only because
  // the SDL declared them nullable; the generated schema declares them
  // non-null and would have nulled every row (#10214).
  GlobalIncidentsArtifactSurfaces: "GlobalIncidentSurface",
  GlobalIncidentsArtifactSurfacesIncidents: "EndpointIncidentWindow",
  GlobalValidatorsArtifact: "ValidatorList",
  HealthHistoryArtifact: "HealthHistory",
  HealthIncidentsArtifact: "SubnetHealthIncidents",
  HealthPercentilesArtifact: "SubnetHealthPercentiles",
  HealthTrendsArtifact: "SubnetHealthTrends",
  IndexerLagArtifact: "IndexerLag",
  IndexerLagArtifactDegraded: "IndexerLagDegraded",
  IndexerLagLatency: "IndexerLagLatency",
  IndexerLagWindow: "IndexerLagWindow",
  NetworkParametersArtifact: "NetworkParameters",
  NeuronDetailArtifact: "Neuron",
  NeuronDetailArtifactNeuron: "NeuronState",
  NeuronHistoryArtifact: "NeuronHistory",
  NeuronHistoryArtifactPoints: "NeuronHistoryPoint",
  PipelineHistoryArtifact: "SubnetPipelineHistory",
  PipelineHistoryPoint: "PipelineHistoryPoint",
  RandomnessArtifact: "NetworkRandomness",
  RegistryLeaderboardsArtifact: "RegistryLeaderboards",
  ReviewAdapterCandidatesArtifact: "ReviewAdapterCandidateList",
  ReviewEnrichmentEvidenceArtifact: "ReviewEnrichmentEvidenceList",
  ReviewEnrichmentQueueArtifact: "ReviewEnrichmentQueueList",
  ReviewEnrichmentTargetsArtifact: "ReviewEnrichmentTargetList",
  ReviewGapPrioritiesArtifact: "ReviewGapPriorityList",
  ReviewProfileCompletenessArtifact: "ReviewProfileCompletenessList",
  RpcPoolsArtifact: "PoolList",
  RpcUsageArtifact: "RpcUsage",
  RpcUsageArtifactBuckets: "RpcUsageBucket",
  RpcUsageArtifactCoverage: "RpcUsageCoverage",
  RpcUsageArtifactCoverageLatencyPercentiles: "RpcUsageCoverageRange",
  RpcUsageArtifactCoverageSegments: "RpcUsageCoverageSegment",
  RpcUsageArtifactEndpoints: "RpcUsageEndpoint",
  RpcUsageArtifactNetworks: "RpcUsageNetwork",
  RpcUsageArtifactSummary: "RpcUsageSummary",
  RpcUsageArtifactSummaryLatencyMs: "RpcUsageLatency",
  RuntimeVersionsArtifact: "RuntimeVersionHistory",
  RuntimeVersionsArtifactCoverageGaps: "RuntimeCoverageGap",
  RuntimeVersionsArtifactTransitions: "RuntimeTransition",
  SearchArtifact: "SearchDocumentList",
  SearchIndexArtifact: "SearchIndexList",
  SelfHealthArtifact: "SelfHealth",
  SelfHealthComponent: "SelfHealthComponentView",
  SelfHealthDay: "SelfHealthDay",
  SelfHealthLane: "SelfHealthLane",
  SourceSnapshotsArtifact: "SourceSnapshotList",
  SubnetAlphaVolumeArtifact: "SubnetVolume",
  SubnetAxonRemovalsArtifact: "SubnetAxonRemovals",
  SubnetBurnArtifact: "SubnetBurn",
  SubnetConcentrationArtifact: "SubnetConcentration",
  SubnetConcentrationHistoryArtifact: "SubnetConcentrationHistory",
  SubnetConcentrationHistoryArtifactPoints: "SubnetConcentrationHistoryPoint",
  SubnetConvictionArtifact: "SubnetConviction",
  SubnetDeregistrationsArtifact: "SubnetDeregistrations",
  SubnetDeregistrationsArtifactEvents: "SubnetDeregistrationEvent",
  SubnetEventSummaryArtifact: "SubnetEventSummary",
  SubnetEventsArtifact: "SubnetEvents",
  SubnetHistoryArtifact: "SubnetHistory",
  SubnetHistoryArtifactPoints: "SubnetHistoryPoint",
  SubnetHolder: "SubnetHolder",
  SubnetHoldersArtifact: "SubnetHolders",
  SubnetHoldersConcentration: "SubnetHoldersConcentration",
  SubnetHoldersDegraded: "DegradedInfo",
  SubnetHyperparametersArtifact: "SubnetHyperparameters",
  SubnetHyperparametersArtifactHyperparameters: "Hyperparameters",
  SubnetHyperparamsHistoryArtifact: "SubnetHyperparamsHistory",
  SubnetHyperparamsHistoryArtifactEntries: "HyperparamsHistoryEntry",
  SubnetHyperparamsHistoryArtifactEntriesHyperparameters: "Hyperparameters",
  SubnetIdentityHistoryArtifact: "SubnetIdentityHistory",
  SubnetIdentityHistoryArtifactEntries: "SubnetIdentityHistoryEntry",
  SubnetIdleStakeArtifact: "SubnetIdleStake",
  SubnetLeaseArtifact: "SubnetLease",
  SubnetLeaseHistoryArtifact: "SubnetLeaseHistory",
  SubnetLifecycleArtifact: "SubnetLifecycle",
  SubnetLifecycleArtifactEntries: "SubnetLifecycleEntry",
  SubnetMoversArtifact: "SubnetMovers",
  SubnetMoversArtifactMovers: "SubnetMover",
  SubnetMoversArtifactNetwork: "SubnetMoversNetwork",
  SubnetOhlcArtifact: "SubnetOhlc",
  SubnetOhlcArtifactCandles: "SubnetOhlcCandle",
  SubnetOwnershipHistoryArtifact: "SubnetOwnershipHistory",
  SubnetPerformanceArtifact: "SubnetPerformance",
  SubnetPerformanceHistoryArtifact: "SubnetPerformanceHistory",
  SubnetPerformanceHistoryArtifactPoints: "SubnetPerformanceHistoryPoint",
  SubnetProfilesArtifact: "ProfileList",
  SubnetPrometheusArtifact: "SubnetPrometheus",
  SubnetRecycledArtifact: "SubnetRecycled",
  SubnetRegistrationsArtifact: "SubnetRegistrations",
  SubnetServingArtifact: "SubnetServing",
  SubnetStakeFlowArtifact: "SubnetStakeFlow",
  SubnetStakeMovesArtifact: "SubnetStakeMoves",
  SubnetStakeQuoteArtifact: "SubnetStakeQuote",
  SubnetStakeTransfersArtifact: "SubnetStakeTransfers",
  SubnetSurfaceHistoryArtifact: "SubnetSurfaceHistory",
  SubnetTrajectoryArtifact: "SubnetTrajectory",
  SubnetTrajectoryArtifactPoints: "SubnetTrajectoryPoint",
  SubnetTurnoverArtifact: "SubnetTurnover",
  SubnetTurnoverArtifactChanges: "SubnetTurnoverChanges",
  SubnetTurnoverArtifactChangesUidReassignments: "TurnoverUidReassignment",
  SubnetTurnoverArtifactChangesValidatorsEntered: "TurnoverValidatorChange",
  SubnetTurnoverArtifactChangesValidatorsExited: "TurnoverValidatorChange",
  SubnetValidatorEconomicsArtifact: "SubnetValidatorEconomics",
  SubnetValidatorEconomicsHistoryArtifact: "SubnetValidatorEconomicsHistory",
  SubnetValidatorsArtifact: "SubnetValidatorList",
  SubnetValidatorsArtifactValidators: "NeuronState",
  SubnetWeightSettersArtifact: "SubnetWeightSetters",
  SubnetWeightSettersArtifactSetters: "SubnetWeightSetter",
  SubnetWeightsArtifact: "SubnetWeights",
  SubnetYieldArtifact: "SubnetYield",
  SubnetYieldArtifactNeurons: "SubnetYieldNeuron",
  SubnetEmissionSplitHistoryArtifact: "SubnetEmissionSplitHistory",
  SubnetEmissionSplitHistoryArtifactPoints: "SubnetEmissionSplitHistoryPoint",
  SubnetMinerFairnessArtifact: "SubnetMinerFairness",
  SubnetMinerFairnessArtifactPoints: "SubnetMinerFairnessPoint",
  SubnetMinerFairnessArtifactPersistence: "SubnetMinerFairnessPersistence",
  SubnetMinerFairnessArtifactConcentration: "SubnetMinerFairnessConcentration",
  // Both lenses collapse onto the ONE published component. The schema is
  // already shared in source (ConcentrationMetricsSchema); these entries are
  // what makes the reuse visible in the published contract rather than
  // minting two look-alike types nothing can compare.
  SubnetMinerFairnessArtifactConcentrationEntity: "ConcentrationMetrics",
  SubnetMinerFairnessArtifactConcentrationUid: "ConcentrationMetrics",
  SubnetOwnerCaptureArtifact: "SubnetOwnerCapture",
  SubnetOwnerCaptureArtifactPoints: "SubnetOwnerCapturePoint",
  SubnetOwnerCaptureArtifactOwnerUids: "SubnetOwnerCaptureUid",
  SubnetOwnerCaptureArtifactAttribution: "SubnetOwnerCaptureStakeholder",
  // Real evidence objects now, not `z.unknown()` -- the array reuses the
  // shared AttributionEvidence shape, so it publishes a nested component.
  SubnetOwnerCaptureArtifactAttributionEvidence: "AttributionEvidence",
  SubnetOwnerCaptureArtifactBlindSpots: "SubnetOwnerCaptureBlindSpot",
  SubnetYieldHistoryArtifact: "SubnetYieldHistory",
  SubnetYieldHistoryArtifactPoints: "SubnetYieldHistoryPoint",
  SudoKeyArtifact: "SudoKey",
  SurfaceHistoryChange: "SurfaceHistoryChange",
  SurfacesArtifact: "SurfaceList",
  TaoUsdArtifact: "TaoUsd",
  TaoUsdLatest: "TaoUsdLatest",
  TaoUsdPoint: "TaoUsdPoint",
  UptimeArtifact: "SubnetUptime",
  UptimeArtifactReliability: "UptimeReliability",
  UptimeArtifactSurfaces: "UptimeSurface",
  UptimeArtifactSurfacesDays: "UptimeDay",
  UptimeArtifactSurfacesDaysLatencyMs: "UptimeLatency",
  UptimeArtifactSurfacesReliability: "UptimeReliability",
  ValidatorDetailArtifact: "Validator",
  // `validatorNode` (src/graphql.ts) normalizes the two producers into one
  // published shape on purpose: the list entry names its timestamps
  // latest_captured_at/latest_block_number and the detail aggregate names
  // them captured_at/block_number. Where they genuinely differ -- featured,
  // uid_count and stake_dominance are list-only -- the SDL publishes them
  // nullable and documents the null, rather than declaring two types.
  GlobalValidatorsArtifactValidators: "Validator",
  ValidatorDetailArtifactColdkeyIdentity: "Identity",
  ValidatorDetailArtifactSubnets: "ValidatorSubnet",
  // The list producer's nested rows, reachable only once the traversal steps
  // through `ValidatorList.items` (#10409). The identity is field for field
  // the detail's; the membership row is the leaderboard's compact five, a
  // subset of the detail's eighteen -- one published type over two producers,
  // which is what `ValidatorSubnet`'s own SDL comment already describes. Both
  // fields the SDL declares non-null (netuid, uid) are non-null on both sides.
  GlobalValidatorsArtifactValidatorsColdkeyIdentity: "Identity",
  GlobalValidatorsArtifactValidatorsSubnets: "ValidatorSubnet",
  ValidatorEconomicsExclusion: "ValidatorEconomicsExclusion",
  ValidatorEconomicsHistoryPoint: "ValidatorEconomicsHistoryPoint",
  ValidatorEconomicsRankingArtifact: "ValidatorEconomicsRanking",
  ValidatorHistoryArtifact: "ValidatorHistory",
  ValidatorHistoryArtifactPoints: "ValidatorHistoryPoint",
  ValidatorNominatorsArtifact: "NominatorList",
  ValidatorNominatorsArtifactNominators: "Nominator",
  ValidatorPermitModelAgreement: "ValidatorPermitModelAgreement",
  ValidatorSetComposition: "ValidatorSetComposition",
  ValidatorTakeDistribution: "ValidatorTakeDistribution",
  // ── the 69 types #10214 stopped publishing as opaque JSON ─────────────────
  //
  // Every one is an IDENTITY entry, and that is the point rather than an
  // omission. The 50 fields these back were `JSON` in the hand-written SDL --
  // a caller could read them, but nothing said what was inside, so nothing
  // checked. They are emitted from their Zod components now, and a component
  // that has never had a published name has no name to preserve: the component
  // id IS the contract, first published here.
  //
  // The renamed entries above exist because the hand-written SDL chose a name
  // before the component did (`SubnetIndexEntry` -> `Subnet`). There was no
  // such choice to honour here -- inventing one would mint a public name no
  // caller has ever seen, and it can still be chosen later, in the issue that
  // wants it, without this diff having pre-empted it.
  AdapterArtifactSnapshot: "AdapterArtifactSnapshot",
  BlockChainEventsArtifactEvents: "BlockChainEventsArtifactEvents",
  BlockExtrinsicsArtifactExtrinsics: "BlockExtrinsicsArtifactExtrinsics",
  BuildSummaryArtifactArtifactBudgetSummary:
    "BuildSummaryArtifactArtifactBudgetSummary",
  BuildSummaryArtifactArtifacts: "BuildSummaryArtifactArtifacts",
  ChainConcentrationScorecard: "ChainConcentrationScorecard",
  ChangelogArtifactArtifacts: "ChangelogArtifactArtifacts",
  ChangelogArtifactSubnets: "ChangelogArtifactSubnets",
  ChangelogArtifactSubnetsAdded: "ChangelogArtifactSubnetsAdded",
  ChangelogArtifactSubnetsRemoved: "ChangelogArtifactSubnetsRemoved",
  ChangelogArtifactSubnetsRenamed: "ChangelogArtifactSubnetsRenamed",
  ChangelogArtifactSummary: "ChangelogArtifactSummary",
  CompareValidatorsArtifactValidatorsColdkeyIdentity:
    "CompareValidatorsArtifactValidatorsColdkeyIdentity",
  CompareValidatorsArtifactValidatorsSubnetContext:
    "CompareValidatorsArtifactValidatorsSubnetContext",
  ContractsArtifactArtifacts: "ContractsArtifactArtifacts",
  ContractsArtifactArtifactsRetirement: "ContractsArtifactArtifactsRetirement",
  CoverageArtifact: "CoverageArtifact",
  CoverageArtifactSource: "CoverageArtifactSource",
  CoverageCompleteness: "CoverageCompleteness",
  CurationArtifactCuration: "CurationArtifactCuration",
  CurationMetadata: "CurationMetadata",
  EndpointIncidentsArtifactSummary: "EndpointIncidentsArtifactSummary",
  EndpointScoreReason: "EndpointScoreReason",
  EvidenceClaim: "EvidenceClaim",
  EvidenceLedgerArtifactSummary: "EvidenceLedgerArtifactSummary",
  Gaps: "Gaps",
  GapsArtifactGaps: "GapsArtifactGaps",
  GlobalIncidentsArtifactSummary: "GlobalIncidentsArtifactSummary",
  HealthHistoryArtifactSurfaces: "HealthHistoryArtifactSurfaces",
  HealthIncidentsArtifactSurfaces: "HealthIncidentsArtifactSurfaces",
  HealthIncidentsArtifactSurfacesIncidents:
    "HealthIncidentsArtifactSurfacesIncidents",
  HealthPercentilesArtifactSurfaces: "HealthPercentilesArtifactSurfaces",
  HealthPercentilesArtifactSurfacesLatencyMs:
    "HealthPercentilesArtifactSurfacesLatencyMs",
  HealthProbeSummary: "HealthProbeSummary",
  IntegrationReadiness: "IntegrationReadiness",
  IntegrationReadinessComponents: "IntegrationReadinessComponents",
  ReviewAdapterCandidate: "ReviewAdapterCandidate",
  ReviewEnrichmentEvidenceArtifactEntries:
    "ReviewEnrichmentEvidenceArtifactEntries",
  ReviewEnrichmentEvidenceArtifactEntriesCandidateEvidenceSummary:
    "ReviewEnrichmentEvidenceArtifactEntriesCandidateEvidenceSummary",
  ReviewEnrichmentQueueArtifactQueue: "ReviewEnrichmentQueueArtifactQueue",
  ReviewEnrichmentQueueArtifactQueueCandidateEvidenceSummary:
    "ReviewEnrichmentQueueArtifactQueueCandidateEvidenceSummary",
  ReviewEnrichmentTargetsArtifactTargets:
    "ReviewEnrichmentTargetsArtifactTargets",
  ReviewEnrichmentTargetsArtifactTargetsCandidateEvidence:
    "ReviewEnrichmentTargetsArtifactTargetsCandidateEvidence",
  ReviewEnrichmentTargetsArtifactTargetsQueueContext:
    "ReviewEnrichmentTargetsArtifactTargetsQueueContext",
  ReviewGapPriority: "ReviewGapPriority",
  ReviewProfileCompletenessArtifactProfiles:
    "ReviewProfileCompletenessArtifactProfiles",
  ReviewProfileCompletenessArtifactSummary:
    "ReviewProfileCompletenessArtifactSummary",
  RpcPool: "RpcPool",
  RpcPoolEndpoints: "RpcPoolEndpoints",
  SearchArtifactDocuments: "SearchArtifactDocuments",
  SearchIndexArtifactDocuments: "SearchIndexArtifactDocuments",
  SourceSnapshotsArtifactSources: "SourceSnapshotsArtifactSources",
  SourceSnapshotsArtifactSummary: "SourceSnapshotsArtifactSummary",
  SubnetConvictionArtifactLeaderboard: "SubnetConvictionArtifactLeaderboard",
  SubnetEventSummaryArtifactCategories: "SubnetEventSummaryArtifactCategories",
  SubnetEventSummaryArtifactEventKinds: "SubnetEventSummaryArtifactEventKinds",
  SubnetLeaseArtifactLease: "SubnetLeaseArtifactLease",
  SubnetLeaseHistoryArtifactLeaseEvents:
    "SubnetLeaseHistoryArtifactLeaseEvents",
  SubnetOwnershipHistoryArtifactOwnershipChanges:
    "SubnetOwnershipHistoryArtifactOwnershipChanges",
  SubnetProfile: "SubnetProfile",
  SubnetProfileCompleteness: "SubnetProfileCompleteness",
  SubnetProfileGithubCommitsWeekly: "SubnetProfileGithubCommitsWeekly",
  SubnetProfileGithubReleases: "SubnetProfileGithubReleases",
  SubnetProfileIdentityEvidence: "SubnetProfileIdentityEvidence",
  SubnetProfileLineage: "SubnetProfileLineage",
  SubnetProfileLineageAlsoOn: "SubnetProfileLineageAlsoOn",
  SubnetProfileNativeIdentity: "SubnetProfileNativeIdentity",
  SubnetProfilePrimaryAppSurface: "SubnetProfilePrimaryAppSurface",
  SubnetProfilePrimaryLinks: "SubnetProfilePrimaryLinks",
  SubnetProfileProvenance: "SubnetProfileProvenance",
};

/** A published type the resolver PROJECTS from a component (#10214). */
export interface ProjectedType {
  /** The component it picks its fields from. */
  readonly component: string;
  /**
   * Fields the resolver adds that the component does not supply -- an
   * association it resolves separately, or a value it computes -- each with
   * the type it publishes.
   *
   * The TYPE is here rather than only in the SDL because the generator has to
   * emit these fields and nothing else knows their shape: they have no
   * component to read one from. Declaring only the NAME made a typo'd or
   * invented field a failure, which is half of it; declaring the type is what
   * lets the SDL stop being the source (#10214). The spelling is checked
   * against the SDL, so it cannot drift while both exist.
   */
  readonly added: Readonly<Record<string, string>>;
  /**
   * Component fields the view deliberately does not republish, each of which
   * must BE a component field (a typo fails) and must be ABSENT from the SDL
   * (a stale entry fails). So the list only shrinks, and a field quietly
   * disappearing from a published type is a failure rather than a silence.
   *
   * Absent on the projections that drop nothing.
   */
  readonly dropped?: readonly string[];
  /**
   * The component field a paginated view's `items` array renames (#10404).
   *
   * `BlockList.items` IS `BlocksFeedArtifact.blocks` -- one field under two
   * names, not a dropped one and an invented one. Declaring the rename is what
   * lets the element type be compared at all.
   */
  readonly itemsFrom?: string;
  /** The component row count a paginated view's `total` renames (#10404). */
  readonly totalFrom?: string;
  /**
   * Component fields this view publishes NULLABLE that the component promises.
   *
   * A projection is a view built by a resolver, and a resolver can fill fewer
   * fields than the component's own producer does. `OpportunityEntry` is that:
   * the economics card promises `miner_count` and four siblings, and
   * /api/v1/economics delivers all five on all 129 rows -- but the LEADERBOARD
   * rows are ranked partials, and each board materializes only what its
   * ranking needs. Production answers `open_slots[].miner_count: null` today.
   *
   * So this cannot be fixed in the Zod: relaxing `SubnetEconomics` would
   * weaken a contract the full card honours, to describe a view that does not.
   * The relaxation belongs to the VIEW, which is what this declares.
   *
   * The direction is deliberately one-way -- a projection may publish a
   * component's non-null field as nullable, never the reverse. Promising more
   * than the component does is a claim about a producer the projection has no
   * standing to make.
   */
  readonly nullable?: readonly string[];
}

/**
 * Published types assembled BY a resolver FROM a component.
 *
 * These were all listed as `RESOLVER_BUILT_TYPES` -- "no component behind
 * them" -- which was true of the shape and false of the fields: 141 of their
 * fields are picked straight from a component that already exists, and eleven
 * of the fifteen types add nothing at all.
 *
 * The distinction is load-bearing because it decides whether anything checks
 * them. `validate-graphql-component-parity` pairs a type with its component by
 * traversing from Query's `Mirrors GET` annotations, and a resolver-built type
 * has no such annotation to traverse from -- so **all fifteen were reached by
 * exactly zero gates**, and an over-promise in any of them (the class that
 * nulled `SelfHealthLane.detail` on every request, #10215) was invisible.
 *
 * A projection is NOT a mirror: it deliberately publishes a subset, so the
 * mirror rule "every component field must appear" does not apply to it. What
 * does apply is every rule about the fields it DOES publish -- nullability and
 * scalar narrowing -- and that is what the projection pass now checks.
 */
export const PROJECTED_TYPES: Readonly<Record<string, ProjectedType>> = {
  // The `deltas` record's VALUE, registered as its own component so the
  // published type has something to be compared against (#10404). `window` is
  // the record's KEY, which the resolver lifts into the row because "7d" and
  // "30d" are not valid GraphQL field names.
  SubnetTrajectoryDelta: {
    component: "SubnetTrajectoryDelta",
    added: {
      window: "String!",
    },
    dropped: [],
  },
  // ── the three that DO have a component behind them (#10404) ───────────────
  //
  // `subnets` and `providers` are the two Query fields with `route: null` --
  // they read a published artifact directly rather than mirroring an
  // /api/v1 route -- so the traversal cannot reach their list types and both
  // sat in RESOLVER_BUILT_TYPES, unchecked. The projection pass does not need
  // the traversal: naming the component is enough.
  SubnetList: {
    component: "SubnetsArtifact",
    itemsFrom: "subnets",
    added: {
      total: "Int!",
      next_cursor: "String",
    },
    dropped: [
      "contract_version",
      "generated_at",
      "notes",
      "schema_version",
      "network",
      "source",
    ],
  },
  ProviderList: {
    component: "ProvidersArtifact",
    itemsFrom: "providers",
    added: {
      total: "Int!",
      next_cursor: "String",
    },
    dropped: ["contract_version", "generated_at", "notes", "schema_version"],
  },
  // A flattened card: the artifact's own fields plus the counts the resolver
  // derives from `global.status_counts`, which is a record GraphQL cannot
  // name. The five it takes straight from the component are checked now; the
  // nine it computes stay declared.
  GlobalHealth: {
    component: "HealthSummaryArtifact",
    added: {
      status: "String",
      ok_count: "Int",
      degraded_count: "Int",
      failed_count: "Int",
      unknown_count: "Int",
      avg_latency_ms: "Int",
      latency_sample_count: "Int",
      last_checked: "String",
      last_ok: "String",
      surface_count: "Int",
    },
    dropped: ["contract_version", "schema_version", "global", "source"],
  },
  Subnet: {
    component: "SubnetIndexEntry",
    added: {
      health: "SubnetHealth",
      economics: "SubnetEconomics",
      surfaces: "[Surface!]!",
      endpoints: "[Endpoint!]!",
    },
    dropped: [
      "block",
      "candidate_count",
      "contact",
      "contact_present",
      "dashboard_url",
      "derived_categories",
      "derived_description",
      "discord",
      "discord_url",
      "github_commits_weekly",
      "github_languages",
      "github_last_push_at",
      "github_stars",
      "github_releases",
      "github_unreachable",
      "mechanism_count",
      "native_name",
      "native_name_quality",
      "native_slug",
      "participant_count",
      "partnership",
      "registered_at_block",
      "registry_observed_count",
      "social",
      "source_repo",
      "tempo",
      "updated_at",
    ],
  },
  Provider: {
    component: "Provider",
    added: {
      subnets: "[Subnet!]!",
      endpoints: "[Endpoint!]!",
    },
    dropped: ["schema_version", "social", "team_url", "cluster_id"],
  },
  Surface: {
    component: "Surface",
    added: {},
    dropped: [
      "auth",
      "curation_level",
      "probe",
      "quality_signals",
      "rate_limit",
      "rate_limit_notes",
      "review",
      // #10441/#10476: `revenue` is a structured declaration block, the same
      // class as probe/review/verification above -- what a surface measures
      // and on what terms, not a value. Dropped from the projection until
      // #10476 models it as its own SDL type; declared here rather than left
      // to the parity gate, which is what caught it.
      "revenue",
      "verification",
    ],
  },
  Endpoint: {
    component: "EndpointResource",
    added: {},
    dropped: [
      "archive_support",
      "chain",
      "error",
      "health_stale",
      "method_support",
      "method_tested",
      "monitoring_policy",
      "observed_at",
      "pool_eligibility_reasons",
      "publication_state",
      "rate_limit_notes",
      "rpc_method_count",
      "score_reasons",
      "reliability_score",
      "reliability_grade",
    ],
  },
  SubnetHealth: { component: "HealthSubnetSummary", added: {} },
  OpportunityEntry: {
    component: "SubnetEconomics",
    added: {
      validator_headroom: "Int",
    },
    // Measured, not guessed. `formatLeaderboards` ranks each board off the
    // fields that board sorts by, so a row carries those and leaves the rest
    // unset -- and the boards disagree with each other about which:
    //
    //   open_slots[]         max_validators, miner_count, validator_count null
    //   validator_headroom[] max_validators, validator_count set; miner_count null
    //
    // against api.metagraph.sh, on every row of both. The full card fills all
    // five on all 129 rows of /api/v1/economics, which is why the component
    // keeps its promise and only this view relaxes it.
    nullable: [
      "max_uids",
      "max_validators",
      "miner_count",
      "registration_allowed",
      "validator_count",
    ],
    dropped: [
      "alpha_fdv_tao",
      "alpha_in_emission",
      "alpha_out_emission",
      "alpha_in_pool",
      "alpha_market_cap_tao",
      "alpha_out_pool",
      "alpha_price_change_1h",
      "alpha_price_change_1m",
      "spot_price_tao",
      "block",
      "emission_enabled",
      "excess_tao",
      "first_emission_block",
      "max_stake_alpha",
      "miner_readiness",
      "miner_burned_fraction",
      "owner_coldkey",
      "owner_hotkey",
      "subnet_volume_tao",
      "subtoken_enabled",
      "moving_price_pinned",
      "registration_allowed_pinned",
      "registered_at_block",
      "subnet_mechanism",
      "tao_in_emission_tao",
      "tao_in_pool_tao",
    ],
  },
  ExtrinsicDetail: {
    component: "ExtrinsicDetailArtifact",
    added: {},
    dropped: ["schema_version", "events"],
  },
  // Was declared over `BlockEventsArtifact` -- the component behind the OTHER
  // block route, /api/v1/blocks/{ref}/events, whose `events` are curated
  // `AccountEvent` rows. This field mirrors /api/v1/blocks/{ref}/chain-events,
  // and openapi.json says so: its `data` refs `BlockChainEventsArtifact`.
  //
  // Measured against production, the two payloads are not the same shape:
  //
  //   /blocks/{ref}/chain-events   {block_number, count, events[...]}
  //   /blocks/{ref}/events         {block_number, event_count, events[...],
  //                                 limit, offset, ref, schema_version}
  //
  // and their rows differ entirely -- raw pallet-level `{pallet, method, args,
  // phase, summary}` here against the curated `{event_kind, hotkey, coldkey,
  // netuid, amount_tao}` there. The component's own comment says as much:
  // "distinct from the curated AccountEvent".
  //
  // It cost nothing while `events` was published as `[JSON!]!`, because JSON
  // serialises whatever it is handed. It stops being free the moment the field
  // is TYPED (#10214): every row would be checked against AccountEvent, match
  // none of its fields, and serve `event_kind: null, hotkey: null, ...` for
  // data that is sitting right there.
  //
  // `schema_version` and `event_count` are resolver-added: the artifact carries
  // `count`, and the resolver renames it and stamps a version, which is what
  // this route's GraphQL card has always published.
  BlockChainEvents: {
    component: "BlockChainEventsArtifact",
    added: { schema_version: "Int", event_count: "Int!" },
    dropped: ["count"],
  },
  AccountEntry: { component: "AccountsListArtifactAccounts", added: {} },
  // ── the three that had NO component until #10409 ─────────────────────────
  //
  // Each has one now, in schemas-src/graphql/graphql-only.ts, so each is
  // checked field by field like every other projection instead of being
  // taken on trust. `EmissionGateChange` is DERIVED from the three arm
  // schemas REST already serves, so a field added to any arm fails the
  // parity gate until the SDL publishes it.
  OpportunityBoards: {
    component: "OpportunityBoards",
    added: {},
    dropped: [],
  },
  EmissionGateChange: {
    component: "EmissionGateChange",
    added: {},
    dropped: [],
  },
  ChainEvent: {
    component: "ChainFirehoseEvent",
    added: {},
    dropped: [],
  },
  // Two producers, one published type, and the ACCOUNTS-LIST one is the whole
  // of it: `AccountsListArtifactAccountsSubnets` emits exactly the four fields
  // `AccountSubnet` declares, so the projection below (which drops seven of
  // the portfolio's eleven) is the same four seen from the other side.
  AccountSubnet: {
    component: "AccountPortfolioArtifactPositions",
    added: {},
    dropped: [
      "role",
      "active",
      "rank",
      "trust",
      "incentive",
      "dividends",
      "yield",
    ],
  },

  // ── paginated views (#10404) ──────────────────────────────────────────────
  //
  // These 25 were SKIPPED wholesale by the parity gate, on the rule "two or
  // more pagination fields the component lacks means this is a view, not a
  // mirror". True of the paging and false of everything else: 158
  // non-pagination fields sat behind that skip, 94 of them component fields
  // the view does not publish. Most are the artifact envelope
  // (schema_version/contract_version/generated_at/notes), which a view has no
  // reason to republish -- but `EndpointList.health_source`,
  // `GlobalIncidents.min_incident_samples` and `EconomicsList.field_sources`
  // are the caveats that say whether a number was measured, and dropping them
  // is the confident-zeros class (#9803) reached through the one door nothing
  // was looking at.
  //
  // Declared as projections instead, so every rule a projection gets applies
  // to them and a NEW drop is a failure.
  AccountList: {
    component: "AccountsListArtifact",
    itemsFrom: "accounts",
    totalFrom: "account_count",
    added: {},
    dropped: ["schema_version", "limit"],
  },
  BlockList: {
    component: "BlocksFeedArtifact",
    itemsFrom: "blocks",
    totalFrom: "block_count",
    added: {},
    dropped: ["schema_version", "limit", "offset"],
  },
  CurationList: {
    component: "CurationArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version"],
  },
  EconomicsList: {
    component: "EconomicsArtifact",
    added: {
      total: "Int!",
      next_cursor: "String",
    },
    // THE PROJECTION (#10786), for the reason this field exists. The artifact's
    // producer always writes a summary -- it is computed from the same rows it
    // ships -- so `EconomicsArtifact.summary` keeps its promise and relaxing it
    // would weaken a contract /api/v1/economics honours. What differs is the
    // VIEW: `loadEconomics` returns null when both the live KV and the
    // committed artifact are cold, and this list answers that with an empty
    // page rather than an error, so `summary` is the one field the view has
    // nothing to build from. Same shape as `OpportunityEntry` above.
    nullable: ["summary"],
    dropped: [
      "contract_version",
      "generated_at",
      "notes",
      "schema_version",
      "captured_at",
      "network",
      "chain_state",
      "field_sources",
      // The USD overlay (#10790). `withAlphaUsdEconomics` decorates the REST
      // payload at serve time; this field's own loader does not run it, so the
      // GraphQL economics view is TAO-only and says so here rather than
      // publishing two fields that would be absent on every request.
      "tao_usd",
      "tao_usd_unavailable",
    ],
  },
  EndpointList: {
    component: "EndpointsArtifact",
    itemsFrom: "endpoints",
    added: {
      total: "Int!",
      next_cursor: "String",
    },
    dropped: [
      "contract_version",
      "generated_at",
      "notes",
      "schema_version",
      "source",
      "operational_observed_at",
      "health_source",
      "summary",
    ],
  },
  EndpointPoolList: {
    component: "EndpointPoolsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: [
      "contract_version",
      "schema_version",
      "disabled_proxy_contract",
      "eligibility_policy",
      "provider_scores",
    ],
  },
  EvidenceList: {
    component: "EvidenceLedgerArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "notes"],
  },
  ExtrinsicList: {
    component: "ExtrinsicsFeedArtifact",
    itemsFrom: "extrinsics",
    totalFrom: "extrinsic_count",
    added: {},
    dropped: ["schema_version", "limit", "offset"],
  },
  GapsList: {
    component: "GapsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version"],
  },
  GlobalIncidents: {
    component: "GlobalIncidentsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["min_incident_samples"],
  },
  HealthHistory: {
    component: "HealthHistoryArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: [
      "contract_version",
      "generated_at",
      "notes",
      "schema_version",
      "source",
      "probe_started_at",
      "probe_finished_at",
    ],
  },
  IncidentList: {
    component: "EndpointIncidentsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version", "source"],
  },
  PoolList: {
    component: "RpcPoolsArtifact",
    added: {
      // `operational_observed_at` was listed here, as a field the RESOLVER
      // supplies. It never was: the artifact carries it, and #10790 declared
      // it on `RpcPoolsArtifact` -- which its own `.describe()` had named
      // since #6570 without any schema saying so. It is a component field now,
      // so the mirror rule covers it and this list must not claim it.
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: [
      "contract_version",
      "schema_version",
      "disabled_proxy_contract",
      "eligibility_policy",
      "provider_scores",
    ],
  },
  ProfileList: {
    component: "SubnetProfilesArtifact",
    added: {
      captured_at: "String",
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: [
      "contract_version",
      "generated_at",
      "notes",
      "schema_version",
      "summary",
    ],
  },
  ReviewAdapterCandidateList: {
    component: "ReviewAdapterCandidatesArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version", "summary"],
  },
  ReviewEnrichmentEvidenceList: {
    component: "ReviewEnrichmentEvidenceArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version", "summary"],
  },
  ReviewEnrichmentQueueList: {
    component: "ReviewEnrichmentQueueArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version", "summary"],
  },
  ReviewEnrichmentTargetList: {
    component: "ReviewEnrichmentTargetsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version", "groups", "summary"],
  },
  ReviewGapPriorityList: {
    component: "ReviewGapPrioritiesArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version"],
  },
  ReviewProfileCompletenessList: {
    component: "ReviewProfileCompletenessArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "schema_version"],
  },
  SearchDocumentList: {
    component: "SearchArtifact",
    totalFrom: "document_count",
    added: {
      next_cursor: "String",
    },
    dropped: ["contract_version", "generated_at", "notes", "schema_version"],
  },
  SearchIndexList: {
    component: "SearchIndexArtifact",
    totalFrom: "document_count",
    added: {
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "notes", "schema_version"],
  },
  SourceSnapshotList: {
    component: "SourceSnapshotsArtifact",
    added: {
      total: "Int!",
      returned: "Int!",
      limit: "Int!",
      cursor: "Int!",
      next_cursor: "Int",
      sort: "String",
      order: "String",
    },
    dropped: ["contract_version", "notes"],
  },
  SurfaceList: {
    component: "SurfacesArtifact",
    itemsFrom: "surfaces",
    added: {
      total: "Int!",
      next_cursor: "String",
    },
    dropped: ["contract_version", "generated_at", "notes", "schema_version"],
  },
  ValidatorList: {
    component: "GlobalValidatorsArtifact",
    itemsFrom: "validators",
    totalFrom: "validator_count",
    added: {
      next_cursor: "String",
    },
    dropped: ["schema_version", "limit"],
  },
};

/** A resolver's edits to a MIRROR -- the projection mechanism, for types that
 *  are not views (#10214). */
export interface MirrorOverlay {
  /**
   * Fields the resolver supplies that no contributing component does, each
   * with the type it publishes -- the same declaration `ProjectedType.added`
   * makes, for a type that mirrors its component rather than projecting one.
   */
  readonly added?: Readonly<Record<string, string>>;
  /**
   * Component fields the resolver does NOT republish under that name.
   *
   * Deliberately narrow: a mirror's rule is that every component field appears,
   * so each entry here weakens the strongest gate on the type and has to say
   * why in a comment. The only entries today are one producer's spelling of a
   * fact the union already publishes under the other's.
   */
  readonly dropped?: readonly string[];
}

/**
 * Mirrors whose published shape is not exactly their component's.
 *
 * WHY NOT `PROJECTED_TYPES`. A projection is exempt from the mirror rule --
 * "every component field must appear" -- because publishing a subset is what
 * it is for. Moving a mirror into that map to give it one added field would
 * hand it that exemption for all its other fields too, which is the gate
 * getting weaker as a side effect of an unrelated change. Two maps keep the
 * two rules separate: `dropped` here is the only exemption, and it is per
 * field.
 */
export const MIRROR_OVERLAYS: Readonly<Record<string, MirrorOverlay>> = {
  // `validatorNode` normalizes two producers into one shape, and the list
  // producer spells the detail's `captured_at`/`block_number` as
  // `latest_captured_at`/`latest_block_number` (the comment on
  // `GlobalValidatorsArtifactValidators` above says so). The union carries all
  // four names; the resolver publishes one pair, so the other is dropped
  // rather than served as a permanent null beside the value it duplicates.
  Validator: { dropped: ["latest_captured_at", "latest_block_number"] },
  // The artifact nests this INSIDE `summary` and REST serves it there; the
  // Query resolver lifts it to the top as well (#9892, after the flattened
  // path resolved null on every call). So it is a GraphQL-only field over a
  // component that legitimately does not carry it -- `JSON` because the value
  // is a record keyed by subnet slug, which is the same reason
  // `ChangelogArtifactSummary.coverage_delta` is JSON where it is nested.
  Changelog: { added: { coverage_delta: "JSON" } },
};

/**
 * NESTED fields that take arguments, and the route whose query parameters are
 * those arguments (#10772).
 *
 * Only the two roots had arguments derived, on the assumption that only a root
 * field takes any. Two nested fields do -- `Subnet.surfaces` and
 * `Subnet.endpoints` are the per-subnet filtered lists -- and the generated
 * schema published them bare, so `subnet { surfaces(kind: "api") }` stopped
 * validating. Nothing caught it: `validate:graphql-query-arguments` walks
 * `QUERY_BINDINGS`, which is the ROOT, so the whole nested class sat outside
 * every argument check there is.
 *
 * The route's PATH parameters are deliberately not republished here -- the
 * parent supplies `netuid`, which is exactly why these are nested fields
 * rather than root ones. Only the query half derives.
 */
export const FIELD_ARGUMENT_ROUTES: Readonly<Record<string, string>> = {
  "Subnet.surfaces": "/api/v1/subnets/{netuid}/surfaces",
  "Subnet.endpoints": "/api/v1/subnets/{netuid}/endpoints",
};

/**
 * Fields whose published type is not the one their component's Zod emits.
 *
 * TWO THINGS LIVE HERE, and both are about the type a field REFERENCES rather
 * than the nullability it promises -- which is the rule the builder enforces:
 * a retype may change the named type and nothing else, unless what it replaces
 * is `JSON`, in which case any spelling is allowed because `JSON` says nothing
 * about shape at all. So this cannot be used to quietly relax a `!`, which is
 * the one direction that would matter to a client.
 *
 * ONE SHAPE, TWO PUBLISHED NAMES. `publishedName()` answers per COMPONENT, so
 * a component the schema names twice comes out under whichever name won, and
 * the other is registered but never reached -- `ChainAlphaVolumeSubnet` and
 * `OpportunityEntry` were two of the four types the generator did not build
 * for exactly this reason. The name belongs to the REFERENCE, not the shape:
 * `SubnetAlphaVolumeArtifact` is `SubnetVolume` from its own route and
 * `ChainAlphaVolumeSubnet` from inside the chain rollup, and only the field
 * knows which.
 *
 * A CONCRETE SHAPE BEHIND AN OPAQUE ONE. `EmissionGateChanges.changes` and
 * `SubnetTrajectory.deltas` are `JSON` in the Zod because REST genuinely
 * serves what GraphQL cannot: an un-flattened union whose arms have different
 * keys, and a record keyed by window ("7d", "30d") rather than by field.
 * GraphQL publishes the flattened/re-keyed form, and the component behind it
 * is registered -- `EmissionGateChange`, `SubnetTrajectoryDelta` -- so naming
 * it here is what stops those rows from being served as opaque blobs. This is
 * the direction the epic exists to move in, not an exception to it.
 */
export const RETYPED_FIELDS: Readonly<Record<string, string>> = {
  // The chain rollup's rows are the per-subnet volume card, published under
  // the rollup's own name -- `ALIASED_TYPE_NAMES` says so, and this is the
  // reference that reaches it.
  "ChainAlphaVolume.subnets": "[ChainAlphaVolumeSubnet!]!",
  // Every board is the economics card minus the 26 fields a ranking has no use
  // for, plus the headroom the ranker derives: `PROJECTED_TYPES.OpportunityEntry`
  // is that view, and these six are its only reference sites.
  "OpportunityBoards.open_slots": "[OpportunityEntry!]!",
  "OpportunityBoards.cheapest_registration": "[OpportunityEntry!]!",
  "OpportunityBoards.highest_emission": "[OpportunityEntry!]!",
  "OpportunityBoards.validator_headroom": "[OpportunityEntry!]!",
  "OpportunityBoards.biggest_alpha_gain_1d": "[OpportunityEntry!]!",
  "OpportunityBoards.biggest_alpha_gain_7d": "[OpportunityEntry!]!",
  // The two opaque ones. REST serves the union un-flattened and the deltas
  // keyed by window; both are `JSON` in the Zod for that reason, and both have
  // a registered component describing the form GraphQL publishes.
  "EmissionGateChanges.changes": "[EmissionGateChange!]!",
  "SubnetTrajectory.deltas": "[SubnetTrajectoryDelta!]!",
};

/**
 * The Subscription root, declared the way `QUERY_BINDINGS` declares the Query
 * root (#10409).
 *
 * A root type is not a component and never will be -- it is assembled from its
 * fields -- so `Subscription` sat in `RESOLVER_BUILT_TYPES` for the same
 * reason `Query` is excluded by name rather than listed there: the debt list
 * was the only place to put it. Declaring its one field the way the 196 Query
 * fields are declared is what the generator needs and what takes that list to
 * zero.
 *
 * `route` is null and always will be: the field is reached over WebSocket only
 * (Sec-WebSocket-Protocol: graphql-transport-ws at /api/v1/graphql), and
 * POSTing a subscription operation to the query endpoint returns a standard
 * GraphQL error. There is no REST route to mirror.
 */

/**
 * Types a resolver builds with no component behind them -- EMPTY, and the
 * generator's completeness depends on it staying that way.
 *
 * THIS LIST WAS THE DEBT, and only it: everything in `PROJECTED_TYPES` is
 * checked field by field and everything here was taken on trust, so an
 * over-promise in any of them (the class that nulled `SelfHealthLane.detail`
 * on every request, #10215) was invisible. It was 15 when #10371 split the two,
 * 8 once the projections were declared, 4 once `SubnetList` / `ProviderList` /
 * `GlobalHealth` named the components they page over and flatten, and 0 at
 * #10409:
 *
 *   OpportunityBoards    now a projection of the registered `OpportunityBoards`
 *                        component, whose rows are the same `SubnetEconomics`
 *                        card `OpportunityEntry` already projects.
 *   EmissionGateChange   now a projection of a component DERIVED from the three
 *                        arm schemas /api/v1/chain/governance/emission-changes
 *                        already serves -- add a field to any arm and the parity
 *                        gate fails until the SDL publishes it.
 *   ChainEvent           now a projection of `ChainFirehoseEvent`, the #4980
 *                        NOTIFY payload, modeled in schemas-src/graphql/
 *                        graphql-only.ts because no REST route serves it.
 *   Subscription         a ROOT, like Query -- assembled from its fields rather
 *                        than emitted as a component, and declared as such in
 *                        `SUBSCRIPTION_BINDINGS` above.
 *
 * A new entry here is a type nothing checks. Give it a component and declare
 * the projection instead; `schemas-src/graphql/graphql-only.ts` is where a
 * shape only GraphQL publishes goes.
 */
export const RESOLVER_BUILT_TYPES: readonly string[] = [];

// ── the surface projections ─────────────────────────────────────────────────
//
// DERIVED, not declared (#10781). These were the second and third places an
// operation was named: each carried its own `route` path string, spelled
// independently of `API_ROUTES` and of each other, joined by string equality.
// The declarations now live in `schemas-src/graphql/query-exposures.ts` keyed
// by OPERATION ID, and `OPERATIONS` resolves the id to the route -- so the path
// below is read from the route table rather than restated beside it, and an id
// that resolves to nothing throws at load instead of skipping a check.

/** One Query field, the route it mirrors, and the type it returns. */
export interface QueryBinding {
  field: string;
  /** The route path, resolved from the field's operation. Null where none serves it. */
  route: string | null;
  /** Why the route's RESPONSE does not describe this field's return type. */
  reshapes?: string;
  /** The published return type, nullability included -- `SubnetList!`. */
  returns: string;
  /** The published field description, verbatim. */
  description: string;
}

function bindingsFor(
  exposures: readonly GraphqlExposure[],
  label: string,
): readonly QueryBinding[] {
  return exposures.map((exposure) => ({
    field: exposure.field,
    route:
      exposure.operation === null
        ? null
        : operationPath(exposure.operation, `${label} ${exposure.field}`),
    ...(exposure.reshapes === undefined ? {} : { reshapes: exposure.reshapes }),
    returns: exposure.returns,
    description: exposure.description,
  }));
}

/** Every Query field, the route it mirrors, and the type it returns. */
export const QUERY_BINDINGS: readonly QueryBinding[] = bindingsFor(
  GRAPHQL_EXPOSURES,
  "GraphQL field",
);

/** The Subscription root, declared the way the Query root is. */
export const SUBSCRIPTION_BINDINGS: readonly QueryBinding[] = bindingsFor(
  SUBSCRIPTION_EXPOSURES,
  "GraphQL subscription",
);
