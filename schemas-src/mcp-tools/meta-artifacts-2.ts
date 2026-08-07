// MCP tools `get_changelog`, `get_build`, `get_coverage`,
// `get_coverage_depth` (types-epic E batch 12, #8075). `get_changelog`,
// `get_build`, and `get_coverage` each live in their own dedicated file
// (src/changelog-mcp.ts, src/build-mcp.ts, src/registry-coverage.ts --
// their `GET_X_MCP_TOOL`/`GET_X_OUTPUT_SCHEMA` spread into mcp-server.ts's
// MCP_TOOLS array); `get_coverage_depth` is defined inline in
// src/mcp-server.ts. All four are no-input, baked-artifact passthrough
// tools.
//
// This header used to say none of them "mirror an existing schemas-src/routes/
// REST schema -- modeled fresh". For `get_coverage_depth` that was wrong:
// CoverageDepthArtifactSchema in schemas-src/routes/coverage.ts models the same
// artifact, and the fresh model disagreed with it on the type of
// `coverage_depth_version` (#9794). It now reuses the route schema outright,
// which also replaces its two bare open arrays with the row and queue-entry
// shapes the route already declares. The remaining three are still local
// models; #9796 covers deriving them.
import { z } from "zod";
import { CoverageDepthArtifactSchema } from "../routes/coverage.ts";
import { SelfHealthArtifactSchema } from "../routes/self-health.ts";
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

// The output schema IS the route's schema, imported rather than restated.
//
// These were two hand-kept copies of one shape, and they had already drifted: this
// copy typed `latency_ms` as a float and `verdict` as a bare string, while the route
// bounded `uptime_ratio` to 0..1 and enumerated the three verdicts. Nothing enforced
// agreement, so `get_self_health` published a looser contract than the REST route
// serving the identical bytes. Sharing the definition removes the drift by
// construction -- adding a field to the card (as #9330's `lanes` does) can no longer
// reach one surface and miss the other.
export const GetSelfHealthOutputSchema = SelfHealthArtifactSchema;
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

// DERIVED FROM THE ROUTE, NOT COPIED (#9794). The hand-written copy typed
// `coverage_depth_version` as a string while CoverageDepthArtifactSchema in
// schemas-src/routes/coverage.ts has always had `z.int().min(1)` and the served
// value is `1`, so every response failed its own published schema.
//
// Reusing the artifact also stops this tool publishing `rows` and
// `ranked_queue` as bare open arrays. The route declares CoverageDepthRowSchema
// and CoverageDepthQueueEntrySchema in full, so an agent now gets the shape of
// the thing it is ranking instead of {"type":"object"}. Verified against
// production before the switch.
export const GetCoverageDepthOutputSchema = CoverageDepthArtifactSchema;
export type GetCoverageDepthOutput = z.infer<
  typeof GetCoverageDepthOutputSchema
>;
