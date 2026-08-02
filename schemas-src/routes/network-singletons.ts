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
import { FieldSourcesSchema } from "../shared.ts";

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
    // #9078. Required, not optional: it is attached outside the KV cache on
    // every read (src/network-parameters.ts), so there is no response shape
    // that legitimately lacks it. This route is why the map generalised --
    // `block_emission_tao` and `emission_gate_exponent_effective` are both
    // values we supply, and nothing else in the body says so.
    field_sources: FieldSourcesSchema,
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
    // #9078. `stored_round_span` is our subtraction of the two rounds above,
    // not a retention window the beacon publishes.
    field_sources: FieldSourcesSchema,
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
    // #9078. One field, one read -- published so that "all of it is measured"
    // is something the response states rather than something a caller has to
    // assume from the absence of a map.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type SudoKeyArtifact = z.infer<typeof SudoKeyArtifactSchema>;
export const SudoKeyResponseSchema = successEnvelopeSchema(
  SudoKeyArtifactSchema,
);
export const SudoKeyQuerySchema = z.object({}).strict();
export type SudoKeyQuery = z.infer<typeof SudoKeyQuerySchema>;
