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
export const RootBasketDetailSchema = z
  .object({
    kind: z.literal("fund"),
    pricing: RootBasketPricingSchema.nullable(),
    summary: RootBasketSummarySchema,
    trading: RootBasketTradingStatusSchema,
    baseline: RootBasketBaselineSchema,
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
        },
        data: { kind: "directory", pricing: [], next_after: null, limit: 64 },
      },
    ],
  })
  .describe(
    "Finalized native Root basket state from the audited node-subtensor v469/v470 API-5 adapter. Unsupported layouts and failed reads return no data, never invented zero balances. Exact u64/u128 values are decimal strings; AccountId32 keys are hex. Read-only; no claim or trade is submitted. This current-state view is separate from historical collection and the deprecated v440 Root-claim compatibility route.",
  );
