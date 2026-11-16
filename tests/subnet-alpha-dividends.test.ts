// The subnet-alpha-dividends serving family (#13163): the pure builders, the
// native store seam, the PostgreSQL store module, and the REST handler. The
// GraphQL and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetAlphaDividendsStore is proven by tests/pg-stake-v2.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetAlphaDividends,
  loadSubnetAlphaDividends,
  u64TextOrNull,
} from "../src/subnet-alpha-dividends.ts";
import { selectedSubnetAlphaDividendsStore } from "../src/subnet-alpha-dividends-store.ts";
import {
  createPgSubnetAlphaDividendsStore,
  SUBNET_ALPHA_DIVIDENDS_ROW_CAP,
} from "../src/pg-subnet-alpha-dividends.ts";
import { handleSubnetAlphaDividends } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function dividendRow(overrides: Row = {}): Row {
  return {
    hotkey: "5Hotkey_one",
    alpha_divs: "12500",
    root_alpha_divs: "300",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("u64TextOrNull", () => {
  test("accepts canonical u64 decimal text only", () => {
    assert.equal(u64TextOrNull("0"), "0");
    assert.equal(u64TextOrNull("12500"), "12500");
    assert.equal(u64TextOrNull("18446744073709551615"), "18446744073709551615");
  });

  test("rejects padding, signs, overflow and non-strings", () => {
    for (const value of [
      "01", // not canonical
      "-1",
      "1.5",
      "18446744073709551616", // u64 max + 1
      "",
      " 1",
      12500, // the column is text; a number never legitimately crosses
      null,
      undefined,
    ]) {
      assert.equal(u64TextOrNull(value), null);
    }
  });
});

describe("buildSubnetAlphaDividends", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      const card = buildSubnetAlphaDividends(rows, 64);
      assert.deepEqual(card, {
        schema_version: 1,
        netuid: 64,
        // Never 0: an empty registry is "the accrual capture has not run",
        // not a measured zero accrual.
        hotkey_count: null,
        captured_at: null,
        dividends: [],
      });
    }
  });

  test("formats rows and stamps the newest capture", () => {
    const card = buildSubnetAlphaDividends(
      [
        dividendRow({ captured_at: CAPTURED_MS + 1000 }),
        dividendRow({
          hotkey: "5Hotkey_two",
          alpha_divs: "900",
          root_alpha_divs: null,
        }),
      ],
      64,
    );
    assert.equal(card.hotkey_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.dividends, [
      {
        hotkey: "5Hotkey_one",
        alpha_divs: "12500",
        root_alpha_divs: "300",
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      {
        hotkey: "5Hotkey_two",
        alpha_divs: "900",
        root_alpha_divs: null,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("unusable cells degrade to null; a row without a hotkey is dropped", () => {
    const card = buildSubnetAlphaDividends(
      [
        dividendRow({
          alpha_divs: "01",
          root_alpha_divs: "-3",
          captured_at: -5,
        }),
        dividendRow({ hotkey: "" }),
        dividendRow({ hotkey: 7 }),
        // Beyond ECMAScript's maximum time value: a Date this far out is
        // Invalid even though the number is finite.
        dividendRow({
          hotkey: "5Hotkey_far",
          alpha_divs: "1",
          root_alpha_divs: null,
          captured_at: 9_000_000_000_000_000,
        }),
        dividendRow({
          hotkey: "5Hotkey_null",
          alpha_divs: "2",
          root_alpha_divs: null,
          captured_at: null,
        }),
        dividendRow({
          hotkey: "5Hotkey_two",
          alpha_divs: null,
          root_alpha_divs: "0",
          captured_at: String(CAPTURED_MS),
        }),
      ],
      7,
    );
    assert.equal(card.hotkey_count, 4);
    assert.deepEqual(card.dividends, [
      {
        hotkey: "5Hotkey_one",
        alpha_divs: null,
        root_alpha_divs: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_far",
        alpha_divs: "1",
        root_alpha_divs: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_null",
        alpha_divs: "2",
        root_alpha_divs: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_two",
        alpha_divs: null,
        root_alpha_divs: "0",
        captured_at: CAPTURED_ISO,
      },
    ]);
    assert.equal(card.captured_at, CAPTURED_ISO);
  });
});

describe("selectedSubnetAlphaDividendsStore / loadSubnetAlphaDividends", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetAlphaDividendsStore({}), null);
    assert.equal(selectedSubnetAlphaDividendsStore(null), null);
    assert.equal(await loadSubnetAlphaDividends({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_ALPHA_DIVIDENDS_STORE: {
        rows: async (netuid: number) => [
          dividendRow({ hotkey: `5Hotkey_${netuid}` }),
        ],
      },
    };
    assert.deepEqual(await loadSubnetAlphaDividends(env, 3), [
      dividendRow({ hotkey: "5Hotkey_3" }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_ALPHA_DIVIDENDS_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetAlphaDividends(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    assert.throws(
      () =>
        selectedSubnetAlphaDividendsStore({ SUBNET_ALPHA_DIVIDENDS_STORE: {} }),
      /Invalid native subnet alpha dividends store/,
    );
  });
});

describe("createPgSubnetAlphaDividendsStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetAlphaDividendsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [dividendRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's accruals, largest first, capped", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.rows(64), [dividendRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.subnet_alpha_dividends/);
    assert.match(calls[0].sql, /ORDER BY length\(alpha_divs\) DESC NULLS LAST/);
    assert.match(
      calls[0].sql,
      new RegExp(`LIMIT ${SUBNET_ALPHA_DIVIDENDS_ROW_CAP}$`),
    );
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.rows(netuid),
        /Invalid native subnet alpha dividends identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetAlphaDividends", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetAlphaDividends(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-dividends"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.dividends, []);
    assert.equal(data.hotkey_count, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/alpha-dividends.json",
    );
  });

  test("a bound store serves the accruals", async () => {
    const env = {
      SUBNET_ALPHA_DIVIDENDS_STORE: {
        rows: async () => [
          dividendRow(),
          dividendRow({ hotkey: "5Hotkey_two" }),
        ],
      },
    };
    const res = await handleSubnetAlphaDividends(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-dividends"),
      env as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.hotkey_count, 2);
    assert.equal(data.captured_at, CAPTURED_ISO);
    assert.equal((data.dividends as Row[])[1].hotkey, "5Hotkey_two");
  });
});

describe("the /subnets/{netuid}/alpha-dividends route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-dividends"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).hotkey_count, null);
  });

  test("testnet has no variant (app.subnet_alpha_dividends has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/subnets/64/alpha-dividends",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/64/alpha-dividends?window=7d",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
