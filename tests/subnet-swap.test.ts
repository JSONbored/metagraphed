// The subnet-swap serving family (#13165): the pure builder, the native
// store seam, the PostgreSQL store module, and the REST handler. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetSwapStore is proven by tests/pg-swap-liquidity.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetSwap,
  feeRateOrNull,
  formatSwapState,
  loadSubnetSwap,
} from "../src/subnet-swap.ts";
import { selectedSubnetSwapStore } from "../src/subnet-swap-store.ts";
import { createPgSubnetSwapStore } from "../src/pg-subnet-swap.ts";
import { handleSubnetSwap } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function swapRow(overrides: Row = {}): Row {
  return {
    tao_reservoir: "5000000000",
    alpha_reservoir: "12500",
    fee_rate: 300,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildSubnetSwap", () => {
  test("null rows and no rows are both the decline: a NULL state", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetSwap(rows, 64), {
        schema_version: 1,
        netuid: 64,
        // Never a zeroed state: an absent capture is "the balancer capture
        // has not run", not a measured empty pool.
        swap: null,
        captured_at: null,
      });
    }
  });

  test("formats the newest capture and stamps it", () => {
    assert.deepEqual(buildSubnetSwap([swapRow()], 64), {
      schema_version: 1,
      netuid: 64,
      swap: {
        tao_reservoir: "5000000000",
        alpha_reservoir: "12500",
        fee_rate: 300,
        captured_at: CAPTURED_ISO,
      },
      captured_at: CAPTURED_ISO,
    });
  });

  test("soft cells degrade to null, never to a fabricated zero", () => {
    const card = buildSubnetSwap(
      [
        swapRow({
          // Non-canonical / out-of-range quantities are not u64 text.
          tao_reservoir: "01",
          alpha_reservoir: "18446744073709551616",
          fee_rate: null,
          captured_at: null,
        }),
      ],
      7,
    );
    assert.deepEqual(card.swap, {
      tao_reservoir: null,
      alpha_reservoir: null,
      fee_rate: null,
      captured_at: null,
    });
    assert.equal(card.captured_at, null);
  });

  test("a capture stamp beyond ECMAScript's time range yields no stamp", () => {
    const card = buildSubnetSwap(
      [swapRow({ captured_at: 9_000_000_000_000_000 })],
      7,
    );
    assert.equal((card.swap as Row).captured_at, null);
  });
});

describe("feeRateOrNull", () => {
  test("the raw u16 crosses as its integer, including as text", () => {
    assert.equal(feeRateOrNull(0), 0);
    assert.equal(feeRateOrNull(65535), 65535);
    assert.equal(feeRateOrNull("300"), 300);
  });

  test("anything that is not a u16 is null, never coalesced to 0", () => {
    for (const value of [null, undefined, "", "  ", "abc", -1, 65536, 1.5]) {
      assert.equal(feeRateOrNull(value), null);
    }
  });
});

describe("formatSwapState", () => {
  test("blank-string cells are not stamps or rates", () => {
    const state = formatSwapState(swapRow({ fee_rate: "", captured_at: "" }));
    assert.equal(state.fee_rate, null);
    assert.equal(state.captured_at, null);
  });
});

describe("selectedSubnetSwapStore / loadSubnetSwap", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetSwapStore({}), null);
    assert.equal(selectedSubnetSwapStore(null), null);
    assert.equal(await loadSubnetSwap({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_SWAP_STORE: {
        latest: async (netuid: number) => [swapRow({ fee_rate: netuid })],
      },
    };
    assert.deepEqual(await loadSubnetSwap(env, 3), [swapRow({ fee_rate: 3 })]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_SWAP_STORE: {
        latest: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetSwap(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () => selectedSubnetSwapStore({ SUBNET_SWAP_STORE: store }),
        /Invalid native subnet swap store/,
      );
    }
  });
});

describe("createPgSubnetSwapStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetSwapStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [swapRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's newest balancer capture", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.latest(64), [swapRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.swap_balancer/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC LIMIT 1$/);
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.latest(netuid),
        /Invalid native subnet swap identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetSwap", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetSwap(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/swap"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.swap, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/swap.json",
    );
  });

  test("a bound store serves the state", async () => {
    const env = {
      SUBNET_SWAP_STORE: { latest: async () => [swapRow()] },
    } as unknown as Env;
    const res = await handleSubnetSwap(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/swap"),
      env,
      64,
    );
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal((data.swap as Row).tao_reservoir, "5000000000");
    assert.equal((data.swap as Row).fee_rate, 300);
  });
});

describe("the /subnets/{netuid}/swap route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/swap"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).swap, null);
  });

  test("testnet has no variant (app.swap_balancer has no network column)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/subnets/64/swap"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/swap?window=7d"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
