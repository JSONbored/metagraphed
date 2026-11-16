// The on-chain TAO/USD oracle block (#13164): the pure builder, the native
// store seam, the PostgreSQL store module, and the three serving surfaces of
// /network/tao-usd carrying it. The real PostgreSQL schema behind
// createPgTaoUsdOracleStore is proven by tests/pg-tao-usd-oracle.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildTaoUsdOracle, loadTaoUsdOracle } from "../src/tao-usd-oracle.ts";
import { selectedTaoUsdOracleStore } from "../src/tao-usd-oracle-store.ts";
import {
  TAO_USD_ORACLE_ROW_CAP,
  createPgTaoUsdOracleStore,
} from "../src/pg-tao-usd-oracle.ts";
import { buildTaoUsdSeries } from "../src/tao-usd-series.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function feedRow(overrides: Row = {}): Row {
  return {
    block_number: 9_000_001,
    usd_per_tao: 212.5,
    price_raw: "340282366920938463463374607431768211455",
    oracle: "5Oracle_feeder",
    observed_at: CAPTURED_MS,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildTaoUsdOracle", () => {
  test("null rows and no rows are both the decline: a NULL block", () => {
    // Never a zeroed block: with no captured feed there is no on-chain price
    // to state.
    assert.equal(buildTaoUsdOracle(null), null);
    assert.equal(buildTaoUsdOracle([]), null);
  });

  test("a history of unusable rows is also the decline", () => {
    assert.equal(
      buildTaoUsdOracle([
        feedRow({ block_number: "not-a-block" }),
        feedRow({ block_number: "" }),
      ]),
      null,
    );
  });

  test("formats the newest feed with its history, labelled by source", () => {
    const block = buildTaoUsdOracle([
      feedRow(),
      feedRow({
        block_number: 9_000_000,
        usd_per_tao: 210,
        observed_at: CAPTURED_MS - 1000,
      }),
    ]);
    assert.deepEqual(block, {
      source: "chain_oracle",
      usd_per_tao: 212.5,
      price_raw: "340282366920938463463374607431768211455",
      oracle: "5Oracle_feeder",
      block_number: 9_000_001,
      observed_at: CAPTURED_ISO,
      captured_at: CAPTURED_ISO,
      fed_count: 2,
      feeds: [
        {
          block_number: 9_000_001,
          usd_per_tao: 212.5,
          observed_at: CAPTURED_ISO,
        },
        {
          block_number: 9_000_000,
          usd_per_tao: 210,
          observed_at: new Date(CAPTURED_MS - 1000).toISOString(),
        },
      ],
    });
  });

  test("unusable cells degrade to null, never to a zero price", () => {
    const block = buildTaoUsdOracle([
      // A feed without its block names no chain state and is dropped; the
      // newest USABLE row is the one the scalar block describes.
      feedRow({ block_number: null }),
      feedRow({
        usd_per_tao: 0,
        price_raw: "01",
        oracle: "",
        observed_at: "abc",
        captured_at: null,
      }),
      feedRow({
        block_number: "9000000",
        usd_per_tao: -3,
        observed_at: 9_000_000_000_000_000,
      }),
      feedRow({
        block_number: 8_999_999,
        usd_per_tao: null,
        observed_at: null,
      }),
    ]);
    assert.ok(block);
    assert.equal(block.usd_per_tao, null);
    assert.equal(block.price_raw, null);
    assert.equal(block.oracle, null);
    assert.equal(block.block_number, 9_000_001);
    assert.equal(block.observed_at, null);
    assert.equal(block.captured_at, null);
    assert.equal(block.fed_count, 3);
    // The string block height crosses as its integer.
    assert.equal((block.feeds as Row[])[1].block_number, 9_000_000);
    assert.equal((block.feeds as Row[])[1].usd_per_tao, null);
    assert.equal((block.feeds as Row[])[1].observed_at, null);
    // A missing price stays null -- never a zero.
    assert.equal((block.feeds as Row[])[2].usd_per_tao, null);
  });
});

describe("buildTaoUsdSeries carries the oracle block and the source label", () => {
  test("the default is the decline: oracle null, source stated", () => {
    const card = buildTaoUsdSeries(null, { window: "24h" });
    assert.equal(card.source, "pool_composite");
    assert.equal(card.oracle, null);
  });

  test("a built oracle block rides the card unchanged", () => {
    const oracle = buildTaoUsdOracle([feedRow()]);
    const card = buildTaoUsdSeries(null, { window: "24h", oracle });
    assert.equal((card.oracle as Row).source, "chain_oracle");
    assert.equal((card.oracle as Row).usd_per_tao, 212.5);
  });
});

describe("selectedTaoUsdOracleStore / loadTaoUsdOracle", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedTaoUsdOracleStore({}), null);
    assert.equal(selectedTaoUsdOracleStore(null), null);
    assert.equal(await loadTaoUsdOracle({}), null);
  });

  test("a bound store serves its rows", async () => {
    const env = { TAO_USD_ORACLE_STORE: { rows: async () => [feedRow()] } };
    assert.deepEqual(await loadTaoUsdOracle(env), [feedRow()]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      TAO_USD_ORACLE_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadTaoUsdOracle(env), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () => selectedTaoUsdOracleStore({ TAO_USD_ORACLE_STORE: store }),
        /Invalid native tao usd oracle store/,
      );
    }
  });
});

describe("createPgTaoUsdOracleStore", () => {
  test("reads the feed history, newest block first, capped", async () => {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgTaoUsdOracleStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [feedRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    assert.deepEqual(await store.rows(), [feedRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.tao_usd_oracle/);
    assert.match(calls[0].sql, /ORDER BY block_number DESC/);
    assert.match(calls[0].sql, new RegExp(`LIMIT ${TAO_USD_ORACLE_ROW_CAP}$`));
    assert.equal(calls[0].params, undefined);
  });
});

describe("the three /network/tao-usd surfaces carry the oracle", () => {
  const ORACLE_ENV = {
    TAO_USD_ORACLE_STORE: { rows: async () => [feedRow()] },
  } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("REST: unbound stores are the labelled decline; a bound oracle rides", async () => {
    const declined = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/network/tao-usd"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(declined.status, 200);
    const declinedData = ((await declined.json()) as Row).data as Row;
    assert.equal(declinedData.source, "pool_composite");
    assert.equal(declinedData.oracle, null);

    const served = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/network/tao-usd"),
      ORACLE_ENV,
      ctx,
    );
    assert.equal(served.status, 200);
    const servedData = ((await served.json()) as Row).data as Row;
    const oracle = servedData.oracle as Row;
    assert.equal(oracle.source, "chain_oracle");
    assert.equal(oracle.usd_per_tao, 212.5);
    assert.equal(oracle.fed_count, 1);
  });

  test("GraphQL: the same block through the same loader", async () => {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ tao_usd { source oracle {
            source usd_per_tao price_raw oracle block_number fed_count
            feeds { block_number usd_per_tao observed_at }
          } } }`,
        }),
      }),
      ORACLE_ENV,
    );
    const out = (await res.json()) as Row;
    assert.equal(out.errors, undefined);
    const card = (out.data as Row).tao_usd as Row;
    assert.equal(card.source, "pool_composite");
    assert.equal((card.oracle as Row).usd_per_tao, 212.5);
    assert.equal(((card.oracle as Row).feeds as Row[]).length, 1);
  });

  test("MCP: the same block through the same loader", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_tao_usd");
    assert.ok(tool, "get_tao_usd is not registered");
    const card = (await tool.handler(
      {} as never,
      { env: ORACLE_ENV } as never,
    )) as Row;
    assert.equal(card.source, "pool_composite");
    assert.equal((card.oracle as Row).source, "chain_oracle");
  });
});
