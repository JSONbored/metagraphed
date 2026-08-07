// MCP tools `list_providers`, `list_surfaces`, `list_candidates`.
// Mirror GET /api/v1/providers, GET /api/v1/surfaces, GET /api/v1/candidates.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   list_providers: 1 bare `{"type":"object"}` site.
//   list_surfaces: 1 bare `{"type":"object"}` site.
//   list_candidates: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";
import { CandidatesArtifactSchema } from "../routes/candidates-evidence.ts";
import { SurfacesArtifactSchema } from "../routes/endpoints-pools.ts";
import {
  PROVIDER_KIND_VALUES,
  ProvidersArtifactSchema,
} from "../routes/providers-rpc.ts";
import {
  AUTHORITY_VALUES,
  CANDIDATE_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";

// Symbolic in each hand-written original (src/contracts.ts's QUERY_ENUMS /
// API_QUERY_COLLECTIONS.*.sort_fields), cross-checked against the actual
// runtime source at the time of writing.
const PROVIDER_KINDS = PROVIDER_KIND_VALUES;
const PROVIDER_AUTHORITIES = AUTHORITY_VALUES;
const PROVIDER_SORT_FIELDS = ["authority", "id", "kind", "name"] as const;

export const ListProvidersInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    kind: kindSchema(PROVIDER_KINDS).optional(),
    authority: z
      .enum(PROVIDER_AUTHORITIES)
      .optional()
      .describe(
        "Who asserts this record: the operator, the community, a provider, or the registry's own probes.",
      )
      .meta({ examples: [PROVIDER_AUTHORITIES[0]] }),
    sort: sortSchema(PROVIDER_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProvidersInput = z.infer<typeof ListProvidersInputSchema>;

export const ListProvidersOutputSchema = ProvidersArtifactSchema.extend({
  providers: projectableRows(ProvidersArtifactSchema.shape.providers),
});
export type ListProvidersOutput = z.infer<typeof ListProvidersOutputSchema>;

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const SURFACE_SORT_FIELDS = [
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
] as const;

export const ListSurfacesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    sort: sortSchema(SURFACE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSurfacesInput = z.infer<typeof ListSurfacesInputSchema>;

export const ListSurfacesOutputSchema = SurfacesArtifactSchema.extend({
  surfaces: projectableRows(SurfacesArtifactSchema.shape.surfaces),
});
export type ListSurfacesOutput = z.infer<typeof ListSurfacesOutputSchema>;

const CANDIDATE_STATES = CANDIDATE_STATE_VALUES;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const CANDIDATES_SORT_FIELDS = [
  "confidence",
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
  "state",
] as const;

export const ListCandidatesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: z
      .enum(CANDIDATE_STATES)
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [CANDIDATE_STATES[0]] }),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    confidence: z
      .enum(CONFIDENCE_LEVELS)
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVELS[0]] }),
    sort: sortSchema(CANDIDATES_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(1000).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListCandidatesInput = z.infer<typeof ListCandidatesInputSchema>;

export const ListCandidatesOutputSchema = CandidatesArtifactSchema.extend({
  candidates: projectableRows(CandidatesArtifactSchema.shape.candidates),
});
export type ListCandidatesOutput = z.infer<typeof ListCandidatesOutputSchema>;
