// get_emission_pipeline_history (#9625): one subnet's pipeline decomposition
// over time, mirroring GET /api/v1/subnets/{netuid}/emission-pipeline/history.
import { z } from "zod";
import { PIPELINE_HISTORY_WINDOWS } from "../../src/route-limits.ts";

export const GetPipelineHistoryInputSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    window: z
      .enum(PIPELINE_HISTORY_WINDOWS as [string, ...string[]])
      .optional(),
  })
  .strict();
export type GetPipelineHistoryInput = z.infer<
  typeof GetPipelineHistoryInputSchema
>;

export const GetPipelineHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    point_count: z.int().nullable(),
    distinct_observations: z.int().nullable(),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    first_captured_day: z.string(),
    points: z.array(
      z
        .object({
          day: z.string(),
          pipeline_block: z.int(),
          pipeline_block_hash: z.string().nullable(),
          repeats_previous_observation: z.boolean(),
          captured_at: z.string().nullable(),
          emission_share: z.number().nullable(),
          alpha_price_tao: z.number().nullable(),
          tao_in_pool_tao: z.number().nullable(),
          tao_in_emission_tao: z.number().nullable(),
          excess_tao: z.number().nullable(),
          alpha_in_emission: z.number().nullable(),
          alpha_out_emission: z.number().nullable(),
          miner_burned_fraction: z.number().nullable(),
          emission_enabled: z.boolean().nullable(),
          first_emission_block: z.int().nullable(),
        })
        .passthrough(),
    ),
    // Present ONLY on a decline. An empty series is a MEASUREMENT -- a subnet
    // registered after the capture began returns one legitimately.
    degraded: z
      .object({ reason: z.enum(["unavailable"]) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetPipelineHistoryOutput = z.infer<
  typeof GetPipelineHistoryOutputSchema
>;
