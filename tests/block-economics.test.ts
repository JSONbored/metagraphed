import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  blockEconomicsUsd,
  summarizeBlockEconomics,
} from "../src/block-economics.ts";

describe("summarizeBlockEconomics", () => {
  test("keeps native transfers, stake flow, issuance, fees and tips separate", () => {
    const summary = summarizeBlockEconomics(
      [
        {
          signer: "5Signer",
          fee_tao: "0.000002131419",
          tip_tao: "0.000000001",
          call_args: JSON.stringify([
            { name: "netuid", value: 19 },
            { name: "dest_netuid", value: "7" },
          ]),
        },
        { signer: null, fee_tao: null, tip_tao: null, call_args: null },
      ],
      [
        { event_kind: "Transfer", amount_tao: "3.5", netuid: null },
        { event_kind: "StakeAdded", amount_tao: "2.25", netuid: 19 },
        { event_kind: "StakeRemoved", amount_tao: "0.5", netuid: 7 },
        { event_kind: "Issued", amount_tao: "1", netuid: null },
        { event_kind: "Deposit", amount_tao: "999", netuid: 7 },
        { event_kind: "StakeMoved", amount_tao: "500", netuid: 3 },
        {
          event_kind: "AlphaSwapped",
          amount_tao: null,
          alpha_amount: "900",
          netuid: 42,
        },
      ],
    );

    assert.deepEqual(summary, {
      native_transfer_tao: "3.5",
      stake_flow_tao: "2.75",
      economic_activity_tao: "6.25",
      fee_tao: "0.000002131419",
      tip_tao: "0.000000001",
      issuance_tao: "1",
      subnet_ids: [3, 7, 19, 42],
      economics_complete: 1,
    });
  });

  test("a complete block with no economic events reports measured zeroes", () => {
    assert.deepEqual(
      summarizeBlockEconomics([], [{ event_kind: "Deposit", amount_tao: "4" }]),
      {
        native_transfer_tao: "0",
        stake_flow_tao: "0",
        economic_activity_tao: "0",
        fee_tao: "0",
        tip_tao: "0",
        issuance_tao: "0",
        subnet_ids: [],
        economics_complete: 1,
      },
    );
  });

  test("a categorized event with no amount remains unknown instead of becoming zero", () => {
    const native = summarizeBlockEconomics(
      [],
      [
        { event_kind: "Transfer", amount_tao: null },
        { event_kind: "StakeAdded", amount_tao: "2" },
      ],
    );
    assert.equal(native.native_transfer_tao, null);
    assert.equal(native.stake_flow_tao, "2");
    assert.equal(native.economic_activity_tao, null);

    const stake = summarizeBlockEconomics(
      [],
      [
        { event_kind: "Transfer", amount_tao: "3" },
        { event_kind: "StakeRemoved", amount_tao: "bad" },
      ],
    );
    assert.equal(stake.native_transfer_tao, "3");
    assert.equal(stake.stake_flow_tao, null);
    assert.equal(stake.economic_activity_tao, null);
  });

  test("a signed call with an undecoded fee or tip does not claim it was free", () => {
    const missingFee = summarizeBlockEconomics(
      [{ signer: "5Signer", fee_tao: null, tip_tao: "0" }],
      [],
    );
    assert.equal(missingFee.fee_tao, null);
    assert.equal(missingFee.tip_tao, "0");

    const missingTip = summarizeBlockEconomics(
      [{ signer: "5Signer", fee_tao: "0.1", tip_tao: null }],
      [],
    );
    assert.equal(missingTip.fee_tao, "0.1");
    assert.equal(missingTip.tip_tao, null);
  });

  test("only named netuid fields contribute to the subnet footprint", () => {
    const summary = summarizeBlockEconomics(
      [
        {
          signer: null,
          call_args: JSON.stringify({
            netuid: 9,
            nested: [
              { name: "subnet_id", value: 2 },
              { name: "uid", value: 777 },
            ],
            wrapper: { name: "payload", value: { destination_netuid: 4 } },
            amount: 64,
          }),
        },
        { signer: null, call_args: "not-json" },
      ],
      [{ event_kind: "WeightsSet", netuid: 12, amount_tao: null }],
    );
    assert.deepEqual(summary.subnet_ids, [2, 4, 9, 12]);
  });

  test("preserves exact decimal sums beyond ordinary display precision", () => {
    const summary = summarizeBlockEconomics(
      [
        { signer: "a", fee_tao: "0.000000000001", tip_tao: "0" },
        { signer: "b", fee_tao: "0.000000000009", tip_tao: "0" },
      ],
      [
        { event_kind: "Transfer", amount_tao: "9007199.254740993" },
        { event_kind: "Transfer", amount_tao: "0.000000007" },
      ],
    );
    assert.equal(summary.fee_tao, "0.00000000001");
    assert.equal(summary.native_transfer_tao, "9007199.254741");
  });

  test("rejects lossy decimals and ignores malformed or excessively nested subnet ids", () => {
    const summary = summarizeBlockEconomics(
      [
        {
          signer: "a",
          fee_tao: "1.0000000000000000001",
          tip_tao: "2.0000000000000000000",
          call_args: {
            netuid: -1,
            invalidNamed: { name: "netuid", value: -2 },
            nested: {
              nested: {
                nested: {
                  nested: {
                    nested: {
                      nested: {
                        nested: { nested: { nested: { netuid: 99 } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
      [{ amount_tao: "9", netuid: "not-a-netuid" }],
    );
    assert.equal(summary.fee_tao, null);
    assert.equal(summary.tip_tao, "2");
    assert.deepEqual(summary.subnet_ids, []);
  });

  test("prices a block with one fresh response-level reading and keeps provenance", () => {
    assert.deepEqual(
      blockEconomicsUsd(
        "2.5",
        {
          usd_per_tao: 240,
          observed_at: "2026-08-29T05:00:00.000Z",
          block_number: 8_948_000,
          price_basis: "wrapped_onchain_median",
        },
        Date.parse("2026-08-29T05:05:00.000Z"),
      ),
      {
        economic_activity_usd: 600,
        usd_per_tao: 240,
        tao_usd_block: 8_948_000,
        tao_usd_observed_at: "2026-08-29T05:00:00.000Z",
        tao_usd_basis: "wrapped_onchain_median",
      },
    );
  });

  test("does not price with a stale reading or fabricate a block total", () => {
    const reading = {
      usd_per_tao: 240,
      observed_at: "2026-08-29T01:00:00.000Z",
      block_number: 8_948_000,
      price_basis: "wrapped_onchain_median",
    };
    assert.equal(
      blockEconomicsUsd("2.5", reading, Date.parse("2026-08-29T05:00:00.000Z"))
        .tao_usd_unavailable,
      "index_stale",
    );
    assert.deepEqual(
      blockEconomicsUsd(
        null,
        { ...reading, observed_at: "2026-08-29T04:59:00.000Z" },
        Date.parse("2026-08-29T05:00:00.000Z"),
      ),
      {
        economic_activity_usd: null,
        usd_per_tao: null,
        tao_usd_block: null,
        tao_usd_observed_at: null,
        tao_usd_basis: null,
      },
    );
  });

  test("labels missing and unusable prices and supports numeric totals", () => {
    assert.equal(
      blockEconomicsUsd(2, null, 0).tao_usd_unavailable,
      "no_index_reading",
    );
    assert.equal(
      blockEconomicsUsd(
        2,
        {
          usd_per_tao: null,
          observed_at: null,
          block_number: null,
          price_basis: null,
        },
        0,
      ).tao_usd_unavailable,
      "index_unpriced",
    );
    assert.deepEqual(
      blockEconomicsUsd(
        2,
        {
          usd_per_tao: 3,
          observed_at: "2026-08-29T05:00:00.000Z",
          block_number: null,
          price_basis: null,
        },
        Date.parse("2026-08-29T05:00:01.000Z"),
      ),
      {
        economic_activity_usd: 6,
        usd_per_tao: 3,
        tao_usd_block: null,
        tao_usd_observed_at: "2026-08-29T05:00:00.000Z",
        tao_usd_basis: null,
      },
    );
    assert.equal(
      blockEconomicsUsd(
        Number.MAX_VALUE,
        {
          usd_per_tao: Number.MAX_VALUE,
          observed_at: "2026-08-29T05:00:00.000Z",
          block_number: null,
          price_basis: null,
        },
        Date.parse("2026-08-29T05:00:01.000Z"),
      ).economic_activity_usd,
      null,
    );
  });
});
