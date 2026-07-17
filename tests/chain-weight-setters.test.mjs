import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainWeightSetters,
  CHAIN_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW,
  CHAIN_WEIGHT_SETTERS_LIMIT_MAX,
} from "../src/chain-weight-setters.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// Two per-setter leaderboard rows + the network-wide totals, matching the
// shape buildChainWeightSetters expects.
const LEADER_ROWS = [
  {
    hotkey: "5Grw...alice",
    uid: 3,
    weight_sets: 30,
    first_set: 1_750_000_000_000,
    last_set: 1_750_600_000_000,
  },
  {
    hotkey: null, // a uid-only setter (hotkey absent on the WeightsSet events)
    uid: 8,
    weight_sets: 10,
    first_set: 1_750_100_000_000,
    last_set: 1_750_200_000_000,
  },
];
const TOTALS = {
  weight_sets: 40,
  distinct_setters: 2,
  newest_observed: 1_750_600_000_000,
};

describe("buildChainWeightSetters", () => {
  test("cold / null inputs yield a schema-stable empty leaderboard", () => {
    for (const [rows, totals] of [
      [null, null],
      [undefined, undefined],
      [[], {}],
    ]) {
      const d = buildChainWeightSetters(rows, totals, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_setters, 0);
      assert.equal(d.weight_sets, 0);
      assert.equal(d.setter_count, 0);
      assert.deepEqual(d.setters, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildChainWeightSetters([], {}).window, null);
  });

  test("limit of 0 yields an empty leaderboard, not a single row", () => {
    const d = buildChainWeightSetters(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: 0,
    });
    assert.equal(d.setters.length, 0);
    assert.equal(d.distinct_setters, 2); // network total unaffected by limit
  });

  test("limit caps the returned page; distinct_setters stays the network-wide total", () => {
    const d = buildChainWeightSetters(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: 1,
    });
    assert.equal(d.setters.length, 1);
    assert.equal(d.setter_count, 1);
    assert.equal(d.distinct_setters, 2);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainWeightSetters(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: CHAIN_WEIGHT_SETTERS_LIMIT_MAX + 500,
    });
    assert.equal(big.setters.length, 2);
    const bogus = buildChainWeightSetters(LEADER_ROWS, TOTALS, {
      window: "7d",
      limit: "abc",
    });
    assert.equal(bogus.setters.length, 2);
  });

  test("a near-monopoly setter's share does not round up to a flat 1 while others set weights", () => {
    // One setter drove 49999 of the network's 50000 WeightsSet events (99.998%);
    // a second setter drove the last 1. A bare 4dp round lifts 0.99998 to exactly
    // 1, reading as if the top setter did ALL the weight-setting network-wide.
    const d = buildChainWeightSetters(
      [
        { hotkey: "5Grw...alice", uid: 3, weight_sets: 49999 },
        { hotkey: "5Frw...bob", uid: 4, weight_sets: 1 },
      ],
      { weight_sets: 50000, distinct_setters: 2 },
    );
    assert.ok(d.setters[0].share < 1, "near-monopoly share must stay below 1");
    assert.equal(d.setters[0].share, 0.9999);
    assert.equal(d.setters[1].share, 0); // 1/50000 rounds to 0.0000 at 4dp
  });

  test("a genuine sole setter keeps an exact share of 1", () => {
    const d = buildChainWeightSetters(
      [{ hotkey: "5Grw...alice", uid: 3, weight_sets: 100 }],
      { weight_sets: 100, distinct_setters: 1 },
    );
    assert.equal(d.setters[0].share, 1);
  });

  test("shapes the leaderboard: counts, shares, first/last, nullable hotkey/uid", () => {
    const d = buildChainWeightSetters(LEADER_ROWS, TOTALS, { window: "30d" });
    assert.equal(d.distinct_setters, 2);
    assert.equal(d.weight_sets, 40);
    assert.equal(d.setter_count, 2);
    assert.equal(d.observed_at, new Date(1_750_600_000_000).toISOString());

    const [a, b] = d.setters;
    assert.equal(a.hotkey, "5Grw...alice");
    assert.equal(a.uid, 3);
    assert.equal(a.weight_sets, 30);
    assert.equal(a.share, 0.75); // 30 / 40
    assert.equal(a.first_set_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(a.last_set_at, new Date(1_750_600_000_000).toISOString());

    assert.equal(b.hotkey, null); // uid-only setter
    assert.equal(b.netuid, null); // legacy/no netuid cell stays null
    assert.equal(b.uid, 8);
    assert.equal(b.share, 0.25); // 10 / 40
  });

  test("preserves subnet scope for duplicate uid-only chain setters", () => {
    const d = buildChainWeightSetters(
      [
        { hotkey: null, netuid: 1, uid: 7, weight_sets: 3 },
        { hotkey: null, netuid: 2, uid: 7, weight_sets: 2 },
      ],
      { weight_sets: 5, distinct_setters: 2 },
    );
    assert.deepEqual(
      d.setters.map((setter) => ({
        hotkey: setter.hotkey,
        netuid: setter.netuid,
        uid: setter.uid,
      })),
      [
        { hotkey: null, netuid: 1, uid: 7 },
        { hotkey: null, netuid: 2, uid: 7 },
      ],
    );
  });

  test("share is null when the network total is zero", () => {
    const d = buildChainWeightSetters(
      [{ hotkey: "5x", uid: 1, weight_sets: 0 }],
      { weight_sets: 0, distinct_setters: 0 },
    );
    assert.equal(d.setters[0].share, null);
  });

  test("rounds share to 4dp", () => {
    const d = buildChainWeightSetters(
      [{ hotkey: "5x", uid: 1, weight_sets: 1 }],
      {
        weight_sets: 3,
        distinct_setters: 1,
      },
    );
    assert.equal(d.setters[0].share, 0.3333); // 1/3 = 0.3333...
  });

  test("coerces numeric-string cells and drops junk uid / hotkey / timestamps", () => {
    const d = buildChainWeightSetters(
      [
        {
          hotkey: "", // blank -> null
          uid: "12", // numeric string -> 12
          weight_sets: "5",
          first_set: "1750000000000", // numeric-string epoch
          last_set: "not-a-date", // junk -> null
        },
        {
          hotkey: 42, // non-string -> null
          uid: -1, // negative -> null
          weight_sets: -3, // negative -> 0
          first_set: 9e15, // out-of-range -> null
          last_set: 0, // <=0 -> null
        },
        {
          hotkey: "5real", // a hotkey-identified setter that carries no uid
          uid: null, // absent -> null (not a number, not a digit-string)
          weight_sets: 2,
        },
      ],
      { weight_sets: 7, distinct_setters: 2 },
    );
    assert.equal(d.setters[0].hotkey, null);
    assert.equal(d.setters[0].uid, 12);
    assert.equal(d.setters[0].weight_sets, 5);
    assert.equal(
      d.setters[0].first_set_at,
      new Date(1_750_000_000_000).toISOString(),
    );
    assert.equal(d.setters[0].last_set_at, null);
    assert.equal(d.setters[1].hotkey, null);
    assert.equal(d.setters[1].uid, null);
    assert.equal(d.setters[1].weight_sets, 0);
    assert.equal(d.setters[1].first_set_at, null);
    assert.equal(d.setters[1].last_set_at, null);
    assert.equal(d.setters[2].hotkey, "5real"); // hotkey kept
    assert.equal(d.setters[2].uid, null); // uid absent -> null
  });

  test("null-safe on a non-array rows input", () => {
    const d = buildChainWeightSetters("nope", TOTALS);
    assert.deepEqual(d.setters, []);
    assert.equal(d.weight_sets, 40); // totals still read
  });

  test("exposes the window map, default, and leaderboard limit max", () => {
    assert.deepEqual(CHAIN_WEIGHT_SETTERS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_CHAIN_WEIGHT_SETTERS_WINDOW, "7d");
    assert.equal(CHAIN_WEIGHT_SETTERS_LIMIT_MAX, 100);
  });
});

// D1 fully eliminated (2026-07-16): account_events' D1 write path is retired
// (#4772) and the table is dropped in production, so loadChainWeightSetters
// (the D1-querying loader) is gone -- the handler now degrades straight to
// buildChainWeightSetters([], null, {...}) on any Postgres miss/outage.
describe("GET /api/v1/chain/weights/setters", () => {
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/weights/setters${q}`);

  function postgresEnv(body) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json(body),
      },
    };
  }

  test("returns the leaderboard at the requested window", async () => {
    const res = await handleRequest(
      req("?window=30d"),
      postgresEnv({
        schema_version: 1,
        window: "30d",
        observed_at: "2026-01-01T00:00:00.000Z",
        distinct_setters: 2,
        weight_sets: 40,
        setter_count: 2,
        setters: [
          { hotkey: "5Grw...alice", uid: 3, weight_sets: 30, share: 0.75 },
          { hotkey: null, uid: 8, weight_sets: 10, share: 0.25 },
        ],
      }),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.setter_count, 2);
    assert.equal(body.data.setters[0].share, 0.75);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/weights/setters.json",
    );
  });

  test("defaults to the 7d window when omitted", async () => {
    const res = await handleRequest(req(), createLocalArtifactEnv(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "7d");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/weights/setters", {
        method: "HEAD",
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("rejects an unknown query parameter with 400", async () => {
    const res = await handleRequest(
      req("?bogus=1"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=1y"),
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

  test("cold store (no Postgres tier flag) → 200 with an empty leaderboard", async () => {
    const res = await handleRequest(req(), createLocalArtifactEnv(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.setter_count, 0);
    assert.deepEqual(body.data.setters, []);
  });

  test("flag=postgres serves the DATA_API response", async () => {
    const res = await handleRequest(
      req("?window=7d"),
      postgresEnv({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-01-01T00:00:00.000Z",
        setter_count: 99,
        setters: [{ hotkey: "5Pg", weight_sets: 1 }],
      }),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.setter_count, 99);
  });

  test("flag=postgres degrades to the empty leaderboard when DATA_API fails", async () => {
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
    assert.equal(body.data.setter_count, 0);
  });

  const WEIGHT_SETTERS_CSV_HEADER =
    "hotkey,netuid,uid,weight_sets,share,first_set_at,last_set_at";

  test("exports the leaderboard as CSV with ?format=csv", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      postgresEnv({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-01-01T00:00:00.000Z",
        distinct_setters: 2,
        weight_sets: 40,
        setter_count: 2,
        setters: [
          { hotkey: "5Grw...alice", uid: 3, weight_sets: 30, share: 0.75 },
          { hotkey: null, uid: 8, weight_sets: 10, share: 0.25 },
        ],
      }),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-weight-setters\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], WEIGHT_SETTERS_CSV_HEADER);
    assert.equal(lines.length, 3); // header + 2 setter rows
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), WEIGHT_SETTERS_CSV_HEADER);
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
