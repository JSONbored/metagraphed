// get_indexer_lag (#9620): how long after a block is produced it becomes
// queryable here, mirroring GET /api/v1/chain/indexer-lag.
import { z } from "zod";

/** No inputs: the route measures one window and has nothing to filter. */
export const GetIndexerLagInputSchema = z.object({}).strict();
export type GetIndexerLagInput = z.infer<typeof GetIndexerLagInputSchema>;

export const GetIndexerLagOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    block_count: z.int().nullable(),
    window: z
      .object({
        oldest_block: z.int().nullable(),
        newest_block: z.int().nullable(),
        oldest_observed_at: z.string().nullable(),
        newest_observed_at: z.string().nullable(),
      })
      .passthrough()
      .nullable(),
    write_latency_ms: z
      .object({
        min: z.number().nullable(),
        p50: z.number().nullable(),
        p95: z.number().nullable(),
        p99: z.number().nullable(),
        max: z.number().nullable(),
        mean: z.number().nullable(),
      })
      .passthrough()
      .nullable(),
    head_age_ms: z.number().nullable(),
    measured_at: z.string(),
    // Present ONLY on a decline. A model seeing null measurements must read
    // this before concluding the lane is instantaneous.
    degraded: z
      .object({
        reason: z.enum(["no_retained_blocks", "unavailable"]),
        detail: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetIndexerLagOutput = z.infer<typeof GetIndexerLagOutputSchema>;
