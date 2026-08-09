// MCP tool `get_deregistration_ranking`.
// Mirrors GET /api/v1/chain/deregistration-ranking.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796): the output schema IS the route's
// own ArtifactSchema, so a route field rename is a compile error here instead
// of silent production drift.
//
// NO ARGUMENTS, deliberately. The route takes none either -- the answer is one
// ordering over the whole network, and narrowing it to a subnet would produce
// the one shape this surface must not serve: a rank with no field to be a rank
// in. A caller wanting one subnet reads its entry out of `ranked`, where
// `ranked_count` is beside it.
import { z } from "zod";
import { SubnetDeregistrationRankingArtifactSchema } from "../routes/subnet-deregistration-ranking.ts";

export const GetDeregistrationRankingInputSchema = z.object({}).strict();
export type GetDeregistrationRankingInput = z.infer<
  typeof GetDeregistrationRankingInputSchema
>;

export const GetDeregistrationRankingOutputSchema =
  SubnetDeregistrationRankingArtifactSchema;
export type GetDeregistrationRankingOutput = z.infer<
  typeof GetDeregistrationRankingOutputSchema
>;
