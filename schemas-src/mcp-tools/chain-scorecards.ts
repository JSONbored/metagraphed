// MCP tools `get_chain_concentration`, `get_chain_performance`,
// `get_chain_idle_stake`, `get_chain_yield` (types-epic E batch 9, #8072).
// Each mirrors a GET /api/v1/chain/* route that is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. All four take no input (bare `{}`). Modeled fresh, matching each
// hand-written literal field-for-field -- including several bare nullable
// `{type:["object","null"]}` fields with no declared shape, which stay
// untyped open objects here too (not "improved" with a guessed shape).
import { z } from "zod";
import {
  OpenObjectSchema,
  netuidSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import {
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
} from "../../src/route-limits.ts";

// --- get_chain_concentration_subnets (#9717) ---------------------------------
// The cross-subnet RANKING, as opposed to get_chain_concentration's single
// network aggregate over the same read.

const CONCENTRATION_LENSES = [
  "emission",
  "stake",
  "entity_emission",
  "entity_stake",
  "validator_stake",
] as const;

const CONCENTRATION_RANKING_SORTS = [
  "nakamoto_coefficient",
  "gini",
  "holders",
  "top_1pct_share",
  "total",
  "netuid",
] as const;

export const GetChainConcentrationSubnetsInputSchema = z
  .object({
    lens: z
      .enum(CONCENTRATION_LENSES)
      .optional()
      .describe(
        "Which distribution to rank subnets by. `emission` (the default) is " +
          "the reward question — who actually receives emissions. `stake` is " +
          "who holds the alpha. The `entity_` variants collapse an operator's " +
          "hotkeys into one holder, so a Sybil running twenty UIDs counts once.",
      )
      .meta({ examples: ["emission"] }),
    sort: sortSchema(CONCENTRATION_RANKING_SORTS).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainConcentrationSubnetsInput = z.infer<
  typeof GetChainConcentrationSubnetsInputSchema
>;

export const GetChainConcentrationSubnetsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    lens: z.string(),
    sort: z.string(),
    order: z.string(),
    subnet_count: z.int(),
    measured_subnet_count: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    neuron_count: z.int().optional(),
    captured_at: z.string().nullable().optional(),
    network: OpenObjectSchema.nullable().optional(),
    subnets: z.array(OpenObjectSchema),
  })
  .passthrough();
export type GetChainConcentrationSubnetsOutput = z.infer<
  typeof GetChainConcentrationSubnetsOutputSchema
>;

export const GetChainConcentrationInputSchema = z.object({}).strict();
export type GetChainConcentrationInput = z.infer<
  typeof GetChainConcentrationInputSchema
>;

export const GetChainConcentrationOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    subnet_count: z.int(),
    neuron_count: z.int(),
    entity_count: z.int().optional(),
    uids_per_entity: z.number().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    stake: OpenObjectSchema.nullable().optional(),
    emission: OpenObjectSchema.nullable().optional(),
    entity_stake: OpenObjectSchema.nullable().optional(),
    entity_emission: OpenObjectSchema.nullable().optional(),
    validator_stake: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetChainConcentrationOutput = z.infer<
  typeof GetChainConcentrationOutputSchema
>;

export const GetChainPerformanceInputSchema = z.object({}).strict();
export type GetChainPerformanceInput = z.infer<
  typeof GetChainPerformanceInputSchema
>;

export const GetChainPerformanceOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    subnet_count: z.int(),
    neuron_count: z.int(),
    validator_count: z.int().optional(),
    active_count: z.int().optional(),
    captured_at: z.string().nullable().optional(),
    incentive: OpenObjectSchema.nullable().optional(),
    dividends: OpenObjectSchema.nullable().optional(),
    trust: OpenObjectSchema.nullable().optional(),
    consensus: OpenObjectSchema.nullable().optional(),
    validator_trust: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetChainPerformanceOutput = z.infer<
  typeof GetChainPerformanceOutputSchema
>;

export const GetChainIdleStakeInputSchema = z.object({}).strict();
export type GetChainIdleStakeInput = z.infer<
  typeof GetChainIdleStakeInputSchema
>;

const ChainIdleStakeSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    neuron_count: z.int(),
    idle_neuron_count: z.int(),
    idle_stake_alpha: z.number(),
  })
  .passthrough();

export const GetChainIdleStakeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    captured_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    total_idle_stake_alpha: z.number(),
    subnets: z.array(ChainIdleStakeSubnetSchema),
  })
  .passthrough();
export type GetChainIdleStakeOutput = z.infer<
  typeof GetChainIdleStakeOutputSchema
>;

export const GetChainYieldInputSchema = z.object({}).strict();
export type GetChainYieldInput = z.infer<typeof GetChainYieldInputSchema>;

export const GetChainYieldOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    subnet_count: z.int(),
    neuron_count: z.int(),
    validator_count: z.int().optional(),
    miner_count: z.int().optional(),
    captured_at: z.string().nullable().optional(),
    total_stake_tao: z.number().optional(),
    total_emission_tao: z.number().optional(),
    network_yield: z.number().nullable().optional(),
    validator_yield: z.number().nullable().optional(),
    miner_yield: z.number().nullable().optional(),
    distribution: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetChainYieldOutput = z.infer<typeof GetChainYieldOutputSchema>;
