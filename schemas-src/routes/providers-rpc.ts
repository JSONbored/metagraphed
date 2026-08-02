// GET /api/v1/providers/{slug}, /api/v1/providers/{slug}/endpoints,
// /api/v1/providers, /api/v1/rpc/endpoints, /api/v1/rpc/pools,
// /api/v1/rpc/usage (types-epic B batch 10, #8064). Modeled from
// schemas/components/03-providers.schema.json and
// schemas/components/07-endpoints-rpc.schema.json's RpcEndpointsArtifact/
// RpcPoolsArtifact, plus schemas/components/06-health.schema.json's
// RpcUsageArtifact (fully live, "no static file" per its own description).
//
// EndpointResource is ALREADY a registered Zod component (pilot batch,
// schemas-src/routes/subnet-detail.ts) -- reused by import for
// ProviderEndpointsArtifact.endpoints[], not redefined.
//
// RpcEndpoint/RpcPoolEndpoint/EndpointProviderScore are each referenced only
// by this batch's own components (verified via repo-wide $ref grep) --
// modeled locally, not registered. Provider and RpcPool are ALSO modeled
// locally by $ref-grep standards, but BOTH are registered anyway:
// generated/metagraphed-client.ts (scripts/generate-client.ts) hardcodes
// `components["schemas"]["Provider"]`/`["RpcPool"]` type lookups -- caught by
// `npm run typecheck`, not by the $ref-grep test alone (same class of gap as
// AgentReadinessStatus in agent-catalog.ts). EndpointSummary IS still
// referenced by two other, not-yet-converted components in this same file
// (EndpointPoolsArtifact/EndpointsArtifact, outside this batch) -- its
// hand-edited definition stays untouched; a local unregistered copy is
// modeled here for ProviderEndpointsArtifact's own use.
//
// Bucket (b) finding: RpcEndpoint.method_tested can be null in real
// buildRpcEndpointArtifact() output (no health row AND no configured
// probe.method fallback) -- the hand-edited schema never declared it
// nullable.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import { BittensorNetworkSchema, HealthStatusSchema } from "../shared.ts";
import {
  AuthoritySchema,
  ClassificationSchema,
  EndpointLayerSchema,
  EndpointResourceSchema,
  EndpointScoreReasonSchema,
  SurfaceKindSchema,
} from "./subnet-detail.ts";

export const ProviderKindSchema = z.enum([
  "subnet-team",
  "infrastructure-provider",
  "data-provider",
  "docs-provider",
  "registry",
]);

const HttpUrlSchema = z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//);

export const ProviderSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    kind: ProviderKindSchema,
    website_url: HttpUrlSchema,
    docs_url: HttpUrlSchema.optional(),
    github_url: HttpUrlSchema.optional(),
    logo_url: HttpUrlSchema.optional(),
    social: z
      .object({
        x: HttpUrlSchema.optional(),
        telegram: HttpUrlSchema.optional(),
        reddit: HttpUrlSchema.optional(),
        youtube: HttpUrlSchema.optional(),
      })
      .strict()
      .optional(),
    team_url: HttpUrlSchema.optional(),
    contact_url: HttpUrlSchema.optional(),
    authority: AuthoritySchema,
    public_notes: z.string().optional(),
    notes: z.string().optional(),
    netuids: z.array(z.int().min(0)).optional(),
    subnet_count: z.int().min(0).optional(),
    surface_count: z.int().min(0).optional(),
    endpoint_count: z.int().min(0).optional(),
    cluster_id: z.string().optional(),
  })
  .strict();

// Exported (batch 9, #8063): field-for-field identical to the hand-edited
// EndpointSummary component that EndpointsArtifact/SubnetEndpointsArtifact
// (schemas-src/routes/endpoints-pools.ts) also $ref -- reused by import
// there rather than redefined, same free-upgrade pattern this file's own
// header describes for EndpointResource/Surface.
export const EndpointSummarySchema = z
  .object({
    endpoint_count: z.int().min(0),
    monitored_count: z.int().min(0),
    pool_eligible_count: z.int().min(0),
    by_kind: z.record(z.string(), z.int().min(0)).optional(),
    by_layer: z.record(z.string(), z.int().min(0)).optional(),
    by_provider: z.record(z.string(), z.int().min(0)).optional(),
    by_publication_state: z.record(z.string(), z.int().min(0)).optional(),
    by_status: z.record(z.string(), z.int().min(0)).optional(),
  })
  .strict();

// Bucket (b): scripts/build-artifacts.ts's per-slug write always includes
// endpoint_summary (via endpointSummary()) alongside `provider` -- not in
// the hand-edited schema's named properties, only legal today via
// ProviderArtifact's additionalProperties:true.
export const ProviderArtifactSchema = ArtifactBaseSchema.extend({
  provider: ProviderSchema,
  endpoint_summary: EndpointSummarySchema.optional(),
});
export type ProviderArtifact = z.infer<typeof ProviderArtifactSchema>;

export const ProvidersArtifactSchema = ArtifactBaseSchema.extend({
  providers: z.array(ProviderSchema),
});
export type ProvidersArtifact = z.infer<typeof ProvidersArtifactSchema>;

export const ProviderEndpointsArtifactSchema = ArtifactBaseSchema.extend({
  provider: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      kind: z.string().optional(),
      authority: z.string().optional(),
    })
    .passthrough(),
  summary: EndpointSummarySchema,
  endpoints: z.array(EndpointResourceSchema),
});
export type ProviderEndpointsArtifact = z.infer<
  typeof ProviderEndpointsArtifactSchema
>;

const RpcEndpointSchema = z
  .object({
    id: z.string(),
    auth_required: z.boolean().optional(),
    authority: AuthoritySchema.optional(),
    kind: z.enum(["subtensor-rpc", "subtensor-wss"]),
    url: z.url(),
    provider: z.string(),
    netuid: z.int().min(0).optional(),
    subnet_name: z.string().optional(),
    subnet_slug: z.string().optional(),
    status: HealthStatusSchema,
    classification: ClassificationSchema,
    network: BittensorNetworkSchema,
    chain: z.literal("bittensor"),
    archive_support: z.boolean().nullable().optional(),
    latency_ms: z.int().min(0).nullable().optional(),
    observed_at: z.string().nullable(),
    health_source: z.enum(["probe-derived", "missing-probe", "not-monitored"]),
    health_stale: z.boolean(),
    last_ok: z.string().nullable(),
    latest_block: z.int().min(0).nullable().optional(),
    rpc_method_count: z.int().min(0).nullable().optional(),
    methods_supported: z
      .union([z.record(z.string(), z.boolean()), z.array(z.string()), z.null()])
      .optional(),
    // Bucket (b): buildRpcEndpointArtifact() can leave this null (no health
    // row AND no configured probe.method fallback) -- the hand-edited schema
    // never declared it nullable.
    method_tested: z.string().nullable().optional(),
    public_safe: z.boolean().optional(),
    rate_limit_notes: z.string().nullable().optional(),
    source_urls: z.array(z.url()).optional(),
    last_checked: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .strict();

export const RpcEndpointsArtifactSchema = ArtifactBaseSchema.extend({
  summary: z
    .object({
      endpoint_count: z.int().min(0),
      archive_supported_count: z.int().min(0).optional(),
      by_kind: z.record(z.string(), z.int().min(0)).optional(),
      by_provider: z.record(z.string(), z.int().min(0)).optional(),
      by_status: z.record(z.string(), z.int().min(0)).optional(),
    })
    .passthrough(),
  endpoints: z.array(RpcEndpointSchema),
});
export type RpcEndpointsArtifact = z.infer<typeof RpcEndpointsArtifactSchema>;

const RpcPoolEndpointSchema = z
  .object({
    id: z.string(),
    surface_id: z.string().optional(),
    surface_key: z.string().optional(),
    kind: SurfaceKindSchema.optional(),
    layer: EndpointLayerSchema.optional(),
    url: z.url(),
    provider: z.string(),
    auth_required: z.boolean().optional(),
    public_safe: z.boolean().optional(),
    status: HealthStatusSchema,
    score: z.int(),
    score_reasons: z.array(EndpointScoreReasonSchema).optional(),
    pool_eligible: z.boolean(),
    pool_eligibility_reasons: z.array(z.string()).optional(),
    archive_support: z.boolean().nullable().optional(),
    latency_ms: z.int().min(0).nullable().optional(),
    observed_at: z.string().nullable(),
    // The first three are what the BUILD emits (endpoint-artifacts.ts).
    // `live-cron-prober` is injected at SERVE time by overlayRpcPoolEligibility,
    // which replaces each pool endpoint's health from the 15-minute cron
    // snapshot -- so it is the value the majority of this route's endpoints
    // actually carry, and omitting it made 15 of 20 fail their own schema
    // (#9138).
    //
    // `unavailable` is deliberately NOT here. overlayEndpointHealth emits it
    // for a surface with no live reading, but overlayRpcPoolEligibility returns
    // such an endpoint untouched (`if (!live) return endpoint`), so this route
    // cannot produce it. Widening past what the producer emits would stop this
    // enum catching the next drift.
    health_source: z.enum([
      "probe-derived",
      "missing-probe",
      "not-monitored",
      "live-cron-prober",
    ]),
    health_stale: z.boolean(),
    last_ok: z.string().nullable(),
    latest_block: z.int().min(0).nullable().optional(),
  })
  .strict();

export const RpcPoolSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    best_endpoint_id: z.string().nullable().optional(),
    endpoint_count: z.int().min(0),
    eligible_count: z.int().min(0),
    endpoints: z.array(RpcPoolEndpointSchema),
  })
  .strict();

// Exported (batch 9, #8063): field-for-field identical to the shape
// endpointProviderScores() (scripts/lib/endpoint-artifacts.ts) produces for
// EndpointPoolsArtifact.provider_scores[] too (same function builds both
// artifacts) -- reused by import there, same treatment as EndpointSummary
// above.
export const EndpointProviderScoreSchema = z
  .object({
    provider: z.string(),
    endpoint_count: z.int().min(0),
    monitored_count: z.int().min(0),
    ok_count: z.int().min(0),
    failed_count: z.int().min(0),
    degraded_count: z.int().min(0),
    pool_eligible_count: z.int().min(0),
    average_score: z.int(),
    operational_score: z.int(),
  })
  .strict();

export const RpcPoolsArtifactSchema = ArtifactBaseSchema.extend({
  // Bucket (b), found while re-reading this function for batch 9 (#8063)'s
  // EndpointPoolsArtifact reuse: buildEndpointPoolArtifact() always sets
  // `source` (either literal, never omitted) -- this batch's own schema
  // never declared it. Purely additive (ArtifactBase is .passthrough(), so
  // this was already tolerated, just undocumented).
  source: z
    .enum(["endpoint-resource-probes", "rpc-endpoint-probes"])
    .optional(),
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
export type RpcPoolsArtifact = z.infer<typeof RpcPoolsArtifactSchema>;

// Fully live (rpc_proxy_events telemetry), no static file, no ArtifactBase --
// window/bucket_granularity/observed_at are request-scoped, not build-scoped.
const RpcUsageEndpointRowSchema = z
  .object({
    rank: z.int().min(1).optional(),
    endpoint_id: z.string().nullable(),
    provider: z.string().nullable().optional(),
    requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_rate: z.number().nullable().optional(),
    avg_latency_ms: z.int().nullable().optional(),
  })
  .passthrough();

const RpcUsageNetworkRowSchema = z
  .object({
    network: z.string(),
    requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_rate: z.number().nullable().optional(),
  })
  .passthrough();

const RpcUsageBucketSchema = z
  .object({
    ts: z.int().min(0),
    requests: z.int().min(0),
    errors: z.int().min(0),
    avg_latency_ms: z.int().nullable(),
  })
  .passthrough();

export const RpcUsageArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable().optional(),
    bucket_granularity: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    summary: z
      .object({
        total_requests: z.int().min(0),
        ok_requests: z.int().min(0),
        error_requests: z.int().min(0),
        error_rate: z.number().nullable().optional(),
        failover_requests: z.int().min(0).optional(),
        failover_rate: z.number().nullable().optional(),
        cache_hits: z.int().min(0).optional(),
        cache_hit_rate: z.number().nullable().optional(),
        latency_ms: z
          .object({
            p50: z.int().nullable().optional(),
            p95: z.int().nullable().optional(),
            avg: z.int().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    endpoints: z.array(RpcUsageEndpointRowSchema),
    networks: z.array(RpcUsageNetworkRowSchema),
    buckets: z.array(RpcUsageBucketSchema),
  })
  .passthrough();
export type RpcUsageArtifact = z.infer<typeof RpcUsageArtifactSchema>;
