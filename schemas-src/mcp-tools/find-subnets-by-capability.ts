// MCP tool `find_subnets_by_capability` (types-epic E batch 2, #8065). No
// REST mirror -- src/mcp-server.ts's own handler builds this shape directly
// from /metagraph/agent-catalog.json + a keyword score, it isn't a route
// response. Modeled field-for-field from the hand-written literals this
// replaces, same as search-subnets.ts in the pilot batch.
import { z } from "zod";
import { limitSchema, netuidSchema, numericCursorSchema } from "./shared.ts";

export const FindSubnetsByCapabilityInputSchema = z
  .object({
    capability: z
      .string()
      .describe(
        "A capability keyword to match against subnet descriptions and surfaces, e.g. `inference` or `storage`.",
      ),
    cursor: numericCursorSchema().optional(),
    limit: limitSchema(50).optional(),
  })
  .strict();
export type FindSubnetsByCapabilityInput = z.infer<
  typeof FindSubnetsByCapabilityInputSchema
>;

const FindSubnetsByCapabilityResultItemSchema = z
  .object({
    netuid: netuidSchema().optional(),
    slug: z.string().optional(),
    name: z.string().nullable().optional(),
    categories: z.array(z.unknown()).optional(),
    service_kinds: z.array(z.unknown()).optional(),
    callable_count: z.int().optional(),
    integration_readiness: z.unknown().optional(),
  })
  .passthrough();

export const FindSubnetsByCapabilityOutputSchema = z
  .object({
    capability: z.string(),
    total: z.int(),
    count: z.int(),
    cursor: z.int(),
    limit: z.int(),
    next_cursor: z.int().nullable(),
    results: z.array(FindSubnetsByCapabilityResultItemSchema),
  })
  .passthrough();
export type FindSubnetsByCapabilityOutput = z.infer<
  typeof FindSubnetsByCapabilityOutputSchema
>;
