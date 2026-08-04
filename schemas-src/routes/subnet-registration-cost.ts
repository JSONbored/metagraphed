// GET /api/v1/subnets/{netuid}/{burn,recycled} (types-epic B batch 1,
// #8055). Two live-RPC + KV-cached single-value scorecards sharing one
// shape (schema_version/netuid + a nullable TAO amount + queried_at) -- no
// static file. Modeled from src/subnet-burn.ts's loadSubnetBurn() and
// src/subnet-recycled.ts's loadSubnetRecycled() (identical shape, a
// different chain storage item each), cross-checked against the
// SubnetBurnArtifact/SubnetRecycledArtifact components they replace.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

export const SubnetBurnArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    burn_tao: z.number().nullable().optional(),
    queried_at: z.iso.datetime().nullable().optional(),
    // #9104. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type SubnetBurnArtifact = z.infer<typeof SubnetBurnArtifactSchema>;
export const SubnetBurnResponseSchema = successEnvelopeSchema(
  SubnetBurnArtifactSchema,
);

export const SubnetRecycledArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    recycled_tao: z.number().nullable().optional(),
    queried_at: z.iso.datetime().nullable().optional(),
    // #9104. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type SubnetRecycledArtifact = z.infer<
  typeof SubnetRecycledArtifactSchema
>;
export const SubnetRecycledResponseSchema = successEnvelopeSchema(
  SubnetRecycledArtifactSchema,
);

// Neither route takes query params (netuid is a path segment; both handlers
// validate only isU16Netuid, no validateQueryParams call).
export const SubnetRegistrationCostQuerySchema = z.object({}).strict();
export type SubnetRegistrationCostQuery = z.infer<
  typeof SubnetRegistrationCostQuerySchema
>;

// GET /api/v1/chain/burn (#9399): every subnet's live registration cost in one
// response, ranked cheapest-first. Modeled from src/chain-burn.ts's loadChainBurn().
export const ChainBurnEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    // A subnet whose burn is a genuine 0 is INCLUDED, not dropped: netuid 76 reads a
    // real zero and it is the cheapest registration on the network, which is exactly
    // what a caller sorting this list is looking for.
    burn_tao: z.number().min(0),
  })
  .strict();

export const ChainBurnArtifactSchema = z
  .object({
    schema_version: z.int(),
    queried_at: z.iso.datetime().nullable(),
    // What the CHAIN reports exists (SubtensorModule.TotalNetworks), kept separate
    // from how many entries were actually read. A gap between the two is the signal
    // that a read was partial; collapsing them into one number would hide it.
    subnet_count: z.int().min(0).nullable(),
    read_count: z.int().min(0),
    cheapest_burn_tao: z.number().min(0).nullable(),
    dearest_burn_tao: z.number().min(0).nullable(),
    median_burn_tao: z.number().min(0).nullable(),
    subnets: z.array(ChainBurnEntrySchema),
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type ChainBurnArtifact = z.infer<typeof ChainBurnArtifactSchema>;
export const ChainBurnResponseSchema = successEnvelopeSchema(
  ChainBurnArtifactSchema,
);
