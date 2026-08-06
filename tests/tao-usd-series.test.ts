// The TAO/USD index reader (src/tao-usd-series.ts, #9609).
//
// One property carries the weight: A NULL PRICE IS A STATED OUTCOME.
//
// The producer writes `price_basis: insufficient_pools` with a NULL
// `usd_per_tao` when the two-pool quorum was not met, and
// migrations/d1/0004_user_state.sql enforces that pairing as a CHECK
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
import { beforeEach, describe, test } from "vitest";
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

// The real DDL, so the CHECK constraint that pairs a null price with
// `insufficient_pools` is enforced in the fixtures too — a test that could
// insert a null price under `wrapped_onchain_median` would be testing a state
// production cannot reach.
const SCHEMA = (() => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0004_user_state.sql"),
    "utf8",
  );
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS tao_usd_index");
  const end = sql.indexOf(
    "CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed",
  );
  const endStmt = sql.indexOf(";", end);
  return sql.slice(start, endStmt + 1);
})();

const NOW = 1_785_979_535_000;
const POOLS = JSON.stringify([
  { address: "0x433a00819c771b33fa7223a5b3499b24fbcd1bbc", included: true },
  { address: "0x0000000000000000000000000000000000000002", included: false },
]);

let db: InstanceType<typeof DatabaseSync>;

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
const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

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

  test("the exact-path match does not swallow a neighbouring path", async () => {
    // Matched on `===`, so a longer path falls THROUGH to the rest of the
    // router. A prefix match would quietly capture paths this route knows
    // nothing about.
    const res = await get("/api/v1/network/tao-usd-extra");
    assert.notEqual(res.status, 200);
  });

  test("no D1 binding is an empty card rather than a 500", async () => {
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
    // A model must not substitute 0 for an unpriceable block.
    assert.match(tool.description, /never as a zero price/);
  });
});
