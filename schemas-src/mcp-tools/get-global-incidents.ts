// MCP tool `get_global_incidents`.
// Mirrors GET /api/v1/incidents.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_global_incidents: 3 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  limitSchema,
  numericCursorSchema,
  orderSchema,
  sortSchema,
  windowSchema,
} from "./shared.ts";
import { GlobalIncidentsArtifactSchema } from "../routes/health-surfaces.ts";

// Symbolic in the hand-written original (src/contracts.ts's
// API_QUERY_COLLECTIONS.incidents.sort_fields), cross-checked against the
// actual runtime array at the time of writing.

export const GetGlobalIncidentsInputSchema = z
  .object({
    window: windowSchema(["7d", "30d"]).optional(),
    netuid: API_QUERY_COLLECTIONS.incidents.filter_schemas.netuid.optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.incidents.sort_fields).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type GetGlobalIncidentsInput = z.infer<
  typeof GetGlobalIncidentsInputSchema
>;

export const GetGlobalIncidentsOutputSchema = GlobalIncidentsArtifactSchema;
export type GetGlobalIncidentsOutput = z.infer<
  typeof GetGlobalIncidentsOutputSchema
>;
