// GET /api/v1/subnets/{netuid}/lease + .../lease/history (types-epic B
// batch 2, #8056). Live-RPC+KV-cache (lease) / account_events-tier
// (lease/history) -- no static file. Modeled from src/subnet-lease.ts's
// loadSubnetLease()/decodeSubnetLease() and src/subnet-lease-history.ts's
// buildSubnetLeaseHistory(), cross-checked against the hand-edited
// SubnetLeaseArtifact/SubnetLease/SubnetLeaseHistoryArtifact/
// SubnetLeaseEvent components they replace. Neither route takes query
// params (verified: handleSubnetLease doesn't even accept a `url` argument;
// the lease/history DATA_API route reads only the netuid path segment).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

const SubnetLeaseSchema = z
  .object({
    lease_id: z.int().min(0),
    beneficiary: z.string(),
    coldkey: z.string(),
    hotkey: z.string(),
    emissions_share_percent: z.int().min(0).max(100).optional(),
    end_block: z.int().min(0).nullable().optional(),
    netuid: z.int().min(0).max(65535),
    cost_tao: z.number().optional(),
    accumulated_dividends_alpha: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetLeaseArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    leased: z.boolean().nullable(),
    lease: SubnetLeaseSchema.nullable().optional(),
    queried_at: z.iso.datetime().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type SubnetLeaseArtifact = z.infer<typeof SubnetLeaseArtifactSchema>;
export const SubnetLeaseResponseSchema = successEnvelopeSchema(
  SubnetLeaseArtifactSchema,
);
export const SubnetLeaseQuerySchema = z.object({}).strict();
export type SubnetLeaseQuery = z.infer<typeof SubnetLeaseQuerySchema>;

// objectItems-equivalent looseness: no field required at the item level,
// matching the hand-written original exactly.
const SubnetLeaseEventSchema = z
  .object({
    event_kind: z.string().optional(),
    beneficiary: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    observed_at: z.iso.datetime().nullable().optional(),
  })
  .strict();

// Real finding (bucket b): the hand-written schema left event_pallet/
// event_kinds out of its required set even though buildSubnetLeaseHistory()
// (src/subnet-lease-history.ts) always sets both unconditionally --
// EVENT_PALLET is a module constant and event_kinds is the fixed 2-element
// literal array, neither ever varies by input. Modeled here as required,
// matching real behavior.
export const SubnetLeaseHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    event_pallet: z.string(),
    event_kinds: z.array(z.string()),
    count: z.int().min(0),
    lease_events: z.array(SubnetLeaseEventSchema),
  })
  .passthrough();
export type SubnetLeaseHistoryArtifact = z.infer<
  typeof SubnetLeaseHistoryArtifactSchema
>;
export const SubnetLeaseHistoryResponseSchema = successEnvelopeSchema(
  SubnetLeaseHistoryArtifactSchema,
);
export const SubnetLeaseHistoryQuerySchema = z.object({}).strict();
export type SubnetLeaseHistoryQuery = z.infer<
  typeof SubnetLeaseHistoryQuerySchema
>;
