// MCP tools `get_agent_catalog`, `get_agent_resources` (types-epic E batch
// 12, #8075). `get_agent_catalog` is defined inline in src/mcp-server.ts's
// MCP_TOOLS array; `get_agent_resources` lives in its own
// src/agent-resources-mcp.ts (its `GET_AGENT_RESOURCES_MCP_TOOL`/
// `GET_AGENT_RESOURCES_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). Neither mirrors an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import {
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
  McpOffsetPageInput,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { AgentResourcesArtifactSchema } from "../routes/agent-catalog.ts";
import { netuidSchema } from "./shared.ts";
import {
  AgentCatalogArtifactSchema,
  AgentCatalogSubnetArtifactSchema,
} from "../routes/agent-catalog.ts";
import { LIVE_HEALTH_OVERLAY } from "../routes/subnet-detail.ts";

export const GetAgentCatalogInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    ...McpOffsetPageInput,
    sort: sortSchema(
      API_QUERY_COLLECTIONS["agent-catalog"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type GetAgentCatalogInput = z.infer<typeof GetAgentCatalogInputSchema>;

/**
 * ONE tool, TWO forms -- and it declared six fields of the two (#10790).
 *
 * `get_agent_catalog()` answers the whole catalog when called bare and ONE
 * subnet's catalog when called with `netuid`, and the two share almost nothing:
 * the index carries `subnets`/`blocked_subnets` and a page block, the detail
 * carries `services`/`examples`/`readiness`. The old declaration named
 * `subnets` and five stamps, so 23 served fields -- every field of the detail
 * form among them -- went out undescribed on every per-subnet call.
 *
 * DERIVED FROM THE TWO ROUTE SCHEMAS, not retyped: the same shapes
 * /api/v1/agent-catalog and /api/v1/agent-catalog/{netuid} publish, so a field
 * added there cannot go missing here. `.partial()` on each because which form
 * you get is decided by the argument -- the fields are not optional within a
 * form, they belong to one form or the other.
 *
 * The cost of one flat object rather than a union: a hypothetical response
 * mixing keys from both forms would validate. That is accepted deliberately --
 * a union would take this tool's schema off the `outputJsonSchema` seam that
 * declares the dispatch-stamped `degraded` block, and no producer can emit the
 * mixed shape, because the two forms are two return statements.
 */
export const GetAgentCatalogOutputSchema = z
  .object({
    ...AgentCatalogArtifactSchema.partial().shape,
    ...AgentCatalogSubnetArtifactSchema.partial().shape,
    // The MCP page block over the index form's `subnets`, and the live health
    // overlay both forms carry. Optional here, unlike on the single-form list
    // tools, because the detail form pages nothing.
    ...McpUnsortedPageFields,
    ...LIVE_HEALTH_OVERLAY,
  })
  .partial()
  .strict();
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
