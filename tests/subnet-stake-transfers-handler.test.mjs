// Handler tests for GET /api/v1/subnets/{netuid}/stake-transfers — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { STAKE_TRANSFERRED_EVENT_KIND } from "../src/subnet-stake-transfers.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalSubnetStakeTransfersCachePath,
  handleSubnetStakeTransfers,
} from "../workers/request-handlers/entities.mjs";

const NETUID = 7;
const OBSERVED_MS = 1_750_000_000_000;

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
}

function stakeTransfersEnv(row, capture = []) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            capture.push({ sql, params });
            return {
              all: async () => {
                if (
                  /COUNT\(\*\) AS transfers/.test(sql) &&
                  /COUNT\(DISTINCT coldkey\) AS distinct_senders/.test(sql) &&
                  /FROM account_events WHERE netuid = \? AND event_kind = \?/.test(
                    sql,
                  )
                ) {
                  return { results: row ? [row] : [] };
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

async function assertValidComponent(componentName, data) {
  const generatedAt = "2026-06-24T12:00:00.000Z";
  const openapi = buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile({
    $id: `https://metagraph.sh/test/${componentName}.json`,
    components: openapi.components,
    $ref: `#/components/schemas/${componentName}`,
  });
  assert.equal(validate(data), true, ajv.errorsText(validate.errors));
}

describe("handleSubnetStakeTransfers happy path", () => {
  test("computes distinct senders, transfer count, and transfers-per-sender over 7d", async () => {
    const capture = [];
    const env = stakeTransfersEnv(
      {
        transfers: 40,
        distinct_senders: 4,
        newest_observed: OBSERVED_MS,
      },
      capture,
    );
    const body = await json(
      await handleSubnetStakeTransfers(
        req(`/api/v1/subnets/${NETUID}/stake-transfers`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-transfers?window=7d`),
      ),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.distinct_senders, 4);
    assert.equal(body.data.transfers, 40);
    assert.equal(body.data.transfers_per_sender, 10);
    assert.equal(body.data.observed_at, new Date(OBSERVED_MS).toISOString());
    assert.equal(body.meta.source, "chain-events");
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/subnets/${NETUID}/stake-transfers.json`,
    );
    assert.equal(body.meta.generated_at, new Date(OBSERVED_MS).toISOString());
    await assertValidComponent("SubnetStakeTransfersArtifact", body.data);
    const captured = capture[0];
    assert.ok(captured);
    assert.equal(captured.params[0], NETUID);
    assert.equal(captured.params[1], STAKE_TRANSFERRED_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number");
  });

  test("defaults to the 7d window when ?window is omitted", async () => {
    const body = await json(
      await handleSubnetStakeTransfers(
        req(`/api/v1/subnets/${NETUID}/stake-transfers`),
        stakeTransfersEnv({
          transfers: 10,
          distinct_senders: 2,
          newest_observed: OBSERVED_MS,
        }),
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-transfers`),
      ),
    );
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.transfers, 10);
    assert.equal(body.data.transfers_per_sender, 5);
  });

  test("honours an explicit 30d window", async () => {
    const body = await json(
      await handleSubnetStakeTransfers(
        req(`/api/v1/subnets/${NETUID}/stake-transfers`),
        stakeTransfersEnv({
          transfers: 15,
          distinct_senders: 3,
          newest_observed: OBSERVED_MS,
        }),
        NETUID,
        url(`/api/v1/subnets/${NETUID}/stake-transfers?window=30d`),
      ),
    );
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.transfers, 15);
    assert.equal(body.data.transfers_per_sender, 5);
  });
});

describe("canonicalSubnetStakeTransfersCachePath", () => {
  test("maps a 30d window to a distinct cache key", () => {
    assert.equal(
      canonicalSubnetStakeTransfersCachePath(
        url(`/api/v1/subnets/${NETUID}/stake-transfers?window=30d`),
      ),
      `/api/v1/subnets/${NETUID}/stake-transfers?window=30d`,
    );
  });
});
