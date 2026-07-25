// GET /api/v1/subnets/{netuid}/prometheus (types-epic B batch 3, #8057). Live
// account_events PrometheusServed-stream data -- no static file. Modeled from
// src/subnet-prometheus.ts, cross-checked against the hand-edited
// SubnetPrometheusArtifact component it replaces, and against a live
// get_subnet_prometheus response for subnet 1 (a schema-stable zeroed card:
// window/observed_at null, every count 0, when the subnet has no
// PrometheusServed events in the window).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetPrometheusArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    distinct_exporters: z.int().min(0),
    announcements: z.int().min(0),
    announcements_per_exporter: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetPrometheusArtifact = z.infer<
  typeof SubnetPrometheusArtifactSchema
>;
export const SubnetPrometheusResponseSchema = successEnvelopeSchema(
  SubnetPrometheusArtifactSchema,
);
export const SubnetPrometheusQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
  })
  .strict();
export type SubnetPrometheusQuery = z.infer<typeof SubnetPrometheusQuerySchema>;
