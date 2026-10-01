import assert from "node:assert/strict";
import { test } from "vitest";
import { collectRootBasketObservation } from "../src/root-basket-observation.ts";
import { RootBasketRuntimeObservationSchema } from "../schemas-src/root-basket-observation.ts";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";
import {
  BASKET_FIXTURE_BLOCK,
  BASKET_FIXTURE_HOTKEY,
  BASKET_FIXTURE_COLDKEY,
  BASKET_FIXTURE_PRICING,
  BASKET_FIXTURE_SUMMARY,
  BASKET_FIXTURE_INDEX,
  basketRuntimeFixture,
  pricingPage,
} from "./fixtures/root-basket-runtime.ts";

test("collection follows empty nonterminal pages and emits one complete finalized observation", async () => {
  let page = 0;
  const fixture = basketRuntimeFixture({
    get_all_beta_pricing: () =>
      ++page === 1 ? pricingPage([], BASKET_FIXTURE_COLDKEY) : pricingPage(),
  });
  const observation = await collectRootBasketObservation(fixture.rpc, "local");
  assert.equal(observation.pages.length, 2);
  assert.equal(observation.pages[0]!.fund_count, 0);
  assert.equal(observation.pages[1]!.start_after, BASKET_FIXTURE_COLDKEY);
  assert.equal(observation.pages[1]!.next_after, null);
  assert.equal(observation.funds.length, 1);
  assert.equal(observation.funds[0]!.page_index, 1);
  assert.equal(observation.funds[0]!.trading!.enabled, true);
  assert.equal(observation.index.status, "not_published");
  assert.equal(observation.source.finalized_block_hash, BASKET_FIXTURE_BLOCK);
  assert.ok(
    fixture.calls
      .filter((call) =>
        ["state_getStorage", "state_call"].includes(call.method),
      )
      .every((call) => call.params.at(-1) === BASKET_FIXTURE_BLOCK),
  );
  assert.equal(
    fixture.calls.filter((call) => call.method === "state_call").length,
    4,
  );
  assert.equal(
    RootBasketRuntimeObservationSchema.safeParse(observation).success,
    true,
  );
  // Modern observations cannot silently masquerade as historical v454 captures.
  assert.equal(RootBasketCaptureSchema.safeParse(observation).success, false);
  const empty = await collectRootBasketObservation(
    basketRuntimeFixture({ get_all_beta_pricing: "0x0000" }).rpc,
    "test",
  );
  assert.deepEqual(empty.funds, []);
  assert.equal(empty.pages.length, 1);
});

test("failed, repeated or incomplete pages never emit a partial observation", async () => {
  for (const pages of [
    [
      pricingPage([BASKET_FIXTURE_PRICING], BASKET_FIXTURE_HOTKEY),
      pricingPage(),
    ],
    [
      pricingPage([], BASKET_FIXTURE_COLDKEY),
      pricingPage([], BASKET_FIXTURE_HOTKEY),
      pricingPage([], BASKET_FIXTURE_COLDKEY),
    ],
    [pricingPage([], BASKET_FIXTURE_COLDKEY), "0x00"],
  ]) {
    let i = 0;
    await assert.rejects(
      collectRootBasketObservation(
        basketRuntimeFixture({ get_all_beta_pricing: () => pages[i++] }).rpc,
        "local",
      ),
    );
  }
  for (const key of [
    "get_validator_basket_summary",
    "get_basket_trading_status",
    "state_getStorage",
  ]) {
    await assert.rejects(
      collectRootBasketObservation(
        basketRuntimeFixture({
          [key]: () => {
            throw new Error("unavailable");
          },
        }).rpc,
        "local",
      ),
      /unavailable/,
    );
  }
});

test("capture budgets reject runaway pagination and oversized fund directories", async () => {
  let i = 0;
  const endless = basketRuntimeFixture({
    get_all_beta_pricing: () =>
      pricingPage([], `0x${(++i).toString(16).padStart(64, "0")}`),
  });
  await assert.rejects(
    collectRootBasketObservation(endless.rpc, "local"),
    /page budget/,
  );
  assert.equal(i, 256);
  let row = 0;
  const large = basketRuntimeFixture({
    get_all_beta_pricing: () => {
      const rows = Array.from(
        { length: 64 },
        () =>
          (++row).toString(16).padStart(64, "0") +
          BASKET_FIXTURE_PRICING.slice(64),
      );
      return pricingPage(rows, `0x${rows.at(-1)!.slice(0, 64)}`);
    },
    get_validator_basket_summary: (params: unknown[]) =>
      `0x${String(params[1]).slice(2)}${BASKET_FIXTURE_SUMMARY.slice(64)}`,
  });
  await assert.rejects(
    collectRootBasketObservation(large.rpc, "local"),
    /fund budget/,
  );
  assert.equal(
    large.calls.filter(
      (call) =>
        call.method === "state_call" &&
        call.params[0] === "BetaBasketRuntimeApi_get_all_beta_pricing",
    ).length,
    33,
  );
});

test("published index completion cannot be newer than the pinned finalized source", async () => {
  const prefix = bytesToHex(
    storageMapPrefix("SubtensorModule", "BetaIndexSnapshot"),
  );
  const fixture = basketRuntimeFixture({
    state_getStorage: (params: unknown[]) =>
      params[0] === prefix ? `0x${BASKET_FIXTURE_INDEX}f501000000000000` : null,
  });
  await assert.rejects(
    collectRootBasketObservation(fixture.rpc, "local"),
    /completion exceeds/,
  );
});

test("observation receipts, identity and child completeness are checked independently", async () => {
  const observation = await collectRootBasketObservation(
    basketRuntimeFixture().rpc,
    "local",
  );
  const corruptions = [
    { started_at_ms: "2", finished_at_ms: "1" },
    { started_at_ms: "bad" },
    { pages: [{ ...observation.pages[0]!, fund_count: 0 }] },
    {
      pages: [{ ...observation.pages[0]!, next_after: BASKET_FIXTURE_HOTKEY }],
    },
    { funds: [observation.funds[0]!, observation.funds[0]!] },
    { funds: [{ ...observation.funds[0]!, page_index: 1 }] },
    {
      funds: [
        {
          ...observation.funds[0]!,
          summary: {
            ...observation.funds[0]!.summary,
            hotkey: BASKET_FIXTURE_COLDKEY,
          },
        },
      ],
    },
    {
      funds: [
        {
          ...observation.funds[0]!,
          summary: {
            ...observation.funds[0]!.summary,
            holdings: [
              observation.funds[0]!.summary.holdings[0]!,
              observation.funds[0]!.summary.holdings[0]!,
            ],
          },
        },
      ],
    },
  ];
  for (const fields of corruptions)
    assert.equal(
      RootBasketRuntimeObservationSchema.safeParse({
        ...observation,
        ...fields,
      }).success,
      false,
    );
});
