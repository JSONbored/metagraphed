// GET /api/v1/subnets/{netuid}/identity-history (types-epic B batch 1,
// #8055). Live subnet_identity_history-tier paginated timeline -- no static
// file. Modeled from src/subnet-identity-history.ts's
// formatIdentityHistoryEntry()/buildSubnetIdentityHistory(), cross-checked
// against the hand-edited SubnetIdentityHistoryEntry/
// SubnetIdentityHistoryArtifact components it replaces.
//
// Real finding (bucket b): the hand-edited SubnetIdentityHistoryEntry
// required identity_hash as a non-nullable string, but
// formatIdentityHistoryEntry() builds it as `record.identity_hash ?? null`
// -- a row with no computed hash yields identity_hash: null, which the old
// schema would have rejected. Modeled here as nullable (still required --
// the key itself is always present), matching real behavior.
import { z } from "zod";
import { subnetEntryListSchema } from "../shared.ts";

export const SubnetIdentityHistoryEntrySchema = z
  .object({
    block_number: z.int().min(0).nullable().optional(),
    observed_at: z.iso.datetime().nullable(),
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
    "One SubnetIdentitiesV3 snapshot recorded when a tracked identity field changed.",
  );
export type SubnetIdentityHistoryEntry = z.infer<
  typeof SubnetIdentityHistoryEntrySchema
>;

export const SubnetIdentityHistoryArtifactSchema = subnetEntryListSchema(
  SubnetIdentityHistoryEntrySchema,
).describe(
  "Append-only on-chain subnet identity timeline (#1647 / #5721). Empty entries on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/identity-history.",
);
export type SubnetIdentityHistoryArtifact = z.infer<
  typeof SubnetIdentityHistoryArtifactSchema
>;
