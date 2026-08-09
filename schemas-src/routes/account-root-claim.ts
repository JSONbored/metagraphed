// GET /api/v1/accounts/{ss58}/root-claim (types-epic B batch 4, #8058). Live
// finney RPC (RootClaimType/StakingHotkeys/OwnedHotkeys/RootClaimable/
// RootClaimed/RootClaimableThreshold storage reads), 120s KV-cached -- no
// static file. Modeled from src/account-root-claim.ts's
// loadAccountRootClaim()/AccountRootClaimResult, cross-checked against the
// hand-edited AccountRootClaimArtifact component it replaces, and against
// real (mocked-RPC) loadAccountRootClaim() output -- see
// tests/account-root-claim.test.ts's "assembles claim_type + hotkey
// claimable entries from storage" case for the same fetch-mock pattern this
// batch's ground-truth test reuses.
//
// RootClaimType/RootClaimHotkey/RootClaimEntry are intentionally NOT
// registered as shared components -- AccountRootClaimArtifact is each one's
// only referrer anywhere in schemas/components/*.schema.json (verified via
// repo-wide $ref grep), so all three hand-edited component keys become
// fully orphaned.
//
// Bucket (c): `queried_at` drops format:date-time in favor of plain
// z.string().nullable(), matching this epic's established convention.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

const RootClaimTypeSchema = z
  .object({
    kind: z.enum(["Swap", "Keep", "KeepSubnets"]),
    subnets: z.array(z.int().min(0).max(65535)).optional(),
  })
  .strict()
  .describe(
    "Per-account RootClaimTypeEnum (#7229): Swap / Keep / KeepSubnets.",
  );

const RootClaimEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    claimable_rate: z.number(),
    claimed: z.string(),
    threshold: z.number(),
  })
  .strict()
  .describe(
    "One netuid's root-claim accounting for a (hotkey, account) pair (#7229).",
  );

const RootClaimHotkeySchema = z
  .object({
    hotkey: z.string(),
    entries: z.array(RootClaimEntrySchema),
  })
  .strict()
  .describe(
    "Root-claim rows for one staking/owned hotkey of the queried account (#7229).",
  );

export const AccountRootClaimArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    claim_type: RootClaimTypeSchema.nullable().optional(),
    hotkeys: z.array(RootClaimHotkeySchema).nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough()
  .describe(
    "Live root-claim current state for one Finney ss58 account (#7229), read directly from chain via RPC (KV-cached). claim_type/hotkeys are null on RPC failure (schema-stable, never a GraphQL error). Read-only; never submits claim_root. Mirrors GET /api/v1/accounts/{ss58}/root-claim.",
  );
export type AccountRootClaimArtifact = z.infer<
  typeof AccountRootClaimArtifactSchema
>;
export const AccountRootClaimResponseSchema = successEnvelopeSchema(
  AccountRootClaimArtifactSchema,
);
