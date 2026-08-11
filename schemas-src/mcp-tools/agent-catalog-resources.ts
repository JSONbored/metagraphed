// MCP tools `get_agent_catalog`, `get_agent_resources` (types-epic E batch
// 12, #8075). `get_agent_catalog` is defined inline in src/mcp-server.ts's
// MCP_TOOLS array; `get_agent_resources` lives in its own
// src/agent-resources-mcp.ts (its `GET_AGENT_RESOURCES_MCP_TOOL`/
// `GET_AGENT_RESOURCES_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). Neither mirrors an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import {
  offsetSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { AgentResourcesArtifactSchema } from "../routes/agent-catalog.ts";
import { netuidSchema } from "./shared.ts";
import { AgentCatalogSubnetEntrySchema } from "../routes/agent-catalog.ts";

export const GetAgentCatalogInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    // The page (#10605). `limit` carries NO default here, deliberately: the
    // helper that runs these queries supplies MCP_LIST_LIMIT_DEFAULT when a
    // caller gives none, so a default stated here would be a second one. What
    // the tool publishes is MAX_LIMIT -- the same constant listQuerySchema gives
    // every list route, rather than a copy of its value; what an omitted
    // limit means is the helper's answer, and there is one of each.
    limit: limitSchema(MAX_LIMIT).optional(),
    // An integer OFFSET, which is what these routes publish
    // (`{minimum: 0, type: integer}`) -- not the keyset cursor. Conflating the
    // two is the mistake query-params.ts calls out by name.
    cursor: offsetSchema().optional(),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["agent-catalog"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
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
    // Typed from the route's own AgentCatalogSubnetEntrySchema (#9797).
    // Optional because it is the GLOBAL form's key -- a per-netuid call
    // returns that subnet's own catalog instead, with no `subnets` at all.
    // Verified against production 2026-08-07 over all 126 rows.
    subnets: z.array(AgentCatalogSubnetEntrySchema).optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type GetAgentCatalogOutput = z.infer<typeof GetAgentCatalogOutputSchema>;

export const GetAgentResourcesInputSchema = z.object({}).strict();
export type GetAgentResourcesInput = z.infer<
  typeof GetAgentResourcesInputSchema
>;

// DERIVED, NOT COPIED (#9796). The copy published summary, copyable_agent, mcp
// and resources[] as bare open shapes.
export const GetAgentResourcesOutputSchema = AgentResourcesArtifactSchema;
export type GetAgentResourcesOutput = z.infer<
  typeof GetAgentResourcesOutputSchema
>;
