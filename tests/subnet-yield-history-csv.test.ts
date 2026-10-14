// CSV export tests for GET /api/v1/subnets/{netuid}/yield/history — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.ts harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import { openApiExampleValue } from "./openapi-example-value.ts";
import {
  canonicalSubnetYieldHistoryCachePath,
  handleSubnetYieldHistory,
} from "../workers/request-handlers/entities.ts";
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
      openApiExampleValue(openapi, csvContent).split("\r\n")[0],
      "snapshot_date,neuron_count,validator_count,yield_count,subnet_yield,mean_yield,median_yield,p25_yield,p75_yield,p90_yield",
    );
  });
});

describe("handleSubnetYieldHistory CSV export", () => {
  test("returns header-only CSV when the store is cold", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {} as unknown as Env,
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

  test("exports dated counts ascending with unknown rates blank and JSON parity", async () => {
    const payload = {
      schema_version: 2,
      netuid: NETUID,
      window: "30d",
      point_count: 2,
      degraded: { reason: "holdings_unqualified" },
      points: [
        {
          snapshot_date: "2026-06-21",
          neuron_count: 5,
          validator_count: 2,
          yield_count: 0,
          subnet_yield: null,
          mean_yield: null,
          median_yield: null,
          p25_yield: null,
          p75_yield: null,
          p90_yield: null,
        },
        {
          snapshot_date: "2026-06-20",
          neuron_count: 4,
          validator_count: 2,
          yield_count: 0,
          subnet_yield: null,
          mean_yield: null,
          median_yield: null,
          p25_yield: null,
          p75_yield: null,
          p90_yield: null,
        },
      ],
    };
    const env = {
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: { fetch: async () => Response.json(payload) },
    };
    const path = `/api/v1/subnets/${NETUID}/yield/history`;
    const jsonRes = await handleSubnetYieldHistory(
      req(path),
      env as unknown as Env,
      NETUID,
      url(`${path}?window=30d&format=json`),
    );
    assert.equal(jsonRes.status, 200);
    const json = (await jsonRes.json()) as Row;
    assert.deepEqual(json.data, payload);

    const res = await handleSubnetYieldHistory(
      req(path),
      env as unknown as Env,
      NETUID,
      url(`${path}?window=30d&format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 3);
    // Observed counts stay numeric; unavailable rates stay blank rather than zero.
    assert.equal(lines[1], "2026-06-20,4,2,0,,,,,,");
    assert.equal(lines[2], "2026-06-21,5,2,0,,,,,,");
    const fields = lines[0].split(",");
    const orderedPoints = [...json.data.points].sort((a: Row, b: Row) =>
      a.snapshot_date.localeCompare(b.snapshot_date),
    );
    for (const [index, point] of orderedPoints.entries()) {
      assert.deepEqual(
        lines[index + 1].split(","),
        fields.map((field: string) =>
          point[field] == null ? "" : String(point[field]),
        ),
      );
    }
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {} as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/yield/history?window=30d&format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetYieldHistory(
      req(`/api/v1/subnets/${NETUID}/yield/history`),
      {} as unknown as Env,
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
