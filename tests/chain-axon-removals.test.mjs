import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainAxonRemovals,
  loadChainAxonRemovals,
  CHAIN_AXON_REMOVALS_LIMIT_MAX,
  AXON_REMOVAL_EVENT_KIND,
} from "../src/chain-axon-removals.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-subnet account_events AxonInfoRemoved aggregate row (the loader GROUPs BY netuid).
function rrow(netuid, distinct_removers, removals) {
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
    const s1 = data.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.distinct_removers, 4);
    assert.equal(s1.removals, 40);
    assert.equal(s1.removals_per_remover, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).removals_per_remover,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).removals_per_remover,
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
    assert.equal(data.intensity_distribution.count, 3);
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
      limit: "abc",
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
      const data = buildChainAxonRemovals(rows, {
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

describe("loadChainAxonRemovals", () => {
  test("reads the network aggregate then the per-subnet leaderboard over the window", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY netuid/.test(sql)) return SUBNETS;
      return [NETWORK];
    };
    const data = await loadChainAxonRemovals(d1, {
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
    assert.equal(calls[0].params[0], AXON_REMOVAL_EVENT_KIND);
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
    const data = await loadChainAxonRemovals(d1, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(calls.length, 1);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.observed_at, null);
  });
});

describe("GET /api/v1/chain/axon-removals", () => {
  function axonRemovalsEnv({ networkRow, subnetRows }) {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/axon-removals${q}`);
  const cold = { networkRow: [{ newest_observed: null }], subnetRows: [] };
  const warm = { networkRow: [NETWORK], subnetRows: SUBNETS };

  test("dispatches to the network axon-removal scorecard", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      axonRemovalsEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/axon-removals.json",
    );
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

  test("exports the per-subnet leaderboard as CSV with ?format=csv", async () => {
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
    assert.equal(lines[0], AXON_REMOVALS_CSV_HEADER);
    // Ranked by total removals desc: netuid 1 (40), 2 (30), 5 (25).
    assert.equal(lines.length, 4); // header + 3 subnet rows
    assert.equal(lines[1], "1,4,40,10");
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
        new Request("https://api.metagraph.sh/api/v1/chain/axon-removals"),
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
