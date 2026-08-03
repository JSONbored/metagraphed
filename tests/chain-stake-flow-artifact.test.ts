// Same family contract as chain-transfers-artifact.test.ts: the stored
// per-(netuid, event_kind) rows flow VERBATIM into the shared
// buildChainStakeFlow builder (which owns ranking, the rollup, the
// distribution, and the limit), and anything that is not the artifact the
// lane wrote declines rather than half-serving.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_STAKE_FLOW_PROJECTION_KEY,
  loadChainStakeFlowFromArtifact,
} from "../src/chain-stake-flow-artifact.ts";

const NEWEST = 1785680000000;

function flowRow(
  netuid: number,
  kind: string,
  tao: number,
  count: number,
  observed = NEWEST,
) {
  return {
    netuid,
    event_kind: kind,
    total_tao: String(tao),
    event_count: String(count),
    last_observed: observed,
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
        rows: [
          flowRow(7, "StakeAdded", 100, 3),
          flowRow(7, "StakeRemoved", 40, 2, NEWEST - 1000),
          flowRow(9, "StakeAdded", 10, 1, NEWEST - 2000),
        ],
      },
      "30d": {
        days: 30,
        rows: [flowRow(3, "StakeRemoved", 500, 8)],
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

describe("loadChainStakeFlowFromArtifact", () => {
  test("serves the default window through the shared builder", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainStakeFlowFromArtifact(env, {});
    assert.equal(gets[0], CHAIN_STAKE_FLOW_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.subnet_count, 2);
    // Biggest net inflow first — the builder owns the ranking.
    assert.equal(data!.subnets[0]!.netuid, 7);
    assert.equal(data!.subnets[0]!.net_flow_tao, 60);
    assert.equal(data!.subnets[0]!.stake_events, 3);
    assert.equal(data!.subnets[0]!.unstake_events, 2);
    assert.equal(data!.network.total_staked_tao, 110);
    assert.equal(data!.network.total_unstaked_tao, 40);
    // The newest stored MAX(observed_at) surfaces as the freshness signal.
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the builder applies the limit while the rollup covers every subnet", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainStakeFlowFromArtifact(env, {
      window: "7d",
      limit: 1,
    });
    assert.equal(data!.subnets.length, 1);
    assert.equal(data!.subnet_count, 2);
    assert.equal(data!.net_flow_distribution!.count, 2);
  });

  test("every precomputed window is servable", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainStakeFlowFromArtifact(env, { window: "30d" });
    assert.equal(data!.window, "30d");
    assert.equal(data!.subnets[0]!.netuid, 3);
    assert.equal(data!.subnets[0]!.direction, "outflow");
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainStakeFlowFromArtifact(env, { window: "90d" }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainStakeFlowFromArtifact(env, { window: "30d" }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(await loadChainStakeFlowFromArtifact({} as never, {}), null);
    assert.equal(await loadChainStakeFlowFromArtifact(null, {}), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainStakeFlowFromArtifact(env, {}), null);
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
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainStakeFlowFromArtifact(env, {}),
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
    assert.equal(await loadChainStakeFlowFromArtifact(env, {}), null);
  });
});
