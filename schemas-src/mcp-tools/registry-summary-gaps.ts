// MCP tools `registry_summary`, `list_enrichment_targets`, `get_subnet_gaps`,
// `list_subnet_gaps` (types-epic E batch 12, #8075). The first three are
// defined inline in src/mcp-server.ts's MCP_TOOLS array; `list_subnet_gaps`
// lives in its own src/subnet-gaps-mcp.ts (its `LIST_SUBNET_GAPS_MCP_TOOL`/
// `LIST_SUBNET_GAPS_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). None mirror an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import { RegistrySummaryArtifactSchema } from "../routes/registry-summary-leaderboards.ts";
import {
  McpListPageFields,
  McpSubnetListArtifactStamp,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  sortSchema,
} from "./shared.ts";
import { SubnetGapsArtifactSchema } from "../routes/review-gaps-profile.ts";
import { SURFACE_KIND_VALUES } from "../routes/subnet-detail.ts";
import { CURATION_LEVEL_VALUES } from "../shared.ts";
import {
  AgentReadinessBlockerSchema,
  CoverageDepthDimensionsSchema,
} from "../routes/coverage.ts";
import {
  AGENT_READINESS_STATUSES,
  BLOCKER_LEVELS,
  COVERAGE_DEPTH_SEVERITIES,
  COVERAGE_DEPTH_TIERS,
} from "../routes/coverage.ts";
import { PRIORITY_SORT_FIELDS } from "../routes/review-gaps-profile.ts";

export const RegistrySummaryInputSchema = z.object({}).strict();
export type RegistrySummaryInput = z.infer<typeof RegistrySummaryInputSchema>;

// DERIVED, NOT COPIED (#9796). The copy published counts, coverage,
// curation_level_counts and profile_level_counts as bare open objects -- the
// four tallies this tool exists to report.
export const RegistrySummaryOutputSchema = RegistrySummaryArtifactSchema;
export type RegistrySummaryOutput = z.infer<typeof RegistrySummaryOutputSchema>;

// Symbolic in the hand-written original (src/contracts.ts's
// QUERY_ENUMS.agentReadinessStatus and mcp-server.ts's own
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES constants), cross-checked
// against the actual runtime source at the time of writing.
export const ListEnrichmentTargetsInputSchema = z
  .object({
    limit: limitSchema(50).optional(),
    tier: z
      .enum(COVERAGE_DEPTH_TIERS)
      .optional()
      .describe("How agent-ready the subnet is.")
      .meta({ examples: [COVERAGE_DEPTH_TIERS[0]] }),
    severity: z
      .enum(COVERAGE_DEPTH_SEVERITIES)
      .optional()
      .describe("How serious the incident is.")
      .meta({ examples: [COVERAGE_DEPTH_SEVERITIES[0]] }),
    gap_code: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe(
        "The machine-readable gap identifier (`missing-openapi`), lowercase " +
          "and hyphenated — not the human-readable label shown beside it.",
      )
      .meta({ examples: ["missing-openapi"] }),
    agent_status: z
      .enum(AGENT_READINESS_STATUSES)
      .optional()
      .describe("How usable the subnet is to an agent right now.")
      .meta({ examples: [AGENT_READINESS_STATUSES[0]] }),
    // #10011: the fourth filter the coverage-depth collection declares. Its
    // three siblings above were already here, so this one's absence was an
    // omission rather than a narrowing.
    blocker_level: z
      .enum(BLOCKER_LEVELS)
      .optional()
      .describe(
        "How badly the subnet is blocked. `none` means nothing is blocking promotion.",
      )
      .meta({ examples: ["hard-blocked"] }),
    netuid: netuidSchema().optional(),
  })
  .strict();
export type ListEnrichmentTargetsInput = z.infer<
  typeof ListEnrichmentTargetsInputSchema
>;

const EnrichmentTargetItemSchema = z
  .object({
    rank: z.int().nullable().optional(),
    netuid: netuidSchema().optional(),
    slug: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    tier: z.string().optional(),
    score: z.int().optional(),
    priority_score: z.int().optional(),
    agent_status: z.string().optional(),
    blocker_level: z.string().optional(),
    top_gap_codes: z.array(z.unknown()).optional(),
    // DERIVED AS A SUBSET, not restated (#9797). This tool is the FILTERED
    // companion of get_coverage_depth's raw passthrough, and it publishes a
    // narrower view of the same two shapes -- `top_gaps` without the prose
    // `message`, `dimensions` with 11 of the row's 18 counters. Both were
    // censused across 50 live targets on 2026-08-07: every listed key present
    // on every row, and every one a member of the route's own schema. `omit`
    // and `pick` state that relationship, so a route field rename still lands
    // here as a compile error the way a full derivation would.
    top_gaps: z
      .array(AgentReadinessBlockerSchema.omit({ message: true }))
      .optional(),
    recommended_next_action: z.string().nullable().optional(),
    dimensions: CoverageDepthDimensionsSchema.pick({
      callable_service_count: true,
      candidate_operational_count: true,
      example_count: true,
      fixture_available_count: true,
      fixture_status_counts: true,
      official_surface_count: true,
      provider_claimed_surface_count: true,
      schema_missing_count: true,
      schema_service_count: true,
      sdk_count: true,
      service_kinds: true,
    }).optional(),
  })
  .passthrough();

export const ListEnrichmentTargetsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    coverage_depth_version: z.unknown().optional(),
    total_rows: z.int(),
    queue_count: z.int(),
    returned: z.int(),
    // The filter set ECHOED back, one key per filtering input parameter, each
    // null when it was not supplied. Modeled from the tool's own inputSchema
    // rather than from a capture: the echo exists to tell a caller what was
    // applied, so its keys ARE the parameters and a new filter must appear in
    // both places or the echo is lying. Verified against production
    // 2026-08-07.
    filters: z
      .object({
        tier: z.string().nullable(),
        severity: z.string().nullable(),
        gap_code: z.string().nullable(),
        agent_status: z.string().nullable(),
        netuid: z.int().min(0).nullable(),
      })
      .passthrough()
      .optional(),
    note: z.string().optional(),
    targets: z.array(EnrichmentTargetItemSchema),
  })
  .passthrough();
export type ListEnrichmentTargetsOutput = z.infer<
  typeof ListEnrichmentTargetsOutputSchema
>;

export const GetSubnetGapsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetGapsInput = z.infer<typeof GetSubnetGapsInputSchema>;

export const GetSubnetGapsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    contract_version: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema(),
    slug: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    // Typed from the route's own SubnetGapsArtifactSchema (#9797) --
    // routes/review-gaps-profile.ts, which is what
    // /api/v1/subnets/{netuid}/gaps resolves to in openapi.json. An earlier
    // attempt tested these against coverage.ts's CoverageDepth schemas on a
    // filename guess and they failed; resolving the route through its
    // published $ref finds the right one. Verified against production
    // 2026-08-07.
    priorities: SubnetGapsArtifactSchema.shape.priorities,
    enrichment_queue: SubnetGapsArtifactSchema.shape.enrichment_queue,
  })
  .passthrough();
export type GetSubnetGapsOutput = z.infer<typeof GetSubnetGapsOutputSchema>;

const CURATION_LEVELS = CURATION_LEVEL_VALUES;
const SURFACE_KINDS = SURFACE_KIND_VALUES;
// The REST route pages this artifact through the review-gap-priorities
// collection (rows live under `priorities`), not the network-wide `gaps`
// collection -- same sort fields as list_review_gaps (batch 10, #8074).
export const ListSubnetGapsInputSchema = z
  .object({
    netuid: netuidSchema(),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    missing_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    review_state: z
      .string()
      .optional()
      .describe("Where the item sits in maintainer review.")
      .meta({ examples: ["pending"] }),
    sort: sortSchema(PRIORITY_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetGapsInput = z.infer<typeof ListSubnetGapsInputSchema>;

export const ListSubnetGapsOutputSchema = SubnetGapsArtifactSchema.pick({
  netuid: true,
  priorities: true,
}).extend({
  priorities: projectableRows(SubnetGapsArtifactSchema.shape.priorities),
  ...McpSubnetListArtifactStamp,
  ...McpListPageFields,
});
export type ListSubnetGapsOutput = z.infer<typeof ListSubnetGapsOutputSchema>;
