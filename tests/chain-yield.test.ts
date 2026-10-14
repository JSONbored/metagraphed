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

// A network snapshot: two validators + two miners across independent Alpha
// tokens. stake_tao is effective voting weight, so it cannot qualify holdings.
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
    assert.equal(d.p50, 0.05); // middle of [0.04, 0.05, 0.1]
    assert.ok(Math.abs(d.mean - 0.063333333) < 1e-6);
    assert.equal(d.p10, 0.04);
    assert.equal(d.p25, 0.04);
    assert.equal(d.p75, 0.1);
    assert.equal(d.p90, 0.1);
  });

  test("averages the two middle values for an even count", () => {
    const d = yieldDistribution([0.2, 0.4])!;
    assert.equal(d.p50, 0.3); // (0.2 + 0.4) / 2
  });

  test("drops null cells; empty / all-null → null (schema-stable)", () => {
    const d = yieldDistribution([0.5, null, 0.25, undefined])!;
    assert.equal(d.count, 2);
    assert.equal(yieldDistribution([]), null);
    assert.equal(yieldDistribution([null, null]), null);
    assert.equal(
      yieldDistribution("not-an-array" as unknown as number[]),
      null,
    );
  });
});

function assertUnknownFinancials(out: ReturnType<typeof buildChainYield>) {
  assert.equal(out.schema_version, 2);
  assert.equal(out.total_stake_alpha, null);
  assert.equal(out.total_emission_alpha, null);
  assert.equal(out.network_yield, null);
  assert.equal(out.validator_yield, null);
  assert.equal(out.miner_yield, null);
  assert.equal(out.distribution, null);
  assert.deepEqual(out.degraded, { reason: "holdings_unqualified" });
}

describe("buildChainYield", () => {
  test("counts subnet observations and stamps the newest captured_at", () => {
    const newest = 1_750_000_001_000;
    const out = buildChainYield([...ROWS, { ...ROWS[0], captured_at: newest }]);
    assertUnknownFinancials(out);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.neuron_count, 5);
    assert.equal(out.validator_count, 3);
    assert.equal(out.miner_count, 2);
    assert.equal(out.captured_at, new Date(newest).toISOString());
  });

  // Root observations must not affect the non-root card, including freshness.
  const ROOT_ROW = {
    validator_permit: 1,
    stake_tao: 6_613_430,
    emission_tao: 9.5,
    netuid: 0,
    captured_at: 1_750_000_100_000,
  };

  test("drops root rows from counts and captured_at", () => {
    const withRoot = buildChainYield([ROOT_ROW, ...ROWS]);
    assert.deepEqual(withRoot, buildChainYield(ROWS));
    assertUnknownFinancials(withRoot);
    assert.equal(withRoot.subnet_count, 2);
    assert.equal(withRoot.neuron_count, 4);
    assert.equal(withRoot.validator_count, 2);
  });

  test("a root-only snapshot has no non-root observations or timestamp", () => {
    const out = buildChainYield([ROOT_ROW]);
    assertUnknownFinancials(out);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.validator_count, 0);
    assert.equal(out.miner_count, 0);
    assert.equal(out.captured_at, null);
  });

  test("independent Alpha tokens never become a chain total or return rate", () => {
    const out = buildChainYield(ROWS);
    assertUnknownFinancials(out);
    // The tempting 80 / 1600 calculation mixes two tokens and weighted stake.
    assert.equal(out.neuron_count, 4);
    assert.equal(out.subnet_count, 2);
  });

  test("one subnet's weighted stake still cannot qualify investment yield", () => {
    const out = buildChainYield(ROWS.filter((row) => row.netuid === 7));
    assertUnknownFinancials(out);
    assert.equal(out.neuron_count, 2);
    assert.equal(out.validator_count, 2);
    assert.equal(out.subnet_count, 1);
  });

  test("subnet_count accepts real ints + numeric strings, rejects blank/null/non-numeric", () => {
    const out = buildChainYield([
      { netuid: 7 },
      { netuid: "12" },
      { netuid: null },
      { netuid: "" },
      { netuid: false },
      { netuid: "abc" },
      { netuid: -1 },
      { netuid: 1.5 },
    ]);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.neuron_count, 2);
  });

  test("accepts ISO captured_at, ignoring null/unparseable stamps", () => {
    const out = buildChainYield([
      { netuid: 7, captured_at: "2026-06-14T00:00:00.000Z" },
      { netuid: 7, captured_at: "2026-06-15T00:00:00.000Z" },
      { netuid: 7, captured_at: null },
      { netuid: 7, captured_at: "not-a-date" },
    ]);
    assert.equal(out.captured_at, "2026-06-15T00:00:00.000Z");
  });

  test("accepts epoch-millisecond string captured_at values from Postgres", () => {
    const newest = 1_750_000_000_000;
    const out = buildChainYield([
      { netuid: 7, captured_at: "1700000000000" },
      { netuid: 7, captured_at: String(newest) },
    ]);
    assert.equal(out.captured_at, new Date(newest).toISOString());
  });

  test("ignores an all-digit captured_at string outside Date's representable range", () => {
    const out = buildChainYield([
      { netuid: 7, captured_at: "100000000000000000000" },
      { netuid: 7, captured_at: "1750000000000" },
    ]);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("ignores out-of-range numeric captured_at values", () => {
    const out = buildChainYield([
      { netuid: 7, captured_at: 100_000_000_000_000_000_000 },
      { netuid: 7, captured_at: 1_750_000_000_000 },
    ]);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("numeric-string role cells retain observations despite unreadable financial cells", () => {
    const out = buildChainYield([
      {
        validator_permit: "1",
        stake_tao: "200",
        emission_tao: "20",
        netuid: 3,
      },
      {
        validator_permit: "0",
        stake_tao: "junk",
        emission_tao: "junk",
        netuid: 3,
      },
    ]);
    assert.equal(out.neuron_count, 2);
    assert.equal(out.validator_count, 1);
    assert.equal(out.miner_count, 1);
    assertUnknownFinancials(out);
  });

  test("invalid weighted-stake and emission cells do not erase neuron observations", () => {
    for (const invalid of ["", "   ", null, -1, "junk", Infinity]) {
      for (const field of ["stake_tao", "emission_tao"]) {
        const out = buildChainYield([
          { netuid: 1, stake_tao: 10, emission_tao: 2, [field]: invalid },
        ]);
        assert.equal(out.neuron_count, 1, `${field}=${String(invalid)}`);
        assertUnknownFinancials(out);
      }
    }
  });

  test("blank-emission observations never produce a denominator or return rate", () => {
    const out = buildChainYield([
      { stake_tao: 100, emission_tao: "   ", netuid: 1, validator_permit: 0 },
      { stake_tao: 100, emission_tao: 10, netuid: 1, validator_permit: 0 },
    ]);
    assert.equal(out.neuron_count, 2);
    assert.equal(out.miner_count, 2);
    assertUnknownFinancials(out);
  });

  test("subnet_count retains subnets whose voting-weight cell is unavailable", () => {
    const out = buildChainYield([
      { stake_tao: "", emission_tao: 5, netuid: 7 },
      { stake_tao: 10, emission_tao: 1, netuid: 12 },
    ]);
    assert.equal(out.subnet_count, 2);
    assert.equal(out.neuron_count, 2);
  });

  test("cold/empty network has zero observations and unknown financials", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildChainYield(rows);
      assert.equal(out.subnet_count, 0);
      assert.equal(out.neuron_count, 0);
      assert.equal(out.captured_at, null);
      assertUnknownFinancials(out);
    }
  });

  test("null-safe on junk rows", () => {
    const out = buildChainYield("nope" as unknown as Row[]);
    assert.equal(out.neuron_count, 0);
    assertUnknownFinancials(out);
  });

  test("thousands of precise observations still cannot qualify cross-token sums", () => {
    const rows: Row[] = Array.from({ length: 5000 }, (_, i) => ({
      validator_permit: 0,
      stake_tao: 1234.987654321 + i * 0.000000001,
      emission_tao: 12.345678901 + i * 0.000000001,
      netuid: (i % 128) + 1,
      captured_at: 1_750_000_000_000,
    }));
    const out = buildChainYield(rows);
    assert.equal(out.neuron_count, 5000);
    assert.equal(out.subnet_count, 128);
    assertUnknownFinancials(out);
  });

  test("loadChainYield reads every non-root subnet in one SELECT and shapes it", async () => {
    let seen: Row | undefined;
    const runner = async (sql: string, params: unknown[]) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadChainYield(runner);
    assert.match(seen!.sql, /FROM neurons/);
    assert.match(seen!.sql, /WHERE netuid != 0/);
    assert.deepEqual(seen!.params, []);
    assert.deepEqual(out, buildChainYield(ROWS));
    assertUnknownFinancials(out);
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
  // removed, since the `neurons` table it read was fully dropped in #4772 (it
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
