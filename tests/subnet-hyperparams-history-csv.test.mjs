// CSV export tests for GET /api/v1/subnets/{netuid}/hyperparameters/history —
// kept in a dedicated file so this PR does not contend with open entity-handler
// PRs on the shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import { handleSubnetHyperparamsHistory } from "../workers/request-handlers/entities.mjs";

const NETUID = 7;
const CSV_HEADER = "block_number,observed_at,hyperparameters,hyperparams_hash";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function errorJson(res) {
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

describe("subnet hyperparameters history OpenAPI CSV contract", () => {
  test("documents the CSV header on the hyperparameters/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    );
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/hyperparameters/history"].get
        .responses["200"].content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(csvContent.example.split("\r\n")[0], CSV_HEADER);
  });
});

describe("handleSubnetHyperparamsHistory CSV export", () => {
  test("returns header-only CSV when Postgres is unconfigured", async () => {
    const res = await handleSubnetHyperparamsHistory(
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters/history?format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], CSV_HEADER);
    assert.equal(lines.length, 1);
  });

  test("exports paginated entries via the Postgres tier, hyperparameters serialized as one JSON cell", async () => {
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            netuid: NETUID,
            entry_count: 1,
            limit: 50,
            offset: 0,
            next_cursor: null,
            entries: [
              {
                block_number: 100,
                observed_at: "2026-06-21T00:00:00.000Z",
                hyperparameters: { tempo: 360 },
                hyperparams_hash: "abc",
              },
            ],
          }),
      },
    };
    const res = await handleSubnetHyperparamsHistory(
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/hyperparameters/history?limit=50&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], CSV_HEADER);
    assert.equal(
      lines[1],
      `100,2026-06-21T00:00:00.000Z,"{""tempo"":360}",abc`,
    );
    assert.equal(lines.length, 2);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetHyperparamsHistory(
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters/history?format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetHyperparamsHistory(
      req(`/api/v1/subnets/${NETUID}/hyperparameters/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/hyperparameters/history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });
});
