// The TAO/USD index reader (src/tao-usd-series.ts, #9609).
//
// One property carries the weight: A NULL PRICE IS A STATED OUTCOME.
//
// The producer writes `price_basis: insufficient_pools` with a NULL
// `usd_per_tao` when the two-pool quorum was not met, and
// tests/fixtures/sqlite-schema/0004_user_state.sql enforces that pairing as a CHECK
// constraint. So this reader must never coalesce the null to 0 — the two say
// opposite things ("not priceable at that block" vs "TAO is worthless"), and
// the producer and the schema both went to the trouble of distinguishing them.
//
// That extends past the scalar: an unpriced block must not bound the window's
// change calculation either, or a gap in pricing renders as a crash and a
// recovery that never happened.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The SERVED path (route, GraphQL, MCP) resolves its store through
// `readStore(env, TAO_USD_TABLES)`, which builds a `new Client(...)` now that
// Neon is the only store (#10179) -- there is no binding a caller can hand in.
// Mocking the module is the seam, and the real SQLite fixture below is
// attached to the mock's controller so the served path executes the same SQL
// against the same DDL the loader tests use. See tests/helpers/pg-mock.ts for
// why the controller has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  DEFAULT_TAO_USD_WINDOW,
  TAO_USD_MAX_POINTS,
  TAO_USD_WINDOWS,
  buildTaoUsdSeries,
  loadTaoUsdSeries,
} from "../src/tao-usd-series.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";
import { TAO_USD_MAX_AGE_MS } from "../src/alpha-usd.ts";

// The real DDL, so the CHECK constraint that pairs a null price with
// `insufficient_pools` is enforced in the fixtures too — a test that could
// insert a null price under `wrapped_onchain_median` would be testing a state
// production cannot reach.
const SCHEMA = (() => {
  const sql = fs.readFileSync(
    path.join(
      process.cwd(),
      "tests/fixtures/sqlite-schema/0004_user_state.sql",
    ),
    "utf8",
  );
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS tao_usd_index");
  const end = sql.indexOf(
    "CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed",
  );
  const endStmt = sql.indexOf(";", end);
  return sql.slice(start, endStmt + 1);
})();

// THE FIXTURE CLOCK MUST TRACK THE REAL ONE, and this was a hardcoded
// 1_785_979_535_000 (2026-08-06T01:25:35Z) until it aged out.
//
// Two kinds of test share this file. The loader tests inject their own clock
// (`now: () => NOW`) and are immune to what the wall clock says. The route,
// GraphQL and MCP tests go through the SERVED path, which has no injection
// point and filters against real `Date.now()` — so they seed rows at
// `NOW - offset` and then ask a handler to select them relative to now.
//
// With an absolute NOW those two halves drift apart at one second per second.
// Once the gap passed DEFAULT_TAO_USD_WINDOW (24h) every seeded row fell
// outside the window and `point_count` went 2 → 0: three tests that had
// passed for months began failing on 2026-08-07 and would have failed every
// day after. Anchoring to Date.now() keeps the seeded rows a fixed distance
// from whenever the suite actually runs, which is what the served-path tests
// were always assuming.
const NOW = Date.now();
const POOLS = JSON.stringify([
  { address: "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc", included: true },
  { address: "0x0000000000000000000000000000000000000002", included: false },
]);

let db: InstanceType<typeof DatabaseSync>;

/** The store handle the LOADER tests inject directly -- loadTaoUsdSeries takes
 * one, so those tests never need the module mock. */
function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
  };
}

/** The env the SERVED path resolves its own store from. `pg.control.db` is
 * assigned in beforeEach, so the same in-memory fixture answers both halves of
 * this file. */
const env = () => ({ ...pgMockEnv() }) as unknown as Env;

function reading(
  offsetMs: number,
  usd: number | null,
  block = 25_692_599,
  pools = POOLS,
) {
  db.prepare(
    `INSERT INTO tao_usd_index
       (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    block,
    NOW - offsetMs,
    usd,
    usd === null ? "insufficient_pools" : "wrapped_onchain_median",
    1906.04,
    usd === null ? 0 : 2,
    pools,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  pg.control.db = db;
  pg.control.queries.length = 0;
});

describe("loadTaoUsdSeries against real SQLite", () => {
  test("returns the window newest-first and excludes older rows", async () => {
    reading(0, 196.17, 100);
    reading(60_000, 196.2, 99);
    reading(3 * 60 * 60 * 1000, 190, 98); // outside a 1h window
    const rows = await loadTaoUsdSeries(d1(), {
      windowHours: 1,
      now: () => NOW,
    });
    assert.deepEqual(
      rows?.map((r) => r.block_number),
      [100, 99],
    );
  });

  test("no binding and a failed read both return null", async () => {
    assert.equal(
      await loadTaoUsdSeries(null, { windowHours: 1, now: () => NOW }),
      null,
    );
    db.exec("DROP TABLE tao_usd_index");
    assert.equal(
      await loadTaoUsdSeries(d1(), { windowHours: 1, now: () => NOW }),
      null,
    );
  });

  test("the schema itself refuses a priced row with no price", () => {
    // Proves the fixture is honest: the CHECK is what makes "null means
    // insufficient_pools" a fact rather than a convention this reader assumes.
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO tao_usd_index (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
           VALUES (1, 1, NULL, 'wrapped_onchain_median', 1900, 2, '[]')`,
        )
        .run(),
    );
  });
});

describe("buildTaoUsdSeries", () => {
  test("carries the latest reading with its whole derivation", async () => {
    reading(0, 196.17);
    const card = buildTaoUsdSeries(
      await loadTaoUsdSeries(d1(), { windowHours: 24, now: () => NOW }),
      { window: "24h" },
    );
    const latest = card.latest as Row;
    assert.equal(latest.usd_per_tao, 196.17);
    assert.equal(latest.price_basis, "wrapped_onchain_median");
    assert.equal(latest.eth_usd, 1906.04);
    assert.equal(latest.pool_count, 2);
    // The per-pool breakdown is parsed, not passed through as a blob.
    assert.equal((latest.pools as unknown[]).length, 2);
  });

  test("a null price survives as null, with its basis stated", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: NOW,
        usd_per_tao: null,
        price_basis: "insufficient_pools",
        eth_usd: 1906,
        pool_count: 0,
        pools: "[]",
      },
    ]);
    const latest = card.latest as Row;
    // THE ASSERTION THIS FILE EXISTS FOR.
    assert.equal(latest.usd_per_tao, null);
    assert.notEqual(latest.usd_per_tao, 0);
    assert.equal(latest.price_basis, "insufficient_pools");
    assert.equal((card.points as Row[])[0].usd_per_tao, null);
    // Counted as a point, but not as a priced one.
    assert.equal(card.point_count, 1);
    assert.equal(card.priced_point_count, 0);
  });

  test("an unpriced block does not bound the change calculation", () => {
    // Newest priced 200, oldest priced 190 -> +10. The unpriced row in between
    // and at the end must not become a 0 and turn this into a crash.
    const card = buildTaoUsdSeries([
      {
        block_number: 4,
        observed_at: NOW,
        usd_per_tao: 200,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
      {
        block_number: 3,
        observed_at: NOW - 1000,
        usd_per_tao: null,
        price_basis: "insufficient_pools",
        eth_usd: 1,
        pool_count: 0,
        pools: "[]",
      },
      {
        block_number: 2,
        observed_at: NOW - 2000,
        usd_per_tao: 190,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
      {
        block_number: 1,
        observed_at: NOW - 3000,
        usd_per_tao: null,
        price_basis: "insufficient_pools",
        eth_usd: 1,
        pool_count: 0,
        pools: "[]",
      },
    ]);
    assert.equal(card.change_usd, 10);
    assert.equal(card.point_count, 4);
    assert.equal(card.priced_point_count, 2);
    assert.equal(Math.round((card.change_pct as number) * 1e6) / 1e6, 0.052632);
  });

  test("a single priced point has no change", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
    ]);
    assert.equal(card.change_usd, null);
    assert.equal(card.change_pct, null);
  });

  test("an empty or unreadable window is a card, not a throw", () => {
    for (const rows of [null, undefined, [], "nope" as unknown]) {
      const card = buildTaoUsdSeries(rows as never, { window: "24h" });
      assert.equal(card.point_count, 0);
      assert.equal(card.priced_point_count, 0);
      assert.equal(card.latest, null);
      assert.equal(card.oldest_observed_at, null);
      assert.equal(card.change_usd, null);
      assert.deepEqual(card.points, []);
    }
  });

  test("reports how far back the answer actually reaches", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 2,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
      {
        block_number: 1,
        observed_at: NOW - 7200_000,
        usd_per_tao: 195,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
    ]);
    // The series is days deep, so a 30d window returns what exists -- this is
    // the field that says so rather than leaving it to an array length.
    assert.equal(
      card.oldest_observed_at,
      new Date(NOW - 7200_000).toISOString(),
    );
  });

  test("a malformed pools blob degrades to an empty list, not a failed card", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools: "{not json",
      },
    ]);
    // The scalar is useful without the breakdown; the reverse is not true.
    assert.deepEqual((card.latest as Row).pools, []);
    assert.equal((card.latest as Row).usd_per_tao, 196);
  });

  test.each([
    ['"a string"', []],
    ["{}", []],
    ["null", []],
  ])("a non-array pools payload %s yields %j", (pools, expected) => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "wrapped_onchain_median",
        eth_usd: 1,
        pool_count: 2,
        pools,
      },
    ]);
    assert.deepEqual((card.latest as Row).pools, expected);
  });

  test("a zero, negative or non-finite price reads as unpriceable", () => {
    // Null already carries "could not price", so a nonsense number must land
    // there rather than being published as a real quote.
    for (const bad of [0, -5, Number.NaN, "junk", null]) {
      const card = buildTaoUsdSeries([
        {
          block_number: 1,
          observed_at: NOW,
          usd_per_tao: bad,
          price_basis: "x",
          eth_usd: 1,
          pool_count: 0,
          pools: "[]",
        },
      ]);
      assert.equal((card.latest as Row).usd_per_tao, null);
    }
  });

  test("a row with no usable timestamp is dropped", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: 0,
        usd_per_tao: 196,
        price_basis: "x",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
    ]);
    assert.equal(card.point_count, 0);
    // `latest` still reflects the newest ROW, whose stamp is simply null.
    assert.equal((card.latest as Row).observed_at, null);
  });

  test("a non-string price_basis and non-integer block are nulled", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1.5,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: 42,
        eth_usd: -1,
        pool_count: -3,
        pools: "[]",
      },
    ]);
    const latest = card.latest as Row;
    assert.equal(latest.price_basis, null);
    assert.equal(latest.block_number, null);
    assert.equal(latest.eth_usd, null);
    assert.equal(latest.pool_count, null);
  });

  test("a non-string pools column yields an empty list", () => {
    // The column is TEXT, but a shim or a future writer could hand back a
    // parsed value; typeof-guarding before JSON.parse keeps that from throwing.
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "x",
        eth_usd: 1,
        pool_count: 2,
        pools: [{ a: 1 }],
      },
    ]);
    assert.deepEqual((card.latest as Row).pools, []);
  });

  test("an absent block_number is null rather than zero", () => {
    // Number(null) is 0 and 0 is a plausible-looking block height, so the
    // null-guard is what keeps a missing block from reading as genesis.
    const card = buildTaoUsdSeries([
      {
        block_number: null,
        observed_at: NOW,
        usd_per_tao: 196,
        price_basis: "x",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
    ]);
    assert.equal((card.latest as Row).block_number, null);
    assert.equal((card.points as Row[])[0].block_number, null);
  });

  test("an out-of-range stamp is null, not a thrown RangeError", () => {
    const card = buildTaoUsdSeries([
      {
        block_number: 1,
        observed_at: 1e300,
        usd_per_tao: 196,
        price_basis: "x",
        eth_usd: 1,
        pool_count: 2,
        pools: "[]",
      },
    ]);
    assert.equal((card.latest as Row).observed_at, null);
    assert.equal(card.point_count, 0);
  });

  test("the window vocabulary and cap are what the contract publishes", () => {
    assert.deepEqual(Object.keys(TAO_USD_WINDOWS), ["1h", "24h", "7d", "30d"]);
    assert.equal(DEFAULT_TAO_USD_WINDOW, "24h");
    assert.equal(TAO_USD_MAX_POINTS, 2000);
  });
});

describe("buildTaoUsdSeries — include_points (#9720)", () => {
  // `observed_at` is epoch ms on the wire, newest first -- the shape
  // loadTaoUsdSeries returns.
  const BASE = Date.parse("2026-08-07T00:00:00.000Z");
  const rows = [
    { observed_at: BASE + 120_000, block_number: 3, usd_per_tao: 200 },
    { observed_at: BASE + 60_000, block_number: 2, usd_per_tao: null },
    { observed_at: BASE, block_number: 1, usd_per_tao: 100 },
  ];

  test("the series rides along by default", () => {
    const card = buildTaoUsdSeries(rows, { window: "24h" });
    assert.equal(Array.isArray(card.points), true);
    assert.equal((card.points as Row[]).length, 3);
  });

  test("include_points false OMITS the key, never empties it", () => {
    // An empty array is indistinguishable from a window that priced nothing.
    // Absence is the only shape that says "you asked not to be sent these".
    const card = buildTaoUsdSeries(rows, {
      window: "24h",
      includePoints: false,
    });
    assert.equal("points" in card, false);
  });

  test("NARROWING THE RESPONSE NEVER NARROWS THE MEASUREMENT", () => {
    // Every summary must be computed over the FULL window either way -- the
    // whole value of the toggle is that dropping the series costs nothing.
    //
    // Both calls are pinned to ONE instant. `age_ms` is clock-derived, so two
    // calls on the live clock differ by a millisecond whenever they straddle
    // one -- which asserts that two Date.now() reads agree, not that the toggle
    // preserves the measurement. The pin keeps this testing its own claim.
    const now = () => BASE + 300_000;
    const withPoints = buildTaoUsdSeries(rows, { window: "24h", now });
    const without = buildTaoUsdSeries(rows, {
      window: "24h",
      includePoints: false,
      now,
    });
    const { points: _dropped, ...summary } = withPoints as Row;
    assert.deepEqual(without, summary);
    // Spelled out, because these are the numbers a caller keeps.
    assert.equal(without.point_count, 3);
    assert.equal(without.priced_point_count, 2);
    assert.equal(without.change_usd, 100);
    assert.equal(without.change_pct, 1);
    assert.equal((without.latest as Row).usd_per_tao, 200);
    assert.equal(without.oldest_observed_at, new Date(BASE).toISOString());
  });
});

describe("GET /api/v1/network/tao-usd", () => {
  const get = (p: string, e?: Env) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${p}`),
      e ?? env(),
      {} as unknown as ExecutionContext,
    );
  const body = async (res: Response) => {
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return ((await res.json()) as Row).data as Row;
  };

  test("serves the series and defaults its window", async () => {
    reading(0, 196.17);
    reading(60_000, 196.2, 99);
    const data = await body(await get("/api/v1/network/tao-usd"));
    assert.equal(data.window, DEFAULT_TAO_USD_WINDOW);
    assert.equal(data.point_count, 2);
    assert.equal((data.latest as Row).usd_per_tao, 196.17);
  });

  test("an unsupported window is a 400, not a silent default", async () => {
    assert.equal((await get("/api/v1/network/tao-usd?window=90d")).status, 400);
  });

  test("an unknown query parameter is rejected", async () => {
    assert.equal((await get("/api/v1/network/tao-usd?limit=5")).status, 400);
  });

  test("an empty table is a card with a null latest, never a 404", async () => {
    const data = await body(await get("/api/v1/network/tao-usd?window=1h"));
    assert.equal(data.point_count, 0);
    assert.equal(data.latest, null);
  });

  test("REST keeps sending the points unless asked not to (#9720)", async () => {
    // The REST default is deliberately UNCHANGED: a browser can stream the
    // series and every existing caller expects it.
    reading(0, 196.17);
    reading(60_000, 196.2, 99);
    const kept = await body(await get("/api/v1/network/tao-usd"));
    assert.equal((kept.points as Row[]).length, 2);

    const dropped = await body(
      await get("/api/v1/network/tao-usd?include_points=false"),
    );
    assert.equal("points" in dropped, false);
    // The summary survives intact, which is the point.
    assert.equal(dropped.point_count, 2);
    assert.equal((dropped.latest as Row).usd_per_tao, 196.17);

    const explicit = await body(
      await get("/api/v1/network/tao-usd?include_points=true"),
    );
    assert.equal((explicit.points as Row[]).length, 2);
  });

  test("include_points is STRICT — a near-miss is a 400, not a silent true", async () => {
    // `raw === "true"` would read every one of these as false or as true by
    // accident, and a toggle whose job is "send me less" that silently ignores
    // its own value is the defect this route is being changed to fix.
    for (const value of ["FALSE", "0", "1", "no", "yes", "True"]) {
      assert.equal(
        (await get(`/api/v1/network/tao-usd?include_points=${value}`)).status,
        400,
        `include_points=${value} should have been rejected`,
      );
    }
  });

  test("the exact-path match does not swallow a neighbouring path", async () => {
    // Matched on `===`, so a longer path falls THROUGH to the rest of the
    // router. A prefix match would quietly capture paths this route knows
    // nothing about.
    const res = await get("/api/v1/network/tao-usd-extra");
    assert.notEqual(res.status, 200);
  });

  test("no store bound is an empty card rather than a 500", async () => {
    // readStore returns undefined without Hyperdrive, the loader returns null,
    // and the card is built from nothing -- "we have not priced this window"
    // is a real state, and the route must not turn it into an error.
    const data = await body(await get("/api/v1/network/tao-usd", {} as Env));
    assert.equal(data.latest, null);
  });
});

describe("tao_usd over GraphQL and MCP", () => {
  const gql = async (query: string) => {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      env(),
    );
    return (await res.json()) as Row;
  };

  test("GraphQL serves the same card", async () => {
    reading(0, 196.17);
    const out = await gql(
      `{ tao_usd(window: "24h") { window point_count priced_point_count
         latest { usd_per_tao price_basis eth_usd pool_count } } }`,
    );
    const card = (out.data as Row).tao_usd as Row;
    assert.equal(card.point_count, 1);
    assert.equal((card.latest as Row).price_basis, "wrapped_onchain_median");
  });

  test("GraphQL rejects an unsupported window", async () => {
    const out = await gql(`{ tao_usd(window: "90d") { window } }`);
    const errors = out.errors as Row[];
    assert.equal((errors[0].extensions as Row)?.code, "BAD_USER_INPUT");
  });

  test("the MCP tool serves it and warns about the null price", async () => {
    reading(0, 196.17);
    const tool = MCP_TOOLS.find((t) => t.name === "get_tao_usd");
    assert.ok(tool, "get_tao_usd is not registered");
    const card = (await tool.handler(
      {} as never,
      {
        env: env(),
      } as never,
    )) as Row;
    assert.equal(card.window, DEFAULT_TAO_USD_WINDOW);
    assert.equal((card.latest as Row).usd_per_tao, 196.17);
    // #9720: the MCP tool defaults include_points to FALSE while REST defaults
    // it to true. A browser can stream 143 KB and a context window cannot, so
    // the surface with the hard constraint carries the default.
    assert.equal("points" in card, false);
    assert.equal(card.point_count, 1);
    // A model must not substitute 0 for an unpriceable block.
    assert.match(tool.description, /never as a zero price/);
  });
});

describe("staleness is STATED, not left to the caller (#8601)", () => {
  const NOW = Date.parse("2026-08-10T06:00:00.000Z");
  const row = (msAgo: number) => ({
    observed_at: NOW - msAgo,
    block_number: 25_719_199,
    usd_per_tao: 204.125,
    price_basis: "wrapped_onchain_median",
    eth_usd: 1917,
    pool_count: 2,
    pools: "[]",
  });

  test("a fresh reading is not stale, and says how old it is", () => {
    const out = buildTaoUsdSeries([row(60_000)], { now: () => NOW });
    assert.equal(out.stale, false);
    assert.equal(out.age_ms, 60_000);
  });

  test("past the bound it says so, rather than making the caller compare", () => {
    // The failure this closes: a consumer that skips the comparison reads a
    // frozen rate as a current one -- a value with no live writer behind it,
    // served at 200 OK.
    const out = buildTaoUsdSeries([row(TAO_USD_MAX_AGE_MS + 1)], {
      now: () => NOW,
    });
    assert.equal(out.stale, true);
    assert.ok((out.age_ms as number) > (out.stale_after_ms as number));
  });

  test("the bound IS the one the API refuses to price against", () => {
    // Compared against the DECLARATION, not a literal. If these drift, the API
    // says "fresh" while every USD figure on it is refusing to derive -- two
    // answers to one question.
    const out = buildTaoUsdSeries([row(1000)], { now: () => NOW });
    assert.equal(out.stale_after_ms, TAO_USD_MAX_AGE_MS);
  });

  test("a reading that cannot say WHEN is STALE, never fresh", () => {
    // Defaulting the unknown direction to "current" is exactly how a frozen
    // rate survives a staleness check.
    for (const bad of [null, "", "not-a-date"]) {
      const out = buildTaoUsdSeries([{ ...row(0), observed_at: bad }], {
        now: () => NOW,
      });
      assert.equal(out.stale, true, String(bad));
      assert.equal(out.age_ms, null);
    }
  });

  test("an empty window is stale, not silently fresh", () => {
    // No reading at all is the strongest form of "do not price against this".
    const out = buildTaoUsdSeries([], { now: () => NOW });
    assert.equal(out.stale, true);
    assert.equal(out.age_ms, null);
  });

  test("the clock is read ONCE, so `stale` and `age_ms` cannot disagree", () => {
    // `stale` and `age_ms` are two statements about the same reading. Sampling
    // the clock per field lets them straddle the bound and contradict each
    // other -- `stale: false` beside an age ABOVE `stale_after_ms` -- so a
    // caller re-deriving staleness from the age gets a different answer than
    // the one the API stated.
    //
    // COUNTING THE READS, rather than only asserting the two agree. Agreement
    // holds whenever both samples land the same side of the bound, which is
    // almost always -- a consistency-only check passes on the broken code for
    // any reading that is not within a millisecond of the threshold, which is
    // precisely how two reads survived here in the first place.
    let reads = 0;
    const out = buildTaoUsdSeries([row(TAO_USD_MAX_AGE_MS)], {
      now: () => {
        reads++;
        return NOW;
      },
    });
    assert.equal(reads, 1, `the response sampled the clock ${reads} times`);
    const age = out.age_ms as number;
    const bound = out.stale_after_ms as number;
    assert.equal(
      out.stale,
      age > bound,
      `stale=${String(out.stale)} contradicts age_ms=${age} vs ${bound}`,
    );
  });
});
