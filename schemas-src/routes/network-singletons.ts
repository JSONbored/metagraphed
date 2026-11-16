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

export const EvmAssociationSchema = z
  .object({
    ss58: z
      .string()
      .nullable()
      .describe(
        "The owning hotkey the engine resolved for this (netuid, uid) at capture time, ss58-encoded. Null when the capture did not carry it.",
      ),
    netuid: z.int().min(0).describe("The subnet the association names."),
    uid: z.int().min(0).describe("The UID the EVM key is associated to."),
    associated_at: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block the association was made at (the u64 beside the H160 in SubtensorModule.AssociatedEvmAddress). Null when the capture did not carry it -- never fabricated as 0, which would claim an association at genesis.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured on-chain EVM key association (SubtensorModule.AssociatedEvmAddress; event EvmKeyAssociated): the (netuid, uid) it binds, the owning ss58 and the association block, with the capture stamp.",
  );

export const EvmAddressMappingArtifactSchema = z
  .object({
    schema_version: z.int(),
    h160: z.string(),
    ss58: z.string().nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #13165: which path answered `ss58`. "storage" when the engine's
    // SubtensorModule.AssociatedEvmAddress capture holds the key's owning
    // ss58; "precompile" otherwise -- including everywhere today, where no
    // association store is bound.
    source: z
      .enum(["storage", "precompile"])
      .describe(
        "Which path answered ss58: the stored on-chain association (SubtensorModule.AssociatedEvmAddress) or the live AddressMapping-precompile eth_call. Precompile everywhere until the engine's association capture lands.",
      ),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * association list is never a measured "never associated" -- it is what
     * an unbound or unfilled store looks like (the engine dependency #13165
     * defers), and publishing it as a count would be the confident-zero
     * failure the subnet surfaces' own comments are about.
     */
    association_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many stored associations this answer carries -- `associations.length`, store-capped. NULL when the store holds no rows for this key (store unbound, or the association capture has not run): a zero count is never a measurement and is not published.",
      ),
    associations: z
      .array(EvmAssociationSchema)
      .describe(
        "The key's captured on-chain associations, newest capture first and store-capped. Empty until the engine's AssociatedEvmAddress capture lands.",
      ),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .strict()
  .describe(
    "EVM (H160) -> Substrate (SS58) account-address mapping: the stored on-chain association (SubtensorModule.AssociatedEvmAddress) when the engine's capture holds it, else resolved live from chain via the AddressMapping precompile -- `source` says which. ss58 is null when neither path resolves (schema-stable, never a GraphQL error). Mirrors GET /api/v1/evm/address/{h160}.",
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
