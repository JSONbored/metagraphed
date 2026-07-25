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
import { mockEnv } from "./row-type.ts";
import type { z } from "zod";

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
