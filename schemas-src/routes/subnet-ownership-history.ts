// GET /api/v1/subnets/{netuid}/ownership-history (types-epic B batch 2,
// #8056). Live chain_events-tier decode -- no static file. Modeled from
// src/subnet-ownership-history.ts's buildSubnetOwnershipHistory(),
// cross-checked against the hand-edited SubnetOwnershipHistoryArtifact/
// SubnetOwnershipChange components it replaces. No query params (verified:
// the DATA_API route reads only the netuid path segment).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

// objectItems-equivalent looseness: no field required at the item level,
// matching the hand-written original exactly.
const SubnetOwnershipChangeSchema = z
  .object({
    netuid: z.int().min(0).max(65535).nullable().optional(),
    old_coldkey: z.string().nullable().optional(),
    new_coldkey: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    observed_at: z.iso.datetime().nullable().optional(),
    // Which store established this transfer (#9312). "chain-event" records are
    // decoded from the SubnetOwnerChanged stream and carry the block that
    // emitted them; "owner-observation" records are inferred from two
    // consecutive owner captures, so `observed_at` is when the change was
    // NOTICED and `block_number` is null. A caller that cannot tell them apart
    // would read a capture lag as a transfer time.
    source: z.enum(["chain-event", "owner-observation"]).nullable().optional(),
  })
  .strict();

// Real finding (bucket b): the hand-written schema left event_pallet/
// event_method out of its required set even though
// buildSubnetOwnershipHistory() (src/subnet-ownership-history.ts) always
// sets both unconditionally -- both are module constants (EVENT_PALLET,
// OWNERSHIP_CHANGE_EVENT_METHOD), never input-dependent. Modeled here as
// required, matching real behavior.
export const SubnetOwnershipHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    event_pallet: z.string(),
    event_method: z.string(),
    count: z.int().min(0),
    ownership_changes: z.array(SubnetOwnershipChangeSchema),
    // How far the owner-observation source covers this subnet at all (#9312),
    // ISO-8601. Optional because the DATA_API tier does not read that source;
    // null when it was read and holds nothing for this netuid. It is what makes
    // "watched, never changed hands" distinguishable from "not watched since",
    // which an empty ownership_changes array on its own cannot say.
    observed_through: z.iso.datetime().nullable().optional(),
  })
  .passthrough();
export type SubnetOwnershipHistoryArtifact = z.infer<
  typeof SubnetOwnershipHistoryArtifactSchema
>;
export const SubnetOwnershipHistoryResponseSchema = successEnvelopeSchema(
  SubnetOwnershipHistoryArtifactSchema,
);
export const SubnetOwnershipHistoryQuerySchema = z.object({}).strict();
export type SubnetOwnershipHistoryQuery = z.infer<
  typeof SubnetOwnershipHistoryQuerySchema
>;
