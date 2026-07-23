import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainAxonRemovals,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
} from "../src/chain-axon-removals.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const OBS = 1_700_000_000_000;

// One per-subnet account_events AxonInfoRemoved aggregate row (the loader GROUPs BY netuid).
function rrow(
  netuid: number,
  distinct_removers: number,
  removals: number | null,
) {
  return { netuid, distinct_removers, removals };
}

// netuid 1: 4 hotkeys, 40 events -> 10 events/hotkey.
// netuid 2: 2 hotkeys, 30 events -> 15 events/hotkey.
// netuid 5: 10 hotkeys, 25 events -> 2.5 events/hotkey.
const SUBNETS = [rrow(1, 4, 40), rrow(2, 2, 30), rrow(5, 10, 25)];
// True network distinct hotkeys (12) is below the per-subnet sum (16): some removers remove an axon
// on more than one subnet and count once network-wide.
const NETWORK = {
  distinct_removers: 12,
  newest_observed: OBS,
};

describe("buildChainAxonRemovals", () => {
  test("shapes the per-subnet leaderboard ranked by total AxonInfoRemoved events", () => {
    const data = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.observed_at, new Date(OBS).toISOString());
    assert.equal(data.subnet_count, 3);
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 2, 5],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.distinct_removers, 4);
    assert.equal(s1.removals, 40);
    assert.equal(s1.removals_per_remover, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2)!.removals_per_remover,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5)!.removals_per_remover,
      2.5,
    );
  });

  test("rolls up the true distinct hotkey count and derived total events", () => {
    const { network } = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_removers, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.removals, 95);
    assert.equal(network.removals_per_remover, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet re-teardown intensity", () => {
    const { intensity_distribution } = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    // intensities 10, 15, 2.5 -> ascending [2.5, 10, 15].
    assert.equal(intensity_distribution!.count, 3);
    assert.equal(intensity_distribution!.min, 2.5);
    assert.equal(intensity_distribution!.p25, 2.5);
    assert.equal(intensity_distribution!.median, 10);
    assert.equal(intensity_distribution!.p75, 15);
    assert.equal(intensity_distribution!.p90, 15);
    assert.equal(intensity_distribution!.max, 15);
    assert.equal(intensity_distribution!.mean, 9.17);
  });

  test("ties on total events break by netuid ascending", () => {
    const data = buildChainAxonRemovals([rrow(9, 3, 50), rrow(4, 2, 50)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution!.count, 3);
  });

  // #5579: limit floor is 0 (matching #2984's chain-weights fix), so limit: 0
  // returns an empty leaderboard rather than a single row.
  test("limit of 0 yields an empty leaderboard, not a single row", () => {
    const data = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      limit: 0,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 0);
    assert.equal(data.subnet_count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      limit: CHAIN_AXON_REMOVALS_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      limit: "abc" as unknown as number,
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum removers and removals)", () => {
    const data = buildChainAxonRemovals([rrow(1, 3, 20), rrow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_removers, 5); // 3 + 2
    assert.equal(s.removals, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainAxonRemovals(
      [{ netuid: 1, distinct_removers: 3, removals: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].removals, 0);
    assert.equal(data.subnets[0].removals_per_remover, 0); // 0 removals / 3 hotkeys
  });

  test("skips rows with a malformed/blank/negative netuid and zero-remover rows", () => {
    const data = buildChainAxonRemovals(
      [
        rrow(1, 4, 40),
        { netuid: null, distinct_removers: 3 },
        { netuid: "", distinct_removers: 3 },
        { netuid: "  ", distinct_removers: 3 },
        { netuid: "bad", distinct_removers: 3 },
        { netuid: -1, distinct_removers: 3 },
        rrow(2, 0, 10), // zero removers: not a teardown surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainAxonRemovals(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_removers: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_removers, 0);
    assert.equal(zeroed.network.removals_per_remover, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainAxonRemovals(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    // A finite but out-of-range epoch (e.g. 1e100) must coerce to null instead of
    // throwing a RangeError from toISOString (mirrors chain-stake-flow #3016).
    assert.equal(
      buildChainAxonRemovals(SUBNETS, {
        window: "7d",
        networkDistinct: { newest_observed: 1e100 },
      }).observed_at,
      null,
    );
    assert.equal(absent.network.distinct_removers, 0);
    assert.equal(absent.network.removals_per_remover, null);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainAxonRemovals(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainAxonRemovals([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainAxonRemovals(rows as unknown as Row[], {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_removers, 0);
      assert.equal(data.network.removals_per_remover, null);
    }
  });
});

describe("GET /api/v1/chain/axon-removals", () => {
  function axonRemovalsEnv({
    networkRow,
    subnetRows,
  }: {
    networkRow: Row[];
    subnetRows: Row[];
  }) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /GROUP BY netuid/.test(sql)
                    ? subnetRows
                    : networkRow,
                }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/axon-removals${q}`);
  const cold = { networkRow: [{ newest_observed: null }], subnetRows: [] };
  const warm = { networkRow: [NETWORK], subnetRows: SUBNETS };

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this handler no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    let d1Called = false;
    const env = axonRemovalsEnv(warm);
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const res = await handleRequest(req("?window=7d"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/axon-removals.json",
    );
    assert.equal(d1Called, false);
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/axon-removals", {
        method: "HEAD",
      }),
      axonRemovalsEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), axonRemovalsEnv(cold), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.intensity_distribution, null);
  });

  // #4832 Tier 2: METAGRAPH_ACCOUNT_EVENTS_SOURCE reused (same account_events
  // table this handler already reads, no new flag) -- tryPostgresTier's own
  // fallback contract is unit-tested in workers/postgres-tier.ts's own
  // tests, so these two just prove the wiring: a Postgres hit is served
  // as-is with D1 never queried, and a Postgres failure falls back to D1.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = {
      ...axonRemovalsEnv(cold),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "7d",
            observed_at: "2026-01-01T00:00:00.000Z",
            subnet_count: 99,
            network: {},
            intensity_distribution: null,
            subnets: [{ netuid: 42 }],
          }),
      },
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const res = await handleRequest(req("?window=7d"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 99);
    assert.equal(d1Called, false);
  });

  // #4909/#6013: the D1 "fallback" is a schema-stable empty stub, not a real
  // D1 read (account_events is retired) -- a Postgres failure degrades to the
  // empty card, not to whatever a D1 mock might return.
  test("flag=postgres falls back to the empty stub (not D1) when DATA_API fails", async () => {
    const env = {
      ...axonRemovalsEnv(warm),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await handleRequest(req("?window=7d"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=90d"),
      axonRemovalsEnv(cold),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), axonRemovalsEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), axonRemovalsEnv(cold), {});
    assert.equal(res.status, 400);
  });

  const AXON_REMOVALS_CSV_HEADER =
    "netuid,distinct_removers,removals,removals_per_remover";

  // #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
  // export is always header-only now (account_events is retired).
  test("CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      axonRemovalsEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-axon-removals\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], AXON_REMOVALS_CSV_HEADER);
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/axon-removals", {
        headers: { accept: "text/csv" },
      }),
      axonRemovalsEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      axonRemovalsEnv(cold),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), AXON_REMOVALS_CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/axon-removals?format=csv",
        { method: "HEAD" },
      ),
      axonRemovalsEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      req("?format=xml"),
      axonRemovalsEnv(cold),
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/axon-removals edge cache", () => {
  // `caches` is `declare const caches: CacheStorage` -- a module-scope const,
  // not a `globalThis` property -- so stubbing/restoring it for a test needs
  // this cast (matches workers/request-handlers/analytics.ts's own precedent).
  const globalWithCaches = globalThis as unknown as { caches: Row };
  let originalCaches: Row;
  afterEach(() => {
    globalWithCaches.caches = originalCaches;
  });

  test("routes through the edge cache with caches enabled", async () => {
    originalCaches = globalWithCaches.caches;
    const store = new Map<string, Response>();
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
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key: string) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-30T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /GROUP BY netuid/.test(sql) ? SUBNETS : [NETWORK],
                }),
            }),
          };
        },
      },
    };
    const waits: Promise<unknown>[] = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/axon-removals"),
        env,
        { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    // #4909/#6013: account_events is retired, so even this "warm" D1 mock
    // never reaches the response -- subnet_count stays 0.
    assert.equal((await res.json()).data.subnet_count, 0);
    await Promise.all(waits);
    assert.equal(store.size, 1);
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 0);
  });
});
