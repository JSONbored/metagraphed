// CSV export tests for GET /api/v1/subnets/{netuid}/yield — kept in a dedicated
// file so this PR does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  canonicalSubnetYieldCachePath,
  handleSubnetYield,
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

describe("subnet yield OpenAPI CSV contract", () => {
  test("documents the CSV header on the yield route", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    ) as Row;
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
  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      {} as unknown as Env,
      String(NETUID),
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
      {} as unknown as Env,
      String(NETUID),
      url(`/api/v1/subnets/${NETUID}/yield?format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetYield(
      req(`/api/v1/subnets/${NETUID}/yield`),
      {} as unknown as Env,
      String(NETUID),
      url(`/api/v1/subnets/${NETUID}/yield?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
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
      csvAccept as unknown as Parameters<
        typeof canonicalSubnetYieldCachePath
      >[1],
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
        csvAccept as unknown as Parameters<
          typeof canonicalSubnetYieldCachePath
        >[1],
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
