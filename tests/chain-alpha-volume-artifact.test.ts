// Same family contract as chain-stake-flow-artifact.test.ts: the stored
// per-(netuid, event_kind) rows flow VERBATIM into the shared
// buildChainAlphaVolume builder (which owns ranking, the network rollup, the
// distribution, and the limit), and anything that is not the artifact the
// lane wrote declines rather than half-serving. One fixed 24h window — the
// route has no ?window= param.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_ALPHA_VOLUME_PROJECTION_KEY,
  loadChainAlphaVolumeFromArtifact,
} from "../src/chain-alpha-volume-artifact.ts";

const NEWEST = 1785680000000;

function volumeRow(
  netuid: number,
  kind: string,
  alpha: number,
  tao: number,
  count: number,
  observed = NEWEST,
) {
  return {
    netuid,
    event_kind: kind,
    alpha_volume: String(alpha),
    tao_volume: String(tao),
    event_count: String(count),
    last_observed: observed,
  };
}

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 3,
    windows: {
      "24h": {
        days: 1,
        rows: [
          volumeRow(7, "StakeAdded", 120, 60, 4),
          volumeRow(7, "StakeRemoved", 40, 20, 2, NEWEST - 1000),
          volumeRow(9, "StakeAdded", 10, 5, 1, NEWEST - 2000),
        ],
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

describe("loadChainAlphaVolumeFromArtifact", () => {
  test("serves the fixed 24h window through the shared builder", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainAlphaVolumeFromArtifact(env, { limit: 20 });
    assert.equal(gets[0], CHAIN_ALPHA_VOLUME_PROJECTION_KEY);
    assert.equal(data!.window, "24h");
    assert.equal(data!.subnet_count, 2);
    // Biggest total volume first — the builder owns the ranking.
    assert.equal(data!.subnets[0]!.netuid, 7);
    assert.equal(data!.subnets[0]!.total_volume_tao, 80);
    assert.equal(data!.subnets[0]!.buy_count, 4);
    assert.equal(data!.subnets[0]!.sell_count, 2);
    assert.equal(data!.network.total_volume_tao, 85);
    // The newest stored MAX(observed_at) surfaces as the freshness signal.
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the builder applies the limit while the rollup covers every subnet", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainAlphaVolumeFromArtifact(env, { limit: 1 });
    assert.equal(data!.subnets.length, 1);
    assert.equal(data!.subnet_count, 2);
    assert.equal(data!.volume_distribution!.count, 2);
  });

  test("an artifact without the 24h window declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["24h"];
    const { env } = bucketWith(body);
    assert.equal(await loadChainAlphaVolumeFromArtifact(env, {}), null);
  });

  test("an unbound bucket declines", async () => {
    assert.equal(await loadChainAlphaVolumeFromArtifact({} as never, {}), null);
    assert.equal(await loadChainAlphaVolumeFromArtifact(null, {}), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainAlphaVolumeFromArtifact(env, {}), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "24h": null } },
      { schema_version: 1, windows: { "24h": { rows: "not-an-array" } } },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainAlphaVolumeFromArtifact(env, {}),
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
    assert.equal(await loadChainAlphaVolumeFromArtifact(env, {}), null);
  });
});
