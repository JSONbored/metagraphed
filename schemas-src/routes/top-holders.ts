// GET /api/v1/accounts/top-holders (types-epic B batch 4, #8058). Modeled on
// account_balances + nominator_positions/neurons tier data -- no static file.
// TWO LEGS SINCE #9469, ON TWO CADENCES SINCE #9632: `net_flow_7d/30d/90d` are
// recomputed daily from chain.account_events; `free_tao`/`delegated_tao`/
// `total_tao` are composed from the store and republished every three hours.
// (Both were frozen 2026-08-02 materializations when this file was written --
// #9502 gave the holdings columns a live source and #9632 gave them their own
// producer, so the sentence that used to be here is gone rather than edited.)
// Each leg answers only the sorts it can rank, so the three holdings columns
// are NULLABLE -- a net_flow_*-ranked page carries rows the holdings leg has
// never seen, and zeroing them there would assert a balance nothing measured.
// Modeled from src/top-holders.ts's buildTopHoldersList(), cross-checked
// against the hand-edited TopHoldersArtifact component it replaces.
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

export const TOP_HOLDERS_SORT_VALUES = [
  "total_tao",
  "free_tao",
  "delegated_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
] as const;

/**
 * Which of those sorts the STORE-backed holdings leg answers (#9632).
 *
 * The two legs are published on different cadences now -- the flow ranking
 * daily from the lakehouse, these three every three hours from the store -- so
 * a page's `captured_at` depends on which leg backs the sort it was ranked by,
 * and src/top-holders.ts needs to know the split to answer that.
 *
 * Declared HERE, beside the enum it partitions, rather than imported from
 * src/top-holders-holdings.ts: that module reaches the Postgres read path, and
 * pulling it into the formatter would drag the driver into every build that
 * only wanted to shape a row. tests/top-holders-holdings-refresh.test.ts pins
 * this against the lane's own three constants, so the copy cannot drift.
 */
export const TOP_HOLDERS_HOLDINGS_SORT_VALUES = [
  "free_tao",
  "delegated_tao",
  "total_tao",
] as const;

const TopHoldersEntrySchema = z
  .object({
    ss58: z.string(),
    free_tao: z
      .number()
      .min(0)
      .nullable()
      .describe(
        "Genuine free TAO from the System::Account chain-state scan. NULL when the tier that answered has no balance source for this row -- a page ranked by net_flow_* is served from the live flow lane, which carries no holdings columns at all (#9469). Null is never a zero balance: 0 is a measured zero.",
      ),
    delegated_tao: z
      .number()
      .min(0)
      .nullable()
      .describe(
        "This account's delegated stake, valued in TAO. TAO-converted: each delegated position is multiplied by its own subnet's alpha_price_tao, taken from the latest daily subnet_snapshots row for that netuid, so cross-subnet alpha is never summed as if it were TAO (#8803). That table has a DAILY cadence, so the price can lag up to ~24h behind the live economics tier. A netuid whose latest snapshot carries no usable price is excluded from the sum rather than counted as zero. NULL on a net_flow_*-ranked page, which the live flow lane serves without holdings columns (#9469).",
      ),
    total_tao: z
      .number()
      .min(0)
      .nullable()
      .describe(
        "free_tao + delegated_tao. Both addends are TAO, so the sum is a real TAO quantity; it inherits delegated_tao's ~24h price staleness. Default sort. NULL whenever either addend is null, rather than summing the half that is known -- a partial total would understate the account silently (#9469).",
      ),
    net_flow_7d: z
      .number()
      .nullable()
      .describe(
        "Cross-subnet stake flow over the trailing 7 days: StakeAdded minus StakeRemoved from chain.account_events, recomputed daily (#9469). SIGNED -- a real net outflow is negative, not missing. Null means this row came from the frozen holdings artifact, which carries no flow figures; rows with a null sort key rank last.",
      ),
    net_flow_30d: z
      .number()
      .nullable()
      .describe("As net_flow_7d, over the trailing 30 days."),
    net_flow_90d: z
      .number()
      .nullable()
      .describe("As net_flow_7d, over the trailing 90 days."),
    last_updated: z
      .string()
      .nullable()
      .describe(
        "When THIS ROW's figures for the requested sort were measured. Which measurement that is depends on the sort, because the two halves of the leaderboard have different producers (#9632): free_tao/delegated_tao/total_tao are refreshed from the store every three hours and report the newest COMPLETE input pass behind them, while net_flow_7d/30d/90d are recomputed daily from the lakehouse and report that scan. Null when the answering tier carries no stamp for the row.",
      ),
  })
  .strict();

export const TopHoldersArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.enum(TOP_HOLDERS_SORT_VALUES),
    limit: z.int().min(1).max(100),
    captured_at: z
      .string()
      .nullable()
      .optional()
      .describe(
        "How old THIS RANKING is: the newest last_updated across the accounts served, for the leg that backs the requested sort. A holdings-sorted page therefore reports its store refresh and a net_flow_*-sorted page its daily lakehouse scan -- one number for both would have to be wrong about one of them (#9632). Null when no row carries a usable stamp, which includes the cold/empty leaderboard.",
      ),
    account_count: z.int().min(0),
    accounts: z.array(TopHoldersEntrySchema),
  })
  .strict();
export type TopHoldersArtifact = z.infer<typeof TopHoldersArtifactSchema>;
