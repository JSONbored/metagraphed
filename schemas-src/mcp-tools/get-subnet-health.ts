// MCP tool `get_subnet_health` (types-epic E batch 2, #8065). "Mirrors" the
// health domain conceptually but the REST route it names isn't one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

export const GetSubnetHealthInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetHealthInput = z.infer<typeof GetSubnetHealthInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const GetSubnetHealthSurfaceSchema = z
  .object({
    surface_id: z.string().optional(),
    netuid: netuidSchema().optional(),
    kind: z.string().nullable().optional(),
    status: z.string().optional(),
    latency_ms: z.int().nullable().optional(),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
  })
  .passthrough();

export const GetSubnetHealthOutputSchema = z
  .object({
    netuid: netuidSchema(),
    summary: OpenObjectSchema,
    operational_observed_at: z.string().nullable().optional(),
    surfaces: z.array(GetSubnetHealthSurfaceSchema),
  })
  .passthrough();
export type GetSubnetHealthOutput = z.infer<typeof GetSubnetHealthOutputSchema>;
