// Ground-truth validation for schemas-src/ (types-epic A, #7859): each pilot
// route's Zod response schema must parse the REAL handler output, not just
// typecheck against a hand-written fixture. Drives the real dispatcher
// (handleRequest, workers/api.ts) with the same createLocalArtifactEnv()
// fixture-env pattern tests/subnet-stake-quote-api.test.ts and friends
// already use, so a schema drifting from the actual contract fails loudly
// here rather than only in production. Also asserts the converse per the
// issue's non-vacuous requirement: an empty object must fail every schema.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
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
