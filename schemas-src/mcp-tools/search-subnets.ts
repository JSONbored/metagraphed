// MCP tool `search_subnets` (types-epic E pilot batch, #7863). No REST
// mirror -- src/mcp-server.ts's own handler builds this shape directly from
// /metagraph/search.json + a ranking score, it isn't a route response. Both
// schemas are modeled from the hand-written JSON Schema literals they
// replace (src/mcp-server.ts's MCP_TOOLS entry +
// TOOL_OUTPUT_SCHEMAS.search_subnets),
// field for field, preserving the EXACT wire contract -- required sets,
// nullability, and additionalProperties posture all carried over unchanged.
// This is a stricter constraint than types-epic B's OpenAPI components: no
// tightening here, only relocating where the schema is defined (#7863's own
// "hard wire-compatibility constraint").
import { z } from "zod";
import {
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  querySchema,
} from "./shared.ts";

export const SearchSubnetsInputSchema = z
  .object({
    // The name the ROUTE publishes (#10018). GET /api/v1/search documents
    // `q`, so an agent reading our own OpenAPI sends that and was rejected for
    // an unknown argument until now. Canonical; `query` stays so existing
    // callers are unaffected. Exactly one is required -- see requireAnyOf on
    // the tool, since Zod cannot express it in a way z.toJSONSchema keeps.
    q: querySchema()
      .optional()
      .describe(
        "The search text. The name GET /api/v1/search publishes; `query` is the alias this tool shipped with.",
      )
      .meta({ examples: ["inference"] }),
    query: querySchema()
      .optional()
      .describe(
        "Alias for `q`, the name this tool shipped with. The subnet search text.",
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
