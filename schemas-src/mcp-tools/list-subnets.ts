// MCP tool `list_subnets` (types-epic E pilot batch, #7863). Input is
// MCP-only filter/sort/page params over the same /metagraph/subnets.json
// index the pilot REST route (`subnets`, schemas-src/routes/subnets.ts)
// reads -- but the output is a deliberately slim 7-field-per-row projection
// (src/mcp-server.ts's own handler), not the full SubnetIndexEntry, so
// nothing here is reused from routes/subnets.ts. `status`/`subnet_type`/
// `domain` (and their `not_*` counterparts) are free-text string filters in
// the original hand-written schema -- NOT constrained to SubnetStatusSchema/
// SubnetTypeSchema's enum values -- so they stay plain z.string() here too;
// only coverage_level/curation_level/sort/order were actually enum-
// constrained on the wire, and only those reuse a shared enum.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
// The route's own filter vocabularies. These three published a bare
// `{"type":"string"}` while the route named its values, so an agent had to
// guess and a wrong guess filtered to nothing rather than erroring (#10115).
// They were unreachable until QUERY_ENUMS moved out of src/contracts.ts
// (#10131) -- importing that from here is the edge that broke the data-api
// build on #10121.
import { QUERY_ENUMS } from "../query-enums.ts";
import {
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import {
  CoverageLevelSchema,
  CurationLevelSchema,
  McpNetworkSchema,
} from "../shared.ts";

const LIST_SUBNETS_SORT_FIELDS = [
  "netuid",
  "integration_readiness",
  "surface_count",
  "name",
] as const;

export const ListSubnetsInputSchema = z
  .object({
    cursor: numericCursorSchema().optional(),
    limit: limitSchema(100, 50).optional(),
    // A SUBNET status, not a health one. This described "rows with this health
    // status" and gave `ok` as the example -- a health verdict, on a parameter
    // whose route accepts active | inactive. The prose and the example both
    // named a different parameter, and neither could be seen to be wrong while
    // the enum was a bare string (#10131).
    status: API_QUERY_COLLECTIONS.subnets.filter_schemas.status
      .optional()
      .describe("Restrict to subnets in this lifecycle state.")
      .meta({ examples: [QUERY_ENUMS.subnetStatus[0]] }),
    subnet_type: API_QUERY_COLLECTIONS.subnets.filter_schemas.subnet_type
      .optional()
      .describe("Root subnet or an application subnet.")
      .meta({ examples: ["application"] }),
    domain: API_QUERY_COLLECTIONS.subnets.filter_schemas.domain
      .optional()
      .describe("The subnet's primary domain of use.")
      .meta({ examples: ["inference"] }),
    not_status: z
      .string()
      .optional()
      .describe(
        "EXCLUDE rows with this status. Applied after any positive `status` filter, so the two can be combined.",
      )
      .meta({ examples: ["unknown"] }),
    not_subnet_type: z
      .string()
      .optional()
      .describe(
        "EXCLUDE rows with this subnet type. Applied after any positive `subnet_type` filter, so the two can be combined.",
      )
      .meta({ examples: ["root"] }),
    not_domain: z
      .string()
      .optional()
      .describe(
        "EXCLUDE rows with this domain. Applied after any positive `domain` filter, so the two can be combined.",
      )
      .meta({ examples: ["media"] }),
    coverage_level: API_QUERY_COLLECTIONS.subnets.filter_schemas.coverage_level
      .optional()
      .describe(
        "How much of the subnet is covered: on-chain data only, a manifest, or actively probed surfaces.",
      )
      .meta({ examples: [CoverageLevelSchema.options[0]] }),
    not_coverage_level: CoverageLevelSchema.optional()
      .describe(
        "EXCLUDE rows with this coverage level. Applied after any positive `coverage_level` filter, so the two can be combined.",
      )
      .meta({ examples: [CoverageLevelSchema.options[0]] }),
    curation_level: API_QUERY_COLLECTIONS.subnets.filter_schemas.curation_level
      .optional()
      .describe(
        "How the record entered the registry — native chain data, discovered candidate, community submission, or machine-derived.",
      )
      .meta({ examples: [CurationLevelSchema.options[0]] }),
    not_curation_level: CurationLevelSchema.optional()
      .describe(
        "EXCLUDE rows with this curation level. Applied after any positive `curation_level` filter, so the two can be combined.",
      )
      .meta({ examples: [CurationLevelSchema.options[0]] }),
    // The route's published names (#10018) -- GET /api/v1/subnets documents
    // these, so an agent reading our OpenAPI sends them. Canonical.
    min_integration_readiness: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Inclusive lower bound on integration-readiness score; rows below it are excluded. The name GET /api/v1/subnets publishes.",
      )
      .meta({ examples: [50] }),
    max_integration_readiness: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Inclusive upper bound on integration-readiness score; rows above it are excluded. The name GET /api/v1/subnets publishes.",
      )
      .meta({ examples: [90] }),
    // The shorter names this tool shipped with, kept so existing callers are
    // unaffected. Same field, same semantics.
    min_readiness: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Alias for `min_integration_readiness`, the name this tool shipped with.",
      )
      .meta({ examples: [50] }),
    max_readiness: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Inclusive upper bound on readiness score; rows above it are excluded.",
      )
      .meta({ examples: [100] }),
    min_surface_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on surface count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_surface_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on surface count; rows above it are excluded.",
      )
      .meta({ examples: [20] }),
    min_block: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on block height; rows below it are excluded.",
      )
      .meta({ examples: [8700000] }),
    max_block: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on block height; rows above it are excluded.",
      )
      .meta({ examples: [8783000] }),
    min_candidate_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on candidate surface count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_candidate_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on candidate surface count; rows above it are excluded.",
      )
      .meta({ examples: [20] }),
    min_mechanism_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on mechanism count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_mechanism_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on mechanism count; rows above it are excluded.",
      )
      .meta({ examples: [8] }),
    min_participant_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on participant count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_participant_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on participant count; rows above it are excluded.",
      )
      .meta({ examples: [256] }),
    min_probed_surface_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on probed surface count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_probed_surface_count: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on probed surface count; rows above it are excluded.",
      )
      .meta({ examples: [20] }),
    min_tempo: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on subnet tempo; rows below it are excluded.",
      )
      .meta({ examples: [99] }),
    max_tempo: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on subnet tempo; rows above it are excluded.",
      )
      .meta({ examples: [360] }),
    // #10014: the two simplest filters the subnets collection declares, absent
    // while thirty others were present. `min_netuid`/`max_netuid` below give a
    // RANGE; neither expresses "these three subnets".
    netuid: API_QUERY_COLLECTIONS.subnets.filter_schemas.netuid
      .optional()
      .describe("Restrict to exactly this subnet.")
      .meta({ examples: [64] }),
    // A CSV membership filter on the route (csv_filters: { netuids: "netuid" }),
    // so a STRING on the wire -- "1,7,64" -- not an array. Without it, asking
    // for three subnets is three calls or a full scan.
    // netuidListSchema() carries the bounds the route enforces: at most 128
    // ids, each at most 5 digits (a netuid is a u16). The `^\d+(,\d+)*$` this
    // declared was unbounded in count and accepted 9-digit "netuids", so the
    // tool advertised a list its own route rejects (#10115).
    netuids: API_QUERY_COLLECTIONS.subnets.filter_schemas.netuids.optional(),
    min_netuid: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on subnet id; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_netuid: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on subnet id; rows above it are excluded.",
      )
      .meta({ examples: [128] }),
    sort: sortSchema(LIST_SUBNETS_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type ListSubnetsInput = z.infer<typeof ListSubnetsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note).
const ListSubnetsRowSchema = z
  .object({
    netuid: netuidSchema().optional(),
    slug: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    subnet_type: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    integration_readiness: z.number().nullable().optional(),
    surface_count: z.int().nullable().optional(),
  })
  .passthrough();

export const ListSubnetsOutputSchema = z
  .object({
    total: z.int(),
    returned: z.int(),
    cursor: z.int(),
    limit: z.int(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
    next_cursor: z.int().nullable(),
    subnets: z.array(ListSubnetsRowSchema),
  })
  .passthrough();
export type ListSubnetsOutput = z.infer<typeof ListSubnetsOutputSchema>;
