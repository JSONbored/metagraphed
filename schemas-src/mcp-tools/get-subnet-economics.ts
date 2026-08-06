// MCP tool `get_subnet_economics` (types-epic E batch 2, #8065). No REST
// mirror named in its description; the handler calls loadSubnetEconomics()
// directly and returns its own compact shape, distinct from schemas-src's
// SubnetEconomicsSchema (schemas-src/shared.ts) or EconomicsArtifactSchema.
// Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

export const GetSubnetEconomicsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetEconomicsInput = z.infer<
  typeof GetSubnetEconomicsInputSchema
>;

export const GetSubnetEconomicsOutputSchema = z
  .object({
    netuid: netuidSchema(),
    source: z.string().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    summary: OpenObjectSchema.nullable().optional(),
    economics: OpenObjectSchema.nullable(),
  })
  .passthrough();
export type GetSubnetEconomicsOutput = z.infer<
  typeof GetSubnetEconomicsOutputSchema
>;
