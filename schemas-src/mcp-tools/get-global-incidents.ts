// MCP tool `get_global_incidents` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/incidents, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, shallow,
// from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema, OpenObjectSchema } from "./shared.ts";

// Symbolic in the hand-written original (src/contracts.ts's
// API_QUERY_COLLECTIONS.incidents.sort_fields), cross-checked against the
// actual runtime array at the time of writing.
const GLOBAL_INCIDENTS_SORT_FIELDS = [
  "downtime_ms",
  "incident_count",
  "netuid",
  "surface_id",
] as const;

export const GetGlobalIncidentsInputSchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    netuid: z.int().min(0).optional(),
    sort: z.enum(GLOBAL_INCIDENTS_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type GetGlobalIncidentsInput = z.infer<
  typeof GetGlobalIncidentsInputSchema
>;

export const GetGlobalIncidentsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    summary: OpenObjectSchema,
    // #8824: the incident-qualifying threshold, mirrors the REST route.
    // surfaces (OpenObjectArraySchema, shallow) already carries each
    // surface's transient_failure_count/transient_failed_samples through.
    min_incident_samples: z.int().optional(),
    surfaces: OpenObjectArraySchema,
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type GetGlobalIncidentsOutput = z.infer<
  typeof GetGlobalIncidentsOutputSchema
>;
