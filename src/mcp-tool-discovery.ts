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
    cursor: CursorSchema.optional().describe(
      "Unchanged next_cursor from the previous page; omit to start a search.",
    ),
  })
  .strict();

export const SearchToolsOutputSchema = z
  .object({
    tools: z.array(z.record(z.string(), z.unknown())).max(3),
    total: z.int().min(0),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const InvokeToolInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/)
      .describe("Exact discovered tool name. invoke_tool cannot invoke itself.")
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
export const InvokeToolOutputSchema = z.record(z.string(), z.unknown());

export function searchToolDefinitions<
  T extends { name: string; title: string; description: string },
>(
  tools: readonly T[],
  input: z.infer<typeof SearchToolsInputSchema>,
  version: string,
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
          `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      });
  const page = matches.slice(offset, offset + 3);
  const next = offset + page.length;
  return {
    tools: page,
    total: matches.length,
    next_cursor:
      next < matches.length ? { version, query, offset: next } : null,
  };
}
