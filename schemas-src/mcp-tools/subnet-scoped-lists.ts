// MCP tools `list_subnet_endpoints`, `list_subnet_surfaces`,
// `list_subnet_health` (types-epic E batch 9, #8073). Like
// registry-catalogs-{1,2}.ts's tools, these three are NOT defined inline in
// src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/`LIST_X_OUTPUT_SCHEMA`
// hand-written literals live in src/subnet-endpoints-mcp.ts,
// src/subnet-surfaces-mcp.ts, and src/subnet-health-mcp.ts respectively,
// imported into mcp-server.ts's MCP_TOOLS array via object spread. The
// z.toJSONSchema(...) wiring for these three happens in THEIR OWN files, not
// mcp-server.ts. None mirror an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field. Unlike
// the network-wide list_* tools in registry-catalogs-{1,2}.ts, `netuid` is
// REQUIRED here (a path parameter, not a filter), and none of the three
// output shapes carry schema_version/notes/summary. list_subnet_endpoints'
// `pool_eligible` is a STRING enum (["true","false"]), unlike
// list_rpc_endpoints' plain boolean for the same filter name.
// list_subnet_surfaces/list_subnet_health have no `fields` projection param
// at all, unlike every other list_* tool in this epic.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

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
const ENDPOINT_PUBLICATION_STATES = [
  "candidate",
  "verified",
  "monitored",
  "pool-eligible",
  "disabled",
  "rejected",
] as const;
const HEALTH_STATUSES = ["ok", "degraded", "failed", "unknown"] as const;
const BOOLEAN_STRINGS = ["true", "false"] as const;
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

export const ListSubnetEndpointsInputSchema = z
  .object({
    netuid: z.int().min(0),
    kind: z.enum(SURFACE_KINDS).optional(),
    layer: z.enum(ENDPOINT_LAYERS).optional(),
    provider: z.string().optional(),
    publication_state: z.enum(ENDPOINT_PUBLICATION_STATES).optional(),
    status: z.enum(HEALTH_STATUSES).optional(),
    pool_eligible: z.enum(BOOLEAN_STRINGS).optional(),
    min_latency_ms: z.number().optional(),
    max_latency_ms: z.number().optional(),
    min_score: z.number().optional(),
    max_score: z.number().optional(),
    sort: z.enum(ENDPOINT_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSubnetEndpointsInput = z.infer<
  typeof ListSubnetEndpointsInputSchema
>;

export const ListSubnetEndpointsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
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
export type ListSubnetEndpointsOutput = z.infer<
  typeof ListSubnetEndpointsOutputSchema
>;

const SURFACE_SORT_FIELDS = [
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
] as const;

export const ListSubnetSurfacesInputSchema = z
  .object({
    netuid: z.int().min(0),
    kind: z.enum(SURFACE_KINDS).optional(),
    provider: z.string().optional(),
    id: z.string().optional(),
    sort: z.enum(SURFACE_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSubnetSurfacesInput = z.infer<
  typeof ListSubnetSurfacesInputSchema
>;

export const ListSubnetSurfacesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    surfaces: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetSurfacesOutput = z.infer<
  typeof ListSubnetSurfacesOutputSchema
>;

const HEALTH_CLASSIFICATIONS = [
  "auth-required",
  "content-mismatch",
  "dead",
  "live",
  "rate-limited",
  "redirected",
  "timeout",
  "transient",
  "unsupported",
  "unsafe",
  "wrong-chain",
] as const;
const HEALTH_SORT_FIELDS = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
] as const;

export const ListSubnetHealthInputSchema = z
  .object({
    netuid: z.int().min(0),
    kind: z.enum(SURFACE_KINDS).optional(),
    provider: z.string().optional(),
    status: z.enum(HEALTH_STATUSES).optional(),
    classification: z.enum(HEALTH_CLASSIFICATIONS).optional(),
    sort: z.enum(HEALTH_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSubnetHealthInput = z.infer<typeof ListSubnetHealthInputSchema>;

export const ListSubnetHealthOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    surfaces: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetHealthOutput = z.infer<
  typeof ListSubnetHealthOutputSchema
>;
