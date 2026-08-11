// get_emission_pipeline_history (#9625): one subnet's pipeline decomposition
// over time, mirroring GET /api/v1/subnets/{netuid}/emission-pipeline/history.
import { z } from "zod";
import { PipelineHistoryArtifactSchema } from "../routes/emission-pipeline-history.ts";
import { netuidSchema } from "./shared.ts";
import {
  DEFAULT_PIPELINE_HISTORY_WINDOW,
  PIPELINE_HISTORY_WINDOWS,
} from "../../src/route-limits.ts";

export const GetPipelineHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: z
      .enum(PIPELINE_HISTORY_WINDOWS as [string, ...string[]])
      .optional()
      .describe(
        "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
      )
      // The route publishes which window an omitted one resolves to (#10060).
      .meta({
        default: DEFAULT_PIPELINE_HISTORY_WINDOW,
        examples: [DEFAULT_PIPELINE_HISTORY_WINDOW],
      }),
  })
  .strict();
export type GetPipelineHistoryInput = z.infer<
  typeof GetPipelineHistoryInputSchema
>;

// THE ROUTE'S OWN SCHEMA, not a restatement of it (#10790). The copy this
// replaces had drifted in three places -- `z.string()` where the route says
// `z.iso.datetime()`, `z.int()` twice where it says `z.int().min(0)` -- and
// re-typed the whole 15-field point shape inline beside the route's
// `PipelineHistoryPointSchema`. No delta survives, because this tool serves
// the route's payload unchanged.
export const GetPipelineHistoryOutputSchema = PipelineHistoryArtifactSchema;
export type GetPipelineHistoryOutput = z.infer<
  typeof GetPipelineHistoryOutputSchema
>;
