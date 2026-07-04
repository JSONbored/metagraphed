import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainCensus,
  ageDistribution,
  loadChainCensus,
} from "../src/chain-census.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A network snapshot: two subnets, a validator + a miner in immunity + an inactive
// miner, all captured at block 8454388.
const ROWS = [
  {
    netuid: 7,
    active: 1,
    validator_permit: 1,
    is_immunity_period: 0,
    registered_at_block: 8000000,
    block_number: 8454388,
    captured_at: 1_750_000_000_000,
  },
  {
    netuid: 7,
    active: 1,
    validator_permit: 0,
    is_immunity_period: 1,
    registered_at_block: 8454000,
    block_number: 8454388,
    captured_at: 1_750_000_000_000,
  },
  {
    netuid: 12,
    active: 0,
    validator_permit: 0,
    is_immunity_period: 0,
    registered_at_block: 7000000,
    block_number: 8454388,
    captured_at: 1_750_000_000_000,
  },
];

describe("ageDistribution", () => {
  test("computes count/mean/min/max + nearest-rank p50/p90", () => {
    const d = ageDistribution([100, 300, 200]);
    assert.equal(d.count, 3);
    assert.equal(d.min_blocks, 100);
    assert.equal(d.max_blocks, 300);
    assert.equal(d.mean_blocks, 200);
    assert.equal(d.p50_blocks, 200); // rank ceil(0.5·3)=2 → ascending[1]
    assert.equal(d.p90_blocks, 300);
  });

  test("drops negative/non-finite ages; empty → null", () => {
    const d = ageDistribution([50, -1, NaN, 150]);
    assert.equal(d.count, 2);
    assert.equal(ageDistribution([]), null);
    assert.equal(ageDistribution([-5, NaN]), null);
    assert.equal(ageDistribution("not-an-array"), null);
  });
});

describe("buildChainCensus", () => {
  test("counts population, split, rates, and the newest height/stamp", () => {
    const out = buildChainCensus(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.neuron_count, 3);
    assert.equal(out.active_count, 2);
    assert.equal(out.inactive_count, 1);
    assert.equal(out.immunity_count, 1);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 2);
    assert.equal(out.active_rate, 0.6667);
    assert.equal(out.immunity_rate, 0.3333);
    assert.equal(out.latest_block, 8454388);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("registration age = newest height − registered_at_block", () => {
    const out = buildChainCensus(ROWS);
    // ages: 454388, 388, 1454388
    assert.equal(out.registration_age.count, 3);
    assert.equal(out.registration_age.min_blocks, 388);
    assert.equal(out.registration_age.max_blocks, 1454388);
  });

  test("drops a future registered_at_block (age would be negative)", () => {
    const out = buildChainCensus([
      { registered_at_block: 100, block_number: 200 }, // age 100
      { registered_at_block: 300, block_number: 200 }, // future → dropped
    ]);
    assert.equal(out.registration_age.count, 1);
    assert.equal(out.registration_age.min_blocks, 100);
  });

  test("coerces numeric-string cells; strict netuid rejects blank", () => {
    const out = buildChainCensus([
      {
        netuid: "7",
        active: "1",
        validator_permit: "1",
        is_immunity_period: "1",
        registered_at_block: "100",
        block_number: "200",
      },
      { netuid: "", active: 1 }, // blank netuid → not subnet 0, but still a neuron
    ]);
    assert.equal(out.subnet_count, 1); // only netuid 7
    assert.equal(out.neuron_count, 2);
    assert.equal(out.active_count, 2);
    assert.equal(out.validator_count, 1);
    assert.equal(out.immunity_count, 1);
  });

  test("accepts a string epoch-ms captured_at; rejects a negative-number block", () => {
    const out = buildChainCensus([
      {
        netuid: 3,
        block_number: -1, // negative number → rejected by toInt
        registered_at_block: 100,
        captured_at: "1750000000000", // string epoch-ms → coerced
      },
    ]);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(out.latest_block, null); // -1 rejected → no capture height
    assert.equal(out.registration_age, null); // no height → no age
  });

  test("no capture height → registration_age null", () => {
    const out = buildChainCensus([
      { netuid: 1, active: 1, registered_at_block: 100 }, // no block_number
    ]);
    assert.equal(out.latest_block, null);
    assert.equal(out.registration_age, null);
  });

  test("cold/empty → schema-stable zeroed card", () => {
    const out = buildChainCensus([]);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.active_rate, null);
    assert.equal(out.immunity_rate, null);
    assert.equal(out.latest_block, null);
    assert.equal(out.captured_at, null);
    assert.equal(out.registration_age, null);
  });

  test("null-safe on junk rows", () => {
    const out = buildChainCensus("nope");
    assert.equal(out.neuron_count, 0);
    assert.equal(out.registration_age, null);
  });

  test("loadChainCensus issues one un-filtered SELECT and shapes it", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainCensus(d1);
    assert.match(seen.sql, /FROM neurons/);
    assert.doesNotMatch(seen.sql, /WHERE netuid/);
    assert.deepEqual(seen.params, []);
    assert.equal(out.neuron_count, 3);
    assert.equal(out.immunity_count, 1);
  });
});

describe("GET /api/v1/chain/census", () => {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/census${q}`);

  test("summarizes the network population", async () => {
    const res = await handleRequest(req(), neuronsEnv(ROWS), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.neuron_count, 3);
    assert.equal(body.data.active_count, 2);
    assert.equal(body.data.immunity_count, 1);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/census edge cache", () => {
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
      new Request("https://api.metagraph.sh/api/v1/chain/census"),
      neuronsEnv([
        {
          netuid: 1,
          active: 1,
          block_number: 100,
          registered_at_block: 50,
          captured_at: 1_700_000_000_000,
        },
      ]),
      { waitUntil: (promise) => promise },
    );
    assert.equal(res.status, 200);
    assert.equal(store.size, 1);
  });
});
