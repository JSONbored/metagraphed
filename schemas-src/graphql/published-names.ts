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
  ChainState: "EmissionPipelineChainState",
  DegradedInfo: "DegradedInfo",
  DeregistrationDerivation: "DeregistrationDerivation",
  IntensityDistribution: "IntensityDistribution",
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
  EconomicsArtifactSubnets: "SubnetEconomics",
  EconomicsArtifactSummary: "EconomicsSummary",
  EconomicsTrendsArtifact: "EconomicsTrends",
  EconomicsTrendsArtifactDays: "EconomicsTrendsDay",
  EmissionGateChangesArtifact: "EmissionGateChanges",
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
  GlobalIncidentsArtifactSurfaces: "EndpointIncident",
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
  ValidatorDetailArtifactColdkeyIdentity: "Identity",
  ValidatorDetailArtifactSubnets: "ValidatorSubnet",
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
};

/**
 * Every Query field, the route it mirrors, and the type it returns.
 *
 * `route: null` means the field reads a published artifact directly rather
 * than mirroring an `/api/v1` route with a component -- the eight static
 * index/detail readers. They still return a declared type; what they lack is a
 * route whose OpenAPI response names the component.
 */
export interface QueryBinding {
  field: string;
  route: string | null;
  returns: string;
}

export const QUERY_BINDINGS: readonly QueryBinding[] = [
  { field: "subnets", route: null, returns: "SubnetList" },
  { field: "subnet", route: null, returns: "Subnet" },
  {
    field: "subnet_registrations",
    route: "/api/v1/subnets/{netuid}/registrations",
    returns: "SubnetRegistrations",
  },
  {
    field: "subnet_hyperparameters",
    route: "/api/v1/subnets/{netuid}/hyperparameters",
    returns: "SubnetHyperparameters",
  },
  {
    field: "subnet_hyperparameters_history",
    route: "/api/v1/subnets/{netuid}/hyperparameters/history",
    returns: "SubnetHyperparamsHistory",
  },
  {
    field: "subnet_lifecycle",
    route: "/api/v1/subnets/{netuid}/lifecycle",
    returns: "SubnetLifecycle",
  },
  {
    field: "chain_subnet_lifecycle",
    route: "/api/v1/chain/subnet-lifecycle",
    returns: "ChainSubnetLifecycle",
  },
  {
    field: "subnet_deregistrations",
    route: "/api/v1/subnets/{netuid}/deregistrations",
    returns: "SubnetDeregistrations",
  },
  {
    field: "subnet_serving",
    route: "/api/v1/subnets/{netuid}/serving",
    returns: "SubnetServing",
  },
  {
    field: "subnet_health_trends",
    route: "/api/v1/subnets/{netuid}/health/trends",
    returns: "SubnetHealthTrends",
  },
  {
    field: "subnet_uptime",
    route: "/api/v1/subnets/{netuid}/uptime",
    returns: "SubnetUptime",
  },
  {
    field: "subnet_health_incidents",
    route: "/api/v1/subnets/{netuid}/health/incidents",
    returns: "SubnetHealthIncidents",
  },
  {
    field: "subnet_health_percentiles",
    route: "/api/v1/subnets/{netuid}/health/percentiles",
    returns: "SubnetHealthPercentiles",
  },
  {
    field: "subnet_health",
    route: "/api/v1/subnets/{netuid}/health",
    returns: "JSON",
  },
  {
    field: "subnet_volume",
    route: "/api/v1/subnets/{netuid}/volume",
    returns: "SubnetVolume",
  },
  {
    field: "agent_resources",
    route: "/api/v1/agent-resources",
    returns: "JSON",
  },
  { field: "curation", route: "/api/v1/curation", returns: "CurationList" },
  { field: "candidates", route: "/api/v1/candidates", returns: "JSON" },
  { field: "saved_query", route: "/api/v1/queries/{id}", returns: "JSON" },
  { field: "fixtures", route: "/api/v1/fixtures", returns: "JSON" },
  { field: "fixture", route: "/api/v1/fixtures/{surface_id}", returns: "JSON" },
  { field: "agent_catalog", route: "/api/v1/agent-catalog", returns: "JSON" },
  { field: "freshness", route: "/api/v1/freshness", returns: "JSON" },
  {
    field: "top_holders",
    route: "/api/v1/accounts/top-holders",
    returns: "JSON",
  },
  { field: "search", route: "/api/v1/search", returns: "SearchDocumentList" },
  {
    field: "search_index",
    route: "/api/v1/search-index",
    returns: "SearchIndexList",
  },
  { field: "domains", route: "/api/v1/domains", returns: "DomainOverview" },
  {
    field: "domain_summary",
    route: "/api/v1/domains/{tag}/summary",
    returns: "DomainSummary",
  },
  {
    field: "compare_validators",
    route: "/api/v1/compare/validators",
    returns: "ValidatorComparison",
  },
  { field: "coverage", route: "/api/v1/coverage", returns: "JSON" },
  { field: "coverage_depth", route: "/api/v1/coverage-depth", returns: "JSON" },
  {
    field: "subnet_ohlc",
    route: "/api/v1/subnets/{netuid}/ohlc",
    returns: "SubnetOhlc",
  },
  {
    field: "subnet_stake_quote",
    route: "/api/v1/subnets/{netuid}/stake-quote",
    returns: "SubnetStakeQuote",
  },
  {
    field: "validator_economics",
    route: "/api/v1/validators/economics",
    returns: "ValidatorEconomicsRanking",
  },
  {
    field: "subnet_validator_economics_history",
    route: "/api/v1/subnets/{netuid}/validator-economics/history",
    returns: "SubnetValidatorEconomicsHistory",
  },
  {
    field: "subnet_validator_economics",
    route: "/api/v1/subnets/{netuid}/validator-economics",
    returns: "SubnetValidatorEconomics",
  },
  {
    field: "subnet_validators",
    route: "/api/v1/subnets/{netuid}/validators",
    returns: "SubnetValidatorList",
  },
  {
    field: "subnet_event_summary",
    route: "/api/v1/subnets/{netuid}/event-summary",
    returns: "SubnetEventSummary",
  },
  {
    field: "subnet_gaps",
    route: "/api/v1/subnets/{netuid}/gaps",
    returns: "JSON",
  },
  {
    field: "subnet_evidence",
    route: "/api/v1/subnets/{netuid}/evidence",
    returns: "JSON",
  },
  {
    field: "subnet_candidates",
    route: "/api/v1/subnets/{netuid}/candidates",
    returns: "JSON",
  },
  {
    field: "subnet_endpoints",
    route: "/api/v1/subnets/{netuid}/endpoints",
    returns: "JSON",
  },
  {
    field: "subnet_axon_removals",
    route: "/api/v1/subnets/{netuid}/axon-removals",
    returns: "SubnetAxonRemovals",
  },
  {
    field: "subnet_weights",
    route: "/api/v1/subnets/{netuid}/weights",
    returns: "SubnetWeights",
  },
  {
    field: "subnet_stake_moves",
    route: "/api/v1/subnets/{netuid}/stake-moves",
    returns: "SubnetStakeMoves",
  },
  {
    field: "subnet_stake_transfers",
    route: "/api/v1/subnets/{netuid}/stake-transfers",
    returns: "SubnetStakeTransfers",
  },
  {
    field: "subnet_idle_stake",
    route: "/api/v1/subnets/{netuid}/idle-stake",
    returns: "SubnetIdleStake",
  },
  {
    field: "subnet_stake_flow",
    route: "/api/v1/subnets/{netuid}/stake-flow",
    returns: "SubnetStakeFlow",
  },
  {
    field: "subnet_events",
    route: "/api/v1/subnets/{netuid}/events",
    returns: "SubnetEvents",
  },
  {
    field: "subnet_history",
    route: "/api/v1/subnets/{netuid}/history",
    returns: "SubnetHistory",
  },
  {
    field: "subnet_prometheus",
    route: "/api/v1/subnets/{netuid}/prometheus",
    returns: "SubnetPrometheus",
  },
  {
    field: "subnet_weight_setters",
    route: "/api/v1/subnets/{netuid}/weights/setters",
    returns: "SubnetWeightSetters",
  },
  {
    field: "subnet_yield",
    route: "/api/v1/subnets/{netuid}/yield",
    returns: "SubnetYield",
  },
  {
    field: "subnet_yield_history",
    route: "/api/v1/subnets/{netuid}/yield/history",
    returns: "SubnetYieldHistory",
  },
  {
    field: "subnet_performance",
    route: "/api/v1/subnets/{netuid}/performance",
    returns: "SubnetPerformance",
  },
  {
    field: "subnet_performance_history",
    route: "/api/v1/subnets/{netuid}/performance/history",
    returns: "SubnetPerformanceHistory",
  },
  {
    field: "subnet_concentration",
    route: "/api/v1/subnets/{netuid}/concentration",
    returns: "SubnetConcentration",
  },
  {
    field: "subnet_holders",
    route: "/api/v1/subnets/{netuid}/holders",
    returns: "SubnetHolders",
  },
  {
    field: "chain_holders",
    route: "/api/v1/chain/holders",
    returns: "ChainHolders",
  },
  {
    field: "chain_concentration_history",
    route: "/api/v1/chain/concentration/history",
    returns: "ChainConcentrationHistory",
  },
  {
    field: "subnet_emission_pipeline_history",
    route: "/api/v1/subnets/{netuid}/emission-pipeline/history",
    returns: "SubnetPipelineHistory",
  },
  {
    field: "emission_changes",
    route: "/api/v1/chain/governance/emission-changes",
    returns: "EmissionGateChanges",
  },
  {
    field: "failure_reasons",
    route: "/api/v1/health/failure-reasons",
    returns: "FailureReasons",
  },
  {
    field: "indexer_lag",
    route: "/api/v1/chain/indexer-lag",
    returns: "IndexerLag",
  },
  { field: "tao_usd", route: "/api/v1/network/tao-usd", returns: "TaoUsd" },
  {
    field: "subnet_surface_history",
    route: "/api/v1/subnets/{netuid}/surface-history",
    returns: "SubnetSurfaceHistory",
  },
  {
    field: "subnet_concentration_history",
    route: "/api/v1/subnets/{netuid}/concentration/history",
    returns: "SubnetConcentrationHistory",
  },
  {
    field: "neuron",
    route: "/api/v1/subnets/{netuid}/neurons/{uid}",
    returns: "Neuron",
  },
  {
    field: "neuron_history",
    route: "/api/v1/subnets/{netuid}/neurons/{uid}/history",
    returns: "NeuronHistory",
  },
  {
    field: "subnet_identity_history",
    route: "/api/v1/subnets/{netuid}/identity-history",
    returns: "SubnetIdentityHistory",
  },
  {
    field: "subnet_trajectory",
    route: "/api/v1/subnets/{netuid}/trajectory",
    returns: "SubnetTrajectory",
  },
  {
    field: "subnet_metagraph",
    route: "/api/v1/subnets/{netuid}/metagraph",
    returns: "JSON",
  },
  {
    field: "subnet_overview",
    route: "/api/v1/subnets/{netuid}/overview",
    returns: "JSON",
  },
  {
    field: "subnet_profile",
    route: "/api/v1/subnets/{netuid}/profile",
    returns: "JSON",
  },
  { field: "providers", route: null, returns: "ProviderList" },
  { field: "provider", route: null, returns: "Provider" },
  { field: "adapter", route: "/api/v1/adapters/{slug}", returns: "Adapter" },
  { field: "economics", route: "/api/v1/economics", returns: "EconomicsList" },
  { field: "surfaces", route: "/api/v1/surfaces", returns: "SurfaceList" },
  { field: "endpoints", route: "/api/v1/endpoints", returns: "EndpointList" },
  {
    field: "provider_endpoints",
    route: "/api/v1/providers/{slug}/endpoints",
    returns: "JSON",
  },
  {
    field: "endpoint_pools",
    route: "/api/v1/endpoint-pools",
    returns: "EndpointPoolList",
  },
  { field: "rpc_pools", route: "/api/v1/rpc/pools", returns: "PoolList" },
  {
    field: "endpoint_incidents",
    route: "/api/v1/endpoint-incidents",
    returns: "IncidentList",
  },
  {
    field: "source_snapshots",
    route: "/api/v1/source-snapshots",
    returns: "SourceSnapshotList",
  },
  { field: "gaps", route: "/api/v1/gaps", returns: "GapsList" },
  { field: "evidence", route: "/api/v1/evidence", returns: "EvidenceList" },
  { field: "profiles", route: "/api/v1/profiles", returns: "ProfileList" },
  {
    field: "review_adapter_candidates",
    route: "/api/v1/review/adapter-candidates",
    returns: "ReviewAdapterCandidateList",
  },
  {
    field: "review_enrichment_evidence",
    route: "/api/v1/review/enrichment-evidence",
    returns: "ReviewEnrichmentEvidenceList",
  },
  {
    field: "review_enrichment_queue",
    route: "/api/v1/review/enrichment-queue",
    returns: "ReviewEnrichmentQueueList",
  },
  {
    field: "review_enrichment_targets",
    route: "/api/v1/review/enrichment-targets",
    returns: "ReviewEnrichmentTargetList",
  },
  {
    field: "review_gaps",
    route: "/api/v1/review/gaps",
    returns: "ReviewGapPriorityList",
  },
  {
    field: "review_profile_completeness",
    route: "/api/v1/review/profile-completeness",
    returns: "ReviewProfileCompletenessList",
  },
  {
    field: "registry_summary",
    route: "/api/v1/registry/summary",
    returns: "JSON",
  },
  { field: "schemas", route: "/api/v1/schemas", returns: "JSON" },
  { field: "source_health", route: "/api/v1/source-health", returns: "JSON" },
  { field: "lineage", route: "/api/v1/lineage", returns: "JSON" },
  { field: "rpc_endpoints", route: "/api/v1/rpc/endpoints", returns: "JSON" },
  { field: "changelog", route: "/api/v1/changelog", returns: "Changelog" },
  { field: "contracts", route: "/api/v1/contracts", returns: "Contracts" },
  { field: "build", route: "/api/v1/build", returns: "BuildSummary" },
  { field: "self_health", route: "/api/v1/self-health", returns: "SelfHealth" },
  {
    field: "health_history",
    route: "/api/v1/health/history/{date}",
    returns: "HealthHistory",
  },
  { field: "health", route: null, returns: "GlobalHealth" },
  { field: "opportunity_boards", route: null, returns: "OpportunityBoards" },
  { field: "compare", route: "/api/v1/compare", returns: "Compare" },
  {
    field: "incidents",
    route: "/api/v1/incidents",
    returns: "GlobalIncidents",
  },
  {
    field: "global_incidents",
    route: "/api/v1/incidents",
    returns: "GlobalIncidents",
  },
  {
    field: "extrinsics",
    route: "/api/v1/extrinsics",
    returns: "ExtrinsicList",
  },
  {
    field: "chain_events",
    route: "/api/v1/chain-events",
    returns: "ChainEventsFeed",
  },
  {
    field: "chain_events_stats",
    route: "/api/v1/chain-events/stats",
    returns: "ChainEventsStats",
  },
  {
    field: "extrinsic",
    route: "/api/v1/extrinsics/{ref}",
    returns: "ExtrinsicDetail",
  },
  {
    field: "governance_config_changes",
    route: "/api/v1/governance/config-changes",
    returns: "ExtrinsicList",
  },
  { field: "blocks", route: "/api/v1/blocks", returns: "BlockList" },
  { field: "block", route: "/api/v1/blocks/{ref}", returns: "BlockDetail" },
  {
    field: "block_extrinsics",
    route: "/api/v1/blocks/{ref}/extrinsics",
    returns: "BlockExtrinsics",
  },
  {
    field: "block_events",
    route: "/api/v1/blocks/{ref}/events",
    returns: "BlockEvents",
  },
  {
    field: "block_chain_events",
    route: "/api/v1/blocks/{block_number}/chain-events",
    returns: "BlockChainEvents",
  },
  {
    field: "blocks_summary",
    route: "/api/v1/blocks/summary",
    returns: "BlocksSummary",
  },
  {
    field: "runtime",
    route: "/api/v1/runtime",
    returns: "RuntimeVersionHistory",
  },
  {
    field: "validators",
    route: "/api/v1/validators",
    returns: "ValidatorList",
  },
  {
    field: "validator",
    route: "/api/v1/validators/{hotkey}",
    returns: "Validator",
  },
  {
    field: "validator_nominators",
    route: "/api/v1/validators/{hotkey}/nominators",
    returns: "NominatorList",
  },
  {
    field: "validator_history",
    route: "/api/v1/validators/{hotkey}/history",
    returns: "ValidatorHistory",
  },
  { field: "accounts", route: "/api/v1/accounts", returns: "AccountList" },
  {
    field: "account",
    route: "/api/v1/accounts/{ss58}",
    returns: "AccountSummary",
  },
  {
    field: "account_prometheus",
    route: "/api/v1/accounts/{ss58}/prometheus",
    returns: "AccountPrometheus",
  },
  {
    field: "account_registrations",
    route: "/api/v1/accounts/{ss58}/registrations",
    returns: "AccountRegistrations",
  },
  {
    field: "account_deregistrations",
    route: "/api/v1/accounts/{ss58}/deregistrations",
    returns: "AccountDeregistrations",
  },
  {
    field: "account_stake_flow",
    route: "/api/v1/accounts/{ss58}/stake-flow",
    returns: "AccountStakeFlow",
  },
  {
    field: "account_position_history",
    route: "/api/v1/accounts/{ss58}/subnets/{netuid}/history",
    returns: "AccountPositionHistory",
  },
  {
    field: "account_portfolio",
    route: "/api/v1/accounts/{ss58}/portfolio",
    returns: "AccountPortfolio",
  },
  {
    field: "account_positions",
    route: "/api/v1/accounts/{ss58}/positions",
    returns: "AccountPositions",
  },
  {
    field: "account_subnets",
    route: "/api/v1/accounts/{ss58}/subnets",
    returns: "AccountSubnets",
  },
  {
    field: "account_serving",
    route: "/api/v1/accounts/{ss58}/serving",
    returns: "AccountServing",
  },
  {
    field: "account_axon_removals",
    route: "/api/v1/accounts/{ss58}/axon-removals",
    returns: "AccountAxonRemovals",
  },
  {
    field: "account_stake_moves",
    route: "/api/v1/accounts/{ss58}/stake-moves",
    returns: "AccountStakeMoves",
  },
  {
    field: "account_weight_setters",
    route: "/api/v1/accounts/{ss58}/weight-setters",
    returns: "AccountWeightSetters",
  },
  {
    field: "account_entities",
    route: "/api/v1/accounts/{ss58}/entities",
    returns: "AccountEntities",
  },
  {
    field: "account_identity",
    route: "/api/v1/accounts/{ss58}/identity",
    returns: "AccountIdentity",
  },
  {
    field: "account_identity_history",
    route: "/api/v1/accounts/{ss58}/identity-history",
    returns: "AccountIdentityHistory",
  },
  {
    field: "account_counterparties",
    route: "/api/v1/accounts/{ss58}/counterparties",
    returns: "AccountCounterparties",
  },
  {
    field: "account_transfers",
    route: "/api/v1/accounts/{ss58}/transfers",
    returns: "AccountTransfers",
  },
  {
    field: "account_extrinsics",
    route: "/api/v1/accounts/{ss58}/extrinsics",
    returns: "AccountExtrinsics",
  },
  {
    field: "account_events",
    route: "/api/v1/accounts/{ss58}/events",
    returns: "AccountEvents",
  },
  {
    field: "account_history",
    route: "/api/v1/accounts/{ss58}/history",
    returns: "AccountHistory",
  },
  {
    field: "economics_trends",
    route: "/api/v1/economics/trends",
    returns: "EconomicsTrends",
  },
  {
    field: "emission_pipeline",
    route: "/api/v1/chain/emission-pipeline",
    returns: "EmissionPipeline",
  },
  {
    field: "registry_leaderboards",
    route: "/api/v1/registry/leaderboards",
    returns: "RegistryLeaderboards",
  },
  {
    field: "subnet_movers",
    route: "/api/v1/subnets/movers",
    returns: "SubnetMovers",
  },
  {
    field: "chain_turnover",
    route: "/api/v1/chain/turnover",
    returns: "ChainTurnover",
  },
  {
    field: "chain_identity_history",
    route: "/api/v1/chain/identity-history",
    returns: "ChainIdentityHistory",
  },
  {
    field: "chain_weights",
    route: "/api/v1/chain/weights",
    returns: "ChainWeights",
  },
  {
    field: "chain_serving",
    route: "/api/v1/chain/serving",
    returns: "ChainServing",
  },
  { field: "chain_calls", route: "/api/v1/chain/calls", returns: "ChainCalls" },
  {
    field: "chain_prometheus",
    route: "/api/v1/chain/prometheus",
    returns: "ChainPrometheus",
  },
  {
    field: "chain_deregistrations",
    route: "/api/v1/chain/deregistrations",
    returns: "ChainDeregistrations",
  },
  {
    field: "chain_registrations",
    route: "/api/v1/chain/registrations",
    returns: "ChainRegistrations",
  },
  { field: "chain_fees", route: "/api/v1/chain/fees", returns: "ChainFees" },
  {
    field: "chain_activity",
    route: "/api/v1/chain/activity",
    returns: "ChainActivity",
  },
  {
    field: "chain_axon_removals",
    route: "/api/v1/chain/axon-removals",
    returns: "ChainAxonRemovals",
  },
  {
    field: "chain_weight_setters",
    route: "/api/v1/chain/weights/setters",
    returns: "ChainWeightSetters",
  },
  {
    field: "chain_signers",
    route: "/api/v1/chain/signers",
    returns: "ChainSigners",
  },
  {
    field: "health_trends",
    route: "/api/v1/health/trends",
    returns: "HealthTrends",
  },
  { field: "rpc_usage", route: "/api/v1/rpc/usage", returns: "RpcUsage" },
  {
    field: "chain_performance",
    route: "/api/v1/chain/performance",
    returns: "ChainPerformance",
  },
  { field: "chain_yield", route: "/api/v1/chain/yield", returns: "ChainYield" },
  {
    field: "chain_concentration",
    route: "/api/v1/chain/concentration",
    returns: "ChainConcentration",
  },
  {
    field: "chain_alpha_volume",
    route: "/api/v1/chain/alpha-volume",
    returns: "ChainAlphaVolume",
  },
  {
    field: "chain_idle_stake",
    route: "/api/v1/chain/idle-stake",
    returns: "ChainIdleStake",
  },
  {
    field: "chain_stake_flow",
    route: "/api/v1/chain/stake-flow",
    returns: "ChainStakeFlow",
  },
  {
    field: "chain_stake_moves",
    route: "/api/v1/chain/stake-moves",
    returns: "ChainStakeMoves",
  },
  {
    field: "chain_stake_transfers",
    route: "/api/v1/chain/stake-transfers",
    returns: "ChainStakeTransfers",
  },
  {
    field: "chain_transfer_pairs",
    route: "/api/v1/chain/transfer-pairs",
    returns: "ChainTransferPairs",
  },
  {
    field: "chain_transfers",
    route: "/api/v1/chain/transfers",
    returns: "ChainTransfers",
  },
  {
    field: "subnet_recycled",
    route: "/api/v1/subnets/{netuid}/recycled",
    returns: "SubnetRecycled",
  },
  {
    field: "subnet_burn",
    route: "/api/v1/subnets/{netuid}/burn",
    returns: "SubnetBurn",
  },
  { field: "chain_burn", route: null, returns: "ChainBurn" },
  { field: "subnet_burn_history", route: null, returns: "SubnetBurnHistory" },
  {
    field: "subnet_turnover",
    route: "/api/v1/subnets/{netuid}/turnover",
    returns: "SubnetTurnover",
  },
  {
    field: "subnet_ownership_history",
    route: "/api/v1/subnets/{netuid}/ownership-history",
    returns: "SubnetOwnershipHistory",
  },
  {
    field: "subnet_conviction",
    route: "/api/v1/subnets/{netuid}/conviction",
    returns: "SubnetConviction",
  },
  {
    field: "subnet_lease",
    route: "/api/v1/subnets/{netuid}/lease",
    returns: "SubnetLease",
  },
  {
    field: "subnet_lease_history",
    route: "/api/v1/subnets/{netuid}/lease/history",
    returns: "SubnetLeaseHistory",
  },
  {
    field: "account_balance",
    route: "/api/v1/accounts/{ss58}/balance",
    returns: "AccountBalance",
  },
  {
    field: "account_root_claim",
    route: "/api/v1/accounts/{ss58}/root-claim",
    returns: "AccountRootClaim",
  },
  {
    field: "account_children",
    route: "/api/v1/accounts/{ss58}/children",
    returns: "AccountChildren",
  },
  {
    field: "account_parents",
    route: "/api/v1/accounts/{ss58}/parents",
    returns: "AccountParents",
  },
  { field: "sudo_key", route: "/api/v1/sudo/key", returns: "SudoKey" },
  {
    field: "network_parameters",
    route: "/api/v1/network/parameters",
    returns: "NetworkParameters",
  },
  {
    field: "network_randomness",
    route: "/api/v1/network/randomness",
    returns: "NetworkRandomness",
  },
  {
    field: "randomness_status",
    route: "/api/v1/network/randomness",
    returns: "NetworkRandomness",
  },
  {
    field: "evm_address",
    route: "/api/v1/evm/address/{h160}",
    returns: "EvmAddressMapping",
  },
  {
    field: "evm_address_mapping",
    route: "/api/v1/evm/address/{h160}",
    returns: "EvmAddressMapping",
  },
  { field: "sudo", route: "/api/v1/sudo", returns: "ExtrinsicList" },
];

/** A published type the resolver PROJECTS from a component (#10214). */
export interface ProjectedType {
  /** The component it picks its fields from. */
  readonly component: string;
  /**
   * Fields the resolver adds that the component does not supply -- an
   * association it resolves separately, or a value it computes. Declared so a
   * typo'd or invented field is a failure rather than a silent extra.
   */
  readonly added: readonly string[];
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
  Subnet: {
    component: "SubnetIndexEntry",
    added: ["health", "economics", "surfaces", "endpoints"],
  },
  Provider: { component: "Provider", added: ["subnets", "endpoints"] },
  Surface: { component: "Surface", added: [] },
  Endpoint: { component: "EndpointResource", added: [] },
  SubnetHealth: { component: "HealthSubnetSummary", added: [] },
  OpportunityEntry: {
    component: "SubnetDetailArtifactEconomics",
    added: ["validator_headroom"],
  },
  ExtrinsicDetail: { component: "ExtrinsicDetailArtifact", added: [] },
  ChainBurn: { component: "ChainBurnArtifact", added: [] },
  SubnetBurnHistory: { component: "SubnetBurnHistoryArtifact", added: [] },
  SubnetBurnHistoryPoint: { component: "SubnetBurnHistoryPoint", added: [] },
  ChainBurnEntry: { component: "ChainBurnEntry", added: [] },
  BlockChainEvents: { component: "BlockEventsArtifact", added: [] },
  AccountEntry: { component: "AccountsListArtifactAccounts", added: [] },
  AccountSubnet: { component: "AccountPortfolioArtifactPositions", added: [] },
};

/**
 * Types a resolver builds, with no component behind them.
 *
 * A pagination view (`{items, total, next_cursor}`) is the resolver's shape,
 * not a mirror of the artifact it pages over, and the remaining entries are
 * hand-shaped cards. The generator emits these from the resolver side; the
 * component emitter never sees them.
 *
 * Anything that picks its fields from a component belongs in `PROJECTED_TYPES`
 * instead, where it gets checked.
 */
export const RESOLVER_BUILT_TYPES: readonly string[] = [
  "SubnetList",
  "ProviderList",
  "GlobalHealth",
  "OpportunityBoards",
  "SubnetTrajectoryDelta",
  "EmissionGateChange",
  "Subscription",
  "ChainEvent",
];
