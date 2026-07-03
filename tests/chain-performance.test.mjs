import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainPerformance,
  scoreDistribution,
  loadChainPerformance,
} from "../src/chain-performance.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A network snapshot: neurons from two subnets, two validators + two miners, a
// skewed incentive/dividend distribution.
const ROWS = [
  {
    incentive: 0.6,
    dividends: 0.5,
    trust: 0.9,
    consensus: 0.8,
    validator_trust: 0.95,
    active: 1,
    validator_permit: 1,
    netuid: 7,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0.3,
    dividends: 0.1,
    trust: 0.7,
    consensus: 0.6,
    validator_trust: 0.85,
    active: 1,
    validator_permit: 1,
    netuid: 7,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0.1,
    dividends: 0,
    trust: 0.4,
    consensus: 0.3,
    validator_trust: 0,
    active: 1,
    validator_permit: 0,
    netuid: 12,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0,
    dividends: 0,
    trust: 0,
    consensus: 0,
    validator_trust: 0,
    active: 0,
    validator_permit: 0,
    netuid: 12,
    captured_at: 1_750_000_000_000,
  },
];

describe("scoreDistribution", () => {
  test("computes count/mean/min/max + nearest-rank percentiles over 0..1 scores", () => {
    const d = scoreDistribution([0, 0.4, 0.7, 0.9]);
    assert.equal(d.count, 4);
    assert.equal(d.min, 0);
    assert.equal(d.max, 0.9);
    assert.equal(d.mean, 0.5);
    assert.equal(d.p50, 0.4); // rank ceil(0.5·4)=2 → ascending[1]
    assert.equal(d.p90, 0.9);
    assert.equal(d.p10, 0);
  });

  test("drops null/NaN/blank cells, coerces numeric strings", () => {
    const d = scoreDistribution([0.5, null, "0.25", undefined, NaN, ""]);
    assert.equal(d.count, 2); // 0.5 and "0.25"
    assert.equal(d.min, 0.25);
    assert.equal(d.max, 0.5);
  });

  test("empty / all-null column → null (schema-stable)", () => {
    assert.equal(scoreDistribution([]), null);
    assert.equal(scoreDistribution([null, undefined, "x"]), null);
    assert.equal(scoreDistribution("not-an-array"), null);
  });
});

describe("buildChainPerformance", () => {
  test("counts subnets/neurons/validators/active and stamps the newest captured_at", () => {
    const out = buildChainPerformance(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids 7 and 12
    assert.equal(out.neuron_count, 4);
    assert.equal(out.validator_count, 2);
    assert.equal(out.active_count, 3);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("incentive concentration is over ALL neurons with a positive incentive", () => {
    const out = buildChainPerformance(ROWS);
    assert.equal(out.incentive.holders, 3); // 0.6/0.3/0.1 positive; the 0 dropped
    assert.ok(out.incentive.gini > 0);
    assert.equal(out.incentive.nakamoto_coefficient, 1); // 0.6 of total 1.0 > 50%
  });

  test("dividends concentration is over the VALIDATORS only", () => {
    const out = buildChainPerformance(ROWS);
    assert.equal(out.dividends.holders, 2); // only the two validators earn
    assert.equal(out.dividends.total, 0.6);
  });

  test("trust/consensus spread over all neurons; validator_trust over validators", () => {
    const out = buildChainPerformance(ROWS);
    assert.equal(out.trust.count, 4);
    assert.equal(out.consensus.count, 4);
    assert.equal(out.validator_trust.count, 2);
    assert.equal(out.trust.max, 0.9);
    assert.equal(out.validator_trust.min, 0.85);
  });

  test("subnet_count ignores null and non-integer netuid cells", () => {
    const out = buildChainPerformance([
      { incentive: 0.5, netuid: 7 },
      { incentive: 0.5, netuid: null }, // rawNetuid == null → skipped
      { incentive: 0.5, netuid: "abc" }, // non-integer → skipped
      { incentive: 0.5, netuid: -1 }, // negative → skipped
    ]);
    assert.equal(out.subnet_count, 1); // only netuid 7 counts
    assert.equal(out.neuron_count, 4);
  });

  test("accepts a string (ISO) captured_at, ignoring null/unparseable stamps", () => {
    const out = buildChainPerformance([
      { incentive: 0.2, captured_at: "2026-06-14T00:00:00.000Z" },
      { incentive: 0.3, captured_at: "2026-06-15T00:00:00.000Z" },
      { incentive: 0.1, captured_at: null }, // unstampable → ignored
      { incentive: 0.1, captured_at: "not-a-date" }, // unparseable → ignored
    ]);
    assert.equal(out.captured_at, "2026-06-15T00:00:00.000Z");
  });

  test("converts D1 string-typed epoch-millisecond captured_at to ISO strings", () => {
    const out = buildChainPerformance([
      { incentive: 0.2, captured_at: "1750000000000" },
      { incentive: 0.3, captured_at: "1750000060000" },
    ]);
    assert.equal(out.captured_at, "2025-06-15T15:07:40.000Z");
  });

  test("rejects invalid captured_at cells instead of leaking junk stamps", () => {
    for (const captured_at of [
      "0",
      "not-a-date",
      "9".repeat(400),
      -1,
      0,
      true,
      8_640_000_000_000_001,
      "8640000000000001",
    ]) {
      const out = buildChainPerformance([{ incentive: 0.1, captured_at }]);
      assert.equal(out.captured_at, null, `expected null for ${captured_at}`);
    }
  });

  test("cold/empty network → schema-stable zero (every metric null)", () => {
    const out = buildChainPerformance([]);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.captured_at, null);
    assert.equal(out.incentive, null);
    assert.equal(out.dividends, null);
    assert.equal(out.trust, null);
    assert.equal(out.consensus, null);
    assert.equal(out.validator_trust, null);
  });

  test("null-safe on junk rows", () => {
    const out = buildChainPerformance("nope");
    assert.equal(out.neuron_count, 0);
    assert.equal(out.incentive, null);
  });

  test("loadChainPerformance issues one un-filtered SELECT and shapes it", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainPerformance(d1);
    assert.match(seen.sql, /FROM neurons/);
    assert.doesNotMatch(seen.sql, /WHERE netuid/); // network-wide: no filter
    assert.deepEqual(seen.params, []);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.validator_count, 2);
  });
});

describe("GET /api/v1/chain/performance", () => {
  // The MAX(captured_at) cache stamp and the network neurons read both hit
  // `FROM neurons`, so route the stamp query first (mirrors chain/concentration).
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
    new Request(`https://api.metagraph.sh/api/v1/chain/performance${q}`);

  test("summarizes reward + score spread across all subnets", async () => {
    const res = await handleRequest(
      req(),
      neuronsEnv([
        {
          incentive: 0.6,
          dividends: 0.5,
          trust: 0.9,
          consensus: 0.8,
          validator_trust: 0.95,
          active: 1,
          validator_permit: 1,
          netuid: 1,
          captured_at: 1_700_000_000_000,
        },
        {
          incentive: 0.2,
          dividends: 0,
          trust: 0.4,
          consensus: 0.3,
          validator_trust: 0,
          active: 1,
          validator_permit: 0,
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
    assert.equal(body.data.incentive.holders, 2);
    assert.equal(body.data.trust.count, 2);
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), neuronsEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/performance edge cache", () => {
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
      new Request("https://api.metagraph.sh/api/v1/chain/performance"),
      neuronsEnv([
        {
          incentive: 0.6,
          trust: 0.9,
          validator_permit: 1,
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
