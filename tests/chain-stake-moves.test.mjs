import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainStakeMoves,
  CHAIN_STAKE_MOVES_LIMIT_MAX,
} from "../src/chain-stake-moves.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-subnet account_events StakeMoved aggregate row (the loader GROUPs BY netuid).
function mrow(netuid, distinct_movers, movements) {
  return { netuid, distinct_movers, movements };
}

// netuid 1: 4 coldkeys, 40 moves -> 10 moves/mover.
// netuid 2: 2 coldkeys, 30 moves -> 15 moves/mover.
// netuid 5: 10 coldkeys, 25 moves -> 2.5 moves/mover.
const SUBNETS = [mrow(1, 4, 40), mrow(2, 2, 30), mrow(5, 10, 25)];
// True network distinct coldkeys (12) is below the per-subnet sum (16): some movers move stake out
// of more than one subnet and count once network-wide.
const NETWORK = {
  distinct_movers: 12,
  newest_observed: OBS,
};

describe("buildChainStakeMoves", () => {
  test("shapes the per-subnet leaderboard ranked by total StakeMoved events", () => {
    const data = buildChainStakeMoves(SUBNETS, {
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
    assert.equal(s1.distinct_movers, 4);
    assert.equal(s1.movements, 40);
    assert.equal(s1.movements_per_mover, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).movements_per_mover,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).movements_per_mover,
      2.5,
    );
  });

  test("rolls up the true distinct mover count and derived total events", () => {
    const { network } = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_movers, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.movements, 95);
    assert.equal(network.movements_per_mover, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet re-move intensity", () => {
    const { intensity_distribution } = buildChainStakeMoves(SUBNETS, {
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
    const data = buildChainStakeMoves([mrow(9, 3, 50), mrow(4, 2, 50)], {
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
    const data = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      limit: 0,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 0);
    assert.equal(data.subnet_count, 3);
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      limit: CHAIN_STAKE_MOVES_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      limit: "abc",
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum movers and movements)", () => {
    const data = buildChainStakeMoves([mrow(1, 3, 20), mrow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_movers, 5); // 3 + 2
    assert.equal(s.movements, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainStakeMoves(
      [{ netuid: 1, distinct_movers: 3, movements: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].movements, 0);
    assert.equal(data.subnets[0].movements_per_mover, 0); // 0 movements / 3 movers
  });

  test("skips rows with a malformed/blank/negative netuid and zero-mover rows", () => {
    const data = buildChainStakeMoves(
      [
        mrow(1, 4, 40),
        { netuid: null, distinct_movers: 3 },
        { netuid: "", distinct_movers: 3 },
        { netuid: "  ", distinct_movers: 3 },
        { netuid: "bad", distinct_movers: 3 },
        { netuid: -1, distinct_movers: 3 },
        mrow(2, 0, 10), // zero movers: not a movement surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainStakeMoves(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_movers: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_movers, 0);
    assert.equal(zeroed.network.movements_per_mover, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainStakeMoves(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    // A finite but out-of-range epoch (e.g. 1e100) must coerce to null instead of
    // throwing a RangeError from toISOString (mirrors chain-stake-flow #3016).
    assert.equal(
      buildChainStakeMoves(SUBNETS, {
        window: "7d",
        networkDistinct: { newest_observed: 1e100 },
      }).observed_at,
      null,
    );
    assert.equal(absent.network.distinct_movers, 0);
    assert.equal(absent.network.movements_per_mover, null);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainStakeMoves(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainStakeMoves([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainStakeMoves(rows, {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_movers, 0);
      assert.equal(data.network.movements_per_mover, null);
    }
  });
});

// D1 fully eliminated (2026-07-16): account_events' D1 write path is retired
// (#4772) and the table is dropped in production, so loadChainStakeMoves
// (the D1-querying loader) is gone -- the handler now degrades straight to
// buildChainStakeMoves([], {...}) on any Postgres miss/outage.
describe("GET /api/v1/chain/stake-moves", () => {
  function postgresEnv(body) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json(body) },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/stake-moves${q}`);
  const warmBody = {
    schema_version: 1,
    window: "7d",
    observed_at: new Date(OBS).toISOString(),
    subnet_count: 3,
    network: { distinct_movers: 12, movements: 95, movements_per_mover: 7.92 },
    intensity_distribution: { count: 3, min: 2.5, max: 15 },
    subnets: [
      { netuid: 1, distinct_movers: 4, movements: 40, movements_per_mover: 10 },
      { netuid: 2, distinct_movers: 2, movements: 30, movements_per_mover: 15 },
      {
        netuid: 5,
        distinct_movers: 10,
        movements: 25,
        movements_per_mover: 2.5,
      },
    ],
  };

  test("dispatches to the network stake-movement scorecard", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      postgresEnv(warmBody),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(body.meta.artifact_path, "/metagraph/chain/stake-moves.json");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-moves", {
        method: "HEAD",
      }),
      postgresEnv(warmBody),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), createLocalArtifactEnv(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.intensity_distribution, null);
  });

  test("flag=postgres serves the DATA_API response", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      postgresEnv({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-01-01T00:00:00.000Z",
        subnet_count: 99,
        network: {},
        intensity_distribution: null,
        subnets: [{ netuid: 42 }],
      }),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 99);
  });

  test("flag=postgres degrades to the empty card when DATA_API fails", async () => {
    const env = {
      ...createLocalArtifactEnv(),
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
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(
      req("?bogus=1"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(
      req("?limit=0"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  const STAKE_MOVES_CSV_HEADER =
    "netuid,distinct_movers,movements,movements_per_mover";

  test("exports the per-subnet leaderboard as CSV with ?format=csv", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      postgresEnv(warmBody),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-stake-moves\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], STAKE_MOVES_CSV_HEADER);
    // Ranked by total movements desc: netuid 1 (40), 2 (30), 5 (25).
    assert.equal(lines.length, 4); // header + 3 subnet rows
    assert.equal(lines[1], "1,4,40,10");
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-moves", {
        headers: { accept: "text/csv" },
      }),
      postgresEnv(warmBody),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), STAKE_MOVES_CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-moves?format=csv",
        { method: "HEAD" },
      ),
      postgresEnv(warmBody),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      req("?format=xml"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/stake-moves edge cache", () => {
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
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "7d",
            observed_at: new Date(OBS).toISOString(),
            subnet_count: 3,
            network: {
              distinct_movers: 12,
              movements: 95,
              movements_per_mover: 7.92,
            },
            intensity_distribution: { count: 3, min: 2.5, max: 15 },
            subnets: [
              {
                netuid: 1,
                distinct_movers: 4,
                movements: 40,
                movements_per_mover: 10,
              },
              {
                netuid: 2,
                distinct_movers: 2,
                movements: 30,
                movements_per_mover: 15,
              },
              {
                netuid: 5,
                distinct_movers: 10,
                movements: 25,
                movements_per_mover: 2.5,
              },
            ],
          }),
      },
    };
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/stake-moves"),
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
