// MCP tool `get_subnet_health_percentiles` (types-epic E batch 2, #8065).
// Mirrors GET /api/v1/subnets/{netuid}/health/percentiles, which is not one
// of schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";

const HEALTH_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetHealthPercentilesInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(HEALTH_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetHealthPercentilesInput = z.infer<
  typeof GetSubnetHealthPercentilesInputSchema
>;

const LatencyPercentilesSchema = z
  .object({
    p50: z.int().nullable().optional(),
    p95: z.int().nullable().optional(),
    p99: z.int().nullable().optional(),
    avg: z.int().nullable().optional(),
    min: z.int().nullable().optional(),
    max: z.int().nullable().optional(),
  })
  .passthrough();

const GetSubnetHealthPercentilesSurfaceSchema = z
  .object({
    surface_id: z.string().nullable().optional(),
    samples: z.int().optional(),
    latency_ms: LatencyPercentilesSchema.optional(),
  })
  .passthrough();

export const GetSubnetHealthPercentilesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    surfaces: z.array(GetSubnetHealthPercentilesSurfaceSchema),
  })
  .passthrough();
export type GetSubnetHealthPercentilesOutput = z.infer<
  typeof GetSubnetHealthPercentilesOutputSchema
>;
