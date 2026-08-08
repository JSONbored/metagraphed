// MCP tools `list_enrichment_queue`, `list_adapter_candidates` (types-epic E
// batch 11, #8074). Neither is defined inline in src/mcp-server.ts -- their
// `LIST_X_MCP_TOOL`/`LIST_X_OUTPUT_SCHEMA` hand-written literals live in
// src/enrichment-queue-mcp.ts and src/adapter-candidates-mcp.ts
// respectively, imported into mcp-server.ts's MCP_TOOLS array via object
// spread. The z.toJSONSchema(...) wiring for these two happens in THEIR OWN
// files, not mcp-server.ts. Neither mirrors an existing schemas-src/routes/
// REST schema -- modeled fresh, matching each hand-written literal
// field-for-field.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  reasonCodesSchema,
  reviewStateSchema,
  McpListArtifactStamp,
  McpListPageFields,
  fieldsSchema,
  kindSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  querySchema,
  sortSchema,
} from "./shared.ts";
import {
  REVIEW_ENRICHMENT_LANE_VALUES,
  REVIEW_EVIDENCE_ACTION_VALUES,
  ReviewEnrichmentQueueArtifactSchema,
} from "../routes/review-enrichment.ts";
import { ReviewAdapterCandidatesArtifactSchema } from "../routes/review-enrichment.ts";
import { SURFACE_KIND_VALUES } from "../routes/subnet-detail.ts";
import { CURATION_LEVEL_VALUES } from "../shared.ts";
import { RECOMMENDED_ADAPTER_KINDS } from "../routes/review-enrichment.ts";
import { IDENTITY_LEVEL_VALUES, PROFILE_LEVEL_VALUES } from "../shared.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const CURATION_LEVELS = CURATION_LEVEL_VALUES;
const EVIDENCE_ACTIONS = REVIEW_EVIDENCE_ACTION_VALUES;
const LANES = REVIEW_ENRICHMENT_LANE_VALUES;
const BOOLEAN_STRINGS = ["true", "false"] as const;
export const ListEnrichmentQueueInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid:
      API_QUERY_COLLECTIONS[
        "enrichment-queue"
      ].filter_schemas.netuid.optional(),
    lane: API_QUERY_COLLECTIONS["enrichment-queue"].filter_schemas.lane
      .optional()
      .describe("Which contribution lane the item belongs to.")
      .meta({ examples: [LANES[0]] }),
    evidence_action: API_QUERY_COLLECTIONS[
      "enrichment-queue"
    ].filter_schemas.evidence_action
      .optional()
      .describe("What the evidence is asking a contributor to do.")
      .meta({ examples: [EVIDENCE_ACTIONS[0]] }),
    identity_level: API_QUERY_COLLECTIONS[
      "enrichment-queue"
    ].filter_schemas.identity_level
      .optional()
      .describe("How complete the subnet's published identity is.")
      .meta({ examples: [IDENTITY_LEVEL_VALUES[0]] }),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    profile_level: API_QUERY_COLLECTIONS[
      "enrichment-queue"
    ].filter_schemas.profile_level
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVEL_VALUES[0]] }),
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
    manual_review_required: API_QUERY_COLLECTIONS[
      "enrichment-queue"
    ].filter_schemas.manual_review_required
      .optional()
      .describe("Restrict to items that do (or do not) need a human reviewer.")
      .meta({ examples: [BOOLEAN_STRINGS[0]] }),
    reason_codes: reasonCodesSchema().optional(),
    review_state: reviewStateSchema().optional(),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["enrichment-queue"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEnrichmentQueueInput = z.infer<
  typeof ListEnrichmentQueueInputSchema
>;

export const ListEnrichmentQueueOutputSchema =
  ReviewEnrichmentQueueArtifactSchema.pick({
    queue: true,
  }).extend({
    queue: projectableRows(ReviewEnrichmentQueueArtifactSchema.shape.queue),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListEnrichmentQueueOutput = z.infer<
  typeof ListEnrichmentQueueOutputSchema
>;

export const ListAdapterCandidatesInputSchema = z
  .object({
    netuid:
      API_QUERY_COLLECTIONS[
        "adapter-candidates"
      ].filter_schemas.netuid.optional(),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    candidate_api_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind exist as unreviewed API candidates. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    operational_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind are operational. One kind per call; see this parameter's enum.",
      )
      .meta({ examples: [SURFACE_KINDS[0]] }),
    recommended_adapter_kind: API_QUERY_COLLECTIONS[
      "adapter-candidates"
    ].filter_schemas.recommended_adapter_kind
      .optional()
      .describe("Which adapter shape suits this surface.")
      .meta({ examples: [RECOMMENDED_ADAPTER_KINDS[0]] }),
    reason_codes: reasonCodesSchema().optional(),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["adapter-candidates"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListAdapterCandidatesInput = z.infer<
  typeof ListAdapterCandidatesInputSchema
>;

export const ListAdapterCandidatesOutputSchema =
  ReviewAdapterCandidatesArtifactSchema.pick({
    candidates: true,
  }).extend({
    candidates: projectableRows(
      ReviewAdapterCandidatesArtifactSchema.shape.candidates,
    ),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListAdapterCandidatesOutput = z.infer<
  typeof ListAdapterCandidatesOutputSchema
>;
