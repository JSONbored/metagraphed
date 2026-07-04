import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainOnboarding,
  loadChainOnboarding,
  CHAIN_ONBOARDING_LIMIT_MAX,
  ONBOARDING_EVENT_KIND,
} from "../src/chain-onboarding.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-subnet account_events NeuronRegistered aggregate row (the loader GROUPs BY netuid).
function orow(netuid, distinct_hotkeys, registrations) {
  return { netuid, distinct_hotkeys, registrations };
}

// netuid 1: 4 hotkeys, 40 regs -> 10 regs/hotkey.
// netuid 2: 2 hotkeys, 30 regs -> 15 regs/hotkey.
// netuid 5: 10 hotkeys, 25 regs -> 2.5 regs/hotkey.
const SUBNETS = [orow(1, 4, 40), orow(2, 2, 30), orow(5, 10, 25)];
// True network distinct hotkeys (12) is below the per-subnet sum (16): some hotkeys register
// on more than one subnet and count once network-wide.
const NETWORK = {
  distinct_hotkeys: 12,
  newest_observed: OBS,
};

describe("buildChainOnboarding", () => {
  test("shapes the per-subnet leaderboard ranked by total registration events", () => {
    const data = buildChainOnboarding(SUBNETS, {
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
    assert.equal(s1.distinct_hotkeys, 4);
    assert.equal(s1.registrations, 40);
    assert.equal(s1.registrations_per_hotkey, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).registrations_per_hotkey,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).registrations_per_hotkey,
      2.5,
    );
  });

  test("rolls up the true distinct hotkey count and derived total events", () => {
    const { network } = buildChainOnboarding(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_hotkeys, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.registrations, 95);
    assert.equal(network.registrations_per_hotkey, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet re-registration intensity", () => {
    const { intensity_distribution } = buildChainOnboarding(SUBNETS, {
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
    const data = buildChainOnboarding([orow(9, 3, 50), orow(4, 2, 50)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainOnboarding(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainOnboarding(SUBNETS, {
      window: "7d",
      limit: CHAIN_ONBOARDING_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainOnboarding(SUBNETS, {
      window: "7d",
      limit: "abc",
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum hotkeys and registrations)", () => {
    const data = buildChainOnboarding([orow(1, 3, 20), orow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_hotkeys, 5); // 3 + 2
    assert.equal(s.registrations, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainOnboarding(
      [{ netuid: 1, distinct_hotkeys: 3, registrations: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].registrations, 0);
    assert.equal(data.subnets[0].registrations_per_hotkey, 0); // 0 registrations / 3 hotkeys
  });

  test("skips rows with a malformed/blank/negative netuid and zero-hotkey rows", () => {
    const data = buildChainOnboarding(
      [
        orow(1, 4, 40),
        { netuid: null, distinct_hotkeys: 3 },
        { netuid: "", distinct_hotkeys: 3 },
        { netuid: "  ", distinct_hotkeys: 3 },
        { netuid: "bad", distinct_hotkeys: 3 },
        { netuid: -1, distinct_hotkeys: 3 },
        orow(2, 0, 10), // zero hotkeys: not an onboarding surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainOnboarding(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_hotkeys: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_hotkeys, 0);
    assert.equal(zeroed.network.registrations_per_hotkey, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainOnboarding(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    assert.equal(absent.network.distinct_hotkeys, 0);
    assert.equal(absent.network.registrations_per_hotkey, null);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainOnboarding(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainOnboarding([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainOnboarding(rows, {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_hotkeys, 0);
      assert.equal(data.network.registrations_per_hotkey, null);
    }
  });
});

describe("loadChainOnboarding", () => {
  test("reads the network aggregate then the per-subnet leaderboard over the window", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY netuid/.test(sql)) return SUBNETS;
      return [NETWORK];
    };
    const data = await loadChainOnboarding(d1, {
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
    assert.equal(calls[0].params[0], ONBOARDING_EVENT_KIND);
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
    const data = await loadChainOnboarding(d1, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(calls.length, 1);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.observed_at, null);
  });
});

describe("GET /api/v1/chain/onboarding", () => {
  function onboardingEnv({ networkRow, subnetRows }) {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/onboarding${q}`);
  const cold = { networkRow: [{ newest_observed: null }], subnetRows: [] };
  const warm = { networkRow: [NETWORK], subnetRows: SUBNETS };

  test("dispatches to the network registration inflow scorecard", async () => {
    const res = await handleRequest(req("?window=7d"), onboardingEnv(warm), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(body.meta.artifact_path, "/metagraph/chain/onboarding.json");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/onboarding", {
        method: "HEAD",
      }),
      onboardingEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), onboardingEnv(cold), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.intensity_distribution, null);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=90d"),
      onboardingEnv(cold),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), onboardingEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), onboardingEnv(cold), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/onboarding edge cache", () => {
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
        new Request("https://api.metagraph.sh/api/v1/chain/onboarding"),
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
