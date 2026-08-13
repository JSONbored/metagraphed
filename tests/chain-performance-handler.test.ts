// Handler tests for GET /api/v1/chain/performance — kept in a dedicated file so
// this PR does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.ts harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import { handleChainPerformance } from "../workers/request-handlers/entities.ts";
import type { Row } from "./row-type.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function json(res: Response) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  return body;
}

function neuronsEnv(rows: Row[], capture: Row[] = []) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
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

async function assertValidComponent(componentName: string, data: Row) {
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
  test("returns schema-stable null blocks on a cold store", async () => {
    const body = await json(
      await handleChainPerformance(
        req("/api/v1/chain/performance"),
        neuronsEnv([]) as unknown as Env,
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
});
