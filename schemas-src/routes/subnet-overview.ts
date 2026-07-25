// GET /api/v1/subnets/{netuid}/overview (types-epic B batch 1, #8055).
// Composed profile + health + curation + gaps + counts artifact: a STATIC
// per-subnet build artifact (/metagraph/overview/{netuid}.json, ArtifactBase
// wrapper -- unlike this batch's other 14 live-only routes), with `health`/
// `operational_observed_at`/`health_source` overlaid live at serve time by
// workers/api.ts's "subnet-overview" dispatch case calling
// src/health-serving.ts's overlayOverviewHealth(). Modeled from
// overlayOverviewHealth() + the static build side, cross-checked against
// the hand-edited SubnetOverviewArtifact component this replaces.
//
// Real finding (bucket b): overlayOverviewHealth() always sets
// operational_observed_at and health_source alongside health, but the
// hand-edited schema never declared either field (only reachable via its
// additionalProperties:true catch-all). Added explicitly here, matching
// real always-present behavior -- additionalProperties stays permissive
// (.passthrough()) so this is a pure completeness gain, not a tightening.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import { CurationMetadataSchema, GapsSchema } from "./subnet-detail.ts";
import { SubnetProfileSchema } from "./subnet-profile.ts";

const SubnetOverviewHealthSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    status: z.string().optional(),
    surface_count: z.int().min(0).optional(),
    ok_count: z.int().min(0).optional(),
    degraded_count: z.int().min(0).optional(),
    failed_count: z.int().min(0).optional(),
    unknown_count: z.int().min(0).optional(),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    avg_latency_ms: z.number().nullable().optional(),
    observed_by: z.string().optional(),
  })
  .passthrough();

export const SubnetOverviewArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  profile: SubnetProfileSchema.nullable(),
  health: SubnetOverviewHealthSchema.nullable(),
  operational_observed_at: z.string().nullable().optional(),
  health_source: z.string().nullable().optional(),
  curation: CurationMetadataSchema.nullable().optional(),
  gaps: GapsSchema.nullable().optional(),
  counts: z
    .object({
      surfaces: z.int().min(0),
      endpoints: z.int().min(0),
      candidates: z.int().min(0),
    })
    .passthrough(),
  gap_priorities: z.array(z.unknown()).optional(),
});
export type SubnetOverviewArtifact = z.infer<
  typeof SubnetOverviewArtifactSchema
>;
export const SubnetOverviewResponseSchema = successEnvelopeSchema(
  SubnetOverviewArtifactSchema,
);

// No query params (route()'s query-parameter array for subnet-overview is
// empty; netuid is a path segment).
export const SubnetOverviewQuerySchema = z.object({}).strict();
export type SubnetOverviewQuery = z.infer<typeof SubnetOverviewQuerySchema>;
