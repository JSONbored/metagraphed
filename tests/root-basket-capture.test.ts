import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

const parse = (value: unknown) =>
  RootBasketCaptureSchema.safeParse(value).success;

function withFund(change: Record<string, unknown>) {
  const capture = syntheticBasketCapture();
  return { ...capture, funds: [{ ...capture.funds[0]!, ...change }] };
}

describe("finalized basket observation contract", () => {
  test("returns validation errors for malformed temporal fields without throwing", () => {
    for (const value of ["bad", "1.2", "1e3", "18446744073709551616"]) {
      for (const field of [
        "finalized_block",
        "started_at_ms",
        "finished_at_ms",
      ]) {
        assert.equal(
          parse({ ...syntheticBasketCapture(), [field]: value }),
          false,
        );
      }
      const capture = syntheticBasketCapture();
      assert.equal(
        parse({
          ...capture,
          index: { ...capture.index, completed_block: value },
        }),
        false,
      );
      assert.equal(
        parse(
          withFund({
            baseline: { ...capture.funds[0]!.baseline, first_block: value },
          }),
        ),
        false,
      );
    }
  });

  test("preserves raw/display scales and distinct spot/realizable marks exactly", () => {
    const capture = RootBasketCaptureSchema.parse(syntheticBasketCapture());
    const fund = capture.funds[0]!;
    const q = 1n << 64n;
    const rao = 1_000_000_000n;
    assert.equal(BigInt(fund.display_shares_q64_bits) / (q * rao), 3n);
    assert.equal(BigInt(fund.shares_atomic) / rao, 2n);
    assert.equal(
      (BigInt(fund.display_shares_q64_bits) *
        BigInt(fund.display_price_q64_bits)) /
        (q * q),
      BigInt(fund.spot_nav_rao),
    );
    assert.equal(
      fund.holdings.reduce((sum, row) => sum + BigInt(row.spot_value_rao), 0n),
      6n * rao,
    );
    assert.equal(
      fund.holdings.reduce(
        (sum, row) => sum + BigInt(row.realizable_value_rao),
        0n,
      ),
      5n * rao,
    );
    // A quarter of the raw supply has different spot and realizable marks.
    assert.equal(
      (500_000_000n * BigInt(fund.spot_nav_rao)) / BigInt(fund.shares_atomic),
      1_500_000_000n,
    );
    assert.equal(
      (500_000_000n * BigInt(fund.realizable_nav_rao)) /
        BigInt(fund.shares_atomic),
      1_250_000_000n,
    );
  });

  for (const value of [
    "0.5",
    "1e3",
    "01",
    "-0",
    "-1",
    "18446744073709551616",
    2_000_000_000,
    null,
    "bogus",
  ]) {
    test(`rejects noncanonical raw quantity ${String(value)}`, () => {
      assert.equal(parse(withFund({ shares_atomic: value })), false);
    });
  }
  test("preserves >2^53 and maximum u64/u128 quantities without Number conversion", () => {
    const capture = RootBasketCaptureSchema.parse(
      withFund({
        shares_atomic: "18446744073709551615",
        spot_nav_rao: "9007199254740993",
        display_shares_q64_bits: "340282366920938463463374607431768211455",
      }),
    );
    assert.equal(capture.funds[0]!.spot_nav_rao, "9007199254740993");
    assert.equal(
      parse(
        withFund({
          display_shares_q64_bits: "340282366920938463463374607431768211456",
        }),
      ),
      false,
    );
  });
  test("preserves signed Q32 bits while rejecting signed overflow and fractions", () => {
    const baseline = syntheticBasketCapture().funds[0]!.baseline;
    for (const value of [
      "-170141183460469231731687303715884105728",
      "170141183460469231731687303715884105727",
    ]) {
      assert.equal(
        parse(withFund({ baseline: { ...baseline, rate0_q32_bits: value } })),
        true,
      );
    }
    for (const value of [
      "-170141183460469231731687303715884105729",
      "170141183460469231731687303715884105728",
      "-0.5",
    ]) {
      assert.equal(
        parse(withFund({ baseline: { ...baseline, rate0_q32_bits: value } })),
        false,
      );
    }
  });
  test("distinguishes an empty complete part from a missing part", () => {
    assert.equal(parse(withFund({ targets: [] })), true);
    assert.equal(parse(withFund({ targets: null })), false);
    assert.equal(parse(withFund({ holdings: undefined })), false);
  });
  test("accepts a zero-row terminal receipt but rejects partial pagination", () => {
    const capture = syntheticBasketCapture();
    capture.expected_funds = 0;
    capture.funds = [];
    capture.pages[0]!.fund_count = 0;
    assert.equal(parse(capture), true);
    capture.pages[0]!.next_after = `0x${"22".repeat(32)}`;
    assert.equal(parse(capture), false);
    capture.expected_pages = 2;
    capture.pages.push({
      ...capture.pages[0]!,
      page_index: 1,
      start_after: capture.pages[0]!.next_after,
      next_after: null,
    });
    assert.equal(parse(capture), true);
  });
  test("rejects cursor gaps, cycles, duplicate pages, and mismatched receipt counts", () => {
    const capture = syntheticBasketCapture();
    assert.equal(parse({ ...capture, expected_pages: 2 }), false);
    assert.equal(parse({ ...capture, expected_funds: 2 }), false);
    assert.equal(
      parse({ ...capture, pages: [{ ...capture.pages[0]!, fund_count: 0 }] }),
      false,
    );
    const cursor = `0x${"22".repeat(32)}`;
    const pages = [
      { ...capture.pages[0]!, next_after: cursor },
      {
        ...capture.pages[0]!,
        page_index: 1,
        start_after: cursor,
        next_after: cursor,
        fund_count: 0,
      },
      {
        ...capture.pages[0]!,
        page_index: 2,
        start_after: cursor,
        next_after: null,
        fund_count: 0,
      },
    ];
    assert.equal(parse({ ...capture, expected_pages: 3, pages }), false);
    assert.equal(
      parse({ ...capture, pages: [{ ...capture.pages[0]!, page_index: 2 }] }),
      false,
    );
    assert.equal(parse(withFund({ page_index: 1 })), false);
  });
  test("does not turn provisional or unpublished index values into historical identity", () => {
    const capture = syntheticBasketCapture();
    capture.index = {
      status: "not_published",
      completed_block: null,
      bag_q64_bits: "18446744073709551616",
      stake_q64_bits: "18446744073709551616",
    };
    capture.funds[0]!.baseline = {
      provisional: true,
      first_block: "0",
      price_divisor_q64_bits: null,
      rate0_q32_bits: null,
      tr_splice_q64_bits: null,
    };
    assert.equal(parse(capture), true);
    assert.equal(
      parse({ ...capture, index: { ...capture.index, completed_block: "0" } }),
      false,
    );
    assert.equal(
      parse(
        withFund({
          baseline: { ...capture.funds[0]!.baseline, first_block: "90" },
        }),
      ),
      false,
    );
  });
  test("keeps source and index freshness separate and rejects future stamps", () => {
    const capture = syntheticBasketCapture();
    assert.equal(parse(capture), true); // block 500, completed index block 100
    assert.equal(parse({ ...capture, finished_at_ms: "999" }), false);
    assert.equal(
      parse({
        ...capture,
        index: { ...capture.index, completed_block: "501" },
      }),
      false,
    );
    assert.equal(
      parse(
        withFund({
          baseline: { ...capture.funds[0]!.baseline, first_block: "501" },
        }),
      ),
      false,
    );
  });
  test("requires canonical hashes, account bytes, audited runtime, and unique scoped assets", () => {
    const capture = syntheticBasketCapture();
    assert.equal(parse({ ...capture, network_genesis_hash: "0x1234" }), false);
    assert.equal(parse({ ...capture, runtime_spec_version: 455 }), false);
    assert.equal(parse({ ...capture, runtime_api_version: 2 }), false);
    assert.equal(parse({ ...capture, extra: true }), false);
    assert.equal(parse(withFund({ hotkey: `0x${"AB".repeat(32)}` })), false);
    assert.equal(
      parse(
        withFund({
          holdings: [
            {
              ...capture.funds[0]!.holdings[0]!,
              quantity_unit: "alpha_atomic",
            },
          ],
        }),
      ),
      false,
    );
    assert.equal(
      parse(
        withFund({
          holdings: [
            capture.funds[0]!.holdings[0],
            capture.funds[0]!.holdings[0],
          ],
        }),
      ),
      false,
    );
    assert.equal(
      parse(withFund({ targets: [{ netuid: 19, weight: 0.5 }] })),
      false,
    );
    assert.equal(
      parse(withFund({ targets: [{ netuid: 19, weight: 65536 }] })),
      false,
    );
    assert.equal(
      parse(
        withFund({
          targets: [
            { netuid: 19, weight: 2 },
            { netuid: 19, weight: 1 },
          ],
        }),
      ),
      false,
    );
    assert.equal(
      parse({
        ...capture,
        expected_funds: 2,
        pages: [{ ...capture.pages[0]!, fund_count: 2 }],
        funds: [capture.funds[0], capture.funds[0]],
      }),
      false,
    );
  });
  test("keeps an observed zero NAV distinct from unavailable input", () => {
    assert.equal(
      parse(
        withFund({
          spot_nav_rao: "0",
          raw_spot_price_q64_bits: "0",
          display_price_q64_bits: "0",
        }),
      ),
      true,
    );
    assert.equal(parse(withFund({ spot_nav_rao: null })), false);
  });
});
