// GET /api/v1/chain/activity + .../calls + .../signers + .../fees
// (types-epic B batch 6, #8060). Live extrinsics/blocks D1-tier data -- no
// static file. Modeled from src/chain-analytics.ts's buildChainActivity()/
// buildChainCalls()/buildChainSigners()/buildChainFees(), cross-checked
// against the hand-edited ChainActivityArtifact/ChainCallsArtifact/
// ChainSignersArtifact/ChainFeesArtifact components they replace.
//
// ChainActivityDay/ChainCallEntry/ChainSignerEntry/ChainFeeDay/ChainFeePayer
// are intentionally NOT registered as shared components -- each is
// referenced only by the one hand-edited component this batch replaces
// (verified via repo-wide $ref grep), so all five hand-edited component
// keys become fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainActivityDaySchema = z
  .object({
    day: z.string(),
    block_count: z.int().min(0),
    extrinsic_count: z.int().min(0),
    event_count: z.int().min(0),
    successful_extrinsics: z.int().min(0),
    success_rate: z.number().min(0).max(1).nullable(),
    unique_signers: z.int().min(0),
  })
  .strict();

export const ChainActivityArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int().min(0),
    days: z.array(ChainActivityDaySchema),
  })
  .passthrough();
export type ChainActivityArtifact = z.infer<typeof ChainActivityArtifactSchema>;
export const ChainActivityResponseSchema = successEnvelopeSchema(
  ChainActivityArtifactSchema,
);
export const ChainActivityQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainActivityQuery = z.infer<typeof ChainActivityQuerySchema>;

const ChainCallEntrySchema = z
  .object({
    call_module: z.string(),
    call_function: z.string().nullable(),
    count: z.int().min(0),
    share: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const ChainCallsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    group_by: z.string(),
    observed_at: z.string().nullable().optional(),
    total_extrinsics: z.int().min(0),
    call_count: z.int().min(0),
    calls: z.array(ChainCallEntrySchema),
  })
  .passthrough();
export type ChainCallsArtifact = z.infer<typeof ChainCallsArtifactSchema>;
export const ChainCallsResponseSchema = successEnvelopeSchema(
  ChainCallsArtifactSchema,
);
export const ChainCallsQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    group_by: z.enum(["module", "module_function"]).optional(),
    limit: z.int().min(1).optional(),
    call_module: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainCallsQuery = z.infer<typeof ChainCallsQuerySchema>;

const ChainSignerEntrySchema = z
  .object({
    signer: z.string(),
    tx_count: z.int().min(0),
    total_fee_tao: z.number().min(0),
    total_tip_tao: z.number().min(0),
    last_tx_block: z.int().nullable(),
  })
  .strict();

export const ChainSignersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    sort: z.enum(["tx_count", "total_fee_tao"]),
    observed_at: z.string().nullable().optional(),
    signer_count: z.int().min(0),
    signers: z.array(ChainSignerEntrySchema),
  })
  .passthrough();
export type ChainSignersArtifact = z.infer<typeof ChainSignersArtifactSchema>;
export const ChainSignersResponseSchema = successEnvelopeSchema(
  ChainSignersArtifactSchema,
);
export const ChainSignersQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    sort: z.enum(["tx_count", "total_fee_tao"]).optional(),
    limit: z.int().min(1).optional(),
    call_module: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainSignersQuery = z.infer<typeof ChainSignersQuerySchema>;

const ChainFeeDaySchema = z
  .object({
    day: z.string(),
    extrinsic_count: z.int().min(0),
    total_fee_tao: z.number().min(0),
    avg_fee_tao: z.number().min(0).nullable(),
    median_fee_tao: z.number().min(0).nullable(),
    total_tip_tao: z.number().min(0),
    avg_tip_tao: z.number().min(0).nullable(),
    median_tip_tao: z.number().min(0).nullable(),
  })
  .strict();

const ChainFeePayerSchema = z
  .object({
    signer: z.string(),
    total_fee_tao: z.number().min(0),
    total_tip_tao: z.number().min(0),
    extrinsic_count: z.int().min(0),
  })
  .strict();

export const ChainFeesArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int().min(0),
    daily: z.array(ChainFeeDaySchema),
    top_fee_payers: z.array(ChainFeePayerSchema),
  })
  .passthrough();
export type ChainFeesArtifact = z.infer<typeof ChainFeesArtifactSchema>;
export const ChainFeesResponseSchema = successEnvelopeSchema(
  ChainFeesArtifactSchema,
);
export const ChainFeesQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    limit: z.int().min(1).optional(),
    call_module: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainFeesQuery = z.infer<typeof ChainFeesQuerySchema>;
