// Ground-truth validation for schemas-src/ (types-epic A, #7859): each pilot
// route's Zod response schema must parse the REAL handler output, not just
// typecheck against a hand-written fixture. Drives the real dispatcher
// (handleRequest, workers/api.ts) with the same createLocalArtifactEnv()
// fixture-env pattern tests/subnet-stake-quote-api.test.ts and friends
// already use, so a schema drifting from the actual contract fails loudly
// here rather than only in production. Also asserts the converse per the
// issue's non-vacuous requirement: an empty object must fail every schema.
import assert from "node:assert/strict";
import { describe, test, vi, afterEach } from "vitest";
import { summarizeEvent } from "@jsonbored/chain-summaries";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { SubnetsResponseSchema } from "../schemas-src/routes/subnets.ts";
import { SubnetDetailResponseSchema } from "../schemas-src/routes/subnet-detail.ts";
import { HealthResponseSchema } from "../schemas-src/routes/health.ts";
import { SelfHealthResponseSchema } from "../schemas-src/routes/self-health.ts";
import { EconomicsResponseSchema } from "../schemas-src/routes/economics.ts";
import { StakeQuoteResponseSchema } from "../schemas-src/routes/stake-quote.ts";
import { SubnetAlphaVolumeResponseSchema } from "../schemas-src/routes/subnet-alpha-volume.ts";
import {
  SubnetAxonRemovalsResponseSchema,
  SubnetDeregistrationsResponseSchema,
  SubnetRegistrationsResponseSchema,
  SubnetServingResponseSchema,
} from "../schemas-src/routes/subnet-activity.ts";
import {
  SubnetBurnResponseSchema,
  SubnetRecycledResponseSchema,
} from "../schemas-src/routes/subnet-registration-cost.ts";
import { SubnetEventsResponseSchema } from "../schemas-src/routes/subnet-events.ts";
import { SubnetEventSummaryResponseSchema } from "../schemas-src/routes/subnet-event-summary.ts";
import { SubnetHistoryResponseSchema } from "../schemas-src/routes/subnet-history.ts";
import { SubnetIdentityHistoryResponseSchema } from "../schemas-src/routes/subnet-identity-history.ts";
import { SubnetIdleStakeResponseSchema } from "../schemas-src/routes/subnet-idle-stake.ts";
import { SubnetOverviewResponseSchema } from "../schemas-src/routes/subnet-overview.ts";
import {
  DomainSummaryResponseSchema,
  DomainsResponseSchema,
} from "../schemas-src/routes/domains.ts";
import { EconomicsTrendsResponseSchema } from "../schemas-src/routes/economics-trends.ts";
import {
  SubnetConcentrationResponseSchema,
  SubnetConcentrationHistoryResponseSchema,
} from "../schemas-src/routes/subnet-concentration.ts";
import { SubnetTurnoverResponseSchema } from "../schemas-src/routes/subnet-turnover.ts";
import { SubnetStakeFlowResponseSchema } from "../schemas-src/routes/subnet-stake-flow.ts";
import { SubnetStakeMovesResponseSchema } from "../schemas-src/routes/subnet-stake-moves.ts";
import { SubnetStakeTransfersResponseSchema } from "../schemas-src/routes/subnet-stake-transfers.ts";
import { SubnetOhlcResponseSchema } from "../schemas-src/routes/subnet-ohlc.ts";
import {
  SubnetYieldResponseSchema,
  SubnetYieldHistoryResponseSchema,
} from "../schemas-src/routes/subnet-yield.ts";
import { SubnetMoversResponseSchema } from "../schemas-src/routes/subnet-movers.ts";
import { SubnetTrajectoryResponseSchema } from "../schemas-src/routes/subnet-trajectory.ts";
import {
  SubnetLeaseResponseSchema,
  SubnetLeaseHistoryArtifactSchema,
} from "../schemas-src/routes/subnet-lease.ts";
import {
  CrowdloansResponseSchema,
  CrowdloanDetailResponseSchema,
} from "../schemas-src/routes/crowdloans.ts";
import { SubnetOwnershipHistoryArtifactSchema } from "../schemas-src/routes/subnet-ownership-history.ts";
import { SubnetConvictionArtifactSchema } from "../schemas-src/routes/subnet-conviction.ts";
import { buildSubnetLeaseHistory } from "../src/subnet-lease-history.ts";
import { buildSubnetOwnershipHistory } from "../src/subnet-ownership-history.ts";
import { buildSubnetConviction } from "../src/subnet-conviction.ts";
import {
  SubnetMetagraphArtifactSchema,
  NeuronDetailArtifactSchema,
  SubnetValidatorsArtifactSchema,
  NeuronHistoryArtifactSchema,
} from "../schemas-src/routes/subnet-metagraph.ts";
import {
  SubnetHyperparametersArtifactSchema,
  SubnetHyperparamsHistoryArtifactSchema,
} from "../schemas-src/routes/subnet-hyperparameters.ts";
import {
  SubnetPerformanceArtifactSchema,
  SubnetPerformanceHistoryArtifactSchema,
} from "../schemas-src/routes/subnet-performance.ts";
import { SubnetPrometheusArtifactSchema } from "../schemas-src/routes/subnet-prometheus.ts";
import {
  SubnetWeightsArtifactSchema,
  SubnetWeightSettersArtifactSchema,
} from "../schemas-src/routes/subnet-weights.ts";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildNeuronDetail,
} from "../src/metagraph-neurons.ts";
import { buildNeuronHistory } from "../src/neuron-history.ts";
import { buildSubnetHyperparams } from "../src/subnet-hyperparams.ts";
import { buildSubnetHyperparamsHistory } from "../src/subnet-hyperparams-history.ts";
import {
  buildSubnetPerformance,
  buildSubnetPerformanceHistory,
} from "../src/subnet-performance.ts";
import { buildSubnetPrometheus } from "../src/subnet-prometheus.ts";
import { buildSubnetWeights } from "../src/subnet-weights.ts";
import { buildSubnetWeightSetters } from "../src/subnet-weight-setters.ts";
import {
  AccountSummaryArtifactSchema,
  AccountSubnetsArtifactSchema,
} from "../schemas-src/routes/account-summary.ts";
import { AccountsListArtifactSchema } from "../schemas-src/routes/accounts-list.ts";
import { TopHoldersArtifactSchema } from "../schemas-src/routes/top-holders.ts";
import { AccountBalanceArtifactSchema } from "../schemas-src/routes/account-balance.ts";
import { AccountPortfolioArtifactSchema } from "../schemas-src/routes/account-portfolio.ts";
import {
  AccountIdentityArtifactSchema,
  AccountIdentityHistoryArtifactSchema,
} from "../schemas-src/routes/account-identity.ts";
import {
  AccountPositionsArtifactSchema,
  AccountPositionHistoryArtifactSchema,
} from "../schemas-src/routes/account-positions.ts";
import { AccountRootClaimArtifactSchema } from "../schemas-src/routes/account-root-claim.ts";
import {
  AccountServingArtifactSchema,
  AccountPrometheusArtifactSchema,
  AccountStakeMovesArtifactSchema,
  AccountStakeFlowArtifactSchema,
} from "../schemas-src/routes/account-activity.ts";
import {
  AccountAxonRemovalsArtifactSchema,
  AccountDeregistrationsArtifactSchema,
  AccountRegistrationsArtifactSchema,
  AccountWeightSettersArtifactSchema,
} from "../schemas-src/routes/account-activity-registrations.ts";
import {
  AccountEventsArtifactSchema,
  AccountHistoryArtifactSchema,
  AccountTransfersArtifactSchema,
} from "../schemas-src/routes/account-events-feed.ts";
import { AccountExtrinsicsArtifactSchema } from "../schemas-src/routes/account-extrinsics.ts";
import { AccountCounterpartiesArtifactSchema } from "../schemas-src/routes/account-counterparties.ts";
import { AccountEntitiesArtifactSchema } from "../schemas-src/routes/account-entities.ts";
import {
  AccountChildrenArtifactSchema,
  AccountParentsArtifactSchema,
} from "../schemas-src/routes/account-child-delegation.ts";
import {
  EvmAddressMappingArtifactSchema,
  NetworkParametersArtifactSchema,
  RandomnessArtifactSchema,
  SudoKeyArtifactSchema,
} from "../schemas-src/routes/network-singletons.ts";
import {
  buildAccountSummary,
  buildAccountSubnets,
} from "../src/account-events.ts";
import { buildAccountsList } from "../src/accounts-list.ts";
import { buildTopHoldersList } from "../src/top-holders.ts";
import { loadAccountBalance } from "../src/account-balance.ts";
import { buildAccountPortfolio } from "../src/account-portfolio.ts";
import { buildAccountIdentity } from "../src/account-identity.ts";
import { buildAccountIdentityHistory } from "../src/account-identity-history.ts";
import { buildAccountPositions } from "../src/account-nominator-positions.ts";
import { buildAccountPositionHistory } from "../src/account-position-history.ts";
import { loadAccountRootClaim } from "../src/account-root-claim.ts";
import { buildAccountServing } from "../src/account-serving.ts";
import { buildAccountPrometheus } from "../src/account-prometheus.ts";
import { buildAccountStakeMoves } from "../src/account-stake-moves.ts";
import { buildAccountStakeFlow } from "../src/account-stake-flow.ts";
import { buildAccountAxonRemovals } from "../src/account-axon-removals.ts";
import { buildAccountDeregistrations } from "../src/account-deregistrations.ts";
import { buildAccountRegistrations } from "../src/account-registrations.ts";
import { buildAccountWeightSetters } from "../src/account-weight-setters.ts";
import {
  buildAccountEvents,
  buildAccountHistory,
  buildAccountTransfers,
} from "../src/account-events.ts";
import { buildAccountExtrinsics } from "../src/extrinsics.ts";
import { buildCounterparties } from "../src/counterparties.ts";
import { buildAccountEntities } from "../src/entity-labels.ts";
import {
  loadAccountChildren,
  loadAccountParents,
} from "../src/child-hotkey-delegation.ts";
import { loadAddressMapping } from "../src/address-mapping.ts";
import { loadNetworkParameters } from "../src/network-parameters.ts";
import { loadRandomnessStatus } from "../src/randomness.ts";
import { loadSudoKey } from "../src/sudo-key.ts";
import { mockEnv } from "./row-type.ts";
import type { z } from "zod";
import {
  ChainActivityArtifactSchema,
  ChainCallsArtifactSchema,
  ChainSignersArtifactSchema,
  ChainFeesArtifactSchema,
} from "../schemas-src/routes/chain-analytics.ts";
import {
  ChainAxonRemovalsArtifactSchema,
  ChainDeregistrationsArtifactSchema,
  ChainPrometheusArtifactSchema,
  ChainRegistrationsArtifactSchema,
  ChainServingArtifactSchema,
  ChainStakeMovesArtifactSchema,
  ChainStakeTransfersArtifactSchema,
  ChainWeightsArtifactSchema,
} from "../schemas-src/routes/chain-network-rollups.ts";
import { ChainAlphaVolumeArtifactSchema } from "../schemas-src/routes/chain-alpha-volume.ts";
import { ChainConcentrationArtifactSchema } from "../schemas-src/routes/chain-concentration.ts";
import {
  ChainEventsFeedArtifactSchema,
  ChainEventsStatsArtifactSchema,
} from "../schemas-src/routes/chain-events.ts";
import { ChainIdentityHistoryArtifactSchema } from "../schemas-src/routes/chain-identity-history.ts";
import { ChainIdleStakeArtifactSchema } from "../schemas-src/routes/chain-idle-stake.ts";
import { ChainPerformanceArtifactSchema } from "../schemas-src/routes/chain-performance.ts";
import { ChainStakeFlowArtifactSchema } from "../schemas-src/routes/chain-stake-flow.ts";
import {
  ChainTransferPairsArtifactSchema,
  ChainTransfersArtifactSchema,
} from "../schemas-src/routes/chain-transfers.ts";
import { ChainTurnoverArtifactSchema } from "../schemas-src/routes/chain-turnover.ts";
import { ChainWeightSettersArtifactSchema } from "../schemas-src/routes/chain-weight-setters.ts";
import { ChainYieldArtifactSchema } from "../schemas-src/routes/chain-yield.ts";
import {
  buildChainActivity,
  buildChainCalls,
  buildChainSigners,
  buildChainFees,
} from "../src/chain-analytics.ts";
import { buildChainAxonRemovals } from "../src/chain-axon-removals.ts";
import { buildChainDeregistrations } from "../src/chain-deregistrations.ts";
import { buildChainPrometheus } from "../src/chain-prometheus.ts";
import { buildChainRegistrations } from "../src/chain-registrations.ts";
import { buildChainServing } from "../src/chain-serving.ts";
import { buildChainStakeMoves } from "../src/chain-stake-moves.ts";
import { buildChainStakeTransfers } from "../src/chain-stake-transfers.ts";
import { buildChainWeights } from "../src/chain-weights.ts";
import { buildChainAlphaVolume } from "../src/chain-alpha-volume.ts";
import { buildChainConcentration } from "../src/concentration.ts";
import { buildChainIdentityHistory } from "../src/chain-identity-history.ts";
import { buildChainIdleStake } from "../src/subnet-idle-stake.ts";
import { buildChainPerformance } from "../src/chain-performance.ts";
import { buildChainStakeFlow } from "../src/chain-stake-flow.ts";
import { buildChainTransferPairs } from "../src/chain-transfer-pairs.ts";
import { buildChainTransfers } from "../src/chain-transfers.ts";
import { buildChainTurnover } from "../src/chain-turnover.ts";
import { buildChainWeightSetters } from "../src/chain-weight-setters.ts";
import { buildChainYield } from "../src/chain-yield.ts";
import {
  BlocksFeedArtifactSchema,
  BlockDetailArtifactSchema,
} from "../schemas-src/routes/blocks.ts";
import { BlocksSummaryArtifactSchema } from "../schemas-src/routes/blocks-summary.ts";
import { RuntimeVersionsArtifactSchema } from "../schemas-src/routes/runtime-versions.ts";
import {
  ExtrinsicsFeedArtifactSchema,
  ExtrinsicDetailArtifactSchema,
} from "../schemas-src/routes/extrinsics.ts";
import { BlockExtrinsicsArtifactSchema } from "../schemas-src/routes/block-extrinsics.ts";
import { BlockEventsArtifactSchema } from "../schemas-src/routes/block-events.ts";
import { BlockChainEventsArtifactSchema } from "../schemas-src/routes/block-chain-events.ts";
import { GlobalValidatorsArtifactSchema } from "../schemas-src/routes/global-validators.ts";
import { ValidatorDetailArtifactSchema } from "../schemas-src/routes/validator-detail.ts";
import { CompareValidatorsArtifactSchema } from "../schemas-src/routes/compare-validators.ts";
import { ValidatorHistoryArtifactSchema } from "../schemas-src/routes/validator-history.ts";
import { ValidatorNominatorsArtifactSchema } from "../schemas-src/routes/validator-nominators.ts";
import { buildBlock, buildBlockFeed } from "../src/blocks.ts";
import { buildBlocksSummary } from "../src/blocks-summary.ts";
import { buildRuntimeVersionHistory } from "../src/runtime-versions.ts";
import {
  buildExtrinsic,
  buildExtrinsicFeed,
  buildBlockExtrinsics,
} from "../src/extrinsics.ts";
import { buildBlockEvents, formatAccountEvent } from "../src/account-events.ts";
import {
  buildGlobalValidators,
  buildValidatorDetail,
  composeValidatorComparison,
} from "../src/metagraph-neurons.ts";
import { buildValidatorHistory } from "../src/validator-history.ts";
import { buildValidatorNominators } from "../src/validator-nominators.ts";
// Batch 10 (#8064) additions.
import {
  ApiIndexArtifactSchema,
  ContractsArtifactSchema,
  OpenApiArtifactSchema,
  BuildSummaryArtifactSchema,
  ChangelogArtifactSchema,
} from "../schemas-src/routes/meta-contracts.ts";
import {
  FreshnessArtifactSchema,
  SourceHealthArtifactSchema,
  SourceSnapshotsArtifactSchema,
  SearchArtifactSchema,
  SearchIndexArtifactSchema,
} from "../schemas-src/routes/evidence-search.ts";
import {
  ProviderArtifactSchema,
  ProvidersArtifactSchema,
  ProviderEndpointsArtifactSchema,
  RpcEndpointsArtifactSchema,
  RpcPoolsArtifactSchema,
  RpcUsageArtifactSchema,
} from "../schemas-src/routes/providers-rpc.ts";
import {
  SubnetProfilesArtifactSchema,
  SubnetProfileArtifactSchema,
  SchemaIndexArtifactSchema,
} from "../schemas-src/routes/subnet-profiles.ts";
import {
  AgentCatalogArtifactSchema,
  AgentCatalogSubnetArtifactSchema,
  AgentResourcesArtifactSchema,
  AgentReadinessStatusSchema,
} from "../schemas-src/routes/agent-catalog.ts";
import { generateOpenApiZodComponents } from "../scripts/generate-openapi-zod-components.ts";
import {
  buildContractsArtifact,
  buildApiIndexArtifact,
} from "../src/contracts.ts";
import { buildCanonicalOpenApiArtifact } from "../scripts/openapi-components.ts";
import { buildChangelog } from "../scripts/changelog.ts";
import {
  evaluateArtifactBudgets,
  summarizeArtifactBudgets,
} from "../scripts/artifact-budgets.ts";
import { publishedAt } from "../scripts/lib.ts";
import {
  mergeFreshness,
  formatRpcUsage,
  overlaySubnetHealth,
  formatBulkTrends,
  formatGlobalIncidents,
  formatIncidents,
  formatPercentiles,
  formatTrends,
  formatUptime,
} from "../src/health-serving.ts";
import {
  buildEndpointResourceArtifact,
  buildRpcEndpointArtifact,
  buildEndpointPoolArtifact,
  buildEndpointIncidentArtifact,
} from "../scripts/lib/endpoint-artifacts.ts";
import {
  subnetIntegrationReadiness,
  buildAgentReadiness,
} from "../scripts/lib/build-readiness.ts";
import { listToolDefinitions } from "../src/mcp-server.ts";

// #9051: the cross-subnet builders REQUIRE a price map (no default), so these
// schema-shape checks pass an explicit one rather than relying on an implicit
// 1:1 that production can no longer do either.
const SCHEMA_PRICES: Map<number, number | null> = new Map(
  Array.from({ length: 300 }, (_, netuid) => [netuid, 1]),
);

import {
  HealthHistoryArtifactSchema,
  BulkHealthTrendsArtifactSchema,
  GlobalIncidentsArtifactSchema,
  HealthSubnetArtifactSchema,
  HealthIncidentsArtifactSchema,
  HealthPercentilesArtifactSchema,
  HealthTrendsArtifactSchema,
  UptimeArtifactSchema,
} from "../schemas-src/routes/health-surfaces.ts";
import {
  SurfacesArtifactSchema,
  SubnetSurfacesArtifactSchema,
  EndpointsArtifactSchema,
  SubnetEndpointsArtifactSchema,
  EndpointIncidentsArtifactSchema,
  EndpointPoolsArtifactSchema,
} from "../schemas-src/routes/endpoints-pools.ts";
import {
  CandidatesArtifactSchema,
  SubnetCandidatesArtifactSchema,
  EvidenceLedgerArtifactSchema,
  SubnetEvidenceArtifactSchema,
} from "../schemas-src/routes/candidates-evidence.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function realBody(path: string) {
  const env = createLocalArtifactEnv();
  const res = await handleRequest(req(path), env as unknown as Env, {});
  assert.equal(
    res.status,
    200,
    `${path} must return 200 to validate the success schema`,
  );
  return res.json();
}

const cases: [string, string, z.ZodType][] = [
  ["subnets", "/api/v1/subnets", SubnetsResponseSchema],
  ["subnet-detail", "/api/v1/subnets/64", SubnetDetailResponseSchema],
  ["health", "/api/v1/health", HealthResponseSchema],
  // #8318: our OWN uptime, distinct from the third-party rollup above. Parses
  // the cold-store shape here (three components, verdict "degraded"), which is
  // exactly what the route serves before the poller has written anything.
  ["self-health", "/api/v1/self-health", SelfHealthResponseSchema],
  ["economics", "/api/v1/economics", EconomicsResponseSchema],
  [
    "stake-quote",
    "/api/v1/subnets/64/stake-quote?amount=1000&direction=stake",
    StakeQuoteResponseSchema,
  ],
];

// Batch 1 (#8055) -- same ground-truth pattern, 15 more routes.
const batch1Cases: [string, string, z.ZodType][] = [
  [
    "subnet-volume",
    "/api/v1/subnets/64/volume",
    SubnetAlphaVolumeResponseSchema,
  ],
  [
    "subnet-axon-removals",
    "/api/v1/subnets/64/axon-removals",
    SubnetAxonRemovalsResponseSchema,
  ],
  ["subnet-burn", "/api/v1/subnets/64/burn", SubnetBurnResponseSchema],
  [
    "subnet-deregistrations",
    "/api/v1/subnets/64/deregistrations",
    SubnetDeregistrationsResponseSchema,
  ],
  [
    "subnet-event-summary",
    "/api/v1/subnets/64/event-summary",
    SubnetEventSummaryResponseSchema,
  ],
  ["subnet-events", "/api/v1/subnets/64/events", SubnetEventsResponseSchema],
  ["subnet-history", "/api/v1/subnets/64/history", SubnetHistoryResponseSchema],
  [
    "subnet-identity-history",
    "/api/v1/subnets/64/identity-history",
    SubnetIdentityHistoryResponseSchema,
  ],
  [
    "subnet-recycled",
    "/api/v1/subnets/64/recycled",
    SubnetRecycledResponseSchema,
  ],
  [
    "subnet-registrations",
    "/api/v1/subnets/64/registrations",
    SubnetRegistrationsResponseSchema,
  ],
  ["subnet-serving", "/api/v1/subnets/64/serving", SubnetServingResponseSchema],
  [
    "subnet-idle-stake",
    "/api/v1/subnets/64/idle-stake",
    SubnetIdleStakeResponseSchema,
  ],
  [
    "subnet-overview",
    "/api/v1/subnets/64/overview",
    SubnetOverviewResponseSchema,
  ],
  [
    "domain-summary",
    "/api/v1/domains/agents/summary",
    DomainSummaryResponseSchema,
  ],
  ["domains", "/api/v1/domains", DomainsResponseSchema],
];

// Batch 2 (#8056) -- same ground-truth pattern, 16 more routes.
const batch2Cases: [string, string, z.ZodType][] = [
  [
    "economics-trends",
    "/api/v1/economics/trends",
    EconomicsTrendsResponseSchema,
  ],
  [
    "subnet-concentration",
    "/api/v1/subnets/64/concentration",
    SubnetConcentrationResponseSchema,
  ],
  [
    "subnet-concentration-history",
    "/api/v1/subnets/64/concentration/history",
    SubnetConcentrationHistoryResponseSchema,
  ],
  [
    "subnet-turnover",
    "/api/v1/subnets/64/turnover?changes=true",
    SubnetTurnoverResponseSchema,
  ],
  [
    "subnet-stake-flow",
    "/api/v1/subnets/64/stake-flow",
    SubnetStakeFlowResponseSchema,
  ],
  [
    "subnet-stake-moves",
    "/api/v1/subnets/64/stake-moves",
    SubnetStakeMovesResponseSchema,
  ],
  [
    "subnet-stake-transfers",
    "/api/v1/subnets/64/stake-transfers",
    SubnetStakeTransfersResponseSchema,
  ],
  ["subnet-ohlc", "/api/v1/subnets/64/ohlc", SubnetOhlcResponseSchema],
  ["subnet-yield", "/api/v1/subnets/64/yield", SubnetYieldResponseSchema],
  [
    "subnet-yield-history",
    "/api/v1/subnets/64/yield/history",
    SubnetYieldHistoryResponseSchema,
  ],
  ["subnet-movers", "/api/v1/subnets/movers", SubnetMoversResponseSchema],
  [
    "subnet-trajectory",
    "/api/v1/subnets/64/trajectory",
    SubnetTrajectoryResponseSchema,
  ],
  ["subnet-lease", "/api/v1/subnets/64/lease", SubnetLeaseResponseSchema],
  ["crowdloans", "/api/v1/crowdloans", CrowdloansResponseSchema],
  ["crowdloan-detail", "/api/v1/crowdloans/0", CrowdloanDetailResponseSchema],
];

describe("pilot route response schemas parse real handler output", () => {
  for (const [name, path, schema] of cases) {
    test(`${name}: Schema.parse(realHandlerBody) succeeds`, async () => {
      const body = await realBody(path);
      // Throws with a readable field-path diff on any mismatch — a schema
      // that merely typechecks but doesn't match reality must fail here.
      const parsed = schema.parse(body);
      assert.ok(parsed);
    });

    test(`${name}: Schema.parse({}) fails (not a vacuous passthrough)`, () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });
  }
});

describe("batch 1 (#8055) route response schemas parse real handler output", () => {
  for (const [name, path, schema] of batch1Cases) {
    test(`${name}: Schema.parse(realHandlerBody) succeeds`, async () => {
      const body = await realBody(path);
      const parsed = schema.parse(body);
      assert.ok(parsed);
    });

    test(`${name}: Schema.parse({}) fails (not a vacuous passthrough)`, () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });
  }
});

describe("batch 2 (#8056) route response schemas parse real handler output", () => {
  for (const [name, path, schema] of batch2Cases) {
    test(`${name}: Schema.parse(realHandlerBody) succeeds`, async () => {
      const body = await realBody(path);
      const parsed = schema.parse(body);
      assert.ok(parsed);
    });

    test(`${name}: Schema.parse({}) fails (not a vacuous passthrough)`, () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });
  }
});

// subnet-lease/history, subnet-ownership-history, and subnet-conviction are
// proxied to the DATA_API service Worker (handleChainEventsProxy) rather
// than handled directly -- createLocalArtifactEnv() has no DATA_API binding,
// so handleRequest() 503s for these three instead of exercising the real
// builder. Drive the pure builder functions directly instead (same real
// fixture-row shapes tests/subnet-lease-history.test.ts, tests/
// subnet-ownership-history.test.ts, and tests/subnet-conviction.test.ts
// already use), asserting the Zod artifact schema against their actual
// non-empty output -- still real handler-shape evidence, just entered one
// layer below the HTTP dispatcher these three routes never locally reach.
describe("batch 2 (#8056) DATA_API-proxied route artifact schemas parse real builder output", () => {
  test("subnet-lease-history: ArtifactSchema.parse(buildSubnetLeaseHistory(...)) succeeds", () => {
    const rows = [
      {
        event_kind: "SubnetLeaseCreated",
        coldkey: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
        block_number: "8587754",
        observed_at: "1783600000000",
      },
    ];
    const data = buildSubnetLeaseHistory(rows, 7);
    const parsed = SubnetLeaseHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });

  test("subnet-lease-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetLeaseHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-ownership-history: ArtifactSchema.parse(buildSubnetOwnershipHistory(...)) succeeds", () => {
    const rows = [
      {
        pallet: "SubtensorModule",
        method: "SubnetOwnerChanged",
        block_number: "8587754",
        observed_at: "1783600000000",
        args: {
          netuid: 7,
          old_coldkey: [
            [
              230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17,
              117, 251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2,
              183, 175, 143, 88,
            ],
          ],
          new_coldkey: [
            [
              109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          ],
        },
      },
    ];
    const data = buildSubnetOwnershipHistory(rows, 7);
    const parsed = SubnetOwnershipHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });

  test("subnet-ownership-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetOwnershipHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-conviction: ArtifactSchema.parse(buildSubnetConviction(...)) succeeds", () => {
    const rows = [
      {
        netuid: 1,
        hotkey: "5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp",
        is_owner: false,
        is_perpetual: true,
        locked_mass: 12801009134,
        conviction_bits: "103052736623230389324344213370",
        last_update: 8639094,
        captured_at: 1784360818505,
      },
    ];
    const data = buildSubnetConviction(rows, 1, {
      now: 8647076,
      unlockRate: 934866,
      maturityRate: 311622,
    });
    const parsed = SubnetConvictionArtifactSchema.parse(data);
    assert.ok(parsed);
  });

  test("subnet-conviction: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetConvictionArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 3 (#8057) -- neurons/neuron_daily/subnet_hyperparams(_history)-tier and
// live account_events-stream routes. None of these are servable through
// createLocalArtifactEnv() (no static fixture backs a D1/live-query route),
// so — same as the batch 2 DATA_API-proxied block above — each case drives
// the real pure builder function directly against a real D1/event-row shape
// (reused from that builder's own tests/*.test.ts fixtures) and asserts the
// Zod artifact schema against its actual non-empty output.
describe("batch 3 (#8057) route artifact schemas parse real builder output", () => {
  // A D1 `neurons` row (booleans as 0/1 INTEGER, stake/emission already TAO
  // floats) -- same shape tests/metagraph-neurons.test.ts's ROW/MINER use.
  const NEURON_ROW = {
    uid: 0,
    hotkey: "5Hk1",
    coldkey: "5Co1",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0.5,
    validator_trust: 0.99,
    consensus: 0.4,
    incentive: 0.1,
    dividends: 0.2,
    emission_tao: 22.1,
    stake_tao: 1000.5,
    registered_at_block: 6702485,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8454388,
    captured_at: 1750000000000,
  };
  const MINER_ROW = {
    ...NEURON_ROW,
    uid: 5,
    validator_permit: 0,
    hotkey: "5Hk5",
  };

  test("subnet-metagraph: ArtifactSchema.parse(buildSubnetMetagraph(...)) succeeds", () => {
    const data = buildSubnetMetagraph([NEURON_ROW, MINER_ROW], 7);
    const parsed = SubnetMetagraphArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-metagraph: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetMetagraphArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("neuron-detail: ArtifactSchema.parse(buildNeuronDetail(...)) succeeds", () => {
    const data = buildNeuronDetail(NEURON_ROW, 7);
    const parsed = NeuronDetailArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("neuron-detail: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = NeuronDetailArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-validators: ArtifactSchema.parse(buildSubnetValidators(...)) succeeds", () => {
    const data = buildSubnetValidators([NEURON_ROW], 7, {
      featuredHotkeys: new Set(["5Hk1"]),
    });
    const parsed = SubnetValidatorsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-validators: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetValidatorsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("neuron-history: ArtifactSchema.parse(buildNeuronHistory(...)) succeeds", () => {
    const dailyRow = {
      snapshot_date: "2026-06-20",
      uid: 3,
      hotkey: "5Hot",
      coldkey: "5Cold",
      active: 1,
      validator_permit: 1,
      rank: 0.5,
      trust: 0.9,
      validator_trust: 0.8,
      consensus: 0.7,
      incentive: 0.6,
      dividends: 0.4,
      emission_tao: 1.23,
      stake_tao: 456.7,
      registered_at_block: 100,
      is_immunity_period: 0,
      axon: "1.2.3.4:9000",
      block_number: 5_000_000,
      captured_at: 1_780_000_000_000,
    };
    const data = buildNeuronHistory([dailyRow], 7, 3, { window: "30d" });
    const parsed = NeuronHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("neuron-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = NeuronHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // Same 33-field shape tests/subnet-hyperparams.test.ts's rawRow() uses.
  const HYPERPARAMS_ROW = {
    kappa_ratio: 0.5,
    immunity_period: 4096,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 0,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 2,
    min_burn_tao: 0.000001,
    max_burn_tao: 100,
    burn_half_life: 43200,
    burn_increase_mult: 1.5,
    bonds_moving_avg_raw: 900000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.7,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 2,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 0,
    min_childkey_take_ratio: 0,
    block_number: 5_000_000,
    captured_at: 1_750_000_000_000,
  };

  test("subnet-hyperparameters: ArtifactSchema.parse(buildSubnetHyperparams(...)) succeeds", () => {
    const data = buildSubnetHyperparams(HYPERPARAMS_ROW, 7);
    const parsed = SubnetHyperparametersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-hyperparameters: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetHyperparametersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-hyperparameters-history: ArtifactSchema.parse(buildSubnetHyperparamsHistory(...)) succeeds", () => {
    const historyRow = {
      ...HYPERPARAMS_ROW,
      observed_at: HYPERPARAMS_ROW.captured_at,
      hyperparams_hash: "abc",
    };
    const data = buildSubnetHyperparamsHistory([historyRow], 86, {
      limit: 100,
      offset: 0,
      nextCursor: "2.1",
    });
    const parsed = SubnetHyperparamsHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-hyperparameters-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetHyperparamsHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // Same shape tests/subnet-performance.test.ts's ROWS uses.
  const PERFORMANCE_ROWS = [
    {
      incentive: 0.6,
      dividends: 0.5,
      trust: 0.9,
      consensus: 0.8,
      validator_trust: 0.95,
      active: 1,
      validator_permit: 1,
      captured_at: 1_750_000_000_000,
    },
    {
      incentive: 0.3,
      dividends: 0.1,
      trust: 0.7,
      consensus: 0.6,
      validator_trust: 0.5,
      active: 1,
      validator_permit: 0,
      captured_at: 1_750_000_000_000,
    },
  ];

  test("subnet-performance: ArtifactSchema.parse(buildSubnetPerformance(...)) succeeds", () => {
    const data = buildSubnetPerformance(PERFORMANCE_ROWS, 7);
    const parsed = SubnetPerformanceArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-performance: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetPerformanceArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-performance-history: ArtifactSchema.parse(buildSubnetPerformanceHistory(...)) succeeds", () => {
    const historyRows = [
      {
        snapshot_date: "2026-06-27",
        incentive: 0.9,
        dividends: 0.9,
        trust: 0.8,
        consensus: 0.7,
        validator_trust: 0.85,
        validator_permit: 1,
        active: 1,
      },
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ];
    const data = buildSubnetPerformanceHistory(historyRows, 7, {
      window: "30d",
    });
    const parsed = SubnetPerformanceHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-performance-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetPerformanceHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-prometheus: ArtifactSchema.parse(buildSubnetPrometheus(...)) succeeds", () => {
    const data = buildSubnetPrometheus(
      {
        distinct_exporters: 4,
        announcements: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    const parsed = SubnetPrometheusArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-prometheus: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetPrometheusArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-weights: ArtifactSchema.parse(buildSubnetWeights(...)) succeeds", () => {
    const data = buildSubnetWeights(
      { distinct_setters: 4, weight_sets: 40, newest_observed: 1750000000000 },
      7,
      { window: "30d" },
    );
    const parsed = SubnetWeightsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-weights: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetWeightsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-weight-setters: ArtifactSchema.parse(buildSubnetWeightSetters(...)) succeeds", () => {
    // Two per-setter leaderboard rows + subnet-wide totals, as the two D1
    // reads return them -- same shape tests/subnet-weight-setters.test.ts's
    // LEADER_ROWS/TOTALS use.
    const leaderRows = [
      {
        hotkey: "5Grw...alice",
        uid: 3,
        weight_sets: 30,
        first_set: 1_750_000_000_000,
        last_set: 1_750_600_000_000,
      },
      {
        hotkey: null,
        uid: 8,
        weight_sets: 10,
        first_set: 1_750_100_000_000,
        last_set: 1_750_200_000_000,
      },
    ];
    const totals = {
      weight_sets: 40,
      distinct_setters: 2,
      newest_observed: 1_750_600_000_000,
    };
    const data = buildSubnetWeightSetters(leaderRows, totals, 7, {
      window: "7d",
    });
    const parsed = SubnetWeightSettersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-weight-setters: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetWeightSettersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 4 (#8058) -- account_events/neurons/account_identity(_history)/
// nominator_positions/account_position_daily D1-tier and live finney-RPC
// routes. None of these are servable through createLocalArtifactEnv()
// either (same situation batch 3 hit), so each case drives the real pure
// builder function directly against a real D1/event-row shape (reused from
// that builder's own tests/*.test.ts fixtures). The two live-RPC routes
// (balance, root-claim) mock global fetch with the same SCALE-encoded
// response shape their own loader tests use.
describe("batch 4 (#8058) route artifact schemas parse real builder output", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("account-summary: ArtifactSchema.parse(buildAccountSummary(...)) succeeds", () => {
    const data = buildAccountSummary("5Hk", {
      agg: { c: 5, sc: 2, fb: 1, lb: 9, fo: 1750000000000, lo: 1750009000000 },
      kinds: [{ kind: "StakeAdded", count: 5 }],
      registrations: [
        { netuid: 7, uid: 1, stake_tao: 10, validator_permit: 1, active: 1 },
      ],
      recent: [
        {
          block_number: 9,
          event_kind: "StakeAdded",
          observed_at: 1750009000000,
        },
      ],
      activity: {
        tx_count: 4,
        last_tx_block: 200,
        last_tx_at: 1750009000000,
        total_fee_tao: 0.02,
      },
      modules: [{ call_module: "SubtensorModule", count: 3 }],
    });
    const withLabels = { ...data, labels: [] };
    const parsed = AccountSummaryArtifactSchema.parse(withLabels);
    assert.ok(parsed);
  });
  test("account-summary: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountSummaryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-subnets: ArtifactSchema.parse(buildAccountSubnets(...)) succeeds", () => {
    const data = buildAccountSubnets(
      [
        {
          netuid: 14,
          uid: 2,
          stake_tao: 12.25,
          validator_permit: 1,
          active: 1,
        },
      ],
      "5Hk",
    );
    const parsed = AccountSubnetsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-subnets: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountSubnetsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("accounts-list: ArtifactSchema.parse(buildAccountsList(...)) succeeds", () => {
    const row = {
      netuid: 1,
      uid: 0,
      hotkey: "5Hk1",
      coldkey: "5Co1",
      validator_permit: 1,
      emission_tao: 22.1,
      stake_tao: 1000.5,
      block_number: 8454388,
      captured_at: 1750000000000,
    };
    const data = buildAccountsList([row], { priceByNetuid: SCHEMA_PRICES });
    const parsed = AccountsListArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("accounts-list: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountsListArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("top-holders: ArtifactSchema.parse(buildTopHoldersList(...)) succeeds", () => {
    const row = {
      ss58: "5Whale1",
      free_tao: 1000.5,
      delegated_tao: 250.25,
      captured_at: 1750000000000,
    };
    const data = buildTopHoldersList([row]);
    const parsed = TopHoldersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("top-holders: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = TopHoldersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const BALANCE_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  // A SCALE-encoded AccountInfo blob: nonce/consumers/providers/sufficients
  // (u32 LE each) then AccountData's free + reserved (u128 LE each) -- same
  // shape tests/account-balance-loader.test.ts's accountInfoHex() builds.
  function accountInfoHex(freeRao: bigint, reservedRao: bigint): string {
    const u128 = (value: bigint): string => {
      let hex = "";
      let rest = value;
      for (let index = 0; index < 16; index += 1) {
        hex += Number(rest & 0xffn)
          .toString(16)
          .padStart(2, "0");
        rest >>= 8n;
      }
      return hex;
    };
    return `0x${"00000000".repeat(4)}${u128(freeRao)}${u128(reservedRao)}`;
  }

  test("account-balance: ArtifactSchema.parse(loadAccountBalance(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: accountInfoHex(1_000_000_000n, 0n),
        }),
      ),
    );
    const data = await loadAccountBalance(mockEnv(), BALANCE_SS58);
    const parsed = AccountBalanceArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-balance: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountBalanceArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-portfolio: ArtifactSchema.parse(buildAccountPortfolio(...)) succeeds", () => {
    const row = {
      netuid: 3,
      uid: 5,
      validator_permit: 1,
      active: 1,
      stake_tao: 1000.5,
      emission_tao: 22.1,
      rank: 0.5,
      trust: 0.9,
      incentive: 0.6,
      dividends: 0.4,
      captured_at: 1750000000000,
    };
    const data = buildAccountPortfolio([row], "5Hk", {
      priceByNetuid: SCHEMA_PRICES,
    });
    const parsed = AccountPortfolioArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-portfolio: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountPortfolioArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  function identityRow(overrides = {}) {
    return {
      account: "5Acc0",
      name: "Example Team",
      url: "https://miao.example/",
      github: "https://github.com/miao-team/miao-repo",
      image: "https://miao.example/logo.png",
      discord: "examplehandle",
      description: "An example subnet operator.",
      additional: null,
      captured_at: 1_700_000_000_000,
      ...overrides,
    };
  }

  test("account-identity: ArtifactSchema.parse(buildAccountIdentity(...)) succeeds", () => {
    const data = buildAccountIdentity(identityRow(), "5Acc0");
    const parsed = AccountIdentityArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-identity: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountIdentityArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-identity-history: ArtifactSchema.parse(buildAccountIdentityHistory(...)) succeeds", () => {
    const row = { ...identityRow(), id: 10, identity_hash: "abc" };
    const data = buildAccountIdentityHistory([row], "5Acc0", {
      limit: 100,
      offset: 0,
      nextCursor: "2.1",
    });
    const parsed = AccountIdentityHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-identity-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountIdentityHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-positions: ArtifactSchema.parse(buildAccountPositions(...)) succeeds", () => {
    const row = {
      coldkey: "5Cold",
      hotkey: "5Hk1",
      netuid: 3,
      share_fraction: 0.25,
      captured_at: 1_780_000_000_000,
    };
    const data = buildAccountPositions(
      [row],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    const parsed = AccountPositionsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-positions: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountPositionsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-position-history: ArtifactSchema.parse(buildAccountPositionHistory(...)) succeeds", () => {
    const row = {
      snapshot_date: "2026-06-20",
      captured_at: 1_780_000_000_000,
      uid: 3,
      coldkey: "5Cold",
      active: 1,
      validator_permit: 1,
      rank: 0.5,
      trust: 0.9,
      incentive: 0.6,
      dividends: 0.4,
      stake_tao: 456.7,
      emission_tao: 1.23,
    };
    const data = buildAccountPositionHistory([row], "5SS58", 7, {
      window: "30d",
    });
    const parsed = AccountPositionHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-position-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountPositionHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const ROOT_CLAIM_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  function toHex(bytes: Uint8Array) {
    return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  function concatBytes(...parts: Uint8Array[]) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  function compactU32(n: number) {
    if (n < 64) return Uint8Array.of(n << 2);
    const v = (n << 2) | 0b01;
    return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff);
  }
  function u16Le(n: number) {
    return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
  }
  function i128LeFromFloat(n: number) {
    const bits = BigInt(Math.round(n * 2 ** 32));
    const out = new Uint8Array(16);
    let rest = bits < 0n ? bits + (1n << 128n) : bits;
    for (let i = 0; i < 16; i += 1) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return out;
  }
  function u128Le(n: number) {
    return i128LeFromFloat(n);
  }

  test("account-root-claim: ArtifactSchema.parse(loadAccountRootClaim(...)) succeeds", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const claimTypeHex = "0x01"; // Keep
    const stakingHex = toHex(concatBytes(compactU32(1), hotAccountId));
    const ownedHex = toHex(compactU32(0));
    const claimableHex = toHex(
      concatBytes(compactU32(1), u16Le(5), i128LeFromFloat(0.25)),
    );
    const claimedHex = toHex(u128Le(1000));
    const thresholdHex = toHex(i128LeFromFloat(0.5));
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        const results = [
          claimTypeHex,
          stakingHex,
          ownedHex,
          claimableHex,
          claimedHex,
          thresholdHex,
        ];
        const result = results[call - 1] ?? null;
        return Response.json({ jsonrpc: "2.0", id: 1, result });
      }),
    );
    const data = await loadAccountRootClaim(mockEnv(), ROOT_CLAIM_SS58);
    const parsed = AccountRootClaimArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-root-claim: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountRootClaimArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const ACTIVITY_ADDR = "5GReferenceAccountAddressForZodSchemaTestssssssss";
  function activityRow(
    netuid: number,
    count: number,
    first: number,
    last: number,
  ) {
    return {
      netuid,
      announcements: count,
      movements: count,
      first_observed: first,
      last_observed: last,
    };
  }

  test("account-serving: ArtifactSchema.parse(buildAccountServing(...)) succeeds", () => {
    const data = buildAccountServing(
      [activityRow(1, 30, 1_700_000_000_000, 1_700_500_000_000)],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountServingArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-serving: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountServingArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-prometheus: ArtifactSchema.parse(buildAccountPrometheus(...)) succeeds", () => {
    const data = buildAccountPrometheus(
      [activityRow(1, 30, 1_700_000_000_000, 1_700_500_000_000)],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountPrometheusArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-prometheus: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountPrometheusArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-stake-moves: ArtifactSchema.parse(buildAccountStakeMoves(...)) succeeds", () => {
    const data = buildAccountStakeMoves(
      [activityRow(1, 3, 1_700_000_000_000, 1_700_500_000_000)],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountStakeMovesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-stake-moves: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountStakeMovesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-stake-flow: ArtifactSchema.parse(buildAccountStakeFlow(...)) succeeds", () => {
    const row = (netuid: number, kind: string, tao: number, count: number) => ({
      netuid,
      event_kind: kind,
      total_tao: tao,
      event_count: count,
    });
    const data = buildAccountStakeFlow(
      [row(1, "StakeAdded", 100, 3), row(1, "StakeRemoved", 40, 2)],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountStakeFlowArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-stake-flow: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountStakeFlowArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 5 (#8059) -- account_events/extrinsics/account_identity D1-tier and
// live finney-RPC routes. None of these are servable through
// createLocalArtifactEnv() either (same situation batches 3/4 hit), so each
// case drives the real pure builder/loader directly against a real
// D1/event-row shape (reused from that builder's own tests/*.test.ts
// fixtures). The live-RPC routes mock global fetch, or exercise the
// documented RPC-failure/cold-empty code path where that's simpler and
// still real, schema-conformant output.
describe("batch 5 (#8059) route artifact schemas parse real builder output", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ACTIVITY_ADDR = "5GReferenceAccountAddressForZodSchemaTestsB5ssssss";
  function activityRow(
    netuid: number,
    countField: string,
    count: number,
    first: number,
    last: number,
  ) {
    return {
      netuid,
      [countField]: count,
      first_observed: first,
      last_observed: last,
    };
  }

  test("account-axon-removals: ArtifactSchema.parse(buildAccountAxonRemovals(...)) succeeds", () => {
    const data = buildAccountAxonRemovals(
      [activityRow(1, "removals", 5, 1_700_000_000_000, 1_700_500_000_000)],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountAxonRemovalsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-axon-removals: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountAxonRemovalsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-deregistrations: ArtifactSchema.parse(buildAccountDeregistrations(...)) succeeds", () => {
    const data = buildAccountDeregistrations(
      [
        activityRow(
          1,
          "deregistrations",
          2,
          1_700_000_000_000,
          1_700_500_000_000,
        ),
      ],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountDeregistrationsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-deregistrations: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountDeregistrationsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-registrations: ArtifactSchema.parse(buildAccountRegistrations(...)) succeeds", () => {
    const data = buildAccountRegistrations(
      [
        activityRow(
          1,
          "registrations",
          3,
          1_700_000_000_000,
          1_700_500_000_000,
        ),
      ],
      ACTIVITY_ADDR,
      { window: "30d" },
    );
    const parsed = AccountRegistrationsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-registrations: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountRegistrationsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-weight-setters: ArtifactSchema.parse(buildAccountWeightSetters(...)) succeeds", () => {
    const data = buildAccountWeightSetters(
      [activityRow(1, "weight_sets", 30, 1_700_000_000_000, 1_700_500_000_000)],
      ACTIVITY_ADDR,
      { window: "7d" },
    );
    const parsed = AccountWeightSettersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-weight-setters: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountWeightSettersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-events: ArtifactSchema.parse(buildAccountEvents(...)) succeeds", () => {
    const row = {
      block_number: 9,
      event_kind: "StakeAdded",
      observed_at: 1750009000000,
    };
    const data = buildAccountEvents([row], "5Hk", {
      limit: 100,
      offset: 0,
      nextCursor: "2.1",
    });
    const parsed = AccountEventsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-events: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountEventsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-history: ArtifactSchema.parse(buildAccountHistory(...)) succeeds", () => {
    const row = {
      day: "2026-06-20",
      netuid: 7,
      event_count: 5,
      event_kinds: "StakeAdded,StakeRemoved",
      first_block: 100,
      last_block: 200,
    };
    const data = buildAccountHistory([row], "5Hk", {
      limit: 100,
      offset: 0,
      nextCursor: null,
    });
    const parsed = AccountHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-transfers: ArtifactSchema.parse(buildAccountTransfers(...)) succeeds", () => {
    const row = {
      block_number: 9,
      hotkey: "5From",
      coldkey: "5To",
      amount_tao: 12.5,
      observed_at: 1750009000000,
    };
    const data = buildAccountTransfers([row], "5From", {
      limit: 100,
      offset: 0,
      nextCursor: null,
    });
    const parsed = AccountTransfersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-transfers: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountTransfersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-extrinsics: ArtifactSchema.parse(buildAccountExtrinsics(...)) succeeds", () => {
    const row = {
      block_number: 1000,
      extrinsic_index: 4,
      extrinsic_hash: "0xhash",
      signer: "5Signer",
      call_module: "SubtensorModule",
      call_function: "add_stake",
      call_args: '[{"name":"hotkey","value":"5H..."}]',
      fee_tao: 0.0125,
      tip_tao: 0.5,
      success: 1,
      observed_at: 1750009000000,
    };
    const data = buildAccountExtrinsics([row], "5Hk", {
      limit: 100,
      offset: 0,
      nextCursor: null,
    });
    const parsed = AccountExtrinsicsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-extrinsics: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountExtrinsicsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-counterparties: ArtifactSchema.parse(buildCounterparties(...)) succeeds", () => {
    const rows = [
      {
        hotkey: "5Me",
        coldkey: "5CounterpartyA",
        amount_tao: 100,
        block_number: 5,
      },
      {
        hotkey: "5CounterpartyB",
        coldkey: "5Me",
        amount_tao: 30,
        block_number: 6,
      },
    ];
    const data = buildCounterparties(rows, "5Me", { limit: 20 });
    const parsed = AccountCounterpartiesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-counterparties: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountCounterpartiesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-entities: ArtifactSchema.parse(buildAccountEntities(...)) succeeds", () => {
    const data = buildAccountEntities("5SomeAccount", {
      entities: [],
      ownershipRows: [],
    });
    const parsed = AccountEntitiesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-entities: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountEntitiesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const DELEGATION_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  test("account-children: ArtifactSchema.parse(loadAccountChildren(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        if (body.method === "state_getKeysPaged") {
          return { ok: true, json: async () => ({ result: [] }) } as Response;
        }
        return { ok: true, json: async () => ({ result: null }) } as Response;
      }),
    );
    const data = await loadAccountChildren(mockEnv(), DELEGATION_SS58);
    const parsed = AccountChildrenArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-children: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountChildrenArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("account-parents: ArtifactSchema.parse(loadAccountParents(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        if (body.method === "state_getKeysPaged") {
          return { ok: true, json: async () => ({ result: [] }) } as Response;
        }
        return { ok: true, json: async () => ({ result: null }) } as Response;
      }),
    );
    const data = await loadAccountParents(mockEnv(), DELEGATION_SS58);
    const parsed = AccountParentsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("account-parents: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AccountParentsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("evm-address-mapping: ArtifactSchema.parse(loadAddressMapping(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable in test");
      }),
    );
    const data = await loadAddressMapping(
      mockEnv(),
      "0x1234567890123456789012345678901234567890",
    );
    const parsed = EvmAddressMappingArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("evm-address-mapping: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = EvmAddressMappingArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("network-parameters: ArtifactSchema.parse(loadNetworkParameters(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable in test");
      }),
    );
    const data = await loadNetworkParameters(mockEnv());
    const parsed = NetworkParametersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("network-parameters: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = NetworkParametersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("randomness: ArtifactSchema.parse(loadRandomnessStatus(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable in test");
      }),
    );
    const data = await loadRandomnessStatus(mockEnv());
    const parsed = RandomnessArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("randomness: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = RandomnessArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("sudo-key: ArtifactSchema.parse(loadSudoKey(...)) succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable in test");
      }),
    );
    const data = await loadSudoKey(mockEnv());
    const parsed = SudoKeyArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("sudo-key: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SudoKeyArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 6 (#8060) -- chain/* network-wide aggregates: extrinsics/blocks/
// account_events/neurons D1-tier data (no static file), driven directly
// against each route's own pure builder with fixture rows reused verbatim
// from that builder's own tests/*.test.ts. The two Postgres-proxy-only
// routes (chain-events, chain-events/stats) have no local pure builder to
// call (workers/data-api.ts inline-shapes them) -- those two use a real
// production response captured live via the metagraphed MCP's
// list_chain_events/get_chain_activity tools, which mirror these exact two
// REST routes.
describe("batch 6 (#8060) route artifact schemas parse real builder output", () => {
  const OBS = 1_700_000_000_000;

  test("chain-activity: ArtifactSchema.parse(buildChainActivity(...)) succeeds", () => {
    const data = buildChainActivity({
      window: "7d",
      observedAt: "2026-06-26T12:00:00.000Z",
      extrinsicRows: [
        {
          day: "2026-06-25",
          extrinsic_count: 100,
          successful_extrinsics: 99,
          unique_signers: 42,
        },
      ],
      blockRows: [{ day: "2026-06-25", block_count: 7200, event_count: 30000 }],
    });
    const parsed = ChainActivityArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-activity: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainActivityArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-calls: ArtifactSchema.parse(buildChainCalls(...)) succeeds", () => {
    const data = buildChainCalls({
      window: "7d",
      total: 1000,
      rows: [
        { call_module: "SubtensorModule", count: 600 },
        { call_module: "Balances", count: 150 },
      ],
    });
    const parsed = ChainCallsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-calls: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainCallsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-signers: ArtifactSchema.parse(buildChainSigners(...)) succeeds", () => {
    const data = buildChainSigners({
      window: "7d",
      observedAt: "2026-06-26T00:00:00.000Z",
      rows: [
        {
          signer: "5Sig",
          tx_count: 100,
          total_fee_tao: 1.5,
          total_tip_tao: 0.1,
          last_tx_block: 8490000,
        },
      ],
    });
    const parsed = ChainSignersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-signers: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainSignersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-fees: ArtifactSchema.parse(buildChainFees(...)) succeeds", () => {
    const data = buildChainFees({
      window: "7d",
      dailyRows: [
        {
          day: "2026-06-25",
          extrinsic_count: 100,
          signed_extrinsic_count: 90,
          total_fee_tao: 1.0,
          total_tip_tao: 0.5,
        },
      ],
      medianRows: [
        { day: "2026-06-25", median_fee_tao: "0.004", median_tip_tao: 0.001 },
      ],
      payerRows: [
        {
          signer: "5Pay",
          total_fee_tao: 0.8,
          total_tip_tao: 0.1,
          extrinsic_count: 40,
        },
      ],
    });
    const parsed = ChainFeesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-fees: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainFeesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // ---- network-rollup family (8 routes, identical shape) -------------------

  test("chain-axon-removals: ArtifactSchema.parse(buildChainAxonRemovals(...)) succeeds", () => {
    const data = buildChainAxonRemovals(
      [
        { netuid: 1, distinct_removers: 4, removals: 40 },
        { netuid: 2, distinct_removers: 2, removals: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_removers: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainAxonRemovalsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-axon-removals: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainAxonRemovalsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-deregistrations: ArtifactSchema.parse(buildChainDeregistrations(...)) succeeds", () => {
    const data = buildChainDeregistrations(
      [
        { netuid: 1, distinct_deregistered_hotkeys: 4, deregistrations: 40 },
        { netuid: 2, distinct_deregistered_hotkeys: 2, deregistrations: 30 },
      ],
      {
        window: "7d",
        networkDistinct: {
          distinct_deregistered_hotkeys: 6,
          newest_observed: OBS,
        },
      },
    );
    const parsed = ChainDeregistrationsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-deregistrations: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainDeregistrationsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-prometheus: ArtifactSchema.parse(buildChainPrometheus(...)) succeeds", () => {
    const data = buildChainPrometheus(
      [
        { netuid: 1, distinct_exporters: 4, announcements: 40 },
        { netuid: 2, distinct_exporters: 2, announcements: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_exporters: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainPrometheusArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-prometheus: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainPrometheusArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-registrations: ArtifactSchema.parse(buildChainRegistrations(...)) succeeds", () => {
    const data = buildChainRegistrations(
      [
        { netuid: 1, distinct_registrants: 4, registrations: 40 },
        { netuid: 2, distinct_registrants: 2, registrations: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_registrants: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainRegistrationsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-registrations: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainRegistrationsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-serving: ArtifactSchema.parse(buildChainServing(...)) succeeds", () => {
    const data = buildChainServing(
      [
        { netuid: 1, distinct_servers: 4, announcements: 40 },
        { netuid: 2, distinct_servers: 2, announcements: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_servers: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainServingArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-serving: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainServingArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-stake-moves: ArtifactSchema.parse(buildChainStakeMoves(...)) succeeds", () => {
    const data = buildChainStakeMoves(
      [
        { netuid: 1, distinct_movers: 4, movements: 40 },
        { netuid: 2, distinct_movers: 2, movements: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_movers: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainStakeMovesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-stake-moves: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainStakeMovesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-stake-transfers: ArtifactSchema.parse(buildChainStakeTransfers(...)) succeeds", () => {
    const data = buildChainStakeTransfers(
      [
        { netuid: 1, distinct_senders: 4, transfers: 40 },
        { netuid: 2, distinct_senders: 2, transfers: 30 },
      ],
      {
        window: "7d",
        networkDistinct: { distinct_senders: 6, newest_observed: OBS },
      },
    );
    const parsed = ChainStakeTransfersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-stake-transfers: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainStakeTransfersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-weights: ArtifactSchema.parse(buildChainWeights(...)) succeeds", () => {
    const data = buildChainWeights(
      [
        { netuid: 1, distinct_setters: 4, weight_sets: 40 },
        { netuid: 2, distinct_setters: 2, weight_sets: 30 },
      ],
      {
        window: "7d",
        networkDistinct: {
          distinct_setters: 6,
          newest_observed: OBS,
        },
      },
    );
    const parsed = ChainWeightsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-weights: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainWeightsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // ---- remaining chain/* routes ---------------------------------------------

  test("chain-alpha-volume: ArtifactSchema.parse(buildChainAlphaVolume(...)) succeeds", () => {
    const ev = (
      netuid: number,
      event_kind: string,
      alpha_volume: number,
      tao_volume: number,
      event_count: number,
    ) => ({
      netuid,
      event_kind,
      alpha_volume,
      tao_volume,
      event_count,
      last_observed: OBS,
    });
    const data = buildChainAlphaVolume(
      [
        ev(1, "StakeAdded", 100, 100, 5),
        ev(1, "StakeRemoved", 30, 30, 2),
        ev(2, "StakeAdded", 20, 20, 1),
        ev(2, "StakeRemoved", 80, 80, 3),
      ],
      {},
    );
    const parsed = ChainAlphaVolumeArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-alpha-volume: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainAlphaVolumeArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-concentration: ArtifactSchema.parse(buildChainConcentration(...)) succeeds", () => {
    const data = buildChainConcentration([
      {
        stake_tao: 10,
        emission_tao: 1,
        coldkey: "ck-a",
        validator_permit: 1,
        netuid: 1,
        captured_at: "2026-06-27T00:00:00Z",
      },
      {
        stake_tao: 20,
        emission_tao: 2,
        coldkey: "ck-a",
        validator_permit: 1,
        netuid: 2,
        captured_at: "2026-06-27T00:00:00Z",
      },
      {
        stake_tao: 30,
        emission_tao: 3,
        coldkey: "ck-b",
        validator_permit: 0,
        netuid: 2,
        captured_at: "2026-06-27T00:00:00Z",
      },
    ]);
    const parsed = ChainConcentrationArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-concentration: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainConcentrationArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // chain-events + chain-events/stats: pure Postgres-proxy routes with the
  // shaping logic inline in workers/data-api.ts (no local pure builder to
  // call). Fixtures below are a REAL production response captured live via
  // the metagraphed MCP's list_chain_events({limit:3})/get_chain_activity
  // ({blocks:100}) tools, which mirror these exact two REST routes.
  test("chain-events: ArtifactSchema.parse(<live list_chain_events response>) succeeds", () => {
    const data = {
      count: 3,
      next_before: 8697469,
      next_cursor: "1784965824000.8697469.326",
      events: [
        {
          block_number: 8697469,
          event_index: 328,
          pallet: "System",
          method: "ExtrinsicSuccess",
          args: {
            dispatch_info: {
              class: "Normal",
              weight: { ref_time: 2580157000, proof_size: 14789 },
              pays_fee: "Yes",
            },
          },
          phase: "ApplyExtrinsic",
          extrinsic_index: 15,
          observed_at: 1784965824000,
        },
        {
          block_number: 8697469,
          event_index: 327,
          pallet: "TransactionPayment",
          method: "TransactionFeePaid",
          args: {
            tip: [0],
            who: "5EymzZqKMoYbgDX17SrmzBFa3fqQKwVPMJrxAd5czjBbEcsk",
            actual_fee: [1290240],
          },
          phase: "ApplyExtrinsic",
          extrinsic_index: 15,
          observed_at: 1784965824000,
        },
        // #8825: positional-tuple SubtensorModule events emit args as an
        // array (decodeChainEventArgs), not a keyed object — regression
        // against the old object-only schema.
        {
          block_number: 123,
          event_index: 0,
          pallet: "SubtensorModule",
          method: "TimelockedWeightsRevealed",
          args: [78, "5Fk765B4CRBekwErwE5VxvveWhHztHSfsnsLt8cbDayDWsuk"],
          phase: "ApplyExtrinsic",
          extrinsic_index: 0,
          observed_at: 1784965824000,
        },
      ],
    };
    const parsed = ChainEventsFeedArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-events: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainEventsFeedArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-events: ArtifactSchema accepts the action-sentence summary field, null for an unmatched pallet.method (#8525)", () => {
    const templated = {
      block_number: 100,
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: {},
      phase: "ApplyExtrinsic",
      extrinsic_index: 0,
      observed_at: 1750000000000,
      summary: summarizeEvent("System", "ExtrinsicSuccess", {}),
    };
    const unmatched = {
      block_number: 100,
      event_index: 1,
      pallet: "NoSuchPallet",
      method: "NoSuchEvent",
      args: {},
      phase: "ApplyExtrinsic",
      extrinsic_index: 0,
      observed_at: 1750000000000,
      summary: summarizeEvent("NoSuchPallet", "NoSuchEvent", {}),
    };
    const parsed = ChainEventsFeedArtifactSchema.parse({
      count: 2,
      next_before: null,
      next_cursor: null,
      events: [templated, unmatched],
    });
    assert.equal(typeof parsed.events[0].summary, "string");
    assert.equal(parsed.events[1].summary, null);
  });

  test("chain-events-stats: ArtifactSchema.parse(<live get_chain_activity response>) succeeds", () => {
    const data = {
      window_blocks: 100,
      groups: 40,
      activity: [
        { pallet: "Balances", method: "Transfer", count: 16551 },
        { pallet: "Balances", method: "Deposit", count: 14671 },
        { pallet: "System", method: "ExtrinsicSuccess", count: 1517 },
      ],
    };
    const parsed = ChainEventsStatsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-events-stats: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainEventsStatsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-identity-history: ArtifactSchema.parse(buildChainIdentityHistory(...)) succeeds", () => {
    const change = (overrides: Record<string, unknown> = {}) => ({
      id: 10,
      netuid: 7,
      block_number: 100,
      observed_at: 1_700_000_000_000,
      subnet_name: "Alpha",
      symbol: "α",
      description: "old",
      github_repo: null,
      subnet_url: null,
      discord: null,
      logo_url: null,
      identity_hash: "abc",
      ...overrides,
    });
    const data = buildChainIdentityHistory(
      [
        change({ id: 4, netuid: 12, block_number: 400, subnet_name: "Delta" }),
        change({ id: 3, netuid: 7, block_number: 300, subnet_name: "Gamma" }),
      ],
      { limit: 50 },
    );
    const parsed = ChainIdentityHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-identity-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainIdentityHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-idle-stake: ArtifactSchema.parse(buildChainIdleStake(...)) succeeds", () => {
    const data = buildChainIdleStake([
      { netuid: 1, stake_tao: 10, dividends: 0 },
      { netuid: 2, stake_tao: 50, dividends: 0 },
      { netuid: 1, stake_tao: 5, dividends: 0.1 },
      { netuid: 2, stake_tao: 5, dividends: 0 },
    ]);
    const parsed = ChainIdleStakeArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-idle-stake: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainIdleStakeArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-performance: ArtifactSchema.parse(buildChainPerformance(...)) succeeds", () => {
    const data = buildChainPerformance([
      {
        incentive: 0.6,
        dividends: 0.5,
        trust: 0.9,
        consensus: 0.8,
        validator_trust: 0.95,
        active: 1,
        validator_permit: 1,
        netuid: 7,
        captured_at: 1_750_000_000_000,
      },
      {
        incentive: 0.1,
        dividends: 0,
        trust: 0.4,
        consensus: 0.3,
        validator_trust: 0,
        active: 1,
        validator_permit: 0,
        netuid: 12,
        captured_at: 1_750_000_000_000,
      },
    ]);
    const parsed = ChainPerformanceArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-performance: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainPerformanceArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-stake-flow: ArtifactSchema.parse(buildChainStakeFlow(...)) succeeds", () => {
    const ev = (
      netuid: number,
      event_kind: string,
      total_tao: number,
      event_count: number,
    ) => ({ netuid, event_kind, total_tao, event_count, last_observed: OBS });
    const data = buildChainStakeFlow(
      [
        ev(1, "StakeAdded", 100, 5),
        ev(1, "StakeRemoved", 30, 2),
        ev(2, "StakeAdded", 20, 1),
        ev(2, "StakeRemoved", 80, 3),
      ],
      { window: "30d" },
    );
    const parsed = ChainStakeFlowArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-stake-flow: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainStakeFlowArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-transfer-pairs: ArtifactSchema.parse(buildChainTransferPairs(...)) succeeds", () => {
    const pair = (
      from: string | null,
      to: string | null,
      volume: number,
      count = 1,
      lastBlock: unknown = 100,
    ) => ({
      from,
      to,
      volume_tao: volume,
      transfer_count: count,
      last_block: lastBlock,
      last_observed_at: OBS,
    });
    const data = buildChainTransferPairs({
      window: "7d",
      sort: "count",
      observedAt: "2026-07-03T00:00:00.000Z",
      totals: {
        transfer_count: "12",
        total_volume_tao: 100,
        unique_pairs: "5",
      },
      pairs: [
        pair("5From", "5To", 20, 4.9, "8454388"),
        pair("5To", "5From", 55, 2, 8454380),
      ],
    });
    const parsed = ChainTransferPairsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-transfer-pairs: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainTransferPairsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-transfers: ArtifactSchema.parse(buildChainTransfers(...)) succeeds", () => {
    const party = (address: string | null, volume: number, count = 1) => ({
      address,
      volume_tao: volume,
      transfer_count: count,
    });
    const data = buildChainTransfers({
      window: "30d",
      observedAt: "2026-06-30T00:00:00.000Z",
      totals: {
        transfer_count: 12,
        total_volume_tao: 100,
        unique_senders: 5,
        unique_receivers: 7,
      },
      senders: [party("5Sa", 60, 3), party("5Sb", 20, 2)],
      receivers: [party("5Rx", 55, 4)],
    });
    const parsed = ChainTransfersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-transfers: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainTransfersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-turnover: ArtifactSchema.parse(buildChainTurnover(...)) succeeds", () => {
    const vrow = (
      snapshot_date: string,
      netuid: number,
      hotkey: string,
      validator_permit = 1,
    ) => ({ snapshot_date, netuid, hotkey, validator_permit });
    const START = "2026-05-31";
    const END = "2026-06-30";
    const data = buildChainTurnover(
      [
        vrow(START, 1, "A"),
        vrow(START, 1, "B"),
        vrow(START, 2, "C"),
        vrow(END, 1, "B"),
        vrow(END, 1, "D"),
        vrow(END, 2, "C"),
      ],
      { window: "30d", startDate: START, endDate: END },
    );
    const parsed = ChainTurnoverArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-turnover: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainTurnoverArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-weight-setters: ArtifactSchema.parse(buildChainWeightSetters(...)) succeeds", () => {
    const leaderRows = [
      {
        hotkey: "5Grw...alice",
        uid: 3,
        weight_sets: 30,
        first_set: 1_750_000_000_000,
        last_set: 1_750_600_000_000,
      },
      {
        hotkey: null,
        uid: 8,
        weight_sets: 10,
        first_set: 1_750_100_000_000,
        last_set: 1_750_200_000_000,
      },
    ];
    const totals = {
      weight_sets: 40,
      distinct_setters: 2,
      newest_observed: 1_750_600_000_000,
    };
    const data = buildChainWeightSetters(leaderRows, totals, {
      window: "7d",
    });
    const parsed = ChainWeightSettersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-weight-setters: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainWeightSettersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("chain-yield: ArtifactSchema.parse(buildChainYield(...)) succeeds", () => {
    const data = buildChainYield([
      {
        validator_permit: 1,
        stake_tao: 1000,
        emission_tao: 50,
        netuid: 7,
        captured_at: 1_750_000_000_000,
      },
      {
        validator_permit: 1,
        stake_tao: 500,
        emission_tao: 20,
        netuid: 7,
        captured_at: 1_750_000_000_000,
      },
      {
        validator_permit: 0,
        stake_tao: 100,
        emission_tao: 10,
        netuid: 12,
        captured_at: 1_750_000_000_000,
      },
    ]);
    const parsed = ChainYieldArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-yield: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainYieldArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 7 (#8061) -- blocks/extrinsics/runtime/governance/sudo/validators
// D1-tier data (no static file), driven directly against each route's own
// real pure builder with fixture rows reused verbatim from that builder's
// own tests/*.test.ts. /api/v1/sudo and /api/v1/governance/config-changes
// reuse the identical ExtrinsicsFeedArtifact shape (buildExtrinsicFeed
// hardcoded to call_module='Sudo'/'AdminUtils') so they're covered by the
// extrinsics-feed tests below, not separately.
describe("batch 7 (#8061) route artifact schemas parse real builder output", () => {
  test("blocks: ArtifactSchema.parse(buildBlockFeed(...)) succeeds", () => {
    const feed = buildBlockFeed(
      [
        { block_number: 2, block_hash: "0x2", observed_at: 1750000000000 },
        { block_number: 1, block_hash: "0x1", observed_at: 1750000000000 },
      ],
      { limit: 50, offset: 0 },
    );
    const parsed = BlocksFeedArtifactSchema.parse(feed);
    assert.ok(parsed);
  });
  test("blocks: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlocksFeedArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("block-detail: ArtifactSchema.parse(buildBlock(...)) succeeds", () => {
    const out = buildBlock(
      { block_number: 5, block_hash: "0x5", observed_at: 1750000000000 },
      "5",
      { prev: 4, next: 6 },
    );
    const parsed = BlockDetailArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("block-detail: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlockDetailArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("blocks-summary: ArtifactSchema.parse(buildBlocksSummary(...)) succeeds", () => {
    const out = buildBlocksSummary([
      {
        block_number: 100,
        author: "5Alice",
        extrinsic_count: 3,
        event_count: 10,
        spec_version: 200,
        observed_at: 1_750_000_000_000,
      },
      {
        block_number: 101,
        author: "5Alice",
        extrinsic_count: 2,
        event_count: 8,
        spec_version: 200,
        observed_at: 1_750_000_012_000,
      },
      {
        block_number: 102,
        author: "5Bob",
        extrinsic_count: 5,
        event_count: 20,
        spec_version: 200,
        observed_at: 1_750_000_024_000,
      },
    ]);
    const parsed = BlocksSummaryArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("blocks-summary: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlocksSummaryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("runtime: ArtifactSchema.parse(buildRuntimeVersionHistory(...)) succeeds", () => {
    const transitionRow = (overrides: Record<string, unknown> = {}) => ({
      spec_version: 218,
      block_number: 5_123_456,
      observed_at: 1_750_000_000_000,
      ...overrides,
    });
    const out = buildRuntimeVersionHistory(
      [
        transitionRow({ spec_version: 217, block_number: 5_000_000 }),
        transitionRow({ spec_version: 218, block_number: 5_123_456 }),
        transitionRow({ spec_version: 219, block_number: 5_400_000 }),
      ],
      { spec_version: 219 },
    );
    const parsed = RuntimeVersionsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("runtime: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = RuntimeVersionsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("extrinsics: ArtifactSchema.parse(buildExtrinsicFeed(...)) succeeds", () => {
    const feed = buildExtrinsicFeed(
      [
        {
          block_number: 1000,
          extrinsic_index: 4,
          extrinsic_hash: "0xhash",
          signer: "5Signer",
          call_module: "SubtensorModule",
          call_function: "add_stake",
          call_args: '[{"name":"hotkey","value":"5H..."}]',
          fee_tao: 0.0125,
          tip_tao: 0.5,
          success: 1,
          observed_at: 1750000000000,
        },
      ],
      { limit: 50, offset: 0 },
    );
    const parsed = ExtrinsicsFeedArtifactSchema.parse(feed);
    assert.ok(parsed);
  });
  test("extrinsics: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ExtrinsicsFeedArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("extrinsics: buildExtrinsicFeed populates the action-sentence summary field, null for an unmatched call (#8525)", () => {
    const feed = buildExtrinsicFeed(
      [
        {
          block_number: 1000,
          extrinsic_index: 0,
          extrinsic_hash: "0xhash1",
          signer: "5Signer",
          call_module: "Timestamp",
          call_function: "set",
          call_args: "[]",
          observed_at: 1750000000000,
        },
        {
          block_number: 1000,
          extrinsic_index: 1,
          extrinsic_hash: "0xhash2",
          signer: "5Signer",
          call_module: "NoSuchModule",
          call_function: "no_such_function",
          call_args: "[]",
          observed_at: 1750000000000,
        },
      ],
      { limit: 50, offset: 0 },
    );
    const parsed = ExtrinsicsFeedArtifactSchema.parse(feed);
    assert.equal(parsed.extrinsics[0].summary, "Set the chain timestamp.");
    assert.equal(parsed.extrinsics[1].summary, null);
  });

  test("extrinsic-detail: ArtifactSchema.parse(buildExtrinsic(...)) succeeds", () => {
    const hash = `0x${"a".repeat(64)}`;
    const out = buildExtrinsic(
      {
        block_number: 5,
        extrinsic_index: 1,
        extrinsic_hash: hash,
        call_args: '{"netuid":1}',
        observed_at: 1750000000000,
      },
      hash,
      [
        formatAccountEvent({
          block_number: 5,
          event_index: 3,
          event_kind: "StakeAdded",
          hotkey: "5Hk",
          coldkey: "5Co",
          netuid: 1,
          uid: null,
          amount_tao: 12.5,
          alpha_amount: 9.25,
          observed_at: 1750000000000,
          extrinsic_index: 1,
        }),
      ],
    );
    const parsed = ExtrinsicDetailArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("extrinsic-detail: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ExtrinsicDetailArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("block-extrinsics: ArtifactSchema.parse(buildBlockExtrinsics(...)) succeeds", () => {
    const out = buildBlockExtrinsics(
      [
        { block_number: 2, extrinsic_index: 1, observed_at: 1750000000000 },
        { block_number: 2, extrinsic_index: 0, observed_at: 1750000000000 },
      ],
      "2",
      2,
      { limit: 50, offset: 0 },
    );
    const parsed = BlockExtrinsicsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("block-extrinsics: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlockExtrinsicsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("block-events: ArtifactSchema.parse(buildBlockEvents(...)) succeeds", () => {
    const out = buildBlockEvents(
      [
        {
          block_number: 1000,
          event_index: 3,
          event_kind: "StakeAdded",
          hotkey: "5Hk",
          coldkey: "5Co",
          netuid: 1,
          uid: null,
          amount_tao: 12.5,
          alpha_amount: 9.25,
          observed_at: 1750000000000,
          extrinsic_index: 2,
        },
      ],
      "1000",
      1000,
      { limit: 50, offset: 0 },
    );
    const parsed = BlockEventsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("block-events: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlockEventsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("block-chain-events: ArtifactSchema.parse(<live block chain-events shape>) succeeds", () => {
    const data = {
      block_number: 8697469,
      count: 3,
      events: [
        {
          event_index: 328,
          pallet: "System",
          method: "ExtrinsicSuccess",
          args: {
            dispatch_info: {
              class: "Normal",
              weight: { ref_time: 2580157000, proof_size: 14789 },
              pays_fee: "Yes",
            },
          },
          phase: "ApplyExtrinsic",
          extrinsic_index: 15,
          observed_at: 1784965824000,
        },
        {
          event_index: 327,
          pallet: "TransactionPayment",
          method: "TransactionFeePaid",
          args: {
            tip: [0],
            who: "5EymzZqKMoYbgDX17SrmzBFa3fqQKwVPMJrxAd5czjBbEcsk",
            actual_fee: [1290240],
          },
          phase: "ApplyExtrinsic",
          extrinsic_index: 15,
          observed_at: 1784965824000,
        },
        // #8825: positional-tuple SubtensorModule events emit args as an
        // array (decodeChainEventArgs), not a keyed object — regression
        // against the old object-only schema.
        {
          block_number: 8697469,
          event_index: 0,
          pallet: "SubtensorModule",
          method: "TimelockedWeightsRevealed",
          args: [78, "5Fk765B4CRBekwErwE5VxvveWhHztHSfsnsLt8cbDayDWsuk"],
          phase: "ApplyExtrinsic",
          extrinsic_index: 0,
          observed_at: 1784965824000,
        },
      ],
    };
    const parsed = BlockChainEventsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("block-chain-events: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BlockChainEventsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("validators: ArtifactSchema.parse(buildGlobalValidators(...)) succeeds", () => {
    const row = (overrides: Record<string, unknown>) => ({
      uid: 0,
      hotkey: "5Hk1",
      coldkey: "5Co1",
      active: 1,
      validator_permit: 1,
      rank: 1,
      trust: 0.5,
      validator_trust: 0.99,
      consensus: 0.4,
      incentive: 0.1,
      dividends: 0.2,
      emission_tao: 22.1,
      stake_tao: 1000.5,
      registered_at_block: 6702485,
      is_immunity_period: 0,
      axon: "1.2.3.4:8091",
      block_number: 8454388,
      captured_at: 1750000000000,
      ...overrides,
    });
    const out = buildGlobalValidators(
      [
        row({
          netuid: 1,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 100,
          emission_tao: 5,
          validator_trust: 0.4,
        }),
        row({
          netuid: 2,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a2",
          stake_tao: 50,
          emission_tao: 9,
          validator_trust: 0.8,
        }),
      ],
      { sort: "subnet_count", limit: 10, priceByNetuid: SCHEMA_PRICES },
    );
    const parsed = GlobalValidatorsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("validators: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = GlobalValidatorsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const VALIDATOR_ROW = {
    uid: 0,
    hotkey: "5Hk1",
    coldkey: "5Co1",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0.5,
    validator_trust: 0.99,
    consensus: 0.4,
    incentive: 0.1,
    dividends: 0.2,
    emission_tao: 22.1,
    stake_tao: 1000.5,
    registered_at_block: 6702485,
    is_immunity_period: 0,
    axon: "1.2.3.4:8091",
    block_number: 8454388,
    captured_at: 1750000000000,
  };

  test("validator-detail: ArtifactSchema.parse(buildValidatorDetail(...)) succeeds", () => {
    const out = buildValidatorDetail(
      [
        {
          ...VALIDATOR_ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 1000,
        },
        { ...VALIDATOR_ROW, netuid: 8, uid: 1, hotkey: "hk-a", stake_tao: 500 },
      ],
      "hk-a",
      { priceByNetuid: SCHEMA_PRICES },
    );
    const parsed = ValidatorDetailArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("validator-detail: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ValidatorDetailArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("compare-validators: ArtifactSchema.parse(composeValidatorComparison(buildValidatorDetail(...))) succeeds", () => {
    const detailA = buildValidatorDetail(
      [
        {
          ...VALIDATOR_ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 1000,
        },
      ],
      "hk-a",
      { priceByNetuid: SCHEMA_PRICES },
    );
    const detailB = buildValidatorDetail(
      [{ ...VALIDATOR_ROW, netuid: 3, uid: 1, hotkey: "hk-b", stake_tao: 500 }],
      "hk-b",
      { priceByNetuid: SCHEMA_PRICES },
    );
    const out = composeValidatorComparison([detailA, detailB], { netuid: 3 });
    const parsed = CompareValidatorsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("compare-validators: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = CompareValidatorsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("validator-history: ArtifactSchema.parse(buildValidatorHistory(...)) succeeds", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          subnet_count: 3,
          total_stake_alpha: 1000,
          total_emission_tao: 12.3,
        },
      ],
      "5Hk1",
      { window: "30d" },
    );
    const parsed = ValidatorHistoryArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("validator-history: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ValidatorHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("validator-nominators: ArtifactSchema.parse(buildValidatorNominators(...)) succeeds", () => {
    const out = buildValidatorNominators(
      [
        {
          coldkey: "ck-a",
          event_kind: "StakeAdded",
          total_tao: 100,
          event_count: 3,
          last_observed: 1000,
        },
        {
          coldkey: "ck-a",
          event_kind: "StakeRemoved",
          total_tao: 40,
          event_count: 2,
          last_observed: 1000,
        },
      ],
      "5Hk1",
      { window: "30d" },
    );
    const parsed = ValidatorNominatorsArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("validator-nominators: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ValidatorNominatorsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 10 (#8064) -- meta/contracts, evidence/freshness/search, providers/
// rpc, subnet-profiles, and agent-catalog routes. Most of these have no
// isolated pure per-request builder (the shape is assembled inline in
// scripts/build-artifacts.ts, a build script excluded from in-process
// coverage) -- for those, each case instead drives the real EXPORTED helper
// functions that DO exist (subnetIntegrationReadiness/buildAgentReadiness,
// evaluateArtifactBudgets/summarizeArtifactBudgets, listToolDefinitions,
// buildEndpointResourceArtifact/buildRpcEndpointArtifact/
// buildEndpointPoolArtifact, mergeFreshness, formatRpcUsage,
// buildContractsArtifact/buildApiIndexArtifact/buildCanonicalOpenApiArtifact/
// buildChangelog) composed with fixtures grounded in real captured
// production responses (api.metagraph.sh, 2026-07-25) rather than a fully
// hand-typed guess.
const GENERATED_AT_10 = "2026-07-25T00:00:00.000Z";
const CONTRACT_10 = "2026-07-03.2";

describe("batch 10 (#8064) route artifact schemas parse real builder output", () => {
  test("api-index: ApiIndexArtifactSchema.parse(buildApiIndexArtifact(...)) succeeds", () => {
    const contracts = buildContractsArtifact(GENERATED_AT_10);
    const apiIndex = buildApiIndexArtifact(GENERATED_AT_10, contracts);
    const parsed = ApiIndexArtifactSchema.parse(apiIndex);
    assert.ok(parsed);
  });
  test("api-index: ApiIndexArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ApiIndexArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("contracts: ContractsArtifactSchema.parse(buildContractsArtifact(...)) succeeds", () => {
    const contracts = buildContractsArtifact(GENERATED_AT_10);
    const parsed = ContractsArtifactSchema.parse(contracts);
    assert.ok(parsed);
  });
  test("contracts: ContractsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ContractsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("openapi: OpenApiArtifactSchema.parse(buildCanonicalOpenApiArtifact(...)) succeeds", async () => {
    const openapi = await buildCanonicalOpenApiArtifact(GENERATED_AT_10);
    const parsed = OpenApiArtifactSchema.parse(openapi);
    assert.ok(parsed);
  });
  test("openapi: OpenApiArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = OpenApiArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("changelog: ChangelogArtifactSchema.parse(buildChangelog(...)) succeeds (populated diff)", () => {
    const data = buildChangelog({
      contractVersion: CONTRACT_10,
      generatedAt: GENERATED_AT_10,
      currentArtifacts: [
        { path: "subnets.json", hash: "abc123" },
        { path: "openapi.json", hash: "def456" },
      ],
      currentCoverage: {
        candidate_count: 300,
        curated_overlay_count: 120,
        native_only_count: 10,
        surface_count: 900,
      },
      currentSubnets: {
        subnets: [
          { netuid: 1, name: "Root", slug: "root" },
          { netuid: 64, name: "Chutes", slug: "chutes" },
        ],
      },
      previousArtifacts: [{ path: "subnets.json", hash: "OLDHASH" }],
      previousCoverage: {
        candidate_count: 280,
        curated_overlay_count: 115,
        native_only_count: 12,
        surface_count: 850,
      },
      previousSubnets: { subnets: [{ netuid: 1, name: "Root", slug: "root" }] },
    });
    const parsed = ChangelogArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.equal(parsed.subnets.added[0].name, "Chutes");
  });
  test("changelog: ChangelogArtifactSchema.parse(buildChangelog(...)) succeeds (empty build-time placeholder)", () => {
    const data = buildChangelog({
      contractVersion: CONTRACT_10,
      generatedAt: GENERATED_AT_10,
      currentArtifacts: [],
      currentCoverage: {
        candidate_count: 0,
        curated_overlay_count: 0,
        native_only_count: 0,
        surface_count: 0,
      },
      currentSubnets: { subnets: [] },
      previousArtifacts: null,
      previousCoverage: null,
      previousSubnets: null,
    });
    const parsed = ChangelogArtifactSchema.parse(data);
    assert.equal(parsed.summary.coverage_delta, null);
  });
  test("changelog: ChangelogArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChangelogArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("build-summary: BuildSummaryArtifactSchema.parse(...) succeeds using real budget helpers", () => {
    const sizes = [
      { path: "subnets.json", size_bytes: 900_000 },
      { path: "openapi.json", size_bytes: 1_900_000 },
    ];
    const budgets = evaluateArtifactBudgets(sizes);
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      published_at: publishedAt(),
      adapter_count: 64,
      artifact_count: 500,
      artifact_size_bytes: 42_000_000,
      full_artifact_count: 2321,
      full_artifact_size_bytes: 44_000_000,
      storage_tier_counts: { dual: 4, git: 2, r2: 2315 },
      storage_tier_size_bytes: {
        dual: 4_000_000,
        git: 100_000,
        r2: 39_900_000,
      },
      artifacts: sizes,
      artifact_budget_summary: summarizeArtifactBudgets(budgets),
      artifact_budgets: budgets.filter((b) => b.status !== "ok"),
      candidate_count: 300,
      coverage: { candidate_count: 300, surface_count: 900 },
      endpoint_count: 3101,
      profile_count: 129,
      provider_count: 136,
      subnet_count: 129,
      surface_count: 3444,
      public_contract: {
        version: CONTRACT_10,
        url: "/metagraph/contracts.json",
      },
    };
    const parsed = BuildSummaryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("build-summary: BuildSummaryArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BuildSummaryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("freshness: FreshnessArtifactSchema.parse(mergeFreshness(...)) succeeds", () => {
    const staticFreshness = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      sources: [
        {
          as_of: null,
          id: "surface-health",
          lane: "health-probe",
          notes: "",
          path: "public/metagraph/health/latest.json",
          required_for_publish: false,
          stale_after_hours: 24,
          stale_behavior: "block",
          status: "missing",
          timestamp: null,
          timestamp_field: "health_probe_as_of",
        },
        {
          as_of: "2026-07-22T18:15:13Z",
          id: "native-subnets",
          lane: "native-data",
          notes: "",
          path: "registry/native/finney-subnets.json",
          required_for_publish: true,
          stale_after_hours: 48,
          stale_behavior: "block",
          status: "captured",
          timestamp: "2026-07-22T18:15:13Z",
          timestamp_field: "native_data_as_of",
        },
      ],
      summary: {
        adapter_count: 64,
        adapter_snapshot_as_of: "2026-07-22T18:23:07.250Z",
        blocking_source_count: 4,
        candidate_discovery_as_of: "2026-07-22T18:15:01.351Z",
        health_probe_as_of: null,
        health_surface_count: 1842,
        missing_blocking_source_count: 0,
        native_data_as_of: "2026-07-22T18:15:13Z",
        native_snapshot_captured_at: "2026-07-22T18:15:13Z",
        openapi_surface_count: 70,
        publish_ready_without_age_check: true,
        schema_snapshot_as_of: "2026-07-22T18:15:01.351Z",
        stale_window_warnings: [],
        verification_as_of: "2026-07-22T18:15:01.351Z",
        verification_generated_at: "2026-07-22T18:15:01.351Z",
        warning_source_count: 66,
      },
    };
    const merged = mergeFreshness(staticFreshness, {
      last_run_at: "2026-07-25T09:00:57.805Z",
    });
    const parsed = FreshnessArtifactSchema.parse(merged);
    assert.ok(parsed);
    // The live-only field this batch added to the hand-edited schema.
    assert.equal(
      parsed.summary.operational_probe_as_of,
      "2026-07-25T09:00:57.805Z",
    );
    const surfaceHealth = parsed.sources.find((s) => s.id === "surface-health");
    assert.equal(surfaceHealth?.status, "current");
  });
  test("freshness: FreshnessArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = FreshnessArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated pure builder (buildSourceHealthArtifact is unexported in
  // scripts/build-artifacts.ts) -- fixture is a real captured production
  // response (api.metagraph.sh/api/v1/source-health, 2026-07-25).
  test("source-health: SourceHealthArtifactSchema.parse(real captured response) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      source: "generated-provider-and-verification-summary",
      providers: [
        {
          authority: "official",
          candidate_count: 20,
          classifications: {
            "content-mismatch": 1,
            dead: 4,
            live: 13,
            redirected: 1,
            unsupported: 1,
          },
          endpoint_count: 71,
          id: "chutes",
          kind: "subnet-team",
          name: "Chutes",
          rpc_endpoint_count: 0,
          status: "ok",
          verification_result_count: 20,
        },
        {
          authority: "community",
          candidate_count: 0,
          classifications: {},
          endpoint_count: 1,
          id: "basilica",
          kind: "subnet-team",
          name: "Basilica",
          rpc_endpoint_count: 0,
          status: "unknown",
          verification_result_count: 0,
        },
      ],
      summary: {
        candidate_count: 2172,
        endpoint_count: 3101,
        provider_count: 136,
        rpc_endpoint_count: 11,
        status_counts: { degraded: 1, failed: 1, ok: 117, unknown: 17 },
        verification_result_count: 2172,
      },
    };
    const parsed = SourceHealthArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("source-health: SourceHealthArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SourceHealthArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated pure builder (buildSourceSnapshots closes over module-level
  // generatedAt/contractVersion) -- fixture is a real captured production
  // response (api.metagraph.sh/api/v1/source-snapshots, 2026-07-25).
  test("source-snapshots: SourceSnapshotsArtifactSchema.parse(real captured response) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      sources: [
        {
          captured_at: "2026-07-22T18:15:01.351Z",
          hash: "c96e1d1ba8b2992475f77c5cf3a6d8c50e8291bb6ca42dfbaa37880625fc76d0",
          id: "adapter:ain",
          kind: "adapter-snapshot",
          path: "registry/adapters/latest/ain.json",
          record_count: 2,
        },
        {
          captured_at: "1970-01-01T00:00:00.000Z",
          hash: "161b23a8fb60ef60697264edda6206d55ed377f8476202ac1201fc94dadfe2be",
          id: "maintainer-decisions",
          kind: "review-ledger",
          path: "registry/reviews/maintainer-reviewed.json",
          record_count: 129,
        },
        {
          captured_at: "2026-07-22T18:15:13Z",
          hash: "73b45792c80ce47b8049b109a09e3b6a5e3c50b7ddf47546881477b352dbafbb",
          id: "native-subnets",
          kind: "native-chain",
          path: "registry/native/finney-subnets.json",
          record_count: 129,
        },
      ],
      summary: {
        adapter_snapshot_count: 64,
        candidate_count: 2172,
        overlay_count: 129,
        provider_count: 136,
        source_count: 70,
        verification_result_count: 2172,
      },
    };
    const parsed = SourceSnapshotsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("source-snapshots: SourceSnapshotsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SourceSnapshotsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated pure builder (buildSearchIndex takes 5 registry-shaped
  // params, not independently constructible without full build state) --
  // fixture uses real per-type documents captured from api.metagraph.sh/
  // api/v1/search, 2026-07-25 (one subnet/surface/provider document each).
  test("search: SearchArtifactSchema.parse(real captured documents) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      document_count: 3,
      documents: [
        {
          id: "subnet:17",
          type: "subnet",
          netuid: 17,
          slug: "sn-17",
          title: "404—GEN",
          subtitle: "a decentralized 3D content generation competition",
          artifact_path: "/metagraph/subnets/17.json",
          url: "/subnets/17",
          tokens: ["17", "404", "gen", "subnet", "content", "generation"],
          categories: ["3d-generation", "official-website"],
          service_kinds: ["data-artifact", "subnet-api"],
        },
        {
          id: "surface:sn-35-oxmarkets-docs",
          type: "surface",
          netuid: 35,
          slug: "sn-35",
          title: "0xMarkets / Cartha documentation",
          subtitle: "docs / oxmarkets",
          artifact_path: "/metagraph/surfaces.json",
          url: "https://docs.0xmarkets.io/",
          tokens: ["0xmarkets", "35", "cartha", "docs", "documentation"],
        },
        {
          id: "provider:404-gen",
          type: "provider",
          title: "404-GEN",
          subtitle: "subnet-team",
          artifact_path: "/metagraph/providers.json",
          url: "https://www.404.xyz/",
          tokens: ["404", "gen", "subnet", "team", "community"],
        },
      ],
    };
    const parsed = SearchArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("search: SearchArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SearchArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // buildSlimSearchIndex(searchIndex) just strips `tokens` from search.json's
  // documents -- fixture mirrors the same real captured documents above,
  // minus tokens (confirmed live: no document ever carries a tokens key).
  test("search-index: SearchIndexArtifactSchema.parse(real captured slim documents) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      document_count: 2,
      documents: [
        {
          id: "subnet:17",
          type: "subnet",
          netuid: 17,
          slug: "sn-17",
          title: "404—GEN",
          subtitle: "a decentralized 3D content generation competition",
          artifact_path: "/metagraph/subnets/17.json",
          url: "/subnets/17",
          categories: ["3d-generation", "official-website"],
          service_kinds: ["data-artifact", "subnet-api"],
        },
        {
          id: "provider:404-gen",
          type: "provider",
          title: "404-GEN",
          subtitle: "subnet-team",
          artifact_path: "/metagraph/providers.json",
          url: "https://www.404.xyz/",
        },
      ],
    };
    const parsed = SearchIndexArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("search-index: SearchIndexArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SearchIndexArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated pure builder for the per-slug provider write (inline in
  // scripts/build-artifacts.ts) -- fixture mirrors real
  // registry/providers/*.json identity fields (basilica.json/404-gen.json)
  // plus the build-time enrichment fields and endpoint_summary this batch
  // added (bucket b).
  test("provider-detail: ProviderArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      provider: {
        schema_version: 1,
        id: "basilica",
        name: "Basilica",
        kind: "subnet-team",
        website_url: "https://www.basilica.ai/",
        github_url: "https://github.com/one-covenant/basilica",
        logo_url: "https://metagraph.sh/logos/basilica.png",
        authority: "community",
        public_notes: "",
        netuids: [39],
        subnet_count: 1,
        surface_count: 2,
        endpoint_count: 1,
        cluster_id: "basilica",
      },
      endpoint_summary: {
        endpoint_count: 1,
        monitored_count: 1,
        pool_eligible_count: 0,
        by_kind: { "subnet-api": 1 },
        by_status: { ok: 1 },
      },
    };
    const parsed = ProviderArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("provider-detail: ProviderArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ProviderArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("providers: ProvidersArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      generated_at: GENERATED_AT_10,
      providers: [
        {
          schema_version: 1,
          id: "404-gen",
          name: "404-GEN",
          kind: "subnet-team",
          website_url: "https://www.404.xyz/",
          authority: "community",
          social: { x: "https://x.com/404gen_" },
        },
      ],
    };
    const parsed = ProvidersArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("providers: ProvidersArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ProvidersArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("provider-endpoints: ProviderEndpointsArtifactSchema.parse(buildEndpointResourceArtifact(...)) succeeds", () => {
    const artifact = buildEndpointResourceArtifact({
      surfaces: [
        {
          id: "r1",
          key: "rpc-key-1",
          netuid: 0,
          kind: "subtensor-rpc",
          url: "https://rpc.example.com",
          provider: "alpha",
          authority: "official",
          auth_required: false,
          public_safe: true,
          probe: {
            enabled: true,
            method: "JSON-RPC",
            expect: "200",
            timeout_ms: 5000,
          },
        },
      ],
      healthSurfaces: [
        {
          surface_id: "r1",
          status: "ok",
          classification: "live",
          verified_at: GENERATED_AT_10,
          archive_support: true,
          latest_block: 100,
          methods_supported: { a: true, b: true },
          rpc_method_count: 7,
          latency_ms: 50,
        },
      ],
      generatedAt: GENERATED_AT_10,
      contractVersion: CONTRACT_10,
      source: "unit",
    });
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      provider: {
        id: "alpha",
        name: "Alpha",
        kind: "subnet-team",
        authority: "official",
      },
      summary: artifact.summary,
      endpoints: artifact.endpoints,
    };
    const parsed = ProviderEndpointsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("provider-endpoints: ProviderEndpointsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ProviderEndpointsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("rpc-endpoints: RpcEndpointsArtifactSchema.parse(buildRpcEndpointArtifact(...)) succeeds", () => {
    const artifact = buildRpcEndpointArtifact({
      surfaces: [
        {
          id: "s1",
          netuid: 0,
          subnet_slug: "root",
          subnet_name: "Root",
          kind: "subtensor-rpc",
          url: "https://rpc.example.com",
          provider: "alpha",
          authority: "official",
          auth_required: false,
          public_safe: true,
          source_urls: [],
        },
        {
          id: "s2",
          netuid: 0,
          subnet_slug: "root",
          subnet_name: "Root",
          kind: "subtensor-wss",
          url: "wss://rpc.example.com",
          provider: "beta",
          authority: "community",
          auth_required: false,
          public_safe: true,
          source_urls: [],
        },
      ],
      healthSurfaces: [
        {
          surface_id: "s1",
          status: "ok",
          classification: "live",
          verified_at: GENERATED_AT_10,
          archive_support: true,
          latest_block: 100,
          methods_supported: { a: true },
          rpc_method_count: 5,
          latency_ms: 50,
          method_tested: "system_health",
          last_ok: GENERATED_AT_10,
        },
      ],
      generatedAt: GENERATED_AT_10,
      contractVersion: CONTRACT_10,
      source: "unit",
    });
    const parsed = RpcEndpointsArtifactSchema.parse(artifact);
    assert.ok(parsed);
  });
  test("rpc-endpoints: RpcEndpointsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = RpcEndpointsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("rpc-pools: RpcPoolsArtifactSchema.parse(buildEndpointPoolArtifact(...)) succeeds", () => {
    const rpcArtifact = buildRpcEndpointArtifact({
      surfaces: [
        {
          id: "a",
          netuid: 0,
          kind: "subtensor-rpc",
          url: "https://a.example.com",
          provider: "alpha",
          authority: "official",
          auth_required: false,
          public_safe: true,
          source_urls: [],
        },
      ],
      healthSurfaces: [],
      generatedAt: GENERATED_AT_10,
      contractVersion: CONTRACT_10,
      source: "unit",
    });
    const artifact = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT_10,
      contractVersion: CONTRACT_10,
      rpcArtifact,
    });
    const parsed = RpcPoolsArtifactSchema.parse(artifact);
    assert.ok(parsed);
  });
  test("rpc-pools: RpcPoolsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = RpcPoolsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("rpc-usage: RpcUsageArtifactSchema.parse(formatRpcUsage(...)) succeeds (warm)", () => {
    const out = formatRpcUsage({
      window: "30d",
      bucketGranularity: "6h",
      observedAt: "2026-06-14T00:00:00Z",
      totals: {
        total: 1000,
        ok_count: 950,
        failover_count: 40,
        cache_hits: 250,
        avg_latency_ms: 160.7,
      },
      latency: { p50: 120.4, p95: 480.9 },
      endpointRows: [
        {
          endpoint_id: "fx",
          provider: "onfinality",
          requests: 700,
          ok_count: 690,
          avg_latency_ms: 140.2,
        },
      ],
      networkRows: [{ network: "finney", requests: 900, ok_count: 870 }],
      bucketRows: [
        {
          ts: 1_718_323_200_000,
          requests: 100,
          errors: 3,
          avg_latency_ms: 120.4,
        },
      ],
    });
    const parsed = RpcUsageArtifactSchema.parse(out);
    assert.ok(parsed);
  });
  test("rpc-usage: RpcUsageArtifactSchema.parse(formatRpcUsage(...)) succeeds (cold)", () => {
    const out = formatRpcUsage({ window: "7d", observedAt: null });
    const parsed = RpcUsageArtifactSchema.parse(out);
    assert.equal(parsed.endpoints.length, 0);
  });
  test("rpc-usage: RpcUsageArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = RpcUsageArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated pure builder for the list/detail writes (inline in
  // scripts/build-artifacts.ts) -- profile shape reused verbatim from
  // schemas-src/routes/subnet-profile.ts's own SubnetProfileSchema (already
  // verified field-for-field against buildSubnetProfile()'s real output).
  const PROFILE_FIXTURE = {
    netuid: 7,
    slug: "allways",
    name: "Allways",
    native_identity: null,
    subnet_type: "application",
    status: "active",
    project_name: "Allways",
    team: null,
    categories: ["inference"],
    derived_categories: ["inference"],
    primary_links: {
      website_url: "https://www.all-ways.io/",
      docs_url: null,
      source_repo: null,
      dashboard_url: null,
    },
    primary_app_surface: null,
    supported_interface_kinds: ["subnet-api"],
    operational_interface_kinds: ["subnet-api"],
    surface_count: 2,
    endpoint_count: 1,
    monitored_endpoint_count: 1,
    candidate_count: 0,
    identity_evidence: {
      candidate_identity_count: 0,
      curated_identity_count: 0,
      curated_identity_kinds: [],
      live_candidate_identity_kinds: [],
      native_contact_present: false,
      native_description_present: false,
      native_identity_count: 0,
      native_identity_kinds: [],
      needs_promotion_kinds: [],
      stale_candidate_identity_kinds: [],
      unverified_candidate_identity_kinds: [],
    },
    completeness: {
      score: 82,
      profile_level: "operational",
      identity_level: "partial",
      identity_surface_count: 1,
      confidence: "high",
      missing_identity: [],
      missing_required: [],
      missing_operational: [],
      missing_critical_count: 0,
      gap_reasons: [],
    },
    provenance: {
      identity_source: "chain",
      interface_source_count: 1,
      review_state: "unreviewed",
      curation_level: "native",
      reviewed_at: null,
      source_urls: [],
    },
    curation_level: "native",
    review_state: "unreviewed",
    confidence: "high",
    profile_level: "operational",
    identity_level: "partial",
    identity_surface_count: 1,
    completeness_score: 82,
    missing_identity: [],
    missing_required: [],
    missing_operational: [],
    missing_critical_count: 0,
    gap_reasons: [],
    suggested_submission_kinds: [],
    integration_readiness: 70,
    readiness: {
      score: 70,
      readiness_tier: "buildable",
      readiness_version: 1,
      components: { has_callable_api: true },
    },
  };

  test("profiles: SubnetProfilesArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      profiles: [PROFILE_FIXTURE],
      summary: {
        profile_count: 1,
        average_completeness_score: 82,
        native_identity_count: 0,
        identity_promotion_candidate_count: 0,
        native_identity_unpromoted_count: 0,
        by_profile_level: { operational: 1 },
        by_identity_level: { partial: 1 },
        by_confidence: { high: 1 },
      },
    };
    const parsed = SubnetProfilesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("profiles: SubnetProfilesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetProfilesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-profile: SubnetProfileArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      profile: PROFILE_FIXTURE,
      subnet: {
        coverage_level: "probed",
        curation: { level: "native", review_state: "unreviewed" },
        curation_level: "native",
        gaps: {
          gap_notes: [],
          missing_kinds: [],
          supported_kinds: ["subnet-api"],
        },
        links: [],
        name: "Allways",
        netuid: 7,
        provenance: {},
        slug: "allways",
        status: "active",
        subnet_type: "application",
        surface_count: 2,
      },
      surfaces: [],
      endpoints: [],
      candidate_surfaces: [],
      gaps: {
        gap_notes: [],
        missing_kinds: [],
        supported_kinds: ["subnet-api"],
      },
    };
    const parsed = SubnetProfileArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-profile: SubnetProfileArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetProfileArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("schemas: SchemaIndexArtifactSchema.parse(real handler output) succeeds", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/schemas"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown };
    const parsed = SchemaIndexArtifactSchema.parse(body.data);
    assert.ok(parsed);
  });
  test("schemas: SchemaIndexArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SchemaIndexArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // No isolated top-level builder (assembled inline per-subnet in
  // scripts/build-artifacts.ts) -- composes the real exported readiness
  // helpers (subnetIntegrationReadiness/buildAgentReadiness) with a
  // realistic SN7 (callable) + SN31 (blocked) fixture pair.
  test("agent-catalog: AgentCatalogArtifactSchema.parse(...) succeeds", () => {
    const services7 = [
      {
        surface_id: "allways-api-health",
        kind: "subnet-api",
        eligibility: { callable: true },
        schema_artifact: "/metagraph/schemas/allways-swagger.json",
        auth_required: false,
      },
    ];
    const readiness7 = subnetIntegrationReadiness({
      services: services7,
      lifecycle: "active",
      completenessScore: 82,
      sourceRepo: "https://github.com/allways/subnet",
      docsUrl: "https://docs.allways.io",
      candidates: [],
    });
    const agentReadiness7 = buildAgentReadiness({
      subnet: { subnet_type: "application" },
      profile: { subnet_type: "application" },
      services: services7,
      readiness: readiness7,
      callableCount: 1,
    });
    const readiness31 = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 40,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const agentReadiness31 = buildAgentReadiness({
      subnet: { subnet_type: "application" },
      profile: null,
      services: [],
      readiness: readiness31,
      callableCount: 0,
    });
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      total_subnet_count: 2,
      subnet_count: 1,
      blocked_subnet_count: 1,
      callable_service_count: 1,
      blocker_summary: { by_status: { blocked: 1 } },
      subnets: [
        {
          netuid: 7,
          slug: "allways",
          name: "Allways",
          native_name: "allways",
          categories: ["inference"],
          subnet_type: "application",
          completeness_score: 82,
          integration_readiness: readiness7.score,
          readiness: readiness7,
          agent_readiness: agentReadiness7,
          service_count: 1,
          callable_count: 1,
          service_kinds: ["subnet-api"],
          example_count: 0,
          base_url: "https://api.all-ways.io",
          health: "unknown",
        },
      ],
      blocked_subnets: [
        {
          netuid: 31,
          slug: "sn31",
          name: "SN31",
          categories: [],
          subnet_type: "application",
          completeness_score: 40,
          integration_readiness: readiness31.score,
          readiness_tier: readiness31.readiness_tier,
          service_count: 0,
          callable_count: 0,
          agent_readiness: agentReadiness31,
        },
      ],
    };
    const parsed = AgentCatalogArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.ok(agentReadiness31.blockers.length > 0);
  });
  test("agent-catalog: AgentCatalogArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AgentCatalogArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("agent-catalog-subnet: AgentCatalogSubnetArtifactSchema.parse(...) succeeds", () => {
    const services = [
      {
        surface_id: "allways-api-health",
        kind: "subnet-api",
        capability: "Allways health API",
        base_url: "https://api.all-ways.io",
        provider: "allways",
        authority: "official",
        auth_required: false,
        auth_schemes: [],
        schema_url: "https://api.all-ways.io/swagger-json",
        schema_status: "machine-readable",
        schema_artifact: "/metagraph/schemas/allways-swagger.json",
        schema_source: {
          surface_id: "allways-swagger",
          match: "same-origin-openapi",
          url: "https://api.all-ways.io/swagger-json",
          artifact: "/metagraph/schemas/allways-swagger.json",
          status: "captured",
          observed_at: GENERATED_AT_10,
          hash: "sha256-abc",
        },
        health: { status: "unknown", stale: true },
        eligibility: { callable: true, reasons: [] },
        fixture_status: {
          status: "available",
          reason: null,
          artifact_path: "/metagraph/fixtures/allways-api-health.json",
          captured_at: GENERATED_AT_10,
        },
      },
    ];
    const readiness = subnetIntegrationReadiness({
      services,
      lifecycle: "active",
      completenessScore: 82,
      sourceRepo: "https://github.com/allways/subnet",
      docsUrl: "https://docs.allways.io",
      candidates: [],
    });
    const agentReadiness = buildAgentReadiness({
      subnet: { subnet_type: "application" },
      profile: { subnet_type: "application" },
      services,
      readiness,
      callableCount: 1,
    });
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      netuid: 7,
      slug: "allways",
      name: "Allways",
      categories: ["inference"],
      subnet_type: "application",
      completeness_score: 82,
      integration_readiness: readiness.score,
      readiness,
      agent_readiness: agentReadiness,
      service_count: 1,
      services,
      example_count: 0,
      examples: [],
    };
    const parsed = AgentCatalogSubnetArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("agent-catalog-subnet: AgentCatalogSubnetArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AgentCatalogSubnetArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("agent-resources: AgentResourcesArtifactSchema.parse(...) succeeds using real listToolDefinitions()", () => {
    const tools = listToolDefinitions().map(
      (t: { name: string; title?: string | null }) => ({
        name: t.name,
        title: t.title ?? null,
      }),
    );
    assert.ok(tools.length > 0);
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_10,
      generated_at: GENERATED_AT_10,
      published_at: "2026-07-01T00:05:00.000Z",
      content_hash: "sha256-0123456789abcdef",
      summary: { subnet_count: 128, callable_service_count: 47 },
      copyable_agent: {
        title: "Bittensor integration agent",
        url: "https://api.metagraph.sh/agent.md",
        description: "Paste-ready system prompt.",
      },
      mcp: {
        endpoint: "https://api.metagraph.sh/mcp",
        transport: "streamable-http",
        install:
          "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp",
        server_card:
          "https://api.metagraph.sh/.well-known/mcp/server-card.json",
        tools,
      },
      resources: [
        {
          id: "agent",
          title: "Copyable AI agent",
          kind: "agent",
          url: "https://api.metagraph.sh/agent.md",
        },
        {
          id: "agent-catalog",
          title: "Agent capability catalog",
          kind: "api",
          url: "https://api.metagraph.sh/api/v1/agent-catalog",
        },
      ],
    };
    const parsed = AgentResourcesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("agent-resources: AgentResourcesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = AgentResourcesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// Batch 9 (#8063) -- health/surfaces/endpoints/candidates/evidence routes.
// D1 is fully retired; 6 of these 8 health-* routes are proxied to the
// DATA_API service Worker (same pattern as batch 2's DATA_API-proxied block
// above) -- driven directly against the real format*() functions in
// src/health-serving.ts with Postgres-row-shaped fixtures. health-history
// and endpoint-incidents/endpoint-pools have no isolated exported per-
// request builder (buildHealthHistoryArtifact is duplicated, unexported, in
// scripts/build-artifacts.ts and scripts/probes-smoke.ts; candidates/
// evidence are assembled inline in scripts/build-artifacts.ts with no
// wrapping function at all, same as batch 8's Lineage precedent) -- those
// cases use hand-composed fixtures that mirror the real transformation/
// sample shapes exactly (candidates/evidence fixtures are drawn from real
// captured production responses, api.metagraph.sh, 2026-07-25).
const GENERATED_AT_9 = "2026-07-25T00:00:00.000Z";
const CONTRACT_9 = "2026-07-03.2";

describe("batch 9 (#8063) route artifact schemas parse real builder output", () => {
  test("health-history: HealthHistoryArtifactSchema.parse(...) succeeds (hand-composed, matches buildHealthHistoryArtifact()'s field mapping)", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      date: "2026-07-24",
      probe_started_at: "2026-07-24T06:00:00.000Z",
      probe_finished_at: "2026-07-24T06:00:12.000Z",
      source: "cron-prober",
      summary: {
        surface_count: 1,
        status_counts: { ok: 1 },
        classification_counts: { live: 1 },
      },
      surfaces: [
        {
          surface_id: "sn-7-example",
          netuid: 7,
          kind: "openapi",
          provider: "allways",
          status: "ok",
          classification: "live",
          latency_ms: 120,
          status_code: 200,
          last_checked: "2026-07-24T06:00:00.000Z",
          last_ok: "2026-07-24T06:00:00.000Z",
          verified_at: "2026-07-24T06:00:00.000Z",
          error_class: null,
        },
      ],
    };
    const parsed = HealthHistoryArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("health-history: HealthHistoryArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = HealthHistoryArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("health-trends-bulk: BulkHealthTrendsArtifactSchema.parse(formatBulkTrends(...)) succeeds", () => {
    const data = formatBulkTrends({
      observedAt: "2026-06-11T00:00:00.000Z",
      windowDays: { "7d": 7, "30d": 30 },
      windows: {
        "7d": [
          {
            netuid: 8,
            date: "2026-06-10",
            total: 4,
            ok_count: 2,
            avg_latency_ms: 10.2,
          },
          {
            netuid: 7,
            date: "2026-06-11",
            total: 10,
            ok_count: 9,
            avg_latency_ms: 50.4,
          },
          {
            netuid: 7,
            date: "2026-06-10",
            total: 5,
            ok_count: 5,
            avg_latency_ms: 30,
          },
        ],
        "30d": [],
      },
    });
    const parsed = BulkHealthTrendsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("health-trends-bulk: BulkHealthTrendsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = BulkHealthTrendsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("incidents: GlobalIncidentsArtifactSchema.parse(formatGlobalIncidents(...)) succeeds", () => {
    const data = formatGlobalIncidents({
      window: "30d",
      observedAt: "2026-06-13T00:00:00.000Z",
      maxIncidents: 1000,
      incidentRows: [
        {
          netuid: 7,
          surface_id: "a",
          started_at: 1000,
          ended_at: 5000,
          failed_samples: 3,
        },
        {
          netuid: 7,
          surface_id: "a",
          started_at: 20000,
          ended_at: 26000,
          failed_samples: 2,
        },
        {
          netuid: 23,
          surface_id: "b",
          started_at: 8000,
          ended_at: 9000,
          failed_samples: 1,
        },
      ],
    });
    const parsed = GlobalIncidentsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("incidents: GlobalIncidentsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = GlobalIncidentsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-health: HealthSubnetArtifactSchema.parse(overlaySubnetHealth(...)) succeeds (warm live snapshot)", () => {
    const data = overlaySubnetHealth(
      null,
      {
        last_run_at: "2026-06-11T00:00:00.000Z",
        surfaces: [
          {
            surface_id: "sn7-api",
            netuid: 7,
            kind: "subnet-api",
            provider: "allways",
            url: "https://api.all-ways.io",
            status: "ok",
            classification: "live",
            latency_ms: 50,
            last_checked: "2026-06-11T00:00:00.000Z",
            last_ok: "2026-06-11T00:00:00.000Z",
          },
        ],
      },
      7,
    );
    const parsed = HealthSubnetArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.equal(parsed.surfaces[0].observed_by, "live-cron-prober");
  });
  test("subnet-health: HealthSubnetArtifactSchema.parse(unknownSubnetHealth(...)-shaped) succeeds (cold store)", () => {
    // unknownSubnetHealth() (workers/api.ts) is the real cold-store fallback
    // -- not exported, but a trivial fixed literal (no branching), hand-typed
    // here to match it exactly.
    const data = {
      schema_version: 1,
      netuid: 7,
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
    const parsed = HealthSubnetArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-health: HealthSubnetArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = HealthSubnetArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-health-incidents: HealthIncidentsArtifactSchema.parse(formatIncidents(...)) succeeds", () => {
    const data = formatIncidents({
      netuid: 7,
      window: "7d",
      observedAt: null,
      slaRows: [{ surface_id: "x", total: 100, ok_count: 96 }],
      incidentRows: [
        {
          surface_id: "x",
          started_at: 1_000_000_000_000,
          ended_at: 1_000_000_240_000,
          failed_samples: 3,
        },
        {
          surface_id: "x",
          started_at: 1_000_000_720_000,
          ended_at: 1_000_000_840_000,
          failed_samples: 2,
        },
      ],
    });
    const parsed = HealthIncidentsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-health-incidents: HealthIncidentsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = HealthIncidentsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-health-percentiles: HealthPercentilesArtifactSchema.parse(formatPercentiles(...)) succeeds", () => {
    const data = formatPercentiles({
      netuid: 7,
      window: "7d",
      observedAt: "2026-06-10T00:00:00Z",
      rows: [
        {
          surface_id: "b",
          samples: 100,
          p50: 120.4,
          p95: 410.9,
          p99: 800,
          avg_latency_ms: 150.6,
          min_latency_ms: 40,
          max_latency_ms: 900,
        },
        {
          surface_id: "a",
          samples: 50,
          p50: 90,
          p95: 200,
          p99: null,
          avg_latency_ms: 110,
          min_latency_ms: 30,
          max_latency_ms: 500,
        },
      ],
    });
    const parsed = HealthPercentilesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-health-percentiles: HealthPercentilesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = HealthPercentilesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-health-trends: HealthTrendsArtifactSchema.parse(formatTrends(...)) succeeds", () => {
    const data = formatTrends({
      netuid: 7,
      observedAt: "2026-06-11T00:00:00Z",
      windows: {
        "7d": [
          {
            surface_id: "a",
            total: 100,
            ok_count: 96,
            latency_samples: 96,
            avg_latency_ms: 50.4,
            p50: 40.6,
            p95: 410.2,
            p99: 900,
          },
        ],
        "30d": [
          { surface_id: "a", total: 400, ok_count: 380, avg_latency_ms: 60.9 },
        ],
      },
    });
    const parsed = HealthTrendsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-health-trends: HealthTrendsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = HealthTrendsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-uptime: UptimeArtifactSchema.parse(formatUptime(...)) succeeds (with reliability)", () => {
    const data = formatUptime({
      netuid: 7,
      window: "90d",
      rows: [
        {
          surface_id: "b",
          day: "2026-06-12",
          samples: 100,
          ok_count: 100,
          uptime_ratio: 1,
          avg_latency_ms: 50,
          status: "ok",
        },
        {
          surface_id: "a",
          day: "2026-06-13",
          samples: 100,
          ok_count: 90,
          uptime_ratio: 0.9,
          avg_latency_ms: 70,
          status: "degraded",
        },
        {
          surface_id: "a",
          day: "2026-06-12",
          samples: 100,
          ok_count: 80,
          uptime_ratio: 0.8,
          avg_latency_ms: 60,
          status: "degraded",
        },
      ],
    });
    const parsed = UptimeArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.notEqual(parsed.reliability, null);
  });
  test("subnet-uptime: UptimeArtifactSchema.parse(formatUptime(...)) succeeds (empty rows, null reliability)", () => {
    const data = formatUptime({ netuid: 7, window: "1y", rows: [] });
    const parsed = UptimeArtifactSchema.parse(data);
    assert.equal(parsed.reliability, null);
    assert.deepEqual(parsed.surfaces, []);
  });
  test("subnet-uptime: UptimeArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = UptimeArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // surfaces/subnet-surfaces: no isolated builder (surfaces[] is a plain
  // Map.get() slice of the same top-level array the pilot's
  // SubnetDetailArtifact.surfaces[] already validates) -- hand-composed
  // fixture matching SurfaceSchema exactly.
  const SAMPLE_SURFACE_9 = {
    auth_required: false,
    authority: "official",
    id: "sn-7-example-api",
    kind: "subnet-api",
    netuid: 7,
    provider: "allways",
    public_safe: true,
    url: "https://api.all-ways.io",
    status: "ok",
  };

  test("surfaces: SurfacesArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      generated_at: GENERATED_AT_9,
      notes:
        "Curated and verified public interface surfaces only. Native-only subnet stubs do not invent surfaces.",
      surfaces: [SAMPLE_SURFACE_9],
    };
    const parsed = SurfacesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("surfaces: SurfacesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SurfacesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-surfaces: SubnetSurfacesArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      netuid: 7,
      slug: "sn-7",
      name: "Allways",
      surfaces: [SAMPLE_SURFACE_9],
    };
    const parsed = SubnetSurfacesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-surfaces: SubnetSurfacesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetSurfacesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // endpoints/subnet-endpoints/endpoint-incidents/endpoint-pools all chain
  // off the same real buildEndpointResourceArtifact() output (one surface
  // ok+archive-eligible, one degraded) -- exercising the real
  // surface->endpoint->incident->pool pipeline end to end, not four
  // independent hand-typed guesses.
  const ENDPOINT_SURFACES_9 = [
    {
      id: "sn-1-example-rpc",
      netuid: 1,
      subnet_slug: "sn-1",
      subnet_name: "Apex",
      kind: "subtensor-rpc",
      url: "https://rpc.example.com",
      provider: "example",
      authority: "official",
      auth_required: false,
      public_safe: true,
      probe: { enabled: true, method: "POST", expect: "json" },
    },
    {
      id: "sn-1-example-api",
      netuid: 1,
      subnet_slug: "sn-1",
      subnet_name: "Apex",
      kind: "subnet-api",
      url: "https://api.example.com",
      provider: "example",
      authority: "official",
      auth_required: false,
      public_safe: true,
      probe: { enabled: true, method: "GET", expect: "json" },
    },
  ];
  const ENDPOINT_HEALTH_SURFACES_9 = [
    {
      surface_id: "sn-1-example-rpc",
      status: "ok",
      classification: "live",
      latency_ms: 80,
      verified_at: "2026-07-24T00:00:00Z",
      archive_support: true,
      latest_block: 8600000,
    },
    {
      surface_id: "sn-1-example-api",
      status: "degraded",
      classification: "transient",
      latency_ms: 900,
      verified_at: "2026-07-24T00:00:00Z",
      error: "slow response",
    },
  ];

  function buildSampleEndpointArtifact9() {
    return buildEndpointResourceArtifact({
      surfaces: ENDPOINT_SURFACES_9,
      healthSurfaces: ENDPOINT_HEALTH_SURFACES_9,
      generatedAt: GENERATED_AT_9,
      contractVersion: CONTRACT_9,
      source: "artifact-build",
    });
  }

  test("endpoints: EndpointsArtifactSchema.parse(buildEndpointResourceArtifact(...)) succeeds", () => {
    const data = buildSampleEndpointArtifact9();
    const parsed = EndpointsArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.equal(parsed.endpoints.length, 2);
  });
  test("endpoints: EndpointsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = EndpointsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-endpoints: SubnetEndpointsArtifactSchema.parse(...) succeeds", () => {
    const endpointArtifact = buildSampleEndpointArtifact9();
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      netuid: 1,
      slug: "sn-1",
      name: "Apex",
      summary: endpointArtifact.summary,
      endpoints: endpointArtifact.endpoints,
    };
    const parsed = SubnetEndpointsArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-endpoints: SubnetEndpointsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetEndpointsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("endpoint-incidents: EndpointIncidentsArtifactSchema.parse(buildEndpointIncidentArtifact(...)) succeeds", () => {
    const endpointArtifact = buildSampleEndpointArtifact9();
    const data = buildEndpointIncidentArtifact({
      endpointArtifact,
      generatedAt: GENERATED_AT_9,
      contractVersion: CONTRACT_9,
    });
    const parsed = EndpointIncidentsArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.equal(parsed.incidents.length, 1);
    assert.equal(parsed.incidents[0].severity, "warning");
  });
  test("endpoint-incidents: EndpointIncidentsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = EndpointIncidentsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("endpoint-pools: EndpointPoolsArtifactSchema.parse(buildEndpointPoolArtifact(...)) succeeds", () => {
    const endpointArtifact = buildSampleEndpointArtifact9();
    const data = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT_9,
      contractVersion: CONTRACT_9,
      endpointArtifact,
    });
    const parsed = EndpointPoolsArtifactSchema.parse(data);
    assert.ok(parsed);
    assert.equal(parsed.source, "endpoint-resource-probes");
  });
  test("endpoint-pools: EndpointPoolsArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = EndpointPoolsArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  // candidates/subnet-candidates/evidence/subnet-evidence: assembled inline
  // in scripts/build-artifacts.ts with no wrapping function (candidates) or
  // an unexported one (buildEvidenceLedger) -- fixtures below are drawn
  // from real captured production responses (api.metagraph.sh, 2026-07-25),
  // not hand-typed guesses.
  const SAMPLE_CANDIDATE_9 = {
    auth_required: false,
    confidence: "medium",
    confirmed_by: ["backprop.finance"],
    id: "sn-0-backprop-dashboard",
    kind: "dashboard",
    name: "root Backprop Finance dashboard",
    netuid: 0,
    provider: "backprop-finance",
    public_safe: true,
    rate_limit_notes:
      "Candidate only; no recurring probe is configured until maintainer review.",
    review_notes:
      "Universal Backprop Finance dTAO subnet dashboard candidate. Third-party enrichment, not protocol authority.",
    schema_version: 1,
    source_tier: "third-party-index",
    source_type: "backprop-dashboard",
    source_url: "https://backprop.finance/dtao/subnets/0-root",
    source_urls: ["https://backprop.finance/dtao/subnets/0-root"],
    state: "schema-valid",
    subnet_name: "root",
    superseded_by: "sn-0-backprop-dashboard",
    url: "https://backprop.finance/dtao/subnets/0-root",
    verification: null,
  };

  test("candidates: CandidatesArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      generated_at: GENERATED_AT_9,
      notes:
        "Unverified candidate surfaces from public source discovery and community intake. Candidates are not verified registry surfaces.",
      candidates: [SAMPLE_CANDIDATE_9],
    };
    const parsed = CandidatesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("candidates: CandidatesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = CandidatesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-candidates: SubnetCandidatesArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      netuid: 0,
      slug: "sn-0",
      name: "root",
      candidates: [SAMPLE_CANDIDATE_9],
    };
    const parsed = SubnetCandidatesArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-candidates: SubnetCandidatesArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetCandidatesArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  const SAMPLE_CLAIMS_9 = [
    {
      claim: "SN0 is an active root netuid on Finney.",
      confidence: "high",
      limits:
        "Native chain state is canonical for active existence only; off-chain interfaces come from overlays and candidates.",
      source_tier: "native-chain",
      source_type: "bittensor-sdk",
      source_url: "registry/native/finney-subnets.json",
      subject: "subnet:0",
      support_summary: "Captured from native snapshot at block 8404076.",
      verified_at: "2026-06-14T09:03:28Z",
    },
    {
      claim: "Allways API health is a public subnet-api surface for SN7.",
      confidence: "medium",
      limits:
        "Surface was recorded as public-safe; availability is tracked by health probes.",
      source_tier: "community-docs",
      source_type: "provider-claimed",
      source_url: "https://api.all-ways.io/health",
      subject: "surface:allways-api-health",
      support_summary: "Listed in curated overlay for allways.",
      verified_at: null,
    },
  ];

  test("evidence: EvidenceLedgerArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      notes:
        "Evidence ledger uses public source URLs and generated registry provenance only. Candidate entries are capped to keep the public artifact compact.",
      summary: {
        candidate_claim_count: 0,
        claim_count: SAMPLE_CLAIMS_9.length,
        subnet_claim_count: 1,
        surface_claim_count: 1,
      },
      claims: SAMPLE_CLAIMS_9,
    };
    const parsed = EvidenceLedgerArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("evidence: EvidenceLedgerArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = EvidenceLedgerArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("subnet-evidence: SubnetEvidenceArtifactSchema.parse(...) succeeds", () => {
    const data = {
      schema_version: 1,
      contract_version: CONTRACT_9,
      generated_at: GENERATED_AT_9,
      netuid: 7,
      slug: "sn-7",
      name: "Allways",
      claims: [SAMPLE_CLAIMS_9[1]],
    };
    const parsed = SubnetEvidenceArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("subnet-evidence: SubnetEvidenceArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = SubnetEvidenceArtifactSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

// #8827: schemas/components/04-surfaces.schema.json's hand-edited
// AgentReadinessStatus (additionalProperties: false, no readiness_verified)
// used to shadow this Zod-owned copy in the merged component bundle -- the
// hand-edited key is deleted now, but this guards the field the deleted copy
// would have rejected, and that the carried-over description still ships.
describe("agent-readiness-status: hand-edited copy no longer shadows the Zod owner (#8827)", () => {
  test("AgentReadinessStatusSchema.parse(...) accepts readiness_verified", () => {
    const parsed = AgentReadinessStatusSchema.parse({
      status: "callable",
      blocker_level: "none",
      blockers: [],
      missing_fields: [],
      readiness_verified: true,
    });
    assert.equal(parsed.readiness_verified, true);
  });

  test("emitted AgentReadinessStatus OpenAPI component carries a non-empty description", () => {
    const components = generateOpenApiZodComponents();
    const description = (
      components.AgentReadinessStatus as { description?: string }
    ).description;
    assert.equal(
      description,
      "Agent-facing readiness status and blocker taxonomy for one subnet.",
    );
  });
});
