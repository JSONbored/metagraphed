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
  .strict()
  .describe(
    "One UTC day's network activity: block/extrinsic/event counts, the successful-extrinsic count and its success rate (null on a zero-extrinsic day), and the distinct signer count.",
  );

export const ChainActivityArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int().min(0),
    days: z.array(ChainActivityDaySchema),
  })
  .passthrough()
  .describe(
    "Per-UTC-day network activity series (blocks, extrinsics, events, signers) over the window, newest day first. Mirrors GET /api/v1/chain/activity's data envelope.",
  );
export type ChainActivityArtifact = z.infer<typeof ChainActivityArtifactSchema>;

const ChainCallEntrySchema = z
  .object({
    call_module: z.string(),
    call_function: z.string().nullable(),
    count: z.int().min(0),
    share: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .describe(
    "One row of the extrinsic call-mix breakdown -- a call_module (plus call_function when group_by=module_function), its extrinsic count over the window, and its share of the window total (null when the window has no extrinsics).",
  );

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
  .passthrough()
  .describe(
    "Extrinsic call-mix breakdown over the window. Mirrors GET /api/v1/chain/calls's data envelope.",
  );
export type ChainCallsArtifact = z.infer<typeof ChainCallsArtifactSchema>;

const ChainSignerEntrySchema = z
  .object({
    signer: z.string(),
    tx_count: z.int().min(0),
    total_fee_tao: z
      .number()
      .min(0)
      .describe(
        "Total fees paid across the window's extrinsics; null when the tier has no fee data.",
      ),
    total_tip_tao: z.number().min(0),
    last_tx_block: z.int().nullable(),
  })
  .strict()
  .describe(
    "One account's extrinsic-submission activity in the window, ranked by the requested sort.",
  );

export const ChainSignersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    sort: z
      .enum(["tx_count", "total_fee_tao"])
      .describe("The rank order actually applied: tx_count or total_fee_tao."),
    observed_at: z.string().nullable().optional(),
    signer_count: z.int().min(0),
    signers: z.array(ChainSignerEntrySchema),
  })
  .passthrough()
  .describe(
    "Network-wide weight-setter leaderboard over a lookback window, summed live from the account_events WeightsSet stream. The setter-level drill-in behind ChainWeights. Mirrors GET /api/v1/chain/weights/setters.",
  );
export type ChainSignersArtifact = z.infer<typeof ChainSignersArtifactSchema>;

const ChainFeeDaySchema = z
  .object({
    day: z.string(),
    extrinsic_count: z.int().min(0),
    signed_extrinsic_count: z.int().min(0),
    total_fee_tao: z.number().min(0),
    avg_fee_tao: z.number().min(0).nullable(),
    median_fee_tao: z.number().min(0).nullable(),
    total_tip_tao: z.number().min(0),
    avg_tip_tao: z.number().min(0).nullable(),
    median_tip_tao: z.number().min(0).nullable(),
  })
  .strict()
  .describe(
    "One UTC day's fee/tip aggregate: extrinsic count, total/avg/median fee and tip in TAO. avg/median are computed over signed extrinsics only and are null on a day with no signed extrinsics; extrinsic_count counts every extrinsic including unsigned inherents.",
  );

const ChainFeePayerSchema = z
  .object({
    signer: z.string(),
    total_fee_tao: z.number().min(0),
    total_tip_tao: z.number().min(0),
    extrinsic_count: z.int().min(0),
  })
  .strict()
  .describe(
    "One top fee-paying signer over the window, with its total fee/tip and extrinsic count.",
  );

export const ChainFeesArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int().min(0),
    daily: z.array(ChainFeeDaySchema),
    top_fee_payers: z.array(ChainFeePayerSchema),
  })
  .passthrough()
  .describe(
    "Per-UTC-day network fee/tip series plus the top fee payers over the window. Mirrors GET /api/v1/chain/fees's data envelope.",
  );
export type ChainFeesArtifact = z.infer<typeof ChainFeesArtifactSchema>;
