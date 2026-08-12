// MCP tools `list_fixtures`, `list_schemas`.
// Mirror GET /api/v1/fixtures, GET /api/v1/schemas.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   list_fixtures: 1 bare `{"type":"object"}` site.
//   list_schemas: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
  McpOffsetPageInput,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { FixturesIndexArtifactSchema } from "../routes/fixtures.ts";
import { SchemaIndexArtifactSchema } from "../routes/subnet-profiles.ts";

export const ListFixturesInputSchema = z
  .object({
    ...McpOffsetPageInput,
    sort: sortSchema(API_QUERY_COLLECTIONS.fixtures.sort_fields).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type ListFixturesInput = z.infer<typeof ListFixturesInputSchema>;

export const ListFixturesOutputSchema = FixturesIndexArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpUnsortedPageFields,
});
export type ListFixturesOutput = z.infer<typeof ListFixturesOutputSchema>;

export const ListSchemasInputSchema = z.object({}).strict();
export type ListSchemasInput = z.infer<typeof ListSchemasInputSchema>;

export const ListSchemasOutputSchema = SchemaIndexArtifactSchema;
export type ListSchemasOutput = z.infer<typeof ListSchemasOutputSchema>;
