import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainYield,
  yieldDistribution,
  loadChainYield,
} from "../src/chain-yield.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

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
    const d = yieldDistribution([0.1, 0.04, 0.05])!;
    assert.equal(d.count, 3);
    assert.equal(d.min, 0.04);
    assert.equal(d.max, 0.1);
    assert.equal(d.median, 0.05); // middle of [0.04, 0.05, 0.1]
    assert.ok(Math.abs(d.mean - 0.063333333) < 1e-6);
    assert.equal(d.p10, 0.04);
    assert.equal(d.p90, 0.1);
  });

  test("averages the two middle values for an even count", () => {
    const d = yieldDistribution([0.2, 0.4])!;
    assert.equal(d.median, 0.3); // (0.2 + 0.4) / 2
  });

  test("drops null cells; empty / all-null → null (schema-stable)", () => {
    const d = yieldDistribution([0.5, null, 0.25, null])!;
    assert.equal(d.count, 2);
    assert.equal(yieldDistribution([]), null);
    assert.equal(yieldDistribution([null, null]), null);
    assert.equal(
      yieldDistribution("not-an-array" as unknown as number[]),
      null,
    );
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
    assert.ok(Math.abs(out.validator_yield! - 70 / 1500) < 1e-6);
    assert.equal(out.miner_yield, 0.1); // 10 / 100
  });

  test("distribution excludes the zero-stake neuron", () => {
    const out = buildChainYield(ROWS);
    assert.equal(out.distribution!.count, 3); // the 0-stake miner is dropped
    assert.equal(out.distribution!.max, 0.1);
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

  test("accepts epoch-millisecond string captured_at values from Postgres", () => {
    const newest = 1_750_000_000_000;
    const out = buildChainYield([
      { stake_tao: 1, emission_tao: 0, captured_at: "1700000000000" },
      { stake_tao: 1, emission_tao: 0, captured_at: String(newest) },
    ]);
    assert.equal(out.captured_at, new Date(newest).toISOString());
  });

  test("ignores an all-digit captured_at string outside Date's representable range", () => {
    // A digit string so large it represents a date beyond JS Date's
    // +/-8.64e15ms range -- Number(value) stays finite, but
    // new Date(ms).getTime() is NaN, so this must fall through rather
    // than return an invalid timestamp.
    const out = buildChainYield([
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: "100000000000000000000",
      },
      {
        stake_tao: 1,
        emission_tao: 0,
        captured_at: "1750000000000",
      },
    ]);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
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
    const out = buildChainYield("nope" as unknown as Row[]);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.network_yield, null);
    assert.equal(out.distribution, null);
  });

  test("sums thousands of rows in exact rao space, not compounding float error (#2922)", () => {
    // Each row's stake carries a real sub-TAO fractional component (not a
    // round number) -- plain `+=` float accumulation across many rows would
    // drift from the true sum. Summing in rao BigInt space must not.
    const rows: Row[] = [];
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
    let seen: Row | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainYield(d1);
    assert.match(seen!.sql, /FROM neurons/);
    assert.doesNotMatch(seen!.sql, /WHERE netuid/); // network-wide: no filter
    assert.deepEqual(seen!.params, []);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.network_yield, 0.05);
  });
});

describe("GET /api/v1/chain/yield", () => {
  // The MAX(captured_at) cache stamp and the network neurons read both hit
  // `FROM neurons`, so route the stamp query first (mirrors chain/performance).
  function neuronsEnv(rows: Row[]) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
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

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      neuronsEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/yield edge cache", () => {
  // `caches` is `declare const caches: CacheStorage` -- a module-scope const,
  // not a `globalThis` property -- so stubbing/restoring it for a test needs
  // this cast (matches workers/request-handlers/analytics.ts's own precedent).
  const globalWithCaches = globalThis as unknown as { caches: Row };
  let originalCaches: Row;
  afterEach(() => {
    globalWithCaches.caches = originalCaches;
  });

  // #5358: chain/yield no longer reads D1 for its edge-cache stamp — the
  // neurons-tier captured_at stamp it used to bust on (readNeuronsCacheStamp) was
  // removed, since the D1 `neurons` table it read was fully dropped in #4772 (it
  // had been reading a permanently-empty/nonexistent source and returning a
  // frozen stamp ever since). It now busts on the same shared health-cron
  // `last_run_at` KV value every sibling Postgres-tier analytics route already
  // uses.
  function controlEnv(lastRunAt: string | null) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          if (key !== "health:meta") return null;
          return lastRunAt ? { last_run_at: lastRunAt } : null;
        },
      },
    };
  }

  // A Map-backed stand-in for the Workers cache so withEdgeCache actually engages.
  function mockCacheStore() {
    const store = new Map<string, Response>();
    return {
      store,
      install() {
        globalWithCaches.caches = {
          default: {
            async match(request: Request) {
              const cached = store.get(request.url);
              return cached ? cached.clone() : undefined;
            },
            async put(request: Request, response: Response) {
              store.set(request.url, response.clone());
            },
          },
        };
      },
    };
  }

  test("engages the edge cache, busting on the health-cron last_run_at stamp", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCacheStore();
    cache.install();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/yield"),
      controlEnv("2026-06-18T00:00:00.000Z") as unknown as Env,
      { waitUntil: (promise: Promise<unknown>) => promise },
    );
    assert.equal(res.status, 200);
    // A warm stamp + 200 means the response was cached: proof the default
    // health-cron stamp resolver ran and returned a real last_run_at.
    assert.equal(cache.store.size, 1);
  });

  test("skips the cache entirely when the health stamp is cold", async () => {
    originalCaches = globalWithCaches.caches;
    const cache = mockCacheStore();
    cache.install();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/yield"),
      controlEnv(null) as unknown as Env,
      { waitUntil: (promise: Promise<unknown>) => promise },
    );
    assert.equal(res.status, 200);
    // A cold/absent last_run_at must never seed the edge cache (mirrors the
    // overlay cache's own `if (lastRunAt)` guard) — a cold-KV response can
    // never poison a stale entry.
    assert.equal(cache.store.size, 0);
  });
});
