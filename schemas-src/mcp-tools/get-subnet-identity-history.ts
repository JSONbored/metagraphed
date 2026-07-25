// MCP tool `get_subnet_identity_history` (types-epic E batch 4, #8067).
// Mirrors GET /api/v1/subnets/{netuid}/identity-history, backed by the SAME
// src/subnet-identity-history.ts buildSubnetIdentityHistory()/
// formatIdentityHistoryEntry() the REST route (schemas-src/routes/
// subnet-identity-history.ts, #8055) uses -- NOT reused as a schema import:
// this tool's own required set (schema_version IS required here, unlike
// REST's envelope-relative posture) and additionalProperties posture
// differ enough that a blind reuse would change what this tool's own
// contract accepts. Modeled fresh instead, matching the hand-written
// literal it replaces field-for-field.
//
// Real finding (bucket b), same root cause #8055 already found and fixed
// on the REST side: the hand-written entry schema required identity_hash
// as a non-nullable string, but formatIdentityHistoryEntry() builds it as
// `record.identity_hash ?? null` -- a row with no computed hash yields
// identity_hash: null, which the old schema would have rejected. Modeled
// here as nullable (still required -- the key itself is always present),
// matching real behavior.
import { z } from "zod";

export const GetSubnetIdentityHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetSubnetIdentityHistoryInput = z.infer<
  typeof GetSubnetIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- except
// identity_hash, which the original also required (see header).
const SubnetIdentityHistoryEntrySchema = z
  .object({
    block_number: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_name: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    github_repo: z.string().nullable().optional(),
    subnet_url: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    logo_url: z.string().nullable().optional(),
    identity_hash: z.string().nullable(),
  })
  .passthrough();

export const GetSubnetIdentityHistoryOutputSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int(),
    entry_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(SubnetIdentityHistoryEntrySchema),
  })
  .passthrough();
export type GetSubnetIdentityHistoryOutput = z.infer<
  typeof GetSubnetIdentityHistoryOutputSchema
>;
