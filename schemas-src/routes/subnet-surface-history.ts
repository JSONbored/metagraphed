// GET /api/v1/subnets/{netuid}/surface-history (#9612): one subnet's surface
// audit trail. Modeled from src/surface-history.ts's buildSurfaceHistory().
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { SURFACE_HISTORY_LIMIT_MAX } from "../../src/route-limits.ts";

export const SurfaceHistoryChangeSchema = z
  .object({
    /** Coalesced column -> overlay id, so it is present on every row including
     * the 8,831 written before the writer recorded the column. */
    surface_id: z.string().nullable(),
    /** A DELETE entry is the only evidence a surface ever existed. */
    action: z.enum(["insert", "update", "delete"]).nullable(),
    kind: z.string().nullable(),
    url: z.string().nullable(),
    name: z.string().nullable(),
    /** The registry commit that produced the change. */
    source_commit: z.string().nullable(),
    recorded_at: z.iso.datetime(),
  })
  .strict();

export const SubnetSurfaceHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    limit: z.int().min(1).nullable(),
    change_count: z.int().min(0),
    /** Distinct surfaces with a recorded mutation -- NOT the subnet's current
     * surface count. A deleted surface is counted here and absent there. */
    surface_count: z.int().min(0),
    latest_change_at: z.iso.datetime().nullable(),
    changes: z.array(SurfaceHistoryChangeSchema),
  })
  .passthrough();
export type SubnetSurfaceHistoryArtifact = z.infer<
  typeof SubnetSurfaceHistoryArtifactSchema
>;
export const SubnetSurfaceHistoryResponseSchema = successEnvelopeSchema(
  SubnetSurfaceHistoryArtifactSchema,
);
export const SubnetSurfaceHistoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SURFACE_HISTORY_LIMIT_MAX)
      .optional(),
  })
  .strict();
