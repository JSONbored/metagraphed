// GET /api/v1/health/history/{date}, /api/v1/health/trends,
// /api/v1/incidents, /api/v1/subnets/{netuid}/health,
// /api/v1/subnets/{netuid}/health/incidents,
// /api/v1/subnets/{netuid}/health/percentiles,
// /api/v1/subnets/{netuid}/health/trends, /api/v1/subnets/{netuid}/uptime
// (types-epic B batch 9, #8063). Modeled from schemas/components/06-health
// .schema.json's HealthHistoryArtifact/BulkHealthTrendsArtifact/
// GlobalIncidentsArtifact/HealthSubnetArtifact/HealthIncidentsArtifact/
// HealthPercentilesArtifact/HealthTrendsArtifact/UptimeArtifact.
//
// D1 is fully retired (2026-07-17) -- every local-fallback loader
// (src/analytics-live.ts, src/bulk-health-trends.ts) now always returns the
// schema-stable empty shape. The real, non-empty data path for 6 of these 8
// routes is tryPostgresTier() (workers/postgres-tier.ts) proxying to a
// separate Worker (workers/data-api.ts) via a service binding, which calls
// these exact same pure format*() functions from src/health-serving.ts --
// same DATA_API-proxied pattern as batch 2's trend/economics routes.
//
// HealthSurface is registered here in its full legacy shape only to keep
// resolving the still-hand-edited HealthLatestArtifact.surfaces[] ($ref by
// name -- HealthLatestArtifact/`/api/v1/health/latest` is a different,
// out-of-batch route, not among this batch's 18) and because
// generate-client.ts hardcodes a components["schemas"]["HealthSurface"] type
// lookup by name. It is deliberately NOT reused for
// HealthSubnetArtifact.surfaces[] below: overlaySubnetHealth() (src/health-
// serving.ts) is the ONLY producer for that route (no static-artifact
// fallback -- workers/api.ts hardcodes `artifact = {ok:false}` for this
// route id, always calling liveHealthOverlay with a null staticArtifact) and
// its live-merged rows are a much smaller ~12-field shape (surface_id/
// netuid/kind/provider/url/status/classification/latency_ms/status_code/
// last_checked/last_ok/observed_by) that HealthSurface's full ~25-field/
// additionalProperties:false shape can't actually validate -- reusing it
// here would be a latent bug in the hand-edited contract (it already $refs
// HealthSurface for this field), not a safe free upgrade. Modeled a
// dedicated, route-local HealthSubnetSurfaceSchema instead.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { HealthStatusSchema } from "../shared.ts";
import { ClassificationSchema, SurfaceKindSchema } from "./subnet-detail.ts";
import { HealthSubnetSummarySchema } from "./health.ts";

// ---- GET /api/v1/health/history/{date} -> HealthHistoryArtifact ----

const HealthHistorySurfaceSchema = z
  .object({
    surface_id: z.string(),
    netuid: z.int().min(0),
    kind: SurfaceKindSchema,
    provider: z.string(),
    status: HealthStatusSchema,
    classification: ClassificationSchema,
    // Bucket (b): buildHealthHistoryArtifact()'s surfaces.map() is an object
    // literal that unconditionally sets every one of these 6 keys (`|| null`
    // fallback, never an omitted key) -- tightened from optional to
    // required-but-nullable.
    latency_ms: z.int().min(0).nullable(),
    status_code: z.int().nullable(),
    last_checked: z.string().nullable(),
    last_ok: z.string().nullable(),
    verified_at: z.string().nullable(),
    error_class: z.string().nullable(),
  })
  .strict();

export const HealthHistoryArtifactSchema = ArtifactBaseSchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Bucket (b): buildHealthHistoryArtifact() always sets these 3 (the two
  // *_at fields via `|| null`) -- tightened from optional to required.
  source: z.string(),
  probe_started_at: z.string().nullable(),
  probe_finished_at: z.string().nullable(),
  summary: z
    .object({
      surface_count: z.int().min(0),
      status_counts: CountMapSchema,
      classification_counts: CountMapSchema,
    })
    .passthrough(),
  surfaces: z.array(HealthHistorySurfaceSchema),
});
export type HealthHistoryArtifact = z.infer<typeof HealthHistoryArtifactSchema>;

// ---- GET /api/v1/health/trends (bulk, all subnets) ->
// BulkHealthTrendsArtifact -- distinct from the per-subnet HealthTrendsArtifact
// further below (same name the epic issue could be misread as sharing). ----

const BulkHealthTrendPointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    samples: z.int().min(0),
    uptime_ratio: z.number().min(0).max(1).nullable(),
    avg_latency_ms: z.int().min(0).nullable(),
    latency_sample_count: z.int().min(0),
  })
  .strict();

const BulkHealthTrendSubnetSchema = z
  .object({
    netuid: z.int().min(0),
    samples: z.int().min(0),
    uptime_ratio: z.number().min(0).max(1).nullable(),
    avg_latency_ms: z.int().min(0).nullable(),
    latency_sample_count: z.int().min(0),
    points: z.array(BulkHealthTrendPointSchema),
  })
  .strict();

// Hand-edited component declares additionalProperties:false at every level;
// formatBulkTrends()'s real return object never exceeds exactly these
// fields, confirmed by reading its body -- modeled .strict() throughout,
// unlike this file's other live-only artifacts (all still additionalProperties
// :true in the hand-edited schema, modeled .passthrough()).
export const BulkHealthTrendsArtifactSchema = z
  .object({
    schema_version: z.int(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    windows: z.record(
      z.string(),
      z
        .object({
          days: z.int().min(0),
          granularity: z.literal("1d"),
          subnet_count: z.int().min(0),
          subnets: z.array(BulkHealthTrendSubnetSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type BulkHealthTrendsArtifact = z.infer<
  typeof BulkHealthTrendsArtifactSchema
>;

// ---- GET /api/v1/incidents -> GlobalIncidentsArtifact ----

const GlobalIncidentEntrySchema = z
  .object({
    started_at: z.int(),
    ended_at: z.int(),
    // #8824: (ended_at - started_at) + PROBE_CADENCE_MS -- the observed
    // failed span plus one probe cadence, since the outage began sometime in
    // the interval before started_at and ended sometime in the interval
    // after ended_at. Always > ended_at - started_at.
    duration_ms: z.int().min(0),
    // Bucket (b): formatGlobalIncidents() always sets failed_samples --
    // tightened from optional to required.
    failed_samples: z.int().min(0),
  })
  .passthrough();

const GlobalIncidentSurfaceSchema = z
  .object({
    netuid: z.int().min(0),
    surface_id: z.string(),
    incident_count: z.int().min(0),
    // Bucket (b): formatGlobalIncidents() always computes and sets
    // downtime_ms (the sum of this surface's own incident durations) --
    // tightened from optional to required.
    downtime_ms: z.int().min(0),
    // #8824: sub-MIN_INCIDENT_SAMPLES gap-islands the incident query excludes
    // for this surface -- island count and their total failed probes --
    // always emitted (0 on the cold/no-flap path), never omitted.
    transient_failure_count: z.int().min(0),
    transient_failed_samples: z.int().min(0),
    incidents: z.array(GlobalIncidentEntrySchema),
  })
  .passthrough();

export const GlobalIncidentsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    summary: z
      .object({
        incident_count: z.int().min(0),
        affected_surface_count: z.int().min(0),
      })
      .passthrough(),
    // #8824: the incident-qualifying threshold (MIN_INCIDENT_SAMPLES),
    // published once so a surface's transient_failure_count is self-describing.
    min_incident_samples: z.int().min(1),
    surfaces: z.array(GlobalIncidentSurfaceSchema),
  })
  .passthrough();
export type GlobalIncidentsArtifact = z.infer<
  typeof GlobalIncidentsArtifactSchema
>;

// ---- GET /api/v1/subnets/{netuid}/health -> HealthSubnetArtifact ----

// See this file's header -- deliberately NOT the registered HealthSurface
// component below; overlaySubnetHealth()'s live-merged rows are a distinct,
// much smaller shape.
const HealthSubnetSurfaceSchema = z
  .object({
    surface_id: z.string(),
    netuid: z.int().min(0),
    kind: SurfaceKindSchema,
    provider: z.string(),
    url: z.string(),
    status: HealthStatusSchema,
    classification: ClassificationSchema.optional(),
    latency_ms: z.int().min(0).nullable().optional(),
    status_code: z.int().nullable().optional(),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    observed_by: z.literal("live-cron-prober"),
  })
  .strict();

export const HealthSubnetArtifactSchema = z
  .object({
    schema_version: z.int(),
    contract_version: z.string().optional(),
    generated_at: z.string().nullable().optional(),
    netuid: z.int().min(0),
    slug: z.string().optional(),
    name: z.string().optional(),
    health_source: z.string().optional(),
    operational_observed_at: z.string().nullable().optional(),
    summary: HealthSubnetSummarySchema,
    surfaces: z.array(HealthSubnetSurfaceSchema),
  })
  .passthrough();
export type HealthSubnetArtifact = z.infer<typeof HealthSubnetArtifactSchema>;

// Full legacy shape -- kept only for HealthLatestArtifact's still-hand-edited
// $ref and generate-client.ts's hardcoded type lookup (see header); NOT used
// by this batch's own HealthSubnetArtifact.surfaces[] above.
export const HealthSurfaceSchema = z
  .object({
    auth_required: z.boolean().optional(),
    surface_id: z.string(),
    netuid: z.int().min(0),
    subnet_name: z.string().optional(),
    subnet_slug: z.string().optional(),
    kind: SurfaceKindSchema.optional(),
    provider: z.string().optional(),
    status: HealthStatusSchema,
    classification: ClassificationSchema,
    content_type: z.string().nullable().optional(),
    url: z.string(),
    latency_ms: z.int().min(0).nullable().optional(),
    method_tested: z.string().optional(),
    private_redirect_blocked: z.boolean().optional(),
    public_safe: z.boolean().optional(),
    redirect_target: z.string().nullable().optional(),
    status_code: z.int().nullable().optional(),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    verified_at: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    error_class: z.string().nullable().optional(),
    uptime_sample_ratio: z.number().min(0).max(1).nullable().optional(),
    archive_support: z.boolean().nullable().optional(),
    latest_block: z.int().min(0).nullable().optional(),
    method_results: z.record(z.string(), z.object({}).passthrough()).optional(),
    methods_supported: z
      .union([z.record(z.string(), z.boolean()), z.array(z.string()), z.null()])
      .optional(),
    rpc_method_count: z.int().min(0).nullable().optional(),
  })
  .strict();
export type HealthSurface = z.infer<typeof HealthSurfaceSchema>;

// ---- GET /api/v1/subnets/{netuid}/health/incidents -> HealthIncidentsArtifact ----

const HealthIncidentEntrySchema = z
  .object({
    started_at: z.int(),
    ended_at: z.int(),
    // #8824: (ended_at - started_at) + PROBE_CADENCE_MS -- the observed
    // failed span plus one probe cadence, since the outage began sometime in
    // the interval before started_at and ended sometime in the interval
    // after ended_at. Always > ended_at - started_at.
    duration_ms: z.int().min(0),
    failed_samples: z.int().min(0),
  })
  .passthrough();

const HealthIncidentSurfaceSchema = z
  .object({
    surface_id: z.string(),
    samples: z.int().min(0),
    uptime_ratio: z.number().nullable(),
    incident_count: z.int().min(0),
    downtime_ms: z.int().min(0),
    // #8824: sub-MIN_INCIDENT_SAMPLES gap-islands the incident query excludes
    // for this surface -- island count and their total failed probes --
    // always emitted (0 on the cold/no-flap path), never omitted. Reconciles
    // uptime_ratio against incident_count: incident_count 0 alongside
    // uptime_ratio < 1 only ever occurs with transient_failure_count > 0.
    transient_failure_count: z.int().min(0),
    transient_failed_samples: z.int().min(0),
    incidents: z.array(HealthIncidentEntrySchema),
  })
  .passthrough();

export const HealthIncidentsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    // #8824: the incident-qualifying threshold (MIN_INCIDENT_SAMPLES),
    // published once so a surface's transient_failure_count is self-describing.
    min_incident_samples: z.int().min(1),
    surfaces: z.array(HealthIncidentSurfaceSchema),
  })
  .passthrough();
export type HealthIncidentsArtifact = z.infer<
  typeof HealthIncidentsArtifactSchema
>;

// ---- GET /api/v1/subnets/{netuid}/health/percentiles -> HealthPercentilesArtifact ----

const HealthPercentilesSurfaceSchema = z
  .object({
    surface_id: z.string(),
    samples: z.int().min(0),
    // Bucket (b): formatPercentiles() always sets all 6 sub-keys (via
    // roundInt(), never conditionally omitted) -- tightened from optional to
    // required-but-nullable.
    latency_ms: z
      .object({
        p50: z.int().nullable(),
        p95: z.int().nullable(),
        p99: z.int().nullable(),
        avg: z.int().nullable(),
        min: z.int().nullable(),
        max: z.int().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export const HealthPercentilesArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    surfaces: z.array(HealthPercentilesSurfaceSchema),
  })
  .passthrough();
export type HealthPercentilesArtifact = z.infer<
  typeof HealthPercentilesArtifactSchema
>;

// ---- GET /api/v1/subnets/{netuid}/health/trends -> HealthTrendsArtifact
// (per-subnet -- NOT the bulk BulkHealthTrendsArtifact above). ----

const HealthTrendSurfaceSchema = z
  .object({
    surface_id: z.string(),
    samples: z.int().min(0),
    uptime_ratio: z.number().nullable(),
    avg_latency_ms: z.int().nullable(),
    latency_sample_count: z.int().min(0),
    // Bucket (b): formatTrends() always sets all 3 sub-keys -- tightened
    // from optional to required-but-nullable.
    latency_ms: z
      .object({
        p50: z.int().nullable(),
        p95: z.int().nullable(),
        p99: z.int().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const HealthTrendWindowSchema = z
  .object({
    samples: z.int().min(0),
    uptime_ratio: z.number().nullable(),
    latency_sample_count: z.int().min(0),
    surfaces: z.array(HealthTrendSurfaceSchema),
  })
  .passthrough();

export const HealthTrendsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    windows: z.record(z.string(), HealthTrendWindowSchema),
  })
  .passthrough();
export type HealthTrendsArtifact = z.infer<typeof HealthTrendsArtifactSchema>;

// ---- GET /api/v1/subnets/{netuid}/uptime -> UptimeArtifact ----

// Shared by both the subnet-level `reliability` (adds window/surface_count/
// day_count/computed_at) and each per-surface `reliability` (lacks those 4)
// -- src/reliability.ts's ReliabilityResult union, read directly. Only 2
// referrers, both within UptimeArtifact itself -- modeled locally, not
// registered (same intra-component-reuse treatment as this repo's existing
// ChainTransferParty precedent).
const ReliabilityScoreSchema = z
  .object({
    score: z.int().min(0).max(100),
    grade: z.enum(["A", "B", "C", "D", "F"]),
    uptime_ratio: z.number().nullable(),
    avg_latency_ms: z.int().nullable(),
    sample_count: z.int().min(0),
    latency_sample_count: z.int().min(0),
    window: z.string().nullable().optional(),
    surface_count: z.int().min(0).optional(),
    day_count: z.int().min(0).optional(),
    computed_at: z.string().nullable().optional(),
  })
  .passthrough();

const UptimeDaySchema = z
  .object({
    day: z.string(),
    samples: z.int().min(0),
    uptime_ratio: z.number().nullable(),
    avg_latency_ms: z.int().nullable().optional(),
    latency_sample_count: z.int().min(0).optional(),
    latency_ms: z
      .object({
        p50: z.int().nullable().optional(),
        p95: z.int().nullable().optional(),
        p99: z.int().nullable().optional(),
      })
      .passthrough()
      .optional(),
    status: z.string(),
  })
  .passthrough();

const UptimeSurfaceSchema = z
  .object({
    surface_id: z.string(),
    day_count: z.int().min(0),
    samples: z.int().min(0),
    uptime_ratio: z.number().nullable(),
    reliability: z.union([ReliabilityScoreSchema, z.null()]).optional(),
    days: z.array(UptimeDaySchema),
  })
  .passthrough();

export const UptimeArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    source: z.string(),
    // Always-present key in formatUptime()'s real return (its value is the
    // JS null when there are no samples, never an omitted key) -- required,
    // unlike the per-surface `reliability` above (no comparable guarantee).
    reliability: z.union([ReliabilityScoreSchema, z.null()]),
    surfaces: z.array(UptimeSurfaceSchema),
  })
  .passthrough();
export type UptimeArtifact = z.infer<typeof UptimeArtifactSchema>;
