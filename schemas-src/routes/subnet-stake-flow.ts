// GET /api/v1/subnets/{netuid}/stake-flow (types-epic B batch 2, #8056).
// Live account_events-tier aggregate -- no static file. Modeled from
// src/stake-flow.ts's buildStakeFlow(), cross-checked against the
// hand-edited SubnetStakeFlowArtifact component it replaces.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_STAKE_FLOW_FLOW_DIRECTIONS_VALUES = [
  "all",
  "in",
  "out",
] as const;

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_STAKE_FLOW_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

export const SubnetStakeFlowArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(SUBNET_STAKE_FLOW_WINDOW_VALUES).nullable(),
    total_staked_tao: z.number(),
    total_unstaked_tao: z.number(),
    net_flow_tao: z.number(),
    stake_events: z.int().min(0),
    unstake_events: z.int().min(0),
  })
  .strict()
  .describe(
    "Per-subnet net stake flow (#7172) over a 7d/30d/90d window. Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/stake-flow' data envelope.",
  );
export type SubnetStakeFlowArtifact = z.infer<
  typeof SubnetStakeFlowArtifactSchema
>;
