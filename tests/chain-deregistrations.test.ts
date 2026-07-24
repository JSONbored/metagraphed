import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainDeregistrations,
  CHAIN_DEREGISTRATIONS_LIMIT_MAX,
} from "../src/chain-deregistrations.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const OBS = 1_700_000_000_000;

// One per-subnet account_events NeuronDeregistered aggregate row (the loader GROUPs BY netuid).
function drow(
  netuid: number,
  distinct_deregistered_hotkeys: number,
  deregistrations: number | null,
) {
  return { netuid, distinct_deregistered_hotkeys, deregistrations };
}

// netuid 1: 4 hotkeys, 40 deregs -> 10 deregs/hotkey.
// netuid 2: 2 hotkeys, 30 deregs -> 15 deregs/hotkey.
// netuid 5: 10 hotkeys, 25 deregs -> 2.5 deregs/hotkey.
const SUBNETS = [drow(1, 4, 40), drow(2, 2, 30), drow(5, 10, 25)];
// True network distinct hotkeys (12) is below the per-subnet sum (16): some hotkeys are deregistered
// on more than one subnet and count once network-wide.
const NETWORK = {
  distinct_deregistered_hotkeys: 12,
  newest_observed: OBS,
};

describe("buildChainDeregistrations", () => {
  test("shapes the per-subnet leaderboard ranked by total NeuronDeregistered events", () => {
    const data = buildChainDeregistrations(SUBNETS, {
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
    assert.equal(s1.distinct_deregistered_hotkeys, 4);
    assert.equal(s1.deregistrations, 40);
    assert.equal(s1.deregistrations_per_hotkey, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2)!.deregistrations_per_hotkey,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5)!.deregistrations_per_hotkey,
      2.5,
    );
  });

  test("rolls up the true distinct hotkey count and derived total events", () => {
    const { network } = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_deregistered_hotkeys, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.deregistrations, 95);
    assert.equal(network.deregistrations_per_hotkey, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet re-deregistration intensity", () => {
    const { intensity_distribution } = buildChainDeregistrations(SUBNETS, {
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
    const data = buildChainDeregistrations([drow(9, 3, 50), drow(4, 2, 50)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  // #5579: limit floor is 0 (matching #2984's chain-weights fix).
  test("limit of 0 yields an empty leaderboard, not a single row", () => {
    const data = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      limit: 0,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 0);
    assert.equal(data.subnet_count, 3);
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution!.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      limit: CHAIN_DEREGISTRATIONS_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      limit: "abc" as unknown as number,
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum hotkeys and deregistrations)", () => {
    const data = buildChainDeregistrations([drow(1, 3, 20), drow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_deregistered_hotkeys, 5); // 3 + 2
    assert.equal(s.deregistrations, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainDeregistrations(
      [{ netuid: 1, distinct_deregistered_hotkeys: 3, deregistrations: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].deregistrations, 0);
    assert.equal(data.subnets[0].deregistrations_per_hotkey, 0); // 0 deregs / 3 hotkeys
  });

  test("skips rows with a malformed/blank/negative netuid and zero-hotkey rows", () => {
    const data = buildChainDeregistrations(
      [
        drow(1, 4, 40),
        { netuid: null, distinct_deregistered_hotkeys: 3 },
        { netuid: "", distinct_deregistered_hotkeys: 3 },
        { netuid: "  ", distinct_deregistered_hotkeys: 3 },
        { netuid: "bad", distinct_deregistered_hotkeys: 3 },
        { netuid: -1, distinct_deregistered_hotkeys: 3 },
        drow(2, 0, 10), // zero hotkeys: not a deregistration surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainDeregistrations(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_deregistered_hotkeys: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_deregistered_hotkeys, 0);
    assert.equal(zeroed.network.deregistrations_per_hotkey, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainDeregistrations(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    // A finite but out-of-range epoch (e.g. 1e100) must coerce to null instead of
    // throwing a RangeError from toISOString (mirrors chain-stake-flow #3016).
    assert.equal(
      buildChainDeregistrations(SUBNETS, {
        window: "7d",
        networkDistinct: { newest_observed: 1e100 },
      }).observed_at,
      null,
    );
    assert.equal(absent.network.distinct_deregistered_hotkeys, 0);
    assert.equal(absent.network.deregistrations_per_hotkey, null);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainDeregistrations(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainDeregistrations([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainDeregistrations(rows as unknown as Row[], {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_deregistered_hotkeys, 0);
      assert.equal(data.network.deregistrations_per_hotkey, null);
    }
  });
});

describe("GET /api/v1/chain/deregistrations", () => {
  function deregistrationsEnv({
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
    new Request(`https://api.metagraph.sh/api/v1/chain/deregistrations${q}`);
  const cold = { networkRow: [{ newest_observed: null }], subnetRows: [] };
  const warm = { networkRow: [NETWORK], subnetRows: SUBNETS };

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this handler no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    let d1Called = false;
    const env = deregistrationsEnv(warm);
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/deregistrations.json",
    );
    assert.equal(d1Called, false);
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/deregistrations", {
        method: "HEAD",
      }),
      deregistrationsEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(
      req(),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
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
      ...deregistrationsEnv(cold),
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
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
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
      ...deregistrationsEnv(warm),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=90d"),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(
      req("?bogus=1"),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(
      req("?limit=0"),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  const DEREGISTRATIONS_CSV_HEADER =
    "netuid,distinct_deregistered_hotkeys,deregistrations,deregistrations_per_hotkey";

  // #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
  // export is always header-only now (account_events is retired).
  test("CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      deregistrationsEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-deregistrations\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], DEREGISTRATIONS_CSV_HEADER);
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/deregistrations", {
        headers: { accept: "text/csv" },
      }),
      deregistrationsEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), DEREGISTRATIONS_CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/deregistrations?format=csv",
        { method: "HEAD" },
      ),
      deregistrationsEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      req("?format=xml"),
      deregistrationsEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/deregistrations edge cache", () => {
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
        new Request("https://api.metagraph.sh/api/v1/chain/deregistrations"),
        env as unknown as Env,
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
