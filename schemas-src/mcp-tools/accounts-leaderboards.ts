// MCP tools `list_accounts`, `get_top_holders` (types-epic E batch 7,
// #8070). Each mirrors a GET /api/v1/accounts* leaderboard route that is
// not one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, matching each hand-written literal
// field-for-field.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

// Symbolic in the hand-written originals (src/accounts-list.ts's
// ACCOUNTS_LIST_SORTS/*_LIMIT_*, src/top-holders.ts's TOP_HOLDERS_SORTS/
// *_LIMIT_*), cross-checked against the actual runtime source at the time
// of writing.
const ACCOUNTS_LIST_SORTS = [
  "total_stake",
  "total_emission",
  "subnet_count",
  "uid_count",
  "validator_count",
  "stake_dominance",
  "last_active",
] as const;
const TOP_HOLDERS_SORTS = ["total_tao", "free_tao", "delegated_tao"] as const;

export const ListAccountsInputSchema = z
  .object({
    sort: z.enum(ACCOUNTS_LIST_SORTS).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type ListAccountsInput = z.infer<typeof ListAccountsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountsListItemSchema = z
  .object({
    hotkey: z.string().optional(),
    coldkey: z.string().nullable().optional(),
    coldkey_count: z.int().optional(),
    subnet_count: z.int().optional(),
    uid_count: z.int().optional(),
    validator_count: z.int().optional(),
    miner_count: z.int().optional(),
    total_stake_tao: z.unknown().optional(),
    total_emission_tao: z.unknown().optional(),
    latest_captured_at: z.string().nullable().optional(),
    latest_block_number: z.int().nullable().optional(),
    subnets: OpenObjectArraySchema.optional(),
  })
  .passthrough();

export const ListAccountsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    sort: z.enum(ACCOUNTS_LIST_SORTS),
    limit: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    account_count: z.int(),
    accounts: z.array(AccountsListItemSchema),
  })
  .passthrough();
export type ListAccountsOutput = z.infer<typeof ListAccountsOutputSchema>;

export const GetTopHoldersInputSchema = z
  .object({
    sort: z.enum(TOP_HOLDERS_SORTS).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type GetTopHoldersInput = z.infer<typeof GetTopHoldersInputSchema>;

// objectItems(...) properties, none required at the item level.
const TopHolderItemSchema = z
  .object({
    ss58: z.string().optional(),
    free_tao: z
      .unknown()
      .optional()
      .describe("Genuine free TAO from the System::Account chain-state scan."),
    delegated_tao: z
      .unknown()
      .optional()
      .describe(
        "This account's delegated stake, valued in TAO. TAO-converted: each delegated position is multiplied by its own subnet's alpha_price_tao, taken from the latest daily subnet_snapshots row for that netuid, so cross-subnet alpha is never summed as if it were TAO (#8803). That table has a DAILY cadence, so the price can lag up to ~24h behind the live economics tier. A netuid whose latest snapshot carries no usable price is excluded from the sum rather than counted as zero.",
      ),
    total_tao: z
      .unknown()
      .optional()
      .describe(
        "free_tao + delegated_tao. Both addends are TAO, so the sum is a real TAO quantity; it inherits delegated_tao's ~24h price staleness. Default sort.",
      ),
    last_updated: z.string().nullable().optional(),
  })
  .passthrough();

export const GetTopHoldersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    sort: z.enum(TOP_HOLDERS_SORTS),
    limit: z.int(),
    captured_at: z.string().nullable().optional(),
    account_count: z.int(),
    accounts: z.array(TopHolderItemSchema),
  })
  .passthrough();
export type GetTopHoldersOutput = z.infer<typeof GetTopHoldersOutputSchema>;
