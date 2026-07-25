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
import { OpenObjectSchema } from "./shared.ts";

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
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetCandidatesInput = z.infer<
  typeof GetSubnetCandidatesInputSchema
>;

export const GetSubnetCandidatesOutputSchema = z
  .object({
    netuid: z.int().nullable().optional(),
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
    netuid: z.int().min(0),
    kind: z.enum(SURFACE_KINDS).optional(),
    provider: z.string().optional(),
    state: z.enum(CANDIDATE_STATES).optional(),
    id: z.string().optional(),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    sort: z.enum(CANDIDATES_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSubnetCandidatesInput = z.infer<
  typeof ListSubnetCandidatesInputSchema
>;

export const ListSubnetCandidatesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
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
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetEvidenceInput = z.infer<
  typeof GetSubnetEvidenceInputSchema
>;

export const GetSubnetEvidenceOutputSchema = z
  .object({
    netuid: z.int().nullable().optional(),
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
    netuid: z.int().min(0),
    q: z.string().optional(),
    sort: z.enum(CLAIM_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListSubnetEvidenceInput = z.infer<
  typeof ListSubnetEvidenceInputSchema
>;

export const ListSubnetEvidenceOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
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
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetSurfacesInput = z.infer<
  typeof GetSubnetSurfacesInputSchema
>;

export const GetSubnetSurfacesOutputSchema = z
  .object({
    netuid: z.int().nullable().optional(),
    surfaces: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
  })
  .passthrough();
export type GetSubnetSurfacesOutput = z.infer<
  typeof GetSubnetSurfacesOutputSchema
>;
