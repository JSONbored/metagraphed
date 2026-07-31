// GET /api/v1/evm/address/{h160} + /api/v1/network/parameters +
// /api/v1/network/randomness + /api/v1/sudo/key (types-epic B batch 5,
// #8059). Live finney RPC, KV-cached at various TTLs -- no static file.
// Modeled from src/address-mapping.ts's loadAddressMapping(),
// src/network-parameters.ts's loadNetworkParameters(),
// src/randomness.ts's loadRandomnessStatus(), and src/sudo-key.ts's
// loadSudoKey(), cross-checked against the hand-edited
// EvmAddressMappingArtifact/NetworkParametersArtifact/RandomnessArtifact/
// SudoKeyArtifact components they replace.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const EvmAddressMappingArtifactSchema = z
  .object({
    schema_version: z.int(),
    h160: z.string(),
    ss58: z.string().nullable().optional(),
    queried_at: z.string().nullable().optional(),
  })
  .passthrough();
export type EvmAddressMappingArtifact = z.infer<
  typeof EvmAddressMappingArtifactSchema
>;
export const EvmAddressMappingResponseSchema = successEnvelopeSchema(
  EvmAddressMappingArtifactSchema,
);
export const EvmAddressMappingQuerySchema = z.object({}).strict();
export type EvmAddressMappingQuery = z.infer<
  typeof EvmAddressMappingQuerySchema
>;

export const NetworkParametersArtifactSchema = z
  .object({
    schema_version: z.int(),
    tao_weight: z.number().nullable().optional(),
    stake_threshold_tao: z.number().nullable().optional(),
    pending_childkey_cooldown_blocks: z.int().nullable().optional(),
    // #8747: derived from TotalIssuance every read, NOT the `BlockEmission`
    // storage item, which reads 1.0 TAO and has been stale since the network
    // passed its first halving. Every emission share is a share OF this, so
    // serving the storage item would make all of them wrong by 2x.
    total_issuance_tao: z.number().nullable().optional(),
    block_emission_tao: z.number().nullable().optional(),
    block_emission_halvings: z.int().nullable().optional(),
    // #8742: the spec-440 emission gate. `emission_gate_exponent` is the value
    // AS STORED and is currently null — the item is unset on chain, and absent
    // means "use the runtime default", not zero. h = 0 would make the Hill
    // gate 0.5 for every subnet, so the effective value is served beside the
    // raw one rather than collapsed into it.
    emission_gate_bar: z.number().nullable().optional(),
    emission_bar_quantile: z.number().nullable().optional(),
    emission_gate_exponent: z.number().nullable().optional(),
    emission_gate_exponent_effective: z.number().nullable().optional(),
    queried_at: z.string().nullable().optional(),
  })
  .passthrough();
export type NetworkParametersArtifact = z.infer<
  typeof NetworkParametersArtifactSchema
>;
export const NetworkParametersResponseSchema = successEnvelopeSchema(
  NetworkParametersArtifactSchema,
);
export const NetworkParametersQuerySchema = z.object({}).strict();
export type NetworkParametersQuery = z.infer<
  typeof NetworkParametersQuerySchema
>;

export const RandomnessArtifactSchema = z
  .object({
    schema_version: z.int(),
    last_stored_round: z.int().nullable().optional(),
    oldest_stored_round: z.int().nullable().optional(),
    stored_round_span: z.int().nullable().optional(),
    queried_at: z.string().nullable().optional(),
  })
  .passthrough();
export type RandomnessArtifact = z.infer<typeof RandomnessArtifactSchema>;
export const RandomnessResponseSchema = successEnvelopeSchema(
  RandomnessArtifactSchema,
);
export const RandomnessQuerySchema = z.object({}).strict();
export type RandomnessQuery = z.infer<typeof RandomnessQuerySchema>;

export const SudoKeyArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string().nullable().optional(),
    queried_at: z.string().nullable().optional(),
  })
  .passthrough();
export type SudoKeyArtifact = z.infer<typeof SudoKeyArtifactSchema>;
export const SudoKeyResponseSchema = successEnvelopeSchema(
  SudoKeyArtifactSchema,
);
export const SudoKeyQuerySchema = z.object({}).strict();
export type SudoKeyQuery = z.infer<typeof SudoKeyQuerySchema>;
