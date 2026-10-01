import type { ApiSchema } from "@jsonbored/metagraphed";

// Synthetic native state, never captured from a production API or chain.
export const BASKET_KEY = `0x${"11".repeat(32)}`;
export const BASKET_CURSOR = `0x${"22".repeat(32)}`;
export const BASKET_HASH = `0x${"33".repeat(32)}`;
export const BASKET_ACCOUNT = "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9";
const q64 = "18446744073709551616";
export const BASKET_PRICING: ApiSchema<"RootBasketPricing"> = {
  hotkey: BASKET_KEY,
  raw_spot_price_q64_bits: q64,
  display_price_q64_bits: q64,
  stake_price_q64_bits: q64,
  pending_entitlement_q64_bits: q64,
  staker_twr_q64_bits: q64,
  bag_index_q64_bits: q64,
  stake_index_q64_bits: q64,
  first_block: "0",
  provisional: true,
  spot_nav_rao: "9007199254740993",
  shares_atomic: "11",
  display_shares_q64_bits: q64,
};
export function basketResponse(data: ApiSchema<"RootBasketReadData">) {
  return {
    ok: true,
    data: {
      schema_version: 1,
      network: "finney",
      status: "available",
      source: {
        network: "finney",
        network_genesis_hash: `0x${"44".repeat(32)}`,
        finalized_block_hash: BASKET_HASH,
        finalized_block: "500",
        runtime_spec_version: 469,
        runtime_api_version: 5,
        decoder_version: "subtensor-v469-370bac46-v1",
        metadata_sha256: `0x${"55".repeat(32)}`,
      },
      data,
    } satisfies ApiSchema<"RootBasketsArtifact">,
    meta: {},
  };
}
export const BASKET_DETAIL = basketResponse({
  kind: "fund",
  pricing: BASKET_PRICING,
  summary: {
    hotkey: BASKET_KEY,
    spot_nav_rao: "9007199254740993",
    realizable_nav_rao: "9007199254740992",
    shares_atomic: "11",
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
  },
  trading: {
    enabled: true,
    frozen: false,
    refill_blocks: "360",
    available_rao: "4",
    budget_rao: "5",
  },
  baseline: {
    provisional: true,
    first_block: "0",
    price_divisor_q64_bits: null,
    rate0_q32_bits: null,
    tr_splice_q64_bits: null,
  },
});
export const BASKET_RETAINED_CLAIM: ApiSchema<"RootBasketAccountEntry"> = {
  hotkey: BASKET_KEY,
  position: null,
  claim: {
    hotkey: BASKET_KEY,
    owed_shares_atomic: "11",
    accrued_rao: "12",
    redeemable_rao: "9007199254740993",
    forfeited_estimate_rao: "3",
    rows: 5,
    rows_to_sell: 3,
    dust_rows: 2,
    swept_rows: 1,
    flushed_credits: 7,
  },
};
