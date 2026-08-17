// The ownership-stream projection reader (#11421).
//
// This lane exists because the read it replaces is the only one in the family
// with a measured FLOOR rather than a tail: against production 2026-08-16,
// `/accounts/{ss58}/entities` spent a minimum of 10,420ms in r2sql across five
// distinct subjects (median 13,711ms), scanning an 895M-row table to return the
// one SubnetOwnerChanged row it holds.
//
// So the contract worth pinning here is the FALLTHROUGH: every decline must
// reach the lakehouse read, because that is what makes shipping this before the
// lane has ever run safe.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  CHAIN_OWNERSHIP_PROJECTION_KEY,
  loadOwnershipRowsFromArtifact,
} from "../src/subnet-ownership-artifact.ts";

const ROW = {
  block_number: 8_500_000,
  pallet: "SubtensorModule",
  method: "SubnetOwnerChanged",
  args: { netuid: 7, old_coldkey: "0xaa", new_coldkey: "0xbb" },
  observed_at: 1_784_537_200_378,
};

function bucketWith(body: unknown, { missing = false } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (missing) return null;
          return {
            async json() {
              return body;
            },
          };
        },
      },
    },
  };
}

describe("loadOwnershipRowsFromArtifact", () => {
  test("serves the stored stream verbatim", async () => {
    const { env, gets } = bucketWith({ schema_version: 1, rows: [ROW] });
    const rows = await loadOwnershipRowsFromArtifact(env);
    assert.deepEqual(gets, [CHAIN_OWNERSHIP_PROJECTION_KEY]);
    assert.equal(rows?.length, 1);
    // `args` arrives PARSED, not as Iceberg's JSON string. The lane restores it
    // so `decodeChainEventArgs` -- which does not parse strings, and silently
    // drops a row handed one -- sees the shape it requires.
    assert.deepEqual(rows?.[0]?.args, ROW.args);
  });

  test("an EMPTY stream is an answer, not a decline", async () => {
    // The honest state for 127 of 128 subnets. Declining on it would leave both
    // routes paying the 13-second read forever on the networks where the answer
    // is cheapest to state.
    const { env } = bucketWith({ schema_version: 1, rows: [] });
    assert.deepEqual(await loadOwnershipRowsFromArtifact(env), []);
  });

  test("reads the per-network key off mainnet, never mainnet's", async () => {
    const { env, gets } = bucketWith({ schema_version: 1, rows: [] });
    await loadOwnershipRowsFromArtifact(env, "testnet");
    assert.ok(gets.length > 0, "the reader actually looked");
    assert.ok(!gets.includes(CHAIN_OWNERSHIP_PROJECTION_KEY));
  });

  describe("declines so the caller falls through to the lakehouse", () => {
    test("no archive bound", async () => {
      assert.equal(await loadOwnershipRowsFromArtifact({}), null);
      assert.equal(await loadOwnershipRowsFromArtifact(null), null);
    });

    test("the object is missing -- the lane has not run yet", async () => {
      const { env } = bucketWith(null, { missing: true });
      assert.equal(await loadOwnershipRowsFromArtifact(env), null);
    });

    test("a body that is not what the lane wrote", async () => {
      for (const body of [
        null,
        {},
        { schema_version: 2, rows: [] },
        { schema_version: 1 },
        // `rows` absent must NEVER read as "no ownership changes" -- that is a
        // wrong answer wearing a measured one's shape, which is why the schema
        // requires it rather than defaulting it.
        { schema_version: 1, rows: null },
        { schema_version: 1, rows: "nope" },
        { schema_version: 1, rows: [null] },
      ]) {
        const { env } = bucketWith(body);
        assert.equal(
          await loadOwnershipRowsFromArtifact(env),
          null,
          `${JSON.stringify(body)} must decline`,
        );
      }
    });

    test("a bucket that throws", async () => {
      const env = {
        METAGRAPH_ARCHIVE: {
          async get() {
            throw new Error("archive unavailable");
          },
        },
      };
      assert.equal(await loadOwnershipRowsFromArtifact(env), null);
    });
  });
});
