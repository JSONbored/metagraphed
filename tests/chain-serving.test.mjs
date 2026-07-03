import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainServing,
  loadChainServing,
  CHAIN_SERVING_LIMIT_MAX,
  SERVING_EVENT_KIND,
} from "../src/chain-serving.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-subnet account_events AxonServed aggregate row (the loader GROUPs BY netuid).
function srow(netuid, distinct_servers, announcements) {
  return { netuid, distinct_servers, announcements };
}

// netuid 1: 4 hotkeys, 40 regs -> 10 regs/hotkey.
// netuid 2: 2 hotkeys, 30 regs -> 15 regs/hotkey.
// netuid 5: 10 hotkeys, 25 regs -> 2.5 regs/hotkey.
const SUBNETS = [srow(1, 4, 40), srow(2, 2, 30), srow(5, 10, 25)];
// True network distinct hotkeys (12) is below the per-subnet sum (16): some servers announce
// on more than one subnet and count once network-wide.
const NETWORK = {
  distinct_servers: 12,
  newest_observed: OBS,
};

describe("buildChainServing", () => {
  test("shapes the per-subnet leaderboard ranked by total AxonServed events", () => {
    const data = buildChainServing(SUBNETS, {
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
    const s1 = data.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.distinct_servers, 4);
    assert.equal(s1.announcements, 40);
    assert.equal(s1.announcements_per_server, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).announcements_per_server,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).announcements_per_server,
      2.5,
    );
  });

  test("rolls up the true distinct hotkey count and derived total events", () => {
    const { network } = buildChainServing(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_servers, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.announcements, 95);
    assert.equal(network.announcements_per_server, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet re-announcement intensity", () => {
    const { intensity_distribution } = buildChainServing(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    // intensities 10, 15, 2.5 -> ascending [2.5, 10, 15].
    assert.equal(intensity_distribution.count, 3);
    assert.equal(intensity_distribution.min, 2.5);
    assert.equal(intensity_distribution.p25, 2.5);
    assert.equal(intensity_distribution.median, 10);
    assert.equal(intensity_distribution.p75, 15);
    assert.equal(intensity_distribution.p90, 15);
    assert.equal(intensity_distribution.max, 15);
    assert.equal(intensity_distribution.mean, 9.17);
  });

  test("ties on total events break by netuid ascending", () => {
    const data = buildChainServing([srow(9, 3, 50), srow(4, 2, 50)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainServing(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainServing(SUBNETS, {
      window: "7d",
      limit: CHAIN_SERVING_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainServing(SUBNETS, {
      window: "7d",
      limit: "abc",
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum hotkeys and announcements)", () => {
    const data = buildChainServing([srow(1, 3, 20), srow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_servers, 5); // 3 + 2
    assert.equal(s.announcements, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainServing(
      [{ netuid: 1, distinct_servers: 3, announcements: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].announcements, 0);
    assert.equal(data.subnets[0].announcements_per_server, 0); // 0 announcements / 3 hotkeys
  });

  test("skips rows with a malformed/blank/negative netuid and zero-hotkey rows", () => {
    const data = buildChainServing(
      [
        srow(1, 4, 40),
        { netuid: null, distinct_servers: 3 },
        { netuid: "", distinct_servers: 3 },
        { netuid: "  ", distinct_servers: 3 },
        { netuid: "bad", distinct_servers: 3 },
        { netuid: -1, distinct_servers: 3 },
        srow(2, 0, 10), // zero hotkeys: not an serving surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainServing(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_servers: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_servers, 0);
    assert.equal(zeroed.network.announcements_per_server, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainServing(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    assert.equal(absent.network.distinct_servers, 0);
    assert.equal(absent.network.announcements_per_server, null);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainServing(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainServing([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainServing(rows, {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_servers, 0);
      assert.equal(data.network.announcements_per_server, null);
    }
  });
});

describe("loadChainServing", () => {
  test("reads the network aggregate then the per-subnet leaderboard over the window", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY netuid/.test(sql)) return SUBNETS;
      return [NETWORK];
    };
    const data = await loadChainServing(d1, {
      windowLabel: "7d",
      windowDays: 7,
      limit: 20,
    });
    assert.match(calls[0].sql, /COUNT\(DISTINCT hotkey\)/);
    assert.doesNotMatch(calls[0].sql, /GROUP BY/);
    assert.match(
      calls[1].sql,
      /event_kind = \? AND observed_at >= \? GROUP BY netuid/,
    );
    assert.equal(calls[0].params[0], SERVING_EVENT_KIND);
    assert.equal(typeof calls[0].params[1], "number"); // epoch-ms cutoff
    assert.equal(calls[1].params[1], calls[0].params[1]); // same window cutoff
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a cold store skips the per-subnet read and returns the empty block", async () => {
    const calls = [];
    const d1 = async (sql) => {
      calls.push(sql);
      if (/GROUP BY netuid/.test(sql)) return SUBNETS;
      return []; // network aggregate returns no row on a fully cold store
    };
    const data = await loadChainServing(d1, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(calls.length, 1);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.observed_at, null);
  });
});

describe("GET /api/v1/chain/serving", () => {
  function servingEnv({ networkRow, subnetRows }) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/serving${q}`);
  const cold = { networkRow: [{ newest_observed: null }], subnetRows: [] };
  const warm = { networkRow: [NETWORK], subnetRows: SUBNETS };

  test("dispatches to the network serving announcement scorecard", async () => {
    const res = await handleRequest(req("?window=7d"), servingEnv(warm), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(body.meta.artifact_path, "/metagraph/chain/serving.json");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/serving", {
        method: "HEAD",
      }),
      servingEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), servingEnv(cold), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.intensity_distribution, null);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(req("?window=90d"), servingEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), servingEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), servingEnv(cold), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/serving edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  test("routes through the edge cache with caches enabled", async () => {
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
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-30T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
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
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/serving"),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.subnet_count, 3);
    await Promise.all(waits);
    assert.equal(store.size, 1);
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 3);
  });
});
