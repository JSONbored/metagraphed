// MCP tool `get_blocks_summary` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/blocks/summary, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, shallow,
// from the hand-written literal it replaces.
import { z } from "zod";
import { BlocksSummaryArtifactSchema } from "../routes/blocks-summary.ts";

export const GetBlocksSummaryInputSchema = z.object({}).strict();
export type GetBlocksSummaryInput = z.infer<typeof GetBlocksSummaryInputSchema>;

// DERIVED, NOT COPIED (#9796). The copy published block_time, throughput and
// author_concentration as bare open objects.
export const GetBlocksSummaryOutputSchema = BlocksSummaryArtifactSchema;
export type GetBlocksSummaryOutput = z.infer<
  typeof GetBlocksSummaryOutputSchema
>;
