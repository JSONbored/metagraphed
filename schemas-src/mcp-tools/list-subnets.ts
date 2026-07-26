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
const LIST_SUBNETS_ORDERS = ["asc", "desc"] as const;

export const ListSubnetsInputSchema = z
  .object({
    cursor: z.int().min(0).optional(),
    limit: z.int().min(1).max(100).optional(),
    status: z.string().optional(),
    subnet_type: z.string().optional(),
    domain: z.string().optional(),
    not_status: z.string().optional(),
    not_subnet_type: z.string().optional(),
    not_domain: z.string().optional(),
    coverage_level: CoverageLevelSchema.optional(),
    not_coverage_level: CoverageLevelSchema.optional(),
    curation_level: CurationLevelSchema.optional(),
    not_curation_level: CurationLevelSchema.optional(),
    min_readiness: z.int().min(0).max(100).optional(),
    max_readiness: z.int().min(0).max(100).optional(),
    min_surface_count: z.int().min(0).optional(),
    max_surface_count: z.int().min(0).optional(),
    min_block: z.number().optional(),
    max_block: z.number().optional(),
    min_candidate_count: z.int().min(0).optional(),
    max_candidate_count: z.int().min(0).optional(),
    min_mechanism_count: z.int().min(0).optional(),
    max_mechanism_count: z.int().min(0).optional(),
    min_participant_count: z.int().min(0).optional(),
    max_participant_count: z.int().min(0).optional(),
    min_probed_surface_count: z.int().min(0).optional(),
    max_probed_surface_count: z.int().min(0).optional(),
    min_tempo: z.int().min(0).optional(),
    max_tempo: z.int().min(0).optional(),
    min_netuid: z.int().min(0).optional(),
    max_netuid: z.int().min(0).optional(),
    sort: z.enum(LIST_SUBNETS_SORT_FIELDS).optional(),
    order: z.enum(LIST_SUBNETS_ORDERS).optional(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type ListSubnetsInput = z.infer<typeof ListSubnetsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note).
const ListSubnetsRowSchema = z
  .object({
    netuid: z.int().optional(),
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
