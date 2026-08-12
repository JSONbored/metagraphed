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
import {
  DisabledProxyContractSchema,
  EndpointEligibilityPolicySchema,
} from "./endpoint-pool-policy.ts";
import {
  EpochMillisSchema,
  HttpUrlSchema,
  SocialLinksSchema,
} from "../shared.ts";
import { QUERY_ENUMS } from "../query-enums.ts";
import { ArtifactBaseSchema } from "../envelope.ts";
import { BittensorNetworkSchema, HealthStatusSchema } from "../shared.ts";
import {
  AuthoritySchema,
  ClassificationSchema,
  EndpointLayerSchema,
  EndpointResourceSchema,
  EndpointScoreReasonSchema,
  LIVE_HEALTH_OVERLAY,
  SurfaceKindSchema,
} from "./subnet-detail.ts";

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const PROVIDER_KIND_VALUES = QUERY_ENUMS.providerKind;
export const ProviderKindSchema = z.enum(PROVIDER_KIND_VALUES);

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
    // shared.ts's own SocialLinksSchema, not a fourth copy of it (#10790).
    social: SocialLinksSchema.optional(),
    team_url: HttpUrlSchema.optional(),
    contact_url: HttpUrlSchema.optional(),
    authority: AuthoritySchema,
    public_notes: z.string().optional(),
    notes: z.string().optional(),
    // Required, not optional (#10214). `scripts/build-artifacts.ts`'s
    // enrichedProviders sets `netuids` on EVERY provider it emits -- an empty
    // array for one with no surfaces, never an absent key -- so `.optional()`
    // published a possibility the producer cannot express. GraphQL had it
    // right (`[Int]!`) and the component disagreed; nothing compared them
    // until the projection pass.
    netuids: z.array(z.int().min(0)),
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
  ...LIVE_HEALTH_OVERLAY,
  provider: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      kind: z.string().optional(),
      authority: z.string().optional(),
    })
    .strict(),
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
    // #9710: the four the shared `endpoints` sort enum advertises. Optional
    // because the route serves a baked artifact -- one published before #9710
    // carries none of them, and a required field would reject a body that is
    // otherwise exactly right.
    layer: z.string().optional(),
    publication_state: z.string().optional(),
    pool_eligible: z.boolean().optional(),
    score: z.number().optional(),
  })
  .strict();

export const RpcEndpointsArtifactSchema = ArtifactBaseSchema.extend({
  // Which tier produced this catalog. `artifact-build` is the committed
  // build's own label; the live overlay replaces it when the 15-minute cron
  // has run. Served on every response and declared nowhere (#10790), which is
  // the provenance class #10786 centralised on the other side.
  source: z
    .string()
    .optional()
    .describe(
      "Which producer answered: `artifact-build` for the committed catalog, the prober's label once the live overlay applies.",
    ),
  summary: z
    .object({
      endpoint_count: z.int().min(0),
      archive_supported_count: z.int().min(0).optional(),
      by_kind: z.record(z.string(), z.int().min(0)).optional(),
      by_provider: z.record(z.string(), z.int().min(0)).optional(),
      by_status: z.record(z.string(), z.int().min(0)).optional(),
    })
    .strict(),
  // mergeRpcEndpoints stamps the overlay's run stamp at the artifact level on
  // every response the 15-minute cron has data for -- the same declaration the
  // pools artifact below already carries, missed here (#10897: the route
  // 500'd on every request for a day once #10853's .strict() went live).
  // ONLY this half of the overlay, same reasoning as pools: `health_source`
  // is per-ENDPOINT here and EndpointResourceSchema already declares it.
  operational_observed_at: LIVE_HEALTH_OVERLAY.operational_observed_at,
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
    // 30-day observed uptime-and-latency for this endpoint, computed once per
    // prober run from the surface_uptime_daily rollup and injected at SERVE time
    // by overlayRpcPoolEligibility (#9357). It ranks the pool ahead of `score`,
    // because `score`'s own latency term comes from a single 87-byte probe --
    // which had the pool preferring an upstream 9x slower on real traffic.
    // Null when the window holds no samples for this surface: "no record" is not
    // a neutral score, and a new endpoint does not outrank a proven one.
    reliability_score: z.int().min(0).max(100).nullable().optional(),
    reliability_grade: z.string().nullable().optional(),
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
  // The first two are what the BUILD emits (buildEndpointPoolArtifact).
  // `live-cron-prober` is what the SERVE path relabels it to: workers/api.ts's
  // rpc-pools case overlays the 15-minute cron snapshot and rewrites `source`
  // to match, honestly -- the served health really did come from the prober
  // rather than from the build. Only this schema was never told, so the route
  // served a value its own contract forbade (#9142, the artifact-level twin of
  // #9138's per-endpoint health_source).
  //
  // No fourth value can reach a 200: the overlay's else-branch sets data=null
  // and the route serves nothing.
  source: z
    .enum([
      "endpoint-resource-probes",
      "rpc-endpoint-probes",
      "live-cron-prober",
    ])
    .optional(),
  // The artifact-level stamp this schema's own `.describe()` has named since
  // #6570 -- "plus operational_observed_at, real here and only here" -- and
  // never declared (#10790). Documented in prose, served on every response,
  // absent from the contract: the exact shape of this issue's defect, in the
  // description of the schema that had it.
  //
  // ONLY this half of the overlay. `health_source` is per-ENDPOINT here and
  // `EndpointResourceSchema` already declares it; adding it at the artifact
  // level would be declaring a field to clear a report.
  operational_observed_at: LIVE_HEALTH_OVERLAY.operational_observed_at,
  disabled_proxy_contract: DisabledProxyContractSchema.optional(),
  eligibility_policy: EndpointEligibilityPolicySchema.optional(),
  provider_scores: z.array(EndpointProviderScoreSchema).optional(),
  pools: z.array(RpcPoolSchema),
}).describe(
  "RPC pool scores (#6570): same pools[] row shape, filter/sort/page surface, and pagination metadata as EndpointPoolList, plus operational_observed_at -- real here and only here, since the RPC pools are the ones carrying a live 15-minute cron eligibility overlay.",
);
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
    error_rate: z
      .number()
      .nullable()
      .optional()
      .describe("Null when the endpoint had no requests in the window."),
    avg_latency_ms: z.int().nullable().optional(),
  })
  .strict()
  .describe("One endpoint's share of RPC reverse-proxy traffic in the window.");

const RpcUsageNetworkRowSchema = z
  .object({
    network: z.string(),
    requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_rate: z
      .number()
      .nullable()
      .optional()
      .describe("Null when the network had no requests in the window."),
  })
  .strict()
  .describe("One network's share of RPC reverse-proxy traffic in the window.");

const RpcUsageBucketSchema = z
  .object({
    ts: EpochMillisSchema.describe("Bucket start, as epoch milliseconds."),
    requests: z.int().min(0),
    errors: z.int().min(0),
    avg_latency_ms: z.int().nullable(),
  })
  .strict()
  .describe(
    "One bounded time bucket of RPC reverse-proxy traffic (bucket_granularity wide).",
  );

// `window` is what the caller asked for; `coverage` is what the two stores
// (Analytics Engine live, R2 lakehouse frozen) could actually answer. They
// diverge whenever a store's retention does not span the window, and
// publishing only `window` is what let a two-hour answer ship labelled `7d`.
const RpcUsageCoverageRangeSchema = z
  .object({
    start: EpochMillisSchema.nullable(),
    end: EpochMillisSchema.nullable(),
  })
  .strict()
  .describe("An epoch-ms span.");

const RpcUsageCoverageSegmentSchema = z
  .object({
    source: z
      .string()
      .describe(
        "Which store measured it: analytics-engine (live capture) or lakehouse (frozen history).",
      ),
    start: EpochMillisSchema.nullable().describe(
      "Epoch ms of this store's oldest measured event in the window.",
    ),
    end: EpochMillisSchema.nullable().describe(
      "Epoch ms of this store's newest measured event in the window.",
    ),
  })
  .strict()
  .describe("One store's contribution to an rpc_usage answer.");

const RpcUsageCoverageSchema = z
  .object({
    start: EpochMillisSchema.nullable().describe(
      "Epoch ms of the oldest measured event across every contributing store, or null when nothing was measured.",
    ),
    end: EpochMillisSchema.nullable().describe(
      "Epoch ms of the newest measured event across every contributing store, or null when nothing was measured.",
    ),
    segments: z
      .array(RpcUsageCoverageSegmentSchema)
      .describe(
        "One entry per contributing store, oldest first. Two non-adjacent entries mean the window has a hole between them that no store covers.",
      ),
    latency_percentiles: RpcUsageCoverageRangeSchema.nullable().describe(
      "The sub-range summary.latency_ms p50/p95 describe, or null when nothing measured them. Counts are additive across disjoint ranges; percentiles are not, so they stay scoped to the one store that has a percentile function.",
    ),
  })
  .strict()
  .describe(
    "The measured span behind an rpc_usage answer. window is what the caller asked for; this is what the stores could answer, and they are not the same whenever a store's retention does not span the window.",
  );

export const RpcUsageArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable().optional(),
    bucket_granularity: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Time-bucket granularity for buckets: 1h for the 7d window, 6h for 30d. Null on a cold store.",
      ),
    // EPOCH MILLISECONDS, not an ISO string (#9794). Both GET /api/v1/rpc/usage
    // and the get_rpc_usage MCP tool serve a number here -- 1786099339000 --
    // so this route contract has been wrong since it was written, and the
    // hand-written MCP copy inherited the same mistake rather than causing it.
    // Unlike this file's other observed_at fields, which are genuine ISO
    // strings, this one is request-scoped telemetry stamped in millis. The
    // example carries a real stamp rather than a bare `1`, because the unit is
    // the whole point of the field and a placeholder integer teaches a reader
    // nothing about it.
    observed_at: EpochMillisSchema.nullable()
      .optional()
      .describe(
        "When this telemetry was observed, as epoch MILLISECONDS -- not an ISO-8601 string like this file's other observed_at fields. Request-scoped rather than build-scoped: it stamps the read, not a published artifact.",
      )
      .meta({ examples: [1786099339000] }),
    // NULLABLE because production answers null RIGHT NOW (#10786). Verified
    // live: GET /api/v1/rpc-usage serves `"source": null`, while this line
    // promised a string -- a published non-null field the route has never
    // filled. `answerRpcUsage` (src/rpc-usage-answer.ts) stamps no source at
    // all, unlike its health siblings in src/health-serving.ts, which set one
    // unconditionally.
    //
    // The PRODUCER is the one that cannot answer here, so the schema is what
    // moves. Giving the answer a label would be inventing provenance for a
    // read that composes a hot tier, a cold tier and a floor -- and this
    // surface's rule is that provenance is derived, never asserted.
    source: z.string().nullable(),
    coverage: RpcUsageCoverageSchema.describe(
      "What the answer is actually about, as opposed to what window was asked for.",
    ),
    summary: z
      .object({
        total_requests: z.int().min(0),
        ok_requests: z.int().min(0),
        error_requests: z.int().min(0),
        error_rate: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Null when there are no requests in the window (no defined rate).",
          ),
        failover_requests: z.int().min(0).optional(),
        failover_rate: z
          .number()
          .nullable()
          .optional()
          .describe("Null when there are no requests in the window."),
        cache_hits: z.int().min(0).optional(),
        cache_hit_rate: z
          .number()
          .nullable()
          .optional()
          .describe("Null when there are no requests in the window."),
        latency_ms: z
          .object({
            p50: z.int().nullable().optional(),
            p95: z.int().nullable().optional(),
            avg: z.int().nullable().optional(),
          })
          .strict()
          .describe(
            "Window latency percentiles + average for RPC reverse-proxy traffic; each is null on a cold store.",
          )
          .optional(),
      })
      .strict()
      .describe("Window-total rollup for RPC reverse-proxy traffic."),
    endpoints: z
      .array(RpcUsageEndpointRowSchema)
      .describe(
        "Per-endpoint request distribution, ranked by request volume (top 50).",
      ),
    networks: z
      .array(RpcUsageNetworkRowSchema)
      .describe("Per-network request breakdown, ordered by request volume."),
    buckets: z
      .array(RpcUsageBucketSchema)
      .describe(
        "Bounded time buckets over the window for heatmaps, oldest-first.",
      ),
  })
  .strict()
  .describe(
    "RPC reverse-proxy usage analytics over a 7d/30d window. Mirrors GET /api/v1/rpc/usage's data envelope.",
  );
export type RpcUsageArtifact = z.infer<typeof RpcUsageArtifactSchema>;
