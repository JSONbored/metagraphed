// GET /api/v1/accounts/top-holders (types-epic B batch 4, #8058). Modeled on
// account_balances + nominator_positions/neurons tier data -- no static file.
// TWO TIERS SINCE #9469: `net_flow_7d/30d/90d` are recomputed daily from
// chain.account_events and are live; `free_tao`/`delegated_tao`/`total_tao`
// still come from the fixed 2026-08-02 materialization, because neither has a
// live source (src/top-holders-flow-tier.ts's header measures both gaps). Each
// tier answers only the sorts it can rank, so the three holdings columns are
// now NULLABLE -- a net_flow_*-ranked page carries rows the frozen snapshot
// has never seen, and zeroing them there would assert a balance nothing
// measured. Modeled from src/top-holders.ts's buildTopHoldersList(), cross-
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
