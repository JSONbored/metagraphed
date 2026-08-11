// MCP tools `list_evidence`, `list_rpc_endpoints`, `list_source_snapshots`.
// Mirror GET /api/v1/evidence, GET /api/v1/rpc/endpoints, GET
// /api/v1/source-snapshots.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   list_evidence: 2 bare `{"type":"object"}` sites.
//   list_rpc_endpoints: 2 bare `{"type":"object"}` sites.
//   list_source_snapshots: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ENDPOINT_LIST_FILTERS } from "./endpoints-catalog.ts";
import { POOL_LIST_FILTERS } from "./endpoint-pools-and-provider.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  McpListArtifactStamp,
  McpListPageFields,
  limitSchema,
  projectableRows,
  querySchema,
  sortSchema,
  McpSortableListPage,
} from "./shared.ts";
import { EvidenceLedgerArtifactSchema } from "../routes/candidates-evidence.ts";
import { SourceSnapshotsArtifactSchema } from "../routes/evidence-search.ts";
import { RpcEndpointsArtifactSchema } from "../routes/providers-rpc.ts";
import { ReviewProfileCompletenessArtifactSchema } from "../routes/review-gaps-profile.ts";
import { RpcPoolsArtifactSchema } from "../routes/providers-rpc.ts";
import {
  LIVE_HEALTH_OVERLAY,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import {
  CONFIDENCE_LEVEL_VALUES,
  IDENTITY_LEVEL_VALUES,
  NATIVE_NAME_QUALITY_VALUES,
  PROFILE_LEVEL_VALUES,
} from "../shared.ts";
import {} from "./shared.ts";

export const ListEvidenceInputSchema = z
  .object({
    q: querySchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.claims.sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListEvidenceInput = z.infer<typeof ListEvidenceInputSchema>;

export const ListEvidenceOutputSchema = EvidenceLedgerArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  claims: projectableRows(EvidenceLedgerArtifactSchema.shape.claims),
});
export type ListEvidenceOutput = z.infer<typeof ListEvidenceOutputSchema>;

const SURFACE_KINDS = SURFACE_KIND_VALUES;
export const ListRpcEndpointsInputSchema = z
  .object({
    ...ENDPOINT_LIST_FILTERS,
    netuid: API_QUERY_COLLECTIONS.endpoints.filter_schemas.netuid.optional(),
    limit: limitSchema(1000, 20).optional(),
    cursor: z
      .union([z.int().min(0), z.string()])
      .describe(
        "Page cursor. Accepts either a numeric row offset or the opaque " +
          "`next_cursor` token from the previous response; pass a token back " +
          "verbatim, since its contents are not stable.",
      )
      .optional()
      .meta({ examples: [0] }),
  })
  .strict();
export type ListRpcEndpointsInput = z.infer<typeof ListRpcEndpointsInputSchema>;

export const ListRpcEndpointsOutputSchema = RpcEndpointsArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  // The same serve-time health overlay the REST route carries.
  ...LIVE_HEALTH_OVERLAY,
  endpoints: projectableRows(RpcEndpointsArtifactSchema.shape.endpoints),
});
export type ListRpcEndpointsOutput = z.infer<
  typeof ListRpcEndpointsOutputSchema
>;

export const ListRpcPoolsInputSchema = z
  .object({
    ...POOL_LIST_FILTERS,
    sort: sortSchema(API_QUERY_COLLECTIONS["rpc-pools"].sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListRpcPoolsInput = z.infer<typeof ListRpcPoolsInputSchema>;

// No schema_version field in the hand-written original, unlike every other
// tool in this batch.
export const ListRpcPoolsOutputSchema = RpcPoolsArtifactSchema.pick({
  source: true,
  pools: true,
}).extend({
  pools: projectableRows(RpcPoolsArtifactSchema.shape.pools),
  ...McpListArtifactStamp,
  // Added by the live overlay, so it is not on the route artifact.
  operational_observed_at: z.string().nullable(),
  ...McpListPageFields,
});
export type ListRpcPoolsOutput = z.infer<typeof ListRpcPoolsOutputSchema>;

export const ListSourceSnapshotsInputSchema = z
  .object({
    q: querySchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.sources.sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListSourceSnapshotsInput = z.infer<
  typeof ListSourceSnapshotsInputSchema
>;

export const ListSourceSnapshotsOutputSchema =
  SourceSnapshotsArtifactSchema.extend({
    // The page block the MCP loader adds on top of the route's artifact --
    // undeclared until #10790, when `.strict()` first rejected it.
    ...McpListPageFields,
    sources: projectableRows(SourceSnapshotsArtifactSchema.shape.sources),
  });
export type ListSourceSnapshotsOutput = z.infer<
  typeof ListSourceSnapshotsOutputSchema
>;

export const ListProfileCompletenessInputSchema = z
  .object({
    netuid:
      API_QUERY_COLLECTIONS[
        "profile-completeness"
      ].filter_schemas.netuid.optional(),
    profile_level: API_QUERY_COLLECTIONS[
      "profile-completeness"
    ].filter_schemas.profile_level
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVEL_VALUES[0]] }),
    confidence: API_QUERY_COLLECTIONS[
      "profile-completeness"
    ].filter_schemas.confidence
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVEL_VALUES[0]] }),
    identity_level: API_QUERY_COLLECTIONS[
      "profile-completeness"
    ].filter_schemas.identity_level
      .optional()
      .describe("How complete the subnet's published identity is.")
      .meta({ examples: [IDENTITY_LEVEL_VALUES[0]] }),
    identity_promotion_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind would promote the subnet's identity. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    native_name_quality: API_QUERY_COLLECTIONS[
      "profile-completeness"
    ].filter_schemas.native_name_quality
      .optional()
      .describe("Whether the on-chain name is real, a placeholder, or empty.")
      .meta({ examples: [NATIVE_NAME_QUALITY_VALUES[0]] }),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["profile-completeness"].sort_fields,
    ).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListProfileCompletenessInput = z.infer<
  typeof ListProfileCompletenessInputSchema
>;

// No schema_version field in the hand-written original. summary declares
// additionalProperties:true explicitly, unlike list_evidence's bare
// nullable-object summary.
export const ListProfileCompletenessOutputSchema =
  ReviewProfileCompletenessArtifactSchema.pick({
    summary: true,
    profiles: true,
  }).extend({
    profiles: projectableRows(
      ReviewProfileCompletenessArtifactSchema.shape.profiles,
    ),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListProfileCompletenessOutput = z.infer<
  typeof ListProfileCompletenessOutputSchema
>;
