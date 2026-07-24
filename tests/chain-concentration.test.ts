import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainConcentration,
  loadChainConcentration,
} from "../src/concentration.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

// buildChainConcentration reuses the (separately tested) computeConcentration /
// groupByEntity primitives, so these tests target the NETWORK-specific wiring:
// subnet_count, the cross-subnet coldkey collapse, the validator lens, the newest
// stamp, and null-safety. A three-row, two-subnet fixture where one coldkey spans
// both subnets exercises every network-only branch at once.
const NET_ROWS = [
  {
    stake_tao: 10,
    emission_tao: 1,
    coldkey: "ck-a",
    validator_permit: 1,
    netuid: 1,
    captured_at: "2026-06-27T00:00:00Z",
  },
  {
    // same coldkey as row 1 but a DIFFERENT subnet — collapses to one entity.
    stake_tao: 20,
    emission_tao: 2,
    coldkey: "ck-a",
    validator_permit: 1,
    netuid: 2,
    captured_at: "2026-06-27T00:00:00Z",
  },
  {
    stake_tao: 30,
    emission_tao: 3,
    coldkey: "ck-b",
    validator_permit: 0,
    netuid: 2,
    captured_at: "2026-06-27T00:00:00Z",
  },
];

describe("buildChainConcentration", () => {
  test("counts distinct subnets and aggregates coldkeys across them", () => {
    const out = buildChainConcentration(NET_ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.subnet_count, 2); // netuids {1, 2}
    assert.equal(out.neuron_count, 3);
    assert.equal(out.entity_count, 2); // coldkeys {ck-a, ck-b}
    assert.equal(out.uids_per_entity, 1.5); // 3 / 2
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");

    // per-UID lens: three holders (10, 20, 30), total 60.
    assert.equal(out.stake!.holders, 3);
    assert.equal(out.stake!.total, 60);

    // entity lens: ck-a's two subnets collapse to 30, so the network control
    // distribution is a uniform {30, 30} — two holders, Gini 0.
    assert.equal(out.entity_stake!.holders, 2);
    assert.equal(out.entity_stake!.total, 60);
    assert.equal(out.entity_stake!.gini, 0);
    assert.equal(out.entity_emission!.holders, 2);
    assert.equal(out.entity_emission!.total, 6);

    // validator lens: only the two permit=1 rows (10 + 20 = 30).
    assert.equal(out.validator_stake!.holders, 2);
    assert.equal(out.validator_stake!.total, 30);
  });

  test("sums one coldkey's per-UID stake and the network total in exact rao space (#2922)", () => {
    // groupByEntity's per-entity pre-sum and computeConcentration's own
    // distribution total both now accumulate in rao-BigInt space rather than
    // plain float `+=` (metagraphed#2922). The `total` field is only surfaced
    // at 4dp, so a handful of thousand rows won't visibly drift past that
    // rounding either way -- this asserts the rao-exact value the BigInt path
    // is now guaranteed to produce, rather than relying on rounding to mask
    // (or reveal) any accumulation error.
    const rows = [];
    let expectedTotalRao = 0n;
    for (let i = 0; i < 5000; i += 1) {
      const stakeTao = 1234.987654321 + i * 0.000000001;
      rows.push({
        stake_tao: stakeTao,
        emission_tao: 0,
        coldkey: "ck-precision",
        validator_permit: 0,
        netuid: i,
      });
      expectedTotalRao += BigInt(Math.round(stakeTao * 1e9));
    }
    const out = buildChainConcentration(rows);
    const expectedTotal =
      Number(expectedTotalRao / 1_000_000_000n) +
      Number(expectedTotalRao % 1_000_000_000n) / 1e9;
    const rounded = Math.round(expectedTotal * 1e4) / 1e4; // computeConcentration rounds `total` to 4dp
    // one coldkey -> one entity, so the entity total equals the per-UID total.
    assert.equal(out.stake!.total, rounded);
    assert.equal(out.entity_stake!.total, rounded);
    assert.equal(out.entity_stake!.holders, 1);
  });

  test("takes the newest captured_at across mixed epoch-ms / ISO stamps", () => {
    const out = buildChainConcentration([
      { stake_tao: 5, coldkey: "a", netuid: 1, captured_at: 1_700_000_000_000 },
      { stake_tao: 5, coldkey: "b", netuid: 1, captured_at: 1_700_000_001_000 },
    ]);
    assert.equal(out.captured_at, new Date(1_700_000_001_000).toISOString());
  });

  test("converts D1 string-typed epoch-millisecond captured_at to ISO strings", () => {
    const out = buildChainConcentration([
      {
        stake_tao: 5,
        coldkey: "a",
        netuid: 1,
        captured_at: "1750000060000",
      },
    ]);
    assert.equal(out.captured_at, "2025-06-15T15:07:40.000Z");
  });

  test("validator lens is null when no UID holds a validator permit", () => {
    const out = buildChainConcentration([
      { stake_tao: 10, coldkey: "a", validator_permit: 0, netuid: 1 },
      { stake_tao: 20, coldkey: "b", validator_permit: 0, netuid: 1 },
    ]);
    assert.equal(out.validator_stake, null);
    assert.equal(out.stake!.holders, 2);
  });

  test("coerces string netuid cells and rejects blank/null/invalid ones", () => {
    const out = buildChainConcentration([
      { stake_tao: 1, coldkey: "a", netuid: "5" }, // numeric string from D1
      { stake_tao: 1, coldkey: "b", netuid: 5 }, // same subnet, not double-counted
      { stake_tao: 1, coldkey: "c", netuid: null }, // never counts as subnet 0
      { stake_tao: 1, coldkey: "d" }, // missing netuid entirely
      { stake_tao: 1, coldkey: "e", netuid: "" }, // blank -> must not coerce to subnet 0
      { stake_tao: 1, coldkey: "f", netuid: "   " }, // whitespace-only -> same
      { stake_tao: 1, coldkey: "g", netuid: -3 }, // negative -> rejected by the >=0 guard
      { stake_tao: 1, coldkey: "h", netuid: "x" }, // non-numeric -> NaN, rejected by isInteger
    ]);
    assert.equal(out.subnet_count, 1); // still only subnet 5
  });

  test("counts root subnet (netuid 0) when explicitly present", () => {
    const out = buildChainConcentration([
      { stake_tao: 1, coldkey: "a", netuid: 0 },
      { stake_tao: 1, coldkey: "b", netuid: "0" },
      { stake_tao: 1, coldkey: "c", netuid: 7 },
    ]);
    assert.equal(out.subnet_count, 2); // root + subnet 7
  });

  test("is schema-stable-zero on a cold store (no rows)", () => {
    assert.deepEqual(buildChainConcentration([]), {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });

  test("treats a non-array argument as a cold store", () => {
    const out = buildChainConcentration(null);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.stake, null);
  });

  test("tolerates junk rows (null, non-object) and still measures the real ones", () => {
    const out = buildChainConcentration([
      null,
      "nope",
      {
        stake_tao: 10,
        emission_tao: 1,
        coldkey: "ck-a",
        netuid: 1,
        captured_at: "2026-06-27T00:00:00Z",
      },
    ] as unknown as Row[]);
    assert.equal(out.subnet_count, 1);
    assert.equal(out.stake!.holders, 1);
    assert.equal(out.stake!.total, 10);
    assert.equal(out.captured_at, "2026-06-27T00:00:00Z");
  });
});

describe("loadChainConcentration", () => {
  // A D1 stub that records the SQL/params so the read shape can be asserted.
  function captureD1(rows: Row[] = []) {
    const calls: Row[] = [];
    const d1 = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return rows;
    };
    return { d1, calls };
  }

  test("reads every subnet's neurons in one pass — no netuid filter", async () => {
    const { d1, calls } = captureD1([
      {
        stake_tao: 100,
        emission_tao: 2,
        coldkey: "ck-a",
        validator_permit: 1,
        netuid: 1,
        captured_at: "2026-06-27T00:00:00Z",
      },
      {
        stake_tao: 50,
        emission_tao: 1,
        coldkey: "ck-b",
        validator_permit: 0,
        netuid: 2,
        captured_at: "2026-06-27T00:00:00Z",
      },
    ]);
    const data = await loadChainConcentration(d1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM neurons/);
    // whole network, not one subnet: no WHERE/netuid filter, no bound params.
    assert.doesNotMatch(calls[0].sql, /WHERE/);
    assert.deepEqual(calls[0].params, []);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.stake!.holders, 2);
  });

  test("returns a schema-stable null block on a cold D1", async () => {
    const { d1 } = captureD1([]);
    const data = await loadChainConcentration(d1);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.neuron_count, 0);
    assert.equal(data.stake, null);
    assert.equal(data.validator_stake, null);
  });
});

describe("GET /api/v1/chain/concentration", () => {
  // A METAGRAPH_HEALTH_DB stub: the MAX(captured_at) cache stamp and the network
  // neurons read both hit `FROM neurons`, so route the stamp query first.
  function neuronsEnv(rows: Row[]) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                all: () =>
                  Promise.resolve({
                    results: /MAX\(captured_at\)/.test(sql)
                      ? [{ captured_at: 1_700_000_000_000 }]
                      : rows,
                  }),
              };
            },
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/concentration${q}`);

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      neuronsEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/concentration edge cache", () => {
  // `caches` is `declare const caches: CacheStorage` -- a module-scope const,
  // not a `globalThis` property -- so stubbing/restoring it for a test needs
  // this cast (matches workers/request-handlers/analytics.ts's own precedent).
  const globalWithCaches = globalThis as unknown as { caches: Row };
  let originalCaches: Row;
  afterEach(() => {
    globalWithCaches.caches = originalCaches;
  });

  // #5358: chain/concentration no longer reads D1 for its edge-cache stamp — the
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
      new Request("https://api.metagraph.sh/api/v1/chain/concentration"),
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
      new Request("https://api.metagraph.sh/api/v1/chain/concentration"),
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
