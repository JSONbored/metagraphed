// get_chain_concentration_history (#9628): the network-wide concentration
// series, mirroring GET /api/v1/chain/concentration/history.
import { z } from "zod";
import { ChainConcentrationHistoryArtifactSchema } from "../routes/chain-concentration-history.ts";
import { CHAIN_CONCENTRATION_HISTORY_WINDOWS } from "../../src/route-limits.ts";

export const GetChainConcentrationHistoryInputSchema = z
  .object({
    window: z
      .enum(CHAIN_CONCENTRATION_HISTORY_WINDOWS as [string, ...string[]])
      .optional()
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
