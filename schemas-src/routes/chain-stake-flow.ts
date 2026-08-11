// GET /api/v1/chain/stake-flow (types-epic B batch 6, #8060). Live
// account_events StakeAdded/StakeRemoved-stream data -- no static file.
// Modeled from src/chain-stake-flow.ts's buildChainStakeFlow(), cross-checked
// against the hand-edited ChainStakeFlowArtifact component it replaces.
import { z } from "zod";

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
  .strict()
  .describe(
    "Spread of per-subnet net_flow_tao (can be negative) across EVERY subnet with stake events (not just the returned page).",
  );

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
      .strict()
      .describe(
        "Network rollup over every subnet that moved stake in the window.",
      ),
    net_flow_distribution: NetFlowDistributionSchema.nullable().describe(
      "Spread of per-subnet net_flow_tao across EVERY subnet with stake events; null when no subnet moved stake.",
    ),
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
          direction: z
            .enum(["inflow", "outflow", "balanced"])
            .describe("inflow | outflow | balanced"),
        })
        .strict()
        .describe(
          "One subnet's capital-flow scorecard in the window, ranked by net_flow_tao.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide cross-subnet capital-flow leaderboard over a lookback window, summed live from the account_events StakeAdded/StakeRemoved stream. Mirrors GET /api/v1/chain/stake-flow's data envelope.",
  );
export type ChainStakeFlowArtifact = z.infer<
  typeof ChainStakeFlowArtifactSchema
>;
