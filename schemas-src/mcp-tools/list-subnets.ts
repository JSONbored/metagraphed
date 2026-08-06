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
    limit: limitSchema(100).optional(),
    status: z
      .string()
      .optional()
      .describe("Restrict to rows with this health status.")
      .meta({ examples: ["ok"] }),
    subnet_type: z
      .string()
      .optional()
      .describe("Root subnet or an application subnet.")
      .meta({ examples: ["application"] }),
    domain: z
      .string()
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
    coverage_level: CoverageLevelSchema.optional()
      .describe(
        "How much of the subnet is covered: on-chain data only, a manifest, or actively probed surfaces.",
      )
      .meta({ examples: [CoverageLevelSchema.options[0]] }),
    not_coverage_level: CoverageLevelSchema.optional()
      .describe(
        "EXCLUDE rows with this coverage level. Applied after any positive `coverage_level` filter, so the two can be combined.",
      )
      .meta({ examples: [CoverageLevelSchema.options[0]] }),
    curation_level: CurationLevelSchema.optional()
      .describe(
        "How the record entered the registry — native chain data, discovered candidate, community submission, or machine-derived.",
      )
      .meta({ examples: [CurationLevelSchema.options[0]] }),
    not_curation_level: CurationLevelSchema.optional()
      .describe(
        "EXCLUDE rows with this curation level. Applied after any positive `curation_level` filter, so the two can be combined.",
      )
      .meta({ examples: [CurationLevelSchema.options[0]] }),
    min_readiness: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Inclusive lower bound on readiness score; rows below it are excluded.",
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
