import { z } from "zod";

const CursorSchema = z
  .object({
    version: z
      .string()
      .min(1)
      .max(128)
      .describe("Catalog deployment identity.")
      .meta({ examples: ["deployment-id"] }),
    query: z
      .string()
      .min(1)
      .max(200)
      .describe("Normalized query this cursor continues.")
      .meta({ examples: ["account"] }),
    offset: z
      .int()
      .min(0)
      .max(10000)
      .describe("Next result offset in that catalog.")
      .meta({ examples: [3] }),
  })
  .strict();

export const SearchToolsInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Exact tool name or words describing the task, for example account history.",
      )
      .meta({ examples: ["get_account_history"] }),
    cursor: CursorSchema.optional()
      .describe(
        "Unchanged next_cursor from the previous page; omit to start a search.",
      )
      .meta({
        examples: [
          { version: "current-deployment-id", query: "account", offset: 3 },
        ],
      }),
  })
  .strict();

const JsonDocumentSchema = z.record(z.string(), z.json());
const ToolDefinitionSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    inputSchema: JsonDocumentSchema,
    outputSchema: JsonDocumentSchema.optional(),
    annotations: z
      .object({
        readOnlyHint: z.boolean(),
        destructiveHint: z.boolean(),
        idempotentHint: z.boolean(),
        openWorldHint: z.boolean(),
      })
      .strict(),
    execution: z.object({ taskSupport: z.literal("forbidden") }).strict(),
    _meta: z
      .object({ "metagraph.sh/auth_required": z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

export const SearchToolsOutputSchema = z
  .object({
    tools: z.array(ToolDefinitionSchema).max(3),
    total: z.int().min(0),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const InvokeToolInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/)
      .describe(
        "Exact discovered tool name. Invocation bridges cannot invoke each other.",
      )
      .meta({ examples: ["get_more_tools"] }),
    arguments: z
      .record(z.string(), z.unknown())
      .describe(
        "Arguments matching the discovered inputSchema; target validation and permissions apply.",
      )
      .meta({ examples: [{}] }),
  })
  .strict();

// The result is the target tool's complete structuredContent, described by the
// exact outputSchema returned by search_tools. No target fields are projected.
export const InvokeToolOutputSchema = JsonDocumentSchema;

export type SearchToolsPageSize = 1 | 2 | 3;

// Opt-in endpoint configuration leaves tool schemas and existing clients intact.
export function searchToolsPageSizeForUrl(url: URL): SearchToolsPageSize {
  const size = url.searchParams.get("search_page_size");
  return size === "1" ? 1 : size === "2" ? 2 : 3;
}

export function searchToolDefinitions<
  T extends { name: string; title: string; description: string },
>(
  tools: readonly T[],
  input: z.infer<typeof SearchToolsInputSchema>,
  version: string,
  pageSize: SearchToolsPageSize = 3,
  descriptionSuffix = "",
) {
  const query = input.query.toLowerCase();
  if (
    input.cursor &&
    (input.cursor.version !== version || input.cursor.query !== query)
  ) {
    throw new Error(
      "Tool catalog or query changed; restart search_tools without cursor.",
    );
  }
  const offset = input.cursor?.offset ?? 0;
  const exact = tools.filter((tool) => tool.name === query);
  const terms = query.split(/[\s_]+/);
  const matches = exact.length
    ? exact
    : tools.filter((tool) => {
        const text =
          `${tool.name} ${tool.title} ${tool.description}${descriptionSuffix}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      });
  const page = matches.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    tools: page,
    total: matches.length,
    next_cursor:
      next < matches.length ? { version, query, offset: next } : null,
  };
}
