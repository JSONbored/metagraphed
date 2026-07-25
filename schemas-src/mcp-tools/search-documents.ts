// MCP tools `list_search_index`, `list_search` (types-epic E batch 11,
// #8074). Neither is defined inline in src/mcp-server.ts -- their
// `LIST_X_MCP_TOOL`/`LIST_X_OUTPUT_SCHEMA` hand-written literals live in
// src/search-index-mcp.ts and src/search-mcp.ts respectively, imported into
// mcp-server.ts's MCP_TOOLS array via object spread. The z.toJSONSchema(...)
// wiring for these two happens in THEIR OWN files, not mcp-server.ts.
// Identical input/output shape (same filters, same "documents" output key)
// -- list_search serves the full documents WITH token blobs where
// list_search_index serves the slim variant without them, a runtime-data
// difference only, not a schema one. Neither mirrors an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
import { z } from "zod";
import { OpenObjectSchema, NotesFieldSchema } from "./shared.ts";

const DOCUMENT_TYPES = ["subnet", "surface", "provider"] as const;
const DOCUMENT_SORT_FIELDS = ["netuid", "slug", "title", "type"] as const;

export const ListSearchIndexInputSchema = z
  .object({
    q: z.string().optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    netuid: z.int().min(0).optional(),
    sort: z.enum(DOCUMENT_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSearchIndexInput = z.infer<typeof ListSearchIndexInputSchema>;

export const ListSearchIndexOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    documents: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSearchIndexOutput = z.infer<typeof ListSearchIndexOutputSchema>;

export const ListSearchInputSchema = z
  .object({
    q: z.string().optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    netuid: z.int().min(0).optional(),
    sort: z.enum(DOCUMENT_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSearchInput = z.infer<typeof ListSearchInputSchema>;

export const ListSearchOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    documents: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSearchOutput = z.infer<typeof ListSearchOutputSchema>;
