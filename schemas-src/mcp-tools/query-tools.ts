// MCP tools `query_graphql`, `run_saved_query` (types-epic E batch 12,
// #8075). Both are defined inline in src/mcp-server.ts's MCP_TOOLS array,
// and unlike every other tool in this epic (whose output schema lives in
// the shared TOOL_OUTPUT_SCHEMAS map), both declare their `outputSchema`
// INLINE on the tool object itself -- same treatment as the existing
// decode_evm_call tool (an earlier batch). Neither mirrors an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
//
// query_graphql's hand-written `data` field declares `nullable: true`, an
// OpenAPI-3.0-ism with NO effect under JSON Schema draft 2020-12 (which has
// no `nullable` keyword) -- so under the target's own spec, `data` was
// already (inertly) a plain non-nullable object. Preserved literally as
// non-nullable here rather than "fixed" into a real `.nullable()`, since
// doing so would make the new schema accept something the old one's actual
// declared (2020-12) semantics didn't -- the opposite direction from this
// epic's wire-compatibility mandate.
//
// run_saved_query's output declares `additionalProperties: false` (.strict()
// below), unlike nearly every other output schema in this epic (which are
// passthrough) -- a genuine, deliberate difference, preserved as-is.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const QueryGraphqlInputSchema = z
  .object({
    query: z
      .string()
      .describe(
        "The request payload or search text this surface expects. Shape depends on the surface; see its schema.",
      )
      .meta({ examples: ["inference"] }),
    variables: OpenObjectSchema.optional()
      .describe("GraphQL variables for the query, as an object.")
      .meta({ examples: [{ netuid: 64 }] }),
  })
  .strict();
export type QueryGraphqlInput = z.infer<typeof QueryGraphqlInputSchema>;

export const QueryGraphqlOutputSchema = z
  .object({
    data: OpenObjectSchema.optional(),
    errors: z.array(OpenObjectSchema).optional(),
  })
  .passthrough();
export type QueryGraphqlOutput = z.infer<typeof QueryGraphqlOutputSchema>;

// Symbolic in the hand-written original (src/saved-queries.ts's
// SAVED_QUERY_TEMPLATES.map((t) => t.id)), cross-checked against the actual
// runtime source at the time of writing.
const SAVED_QUERY_IDS = [
  "subnet-leaderboard",
  "chain-registrations-window",
] as const;

export const RunSavedQueryInputSchema = z
  .object({
    query_id: z
      .enum(SAVED_QUERY_IDS)
      .describe(
        "Which saved query template to run. See this parameter's enum for the available ids.",
      )
      .meta({ examples: [SAVED_QUERY_IDS[0]] }),
    params: OpenObjectSchema.optional()
      .describe(
        "Positional or named parameters for the RPC method, matching what that method expects.",
      )
      .meta({ examples: [[]] }),
  })
  .strict();
export type RunSavedQueryInput = z.infer<typeof RunSavedQueryInputSchema>;

export const RunSavedQueryOutputSchema = z
  .object({
    query_id: z.string(),
    params: OpenObjectSchema,
    data: z.unknown(),
  })
  .strict();
export type RunSavedQueryOutput = z.infer<typeof RunSavedQueryOutputSchema>;
