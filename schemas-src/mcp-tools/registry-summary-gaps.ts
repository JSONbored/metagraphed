// MCP tools `registry_summary`, `list_enrichment_targets`, `get_subnet_gaps`,
// `list_subnet_gaps` (types-epic E batch 12, #8075). The first three are
// defined inline in src/mcp-server.ts's MCP_TOOLS array; `list_subnet_gaps`
// lives in its own src/subnet-gaps-mcp.ts (its `LIST_SUBNET_GAPS_MCP_TOOL`/
// `LIST_SUBNET_GAPS_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS
// array). None mirror an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import {
  OpenObjectSchema,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";

export const RegistrySummaryInputSchema = z.object({}).strict();
export type RegistrySummaryInput = z.infer<typeof RegistrySummaryInputSchema>;

export const RegistrySummaryOutputSchema = z
  .object({
    subnet_count: z.int(),
    counts: OpenObjectSchema,
    coverage: OpenObjectSchema.optional(),
    curation_level_counts: OpenObjectSchema.optional(),
    profile_level_counts: OpenObjectSchema.optional(),
    recent_changes: OpenObjectSchema.optional(),
    top_subnets: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type RegistrySummaryOutput = z.infer<typeof RegistrySummaryOutputSchema>;

// Symbolic in the hand-written original (src/contracts.ts's
// QUERY_ENUMS.agentReadinessStatus and mcp-server.ts's own
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES constants), cross-checked
// against the actual runtime source at the time of writing.
const COVERAGE_DEPTH_TIERS = [
  "agent-ready",
  "machine-usable",
  "candidate-review",
  "needs-evidence",
  "hard-blocked",
  "missing-interface",
] as const;
const COVERAGE_DEPTH_SEVERITIES = [
  "hard",
  "missing-data",
  "needs-review",
] as const;
const AGENT_READINESS_STATUSES = [
  "callable",
  "base-layer",
  "candidate",
  "needs-evidence",
  "blocked",
] as const;

export const ListEnrichmentTargetsInputSchema = z
  .object({
    limit: limitSchema(50).optional(),
    tier: z
      .enum(COVERAGE_DEPTH_TIERS)
      .optional()
      .describe("How agent-ready the subnet is."),
    severity: z
      .enum(COVERAGE_DEPTH_SEVERITIES)
      .optional()
      .describe("How serious the incident is."),
    gap_code: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe(
        "The machine-readable gap identifier (`missing-openapi`), lowercase " +
          "and hyphenated — not the human-readable label shown beside it.",
      ),
    agent_status: z
      .enum(AGENT_READINESS_STATUSES)
      .optional()
      .describe("How usable the subnet is to an agent right now."),
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
    top_gaps: z.array(OpenObjectSchema).optional(),
    recommended_next_action: z.string().nullable().optional(),
    dimensions: OpenObjectSchema.optional(),
  })
  .passthrough();

export const ListEnrichmentTargetsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    coverage_depth_version: z.unknown().optional(),
    total_rows: z.int(),
    queue_count: z.int(),
    returned: z.int(),
    filters: OpenObjectSchema.optional(),
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
    priorities: z.array(OpenObjectSchema),
    enrichment_queue: z.array(OpenObjectSchema),
  })
  .passthrough();
export type GetSubnetGapsOutput = z.infer<typeof GetSubnetGapsOutputSchema>;

const CURATION_LEVELS = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const SURFACE_KINDS = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
] as const;
// The REST route pages this artifact through the review-gap-priorities
// collection (rows live under `priorities`), not the network-wide `gaps`
// collection -- same sort fields as list_review_gaps (batch 10, #8074).
const GAP_PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
] as const;

export const ListSubnetGapsInputSchema = z
  .object({
    netuid: netuidSchema(),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    missing_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
      ),
    review_state: z
      .string()
      .optional()
      .describe("Where the item sits in maintainer review."),
    sort: sortSchema(GAP_PRIORITY_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetGapsInput = z.infer<typeof ListSubnetGapsInputSchema>;

export const ListSubnetGapsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    priorities: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetGapsOutput = z.infer<typeof ListSubnetGapsOutputSchema>;
