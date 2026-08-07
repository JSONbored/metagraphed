// MCP tool `compare_subnets`.
// Mirrors GET /api/v1/compare.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   compare_subnets: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { CompareArtifactSchema } from "../routes/compare.ts";

const COMPARE_DIMENSIONS = ["structure", "economics", "health"] as const;

export const CompareSubnetsInputSchema = z
  .object({
    netuids: z
      .array(z.int().min(0))
      .min(1)
      .max(128)
      .describe(
        "Subnet ids to include, as an array of integers. Omit for every subnet.",
      )
      .meta({ examples: [[64, 8, 1]] }),
    dimensions: z
      .array(z.enum(COMPARE_DIMENSIONS))
      .optional()
      .describe("Which breakdown dimensions to return, as an array of names.")
      .meta({ examples: [COMPARE_DIMENSIONS[0]] }),
  })
  .strict();
export type CompareSubnetsInput = z.infer<typeof CompareSubnetsInputSchema>;

export const CompareSubnetsOutputSchema = CompareArtifactSchema;
export type CompareSubnetsOutput = z.infer<typeof CompareSubnetsOutputSchema>;
