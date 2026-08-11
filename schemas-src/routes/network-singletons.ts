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
import { FieldSourcesSchema } from "../shared.ts";

export const EvmAddressMappingArtifactSchema = z
  .object({
    schema_version: z.int(),
    h160: z.string(),
    ss58: z.string().nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .strict()
  .describe(
    "Live EVM (H160) -> Substrate (SS58) account-address mapping read from chain via RPC. ss58 is null when the mapping cannot be resolved (schema-stable, never a GraphQL error). Mirrors GET /api/v1/evm/address/{h160}.",
  );
export type EvmAddressMappingArtifact = z.infer<
  typeof EvmAddressMappingArtifactSchema
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
    // #10484: the owner's share of alpha emission, the same raw/effective pair
    // and for the same reason -- SubnetOwnerCut is ALSO unset on chain, so the
    // stored numerator is null and the effective share comes from the runtime
    // default 11796/65535. A single collapsed field would read 0 for "absent",
    // which claims subnet owners receive nothing, for every subnet at once.
    subnet_owner_cut: z.number().nullable().optional().meta({
      description:
        "SubnetOwnerCut as stored: the u16 numerator over 65535, or null when the storage item is unset (its current state on finney). NOT the share the runtime applies -- read subnet_owner_cut_effective for that.",
    }),
    subnet_owner_cut_effective: z.number().nullable().optional().meta({
      description:
        "The share the runtime actually applies: the stored numerator over 65535, or the runtime default 11796/65535 = 0.17999... when the item is unset. Never 0 from absence.",
    }),
    queried_at: z.string().nullable().optional(),
    // #9078. Required, not optional: it is attached outside the KV cache on
    // every read (src/network-parameters.ts), so there is no response shape
    // that legitimately lacks it. This route is why the map generalised --
    // `block_emission_tao` and `emission_gate_exponent_effective` are both
    // values we supply, and nothing else in the body says so.
    field_sources: FieldSourcesSchema,
  })
  .strict()
  .describe(
    "Live global Subtensor protocol/governance parameters, read live from chain via RPC. Each field is independently null on its own RPC failure (schema-stable). Mirrors GET /api/v1/network/parameters's data envelope.",
  );
export type NetworkParametersArtifact = z.infer<
  typeof NetworkParametersArtifactSchema
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
  .strict()
  .describe(
    "Live drand randomness-beacon status read from chain via RPC. Each field is independently null on its own RPC failure (schema-stable). Mirrors GET /api/v1/network/randomness's data envelope.",
  );
export type RandomnessArtifact = z.infer<typeof RandomnessArtifactSchema>;

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
  .strict()
  .describe(
    "The network's on-chain sudo (superuser) key, read live from chain via RPC. hotkey is null on RPC failure or a renounced sudo (schema-stable). Mirrors GET /api/v1/sudo/key's data envelope.",
  );
export type SudoKeyArtifact = z.infer<typeof SudoKeyArtifactSchema>;
