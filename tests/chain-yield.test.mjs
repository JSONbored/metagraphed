import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainYield,
  computeYieldDistribution,
  loadChainYield,
} from "../src/chain-yield.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

describe("computeYieldDistribution", () => {
  test("summarizes an even-count distribution (median averages the two middles)", () => {
    assert.deepEqual(computeYieldDistribution([0.6, 0.2, 0.8, 0.4]), {
      count: 4,
      mean: 0.5,
      min: 0.2,
      p25: 0.2,
      median: 0.5,
      p75: 0.6,
      p90: 0.8,
      max: 0.8,
    });
  });

  test("summarizes an odd-count distribution (median is the middle value)", () => {
    assert.deepEqual(computeYieldDistribution([0.5, 0.1, 0.3]), {
      count: 3,
      mean: 0.3,
      min: 0.1,
      p25: 0.1,
      median: 0.3,
      p75: 0.5,
      p90: 0.5,
      max: 0.5,
    });
  });

  test("drops null entries and returns null for an empty / non-array lens", () => {
    assert.equal(computeYieldDistribution([null, null]), null);
    assert.equal(computeYieldDistribution([]), null);
    assert.equal(computeYieldDistribution(null), null);
    assert.equal(computeYieldDistribution([0.4, null, 0.6]).count, 2);
  });
});

describe("buildChainYield", () => {
  const ROWS = [
    {
      hotkey: "hk-a",
      validator_permit: 1,
      stake_tao: 10,
      emission_tao: 2, // validator yield 0.2
      netuid: 1,
      captured_at: "2026-06-27T00:00:00Z",
    },
    {
      hotkey: "hk-b",
      validator_permit: 0,
      stake_tao: 5,
      emission_tao: 2, // miner yield 0.4
      netuid: 2,
      captured_at: "2026-06-27T00:00:00Z",
    },
    {
      hotkey: "hk-c",
      validator_permit: 0,
      stake_tao: 0, // zero stake -> yield undefined, excluded from distributions
      emission_tao: 1,
      netuid: 2,
      captured_at: "2026-06-27T00:00:00Z",
    },
  ];

  test("computes totals, role aggregates, distributions, and the leaderboard", () => {
    const out = buildChainYield(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids {1, 2}
    assert.equal(out.neuron_count, 3);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 2);
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");
    assert.equal(out.total_stake_tao, 15);
    assert.equal(out.total_emission_tao, 5);

    // stake-weighted aggregate yields per lens.
    assert.equal(out.network_yield, 0.333333333); // 5 / 15
    assert.equal(out.validator_yield, 0.2); // 2 / 10
    assert.equal(out.miner_yield, 0.6); // (2 + 1) / (5 + 0)

    // per-neuron distributions (zero-stake hk-c excluded).
    assert.equal(out.yield.count, 2);
    assert.equal(out.yield.mean, 0.3);
    assert.equal(out.yield.median, 0.3);
    assert.equal(out.validator_yield_distribution.count, 1);
    assert.equal(out.validator_yield_distribution.mean, 0.2);
    assert.equal(out.miner_yield_distribution.count, 1);
    assert.equal(out.miner_yield_distribution.mean, 0.4);

    // leaderboard: highest yield first, zero-stake excluded.
    assert.equal(out.top_yielders.length, 2);
    assert.deepEqual(out.top_yielders[0], {
      hotkey: "hk-b",
      netuid: 2,
      role: "miner",
      stake_tao: 5,
      emission_tao: 2,
      yield: 0.4,
    });
    assert.equal(out.top_yielders[1].hotkey, "hk-a");
  });

  test("aggregate yields are null when a lens holds no stake", () => {
    const out = buildChainYield([
      { validator_permit: 0, stake_tao: 0, emission_tao: 1, netuid: 1 },
    ]);
    assert.equal(out.network_yield, null); // no stake anywhere
    assert.equal(out.validator_yield, null); // no validators
    assert.equal(out.miner_yield, null); // miner has zero stake
    assert.equal(out.yield, null);
  });

  test("clamps the leaderboard limit to 1..100", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      hotkey: `hk-${i}`,
      validator_permit: 0,
      stake_tao: 10,
      emission_tao: i + 1,
      netuid: 1,
    }));
    assert.equal(buildChainYield(rows, { limit: 2 }).top_yielders.length, 2);
    assert.equal(buildChainYield(rows, { limit: 0 }).top_yielders.length, 1); // -> 1
    assert.equal(buildChainYield(rows, { limit: 999 }).top_yielders.length, 5); // <= rows
  });

  test("leaderboard tie-breaks equal yields by larger stake first", () => {
    const out = buildChainYield([
      {
        hotkey: "small",
        validator_permit: 0,
        stake_tao: 10,
        emission_tao: 2,
        netuid: 1,
      },
      {
        hotkey: "big",
        validator_permit: 0,
        stake_tao: 100,
        emission_tao: 20,
        netuid: 1,
      },
    ]);
    // both yield 0.2; larger stake ranks first.
    assert.equal(out.top_yielders[0].hotkey, "big");
  });

  test("takes the newest captured_at and ignores unparseable stamps", () => {
    assert.equal(
      buildChainYield([
        {
          stake_tao: 1,
          emission_tao: 1,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
        {
          stake_tao: 1,
          emission_tao: 1,
          netuid: 1,
          captured_at: 1_700_000_001_000,
        },
      ]).captured_at,
      new Date(1_700_000_001_000).toISOString(),
    );
    assert.equal(
      buildChainYield([
        { stake_tao: 1, emission_tao: 1, netuid: 1, captured_at: "nope" },
      ]).captured_at,
      null,
    );
  });

  test("coerces string netuid cells and rejects blank/null/invalid ones", () => {
    const out = buildChainYield([
      { stake_tao: 1, emission_tao: 1, netuid: "5" },
      { stake_tao: 1, emission_tao: 1, netuid: 5 },
      { stake_tao: 1, emission_tao: 1, netuid: null },
      { stake_tao: 1, emission_tao: 1 },
      { stake_tao: 1, emission_tao: 1, netuid: -3 },
      { stake_tao: 1, emission_tao: 1, netuid: "x" },
    ]);
    assert.equal(out.subnet_count, 1); // only subnet 5
  });

  test("coerces string stake/emission cells and treats non-numeric ones as 0", () => {
    const out = buildChainYield([
      {
        hotkey: "s",
        validator_permit: 0,
        stake_tao: "10",
        emission_tao: "2",
        netuid: 1,
      },
      {
        hotkey: "j",
        validator_permit: 0,
        stake_tao: "bad",
        emission_tao: null,
        netuid: 1,
      },
    ]);
    assert.equal(out.total_stake_tao, 10); // "10" -> 10, "bad" -> 0
    assert.equal(out.total_emission_tao, 2); // "2" -> 2, null -> 0
    assert.equal(out.top_yielders.length, 1); // only the "10"/"2" row has stake > 0
    assert.equal(out.top_yielders[0].yield, 0.2);
  });

  test("is schema-stable-zero on a cold store", () => {
    assert.deepEqual(buildChainYield([]), {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      validator_count: 0,
      miner_count: 0,
      captured_at: null,
      total_stake_tao: 0,
      total_emission_tao: 0,
      network_yield: null,
      validator_yield: null,
      miner_yield: null,
      yield: null,
      validator_yield_distribution: null,
      miner_yield_distribution: null,
      top_yielders: [],
    });
    assert.equal(buildChainYield(null).neuron_count, 0);
  });
});

describe("loadChainYield", () => {
  function captureD1(rows = []) {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return rows;
    };
    return { d1, calls };
  }

  test("reads every subnet's neurons in one pass and passes the limit through", async () => {
    const { d1, calls } = captureD1([
      {
        hotkey: "a",
        validator_permit: 1,
        stake_tao: 10,
        emission_tao: 2,
        netuid: 1,
      },
      {
        hotkey: "b",
        validator_permit: 0,
        stake_tao: 10,
        emission_tao: 4,
        netuid: 2,
      },
    ]);
    const data = await loadChainYield(d1, { limit: 1 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM neurons/);
    assert.doesNotMatch(calls[0].sql, /WHERE/);
    assert.deepEqual(calls[0].params, []);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.top_yielders.length, 1); // limit applied
  });

  test("returns a schema-stable null block on a cold D1", async () => {
    const data = await loadChainYield(captureD1([]).d1);
    assert.equal(data.neuron_count, 0);
    assert.equal(data.yield, null);
    assert.deepEqual(data.top_yielders, []);
  });
});

describe("GET /api/v1/chain/yield", () => {
  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /MAX\(captured_at\)/.test(sql)
                    ? [{ captured_at: 1_700_000_000_000 }]
                    : rows,
                }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/yield${q}`);

  test("aggregates yields across all subnets", async () => {
    const res = await handleRequest(
      req(),
      neuronsEnv([
        {
          hotkey: "a",
          validator_permit: 1,
          stake_tao: 10,
          emission_tao: 2,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.network_yield, 0.2);
    assert.equal(body.data.validator_count, 1);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("rejects a non-canonical limit with 400", async () => {
    const res = await handleRequest(req("?limit=abc"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/yield edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  function neuronsEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /MAX\(captured_at\)/.test(sql)
                    ? [{ captured_at: 1_700_000_000_000 }]
                    : rows,
                }),
            }),
          };
        },
      },
    };
  }

  test("engages the edge cache, busting on the newest neuron captured_at", async () => {
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
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/yield"),
      neuronsEnv([
        {
          hotkey: "a",
          validator_permit: 1,
          stake_tao: 10,
          emission_tao: 2,
          netuid: 1,
        },
      ]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(store.size, 1);
  });
});
