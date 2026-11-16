// The subnet-limit-orders serving family (#13165): the pure builder, the
// native store seam, the PostgreSQL store module, and the REST handler. The
// GraphQL and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetLimitOrdersStore is proven by tests/pg-limit-orders.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetLimitOrders,
  formatLimitOrder,
  loadSubnetLimitOrders,
} from "../src/subnet-limit-orders.ts";
import { selectedSubnetLimitOrdersStore } from "../src/subnet-limit-orders-store.ts";
import {
  createPgSubnetLimitOrdersStore,
  SUBNET_LIMIT_ORDERS_ROW_CAP,
} from "../src/pg-subnet-limit-orders.ts";
import { handleSubnetLimitOrders } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();
const ORDER_ID = `0x${"ab".repeat(32)}`;

function orderRow(overrides: Row = {}): Row {
  return {
    order_id: ORDER_ID,
    owner: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    kind: "Buy",
    amount: "65802619318",
    price: "12500",
    status: "PartiallyFilled",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildSubnetLimitOrders", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetLimitOrders(rows, 64), {
        schema_version: 1,
        netuid: 64,
        // Never 0: an empty book is "the order-book capture has not run",
        // not a measured order-less subnet.
        order_count: null,
        captured_at: null,
        orders: [],
      });
    }
  });

  test("formats rows and stamps the newest capture", () => {
    const card = buildSubnetLimitOrders(
      [
        orderRow({ captured_at: CAPTURED_MS + 1000 }),
        orderRow({ order_id: `0x${"cd".repeat(32)}`, status: null }),
      ],
      64,
    );
    assert.equal(card.order_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.orders, [
      {
        order_id: ORDER_ID,
        owner: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        kind: "Buy",
        amount: "65802619318",
        price: "12500",
        status: "PartiallyFilled",
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      {
        order_id: `0x${"cd".repeat(32)}`,
        owner: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        kind: "Buy",
        amount: "65802619318",
        price: "12500",
        status: null,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("a row missing its identity is dropped; soft cells degrade", () => {
    const card = buildSubnetLimitOrders(
      [
        orderRow({ order_id: "not-an-h256" }),
        orderRow({ order_id: 7 }),
        orderRow({ order_id: `0x${"AB".repeat(32)}` }),
        orderRow({ owner: "" }),
        orderRow({ kind: null }),
        orderRow({
          order_id: `0x${"ef".repeat(32)}`,
          amount: "01",
          price: "340282366920938463463374607431768211456",
          status: "",
          captured_at: null,
        }),
        // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
        orderRow({
          order_id: `0x${"12".repeat(32)}`,
          captured_at: 9_000_000_000_000_000,
        }),
      ],
      7,
    );
    assert.equal(card.order_count, 2);
    assert.deepEqual((card.orders as Row[])[0], {
      order_id: `0x${"ef".repeat(32)}`,
      owner: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      kind: "Buy",
      amount: null,
      price: null,
      status: null,
      captured_at: null,
    });
    assert.equal((card.orders as Row[])[1].captured_at, null);
    assert.equal(card.captured_at, null);
  });
});

describe("formatLimitOrder", () => {
  test("a blank capture stamp is not a stamp", () => {
    assert.equal(
      (formatLimitOrder(orderRow({ captured_at: "" })) as Row).captured_at,
      null,
    );
  });
});

describe("selectedSubnetLimitOrdersStore / loadSubnetLimitOrders", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetLimitOrdersStore({}), null);
    assert.equal(selectedSubnetLimitOrdersStore(null), null);
    assert.equal(await loadSubnetLimitOrders({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_LIMIT_ORDERS_STORE: {
        rows: async (netuid: number) => [orderRow({ kind: `Buy${netuid}` })],
      },
    };
    assert.deepEqual(await loadSubnetLimitOrders(env, 3), [
      orderRow({ kind: "Buy3" }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_LIMIT_ORDERS_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetLimitOrders(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () =>
          selectedSubnetLimitOrdersStore({ SUBNET_LIMIT_ORDERS_STORE: store }),
        /Invalid native subnet limit orders store/,
      );
    }
  });
});

describe("createPgSubnetLimitOrdersStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetLimitOrdersStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [orderRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's orders newest-first, capped", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.rows(64), [orderRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.limit_orders/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC, order_id/);
    assert.match(
      calls[0].sql,
      new RegExp(`LIMIT ${SUBNET_LIMIT_ORDERS_ROW_CAP}$`),
    );
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.rows(netuid),
        /Invalid native subnet limit orders identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetLimitOrders", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetLimitOrders(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/limit-orders"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.orders, []);
    assert.equal(data.order_count, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/limit-orders.json",
    );
  });

  test("a bound store serves the book", async () => {
    const env = {
      SUBNET_LIMIT_ORDERS_STORE: {
        rows: async () => [
          orderRow(),
          orderRow({ order_id: `0x${"cd".repeat(32)}` }),
        ],
      },
    } as unknown as Env;
    const res = await handleSubnetLimitOrders(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/limit-orders"),
      env,
      64,
    );
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.order_count, 2);
    assert.equal((data.orders as Row[])[1].order_id, `0x${"cd".repeat(32)}`);
  });
});

describe("the /subnets/{netuid}/limit-orders route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/limit-orders"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).order_count, null);
  });

  test("testnet has no variant (app.limit_orders has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/subnets/64/limit-orders",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/64/limit-orders?window=7d",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
