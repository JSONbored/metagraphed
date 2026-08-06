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
import {
  NotesFieldSchema,
  OpenObjectSchema,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";

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
const EVIDENCE_ACTIONS = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
] as const;
const LANES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
] as const;
const EVIDENCE_SORT_FIELDS = [
  "evidence_action",
  "lane",
  "name",
  "netuid",
  "priority_score",
] as const;

export const ListEnrichmentEvidenceInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid: netuidSchema().optional(),
    lane: z
      .enum(LANES)
      .optional()
      .describe("Which contribution lane the item belongs to.")
      .meta({ examples: [LANES[0]] }),
    evidence_action: z
      .enum(EVIDENCE_ACTIONS)
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
    sort: sortSchema(EVIDENCE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEnrichmentEvidenceInput = z.infer<
  typeof ListEnrichmentEvidenceInputSchema
>;

export const ListEnrichmentEvidenceOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    entries: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListEnrichmentEvidenceOutput = z.infer<
  typeof ListEnrichmentEvidenceOutputSchema
>;

const CURATION_LEVELS = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
] as const;

export const ListReviewGapsInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
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
export type ListReviewGapsInput = z.infer<typeof ListReviewGapsInputSchema>;

export const ListReviewGapsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
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
export type ListReviewGapsOutput = z.infer<typeof ListReviewGapsOutputSchema>;

const PROFILE_LEVELS = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"] as const;
const BOOLEAN_STRINGS = ["true", "false"] as const;
const SUBMISSION_ROUTES = [
  "direct-candidate-pr",
  "adapter-request",
  "maintainer-review",
  "status-report",
] as const;
const TARGET_ACTIONS = [
  "submit-new-candidate",
  "replace-stale-candidate",
  "verify-existing-candidate",
  "review-existing-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
] as const;
const TARGET_TYPES = [
  "surface-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
] as const;
const TARGET_SORT_FIELDS = [
  "auto_review_candidate",
  "evidence_action",
  "identity_level",
  "kind",
  "lane",
  "manual_review_required",
  "name",
  "netuid",
  "priority_score",
  "profile_level",
  "submission_route",
  "target_action",
  "target_type",
] as const;

export const ListReviewEnrichmentTargetsInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid: netuidSchema().optional(),
    target_type: z
      .enum(TARGET_TYPES)
      .optional()
      .describe("What kind of enrichment target this is.")
      .meta({ examples: [TARGET_TYPES[0]] }),
    target_action: z
      .enum(TARGET_ACTIONS)
      .optional()
      .describe("What the target is asking a contributor to do.")
      .meta({ examples: [TARGET_ACTIONS[0]] }),
    kind: kindSchema(SURFACE_KINDS).optional(),
    lane: z
      .enum(LANES)
      .optional()
      .describe("Which contribution lane the item belongs to.")
      .meta({ examples: [LANES[0]] }),
    evidence_action: z
      .enum(EVIDENCE_ACTIONS)
      .optional()
      .describe("What the evidence is asking a contributor to do.")
      .meta({ examples: [EVIDENCE_ACTIONS[0]] }),
    identity_level: z
      .enum(IDENTITY_LEVELS)
      .optional()
      .describe("How complete the subnet's published identity is.")
      .meta({ examples: [IDENTITY_LEVELS[0]] }),
    profile_level: z
      .enum(PROFILE_LEVELS)
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVELS[0]] }),
    submission_route: z
      .enum(SUBMISSION_ROUTES)
      .optional()
      .describe("How a contribution for this gap should be submitted.")
      .meta({ examples: [SUBMISSION_ROUTES[0]] }),
    auto_review_candidate: z
      .enum(BOOLEAN_STRINGS)
      .optional()
      .describe("Restrict to items eligible for automated review.")
      .meta({ examples: [BOOLEAN_STRINGS[0]] }),
    manual_review_required: z
      .enum(BOOLEAN_STRINGS)
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
    reason_codes: z
      .string()
      .optional()
      .describe(
        "Comma-separated reason codes to filter by; an item matches if it carries any of them.",
      )
      .meta({ examples: ["stale-evidence"] }),
    sort: sortSchema(TARGET_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListReviewEnrichmentTargetsInput = z.infer<
  typeof ListReviewEnrichmentTargetsInputSchema
>;

export const ListReviewEnrichmentTargetsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    targets: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListReviewEnrichmentTargetsOutput = z.infer<
  typeof ListReviewEnrichmentTargetsOutputSchema
>;
