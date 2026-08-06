// MCP tools `list_endpoints`, `get_subnet_endpoints` (types-epic E batch 9,
// #8073). Both are defined inline in src/mcp-server.ts's MCP_TOOLS array
// (unlike this batch's 11 other list_* tools, which live in separate
// src/*-mcp.ts files). Neither mirrors an existing schemas-src/routes/ REST
// schema -- modeled fresh, matching each hand-written literal
// field-for-field.
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
  sortSchema,
} from "./shared.ts";

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
    fields: fieldsStringSchema().optional(),
    // Ceiling is MAX_LIMIT (workers/request-params.ts:21); a literal here
    // because schemas-src/ imports from neither src/ nor workers/.
    limit: limitSchema(1000).optional(),
    cursor: numericCursorSchema().optional(),
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
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetEndpointsInput = z.infer<
  typeof GetSubnetEndpointsInputSchema
>;

export const GetSubnetEndpointsOutputSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    endpoints: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetEndpointsOutput = z.infer<
  typeof GetSubnetEndpointsOutputSchema
>;
