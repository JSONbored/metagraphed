// MCP tool `get_account_stake_flow` (types-epic E batch 6, #8069). Mirrors
// GET /api/v1/accounts/{ss58}/stake-flow, backed by the SAME
// src/stake-flow.ts STAKE_FLOW_WINDOWS/STAKE_FLOW_DIRECTIONS constants the
// REST subnet-scoped stake-flow route (schemas-src/routes/
// subnet-stake-flow.ts, types-epic B batch 2 #8056) uses -- NOT reused as a
// schema import: that's a per-SUBNET artifact shape (SubnetStakeFlowArtifact,
// strict/flat), while this tool is per-ACCOUNT with a materially different
// shape (address-keyed, additionalProperties:true, a nested per-subnet
// breakdown array) -- the two were never the same contract. Modeled fresh,
// matching the hand-written literal it replaces field-for-field.
import { z } from "zod";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

// Symbolic in the hand-written original (src/stake-flow.ts's
// STAKE_FLOW_WINDOWS/STAKE_FLOW_DIRECTIONS), cross-checked against the
// actual runtime source at the time of writing.
const ACCOUNT_STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"] as const;
const ACCOUNT_STAKE_FLOW_DIRECTIONS = ["all", "in", "out"] as const;

export const GetAccountStakeFlowInputSchema = z
  .object({
    ss58: Ss58Schema,
    window: z.enum(ACCOUNT_STAKE_FLOW_WINDOWS).optional(),
    direction: z.enum(ACCOUNT_STAKE_FLOW_DIRECTIONS).optional(),
  })
  .strict();
export type GetAccountStakeFlowInput = z.infer<
  typeof GetAccountStakeFlowInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountStakeFlowSubnetSchema = z
  .object({
    netuid: z.int().optional(),
    staked_tao: z.unknown().optional(),
    unstaked_tao: z.unknown().optional(),
    net_flow_tao: z.unknown().optional(),
    gross_flow_tao: z.unknown().optional(),
    flow_ratio: z.number().nullable().optional(),
    direction: z.string().nullable().optional(),
    stake_events: z.int().optional(),
    unstake_events: z.int().optional(),
  })
  .passthrough();

export const GetAccountStakeFlowOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_staked_tao: z.unknown(),
    total_unstaked_tao: z.unknown(),
    net_flow_tao: z.unknown(),
    gross_flow_tao: z.unknown(),
    flow_ratio: z.number().nullable().optional(),
    direction: z.string().nullable(),
    stake_events: z.int(),
    unstake_events: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(AccountStakeFlowSubnetSchema),
  })
  .passthrough();
export type GetAccountStakeFlowOutput = z.infer<
  typeof GetAccountStakeFlowOutputSchema
>;
