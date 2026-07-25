// MCP tools `get_network_parameters`, `get_randomness_status` (types-epic E
// batch 8, #8071). Each mirrors a GET /api/v1/network/* route that is not
// one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Both take no input (bare `{}`) and every output field is
// required-but-independently-nullable (each queried live from a separate RPC
// call that can fail on its own) -- modeled fresh, matching each hand-written
// literal field-for-field.
import { z } from "zod";

export const GetNetworkParametersInputSchema = z.object({}).strict();
export type GetNetworkParametersInput = z.infer<
  typeof GetNetworkParametersInputSchema
>;

export const GetNetworkParametersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    tao_weight: z.number().nullable(),
    stake_threshold_tao: z.number().nullable(),
    pending_childkey_cooldown_blocks: z.int().nullable(),
    queried_at: z.string().nullable(),
  })
  .passthrough();
export type GetNetworkParametersOutput = z.infer<
  typeof GetNetworkParametersOutputSchema
>;

export const GetRandomnessStatusInputSchema = z.object({}).strict();
export type GetRandomnessStatusInput = z.infer<
  typeof GetRandomnessStatusInputSchema
>;

export const GetRandomnessStatusOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    last_stored_round: z.int().nullable(),
    oldest_stored_round: z.int().nullable(),
    stored_round_span: z.int().nullable(),
    queried_at: z.string().nullable(),
  })
  .passthrough();
export type GetRandomnessStatusOutput = z.infer<
  typeof GetRandomnessStatusOutputSchema
>;
