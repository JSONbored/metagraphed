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
import { ConcentrationMetricsSchema, DurationMillisSchema } from "../shared.ts";

const BlockTimeDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean_ms: DurationMillisSchema,
    min_ms: DurationMillisSchema,
    max_ms: DurationMillisSchema,
    p50_ms: DurationMillisSchema,
    p90_ms: DurationMillisSchema,
  })
  .strict()
  .describe(
    "Inter-block interval distribution in milliseconds, over genuinely consecutive in-window blocks.",
  )
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
      .describe(
        "Extrinsic/event throughput across the summarized block window.",
      )
      .nullable(),
    distinct_authors: z.int().min(0),
    author_concentration: ConcentrationMetricsSchema.nullable(),
    distinct_spec_versions: z.int().min(0),
    latest_spec_version: z.int().min(0).nullable(),
  })
  .strict()
  .describe(
    "Block-production summary (#5664) over the recent-block window. Every aggregate is null on a cold retired-D1 store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/summary.",
  );
export type BlocksSummaryArtifact = z.infer<typeof BlocksSummaryArtifactSchema>;
