// Handler tests for GET /api/v1/chain/performance — kept in a dedicated file so
// this PR does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { CHAIN_PERFORMANCE_READ_COLUMNS } from "../src/chain-performance.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import { handleChainPerformance } from "../workers/request-handlers/entities.mjs";

const CAPTURED_MS = 1_700_000_000_000;

const ROWS = [
  {
    incentive: 0.6,
    dividends: 0.5,
    trust: 0.9,
    consensus: 0.8,
    validator_trust: 0.95,
    active: 1,
    validator_permit: 1,
    netuid: 7,
    captured_at: CAPTURED_MS,
  },
  {
    incentive: 0.3,
    dividends: 0.1,
    trust: 0.7,
    consensus: 0.6,
    validator_trust: 0.85,
    active: 1,
    validator_permit: 1,
    netuid: 7,
    captured_at: CAPTURED_MS,
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
    captured_at: CAPTURED_MS,
  },
];

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res) {
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

function neuronsEnv(rows, capture = []) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            capture.push({ sql, params });
            return {
              all: async () => ({ results: rows }),
            };
          },
        };
      },
    },
  };
}

async function assertValidComponent(componentName, data) {
  const generatedAt = "2026-06-24T12:00:00.000Z";
  const openapi = buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $id: `https://metagraph.sh/test/${componentName}.json`,
    components: openapi.components,
    $ref: `#/components/schemas/${componentName}`,
  });
  assert.equal(validate(data), true, ajv.errorsText(validate.errors));
}

describe("handleChainPerformance happy path", () => {
  test("summarizes reward + score spread across all subnets", async () => {
    const capture = [];
    const body = await json(
      await handleChainPerformance(
        req("/api/v1/chain/performance"),
        neuronsEnv(ROWS, capture),
        url("/api/v1/chain/performance"),
      ),
    );
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.neuron_count, 3);
    assert.equal(body.data.validator_count, 2);
    assert.equal(body.data.active_count, 3);
    assert.equal(body.data.incentive.holders, 3);
    assert.equal(body.data.dividends.holders, 2);
    assert.equal(body.data.trust.count, 3);
    assert.equal(body.data.captured_at, new Date(CAPTURED_MS).toISOString());
    assert.equal(body.meta.source, "metagraph-snapshot");
    assert.equal(body.meta.artifact_path, "/metagraph/chain/performance.json");
    assert.equal(body.meta.generated_at, new Date(CAPTURED_MS).toISOString());
    await assertValidComponent("ChainPerformanceArtifact", body.data);
    const captured = capture[0];
    assert.ok(captured);
    assert.match(captured.sql, /FROM neurons/);
    assert.doesNotMatch(captured.sql, /WHERE netuid/);
    assert.equal(captured.params.length, 0);
    assert.match(captured.sql, new RegExp(CHAIN_PERFORMANCE_READ_COLUMNS));
  });

  test("returns schema-stable null blocks on cold D1", async () => {
    const body = await json(
      await handleChainPerformance(
        req("/api/v1/chain/performance"),
        neuronsEnv([]),
        url("/api/v1/chain/performance"),
      ),
    );
    assert.equal(body.data.subnet_count, 0);
    assert.equal(body.data.neuron_count, 0);
    assert.equal(body.data.captured_at, null);
    assert.equal(body.data.incentive, null);
    assert.equal(body.data.dividends, null);
    assert.equal(body.data.trust, null);
    assert.equal(body.data.consensus, null);
    assert.equal(body.data.validator_trust, null);
    await assertValidComponent("ChainPerformanceArtifact", body.data);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    await errorJson(
      await handleChainPerformance(
        req("/api/v1/chain/performance?window=7d"),
        neuronsEnv([]),
        url("/api/v1/chain/performance?window=7d"),
      ),
    );
  });
});
