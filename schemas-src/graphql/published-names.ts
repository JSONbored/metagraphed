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
  /** The published return type, nullability included -- `SubnetList!`. */
  returns: string;
  /**
   * The published field description, verbatim.
   *
   * NOT derived from the route's own description, which was the first thing
   * tried: zero of the 196 GraphQL descriptions start with their route's, and
   * reading a sample says why. REST's prose talks about `?limit=`, `?format=
   * csv` and "Fetch …", none of which a GraphQL caller can act on, while
   * GraphQL's states the thing REST has no word for -- "resolves to a
   * schema-stable zeroed card, never null" is a nullability promise about
   * THIS surface. Deriving one from the other would make both worse.
   *
   * So this is documentation, not shape, and it lives in exactly one place --
   * here, beside the binding it documents -- the way `API_ROUTES[].description`
   * is the one place REST's lives. Extracted from `src/graphql-sdl.ts` by
   * codemod at the commit that added the field; from here it is the source and
   * the SDL is generated from it.
   */
  description: string;
}

export const QUERY_BINDINGS: readonly QueryBinding[] = [
  {
    field: "subnets",
    route: null,
    returns: "SubnetList!",
    description:
      "Paginated active-subnet index. Reads the same static /metagraph/subnets.json artifact as the list_subnets MCP tool and supports its full query surface: network scoping, categorical inclusion + negation filters, min_/max_ range bounds, and sort/order.",
  },
  {
    field: "subnet",
    route: null,
    returns: "Subnet",
    description:
      "One subnet with its health, surfaces, endpoints, and economics. network scopes which static artifact the registry-metric backfill reads (finney default, test for testnet), mirroring list_subnets.",
  },
  {
    field: "subnet_registrations",
    route: "/api/v1/subnets/{netuid}/registrations",
    returns: "SubnetRegistrations!",
    description:
      "Per-subnet neuron-registration activity over a 7d/30d window (distinct registrants, NeuronRegistered count, and registrations per registrant); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/registrations.",
  },
  {
    field: "subnet_hyperparameters",
    route: "/api/v1/subnets/{netuid}/hyperparameters",
    returns: "SubnetHyperparameters",
    description:
      "One subnet's live on-chain hyperparameters (latest snapshot only). The hyperparameters block is null when the subnet has no captured row -- a schema-stable card, never a GraphQL error, matching the Query.block ref-lookup convention. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters.",
  },
  {
    field: "subnet_hyperparameters_history",
    route: "/api/v1/subnets/{netuid}/hyperparameters/history",
    returns: "SubnetHyperparamsHistory!",
    description:
      "One subnet's append-only hyperparameter-change history, newest first, one entry per observed change. Forward-only: entries exist only from when the diff-on-change write started. A subnet with no recorded changes resolves to an empty entry list, never null. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters/history.",
  },
  {
    field: "subnet_lifecycle",
    route: "/api/v1/subnets/{netuid}/lifecycle",
    returns: "SubnetLifecycle!",
    description:
      "When one subnet was registered or deregistered, newest first. Entries with predates_capture=true are older than detection and carry a null block_number -- a real answer, not a missing one. A subnet with no recorded transition resolves to an empty entry list, never null. Mirrors GET /api/v1/subnets/{netuid}/lifecycle.",
  },
  {
    field: "chain_subnet_lifecycle",
    route: "/api/v1/chain/subnet-lifecycle",
    returns: "ChainSubnetLifecycle!",
    description:
      "Every subnet's registrations and deregistrations across the network, newest first. window is 7d|30d|90d|1y|all and defaults to all, because a subnet changes state a handful of times in its lifetime. Mirrors GET /api/v1/chain/subnet-lifecycle.",
  },
  {
    field: "subnet_deregistrations",
    route: "/api/v1/subnets/{netuid}/deregistrations",
    returns: "SubnetDeregistrations!",
    description:
      "Per-subnet neuron-deregistration activity over a 7d/30d window (distinct deregistered hotkeys, deregistration count, and deregistrations per hotkey), DERIVED from UID reuse in the NeuronRegistered stream -- NeuronDeregistered has never been emitted by the runtime (#9307). A subnet with no slot turnover in the window resolves to a schema-stable zeroed card, never null; when nothing derived the window the card carries a degraded block instead of a confident zero. Mirrors GET /api/v1/subnets/{netuid}/deregistrations.",
  },
  {
    field: "subnet_serving",
    route: "/api/v1/subnets/{netuid}/serving",
    returns: "SubnetServing!",
    description:
      "Per-subnet axon-serving activity over a 7d/30d window (distinct servers, AxonServed announcement count, and announcements per server); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/serving.",
  },
  {
    field: "subnet_health_trends",
    route: "/api/v1/subnets/{netuid}/health/trends",
    returns: "SubnetHealthTrends!",
    description:
      "One subnet's uptime + success-only latency trend windows (7d/30d) from the live health-probe history: per-window samples, uptime_ratio, latency sample count, and the per-surface uptime/latency series. A subnet with no probe history resolves to a schema-stable zeroed-windows card, never null. Mirrors GET /api/v1/subnets/{netuid}/health/trends.",
  },
  {
    field: "subnet_uptime",
    route: "/api/v1/subnets/{netuid}/uptime",
    returns: "SubnetUptime!",
    description:
      "One subnet's long-term daily uptime history for its operational surfaces from the live surface_uptime_daily rollup: per-surface day series, window-wide uptime ratios, and reliability scores for the requested window (90d or 1y, default 90d). Optional min_samples drops day rows whose daily probe count is below the threshold (including zero-sample 'unknown' days). A subnet with no history resolves to a schema-stable empty card (surfaces []), never null. Mirrors GET /api/v1/subnets/{netuid}/uptime.",
  },
  {
    field: "subnet_health_incidents",
    route: "/api/v1/subnets/{netuid}/health/incidents",
    returns: "SubnetHealthIncidents!",
    description:
      "One subnet's per-surface SLA (uptime ratio) and reconstructed downtime incidents over a 7d/30d window (default 7d), computed live from the health-probe history: each surface's sample count, uptime_ratio, incident_count, total downtime_ms, and the gap-island incident list. A subnet with no probe history resolves to a schema-stable empty surfaces list, never null. Mirrors GET /api/v1/subnets/{netuid}/health/incidents.",
  },
  {
    field: "subnet_health_percentiles",
    route: "/api/v1/subnets/{netuid}/health/percentiles",
    returns: "SubnetHealthPercentiles!",
    description:
      "One subnet's per-surface latency percentiles (p50/p90/p95/p99) over a 7d/30d window (default 7d), computed live from the success-only health-probe history. The latency-distribution companion of subnet_health_incidents' availability view. A subnet with no probe history resolves to a schema-stable empty surfaces list, never null. Mirrors GET /api/v1/subnets/{netuid}/health/percentiles.",
  },
  {
    field: "subnet_health",
    route: "/api/v1/subnets/{netuid}/health",
    returns: "JSON",
    description:
      "One subnet's current live operational-health card: the per-surface status/latency/last-ok rows from the latest ~15-minute cron probe (summarized into ok/degraded/failed/unknown counts) plus the cross-window reliability score. The at-a-glance base card completing the health family whose windowed views are subnet_health_trends/subnet_health_incidents/subnet_health_percentiles. A subnet with no live health data resolves to the same schema-stable unknown card (summary.status of unknown, empty surfaces), never null. Filter with kind, provider, status, and classification; sort with sort + order; project with fields; and page with limit (1-100) / cursor, exactly as REST does -- an unsupported value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST reports (total, returned, limit, cursor, next_cursor, sort, order) alongside the surfaces. Opaque JSON otherwise matching the get_subnet_health MCP/REST shape (the existing typed SubnetHealth is the flat health-list item, a different shape, so this base card is JSON like the sibling surfaces payloads). Mirrors GET /api/v1/subnets/{netuid}/health.",
  },
  {
    field: "subnet_volume",
    route: "/api/v1/subnets/{netuid}/volume",
    returns: "SubnetVolume!",
    description:
      "One subnet's rolling 24h alpha trading volume from the StakeAdded/StakeRemoved trade stream: buy/sell volume in alpha and TAO, trade counts, net flow, a buy-vs-sell sentiment ratio, and volume-to-market-cap ratio. A subnet with no trades resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/volume.",
  },
  {
    field: "agent_resources",
    route: "/api/v1/agent-resources",
    returns: "JSON",
    description:
      "The machine-readable AI-resources index: the copyable agent prompt (/agent.md), MCP server install metadata and tool listing, the Bittensor skill, llms.txt, OpenAPI, and links to the agent-facing APIs. Use it to bootstrap an agent integration before calling the catalog/search fields. Null when the index has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_agent_resources MCP/REST shape. Mirrors GET /api/v1/agent-resources.",
  },
  {
    field: "curation",
    route: "/api/v1/curation",
    returns: "CurationList!",
    description:
      "Per-subnet curation states with full REST filter parity: each subnet's coverage_level, curation_level, and source counts. Filter by netuid/coverage_level/curation_level, sort with sort/order, and page with limit (1-100)/cursor. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the curation rows, as opaque JSON. An invalid filter/sort is a GraphQL error, and a cold/absent artifact is a GraphQL error (matching REST/MCP not_found), not a null. Mirrors GET /api/v1/curation.",
  },
  {
    field: "candidates",
    route: "/api/v1/candidates",
    returns: "JSON",
    description:
      "The discovered candidate-surface ledger: every machine-discovered surface awaiting review, with its subnet (netuid), kind, provider, and review state. Filter by netuid/kind/provider/state/id/confidence, sort with sort + order, and page with limit (1-1000) / cursor, exactly like the REST route — an unsupported filter/sort value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the candidates rows, as opaque JSON. A cold/absent artifact is a GraphQL error (matching REST/MCP not_found). Mirrors GET /api/v1/candidates.",
  },
  {
    field: "saved_query",
    route: "/api/v1/queries/{id}",
    returns: "JSON",
    description:
      "Run one maintainer-curated saved-query template by id, with its template-defined params object -- the same parameterized query library REST and the run_saved_query MCP tool execute. Resolves to {query_id, params, data} as opaque JSON. An unknown id or invalid params is a BAD_USER_INPUT error listing the valid template ids, not a silently substituted default. Mirrors GET /api/v1/queries/{id}.",
  },
  {
    field: "fixtures",
    route: "/api/v1/fixtures",
    returns: "JSON",
    description:
      "The recorded response fixtures for registered surfaces, used to replay/verify a surface without calling it. Null when no fixture index has been baked in this environment. Opaque JSON passed through verbatim, matching the list_fixtures MCP/REST shape. Mirrors GET /api/v1/fixtures.",
  },
  {
    field: "fixture",
    route: "/api/v1/fixtures/{surface_id}",
    returns: "JSON",
    description:
      "One captured live request/response fixture by surface_id — the sanitized sample get_fixture / GET /api/v1/fixtures/{surface_id} return. Resolves deprecated surface_id aliases the same way MCP does. Null when no fixture exists for the id (rather than a GraphQL error). An invalid surface_id is BAD_USER_INPUT. Opaque JSON passed through verbatim. Mirrors GET /api/v1/fixtures/{surface_id}.",
  },
  {
    field: "agent_catalog",
    route: "/api/v1/agent-catalog",
    returns: "JSON",
    description:
      "The agent-callable service catalog: without a netuid, the global index of subnets exposing callable services; with one, that subnet's full per-service catalog. Both are overlaid with live health exactly as REST composes them. Null when the catalog has not been baked. Opaque JSON, matching the get_agent_catalog MCP/REST shape. Mirrors GET /api/v1/agent-catalog.",
  },
  {
    field: "freshness",
    route: "/api/v1/freshness",
    returns: "JSON",
    description:
      "Artifact freshness: each published artifact's generated_at/age, merged with the live cron snapshot stamp when the health store is warm. Null when no freshness artifact has been baked. Opaque JSON, matching the get_freshness MCP/REST shape. Mirrors GET /api/v1/freshness.",
  },
  {
    field: "top_holders",
    route: "/api/v1/accounts/top-holders",
    returns: "JSON",
    description:
      "The largest TAO holders ranked by the chosen sort (total_tao by default), limit 1-100 (default 20). An unknown sort is a BAD_USER_INPUT error. Resolves to a schema-stable empty list when every holders tier is cold, never null. TWO TIERS (#9469): the net_flow_7d/30d/90d sorts are LIVE, recomputed daily from the account_events stake stream; the free_tao/delegated_tao/total_tao sorts are served from a fixed snapshot taken 2026-08-02 whose source scan has no writer any more, so on those captured_at/last_updated do not advance and balances are as of that date -- read that ranking as historical, and use account(ss58) for a live balance. On a flow-sorted page the three holdings columns are null, never zero. Opaque JSON, matching the get_top_holders MCP/REST shape. Mirrors GET /api/v1/accounts/top-holders.",
  },
  {
    field: "search",
    route: "/api/v1/search",
    returns: "SearchDocumentList!",
    description:
      "The full compact search index: one document per subnet/surface/provider/doc, each with its id, type, title, subtitle, url, and the per-document token blob that widens server-side recall. Filter by type/netuid, keyword-search with q, sort with sort/order, and page with limit (1-100)/cursor -- the same list-query transforms REST and MCP apply. An invalid type/sort/order/limit/cursor is a GraphQL error, not a silently substituted default. Documents are heterogeneous by type, so each is passed through as opaque JSON. Mirrors GET /api/v1/search.",
  },
  {
    field: "search_index",
    route: "/api/v1/search-index",
    returns: "SearchIndexList!",
    description:
      "The slim search index -- the same documents as search without the per-document token blobs, for fast browser typeahead and listing. Filter by type/netuid/q, sort with sort/order, and page with limit/cursor. An invalid filter/sort/limit/cursor is a GraphQL error. Mirrors GET /api/v1/search-index.",
  },
  {
    field: "domains",
    route: "/api/v1/domains",
    returns: "DomainOverview!",
    description:
      "The per-domain rollup overview: every tag in the fixed 14-tag capability taxonomy with its member subnet count, total stake, total emission share, and within-domain emission concentration. Computed live from the subnets index + economics tier. Mirrors GET /api/v1/domains.",
  },
  {
    field: "domain_summary",
    route: "/api/v1/domains/{tag}/summary",
    returns: "DomainSummary!",
    description:
      "One domain/capability tag's own rollup. tag must be one of the 14 fixed domain tags (the same enum ?domain= validates on subnets); an unknown tag is a BAD_USER_INPUT error. Mirrors GET /api/v1/domains/{tag}/summary.",
  },
  {
    field: "compare_validators",
    route: "/api/v1/compare/validators",
    returns: "ValidatorComparison!",
    description:
      "Several validators side by side for a stake/delegate decision: each hotkey's take, estimated APY, nominator count, identity, and cross-subnet stake/emission/trust aggregates. hotkeys takes 1-16 distinct SS58 addresses (a real GraphQL list, like the sibling compare field's netuids, rather than REST's comma-separated string); the optional netuid adds each validator's membership row in that subnet. The validator equivalent of the compare field. Mirrors GET /api/v1/compare/validators.",
  },
  {
    field: "coverage",
    route: "/api/v1/coverage",
    returns: "JSON",
    description:
      "The registry coverage summary: surface/subnet counts, domain coverage, and overall completeness across the whole Bittensor application layer. Null when the coverage artifact has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_coverage MCP/REST shape. Mirrors GET /api/v1/coverage.",
  },
  {
    field: "coverage_depth",
    route: "/api/v1/coverage-depth",
    returns: "JSON",
    description:
      "The machine-usable coverage-depth scorecard and ranked enrichment queue: per-subnet tier/score/priority rows plus the ranked queue of enrichment targets. Null when the coverage-depth artifact has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the /api/v1/coverage-depth REST shape. Mirrors GET /api/v1/coverage-depth.",
  },
  {
    field: "subnet_ohlc",
    route: "/api/v1/subnets/{netuid}/ohlc",
    returns: "SubnetOhlc!",
    description:
      "One subnet's alpha-price OHLC candles bucketed by interval (1h or 1d, default 1h) over the trailing days window (default 90, max 365), from the same executed-trade stream subnet_volume reads. A subnet with no trades resolves to a schema-stable empty candle list, never null. Mirrors GET /api/v1/subnets/{netuid}/ohlc.",
  },
  {
    field: "subnet_stake_quote",
    route: "/api/v1/subnets/{netuid}/stake-quote",
    returns: "SubnetStakeQuote!",
    description:
      "A read-only quote for a hypothetical stake/unstake against one subnet's live AMM pool: expected amount out, spot vs effective price, and estimated price impact. Computes nothing on-chain and signs nothing. Mirrors GET /api/v1/subnets/{netuid}/stake-quote.",
  },
  {
    field: "validator_economics",
    route: "/api/v1/validators/economics",
    returns: "ValidatorEconomicsRanking!",
    description:
      "Rank every subnet by what it costs to become an EARNING validator there: the same fields as subnet_validator_economics, one row per subnet, sortable by earning_floor_cost_tao (default, cheapest first), permit_floor_cost_tao, permit_to_earning_multiple, tao_inflow_per_day or validator_headroom, and filterable on emission_gate_open / cap_binding (omitting a filter means BOTH, which is not the same as false). Every subnet the ranking drops is returned in the excluded list with a reason. The registration burn is excluded from the ranking -- it is a live per-subnet read and immaterial to the order. Mirrors GET /api/v1/validators/economics.",
  },
  {
    field: "subnet_validator_economics_history",
    route: "/api/v1/subnets/{netuid}/validator-economics/history",
    returns: "SubnetValidatorEconomicsHistory!",
    description:
      "Whether validating on one subnet is getting cheaper or more expensive: a daily series of the OBSERVED permit floor and earning floor in alpha (the smallest stake that actually held a permit, and that actually earned, each day), validator set composition as three separate counts, and the emission-gate state with daily TAO inflow. window accepts 7d, 30d or 90d (default 30d). TAO cost is deliberately absent from the series -- a historical cost needs the pool reserves as they were, and reconstructing one from today's reserves would be wrong; alpha floors are unambiguous. Mirrors GET /api/v1/subnets/{netuid}/validator-economics/history.",
  },
  {
    field: "subnet_validator_economics",
    route: "/api/v1/subnets/{netuid}/validator-economics",
    returns: "SubnetValidatorEconomics!",
    description:
      "What it costs to validate on one subnet and whether a permit there earns: the permit floor and the earning floor (which differ by a median of ~7x -- a permit is not income), the TAO to reach each priced against live pool reserves plus the registration burn, open validator slots, the commission (take) distribution among permit-holders, the emission-gate state, and the live StakeThreshold/TaoWeight the floors were derived against. Permitted, active and earning are three different counts and all three are returned. Every derived field is nullable and degrades with a stated reason rather than reporting a confident zero. Mirrors GET /api/v1/subnets/{netuid}/validator-economics.",
  },
  {
    field: "subnet_validators",
    route: "/api/v1/subnets/{netuid}/validators",
    returns: "SubnetValidatorList!",
    description:
      "One subnet's current validator set (permitted neurons) from the live metagraph snapshot, with each validator's full neuron record. A subnet with no snapshot resolves to a schema-stable empty list, never null. Mirrors GET /api/v1/subnets/{netuid}/validators.",
  },
  {
    field: "subnet_event_summary",
    route: "/api/v1/subnets/{netuid}/event-summary",
    returns: "SubnetEventSummary!",
    description:
      "One subnet's chain-event activity summary over a 7d/30d/90d window (default 30d): total events, the per-kind and per-category breakdowns with hotkey/coldkey participation and TAO/alpha amounts, and a bounded newest-first recent-event list (limit 1-50, default 10). A subnet with no events resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/event-summary.",
  },
  {
    field: "subnet_gaps",
    route: "/api/v1/subnets/{netuid}/gaps",
    returns: "JSON",
    description:
      "One subnet's registry gap report — the reviewer-facing list of missing/incomplete surface coverage backing its curation state. Null when no gap report has been baked for the netuid (rather than a GraphQL error). Filter with curation_level, missing_kinds, and review_state; sort with sort + order; project with fields; and page with limit (1-100) / cursor, exactly as REST does -- an unsupported filter/sort value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the priorities rows. Mirrors GET /api/v1/subnets/{netuid}/gaps.",
  },
  {
    field: "subnet_evidence",
    route: "/api/v1/subnets/{netuid}/evidence",
    returns: "JSON",
    description:
      "One subnet's curation evidence record — the provenance trail (source URLs, checks, reviewer notes) behind its registry entry. Search with q across subject, claim, source_url, and support_summary; sort with sort + order; project with fields; and page with limit (1-100) / cursor, exactly as REST does — an unsupported sort/limit/cursor is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the claims rows. Null when no evidence record has been baked for the netuid (rather than a GraphQL error). Mirrors GET /api/v1/subnets/{netuid}/evidence.",
  },
  {
    field: "subnet_candidates",
    route: "/api/v1/subnets/{netuid}/candidates",
    returns: "JSON",
    description:
      "One subnet's unpromoted candidate-surface queue — the baked per-subnet /metagraph/candidates/{netuid}.json artifact the REST route and get_subnet_candidates MCP tool read. Filter with kind, provider, state, id, and confidence; sort with sort + order; and page with limit (1-100) / cursor, exactly as REST does — an unsupported filter/sort value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the candidates rows. Null when no candidate artifact has been baked for the netuid (rather than a GraphQL error). Distinct from candidates(...) (the filterable network-wide candidate catalog). Mirrors GET /api/v1/subnets/{netuid}/candidates.",
  },
  {
    field: "subnet_endpoints",
    route: "/api/v1/subnets/{netuid}/endpoints",
    returns: "JSON",
    description:
      "One subnet's endpoint/resource registry as a filtered/sorted/paged list — the baked per-subnet /metagraph/endpoints/{netuid}.json artifact the REST route and list_subnet_endpoints MCP tool read. Filter with kind, layer, provider, publication_state, status, and pool_eligible (a true/false string); threshold with min_/max_latency_ms and min_/max_score; project with fields; sort with sort + order; and page with limit (1-100) / cursor, exactly as REST does — an unsupported filter/sort value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the endpoints rows. Null when no endpoint artifact has been baked for the netuid (rather than a GraphQL error). Distinct from endpoints(...) (the filterable network-wide endpoint registry). Mirrors GET /api/v1/subnets/{netuid}/endpoints.",
  },
  {
    field: "subnet_axon_removals",
    route: "/api/v1/subnets/{netuid}/axon-removals",
    returns: "SubnetAxonRemovals!",
    description:
      "Per-subnet axon-removal activity over a 7d/30d window (distinct removers, AxonInfoRemoved count, and removals per remover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/axon-removals.",
  },
  {
    field: "subnet_weights",
    route: "/api/v1/subnets/{netuid}/weights",
    returns: "SubnetWeights!",
    description:
      "Per-subnet validator weight-setting activity over a 7d/30d window (distinct weight-setters, WeightsSet count, and sets per setter); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/weights.",
  },
  {
    field: "subnet_stake_moves",
    route: "/api/v1/subnets/{netuid}/stake-moves",
    returns: "SubnetStakeMoves!",
    description:
      "Per-subnet stake-movement (re-delegation) activity over a 7d/30d window (distinct movers, StakeMoved count, and movements per mover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-moves.",
  },
  {
    field: "subnet_stake_transfers",
    route: "/api/v1/subnets/{netuid}/stake-transfers",
    returns: "SubnetStakeTransfers!",
    description:
      "Per-subnet stake-transfer activity over a 7d/30d window (distinct senders, StakeTransferred count, and transfers per sender); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-transfers.",
  },
  {
    field: "subnet_idle_stake",
    route: "/api/v1/subnets/{netuid}/idle-stake",
    returns: "SubnetIdleStake!",
    description:
      "Per-subnet idle-stake scorecard from the current neurons snapshot: stake delegated to a hotkey earning zero dividends right now (no validator permit, or a permitted hotkey whose weight-setting output is zero), plus the neuron and idle-neuron counts; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/idle-stake.",
  },
  {
    field: "subnet_stake_flow",
    route: "/api/v1/subnets/{netuid}/stake-flow",
    returns: "SubnetStakeFlow!",
    description:
      "Per-subnet net stake flow over a 7d/30d/90d window (default 30d): TAO staked (StakeAdded) vs unstaked (StakeRemoved), the net capital flow, and event counts, summed live from the account_events stream. direction narrows to inflow (in) or outflow (out); all (default) reports both. A subnet with no events resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-flow.",
  },
  {
    field: "subnet_events",
    route: "/api/v1/subnets/{netuid}/events",
    returns: "SubnetEvents!",
    description:
      "One subnet's paginated first-party chain-event feed (newest first): each event's kind, block, UID, hot/cold keys, amount, and timestamp. Filter by kind and by block_start/block_end (inclusive block bounds); page with limit (1-1000, default 100)/offset. event_count is the page count, not a grand total. A subnet with no matching events resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/subnets/{netuid}/events.",
  },
  {
    field: "subnet_history",
    route: "/api/v1/subnets/{netuid}/history",
    returns: "SubnetHistory!",
    description:
      "One subnet's daily history from the neuron_daily rollup over a 7d/30d/90d/1y/all window (default 30d): neuron count, validator count, total stake (TAO), and total emission (TAO) per snapshot_date, newest first. A subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/history.",
  },
  {
    field: "subnet_prometheus",
    route: "/api/v1/subnets/{netuid}/prometheus",
    returns: "SubnetPrometheus!",
    description:
      "Per-subnet Prometheus telemetry-endpoint serving activity over a 7d/30d window (default 7d): distinct exporters (hotkeys), PrometheusServed announcement count, and announcements per exporter, summed live from the account_events stream. A subnet with no announcements resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/prometheus.",
  },
  {
    field: "subnet_weight_setters",
    route: "/api/v1/subnets/{netuid}/weights/setters",
    returns: "SubnetWeightSetters!",
    description:
      "Per-subnet weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators behind /weights ranked by WeightsSet activity, each with count, share, and first/last set times; a subnet with no events resolves to a schema-stable empty leaderboard, never null. Mirrors GET /api/v1/subnets/{netuid}/weights/setters.",
  },
  {
    field: "subnet_yield",
    route: "/api/v1/subnets/{netuid}/yield",
    returns: "SubnetYield!",
    description:
      "Per-subnet emission-per-stake yield over the current metagraph snapshot: each UID's yield plus the subnet-wide aggregate and p25/median/p75/p90 distribution; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/yield.",
  },
  {
    field: "subnet_yield_history",
    route: "/api/v1/subnets/{netuid}/yield/history",
    returns: "SubnetYieldHistory!",
    description:
      "Per-subnet per-day emission-per-stake yield trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's subnet-wide yield plus the mean/median/p25/p75/p90 distribution across UIDs, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/yield/history.",
  },
  {
    field: "subnet_performance",
    route: "/api/v1/subnets/{netuid}/performance",
    returns: "SubnetPerformance!",
    description:
      "Per-subnet reward-distribution and score-spread card over the current neurons snapshot: incentive/dividends concentration plus p10–p90 trust/consensus/validator_trust; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/performance.",
  },
  {
    field: "subnet_performance_history",
    route: "/api/v1/subnets/{netuid}/performance/history",
    returns: "SubnetPerformanceHistory!",
    description:
      "Per-subnet per-day reward-distribution and score-spread trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's incentive/dividends Gini, Nakamoto coefficient, and top-10% share plus mean/median trust, consensus, and validator_trust, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/performance/history.",
  },
  {
    field: "subnet_concentration",
    route: "/api/v1/subnets/{netuid}/concentration",
    returns: "SubnetConcentration!",
    description:
      "Per-subnet stake and emission concentration over the current neurons snapshot: raw-UID and per-entity Gini/HHI/Nakamoto/top-K share for stake and emission, validator-only stake concentration, and a uids-per-entity Sybil signal; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration.",
  },
  {
    field: "subnet_holders",
    route: "/api/v1/subnets/{netuid}/holders",
    returns: "SubnetHolders!",
    description:
      "Who OWNS a subnet's alpha: the top coldkeys by alpha held on that netuid, each with its share of the subnet total and how many hotkeys it holds through, plus whole-subnet aggregates (distinct holder count, total measured alpha, top5/top10/top20 concentration). The reverse index of account_positions, which reads the same ledger one coldkey (one account) at a time, and distinct from subnet_concentration: that card is computed off registered UIDs' stake, while this one includes alpha staked to UNREGISTERED hotkeys. Ranked in ALPHA, not TAO. limit caps the rows (default 20, max 100); the aggregates are always computed over the FULL holder set, so holder_count is not the length of what you got back. TWO STATES DECLINE rather than answer, both with an empty holders list, a degraded block and NULL counts: pool_totals_unproven while the pool ledger has no complete pass, and root_not_in_alpha_map for netuid 0, which the chain's Alpha map does not cover. An empty holders list WITHOUT a degraded block is therefore a measurement. Mainnet only. Mirrors GET /api/v1/subnets/{netuid}/holders.",
  },
  {
    field: "chain_holders",
    route: "/api/v1/chain/holders",
    returns: "ChainHolders!",
    description:
      "Every subnet ranked by how concentrated its alpha OWNERSHIP is: per subnet the distinct holder count, measured alpha total, top1/top5/top10/top20 shares and the largest holder's coldkey (an ss58 address). The cross-subnet companion to subnet_holders, which answers one subnet at a time. NOT chain_concentration, which computes Gini/HHI/Nakamoto off registered UIDs' stake and cannot see alpha held on hotkeys with no UID. ALPHA IS NEVER SUMMED ACROSS SUBNETS -- each subnet's alpha is a different token, so total_alpha is per subnet and the network block carries only counts plus the median top-1 share. sort is one of top1_share (default), top5_share, top10_share, top20_share, holder_count, total_alpha; unmeasurable subnets sort LAST. Declines with an empty list plus a degraded block while the pool ledger has no complete pass, so an empty list WITHOUT that block is a measurement. Mainnet only. Mirrors GET /api/v1/chain/holders.",
  },
  {
    field: "chain_concentration_history",
    route: "/api/v1/chain/concentration/history",
    returns: "ChainConcentrationHistory!",
    description:
      "Whether the NETWORK is getting more concentrated: the network-wide concentration card as a per-day series, each point carrying the same five lenses the live card does (stake, emission, entity_stake, entity_emission, validator_stake) plus uids_per_entity and the shape of the day it was computed over. subnet_concentration_history answers one subnet at a time; this answers the whole network. READ builder_versions BEFORE DRAWING A TREND -- each point is a STORED computation, so if the builder changed, points before and after disagree BY CONSTRUCTION rather than because the network moved, and more than one version means the series changes DEFINITION partway along. The depth is the rollup's: neuron_daily is ~27 days deep and the rollup cannot predate it, so a 90d window returns what EXISTS, and a day the capture did not run is ABSENT rather than a zero-concentration point. A NULL scorecard means no measurable distribution, not a missing one. window is 7d, 30d (default) or 90d. An empty window is a measurement. Mainnet only. Mirrors GET /api/v1/chain/concentration/history.",
  },
  {
    field: "subnet_emission_pipeline_history",
    route: "/api/v1/subnets/{netuid}/emission-pipeline/history",
    returns: "SubnetPipelineHistory!",
    description:
      "One subnet's emission-pipeline decomposition OVER TIME: emission share, the TAO split (pool-liquidity injection vs chain buys), alpha in/out emission, miner burned fraction and whether emission is enabled, one point per day, each pinned to the block it was captured at. chain_emission_pipeline answers ONE BLOCK for every subnet; this answers one subnet across days. READ THE DEPTH: the pipeline columns began on 2026-08-02, so a wide window returns the days that EXIST -- first_captured_day says where the series starts. READ distinct_observations, NOT point_count, when claiming a value moved: the snapshot writer carries the last capture forward when a fresh one has not landed, so two consecutive points can be THE SAME OBSERVATION, flagged per point as repeats_previous_observation. Treating one as an independent sample reports a value as FLAT when it was simply not re-measured. window is 7d, 30d (default), 90d or 180d. An empty series is a measurement. Mainnet only. Mirrors GET /api/v1/subnets/{netuid}/emission-pipeline/history.",
  },
  {
    field: "emission_changes",
    route: "/api/v1/chain/governance/emission-changes",
    returns: "EmissionGateChanges!",
    description:
      "Every recorded change to the emission gate -- its governance parameters, the per-subnet emission switches, and the dormant TAO-flow path, in one chronological feed. network_parameters serves these as CURRENT state; this says when they became that and what they were before. CRITICAL FOR COUNTING: predates_capture means the entry is the FIRST OBSERVATION of a value, not a change to it, so subtract predates_capture_count before reporting how often something changed. Each entry carries only the fields its kind has. kind filters to param, subnet or flow; newest first across all three tables. An empty feed is the steady state, not an error. Mainnet only. Mirrors GET /api/v1/chain/governance/emission-changes.",
  },
  {
    field: "failure_reasons",
    route: "/api/v1/health/failure-reasons",
    returns: "FailureReasons!",
    description:
      "WHY registry surfaces fail and whether the mix is changing: the classification breakdown (live, redirected, transient, rate-limited, timeout, dead, content-mismatch, unsupported, auth-required) over a window, plus a per-day series. NOT health_history, which filters one dated snapshot BY classification; this aggregates the reasons themselves. Successful probes are counted too, because a rate needs its denominator -- share is of every probe in the window, failure_share is of the failing ones only and is NULL rather than zero on a succeeding classification. redirected is NOT a failure: a surface answering from a new location is serving. days_covered is counted from the rows, so a day the prober did not run is ABSENT rather than a day of perfect health. window is 7d, 30d (default), 90d or 180d. An empty window is a MEASUREMENT, not a decline. Mainnet only. Mirrors GET /api/v1/health/failure-reasons.",
  },
  {
    field: "indexer_lag",
    route: "/api/v1/chain/indexer-lag",
    returns: "IndexerLag!",
    description:
      "How long after a block is produced it becomes queryable here: the write-latency distribution (min/p50/p95/p99/max/mean, in ms) over the retained block window, plus how far behind the lane is right now. TWO DIFFERENT NUMBERS -- write_latency_ms is how long each block TOOK to land, head_age_ms is how stale the newest block IS, and a stalled lane keeps a perfect latency distribution while its head age climbs without bound, so read head_age_ms for staleness. The window is pruned on a rolling basis, so this is the RECENT distribution and window reports which blocks it covers. A NEGATIVE latency is real -- the two timestamps come from different clocks -- and is served as measured rather than clamped. Null measurements are a DECLINE, not a zero-latency lane; check degraded.reason. Mainnet only. Mirrors GET /api/v1/chain/indexer-lag.",
  },
  {
    field: "tao_usd",
    route: "/api/v1/network/tao-usd",
    returns: "TaoUsd!",
    description:
      "The USD price of one TAO with the derivation behind it, plus the recent series. Composed per ADR 0025 -- a liquidity-weighted median across qualifying wTAO/WETH pools with 2% outlier rejection and a two-pool quorum, multiplied through an ETH/USDC anchor -- because no TAO/USD pair exists on chain. A null usd_per_tao is a STATED OUTCOME (price_basis insufficient_pools), never a zero price. window is 1h, 24h (default), 7d or 30d. The series begins 2026-08-02, so a wide window returns everything that exists and oldest_observed_at says how far back that is. Mainnet only. Mirrors GET /api/v1/network/tao-usd.",
  },
  {
    field: "subnet_surface_history",
    route: "/api/v1/subnets/{netuid}/surface-history",
    returns: "SubnetSurfaceHistory!",
    description:
      "When one subnet's public surfaces were added, changed or removed, and in which commit. subnet_surfaces says what a subnet exposes TODAY; this says when that became true. A delete entry is the ONLY evidence a surface ever existed -- the registry keeps no trace of a removed surface. surface_count counts distinct surfaces with a recorded mutation, which is NOT the current surface count. The full surface record is not repeated here; read subnet_surfaces for that. Newest first. A subnet whose surfaces never changed resolves to an empty trail, never an error. Mainnet only. Mirrors GET /api/v1/subnets/{netuid}/surface-history.",
  },
  {
    field: "subnet_concentration_history",
    route: "/api/v1/subnets/{netuid}/concentration/history",
    returns: "SubnetConcentrationHistory!",
    description:
      "Per-subnet per-day stake and emission concentration trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's stake/emission Gini, Nakamoto coefficient, and top-10% share, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration/history.",
  },
  {
    field: "neuron",
    route: "/api/v1/subnets/{netuid}/neurons/{uid}",
    returns: "Neuron!",
    description:
      "One neuron in a subnet by UID: hot/cold keys, stake, rank, trust, consensus, incentive, dividends, emission, validator permit, immunity, axon, and take. The nested neuron field is null when that UID is absent from the latest snapshot -- a schema-stable card, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}.",
  },
  {
    field: "neuron_history",
    route: "/api/v1/subnets/{netuid}/neurons/{uid}/history",
    returns: "NeuronHistory!",
    description:
      "One neuron's per-day metagraph history in a subnet by UID from the neuron_daily rollup (window: 7d/30d/90d/1y/all, default 30d), newest first: stake, rank, trust, consensus, incentive, dividends, emission, validator permit, axon, and take per snapshot_date. A UID with no matching rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history.",
  },
  {
    field: "subnet_identity_history",
    route: "/api/v1/subnets/{netuid}/identity-history",
    returns: "SubnetIdentityHistory!",
    description:
      "Append-only on-chain SubnetIdentitiesV3 change timeline for one subnet (name, symbol, description, repo, website, discord, logo), newest first; page with limit/offset or follow next_cursor. A subnet with no matching events resolves to a schema-stable empty timeline (entry_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/identity-history.",
  },
  {
    field: "subnet_trajectory",
    route: "/api/v1/subnets/{netuid}/trajectory",
    returns: "SubnetTrajectory!",
    description:
      "One subnet's weekly structural + economics trajectory from the daily snapshots: a chronological series of points (completeness/surface/endpoint counts plus validator/miner counts and economics — stake, alpha price, emission share, pool reserves, volume), and the latest-vs-window-ago deltas for the 7d and 30d windows. A subnet with no snapshots resolves to a schema-stable empty trajectory (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/trajectory.",
  },
  {
    field: "subnet_metagraph",
    route: "/api/v1/subnets/{netuid}/metagraph",
    returns: "JSON",
    description:
      "One subnet's live metagraph: every neuron with its uid, keys, stake, trust/consensus/incentive/dividends, emission, and axon, plus the subnet's aggregate counters. Set validator_permit to true to return only permit-holding validators. A subnet with no indexed neurons resolves to a schema-stable empty metagraph, never null. Opaque JSON passed through verbatim, matching the get_subnet_metagraph MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/metagraph.",
  },
  {
    field: "subnet_overview",
    route: "/api/v1/subnets/{netuid}/overview",
    returns: "JSON",
    description:
      "One subnet's composed overview card: the baked static subnet record overlaid with live probe-derived health, exactly as the REST route composes it. Null when no overview has been baked for that netuid (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_subnet MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/overview.",
  },
  {
    field: "subnet_profile",
    route: "/api/v1/subnets/{netuid}/profile",
    returns: "JSON",
    description:
      "One subnet's contributor-review profile: candidate surfaces, contract version, endpoints, and completeness/curation metadata. Null when no profile has been baked for that netuid (rather than a GraphQL error); a negative netuid is a BAD_USER_INPUT error. Opaque JSON passed through verbatim, matching the get_subnet_profile MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/profile.",
  },
  {
    field: "providers",
    route: null,
    returns: "ProviderList!",
    description:
      "Paginated provider/source registry -- filter by id/kind/authority, sort with sort/order, project with fields, and page with limit/cursor. An invalid filter/sort is a GraphQL error, not a silently substituted default. Cursor remains the pre-existing opaque string id-keyset (not REST's integer offset), and a cold/absent artifact still resolves to an empty list. Filter/sort reuse loadProvidersList (same logic as GET /api/v1/providers / list_providers).",
  },
  {
    field: "provider",
    route: null,
    returns: "Provider",
    description: "One provider with its subnets.",
  },
  {
    field: "adapter",
    route: "/api/v1/adapters/{slug}",
    returns: "Adapter",
    description:
      "One adapter-backed public metrics snapshot by slug (e.g. 'gittensor', 'allways', 'sn-64'): the captured adapter snapshot, extension metadata, and netuid linkage. An invalid slug is a BAD_USER_INPUT error; a missing slug resolves to null (schema-stable, never a GraphQL error). Mirrors GET /api/v1/adapters/{slug}.",
  },
  {
    field: "economics",
    route: "/api/v1/economics",
    returns: "EconomicsList!",
    description:
      "Paginated per-subnet economic + validator metrics with full REST filter parity: optionally scope to one subnet (netuid), filter by registration_allowed, search by name/slug (q), sort with sort/order, and page with limit/cursor. An invalid filter/sort is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/economics.",
  },
  {
    field: "surfaces",
    route: "/api/v1/surfaces",
    returns: "SurfaceList!",
    description:
      "Curated public interface surfaces with full REST filter parity: optionally scope to one subnet (netuid) and filter by kind/provider/id, sort with sort/order, and page with limit/cursor. An invalid filter/sort is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/surfaces.",
  },
  {
    field: "endpoints",
    route: "/api/v1/endpoints",
    returns: "EndpointList!",
    description:
      "Endpoint/resource registry with full REST filter parity: optionally scope to one subnet (netuid) and filter by kind/layer/provider/publication_state/status/pool_eligible, threshold with min_/max_latency_ms and min_/max_score, project with fields, sort with sort/order, and page with limit/cursor. An invalid filter/sort is a GraphQL error (matching endpoint_pools/rpc_pools/rpc_endpoints), not a silently substituted default. Mirrors GET /api/v1/endpoints.",
  },
  {
    field: "provider_endpoints",
    route: "/api/v1/providers/{slug}/endpoints",
    returns: "JSON",
    description:
      "One provider's endpoint rows with full REST filter parity: filter by netuid/kind/layer/publication_state/status/pool_eligible, latency and score ranges, sort + order, and page with limit/cursor. Composed live from the baked /metagraph/providers/{slug}/endpoints.json artifact. An unsupported filter/sort or an unknown provider is a GraphQL error (matching REST/MCP), not a silently substituted default. Opaque JSON passed through verbatim, matching the list_provider_endpoints MCP/REST shape. Mirrors GET /api/v1/providers/{slug}/endpoints.",
  },
  {
    field: "endpoint_pools",
    route: "/api/v1/endpoint-pools",
    returns: "EndpointPoolList!",
    description:
      "Generalized endpoint pool scores -- each pool's kind, eligible/total endpoint count, and probe-derived routing score. Filter by id/kind, threshold with min_/max_eligible_count and min_/max_endpoint_count, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/endpoint-pools.",
  },
  {
    field: "rpc_pools",
    route: "/api/v1/rpc/pools",
    returns: "PoolList!",
    description:
      "The load-balanced Bittensor RPC pool scores -- the RPC-specific predecessor of endpoint_pools (#6570): same pools[] row shape and filter/sort/page surface, with a live 15-minute cron eligibility overlay applied before filtering/sorting. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/rpc/pools.",
  },
  {
    field: "endpoint_incidents",
    route: "/api/v1/endpoint-incidents",
    returns: "IncidentList!",
    description:
      "Probe-derived endpoint incident feed -- active endpoint failures/degradations with severity, state, provider, and subnet. Filter by netuid/kind/provider/status/severity/state, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/endpoint-incidents.",
  },
  {
    field: "source_snapshots",
    route: "/api/v1/source-snapshots",
    returns: "SourceSnapshotList!",
    description:
      "Per-source input-hash ledger -- each registry data source's captured input hash and record count at ingest time, for detecting hash drift or seeing per-source contribution volume. Filter with q (keyword search across id/kind/path), sort with sort/order, and page with limit (1-100)/cursor. An invalid sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/source-snapshots.",
  },
  {
    field: "gaps",
    route: "/api/v1/gaps",
    returns: "GapsList!",
    description:
      "Registry-wide interface gap report -- every active subnet's missing/unsupported public interface facets, gap_count, coverage_level, and curation_level. Filter by netuid/coverage_level/curation_level, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Distinct from subnet_gaps(netuid) (one subnet's contributor enrichment queue). Mirrors GET /api/v1/gaps.",
  },
  {
    field: "evidence",
    route: "/api/v1/evidence",
    returns: "EvidenceList!",
    description:
      "Network-wide public evidence ledger -- the append-only provenance record behind registry surfaces. Search with q across subject/claim/source_url/support_summary, sort with sort/order, project with fields, and page with limit (1-100)/cursor. An invalid sort/limit/cursor is a GraphQL error, not a silently substituted default. Distinct from subnet_evidence(netuid) (one subnet's claims). Mirrors GET /api/v1/evidence.",
  },
  {
    field: "profiles",
    route: "/api/v1/profiles",
    returns: "ProfileList!",
    description:
      "Public-safe subnet profile index -- completeness scores, surface/interface counts, curation level, review state, and confidence for every registered subnet. Filter by netuid/subnet_type/curation_level/review_state/confidence/profile_level, search name/slug/project/team/categories with q, sort with sort/order, and page with limit (1-1000)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/profiles.",
  },
  {
    field: "review_adapter_candidates",
    route: "/api/v1/review/adapter-candidates",
    returns: "ReviewAdapterCandidateList!",
    description:
      "Subnets worth deeper adapter work -- recommended_adapter_kind, operational and candidate API kinds, priority_score, and reason_codes. Filter by netuid/curation_level/candidate_api_kinds/operational_kinds/recommended_adapter_kind/reason_codes, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/adapter-candidates.",
  },
  {
    field: "review_enrichment_evidence",
    route: "/api/v1/review/enrichment-evidence",
    returns: "ReviewEnrichmentEvidenceList!",
    description:
      "Detailed candidate evidence behind the enrichment queue -- evidence_action, lane, missing kinds, and priority_score per subnet. Filter by netuid/lane/evidence_action/direct_submission_kinds/missing_kinds, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-evidence.",
  },
  {
    field: "review_enrichment_queue",
    route: "/api/v1/review/enrichment-queue",
    returns: "ReviewEnrichmentQueueList!",
    description:
      "Prioritized all-subnet enrichment queue -- lane, priority_score, missing kinds, and recommended_action per subnet. Filter by netuid/lane/evidence_action/identity_level/curation_level/profile_level/direct_submission_kinds/missing_kinds/manual_review_required/reason_codes/review_state, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-queue.",
  },
  {
    field: "review_enrichment_targets",
    route: "/api/v1/review/enrichment-targets",
    returns: "ReviewEnrichmentTargetList!",
    description:
      "Contributor-facing enrichment targets -- target_type, target_action, lane, priority_score, and submission_route. Filter by netuid/target_type/target_action/kind/lane/evidence_action/identity_level/profile_level/submission_route/auto_review_candidate/manual_review_required/missing_kinds/reason_codes, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-targets.",
  },
  {
    field: "review_gaps",
    route: "/api/v1/review/gaps",
    returns: "ReviewGapPriorityList!",
    description:
      "Contributor-targeted review gap priorities -- priority_score, missing surface kinds, curation_level, and review_state. Distinct from the per-subnet subnet_gaps field and the global gaps ledger. Filter by netuid/curation_level/missing_kinds/review_state, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/gaps.",
  },
  {
    field: "review_profile_completeness",
    route: "/api/v1/review/profile-completeness",
    returns: "ReviewProfileCompletenessList!",
    description:
      "Contributor review queue of subnet profile-completeness gaps -- identity, native name, confidence, and promotion signals. Filter by netuid/profile_level/confidence/identity_level/identity_promotion_kinds/native_name_quality, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/profile-completeness.",
  },
  {
    field: "registry_summary",
    route: "/api/v1/registry/summary",
    returns: "JSON",
    description:
      "The registry-wide summary: overall subnet count, coverage/curation-level/profile-level counts, recent registry changes, and the most-complete top subnets. A fast orientation for the whole Bittensor application layer. Null when the summary has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the registry_summary MCP/REST shape. Mirrors GET /api/v1/registry/summary.",
  },
  {
    field: "schemas",
    route: "/api/v1/schemas",
    returns: "JSON",
    description:
      "The registry's captured API-schema index: which subnet surfaces publish a machine-readable OpenAPI/Swagger schema, each schema's hash, and its drift status (new/unchanged/changed). Null when the schema index has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the list_schemas MCP/REST shape. Mirrors GET /api/v1/schemas.",
  },
  {
    field: "source_health",
    route: "/api/v1/source-health",
    returns: "JSON",
    description:
      "The per-provider source-health rollup: for each provider/source, the candidate-surface count and its live/redirected/dead classification, endpoint and RPC-endpoint counts, verification-result count, and an overall status. Null when the rollup has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_source_health MCP/REST shape. Mirrors GET /api/v1/source-health.",
  },
  {
    field: "lineage",
    route: "/api/v1/lineage",
    returns: "JSON",
    description:
      "The maintainer-approved cross-network subnet lineage: which testnet subnets have graduated to mainnet (mainnet <-> testnet pairs with match evidence), plus any flagged broken links. Null when the lineage has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_lineage MCP/REST shape. Mirrors GET /api/v1/lineage.",
  },
  {
    field: "rpc_endpoints",
    route: "/api/v1/rpc/endpoints",
    returns: "JSON",
    description:
      "The full catalog of monitored Bittensor base-layer RPC endpoints and their status (each endpoint's URL, network, and probe-derived health/latency), with the same live 15-minute cron RPC-pool overlay REST and MCP apply before serving. Filter by kind/layer/netuid/pool_eligible/provider/publication_state/status, threshold with min_/max_latency_ms and min_/max_score, project with fields, sort with sort/order, and page with limit/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default; a cold/absent catalog is likewise a GraphQL error (matching endpoint_pools / rpc_pools). Opaque JSON passed through verbatim, matching the list_rpc_endpoints MCP/REST shape. Mirrors GET /api/v1/rpc/endpoints.",
  },
  {
    field: "changelog",
    route: "/api/v1/changelog",
    returns: "Changelog",
    description:
      "The latest generated registry changelog: artifact added/modified/removed rows, subnet added/removed/renamed events, and coverage deltas since the previous publish. Resolves to a GraphQL error (not null) when the changelog artifact has not been baked in this environment, matching the REST route's 404 and the get_changelog MCP tool. Mirrors GET /api/v1/changelog.",
  },
  {
    field: "contracts",
    route: "/api/v1/contracts",
    returns: "Contracts",
    description:
      "The registry's public artifact contract metadata: every baked artifact path, storage tier, schema reference, and consumer notes. Resolves to a GraphQL error (not null) when the contracts artifact has not been baked in this environment, matching the REST route's 404 and the get_contracts MCP tool. Mirrors GET /api/v1/contracts.",
  },
  {
    field: "build",
    route: "/api/v1/build",
    returns: "BuildSummary!",
    description:
      "The generated build summary: artifact inventory counts and sizes, subnet/provider/surface totals, coverage rollup, and publish metadata. Resolves to a GraphQL error (not null) when the build-summary artifact has not been baked in this environment, matching the REST route's 404 and the get_build MCP tool. Mirrors GET /api/v1/build.",
  },
  {
    field: "self_health",
    route: "/api/v1/self-health",
    returns: "SelfHealth!",
    description:
      "metagraphed's OWN uptime: the api/site/publish component views with their latest probe state and trailing-90-day daily uptime ratios, plus the rolled-up operational/degraded/outage verdict. Scoped strictly to our own surfaces -- never third-party subnet health (that is the health rollup). Resolves to a GraphQL error (not null) when the self-health artifact has not been baked in this environment, matching the REST route's 404 and the get_self_health MCP tool. Mirrors GET /api/v1/self-health.",
  },
  {
    field: "health_history",
    route: "/api/v1/health/history/{date}",
    returns: "HealthHistory!",
    description:
      "A compact daily operational health snapshot for one UTC date (YYYY-MM-DD): per-surface status/latency plus summary incident counts from the archived health/history tier. Filter by netuid/kind/provider/status/classification, sort with sort/order, and page with limit (1-1000)/cursor. An invalid date/filter/sort/limit/cursor or a missing snapshot is a GraphQL error, not a silently substituted default. Distinct from the live health rollup and health_trends. Mirrors GET /api/v1/health/history/{date}.",
  },
  {
    field: "health",
    route: null,
    returns: "GlobalHealth",
    description: "Global operational health rollup with per-subnet summaries.",
  },
  {
    field: "opportunity_boards",
    route: null,
    returns: "OpportunityBoards!",
    description:
      "Cross-subnet economic opportunity boards (where to register, what it costs, where the emission and validator headroom are).",
  },
  {
    field: "compare",
    route: "/api/v1/compare",
    returns: "Compare!",
    description:
      "Cross-subnet comparison: registry structure, live economics, and live health placed side by side for the requested netuids, in requested order. Mirrors GET /api/v1/compare.",
  },
  {
    field: "incidents",
    route: "/api/v1/incidents",
    returns: "GlobalIncidents!",
    description:
      "Global endpoint-incident ledger over a 7d/30d window; degrades to a schema-stable empty ledger (never a GraphQL error) on a cold/retired health tier. Mirrors GET /api/v1/incidents.",
  },
  {
    field: "global_incidents",
    route: "/api/v1/incidents",
    returns: "GlobalIncidents!",
    description:
      "The get_global_incidents-aligned name for the same global downtime-incident ledger (#7643): identical 7d/30d window validation, tier fallback, and cold-tier degradation as incidents — a thin alias so MCP tool names and GraphQL fields line up. Distinct from endpoint_incidents (the active endpoint failure/degradation feed, GET /api/v1/endpoint-incidents): this is the historical incident ledger. Returns the typed GlobalIncidents envelope rather than the issue's literal JSON suggestion, matching incidents. Mirrors GET /api/v1/incidents.",
  },
  {
    field: "extrinsics",
    route: "/api/v1/extrinsics",
    returns: "ExtrinsicList!",
    description:
      "Recent-extrinsic feed (newest first), optionally filtered. Optionally narrow by call_hash, block (exact height), block_start/block_end (inclusive height range), or from/to (observed_at epoch-ms range — String args because epoch-ms exceeds GraphQL Int's 32-bit range, matching account_history) — the same filters GET /api/v1/extrinsics and the list_extrinsics MCP tool accept. Mirrors GET /api/v1/extrinsics.",
  },
  {
    field: "chain_events",
    route: "/api/v1/chain-events",
    returns: "ChainEventsFeed!",
    description:
      "Paginated all-events feed (newest first) from the chain_events lakehouse table: each event's block, event index, pallet, method, decoded args, phase, and emitting extrinsic index. Filter by pallet/method/block/extrinsic; page with limit (1-200, default 50) and the opaque keyset cursor (or legacy before=block_number). An invalid filter combo is a GraphQL BAD_USER_INPUT error; a cold/unbound tier resolves to a schema-stable empty feed, never a GraphQL error. Reads the raw all-events tier -- distinct from account_events/subnet_events (the curated account-attributed streams, a different data source) and from Subscription.chainEvents (live WebSocket firehose). Pass network to read testnet's decoded history instead of mainnet's. Mirrors GET /api/v1/chain-events.",
  },
  {
    field: "chain_events_stats",
    route: "/api/v1/chain-events/stats",
    returns: "ChainEventsStats!",
    description:
      "Chain-activity aggregate over the most recent N blocks the decode lane has published (the blocks arg, 1-5000, default 1000, a stray large value silently capped) from the chain_events lakehouse table: the pallet.method event distribution, each with its count, busiest first. A non-positive/non-integer blocks is a GraphQL BAD_USER_INPUT error; a cold/unbound tier resolves to a schema-stable empty aggregate, never a GraphQL error. The aggregate sibling of chain_events (the raw feed). Pass network to aggregate testnet's decoded history instead of mainnet's. Mirrors GET /api/v1/chain-events/stats (and MCP get_chain_activity).",
  },
  {
    field: "extrinsic",
    route: "/api/v1/extrinsics/{ref}",
    returns: "ExtrinsicDetail",
    description:
      "One extrinsic by hash or composite block_number-extrinsic_index ref; extrinsic is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/extrinsics/{ref}.",
  },
  {
    field: "governance_config_changes",
    route: "/api/v1/governance/config-changes",
    returns: "ExtrinsicList!",
    description:
      "Subtensor's root-origin hyperparameter/network-config change feed (newest first) -- the extrinsics feed fixed to call_module=AdminUtils, so it takes no signer/call_module filter. Same ExtrinsicList shape as extrinsics. Mirrors GET /api/v1/governance/config-changes.",
  },
  {
    field: "blocks",
    route: "/api/v1/blocks",
    returns: "BlockList!",
    description:
      "Recent-block feed (newest first). Optionally filter by author (SS58), spec_version, block_start/block_end (inclusive block-height range), from/to (observed_at epoch-ms range — String args because epoch-ms exceeds GraphQL Int's 32-bit range, matching account_history), min_extrinsics, and min_events — the same filter set MCP list_blocks and GET /api/v1/blocks accept. Mirrors GET /api/v1/blocks.",
  },
  {
    field: "block",
    route: "/api/v1/blocks/{ref}",
    returns: "BlockDetail",
    description:
      "One block by numeric height or 0x block hash; block is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/{ref}.",
  },
  {
    field: "block_extrinsics",
    route: "/api/v1/blocks/{ref}/extrinsics",
    returns: "BlockExtrinsics!",
    description:
      "The extrinsics in one block by ref (numeric block_number or 0x hash), in natural read order (extrinsic_index ASC), paginated with limit (1-100, default 50)/offset. Returns block_number:null + extrinsics:[] for an unknown ref or cold store, never a GraphQL error. Mirrors GET /api/v1/blocks/{ref}/extrinsics.",
  },
  {
    field: "block_events",
    route: "/api/v1/blocks/{ref}/events",
    returns: "BlockEvents!",
    description:
      "The decoded, account-attributed chain events in one block by ref, in read order (event_index ASC), paginated with limit (1-1000, default 100)/offset. Returns block_number:null + events:[] for an unknown ref or cold store, never a GraphQL error. Mirrors GET /api/v1/blocks/{ref}/events.",
  },
  {
    field: "block_chain_events",
    route: "/api/v1/blocks/{block_number}/chain-events",
    returns: "BlockChainEvents!",
    description:
      "Every raw pallet.method event in one block from the Postgres all-events tier (ADR 0013), by numeric block_number, in read order. Distinct from block_events (the curated account-attributed D1 stream); requires the all-events data Worker, so it is a GraphQL error where that tier is unavailable (e.g. preview deploys). Mirrors GET /api/v1/blocks/{block_number}/chain-events.",
  },
  {
    field: "blocks_summary",
    route: "/api/v1/blocks/summary",
    returns: "BlocksSummary!",
    description:
      "Block-production summary over the recent-block window -- counts, inter-block timing, throughput, and author-concentration. Every aggregate is null (never a GraphQL error) when the retired-D1 store is cold. Mirrors GET /api/v1/blocks/summary.",
  },
  {
    field: "runtime",
    route: "/api/v1/runtime",
    returns: "RuntimeVersionHistory!",
    description:
      "Site-wide runtime spec-version transition timeline: the earliest known block at each distinct spec_version observed (ascending), the current spec_version, and where coverage starts. The empty shape (transition_count 0, current_spec_version null) is schema-stable, never a GraphQL error, when the store has no reading yet. Mirrors GET /api/v1/runtime.",
  },
  {
    field: "validators",
    route: "/api/v1/validators",
    returns: "ValidatorList!",
    description:
      "Network-wide validator/operator leaderboard, grouped by hotkey across every subnet it operates in. Paginate with limit/cursor like providers. Mirrors GET /api/v1/validators.",
  },
  {
    field: "validator",
    route: "/api/v1/validators/{hotkey}",
    returns: "Validator",
    description:
      "One validator's cross-subnet aggregate by hotkey; a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null. Mirrors GET /api/v1/validators/{hotkey}.",
  },
  {
    field: "validator_nominators",
    route: "/api/v1/validators/{hotkey}/nominators",
    returns: "NominatorList!",
    description:
      "One validator's nominator leaderboard over a 7d/30d/90d window (default 30d): every coldkey that staked to or unstaked from this hotkey in the window, with its staked/unstaked/net/gross TAO, event count, and last-activity time, ranked by sort (net_staked | gross_staked | last_activity, default net_staked), paginated with limit (1-2000, default 20)/offset. An unsupported window/sort or an out-of-range limit/offset is a GraphQL error, not a silently substituted default; a hotkey with no nominators resolves to a schema-stable empty list, never null and never a GraphQL error. Mirrors GET /api/v1/validators/{hotkey}/nominators.",
  },
  {
    field: "validator_history",
    route: "/api/v1/validators/{hotkey}/history",
    returns: "ValidatorHistory!",
    description:
      "One validator's cross-subnet staked-over-time history: one point per day (window: 7d/30d/90d/1y/all, default 30d), summed across every subnet it validates in, plus a rewards-per-1000-TAO rate. A hotkey with no matching neuron_daily rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/validators/{hotkey}/history.",
  },
  {
    field: "accounts",
    route: "/api/v1/accounts",
    returns: "AccountList!",
    description:
      "Site-wide accounts leaderboard -- every currently-registered hotkey, aggregated cross-subnet from the current neurons snapshot. Mirrors GET /api/v1/accounts.",
  },
  {
    field: "account",
    route: "/api/v1/accounts/{ss58}",
    returns: "AccountSummary",
    description:
      "One account's cross-subnet event-history summary by ss58 address; an address with no matching account_events rows resolves to a schema-stable zero summary, never null. Mirrors GET /api/v1/accounts/{ss58}.",
  },
  {
    field: "account_prometheus",
    route: "/api/v1/accounts/{ss58}/prometheus",
    returns: "AccountPrometheus!",
    description:
      "One account's Prometheus telemetry-serving footprint across subnets over a 7d/30d/90d window (default 30d) -- which subnets it announces a Prometheus endpoint on, how often, first/last announcement times, and an HHI concentration of where that activity is focused. An address with no matching announcements resolves to a schema-stable zeroed footprint, never null. Mirrors GET /api/v1/accounts/{ss58}/prometheus.",
  },
  {
    field: "account_registrations",
    route: "/api/v1/accounts/{ss58}/registrations",
    returns: "AccountRegistrations!",
    description:
      "One account's per-subnet registration footprint over a 7d/30d/90d window (default 30d): NeuronRegistered count and first/last timestamps per subnet, an HHI concentration of where its registration activity is focused, and the dominant subnet; an address with no registrations in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/registrations.",
  },
  {
    field: "account_deregistrations",
    route: "/api/v1/accounts/{ss58}/deregistrations",
    returns: "AccountDeregistrations!",
    description:
      "One account's per-subnet deregistration footprint over a 7d/30d/90d window (default 30d) -- the slots where this hotkey was the PREVIOUS holder, DERIVED from UID reuse (#9307): eviction count and first/last timestamps per subnet, an HHI concentration of where its deregistration activity is focused, and the dominant subnet. An address with no evictions resolves to a schema-stable zeroed card, never null; the 90d window is not precomputed, so it carries a degraded block instead of a confident zero. Mirrors GET /api/v1/accounts/{ss58}/deregistrations.",
  },
  {
    field: "account_stake_flow",
    route: "/api/v1/accounts/{ss58}/stake-flow",
    returns: "AccountStakeFlow!",
    description:
      "One account's StakeAdded/StakeRemoved flow per subnet over a 7d/30d/90d window (default 30d) -- net + gross flow, a direction label (accumulating/exiting/churning/idle), and an HHI concentration of where its flow is focused. direction narrows to inflow (in) or outflow (out) only; all (default) reports both sides. An address with no flow in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-flow.",
  },
  {
    field: "account_position_history",
    route: "/api/v1/accounts/{ss58}/subnets/{netuid}/history",
    returns: "AccountPositionHistory!",
    description:
      "One account's per-subnet position (uid/role/active plus stake/emission/rank/trust/incentive/dividends/yield) day-by-day over a 7d/30d/90d/1y/all window (default 30d), newest first, one point per neuron_daily snapshot. An account with no rows for the subnet in the window resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history.",
  },
  {
    field: "account_portfolio",
    route: "/api/v1/accounts/{ss58}/portfolio",
    returns: "AccountPortfolio!",
    description:
      "One wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a registered neuron, each position's economics (stake, emission, rank, trust, incentive, dividends, role) and emission/stake yield, plus wallet-level aggregates (totals, counts, overall return, stake concentration). Richer than account.registrations (registration footprint only). An address with no registered neurons resolves to a schema-stable empty card, never null. Mirrors GET /api/v1/accounts/{ss58}/portfolio.",
  },
  {
    field: "account_positions",
    route: "/api/v1/accounts/{ss58}/positions",
    returns: "AccountPositions!",
    description:
      "This account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from account_portfolio's hotkey-scoped view (a pure delegator shows near-zero there since its stake lives on someone ELSE's hotkey row). Root (netuid 0) stake is not covered -- root has no alpha pool, so an address that only holds root-delegated stake resolves to a schema-stable empty positions[], never null. Mirrors GET /api/v1/accounts/{ss58}/positions.",
  },
  {
    field: "account_subnets",
    route: "/api/v1/accounts/{ss58}/subnets",
    returns: "AccountSubnets!",
    description:
      "One account's live cross-subnet footprint: every subnet where the hotkey is currently registered as a neuron, each with its netuid, uid, stake, validator-permit and active flag, plus a subnet_count. The registration snapshot only (netuid/uid/stake/permit/active) -- account_portfolio is the richer economics view over the same neurons. An unregistered or never-seen address resolves to a schema-stable empty footprint (subnet_count 0, subnets []), never null. Mirrors GET /api/v1/accounts/{ss58}/subnets.",
  },
  {
    field: "account_serving",
    route: "/api/v1/accounts/{ss58}/serving",
    returns: "AccountServing!",
    description:
      "One account's per-subnet axon-serving footprint over a 7d/30d/90d window (default 30d): AxonServed announcement count and first/last timestamps per subnet, an HHI concentration of where its serving activity is focused, and the dominant subnet; an address with no announcements in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/serving.",
  },
  {
    field: "account_axon_removals",
    route: "/api/v1/accounts/{ss58}/axon-removals",
    returns: "AccountAxonRemovals!",
    description:
      "One account's per-subnet axon-removal footprint over a 7d/30d/90d window (default 30d): AxonInfoRemoved count and first/last timestamps per subnet, an HHI concentration of where its teardown activity is focused, and the dominant subnet; an address with no removals in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/axon-removals.",
  },
  {
    field: "account_stake_moves",
    route: "/api/v1/accounts/{ss58}/stake-moves",
    returns: "AccountStakeMoves!",
    description:
      "One account's per-subnet StakeMoved footprint over a 7d/30d/90d window (default 30d): movement count, first/last timestamps, and the alpha price (TAO) at its most recent move per subnet, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet; an address with no moves in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-moves.",
  },
  {
    field: "account_weight_setters",
    route: "/api/v1/accounts/{ss58}/weight-setters",
    returns: "AccountWeightSetters!",
    description:
      "One account's (validator hotkey's) WeightsSet weight-setting footprint per subnet over a 7d/30d window (default 7d): each subnet's weight-set count with the first/last WeightsSet timestamps, plus account totals, an HHI concentration of where its weight-setting activity is focused, and the dominant subnet. An address with no weight-sets in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/weight-setters.",
  },
  {
    field: "account_entities",
    route: "/api/v1/accounts/{ss58}/entities",
    returns: "AccountEntities!",
    description:
      "One coldkey's community-contributed entity labels (exchange/foundation/operator/other) plus every subnet-ownership tie it has via the chain_events SubnetOwnerChanged stream (either side of an automatic conviction-contest transfer). Only tracks automatic SubnetOwnerChanged transfers, not genesis ownership -- a coldkey that has held a subnet since registration and never lost it to a challenger will not appear in ownership_ties. An address with no labels or ties resolves to a schema-stable empty card, never null. Mirrors GET /api/v1/accounts/{ss58}/entities.",
  },
  {
    field: "account_identity",
    route: "/api/v1/accounts/{ss58}/identity",
    returns: "AccountIdentity!",
    description:
      "One account's on-chain identity (its latest set_identity values, sanitized at serve time). has_identity is false with every field null for an account that never set one -- the common case, so this is a schema-stable card, never null and never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/identity.",
  },
  {
    field: "account_identity_history",
    route: "/api/v1/accounts/{ss58}/identity-history",
    returns: "AccountIdentityHistory!",
    description:
      "One account's on-chain identity change history, newest first -- an append-only diff-tracking timeline (name/url/github/image/discord/description/additional plus a stable hash per entry). Page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no identity-history rows resolves to a schema-stable empty timeline, never null. Mirrors GET /api/v1/accounts/{ss58}/identity-history.",
  },
  {
    field: "account_counterparties",
    route: "/api/v1/accounts/{ss58}/counterparties",
    returns: "AccountCounterparties!",
    description:
      "Rank who one account transacts native TAO with, by total transfer volume, from the Balances.Transfer feed: per counterparty the sent/received/net TAO, transfer count, and last block, plus scan totals. Pass counterparty=<ss58> (must differ from ss58) to drill into a single relationship instead -- its fund-flow totals plus direction-aware transfer evidence under relationship, newest first. limit caps the ranked list (default 20) or the relationship's transfer evidence (default 50); 1-100. An address with no transfers resolves to a schema-stable zero card, never null. Mirrors GET /api/v1/accounts/{ss58}/counterparties.",
  },
  {
    field: "account_transfers",
    route: "/api/v1/accounts/{ss58}/transfers",
    returns: "AccountTransfers!",
    description:
      "One account's native-TAO transfer feed from the Balances.Transfer event stream, newest first -- each event's block/index, from/to, amount_tao, a direction relative to the queried address (sent = it paid, received = it was paid), and observed_at. direction narrows to sent | received only (default both); block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no transfers resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/transfers.",
  },
  {
    field: "account_extrinsics",
    route: "/api/v1/accounts/{ss58}/extrinsics",
    returns: "AccountExtrinsics!",
    description:
      "One account's signed-extrinsic feed, newest first -- the extrinsics whose signer is this address (matched by signer only, not the hotkey/coldkey union account_events uses), each carrying its block/index, hash, call_module/call_function, decoded call_args, success flag, fee and tip. block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). extrinsic_count is the page count, not a grand total. An address that signed nothing resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/extrinsics.",
  },
  {
    field: "account_events",
    route: "/api/v1/accounts/{ss58}/events",
    returns: "AccountEvents!",
    description:
      "One account's first-party chain-event feed, newest first -- every event where this address is the hotkey OR coldkey (the union account_extrinsics does not use), each carrying its block/event index, event_kind, hotkey/coldkey, netuid/uid, amount_tao/alpha_amount, extrinsic_index and observed_at. kind filters to one event kind (e.g. StakeAdded, NeuronRegistered, AxonServed, WeightsSet); netuid scopes to one subnet; block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). event_count is the page count, not a grand total. An address with no matching events resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/events.",
  },
  {
    field: "account_history",
    route: "/api/v1/accounts/{ss58}/history",
    returns: "AccountHistory!",
    description:
      "One account's durable per-day activity series from the hotkey-keyed account_events_daily rollup, newest day first -- each day's netuid, event_count, event_kinds, and first/last block. netuid filters to one subnet; from/to are YYYY-MM-DD bounds; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). day_count is the page count, not a grand total. Note: the rollup is hotkey-attributed only -- a coldkey-only address returns zero days even when account_events shows activity. An address with no matching days resolves to a schema-stable empty series, never null. Mirrors GET /api/v1/accounts/{ss58}/history.",
  },
  {
    field: "economics_trends",
    route: "/api/v1/economics/trends",
    returns: "EconomicsTrends!",
    description:
      "Network-wide economics time series, aggregated per UTC day across all subnets; day_count is 0 and days is empty on a cold rollup, never null. Mirrors GET /api/v1/economics/trends.",
  },
  {
    field: "emission_pipeline",
    route: "/api/v1/chain/emission-pipeline",
    returns: "EmissionPipeline!",
    description:
      "The v440 emission pipeline decomposed per subnet at the block the economics capture was pinned to: each subnet's stage-1 price share, its MinerBurned-reweighted and Hill-gated shares, its final share of block emission, and the split of its TAO intake between pool injection (tao_in_emission) and chain buys (excess_tao). netuid narrows the per-subnet rows only -- aggregate and verification stay network-wide, since a one-subnet slice of a network identity cannot be verified. ALWAYS read verification.verified: false means the four identities did not hold on these exact rows and the response is not defensible. field_sources labels every field measured or reconstructed. A capture with no chain_state is an EMISSION_PIPELINE_UNAVAILABLE error, never a partial body. Mirrors GET /api/v1/chain/emission-pipeline.",
  },
  {
    field: "registry_leaderboards",
    route: "/api/v1/registry/leaderboards",
    returns: "RegistryLeaderboards!",
    description:
      "Registry leaderboards: the operational boards (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable) and the economic-opportunity boards (open-slots, cheapest-registration, highest-emission, validator-headroom, biggest-alpha-gain-1d, biggest-alpha-gain-7d), composed live from the registry profiles projection plus D1 health/rpc/growth/reliability rows and the economics tier. Pass board to return just that board (default: every board); limit caps each board's entries (default 20, max 100). An unknown board is a BAD_USER_INPUT error, matching REST's invalid_query 400. Mirrors GET /api/v1/registry/leaderboards.",
  },
  {
    field: "subnet_movers",
    route: "/api/v1/subnets/movers",
    returns: "SubnetMovers!",
    description:
      "Cross-subnet momentum leaderboard: every subnet ranked by its stake/emission/validator change between a window's start and end snapshots; movers is empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/subnets/movers.",
  },
  {
    field: "chain_turnover",
    route: "/api/v1/chain/turnover",
    returns: "ChainTurnover!",
    description:
      "Network-wide validator-set churn across all subnets over a 7d/30d/90d window (default 30d): every subnet ranked by gross validator churn (entered + exited) between the window's start and end snapshots, each with its retention and 0-100 stability score, plus a network rollup and the network-wide stability spread. neuron_daily-derived; comparable is false and the leaderboard empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/chain/turnover.",
  },
  {
    field: "chain_identity_history",
    route: "/api/v1/chain/identity-history",
    returns: "ChainIdentityHistory!",
    description:
      "Network-wide identity-change feed: the most-recent SubnetIdentitiesV3 changes across every subnet (each entry carries its netuid), newest first, capped by limit; a cold/absent store resolves to a schema-stable empty feed (count 0), never null. Mirrors GET /api/v1/chain/identity-history.",
  },
  {
    field: "chain_weights",
    route: "/api/v1/chain/weights",
    returns: "ChainWeights!",
    description:
      "Network-wide validator weight-setting activity leaderboard over a 7d/30d window (default 7d): subnets ranked by WeightsSet events with each's distinct-setter count and sets-per-setter update intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. Mirrors GET /api/v1/chain/weights.",
  },
  {
    field: "chain_serving",
    route: "/api/v1/chain/serving",
    returns: "ChainServing!",
    description:
      "Network-wide axon-serving announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonServed announcements with each's distinct-server count and announcements-per-server re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide counterpart of subnet_serving. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/serving.",
  },
  {
    field: "chain_calls",
    route: "/api/v1/chain/calls",
    returns: "ChainCalls!",
    description:
      "Extrinsic call-mix breakdown over a 7d/30d window (default 7d): the extrinsic count and share per call_module, or per call_module+call_function when group_by is module_function (default module), optionally scoped to a single call_module, ranked by count (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty breakdown, never a GraphQL error. Mirrors GET /api/v1/chain/calls.",
  },
  {
    field: "chain_prometheus",
    route: "/api/v1/chain/prometheus",
    returns: "ChainPrometheus!",
    description:
      "Network-wide Prometheus telemetry-endpoint announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by PrometheusServed announcements with each's distinct-exporter count and announcements-per-exporter re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The telemetry-endpoint companion to chain_serving's axon endpoints -- which subnets run observability infrastructure. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/prometheus.",
  },
  {
    field: "chain_deregistrations",
    route: "/api/v1/chain/deregistrations",
    returns: "ChainDeregistrations!",
    description:
      "Network-wide neuron-deregistration leaderboard over a 7d/30d window (default 7d): subnets ranked by deregistration events with each's distinct-hotkey count and deregistrations-per-hotkey churn intensity, plus a network rollup and the per-subnet intensity spread, DERIVED from UID reuse in the NeuronRegistered stream by a scheduled projection -- NeuronDeregistered has never been emitted by the runtime (#9307). The network-wide, exit-side counterpart of subnet_deregistrations -- where neurons are being pushed out. limit caps the leaderboard (default 20, max 100). A window nothing derived carries a degraded block rather than a confident zero. Mirrors GET /api/v1/chain/deregistrations.",
  },
  {
    field: "chain_registrations",
    route: "/api/v1/chain/registrations",
    returns: "ChainRegistrations!",
    description:
      "Network-wide neuron-registration leaderboard over a 7d/30d window (default 7d): subnets ranked by NeuronRegistered events with each's distinct-hotkey count and registrations-per-registrant re-registration intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide, entry-side counterpart of subnet_registrations -- where neurons are joining. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/registrations.",
  },
  {
    field: "chain_fees",
    route: "/api/v1/chain/fees",
    returns: "ChainFees!",
    description:
      "Per-UTC-day network fee/tip series over a 7d/30d window (default 7d): each day's extrinsic count and total/avg/median fee + tip in TAO, plus the top fee-paying signers (limit default 25, max 100), optionally scoped to a single call_module. Computed live from the extrinsics tier; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/fees.",
  },
  {
    field: "chain_activity",
    route: "/api/v1/chain/activity",
    returns: "ChainActivity!",
    description:
      "Per-UTC-day network activity series over a 7d/30d window (default 7d): each UTC day's block count, extrinsic count (with its successful-extrinsic count and success rate), on-chain event count, and distinct signer count, newest day first. Computed live from the extrinsics/blocks tiers; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/activity.",
  },
  {
    field: "chain_axon_removals",
    route: "/api/v1/chain/axon-removals",
    returns: "ChainAxonRemovals!",
    description:
      "Network-wide axon-removal (teardown) leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonInfoRemoved events with each's distinct-remover count and removals-per-remover teardown intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The teardown counterpart of chain_serving's announcements -- where neurons are tearing endpoints down. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/axon-removals.",
  },
  {
    field: "chain_weight_setters",
    route: "/api/v1/chain/weights/setters",
    returns: "ChainWeightSetters!",
    description:
      "Network-wide weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators driving consensus network-wide, each with its total WeightsSet count, share of the network total, and first/last set times, ranked by activity. The setter-level drill-in behind chain_weights. Mirrors GET /api/v1/chain/weights/setters.",
  },
  {
    field: "chain_signers",
    route: "/api/v1/chain/signers",
    returns: "ChainSigners!",
    description:
      "Most-active signer leaderboard over a 7d/30d window (default 7d): the accounts submitting the most extrinsics, each with its extrinsic count, total fees and tips paid in TAO, and last-seen block. Rank by tx_count (default) or total_fee_tao, optionally scoped to a single call_module pallet (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty leaderboard, never a GraphQL error. Mirrors GET /api/v1/chain/signers.",
  },
  {
    field: "health_trends",
    route: "/api/v1/health/trends",
    returns: "HealthTrends!",
    description:
      "Compact all-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history (probed every ~15 minutes); a cold store still returns both windows, schema-stable and zeroed, never a GraphQL error. Mirrors GET /api/v1/health/trends.",
  },
  {
    field: "rpc_usage",
    route: "/api/v1/rpc/usage",
    returns: "RpcUsage!",
    description:
      "RPC reverse-proxy usage analytics over a 7d/30d window (default 7d): total request volume, error + failover rates, cache-hit rate, latency p50/p95/avg, the per-endpoint and per-network request distribution, and bounded time buckets (1h for 7d, 6h for 30d). Counts are summed across two disjoint stores -- Workers Analytics Engine for live traffic, the R2 lakehouse for history -- and coverage reports the span each contributed plus any gap between them. p50/p95 are measured only over the Analytics Engine span (coverage.latency_percentiles) and are null where nothing measured them; the lakehouse has no percentile function. A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/rpc/usage.",
  },
  {
    field: "chain_performance",
    route: "/api/v1/chain/performance",
    returns: "ChainPerformance!",
    description:
      "Network-wide reward-distribution & score-spread card across every subnet's neurons: incentive/dividends concentration (who actually captures rewards network-wide) plus the trust/consensus/validator_trust score spread. Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet_performance. Mirrors GET /api/v1/chain/performance.",
  },
  {
    field: "chain_yield",
    route: "/api/v1/chain/yield",
    returns: "ChainYield!",
    description:
      "Network-wide emission-yield (return rate) aggregated across every subnet's neurons -- the aggregate network return, the same split by validator vs miner role, and the distribution of the per-neuron return rate. Every aggregate is null (never a GraphQL error) on a cold store. Mirrors GET /api/v1/chain/yield.",
  },
  {
    field: "chain_concentration",
    route: "/api/v1/chain/concentration",
    returns: "ChainConcentration!",
    description:
      "Network-wide stake & emission decentralization across every subnet's neurons at once: the raw stake/emission distribution, the same two lenses collapsed per controlling entity (an operator running hotkeys in ten subnets counts once, not ten times), and the permitted-validator stake distribution -- each as gini/HHI/Nakamoto/top-share/entropy. uids_per_entity is the network consolidation signal (1.0 = every UID a distinct owner). Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet concentration. Mirrors GET /api/v1/chain/concentration.",
  },
  {
    field: "chain_alpha_volume",
    route: "/api/v1/chain/alpha-volume",
    returns: "ChainAlphaVolume!",
    description:
      "Network-wide rolling 24h buy/sell alpha-volume leaderboard: every subnet with StakeAdded (buy) or StakeRemoved (sell) volume in the last 24h ranked by total_volume_tao, each carrying its full buy/sell/total volume + sentiment scorecard (vol_mcap_ratio always null here -- no per-subnet market-cap input at the network level), plus a network rollup with its own net/gross sentiment reading and the per-subnet total-volume spread, summed live from the account_events stream. Fixed 24h window (no window arg); limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/alpha-volume.",
  },
  {
    field: "chain_idle_stake",
    route: "/api/v1/chain/idle-stake",
    returns: "ChainIdleStake!",
    description:
      "Network-wide idle-stake rollup: every subnet's stake delegated to a currently-zero-dividends hotkey, ranked by idle_stake_alpha, plus the network total. Current snapshot only (no window/params). A cold store yields a schema-stable empty ranking, never a GraphQL error. Mirrors GET /api/v1/chain/idle-stake.",
  },
  {
    field: "chain_stake_flow",
    route: "/api/v1/chain/stake-flow",
    returns: "ChainStakeFlow!",
    description:
      "Network-wide cross-subnet capital-flow leaderboard over a 7d/30d window (default 7d): subnets ranked by net StakeAdded minus StakeRemoved TAO with staked/unstaked/gross totals and an inflow/outflow/balanced direction label, plus a network rollup and the per-subnet net-flow spread, summed live from the account_events stream. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-flow.",
  },
  {
    field: "chain_stake_moves",
    route: "/api/v1/chain/stake-moves",
    returns: "ChainStakeMoves!",
    description:
      "Network-wide stake-movement (re-delegation) leaderboard over a 7d/30d window (default 7d): subnets ranked by StakeMoved events with each's distinct-mover count and movements-per-mover intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. StakeMoved relocates stake between hotkeys/subnets without unstaking -- re-delegation churn, not net capital flow. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-moves.",
  },
  {
    field: "chain_stake_transfers",
    route: "/api/v1/chain/stake-transfers",
    returns: "ChainStakeTransfers!",
    description:
      "Network-wide stake-transfer (between-coldkeys) leaderboard over a 7d/30d window (default 7d): subnets ranked by StakeTransferred events with each's distinct-sender count and transfers-per-sender intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. StakeTransferred relocates ownership on the same hotkey -- not net capital or re-delegation churn. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-transfers.",
  },
  {
    field: "chain_transfer_pairs",
    route: "/api/v1/chain/transfer-pairs",
    returns: "ChainTransferPairs!",
    description:
      "Network-wide directed native-TAO transfer-corridor leaderboard over a 7d/30d window (default 7d): top sender->receiver pairs ranked by volume (default) or transfer count, each with volume, count, and last block/time, plus a network rollup (total volume, transfer count, unique corridors, top-corridor share). Self-transfers and malformed rows are excluded. limit caps the corridors (default 25, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/transfer-pairs.",
  },
  {
    field: "chain_transfers",
    route: "/api/v1/chain/transfers",
    returns: "ChainTransfers!",
    description:
      "Network-wide native-TAO transfer analytics over a 7d/30d window (default 7d): total Balances.Transfer volume and count, distinct senders/receivers, top senders and receivers ranked by volume, and the top senders' share of total volume. limit caps each leaderboard (default 25, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/transfers.",
  },
  {
    field: "subnet_recycled",
    route: "/api/v1/subnets/{netuid}/recycled",
    returns: "SubnetRecycled",
    description:
      "Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC (not the Postgres tier). recycled_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/recycled.",
  },
  {
    field: "subnet_burn",
    route: "/api/v1/subnets/{netuid}/burn",
    returns: "SubnetBurn",
    description:
      "Live current registration/burn cost for one subnet -- the dynamic price between the static min_burn_tao/max_burn_tao bounds, read directly from chain via RPC (not the Postgres tier). burn_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/burn.",
  },
  {
    field: "chain_burn",
    route: "/api/v1/chain/burn",
    returns: "ChainBurn",
    description:
      "Every subnet's live registration/burn cost in one response, ranked cheapest-first -- the cross-subnet companion to subnet_burn, which answers the same question one subnet at a time. Served from a single chain read, so an RPC failure resolves the card with nulls rather than a GraphQL error. Mirrors GET /api/v1/chain/burn.",
  },
  {
    field: "subnet_burn_history",
    route: "/api/v1/subnets/{netuid}/burn/history",
    returns: "SubnetBurnHistory!",
    description:
      "One subnet's registration-cost series: how the burn has moved, captured every 15 minutes. The live cards answer what it costs; this answers whether it is getting more expensive. window is 24h|7d|30d|90d. A subnet with no captured points resolves to an empty series, never null. Mirrors GET /api/v1/subnets/{netuid}/burn/history.",
  },
  {
    field: "subnet_turnover",
    route: "/api/v1/subnets/{netuid}/turnover",
    returns: "SubnetTurnover!",
    description:
      "One subnet's validator/neuron-set turnover (entered/exited/retention/0-100 stability) between the boundary snapshots of a 7d/30d/90d/1y/all window (default 30d), from neuron_daily. comparable is false and the churn metrics zeroed on a single-snapshot or cold store, never null. Mirrors GET /api/v1/subnets/{netuid}/turnover.",
  },
  {
    field: "subnet_ownership_history",
    route: "/api/v1/subnets/{netuid}/ownership-history",
    returns: "SubnetOwnershipHistory!",
    description:
      "Every automatic ownership transfer one subnet has undergone (#6637, part of the conviction/ownership-contest tracker epic #4302), decoded from the chain_events SubnetOwnerChanged stream -- Bittensor subnet ownership is a permissionless, conviction-weighted contest that transfers automatically once a challenger's conviction overtakes the incumbent owner's, no vote required. A subnet that has never changed hands returns an empty list. Reaches the all-events tier directly (no D1 predecessor) and falls to the R2 lakehouse reader when that tier cannot answer, the same two tiers REST and MCP use; an out-of-range netuid is a GraphQL error, and so is a tier failure the lakehouse cannot cover either -- never a silent empty list. Mirrors GET /api/v1/subnets/{netuid}/ownership-history.",
  },
  {
    field: "subnet_conviction",
    route: "/api/v1/subnets/{netuid}/conviction",
    returns: "SubnetConviction!",
    description:
      "Live per-subnet conviction leaderboard (#6638, part of the conviction/ownership-contest tracker epic #4302) -- who currently holds the most rolled conviction, i.e. how close the subnet is to an automatic ownership flip. Companion to subnet_ownership_history (that's the event log of past flips; this is the current standings). A subnet with no active challengers/owner lock returns an empty leaderboard. Reaches the Postgres-only all-events tier directly; an out-of-range netuid or an unavailable tier is a GraphQL error, never a silent empty leaderboard. Mirrors GET /api/v1/subnets/{netuid}/conviction.",
  },
  {
    field: "subnet_lease",
    route: "/api/v1/subnets/{netuid}/lease",
    returns: "SubnetLease",
    description:
      "Live subnet-lease state (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717) -- whether a subnet is currently under a lease (a crowdfunded, time-boxed primary market for new subnets) and, if so, its terms and accumulated-but-undistributed alpha dividends, read directly from chain via RPC (not the Postgres tier). leased is null (not false) on RPC failure, distinct from a confirmed no-lease (leased:false); schema-stable, never a GraphQL error except for an out-of-range netuid. Mirrors GET /api/v1/subnets/{netuid}/lease.",
  },
  {
    field: "subnet_lease_history",
    route: "/api/v1/subnets/{netuid}/lease/history",
    returns: "SubnetLeaseHistory!",
    description:
      "Every SubnetLeaseCreated/SubnetLeaseTerminated event one subnet has had (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717), decoded from the account_events stream. Companion to subnet_lease (that's the current state; this is the event log). A subnet that has never been leased returns an empty list. Reaches the Postgres-only all-events tier directly; an out-of-range netuid or an unavailable tier is a GraphQL error, never a silent empty list. Mirrors GET /api/v1/subnets/{netuid}/lease/history.",
  },
  {
    field: "account_balance",
    route: "/api/v1/accounts/{ss58}/balance",
    returns: "AccountBalance",
    description:
      "Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached, not the Postgres tier). balance_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/balance.",
  },
  {
    field: "account_root_claim",
    route: "/api/v1/accounts/{ss58}/root-claim",
    returns: "AccountRootClaim",
    description:
      "Live root-claim current state for one Finney ss58 account (#7229) — claim type, per-hotkey claimable rates, cumulative claimed watermarks, and per-netuid thresholds — read directly from chain via RPC (KV-cached, not the Postgres tier). claim_type/hotkeys are null on RPC failure, schema-stable, never a GraphQL error. Read-only; never submits claim_root. Mirrors GET /api/v1/accounts/{ss58}/root-claim.",
  },
  {
    field: "account_children",
    route: "/api/v1/accounts/{ss58}/children",
    returns: "AccountChildren",
    description:
      "Live child-hotkey delegation graph (#6723) for one Finney ss58 account -- every child hotkey it currently delegates stake-weight to, per subnet, with the proportion charged -- read directly from chain via RPC (KV-cached, not the Postgres tier). subnets is null on RPC failure, distinct from a confirmed-empty [] (the account genuinely has no children on any subnet). Companion to account_parents. Mirrors GET /api/v1/accounts/{ss58}/children.",
  },
  {
    field: "account_parents",
    route: "/api/v1/accounts/{ss58}/parents",
    returns: "AccountParents",
    description:
      "Live parent-hotkey delegation graph (#6723) for one Finney ss58 account -- every hotkey currently delegating stake-weight to it, per subnet -- read directly from chain via RPC (KV-cached, not the Postgres tier). subnets is null on RPC failure, distinct from a confirmed-empty [] (the account genuinely has no parents on any subnet). Companion to account_children. Mirrors GET /api/v1/accounts/{ss58}/parents.",
  },
  {
    field: "sudo_key",
    route: "/api/v1/sudo/key",
    returns: "SudoKey",
    description:
      "The network's on-chain sudo (superuser) key hotkey, read live from chain via RPC (not the Postgres tier). hotkey is null on RPC failure or a renounced sudo, schema-stable, never a GraphQL error. Mirrors GET /api/v1/sudo/key.",
  },
  {
    field: "network_parameters",
    route: "/api/v1/network/parameters",
    returns: "NetworkParameters",
    description:
      "Live global Subtensor protocol/governance parameters (TaoWeight, StakeThreshold, PendingChildKeyCooldown), read directly from chain via RPC (not the Postgres tier). Each field is independently null on its own RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/network/parameters.",
  },
  {
    field: "network_randomness",
    route: "/api/v1/network/randomness",
    returns: "NetworkRandomness",
    description:
      "Live drand randomness-beacon status read directly from chain via RPC (not the Postgres tier): the newest and oldest stored beacon rounds and the span between them. Each field is independently null on its own RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/network/randomness.",
  },
  {
    field: "randomness_status",
    route: "/api/v1/network/randomness",
    returns: "NetworkRandomness",
    description:
      "The get_randomness_status-aligned name for the same live drand beacon snapshot (#7649): identical loader, KV cache, and independently-null RPC-failure behavior as network_randomness — a thin alias so MCP tool names and GraphQL fields line up. Returns the typed NetworkRandomness envelope rather than the issue's literal JSON suggestion, matching network_randomness. Mirrors GET /api/v1/network/randomness.",
  },
  {
    field: "evm_address",
    route: "/api/v1/evm/address/{h160}",
    returns: "EvmAddressMapping",
    description:
      "Live EVM (H160) -> Substrate (SS58) account-address mapping for a 20-byte 0x-prefixed hex address, resolved directly from chain via RPC (not the Postgres tier). ss58 is null when the address has no association or the RPC lookup fails, schema-stable, never a GraphQL error. Mirrors GET /api/v1/evm/address/{h160}.",
  },
  {
    field: "evm_address_mapping",
    route: "/api/v1/evm/address/{h160}",
    returns: "EvmAddressMapping",
    description:
      "The get_evm_address_mapping-aligned name for evm_address, so the MCP tool name and this Query field line up. Structurally identical to evm_address -- same live RPC read, same validation, same schema-stable null on an unresolved mapping -- not a second lookup. Mirrors GET /api/v1/evm/address/{h160}.",
  },
  {
    field: "sudo",
    route: "/api/v1/sudo",
    returns: "ExtrinsicList!",
    description:
      "Recent Sudo-pallet extrinsic feed (newest first): the chain's superuser governance calls, the same shape as the extrinsics feed with call_module fixed to Sudo (so no signer/call_module args). Optionally narrow by block (exact height), block_start/block_end (inclusive height range), or from/to (observed_at epoch-ms range — String args because epoch-ms exceeds GraphQL Int's 32-bit range, matching account_history) — the same block/time filters GET /api/v1/sudo and the get_sudo MCP tool accept. Mirrors GET /api/v1/sudo.",
  },
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
