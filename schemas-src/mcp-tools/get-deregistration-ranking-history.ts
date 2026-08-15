// get_deregistration_ranking_history (#10296): one subnet's trajectory toward
// or away from the pruning bar, mirroring GET
// /api/v1/subnets/{netuid}/deregistration-ranking/history.
import { z } from "zod";
import { DeregistrationHistoryArtifactSchema } from "../routes/subnet-deregistration-history.ts";
import { netuidSchema } from "./shared.ts";
import {
  DEFAULT_DEREGISTRATION_HISTORY_WINDOW,
  DEREGISTRATION_HISTORY_WINDOWS,
} from "../../src/route-limits.ts";

export const GetDeregistrationHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: z
      .enum(DEREGISTRATION_HISTORY_WINDOWS as [string, ...string[]])
      .optional()
      .describe(
        "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
      )
      // The route publishes which window an omitted one resolves to (#10060).
      .meta({
        default: DEFAULT_DEREGISTRATION_HISTORY_WINDOW,
        examples: [DEFAULT_DEREGISTRATION_HISTORY_WINDOW],
      }),
  })
  .strict();
export type GetDeregistrationHistoryInput = z.infer<
  typeof GetDeregistrationHistoryInputSchema
>;

// THE ROUTE'S OWN SCHEMA, not a restatement of it (#10790). This tool serves
// the route's payload unchanged, so no delta can survive here.
export const GetDeregistrationHistoryOutputSchema =
  DeregistrationHistoryArtifactSchema;
