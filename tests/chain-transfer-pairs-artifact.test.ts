// Same family contract as chain-transfers-artifact.test.ts: the stored
// corridor rows (one list per supported sort) flow through the SAME
// buildChainTransferPairs formatter, sliced to the caller's limit BEFORE the
// formatter (data-api's LIMIT-ed-fetch row set) with top_pair_share dividing
// the stored full-window MAX by the full-window SUM, and anything that is
// not the artifact the lane wrote — including a sort it did not precompute —
// declines rather than half-serving.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_TRANSFER_PAIRS_PROJECTION_KEY,
  loadChainTransferPairsFromArtifact,
} from "../src/chain-transfer-pairs-artifact.ts";

const NEWEST = 1785680000000;

function pair(from: string, to: string, volume: number, count: number) {
  return {
    from_address: from,
    to_address: to,
    volume_tao: String(volume),
    transfer_count: String(count),
    last_block: "123456",
    last_observed_at: NEWEST - 1000,
  };
}

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 4,
    windows: {
      "7d": {
        days: 7,
        totals: {
          transfer_count: "10",
          total_volume_tao: "500",
          unique_pairs: "3",
          top_pair_volume_tao: "300",
          newest_observed: NEWEST,
        },
        sorts: {
          volume: [pair("5A", "5B", 300, 2), pair("5C", "5D", 150, 6)],
          count: [pair("5C", "5D", 150, 6), pair("5A", "5B", 300, 2)],
        },
      },
      "30d": {
        days: 30,
        totals: null,
        sorts: { volume: [], count: [] },
      },
    },
  };
}

function bucketWith(body: unknown, opts: { missing?: boolean } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (opts.missing) return null;
          return { json: async () => body };
        },
      },
    } as unknown as Env,
  };
}

describe("loadChainTransferPairsFromArtifact", () => {
  test("serves the default window/sort through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainTransferPairsFromArtifact(env, { limit: 25 });
    assert.equal(gets[0], CHAIN_TRANSFER_PAIRS_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.sort, "volume");
    assert.equal(data!.total_volume_tao, 500);
    assert.equal(data!.transfer_count, 10);
    assert.equal(data!.unique_pairs, 3);
    assert.equal(data!.pair_count, 2);
    assert.equal(data!.pairs[0]!.from, "5A");
    assert.equal(data!.pairs[0]!.volume_tao, 300);
    // top_pair_share divides the stored FULL-WINDOW MAX corridor by the
    // full-window SUM, exactly like the live tier's totals rollup.
    assert.equal(data!.top_pair_share, 300 / 500);
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the count sort serves its own precomputed order", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainTransferPairsFromArtifact(env, {
      sort: "count",
      limit: 25,
    });
    assert.equal(data!.sort, "count");
    assert.deepEqual(
      data!.pairs.map((row) => row.from),
      ["5C", "5A"],
    );
  });

  test("the limit slices BEFORE the formatter while shares stay full-window", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainTransferPairsFromArtifact(env, {
      sort: "count",
      limit: 1,
    });
    assert.equal(data!.pair_count, 1);
    assert.equal(data!.pairs[0]!.from, "5C");
    // The truncated page does not skew the share — the stored full-window
    // MAX (a corridor OUTSIDE this page) still leads the ratio.
    assert.equal(data!.top_pair_share, 300 / 500);
  });

  test("a malformed limit falls back to the route default; an oversize one is capped", async () => {
    const body = artifact();
    body.windows["7d"].sorts.volume = Array.from({ length: 120 }, (_, i) =>
      pair(`5F${String(i).padStart(3, "0")}`, "5T", 120 - i, 1),
    );
    const { env } = bucketWith(body);
    const defaulted = await loadChainTransferPairsFromArtifact(env, {
      limit: "bogus",
    });
    assert.equal(defaulted!.pair_count, 25);
    const capped = await loadChainTransferPairsFromArtifact(env, {
      limit: 500,
    });
    assert.equal(capped!.pair_count, 100);
  });

  test("a window the lane observed nothing in serves the schema-stable empty", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainTransferPairsFromArtifact(env, {
      window: "30d",
      limit: 25,
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.pair_count, 0);
    assert.equal(data!.top_pair_share, null);
    assert.equal(data!.observed_at, null);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainTransferPairsFromArtifact(env, {
        window: "90d",
        limit: 25,
      }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainTransferPairsFromArtifact(env, {
        window: "30d",
        limit: 25,
      }),
      null,
    );
  });

  test("an unknown sort declines — never a different order's rows", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainTransferPairsFromArtifact(env, {
        sort: "bogus",
        limit: 25,
      }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainTransferPairsFromArtifact({} as never, { limit: 25 }),
      null,
    );
    assert.equal(
      await loadChainTransferPairsFromArtifact(null, { limit: 25 }),
      null,
    );
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(
      await loadChainTransferPairsFromArtifact(env, { limit: 25 }),
      null,
    );
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      { schema_version: 1, windows: { "7d": { sorts: null } } },
      { schema_version: 1, windows: { "7d": { sorts: "no" } } },
      { schema_version: 1, windows: { "7d": { sorts: { count: [] } } } },
      {
        schema_version: 1,
        windows: { "7d": { sorts: { volume: "not-an-array" } } },
      },
      {
        schema_version: 1,
        windows: {
          "7d": { totals: "not-a-row", sorts: { volume: [], count: [] } },
        },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainTransferPairsFromArtifact(env, { limit: 25 }),
        null,
        JSON.stringify(body),
      );
    }
  });

  test("a throwing store declines instead of failing the request", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("r2 down");
        },
      },
    } as unknown as Env;
    assert.equal(
      await loadChainTransferPairsFromArtifact(env, { limit: 25 }),
      null,
    );
  });
});
