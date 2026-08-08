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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  idFilterSchema,
  McpListArtifactStamp,
  McpListPageFields,
  RPC_POOL_KIND_VALUES,
  fieldsSchema,
  kindSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";
import { EvidenceLedgerArtifactSchema } from "../routes/candidates-evidence.ts";
import { SourceSnapshotsArtifactSchema } from "../routes/evidence-search.ts";
import { RpcEndpointsArtifactSchema } from "../routes/providers-rpc.ts";
import { ReviewProfileCompletenessArtifactSchema } from "../routes/review-gaps-profile.ts";
import { RpcPoolsArtifactSchema } from "../routes/providers-rpc.ts";
import {
  ENDPOINT_LAYER_VALUES,
  ENDPOINT_PUBLICATION_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import { HEALTH_STATUS_VALUES } from "../shared.ts";
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
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEvidenceInput = z.infer<typeof ListEvidenceInputSchema>;

export const ListEvidenceOutputSchema = EvidenceLedgerArtifactSchema.extend({
  claims: projectableRows(EvidenceLedgerArtifactSchema.shape.claims),
});
export type ListEvidenceOutput = z.infer<typeof ListEvidenceOutputSchema>;

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const ENDPOINT_LAYERS = ENDPOINT_LAYER_VALUES;
const HEALTH_STATUSES = HEALTH_STATUS_VALUES;
const ENDPOINT_PUBLICATION_STATES = ENDPOINT_PUBLICATION_STATE_VALUES;
export const ListRpcEndpointsInputSchema = z
  .object({
    kind: kindSchema(SURFACE_KINDS).optional(),
    layer: z
      .enum(ENDPOINT_LAYERS)
      .optional()
      .describe(
        "Which layer of the stack the endpoint belongs to: the Bittensor base chain, a data or docs provider, or a subnet's own app.",
      )
      .meta({ examples: [ENDPOINT_LAYERS[0]] }),
    netuid: API_QUERY_COLLECTIONS.endpoints.filter_schemas.netuid.optional(),
    provider: providerSlugSchema().optional(),
    publication_state:
      API_QUERY_COLLECTIONS.endpoints.filter_schemas.publication_state
        .optional()
        .describe(
          "Where the endpoint sits in the review pipeline, from unreviewed candidate through to pool-eligible or rejected.",
        )
        .meta({ examples: [ENDPOINT_PUBLICATION_STATES[0]] }),
    status: kindSchema(HEALTH_STATUSES).optional(),
    pool_eligible: z
      .boolean()
      .optional()
      .describe(
        "Restrict to endpoints that are (or are not) eligible for the public RPC pool.",
      )
      .meta({ examples: [true] }),
    min_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on probe latency in milliseconds; rows below it are excluded.",
      )
      .meta({ examples: [50] }),
    max_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on probe latency in milliseconds; rows above it are excluded.",
      )
      .meta({ examples: [500] }),
    min_score: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint score; rows below it are excluded.",
      )
      .meta({ examples: [50] }),
    max_score: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint score; rows above it are excluded.",
      )
      .meta({ examples: [100] }),
    sort: sortSchema(API_QUERY_COLLECTIONS.endpoints.sort_fields).optional(),
    order: orderSchema().optional(),
    // Both `fields` and `cursor` are UNIONS here, unlike everywhere else, so
    // neither can take a shared builder -- the sentence has to say which forms
    // are accepted rather than assume one.
    fields: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Row fields to project. Accepts either a comma-separated string " +
          "(`id,url,status`) or an array of bare names. Omit for the full row.",
      )
      .optional()
      .meta({ examples: ["netuid,name,slug"] }),
    // Ceiling is MAX_LIMIT (workers/request-params.ts:21); a literal here
    // because schemas-src/ imports from neither src/ nor workers/.
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
  endpoints: projectableRows(RpcEndpointsArtifactSchema.shape.endpoints),
});
export type ListRpcEndpointsOutput = z.infer<
  typeof ListRpcEndpointsOutputSchema
>;

export const ListRpcPoolsInputSchema = z
  .object({
    id: idFilterSchema().optional(),
    // POOL kinds, not endpoint LAYERS. This read ENDPOINT_LAYER_VALUES
    // (`bittensor-base`, `subnet-app`, …) -- a different vocabulary entirely,
    // so all four advertised values were rejected by the route and none of the
    // three it accepts was advertised (#10118).
    kind: kindSchema(RPC_POOL_KIND_VALUES).optional(),
    min_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on pool-eligible endpoint count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on pool-eligible endpoint count; rows above it are excluded.",
      )
      .meta({ examples: [10] }),
    min_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint count; rows above it are excluded.",
      )
      .meta({ examples: [10] }),
    sort: sortSchema(API_QUERY_COLLECTIONS["rpc-pools"].sort_fields).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
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
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSourceSnapshotsInput = z.infer<
  typeof ListSourceSnapshotsInputSchema
>;

export const ListSourceSnapshotsOutputSchema =
  SourceSnapshotsArtifactSchema.extend({
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
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
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
