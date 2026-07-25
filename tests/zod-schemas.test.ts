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
