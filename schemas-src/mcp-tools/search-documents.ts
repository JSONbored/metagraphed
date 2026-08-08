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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  McpListArtifactStamp,
  McpListPageFields,
  NotesFieldSchema,
  fieldsSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  querySchema,
  sortSchema,
} from "./shared.ts";
import { SearchIndexArtifactSchema } from "../routes/evidence-search.ts";
import { SearchArtifactSchema } from "../routes/evidence-search.ts";
import { SEARCH_DOCUMENT_TYPE_VALUES } from "../routes/evidence-search.ts";

export const ListSearchIndexInputSchema = z
  .object({
    q: querySchema().optional(),
    type: API_QUERY_COLLECTIONS.documents.filter_schemas.type
      .optional()
      .describe("Which entity kind to search over.")
      .meta({ examples: [SEARCH_DOCUMENT_TYPE_VALUES[0]] }),
    netuid: API_QUERY_COLLECTIONS.documents.filter_schemas.netuid.optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.documents.sort_fields).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSearchIndexInput = z.infer<typeof ListSearchIndexInputSchema>;

export const ListSearchIndexOutputSchema = SearchIndexArtifactSchema.pick({
  documents: true,
}).extend({
  documents: projectableRows(SearchIndexArtifactSchema.shape.documents),
  ...McpListArtifactStamp,
  ...McpListPageFields,
});
export type ListSearchIndexOutput = z.infer<typeof ListSearchIndexOutputSchema>;

export const ListSearchInputSchema = z
  .object({
    q: querySchema().optional(),
    type: API_QUERY_COLLECTIONS.documents.filter_schemas.type
      .optional()
      .describe("Which entity kind to search over.")
      .meta({ examples: [SEARCH_DOCUMENT_TYPE_VALUES[0]] }),
    netuid: API_QUERY_COLLECTIONS.documents.filter_schemas.netuid.optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.documents.sort_fields).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSearchInput = z.infer<typeof ListSearchInputSchema>;

export const ListSearchOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    // Typed from the route's own SearchArtifactSchema (#9797), PARTIAL
    // because this tool advertises `fields` (#9884). Verified against
    // production 2026-08-07, whole and projected.
    documents: z.array(SearchArtifactSchema.shape.documents.element.partial()),
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
