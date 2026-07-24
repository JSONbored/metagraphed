// MCP tool `get_subnet_trajectory` (types-epic E batch 2, #8065). No
// "Mirrors" claim in its description and no covered REST route to reuse.
// Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetSubnetTrajectoryInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetTrajectoryInput = z.infer<
  typeof GetSubnetTrajectoryInputSchema
>;

export const GetSubnetTrajectoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    point_count: z.int(),
    points: z.array(OpenObjectSchema),
    deltas: OpenObjectSchema.optional(),
  })
  .passthrough();
export type GetSubnetTrajectoryOutput = z.infer<
  typeof GetSubnetTrajectoryOutputSchema
>;
