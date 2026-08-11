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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { ChangelogArtifactSchema } from "../routes/meta-contracts.ts";
import { CoverageDepthArtifactSchema } from "../routes/coverage.ts";
import { SelfHealthArtifactSchema } from "../routes/self-health.ts";
import { CoverageArtifactSchema } from "../routes/coverage.ts";
import {
  fieldsSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  querySchema,
  sortSchema,
  projectableRows,
} from "./shared.ts";
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

/**
 * #10011. This took NO arguments and returned ~293 KB -- the whole
 * coverage-depth scorecard, every subnet, on every call, while
 * GET /api/v1/coverage/depth publishes every filter below. Not bad defaults:
 * no lever at all, the same shape get_health_trends had before #9989.
 *
 * The vocabularies are the ROUTE's own, so a tier added to the scorecard
 * cannot become one this tool rejects.
 */
export const GetCoverageDepthInputSchema = z
  .object({
    netuid:
      API_QUERY_COLLECTIONS["coverage-depth"].filter_schemas.netuid.optional(),
    tier: API_QUERY_COLLECTIONS["coverage-depth"].filter_schemas.tier
      .optional()
      .describe(
        "Restrict to subnets in this readiness tier. Applied across the whole scorecard, not to one page.",
      )
      .meta({ examples: ["agent-ready"] }),
    agent_status: API_QUERY_COLLECTIONS[
      "coverage-depth"
    ].filter_schemas.agent_status
      .optional()
      .describe("Restrict to subnets with this agent-readiness status.")
      .meta({ examples: ["callable"] }),
    blocker_level: API_QUERY_COLLECTIONS[
      "coverage-depth"
    ].filter_schemas.blocker_level
      .optional()
      .describe(
        "Restrict to subnets blocked this badly. `none` means nothing is blocking promotion.",
      )
      .meta({ examples: ["hard-blocked"] }),
    // Free-text over the collection's own `search_keys` -- name, slug,
    // top_gap_codes, recommended_next_action (#10793). The engine this handler
    // already runs through implements it; only the argument was missing, so a
    // caller could narrow by tier or netuid but not by "which subnets have a
    // schema gap".
    q: querySchema().optional(),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["coverage-depth"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    // Defaults to a PAGE, not the whole scorecard (#10027). Measured at
    // 268,088 B for 129 rows -- ~2 KB each -- so an unbounded call spent most
    // of an agent's context before it had asked anything specific. `total`
    // still spans every row and `next_cursor` is emitted, so a paged caller
    // keeps the denominator and can continue; limitSchema puts the default
    // into the published contract rather than leaving it in prose.
    limit: limitSchema(500, 25).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
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
// #10064 production sweep: this tool advertises `fields`, so a caller can ask
// for a SUBSET of each row -- and the artifact schema requires every property
// on it. Production answered `?fields=` with rows that failed the tool's own
// published schema; `projectableRows` is the convention the sibling tools
// already use. Field names and types still come from the route, so a rename
// there is still a compile error here; only requiredness changes, because the
// caller controls it.
export const GetCoverageDepthOutputSchema = CoverageDepthArtifactSchema.extend({
  rows: projectableRows(CoverageDepthArtifactSchema.shape.rows),
  ranked_queue: projectableRows(CoverageDepthArtifactSchema.shape.ranked_queue),
});
export type GetCoverageDepthOutput = z.infer<
  typeof GetCoverageDepthOutputSchema
>;
