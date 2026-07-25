// MCP tool `get_subnet_detail` (types-epic E batch 2, #8065). Despite
// "Mirrors GET /api/v1/subnets/{netuid}" in its description, the handler
// reads the RAW /metagraph/subnets/{netuid}.json artifact and nests it under
// a `subnet` key (`{schema_version, generated_at, subnet: {...}, ...}`) --
// a different top-level wrapper shape than schemas-src/routes/subnet-detail.ts's
// SubnetDetailArtifactSchema (the REST route's own `data`, which is the
// subnet's fields directly, not nested under `subnet`). Not reusable;
// modeled fresh, shallow, from the hand-written literal it replaces (same
// look-but-don't-reuse finding as get-network-health.ts/get-economics.ts in
// the pilot batch).
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetSubnetDetailInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetDetailInput = z.infer<typeof GetSubnetDetailInputSchema>;

export const GetSubnetDetailOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    generated_at: z.string().nullable().optional(),
    subnet: OpenObjectSchema,
    candidate_surfaces: z.array(z.unknown()).optional(),
    candidates: z.array(z.unknown()).optional(),
    endpoints: z.array(z.unknown()).optional(),
    gaps: z.unknown().optional(),
    surfaces: z.array(z.unknown()).optional(),
    verified_surfaces: z.array(z.unknown()).optional(),
    economics: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetDetailOutput = z.infer<typeof GetSubnetDetailOutputSchema>;
