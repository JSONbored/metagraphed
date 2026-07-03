// CSV export tests for GET /api/v1/subnets/{netuid}/yield — kept in a dedicated
// file so this PR does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalSubnetYieldCachePath,
  handleSubnetYield,
} from "../workers/request-handlers/entities.mjs";

const NETUID = 7;
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

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

function neuronEnv(rows) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(..._params) {
            return {
              all: async () => {
                if (/FROM neurons WHERE netuid = \?/.test(sql)) {
                  return { results: rows };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

describe("subnet yield OpenAPI CSV contract", () => {
  test("documents the CSV header on the yield route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    );
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/yield"].get.responses["200"]
        .content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(
      csvContent.example.split("\r\n")[0],
      "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    );
  });
});

describe("handleSubnetYield CSV export", () => {
  test("returns CSV response when ?format=csv is present", async () => {
    const env = neuronEnv([
      {
        uid: 1,
        hotkey: SS58,
        validator_permit: 0,
        stake_tao: 100,
        emission_tao: 5,
        captured_at: 1_750_009_000_000,
        block_number: 5_000_000,
      },
      {
        uid: 0,
        hotkey: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
        validator_permit: 1,
        stake_tao: 100,
        emission_tao: 2,
        captured_at: 1_750_009_000_000,
        block_number: 5_000_000,
      },
    ]);
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?format=csv`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="subnet-7-yield.csv"'),
    );
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(
      lines[0],
      "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    );
    assert.equal(lines[1], `1,${SS58},miner,100,5,0.05,above`);
    assert.equal(
      lines[2],
      "0,5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ,validator,100,2,0.02,below",
    );
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = neuronEnv([
      {
        uid: 0,
        hotkey: SS58,
        validator_permit: 1,
        stake_tao: 100,
        emission_tao: 2,
        captured_at: 1_750_009_000_000,
        block_number: 5_000_000,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetYield(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[1], `0,${SS58},validator,100,2,0.02,at`);
  });

  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = neuronEnv([
      {
        uid: 0,
        hotkey: SS58,
        validator_permit: 1,
        stake_tao: 100,
        emission_tao: 2,
        captured_at: 1_750_009_000_000,
        block_number: 5_000_000,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetYield(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield?format=json`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.neuron_count, 1);
  });
});

describe("canonicalSubnetYieldCachePath", () => {
  test("bare path stays canonical for JSON", () => {
    assert.equal(
      canonicalSubnetYieldCachePath(url(`/api/v1/subnets/${NETUID}/yield`)),
      `/api/v1/subnets/${NETUID}/yield`,
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalSubnetYieldCachePath(
      url(`/api/v1/subnets/${NETUID}/yield?format=csv`),
    );
    assert.equal(csv, `/api/v1/subnets/${NETUID}/yield?format=csv`);

    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield`,
      { headers: { accept: "text/csv" } },
    );
    const json = canonicalSubnetYieldCachePath(
      url(`/api/v1/subnets/${NETUID}/yield?format=json`),
      csvAccept,
    );
    assert.equal(json, `/api/v1/subnets/${NETUID}/yield`);
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield`,
      { headers: { accept: "text/csv" } },
    );
    assert.equal(
      canonicalSubnetYieldCachePath(
        url(`/api/v1/subnets/${NETUID}/yield`),
        csvAccept,
      ),
      `/api/v1/subnets/${NETUID}/yield?format=csv`,
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = `/api/v1/subnets/${NETUID}/yield?bogus=1`;
    assert.equal(canonicalSubnetYieldCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid format", () => {
    const raw = `/api/v1/subnets/${NETUID}/yield?format=pdf`;
    assert.equal(canonicalSubnetYieldCachePath(url(raw)), raw);
  });
});
