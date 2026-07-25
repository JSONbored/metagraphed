// GET /api/v1/subnets/{netuid}/surfaces, /api/v1/surfaces,
// /api/v1/subnets/{netuid}/endpoints, /api/v1/endpoints,
// /api/v1/endpoint-incidents, /api/v1/endpoint-pools (types-epic B batch 9,
// #8063). Modeled from schemas/components/04-surfaces.schema.json's
// SubnetSurfacesArtifact/SurfacesArtifact and 07-endpoints-rpc.schema.json's
// SubnetEndpointsArtifact/EndpointsArtifact/EndpointIncidentsArtifact/
// EndpointPoolsArtifact.
//
// Surface/EndpointResource are ALREADY registered Zod components (pilot
// batch, schemas-src/routes/subnet-detail.ts) -- reused by import, not
// redefined. EndpointSummary/EndpointProviderScore are ALSO already-modeled
// Zod schemas (batch 10, providers-rpc.ts, exported there specifically for
// this reuse) -- same treatment.
//
// Bucket (b) finding: the hand-edited SubnetSurfacesArtifact was declared as
// a bare `$ref` alias to its global counterpart (SurfacesArtifact), which
// drops the real, always-present netuid/slug/name fields the real per-subnet
// builder writes (and the global counterpart never carries -- the two are
// mutually exclusive key sets, verified against real built artifacts).
// Modeled as its own distinct shape instead of an alias, matching this same
// codebase's own SubnetEndpointsArtifact precedent (which already declared
// netuid/slug/name correctly, never aliased its global counterpart).
//
// EndpointPoolsArtifact is a pure runtime alias of the still-hand-edited
// RpcPoolsArtifact: buildEndpointPoolArtifact() (scripts/lib/endpoint-
// artifacts.ts) builds BOTH /metagraph/endpoint-pools.json and
// /metagraph/rpc/pools.json from the exact same function, byte-identical
// per-pool/per-endpoint/per-provider-score shape. Reuses RpcPoolsArtifact's
// already-Zod-owned RpcPool/EndpointProviderScore sub-shapes (batch 10) by
// import rather than remodeling them, but registers as its own distinct
// top-level component -- EndpointPoolsArtifact's own route needs a
// schema_ref of that exact name, and the Zod component registry maps one
// name per schema object (a literal "$ref-only" alias the way the
// hand-edited JSON declared it isn't representable that way) -- an
// identically-shaped independent schema is the correct equivalent. Unlike
// its sibling /api/v1/rpc/pools (LIVE_OVERLAY_ROUTE_IDS, refreshed from the
// 15-minute cron via overlayRpcPoolEligibility), /api/v1/endpoint-pools is
// NOT in LIVE_OVERLAY_ROUTE_IDS and gets no live overlay at all -- fully
// static, edge-cache eligible (verified via workers/api.ts).
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { HealthStatusSchema } from "../shared.ts";
import {
  ClassificationSchema,
  EndpointLayerSchema,
  EndpointResourceSchema,
  SurfaceKindSchema,
  SurfaceSchema,
} from "./subnet-detail.ts";
import {
  EndpointProviderScoreSchema,
  EndpointSummarySchema,
  RpcPoolSchema,
} from "./providers-rpc.ts";

// ---- GET /api/v1/surfaces -> SurfacesArtifact ----

export const SurfacesArtifactSchema = ArtifactBaseSchema.extend({
  surfaces: z.array(SurfaceSchema),
});
export type SurfacesArtifact = z.infer<typeof SurfacesArtifactSchema>;

// ---- GET /api/v1/subnets/{netuid}/surfaces -> SubnetSurfacesArtifact
// (own shape -- see header; NOT a $ref alias to SurfacesArtifact). ----

export const SubnetSurfacesArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  surfaces: z.array(SurfaceSchema),
});
export type SubnetSurfacesArtifact = z.infer<
  typeof SubnetSurfacesArtifactSchema
>;

// ---- GET /api/v1/endpoints -> EndpointsArtifact ----
// Live-overlaid on every real request (LIVE_OVERLAY_ROUTE_IDS):
// overlayArtifactEndpoints() (src/health-serving.ts) always adds
// operational_observed_at/health_source on top of the static shape below.

export const EndpointsArtifactSchema = ArtifactBaseSchema.extend({
  // Always set by buildEndpointResourceArtifact() (the raw static artifact);
  // "artifact-build" at this route's real call site, but the builder itself
  // takes any string -- kept open rather than a z.literal.
  source: z.string(),
  operational_observed_at: z.string().nullable().optional(),
  health_source: z.string().optional(),
  summary: EndpointSummarySchema,
  endpoints: z.array(EndpointResourceSchema),
});
export type EndpointsArtifact = z.infer<typeof EndpointsArtifactSchema>;

// ---- GET /api/v1/subnets/{netuid}/endpoints -> SubnetEndpointsArtifact ----
// Real per-subnet builder (build-artifacts.ts) never sets `source` (its
// inline literal omits the key entirely, unlike the global EndpointsArtifact
// above) -- deliberately not declared here. Also live-overlaid on every real
// request, same as EndpointsArtifact.

export const SubnetEndpointsArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  operational_observed_at: z.string().nullable().optional(),
  health_source: z.string().optional(),
  summary: EndpointSummarySchema,
  endpoints: z.array(EndpointResourceSchema),
});
export type SubnetEndpointsArtifact = z.infer<
  typeof SubnetEndpointsArtifactSchema
>;

// ---- GET /api/v1/endpoint-incidents -> EndpointIncidentsArtifact ----

// Registered below (openapi-registry.ts): scripts/validate-schema-enums.ts
// hardcodes comparePropertyEnum("EndpointIncident", "severity"/"state", ...)
// against it as a top-level components.schemas entry by name, not via $ref.
export const EndpointIncidentSchema = z
  .object({
    id: z.string(),
    endpoint_id: z.string(),
    surface_id: z.string(),
    surface_key: z.string(),
    netuid: z.int().min(0),
    subnet_slug: z.string().optional(),
    subnet_name: z.string().optional(),
    layer: EndpointLayerSchema,
    kind: SurfaceKindSchema,
    provider: z.string(),
    operator: z.string(),
    status: HealthStatusSchema,
    classification: ClassificationSchema,
    // buildEndpointIncidentArtifact() only ever emits "critical" (status
    // failed) or "warning" (status degraded) in practice -- "info" is a
    // declared-but-currently-unproducible enum value, kept for contract
    // stability (matches QUERY_ENUMS.endpointIncidentSeverity, the same list
    // validate-schema-enums.ts checks this field against).
    severity: z.enum(["critical", "warning", "info"]),
    // Always "active" in real output -- "resolved" is declared-but-
    // currently-unproducible (the builder hardcodes state: "active"), kept
    // for the same contract-stability/enum-drift-check reason as severity.
    state: z.enum(["active", "resolved"]),
    reason: z.string(),
    detected_at: z.string(),
    observed_at: z.string().nullable(),
    health_source: z.enum(["probe-derived", "missing-probe", "not-monitored"]),
    health_stale: z.boolean(),
    last_ok: z.string().nullable(),
    last_checked: z.string().nullable(),
    pool_eligible: z.boolean(),
    user_reported: z.boolean(),
    source: z.literal("probe-derived"),
  })
  .strict();
export type EndpointIncident = z.infer<typeof EndpointIncidentSchema>;

// Only 3 referrers, all within this batch's own EndpointIncidentsArtifact --
// modeled locally, not registered (same treatment as health-surfaces.ts's
// ReliabilityScore).
//
// Bucket (b): countRecord() (scripts/lib/endpoint-artifacts.ts) always
// returns a defined object (empty {} for zero incidents, never undefined) --
// every by_* field is unconditionally present, tightened from optional to
// required.
const EndpointIncidentSummarySchema = z
  .object({
    incident_count: z.int().min(0),
    active_count: z.int().min(0),
    by_kind: CountMapSchema,
    by_layer: CountMapSchema,
    by_provider: CountMapSchema,
    by_severity: CountMapSchema,
    by_status: CountMapSchema,
  })
  .strict();

export const EndpointIncidentsArtifactSchema = ArtifactBaseSchema.extend({
  // Always this exact literal in buildEndpointIncidentArtifact()'s return.
  source: z.literal("endpoint-resource-probes"),
  summary: EndpointIncidentSummarySchema,
  incidents: z.array(EndpointIncidentSchema),
});
export type EndpointIncidentsArtifact = z.infer<
  typeof EndpointIncidentsArtifactSchema
>;

// ---- GET /api/v1/endpoint-pools -> EndpointPoolsArtifact ----
// See header: a runtime (not registry) alias of RpcPoolsArtifact, reusing
// its already-Zod-owned RpcPool/EndpointProviderScore sub-shapes. Structure
// mirrors RpcPoolsArtifactSchema (providers-rpc.ts) field-for-field since
// buildEndpointPoolArtifact() is the one function that produces both.

export const EndpointPoolsArtifactSchema = ArtifactBaseSchema.extend({
  source: z.enum(["endpoint-resource-probes", "rpc-endpoint-probes"]),
  disabled_proxy_contract: z
    .object({
      enabled: z.boolean().optional(),
      feature_flag: z.string().optional(),
      allowed_methods: z.array(z.string()).optional(),
      denied_method_patterns: z.array(z.string()).optional(),
      rate_limit_required: z.boolean().optional(),
      waf_required: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  eligibility_policy: z
    .object({
      source: z.string().optional(),
      eligible_layers: z.array(z.string()).optional(),
      required_status: z.string().optional(),
      requires_no_auth: z.boolean().optional(),
      requires_public_safe: z.boolean().optional(),
      user_reports_can_change_health: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .passthrough()
    .optional(),
  provider_scores: z.array(EndpointProviderScoreSchema).optional(),
  pools: z.array(RpcPoolSchema),
});
export type EndpointPoolsArtifact = z.infer<typeof EndpointPoolsArtifactSchema>;
