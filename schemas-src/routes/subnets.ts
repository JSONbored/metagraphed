// GET /api/v1/subnets (types-epic A pilot route #1 of 5, #7859) — list +
// pagination envelope variant.
//
// Data shape (SubnetsArtifact) derived by reading public/metagraph/
// openapi.json's SubnetsArtifact/SubnetIndexEntry components (built from
// src/contracts.ts) and cross-checked against the real handler response
// (handleRequest() dispatch through workers/api.ts, served via
// workers/responses.ts's envelopeResponse) — see tests/zod-schemas.test.ts.
// Query params from the same OpenAPI operation's `parameters` array (the
// route() call in src/contracts.ts for "subnets").
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import {
  BittensorNetworkSchema,
  CoverageLevelSchema,
  CurationLevelSchema,
  PartnershipMetadataSchema,
  SubnetStatusSchema,
  SubnetTypeSchema,
} from "../shared.ts";

const HttpUrlSchema = z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//);

export const SubnetIndexEntrySchema = z
  .object({
    block: z.int().min(0).optional(),
    candidate_count: z.int().min(0).optional(),
    categories: z.array(z.string()).optional(),
    contact: z.string().nullable().optional(),
    contact_present: z.boolean().optional(),
    coverage_level: CoverageLevelSchema,
    curation_level: CurationLevelSchema,
    dashboard_url: z.string().nullable().optional(),
    derived_categories: z.array(z.string()).optional(),
    derived_description: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    discord: z.string().max(200).nullable().optional(),
    discord_url: z.string().nullable().optional(),
    docs_url: z.string().nullable().optional(),
    first_party: z.boolean().optional(),
    gap_count: z.int().min(0).optional(),
    // Byte-count language breakdown from the GitHub /languages API (#6639) —
    // a genuinely open map (language name -> byte count), matching the
    // OpenAPI contract's own additionalProperties schema, not a shortcut.
    github_languages: z
      .record(z.string(), z.int().min(0))
      .nullable()
      .optional(),
    github_last_push_at: z.string().nullable().optional(),
    integration_readiness: z.int().min(0).max(100).optional(),
    lifecycle: z.enum(["active", "deprecated", "parked", "pending"]).optional(),
    logo_url: z.string().nullable().optional(),
    mechanism_count: z.int().min(0).optional(),
    name: z.string(),
    native_name: z.string().nullable().optional(),
    native_name_quality: z.enum(["chain", "placeholder", "empty"]).optional(),
    native_slug: z.string().nullable().optional(),
    netuid: z.int().min(0),
    official_surface_count: z.int().min(0).optional(),
    participant_count: z.int().min(0).optional(),
    partnership: z.union([PartnershipMetadataSchema, z.null()]).optional(),
    probed_surface_count: z.int().min(0).optional(),
    registered_at_block: z.int().min(0).optional(),
    registry_observed_count: z.int().min(0).optional(),
    slug: z.string(),
    social: z
      .object({
        reddit: HttpUrlSchema.optional(),
        telegram: HttpUrlSchema.optional(),
        x: HttpUrlSchema.optional(),
        youtube: HttpUrlSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    source_repo: z.string().nullable().optional(),
    status: SubnetStatusSchema,
    subnet_type: SubnetTypeSchema,
    surface_count: z.int().min(0),
    symbol: z.string().nullable().optional(),
    tempo: z.int().min(0).optional(),
    updated_at: z.string().nullable().optional(),
    website_url: z.string().nullable().optional(),
  })
  .strict();
export type SubnetIndexEntry = z.infer<typeof SubnetIndexEntrySchema>;

export const SubnetsArtifactSchema = ArtifactBaseSchema.extend({
  network: BittensorNetworkSchema,
  source: z
    .object({
      identity_storage: z.string().optional(),
      kind: z.string().optional(),
      method: z.string().optional(),
      package: z.string().optional(),
      rpc_family: z.string().optional(),
      version: z.string().optional(),
    })
    .passthrough(),
  subnets: z.array(SubnetIndexEntrySchema),
});
export type SubnetsArtifact = z.infer<typeof SubnetsArtifactSchema>;

export const SubnetsResponseSchema = successEnvelopeSchema(
  SubnetsArtifactSchema,
);

export const SubnetsQuerySchema = z
  .object({
    netuid: z.int().min(0).optional(),
    netuids: z
      .string()
      .max(767)
      .regex(/^\d{1,5}(,\d{1,5}){0,127}$/)
      .optional(),
    coverage_level: CoverageLevelSchema.optional(),
    curation_level: CurationLevelSchema.optional(),
    domain: z
      .enum([
        "agents",
        "compute",
        "data",
        "finance",
        "inference",
        "media",
        "prediction",
        "privacy",
        "robotics",
        "science",
        "search",
        "security",
        "storage",
        "training",
      ])
      .optional(),
    status: z.enum(["active", "inactive"]).optional(),
    subnet_type: SubnetTypeSchema.optional(),
    q: z.string().max(200).optional(),
    min_block: z.number().optional(),
    max_block: z.number().optional(),
    min_candidate_count: z.number().optional(),
    max_candidate_count: z.number().optional(),
    min_integration_readiness: z.number().optional(),
    max_integration_readiness: z.number().optional(),
    min_mechanism_count: z.number().optional(),
    max_mechanism_count: z.number().optional(),
    min_participant_count: z.number().optional(),
    max_participant_count: z.number().optional(),
    min_probed_surface_count: z.number().optional(),
    max_probed_surface_count: z.number().optional(),
    min_surface_count: z.number().optional(),
    max_surface_count: z.number().optional(),
    min_tempo: z.number().optional(),
    max_tempo: z.number().optional(),
    fields: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$/)
      .optional(),
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
    sort: z
      .enum([
        "block",
        "candidate_count",
        "coverage_level",
        "curation_level",
        "integration_readiness",
        "mechanism_count",
        "name",
        "netuid",
        "participant_count",
        "probed_surface_count",
        "status",
        "subnet_type",
        "surface_count",
        "tempo",
      ])
      .optional(),
    order: z.enum(["asc", "desc"]).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetsQuery = z.infer<typeof SubnetsQuerySchema>;
