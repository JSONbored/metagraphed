import { z } from "zod";
import { BittensorNetworkSchema } from "../shared.ts";
import { RootBasketCaptureSchema } from "../root-basket-capture.ts";
import {
  ROOT_BASKET_READ_LIMITS,
  RootBasketSourceSchema,
  RootBasketPricingSchema,
  RootBasketSummarySchema,
  RootBasketTradingStatusSchema,
  RootBasketPositionSchema,
  RootBasketClaimPreviewSchema,
  RootBasketEntitlementSchema,
} from "../root-basket-runtime.ts";

const account = RootBasketCaptureSchema.shape.funds.element.shape.hotkey;
export const RootBasketBaselineSchema = z.lazy(
  () => RootBasketCaptureSchema.shape.funds.element.shape.baseline,
);
export const RootBasketAccountEntrySchema = z
  .object({
    hotkey: account,
    position: RootBasketPositionSchema.nullable(),
    claim: RootBasketClaimPreviewSchema.nullable(),
    entitlement: RootBasketEntitlementSchema.nullable().optional(),
  })
  .strict();
export const RootBasketDirectorySchema = z
  .object({
    kind: z.literal("directory"),
    pricing: z.array(RootBasketPricingSchema).max(ROOT_BASKET_READ_LIMITS.page),
    next_after: account.nullable(),
    limit: z.int().min(1).max(ROOT_BASKET_READ_LIMITS.page),
  })
  .strict();
export const RootBasketLegacyDirectorySchema = z
  .object({
    kind: z.literal("legacy-directory"),
    summaries: z
      .array(RootBasketSummarySchema)
      .max(ROOT_BASKET_READ_LIMITS.page),
    next_after: account.nullable(),
    limit: z.int().min(1).max(ROOT_BASKET_READ_LIMITS.page),
  })
  .strict();
export const RootBasketDetailSchema = z
  .object({
    kind: z.literal("fund"),
    pricing: RootBasketPricingSchema.nullable(),
    summary: RootBasketSummarySchema,
    trading: RootBasketTradingStatusSchema.nullable(),
    baseline: RootBasketBaselineSchema.nullable(),
  })
  .strict();
export const RootBasketAccountPageSchema = z
  .object({
    kind: z.literal("account"),
    ss58: z.string(),
    entries: z
      .array(RootBasketAccountEntrySchema)
      .max(ROOT_BASKET_READ_LIMITS.accountPage),
    total_relationships: z
      .int()
      .min(0)
      .max(ROOT_BASKET_READ_LIMITS.relationships),
    next_offset: z
      .int()
      .min(0)
      .max(ROOT_BASKET_READ_LIMITS.relationships)
      .nullable(),
    offset: z.int().min(0).max(ROOT_BASKET_READ_LIMITS.relationships),
    limit: z.int().min(1).max(ROOT_BASKET_READ_LIMITS.accountPage),
  })
  .strict();
export const RootBasketReadDataSchema = z.discriminatedUnion("kind", [
  RootBasketDirectorySchema,
  RootBasketLegacyDirectorySchema,
  RootBasketDetailSchema,
  RootBasketAccountPageSchema,
]);
const common = {
  schema_version: z.literal(1),
  network: BittensorNetworkSchema,
};
export const RootBasketsArtifactSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...common,
        status: z.literal("available"),
        source: RootBasketSourceSchema,
        data: RootBasketReadDataSchema,
      })
      .strict(),
    z
      .object({
        ...common,
        status: z.literal("unsupported"),
        source: z.null(),
        data: z.null(),
      })
      .strict(),
    z
      .object({
        ...common,
        status: z.literal("unavailable"),
        source: z.null(),
        data: z.null(),
      })
      .strict(),
  ])
  .meta({
    type: "object",
    examples: [
      {
        schema_version: 1,
        network: "finney",
        status: "available",
        source: {
          network: "finney",
          network_genesis_hash: `0x${"44".repeat(32)}`,
          finalized_block_hash: `0x${"33".repeat(32)}`,
          finalized_block: "500",
          runtime_spec_version: 470,
          runtime_api_version: 5,
          decoder_version: "subtensor-v470-923fd1fa-v1",
          metadata_sha256: `0x${"55".repeat(32)}`,
          capabilities: {
            pricing: true,
            beta_positions: true,
            target_weights: false,
            trading_status: true,
            claim_preview: true,
          },
        },
        data: { kind: "directory", pricing: [], next_after: null, limit: 64 },
      },
    ],
  })
  .describe(
    "Finalized native Root basket state across explicitly audited official releases v441–v471. source.capabilities identifies published operations: API 1 exposes holdings, stored target weights and owed-share entitlements; API 3 adds display beta and pricing; API 4 removes target weights and adds trading status; API 5 adds dust-aware claim previews. Absent methods are never called or replaced with invented prices or zero claims. Unknown layouts and failed reads return no data. Exact u64/u128 values are decimal strings; AccountId32 keys are hex. Read-only; no claim or trade is submitted. Historical block reads require an archive source and do not establish retained snapshot coverage.",
  );
