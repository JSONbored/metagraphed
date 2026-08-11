// MCP tools `get_subnet_candidates`, `get_subnet_evidence`,
// `get_subnet_surfaces`.
// Mirror GET /api/v1/subnets/{netuid}/candidates, GET
// /api/v1/subnets/{netuid}/evidence, GET /api/v1/subnets/{netuid}/surfaces.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_candidates: 1 bare `{"type":"object"}` site.
//   get_subnet_evidence: 1 bare `{"type":"object"}` site.
//   get_subnet_surfaces: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  idFilterSchema,
  McpListPageFields,
  McpSubnetListArtifactStamp,
  kindSchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  querySchema,
  sortSchema,
  McpUnsortedPageFields,
  McpSortableListPage,
} from "./shared.ts";
import {
  SubnetCandidatesArtifactSchema,
  SubnetEvidenceArtifactSchema,
} from "../routes/candidates-evidence.ts";
import { SubnetSurfacesArtifactSchema } from "../routes/endpoints-pools.ts";
import {
  CANDIDATE_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import { CONFIDENCE_LEVEL_VALUES } from "../shared.ts";
// #9998: the per-subnet views below are these two with `netuid` moved from an
// optional filter to the required subject.
import {
  ListCandidatesInputSchema,
  ListSurfacesInputSchema,
} from "./registry-catalogs-1.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING (#9998). See
 * GetSubnetSurfacesInputSchema below for the reasoning -- the per-subnet view
 * is list_candidates with `netuid` moved from an optional FILTER to the
 * required SUBJECT.
 */
export const GetSubnetCandidatesInputSchema = ListCandidatesInputSchema.omit({
  netuid: true,
})
  .extend({ netuid: netuidSchema() })
  .strict();
export type GetSubnetCandidatesInput = z.infer<
  typeof GetSubnetCandidatesInputSchema
>;

// #10064 production sweep: this tool advertises `fields`, so a caller can ask
// for a SUBSET of each row -- and the artifact schema requires every property
// on it. Production answered `?fields=` with rows that failed the tool's own
// published schema; `projectableRows` is the convention the sibling tools
// already use. Field names and types still come from the route, so a rename
// there is still a compile error here; only requiredness changes, because the
// caller controls it.
export const GetSubnetCandidatesOutputSchema =
  SubnetCandidatesArtifactSchema.extend({
    // The page block the MCP loader adds on top of the route's artifact --
    // undeclared until #10790, when `.strict()` first rejected it.
    ...McpUnsortedPageFields,
    candidates: projectableRows(
      SubnetCandidatesArtifactSchema.shape.candidates,
    ),
  });
export type GetSubnetCandidatesOutput = z.infer<
  typeof GetSubnetCandidatesOutputSchema
>;

const CANDIDATE_STATES = CANDIDATE_STATE_VALUES;
export const ListSubnetCandidatesInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: API_QUERY_COLLECTIONS.candidates.filter_schemas.state
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [CANDIDATE_STATES[0]] }),
    id: idFilterSchema().optional(),
    confidence: API_QUERY_COLLECTIONS.candidates.filter_schemas.confidence
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVEL_VALUES[0]] }),
    sort: sortSchema(API_QUERY_COLLECTIONS.candidates.sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListSubnetCandidatesInput = z.infer<
  typeof ListSubnetCandidatesInputSchema
>;

export const ListSubnetCandidatesOutputSchema =
  SubnetCandidatesArtifactSchema.pick({
    netuid: true,
    candidates: true,
  }).extend({
    candidates: projectableRows(
      SubnetCandidatesArtifactSchema.shape.candidates,
    ),
    ...McpSubnetListArtifactStamp,
    ...McpListPageFields,
  });
export type ListSubnetCandidatesOutput = z.infer<
  typeof ListSubnetCandidatesOutputSchema
>;

/**
 * #10793. This took `netuid` alone and returned the whole ledger -- measured at
 * 77 claims / ~33 KB for SN64, with no pagination block in the response at all,
 * while GET /api/v1/subnets/{netuid}/evidence publishes `q`, `sort`, `order`,
 * `limit` and `cursor`. The same no-lever shape #10011 found on
 * get_coverage_depth (293 KB, zero arguments) and #10027 resolved by giving it
 * a page.
 *
 * The four are NOT copied from the sibling below: both read the `claims`
 * collection, so both take their vocabulary from it, and a search key or sort
 * column added there reaches the two tools together.
 */
export const GetSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
    q: querySchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.claims.sort_fields).optional(),
    order: orderSchema().optional(),
    // Both numbers come from the constants that DECIDE them, not from the
    // sibling's literals. This handler runs applySubnetListQuery, so the
    // ceiling is whatever the route publishes -- MAX_LIMIT, since
    // validateListQuery reads the bound off the published schema -- and the
    // default is the one applyMcpQueryFilters really supplies. Restating the
    // sibling's `limitSchema(100, 20)` would advertise a ceiling this handler
    // does not enforce: `limit: 200` is served, not rejected.
    limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
    // An integer OFFSET, which is what this route publishes
    // (`{minimum: 0, type: integer}`) -- not the keyset cursor.
    cursor: offsetSchema().optional(),
  })
  .strict();
export type GetSubnetEvidenceInput = z.infer<
  typeof GetSubnetEvidenceInputSchema
>;

// Extended with the page fields the handler now returns. Left as the full
// artifact rather than narrowed to the sibling's `pick({netuid, claims})`: this
// tool has always returned `name`, `slug` and `generated_at` too, and dropping
// them to share a schema would break callers for tidiness.
//
// FIVE fields, not McpListPageFields' seven. applySubnetListQuery lifts
// total/returned/cursor/limit/next_cursor out of the engine's pagination block
// and does not lift `sort`/`order`, so spreading the shared group here would
// declare two fields this handler never emits -- the sibling below carries all
// seven because its loader really does return them.
//
// Optional because the lift is conditional on the engine having produced a
// pagination block at all; a required field the handler can omit is a schema
// that fails on its own output.
export const GetSubnetEvidenceOutputSchema =
  SubnetEvidenceArtifactSchema.extend({
    total: McpListPageFields.total.optional(),
    returned: McpListPageFields.returned.optional(),
    limit: McpListPageFields.limit.optional(),
    cursor: McpListPageFields.cursor.optional(),
    next_cursor: McpListPageFields.next_cursor.optional(),
  });
export type GetSubnetEvidenceOutput = z.infer<
  typeof GetSubnetEvidenceOutputSchema
>;

export const ListSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
    q: querySchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.claims.sort_fields).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListSubnetEvidenceInput = z.infer<
  typeof ListSubnetEvidenceInputSchema
>;

export const ListSubnetEvidenceOutputSchema = SubnetEvidenceArtifactSchema.pick(
  {
    netuid: true,
    claims: true,
  },
).extend({
  claims: projectableRows(SubnetEvidenceArtifactSchema.shape.claims),
  ...McpSubnetListArtifactStamp,
  ...McpListPageFields,
});
export type ListSubnetEvidenceOutput = z.infer<
  typeof ListSubnetEvidenceOutputSchema
>;

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING, NOT DECLARED FRESH (#9998).
 *
 * This took `netuid` alone, so an agent could not filter or page a subnet's
 * surfaces at all while any REST caller could -- and it is 159 KB precisely
 * because it could not pass a `limit`.
 *
 * Expressed as the network-wide schema with `netuid` moved from an optional
 * FILTER to the required SUBJECT, rather than restating filters that would
 * then be free to drift from the list tool serving the same collection.
 */
export const GetSubnetSurfacesInputSchema = ListSurfacesInputSchema.omit({
  netuid: true,
})
  .extend({ netuid: netuidSchema() })
  .strict();
export type GetSubnetSurfacesInput = z.infer<
  typeof GetSubnetSurfacesInputSchema
>;

// #10064 production sweep: this tool advertises `fields`, so a caller can ask
// for a SUBSET of each row -- and the artifact schema requires every property
// on it. Production answered `?fields=` with rows that failed the tool's own
// published schema; `projectableRows` is the convention the sibling tools
// already use. Field names and types still come from the route, so a rename
// there is still a compile error here; only requiredness changes, because the
// caller controls it.
export const GetSubnetSurfacesOutputSchema =
  SubnetSurfacesArtifactSchema.extend({
    // The page block the MCP loader adds on top of the route's artifact --
    // undeclared until #10790, when `.strict()` first rejected it.
    ...McpUnsortedPageFields,
    surfaces: projectableRows(SubnetSurfacesArtifactSchema.shape.surfaces),
  });
export type GetSubnetSurfacesOutput = z.infer<
  typeof GetSubnetSurfacesOutputSchema
>;
