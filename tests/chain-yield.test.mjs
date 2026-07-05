import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainYield,
  yieldDistribution,
  loadChainYield,
} from "../src/chain-yield.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A network snapshot: two validators + two miners across two subnets, one miner
// with zero stake (excluded from the return-rate distribution).
const ROWS = [
  {
    validator_permit: 1,
    stake_tao: 1000,
    emission_tao: 50,
    netuid: 7,
    captured_at: 1_750_000_000_000,
  },
  {
    validator_permit: 1,
    stake_tao: 500,
    emission_tao: 20,
    netuid: 7,
    captured_at: 1_750_000_000_000,
  },
  {
    validator_permit: 0,
    stake_tao: 100,
    emission_tao: 10,
    netuid: 12,
    captured_at: 1_750_000_000_000,
  },
  {
    validator_permit: 0,
    stake_tao: 0,
    emission_tao: 0,
    netuid: 12,
    captured_at: 1_750_000_000_000,
  },
];

describe("yieldDistribution", () => {
  test("computes count/mean/median/min/max + nearest-rank percentiles", () => {
    const d = yieldDistribution([0.1, 0.04, 0.05]);
    assert.equal(d.count, 3);
    assert.equal(d.min, 0.04);
    assert.equal(d.max, 0.1);
    assert.equal(d.median, 0.05); // middle of [0.04, 0.05, 0.1]
    assert.ok(Math.abs(d.mean - 0.063333333) < 1e-6);
    assert.equal(d.p10, 0.04);
    assert.equal(d.p90, 0.1);
  });

  test("averages the two middle values for an even count", () => {
    const d = yieldDistribution([0.2, 0.4]);
    assert.equal(d.median, 0.3); // (0.2 + 0.4) / 2
  });

  test("drops null cells; empty / all-null → null (schema-stable)", () => {
    const d = yieldDistribution([0.5, null, 0.25, null]);
    assert.equal(d.count, 2);
    assert.equal(yieldDistribution([]), null);
    assert.equal(yieldDistribution([null, null]), null);
    assert.equal(yieldDistribution("not-an-array"), null);
  });
});

describe("buildChainYield", () => {
  test("counts subnets/neurons/validators/miners and stamps the newest captured_at", () => {
    const out = buildChainYield(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids 7 and 12
    assert.equal(out.neuron_count, 4);
    assert.equal(out.validator_count, 2);
    assert.equal(out.miner_count, 2);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("aggregate network return and the validator/miner split", () => {
    const out = buildChainYield(ROWS);
    assert.equal(out.total_stake_tao, 1600);
    assert.equal(out.total_emission_tao, 80);
    assert.equal(out.network_yield, 0.05); // 80 / 1600
    assert.ok(Math.abs(out.validator_yield - 70 / 1500) < 1e-6);
    assert.equal(out.miner_yield, 0.1); // 10 / 100
  });

  test("distribution excludes the zero-stake neuron", () => {
    const out = buildChainYield(ROWS);
    assert.equal(out.distribution.count, 3); // the 0-stake miner is dropped
    assert.equal(out.distribution.max, 0.1);
  });

  test("subnet_count accepts real ints + numeric strings, rejects blank/null/non-numeric", () => {
    const out = buildChainYield([
      { stake_tao: 1, emission_tao: 0, netuid: 7 }, // integer
      { stake_tao: 1, emission_tao: 0, netuid: "12" }, // numeric string → 12
      { stake_tao: 1, emission_tao: 0, netuid: null }, // dropped
      { stake_tao: 1, emission_tao: 0, netuid: "" }, // blank → NOT subnet 0
      { stake_tao: 1, emission_tao: 0, netuid: false }, // false → NOT subnet 0
      { stake_tao: 1, emission_tao: 0, netuid: "abc" }, // non-numeric → dropped
      { stake_tao: 1, emission_tao: 0, netuid: -1 }, // negative → dropped
      { stake_tao: 1, emission_tao: 0, netuid: 1.5 }, // non-integer → dropped
    ]);
    assert.equal(out.subnet_count, 2); // only 7 and 12 — never a spurious subnet 0
    assert.equal(out.neuron_count, 8);
  });

  test("accepts a string (ISO) captured_at, ignoring null/unparseable stamps", () => {
    const out = buildChainYield([
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: "2026-06-14T00:00:00.000Z",
      },
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: "2026-06-15T00:00:00.000Z",
      },
      { stake_tao: 1, emission_tao: 0, captured_at: null }, // ignored
      { stake_tao: 1, emission_tao: 0, captured_at: "not-a-date" }, // ignored
    ]);
    assert.equal(out.captured_at, "2026-06-15T00:00:00.000Z");
  });

  test("ignores out-of-range numeric captured_at values", () => {
    const out = buildChainYield([
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: 100_000_000_000_000_000_000,
      },
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: 1_750_000_000_000,
      },
    ]);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("coerces numeric-string stake/emission cells from D1", () => {
    const out = buildChainYield([
      {
        validator_permit: "1",
        stake_tao: "200",
        emission_tao: "20",
        netuid: 3,
      },
      {
        validator_permit: 0,
        stake_tao: "junk",
        emission_tao: "junk",
        netuid: 3,
      },
    ]);
    assert.equal(out.neuron_count, 1);
    assert.equal(out.total_stake_tao, 200);
    assert.equal(out.network_yield, 0.1);
    assert.equal(out.validator_count, 1);
  });

  test("reject blank stake_tao/emission_tao cells that coerce to 0", () => {
    for (const blank of ["", "   "]) {
      const skippedStake = buildChainYield([
        { stake_tao: blank, emission_tao: 2, netuid: 1 },
      ]);
      assert.equal(
        skippedStake.neuron_count,
        0,
        `stake ${JSON.stringify(blank)}`,
      );

      const blankEmission = buildChainYield([
        { stake_tao: 10, emission_tao: blank, netuid: 1 },
      ]);
      assert.equal(blankEmission.neuron_count, 1);
      assert.equal(blankEmission.total_emission_tao, 0);
      assert.equal(blankEmission.network_yield, null);
    }

    const nullStake = buildChainYield([
      { stake_tao: null, emission_tao: 2, netuid: 1 },
    ]);
    assert.equal(nullStake.neuron_count, 0);

    const negativeStake = buildChainYield([
      { stake_tao: -1, emission_tao: 2, netuid: 1 },
    ]);
    assert.equal(negativeStake.neuron_count, 0);
  });

  test("network_yield ignores blank-emission stake in the aggregate denominator", () => {
    const out = buildChainYield([
      { stake_tao: 100, emission_tao: "   ", netuid: 1, validator_permit: 0 },
      { stake_tao: 100, emission_tao: 10, netuid: 1, validator_permit: 0 },
    ]);
    assert.equal(out.total_stake_tao, 200);
    assert.equal(out.total_emission_tao, 10);
    assert.equal(out.network_yield, 0.1);
    assert.equal(out.miner_yield, 0.1);
  });

  test("subnet_count ignores skipped blank-stake rows", () => {
    const out = buildChainYield([
      { stake_tao: "", emission_tao: 5, netuid: 7 },
      { stake_tao: 10, emission_tao: 1, netuid: 12 },
    ]);
    assert.equal(out.subnet_count, 1);
    assert.equal(out.neuron_count, 1);
  });

  test("cold/empty network → schema-stable zero (yields + distribution null)", () => {
    const out = buildChainYield([]);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.captured_at, null);
    assert.equal(out.total_stake_tao, 0);
    assert.equal(out.network_yield, null);
    assert.equal(out.validator_yield, null);
    assert.equal(out.miner_yield, null);
    assert.equal(out.distribution, null);
  });

  test("null-safe on junk rows", () => {
    const out = buildChainYield("nope");
    assert.equal(out.neuron_count, 0);
    assert.equal(out.network_yield, null);
    assert.equal(out.distribution, null);
  });

  test("sums thousands of rows in exact rao space, not compounding float error (#2922)", () => {
    // Each row's stake carries a real sub-TAO fractional component (not a
    // round number) -- plain `+=` float accumulation across many rows would
    // drift from the true sum. Summing in rao BigInt space must not.
    const rows = [];
    let expectedTotalRao = 0n;
    for (let i = 0; i < 5000; i += 1) {
      const stakeTao = 1234.987654321 + i * 0.000000001;
      rows.push({
        validator_permit: 0,
        stake_tao: stakeTao,
        emission_tao: 0,
        netuid: i % 129,
        captured_at: 1_750_000_000_000,
      });
      expectedTotalRao += BigInt(Math.round(stakeTao * 1e9));
    }
    const out = buildChainYield(rows);
    const expectedTotal =
      Number(expectedTotalRao / 1_000_000_000n) +
      Number(expectedTotalRao % 1_000_000_000n) / 1e9;
    assert.equal(out.total_stake_tao, Math.round(expectedTotal * 1e9) / 1e9);
  });

  test("loadChainYield issues one un-filtered SELECT and shapes it", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainYield(d1);
    assert.match(seen.sql, /FROM neurons/);
    assert.doesNotMatch(seen.sql, /WHERE netuid/); // network-wide: no filter
    assert.deepEqual(seen.params, []);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.network_yield, 0.05);
  });
});

describe("GET /api/v1/chain/yield", () => {
  // The MAX(captured_at) cache stamp and the network neurons read both hit
  // `FROM neurons`, so route the stamp query first (mirrors chain/performance).
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

  test("summarizes network yield across all subnets", async () => {
    const res = await handleRequest(
      req(),
      neuronsEnv([
        {
          validator_permit: 1,
          stake_tao: 1000,
          emission_tao: 50,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
        {
          validator_permit: 0,
          stake_tao: 100,
          emission_tao: 10,
          netuid: 2,
          captured_at: 1_700_000_000_000,
        },
      ]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.neuron_count, 2);
    assert.equal(body.data.validator_count, 1);
    assert.ok(Math.abs(body.data.network_yield - 60 / 1100) < 1e-6);
    assert.equal(body.data.distribution.count, 2);
    assert.equal(body.meta.source, "metagraph-snapshot");
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
          validator_permit: 1,
          stake_tao: 1000,
          emission_tao: 50,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
      ]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    // A non-null stamp resolver + 200 means the response was cached: proof the
    // stamp resolver arrow ran and returned the network captured_at.
    assert.equal(store.size, 1);
  });
});
