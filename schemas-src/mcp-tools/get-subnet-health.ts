// MCP tool `get_subnet_health` (types-epic E batch 2, #8065). "Mirrors" the
// health domain conceptually but the REST route it names isn't one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { ListSubnetHealthInputSchema } from "./subnet-scoped-lists.ts";
import { HealthSubnetSummarySchema } from "../routes/health.ts";

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING (#9998).
 *
 * `netuid` alone meant an agent could not narrow a subnet's health rows by
 * kind, provider, status or classification, nor page them, while a REST caller
 * could. The per-subnet view is list_subnet_health with `netuid` moved from an
 * optional FILTER to the required SUBJECT.
 */
export const GetSubnetHealthInputSchema = ListSubnetHealthInputSchema.omit({
  netuid: true,
})
  .extend({ netuid: netuidSchema() })
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
    // Typed from the route's own HealthSubnetSummarySchema (#9797). This tool
    // advertises no `fields`, so it is not partial. Verified against
    // production 2026-08-07.
    summary: HealthSubnetSummarySchema,
    operational_observed_at: z.string().nullable().optional(),
    surfaces: z.array(GetSubnetHealthSurfaceSchema),
  })
  .passthrough();
export type GetSubnetHealthOutput = z.infer<typeof GetSubnetHealthOutputSchema>;
