// MCP tool `get_stake_action_preview` (types-epic E batch 2, #8065). A
// presentation layer over the same computeStakeQuote() result
// get_subnet_stake_quote returns (see get-subnet-stake-quote.ts, pilot
// batch) but reshaped into a human-readable preview with its own distinct
// fields (summary, estimated_out, warnings, ok, disclaimer) -- not the same
// wire shape, so not reused. Modeled from the hand-written literal it
// replaces, which (unlike most tools in this batch) already declared its
// own outputSchema inline rather than via TOOL_OUTPUT_SCHEMAS.
import { z } from "zod";

const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"] as const;

export const GetStakeActionPreviewInputSchema = z
  .object({
    netuid: z.int().min(0),
    amount: z.number().gt(0),
    direction: z.enum(STAKE_QUOTE_DIRECTIONS).optional(),
  })
  .strict();
export type GetStakeActionPreviewInput = z.infer<
  typeof GetStakeActionPreviewInputSchema
>;

const EstimatedOutSchema = z
  .object({
    amount: z.number(),
    unit: z.string(),
  })
  .strict();

export const GetStakeActionPreviewOutputSchema = z
  .object({
    netuid: z.int(),
    direction: z.string(),
    amount: z.number(),
    summary: z.string(),
    estimated_out: EstimatedOutSchema.optional(),
    spot_price_tao: z.number().optional(),
    effective_price_tao: z.number().optional(),
    price_impact_pct: z.number().optional(),
    warnings: z.array(z.string()),
    ok: z.boolean(),
    disclaimer: z.string(),
  })
  .passthrough();
export type GetStakeActionPreviewOutput = z.infer<
  typeof GetStakeActionPreviewOutputSchema
>;
