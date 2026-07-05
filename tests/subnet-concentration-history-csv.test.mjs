// CSV export tests for GET /api/v1/subnets/{netuid}/concentration/history — kept in
// a dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalSubnetConcentrationHistoryCachePath,
  handleSubnetConcentrationHistory,
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

describe("subnet concentration history OpenAPI CSV contract", () => {
  test("documents the CSV header on the concentration/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    );
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/concentration/history"].get
        .responses["200"].content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(
      csvContent.example.split("\r\n")[0],
      "snapshot_date,neuron_count,stake_gini,stake_nakamoto_coefficient,stake_top_10pct_share,emission_gini,emission_nakamoto_coefficient,emission_top_10pct_share",
    );
  });
});

describe("handleSubnetConcentrationHistory CSV export", () => {
  test("returns CSV response when ?format=csv is present", async () => {
    const env = neuronDailyEnv([
      { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
      { snapshot_date: "2026-06-27", stake_tao: 1, emission_tao: 1 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
    ]);
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="subnet-7-concentration-history.csv"'),
    );
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,stake_gini,stake_nakamoto_coefficient,stake_top_10pct_share,emission_gini,emission_nakamoto_coefficient,emission_top_10pct_share",
    );
    assert.equal(lines[1], "2026-06-26,2,0,2,0.5,0,2,0.5");
    assert.equal(
      lines[2],
      "2026-06-27,2,0.490099,1,0.990099,0.409091,1,0.909091",
    );
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = neuronDailyEnv([
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/concentration/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetConcentrationHistory(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[1], "2026-06-26,2,0,2,0.5,0,2,0.5");
  });

  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      {},
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,stake_gini,stake_nakamoto_coefficient,stake_top_10pct_share,emission_gini,emission_nakamoto_coefficient,emission_top_10pct_share",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      {},
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=30d&format=pdf`,
      ),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("returns the JSON envelope when CSV is not requested", async () => {
    const env = neuronDailyEnv([
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
    ]);
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/concentration/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.point_count, 1);
    assert.equal(body.data.points[0].snapshot_date, "2026-06-26");
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = neuronDailyEnv([
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/concentration/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetConcentrationHistory(
      request,
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=7d&format=json`,
      ),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.point_count, 1);
  });
});

describe("canonicalSubnetConcentrationHistoryCachePath", () => {
  test("default window stays canonical for JSON", () => {
    assert.equal(
      canonicalSubnetConcentrationHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/concentration/history`),
      ),
      `/api/v1/subnets/${NETUID}/concentration/history?window=30d`,
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalSubnetConcentrationHistoryCachePath(
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=7d&format=csv`,
      ),
    );
    assert.equal(
      csv,
      `/api/v1/subnets/${NETUID}/concentration/history?window=7d&format=csv`,
    );

    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/concentration/history`,
      { headers: { accept: "text/csv" } },
    );
    const json = canonicalSubnetConcentrationHistoryCachePath(
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=7d&format=json`,
      ),
      csvAccept,
    );
    assert.equal(
      json,
      `/api/v1/subnets/${NETUID}/concentration/history?window=7d`,
    );
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/concentration/history`,
      { headers: { accept: "text/csv" } },
    );
    assert.equal(
      canonicalSubnetConcentrationHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/concentration/history?window=90d`),
        csvAccept,
      ),
      `/api/v1/subnets/${NETUID}/concentration/history?window=90d&format=csv`,
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = `/api/v1/subnets/${NETUID}/concentration/history?bogus=1`;
    assert.equal(canonicalSubnetConcentrationHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid format", () => {
    const raw = `/api/v1/subnets/${NETUID}/concentration/history?format=pdf`;
    assert.equal(canonicalSubnetConcentrationHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window", () => {
    const raw = `/api/v1/subnets/${NETUID}/concentration/history?window=1y`;
    assert.equal(canonicalSubnetConcentrationHistoryCachePath(url(raw)), raw);
  });
});
