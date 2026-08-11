// MCP tools `query_graphql`, `run_saved_query` (types-epic E batch 12,
// #8075). Both are defined inline in src/mcp-server.ts's MCP_TOOLS array,
// and unlike every other tool in this epic (whose output schema lives in
// the shared TOOL_OUTPUT_SCHEMAS map), both declare their `outputSchema`
// INLINE on the tool object itself -- same treatment as the existing
// decode_evm_call tool (an earlier batch). Neither mirrors an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
//
// query_graphql's `data` IS nullable (#9911), and the reasoning that once said
// otherwise has been overtaken by evidence.
//
// The hand-written original declared `nullable: true`, an OpenAPI-3.0-ism with
// no effect under JSON Schema draft 2020-12. The port preserved it literally as
// non-nullable rather than "fixing" it, on the grounds that widening a schema
// during a migration accepts something the old one did not -- the right instinct
// while the question was only what the old document meant.
//
// It is no longer only that question. The production conformance sweep (#9879)
// called this tool and got `data: null` back, which is not our choice: the
// GraphQL spec REQUIRES `data` to be null when a request fails before execution
// begins. So the non-nullable declaration forbade a value the protocol obliges
// us to emit, and every failed query violated the contract we publish. Matching
// the protocol is a correction, not a loosening.
//
// run_saved_query's output declares `additionalProperties: false` (.strict()
// below), unlike nearly every other output schema in this epic (which are
// passthrough) -- a genuine, deliberate difference, preserved as-is.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const QueryGraphqlInputSchema = z
  .object({
    // A GraphQL DOCUMENT, not search text (#9795). This carried the search
    // tools' generic description -- "the request payload or search text this
    // surface expects" -- and their `"inference"` example, so an agent that
    // copied the example got `Syntax Error: Unexpected Name "inference"`. The
    // example below is a real query, verified against the live schema
    // alongside this file's `variables` example.
    query: z
      .string()
      .describe(
        "The GraphQL document to execute against metagraphed's schema -- a full `query { ... }` operation, not search text. Pair named variables with the sibling `variables` object; use get_api_schema to discover the available fields.",
      )
      // SELF-CONTAINED, deliberately (#9911). The previous example declared
      // `$netuid: Int!` while the matching value lived on the SEPARATE,
      // optional `variables` parameter -- so an agent copying the `query`
      // example alone got a variable-coercion error rather than a subnet. Same
      // class as the `chutes` slug example (#9860): an example is the first
      // thing an agent copies, and one that does not work teaches the wrong
      // thing AND wastes the call. Verified live 2026-08-07.
      .meta({
        examples: ["query { subnet(netuid: 64) { netuid name } }"],
      }),
    variables: OpenObjectSchema.optional()
      .describe("GraphQL variables for the query, as an object.")
      .meta({ examples: [{ netuid: 64 }] }),
  })
  .strict();
export type QueryGraphqlInput = z.infer<typeof QueryGraphqlInputSchema>;

export const QueryGraphqlOutputSchema = z
  .object({
    // Null on a request error, per the GraphQL spec -- see the header.
    data: OpenObjectSchema.nullable().optional(),
    errors: z.array(OpenObjectSchema).optional(),
  })
  .strict();
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
