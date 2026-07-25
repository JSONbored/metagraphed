// GET /api/v1/chain/stake-flow (types-epic B batch 6, #8060). Live
// account_events StakeAdded/StakeRemoved-stream data -- no static file.
// Modeled from src/chain-stake-flow.ts's buildChainStakeFlow(), cross-checked
// against the hand-edited ChainStakeFlowArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const NetFlowDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number(),
    min: z.number(),
    p25: z.number(),
    median: z.number(),
    p75: z.number(),
    p90: z.number(),
    max: z.number(),
  })
  .strict();

export const ChainStakeFlowArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        total_staked_tao: z.number().min(0),
        total_unstaked_tao: z.number().min(0),
        net_flow_tao: z.number(),
        gross_flow_tao: z.number().min(0),
        stake_events: z.int().min(0),
        unstake_events: z.int().min(0),
        gaining: z.int().min(0),
        losing: z.int().min(0),
        flat: z.int().min(0),
      })
      .strict(),
    net_flow_distribution: NetFlowDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          total_staked_tao: z.number().min(0),
          total_unstaked_tao: z.number().min(0),
          net_flow_tao: z.number(),
          gross_flow_tao: z.number().min(0),
          stake_events: z.int().min(0),
          unstake_events: z.int().min(0),
          direction: z.enum(["inflow", "outflow", "balanced"]),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainStakeFlowArtifact = z.infer<
  typeof ChainStakeFlowArtifactSchema
>;
export const ChainStakeFlowResponseSchema = successEnvelopeSchema(
  ChainStakeFlowArtifactSchema,
);
export const ChainStakeFlowQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    limit: z.int().min(1).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainStakeFlowQuery = z.infer<typeof ChainStakeFlowQuerySchema>;
