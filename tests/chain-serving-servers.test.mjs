import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainServingServers,
  loadChainServingServers,
  CHAIN_SERVING_SERVERS_WINDOWS,
  DEFAULT_CHAIN_SERVING_SERVERS_WINDOW,
  CHAIN_SERVING_SERVERS_LIMIT_MAX,
} from "../src/chain-serving-servers.mjs";
import { SERVING_EVENT_KIND } from "../src/chain-serving.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// Two per-server leaderboard rows + the network-wide totals, as the two D1 reads return them.
const LEADER_ROWS = [
  {
    hotkey: "5Grw...alice",
    uid: 3,
    announcements: 30,
    first_served: 1_750_000_000_000,
    last_served: 1_750_600_000_000,
  },
  {
    hotkey: null, // a uid-only server (hotkey absent on the AxonServed events)
    uid: 8,
    announcements: 10,
    first_served: 1_750_100_000_000,
    last_served: 1_750_200_000_000,
  },
];
const TOTALS = {
  announcements: 40,
  distinct_servers: 2,
  newest_observed: 1_750_600_000_000,
};

describe("buildChainServingServers", () => {
  test("cold / null inputs yield a schema-stable empty leaderboard", () => {
    for (const [rows, totals] of [
      [null, null],
      [undefined, undefined],
      [[], {}],
    ]) {
      const d = buildChainServingServers(rows, totals, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_servers, 0);
      assert.equal(d.announcements, 0);
      assert.equal(d.server_count, 0);
      assert.deepEqual(d.servers, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildChainServingServers([], {}).window, null);
  });

  test("limit of 0 yields an empty leaderboard, not a single row", () => {
    const d = buildChainServingServers(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: 0,
    });
    assert.equal(d.servers.length, 0);
    assert.equal(d.distinct_servers, 2); // network total unaffected by limit
  });

  test("limit caps the returned page; distinct_servers stays the network-wide total", () => {
    const d = buildChainServingServers(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: 1,
    });
    assert.equal(d.servers.length, 1);
    assert.equal(d.server_count, 1);
    assert.equal(d.distinct_servers, 2);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainServingServers(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: CHAIN_SERVING_SERVERS_LIMIT_MAX + 500,
    });
    assert.equal(big.servers.length, 2);
    const bogus = buildChainServingServers(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: "abc",
    });
    assert.equal(bogus.servers.length, 2);
  });

  test("a near-monopoly server's share does not round up to a flat 1 while others serve", () => {
    // One server drove 49999 of the network's 50000 AxonServed events (99.998%);
    // a second server drove the last 1. A bare 4dp round lifts 0.99998 to exactly
    // 1, reading as if the top server did ALL the serving network-wide.
    const d = buildChainServingServers(
      [
        { hotkey: "5Grw...alice", uid: 3, announcements: 49999 },
        { hotkey: "5Frw...bob", uid: 4, announcements: 1 },
      ],
      { announcements: 50000, distinct_servers: 2 },
    );
    assert.ok(d.servers[0].share < 1, "near-monopoly share must stay below 1");
    assert.equal(d.servers[0].share, 0.9999);
    assert.equal(d.servers[1].share, 0); // 1/50000 rounds to 0.0000 at 4dp
  });

  test("a genuine sole server keeps an exact share of 1", () => {
    const d = buildChainServingServers(
      [{ hotkey: "5Grw...alice", uid: 3, announcements: 100 }],
      { announcements: 100, distinct_servers: 1 },
    );
    assert.equal(d.servers[0].share, 1);
  });

  test("shapes the leaderboard: counts, shares, first/last, nullable hotkey/uid", () => {
    const d = buildChainServingServers(LEADER_ROWS, TOTALS, { window: "30d" });
    assert.equal(d.distinct_servers, 2);
    assert.equal(d.announcements, 40);
    assert.equal(d.server_count, 2);
    assert.equal(d.observed_at, new Date(1_750_600_000_000).toISOString());

    const [a, b] = d.servers;
    assert.equal(a.hotkey, "5Grw...alice");
    assert.equal(a.uid, 3);
    assert.equal(a.announcements, 30);
    assert.equal(a.share, 0.75); // 30 / 40
    assert.equal(a.first_served_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(a.last_served_at, new Date(1_750_600_000_000).toISOString());

    assert.equal(b.hotkey, null); // uid-only server
    assert.equal(b.uid, 8);
    assert.equal(b.share, 0.25); // 10 / 40
  });

  test("share is null when the network total is zero", () => {
    const d = buildChainServingServers(
      [{ hotkey: "5x", uid: 1, announcements: 0 }],
      { announcements: 0, distinct_servers: 0 },
    );
    assert.equal(d.servers[0].share, null);
  });

  test("rounds share to 4dp", () => {
    const d = buildChainServingServers(
      [{ hotkey: "5x", uid: 1, announcements: 1 }],
      {
        announcements: 3,
        distinct_servers: 1,
      },
    );
    assert.equal(d.servers[0].share, 0.3333); // 1/3 = 0.3333...
  });

  test("coerces numeric-string cells and drops junk uid / hotkey / timestamps", () => {
    const d = buildChainServingServers(
      [
        {
          hotkey: "", // blank -> null
          uid: "12", // numeric string -> 12
          announcements: "5",
          first_served: "1750000000000", // numeric-string epoch
          last_served: "not-a-date", // junk -> null
        },
        {
          hotkey: 42, // non-string -> null
          uid: -1, // negative -> null
          announcements: -3, // negative -> 0
          first_served: 9e15, // out-of-range -> null
          last_served: 0, // <=0 -> null
        },
        {
          hotkey: "5real", // a hotkey-identified server that carries no uid
          uid: null, // absent -> null (not a number, not a digit-string)
          announcements: 2,
        },
      ],
      { announcements: 7, distinct_servers: 2 },
    );
    assert.equal(d.servers[0].hotkey, null);
    assert.equal(d.servers[0].uid, 12);
    assert.equal(d.servers[0].announcements, 5);
    assert.equal(
      d.servers[0].first_served_at,
      new Date(1_750_000_000_000).toISOString(),
    );
    assert.equal(d.servers[0].last_served_at, null);
    assert.equal(d.servers[1].hotkey, null);
    assert.equal(d.servers[1].uid, null);
    assert.equal(d.servers[1].announcements, 0);
    assert.equal(d.servers[1].first_served_at, null);
    assert.equal(d.servers[1].last_served_at, null);
    assert.equal(d.servers[2].hotkey, "5real"); // hotkey kept
    assert.equal(d.servers[2].uid, null); // uid absent -> null
  });

  test("null-safe on a non-array rows input", () => {
    const d = buildChainServingServers("nope", TOTALS);
    assert.deepEqual(d.servers, []);
    assert.equal(d.announcements, 40); // totals still read
  });

  test("exposes the window map, default, and leaderboard limit max", () => {
    assert.deepEqual(CHAIN_SERVING_SERVERS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_CHAIN_SERVING_SERVERS_WINDOW, "7d");
    assert.equal(CHAIN_SERVING_SERVERS_LIMIT_MAX, 100);
  });
});

describe("loadChainServingServers", () => {
  test("runs the leaderboard + totals reads over account_events (no netuid filter) and shapes them", async () => {
    const captured = [];
    const d1 = async (sql, params) => {
      captured.push({ sql, params });
      return sql.includes("GROUP BY") ? LEADER_ROWS : [TOTALS];
    };
    const d = await loadChainServingServers(d1, {
      windowLabel: "7d",
      windowDays: 7,
      limit: 20,
    });
    // Leaderboard read: grouped by the hotkey-or-(netuid,uid) identity, capped, ordered.
    const leader = captured.find((c) => c.sql.includes("GROUP BY"));
    assert.match(leader.sql, /FROM account_events/);
    assert.doesNotMatch(leader.sql, /netuid = \?/); // network-wide: no netuid filter
    assert.match(leader.sql, /WHEN hotkey IS NOT NULL/);
    assert.match(leader.sql, /'uid:' \|\| netuid \|\| ':' \|\| uid/);
    assert.match(leader.sql, /ORDER BY announcements DESC/);
    assert.equal(leader.params[0], SERVING_EVENT_KIND);
    assert.equal(typeof leader.params[1], "number"); // cutoff epoch ms
    // Totals read: distinct-server count over the same identity, no GROUP BY.
    const totals = captured.find((c) => c.sql.includes("COUNT(DISTINCT"));
    assert.doesNotMatch(totals.sql, /GROUP BY/);
    assert.equal(d.server_count, 2);
    assert.equal(d.announcements, 40);
    assert.equal(d.servers[0].share, 0.75);
  });

  test("a cold store (no rows) yields the empty leaderboard", async () => {
    const d = await loadChainServingServers(async () => [], {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.server_count, 0);
    assert.equal(d.announcements, 0);
    assert.deepEqual(d.servers, []);
  });
});

describe("GET /api/v1/chain/serving/servers", () => {
  function eventsEnv(leaderRows, totalsRow) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: sql.includes("GROUP BY")
                    ? leaderRows
                    : totalsRow
                      ? [totalsRow]
                      : [],
                }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/serving/servers${q}`);

  test("returns the leaderboard at the requested window", async () => {
    const res = await handleRequest(
      req("?window=30d"),
      eventsEnv(LEADER_ROWS, TOTALS),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.server_count, 2);
    assert.equal(body.data.servers[0].share, 0.75);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/serving/servers.json",
    );
  });

  test("defaults to the 7d window when omitted", async () => {
    const res = await handleRequest(req(), eventsEnv([], null), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "7d");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/serving/servers", {
        method: "HEAD",
      }),
      eventsEnv(LEADER_ROWS, TOTALS),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("rejects an unknown query parameter with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), eventsEnv([], null), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(req("?window=1y"), eventsEnv([], null), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), eventsEnv([], null), {});
    assert.equal(res.status, 400);
  });

  test("cold store → 200 with an empty leaderboard", async () => {
    const res = await handleRequest(req(), eventsEnv([], null), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.server_count, 0);
    assert.deepEqual(body.data.servers, []);
  });

  const SERVERS_CSV_HEADER =
    "hotkey,uid,announcements,share,first_served_at,last_served_at";

  test("exports the leaderboard as CSV with ?format=csv", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      eventsEnv(LEADER_ROWS, TOTALS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-serving-servers\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], SERVERS_CSV_HEADER);
    assert.equal(lines.length, 3); // header + 2 server rows
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      eventsEnv([], null),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), SERVERS_CSV_HEADER);
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      req("?format=xml"),
      eventsEnv([], null),
      {},
    );
    assert.equal(res.status, 400);
  });
});
