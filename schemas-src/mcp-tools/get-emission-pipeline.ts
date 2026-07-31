// MCP tool `get_emission_pipeline` (#8744) — the v440 emission decomposition.
//
// Unlike get-economics-trends.ts, this one's REST counterpart IS covered by
// schemas-src/routes/, so the output schema reuses that route's own body
// (EMISSION_PIPELINE_BODY) rather than being modelled fresh — the same
// reuse-the-route-schema precedent get-subnet-stake-quote.ts set. The tool
// returns the projection alone, with none of ArtifactBase's envelope fields,
// which is why the route file exports the body separately.
//
// Strictness is inherited deliberately: the tool and the route describe the
// same bytes, so if a capture ever grew a field, both contracts would be wrong
// together and there is exactly one place to fix — which is the whole point of
// not keeping a second copy here.
import { z } from "zod";
import { EMISSION_PIPELINE_BODY } from "../routes/emission-pipeline.ts";

export const GetEmissionPipelineInputSchema = z
  .object({
    // Narrows the per-subnet rows only; the aggregate and the identity checks
    // stay network-wide, matching ?netuid= on the REST route.
    netuid: z.int().min(0).optional(),
  })
  .strict();
export type GetEmissionPipelineInput = z.infer<
  typeof GetEmissionPipelineInputSchema
>;

export const GetEmissionPipelineOutputSchema = z
  .object(EMISSION_PIPELINE_BODY)
  .strict();
export type GetEmissionPipelineOutput = z.infer<
  typeof GetEmissionPipelineOutputSchema
>;
