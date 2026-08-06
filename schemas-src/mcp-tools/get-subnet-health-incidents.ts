// MCP tool `get_subnet_health_incidents` (types-epic E batch 2, #8065).
// Mirrors GET /api/v1/subnets/{netuid}/health/incidents, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { netuidSchema, windowSchema } from "./shared.ts";

const HEALTH_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetHealthIncidentsInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(HEALTH_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetHealthIncidentsInput = z.infer<
  typeof GetSubnetHealthIncidentsInputSchema
>;

const GetSubnetHealthIncidentSchema = z
  .object({
    started_at: z.int().nullable().optional(),
    ended_at: z.int().nullable().optional(),
    duration_ms: z.int().nullable().optional(),
    failed_samples: z.int().optional(),
  })
  .passthrough();

const GetSubnetHealthIncidentsSurfaceSchema = z
  .object({
    surface_id: z.string().nullable().optional(),
    samples: z.int().optional(),
    uptime_ratio: z.number().nullable().optional(),
    incident_count: z.int().optional(),
    downtime_ms: z.int().optional(),
    // #8824: sub-MIN_INCIDENT_SAMPLES gap-islands excluded from incidents --
    // island count + their total failed probes -- mirrors the REST route.
    transient_failure_count: z.int().optional(),
    transient_failed_samples: z.int().optional(),
    incidents: z.array(GetSubnetHealthIncidentSchema).optional(),
  })
  .passthrough();

export const GetSubnetHealthIncidentsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    // #8824: the incident-qualifying threshold, mirrors the REST route.
    min_incident_samples: z.int().optional(),
    surfaces: z.array(GetSubnetHealthIncidentsSurfaceSchema),
  })
  .passthrough();
export type GetSubnetHealthIncidentsOutput = z.infer<
  typeof GetSubnetHealthIncidentsOutputSchema
>;
