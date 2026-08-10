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

export const SelfHealthDaySchema = z
  .object({
    day: z.string(),
    checks: z.int().min(0),
    ok_count: z.int().min(0),
    uptime_ratio: z.number().min(0).max(1).describe("ok_count / checks, 0..1."),
  })
  .passthrough()
  .describe(
    "One UTC day's uptime ratio for a self-health component. Days with no probe rows are ABSENT, never zero-filled.",
  );
export type SelfHealthDay = z.infer<typeof SelfHealthDaySchema>;

export const SelfHealthComponentSchema = z
  .object({
    component: z.string(),
    // Null, not false, when the component has never been probed: "not
    // measured" and "down" are different claims.
    current_ok: z
      .boolean()
      .nullable()
      .describe("Null when the component has never been probed -- NOT false."),
    http_status: z.int().nullable(),
    latency_ms: z.int().nullable(),
    checked_at: z.string().nullable(),
    // metagraphed#8352: qualifies a false current_ok with WHY, for the one
    // component class (publish) whose failure is a cadence miss rather than
    // an HTTP-level outage -- null whenever there's nothing to qualify (the
    // component is healthy, or its failure IS the plain "down" the label
    // already says).
    note: z
      .string()
      .nullable()
      .describe(
        "Qualifies a false current_ok with why, for non-HTTP failure modes. Null when there's nothing to add.",
      ),
    // Days with no rows are absent, never zero-filled -- a gap means "we
    // weren't measuring", and 0% would invent an outage.
    days: z
      .array(SelfHealthDaySchema)
      .describe(
        "Trailing-90d daily ratios, oldest first; gaps are absent, never zero-filled.",
      ),
    uptime_90d: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        "Mean uptime across the days we actually have. Null when there are none.",
      ),
  })
  .passthrough()
  .describe(
    "One self-health component (api / site / publish): its latest probe state and trailing-90-day daily ratios.",
  );
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
  .passthrough()
  .describe(
    'One ingest lane\'s staleness verdict.\n\nThree of these five were declared non-null against a Zod schema that says\notherwise, and production proved it: \\`self_health\\` returned\n\\`Cannot return null for non-nullable field SelfHealthLane.detail\\` and nulled\nthe whole \\`lanes\\` list. \\`age_ms\\` and \\`checked_at\\` are null for the same\nreason -- the watchdog could not measure the lane, which is the "we did not\nmeasure" this type exists to distinguish from "the lane is fine" (#10215).\n\n\\`age_ms\\` is a Float because it is a duration in MILLISECONDS: a lane stale\nfor more than 24.8 days exceeds GraphQL\'s 32-bit Int, and the answer to\n"how far behind is this lane" must not stop being representable exactly when\nit starts to matter.',
  );
export type SelfHealthLane = z.infer<typeof SelfHealthLaneSchema>;

export const SelfHealthArtifactSchema = z
  .object({
    schema_version: z.int(),
    // Scoped to our OWN components only -- never mixed with third-party
    // subnet-surface health.
    verdict: z
      .enum(["operational", "degraded", "outage"])
      .describe("operational | degraded | outage."),
    components: z.array(SelfHealthComponentSchema),
    measured_component_count: z
      .int()
      .min(0)
      .describe(
        "Components with data. Zero means the poller hasn't written anything yet.",
      ),
    // Stale lanes lead, then alphabetical -- the rows an operator acts on first.
    lanes: z.array(SelfHealthLaneSchema),
    stale_lane_count: z.int().min(0),
    observed_at: z.string().nullable(),
  })
  .passthrough()
  .describe(
    "metagraphed's own uptime verdict (#8422). Mirrors GET /api/v1/self-health.",
  );
export type SelfHealthArtifact = z.infer<typeof SelfHealthArtifactSchema>;
