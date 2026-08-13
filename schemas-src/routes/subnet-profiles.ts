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
import { sectionsOf } from "../artifact-sections.ts";
import { SubnetProfileSchema } from "./subnet-profile.ts";
import {
  CandidateSurfaceSchema,
  EndpointResourceSchema,
  GapsSchema,
  LIVE_HEALTH_OVERLAY,
  SubnetDetailSchema,
  SurfaceSchema,
} from "./subnet-detail.ts";
import { SchemaDriftStatusSchema } from "../shared.ts";
import { SchemaDriftSummarySchema } from "../artifacts/schema-drift.ts";

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
  ...LIVE_HEALTH_OVERLAY,
  profile: SubnetProfileSchema,
  subnet: SubnetDetailSchema,
  surfaces: z.array(SurfaceSchema),
  endpoints: z.array(EndpointResourceSchema),
  candidate_surfaces: z.array(CandidateSurfaceSchema),
  gaps: GapsSchema,
});
export type SubnetProfileArtifact = z.infer<typeof SubnetProfileArtifactSchema>;

/**
 * What `?sections=` accepts on the profile route. Derived, and deliberately
 * NOT shared with the detail route: this document has `profile` and no
 * `economics`/`candidates`/`verified_surfaces`, so one common vocabulary would
 * let a caller ask here for a card that can never come back.
 */
export const SUBNET_PROFILE_SECTIONS = sectionsOf(SubnetProfileArtifactSchema);

/**
 * The captured OpenAPI snapshot's own metadata -- ONE declaration (#10790).
 *
 * `get_api_schema` returns exactly this object at its top level and declared
 * eight of its twenty-three fields, so everything that makes a snapshot
 * interpretable -- the hashes, the drift verdict, the counts, `auth_detail` --
 * was served undescribed. Exported rather than copied: a second declaration is
 * how the copy comes to omit the field that matters.
 */
export const SchemaSnapshotSchema = z
  .object({
    surface_id: z.string().nullable().optional(),
    surface_url: z.string().nullable().optional(),
    schema_url: z.string().nullable().optional(),
    netuid: z.int().min(0).nullable().optional(),
    subnet_name: z.string().nullable().optional(),
    subnet_slug: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
    openapi_version: z.string().nullable().optional(),
    path_count: z.int().min(0).optional(),
    component_schema_count: z.int().min(0).optional(),
    server_count: z.int().min(0).optional(),
    tag_count: z.int().min(0).optional(),
    auth_required: z.boolean().optional(),
    // An OBJECT, not a string -- 30 of 65 rows carry one and 29 are null,
    // so a single-row sample reads as "always null" (#9800). It describes
    // HOW the surface authenticates: which scheme, in which header, and the
    // shape of the value. `value_format` is a placeholder like `<api-key>`,
    // never a credential.
    auth_detail: z
      .object({
        scheme: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        value_format: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    auth_schemes: z.array(z.string()).optional(),
    hash: z.string().nullable().optional(),
    previous_hash: z.string().nullable().optional(),
    drift_status: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    contract_version: z.string().nullable().optional(),
    schema_version: z.int().optional(),
  })
  .strict();

const SchemaIndexEntrySchema = z
  .object({
    content_type: z.string().nullable().optional(),
    drift_status: SchemaDriftStatusSchema,
    error: z.string().nullable().optional(),
    hash: z.string().nullable().optional(),
    netuid: z.int().min(0).optional(),
    path: z.string().nullable().optional(),
    previous_hash: z.string().nullable().optional(),
    schema_url: z.url().nullable(),
    // #9800. Was `z.record(z.string(), z.unknown())` -- a record whose value
    // schema is `unknown`, which declares no more than a bare open object does.
    // This is the captured OpenAPI snapshot's own metadata: what was fetched,
    // when, from where, and whether it has drifted since. Verified field by
    // field against a live list_schemas response.
    snapshot: SchemaSnapshotSchema.optional(),
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
  summary: SchemaDriftSummarySchema.optional(),
  // The schema-snapshots cron's promotion provenance (SchemaIndexArtifact in
  // src/schema-snapshots-sync.ts: "with only summary/schemas replaced ... and
  // two provenance fields added"). The SERVED artifact carries them once the
  // cron has promoted; the committed baseline never does, hence optional.
  // Undeclared, they were a passthrough; #10853's .strict() 500'd the route
  // on every request for a day (#10897).
  promoted_at: z
    .string()
    .optional()
    .describe(
      "When the schema-snapshots cron promoted this index into the store. Absent on a build-baked baseline the cron has not promoted.",
    ),
  promoted_by: z
    .literal("worker-cron")
    .optional()
    .describe(
      "Which producer promoted this index. Absent on a build-baked baseline.",
    ),
});
export type SchemaIndexArtifact = z.infer<typeof SchemaIndexArtifactSchema>;
