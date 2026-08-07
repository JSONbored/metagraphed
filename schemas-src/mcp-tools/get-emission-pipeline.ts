// MCP tool `get_emission_pipeline`.
// Mirrors GET /api/v1/chain/emission-pipeline.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  netuidSchema,
  fieldsSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import { EMISSION_PIPELINE_SORT_FIELDS } from "../../src/emission-pipeline-surface.ts";
import {
  EMISSION_PIPELINE_LIMIT_MAX,
  EMISSION_PIPELINE_MCP_LIMIT_DEFAULT,
} from "../../src/route-limits.ts";
import { EmissionPipelineArtifactSchema } from "../routes/emission-pipeline.ts";

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

export const GetEmissionPipelineOutputSchema = EmissionPipelineArtifactSchema;
export type GetEmissionPipelineOutput = z.infer<
  typeof GetEmissionPipelineOutputSchema
>;
