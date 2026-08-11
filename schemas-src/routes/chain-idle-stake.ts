// GET /api/v1/chain/idle-stake (types-epic B batch 6, #8060). Live neurons
// D1-tier data -- no static file. Modeled from src/subnet-idle-stake.ts's
// buildChainIdleStake(), cross-checked against the hand-edited
// ChainIdleStakeArtifact component it replaces.
import { z } from "zod";

export const ChainIdleStakeArtifactSchema = z
  .object({
    schema_version: z.int(),
    captured_at: z.string().nullable().optional(),
    subnet_count: z.int().min(0),
    total_idle_stake_alpha: z.number().min(0),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          neuron_count: z.int().min(0),
          idle_neuron_count: z.int().min(0),
          idle_stake_alpha: z.number().min(0),
        })
        .strict()
        .describe("One subnet's idle-stake scorecard in the network ranking."),
    ),
  })
  .strict()
  .describe(
    "Network-wide idle-stake rollup: every subnet's stake on currently-zero-dividends hotkeys, ranked by idle_stake_alpha. Mirrors GET /api/v1/chain/idle-stake's data envelope.",
  );
export type ChainIdleStakeArtifact = z.infer<
  typeof ChainIdleStakeArtifactSchema
>;
