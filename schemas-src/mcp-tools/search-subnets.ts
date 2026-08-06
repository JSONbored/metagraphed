// MCP tool `search_subnets` (types-epic E pilot batch, #7863). No REST
// mirror -- src/mcp-server.ts's own handler builds this shape directly from
// /metagraph/search.json + a ranking score, it isn't a route response. Both
// schemas are modeled from the hand-written JSON Schema literals they
// replace (src/mcp-server.ts's MCP_TOOLS entry + TOOL_OUTPUT_SCHEMAS.search_subnets),
// field for field, preserving the EXACT wire contract -- required sets,
// nullability, and additionalProperties posture all carried over unchanged.
// This is a stricter constraint than types-epic B's OpenAPI components: no
// tightening here, only relocating where the schema is defined (#7863's own
// "hard wire-compatibility constraint").
import { z } from "zod";
import { limitSchema, netuidSchema, numericCursorSchema } from "./shared.ts";

export const SearchSubnetsInputSchema = z
  .object({
    query: z
      .string()
      .describe(
        "The request payload or search text this surface expects. Shape depends on the surface; see its schema.",
      )
      .meta({ examples: ["inference"] }),
    cursor: numericCursorSchema().optional(),
    limit: limitSchema(50).optional(),
  })
  .strict();
export type SearchSubnetsInput = z.infer<typeof SearchSubnetsInputSchema>;

// objectItems(...) in mcp-server.ts emits {type:"object", additionalProperties:true,
// properties} with NO `required` array -- every field below is optional at
// the wire level even though the real handler always sets all five.
const SearchSubnetsResultItemSchema = z
  .object({
    netuid: netuidSchema().optional(),
    slug: z.string().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

export const SearchSubnetsOutputSchema = z
  .object({
    query: z.string(),
    total: z.int(),
    count: z.int(),
    cursor: z.int(),
    limit: z.int(),
    next_cursor: z.int().nullable(),
    results: z.array(SearchSubnetsResultItemSchema),
  })
  .passthrough();
export type SearchSubnetsOutput = z.infer<typeof SearchSubnetsOutputSchema>;
