// MCP tools `list_fixtures`, `list_schemas` (types-epic E batch 11, #8074).
// Both are defined inline in src/mcp-server.ts's MCP_TOOLS array, take no
// input, and mirror GET /api/v1/fixtures and GET /api/v1/schemas
// respectively. Neither mirrors an existing schemas-src/routes/ REST schema
// -- modeled fresh, matching each hand-written literal field-for-field.
// `list_schemas`' `notes` is a PLAIN nullable string, unlike the
// array-or-string-or-null `notes` shape most of this batch's other list_*
// tools use (see shared.ts's NotesFieldSchema) -- a genuine, deliberate
// difference, not something to "fix" to match its siblings.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const ListFixturesInputSchema = z.object({}).strict();
export type ListFixturesInput = z.infer<typeof ListFixturesInputSchema>;

export const ListFixturesOutputSchema = z
  .object({
    candidate_count: z.int().optional(),
    coverage: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type ListFixturesOutput = z.infer<typeof ListFixturesOutputSchema>;

export const ListSchemasInputSchema = z.object({}).strict();
export type ListSchemasInput = z.infer<typeof ListSchemasInputSchema>;

export const ListSchemasOutputSchema = z
  .object({
    schemas: z.array(OpenObjectSchema).optional(),
    observed_at: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSchemasOutput = z.infer<typeof ListSchemasOutputSchema>;
