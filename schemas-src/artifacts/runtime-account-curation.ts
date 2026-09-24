import { z } from "zod";
import { HistoryAccountFeedSchema } from "./history-account-feed.ts";
import { HistoryObjectSchema } from "./history-generation.ts";

export const RUNTIME_CURATED_EVENT_KINDS = [
  "RootClaimed",
  "BasketDeposited",
  "BasketStakedIn",
  "BasketClaimed",
  "BasketHoldingConverted",
  "BetaBaselineStamped",
  "BasketAlphaWrittenOff",
  "SubnetLeaseDividendSkipped",
  "SharePoolDenominatorReconciled",
  "BasketSwapped",
  "BasketClaimDustSkipped",
  "CollateralLocked",
  "MinCollateralSet",
  "LiquidAlphaConsensusModeSet",
] as const;

export const RUNTIME_CURATION_FIRST_BLOCK = {
  mainnet: 8765684,
  testnet: 7703142,
} as const;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RuntimeAccountCurationPointerSchema = z.strictObject({
  version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]),
  manifest: HistoryObjectSchema,
});

/** The closed correction range is independent of the frozen historical base.
 * Its ordinary block/account indexes contain every qualified raw event in
 * these families; older runtimes retain their original nullable values. */
export const RuntimeAccountCurationSchema = z.strictObject({
  version: z.literal(1),
  state: z.literal("complete"),
  network: z.enum(["mainnet", "testnet"]),
  selection: HistoryAccountFeedSchema.shape.selection,
  sourceSnapshot: z.string().regex(/^[0-9]+$/),
  sourceUuid: z.string().min(1),
  binarySha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: count,
  counts: z.record(z.enum(RUNTIME_CURATED_EVENT_KINDS), count),
  sourceProof: HistoryObjectSchema,
  accountManifest: HistoryObjectSchema,
});
export type RuntimeAccountCuration = z.infer<
  typeof RuntimeAccountCurationSchema
>;
