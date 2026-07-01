import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainConsensus,
  computeDistribution,
  loadChainConsensus,
} from "../src/chain-consensus.mjs";
import { handleRequest } from "../workers/api.mjs";
import { readNeuronsCacheStamp } from "../workers/request-handlers/analytics.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

describe("computeDistribution", () => {
  test("summarizes an even-count distribution (median averages the two middles)", () => {
    assert.deepEqual(computeDistribution([0.6, 0.2, 0.8, 0.4]), {
      count: 4,
      mean: 0.5,
      min: 0.2,
      p25: 0.2,
      median: 0.5, // (0.4 + 0.6) / 2
      p75: 0.6,
      p90: 0.8,
      max: 0.8,
    });
  });

  test("summarizes an odd-count distribution (median is the middle value)", () => {
    assert.deepEqual(computeDistribution([0.5, 0.1, 0.3]), {
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

  test("drops zero / negative / non-finite / null cells before measuring", () => {
    const out = computeDistribution([0, -0.1, 0.5, null, "x", NaN, 0.3]);
    assert.equal(out.count, 2); // only 0.5 and 0.3 participate
    assert.equal(out.min, 0.3);
    assert.equal(out.max, 0.5);
    assert.equal(out.mean, 0.4);
  });

  test("coerces numeric-string cells from D1", () => {
    const out = computeDistribution(["0.4", "0.6"]);
    assert.equal(out.count, 2);
    assert.equal(out.mean, 0.5);
  });

  test("returns null for an empty / non-array / all-zero distribution", () => {
    assert.equal(computeDistribution([]), null);
    assert.equal(computeDistribution(null), null);
    assert.equal(computeDistribution([0, 0, 0]), null);
  });
});

describe("buildChainConsensus", () => {
  const ROWS = [
    {
      trust: 0.8,
      consensus: 0.7,
      incentive: 0, // a validator earns dividends, not incentive
      dividends: 0.5,
      validator_permit: 1,
      active: 1,
      netuid: 1,
      captured_at: "2026-06-27T00:00:00Z",
    },
    {
      trust: 0.6,
      consensus: 0.5,
      incentive: 0.4, // a miner earns incentive, not dividends
      dividends: 0,
      validator_permit: 0,
      active: 1,
      netuid: 2,
      captured_at: "2026-06-27T00:00:00Z",
    },
    {
      trust: 0,
      consensus: 0,
      incentive: 0,
      dividends: 0,
      validator_permit: 0,
      active: 0, // inactive
      netuid: 2,
      captured_at: "2026-06-27T00:00:00Z",
    },
  ];

  test("counts subnets/neurons/active/validators/miners and splits the signals", () => {
    const out = buildChainConsensus(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids {1, 2}
    assert.equal(out.neuron_count, 3);
    assert.equal(out.active_count, 2);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 2); // 3 - 1
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");

    // trust participates for the two non-zero rows.
    assert.equal(out.trust.count, 2);
    assert.equal(out.trust.mean, 0.7);
    assert.equal(out.consensus.count, 2);
    // incentive only the miner earns; dividends only the validator earns.
    assert.equal(out.incentive.count, 1);
    assert.equal(out.incentive.mean, 0.4);
    assert.equal(out.dividends.count, 1);
    assert.equal(out.dividends.mean, 0.5);
  });

  test("takes the newest captured_at across mixed epoch-ms / ISO stamps", () => {
    const out = buildChainConsensus([
      { trust: 0.5, netuid: 1, captured_at: 1_700_000_000_000 },
      { trust: 0.5, netuid: 1, captured_at: 1_700_000_001_000 },
    ]);
    assert.equal(out.captured_at, new Date(1_700_000_001_000).toISOString());
  });

  test("ignores an unparseable captured_at (invalid string or NaN number)", () => {
    const out = buildChainConsensus([
      { trust: 0.5, netuid: 1, captured_at: "not-a-date" },
      { trust: 0.5, netuid: 1, captured_at: Number.NaN },
    ]);
    assert.equal(out.captured_at, null);
  });

  test("coerces string netuid cells and rejects blank/null/invalid ones", () => {
    const out = buildChainConsensus([
      { trust: 0.5, netuid: "5" },
      { trust: 0.5, netuid: 5 }, // same subnet, not double-counted
      { trust: 0.5, netuid: null }, // never counts as subnet 0
      { trust: 0.5 }, // missing netuid
      { trust: 0.5, netuid: -3 }, // negative -> rejected by the >=0 guard
      { trust: 0.5, netuid: "x" }, // non-numeric -> NaN, rejected by isInteger
    ]);
    assert.equal(out.subnet_count, 1);
  });

  test("is schema-stable-zero on a cold store (no rows)", () => {
    assert.deepEqual(buildChainConsensus([]), {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      active_count: 0,
      validator_count: 0,
      miner_count: 0,
      captured_at: null,
      trust: null,
      consensus: null,
      incentive: null,
      dividends: null,
    });
  });

  test("treats a non-array argument as a cold store", () => {
    const out = buildChainConsensus(null);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.trust, null);
  });
});

describe("loadChainConsensus", () => {
  function captureD1(rows = []) {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return rows;
    };
    return { d1, calls };
  }

  test("reads every subnet's neurons in one pass — no netuid filter", async () => {
    const { d1, calls } = captureD1([
      { trust: 0.8, validator_permit: 1, active: 1, netuid: 1 },
      { trust: 0.6, validator_permit: 0, active: 1, netuid: 2 },
    ]);
    const data = await loadChainConsensus(d1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM neurons/);
    assert.doesNotMatch(calls[0].sql, /WHERE/);
    assert.deepEqual(calls[0].params, []);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.trust.count, 2);
  });

  test("returns a schema-stable null block on a cold D1", async () => {
    const { d1 } = captureD1([]);
    const data = await loadChainConsensus(d1);
    assert.equal(data.neuron_count, 0);
    assert.equal(data.trust, null);
    assert.equal(data.dividends, null);
  });
});

describe("GET /api/v1/chain/consensus", () => {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/consensus${q}`);

  test("aggregates the consensus signals across all subnets", async () => {
    const res = await handleRequest(
      req(),
      neuronsEnv([
        {
          trust: 0.8,
          consensus: 0.7,
          incentive: 0,
          dividends: 0.5,
          validator_permit: 1,
          active: 1,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 1);
    assert.equal(body.data.validator_count, 1);
    assert.equal(body.data.trust.count, 1);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("readNeuronsCacheStamp", () => {
  function stampEnv(results) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({ all: () => Promise.resolve({ results }) }) };
        },
      },
    };
  }

  test("returns the newest captured_at across all subnets as a string", async () => {
    assert.equal(
      await readNeuronsCacheStamp(
        stampEnv([{ captured_at: 1_700_000_000_000 }]),
      ),
      "1700000000000",
    );
  });

  test("returns null on a cold store (null or non-positive stamp)", async () => {
    assert.equal(
      await readNeuronsCacheStamp(stampEnv([{ captured_at: null }])),
      null,
    );
    assert.equal(
      await readNeuronsCacheStamp(stampEnv([{ captured_at: 0 }])),
      null,
    );
  });

  test("returns null when D1 is unbound (fallback rows)", async () => {
    assert.equal(await readNeuronsCacheStamp({}), null);
  });
});

describe("chain/consensus edge cache", () => {
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
      new Request("https://api.metagraph.sh/api/v1/chain/consensus"),
      neuronsEnv([{ trust: 0.5, validator_permit: 1, active: 1, netuid: 1 }]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(store.size, 1); // a non-null stamp cached the response
  });
});
