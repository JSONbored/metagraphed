import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  buildChainStakeFlow,
  loadChainStakeFlow,
} from "../src/chain-stake-flow.mjs";
import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
} from "../src/stake-flow.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildChainStakeFlow", () => {
  test("cold / empty / non-array inputs yield schema-stable zeros", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildChainStakeFlow(rows, { window: "30d" });
      assert.equal(data.schema_version, 1);
      assert.equal(data.window, "30d");
      assert.equal(data.total_staked_tao, 0);
      assert.equal(data.total_unstaked_tao, 0);
      assert.equal(data.net_flow_tao, 0);
      assert.equal(data.stake_events, 0);
      assert.equal(data.unstake_events, 0);
      assert.equal("netuid" in data, false);
    }
  });

  test("window defaults to null when omitted", () => {
    assert.equal(buildChainStakeFlow([]).window, null);
  });

  test("sums StakeAdded as inflow and StakeRemoved as outflow", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: 100, event_count: 4 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: 25, event_count: 2 },
    ];
    const data = buildChainStakeFlow(rows, { window: "7d" });
    assert.equal(data.total_staked_tao, 100);
    assert.equal(data.total_unstaked_tao, 25);
    assert.equal(data.net_flow_tao, 75);
    assert.equal(data.stake_events, 4);
    assert.equal(data.unstake_events, 2);
  });

  test("rounds TAO sums to rao precision (no IEEE-754 dust)", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: 0.1 + 0.2, event_count: 1 },
    ];
    const data = buildChainStakeFlow(rows, { window: "30d" });
    assert.equal(data.total_staked_tao, 0.3);
    assert.equal(data.net_flow_tao, 0.3);
  });

  test("null / non-finite total_tao defaults to zero", () => {
    const rows = [
      { event_kind: STAKE_ADDED_KIND, total_tao: null, event_count: 0 },
      { event_kind: STAKE_REMOVED_KIND, total_tao: "nope", event_count: 0 },
    ];
    const data = buildChainStakeFlow(rows, { window: "7d" });
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.total_unstaked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
  });

  test("ignores unknown event kinds", () => {
    const data = buildChainStakeFlow(
      [{ event_kind: "WeightsSet", total_tao: 999, event_count: 9 }],
      { window: "7d" },
    );
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
  });
});

describe("loadChainStakeFlow", () => {
  test("queries account_events without a netuid filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 300,
          event_count: 10,
          last_observed: 1717900000000,
        },
      ];
    };
    const { data, generatedAt } = await loadChainStakeFlow(d1, {
      windowLabel: "30d",
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /netuid/);
    assert.match(calls[0].sql, /GROUP BY event_kind/);
    assert.equal(calls[0].params.at(-1), Date.now() - 30 * DAY_MS);
    assert.equal(data.window, "30d");
    assert.equal(data.net_flow_tao, 300);
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
    vi.useRealTimers();
  });

  test("defaults to the 30d window when none is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let captured;
    const d1 = async (_sql, params) => {
      captured = params;
      return [];
    };
    const { data } = await loadChainStakeFlow(d1, {});
    assert.equal(data.window, DEFAULT_STAKE_FLOW_WINDOW);
    assert.equal(captured[2], Date.now() - STAKE_FLOW_WINDOWS["30d"] * DAY_MS);
    vi.useRealTimers();
  });

  test("an unknown window label falls back to the default cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let captured;
    const d1 = async (_sql, params) => {
      captured = params;
      return [];
    };
    await loadChainStakeFlow(d1, { windowLabel: "bogus" });
    assert.equal(captured[2], Date.now() - STAKE_FLOW_WINDOWS["30d"] * DAY_MS);
    vi.useRealTimers();
  });

  test("cold D1 yields zeroed totals and null generated_at", async () => {
    const d1 = async () => [];
    const { data, generatedAt } = await loadChainStakeFlow(d1, {
      windowLabel: "7d",
    });
    assert.equal(data.total_staked_tao, 0);
    assert.equal(data.net_flow_tao, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to zeroed totals", async () => {
    const d1 = async () => null;
    const { data, generatedAt } = await loadChainStakeFlow(d1, {});
    assert.equal(data.total_staked_tao, 0);
    assert.equal(generatedAt, null);
  });

  test("direction=in queries StakeAdded only", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 100,
          event_count: 3,
          last_observed: 1717000000000,
        },
      ];
    };
    const { data } = await loadChainStakeFlow(d1, {
      windowLabel: "7d",
      direction: "in",
    });
    assert.equal(calls[0].params[0], STAKE_ADDED_KIND);
    assert.equal(calls[0].params.length, 2);
    assert.equal(data.total_staked_tao, 100);
    assert.equal(data.net_flow_tao, 100);
  });

  test("direction=out queries StakeRemoved only", async () => {
    const calls = [];
    const d1 = async (_sql, params) => {
      calls.push(params);
      return [];
    };
    await loadChainStakeFlow(d1, { windowLabel: "7d", direction: "out" });
    assert.equal(calls[0][0], STAKE_REMOVED_KIND);
    assert.equal(calls[0].length, 2);
  });

  test("direction=all queries both stake kinds", async () => {
    const calls = [];
    const d1 = async (_sql, params) => {
      calls.push(params);
      return [];
    };
    await loadChainStakeFlow(d1, { direction: "all" });
    assert.deepEqual(calls[0].slice(0, 2), [
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
    ]);
  });

  test("generatedAt coerces string-typed last_observed cells", async () => {
    const d1 = async () => [
      {
        event_kind: STAKE_ADDED_KIND,
        total_tao: 10,
        event_count: 1,
        last_observed: "1717000000000",
      },
      {
        event_kind: STAKE_REMOVED_KIND,
        total_tao: 5,
        event_count: 1,
        last_observed: "1717900000000",
      },
    ];
    const { generatedAt } = await loadChainStakeFlow(d1, { windowLabel: "7d" });
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
  });

  test("generatedAt stays null for invalid last_observed values", async () => {
    for (const last_observed of [
      "",
      "not-a-date",
      null,
      0,
      -1,
      "8640000000000001",
    ]) {
      const d1 = async () => [
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 10,
          event_count: 1,
          last_observed,
        },
      ];
      const { generatedAt } = await loadChainStakeFlow(d1, {
        windowLabel: "7d",
      });
      assert.equal(generatedAt, null, `last_observed=${last_observed}`);
    }
  });

  test("generatedAt picks the newest observed_at across multiple rows", async () => {
    const d1 = async () => [
      {
        event_kind: STAKE_ADDED_KIND,
        total_tao: 10,
        event_count: 1,
        last_observed: 1717900000000,
      },
      {
        event_kind: STAKE_REMOVED_KIND,
        total_tao: 5,
        event_count: 1,
        last_observed: 1717000000000,
      },
    ];
    const { generatedAt } = await loadChainStakeFlow(d1, {
      windowLabel: "7d",
    });
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
  });
});

describe("GET /api/v1/chain/stake-flow", () => {
  function stakeFlowEnv(rows = []) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(_sql) {
          return {
            bind() {
              return {
                all: () => Promise.resolve({ results: rows }),
              };
            },
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/stake-flow${q}`);

  test("aggregates network-wide stake flow", async () => {
    const res = await handleRequest(
      req(),
      stakeFlowEnv([
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 50,
          event_count: 2,
          last_observed: 1_700_000_000_000,
        },
        {
          event_kind: STAKE_REMOVED_KIND,
          total_tao: 20,
          event_count: 1,
          last_observed: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.net_flow_tao, 30);
    assert.equal(body.meta.source, "chain-events");
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(req("?window=1y"), stakeFlowEnv(), {});
    assert.equal(res.status, 400);
  });

  test("rejects an invalid direction with 400", async () => {
    const res = await handleRequest(
      req("?direction=sideways"),
      stakeFlowEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), stakeFlowEnv(), {});
    assert.equal(res.status, 400);
  });

  test("direction=in narrows to StakeAdded inflow only", async () => {
    const res = await handleRequest(
      req("?direction=in"),
      stakeFlowEnv([
        {
          event_kind: STAKE_ADDED_KIND,
          total_tao: 40,
          event_count: 2,
          last_observed: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.total_staked_tao, 40);
    assert.equal(body.data.total_unstaked_tao, 0);
  });

  test("direction=out narrows to StakeRemoved outflow only", async () => {
    const res = await handleRequest(
      req("?direction=out"),
      stakeFlowEnv([
        {
          event_kind: STAKE_REMOVED_KIND,
          total_tao: 15,
          event_count: 1,
          last_observed: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.total_staked_tao, 0);
    assert.equal(body.data.total_unstaked_tao, 15);
    assert.equal(body.data.net_flow_tao, -15);
  });

  test("returns schema-stable zeros on cold D1", async () => {
    const res = await handleRequest(req(), stakeFlowEnv([]), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.total_staked_tao, 0);
    assert.equal(body.data.net_flow_tao, 0);
  });
});

describe("chain/stake-flow edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  test("engages the edge cache for repeated requests", async () => {
    originalCaches = globalThis.caches;
    const store = new Map();
    globalThis.caches = {
      default: {
        async match(request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request, response) {
          store.set(request.url, response.clone());
        },
      },
    };
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta"
            ? { last_run_at: "2026-07-02T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: [
                    {
                      event_kind: STAKE_ADDED_KIND,
                      total_tao: 10,
                      event_count: 1,
                      last_observed: 1_700_000_000_000,
                    },
                  ],
                }),
            }),
          };
        },
      },
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-flow"),
      env,
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(store.size, 1);
  });
});
