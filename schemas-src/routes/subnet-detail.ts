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
import {
  HttpUrlSchema,
  SocialLinksSchema,
  SubmissionReviewStateSchema,
  GithubReleaseSchema,
} from "../shared.ts";
import { QUERY_ENUMS } from "../query-enums.ts";
import { ArtifactBaseSchema } from "../envelope.ts";
import { sectionsOf } from "../artifact-sections.ts";
import {
  BittensorNetworkSchema,
  CoverageLevelSchema,
  CurationLevelSchema,
  HealthStatusSchema,
  PartnershipMetadataSchema,
  SubnetEconomicsSchema,
  SubnetStatusSchema,
  SubnetTypeSchema,
} from "../shared.ts";
import {
  CONFIDENCE_LEVEL_VALUES,
  NATIVE_NAME_QUALITY_VALUES,
} from "../shared.ts";
import { SurfaceAuthLocationSchema } from "../shared.ts";
import { SurfaceAuthSchemeSchema } from "../shared.ts";
// The evidence-class vocabulary is owned by the route that publishes the
// coverage ratio it gates (#10447). Restating it here is how the two drift.
import { RevenueProvenanceSchema } from "./revenue-coverage.ts";

const HttpOrWssUrlSchema = z
  .string()
  .regex(/^(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?):\/\//);

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const SURFACE_KIND_VALUES = QUERY_ENUMS.surfaceKind;
export const SurfaceKindSchema = z.enum(SURFACE_KIND_VALUES);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

/** The HTTP method a surface is invoked with; absent means GET (#11146
 * phase 3). The manifest schema's copy of this enum is pinned to the same
 * QUERY_ENUMS declaration by validate:schema-enums. */
export const SURFACE_METHOD_VALUES = QUERY_ENUMS.surfaceMethod;
export const SurfaceMethodSchema = z.enum(SURFACE_METHOD_VALUES);
export type SurfaceMethod = z.infer<typeof SurfaceMethodSchema>;

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

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const CANDIDATE_STATE_VALUES = QUERY_ENUMS.candidateState;
export const CandidateStateSchema = z.enum(CANDIDATE_STATE_VALUES);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export const QualitySignalsSchema = z
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

export const VerificationResultSchema = z
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
    github_api_url: z.url().optional(),
    homepage: z.string().nullable().optional(),
    // format:"uri" throughout this block -- z.url() verified against every
    // registry/subnets/*.json Surface.verification value that shares these
    // exact field names (#7860's diff audit); CandidateSurface's own
    // verification carries no committed sample data to cross-check
    // (candidate_surfaces isn't present in this repo snapshot), but these
    // are the same GitHub-API-shaped fields (html_url/url mirror GitHub's
    // own REST API, always absolute URIs).
    html_url: z.url().optional(),
    kind: SurfaceKindSchema.optional(),
    last_push_at: z.string().nullable().optional(),
    latency_ms: z.int().min(0).nullable().optional(),
    method_tested: z.string().optional(),
    name: z.string().optional(),
    netuid: z.int().min(0).optional(),
    private_redirect_blocked: z.boolean().optional(),
    provider: z.string().optional(),
    quality_signals: QualitySignalsSchema.optional(),
    redirect_target: z.url().nullable().optional(),
    source_tier: SourceTierSchema.optional(),
    source_type: z.string().optional(),
    source_url: z.url().optional(),
    source_urls: z.array(z.url()).optional(),
    status: HealthStatusSchema,
    status_code: z.int().nullable().optional(),
    topics: z.array(z.string()).optional(),
    url: z.url(),
    verified_at: z.string(),
  })
  .strict();

export const RateLimitSchema = z
  .object({
    burst: z.int().min(0).optional(),
    cost_notes: z.string().optional(),
    requests: z.int().min(0),
    scope: z.enum(["per-key", "per-ip", "global", "unknown"]).optional(),
    window: z.string().min(1),
  })
  .strict();

/**
 * How to authenticate to a surface, or null when it needs no credential.
 *
 * THE ONE DECLARATION (#10790). `agent-catalog.ts` carried a second copy of
 * this same vocabulary -- both modelled from
 * `schemas/subnet-manifest.schema.json`'s `$defs.surface.properties.auth`,
 * which is what actually validates the registry records they both come from --
 * and that copy was `.passthrough()`, narrower, and wrong: it omitted
 * `body_envelope` and `token_url`, and served `body_envelope` on eight
 * services anyway.
 *
 * Its own comment pointed at #9799 for the fix, and #9799 CLOSED -- having
 * single-sourced the enum vocabularies INSIDE this object (`scheme`,
 * `location`, both imported from `../shared.ts` by both copies) and left the
 * object around them duplicated. `validate-schema-vocabularies.ts` is that
 * issue's gate and it looks for string-literal lists, so a re-copied OBJECT
 * passes it. That is the gap this one closes.
 *
 * The prose below came from that copy. It is the better half of it, and the
 * reason collapsing a duplicate is not the same as deleting one.
 */
export const AuthSchema = z
  .object({
    body_envelope: z
      .object({
        credential_key: z.string().min(1),
        payload_key: z.string().min(1),
      })
      .strict()
      .optional()
      .describe(
        "For scheme:signature with location:body -- which key of the outgoing JSON body carries the credential, and which carries the payload it signs.",
      ),
    location: SurfaceAuthLocationSchema.optional().describe(
      "Where the credential is sent. `body` only applies to scheme:signature, whose values are merged into the outgoing JSON request body.",
    ),
    name: z
      .string()
      .optional()
      .describe("The single header the credential goes in."),
    // minItems:1 in the hand-edited contract -- verified against real
    // registry/subnets/*.json auth.names values (#7860's diff audit).
    names: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "The header SET, for schemes that need more than one (signature schemes send hotkey + nonce + signature together). Present instead of `name`, not alongside it.",
      ),
    scheme: SurfaceAuthSchemeSchema.describe(
      "`signature` means the request is signed per-call (a hotkey/nonce/signature header set, see `names`), not a static token.",
    ),
    scopes_note: z
      .string()
      .optional()
      .describe(
        "How the requirement was established -- often a live-checked 401, because a subnet's own OpenAPI frequently declares no securitySchemes at all.",
      ),
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
    confidence: z.enum(CONFIDENCE_LEVEL_VALUES).optional(),
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
    source_url: z.url(),
    source_urls: z.array(z.url()).optional(),
    state: CandidateStateSchema,
    subnet_name: z.string().nullable().optional(),
    superseded_by: z.string().nullable().optional(),
    url: z.url(),
    verification: VerificationResultSchema.nullable().optional(),
  })
  .strict();
export type CandidateSurface = z.infer<typeof CandidateSurfaceSchema>;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const AUTHORITY_VALUES = QUERY_ENUMS.providerAuthority;
export const AuthoritySchema = z.enum(AUTHORITY_VALUES);
export type Authority = z.infer<typeof AuthoritySchema>;

/**
 * Where an endpoint sits in the stack. NOT a pool kind -- `RPC_POOL_KIND_VALUES`
 * in schemas-src/query-params.ts is that, and the two look interchangeable
 * enough that both pool tools published THIS list for a `kind` filter, so every
 * value they advertised was rejected by their route (#10118).
 *
 * The vocabulary, exported as a tuple so every other schema that needs these
 * values imports them instead of restating them (#9799).
 */
export const ENDPOINT_LAYER_VALUES = QUERY_ENUMS.endpointLayer;
export const EndpointLayerSchema = z.enum(ENDPOINT_LAYER_VALUES);
export type EndpointLayer = z.infer<typeof EndpointLayerSchema>;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const ENDPOINT_PUBLICATION_STATE_VALUES =
  QUERY_ENUMS.endpointPublicationState;
export const EndpointPublicationStateSchema = z.enum(
  ENDPOINT_PUBLICATION_STATE_VALUES,
);
export type EndpointPublicationState = z.infer<
  typeof EndpointPublicationStateSchema
>;

export const EndpointMonitoringPolicySchema = z
  .object({
    enabled: z.boolean(),
    expect: z.string().nullable(),
    method: z.string().nullable(),
    source: z.string(),
    timeout_ms: z.int().min(0).nullable().optional(),
  })
  .strict();

export const EndpointScoreReasonSchema = z
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
    network: BittensorNetworkSchema.optional(),
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
    // 30-day observed uptime-and-latency for this endpoint, computed once per
    // prober run from the surface_uptime_daily rollup and injected at SERVE time
    // by overlayRpcPoolEligibility (#9357). It ranks the pool ahead of `score`,
    // because `score`'s own latency term comes from a single 87-byte probe --
    // which had the pool preferring an upstream 9x slower on real traffic.
    // Null when the window holds no samples for this surface: "no record" is not
    // a neutral score, and a new endpoint does not outrank a proven one.
    reliability_score: z.int().min(0).max(100).nullable().optional(),
    reliability_grade: z.string().nullable().optional(),
    source_urls: z.array(z.url()).optional(),
    status: HealthStatusSchema,
    subnet_name: z.string().optional(),
    subnet_slug: z.string().optional(),
    surface_id: z.string(),
    surface_key: z.string(),
    url: z.url(),
  })
  .strict();
export type EndpointResource = z.infer<typeof EndpointResourceSchema>;

export const GapsSchema = z
  .object({
    gap_notes: z.array(z.string()),
    missing_kinds: z.array(SurfaceKindSchema),
    // #9746: ids of tracked surfaces whose URL names a MOVING TARGET
    // (a /latest or /current terminal), so the operator may publish a
    // parameterized sibling beside them that this registry does not track.
    // A lead to resolve against the operator's own documentation -- never a
    // claim that such a sibling exists. Optional so a body published before
    // this shipped still validates.
    moving_target_surfaces: z.array(z.string()).optional(),
    supported_kinds: z.array(SurfaceKindSchema),
  })
  .strict();
export type Gaps = z.infer<typeof GapsSchema>;

export const ReviewStateSchema = z.enum([
  "unreviewed",
  "machine-generated",
  "maintainer-reviewed",
  "needs-review",
  "stale",
]);

export const CurationMetadataSchema = z
  .object({
    gap_notes: z.array(z.string()).optional(),
    level: CurationLevelSchema,
    review_state: ReviewStateSchema,
    reviewed_at: z.string().nullable().optional(),
    source_count: z.int().min(0).optional(),
    verified_at: z.string().nullable().optional(),
  })
  .strict();
export type CurationMetadata = z.infer<typeof CurationMetadataSchema>;

// #10543: whether this subnet has been searched for external revenue, and
// when. `revenue` lives on a SURFACE, so a subnet with no revenue-shaped
// surface has nowhere to put one -- and that is exactly the population the
// dark sweep covers. Without this, an undated silence is indistinguishable
// from nobody having looked, and "N% of the network has no observable
// external revenue" is not a defensible claim.
export const RevenueSearchSchema = z
  .object({
    checked: z
      .array(
        z.enum([
          "website",
          "docs",
          "openapi",
          "dashboard",
          "source-repo",
          "blog",
          "explorer",
        ]),
      )
      .min(1)
      .meta({
        description:
          'Where the search actually looked. Without it, "we searched" is unfalsifiable and nobody else can re-run it.',
      }),
    notes: z.string().optional(),
    outcome: z.enum(["none-found", "surfaces-declared"]).meta({
      description:
        "Cross-checked against the surfaces themselves, so the summary cannot drift from the data it summarises.",
    }),
    searched_at: z.string().meta({
      description: "An absence with no date is not evidence.",
    }),
  })
  .strict();

// #10586: the sibling of RevenueSearchSchema, one phase later.
//
// registry/entities/ holds addresses that EXIST, so a subnet declaring no
// treasury has no address to write and its absence has nowhere to live. Without
// this record, "N of 128 subnets publish no treasury address" cannot be claimed
// at all -- nothing distinguishes a subnet nobody looked at from one that was
// looked at and had none.
//
// Both value sets are exported so validate:schema-vocabularies can pin them
// against schemas/subnet-manifest.schema.json. The entity-category enum drifted
// exactly this way (#10483): the JSON Schema gained four values, the Zod copy
// did not, and nothing noticed because no document used them yet.
export const WALLET_SEARCH_OUTCOME_VALUES = [
  "none-found",
  "wallets-declared",
] as const;

export const WALLET_SEARCH_CHECKED_VALUES = [
  "website",
  "docs",
  "blog",
  "source-repo",
  "explorer",
  "whitepaper",
  "chain",
] as const;

export const WalletSearchSchema = z
  .object({
    checked: z.array(z.enum(WALLET_SEARCH_CHECKED_VALUES)).min(1).meta({
      description:
        'Where the search actually looked. Without it, "we searched" is unfalsifiable and nobody else can re-run it. `chain` means the on-chain owner keys were read (SubnetOwner), which is always available and is NOT a declaration by the team.',
    }),
    notes: z.string().optional(),
    outcome: z.enum(WALLET_SEARCH_OUTCOME_VALUES).meta({
      description:
        "Cross-checked against registry/entities/ itself, so the summary cannot drift from the data it summarises.",
    }),
    searched_at: z.string().meta({
      description: "An absence with no date is not evidence.",
    }),
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
    // format:"uri"/"date-time" in the hand-edited OpenAPI contract --
    // z.url()/z.iso.datetime() match exactly (verified against every
    // registry/subnets/*.json value before adding these constraints,
    // #7860's diff audit; same fields as schemas-src/routes/subnets.ts's
    // SubnetIndexEntrySchema).
    dashboard_url: z.url().nullable().optional(),
    derived_categories: z.array(z.string()).optional(),
    description: z.string().nullable().optional(),
    docs_url: z.url().nullable().optional(),
    gap_count: z.int().min(0).optional(),
    gaps: GapsSchema,
    // #8379: last 13 weeks (~90d) of commit activity for the resolved
    // source_repo, from GitHub's stats/commit_activity endpoint.
    github_commits_weekly: z
      .array(z.object({ week: z.iso.datetime(), count: z.int().min(0) }))
      .nullable()
      .optional(),
    github_languages: z
      .record(z.string(), z.int().min(0))
      .nullable()
      .optional(),
    github_last_push_at: z.iso.datetime().nullable().optional(),
    github_stars: z.int().min(0).nullable().optional(),
    // #8379: true when the last capture attempt failed and this is retained
    // last-good data (dropped from the artifact entirely, not flagged, once
    // stale beyond 30d) -- see registry/generated/github-signals.json.
    // #8704: the subnet repo's published releases, feeding the `release` item
    // kind on /api/v1/feeds/subnets/{netuid}. Null means the repo was never
    // asked (no resolvable source repo, or not yet captured); [] means it
    // publishes no releases, which is the common case for subnet repos.
    github_releases: z.array(GithubReleaseSchema).nullable().optional(),
    github_unreachable: z.boolean().optional(),
    lifecycle: z.enum(["active", "deprecated", "parked", "pending"]).optional(),
    // Genuinely open shape in the source contract (additionalProperties:
    // true, no fixed properties) -- see this file's header.
    // #9800. Was an array of bare open objects, so the curated link list --
    // website, docs, repo -- said nothing about what a link is.
    links: z.array(
      z
        .object({
          label: z.string(),
          url: z.string(),
          source_url: z.string().nullable().optional(),
        })
        .strict(),
    ),
    logo_url: z.url().nullable().optional(),
    mechanism_count: z.int().min(0).optional(),
    name: z.string(),
    native_name: z.string().nullable().optional(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITY_VALUES).optional(),
    native_slug: z.string().nullable().optional(),
    netuid: z.int().min(0),
    notes: z.string().nullable().optional(),
    revenue_search: RevenueSearchSchema.optional(),
    wallet_search: WalletSearchSchema.optional(),
    participant_count: z.int().min(0).optional(),
    partnership: PartnershipMetadataSchema.nullable().optional(),
    previously_known_as: z.array(z.string()).optional(),
    probed_surface_count: z.int().min(0).optional(),
    // Same open-shape carve-out as `links` above.
    // #9800. Was a bare open object. This is the record's own audit trail --
    // where each claim came from and how it was established -- so leaving it
    // undeclared removed exactly the information a caller weighs the record by.
    provenance: z
      .object({
        existence: z
          .object({
            authority: z.string().nullable().optional(),
            captured_at: z.string().nullable().optional(),
            method: z.string().nullable().optional(),
            network: z.string().nullable().optional(),
            source_kind: z.string().nullable().optional(),
          })
          .strict()
          .optional(),
        identity: z
          .object({
            display_name_source: z.string().nullable().optional(),
            native_name_quality: z.string().nullable().optional(),
          })
          .strict()
          .optional(),
        interface_metadata: z.string().nullable().optional(),
      })
      .strict(),
    registered_at_block: z.int().min(0).optional(),
    slug: z.string(),
    social: SocialLinksSchema.nullable().optional(),
    source_repo: z.url().nullable().optional(),
    status: SubnetStatusSchema,
    subnet_type: SubnetTypeSchema,
    surface_count: z.int().min(0),
    symbol: z.string().nullable().optional(),
    tempo: z.int().min(0).optional(),
    website_url: z.url().nullable().optional(),
  })
  .strict();
export type SubnetDetail = z.infer<typeof SubnetDetailSchema>;

export const ProbeConfigSchema = z
  .object({
    enabled: z.boolean(),
    expect: z.enum(["json", "html", "sse", "any"]),
    method: z.enum(["GET", "HEAD", "JSON-RPC", "WSS-RPC"]),
    timeout_ms: z.int().min(1000).max(30000).optional(),
  })
  .strict();

// #10441: what a surface measures, and on what terms. The published mirror of
// schemas/subnet-manifest.schema.json's `$defs.revenue` -- a registry-side
// addition that nothing consumed passed CI vacuously, and only failed once a
// subnet file actually carried one and the block reached these artifacts.
export const SurfaceRevenueSchema = z
  .object({
    circularity: z
      .enum(["external", "alpha-denominated", "team-funded", "unknown"])
      .optional()
      .meta({
        description:
          "Whether the money originates outside Bittensor. Absent means unknown, never external.",
      }),
    currency: z.enum(["USD", "TAO", "ALPHA"]).optional().meta({
      description:
        "Unit the amount field carries. Declared rather than inferred from the path: api.chutes.ai/payments/summary/tao is named for TAO and its values reconcile as USD.",
    }),
    excludes: z.array(z.string()).optional().meta({
      description:
        "Fields present in the payload that are NOT external revenue and must be subtracted -- subnet-funded or unrecognised components.",
    }),
    fields: z.record(z.string(), z.string()).optional().meta({
      description:
        "Map of role -> field name in the upstream payload, e.g. {date: 'date', amount: 'total_revenue'}.",
    }),
    grain: z.enum(["daily", "weekly", "monthly", "cumulative"]).optional(),
    rows: z.string().optional().meta({
      description:
        "The envelope key holding the payload `shape` describes, for a source that wraps its rows (a pagination envelope's `items`). Absent means the payload IS the rows.",
    }),
    shape: z.enum(QUERY_ENUMS.revenueShape).optional().meta({
      description:
        "How the payload is arranged, so an extractor does not have to guess. flat-array: a list of records, fields.date/fields.amount naming keys within one. keyed-map: nested {period: {subkey: amount}}, where the period IS the key and there are no field names to point at. scalar: one object carrying a single total.",
    }),
    provenance: RevenueProvenanceSchema.meta({
      description:
        "Evidence class. Only chain-verified and probe-derived count toward a published coverage ratio; the rest are shown beside it and never summed in.",
    }),
    role: z
      .enum(["external-revenue", "usage-proxy", "miner-payout", "not-revenue"])
      .meta({
        description:
          "What this surface actually measures. A 'stats' endpoint is guilty until proven revenue: miner payout is emission -- the denominator -- and counting it as revenue puts the denominator in the numerator.",
      }),
    searched_at: z.string().optional().meta({
      description:
        "When absence was established. Required for provenance 'none': an undated absence is not evidence.",
    }),
    source_url: z.url().optional(),
    supersedes: z.array(z.string()).optional().meta({
      description:
        "Surface ids this one subsumes. Declares a subset relationship so overlapping channels are not summed twice.",
    }),
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
    method: SurfaceMethodSchema.optional().meta({
      description:
        "HTTP method this surface is invoked with; absent means GET. A non-GET surface is a declared mutation (#11146): the prober never touches it (the manifest schema forbids an enabled probe on one), so it carries no probe-derived health -- reach it through call_subnet_surface's schema-gated execution.",
    }),
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
        confidence: z.enum(CONFIDENCE_LEVEL_VALUES).optional(),
        review_notes: z.string().optional(),
        // The SUBMISSION axis, not the curation `ReviewStateSchema` declared
        // above in this same file. Both were spelled inline here; the two are
        // different vocabularies that share one member, so the local name
        // would type-check and publish the wrong enum.
        state: SubmissionReviewStateSchema,
        submitted_at: z.string().optional(),
        submitted_by: z.string().optional(),
      })
      .strict()
      .optional(),
    revenue: SurfaceRevenueSchema.optional(),
    schema_status: z
      .enum(["machine-readable", "ui-only", "not-captured"])
      .optional(),
    schema_url: HttpOrWssUrlSchema.optional(),
    source_urls: z.array(z.url()).optional(),
    stale: z.boolean().nullable().optional().meta({
      description:
        "Whether this surface's verification is older than its kind's freshness TTL. NULL when the surface has never been verified (#9906): that is unverified, not fresh, and 78% of surfaces were in that state while publishing false. Same unknown-is-not-a-value convention as `exists` on /crowdloans/{id}, `leased` on /subnets/{netuid}/lease, and lane_health's `verdict: unknown`.",
    }),
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
        github_api_url: z.url().optional(),
        homepage: z.string().nullable().optional(),
        last_push_at: z.string().nullable().optional(),
        latency_ms: z.int().min(0).nullable().optional(),
        method_tested: z.string().optional(),
        redirect_target: z.url().nullable().optional(),
        status_code: z.int().nullable().optional(),
        topics: z.array(z.string()).optional(),
        verified_at: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Surface = z.infer<typeof SurfaceSchema>;

/**
 * The pair `overlayOverviewHealth()` stamps beside `health` -- ONE declaration.
 *
 * The overlay writes both fields or neither, onto BOTH the subnet DETAIL and
 * the subnet OVERVIEW artifact, and only the overview declared them (#8055 saw
 * the omission there and fixed it in one place). `.passthrough()` carried the
 * detail's copy out to clients for as long as it has existed; flipping to
 * `.strict()` is what finally said so, in `validate:api` rather than in a
 * report -- the field is composed at SERVE time, so no walk of the built
 * artifacts could ever have found it (#10790).
 *
 * `z.string()` rather than the endpoint-level `health_source` enum on purpose.
 * That enum describes a value THIS repo computes per endpoint; this one is
 * lifted from the live health snapshot, which is written by the prober and can
 * carry a source this schema has never heard of -- `live-postgres-fallback` is
 * already one such. A closed set drawn from the values we happen to have seen
 * would be a contract that fails the moment the producer grows a case.
 */
export const LIVE_HEALTH_OVERLAY = {
  operational_observed_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When the live health snapshot behind this response was taken. Null when the snapshot carries no run stamp.",
    ),
  health_source: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Which live tier answered for health on this response. Open-ended: the value comes from the health snapshot's own producer.",
    ),
} as const;

export const SubnetDetailArtifactSchema = ArtifactBaseSchema.extend({
  ...LIVE_HEALTH_OVERLAY,
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

/**
 * What `?sections=` accepts on the detail route -- read off the document above
 * rather than restated, so the route cannot offer a card the artifact lacks.
 */
export const SUBNET_DETAIL_SECTIONS = sectionsOf(SubnetDetailArtifactSchema);
