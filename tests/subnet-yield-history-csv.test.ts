// CSV export tests for GET /api/v1/subnets/{netuid}/yield/history — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  canonicalSubnetYieldHistoryCachePath,
  handleSubnetYieldHistory,
} from "../workers/request-handlers/entities.mjs";
import type { Row } from "./row-type.ts";

const NETUID = 7;

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

describe("subnet yield history OpenAPI CSV contract", () => {
  test("documents the CSV header on the yield/history route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    ) as Row;
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
                yield_count: 5,
                subnet_yield: 0.1,
                mean_yield: 0.1,
                median_yield: 0.1,
                p25_yield: 0.05,
                p75_yield: 0.15,
                p90_yield: 0.2,
              },
              {
                snapshot_date: "2026-06-20",
                neuron_count: 4,
                validator_count: 2,
                yield_count: 4,
                subnet_yield: 0.09,
                mean_yield: 0.09,
                median_yield: 0.09,
                p25_yield: 0.04,
                p75_yield: 0.14,
                p90_yield: 0.19,
              },
            ],
          }),
      },
    };
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=30d&format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 3);
    // CSV export re-sorts newest-first `points` into ascending snapshot_date.
    assert.match(lines[1], /^2026-06-20,/);
    assert.match(lines[2], /^2026-06-21,/);
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
      csvAccept as unknown as Parameters<
        typeof canonicalSubnetYieldHistoryCachePath
      >[1],
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
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetYieldHistoryCachePath
        >[1],
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
