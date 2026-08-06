// MCP tools `get_subnet_candidates`, `list_subnet_candidates`,
// `get_subnet_evidence`, `list_subnet_evidence`, `get_subnet_surfaces`
// (types-epic E batch 11, #8074). The first, third, and fifth are defined
// inline in src/mcp-server.ts's MCP_TOOLS array; `list_subnet_candidates`/
// `list_subnet_evidence` live in src/subnet-candidates-mcp.ts and
// src/subnet-evidence-mcp.ts respectively (their `LIST_X_MCP_TOOL`/
// `LIST_X_OUTPUT_SCHEMA` spread into mcp-server.ts's MCP_TOOLS array) -- the
// z.toJSONSchema(...) wiring for those two happens in THEIR OWN files, not
// mcp-server.ts. None mirror an existing schemas-src/routes/ REST schema --
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
  providerSlugSchema,
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

export const GetSubnetCandidatesInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetCandidatesInput = z.infer<
  typeof GetSubnetCandidatesInputSchema
>;

export const GetSubnetCandidatesOutputSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    candidates: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetCandidatesOutput = z.infer<
  typeof GetSubnetCandidatesOutputSchema
>;

const CANDIDATE_STATES = [
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected",
] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const CANDIDATES_SORT_FIELDS = [
  "confidence",
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
  "state",
] as const;

export const ListSubnetCandidatesInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: z
      .enum(CANDIDATE_STATES)
      .optional()
      .describe("The incident's lifecycle state."),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      ),
    confidence: z
      .enum(CONFIDENCE_LEVELS)
      .optional()
      .describe("How confident the machine assessment is."),
    sort: sortSchema(CANDIDATES_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetCandidatesInput = z.infer<
  typeof ListSubnetCandidatesInputSchema
>;

export const ListSubnetCandidatesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
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
export type ListSubnetCandidatesOutput = z.infer<
  typeof ListSubnetCandidatesOutputSchema
>;

export const GetSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetEvidenceInput = z.infer<
  typeof GetSubnetEvidenceInputSchema
>;

export const GetSubnetEvidenceOutputSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    claims: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetEvidenceOutput = z.infer<
  typeof GetSubnetEvidenceOutputSchema
>;

const CLAIM_SORT_FIELDS = [
  "claim",
  "source_url",
  "subject",
  "verified_at",
] as const;

export const ListSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
    q: querySchema().optional(),
    sort: sortSchema(CLAIM_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetEvidenceInput = z.infer<
  typeof ListSubnetEvidenceInputSchema
>;

export const ListSubnetEvidenceOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    claims: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetEvidenceOutput = z.infer<
  typeof ListSubnetEvidenceOutputSchema
>;

export const GetSubnetSurfacesInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetSurfacesInput = z.infer<
  typeof GetSubnetSurfacesInputSchema
>;

export const GetSubnetSurfacesOutputSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    surfaces: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetSurfacesOutput = z.infer<
  typeof GetSubnetSurfacesOutputSchema
>;
