// GET /api/v1/profiles, /api/v1/subnets/{netuid}/profile, /api/v1/schemas
// (types-epic B batch 10, #8064).
//
// SubnetProfileArtifact composes entirely from schemas already modeled by
// the pilot batch (schemas-src/routes/subnet-detail.ts): SubnetProfileSchema
// (schemas-src/routes/subnet-profile.ts), SubnetDetailSchema, SurfaceSchema,
// EndpointResourceSchema, CandidateSurfaceSchema, GapsSchema -- verified
// field-for-field equal to the hand-edited SubnetProfileArtifact's $refs.
// SubnetDetail (bare, hand-edited) had exactly one referrer -- this one
// component -- so it's safe to orphan alongside it (SubnetDetailSchema, the
// Zod equivalent, is already unregistered and reused as-is, same as
// SubnetDetailArtifactSchema already does internally).
//
// SchemaIndexEntry is referenced only by SchemaIndexArtifact (verified via
// repo-wide $ref grep) -- modeled locally, not registered.
//
// Bucket (b) finding: SchemaIndexArtifact's real producer
// (scripts/snapshot-openapi.ts) always sets top-level `summary`/`observed_at`,
// neither declared in the hand-edited schema -- see SchemaIndexArtifactSchema.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import { SubnetProfileSchema } from "./subnet-profile.ts";
import {
  CandidateSurfaceSchema,
  EndpointResourceSchema,
  GapsSchema,
  SubnetDetailSchema,
  SurfaceSchema,
} from "./subnet-detail.ts";

export const SubnetProfilesArtifactSchema = ArtifactBaseSchema.extend({
  profiles: z.array(SubnetProfileSchema),
  summary: z
    .object({
      profile_count: z.int().min(0),
      average_completeness_score: z.int().min(0).max(100),
      native_identity_count: z.int().min(0),
      identity_promotion_candidate_count: z.int().min(0),
      native_identity_unpromoted_count: z.int().min(0),
      by_profile_level: z.record(z.string(), z.int().min(0)),
      by_identity_level: z.record(z.string(), z.int().min(0)),
      by_confidence: z.record(z.string(), z.int().min(0)),
    })
    .strict(),
});
export type SubnetProfilesArtifact = z.infer<
  typeof SubnetProfilesArtifactSchema
>;

export const SubnetProfileArtifactSchema = ArtifactBaseSchema.extend({
  profile: SubnetProfileSchema,
  subnet: SubnetDetailSchema,
  surfaces: z.array(SurfaceSchema),
  endpoints: z.array(EndpointResourceSchema),
  candidate_surfaces: z.array(CandidateSurfaceSchema),
  gaps: GapsSchema,
});
export type SubnetProfileArtifact = z.infer<typeof SubnetProfileArtifactSchema>;

const SchemaIndexEntrySchema = z
  .object({
    content_type: z.string().nullable().optional(),
    drift_status: z.enum([
      "changed",
      "missing-after-previous-capture",
      "new",
      "not-captured",
      "unchanged",
    ]),
    error: z.string().nullable().optional(),
    hash: z.string().nullable().optional(),
    netuid: z.int().min(0).optional(),
    path: z.string().nullable().optional(),
    previous_hash: z.string().nullable().optional(),
    schema_url: z.url().nullable(),
    snapshot: z.record(z.string(), z.unknown()).optional(),
    status: z.enum([
      "captured",
      "error",
      "not-captured",
      "not-found",
      "too-large",
      "unsafe",
    ]),
    subnet_slug: z.string().optional(),
    surface_id: z.string(),
    url: z.url().optional(),
  })
  .strict();

export const SchemaIndexArtifactSchema = ArtifactBaseSchema.extend({
  schemas: z.array(SchemaIndexEntrySchema),
  source: z.string(),
  // Bucket (b): real producer (scripts/snapshot-openapi.ts) always sets
  // both -- the never-yet-captured placeholder builder omits them, hence
  // .optional() rather than required. Not in the hand-edited schema's named
  // properties, only legal today via additionalProperties:true.
  observed_at: z.string().optional(),
  summary: z
    .object({
      surface_count: z.int().min(0),
      schema_count: z.int().min(0),
      by_status: z.record(z.string(), z.int().min(0)),
      by_drift_status: z.record(z.string(), z.int().min(0)),
    })
    .strict()
    .optional(),
});
export type SchemaIndexArtifact = z.infer<typeof SchemaIndexArtifactSchema>;
