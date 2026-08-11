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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  idFilterSchema,
  fieldsSchema,
  kindSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  sortSchema,
  McpListPageFields,
  McpSortableListPage,
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
import { CONFIDENCE_LEVEL_VALUES } from "../shared.ts";

// Symbolic in each hand-written original (src/contracts.ts's QUERY_ENUMS /
// API_QUERY_COLLECTIONS.*.sort_fields), cross-checked against the actual
// runtime source at the time of writing.
const PROVIDER_KINDS = PROVIDER_KIND_VALUES;
const PROVIDER_AUTHORITIES = AUTHORITY_VALUES;

export const ListProvidersInputSchema = z
  .object({
    id: idFilterSchema().optional(),
    kind: kindSchema(PROVIDER_KINDS).optional(),
    authority: z
      .enum(PROVIDER_AUTHORITIES)
      .optional()
      .describe(
        "Who asserts this record: the operator, the community, a provider, or the registry's own probes.",
      )
      .meta({ examples: [PROVIDER_AUTHORITIES[0]] }),
    sort: sortSchema(API_QUERY_COLLECTIONS.providers.sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListProvidersInput = z.infer<typeof ListProvidersInputSchema>;

export const ListProvidersOutputSchema = ProvidersArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  providers: projectableRows(ProvidersArtifactSchema.shape.providers),
});
export type ListProvidersOutput = z.infer<typeof ListProvidersOutputSchema>;

const SURFACE_KINDS = SURFACE_KIND_VALUES;
export const ListSurfacesInputSchema = z
  .object({
    netuid:
      API_QUERY_COLLECTIONS[
        "curated-surfaces"
      ].filter_schemas.netuid.optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    id: idFilterSchema().optional(),
    // #10008: the three the curated-surfaces collection declares and this tool
    // could not pass. Strings, not booleans, because that is what the route
    // accepts -- these are query parameters, and `?auth_required=true` is a
    // string on the wire. A boolean here would accept `true` and send
    // "true" anyway, but would also reject the literal a REST caller uses.
    //
    // THE REASON THEY ARE SERVER-SIDE, from the collection's own comment: the
    // UI once applied these client-side over one loaded page, and with 25 rows
    // against 3,494 surfaces `?auth=required` showed 6 of the 1,184 matches --
    // "a filter that silently under-reports by 99% is worse than one that
    // errors, because it looks like it worked". An agent narrowing a page it
    // fetched is in exactly that position.
    auth_required: API_QUERY_COLLECTIONS[
      "curated-surfaces"
    ].filter_schemas.auth_required
      .optional()
      .describe(
        "Restrict to surfaces that do (`true`) or do not (`false`) require authentication. Applied server-side across the whole catalog, not to one page.",
      )
      .meta({ examples: ["false"] }),
    public_safe: API_QUERY_COLLECTIONS[
      "curated-surfaces"
    ].filter_schemas.public_safe
      .optional()
      .describe(
        "Restrict to surfaces marked safe (`true`) or unsafe (`false`) to call from a public client.",
      )
      .meta({ examples: ["true"] }),
    rate_limited: API_QUERY_COLLECTIONS[
      "curated-surfaces"
    ].filter_schemas.rate_limited
      .optional()
      .describe(
        "Restrict to surfaces that declare rate-limit notes (`true`) or declare none (`false`). A presence filter over `rate_limit_notes`, not a claim that an unlimited surface exists.",
      )
      .meta({ examples: ["true"] }),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["curated-surfaces"].sort_fields,
    ).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListSurfacesInput = z.infer<typeof ListSurfacesInputSchema>;

export const ListSurfacesOutputSchema = SurfacesArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  surfaces: projectableRows(SurfacesArtifactSchema.shape.surfaces),
});
export type ListSurfacesOutput = z.infer<typeof ListSurfacesOutputSchema>;

const CANDIDATE_STATES = CANDIDATE_STATE_VALUES;
export const ListCandidatesInputSchema = z
  .object({
    netuid: API_QUERY_COLLECTIONS.candidates.filter_schemas.netuid.optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: API_QUERY_COLLECTIONS.candidates.filter_schemas.state
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [CANDIDATE_STATES[0]] }),
    id: idFilterSchema().optional(),
    confidence: API_QUERY_COLLECTIONS.candidates.filter_schemas.confidence
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVEL_VALUES[0]] }),
    sort: sortSchema(API_QUERY_COLLECTIONS.candidates.sort_fields).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(1000, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListCandidatesInput = z.infer<typeof ListCandidatesInputSchema>;

export const ListCandidatesOutputSchema = CandidatesArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  candidates: projectableRows(CandidatesArtifactSchema.shape.candidates),
});
export type ListCandidatesOutput = z.infer<typeof ListCandidatesOutputSchema>;
