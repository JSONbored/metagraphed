// GET /api/v1/runtime (types-epic B batch 7, #8061). Live blocks D1-tier
// data -- no static file. Modeled from src/runtime-versions.ts's
// buildRuntimeVersionHistory(), cross-checked against the hand-edited
// RuntimeVersionsArtifact component it replaces.
//
// RuntimeVersionTransition is intentionally NOT registered as a shared
// component -- RuntimeVersionsArtifact is its only referrer (verified via
// repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const RuntimeVersionTransitionSchema = z
  .object({
    spec_version: z.int().min(0),
    block_number: z.int().min(0),
    observed_at: z.string().nullable(),
  })
  .strict();

export const RuntimeVersionsArtifactSchema = z
  .object({
    schema_version: z.int(),
    transitions: z.array(RuntimeVersionTransitionSchema),
    transition_count: z.int().min(0),
    current_spec_version: z.int().min(0).nullable(),
    coverage_from_block: z.int().min(0).nullable(),
    coverage_from_at: z.string().nullable(),
  })
  .passthrough();
export type RuntimeVersionsArtifact = z.infer<
  typeof RuntimeVersionsArtifactSchema
>;
export const RuntimeVersionsResponseSchema = successEnvelopeSchema(
  RuntimeVersionsArtifactSchema,
);
export const RuntimeVersionsQuerySchema = z.object({}).strict();
export type RuntimeVersionsQuery = z.infer<typeof RuntimeVersionsQuerySchema>;
