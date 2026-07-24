// Handler tests for GET /api/v1/subnets/{netuid}/idle-stake and
// GET /api/v1/chain/idle-stake (#6789) — kept in a dedicated file so this PR
// does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.mjs harness (mirrors chain-performance-
// handler.test.mjs's own precedent).

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  handleChainIdleStake,
  handleSubnetIdleStake,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { mockEnv, type Row } from "./row-type.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const NETUID = 7;
const ctx = { waitUntil: (promise: Promise<unknown>) => promise };

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res: Response): Promise<Row> {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res: Response): Promise<Row> {
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, false);
  return body;
}

function emptyEnv() {
  return mockEnv();
}

async function assertValidComponent(componentName: string, data: unknown) {
  const generatedAt = "2026-06-24T12:00:00.000Z";
  const openapi = buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  ) as Row;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $id: `https://metagraph.sh/test/${componentName}.json`,
    components: openapi.components,
    $ref: `#/components/schemas/${componentName}`,
  });
  assert.equal(validate(data), true, ajv.errorsText(validate.errors));
}

describe("handleSubnetIdleStake", () => {
  test("rejects an unsupported query param with 400", async () => {
    await errorJson(
      await handleSubnetIdleStake(
        req(`/api/v1/subnets/${NETUID}/idle-stake?window=7d`),
        emptyEnv(),
        NETUID,
        url(`/api/v1/subnets/${NETUID}/idle-stake?window=7d`),
      ),
    );
  });

  test("returns a schema-stable zero scorecard on cold D1", async () => {
    const body = await json(
      await handleSubnetIdleStake(
        req(`/api/v1/subnets/${NETUID}/idle-stake`),
        emptyEnv(),
        NETUID,
        url(`/api/v1/subnets/${NETUID}/idle-stake`),
      ),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.captured_at, null);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.idle_neuron_count, 0);
    assert.equal(body.data.idle_stake_tao, 0);
    await assertValidComponent("SubnetIdleStakeArtifact", body.data);
  });
});

describe("handleChainIdleStake", () => {
  test("rejects an unsupported query param with 400", async () => {
    await errorJson(
      await handleChainIdleStake(
        req("/api/v1/chain/idle-stake?window=7d"),
        emptyEnv(),
        url("/api/v1/chain/idle-stake?window=7d"),
      ),
    );
  });

  test("returns a schema-stable empty ranking on cold D1", async () => {
    const body = await json(
      await handleChainIdleStake(
        req("/api/v1/chain/idle-stake"),
        emptyEnv(),
        url("/api/v1/chain/idle-stake"),
      ),
    );
    assert.equal(body.data.captured_at, null);
    assert.equal(body.data.subnet_count, 0);
    assert.equal(body.data.total_idle_stake_tao, 0);
    assert.deepEqual(body.data.subnets, []);
    await assertValidComponent("ChainIdleStakeArtifact", body.data);
  });
});

describe("workers/api.mjs dispatch", () => {
  test("GET /api/v1/subnets/{netuid}/idle-stake reaches handleSubnetIdleStake via SUBNET_IDLE_STAKE_PATH_PATTERN", async () => {
    const res = await handleRequest(
      req(`/api/v1/subnets/${NETUID}/idle-stake`),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    const body = await json(res);
    assert.equal(body.data.netuid, NETUID);
  });

  test("GET /api/v1/chain/idle-stake reaches handleChainIdleStake", async () => {
    const res = await handleRequest(
      req("/api/v1/chain/idle-stake"),
      createLocalArtifactEnv() as unknown as Env,
      ctx,
    );
    const body = await json(res);
    assert.equal(body.data.subnet_count, 0);
  });
});
