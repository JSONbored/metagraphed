// MCP tools `list_endpoints`, `get_subnet_endpoints` (types-epic E batch 9,
// #8073). Both are defined inline in src/mcp-server.ts's MCP_TOOLS array
// (unlike this batch's 11 other list_* tools, which live in separate
// src/*-mcp.ts files). Neither mirrors an existing schemas-src/routes/ REST
// schema -- modeled fresh, matching each hand-written literal
// field-for-field.
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

export const ListEndpointsInputSchema = z
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
    fields: z.string().optional(),
    // Ceiling matches workers/request-params.ts:21 (`MAX_LIMIT`).
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListEndpointsInput = z.infer<typeof ListEndpointsInputSchema>;

export const ListEndpointsOutputSchema = z
  .object({
    endpoints: z.array(OpenObjectSchema).optional(),
    total: z.int().optional(),
    returned: z.int().optional(),
    cursor: z.int().optional(),
    limit: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type ListEndpointsOutput = z.infer<typeof ListEndpointsOutputSchema>;

export const GetSubnetEndpointsInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetEndpointsInput = z.infer<
  typeof GetSubnetEndpointsInputSchema
>;

export const GetSubnetEndpointsOutputSchema = z
  .object({
    netuid: z.int().nullable().optional(),
    endpoints: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetEndpointsOutput = z.infer<
  typeof GetSubnetEndpointsOutputSchema
>;
