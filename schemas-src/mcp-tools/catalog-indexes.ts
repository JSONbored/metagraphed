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
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import {
  offsetSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { FixturesIndexArtifactSchema } from "../routes/fixtures.ts";
import { SchemaIndexArtifactSchema } from "../routes/subnet-profiles.ts";

export const ListFixturesInputSchema = z
  .object({
    // The page (#10605). Both numbers come from the constants that actually
    // decide them: MAX_LIMIT is the ceiling listQuerySchema gives every list
    // route, and MCP_LIST_LIMIT_DEFAULT is the default applyMcpQueryFilters
    // really applies -- published rather than hidden, because #10101 found 83
    // tools whose schema left a caller unable to tell what an omitted
    // limit returns. Publishing the ceiling while hiding the default would
    // recreate exactly that gap.
    limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
    // An integer OFFSET, which is what these routes publish
    // (`{minimum: 0, type: integer}`) -- not the keyset cursor. Conflating the
    // two is the mistake query-params.ts calls out by name.
    cursor: offsetSchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.fixtures.sort_fields).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type ListFixturesInput = z.infer<typeof ListFixturesInputSchema>;

export const ListFixturesOutputSchema = FixturesIndexArtifactSchema;
export type ListFixturesOutput = z.infer<typeof ListFixturesOutputSchema>;

export const ListSchemasInputSchema = z.object({}).strict();
export type ListSchemasInput = z.infer<typeof ListSchemasInputSchema>;

export const ListSchemasOutputSchema = SchemaIndexArtifactSchema;
export type ListSchemasOutput = z.infer<typeof ListSchemasOutputSchema>;
