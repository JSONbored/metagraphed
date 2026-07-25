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
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { SubnetsResponseSchema } from "../schemas-src/routes/subnets.ts";
import { SubnetDetailResponseSchema } from "../schemas-src/routes/subnet-detail.ts";
import { HealthResponseSchema } from "../schemas-src/routes/health.ts";
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
    const data = buildAccountsList([row]);
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
    const data = buildAccountPortfolio([row], "5Hk");
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
      ],
    };
    const parsed = ChainEventsFeedArtifactSchema.parse(data);
    assert.ok(parsed);
  });
  test("chain-events: ArtifactSchema.parse({}) fails (not a vacuous passthrough)", () => {
    const result = ChainEventsFeedArtifactSchema.safeParse({});
    assert.equal(result.success, false);
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
