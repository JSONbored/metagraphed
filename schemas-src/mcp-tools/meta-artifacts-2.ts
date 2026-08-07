// MCP tools `get_build`, `get_coverage`.
// Mirror GET /api/v1/build, GET /api/v1/coverage.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_build: 3 bare `{"type":"object"}` sites.
//   get_coverage: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ChangelogArtifactSchema } from "../routes/meta-contracts.ts";
import { CoverageDepthArtifactSchema } from "../routes/coverage.ts";
import { SelfHealthArtifactSchema } from "../routes/self-health.ts";
import { CoverageArtifactSchema } from "../routes/coverage.ts";
import { BuildSummaryArtifactSchema } from "../routes/meta-contracts.ts";

export const GetChangelogInputSchema = z.object({}).strict();
export type GetChangelogInput = z.infer<typeof GetChangelogInputSchema>;

// DERIVED, NOT COPIED (#9796). The copy published summary, artifacts, subnets
// and coverage_delta as bare open objects -- every field of the change summary.
export const GetChangelogOutputSchema = ChangelogArtifactSchema;
export type GetChangelogOutput = z.infer<typeof GetChangelogOutputSchema>;

export const GetBuildInputSchema = z.object({}).strict();
export type GetBuildInput = z.infer<typeof GetBuildInputSchema>;

export const GetBuildOutputSchema = BuildSummaryArtifactSchema;
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

export const GetCoverageOutputSchema = CoverageArtifactSchema;
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
