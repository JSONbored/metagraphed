// Audited SCALE contract: subtensor v469, 370bac46fa8cf602c4f8283a0635b3a8b4675394.
// Basket API 5 adds dust-aware claim previews; composition has no target weights.
// Reuse the historical capture's exact quantity vocabulary without widening it.
import { z } from "zod";
import { RootBasketCaptureSchema } from "./root-basket-capture.ts";

const capture = RootBasketCaptureSchema.shape;
const fund = capture.funds.element.shape;
const u64 = fund.spot_nav_rao;
const q64 = fund.raw_spot_price_q64_bits;
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

export const RootBasketSourceSchema = z
  .object({
    network: capture.network,
    network_genesis_hash: capture.network_genesis_hash,
    finalized_block_hash: capture.finalized_block_hash,
    finalized_block: capture.finalized_block,
    runtime_spec_version: z.literal(469),
    runtime_api_version: z.literal(5),
    decoder_version: z.literal("subtensor-v469-370bac46-v1"),
    metadata_sha256: capture.metadata_sha256,
  })
  .strict();

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
    holdings: fund.holdings.max(ROOT_BASKET_READ_LIMITS.holdings),
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

/** Collection contract for the audited modern layout. It deliberately cannot
 * enter the v454 receiver: versioned observations must retain their provenance.
 */
export const RootBasketRuntimeObservationSchema = z
  .object({
    capture_id: capture.capture_id,
    source: RootBasketSourceSchema,
    index: capture.index,
    started_at_ms: capture.started_at_ms,
    finished_at_ms: capture.finished_at_ms,
    pages: capture.pages.min(1).max(ROOT_BASKET_READ_LIMITS.pages),
    funds: z
      .array(
        z
          .object({
            page_index: count,
            pricing: RootBasketPricingSchema,
            summary: RootBasketSummarySchema,
            trading: RootBasketTradingStatusSchema,
            baseline: fund.baseline,
          })
          .strict(),
      )
      .max(ROOT_BASKET_READ_LIMITS.funds),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const started = capture.started_at_ms.safeParse(observation.started_at_ms);
    const finished = capture.finished_at_ms.safeParse(
      observation.finished_at_ms,
    );
    if (
      started.success &&
      finished.success &&
      BigInt(finished.data) < BigInt(started.data)
    )
      issue("Observation finishes before it starts");
    const seenFunds = new Set<string>();
    const seenCursors = new Set<string>();
    const counts = new Map<number, number>();
    for (const row of observation.funds) {
      if (
        row.summary.hotkey !== row.pricing.hotkey ||
        seenFunds.has(row.pricing.hotkey)
      )
        issue("Duplicate or mismatched observation fund");
      seenFunds.add(row.pricing.hotkey);
      counts.set(row.page_index, (counts.get(row.page_index) ?? 0) + 1);
      if (
        new Set(row.summary.holdings.map((holding) => holding.netuid)).size !==
        row.summary.holdings.length
      )
        issue("Duplicate observation holding");
    }
    for (const [position, row] of observation.pages.entries()) {
      const start =
        position === 0 ? null : observation.pages[position - 1]!.next_after;
      if (
        row.page_index !== position ||
        row.start_after !== start ||
        (position > 0 && start === null) ||
        (position === observation.pages.length - 1) !==
          (row.next_after === null)
      )
        issue("Observation pages are not a complete contiguous chain");
      if (row.fund_count !== (counts.get(position) ?? 0))
        issue("Observation receipt count mismatch");
      if (row.next_after !== null) {
        if (seenCursors.has(row.next_after))
          issue("Observation cursor repeats");
        seenCursors.add(row.next_after);
      }
    }
    if ([...counts.keys()].some((page) => page >= observation.pages.length))
      issue("Observation fund has no receipt");
  });
