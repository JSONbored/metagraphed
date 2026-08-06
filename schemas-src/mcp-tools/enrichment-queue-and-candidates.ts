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
const CURATION_LEVELS = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const PROFILE_LEVELS = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const EVIDENCE_ACTIONS = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
] as const;
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"] as const;
const LANES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
] as const;
const BOOLEAN_STRINGS = ["true", "false"] as const;
const QUEUE_SORT_FIELDS = [
  "adapter_score",
  "candidate_count",
  "completeness_score",
  "curation_level",
  "endpoint_count",
  "evidence_action",
  "identity_level",
  "identity_surface_count",
  "lane",
  "name",
  "netuid",
  "operational_interface_count",
  "priority_score",
  "profile_level",
  "review_state",
  "stale_candidate_count",
  "surface_count",
  "verified_candidate_count",
] as const;

export const ListEnrichmentQueueInputSchema = z
  .object({
    q: querySchema().optional(),
    netuid: netuidSchema().optional(),
    lane: z
      .enum(LANES)
      .optional()
      .describe("Which contribution lane the item belongs to."),
    evidence_action: z
      .enum(EVIDENCE_ACTIONS)
      .optional()
      .describe("What the evidence is asking a contributor to do."),
    identity_level: z
      .enum(IDENTITY_LEVELS)
      .optional()
      .describe("How complete the subnet's published identity is."),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    profile_level: z
      .enum(PROFILE_LEVELS)
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      ),
    direct_submission_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind a contributor can submit directly. One kind per call; see this parameter's enum.",
      ),
    missing_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind the subnet is MISSING. One kind per call; see this parameter's enum.",
      ),
    manual_review_required: z
      .enum(BOOLEAN_STRINGS)
      .optional()
      .describe("Restrict to items that do (or do not) need a human reviewer."),
    reason_codes: z
      .string()
      .optional()
      .describe(
        "Comma-separated reason codes to filter by; an item matches if it carries any of them.",
      ),
    review_state: z
      .string()
      .optional()
      .describe("Where the item sits in maintainer review."),
    sort: sortSchema(QUEUE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEnrichmentQueueInput = z.infer<
  typeof ListEnrichmentQueueInputSchema
>;

export const ListEnrichmentQueueOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    queue: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListEnrichmentQueueOutput = z.infer<
  typeof ListEnrichmentQueueOutputSchema
>;

const RECOMMENDED_ADAPTER_KINDS = [
  "custom-adapter",
  "data-artifact-adapter",
  "generic-openapi-or-custom",
  "stream-adapter",
] as const;
const ADAPTER_CANDIDATES_SORT_FIELDS = [
  "candidate_api_count",
  "candidate_api_kinds",
  "curation_level",
  "name",
  "netuid",
  "operational_kinds",
  "operational_surface_count",
  "priority_score",
  "recommended_adapter_kind",
] as const;

export const ListAdapterCandidatesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    curation_level: kindSchema(CURATION_LEVELS).optional(),
    candidate_api_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind exist as unreviewed API candidates. One kind per call; see this parameter's enum.",
      ),
    operational_kinds: z
      .enum(SURFACE_KINDS)
      .optional()
      .describe(
        "Restrict to subnets where surfaces of this kind are operational. One kind per call; see this parameter's enum.",
      ),
    recommended_adapter_kind: z
      .enum(RECOMMENDED_ADAPTER_KINDS)
      .optional()
      .describe("Which adapter shape suits this surface."),
    reason_codes: z
      .string()
      .optional()
      .describe(
        "Comma-separated reason codes to filter by; an item matches if it carries any of them.",
      ),
    sort: sortSchema(ADAPTER_CANDIDATES_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListAdapterCandidatesInput = z.infer<
  typeof ListAdapterCandidatesInputSchema
>;

export const ListAdapterCandidatesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    candidates: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListAdapterCandidatesOutput = z.infer<
  typeof ListAdapterCandidatesOutputSchema
>;
