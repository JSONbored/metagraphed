// The gamma-deposits serving family (#13164): the pure builder, the native
// store seam, the PostgreSQL store module, and the REST handler. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgGammaDepositsStore is proven by tests/pg-gamma.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildGammaDeposits,
  loadGammaDeposits,
} from "../src/gamma-deposits.ts";
import { selectedGammaDepositsStore } from "../src/gamma-deposits-store.ts";
import {
  GAMMA_DEPOSITS_ROW_CAP,
  createPgGammaDepositsStore,
} from "../src/pg-gamma-deposits.ts";
import { handleGammaDeposits } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function depositRow(overrides: Row = {}): Row {
  return {
    coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    hotkey: "5Hotkey_one",
    netuid: 64,
    balance: "5000000000",
    spender: "5Spender_one",
    daily_cap: "1000000000",
    closed_at: 9_000_000,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildGammaDeposits", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildGammaDeposits(rows), {
        schema_version: 1,
        // Never 0: an empty list is "the deposit capture has not run", not a
        // measured deposit-free chain.
        deposit_count: null,
        captured_at: null,
        deposits: [],
      });
    }
  });

  test("formats rows and stamps the newest capture", () => {
    const card = buildGammaDeposits([
      depositRow({ captured_at: CAPTURED_MS + 1000 }),
      depositRow({
        hotkey: "5Hotkey_two",
        spender: null,
        daily_cap: null,
        closed_at: null,
      }),
    ]);
    assert.equal(card.deposit_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.deposits, [
      {
        coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        hotkey: "5Hotkey_one",
        netuid: 64,
        balance: "5000000000",
        spender: "5Spender_one",
        daily_cap: "1000000000",
        closed_at: 9_000_000,
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      {
        coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        hotkey: "5Hotkey_two",
        netuid: 64,
        balance: "5000000000",
        spender: null,
        daily_cap: null,
        closed_at: null,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("a row missing its identity or balance is dropped; soft cells degrade", () => {
    const card = buildGammaDeposits([
      depositRow({ coldkey: "" }),
      depositRow({ coldkey: 7 }),
      depositRow({ hotkey: 7 }),
      depositRow({ netuid: null }),
      depositRow({ netuid: 70000 }),
      depositRow({ balance: "01" }),
      depositRow({
        hotkey: "5Hotkey_soft",
        spender: "",
        daily_cap: "18446744073709551616", // u64 max + 1
        closed_at: "not-a-block",
        captured_at: null,
      }),
    ]);
    assert.equal(card.deposit_count, 1);
    assert.deepEqual(card.deposits, [
      {
        coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        hotkey: "5Hotkey_soft",
        netuid: 64,
        balance: "5000000000",
        spender: null,
        daily_cap: null,
        closed_at: null,
        captured_at: null,
      },
    ]);
    assert.equal(card.captured_at, null);
  });

  test("unusable stamps and blank blocks degrade to null, never to a number", () => {
    const card = buildGammaDeposits([
      depositRow({ hotkey: "hk-nan", closed_at: "", captured_at: "abc" }),
      depositRow({ hotkey: "hk-neg", captured_at: -5 }),
      // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
      depositRow({ hotkey: "hk-far", captured_at: 9_000_000_000_000_000 }),
      depositRow({ hotkey: "hk-str", captured_at: String(CAPTURED_MS) }),
    ]);
    const deposits = card.deposits as Row[];
    assert.deepEqual(
      deposits.map((d) => [d.hotkey, d.captured_at]),
      [
        ["hk-nan", null],
        ["hk-neg", null],
        ["hk-far", null],
        ["hk-str", CAPTURED_ISO],
      ],
    );
    assert.equal(deposits[0].closed_at, null);
    assert.equal(card.captured_at, CAPTURED_ISO);
  });

  test("a string closed_at block crosses as its integer", () => {
    const card = buildGammaDeposits([depositRow({ closed_at: "9000000" })]);
    assert.equal((card.deposits as Row[])[0].closed_at, 9_000_000);
  });
});

describe("selectedGammaDepositsStore / loadGammaDeposits", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedGammaDepositsStore({}), null);
    assert.equal(selectedGammaDepositsStore(null), null);
    assert.equal(await loadGammaDeposits({}), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      GAMMA_DEPOSITS_STORE: { rows: async () => [depositRow()] },
    };
    assert.deepEqual(await loadGammaDeposits(env), [depositRow()]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      GAMMA_DEPOSITS_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadGammaDeposits(env), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () => selectedGammaDepositsStore({ GAMMA_DEPOSITS_STORE: store }),
        /Invalid native gamma deposits store/,
      );
    }
  });
});

describe("createPgGammaDepositsStore", () => {
  test("reads the chain's deposits, largest first, capped", async () => {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgGammaDepositsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [depositRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    assert.deepEqual(await store.rows(), [depositRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.gamma_deposits/);
    assert.match(calls[0].sql, /ORDER BY length\(balance\) DESC, balance DESC/);
    assert.match(calls[0].sql, new RegExp(`LIMIT ${GAMMA_DEPOSITS_ROW_CAP}$`));
    assert.equal(calls[0].params, undefined);
  });
});

describe("handleGammaDeposits", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleGammaDeposits(
      new Request("https://api.metagraph.sh/api/v1/gamma/deposits"),
      {} as unknown as Env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.deposits, []);
    assert.equal(data.deposit_count, null);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/gamma/deposits.json",
    );
  });

  test("a bound store serves the deposits", async () => {
    const env = {
      GAMMA_DEPOSITS_STORE: { rows: async () => [depositRow()] },
    } as unknown as Env;
    const res = await handleGammaDeposits(
      new Request("https://api.metagraph.sh/api/v1/gamma/deposits"),
      env,
    );
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.deposit_count, 1);
    assert.equal(data.captured_at, CAPTURED_ISO);
  });
});

describe("the /gamma/deposits route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/gamma/deposits"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).deposit_count, null);
  });

  test("testnet has no variant (app.gamma_deposits has no network column)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/gamma/deposits"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/gamma/deposits?limit=5"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
