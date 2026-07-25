// GET /api/v1/chain/identity-history (types-epic B batch 6, #8060). Live
// subnet_identity_history D1-tier data -- no static file. Modeled from
// src/chain-identity-history.ts's buildChainIdentityHistory() (which reuses
// src/subnet-identity-history.ts's formatIdentityHistoryEntry() -- the same
// sanitizer subnet-identity-history.ts's own per-subnet route already
// exercises), cross-checked against the hand-edited
// ChainIdentityHistoryArtifact component it replaces.
//
// Real finding (bucket a): `discord` was initially modeled without a length
// bound; formatIdentityHistoryEntry() runs it through the same
// nativeContactHandle() sanitizer as account-identity.ts's discord field
// (types-epic B batch 4's own finding for the identical situation) --
// non-null values are always <=200 chars. Fixed to `.max(200)`, matching the
// hand-edited bound.
//
// ChainIdentityHistoryChange is intentionally NOT registered as a shared
// component -- ChainIdentityHistoryArtifact is its only referrer (verified
// via repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainIdentityHistoryChangeSchema = z
  .object({
    netuid: z.int().min(0).nullable(),
    block_number: z.int().min(0).nullable().optional(),
    observed_at: z.string().nullable(),
    subnet_name: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    github_repo: z.url().nullable().optional(),
    subnet_url: z.url().nullable().optional(),
    discord: z.string().max(200).nullable().optional(),
    logo_url: z.url().nullable().optional(),
    identity_hash: z.string().nullable(),
  })
  .passthrough();

export const ChainIdentityHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    count: z.int().min(0),
    subnet_count: z.int().min(0),
    changes: z.array(ChainIdentityHistoryChangeSchema),
  })
  .passthrough();
export type ChainIdentityHistoryArtifact = z.infer<
  typeof ChainIdentityHistoryArtifactSchema
>;
export const ChainIdentityHistoryResponseSchema = successEnvelopeSchema(
  ChainIdentityHistoryArtifactSchema,
);
export const ChainIdentityHistoryQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
  })
  .strict();
export type ChainIdentityHistoryQuery = z.infer<
  typeof ChainIdentityHistoryQuerySchema
>;
