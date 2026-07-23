// CSV export tests for GET /api/v1/subnets/{netuid}/concentration/history — kept in
// a dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
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
                stake_gini: 0.4,
                stake_nakamoto_coefficient: 2,
                stake_top_10pct_share: 0.5,
                emission_gini: 0.3,
                emission_nakamoto_coefficient: 3,
                emission_top_10pct_share: 0.4,
              },
              {
                snapshot_date: "2026-06-20",
                neuron_count: 4,
                stake_gini: 0.35,
                stake_nakamoto_coefficient: 2,
                stake_top_10pct_share: 0.45,
                emission_gini: 0.25,
                emission_nakamoto_coefficient: 3,
                emission_top_10pct_share: 0.35,
              },
            ],
          }),
      },
    };
    const res = await handleSubnetConcentrationHistory(
      req(`/api/v1/subnets/${NETUID}/concentration/history`),
      env,
      NETUID,
      url(
        `/api/v1/subnets/${NETUID}/concentration/history?window=30d&format=csv`,
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
