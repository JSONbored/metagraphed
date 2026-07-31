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
import { OpenObjectSchema } from "./shared.ts";

const CLAIM_SORT_FIELDS = [
  "claim",
  "source_url",
  "subject",
  "verified_at",
] as const;

export const ListEvidenceInputSchema = z
  .object({
    q: z.string().optional(),
    sort: z.enum(CLAIM_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
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
    kind: z.enum(SURFACE_KINDS).optional(),
    layer: z.enum(ENDPOINT_LAYERS).optional(),
    netuid: z.int().min(0).optional(),
    provider: z.string().optional(),
    publication_state: z.enum(ENDPOINT_PUBLICATION_STATES).optional(),
    status: z.enum(HEALTH_STATUSES).optional(),
    pool_eligible: z.boolean().optional(),
    min_latency_ms: z.number().optional(),
    max_latency_ms: z.number().optional(),
    min_score: z.number().optional(),
    max_score: z.number().optional(),
    sort: z.enum(ENDPOINT_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.union([z.string(), z.array(z.string())]).optional(),
    // Ceiling matches workers/request-params.ts:21 (`MAX_LIMIT`).
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.union([z.int().min(0), z.string()]).optional(),
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
    id: z.string().optional(),
    kind: z.enum(POOL_KINDS).optional(),
    min_eligible_count: z.number().optional(),
    max_eligible_count: z.number().optional(),
    min_endpoint_count: z.number().optional(),
    max_endpoint_count: z.number().optional(),
    sort: z.enum(POOL_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
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
    q: z.string().optional(),
    sort: z.enum(SOURCE_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
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
    netuid: z.int().min(0).optional(),
    profile_level: z.enum(PROFILE_LEVELS).optional(),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    identity_level: z.enum(IDENTITY_LEVELS).optional(),
    identity_promotion_kinds: z.enum(SURFACE_KINDS).optional(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITIES).optional(),
    sort: z.enum(PROFILE_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
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
