// GET /api/v1/adapters/{slug} (types-epic B batch 8, #8062). slug is a path
// param, not a query param -- no Query schema needed (mirrors the
// get_adapter MCP tool, types-epic E batch 11, #8074's get-adapter.ts).
// Modeled from the hand-edited AdapterArtifact component it replaces.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";

export const AdapterArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  subnet: z.string(),
  slug: z.string(),
  extensions: z.record(z.string(), z.object({}).passthrough()),
  snapshot: z.object({}).passthrough().nullable().optional(),
}).passthrough();
export type AdapterArtifact = z.infer<typeof AdapterArtifactSchema>;
export const AdapterResponseSchema = successEnvelopeSchema(
  AdapterArtifactSchema,
);
