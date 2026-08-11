// MCP tool `get_account_history` (types-epic E batch 7, #8070). Mirrors
// GET /api/v1/accounts/{ss58}/history, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import { ss58Schema } from "./shared.ts";
import { AccountHistoryArtifactSchema } from "../routes/account-events-feed.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";

const RouteQuery_accounts_ss58_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/history"];

export const GetAccountHistoryInputSchema = z
  .object({
    ss58: ss58Schema(),
    netuid: RouteQuery_accounts_ss58_history.shape.netuid,
    // DAYS, not block heights. These carried the generic cross-tool sentence
    // ("a block height on chain tools, an ISO-8601 date on time-series ones")
    // and a block-height EXAMPLE, while this route reads a day-partitioned
    // table and takes YYYY-MM-DD only -- verified live, `?from=8700000` is a
    // 400 and `?from=2026-08-01` is a 200. An agent following the tool's own
    // example was rejected (#10115).
    from: RouteQuery_accounts_ss58_history.shape.from,
    to: RouteQuery_accounts_ss58_history.shape.to,
    limit: RouteQuery_accounts_ss58_history.shape.limit,
    offset: RouteQuery_accounts_ss58_history.shape.offset,
    cursor: RouteQuery_accounts_ss58_history.shape.cursor,
  })
  .strict();
export type GetAccountHistoryInput = z.infer<
  typeof GetAccountHistoryInputSchema
>;

// THE ROUTE'S OWN SCHEMA (#10790), and the collapse corrected a real error:
// `next_cursor` was declared here as an `int` on the evidence of a single
// `null` sample, while `loadAccountHistory` types it `string | null` and the
// route has always said so. A guess from one observation against the producer's
// own declaration -- the route wins, which is the whole reason to collapse
// toward it rather than away.
export const GetAccountHistoryOutputSchema = AccountHistoryArtifactSchema;
export type GetAccountHistoryOutput = z.infer<
  typeof GetAccountHistoryOutputSchema
>;
