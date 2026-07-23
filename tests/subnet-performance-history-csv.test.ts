// CSV export tests for GET /api/v1/subnets/{netuid}/performance/history — kept in
// a dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  canonicalSubnetPerformanceHistoryCachePath,
  handleSubnetPerformanceHistory,
} from "../workers/request-handlers/entities.ts";
import type { Row } from "./row-type.ts";

const NETUID = 7;
const CSV_HEADER =
  "snapshot_date,neuron_count,validator_count,active_count,incentive_gini,incentive_nakamoto_coefficient,incentive_top_10pct_share,dividends_gini,dividends_nakamoto_coefficient,dividends_top_10pct_share,trust_mean,trust_median,consensus_mean,consensus_median,validator_trust_mean,validator_trust_median";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function errorJson(res: Response) {
  assert.equal(res.status, 400);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, false);
  return body;
}

describe("subnet performance history OpenAPI CSV contract", () => {
  test("documents the CSV header on the performance/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    ) as Row;
    const csvContent =
      openapi.paths["/api/v1/subnets/{netuid}/performance/history"].get
        .responses["200"].content["text/csv"];
    assert.equal(csvContent.schema.type, "string");
    assert.equal(csvContent.example.split("\r\n")[0], CSV_HEADER);
  });
});

describe("handleSubnetPerformanceHistory CSV export", () => {
  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      {} as unknown as Env,
      String(NETUID),
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], CSV_HEADER);
    assert.equal(lines.length, 1);
  });

  test("sorts and exports real points ascending by snapshot_date via the Postgres tier", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            netuid: NETUID,
            window: "30d",
            points: [
              {
                snapshot_date: "2026-06-21",
                neuron_count: 5,
                validator_count: 2,
                active_count: 5,
                incentive_gini: 0.4,
                incentive_nakamoto_coefficient: 2,
                incentive_top_10pct_share: 0.5,
                dividends_gini: 0.3,
                dividends_nakamoto_coefficient: 1,
                dividends_top_10pct_share: 0.6,
                trust_mean: 0.5,
                trust_median: 0.5,
                consensus_mean: 0.4,
                consensus_median: 0.4,
                validator_trust_mean: 0.6,
                validator_trust_median: 0.6,
              },
              {
                snapshot_date: "2026-06-20",
                neuron_count: 4,
                validator_count: 2,
                active_count: 4,
                incentive_gini: 0.35,
                incentive_nakamoto_coefficient: 2,
                incentive_top_10pct_share: 0.45,
                dividends_gini: 0.25,
                dividends_nakamoto_coefficient: 1,
                dividends_top_10pct_share: 0.55,
                trust_mean: 0.45,
                trust_median: 0.45,
                consensus_mean: 0.35,
                consensus_median: 0.35,
                validator_trust_mean: 0.55,
                validator_trust_median: 0.55,
              },
            ],
          }),
      },
    };
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      env as unknown as Env,
      String(NETUID),
      url(
        `/api/v1/subnets/${NETUID}/performance/history?window=30d&format=csv`,
      ),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 3);
    // CSV export re-sorts newest-first `points` into ascending snapshot_date.
    assert.match(lines[1], /^2026-06-20,/);
    assert.match(lines[2], /^2026-06-21,/);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetPerformanceHistory(
      req(`/api/v1/subnets/${NETUID}/performance/history`),
      {} as unknown as Env,
      String(NETUID),
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
      {} as unknown as Env,
      String(NETUID),
      url(`/api/v1/subnets/${NETUID}/performance/history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
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
      csvAccept as unknown as Parameters<
        typeof canonicalSubnetPerformanceHistoryCachePath
      >[1],
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
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetPerformanceHistoryCachePath
        >[1],
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
