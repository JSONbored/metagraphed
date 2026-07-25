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
import { successEnvelopeSchema } from "../envelope.ts";

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
  .strict();
export type SubnetIdentityHistoryEntry = z.infer<
  typeof SubnetIdentityHistoryEntrySchema
>;

export const SubnetIdentityHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    entry_count: z.int().min(0),
    limit: z.int().min(1).max(1000).nullable().optional(),
    offset: z.int().min(0).nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(SubnetIdentityHistoryEntrySchema),
  })
  .passthrough();
export type SubnetIdentityHistoryArtifact = z.infer<
  typeof SubnetIdentityHistoryArtifactSchema
>;
export const SubnetIdentityHistoryResponseSchema = successEnvelopeSchema(
  SubnetIdentityHistoryArtifactSchema,
);

export const SubnetIdentityHistoryQuerySchema = z
  .object({
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetIdentityHistoryQuery = z.infer<
  typeof SubnetIdentityHistoryQuerySchema
>;
