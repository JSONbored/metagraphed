// CSV export tests for GET /api/v1/subnets/{netuid}/yield/history — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalSubnetYieldHistoryCachePath,
  handleSubnetYieldHistory,
} from "../workers/request-handlers/entities.mjs";

const NETUID = 7;

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

function neuronDailyEnv(rows) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(..._params) {
            return {
              all: async () => {
                if (/FROM neuron_daily WHERE netuid = \?/.test(sql)) {
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

describe("subnet yield history OpenAPI CSV contract", () => {
  test("documents the CSV header on the yield/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    );
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/yield/history"].get.responses[
        "200"
      ].content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(
      csvContent.example.split("\r\n")[0],
      "snapshot_date,neuron_count,validator_count,yield_count,subnet_yield,mean_yield,median_yield,p25_yield,p75_yield,p90_yield",
    );
  });
});

describe("handleSubnetYieldHistory CSV export", () => {
  test("returns CSV response when ?format=csv is present", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-27",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-27",
        stake_tao: 100,
        emission_tao: 5,
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
    ]);
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=30d&format=csv`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="subnet-7-yield-history.csv"'),
    );
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,validator_count,yield_count,subnet_yield,mean_yield,median_yield,p25_yield,p75_yield,p90_yield",
    );
    assert.equal(lines[1], "2026-06-26,1,1,1,0.1,0.1,0.1,0.1,0.1,0.1");
    assert.equal(lines[2], "2026-06-27,2,1,2,0.075,0.075,0.075,0.05,0.1,0.1");
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetYieldHistory(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[1], "2026-06-26,1,1,1,0.1,0.1,0.1,0.1,0.1,0.1");
  });

  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=30d&format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,validator_count,yield_count,subnet_yield,mean_yield,median_yield,p25_yield,p75_yield,p90_yield",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=30d&format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("returns the JSON envelope when CSV is not requested", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
    ]);
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.point_count, 1);
    assert.equal(body.data.points[0].median_yield, 0.1);
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        stake_tao: 100,
        emission_tao: 10,
        validator_permit: 1,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetYieldHistory(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d&format=json`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.point_count, 1);
  });
});

describe("canonicalSubnetYieldHistoryCachePath", () => {
  test("default window stays canonical for JSON", () => {
    assert.equal(
      canonicalSubnetYieldHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/yield/history`),
      ),
      `/api/v1/subnets/${NETUID}/yield/history?window=30d`,
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalSubnetYieldHistoryCachePath(
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d&format=csv`),
    );
    assert.equal(
      csv,
      `/api/v1/subnets/${NETUID}/yield/history?window=7d&format=csv`,
    );

    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield/history`,
      { headers: { accept: "text/csv" } },
    );
    const json = canonicalSubnetYieldHistoryCachePath(
      url(`/api/v1/subnets/${NETUID}/yield/history?window=7d&format=json`),
      csvAccept,
    );
    assert.equal(json, `/api/v1/subnets/${NETUID}/yield/history?window=7d`);
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/yield/history`,
      { headers: { accept: "text/csv" } },
    );
    assert.equal(
      canonicalSubnetYieldHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/yield/history?window=90d`),
        csvAccept,
      ),
      `/api/v1/subnets/${NETUID}/yield/history?window=90d&format=csv`,
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = `/api/v1/subnets/${NETUID}/yield/history?bogus=1`;
    assert.equal(canonicalSubnetYieldHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid format", () => {
    const raw = `/api/v1/subnets/${NETUID}/yield/history?format=pdf`;
    assert.equal(canonicalSubnetYieldHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window", () => {
    const raw = `/api/v1/subnets/${NETUID}/yield/history?window=1y`;
    assert.equal(canonicalSubnetYieldHistoryCachePath(url(raw)), raw);
  });
});
