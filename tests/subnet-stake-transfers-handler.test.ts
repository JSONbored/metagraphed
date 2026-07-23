// Handler tests for GET /api/v1/subnets/{netuid}/stake-transfers — kept in a
// dedicated file so this PR does not contend with open entity-handler PRs on the
// shared request-handlers-entities.test.mjs harness.
//
// #4909 D1 retirement: the "happy path" describe block that used to live here
// exercised the D1-served account_events query directly (a capturing D1 stub +
// handleSubnetStakeTransfers). account_events' D1 write path is retired
// (#4772) and the table is dropped in production, so that query no longer
// runs at all — handleSubnetStakeTransfers now only calls tryPostgresTier,
// falling back to a schema-stable-empty buildSubnetStakeTransfers(null, ...)
// literal on a miss, never D1. Only the pure cache-key coverage below
// (canonicalSubnetStakeTransfersCachePath, untouched by the retirement)
// remains meaningful here.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { canonicalSubnetStakeTransfersCachePath } from "../workers/request-handlers/entities.ts";

const NETUID = 7;

function url(path: string) {
  return new URL(`https://api.metagraph.sh${path}`);
}

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
