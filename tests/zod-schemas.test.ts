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
