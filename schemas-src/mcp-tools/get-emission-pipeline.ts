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
import {
  netuidSchema,
  fieldsSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import { EMISSION_PIPELINE_BODY } from "../routes/emission-pipeline.ts";
import { EMISSION_PIPELINE_SORT_FIELDS } from "../../src/emission-pipeline-surface.ts";
import {
  EMISSION_PIPELINE_LIMIT_MAX,
  EMISSION_PIPELINE_MCP_LIMIT_DEFAULT,
} from "../../src/route-limits.ts";

export const GetEmissionPipelineInputSchema = z
  .object({
    // Narrows the per-subnet rows only; the aggregate and the identity checks
    // stay network-wide, matching ?netuid= on the REST route.
    netuid: netuidSchema().optional(),
    // #9720. 129 subnets x 16 fields is ~56 KB, and `netuid` was the only
    // filter -- it narrows to ONE subnet or leaves all of them, with nothing in
    // between. NARROWING THE RESPONSE NEVER NARROWS THE MEASUREMENT: the
    // aggregate and the four identity checks are computed over every subnet
    // before any of this applies, so `verification` still covers the whole
    // distribution.
    sort: sortSchema(EMISSION_PIPELINE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(
      EMISSION_PIPELINE_LIMIT_MAX,
      EMISSION_PIPELINE_MCP_LIMIT_DEFAULT,
    ).optional(),
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
