// GET /api/v1/self-health (metagraphed#8318). Live Postgres-tier data written
// by the poller's self-health job (#8317) -- no static file.
//
// Modeled from src/self-health.ts's buildSelfHealth(). SelfHealthDay and
// SelfHealthComponent ARE registered as shared components (unlike e.g.
// chain-yield's YieldDistribution, which has a single referrer): they're
// referenced from the artifact's own nested arrays, and an unregistered named
// sub-shape gets silently inlined by the OpenAPI registry rather than
// $ref'd -- see the Zod-registry gotcha in the schema notes.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SelfHealthDaySchema = z
  .object({
    day: z.string(),
    checks: z.int().min(0),
    ok_count: z.int().min(0),
    uptime_ratio: z.number().min(0).max(1),
  })
  .passthrough();
export type SelfHealthDay = z.infer<typeof SelfHealthDaySchema>;

export const SelfHealthComponentSchema = z
  .object({
    component: z.string(),
    // Null, not false, when the component has never been probed: "not
    // measured" and "down" are different claims.
    current_ok: z.boolean().nullable(),
    http_status: z.int().nullable(),
    latency_ms: z.int().nullable(),
    checked_at: z.string().nullable(),
    // metagraphed#8352: qualifies a false current_ok with WHY, for the one
    // component class (publish) whose failure is a cadence miss rather than
    // an HTTP-level outage -- null whenever there's nothing to qualify (the
    // component is healthy, or its failure IS the plain "down" the label
    // already says).
    note: z.string().nullable(),
    // Days with no rows are absent, never zero-filled -- a gap means "we
    // weren't measuring", and 0% would invent an outage.
    days: z.array(SelfHealthDaySchema),
    uptime_90d: z.number().min(0).max(1).nullable(),
  })
  .passthrough();
export type SelfHealthComponent = z.infer<typeof SelfHealthComponentSchema>;

// #9330/#9340: the per-lane watchdog verdicts, from the D1 `lane_health` table.
//
// Declared here rather than beside the component views because they answer a
// different question. `components` is "were OUR public surfaces reachable",
// probed from outside. `lanes` is "did each ingest lane actually write", which is
// what the staleness watchdogs compute and what PostHog was silently dropping.
// A lane can be dead for hours while every component reads 100% -- that is exactly
// the 2026-08-03 chain-detail outage, and why this is not folded into the former.
export const LANE_VERDICTS = ["ok", "stale", "unknown"] as const;

export const SelfHealthLaneSchema = z
  .object({
    lane: z.string(),
    // `unknown` is NOT a synonym for `ok`: the watchdog could not evaluate the
    // lane at all, which is the same "we did not measure" that current_ok models
    // with null above.
    verdict: z.enum(LANE_VERDICTS),
    // Null when the watchdog could not measure how far behind the lane was.
    age_ms: z.int().min(0).nullable(),
    detail: z.string().nullable(),
    checked_at: z.string().nullable(),
  })
  .passthrough();
export type SelfHealthLane = z.infer<typeof SelfHealthLaneSchema>;

export const SelfHealthArtifactSchema = z
  .object({
    schema_version: z.int(),
    // Scoped to our OWN components only -- never mixed with third-party
    // subnet-surface health.
    verdict: z.enum(["operational", "degraded", "outage"]),
    components: z.array(SelfHealthComponentSchema),
    measured_component_count: z.int().min(0),
    // Stale lanes lead, then alphabetical -- the rows an operator acts on first.
    lanes: z.array(SelfHealthLaneSchema),
    stale_lane_count: z.int().min(0),
    observed_at: z.string().nullable(),
  })
  .passthrough();
export type SelfHealthArtifact = z.infer<typeof SelfHealthArtifactSchema>;

export const SelfHealthResponseSchema = successEnvelopeSchema(
  SelfHealthArtifactSchema,
);
export const SelfHealthQuerySchema = z.object({}).strict();
export type SelfHealthQuery = z.infer<typeof SelfHealthQuerySchema>;
