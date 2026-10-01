import { z } from "zod";
import { BittensorNetworkSchema } from "../shared.ts";
import { limitSchema } from "../query-params.ts";
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
const asOf = RootBasketSourceSchema.shape.finalized_block_hash
  .optional()
  .describe(
    "Canonical finalized block hash. Required when resuming a page; reuse source.finalized_block_hash from the first response.",
  )
  .meta({ examples: [`0x${"11".repeat(32)}`] });
export const RootBasketsQuerySchema = z.object({
  hotkey: account
    .optional()
    .describe(
      "Optional AccountId32 hex fund key; selects one fund's detail instead of directory pricing.",
    )
    .meta({ examples: [`0x${"22".repeat(32)}`] }),
  cursor: account
    .optional()
    .describe(
      "Opaque upstream AccountId32 continuation. Pass it back verbatim with as_of. Empty pricing pages can still carry this cursor.",
    )
    .meta({ examples: [`0x${"22".repeat(32)}`] }),
  as_of: asOf,
  limit: limitSchema(
    ROOT_BASKET_READ_LIMITS.page,
    ROOT_BASKET_READ_LIMITS.page,
  ).optional(),
});
export const AccountRootBasketsQuerySchema = z.object({
  as_of: asOf,
  offset: z
    .int()
    .min(0)
    .max(ROOT_BASKET_READ_LIMITS.relationships)
    .optional()
    .describe(
      "Relationship offset at the pinned block, default 0. Includes confirmed non-basket relationships so no position is silently skipped.",
    )
    .meta({ examples: [16] }),
  limit: limitSchema(
    ROOT_BASKET_READ_LIMITS.accountPage,
    ROOT_BASKET_READ_LIMITS.accountPage,
  ).optional(),
});
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
  .meta({ type: "object" })
  .describe(
    "Finalized native Root basket state from the audited node-subtensor v469/API-5 adapter. Unsupported layouts and failed reads return no data, never invented zero balances. Exact u64/u128 values are decimal strings; AccountId32 keys are hex. Read-only; no claim or trade is submitted. This current-state view is separate from historical collection and the deprecated v440 Root-claim compatibility route.",
  );
