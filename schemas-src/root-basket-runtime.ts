// Audited release identities and API generations are in root-basket-compatibility.
// Older summaries include weights; API 3 adds pricing, 4 trading and 5 previews.
// Reuse the historical capture's exact quantity vocabulary without widening it.
import { z } from "zod";
import { RootBasketCaptureSchema } from "./root-basket-capture.ts";
import {
  ROOT_BASKET_RUNTIME_ADAPTERS,
  rootBasketCapabilities,
} from "./root-basket-compatibility.ts";

const capture = RootBasketCaptureSchema.shape;
const fund = capture.funds.element.shape;
// Preserve the input pipeline's decimal grammar in the published output schema.
const u64 = fund.spot_nav_rao.meta({
  pattern: "^(0|[1-9]\\d*)$",
  maxLength: 20,
  examples: ["9007199254740993"],
});
const q64 = fund.raw_spot_price_q64_bits.meta({
  pattern: "^(0|[1-9]\\d*)$",
  examples: ["18446744073709551616"],
});
const count = capture.expected_funds;
export const ROOT_BASKET_READ_LIMITS = {
  page: 64,
  holdings: 1_024,
  positions: 256,
  relationships: 4_096,
  accountPage: 16,
  bytes: 1_048_576,
  pages: 256,
  funds: 2_048,
} as const;

export const RootBasketFinalizedHashSchema = capture.finalized_block_hash;
const sourceIdentity = {
  network: capture.network,
  network_genesis_hash: capture.network_genesis_hash,
  finalized_block_hash: RootBasketFinalizedHashSchema,
  finalized_block: u64,
};

// Keep the audited runtime and decoder paired in both validation and OpenAPI.
function sourceSchema<const A extends (typeof ROOT_BASKET_RUNTIME_ADAPTERS)[number]>(adapter: A) {
  const capabilities = rootBasketCapabilities(adapter.api);
  return z.object({
    ...sourceIdentity,
    runtime_spec_version: z.literal(adapter.spec),
    runtime_api_version: z.literal(adapter.api),
    decoder_version: z.literal(adapter.decoder),
    metadata_sha256: capture.metadata_sha256,
    capabilities: z.object({
      pricing: z.literal(capabilities.pricing),
      beta_positions: z.literal(capabilities.beta_positions),
      target_weights: z.literal(capabilities.target_weights),
      trading_status: z.literal(capabilities.trading_status),
      claim_preview: z.literal(capabilities.claim_preview),
    }).strict(),
  }).strict();
}
export const RootBasketSourceSchema = z.discriminatedUnion("runtime_spec_version", [
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[0]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[1]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[2]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[3]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[4]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[5]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[6]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[7]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[8]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[9]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[10]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[11]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[12]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[13]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[14]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[15]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[16]),
  sourceSchema(ROOT_BASKET_RUNTIME_ADAPTERS[17]),
]);

export const BasketRuntimeHeaderSchema = z.object({
  number: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(18),
});
export const BasketRuntimeVersionSchema = z.object({
  specName: z.string(),
  specVersion: z.number().int().nonnegative(),
  apis: z.array(z.tuple([z.string(), z.number().int().nonnegative()])),
});

export const RootBasketPricingSchema = z
  .object({
    hotkey: fund.hotkey,
    raw_spot_price_q64_bits: q64,
    display_price_q64_bits: q64,
    stake_price_q64_bits: q64,
    pending_entitlement_q64_bits: q64,
    staker_twr_q64_bits: q64,
    bag_index_q64_bits: q64,
    stake_index_q64_bits: q64,
    first_block: u64,
    provisional: z.boolean(),
    spot_nav_rao: u64,
    shares_atomic: u64,
    display_shares_q64_bits: q64,
  })
  .strict();

export const RootBasketPricingPageSchema = z
  .object({
    pricing: z.array(RootBasketPricingSchema).max(ROOT_BASKET_READ_LIMITS.page),
    next_after: fund.hotkey.nullable(),
  })
  .strict();

export const RootBasketSummarySchema = z
  .object({
    hotkey: fund.hotkey,
    realizable_nav_rao: u64,
    spot_nav_rao: u64,
    shares_atomic: u64,
    deposited_rao: u64,
    redeemed_rao: u64,
    target_weights: z.array(z.object({
      netuid: z.int().min(0).max(65_535),
      weight_u16: z.int().min(0).max(65_535),
    }).strict()).max(ROOT_BASKET_READ_LIMITS.holdings).optional(),
    holdings: z
      .array(
        fund.holdings.element.safeExtend({
          quantity_atomic: u64,
          spot_value_rao: u64,
          realizable_value_rao: u64,
        }),
      )
      .max(ROOT_BASKET_READ_LIMITS.holdings),
  })
  .strict();

export const RootBasketPositionSchema = z
  .object({
    hotkey: fund.hotkey,
    beta_atomic: u64,
    display_beta_q64_bits: q64,
    display_price_q64_bits: q64,
    realizable_value_rao: u64,
    spot_value_rao: u64,
    provisional: z.boolean(),
  })
  .strict();

// API 1 publishes owed shares and a marked payout, without display pricing or
// dust-aware execution preview. Preserve that narrower meaning.
export const RootBasketEntitlementSchema = z.object({
  hotkey: fund.hotkey,
  owed_shares_atomic: u64,
  payout_rao: u64,
}).strict();

export const RootBasketTradingStatusSchema = z
  .object({
    enabled: z.boolean(),
    frozen: z.boolean(),
    refill_blocks: u64,
    available_rao: u64,
    budget_rao: u64,
  })
  .strict();

export const RootBasketClaimPreviewSchema = z
  .object({
    hotkey: fund.hotkey,
    owed_shares_atomic: u64,
    accrued_rao: u64,
    redeemable_rao: u64,
    forfeited_estimate_rao: u64,
    rows: count,
    rows_to_sell: count,
    dust_rows: count,
    swept_rows: count,
    flushed_credits: count,
  })
  .strict();

export const RootBasketIndexSchema = z
  .object({
    bag_index_q64_bits: q64,
    stake_index_q64_bits: q64,
  })
  .strict();
