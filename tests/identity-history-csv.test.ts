// CSV export tests for the two identity-history feeds —
// GET /api/v1/subnets/{netuid}/identity-history and
// GET /api/v1/accounts/{ss58}/identity-history. Kept in a dedicated file so this
// PR does not contend with open entity-handler PRs on the shared
// request-handlers-entities.test.mjs harness, mirroring
// subnet-hyperparams-history-csv.test.mjs.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  handleSubnetIdentityHistory,
  handleAccountIdentityHistory,
} from "../workers/request-handlers/entities.ts";
import type { Row } from "./row-type.ts";

const NETUID = 7;
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const SUBNET_CSV_HEADER =
  "block_number,observed_at,subnet_name,symbol,description,github_repo,subnet_url,discord,logo_url,identity_hash";
const ACCOUNT_CSV_HEADER =
  "observed_at,name,url,github,image,discord,description,additional,identity_hash";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

function postgresEnv(flag: string, body: Row) {
  return {
    [flag]: "postgres",
    DATA_API: { fetch: async () => Response.json(body) },
  };
}

async function errorJson(res: Response) {
  assert.equal(res.status, 400);
  const body = (await res.json()) as Row;
  assert.equal(body.ok, false);
  return body;
}

describe("identity-history OpenAPI CSV contract", () => {
  test("documents the CSV header on both identity-history routes", async () => {
    const openapi = buildOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
      await loadOpenApiComponentSchemas(),
    ) as Row;
    const subnetCsv =
      openapi.paths["/api/v1/subnets/{netuid}/identity-history"].get.responses[
        "200"
      ].content["text/csv"];
    assert.equal(subnetCsv.schema.type, "string");
    assert.equal(subnetCsv.example.split("\r\n")[0], SUBNET_CSV_HEADER);

    const accountCsv =
      openapi.paths["/api/v1/accounts/{ss58}/identity-history"].get.responses[
        "200"
      ].content["text/csv"];
    assert.equal(accountCsv.schema.type, "string");
    assert.equal(accountCsv.example.split("\r\n")[0], ACCOUNT_CSV_HEADER);
  });
});

describe("handleSubnetIdentityHistory CSV export", () => {
  test("returns header-only CSV on cold D1", async () => {
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      {} as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history?format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], SUBNET_CSV_HEADER);
    assert.equal(lines.length, 1);
  });

  test("exports the paginated timeline via the Postgres tier", async () => {
    const env = postgresEnv("METAGRAPH_SUBNET_IDENTITY_SOURCE", {
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
          subnet_name: "MIAO",
          symbol: "α",
          description: "old",
          github_repo: null,
          subnet_url: null,
          discord: null,
          logo_url: null,
          identity_hash: "abc",
        },
      ],
    });
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      env as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history?limit=50&format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], SUBNET_CSV_HEADER);
    assert.equal(lines[1], "100,2026-06-21T00:00:00.000Z,MIAO,α,old,,,,,abc");
    assert.equal(lines.length, 2);
  });

  test("keeps the JSON envelope when no CSV is requested", async () => {
    const env = postgresEnv("METAGRAPH_SUBNET_IDENTITY_SOURCE", {
      schema_version: 1,
      netuid: NETUID,
      entry_count: 0,
      limit: 50,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      env as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history`),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, NETUID);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      {} as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history?format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleSubnetIdentityHistory(
      req(`/api/v1/subnets/${NETUID}/identity-history`),
      {} as unknown as Env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/identity-history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });
});

describe("handleAccountIdentityHistory CSV export", () => {
  test("returns header-only CSV on cold D1", async () => {
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      {} as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history?format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(lines[0], ACCOUNT_CSV_HEADER);
    assert.equal(lines.length, 1);
  });

  test("exports the paginated timeline via the Postgres tier", async () => {
    const env = postgresEnv("METAGRAPH_ACCOUNT_IDENTITY_SOURCE", {
      schema_version: 1,
      account: SS58,
      entry_count: 1,
      limit: 50,
      offset: 0,
      next_cursor: null,
      entries: [
        {
          observed_at: "2026-06-21T00:00:00.000Z",
          name: "Alice",
          url: "https://alice.example",
          github: "https://github.com/alice",
          image: null,
          discord: null,
          description: "hi",
          additional: null,
          identity_hash: "abc",
        },
      ],
    });
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      env as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history?limit=50&format=csv`),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], ACCOUNT_CSV_HEADER);
    assert.equal(
      lines[1],
      "2026-06-21T00:00:00.000Z,Alice,https://alice.example,https://github.com/alice,,,hi,,abc",
    );
    assert.equal(lines.length, 2);
  });

  test("keeps the JSON envelope when no CSV is requested", async () => {
    const env = postgresEnv("METAGRAPH_ACCOUNT_IDENTITY_SOURCE", {
      schema_version: 1,
      account: SS58,
      entry_count: 0,
      limit: 50,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      env as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history`),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal(body.data.account, SS58);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      {} as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history?format=pdf`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleAccountIdentityHistory(
      req(`/api/v1/accounts/${SS58}/identity-history`),
      {} as unknown as Env,
      SS58,
      url(`/api/v1/accounts/${SS58}/identity-history?format=`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "format");
  });
});
