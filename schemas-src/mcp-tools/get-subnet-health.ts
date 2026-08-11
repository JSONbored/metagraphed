// MCP tool `get_subnet_health` (types-epic E batch 2, #8065). "Mirrors" the
// health domain conceptually but the REST route it names isn't one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { McpUnsortedPageFields, netuidSchema } from "./shared.ts";
import { ListSubnetHealthInputSchema } from "./subnet-scoped-lists.ts";
import { HealthSubnetSummarySchema } from "../routes/health.ts";
import { LIVE_HEALTH_OVERLAY } from "../routes/subnet-detail.ts";

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
  .strict();

/**
 * The windowed reliability score, or null when nothing was probed (#10790).
 *
 * `computeReliability().subnet` (src/reliability.ts), served here since the
 * score landed and declared nowhere -- so the one field that says how
 * TRUSTWORTHY the status above is went out undescribed. Null is the honest
 * answer for a subnet with no samples: no probe data, no score, never a zero
 * that reads as "measured, and bad".
 */
const SubnetReliabilitySchema = z
  .object({
    score: z.number(),
    grade: z.string(),
    uptime_ratio: z.number().min(0).max(1),
    avg_latency_ms: z.number().nullable(),
    sample_count: z.int().min(0),
    latency_sample_count: z.int().min(0),
    window: z.string().nullable(),
    surface_count: z.int().min(0),
    day_count: z.int().min(0),
    computed_at: z.string().nullable(),
  })
  .strict()
  .nullable();

export const GetSubnetHealthOutputSchema = z
  .object({
    netuid: netuidSchema(),
    // Typed from the route's own HealthSubnetSummarySchema (#9797). This tool
    // advertises no `fields`, so it is not partial. Verified against
    // production 2026-08-07.
    summary: HealthSubnetSummarySchema,
    ...LIVE_HEALTH_OVERLAY,
    surfaces: z.array(GetSubnetHealthSurfaceSchema),
    reliability: SubnetReliabilitySchema.optional(),
    schema_version: z.int().optional(),
    // This tool pages its `surfaces`, and said so nowhere.
    ...McpUnsortedPageFields,
  })
  .strict();
export type GetSubnetHealthOutput = z.infer<typeof GetSubnetHealthOutputSchema>;
