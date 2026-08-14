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
import { ArtifactBaseSchema } from "../envelope.ts";
import { sectionsOf } from "../artifact-sections.ts";
import { OverlaidSubnetHealthSchema } from "./health.ts";
import {
  CurationMetadataSchema,
  GapsSchema,
  LIVE_HEALTH_OVERLAY,
} from "./subnet-detail.ts";
import { SubnetProfileSchema } from "./subnet-profile.ts";
import { SubnetComputeRequirementsSchema } from "../compute.ts";

// The overlaid health block has ONE declaration, in routes/health.ts next to
// the summary the overlay spreads. Re-listing it here dropped
// `latency_sample_count` and `name` -- both of which the overlay copies through
// and production serves -- so this route served two keys its own `.strict()`
// schema forbade, which the daily conformance sweep reported against
// `/data/health`.

export const SubnetOverviewArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  profile: SubnetProfileSchema.nullable(),
  health: OverlaidSubnetHealthSchema.nullable(),
  ...LIVE_HEALTH_OVERLAY,
  curation: CurationMetadataSchema.nullable().optional(),
  gaps: GapsSchema.nullable().optional(),
  counts: z
    .object({
      surfaces: z.int().min(0),
      endpoints: z.int().min(0),
      candidates: z.int().min(0),
    })
    .strict(),
  gap_priorities: z.array(z.unknown()).optional(),
  // #11097: the hardware floor, as a selectable section. Null when the
  // resolved source repo publishes no readable min_compute file -- which is
  // the answer for 90 of 129 subnets and must never render as "no GPU needed".
  compute_requirements: SubnetComputeRequirementsSchema.nullable().optional(),
});
export type SubnetOverviewArtifact = z.infer<
  typeof SubnetOverviewArtifactSchema
>;

/**
 * The overview's selectable sections (#11100), derived the same way the other
 * two composite subnet routes derive theirs (#10600). The identity scalars
 * (netuid/slug/name/status) ride the vocabulary by derivation -- selecting
 * them is harmless, and excluding them by hand would be a second list to
 * drift.
 */
export const SUBNET_OVERVIEW_SECTIONS = sectionsOf(
  SubnetOverviewArtifactSchema,
);
