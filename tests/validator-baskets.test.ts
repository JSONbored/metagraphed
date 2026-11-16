// The Root-basket serving family (#13163): the pure builders, the account-id
// conversion, the capture-store loaders, and the REST handlers. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema and the
// migration-0046 era constraint behind the loaders are proven by
// tests/root-basket-v490.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  basketAccountHex,
  buildValidatorBasket,
  buildValidatorBaskets,
  formatBasketCapture,
  formatBasketFund,
  loadValidatorBasket,
  loadValidatorBaskets,
  VALIDATOR_BASKETS_FUND_CAP,
} from "../src/validator-baskets.ts";
import { ROOT_BASKET_CAPTURE_LIMITS } from "../src/root-basket-capture-write.ts";
import {
  handleChainBaskets,
  handleValidatorBasket,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const ACCOUNT_HEX = basketAccountHex(HOTKEY)!;
const ACCEPTED_MS = 1_763_000_000_000;
const ACCEPTED_ISO = new Date(ACCEPTED_MS).toISOString();

function captureRow(overrides: Row = {}): Row {
  return {
    capture_id: "00000000-0000-4000-8000-000000000001",
    finalized_block: "6500000",
    finalized_block_hash: `0x${"02".repeat(32)}`,
    runtime_spec_version: 454,
    decoder_version: "subtensor-v454-14cde641-v1",
    accepted_at_ms: String(ACCEPTED_MS),
    ...overrides,
  };
}

function fundRow(overrides: Row = {}): Row {
  return {
    hotkey: ACCOUNT_HEX,
    shares_atomic: "2000000000",
    spot_nav_rao: "6000000000",
    realizable_nav_rao: "5000000000",
    deposited_rao: "4000000000",
    redeemed_rao: "0",
    display_price_q64_bits: "36893488147419103232",
    stake_price_q64_bits: "25941395251828326400",
    staker_twr_q64_bits: "20752316201462661120",
    pending_entitlement_q64_bits: "3458764513820540928",
    provisional: 0,
    first_block: "90",
    holdings_count: 2,
    targets_count: 1,
    ...overrides,
  };
}

const FORMATTED_FUND = {
  hotkey: HOTKEY,
  account_id: ACCOUNT_HEX,
  shares_atomic: "2000000000",
  spot_nav_rao: "6000000000",
  realizable_nav_rao: "5000000000",
  deposited_rao: "4000000000",
  redeemed_rao: "0",
  display_price_q64_bits: "36893488147419103232",
  stake_price_q64_bits: "25941395251828326400",
  staker_twr_q64_bits: "20752316201462661120",
  pending_entitlement_q64_bits: "3458764513820540928",
  provisional: false,
  first_block: "90",
  holdings_count: 2,
  targets_count: 1,
};

describe("basketAccountHex", () => {
  test("round-trips an SS58 hotkey to the stored 0x account id", () => {
    assert.match(ACCOUNT_HEX, /^0x[0-9a-f]{64}$/);
    // formatBasketFund re-encodes the same bytes back to the same address.
    assert.equal(formatBasketFund(fundRow())!.hotkey, HOTKEY);
  });

  test("a malformed address is null, never a guessed key", () => {
    for (const value of ["", "nope", "5short"]) {
      assert.equal(basketAccountHex(value), null);
    }
  });

  test("the fund cap restates the receiver ceiling it mirrors", () => {
    // The capture-write module owns the ceiling but is deliberately kept out
    // of the request-worker graphs; this pin keeps the restated literal honest.
    assert.equal(VALIDATOR_BASKETS_FUND_CAP, ROOT_BASKET_CAPTURE_LIMITS.funds);
  });
});

describe("formatBasketCapture", () => {
  test("a usable capture row formats with its acceptance stamp", () => {
    assert.deepEqual(formatBasketCapture(captureRow()), {
      finalized_block: "6500000",
      finalized_block_hash: `0x${"02".repeat(32)}`,
      runtime_spec_version: 454,
      decoder_version: "subtensor-v454-14cde641-v1",
      accepted_at: ACCEPTED_ISO,
    });
  });

  test("an unreadable acceptance stamp degrades to null alone", () => {
    for (const accepted_at_ms of [null, "", "-5", 9_000_000_000_000_000]) {
      assert.equal(
        formatBasketCapture(captureRow({ accepted_at_ms }))!.accepted_at,
        null,
      );
    }
  });

  test("a row missing its identity is null: nothing pins values to a block", () => {
    assert.equal(formatBasketCapture(null), null);
    for (const overrides of [
      { finalized_block: "01" },
      { finalized_block: null },
      { finalized_block_hash: "0x1234" },
      { finalized_block_hash: null },
      { runtime_spec_version: null },
      { runtime_spec_version: -1 },
      { decoder_version: "" },
      { decoder_version: null },
    ]) {
      assert.equal(formatBasketCapture(captureRow(overrides)), null);
    }
  });
});

describe("formatBasketFund", () => {
  test("formats quantities as the canonical decimal text they are stored as", () => {
    assert.deepEqual(formatBasketFund(fundRow()), FORMATTED_FUND);
  });

  test("a fund without a usable account id is dropped", () => {
    for (const hotkey of [null, "", "0x1234", 7]) {
      assert.equal(formatBasketFund(fundRow({ hotkey })), null);
    }
  });

  test("a provisional baseline serves provisional=true and no first block", () => {
    const fund = formatBasketFund(
      fundRow({ provisional: 1, first_block: "0" }),
    )!;
    assert.equal(fund.provisional, true);
    assert.equal(fund.first_block, null);
  });

  test("unusable cells degrade to null rather than inventing quantities", () => {
    const fund = formatBasketFund(
      fundRow({
        shares_atomic: "01",
        spot_nav_rao: null,
        realizable_nav_rao: "18446744073709551616", // u64 max + 1
        deposited_rao: 4,
        redeemed_rao: "-1",
        display_price_q64_bits: "340282366920938463463374607431768211456", // u128 max + 1
        stake_price_q64_bits: "",
        staker_twr_q64_bits: null,
        pending_entitlement_q64_bits: null,
        provisional: 2,
        first_block: null,
        holdings_count: null,
        targets_count: "",
      }),
    )!;
    assert.deepEqual(fund, {
      hotkey: HOTKEY,
      account_id: ACCOUNT_HEX,
      shares_atomic: null,
      spot_nav_rao: null,
      realizable_nav_rao: null,
      deposited_rao: null,
      redeemed_rao: null,
      display_price_q64_bits: null,
      stake_price_q64_bits: null,
      staker_twr_q64_bits: null,
      pending_entitlement_q64_bits: null,
      provisional: null,
      first_block: null,
      holdings_count: null,
      targets_count: null,
    });
    assert.equal(
      formatBasketFund(fundRow({ provisional: null }))!.provisional,
      null,
    );
  });
});

describe("buildValidatorBaskets", () => {
  test("a null load and an unusable capture are both the null-capture decline", () => {
    for (const loaded of [
      null,
      { capture: null, funds: [] },
      { capture: captureRow({ finalized_block: null }), funds: [fundRow()] },
    ]) {
      assert.deepEqual(buildValidatorBaskets(loaded), {
        schema_version: 1,
        capture: null,
        fund_count: null,
        baskets: [],
      });
    }
  });

  test("a completed capture with no funds is a MEASURED zero, not a decline", () => {
    const card = buildValidatorBaskets({ capture: captureRow(), funds: [] });
    assert.equal(card.fund_count, 0);
    assert.notEqual(card.capture, null);
    assert.deepEqual(card.baskets, []);
    // An omitted funds array reads the same as an empty one.
    assert.equal(
      buildValidatorBaskets({ capture: captureRow() }).fund_count,
      0,
    );
  });

  test("serves the funds and drops only unattributable rows", () => {
    const card = buildValidatorBaskets({
      capture: captureRow(),
      funds: [fundRow(), fundRow({ hotkey: "nope" })],
    });
    assert.equal(card.fund_count, 1);
    assert.deepEqual(card.baskets, [FORMATTED_FUND]);
  });
});

describe("buildValidatorBasket", () => {
  const holding = {
    netuid: 0,
    quantity_atomic: "1000000000",
    quantity_unit: "rao",
    spot_value_rao: "1000000000",
    realizable_value_rao: "1000000000",
  };

  test("a null load is the null-capture decline", () => {
    assert.deepEqual(buildValidatorBasket(null, HOTKEY), {
      schema_version: 1,
      hotkey: HOTKEY,
      capture: null,
      basket: null,
      holdings: [],
      targets: [],
    });
  });

  test("a capture without this fund is a measured absence, capture intact", () => {
    const card = buildValidatorBasket(
      { capture: captureRow(), fund: null, holdings: [], targets: [] },
      HOTKEY,
    );
    assert.notEqual(card.capture, null);
    assert.equal(card.basket, null);
    assert.deepEqual(card.holdings, []);
    assert.deepEqual(card.targets, []);
  });

  test("serves the fund with its holdings and targets, dropping unusable rows", () => {
    const card = buildValidatorBasket(
      {
        capture: captureRow(),
        fund: fundRow(),
        holdings: [
          holding,
          { ...holding, netuid: 19, quantity_unit: "alpha_atomic" },
          { ...holding, netuid: null },
          { ...holding, netuid: 70000 },
          {
            netuid: 50,
            quantity_atomic: "01",
            quantity_unit: "tao",
            spot_value_rao: null,
            realizable_value_rao: "x",
          },
        ],
        targets: [
          { netuid: 19, weight: 65535 },
          { netuid: null, weight: 1 },
          { netuid: 70000, weight: 1 },
          { netuid: 19, weight: null },
          { netuid: 19, weight: 70000 },
        ],
      },
      HOTKEY,
    );
    assert.deepEqual(card.basket, FORMATTED_FUND);
    assert.deepEqual(card.holdings, [
      holding,
      { ...holding, netuid: 19, quantity_unit: "alpha_atomic" },
      {
        netuid: 50,
        quantity_atomic: null,
        quantity_unit: null,
        spot_value_rao: null,
        realizable_value_rao: null,
      },
    ]);
    assert.deepEqual(card.targets, [{ netuid: 19, weight: 65535 }]);
  });

  test("an unattributable fund row serves as a measured absence", () => {
    const card = buildValidatorBasket(
      {
        capture: captureRow(),
        fund: fundRow({ hotkey: "nope" }),
        holdings: [holding],
        targets: [],
      },
      HOTKEY,
    );
    assert.equal(card.basket, null);
    assert.deepEqual(card.holdings, []);
  });

  test("omitted holdings/targets read the same as empty parts", () => {
    const card = buildValidatorBasket(
      { capture: captureRow(), fund: fundRow() },
      HOTKEY,
    );
    assert.deepEqual(card.basket, FORMATTED_FUND);
    assert.deepEqual(card.holdings, []);
    assert.deepEqual(card.targets, []);
  });
});

function storeEnv(rows: {
  capture?: Row | null;
  funds?: Row[];
  fund?: Row | null;
  holdings?: Row[];
  targets?: Row[];
  fail?: boolean;
}) {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const read = {
    async first(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (rows.fail) throw new Error("native unavailable");
      if (/FROM root_basket_captures/.test(sql)) return rows.capture ?? null;
      return rows.fund ?? null;
    },
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (/root_basket_holdings/.test(sql)) return rows.holdings ?? [];
      if (/root_basket_targets/.test(sql)) return rows.targets ?? [];
      return rows.funds ?? [];
    },
  };
  return {
    calls,
    env: { ROOT_BASKET_STORE: { write: async () => ({}), read } },
  };
}

describe("loadValidatorBaskets / loadValidatorBasket", () => {
  test("no ROOT_BASKET_STORE key means the null decline", async () => {
    assert.equal(await loadValidatorBaskets({}), null);
    assert.equal(await loadValidatorBasket({}, ACCOUNT_HEX), null);
  });

  test("no completed capture is the same decline", async () => {
    const { env } = storeEnv({ capture: null });
    assert.equal(await loadValidatorBaskets(env), null);
    assert.equal(await loadValidatorBasket(env, ACCOUNT_HEX), null);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const { env } = storeEnv({ fail: true });
    assert.equal(await loadValidatorBaskets(env), null);
    assert.equal(await loadValidatorBasket(env, ACCOUNT_HEX), null);
  });

  test("serves the newest completed capture's funds through one bounded read", async () => {
    const { calls, env } = storeEnv({
      capture: captureRow(),
      funds: [fundRow()],
    });
    const loaded = await loadValidatorBaskets(env);
    assert.deepEqual(loaded, { capture: captureRow(), funds: [fundRow()] });
    assert.match(calls[0].sql, /JOIN root_basket_capture_completions/);
    assert.match(calls[0].sql, /network = 'finney'/);
    assert.match(
      calls[1].sql,
      new RegExp(`LIMIT ${VALIDATOR_BASKETS_FUND_CAP}$`),
    );
    assert.deepEqual(calls[1].params, [captureRow().capture_id]);
  });

  test("a capture without this hotkey's fund loads as a measured absence", async () => {
    const { calls, env } = storeEnv({ capture: captureRow(), fund: null });
    assert.deepEqual(await loadValidatorBasket(env, ACCOUNT_HEX), {
      capture: captureRow(),
      fund: null,
      holdings: [],
      targets: [],
    });
    // The holdings/targets reads are skipped: there is no fund to scope them.
    assert.equal(calls.length, 2);
  });

  test("loads one fund with its holdings and targets", async () => {
    const holdings = [{ netuid: 0 }];
    const targets = [{ netuid: 19, weight: 1 }];
    const { env } = storeEnv({
      capture: captureRow(),
      fund: fundRow(),
      holdings,
      targets,
    });
    assert.deepEqual(await loadValidatorBasket(env, ACCOUNT_HEX), {
      capture: captureRow(),
      fund: fundRow(),
      holdings,
      targets,
    });
  });
});

describe("handleChainBaskets / handleValidatorBasket", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleChainBaskets(
      new Request("https://api.metagraph.sh/api/v1/chain/baskets"),
      {} as unknown as Env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.capture, null);
    assert.equal(data.fund_count, null);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/chain/baskets.json",
    );
  });

  test("a bound store serves the capture's funds", async () => {
    const { env } = storeEnv({ capture: captureRow(), funds: [fundRow()] });
    const res = await handleChainBaskets(
      new Request("https://api.metagraph.sh/api/v1/chain/baskets"),
      env as unknown as Env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.fund_count, 1);
    assert.equal((data.capture as Row).accepted_at, ACCEPTED_ISO);
    assert.deepEqual(data.baskets, [FORMATTED_FUND]);
  });

  test("rejects an invalid hotkey before touching any store", async () => {
    const res = await handleValidatorBasket(
      new Request("https://api.metagraph.sh/api/v1/validators/nope/basket"),
      {} as unknown as Env,
      "nope",
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_ss58");
  });

  test("serves one validator's basket detail", async () => {
    const { env } = storeEnv({
      capture: captureRow(),
      fund: fundRow(),
      holdings: [
        {
          netuid: 0,
          quantity_atomic: "1000000000",
          quantity_unit: "rao",
          spot_value_rao: "1000000000",
          realizable_value_rao: "1000000000",
        },
      ],
      targets: [{ netuid: 19, weight: 65535 }],
    });
    const res = await handleValidatorBasket(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/basket`,
      ),
      env as unknown as Env,
      HOTKEY,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.basket, FORMATTED_FUND);
    assert.equal((data.holdings as Row[]).length, 1);
    assert.deepEqual(data.targets, [{ netuid: 19, weight: 65535 }]);
    assert.equal(
      (body.meta as Row).artifact_path,
      `/metagraph/validators/${HOTKEY}/basket.json`,
    );
  });

  test("a store decline through the per-validator card keeps the 200 shape", async () => {
    const res = await handleValidatorBasket(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/basket`,
      ),
      {} as unknown as Env,
      HOTKEY,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).capture, null);
    assert.equal((body.data as Row).basket, null);
  });
});

describe("the basket routes through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches both routes (decline bodies on an unbound store)", async () => {
    for (const path of [
      "/api/v1/chain/baskets",
      `/api/v1/validators/${HOTKEY}/basket`,
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Row;
      assert.equal((body.data as Row).capture, null);
    }
  });

  test("testnet has no variant (the loader pins network='finney')", async () => {
    for (const path of [
      "/api/v1/testnet/chain/baskets",
      `/api/v1/testnet/validators/${HOTKEY}/basket`,
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 404);
    }
  });

  test("rejects a query parameter: the cards take none", async () => {
    for (const path of [
      "/api/v1/chain/baskets?window=7d",
      `/api/v1/validators/${HOTKEY}/basket?window=7d`,
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 400);
    }
  });
});
