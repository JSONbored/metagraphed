// Same family contract as chain-stake-flow-artifact.test.ts: the stored
// per-subnet rows and the network DISTINCT row flow VERBATIM into the shared
// buildChainStakeTransfers builder (which owns ranking, the rollup, the
// distribution, and the limit), and anything that is not the artifact the
// lane wrote declines rather than half-serving.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_STAKE_TRANSFERS_PROJECTION_KEY,
  loadChainStakeTransfersFromArtifact,
} from "../src/chain-stake-transfers-artifact.ts";

const NEWEST = 1785680000000;

function subnetRow(netuid: number, transfers: number, senders: number) {
  return {
    netuid,
    transfers: String(transfers),
    distinct_senders: String(senders),
  };
}

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 2,
    windows: {
      "7d": {
        days: 7,
        network: { distinct_senders: "4", newest_observed: NEWEST },
        rows: [subnetRow(7, 6, 3), subnetRow(9, 2, 2)],
      },
      "30d": {
        days: 30,
        network: null,
        rows: [],
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

describe("loadChainStakeTransfersFromArtifact", () => {
  test("serves the default window through the shared builder", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainStakeTransfersFromArtifact(env, {});
    assert.equal(gets[0], CHAIN_STAKE_TRANSFERS_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.subnet_count, 2);
    // Most active sending subnet first — the builder owns the ranking.
    assert.equal(data!.subnets[0]!.netuid, 7);
    assert.equal(data!.subnets[0]!.transfers, 6);
    assert.equal(data!.subnets[0]!.transfers_per_sender, 2);
    // The network DISTINCT row is the true network-wide count, NOT the sum
    // of the per-subnet counts.
    assert.equal(data!.network.distinct_senders, 4);
    assert.equal(data!.network.transfers, 8);
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the builder applies the limit while the rollup covers every subnet", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainStakeTransfersFromArtifact(env, {
      window: "7d",
      limit: 1,
    });
    assert.equal(data!.subnets.length, 1);
    assert.equal(data!.subnet_count, 2);
    assert.equal(data!.intensity_distribution!.count, 2);
  });

  test("a window the lane observed nothing in serves the schema-stable empty", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainStakeTransfersFromArtifact(env, {
      window: "30d",
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.subnet_count, 0);
    assert.equal(data!.observed_at, null);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainStakeTransfersFromArtifact(env, { window: "90d" }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainStakeTransfersFromArtifact(env, { window: "30d" }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainStakeTransfersFromArtifact({} as never, {}),
      null,
    );
    assert.equal(await loadChainStakeTransfersFromArtifact(null, {}), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainStakeTransfersFromArtifact(env, {}), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      { schema_version: 1, windows: { "7d": { rows: "not-an-array" } } },
      {
        schema_version: 1,
        windows: { "7d": { network: "not-a-row", rows: [] } },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainStakeTransfersFromArtifact(env, {}),
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
    assert.equal(await loadChainStakeTransfersFromArtifact(env, {}), null);
  });
});
