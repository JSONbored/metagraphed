// GET /api/v1/subnets/{netuid}/emission-pipeline/history (#9625): one subnet's
// pipeline decomposition over time. Modeled from
// src/emission-pipeline-history.ts's buildPipelineHistory().
import { z } from "zod";
import { dailySubnetSeriesArtifact } from "./daily-subnet-series.ts";

export const PipelineHistoryPointSchema = z
  .object({
    day: z.string(),
    /** The chain state this point describes. Required -- a point that cannot
     * say which block it came from cannot be placed in a series. */
    pipeline_block: z
      .int()
      .min(0)
      .describe(
        "The chain state this point describes. A point that cannot say which block it came from is not served.",
      ),
    pipeline_block_hash: z.string().nullable(),
    /** True when the snapshot writer carried the previous capture forward
     * because a fresh one had not landed: this point is NOT an independent
     * sample, and reading it as flatness is a finding the data cannot support. */
    repeats_previous_observation: z
      .boolean()
      .describe(
        "True when the snapshot writer carried the previous capture forward: this point is NOT an independent sample.",
      ),
    captured_at: z.iso.datetime().nullable(),
    emission_share: z.number().nullable(),
    alpha_price_tao: z.number().nullable(),
    tao_in_pool_tao: z.number().nullable(),
    /** Pool liquidity injection. */
    tao_in_emission_tao: z
      .number()
      .nullable()
      .describe("Pool liquidity injection."),
    /** Chain buys. */
    excess_tao: z.number().nullable().describe("Chain buys."),
    alpha_in_emission: z.number().nullable(),
    alpha_out_emission: z.number().nullable(),
    miner_burned_fraction: z.number().nullable(),
    emission_enabled: z.boolean().nullable(),
    first_emission_block: z.int().min(0).nullable(),
  })
  .strict();

export const PipelineHistoryArtifactSchema = dailySubnetSeriesArtifact(
  PipelineHistoryPointSchema,
  {
    pointCount: "Rows returned. NOT the number of times the pipeline was read.",
    distinctObservations:
      "Independent samples -- the honest denominator for any claim about how a value moved.",
    firstCapturedDay:
      "The first day the pipeline columns were ever written, so a short series reads as a start rather than a gap.",
    degraded: "Present ONLY on a decline. An empty series is a measurement.",
  },
);
export type PipelineHistoryArtifact = z.infer<
  typeof PipelineHistoryArtifactSchema
>;
