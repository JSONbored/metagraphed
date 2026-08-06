// MCP tool `compare_subnets` (types-epic E batch 4, #8067). Mirrors GET
// /api/v1/compare, which is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse. Modeled fresh, shallow, from
// the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

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

export const CompareSubnetsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    requested_netuids: z.array(z.int()),
    dimensions: z.array(z.string()),
    subnets: OpenObjectArraySchema,
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();
export type CompareSubnetsOutput = z.infer<typeof CompareSubnetsOutputSchema>;
