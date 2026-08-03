// The per-subnet slice of the chain-stake-flow projection (#9146).
//
// The interesting failures here are the ones that produce a plausible NUMBER
// rather than an error: answering a window the lane never computed with a
// different window's rows, or letting another subnet's rows leak into a
// subnet's total. Both would look completely normal in the response, so each
// gets its own test.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetStakeFlowFromArtifact } from "../src/subnet-stake-flow-artifact.ts";
import { CHAIN_STAKE_FLOW_PROJECTION_KEY } from "../src/chain-stake-flow-artifact.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "../src/stake-flow.ts";
import type { Row } from "./row-type.ts";

function row(
  netuid: number,
  kind: string,
  totalTao: number,
  eventCount: number,
  lastObserved = 1_785_700_000_000,
): Row {
  return {
    netuid,
    event_kind: kind,
    total_tao: totalTao,
    event_count: eventCount,
    last_observed: lastObserved,
  };
}

/** An R2 double returning `body` for the projection key and null otherwise. */
function envWith(body: unknown, opts: { throws?: boolean } = {}) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        get(key: string) {
          keys.push(key);
          if (opts.throws) return Promise.reject(new Error("r2 down"));
          if (key !== CHAIN_STAKE_FLOW_PROJECTION_KEY) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ json: () => Promise.resolve(body) });
        },
      },
    } as unknown as Env,
  };
}

const BODY = {
  schema_version: 1,
  windows: {
    "7d": {
      days: 7,
      rows: [
        row(1, STAKE_ADDED_KIND, 100, 10),
        row(1, STAKE_REMOVED_KIND, 40, 4, 1_785_700_500_000),
        row(2, STAKE_ADDED_KIND, 999, 99),
      ],
    },
    "30d": { days: 30, rows: [row(1, STAKE_ADDED_KIND, 500, 50)] },
    "90d": { days: 90, rows: [row(1, STAKE_ADDED_KIND, 900, 90)] },
  },
};

describe("loadSubnetStakeFlowFromArtifact", () => {
  test("slices one subnet out of the shared projection", async () => {
    const { env, keys } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
    });
    assert.ok(out);
    assert.equal(out.data.netuid, 1);
    assert.equal(out.data.window, "7d");
    assert.equal(out.data.total_staked_tao, 100);
    assert.equal(out.data.total_unstaked_tao, 40);
    assert.equal(out.data.net_flow_tao, 60);
    assert.equal(out.data.stake_events, 10);
    assert.equal(out.data.unstake_events, 4);
    // Reads the chain lane's artifact, not one of its own.
    assert.deepEqual(keys, [CHAIN_STAKE_FLOW_PROJECTION_KEY]);
  });

  test("never lets another subnet's rows into the total", async () => {
    // netuid 2 carries 999 TAO in the same window; a missing filter would
    // silently inflate netuid 1 rather than fail.
    const { env } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
    });
    assert.equal(out?.data.total_staked_tao, 100);
  });

  test("reports the newest last_observed across the subnet's rows", async () => {
    const { env } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
    });
    assert.equal(out?.generatedAt, new Date(1_785_700_500_000).toISOString());
  });

  test("direction narrows to one side, matching the SQL it replaces", async () => {
    const { env } = envWith(BODY);
    const inbound = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
      direction: "in",
    });
    assert.equal(inbound?.data.total_staked_tao, 100);
    assert.equal(inbound?.data.total_unstaked_tao, 0);

    const outbound = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
      direction: "out",
    });
    assert.equal(outbound?.data.total_staked_tao, 0);
    assert.equal(outbound?.data.total_unstaked_tao, 40);

    const both = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "7d",
      direction: "all",
    });
    assert.equal(both?.data.net_flow_tao, 60);
  });

  test("serves the 90d window the chain route does not expose", async () => {
    const { env } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 1, {
      window: "90d",
    });
    assert.equal(out?.data.total_staked_tao, 900);
    assert.equal(out?.data.window, "90d");
  });

  test("defaults to the route's default window", async () => {
    const { env } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 1);
    assert.equal(out?.data.window, "30d");
    assert.equal(out?.data.total_staked_tao, 500);
  });

  test("returns a genuine zero for a subnet the window has no events for", async () => {
    // The lane DID cover this window; the answer is simply that nothing moved.
    // That is a zero, not a decline -- declining would mark the response
    // uncacheable and hide a real answer.
    const { env } = envWith(BODY);
    const out = await loadSubnetStakeFlowFromArtifact(env, 77, {
      window: "7d",
    });
    assert.ok(out);
    assert.equal(out.data.netuid, 77);
    assert.equal(out.data.net_flow_tao, 0);
    assert.equal(out.generatedAt, null);
  });

  test("declines a window the lane did not precompute", async () => {
    // The failure this prevents: answering with a DIFFERENT window's numbers.
    const { env } = envWith({
      schema_version: 1,
      windows: { "7d": BODY.windows["7d"] },
    });
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(env, 1, { window: "90d" }),
      null,
    );
  });

  test("declines an unsupported window label outright", async () => {
    const { env } = envWith(BODY);
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(env, 1, { window: "1y" }),
      null,
    );
  });

  test.each([
    ["no binding", null, undefined],
    ["wrong schema_version", { schema_version: 2, windows: {} }, undefined],
    ["windows absent", { schema_version: 1 }, undefined],
    ["windows null", { schema_version: 1, windows: null }, undefined],
    [
      "rows not an array",
      { schema_version: 1, windows: { "7d": {} } },
      undefined,
    ],
  ])("declines when the artifact is unusable: %s", async (_label, body) => {
    const env =
      body === null ? ({} as unknown as Env) : envWith(body as unknown).env;
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(env, 1, { window: "7d" }),
      null,
    );
  });

  test("declines when the object is missing", async () => {
    const env = {
      METAGRAPH_ARCHIVE: { get: () => Promise.resolve(null) },
    } as unknown as Env;
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(env, 1, { window: "7d" }),
      null,
    );
  });

  test("declines rather than throwing when the store errors", async () => {
    const { env } = envWith(BODY, { throws: true });
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(env, 1, { window: "7d" }),
      null,
    );
  });

  test("declines on a null env", async () => {
    assert.equal(
      await loadSubnetStakeFlowFromArtifact(null, 1, { window: "7d" }),
      null,
    );
  });
});
