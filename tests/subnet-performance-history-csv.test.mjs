// CSV export tests for GET /api/v1/subnets/{netuid}/performance/history — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalSubnetPerformanceHistoryCachePath,
  handleSubnetPerformanceHistory,
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

describe("subnet performance history OpenAPI CSV contract", () => {
  test("documents the CSV header on the performance/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    );
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/performance/history"].get
        .responses["200"].content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(
      csvContent.example.split("\r\n")[0],
      "snapshot_date,neuron_count,validator_count,active_count,incentive_gini,incentive_nakamoto_coefficient,incentive_top_10pct_share,dividends_gini,dividends_nakamoto_coefficient,dividends_top_10pct_share,trust_mean,trust_median,consensus_mean,consensus_median,validator_trust_mean,validator_trust_median",
    );
  });
});

describe("handleSubnetPerformanceHistory CSV export", () => {
  test("returns CSV response when ?format=csv is present", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-27",
        incentive: 0.9,
        dividends: 0.9,
        trust: 0.8,
        consensus: 0.7,
        validator_trust: 0.85,
        validator_permit: 1,
        active: 1,
      },
      {
        snapshot_date: "2026-06-27",
        incentive: 0.05,
        dividends: 0,
        trust: 0.2,
        consensus: 0.1,
        validator_trust: 0,
        validator_permit: 0,
        active: 1,
      },
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ]);
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="subnet-7-performance-history.csv"'),
    );
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,validator_count,active_count,incentive_gini,incentive_nakamoto_coefficient,incentive_top_10pct_share,dividends_gini,dividends_nakamoto_coefficient,dividends_top_10pct_share,trust_mean,trust_median,consensus_mean,consensus_median,validator_trust_mean,validator_trust_median",
    );
    assert.equal(
      lines[1],
      "2026-06-26,1,1,1,0,1,1,0,1,1,0.5,0.5,0.5,0.5,0.5,0.5",
    );
    assert.equal(
      lines[2],
      "2026-06-27,2,1,2,0.447368,1,0.947368,0,1,1,0.5,0.5,0.4,0.4,0.85,0.85",
    );
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/performance/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetPerformanceHistory(
      request,
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[1],
      "2026-06-26,1,1,1,0,1,1,0,1,1,0.5,0.5,0.5,0.5,0.5,0.5",
    );
  });

  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      {},
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,neuron_count,validator_count,active_count,incentive_gini,incentive_nakamoto_coefficient,incentive_top_10pct_share,dividends_gini,dividends_nakamoto_coefficient,dividends_top_10pct_share,trust_mean,trust_median,consensus_mean,consensus_median,validator_trust_mean,validator_trust_median",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      {},
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=30d&format=pdf`,
      ),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      {},
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("returns the JSON envelope when CSV is not requested", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ]);
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/performance/history?window=7d`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.point_count, 1);
    assert.equal(body.data.points[0].trust_mean, 0.5);
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = neuronDailyEnv([
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ]);
    const request = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/performance/history`,
      { headers: { accept: "text/csv" } },
    );
    const res = await handleSubnetPerformanceHistory(
      request,
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=7d&format=json`,
      ),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.point_count, 1);
  });
});

describe("canonicalSubnetPerformanceHistoryCachePath", () => {
  test("default window stays canonical for JSON", () => {
    assert.equal(
      canonicalSubnetPerformanceHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/performance/history`),
      ),
      `/api/v1/subnets/${NETUID}/performance/history?window=30d`,
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalSubnetPerformanceHistoryCachePath(
      url(`/api/v1/subnets/${NETUID}/performance/history?window=7d&format=csv`),
    );
    assert.equal(
      csv,
      `/api/v1/subnets/${NETUID}/performance/history?window=7d&format=csv`,
    );

    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/performance/history`,
      { headers: { accept: "text/csv" } },
    );
    const json = canonicalSubnetPerformanceHistoryCachePath(
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=7d&format=json`,
      ),
      csvAccept,
    );
    assert.equal(
      json,
      `/api/v1/subnets/${NETUID}/performance/history?window=7d`,
    );
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request(
      `https://api.metagraph.sh/api/v1/subnets/${NETUID}/performance/history`,
      { headers: { accept: "text/csv" } },
    );
    assert.equal(
      canonicalSubnetPerformanceHistoryCachePath(
        url(`/api/v1/subnets/${NETUID}/performance/history?window=90d`),
        csvAccept,
      ),
      `/api/v1/subnets/${NETUID}/performance/history?window=90d&format=csv`,
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = `/api/v1/subnets/${NETUID}/performance/history?bogus=1`;
    assert.equal(canonicalSubnetPerformanceHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid format", () => {
    const raw = `/api/v1/subnets/${NETUID}/performance/history?format=pdf`;
    assert.equal(canonicalSubnetPerformanceHistoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window", () => {
    const raw = `/api/v1/subnets/${NETUID}/performance/history?window=1y`;
    assert.equal(canonicalSubnetPerformanceHistoryCachePath(url(raw)), raw);
  });
});
