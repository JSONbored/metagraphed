// GET /api/v1/subnets/{netuid} (types-epic A pilot route #2 of 5, #7859) —
// single-entity envelope variant, with a live per-endpoint health overlay
// merged onto the static artifact (workers/api.ts's liveHealthOverlay ->
// overlayOverviewHealth). No query params — only the {netuid} path param
// (src/contracts.ts's "subnet-detail" route() call).
//
// This is the deepest of the 5 pilot shapes: SubnetDetailArtifact nests
// SubnetDetail/Surface/CandidateSurface/EndpointResource/Gaps, each with
// their own real sub-shapes. Modeled to the same .strict() standard as every
// other pilot route by reading public/metagraph/openapi.json's full
// component graph for these (built from src/contracts.ts) — no field was
// left as z.unknown() to save time. Two fields stay z.object({}).passthrough():
// SubnetDetail's `links[]` entries and `provenance` — both are genuinely
// additionalProperties:true with NO fixed keys in the source OpenAPI schema
// itself (not a shortcut introduced here), matching the issue's own
// documented-open-map carve-out.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import {
  CoverageLevelSchema,
  CurationLevelSchema,
  HealthStatusSchema,
  PartnershipMetadataSchema,
  SubnetEconomicsSchema,
  SubnetStatusSchema,
  SubnetTypeSchema,
} from "../shared.ts";

const HttpUrlSchema = z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//);
const HttpOrWssUrlSchema = z
  .string()
  .regex(/^(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?):\/\//);

export const SurfaceKindSchema = z.enum([
  "archive",
  "subtensor-rpc",
  "subtensor-wss",
  "subnet-api",
  "openapi",
  "sse",
  "sdk",
  "example",
  "website",
  "source-repo",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const SourceTierSchema = z.enum([
  "native-chain",
  "provider-claimed",
  "third-party-index",
  "community-docs",
]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const ClassificationSchema = z.enum([
  "live",
  "redirected",
  "auth-required",
  "dead",
  "unsafe",
  "unsupported",
  "rate-limited",
  "transient",
  "timeout",
  "content-mismatch",
  "wrong-chain",
  "unknown",
]);
export type Classification = z.infer<typeof ClassificationSchema>;

export const CandidateStateSchema = z.enum([
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected",
]);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

const QualitySignalsSchema = z
  .object({
    archived: z.boolean().optional(),
    content_type_matches_kind: z.boolean().optional(),
    has_default_branch: z.boolean().optional(),
    has_recent_push_metadata: z.boolean().optional(),
    public_safe: z.boolean().optional(),
    rate_limited: z.boolean().optional(),
    redirected: z.boolean().optional(),
    source_tier: SourceTierSchema.optional(),
    transient_failure: z.boolean().optional(),
  })
  .strict();

const VerificationResultSchema = z
  .object({
    archived: z.boolean().optional(),
    candidate_id: z.string(),
    classification: ClassificationSchema,
    confidence_score: z.int().min(0).max(100).optional(),
    content_type: z.string().nullable().optional(),
    default_branch: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    github_api_status: z.int().optional(),
    github_api_url: z.string().optional(),
    homepage: z.string().nullable().optional(),
    html_url: z.string().optional(),
    kind: SurfaceKindSchema.optional(),
    last_push_at: z.string().nullable().optional(),
    latency_ms: z.int().min(0).nullable().optional(),
    method_tested: z.string().optional(),
    name: z.string().optional(),
    netuid: z.int().min(0).optional(),
    private_redirect_blocked: z.boolean().optional(),
    provider: z.string().optional(),
    quality_signals: QualitySignalsSchema.optional(),
    redirect_target: z.string().nullable().optional(),
    source_tier: SourceTierSchema.optional(),
    source_type: z.string().optional(),
    source_url: z.string().optional(),
    source_urls: z.array(z.string()).optional(),
    status: HealthStatusSchema,
    status_code: z.int().nullable().optional(),
    topics: z.array(z.string()).optional(),
    url: z.string(),
    verified_at: z.string(),
  })
  .strict();

const RateLimitSchema = z
  .object({
    burst: z.int().min(0).optional(),
    cost_notes: z.string().optional(),
    requests: z.int().min(0),
    scope: z.enum(["per-key", "per-ip", "global", "unknown"]).optional(),
    window: z.string().min(1),
  })
  .strict();

const AuthSchema = z
  .object({
    body_envelope: z
      .object({
        credential_key: z.string().min(1),
        payload_key: z.string().min(1),
      })
      .strict()
      .optional(),
    location: z.enum(["header", "query", "cookie", "body"]).optional(),
    name: z.string().optional(),
    names: z.array(z.string()).optional(),
    scheme: z.enum([
      "none",
      "bearer",
      "api-key",
      "basic",
      "oauth2",
      "signature",
      "custom",
    ]),
    scopes_note: z.string().optional(),
    token_url: HttpUrlSchema.optional(),
    value_format: z.string().optional(),
  })
  .strict()
  .nullable()
  .optional();

export const CandidateSurfaceSchema = z
  .object({
    auth: AuthSchema,
    auth_required: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    confirmed_by: z.array(z.string()).optional(),
    id: z.string(),
    kind: SurfaceKindSchema,
    name: z.string(),
    netuid: z.int().min(0),
    provider: z.string(),
    public_safe: z.boolean(),
    rate_limit: RateLimitSchema.optional(),
    rate_limit_notes: z.string().optional(),
    review_notes: z.string().optional(),
    schema_version: z.literal(1),
    source_tier: SourceTierSchema.optional(),
    source_type: z.string().optional(),
    source_url: z.string(),
    source_urls: z.array(z.string()).optional(),
    state: CandidateStateSchema,
    subnet_name: z.string().nullable().optional(),
    superseded_by: z.string().nullable().optional(),
    url: z.string(),
    verification: z.union([VerificationResultSchema, z.null()]).optional(),
  })
  .strict();
export type CandidateSurface = z.infer<typeof CandidateSurfaceSchema>;

export const AuthoritySchema = z.enum([
  "official",
  "provider-claimed",
  "community",
  "registry-observed",
]);
export type Authority = z.infer<typeof AuthoritySchema>;

export const EndpointLayerSchema = z.enum([
  "bittensor-base",
  "subnet-app",
  "data-provider",
  "docs-provider",
]);
export type EndpointLayer = z.infer<typeof EndpointLayerSchema>;

export const EndpointPublicationStateSchema = z.enum([
  "candidate",
  "verified",
  "monitored",
  "pool-eligible",
  "disabled",
  "rejected",
]);
export type EndpointPublicationState = z.infer<
  typeof EndpointPublicationStateSchema
>;

const EndpointMonitoringPolicySchema = z
  .object({
    enabled: z.boolean(),
    expect: z.string().nullable(),
    method: z.string().nullable(),
    source: z.string(),
    timeout_ms: z.int().min(0).nullable().optional(),
  })
  .strict();

const EndpointScoreReasonSchema = z
  .object({
    points: z.int(),
    reason: z.string(),
  })
  .strict();

export const EndpointResourceSchema = z
  .object({
    archive_support: z.boolean().nullable().optional(),
    auth_required: z.boolean(),
    authority: AuthoritySchema.optional(),
    chain: z.literal("bittensor").optional(),
    classification: ClassificationSchema.optional(),
    error: z.string().nullable().optional(),
    health_source: z.enum([
      "probe-derived",
      "missing-probe",
      "not-monitored",
      "live-cron-prober",
      "unavailable",
    ]),
    health_stale: z.boolean(),
    id: z.string(),
    kind: SurfaceKindSchema,
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable(),
    latency_ms: z.int().min(0).nullable().optional(),
    latest_block: z.int().min(0).nullable().optional(),
    layer: EndpointLayerSchema,
    method_support: z
      .union([z.record(z.string(), z.boolean()), z.array(z.string()), z.null()])
      .optional(),
    method_tested: z.string().nullable().optional(),
    monitoring_policy: EndpointMonitoringPolicySchema,
    monitoring_status: z.enum(["monitored", "not_monitored"]),
    netuid: z.int().min(0),
    network: z.enum(["finney", "test", "local"]).optional(),
    observed_at: z.string().nullable(),
    operator: z.string(),
    pool_eligibility_reasons: z.array(z.string()).optional(),
    pool_eligible: z.boolean(),
    provider: z.string(),
    public_safe: z.boolean(),
    publication_state: EndpointPublicationStateSchema,
    rate_limit_notes: z.string().nullable().optional(),
    rpc_method_count: z.int().min(0).nullable().optional(),
    score: z.int().min(0),
    score_reasons: z.array(EndpointScoreReasonSchema).optional(),
    source_urls: z.array(z.string()).optional(),
    status: HealthStatusSchema,
    subnet_name: z.string().optional(),
    subnet_slug: z.string().optional(),
    surface_id: z.string(),
    surface_key: z.string(),
    url: z.string(),
  })
  .strict();
export type EndpointResource = z.infer<typeof EndpointResourceSchema>;

export const GapsSchema = z
  .object({
    gap_notes: z.array(z.string()),
    missing_kinds: z.array(SurfaceKindSchema),
    supported_kinds: z.array(SurfaceKindSchema),
  })
  .strict();
export type Gaps = z.infer<typeof GapsSchema>;

const ReviewStateSchema = z.enum([
  "unreviewed",
  "machine-generated",
  "maintainer-reviewed",
  "needs-review",
  "stale",
]);

const CurationMetadataSchema = z
  .object({
    gap_notes: z.array(z.string()).optional(),
    level: CurationLevelSchema,
    review_state: ReviewStateSchema,
    reviewed_at: z.string().nullable().optional(),
    source_count: z.int().min(0).optional(),
    verified_at: z.string().nullable().optional(),
  })
  .strict();

export const SubnetDetailSchema = z
  .object({
    block: z.int().min(0).optional(),
    candidate_count: z.int().min(0).optional(),
    categories: z.array(z.string()).optional(),
    contact: z.string().nullable().optional(),
    coverage_level: CoverageLevelSchema,
    curation: CurationMetadataSchema,
    curation_level: CurationLevelSchema,
    dashboard_url: z.string().nullable().optional(),
    derived_categories: z.array(z.string()).optional(),
    description: z.string().nullable().optional(),
    docs_url: z.string().nullable().optional(),
    gap_count: z.int().min(0).optional(),
    gaps: GapsSchema,
    github_languages: z
      .record(z.string(), z.int().min(0))
      .nullable()
      .optional(),
    github_last_push_at: z.string().nullable().optional(),
    lifecycle: z.enum(["active", "deprecated", "parked", "pending"]).optional(),
    // Genuinely open shape in the source contract (additionalProperties:
    // true, no fixed properties) -- see this file's header.
    links: z.array(z.object({}).passthrough()),
    logo_url: z.string().nullable().optional(),
    mechanism_count: z.int().min(0).optional(),
    name: z.string(),
    native_name: z.string().nullable().optional(),
    native_name_quality: z.enum(["chain", "placeholder", "empty"]).optional(),
    native_slug: z.string().nullable().optional(),
    netuid: z.int().min(0),
    notes: z.string().nullable().optional(),
    participant_count: z.int().min(0).optional(),
    partnership: z.union([PartnershipMetadataSchema, z.null()]).optional(),
    previously_known_as: z.array(z.string()).optional(),
    probed_surface_count: z.int().min(0).optional(),
    // Same open-shape carve-out as `links` above.
    provenance: z.object({}).passthrough(),
    registered_at_block: z.int().min(0).optional(),
    slug: z.string(),
    social: z
      .object({
        reddit: HttpUrlSchema.optional(),
        telegram: HttpUrlSchema.optional(),
        x: HttpUrlSchema.optional(),
        youtube: HttpUrlSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    source_repo: z.string().nullable().optional(),
    status: SubnetStatusSchema,
    subnet_type: SubnetTypeSchema,
    surface_count: z.int().min(0),
    symbol: z.string().nullable().optional(),
    tempo: z.int().min(0).optional(),
    website_url: z.string().nullable().optional(),
  })
  .strict();
export type SubnetDetail = z.infer<typeof SubnetDetailSchema>;

const ProbeConfigSchema = z
  .object({
    enabled: z.boolean(),
    expect: z.enum(["json", "html", "sse", "any"]),
    method: z.enum(["GET", "HEAD", "JSON-RPC", "WSS-RPC"]),
    timeout_ms: z.int().min(1000).max(30000).optional(),
  })
  .strict();

export const SurfaceSchema = z
  .object({
    auth: AuthSchema,
    auth_required: z.boolean(),
    authority: AuthoritySchema,
    classification: ClassificationSchema.optional(),
    curation_level: CurationLevelSchema.optional(),
    id: z.string(),
    key: z.string().optional(),
    kind: SurfaceKindSchema,
    last_verified_at: z.string().nullable().optional(),
    name: z.string().optional(),
    netuid: z.int().min(0),
    notes: z.string().optional(),
    probe: ProbeConfigSchema.optional(),
    provider: z.string(),
    public_safe: z.boolean(),
    quality_signals: QualitySignalsSchema.optional(),
    rate_limit: RateLimitSchema.optional(),
    rate_limit_notes: z.string().optional(),
    review: z
      .object({
        confidence: z.enum(["low", "medium", "high"]).optional(),
        review_notes: z.string().optional(),
        state: z.enum([
          "community-submitted",
          "maintainer-reviewed",
          "rejected",
        ]),
        submitted_at: z.string().optional(),
        submitted_by: z.string().optional(),
      })
      .strict()
      .optional(),
    schema_status: z
      .enum(["machine-readable", "ui-only", "not-captured"])
      .optional(),
    schema_url: HttpOrWssUrlSchema.optional(),
    source_urls: z.array(z.string()).optional(),
    stale: z.boolean().optional(),
    status: HealthStatusSchema.optional(),
    subnet_name: z.string().optional(),
    subnet_slug: z.string().optional(),
    url: HttpOrWssUrlSchema,
    verification: z
      .object({
        archived: z.boolean().optional(),
        classification: ClassificationSchema.optional(),
        confidence_score: z.int().min(0).max(100).optional(),
        content_type: z.string().nullable().optional(),
        default_branch: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
        github_api_url: z.string().optional(),
        homepage: z.string().nullable().optional(),
        last_push_at: z.string().nullable().optional(),
        latency_ms: z.int().min(0).nullable().optional(),
        method_tested: z.string().optional(),
        redirect_target: z.string().nullable().optional(),
        status_code: z.int().nullable().optional(),
        topics: z.array(z.string()).optional(),
        verified_at: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Surface = z.infer<typeof SurfaceSchema>;

export const SubnetDetailArtifactSchema = ArtifactBaseSchema.extend({
  candidate_surfaces: z.array(CandidateSurfaceSchema),
  candidates: z.array(CandidateSurfaceSchema).optional(),
  economics: SubnetEconomicsSchema.optional(),
  endpoints: z.array(EndpointResourceSchema).optional(),
  gaps: GapsSchema,
  subnet: SubnetDetailSchema,
  surfaces: z.array(SurfaceSchema),
  verified_surfaces: z.array(SurfaceSchema).optional(),
});
export type SubnetDetailArtifact = z.infer<typeof SubnetDetailArtifactSchema>;

export const SubnetDetailResponseSchema = successEnvelopeSchema(
  SubnetDetailArtifactSchema,
);
