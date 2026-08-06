// MCP tools `list_evidence`, `list_rpc_endpoints`, `list_rpc_pools`,
// `list_source_snapshots`, `list_profile_completeness` (types-epic E batch
// 9, #8073). Like registry-catalogs-1.ts's three tools, these five are NOT
// defined inline in src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/
// `LIST_X_OUTPUT_SCHEMA` hand-written literals live in src/evidence-mcp.ts,
// src/rpc-endpoints-mcp.ts, src/rpc-pools-mcp.ts, src/source-snapshots-mcp.ts,
// and src/profile-completeness-mcp.ts respectively, imported into
// mcp-server.ts's MCP_TOOLS array via object spread. The z.toJSONSchema(...)
// wiring for these five happens in THEIR OWN files, not mcp-server.ts. None
// mirror an existing schemas-src/routes/ REST schema -- modeled fresh,
// matching each hand-written literal field-for-field. Genuine per-tool
// variation worth flagging: list_rpc_pools and list_profile_completeness
// have NO schema_version output field at all (their siblings all do);
// list_rpc_endpoints' schema_version is a plain nullable integer (not the
// string|integer|null union every other tool in this batch uses); and
// list_rpc_endpoints' `fields`/`cursor` inputs are `oneOf` unions (string-or-
// array, integer-or-string) unlike every other tool's single-type fields.
import { z } from "zod";
import {
  OpenObjectSchema,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  providerSlugSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";

const CLAIM_SORT_FIELDS = [
  "claim",
  "source_url",
  "subject",
  "verified_at",
] as const;

export const ListEvidenceInputSchema = z
  .object({
    q: querySchema().optional(),
    sort: sortSchema(CLAIM_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEvidenceInput = z.infer<typeof ListEvidenceInputSchema>;

export const ListEvidenceOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
    summary: OpenObjectSchema.nullable().optional(),
    claims: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListEvidenceOutput = z.infer<typeof ListEvidenceOutputSchema>;

const SURFACE_KINDS = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
] as const;
const ENDPOINT_LAYERS = [
  "bittensor-base",
  "data-provider",
  "docs-provider",
  "subnet-app",
] as const;
const HEALTH_STATUSES = ["ok", "degraded", "failed", "unknown"] as const;
const ENDPOINT_PUBLICATION_STATES = [
  "candidate",
  "verified",
  "monitored",
  "pool-eligible",
  "disabled",
  "rejected",
] as const;
const ENDPOINT_SORT_FIELDS = [
  "kind",
  "last_checked",
  "latency_ms",
  "layer",
  "netuid",
  "pool_eligible",
  "provider",
  "publication_state",
  "score",
  "status",
] as const;

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
    netuid: netuidSchema().optional(),
    provider: providerSlugSchema().optional(),
    publication_state: z
      .enum(ENDPOINT_PUBLICATION_STATES)
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
    sort: sortSchema(ENDPOINT_SORT_FIELDS).optional(),
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
    limit: limitSchema(1000).optional(),
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

export const ListRpcEndpointsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z
      .union([z.array(z.string()), z.string()])
      .nullable()
      .optional(),
    schema_version: z.int().nullable().optional(),
    summary: OpenObjectSchema.nullable().optional(),
    source: z.string().nullable().optional(),
    operational_observed_at: z.string().nullable().optional(),
    endpoints: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListRpcEndpointsOutput = z.infer<
  typeof ListRpcEndpointsOutputSchema
>;

const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"] as const;
const POOL_SORT_FIELDS = [
  "eligible_count",
  "endpoint_count",
  "id",
  "kind",
] as const;

export const ListRpcPoolsInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    kind: kindSchema(POOL_KINDS).optional(),
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
    sort: sortSchema(POOL_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListRpcPoolsInput = z.infer<typeof ListRpcPoolsInputSchema>;

// No schema_version field in the hand-written original, unlike every other
// tool in this batch.
export const ListRpcPoolsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z
      .union([z.array(z.string()), z.string()])
      .nullable()
      .optional(),
    source: z.string().nullable().optional(),
    operational_observed_at: z.string().nullable().optional(),
    pools: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListRpcPoolsOutput = z.infer<typeof ListRpcPoolsOutputSchema>;

const SOURCE_SORT_FIELDS = ["id", "kind", "path", "record_count"] as const;

export const ListSourceSnapshotsInputSchema = z
  .object({
    q: querySchema().optional(),
    sort: sortSchema(SOURCE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSourceSnapshotsInput = z.infer<
  typeof ListSourceSnapshotsInputSchema
>;

export const ListSourceSnapshotsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
    summary: OpenObjectSchema.nullable().optional(),
    sources: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSourceSnapshotsOutput = z.infer<
  typeof ListSourceSnapshotsOutputSchema
>;

const PROFILE_LEVELS = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"] as const;
const NATIVE_NAME_QUALITIES = ["chain", "placeholder", "empty"] as const;
const PROFILE_SORT_FIELDS = [
  "candidate_count",
  "completeness_score",
  "identity_level",
  "identity_promotion_kind_count",
  "identity_surface_count",
  "live_identity_candidate_kind_count",
  "missing_critical_count",
  "name",
  "native_identity_signal_count",
  "native_name_quality",
  "netuid",
  "priority_score",
  "profile_level",
  "stale_identity_candidate_kind_count",
] as const;

export const ListProfileCompletenessInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    profile_level: z
      .enum(PROFILE_LEVELS)
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVELS[0]] }),
    confidence: z
      .enum(CONFIDENCE_LEVELS)
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVELS[0]] }),
    identity_level: z
      .enum(IDENTITY_LEVELS)
      .optional()
      .describe("How complete the subnet's published identity is.")
      .meta({ examples: [IDENTITY_LEVELS[0]] }),
    identity_promotion_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind would promote the subnet's identity. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    native_name_quality: z
      .enum(NATIVE_NAME_QUALITIES)
      .optional()
      .describe("Whether the on-chain name is real, a placeholder, or empty.")
      .meta({ examples: [NATIVE_NAME_QUALITIES[0]] }),
    sort: sortSchema(PROFILE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProfileCompletenessInput = z.infer<
  typeof ListProfileCompletenessInputSchema
>;

// No schema_version field in the hand-written original. summary declares
// additionalProperties:true explicitly, unlike list_evidence's bare
// nullable-object summary.
export const ListProfileCompletenessOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z
      .union([z.array(z.string()), z.string()])
      .nullable()
      .optional(),
    summary: z.object({}).passthrough().nullable().optional(),
    profiles: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListProfileCompletenessOutput = z.infer<
  typeof ListProfileCompletenessOutputSchema
>;
