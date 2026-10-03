import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeBasketClaimPreview,
  decodeBasketClaimPreviews,
  decodeBasketIndex,
  decodeBasketPortfolio,
  decodeBasketPosition,
  decodeBasketPricing,
  decodeBasketPricingPage,
  decodeBasketSummary,
  decodeBasketTradingStatus,
  decodeBasketStakingHotkeys,
  decodeBasketBaseline,
  decodeBasketIndexSnapshot,
} from "../src/root-basket-runtime-codec.ts";
import {
  BASKET_FIXTURE_CLAIM,
  BASKET_FIXTURE_HOTKEY,
  BASKET_FIXTURE_INDEX,
  BASKET_FIXTURE_POSITION,
  BASKET_FIXTURE_PRICING,
  BASKET_FIXTURE_Q64,
  BASKET_FIXTURE_SUMMARY,
  BASKET_FIXTURE_TRADING,
  BASKET_FIXTURE_WIDE,
  pricingPage,
} from "./fixtures/root-basket-runtime.ts";

const cases = [
  [decodeBasketPricingPage, pricingPage()],
  [decodeBasketPricing, `0x01${BASKET_FIXTURE_PRICING}`],
  [decodeBasketSummary, `0x${BASKET_FIXTURE_SUMMARY}`],
  [decodeBasketPosition, `0x01${BASKET_FIXTURE_POSITION}`],
  [decodeBasketPortfolio, `0x04${BASKET_FIXTURE_POSITION}`],
  [decodeBasketClaimPreview, `0x01${BASKET_FIXTURE_CLAIM}`],
  [decodeBasketClaimPreviews, `0x04${BASKET_FIXTURE_CLAIM}`],
  [decodeBasketTradingStatus, `0x${BASKET_FIXTURE_TRADING}`],
  [decodeBasketIndex, `0x${BASKET_FIXTURE_INDEX}`],
] as const;

test("frozen pricing layout preserves exact quantities and distinct marks", () => {
  const page = decodeBasketPricingPage(pricingPage([], BASKET_FIXTURE_HOTKEY));
  assert.deepEqual(page, { pricing: [], next_after: BASKET_FIXTURE_HOTKEY });
  const row = decodeBasketPricing(`0x01${BASKET_FIXTURE_PRICING}`)!;
  assert.equal(row.hotkey, BASKET_FIXTURE_HOTKEY);
  assert.equal(row.spot_nav_rao, BASKET_FIXTURE_WIDE);
  assert.equal(
    row.raw_spot_price_q64_bits,
    (2n * BigInt(BASKET_FIXTURE_Q64)).toString(),
  );
  assert.equal(
    row.pending_entitlement_q64_bits,
    (5n * BigInt(BASKET_FIXTURE_Q64)).toString(),
  );
  assert.equal(
    row.staker_twr_q64_bits,
    (6n * BigInt(BASKET_FIXTURE_Q64)).toString(),
  );
  assert.equal(row.display_shares_q64_bits, "18446744073709551617");
  assert.equal(row.first_block, "100");
  assert.equal(row.provisional, false);
  assert.deepEqual(decodeBasketPricingPage(pricingPage()).pricing, [row]);
  assert.equal(
    decodeBasketPricingPage(pricingPage(Array(64).fill(BASKET_FIXTURE_PRICING)))
      .pricing.length,
    64,
  );
});

test("validated hex decoding removes per-byte temporary strings with identical bytes", () => {
  const hex = pricingPage(Array(64).fill(BASKET_FIXTURE_PRICING)).slice(2);
  const previous = () =>
    Uint8Array.from(hex.match(/../g) ?? [], (part) =>
      Number.parseInt(part, 16),
    );
  const current = () => Buffer.from(hex, "hex");
  assert.deepEqual([...current()], [...previous()]);
  const measure = (convert: () => Uint8Array) => {
    for (let i = 0; i < 10; i++) convert();
    const samples: number[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const start = performance.now();
      for (let i = 0; i < 100; i++) convert();
      samples.push((performance.now() - start) / 100);
    }
    return samples.sort((a, b) => a - b)[2]!;
  };
  console.log(
    "ROOT_BASKET_FIXTURE_HEX",
    JSON.stringify({
      decoded_bytes: hex.length / 2,
      removed_temporary_byte_strings: hex.length / 2,
      iterations_per_sample: 100,
      samples: 5,
      previous_median_ms: measure(previous),
      direct_median_ms: measure(current),
      bytes_equal: true,
      production_observation: false,
    }),
  );
});

test("summary distinguishes root cash, subnet alpha and realizable valuation", () => {
  assert.deepEqual(decodeBasketSummary(`0x${BASKET_FIXTURE_SUMMARY}`), {
    hotkey: BASKET_FIXTURE_HOTKEY,
    realizable_nav_rao: "5",
    spot_nav_rao: "7",
    shares_atomic: "17",
    deposited_rao: "19",
    redeemed_rao: "23",
    holdings: [
      {
        netuid: 0,
        quantity_atomic: "1",
        quantity_unit: "rao",
        spot_value_rao: "1",
        realizable_value_rao: "1",
      },
      {
        netuid: 19,
        quantity_atomic: "3",
        quantity_unit: "alpha_atomic",
        spot_value_rao: "6",
        realizable_value_rao: "4",
      },
    ],
  });
});

test("position, dust-aware claim and trading views never manufacture a claim payout", () => {
  const position = decodeBasketPosition(`0x01${BASKET_FIXTURE_POSITION}`)!;
  assert.equal(position.beta_atomic, "11");
  assert.equal(position.display_beta_q64_bits, "12");
  assert.equal(position.realizable_value_rao, "14");
  assert.equal(position.spot_value_rao, "15");
  assert.deepEqual(decodeBasketPortfolio(`0x04${BASKET_FIXTURE_POSITION}`), [
    position,
  ]);
  const claim = decodeBasketClaimPreview(`0x01${BASKET_FIXTURE_CLAIM}`)!;
  assert.deepEqual(claim, {
    hotkey: BASKET_FIXTURE_HOTKEY,
    owed_shares_atomic: "11",
    accrued_rao: "12",
    redeemable_rao: "9",
    forfeited_estimate_rao: "3",
    rows: 5,
    rows_to_sell: 3,
    dust_rows: 2,
    swept_rows: 1,
    flushed_credits: 7,
  });
  assert.deepEqual(decodeBasketClaimPreviews(`0x04${BASKET_FIXTURE_CLAIM}`), [
    claim,
  ]);
  assert.deepEqual(decodeBasketTradingStatus(`0x${BASKET_FIXTURE_TRADING}`), {
    enabled: true,
    frozen: false,
    refill_blocks: "360",
    available_rao: "4",
    budget_rao: "5",
  });
  assert.deepEqual(decodeBasketIndex(`0x${BASKET_FIXTURE_INDEX}`), {
    bag_index_q64_bits: "7",
    stake_index_q64_bits: "8",
  });
});

test("confirmed empty and absent values remain distinct from failed decoding", () => {
  for (const decode of [
    decodeBasketPricing,
    decodeBasketPosition,
    decodeBasketClaimPreview,
  ])
    assert.equal(decode("0x00"), null);
  for (const decode of [decodeBasketPortfolio, decodeBasketClaimPreviews])
    assert.deepEqual(decode("0x00"), []);
  assert.deepEqual(decodeBasketPricingPage("0x0000"), {
    pricing: [],
    next_after: null,
  });
});

test("every decoder rejects malformed, truncated, trailing and oversized bytes", () => {
  for (const [decode, valid] of cases) {
    for (const bad of [
      null,
      {},
      "0x0",
      "0xzz",
      "0x",
      valid.slice(0, -2),
      `${valid}00`,
      `0x${"00".repeat(1_048_577)}`,
    ])
      assert.throws(() => decode(bad));
  }
  for (const decode of [
    decodeBasketPricing,
    decodeBasketPosition,
    decodeBasketClaimPreview,
  ])
    assert.throws(() => decode("0x02"), /discriminant/);
  assert.throws(
    () => decodeBasketTradingStatus(`0x02${BASKET_FIXTURE_TRADING.slice(2)}`),
    /discriminant/,
  );
  for (const prefix of ["0500", "02000000", "03000000", "0504", "02000100"])
    assert.throws(() => decodeBasketPortfolio(`0x${prefix}`), /length|budget/);
});

test("pinned storage defaults are explicit and signed baseline bits survive decoding", () => {
  assert.deepEqual(decodeBasketStakingHotkeys(null), []);
  assert.deepEqual(decodeBasketStakingHotkeys("0x00"), []);
  assert.deepEqual(
    decodeBasketStakingHotkeys(`0x04${BASKET_FIXTURE_HOTKEY.slice(2)}`),
    [BASKET_FIXTURE_HOTKEY],
  );
  assert.throws(
    () =>
      decodeBasketStakingHotkeys(
        `0x08${BASKET_FIXTURE_HOTKEY.slice(2).repeat(2)}`,
      ),
    /Duplicate/,
  );
  assert.equal(decodeBasketBaseline(null).provisional, true);
  const one = `01000000000000000000000000000000`;
  const baseline = decodeBasketBaseline(
    `0x${one}${"ff".repeat(16)}${one}0100000000000000`,
  );
  assert.equal(baseline.rate0_q32_bits, "-1");
  assert.equal(baseline.first_block, "1");
  assert.equal(baseline.provisional, false);
  assert.equal(
    decodeBasketBaseline(`0x${one}${"00".repeat(16)}${one}0100000000000000`)
      .rate0_q32_bits,
    "0",
  );
  assert.deepEqual(decodeBasketIndexSnapshot(null), {
    status: "not_published",
    completed_block: null,
    bag_q64_bits: BASKET_FIXTURE_Q64,
    stake_q64_bits: BASKET_FIXTURE_Q64,
  });
  assert.deepEqual(
    decodeBasketIndexSnapshot(`0x${BASKET_FIXTURE_INDEX}0100000000000000`),
    {
      status: "published",
      completed_block: "1",
      bag_q64_bits: "7",
      stake_q64_bits: "8",
    },
  );
  for (const decode of [
    decodeBasketBaseline,
    decodeBasketIndexSnapshot,
    decodeBasketStakingHotkeys,
  ]) {
    for (const bad of [undefined, "0x", "0x00ff", "0x0"])
      assert.throws(() => decode(bad));
  }
});
