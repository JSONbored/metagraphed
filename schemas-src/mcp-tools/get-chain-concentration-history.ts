// get_chain_concentration_history (#9628): the network-wide concentration
// series, mirroring GET /api/v1/chain/concentration/history.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { ChainConcentrationHistoryArtifactSchema } from "../routes/chain-concentration-history.ts";
import { CHAIN_CONCENTRATION_HISTORY_WINDOWS } from "../../src/route-limits.ts";

const RouteQuery_chain_concentration_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/concentration/history"];

export const GetChainConcentrationHistoryInputSchema = z
  .object({
    window: RouteQuery_chain_concentration_history.shape.window
      .describe(
        "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
      )
      .meta({ examples: [CHAIN_CONCENTRATION_HISTORY_WINDOWS[0]] }),
  })
  .strict();
export type GetChainConcentrationHistoryInput = z.infer<
  typeof GetChainConcentrationHistoryInputSchema
>;

// DERIVED, NOT COPIED (#9796). This copy modelled the point shape inline but
// left the five distributions inside each point as bare open objects, so the
// series was typed and its contents were not.
export const GetChainConcentrationHistoryOutputSchema =
  ChainConcentrationHistoryArtifactSchema;
export type GetChainConcentrationHistoryOutput = z.infer<
  typeof GetChainConcentrationHistoryOutputSchema
>;
