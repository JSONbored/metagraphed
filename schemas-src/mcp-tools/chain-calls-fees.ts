// MCP tools `get_chain_calls`, `get_chain_signers`, `get_chain_fees`
// (types-epic E batch 9, #8072). Each mirrors a GET /api/v1/chain/
// {calls,signers,fees} route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching each hand-written literal field-for-field. `window` is a LITERAL
// inline `["7d","30d"]` enum in all three hand-written originals (no
// symbolic *_WINDOWS import), backed by the shared parseAnalyticsWindow()
// runtime helper -- modeled the same way here, no shared constant.
import { z } from "zod";
import { limitSchema, sortSchema, windowSchema } from "./shared.ts";

const WINDOWS_2 = ["7d", "30d"] as const;

export const GetChainCallsInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    group_by: z
      .enum(["module", "module_function"])
      .optional()
      .describe(
        "How to bucket the counts: by pallet, or by pallet and call together.",
      )
      .meta({ examples: ["module"] }),
    limit: limitSchema(100).optional(),
    call_module: z
      .string()
      .optional()
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainCallsInput = z.infer<typeof GetChainCallsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ChainCallGroupSchema = z
  .object({
    call_module: z.string().nullable().optional(),
    call_function: z.string().nullable().optional(),
    count: z.int().nullable().optional(),
    share: z.unknown().optional(),
  })
  .passthrough();

export const GetChainCallsOutputSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    group_by: z.string(),
    observed_at: z.string().nullable().optional(),
    total_extrinsics: z.int(),
    call_count: z.int(),
    calls: z.array(ChainCallGroupSchema),
  })
  .passthrough();
export type GetChainCallsOutput = z.infer<typeof GetChainCallsOutputSchema>;

export const GetChainSignersInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    sort: sortSchema(["tx_count", "total_fee_tao"]).optional(),
    limit: limitSchema(100).optional(),
    call_module: z
      .string()
      .optional()
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainSignersInput = z.infer<typeof GetChainSignersInputSchema>;

// objectItems(...) properties, none required at the item level.
const ChainSignerSchema = z
  .object({
    signer: z.string().nullable().optional(),
    tx_count: z.int().nullable().optional(),
    total_fee_tao: z.number().nullable().optional(),
    total_tip_tao: z.number().nullable().optional(),
    last_tx_block: z.int().nullable().optional(),
  })
  .passthrough();

export const GetChainSignersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string(),
    sort: z.enum(["tx_count", "total_fee_tao"]),
    observed_at: z.string().nullable().optional(),
    signer_count: z.int(),
    signers: z.array(ChainSignerSchema),
  })
  .passthrough();
export type GetChainSignersOutput = z.infer<typeof GetChainSignersOutputSchema>;

export const GetChainFeesInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(100).optional(),
    call_module: z
      .string()
      .optional()
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainFeesInput = z.infer<typeof GetChainFeesInputSchema>;

// objectItems(...) properties, none required at the item level.
const ChainFeesDaySchema = z
  .object({
    day: z.string().nullable().optional(),
    extrinsic_count: z.int().nullable().optional(),
    signed_extrinsic_count: z.int().nullable().optional(),
    total_fee_tao: z.number().nullable().optional(),
    avg_fee_tao: z.number().nullable().optional(),
    median_fee_tao: z.number().nullable().optional(),
    total_tip_tao: z.number().nullable().optional(),
    avg_tip_tao: z.number().nullable().optional(),
    median_tip_tao: z.number().nullable().optional(),
  })
  .passthrough();

const ChainTopFeePayerSchema = z
  .object({
    signer: z.string().nullable().optional(),
    total_fee_tao: z.number().nullable().optional(),
    total_tip_tao: z.number().nullable().optional(),
    extrinsic_count: z.int().nullable().optional(),
  })
  .passthrough();

export const GetChainFeesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int(),
    daily: z.array(ChainFeesDaySchema),
    top_fee_payers: z.array(ChainTopFeePayerSchema),
  })
  .passthrough();
export type GetChainFeesOutput = z.infer<typeof GetChainFeesOutputSchema>;
