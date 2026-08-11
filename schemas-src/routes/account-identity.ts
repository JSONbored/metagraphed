// GET /api/v1/accounts/{ss58}/identity + .../identity-history (types-epic B
// batch 4, #8058). Live account_identity(_history) D1-tier data -- no static
// file. Modeled from src/account-identity.ts's buildAccountIdentity() and
// src/account-identity-history.ts's buildAccountIdentityHistory()/
// formatAccountIdentityHistoryEntry(), cross-checked against the hand-edited
// AccountIdentityArtifact/AccountIdentityHistoryArtifact components they
// replace.
//
// Real finding (bucket a): both `discord` fields were initially modeled
// without a length bound; the hand-edited components declare maxLength:200.
// src/chain-identity-sanitize.ts's nativeContactHandle() -- the sanitizer
// sanitizeAccountIdentityFields() runs `discord` through -- discards any
// value over 200 chars (`if (!cleaned || cleaned.length > 200) return
// null;`), so a non-null discord is always <=200 chars in practice. Fixed
// to `.max(200)` on both, matching the hand-edited bound and the real
// sanitizer's own guarantee.
//
// AccountIdentityHistoryEntry is intentionally NOT registered as a shared
// component -- AccountIdentityHistoryArtifact is its only referrer anywhere
// in schemas/components/*.schema.json (verified via repo-wide $ref grep), so
// the hand-edited component key becomes fully orphaned.
import { z } from "zod";

export const AccountIdentityArtifactSchema = z
  .object({
    schema_version: z.int(),
    account: z.string(),
    has_identity: z.boolean(),
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    github: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    discord: z.string().max(200).nullable().optional(),
    description: z.string().nullable().optional(),
    additional: z.string().nullable().optional(),
    captured_at: z.string().nullable().optional(),
  })
  .strict();
export type AccountIdentityArtifact = z.infer<
  typeof AccountIdentityArtifactSchema
>;

const AccountIdentityHistoryEntrySchema = z
  .object({
    observed_at: z.string().nullable(),
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    github: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    discord: z.string().max(200).nullable().optional(),
    description: z.string().nullable().optional(),
    additional: z.string().nullable().optional(),
    // NULLABLE, and for the reason #8055 already wrote down on the subnet
    // sibling: `formatIdentityHistoryEntry` builds this as
    // `row.identity_hash ?? null` (src/account-identity-history.ts), so a row
    // with no computed hash yields null. `SubnetIdentityHistoryEntry` was
    // corrected then; this one was not, and nothing noticed because the key is
    // always PRESENT -- required and nullable are orthogonal, and only the
    // first was true. Found by generating the GraphQL type from this schema:
    // the generator promised non-null over a producer that can answer null,
    // which graphql-js turns into a nulled parent plus an error (#10214).
    identity_hash: z
      .string()
      .nullable()
      .describe(
        "Stable hash of this entry's tracked identity fields -- unchanged across entries where nothing actually differs. Null on a row with no computed hash.",
      ),
  })
  .strict()
  .describe(
    "One diff-tracked snapshot of an account's on-chain identity, taken when any tracked field changed since the previous entry.",
  );

export const AccountIdentityHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    account: z.string(),
    entry_count: z.int().min(0),
    limit: z.int().min(1).max(1000).nullable().optional(),
    offset: z.int().min(0).nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(AccountIdentityHistoryEntrySchema),
  })
  .strict();
export type AccountIdentityHistoryArtifact = z.infer<
  typeof AccountIdentityHistoryArtifactSchema
>;
