// MCP tools `list_enrichment_evidence`, `list_review_gaps`,
// `list_review_enrichment_targets` (types-epic E batch 11, #8074). None are
// defined inline in src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/
// `LIST_X_OUTPUT_SCHEMA` hand-written literals live in
// src/enrichment-evidence-mcp.ts, src/review-gaps-mcp.ts, and
// src/review-enrichment-targets-mcp.ts respectively, imported into
// mcp-server.ts's MCP_TOOLS array via object spread. The z.toJSONSchema(...)
// wiring for these three happens in THEIR OWN files, not mcp-server.ts. None
// mirror an existing schemas-src/routes/ REST schema -- modeled fresh,
// matching each hand-written literal field-for-field.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  reasonCodesSchema,
  reviewStateSchema,
  McpListArtifactStamp,
  McpListPageFields,
  kindSchema,
  projectableRows,
  querySchema,
  sortSchema,
  McpSortableListPage,
} from "./shared.ts";
import {
  REVIEW_ENRICHMENT_LANE_VALUES,
  REVIEW_ENRICHMENT_SUBMISSION_ROUTE_VALUES,
  REVIEW_ENRICHMENT_TARGET_ACTION_VALUES,
  REVIEW_ENRICHMENT_TARGET_TYPE_VALUES,
  REVIEW_EVIDENCE_ACTION_VALUES,
  ReviewEnrichmentEvidenceArtifactSchema,
} from "../routes/review-enrichment.ts";
import { ReviewGapPrioritiesArtifactSchema } from "../routes/review-gaps-profile.ts";
import { ReviewEnrichmentTargetsArtifactSchema } from "../routes/review-enrichment.ts";
import { SURFACE_KIND_VALUES } from "../routes/subnet-detail.ts";
import { CURATION_LEVEL_VALUES } from "../shared.ts";
import {} from "../routes/review-enrichment.ts";
import { PRIORITY_SORT_FIELDS } from "../routes/review-gaps-profile.ts";
import { IDENTITY_LEVEL_VALUES, PROFILE_LEVEL_VALUES } from "../shared.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const EVIDENCE_ACTIONS = REVIEW_EVIDENCE_ACTION_VALUES;
const LANES = REVIEW_ENRICHMENT_LANE_VALUES;
export const ListEnrichmentEvidenceInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid:
      API_QUERY_COLLECTIONS[
        "enrichment-evidence"
      ].filter_schemas.netuid.optional(),
    lane: API_QUERY_COLLECTIONS["enrichment-evidence"].filter_schemas.lane
      .optional()
      .describe("Which contribution lane the item belongs to.")
      .meta({ examples: [LANES[0]] }),
    evidence_action: API_QUERY_COLLECTIONS[
      "enrichment-evidence"
    ].filter_schemas.evidence_action
      .optional()
      .describe("What the evidence is asking a contributor to do.")
      .meta({ examples: [EVIDENCE_ACTIONS[0]] }),
    direct_submission_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind a contributor can submit directly. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    missing_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["enrichment-evidence"].sort_fields,
    ).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListEnrichmentEvidenceInput = z.infer<
  typeof ListEnrichmentEvidenceInputSchema
>;

export const ListEnrichmentEvidenceOutputSchema =
  ReviewEnrichmentEvidenceArtifactSchema.pick({
    entries: true,
  }).extend({
    entries: projectableRows(
      ReviewEnrichmentEvidenceArtifactSchema.shape.entries,
    ),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListEnrichmentEvidenceOutput = z.infer<
  typeof ListEnrichmentEvidenceOutputSchema
>;

/**
 * The gap-review FILTERS, declared once for both callers (#10790).
 *
 * `list_review_gaps` and `list_subnet_gaps` share all three. What they do not
 * share is `netuid` -- an optional FILTER on the network-wide feed, the
 * required SUBJECT of the per-subnet one -- or their sort fields, which name
 * different collections (`gaps` against `review-gap-priorities`). Same key set,
 * genuinely different arguments, so those two stay declared per site where the
 * difference is visible.
 */
export const GAP_REVIEW_FILTERS = {
  curation_level: kindSchema(CURATION_LEVEL_VALUES).optional(),
  missing_kinds: z
    .enum(SURFACE_KIND_VALUES)
    .optional()
    .describe(
      "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
    )
    .meta({ examples: [SURFACE_KIND_VALUES[0]] }),
  review_state: reviewStateSchema().optional(),
};

export const ListReviewGapsInputSchema = z
  .object({
    netuid: API_QUERY_COLLECTIONS.gaps.filter_schemas.netuid.optional(),
    ...GAP_REVIEW_FILTERS,
    sort: sortSchema(PRIORITY_SORT_FIELDS).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListReviewGapsInput = z.infer<typeof ListReviewGapsInputSchema>;

export const ListReviewGapsOutputSchema =
  ReviewGapPrioritiesArtifactSchema.pick({
    priorities: true,
  }).extend({
    priorities: projectableRows(
      ReviewGapPrioritiesArtifactSchema.shape.priorities,
    ),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListReviewGapsOutput = z.infer<typeof ListReviewGapsOutputSchema>;

const BOOLEAN_STRINGS = ["true", "false"] as const;
const SUBMISSION_ROUTES = REVIEW_ENRICHMENT_SUBMISSION_ROUTE_VALUES;
const TARGET_ACTIONS = REVIEW_ENRICHMENT_TARGET_ACTION_VALUES;
const TARGET_TYPES = REVIEW_ENRICHMENT_TARGET_TYPE_VALUES;
export const ListReviewEnrichmentTargetsInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid:
      API_QUERY_COLLECTIONS[
        "enrichment-targets"
      ].filter_schemas.netuid.optional(),
    target_type: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.target_type
      .optional()
      .describe("What kind of enrichment target this is.")
      .meta({ examples: [TARGET_TYPES[0]] }),
    target_action: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.target_action
      .optional()
      .describe("What the target is asking a contributor to do.")
      .meta({ examples: [TARGET_ACTIONS[0]] }),
    kind: kindSchema(SURFACE_KINDS).optional(),
    lane: API_QUERY_COLLECTIONS["enrichment-targets"].filter_schemas.lane
      .optional()
      .describe("Which contribution lane the item belongs to.")
      .meta({ examples: [LANES[0]] }),
    evidence_action: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.evidence_action
      .optional()
      .describe("What the evidence is asking a contributor to do.")
      .meta({ examples: [EVIDENCE_ACTIONS[0]] }),
    identity_level: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.identity_level
      .optional()
      .describe("How complete the subnet's published identity is.")
      .meta({ examples: [IDENTITY_LEVEL_VALUES[0]] }),
    profile_level: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.profile_level
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVEL_VALUES[0]] }),
    submission_route: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.submission_route
      .optional()
      .describe("How a contribution for this gap should be submitted.")
      .meta({ examples: [SUBMISSION_ROUTES[0]] }),
    auto_review_candidate: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.auto_review_candidate
      .optional()
      .describe("Restrict to items eligible for automated review.")
      .meta({ examples: [BOOLEAN_STRINGS[0]] }),
    manual_review_required: API_QUERY_COLLECTIONS[
      "enrichment-targets"
    ].filter_schemas.manual_review_required
      .optional()
      .describe("Restrict to items that do (or do not) need a human reviewer.")
      .meta({ examples: [BOOLEAN_STRINGS[0]] }),
    missing_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    reason_codes: reasonCodesSchema().optional(),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["enrichment-targets"].sort_fields,
    ).optional(),
    ...McpSortableListPage,
  })
  .strict();
export type ListReviewEnrichmentTargetsInput = z.infer<
  typeof ListReviewEnrichmentTargetsInputSchema
>;

export const ListReviewEnrichmentTargetsOutputSchema =
  ReviewEnrichmentTargetsArtifactSchema.pick({
    targets: true,
  }).extend({
    targets: projectableRows(
      ReviewEnrichmentTargetsArtifactSchema.shape.targets,
    ),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListReviewEnrichmentTargetsOutput = z.infer<
  typeof ListReviewEnrichmentTargetsOutputSchema
>;
