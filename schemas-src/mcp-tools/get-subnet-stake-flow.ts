// MCP tool `get_subnet_stake_flow` (types-epic E batch 3, #8066). Mirrors
// GET /api/v1/subnets/{netuid}/stake-flow, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
// Window/direction enums hardcoded from src/stake-flow.ts's
// STAKE_FLOW_WINDOWS/STAKE_FLOW_DIRECTIONS at the time of writing (mirrors
// the pilot batch's ECONOMICS_SORT_FIELDS precedent -- not cross-imported).
import { z } from "zod";
import { kindSchema, netuidSchema, windowSchema } from "./shared.ts";

const STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"] as const;
const STAKE_FLOW_DIRECTIONS = ["all", "in", "out"] as const;

export const GetSubnetStakeFlowInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(STAKE_FLOW_WINDOWS).optional(),
    direction: kindSchema(STAKE_FLOW_DIRECTIONS).optional(),
  })
  .strict();
export type GetSubnetStakeFlowInput = z.infer<
  typeof GetSubnetStakeFlowInputSchema
>;

export const GetSubnetStakeFlowOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    total_staked_tao: z.unknown(),
    total_unstaked_tao: z.unknown(),
    net_flow_tao: z.unknown(),
    stake_events: z.int(),
    unstake_events: z.int(),
  })
  .passthrough();
export type GetSubnetStakeFlowOutput = z.infer<
  typeof GetSubnetStakeFlowOutputSchema
>;
