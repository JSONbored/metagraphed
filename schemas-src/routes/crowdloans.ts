// GET /api/v1/crowdloans + /api/v1/crowdloans/{crowdloan_id} (#8696).
// Live-RPC+KV-cache, no static file. Modeled from src/crowdloans.ts's
// loadCrowdloans()/loadCrowdloan()/decodeCrowdloan(). Neither route takes
// query params (both call validateEntityQuery(url, []), so any query string
// is a 400).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

// One decoded CrowdloanInfo record. Every field is set unconditionally by
// decodeCrowdloan() -- it returns null rather than a partial record -- so
// they are all required, except percent_raised, which is deliberately
// nullable: a cap of 0 is representable on-chain and would divide by zero.
const CrowdloanSchema = z
  .object({
    crowdloan_id: z.int().min(0).max(4294967295),
    creator: z.string(),
    deposit_tao: z.number(),
    min_contribution_tao: z.number(),
    end: z.int().min(0),
    cap_tao: z.number(),
    funds_account: z.string(),
    raised_tao: z.number(),
    // Option<AccountId32> on-chain: null when the crowdloan dispatches a call
    // instead of funding an address.
    target_address: z.string().nullable(),
    // Presence only. The Option<Bounded<Call>> payload needs the full runtime
    // type registry to decode, which a Worker does not carry -- see
    // src/crowdloans.ts's header.
    has_dispatch_call: z.boolean(),
    finalized: z.boolean(),
    contributors_count: z.int().min(0),
    percent_raised: z.number().nullable(),
  })
  .passthrough();

export const CrowdloansArtifactSchema = z
  .object({
    schema_version: z.int(),
    // Length of `crowdloans`, which can be LOWER than next_crowdloan_id:
    // `dissolve` removes a record while NextCrowdloanId keeps counting.
    crowdloan_count: z.int().min(0),
    // null only on an RPC failure reading NextCrowdloanId.
    next_crowdloan_id: z.int().min(0).nullable(),
    crowdloans: z.array(CrowdloanSchema),
    queried_at: z.iso.datetime().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type CrowdloansArtifact = z.infer<typeof CrowdloansArtifactSchema>;
export const CrowdloansResponseSchema = successEnvelopeSchema(
  CrowdloansArtifactSchema,
);
export const CrowdloansQuerySchema = z.object({}).strict();
export type CrowdloansQuery = z.infer<typeof CrowdloansQuerySchema>;

export const CrowdloanDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    crowdloan_id: z.int().min(0).max(4294967295),
    // null (not false) on RPC failure -- distinct from a confirmed-absent id
    // (false), matching SubnetLeaseArtifact's `leased` convention.
    exists: z.boolean().nullable(),
    crowdloan: CrowdloanSchema.nullable(),
    queried_at: z.iso.datetime().nullable().optional(),
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type CrowdloanDetailArtifact = z.infer<
  typeof CrowdloanDetailArtifactSchema
>;
export const CrowdloanDetailResponseSchema = successEnvelopeSchema(
  CrowdloanDetailArtifactSchema,
);
export const CrowdloanDetailQuerySchema = z.object({}).strict();
export type CrowdloanDetailQuery = z.infer<typeof CrowdloanDetailQuerySchema>;
