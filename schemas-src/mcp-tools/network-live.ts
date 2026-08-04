// MCP tools `get_network_parameters`, `get_randomness_status` (types-epic E
// batch 8, #8071). Each mirrors a GET /api/v1/network/* route that is not
// one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Both take no input (bare `{}`) and every output field is
// required-but-independently-nullable (each queried live from a separate RPC
// call that can fail on its own) -- modeled fresh, matching each hand-written
// literal field-for-field.
import { z } from "zod";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetNetworkParametersInputSchema = z
  .object({
    // #8700: which chain to read. Absent means finney, so every existing
    // caller is unchanged. These routes answer from live storage whose keys
    // are chain-agnostic twox128 hashes — only the endpoint varies.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetNetworkParametersInput = z.infer<
  typeof GetNetworkParametersInputSchema
>;

export const GetNetworkParametersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    tao_weight: z.number().nullable(),
    stake_threshold_tao: z.number().nullable(),
    pending_childkey_cooldown_blocks: z.int().nullable(),
    // #8747: issuance-derived, never the stale `BlockEmission` storage item.
    total_issuance_tao: z.number().nullable(),
    block_emission_tao: z.number().nullable(),
    block_emission_halvings: z.int().nullable(),
    // #8742: raw vs effective — the exponent's storage item is unset, and
    // absent means the runtime default (3), never 0.
    emission_gate_bar: z.number().nullable(),
    emission_bar_quantile: z.number().nullable(),
    emission_gate_exponent: z.number().nullable(),
    emission_gate_exponent_effective: z.number().nullable(),
    queried_at: z.string().nullable(),
    // #9078 provenance, mirroring NetworkParametersArtifactSchema field for
    // field. It matters most to an MCP caller: an agent that cites
    // `emission_gate_exponent_effective: 3` as a chain reading is citing our
    // runtime default, and this map is the only thing that says so.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetNetworkParametersOutput = z.infer<
  typeof GetNetworkParametersOutputSchema
>;

export const GetRandomnessStatusInputSchema = z
  .object({
    // #8700: which chain to read. Absent means finney, so every existing
    // caller is unchanged. These routes answer from live storage whose keys
    // are chain-agnostic twox128 hashes — only the endpoint varies.
    network: McpNetworkSchema.optional(),
  })
  .strict();
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
    // #9078 provenance, mirroring RandomnessArtifactSchema field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetRandomnessStatusOutput = z.infer<
  typeof GetRandomnessStatusOutputSchema
>;
