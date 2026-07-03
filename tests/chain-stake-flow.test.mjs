import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  buildChainStakeFlow,
  loadChainStakeFlow,
} from "../src/chain-stake-flow.mjs";
import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
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
});

describe("GET /api/v1/chain/stake-flow", () => {
  function stakeFlowEnv(rows = []) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
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
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.total_staked_tao, 50);
    assert.equal(body.data.total_unstaked_tao, 20);
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
