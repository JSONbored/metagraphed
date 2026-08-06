// MCP tools `get_agent_catalog`, `get_agent_resources` (types-epic E batch
// 12, #8075). `get_agent_catalog` is defined inline in src/mcp-server.ts's
// MCP_TOOLS array; `get_agent_resources` lives in its own
// src/agent-resources-mcp.ts (its `GET_AGENT_RESOURCES_MCP_TOOL`/
// `GET_AGENT_RESOURCES_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). Neither mirrors an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

export const GetAgentCatalogInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
  })
  .strict();
export type GetAgentCatalogInput = z.infer<typeof GetAgentCatalogInputSchema>;

// Two shapes: the global index (no netuid) and a single-subnet catalog
// (with a netuid). They share few keys, so nothing is required in the
// hand-written original; the fields below describe the global index when
// present.
export const GetAgentCatalogOutputSchema = z
  .object({
    subnet_count: z.int().optional(),
    total_subnet_count: z.int().optional(),
    callable_service_count: z.int().optional(),
    content_hash: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    published_at: z.string().nullable().optional(),
    subnets: z.array(OpenObjectSchema).optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type GetAgentCatalogOutput = z.infer<typeof GetAgentCatalogOutputSchema>;

export const GetAgentResourcesInputSchema = z.object({}).strict();
export type GetAgentResourcesInput = z.infer<
  typeof GetAgentResourcesInputSchema
>;

export const GetAgentResourcesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    published_at: z.string().nullable().optional(),
    content_hash: z.string().nullable().optional(),
    summary: OpenObjectSchema.optional(),
    copyable_agent: OpenObjectSchema.optional(),
    mcp: OpenObjectSchema,
    resources: z.array(OpenObjectSchema),
  })
  .passthrough();
export type GetAgentResourcesOutput = z.infer<
  typeof GetAgentResourcesOutputSchema
>;
