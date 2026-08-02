// GET /api/v1/accounts (types-epic B batch 4, #8058). Live neurons D1-tier
// data -- no static file. Modeled from src/accounts-list.ts's
// buildAccountsList(), cross-checked against the hand-edited
// AccountsListArtifact component it replaces.
//
// No fix needed on `sort`: the hand-edited component's enum
// ["total_stake","total_emission","subnet_count","uid_count",
// "validator_count","stake_dominance","last_active"] matches
// ACCOUNTS_LIST_SORTS exactly.
//
// Real finding (bucket a): AccountsListEntry's `stake_dominance` was
// initially modeled `.optional()`, but buildAccountsList() unconditionally
// runs every entry through applyStakeDominance() before returning -- every
// row always carries the key (a real 0..1 ratio, or null when the network
// total is 0) -- confirmed via src/accounts-list.ts's own call site. Fixed
// to required-but-nullable, matching the hand-edited component and reality.
//
// Real finding (bucket a): `subnets[]` was initially modeled without a
// length bound; buildAccountEntry() always slices to
// ACCOUNTS_LIST_SUBNET_LIMIT (10) before returning. Fixed to `.max(10)`,
// matching the hand-edited component's maxItems:10 and the real cap.
//
// AccountsListEntry/AccountsListSubnet are intentionally NOT registered as
// shared components -- AccountsListArtifact is each one's only referrer
// anywhere in schemas/components/*.schema.json (verified via repo-wide $ref
// grep), so both hand-edited component keys become fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const AccountsListSubnetSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    stake_tao: z.number().min(0),
    emission_tao: z.number().min(0),
  })
  .strict();

const AccountsListEntrySchema = z
  .object({
    hotkey: z.string(),
    coldkey: z.string().nullable(),
    coldkey_count: z.int().min(0),
    subnet_count: z.int().min(0),
    uid_count: z.int().min(0),
    validator_count: z.int().min(0),
    miner_count: z.int().min(0),
    total_stake_tao: z
      .number()
      .min(0)
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest alpha_price_tao (root at 1:1) before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Prices come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier.",
      ),
    total_emission_tao: z
      .number()
      .min(0)
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest alpha_price_tao (root at 1:1) before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Prices come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier.",
      ),
    stake_dominance: z.number().min(0).max(1).nullable(),
    latest_captured_at: z.string().nullable(),
    latest_block_number: z.int().nullable(),
    subnets: z.array(AccountsListSubnetSchema).max(10),
  })
  .strict();

export const AccountsListArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.enum([
      "total_stake",
      "total_emission",
      "subnet_count",
      "uid_count",
      "validator_count",
      "stake_dominance",
      "last_active",
    ]),
    limit: z.int().min(1).max(100),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    account_count: z.int().min(0),
    accounts: z.array(AccountsListEntrySchema),
  })
  .passthrough();
export type AccountsListArtifact = z.infer<typeof AccountsListArtifactSchema>;
export const AccountsListResponseSchema = successEnvelopeSchema(
  AccountsListArtifactSchema,
);
export const AccountsListQuerySchema = z
  .object({
    sort: z
      .enum([
        "total_stake",
        "total_emission",
        "subnet_count",
        "uid_count",
        "validator_count",
        "stake_dominance",
        "last_active",
      ])
      .optional(),
    limit: z.int().min(1).max(100).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type AccountsListQuery = z.infer<typeof AccountsListQuerySchema>;
