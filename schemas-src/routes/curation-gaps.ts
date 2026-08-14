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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { ArtifactBaseSchema } from "../envelope.ts";
import { COVERAGE_LEVEL_VALUES, CurationLevelSchema } from "../shared.ts";
import { CurationMetadataSchema, GapsSchema } from "./subnet-detail.ts";
import { ENDPOINT_INCIDENT_SEVERITY_VALUES } from "./endpoints-pools.ts";

const COVERAGE_LEVELS = COVERAGE_LEVEL_VALUES;
export const CoverageLevelSchema = z.enum(COVERAGE_LEVELS);

export const CURATION_SORT_FIELDS = API_QUERY_COLLECTIONS.curation.sort_fields;

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
})
  .strict()
  .describe(
    "Per-subnet curation state (coverage level, curation level, source counts). Mirrors GET /api/v1/curation (and MCP list_curation).",
  );
export type CurationArtifact = z.infer<typeof CurationArtifactSchema>;

export const GAPS_SORT_FIELDS = API_QUERY_COLLECTIONS.gaps.sort_fields;

/** #11146 phase 4: captured spec vs registered catalogue, per subnet. Present
 * only when the subnet has captured schema-index entries with stamped counts
 * -- absence means "not measured", never "in parity". Not exported: the only
 * consumer is GapsEntrySchema below, and an export nothing imports is what
 * the unreferenced-exports ratchet counts. */
const SchemaParitySchema = z
  .object({
    capture_cadence_hours: z.number().min(0).meta({
      description:
        "The capture lane's declared cadence in hours. Compare it against the backing entries' `snapshot.observed_at` (GET /api/v1/schemas) to judge whether this measurement rests on a current capture. No age is baked: this document is served for hours after it is built, so a build-stamped age would be wrong on arrival.",
    }),
    captured_schema_count: z.int().min(1).meta({
      description: "Captured machine-readable specs backing this measurement.",
    }),
    captured_path_count: z.int().min(0).meta({
      description:
        "Paths the subnet's captured spec(s) declare, summed across captured specs.",
    }),
    declared_non_get_count: z.int().min(0).nullable().meta({
      description:
        "Declared POST/PUT/PATCH/DELETE operations. NULL when the captured entries predate the capture-time stamp -- unmeasured, not zero.",
    }),
    registered_route_surface_count: z.int().min(0).meta({
      description:
        "Registered concrete route surfaces (subnet-api/sse/data-artifact; the openapi spec surface itself is not a route).",
    }),
    registered_non_get_count: z.int().min(0).meta({
      description:
        "Registered surfaces declaring a non-GET method (#11146 phase 3).",
    }),
    flagged: z.boolean().meta({
      description:
        "True when the subnet declares more paths than the catalogue registers as routes -- a caller reading only the registry cannot tell which routes are missing. Judge its currency from the entry's `observed_at` against the schema index's `capture_cadence_hours`.",
    }),
  })
  .strict();

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
    schema_parity: SchemaParitySchema.optional(),
  })
  .strict();

export const GapsArtifactSchema = ArtifactBaseSchema.extend({
  gaps: z.array(GapsEntrySchema),
})
  .strict()
  .describe(
    "Registry-wide interface gap report page. Mirrors GET /api/v1/gaps (and MCP list_gaps).",
  );
export type GapsArtifact = z.infer<typeof GapsArtifactSchema>;
