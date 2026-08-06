// get_subnet_surface_history (#9612): one subnet's surface audit trail,
// mirroring GET /api/v1/subnets/{netuid}/surface-history.
import { z } from "zod";
import { SURFACE_HISTORY_LIMIT_MAX } from "../../src/route-limits.ts";

export const GetSubnetSurfaceHistoryInputSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    limit: z.int().min(1).max(SURFACE_HISTORY_LIMIT_MAX).optional(),
  })
  .strict();
export type GetSubnetSurfaceHistoryInput = z.infer<
  typeof GetSubnetSurfaceHistoryInputSchema
>;

export const GetSubnetSurfaceHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    limit: z.int().nullable(),
    change_count: z.int(),
    surface_count: z.int(),
    latest_change_at: z.string().nullable(),
    changes: z.array(
      z
        .object({
          surface_id: z.string().nullable(),
          action: z.string().nullable(),
          kind: z.string().nullable(),
          url: z.string().nullable(),
          name: z.string().nullable(),
          source_commit: z.string().nullable(),
          recorded_at: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type GetSubnetSurfaceHistoryOutput = z.infer<
  typeof GetSubnetSurfaceHistoryOutputSchema
>;
