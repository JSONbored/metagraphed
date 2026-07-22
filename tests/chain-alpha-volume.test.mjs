import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainAlphaVolume,
  CHAIN_ALPHA_VOLUME_LIMIT_MAX,
} from "../src/chain-alpha-volume.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One GROUP BY netuid, event_kind aggregate row from account_events, the shape
// loadChainAlphaVolume's SUM/COUNT/MAX query returns (mirrors alpha-volume.mjs's
// own per-subnet loader row shape, just without the `netuid = ?` filter).
function ev(
  netuid,
  event_kind,
  alpha_volume,
  tao_volume,
  event_count,
  last_observed = OBS,
) {
  return {
    netuid,
    event_kind,
    alpha_volume,
    tao_volume,
    event_count,
    last_observed,
  };
}

// netuid 1: total_volume_tao 130 (biggest). netuid 2: 100. netuid 3: 20 (smallest).
const ROWS = [
  ev(1, "StakeAdded", 100, 100, 5),
  ev(1, "StakeRemoved", 30, 30, 2),
  ev(2, "StakeAdded", 20, 20, 1),
  ev(2, "StakeRemoved", 80, 80, 3),
  ev(3, "StakeAdded", 10, 10, 1),
  ev(3, "StakeRemoved", 10, 10, 1),
];

describe("buildChainAlphaVolume", () => {
  test("shapes per-subnet volume ranked by total_volume_tao descending, reusing buildAlphaVolume", () => {
    const data = buildChainAlphaVolume(ROWS, {});
    assert.equal(data.schema_version, 1);
    assert.equal(data.window, "24h");
    assert.equal(data.subnet_count, 3);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
    // ranked by total_volume_tao desc: 130, 100, 20 -> [1, 2, 3]
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 2, 3],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1);
    // Each leaderboard entry is a full buildAlphaVolume scorecard (schema_version/
    // window/netuid included).
    assert.equal(s1.schema_version, 1);
    assert.equal(s1.window, "24h");
    assert.equal(s1.buy_volume_alpha, 100);
    assert.equal(s1.sell_volume_alpha, 30);
    assert.equal(s1.total_volume_alpha, 130);
    assert.equal(s1.buy_volume_tao, 100);
    assert.equal(s1.sell_volume_tao, 30);
    assert.equal(s1.total_volume_tao, 130);
    assert.equal(s1.buy_count, 5);
    assert.equal(s1.sell_count, 2);
    assert.equal(s1.net_volume_alpha, 70);
    assert.equal(s1.sentiment_ratio, 0.5385); // 70/130 rounded to 4dp
    assert.equal(s1.sentiment, "bullish");
    // No per-subnet marketCapTao is passed at the network level -> always null.
    assert.equal(s1.vol_mcap_ratio, null);
  });

  test("a subnet with only one event kind (single-sided volume) shapes correctly", () => {
    const data = buildChainAlphaVolume([ev(9, "StakeAdded", 40, 40, 3)], {});
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.buy_volume_alpha, 40);
    assert.equal(s.sell_volume_alpha, 0);
    assert.equal(s.total_volume_tao, 40);
    assert.equal(s.sentiment, "bullish");
    assert.equal(s.vol_mcap_ratio, null);
  });

  test("a subnet with both event kinds nets buy minus sell", () => {
    const data = buildChainAlphaVolume(
      [ev(9, "StakeAdded", 40, 40, 3), ev(9, "StakeRemoved", 40, 40, 3)],
      {},
    );
    const s = data.subnets[0];
    assert.equal(s.total_volume_tao, 80);
    assert.equal(s.net_volume_alpha, 0);
    assert.equal(s.sentiment, "neutral");
  });

  test("rolls up a network summary across every subnet, with its own sentiment reading", () => {
    const { network } = buildChainAlphaVolume(ROWS, {});
    assert.equal(network.buy_volume_alpha, 130); // 100 + 20 + 10
    assert.equal(network.sell_volume_alpha, 120); // 30 + 80 + 10
    assert.equal(network.total_volume_alpha, 250);
    assert.equal(network.buy_volume_tao, 130);
    assert.equal(network.sell_volume_tao, 120);
    assert.equal(network.total_volume_tao, 250);
    assert.equal(network.buy_count, 7); // 5 + 1 + 1
    assert.equal(network.sell_count, 6); // 2 + 3 + 1
    assert.equal(network.net_volume_alpha, 10);
    // 10 / 250 = 0.04, below the 0.2 neutral band -> neutral, even though the
    // individual subnets are bullish/bearish/neutral respectively.
    assert.equal(network.sentiment_ratio, 0.04);
    assert.equal(network.sentiment, "neutral");
  });

  test("a strongly buy-dominated network reads bullish", () => {
    const { network } = buildChainAlphaVolume(
      [ev(1, "StakeAdded", 90, 90, 1), ev(1, "StakeRemoved", 10, 10, 1)],
      {},
    );
    assert.equal(network.sentiment_ratio, 0.8); // (90-10)/100
    assert.equal(network.sentiment, "bullish");
  });

  test("a strongly sell-dominated network reads bearish", () => {
    const { network } = buildChainAlphaVolume(
      [ev(1, "StakeAdded", 10, 10, 1), ev(1, "StakeRemoved", 90, 90, 1)],
      {},
    );
    assert.equal(network.sentiment_ratio, -0.8); // (10-90)/100
    assert.equal(network.sentiment, "bearish");
  });

  test("summarizes the spread of per-subnet total_volume_tao into a distribution", () => {
    // per-subnet total_volume_tao [130, 100, 20] -> ascending [20, 100, 130].
    const { volume_distribution: dist } = buildChainAlphaVolume(ROWS, {});
    assert.equal(dist.count, 3);
    assert.equal(dist.mean, 83.333333333); // 250/3 rounded to rao
    assert.equal(dist.min, 20);
    assert.equal(dist.p25, 20);
    assert.equal(dist.median, 100);
    assert.equal(dist.p75, 130);
    assert.equal(dist.p90, 130);
    assert.equal(dist.max, 130);
  });

  test("distribution is null when no subnet had volume", () => {
    assert.equal(buildChainAlphaVolume([], {}).volume_distribution, null);
  });

  test("distribution counts every subnet even when the leaderboard is truncated", () => {
    const { volume_distribution: dist } = buildChainAlphaVolume(ROWS, {
      limit: 1,
    });
    assert.equal(dist.count, 3);
  });

  test("caps the leaderboard to limit but counts every subnet", () => {
    const data = buildChainAlphaVolume(ROWS, { limit: 1 });
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets.length, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("clamps a non-integer / negative / over-max / non-finite limit", () => {
    const n = (limit) => buildChainAlphaVolume(ROWS, { limit }).subnets.length;
    assert.equal(n(1.9), 1); // floored
    assert.equal(n(-5), 0); // negative -> 0
    assert.equal(n(9999), 3); // over-max clamps, capped by data
    assert.equal(n(Number.NaN), 3); // non-finite -> default
    assert.ok(CHAIN_ALPHA_VOLUME_LIMIT_MAX >= 100);
  });

  test("ignores non-volume event kinds and malformed/null netuids", () => {
    const data = buildChainAlphaVolume(
      [
        ev(1, "StakeAdded", 100, 100, 2),
        ev(1, "Transfer", 999, 999, 9), // not a volume kind -> ignored
        {
          netuid: "bad",
          event_kind: "StakeAdded",
          alpha_volume: 5,
          tao_volume: 5,
          event_count: 1,
        },
        {
          netuid: null,
          event_kind: "StakeAdded",
          alpha_volume: 5,
          tao_volume: 5,
          event_count: 1,
        },
        // Blank and whitespace-only netuid strings both coerce to 0 via Number(); they must be
        // rejected outright, never counted as subnet 0.
        {
          netuid: "",
          event_kind: "StakeAdded",
          alpha_volume: 7,
          tao_volume: 7,
          event_count: 1,
        },
        {
          netuid: "   ",
          event_kind: "StakeAdded",
          alpha_volume: 7,
          tao_volume: 7,
          event_count: 1,
        },
        ev(1, "StakeRemoved", 40, 40, 1),
      ],
      {},
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1); // not a phantom subnet 0 from the blank strings
    assert.equal(data.subnets[0].buy_volume_tao, 100); // Transfer's 999 + blank rows' 7s excluded
    assert.equal(data.subnets[0].total_volume_tao, 140);
  });

  test("a netuid whose only row is a non-volume kind is absent (no inactive bucket)", () => {
    // Subnet 7 appears solely via a Transfer row (no StakeAdded/StakeRemoved). It must not
    // materialize an all-zero "inactive" subnet: the contract represents active-volume subnets
    // only. Subnet 3 has a real volume row and is the only subnet returned.
    const data = buildChainAlphaVolume(
      [ev(7, "Transfer", 500, 500, 5), ev(3, "StakeAdded", 80, 80, 2)],
      {},
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 3);
    assert.equal(
      data.subnets.some((s) => s.netuid === 7),
      false,
    );
  });

  test("breaks a total-volume tie by netuid ascending", () => {
    // netuid 5 and netuid 3 both total_volume_tao 10 -> tie, broken by the lower netuid first.
    const data = buildChainAlphaVolume(
      [ev(5, "StakeAdded", 10, 10, 1), ev(3, "StakeAdded", 10, 10, 1)],
      {},
    );
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [3, 5],
    );
  });

  test("cold / empty input yields a schema-stable zeroed card", () => {
    for (const rows of [[], null, undefined, "not-an-array"]) {
      const data = buildChainAlphaVolume(rows, {});
      assert.equal(data.schema_version, 1);
      assert.equal(data.window, "24h");
      assert.equal(data.observed_at, null);
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.volume_distribution, null);
      assert.equal(data.network.total_volume_tao, 0);
      assert.equal(data.network.sentiment, "neutral");
      assert.equal(data.network.sentiment_ratio, null);
    }
  });

  test("rounds network TAO sums to rao precision (no IEEE-754 dust)", () => {
    const data = buildChainAlphaVolume(
      [
        ev(1, "StakeAdded", 0.1, 0.1, 1),
        ev(2, "StakeAdded", 0.1, 0.1, 1),
        ev(3, "StakeAdded", 0.1, 0.1, 1),
      ],
      {},
    );
    assert.equal(data.network.total_volume_alpha, 0.3); // not 0.30000000000000004
    assert.equal(data.network.total_volume_tao, 0.3);
  });

  test("ignores out-of-range timestamps that cannot be rendered as ISO", () => {
    const data = buildChainAlphaVolume(
      [ev(2, "StakeAdded", 5, 5, 1, 1e100), ev(3, "StakeAdded", 7, 7, 1, OBS)],
      {},
    );
    assert.equal(data.subnet_count, 2);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
  });

  test("ignores a non-numeric last_observed cell instead of throwing", () => {
    const data = buildChainAlphaVolume(
      [
        ev(2, "StakeAdded", 5, 5, 1, "not-a-timestamp"),
        ev(3, "StakeAdded", 7, 7, 1, OBS),
      ],
      {},
    );
    assert.equal(data.subnet_count, 2);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
  });
});

describe("GET /api/v1/chain/alpha-volume", () => {
  function alphaVolumeEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM account_events/.test(sql) ? rows : [],
                }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/alpha-volume${q}`);

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this handler no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    let d1Called = false;
    const env = alphaVolumeEnv(ROWS);
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const res = await handleRequest(req(), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.window, "24h");
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(typeof body.data.network, "object");
    assert.equal(d1Called, false);
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/alpha-volume", {
        method: "HEAD",
      }),
      alphaVolumeEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), alphaVolumeEnv([]), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.volume_distribution, null);
  });

  // #4832 Tier 2 pattern: METAGRAPH_ACCOUNT_EVENTS_SOURCE reused (same account_events table
  // this handler already reads, no new flag) -- tryPostgresTier's own fallback contract is
  // unit-tested in workers/postgres-tier.ts's own tests, so these two just prove the wiring.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = {
      ...alphaVolumeEnv([]),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "24h",
            observed_at: "2026-01-01T00:00:00.000Z",
            subnet_count: 99,
            network: {},
            volume_distribution: null,
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
    const res = await handleRequest(req(), env, {});
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
      ...alphaVolumeEnv(ROWS),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await handleRequest(req(), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
  });

  test("rejects a ?window= param with 400 (fixed 24h window, no windowing on this route)", async () => {
    const res = await handleRequest(req("?window=7d"), alphaVolumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), alphaVolumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), alphaVolumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  // #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
  // export is always header-only now (account_events is retired).
  test("CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      alphaVolumeEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-alpha-volume\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      "netuid,buy_volume_alpha,sell_volume_alpha,total_volume_alpha,buy_volume_tao,sell_volume_tao,total_volume_tao,buy_count,sell_count,net_volume_alpha,sentiment_ratio,sentiment,vol_mcap_ratio",
    );
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/alpha-volume", {
        headers: { accept: "text/csv" },
      }),
      alphaVolumeEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(req("?format=csv"), alphaVolumeEnv([]), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(
      (await res.text()).trim(),
      "netuid,buy_volume_alpha,sell_volume_alpha,total_volume_alpha,buy_volume_tao,sell_volume_tao,total_volume_tao,buy_count,sell_count,net_volume_alpha,sentiment_ratio,sentiment,vol_mcap_ratio",
    );
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/alpha-volume?format=csv",
        { method: "HEAD" },
      ),
      alphaVolumeEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(req("?format=xml"), alphaVolumeEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/alpha-volume edge cache", () => {
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
      // A non-null health:meta stamp so withEdgeCache actually engages (it skips caching when
      // the analytics cron stamp is null).
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
                  results: /FROM account_events/.test(sql) ? ROWS : [],
                }),
            }),
          };
        },
      },
    };
    // withEdgeCache writes via ctx.waitUntil, so capture the background put and await it.
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/alpha-volume"),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    const body = await res.json();
    // #4909/#6013: account_events is retired, so even this "warm" D1 mock
    // never reaches the response -- subnet_count stays 0.
    assert.equal(body.data.subnet_count, 0);
    await Promise.all(waits); // let the deferred cache put settle
    assert.equal(store.size, 1); // the response was cached under one key
    // A second request is served from that cached entry (the mocked match() returns it).
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 0);
  });
});
