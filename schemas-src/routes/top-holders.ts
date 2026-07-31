// GET /api/v1/accounts/top-holders (types-epic B batch 4, #8058). Live
// account_balances + nominator_positions/neurons D1-tier data -- no static
// file. Modeled from src/top-holders.ts's buildTopHoldersList(), cross-
// checked against the hand-edited TopHoldersArtifact component it replaces.
//
// Real finding (bucket b): the hand-edited `sort` enum only listed
// ["total_tao","free_tao","delegated_tao"] -- TOP_HOLDERS_SORTS also allows
// "net_flow_7d"/"net_flow_30d"/"net_flow_90d" (#6886/#6887's cross-subnet
// stake-flow leaderboard extension), so the hand-edited enum was stale;
// generated schema matches the real TOP_HOLDERS_SORTS constant.
//
// Bucket (c): captured_at/last_updated drop format:date-time in favor of
// plain z.string().nullable(), matching this epic's established convention.
//
// TopHoldersEntry is intentionally NOT registered as a shared component --
// TopHoldersArtifact is its only referrer anywhere in schemas/components/
// *.schema.json (verified via repo-wide $ref grep), so the hand-edited
// component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const TOP_HOLDERS_SORT_VALUES = [
  "total_tao",
  "free_tao",
  "delegated_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
] as const;

const TopHoldersEntrySchema = z
  .object({
    ss58: z.string(),
    free_tao: z
      .number()
      .min(0)
      .describe("Genuine free TAO from the System::Account chain-state scan."),
    delegated_tao: z
      .number()
      .min(0)
      .describe(
        "This account's delegated stake, valued in TAO. TAO-converted: each delegated position is multiplied by its own subnet's alpha_price_tao, taken from the latest daily subnet_snapshots row for that netuid, so cross-subnet alpha is never summed as if it were TAO (#8803). That table has a DAILY cadence, so the price can lag up to ~24h behind the live economics tier. A netuid whose latest snapshot carries no usable price is excluded from the sum rather than counted as zero.",
      ),
    total_tao: z
      .number()
      .min(0)
      .describe(
        "free_tao + delegated_tao. Both addends are TAO, so the sum is a real TAO quantity; it inherits delegated_tao's ~24h price staleness. Default sort.",
      ),
    net_flow_7d: z.number().nullable(),
    net_flow_30d: z.number().nullable(),
    net_flow_90d: z.number().nullable(),
    last_updated: z.string().nullable(),
  })
  .strict();

export const TopHoldersArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.enum(TOP_HOLDERS_SORT_VALUES),
    limit: z.int().min(1).max(100),
    captured_at: z.string().nullable().optional(),
    account_count: z.int().min(0),
    accounts: z.array(TopHoldersEntrySchema),
  })
  .passthrough();
export type TopHoldersArtifact = z.infer<typeof TopHoldersArtifactSchema>;
export const TopHoldersResponseSchema = successEnvelopeSchema(
  TopHoldersArtifactSchema,
);
export const TopHoldersQuerySchema = z
  .object({
    sort: z.enum(TOP_HOLDERS_SORT_VALUES).optional(),
    limit: z.int().min(1).max(100).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type TopHoldersQuery = z.infer<typeof TopHoldersQuerySchema>;
