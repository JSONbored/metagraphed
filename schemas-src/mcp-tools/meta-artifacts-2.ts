// MCP tools `get_changelog`, `get_build`, `get_coverage`,
// `get_coverage_depth` (types-epic E batch 12, #8075). `get_changelog`,
// `get_build`, and `get_coverage` each live in their own dedicated file
// (src/changelog-mcp.ts, src/build-mcp.ts, src/registry-coverage.ts --
// their `GET_X_MCP_TOOL`/`GET_X_OUTPUT_SCHEMA` spread into mcp-server.ts's
// MCP_TOOLS array); `get_coverage_depth` is defined inline in
// src/mcp-server.ts. All four are no-input, baked-artifact passthrough
// tools. None mirror an existing schemas-src/routes/ REST schema -- modeled
// fresh, matching each hand-written literal field-for-field.
// `get_coverage_depth`'s output declares NO `required` key at all (unlike
// every sibling in this file, which declares an explicit list or an empty
// array) -- a genuine, pre-existing difference, preserved as-is.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- this
// batch's shared.ts predates the NotesFieldSchema helper hoisted in batch 10
// (#8074), still unmerged as of this batch (#8075) -- inlined here rather
// than depending on unmerged parallel work.
const NotesFieldSchema = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional();

export const GetChangelogInputSchema = z.object({}).strict();
export type GetChangelogInput = z.infer<typeof GetChangelogInputSchema>;

export const GetChangelogOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    source: z.string().nullable(),
    notes: NotesFieldSchema,
    summary: OpenObjectSchema,
    artifacts: OpenObjectSchema,
    subnets: OpenObjectSchema,
    coverage_delta: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetChangelogOutput = z.infer<typeof GetChangelogOutputSchema>;

export const GetBuildInputSchema = z.object({}).strict();
export type GetBuildInput = z.infer<typeof GetBuildInputSchema>;

export const GetBuildOutputSchema = z
  .object({
    schema_version: z.int(),
    contract_version: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    published_at: z.string().nullable().optional(),
    adapter_count: z.int().nullable().optional(),
    artifact_count: z.int(),
    artifact_size_bytes: z.int().nullable().optional(),
    subnet_count: z.int().nullable().optional(),
    surface_count: z.int().nullable().optional(),
    provider_count: z.int().nullable().optional(),
    artifacts: z.array(OpenObjectSchema).nullable().optional(),
    coverage: OpenObjectSchema.nullable().optional(),
    artifact_budget_summary: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetBuildOutput = z.infer<typeof GetBuildOutputSchema>;

// #8422: get_self_health -- GET /api/v1/self-health parity, baked
// /metagraph/self-health.json passthrough. Mirrors src/self-health.ts's
// SelfHealth / SelfHealthComponentView / SelfHealthDay interfaces field for
// field. Nullable (never optional-absent) where the interface says `| null`.
export const GetSelfHealthInputSchema = z.object({}).strict();
export type GetSelfHealthInput = z.infer<typeof GetSelfHealthInputSchema>;

const SelfHealthDaySchema = z
  .object({
    day: z.string(),
    checks: z.int(),
    ok_count: z.int(),
    uptime_ratio: z.number(),
  })
  .passthrough();

const SelfHealthComponentViewSchema = z
  .object({
    component: z.string(),
    current_ok: z.boolean().nullable(),
    http_status: z.int().nullable(),
    latency_ms: z.number().nullable(),
    checked_at: z.string().nullable(),
    note: z.string().nullable(),
    days: z.array(SelfHealthDaySchema),
    uptime_90d: z.number().nullable(),
  })
  .passthrough();

export const GetSelfHealthOutputSchema = z
  .object({
    schema_version: z.int(),
    verdict: z.string(),
    components: z.array(SelfHealthComponentViewSchema),
    measured_component_count: z.int(),
    observed_at: z.string().nullable(),
  })
  .passthrough();
export type GetSelfHealthOutput = z.infer<typeof GetSelfHealthOutputSchema>;

export const GetCoverageInputSchema = z.object({}).strict();
export type GetCoverageInput = z.infer<typeof GetCoverageInputSchema>;

export const GetCoverageOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    surface_count: z.int(),
    official_surface_count: z.int().optional(),
    first_party_subnet_count: z.int().optional(),
    chain_subnet_count: z.int().optional(),
    candidate_count: z.int().optional(),
    probed_count: z.int().optional(),
    domain_coverage: OpenObjectSchema.optional(),
    completeness: OpenObjectSchema,
    subnets_without_official_surface: z.int().optional(),
  })
  .passthrough();
export type GetCoverageOutput = z.infer<typeof GetCoverageOutputSchema>;

export const GetCoverageDepthInputSchema = z.object({}).strict();
export type GetCoverageDepthInput = z.infer<typeof GetCoverageDepthInputSchema>;

// No `required` key in the hand-written original, unlike this file's other
// three tools.
export const GetCoverageDepthOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    generated_at: z.string().nullable().optional(),
    coverage_depth_version: z.string().nullable().optional(),
    rows: z.array(OpenObjectSchema).optional(),
    ranked_queue: z.array(OpenObjectSchema).optional(),
  })
  .passthrough();
export type GetCoverageDepthOutput = z.infer<
  typeof GetCoverageDepthOutputSchema
>;
