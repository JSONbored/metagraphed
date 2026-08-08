// GET /api/v1/curation, GET /api/v1/gaps (types-epic B batch 8, #8062).
// Both live-filtered/paginated baked-artifact list routes (mirror the
// list_curation/list_gaps MCP tools, types-epic E batch 11, #8074's
// curation-and-gaps.ts, which share this exact query-param shape --
// "mirrors GET /api/v1/curation"/"mirrors GET /api/v1/gaps" in their own
// hand-written descriptions confirm behavioral parity, unlike the MCP
// tools' own deliberately loose output items). Modeled from the
// hand-edited CurationArtifact/CurationEntry and GapsArtifact/GapsEntry
// components they replace.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import { COVERAGE_LEVEL_VALUES, CurationLevelSchema } from "../shared.ts";
import { CurationMetadataSchema, GapsSchema } from "./subnet-detail.ts";
import { ENDPOINT_INCIDENT_SEVERITY_VALUES } from "./endpoints-pools.ts";

const COVERAGE_LEVELS = COVERAGE_LEVEL_VALUES;
export const CoverageLevelSchema = z.enum(COVERAGE_LEVELS);

export const CURATION_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "name",
  "netuid",
] as const;

export const CurationEntrySchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string(),
    coverage_level: CoverageLevelSchema,
    curation_level: CurationLevelSchema.optional(),
    surface_count: z.int().min(0),
    candidate_count: z.int().min(0),
    gap_count: z.int().min(0).optional(),
    description: z.string().nullable().optional(),
    lifecycle: z.enum(["active", "deprecated", "parked", "pending"]).optional(),
    curation: CurationMetadataSchema,
    gaps: GapsSchema,
  })
  .strict();

export const CurationArtifactSchema = ArtifactBaseSchema.extend({
  curation: z.array(CurationEntrySchema),
}).passthrough();
export type CurationArtifact = z.infer<typeof CurationArtifactSchema>;
export const CurationResponseSchema = successEnvelopeSchema(
  CurationArtifactSchema,
);

export const GAPS_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "gap_count",
  "name",
  "netuid",
] as const;

export const GapsEntrySchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string(),
    coverage_level: CoverageLevelSchema,
    curation_level: CurationLevelSchema,
    // Optional for the same reason CurationEntrySchema's is: the route serves a
    // baked artifact, so an artifact published before #9710 has no such key and
    // a required field would reject a body that is otherwise exactly correct.
    gap_count: z.int().min(0).optional(),
    gaps: GapsSchema,
    gap_severity: z.enum(ENDPOINT_INCIDENT_SEVERITY_VALUES).optional(),
    gap_priority: z.int().min(0).optional(),
  })
  .strict();

export const GapsArtifactSchema = ArtifactBaseSchema.extend({
  gaps: z.array(GapsEntrySchema),
}).passthrough();
export type GapsArtifact = z.infer<typeof GapsArtifactSchema>;
export const GapsResponseSchema = successEnvelopeSchema(GapsArtifactSchema);
