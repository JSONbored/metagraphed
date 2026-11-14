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
import { FieldSourcesSchema } from "../shared.ts";
import { AccountEventSchema } from "./subnet-events.ts";

/**
 * The ≥v441 basket-claim era (#13163). Root Reborn retired the per-subnet
 * claim storage the legacy fields describe; on the live runtime, claims flow
 * through Basket* events this repo already ingests, and this block serves
 * that flow beside the legacy compatibility read. NULL is the decline (no
 * event store bound, a failed read, or a non-finney network); an EMPTY
 * `claims` from a bound store is a measurement over the stated coverage
 * window.
 */
export const RootClaimBasketClaimsSchema = z
  .object({
    claims: z
      .array(AccountEventSchema)
      .describe(
        "This account's newest BasketClaimed / BasketClaimDustSkipped events, newest first, at most 100 -- a claims card, not a second paged feed (/accounts/{ss58}/events remains the paged surface).",
      ),
    claim_count: z
      .int()
      .min(0)
      .describe(
        "`claims.length` -- the returned page, capped at 100, not a lifetime total.",
      ),
    covered_since: z
      .string()
      .nullable()
      .describe(
        "The event store's own coverage floor: claims before this instant are not visible to this card. Null when the floor could not be read.",
      ),
  })
  .strict()
  .describe(
    "The ≥v441 Root basket claim flow for this account, assembled from the ingested Basket* event stream (#13163). Basket STATE (shares, NAV, holdings) lives on /api/v1/chain/baskets and /api/v1/validators/{hotkey}/basket.",
  );

const RootClaimTypeSchema = z
  .object({
    kind: z.enum(["Swap", "Keep", "KeepSubnets"]),
    subnets: z.array(z.int().min(0).max(65535)).optional(),
  })
  .strict()
  .describe(
    "Legacy v440 per-account RootClaimTypeEnum: Swap / Keep / KeepSubnets. A runtime-default value is explicitly identified by compatibility.claim_type_source.",
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
    compatibility: z
      .object({
        status: z.enum(["legacy_supported", "unsupported", "unavailable"]),
        reason: z
          .enum([
            "root_reborn",
            "unverified_runtime",
            "rpc_or_decode_failure",
            "legacy_limit_exceeded",
          ])
          .nullable(),
        spec_name: z.string().nullable(),
        spec_version: z.int().min(0).nullable(),
        block_hash: z.string().nullable(),
        claim_type_source: z.enum(["storage", "runtime_default"]).nullable(),
      })
      .strict()
      .describe(
        "Runtime compatibility at one finalized block. Only the audited node-subtensor v440 adapter supports legacy reads; v441+ is unsupported. Other runtimes or failed reads are unavailable. Native basket entitlement is not represented here.",
      ),
    // #13163. Required: attached outside the KV cache on every read (same
    // mechanism as field_sources below), so no fresh response lacks it.
    basket_claims: RootClaimBasketClaimsSchema.nullable(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .strict()
  .describe(
    "Per-account Root-claim currency: the deprecated per-subnet compatibility read at one finalized block (only the audited node-subtensor v440 adapter returns legacy values; v441+ reports unsupported, other runtimes or failed reads unavailable; claim_type/hotkeys null unless supported) PLUS the ≥v441 basket-claim era block, assembled from the ingested Basket* event stream (#13163) -- claims now flow through BasketClaimed events, and basket state lives on /chain/baskets. Read-only; never submits claim_root. Mirrors GET /api/v1/accounts/{ss58}/root-claim.",
  );
export type AccountRootClaimArtifact = z.infer<
  typeof AccountRootClaimArtifactSchema
>;
