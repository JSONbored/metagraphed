import type { z } from "zod";
import type { RootBasketCaptureSchema } from "../../schemas-src/root-basket-capture.ts";

/** Synthetic exact arithmetic, not a network capture or performance result.
 * Root cash = 1 TAO; 16 alpha at 0.125 plus 6 alpha at 0.5 give spot NAV 6.
 * Realizable marks total 5. Raw supply 2 beta with divisor 1.5 displays as 3.
 */
export function syntheticBasketCapture(): z.input<
  typeof RootBasketCaptureSchema
> {
  const q64 = (numerator: bigint, denominator = 1n) =>
    ((numerator * (1n << 64n)) / denominator).toString();
  return {
    capture_id: "00000000-0000-4000-8000-000000000001",
    network: "local",
    network_genesis_hash: `0x${"01".repeat(32)}`,
    finalized_block_hash: `0x${"02".repeat(32)}`,
    finalized_block: "500",
    runtime_spec_version: 454,
    runtime_api_version: 3,
    decoder_version: "subtensor-v454-14cde641-v1",
    metadata_sha256: `0x${"03".repeat(32)}`,
    started_at_ms: "1000",
    finished_at_ms: "2000",
    expected_pages: 1,
    expected_funds: 1,
    index: {
      status: "published",
      completed_block: "100",
      bag_q64_bits: q64(7n, 4n),
      stake_q64_bits: q64(3n, 2n),
    },
    pages: [
      {
        page_index: 0,
        start_after: null,
        next_after: null,
        response_sha256: `0x${"04".repeat(32)}`,
        fund_count: 1,
      },
    ],
    funds: [
      {
        hotkey: `0x${"11".repeat(32)}`,
        page_index: 0,
        shares_atomic: "2000000000",
        spot_nav_rao: "6000000000",
        realizable_nav_rao: "5000000000",
        deposited_rao: "4000000000",
        redeemed_rao: "0",
        raw_spot_price_q64_bits: q64(3n),
        display_price_q64_bits: q64(2n),
        display_shares_q64_bits: q64(3_000_000_000n),
        stake_price_q64_bits: q64(45n, 32n),
        staker_twr_q64_bits: q64(9n, 8n),
        pending_entitlement_q64_bits: q64(3n, 16n),
        baseline: {
          provisional: false,
          first_block: "90",
          price_divisor_q64_bits: q64(3n, 2n),
          rate0_q32_bits: "536870912",
          tr_splice_q64_bits: q64(5n, 4n),
        },
        holdings: [
          {
            netuid: 0,
            quantity_atomic: "1000000000",
            quantity_unit: "rao",
            spot_value_rao: "1000000000",
            realizable_value_rao: "1000000000",
          },
          {
            netuid: 19,
            quantity_atomic: "16000000000",
            quantity_unit: "alpha_atomic",
            spot_value_rao: "2000000000",
            realizable_value_rao: "1500000000",
          },
          {
            netuid: 50,
            quantity_atomic: "6000000000",
            quantity_unit: "alpha_atomic",
            spot_value_rao: "3000000000",
            realizable_value_rao: "2500000000",
          },
        ],
        targets: [
          { netuid: 19, weight: 2 },
          { netuid: 50, weight: 1 },
        ],
      },
    ],
  };
}
