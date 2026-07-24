// Handler tests for GET /api/v1/accounts/{ss58}/entities (#6740) -- kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on
// the shared request-handlers-entities.test.mjs harness (mirrors
// chain-performance-handler.test.mjs's own precedent).

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  handleAccount,
  handleAccountEntities,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string): Request {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function json(res: Response): Promise<Row> {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, true);
  return body;
}

async function assertValidComponent(
  componentName: string,
  data: unknown,
): Promise<void> {
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

function entitiesArchiveEnv(entities: Row[]): Row {
  return {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (!key.endsWith("entities.json")) return null;
        return {
          async json() {
            return { schema_version: 1, generated_at: null, entities };
          },
        };
      },
    },
  };
}

describe("handleAccountEntities", () => {
  test("returns a schema-stable empty result on cold D1/R2", async () => {
    const body = await json(
      await handleAccountEntities(
        req(`/api/v1/accounts/${SS58}/entities`),
        {} as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.ss58, SS58);
    assert.deepEqual(body.data.labels, []);
    assert.equal(body.data.ownership_tie_count, 0);
    assert.deepEqual(body.data.ownership_ties, []);
    await assertValidComponent("AccountEntitiesArtifact", body.data);
  });

  test("joins a populated entities.json artifact's labels for this ss58", async () => {
    const env = entitiesArchiveEnv([
      {
        schema_version: 1,
        ss58: SS58,
        name: "Example Foundation",
        category: "foundation",
        source_urls: ["https://example.org/proof"],
        review: { state: "maintainer-reviewed" },
      },
    ]);
    const body = await json(
      await handleAccountEntities(
        req(`/api/v1/accounts/${SS58}/entities`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.labels.length, 1);
    assert.equal(body.data.labels[0].name, "Example Foundation");
  });

  test("a successful DATA_API response wins over the schema-stable cold fallback", async () => {
    const env = {
      METAGRAPH_SUBNET_OWNERSHIP_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            ownership_tie_count: 1,
            ownership_ties: [
              { netuid: 7, role: "gained_ownership", block_number: 100 },
            ],
          }),
      },
    };
    const body = await json(
      await handleAccountEntities(
        req(`/api/v1/accounts/${SS58}/entities`),
        env as unknown as Env,
        SS58,
      ),
    );
    assert.equal(body.data.ownership_tie_count, 1);
    assert.equal(body.data.ownership_ties[0].netuid, 7);
    // labels still joined locally regardless of which source served ties.
    assert.deepEqual(body.data.labels, []);
  });
});

describe("handleAccount labels join", () => {
  test("joins a populated entities.json artifact's labels for this ss58", async () => {
    const env = entitiesArchiveEnv([
      {
        schema_version: 1,
        ss58: SS58,
        name: "Example Exchange",
        category: "exchange",
        source_urls: ["https://example.org/proof"],
        review: { state: "maintainer-reviewed" },
      },
    ]);
    const res = await handleAccount(
      req(`/api/v1/accounts/${SS58}`),
      env as unknown as Env,
      SS58,
    );
    const body = await json(res);
    assert.equal(body.data.labels.length, 1);
    assert.equal(body.data.labels[0].name, "Example Exchange");
  });
});

describe("workers/api.mjs dispatch", () => {
  const ctx = { waitUntil: (promise: Promise<unknown>) => promise };

  test("GET /api/v1/accounts/{ss58}/entities reaches handleAccountEntities via ACCOUNT_ENTITIES_PATH_PATTERN", async () => {
    const res = await handleRequest(
      req(`/api/v1/accounts/${SS58}/entities`),
      {} as unknown as Env,
      ctx,
    );
    const body = await json(res);
    assert.equal(body.data.ss58, SS58);
  });

  test("testnet has no variant (mainnet-only live route)", async () => {
    const res = await handleRequest(
      req(`/api/v1/testnet/accounts/${SS58}/entities`),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
