// GET /api/v1/blocks/summary (types-epic B batch 7, #8061). Live blocks
// D1-tier data -- no static file. Modeled from src/blocks-summary.ts's
// buildBlocksSummary(), cross-checked against the hand-edited
// BlocksSummaryArtifact component it replaces.
//
// BlockTimeDistribution is intentionally NOT registered as a shared
// component -- BlocksSummaryArtifact is its only referrer (verified via
// repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ConcentrationMetricsSchema } from "../shared.ts";

const BlockTimeDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean_ms: z.int(),
    min_ms: z.int(),
    max_ms: z.int(),
    p50_ms: z.int(),
    p90_ms: z.int(),
  })
  .strict()
  .nullable();

export const BlocksSummaryArtifactSchema = z
  .object({
    schema_version: z.int(),
    block_count: z.int().min(0),
    first_block: z.int().min(0).nullable(),
    last_block: z.int().min(0).nullable(),
    first_observed_at: z.string().nullable(),
    last_observed_at: z.string().nullable(),
    block_time: BlockTimeDistributionSchema,
    throughput: z
      .object({
        total_extrinsics: z.int().min(0),
        total_events: z.int().min(0),
        mean_extrinsics_per_block: z.number().min(0),
        mean_events_per_block: z.number().min(0),
        max_extrinsics_in_block: z.int().min(0),
      })
      .strict()
      .nullable(),
    distinct_authors: z.int().min(0),
    author_concentration: ConcentrationMetricsSchema.nullable(),
    distinct_spec_versions: z.int().min(0),
    latest_spec_version: z.int().min(0).nullable(),
  })
  .passthrough();
export type BlocksSummaryArtifact = z.infer<typeof BlocksSummaryArtifactSchema>;
export const BlocksSummaryResponseSchema = successEnvelopeSchema(
  BlocksSummaryArtifactSchema,
);
export const BlocksSummaryQuerySchema = z.object({}).strict();
export type BlocksSummaryQuery = z.infer<typeof BlocksSummaryQuerySchema>;
