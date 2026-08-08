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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { limitSchema, projectableRows } from "./shared.ts";
import {
  EMISSION_PIPELINE_LIMIT_MAX,
  EMISSION_PIPELINE_MCP_LIMIT_DEFAULT,
} from "../../src/route-limits.ts";
import { EmissionPipelineArtifactSchema } from "../routes/emission-pipeline.ts";

const RouteQuery_chain_emission_pipeline =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/emission-pipeline"];

export const GetEmissionPipelineInputSchema = z
  .object({
    // Narrows the per-subnet rows only; the aggregate and the identity checks
    // stay network-wide, matching ?netuid= on the REST route.
    netuid: RouteQuery_chain_emission_pipeline.shape.netuid,
    // #9720. 129 subnets x 16 fields is ~56 KB, and `netuid` was the only
    // filter -- it narrows to ONE subnet or leaves all of them, with nothing in
    // between. NARROWING THE RESPONSE NEVER NARROWS THE MEASUREMENT: the
    // aggregate and the four identity checks are computed over every subnet
    // before any of this applies, so `verification` still covers the whole
    // distribution.
    sort: RouteQuery_chain_emission_pipeline.shape.sort,
    order: RouteQuery_chain_emission_pipeline.shape.order,
    fields: RouteQuery_chain_emission_pipeline.shape.fields,
    limit: limitSchema(
      EMISSION_PIPELINE_LIMIT_MAX,
      EMISSION_PIPELINE_MCP_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetEmissionPipelineInput = z.infer<
  typeof GetEmissionPipelineInputSchema
>;

export const GetEmissionPipelineOutputSchema =
  EmissionPipelineArtifactSchema.extend({
    subnets: projectableRows(EmissionPipelineArtifactSchema.shape.subnets),
  });
export type GetEmissionPipelineOutput = z.infer<
  typeof GetEmissionPipelineOutputSchema
>;
