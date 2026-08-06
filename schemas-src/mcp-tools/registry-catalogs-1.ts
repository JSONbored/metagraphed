// MCP tools `list_providers`, `list_surfaces`, `list_candidates` (types-epic
// E batch 9, #8073). Unlike every other tool converted so far in this
// epic, these three are NOT defined inline in src/mcp-server.ts -- their
// `LIST_X_MCP_TOOL`/`LIST_X_OUTPUT_SCHEMA` hand-written literals live in
// src/providers-mcp.ts, src/surfaces-mcp.ts, and src/candidates-mcp.ts
// respectively, imported into mcp-server.ts's MCP_TOOLS array via object
// spread (`{ ...LIST_PROVIDERS_MCP_TOOL, async handler(...) {...} }`). The
// z.toJSONSchema(...) wiring for these three happens in THEIR OWN files, not
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
  sortSchema,
} from "./shared.ts";

// Symbolic in each hand-written original (src/contracts.ts's QUERY_ENUMS /
// API_QUERY_COLLECTIONS.*.sort_fields), cross-checked against the actual
// runtime source at the time of writing.
const PROVIDER_KINDS = [
  "data-provider",
  "docs-provider",
  "infrastructure-provider",
  "registry",
  "subnet-team",
] as const;
const PROVIDER_AUTHORITIES = [
  "community",
  "official",
  "provider-claimed",
  "registry-observed",
] as const;
const PROVIDER_SORT_FIELDS = ["authority", "id", "kind", "name"] as const;

export const ListProvidersInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    kind: kindSchema(PROVIDER_KINDS).optional(),
    authority: z
      .enum(PROVIDER_AUTHORITIES)
      .optional()
      .describe(
        "Who asserts this record: the operator, the community, a provider, or the registry's own probes.",
      )
      .meta({ examples: [PROVIDER_AUTHORITIES[0]] }),
    sort: sortSchema(PROVIDER_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProvidersInput = z.infer<typeof ListProvidersInputSchema>;

export const ListProvidersOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
    providers: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListProvidersOutput = z.infer<typeof ListProvidersOutputSchema>;

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
const SURFACE_SORT_FIELDS = [
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
] as const;

export const ListSurfacesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    sort: sortSchema(SURFACE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSurfacesInput = z.infer<typeof ListSurfacesInputSchema>;

export const ListSurfacesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
    surfaces: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSurfacesOutput = z.infer<typeof ListSurfacesOutputSchema>;

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

export const ListCandidatesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: z
      .enum(CANDIDATE_STATES)
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [CANDIDATE_STATES[0]] }),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    confidence: z
      .enum(CONFIDENCE_LEVELS)
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVELS[0]] }),
    sort: sortSchema(CANDIDATES_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(1000).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListCandidatesInput = z.infer<typeof ListCandidatesInputSchema>;

export const ListCandidatesOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z
      .union([z.array(z.string()), z.string()])
      .nullable()
      .optional(),
    schema_version: z.union([z.string(), z.int()]).nullable().optional(),
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
export type ListCandidatesOutput = z.infer<typeof ListCandidatesOutputSchema>;
