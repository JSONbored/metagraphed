// MCP tools `get_agent_catalog`, `get_agent_resources` (types-epic E batch
// 12, #8075). `get_agent_catalog` is defined inline in src/mcp-server.ts's
// MCP_TOOLS array; `get_agent_resources` lives in its own
// src/agent-resources-mcp.ts (its `GET_AGENT_RESOURCES_MCP_TOOL`/
// `GET_AGENT_RESOURCES_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). Neither mirrors an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import {
  offsetSchema,
  limitSchema,
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
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
    // The page (#10605). Both numbers come from the constants that actually
    // decide them: MAX_LIMIT is the ceiling listQuerySchema gives every list
    // route, and MCP_LIST_LIMIT_DEFAULT is the default applyMcpQueryFilters
    // really applies -- published rather than hidden, because #10101 found 83
    // tools whose schema left a caller unable to tell what an omitted
    // limit returns. Publishing the ceiling while hiding the default would
    // recreate exactly that gap.
    limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
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
