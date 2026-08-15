// GET /api/v1/chain/identity-history (types-epic B batch 6, #8060). Live
// subnet_identity_history store-tier data -- no static file. Modeled from
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
  .strict()
  .describe(
    "One cross-subnet identity change in the network-wide feed (carries its netuid).",
  );

export const ChainIdentityHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    count: z.int().min(0),
    subnet_count: z.int().min(0),
    changes: z.array(ChainIdentityHistoryChangeSchema),
  })
  .strict();
/**
 * The same feed as a READ path must take it.
 *
 * Partial + catchall at BOTH levels -- envelope and change -- which is the
 * contract every lakehouse row schema already carries, and for the same two
 * reasons: a tier may answer with a subset of the columns, and a producer may
 * ship a field before this file learns about it. What stays pinned is the TYPE
 * of any declared key that IS present, which is the half that catches a defect.
 *
 * The strict schema above stays the RESPONSE contract, where an undeclared key
 * is real drift worth failing on. The composer cannot read through it: this
 * feed is assembled from three tiers, and rejecting a tier's whole answer over
 * one absent key would fall through to the empty artifact and publish "no
 * identity has ever changed" for most of the network -- turning a schema into
 * an availability risk (#11339).
 */
export const ChainIdentityHistoryReadSchema =
  ChainIdentityHistoryArtifactSchema.extend({
    changes: z.array(
      ChainIdentityHistoryChangeSchema.partial().catchall(z.unknown()),
    ),
  })
    .partial()
    .catchall(z.unknown());
export type ChainIdentityHistoryRead = z.infer<
  typeof ChainIdentityHistoryReadSchema
>;

export type ChainIdentityHistoryArtifact = z.infer<
  typeof ChainIdentityHistoryArtifactSchema
>;
