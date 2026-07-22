import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainStakeTransfers,
  CHAIN_STAKE_TRANSFERS_LIMIT_MAX,
} from "../src/chain-stake-transfers.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-subnet account_events StakeTransferred aggregate row (the loader GROUPs BY netuid).
function trow(netuid, distinct_senders, transfers) {
  return { netuid, distinct_senders, transfers };
}

// netuid 1: 4 coldkeys, 40 transfers -> 10 transfers/sender.
// netuid 2: 2 coldkeys, 30 transfers -> 15 transfers/sender.
// netuid 5: 10 coldkeys, 25 transfers -> 2.5 transfers/sender.
const SUBNETS = [trow(1, 4, 40), trow(2, 2, 30), trow(5, 10, 25)];
// True network distinct coldkeys (12) is below the per-subnet sum (16): some senders transfer stake
// out of more than one subnet and count once network-wide.
const NETWORK = {
  distinct_senders: 12,
  newest_observed: OBS,
};

describe("buildChainStakeTransfers", () => {
  test("shapes the per-subnet leaderboard ranked by total StakeTransferred events", () => {
    const data = buildChainStakeTransfers(SUBNETS, {
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
    assert.equal(s1.distinct_senders, 4);
    assert.equal(s1.transfers, 40);
    assert.equal(s1.transfers_per_sender, 10);
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).transfers_per_sender,
      15,
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).transfers_per_sender,
      2.5,
    );
  });

  test("rolls up the true distinct sender count and derived total events", () => {
    const { network } = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(network.distinct_senders, 12); // true distinct, not the 16 per-subnet sum
    assert.equal(network.transfers, 95);
    assert.equal(network.transfers_per_sender, 7.92); // 95 / 12
  });

  test("summarises the spread of per-subnet transfer intensity", () => {
    const { intensity_distribution } = buildChainStakeTransfers(SUBNETS, {
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
    const data = buildChainStakeTransfers([trow(9, 3, 50), trow(4, 2, 50)], {
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
    const data = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      limit: 0,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 0);
    assert.equal(data.subnet_count, 3);
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      limit: 2,
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.intensity_distribution.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      limit: CHAIN_STAKE_TRANSFERS_LIMIT_MAX + 500,
      networkDistinct: NETWORK,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      limit: "abc",
      networkDistinct: NETWORK,
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum senders and transfers)", () => {
    const data = buildChainStakeTransfers([trow(1, 3, 20), trow(1, 2, 15)], {
      window: "7d",
      networkDistinct: NETWORK,
    });
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.distinct_senders, 5); // 3 + 2
    assert.equal(s.transfers, 35); // 20 + 15
  });

  test("coerces non-numeric count cells to zero", () => {
    const data = buildChainStakeTransfers(
      [{ netuid: 1, distinct_senders: 3, transfers: null }],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnets[0].transfers, 0);
    assert.equal(data.subnets[0].transfers_per_sender, 0); // 0 transfers / 3 senders
  });

  test("skips rows with a malformed/blank/negative netuid and zero-sender rows", () => {
    const data = buildChainStakeTransfers(
      [
        trow(1, 4, 40),
        { netuid: null, distinct_senders: 3 },
        { netuid: "", distinct_senders: 3 },
        { netuid: "  ", distinct_senders: 3 },
        { netuid: "bad", distinct_senders: 3 },
        { netuid: -1, distinct_senders: 3 },
        trow(2, 0, 10), // zero senders: not a transfer surface
      ],
      { window: "7d", networkDistinct: NETWORK },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a zero/absent network distinct count yields null network intensity", () => {
    const zeroed = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      // newest_observed 0 is present-but-invalid: observed_at coerces to null, not a 1970 stamp.
      networkDistinct: { distinct_senders: 0, newest_observed: 0 },
    });
    assert.equal(zeroed.network.distinct_senders, 0);
    assert.equal(zeroed.network.transfers_per_sender, null);
    assert.equal(zeroed.observed_at, null);
    const absent = buildChainStakeTransfers(SUBNETS, { window: "7d" });
    assert.equal(absent.observed_at, null);
    assert.equal(absent.network.distinct_senders, 0);
    assert.equal(absent.network.transfers_per_sender, null);
  });

  test("an out-of-range newest_observed yields null instead of throwing a RangeError", () => {
    // A finite but out-of-JS-Date-range epoch (e.g. 1e100) makes new Date(n).toISOString()
    // throw, which would 500 the endpoint. It must coerce to null, matching chain-stake-flow (#3016).
    const data = buildChainStakeTransfers(SUBNETS, {
      window: "7d",
      networkDistinct: { distinct_senders: 12, newest_observed: 1e100 },
    });
    assert.equal(data.observed_at, null);
    assert.equal(data.subnet_count, 3);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(
      buildChainStakeTransfers(SUBNETS, { networkDistinct: NETWORK }).window,
      null,
    );
    assert.equal(buildChainStakeTransfers([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainStakeTransfers(rows, {
        window: "7d",
        networkDistinct: NETWORK,
      });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.intensity_distribution, null);
      assert.equal(data.network.distinct_senders, 0);
      assert.equal(data.network.transfers_per_sender, null);
    }
  });
});

// D1 fully eliminated (2026-07-16): account_events' D1 write path is retired
// (#4772) and the table is dropped in production, so loadChainStakeTransfers
// (the D1-querying loader) is gone -- the handler now degrades straight to
// buildChainStakeTransfers([], {...}) on any Postgres miss/outage.
describe("GET /api/v1/chain/stake-transfers", () => {
  function postgresEnv(body) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json(body) },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/stake-transfers${q}`);
  const warmBody = {
    schema_version: 1,
    window: "7d",
    observed_at: new Date(OBS).toISOString(),
    subnet_count: 3,
    network: {
      distinct_senders: 12,
      transfers: 95,
      transfers_per_sender: 7.92,
    },
    intensity_distribution: { count: 3, min: 2.5, max: 15 },
    subnets: [
      {
        netuid: 1,
        distinct_senders: 4,
        transfers: 40,
        transfers_per_sender: 10,
      },
      {
        netuid: 2,
        distinct_senders: 2,
        transfers: 30,
        transfers_per_sender: 15,
      },
      {
        netuid: 5,
        distinct_senders: 10,
        transfers: 25,
        transfers_per_sender: 2.5,
      },
    ],
  };

  test("dispatches to the network stake-transfer scorecard", async () => {
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
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/stake-transfers.json",
    );
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-transfers", {
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

  const STAKE_TRANSFERS_CSV_HEADER =
    "netuid,distinct_senders,transfers,transfers_per_sender";

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
      /attachment; filename="chain-stake-transfers\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], STAKE_TRANSFERS_CSV_HEADER);
    // Ranked by total transfers desc: netuid 1 (40), 2 (30), 5 (25).
    assert.equal(lines.length, 4); // header + 3 subnet rows
    assert.equal(lines[1], "1,4,40,10");
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-transfers", {
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
    assert.equal((await res.text()).trim(), STAKE_TRANSFERS_CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-transfers?format=csv",
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

describe("chain/stake-transfers edge cache", () => {
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
              distinct_senders: 12,
              transfers: 95,
              transfers_per_sender: 7.92,
            },
            intensity_distribution: { count: 3, min: 2.5, max: 15 },
            subnets: [
              {
                netuid: 1,
                distinct_senders: 4,
                transfers: 40,
                transfers_per_sender: 10,
              },
              {
                netuid: 2,
                distinct_senders: 2,
                transfers: 30,
                transfers_per_sender: 15,
              },
              {
                netuid: 5,
                distinct_senders: 10,
                transfers: 25,
                transfers_per_sender: 2.5,
              },
            ],
          }),
      },
    };
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/stake-transfers"),
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
