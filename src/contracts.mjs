import { artifactStorageTierForPath } from "./artifact-storage.mjs";
import { DOMAIN_TAGS } from "./domain-tags.mjs";
import { sampleFromSchema } from "./openapi-sample.mjs";

export const CONTRACT_VERSION = "2026-06-29.1";
export const SCHEMA_VERSION = 1;
// The API + artifacts are served from the api subdomain; the bare apex
// (metagraph.sh) is the metagraphed-ui UI. PRIMARY_DOMAIN drives the OpenAPI
// server URL and the consumer metadata in contracts.json / api-index.json.
export const PRIMARY_DOMAIN = "api.metagraph.sh";
export const API_BASE_PATH = "/api/v1";
export const ARTIFACT_BASE_PATH = "/metagraph";
export const TYPE_DEFINITIONS_PATH = "/metagraph/types.d.ts";

export const CACHE_SECONDS = {
  short: 60,
  standard: 300,
  static: 600,
};

export const QUERY_ENUMS = {
  candidateState: [
    "schema-invalid",
    "schema-valid",
    "maintainer-review",
    "verified",
    "stale",
    "rejected",
  ],
  coverageLevel: ["native-only", "manifested", "probed"],
  curationLevel: [
    "native",
    "candidate-discovered",
    "community-seeded",
    "machine-verified",
    "maintainer-reviewed",
    "adapter-backed",
  ],
  healthClassification: [
    "auth-required",
    "content-mismatch",
    "dead",
    "live",
    "rate-limited",
    "redirected",
    "timeout",
    "transient",
    "unsupported",
    "unsafe",
    "wrong-chain",
  ],
  healthStatus: ["ok", "degraded", "failed", "unknown"],
  providerAuthority: [
    "community",
    "official",
    "provider-claimed",
    "registry-observed",
  ],
  providerKind: [
    "data-provider",
    "docs-provider",
    "infrastructure-provider",
    "registry",
    "subnet-team",
  ],
  profileLevel: [
    "directory-only",
    "identity-partial",
    "identity-complete",
    "operational",
    "adapter-backed",
  ],
  subnetStatus: ["active", "inactive"],
  subnetType: ["root", "application"],
  endpointLayer: [
    "bittensor-base",
    "data-provider",
    "docs-provider",
    "subnet-app",
  ],
  endpointPublicationState: [
    "candidate",
    "verified",
    "monitored",
    "pool-eligible",
    "disabled",
    "rejected",
  ],
  coverageDepthTier: [
    "agent-ready",
    "machine-usable",
    "candidate-review",
    "needs-evidence",
    "hard-blocked",
    "missing-interface",
  ],
  agentReadinessStatus: [
    "callable",
    "base-layer",
    "candidate",
    "needs-evidence",
    "blocked",
  ],
  agentBlockerLevel: ["none", "hard-blocked", "needs-review", "missing-data"],
  endpointIncidentSeverity: ["critical", "warning", "info"],
  endpointIncidentState: ["active", "resolved"],
  recommendedAdapterKind: [
    "custom-adapter",
    "data-artifact-adapter",
    "generic-openapi-or-custom",
    "stream-adapter",
  ],
  surfaceKind: [
    "archive",
    "dashboard",
    "data-artifact",
    "docs",
    "example",
    "openapi",
    "repo-registry",
    "sdk",
    "source-repo",
    "sse",
    "subnet-api",
    "subtensor-rpc",
    "subtensor-wss",
    "website",
  ],
};

const integerSchema = { type: "integer", minimum: 0 };
const textSchema = { type: "string" };
const fieldListSchema = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$",
};

export const API_QUERY_COLLECTIONS = {
  candidates: queryCollection("candidates", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: textSchema,
      state: enumSchema(QUERY_ENUMS.candidateState),
    },
    sort: ["confidence", "id", "kind", "name", "netuid", "provider", "state"],
  }),
  claims: queryCollection("claims", {
    search: ["subject", "claim", "source_url", "support_summary"],
    sort: ["claim", "source_url", "subject", "verified_at"],
  }),
  curation: queryCollection("curation", {
    filters: {
      netuid: integerSchema,
      coverage_level: enumSchema(QUERY_ENUMS.coverageLevel),
    },
    sort: ["coverage_level", "curation_level", "name", "netuid"],
  }),
  "coverage-depth": queryCollection("rows", {
    filters: {
      netuid: integerSchema,
      tier: enumSchema(QUERY_ENUMS.coverageDepthTier),
      agent_status: enumSchema(QUERY_ENUMS.agentReadinessStatus),
      blocker_level: enumSchema(QUERY_ENUMS.agentBlockerLevel),
    },
    search: ["name", "slug", "top_gap_codes", "recommended_next_action"],
    sort: [
      "agent_status",
      "blocker_level",
      "name",
      "netuid",
      "priority_score",
      "score",
      "tier",
    ],
  }),
  "curated-surfaces": queryCollection("surfaces", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: textSchema,
    },
    sort: ["id", "kind", "name", "netuid", "provider"],
  }),
  documents: queryCollection("documents", {
    search: ["title", "subtitle", "slug", "tokens"],
    sort: ["kind", "netuid", "slug", "title"],
  }),
  economics: queryCollection("subnets", {
    filters: {
      netuid: integerSchema,
      registration_allowed: enumSchema(["true", "false"]),
    },
    search: ["name", "slug"],
    sort: [
      "alpha_price_tao",
      "emission_share",
      "max_stake_tao",
      "max_uids",
      "max_validators",
      "miner_count",
      "miner_readiness",
      "name",
      "netuid",
      "open_slots",
      "registration_cost_tao",
      "subnet_volume_tao",
      "total_stake_tao",
      "validator_count",
    ],
  }),
  endpoints: queryCollection("endpoints", {
    filters: {
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      layer: enumSchema(QUERY_ENUMS.endpointLayer),
      netuid: integerSchema,
      pool_eligible: enumSchema(["true", "false"]),
      provider: textSchema,
      publication_state: enumSchema(QUERY_ENUMS.endpointPublicationState),
      status: enumSchema(QUERY_ENUMS.healthStatus),
    },
    sort: [
      "kind",
      "last_checked",
      "latency_ms",
      "layer",
      "netuid",
      "pool_eligible",
      "provider",
      "publication_state",
      "score",
      "status",
    ],
  }),
  "endpoint-pools": queryCollection("pools", {
    filters: {
      id: textSchema,
      kind: enumSchema(["subtensor-rpc", "subtensor-wss", "archive"]),
    },
    sort: ["eligible_count", "endpoint_count", "id", "kind"],
  }),
  "endpoint-incidents": queryCollection("incidents", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: textSchema,
      status: enumSchema(QUERY_ENUMS.healthStatus),
      severity: enumSchema(QUERY_ENUMS.endpointIncidentSeverity),
      state: enumSchema(QUERY_ENUMS.endpointIncidentState),
    },
    sort: [
      "detected_at",
      "endpoint_id",
      "kind",
      "last_checked",
      "netuid",
      "provider",
      "severity",
      "state",
      "status",
    ],
  }),
  gaps: queryCollection("gaps", {
    filters: {
      netuid: integerSchema,
      coverage_level: enumSchema(QUERY_ENUMS.coverageLevel),
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
    },
    sort: ["coverage_level", "curation_level", "gap_count", "name", "netuid"],
  }),
  profiles: queryCollection("profiles", {
    filters: {
      netuid: integerSchema,
      subnet_type: enumSchema(QUERY_ENUMS.subnetType),
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
      review_state: textSchema,
      confidence: enumSchema(["low", "medium", "high"]),
      profile_level: enumSchema(QUERY_ENUMS.profileLevel),
    },
    search: ["name", "slug", "project_name", "team", "categories"],
    sort: [
      "candidate_count",
      "completeness_score",
      "curation_level",
      "interface_count",
      "missing_critical_count",
      "name",
      "netuid",
      "operational_interface_count",
      "profile_level",
      "review_state",
    ],
  }),
  "profile-completeness": queryCollection("profiles", {
    filters: {
      netuid: integerSchema,
      profile_level: enumSchema(QUERY_ENUMS.profileLevel),
      confidence: enumSchema(["low", "medium", "high"]),
      identity_level: enumSchema(["none", "directory", "partial", "complete"]),
      identity_promotion_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      native_name_quality: enumSchema(["chain", "placeholder", "empty"]),
    },
    sort: [
      "candidate_count",
      "completeness_score",
      "identity_level",
      "identity_promotion_kind_count",
      "identity_surface_count",
      "live_identity_candidate_kind_count",
      "missing_critical_count",
      "name",
      "native_identity_signal_count",
      "native_name_quality",
      "netuid",
      "priority_score",
      "profile_level",
      "stale_identity_candidate_kind_count",
    ],
  }),
  "review-gap-priorities": queryCollection("priorities", {
    filters: {
      netuid: integerSchema,
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
      review_state: textSchema,
    },
    sort: [
      "candidate_count",
      "curation_level",
      "missing_kinds",
      "name",
      "netuid",
      "priority_score",
      "surface_count",
      "verified_candidate_count",
    ],
  }),
  "adapter-candidates": queryCollection("candidates", {
    filters: {
      netuid: integerSchema,
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
      candidate_api_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      operational_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      reason_codes: textSchema,
      recommended_adapter_kind: enumSchema(QUERY_ENUMS.recommendedAdapterKind),
    },
    sort: [
      "candidate_api_count",
      "candidate_api_kinds",
      "curation_level",
      "name",
      "netuid",
      "operational_kinds",
      "operational_surface_count",
      "priority_score",
      "recommended_adapter_kind",
    ],
  }),
  "enrichment-queue": queryCollection("queue", {
    filters: {
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
      direct_submission_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      evidence_action: enumSchema([
        "submit-new-evidence",
        "verify-existing-evidence",
        "replace-stale-evidence",
        "review-existing-evidence",
        "maintainer-review-existing-evidence",
        "monitor",
      ]),
      identity_level: enumSchema(["none", "directory", "partial", "complete"]),
      lane: enumSchema([
        "direct-submission",
        "maintainer-review",
        "adapter-candidate",
        "monitoring-followup",
        "baseline-monitoring",
      ]),
      missing_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      netuid: integerSchema,
      profile_level: enumSchema(QUERY_ENUMS.profileLevel),
      reason_codes: textSchema,
      review_state: textSchema,
      manual_review_required: enumSchema(["true", "false"]),
    },
    search: ["name", "slug", "recommended_action", "reason_codes"],
    sort: [
      "adapter_score",
      "candidate_count",
      "completeness_score",
      "curation_level",
      "endpoint_count",
      "evidence_action",
      "identity_level",
      "identity_surface_count",
      "lane",
      "name",
      "netuid",
      "operational_interface_count",
      "priority_score",
      "profile_level",
      "review_state",
      "stale_candidate_count",
      "surface_count",
      "verified_candidate_count",
    ],
  }),
  "enrichment-evidence": queryCollection("entries", {
    filters: {
      direct_submission_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      evidence_action: enumSchema([
        "submit-new-evidence",
        "verify-existing-evidence",
        "replace-stale-evidence",
        "review-existing-evidence",
        "maintainer-review-existing-evidence",
        "monitor",
      ]),
      lane: enumSchema([
        "direct-submission",
        "maintainer-review",
        "adapter-candidate",
        "monitoring-followup",
        "baseline-monitoring",
      ]),
      missing_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      netuid: integerSchema,
    },
    search: ["name", "slug", "evidence_action"],
    sort: ["evidence_action", "lane", "name", "netuid", "priority_score"],
  }),
  "enrichment-targets": queryCollection("targets", {
    filters: {
      auto_review_candidate: enumSchema(["true", "false"]),
      evidence_action: enumSchema([
        "submit-new-evidence",
        "verify-existing-evidence",
        "replace-stale-evidence",
        "review-existing-evidence",
        "maintainer-review-existing-evidence",
        "monitor",
      ]),
      identity_level: enumSchema(["none", "directory", "partial", "complete"]),
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      lane: enumSchema([
        "direct-submission",
        "maintainer-review",
        "adapter-candidate",
        "monitoring-followup",
        "baseline-monitoring",
      ]),
      manual_review_required: enumSchema(["true", "false"]),
      missing_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      netuid: integerSchema,
      profile_level: enumSchema(QUERY_ENUMS.profileLevel),
      reason_codes: textSchema,
      submission_route: enumSchema([
        "direct-candidate-pr",
        "adapter-request",
        "maintainer-review",
        "status-report",
      ]),
      target_action: enumSchema([
        "submit-new-candidate",
        "replace-stale-candidate",
        "verify-existing-candidate",
        "review-existing-candidate",
        "adapter-review",
        "maintainer-review",
        "monitoring-followup",
      ]),
      target_type: enumSchema([
        "surface-candidate",
        "adapter-review",
        "maintainer-review",
        "monitoring-followup",
      ]),
    },
    search: [
      "name",
      "slug",
      "contribution_prompt",
      "recommended_action",
      "reason_codes",
    ],
    sort: [
      "auto_review_candidate",
      "evidence_action",
      "identity_level",
      "kind",
      "lane",
      "manual_review_required",
      "name",
      "netuid",
      "priority_score",
      "profile_level",
      "submission_route",
      "target_action",
      "target_type",
    ],
  }),
  "health-subnets": queryCollection("subnets", {
    filters: {
      netuid: integerSchema,
      status: enumSchema(QUERY_ENUMS.healthStatus),
    },
    sort: [
      "avg_latency_ms",
      "degraded_count",
      "failed_count",
      "last_checked",
      "last_ok",
      "name",
      "netuid",
      "ok_count",
      "status",
      "surface_count",
      "unknown_count",
    ],
  }),
  "health-surfaces": queryCollection("surfaces", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: textSchema,
      status: enumSchema(QUERY_ENUMS.healthStatus),
      classification: enumSchema(QUERY_ENUMS.healthClassification),
    },
    sort: [
      "classification",
      "kind",
      "last_checked",
      "last_ok",
      "latency_ms",
      "netuid",
      "provider",
      "status",
      "status_code",
      "surface_id",
      "verified_at",
    ],
  }),
  pools: queryCollection("pools", {
    filters: {
      id: textSchema,
      kind: enumSchema(["subtensor-rpc", "subtensor-wss", "archive"]),
    },
    sort: ["eligible_count", "endpoint_count", "id", "kind"],
  }),
  providers: queryCollection("providers", {
    filters: {
      id: textSchema,
      kind: enumSchema(QUERY_ENUMS.providerKind),
      authority: enumSchema(QUERY_ENUMS.providerAuthority),
    },
    sort: ["authority", "id", "kind", "name"],
  }),
  sources: queryCollection("sources", {
    search: ["id", "kind", "path"],
    sort: ["id", "kind", "path", "record_count"],
  }),
  subnets: queryCollection("subnets", {
    csvFilters: { netuids: "netuid" },
    // ?domain= matches the union of curated categories + derived_categories
    // (issue #345), so a derived domain tag OR a curated category resolves it.
    arrayFilters: { domain: ["categories", "derived_categories"] },
    filters: {
      netuid: integerSchema,
      netuids: {
        type: "string",
        maxLength: 767,
        pattern: "^\\d{1,5}(,\\d{1,5}){0,127}$",
      },
      coverage_level: enumSchema(QUERY_ENUMS.coverageLevel),
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
      domain: enumSchema(DOMAIN_TAGS),
      status: enumSchema(QUERY_ENUMS.subnetStatus),
      subnet_type: enumSchema(QUERY_ENUMS.subnetType),
    },
    search: ["name", "slug"],
    sort: [
      "block",
      "candidate_count",
      "coverage_level",
      "curation_level",
      "mechanism_count",
      "name",
      "netuid",
      "participant_count",
      "probed_surface_count",
      "status",
      "subnet_type",
      "surface_count",
      "tempo",
    ],
    // Inclusive numeric range filters: ?min_surface_count=5&max_tempo=360, etc.
    rangeFilters: [
      "block",
      "candidate_count",
      "mechanism_count",
      "participant_count",
      "probed_surface_count",
      "surface_count",
      "tempo",
    ],
  }),
};

export const PUBLIC_ARTIFACTS = [
  artifact(
    "contracts",
    "/metagraph/contracts.json",
    "Public artifact contract metadata for metagraph.sh consumers.",
    "ContractsArtifact",
  ),
  artifact(
    "providers",
    "/metagraph/providers.json",
    "Provider/source registry.",
    "ProvidersArtifact",
  ),
  artifact(
    "provider-detail",
    "/metagraph/providers/{slug}.json",
    "Per-provider detail payload.",
    "ProviderArtifact",
  ),
  artifact(
    "provider-endpoints",
    "/metagraph/providers/{slug}/endpoints.json",
    "Endpoint resources for one provider or operator.",
    "ProviderEndpointsArtifact",
  ),
  artifact(
    "api-index",
    "/metagraph/api-index.json",
    "Clean API route index for metagraph.sh consumers.",
    "ApiIndexArtifact",
  ),
  artifact(
    "openapi",
    "/metagraph/openapi.json",
    "OpenAPI 3.1 contract for the metagraph.sh backend API.",
    "OpenApiArtifact",
  ),
  artifact(
    "type-definitions",
    "/metagraph/types.d.ts",
    "Generated TypeScript definitions for metagraph.sh backend consumers.",
    null,
  ),
  artifact(
    "changelog",
    "/metagraph/changelog.json",
    "Reviewable generated artifact and subnet-change summary.",
    "ChangelogArtifact",
  ),
  artifact(
    "subnets",
    "/metagraph/subnets.json",
    "All active Finney subnets with compact registry metadata.",
    "SubnetsArtifact",
  ),
  artifact(
    "metagraph-latest",
    "/metagraph/metagraph/latest.json",
    "Latest normalized all-subnet metagraph index with chain-native state and registry coverage metadata.",
    "SubnetsArtifact",
  ),
  artifact(
    "subnet-detail",
    "/metagraph/subnets/{netuid}.json",
    "Per-subnet detail payload.",
    "SubnetDetailArtifact",
  ),
  artifact(
    "subnet-overview",
    "/metagraph/overview/{netuid}.json",
    "Composed per-subnet overview: profile + health + curation + gaps + counts.",
    "SubnetOverviewArtifact",
  ),
  artifact(
    "profiles",
    "/metagraph/profiles.json",
    "Public-safe subnet identity and completeness profiles.",
    "SubnetProfilesArtifact",
  ),
  artifact(
    "profile-detail",
    "/metagraph/profiles/{netuid}.json",
    "Per-subnet public-safe profile detail.",
    "SubnetProfileArtifact",
  ),
  artifact(
    "surfaces",
    "/metagraph/surfaces.json",
    "Curated public interface surfaces only.",
    "SurfacesArtifact",
  ),
  artifact(
    "surface-aliases",
    "/metagraph/surface-aliases.json",
    "Deprecated surface display-id aliases mapped to stable surface keys for renamed surfaces.",
    "SurfaceAliasesArtifact",
  ),
  artifact(
    "surfaces-subnet",
    "/metagraph/surfaces/{netuid}.json",
    "Curated public interface surfaces for one subnet.",
    "SubnetSurfacesArtifact",
  ),
  artifact(
    "endpoints",
    "/metagraph/endpoints.json",
    "Generalized endpoint/resource registry derived from curated surfaces and probe observations.",
    "EndpointsArtifact",
  ),
  artifact(
    "endpoints-subnet",
    "/metagraph/endpoints/{netuid}.json",
    "Generalized endpoint/resource registry for one subnet.",
    "SubnetEndpointsArtifact",
  ),
  artifact(
    "candidates",
    "/metagraph/candidates.json",
    "Unpromoted candidate surfaces from public discovery.",
    "CandidatesArtifact",
  ),
  artifact(
    "candidates-subnet",
    "/metagraph/candidates/{netuid}.json",
    "Unpromoted candidate surfaces for one subnet.",
    "SubnetCandidatesArtifact",
  ),
  artifact(
    "review-queue",
    "/metagraph/review-queue.json",
    "Candidate surfaces queued for maintainer review.",
    "ReviewQueueArtifact",
  ),
  artifact(
    "search",
    "/metagraph/search.json",
    "Compact search index for subnets, surfaces, and providers.",
    "SearchArtifact",
  ),
  artifact(
    "search-index",
    "/metagraph/search-index.json",
    "Slim search index (the same documents as search.json without the per-document token blobs) for fast browser typeahead and listing.",
    "SearchIndexArtifact",
  ),
  artifact(
    "coverage",
    "/metagraph/coverage.json",
    "Registry coverage counts and source precedence.",
    "CoverageArtifact",
  ),
  artifact(
    "coverage-depth",
    "/metagraph/coverage-depth.json",
    "Machine-usable coverage depth scorecard with per-subnet readiness dimensions and a ranked enrichment queue.",
    "CoverageDepthArtifact",
  ),
  artifact(
    "economics",
    "/metagraph/economics.json",
    "Per-subnet validator and economic metrics from the chain: validator/miner counts, total + max stake, registration cost, alpha price, and derived price-weighted emission share.",
    "EconomicsArtifact",
  ),
  artifact(
    "economics-trends",
    "/metagraph/economics/trends.json",
    "Network-wide economics time series (#1307) aggregated per UTC day across all subnets from the daily subnet_snapshots D1 rollup (the same source the per-subnet trajectory reads), served live at /api/v1/economics/trends (no static file).",
    "EconomicsTrendsArtifact",
  ),
  artifact(
    "registry-summary",
    "/metagraph/registry-summary.json",
    "Registry-wide summary: completeness rollup, top subnets, level counts, latest changes.",
    "RegistrySummaryArtifact",
  ),
  artifact(
    "lineage",
    "/metagraph/lineage.json",
    "Cross-network subnet lineage: maintainer-approved mainnet ↔ testnet pairs with reviewed match evidence.",
    "LineageArtifact",
  ),
  artifact(
    "fixtures-index",
    "/metagraph/fixtures.json",
    "Index of captured live request/response fixtures (which surfaces carry a sanitized sample).",
    "FixturesIndexArtifact",
  ),
  artifact(
    "agent-resources",
    "/metagraph/agent-resources.json",
    "Machine index of every AI resource: the copyable agent, the MCP server + tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs.",
    "AgentResourcesArtifact",
  ),
  artifact(
    "fixture-detail",
    "/metagraph/fixtures/{surface_id}.json",
    "A captured, sanitized live request/response sample for one surface.",
    "JsonObject",
  ),
  artifact(
    "curation",
    "/metagraph/curation.json",
    "Curation state and gaps for every active subnet.",
    "CurationArtifact",
  ),
  artifact(
    "gaps",
    "/metagraph/gaps.json",
    "Missing public interface facets by subnet.",
    "GapsArtifact",
  ),
  artifact(
    "verification",
    "/metagraph/verification/latest.json",
    "Latest candidate verification snapshot.",
    "VerificationArtifact",
  ),
  artifact(
    "verification-subnet",
    "/metagraph/verification/subnets/{netuid}.json",
    "Latest candidate verification snapshot for one subnet.",
    "SubnetVerificationArtifact",
  ),
  artifact(
    "freshness",
    "/metagraph/freshness.json",
    "Freshness and staleness summary for generated backend data.",
    "FreshnessArtifact",
  ),
  artifact(
    "source-health",
    "/metagraph/source-health.json",
    "Upstream source and provider health summary.",
    "SourceHealthArtifact",
  ),
  artifact(
    "source-snapshots",
    "/metagraph/source-snapshots.json",
    "Compact hashes and counts for canonical source inputs.",
    "SourceSnapshotsArtifact",
  ),
  artifact(
    "evidence-ledger",
    "/metagraph/evidence-ledger.json",
    "Public evidence ledger for subnet and surface claims.",
    "EvidenceLedgerArtifact",
  ),
  artifact(
    "evidence-subnet",
    "/metagraph/evidence/{netuid}.json",
    "Public evidence ledger claims for one subnet.",
    "SubnetEvidenceArtifact",
  ),
  artifact(
    "health-latest",
    "/metagraph/health/latest.json",
    "Latest surface health snapshot.",
    "HealthLatestArtifact",
  ),
  artifact(
    "health-summary",
    "/metagraph/health/summary.json",
    "Global and per-subnet health rollup.",
    "HealthSummaryArtifact",
  ),
  artifact(
    "health-history",
    "/metagraph/health/history/{date}.json",
    "Compact daily health-history snapshot.",
    "HealthHistoryArtifact",
  ),
  artifact(
    "health-subnet",
    "/metagraph/health/subnets/{netuid}.json",
    "Per-subnet health payload for metagraph.sh consumers.",
    "HealthSubnetArtifact",
  ),
  artifact(
    "health-badge",
    "/metagraph/health/badges/{netuid}.json",
    "Badge data contract for status rendering.",
    "HealthBadgeArtifact",
  ),
  artifact(
    "health-trends",
    "/metagraph/health/trends/{netuid}.json",
    "Computed 7d/30d uptime + success-only latency trends (mean, p50/p95/p99 tail, and healthy-sample count) for one subnet's operational surfaces. Served live from D1 at /api/v1/subnets/{netuid}/health/trends (no static file).",
    "HealthTrendsArtifact",
  ),
  artifact(
    "health-trends-bulk",
    "/metagraph/health/trends.json",
    "Compact all-subnet 7d/30d daily uptime + success-only latency trend matrix (mean + healthy-sample count). Served live from D1 at /api/v1/health/trends (no static file).",
    "BulkHealthTrendsArtifact",
  ),
  artifact(
    "health-percentiles",
    "/metagraph/health/percentiles/{netuid}.json",
    "Latency percentiles (p50/p95/p99 + avg/min/max) per operational surface for one subnet, computed live from D1 at /api/v1/subnets/{netuid}/health/percentiles (no static file).",
    "HealthPercentilesArtifact",
  ),
  artifact(
    "health-incidents",
    "/metagraph/health/incidents/{netuid}.json",
    "SLA (uptime ratio) and reconstructed downtime incidents per operational surface for one subnet, computed live from D1 at /api/v1/subnets/{netuid}/health/incidents (no static file).",
    "HealthIncidentsArtifact",
  ),
  artifact(
    "subnet-trajectory",
    "/metagraph/subnets/{netuid}/trajectory.json",
    "Week-over-week structural trajectory (completeness + surface/endpoint counts) for one subnet from daily snapshots, served live from D1 at /api/v1/subnets/{netuid}/trajectory (no static file).",
    "SubnetTrajectoryArtifact",
  ),
  artifact(
    "subnet-concentration",
    "/metagraph/subnets/{netuid}/concentration.json",
    "Stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for one subnet across three lenses — per-UID, per-entity (coldkeys collapsed to the true control distribution), and validator-only consensus power — served live from the neurons D1 tier at /api/v1/subnets/{netuid}/concentration (no static file).",
    "SubnetConcentrationArtifact",
  ),
  artifact(
    "subnet-concentration-history",
    "/metagraph/subnets/{netuid}/concentration/history.json",
    "Per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) over a 7d/30d/90d window for one subnet, served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/concentration/history (no static file).",
    "SubnetConcentrationHistoryArtifact",
  ),
  artifact(
    "subnet-turnover",
    "/metagraph/subnets/{netuid}/turnover.json",
    "Validator-set & registration turnover (churn) for one subnet between a window's start and end snapshots — validators entered/exited + Jaccard retention, UID deregistrations, and a 0-100 stability score — served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/turnover (no static file).",
    "SubnetTurnoverArtifact",
  ),
  artifact(
    "subnet-metagraph",
    "/metagraph/subnets/{netuid}/metagraph.json",
    "Per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) for one subnet, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/metagraph (no static file).",
    "SubnetMetagraphArtifact",
  ),
  artifact(
    "subnet-neuron",
    "/metagraph/subnets/{netuid}/neurons/{uid}.json",
    "A single neuron's metagraph state by UID, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/neurons/{uid} (no static file).",
    "NeuronDetailArtifact",
  ),
  artifact(
    "subnet-validators",
    "/metagraph/subnets/{netuid}/validators.json",
    "Validators (validator_permit) of one subnet ranked by stake, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/validators (no static file).",
    "SubnetValidatorsArtifact",
  ),
  artifact(
    "subnet-events",
    "/metagraph/subnets/{netuid}/events.json",
    "First-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers), newest first, served live from the account_events D1 tier filtered by netuid at /api/v1/subnets/{netuid}/events (no static file).",
    "SubnetEventsArtifact",
  ),
  artifact(
    "subnet-neuron-history",
    "/metagraph/subnets/{netuid}/neurons/{uid}/history.json",
    "Per-UID daily metagraph history (stake/trust/emission/rank over time) for one UID, served live from the neuron_daily D1 rollup tier at /api/v1/subnets/{netuid}/neurons/{uid}/history (no static file).",
    "NeuronHistoryArtifact",
  ),
  artifact(
    "subnet-history",
    "/metagraph/subnets/{netuid}/history.json",
    "Per-subnet daily aggregate history (neuron/validator counts + stake/emission totals) for one subnet, served live from the neuron_daily D1 rollup tier at /api/v1/subnets/{netuid}/history (no static file).",
    "SubnetHistoryArtifact",
  ),
  artifact(
    "account-summary",
    "/metagraph/accounts/{ss58}.json",
    "Cross-subnet activity summary for one account (hotkey or coldkey): chain-event aggregates joined to current registrations, served live from D1 at /api/v1/accounts/{ss58} (no static file).",
    "AccountSummaryArtifact",
  ),
  artifact(
    "account-events",
    "/metagraph/accounts/{ss58}/events.json",
    "Paginated first-party chain-event history for one account (hotkey or coldkey), served live from the account_events D1 tier at /api/v1/accounts/{ss58}/events (no static file).",
    "AccountEventsArtifact",
  ),
  artifact(
    "account-history",
    "/metagraph/accounts/{ss58}/history.json",
    "Durable per-day activity series for one account (hotkey-keyed, newest day first), served live from the account_events_daily rollup at /api/v1/accounts/{ss58}/history (no static file).",
    "AccountHistoryArtifact",
  ),
  artifact(
    "account-extrinsics",
    "/metagraph/accounts/{ss58}/extrinsics.json",
    "Paginated extrinsics this account signed (by signer), newest first, served live from the extrinsics D1 tier at /api/v1/accounts/{ss58}/extrinsics (no static file).",
    "AccountExtrinsicsArtifact",
  ),
  artifact(
    "account-transfers",
    "/metagraph/accounts/{ss58}/transfers.json",
    "The native-TAO Balances.Transfer feed for one account (directional sent/received), served live from the account_events D1 tier at /api/v1/accounts/{ss58}/transfers (no static file).",
    "AccountTransfersArtifact",
  ),
  artifact(
    "account-counterparties",
    "/metagraph/accounts/{ss58}/counterparties.json",
    "Per-counterparty fund-flow rollup for one account, with optional ?counterparty=<ss58> relationship evidence — native-TAO transfers from the account_events D1 tier at /api/v1/accounts/{ss58}/counterparties (no static file).",
    "AccountCounterpartiesArtifact",
  ),
  artifact(
    "account-subnets",
    "/metagraph/accounts/{ss58}/subnets.json",
    "The subnets where an account's hotkey is currently registered, served live from the neurons D1 tier at /api/v1/accounts/{ss58}/subnets (no static file).",
    "AccountSubnetsArtifact",
  ),
  artifact(
    "account-balance",
    "/metagraph/accounts/{ss58}/balance.json",
    "Live TAO balance (free+reserved, in TAO) for a finney account, queried from the RPC at request time with 60s KV cache. balance_tao is null on RPC failure. (#1818)",
    "AccountBalanceArtifact",
  ),
  artifact(
    "blocks-feed",
    "/metagraph/blocks.json",
    "The recent-block feed (newest first) for the block explorer (#1345), served live from the first-party blocks D1 tier at /api/v1/blocks (no static file).",
    "BlocksFeedArtifact",
  ),
  artifact(
    "block-detail",
    "/metagraph/blocks/{ref}.json",
    "Per-block detail (by numeric block_number or 0x block_hash) for the block explorer (#1345), served live from the first-party blocks D1 tier at /api/v1/blocks/{ref} (no static file).",
    "BlockDetailArtifact",
  ),
  artifact(
    "block-extrinsics",
    "/metagraph/blocks/{ref}/extrinsics.json",
    "The extrinsics in one block (by numeric block_number or 0x block_hash), in natural order, served live from the first-party extrinsics D1 tier at /api/v1/blocks/{ref}/extrinsics (no static file).",
    "BlockExtrinsicsArtifact",
  ),
  artifact(
    "block-events",
    "/metagraph/blocks/{ref}/events.json",
    "The decoded chain events in one block (by numeric block_number or 0x block_hash), in natural order, served live from the first-party account_events D1 tier filtered by block_number at /api/v1/blocks/{ref}/events (no static file).",
    "BlockEventsArtifact",
  ),
  artifact(
    "chain-events-feed",
    "/metagraph/chain-events.json",
    "Recent all-events feed (newest first) from the Postgres-backed all-events tier (ADR 0013), served live at /api/v1/chain-events (no static file). Distinct from the curated account-attributed event stream; empty before the all-events backfill runs.",
    "ChainEventsFeedArtifact",
  ),
  artifact(
    "block-chain-events",
    "/metagraph/blocks/{ref}/chain-events.json",
    "Every raw pallet-level event in one block (event_index ascending) from the Postgres-backed all-events tier (ADR 0013), served live at /api/v1/blocks/{ref}/chain-events (no static file). Distinct from /blocks/{ref}/events (the curated account-attributed D1 stream).",
    "BlockChainEventsArtifact",
  ),
  artifact(
    "chain-events-stats",
    "/metagraph/chain-events/stats.json",
    "Chain-activity aggregate (pallet.method event distribution over the most recent N blocks) from the Postgres-backed all-events tier (ADR 0013), served live at /api/v1/chain-events/stats (no static file) and consumed by the get_chain_activity MCP tool.",
    "ChainEventsStatsArtifact",
  ),
  artifact(
    "extrinsics-feed",
    "/metagraph/extrinsics.json",
    "The recent-extrinsic feed (newest first) for the block explorer (#1345), served live from the first-party extrinsics D1 tier at /api/v1/extrinsics (no static file).",
    "ExtrinsicsFeedArtifact",
  ),
  artifact(
    "extrinsic-detail",
    "/metagraph/extrinsics/{hash}.json",
    "Per-extrinsic detail (by 0x extrinsic_hash OR the composite <block_number>-<extrinsic_index> id) for the block explorer (#1345/#1848), served live from the first-party extrinsics D1 tier at /api/v1/extrinsics/{hash} (no static file).",
    "ExtrinsicDetailArtifact",
  ),
  artifact(
    "chain-activity",
    "/metagraph/chain/activity.json",
    "Daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d or 30d window for the block explorer (#1987), computed live from the first-party chain D1 tiers at /api/v1/chain/activity (no static file).",
    "ChainActivityArtifact",
  ),
  artifact(
    "chain-calls",
    "/metagraph/chain/calls.json",
    "Extrinsic call-mix breakdown (count + share per call_module / call_function) over a 7d or 30d window for the block explorer (#1989), computed live from the first-party extrinsics D1 tier at /api/v1/chain/calls (no static file).",
    "ChainCallsArtifact",
  ),
  artifact(
    "chain-signers",
    "/metagraph/chain/signers.json",
    "Windowed most-active-account leaderboard (signers ranked by extrinsic count, with fees/tips + newest block) over a 7d or 30d window for the block explorer (#1990), computed live from the first-party extrinsics D1 tier at /api/v1/chain/signers (no static file).",
    "ChainSignersArtifact",
  ),
  artifact(
    "chain-fees",
    "/metagraph/chain/fees.json",
    "Fee/tip market analytics (daily totals + averages and a top-fee-payer list) over a 7d or 30d window for the block explorer (#1988), computed live from the first-party extrinsics D1 tier at /api/v1/chain/fees (no static file).",
    "ChainFeesArtifact",
  ),
  artifact(
    "subnet-uptime",
    "/metagraph/subnets/{netuid}/uptime.json",
    "Long-term daily uptime history per operational surface for one subnet (90d/1y window), served live from the surface_uptime_daily D1 rollup (no static file).",
    "UptimeArtifact",
  ),
  artifact(
    "global-incidents",
    "/metagraph/incidents.json",
    "Recent cross-subnet downtime incidents reconstructed from probe history over a 7d or 30d window, served live from D1 at /api/v1/incidents (no static file).",
    "GlobalIncidentsArtifact",
  ),
  artifact(
    "registry-leaderboards",
    "/metagraph/registry/leaderboards.json",
    "Registry leaderboards — operational (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable) and economic opportunity (open-slots, cheapest-registration, highest-emission, validator-headroom) — computed live from D1 + registry projections + the economics tier at /api/v1/registry/leaderboards (no static file).",
    "RegistryLeaderboardsArtifact",
  ),
  artifact(
    "compare",
    "/metagraph/compare.json",
    "Cross-subnet comparison — registry structure (completeness + surface counts), the live economics tier, and the live per-subnet health rollup placed side by side for the requested netuids in requested order — computed live from registry projections + the economics tier + D1 at /api/v1/compare (no static file).",
    "CompareArtifact",
  ),
  artifact(
    "rpc-usage",
    "/metagraph/rpc/usage.json",
    "RPC reverse-proxy usage analytics (request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets) over a 7d/30d window, computed live from the rpc_proxy_events telemetry at /api/v1/rpc/usage (no static file).",
    "RpcUsageArtifact",
  ),
  artifact(
    "rpc-endpoints",
    "/metagraph/rpc-endpoints.json",
    "Bittensor base-layer RPC endpoint registry and probe status.",
    "RpcEndpointsArtifact",
  ),
  artifact(
    "rpc-pools",
    "/metagraph/rpc/pools.json",
    "Endpoint pool scoring for future read-only RPC routing.",
    "RpcPoolsArtifact",
  ),
  artifact(
    "endpoint-pools",
    "/metagraph/endpoint-pools.json",
    "Generalized endpoint pool scoring for future read-only routing.",
    "EndpointPoolsArtifact",
  ),
  artifact(
    "endpoint-incidents",
    "/metagraph/endpoint-incidents.json",
    "Probe-derived endpoint incident summary and active endpoint failures.",
    "EndpointIncidentsArtifact",
  ),
  artifact(
    "operational-surfaces",
    "/metagraph/operational-surfaces.json",
    "Operational surfaces (RPC/WSS/subnet-api/SSE/data-artifact) probed live by the cron health prober; input list for the 15-minute scheduled prober.",
    "OperationalSurfacesArtifact",
  ),
  artifact(
    "agent-catalog",
    "/metagraph/agent-catalog.json",
    "Compact index of subnets exposing callable services (subnet-api/openapi/sse/data-artifact) — the machine-readable 'which subnet does X + how to call it' index for AI agents.",
    "AgentCatalogArtifact",
  ),
  artifact(
    "agent-catalog-subnet",
    "/metagraph/agent-catalog/{netuid}.json",
    "Per-subnet agent capability catalog: each callable service with its base URL, auth, machine-readable schema, and live-build health/eligibility.",
    "AgentCatalogSubnetArtifact",
  ),
  artifact(
    "schema-drift",
    "/metagraph/schema-drift.json",
    "OpenAPI schema snapshot/drift status.",
    "SchemaDriftArtifact",
  ),
  artifact(
    "schema-index",
    "/metagraph/schemas/index.json",
    "Index of captured machine-readable schemas.",
    "SchemaIndexArtifact",
  ),
  artifact(
    "schema-snapshot",
    "/metagraph/schemas/{surface_id}.json",
    "Captured machine-readable OpenAPI/Swagger schema snapshot detail.",
    "JsonObject",
  ),
  artifact(
    "adapter",
    "/metagraph/adapters/{slug}.json",
    "Adapter-backed public metrics by subnet slug.",
    "AdapterArtifact",
  ),
  artifact(
    "r2-manifest",
    "/metagraph/r2-manifest.json",
    "R2 upload manifest for generated artifact history.",
    "R2ManifestArtifact",
  ),
  artifact(
    "review-curation",
    "/metagraph/review/curation.json",
    "Maintainer curation and adapter candidate report.",
    "ReviewCurationArtifact",
  ),
  artifact(
    "review-gap-priorities",
    "/metagraph/review/gap-priorities.json",
    "Subnet interface gap priorities.",
    "ReviewGapPrioritiesArtifact",
  ),
  artifact(
    "subnet-gaps",
    "/metagraph/review/gaps/{netuid}.json",
    "Interface gap priorities and enrichment queue for one subnet.",
    "SubnetGapsArtifact",
  ),
  artifact(
    "review-profile-completeness",
    "/metagraph/review/profile-completeness.json",
    "Profile completeness and contributor targeting report.",
    "ReviewProfileCompletenessArtifact",
  ),
  artifact(
    "review-adapter-candidates",
    "/metagraph/review/adapter-candidates.json",
    "Subnets worth deeper adapter work.",
    "ReviewAdapterCandidatesArtifact",
  ),
  artifact(
    "review-enrichment-queue",
    "/metagraph/review/enrichment-queue.json",
    "Prioritized all-subnet enrichment work queue for contributor-safe registry improvements.",
    "ReviewEnrichmentQueueArtifact",
  ),
  artifact(
    "review-enrichment-evidence",
    "/metagraph/review/enrichment-evidence.json",
    "Detailed candidate evidence by missing or contributor-target surface kind for enrichment work.",
    "ReviewEnrichmentEvidenceArtifact",
  ),
  artifact(
    "review-enrichment-targets",
    "/metagraph/review/enrichment-targets.json",
    "Contributor-oriented enrichment target pack grouped by submission kind, review route, and evidence action.",
    "ReviewEnrichmentTargetsArtifact",
  ),
  artifact(
    "review-decisions",
    "/metagraph/review/maintainer-decisions.json",
    "Public-safe maintainer review decision ledger.",
    "ReviewDecisionsArtifact",
  ),
  artifact(
    "build-summary",
    "/metagraph/build-summary.json",
    "Generated build summary.",
    "BuildSummaryArtifact",
  ),
];

export const API_ROUTES = [
  route(
    "api-index",
    "GET",
    "/api/v1",
    "/metagraph/api-index.json",
    "List backend API routes and response envelope metadata.",
    "standard",
    ["contracts"],
  ),
  route(
    "subnets",
    "GET",
    "/api/v1/subnets",
    "/metagraph/subnets.json",
    "List active Finney subnets.",
    "standard",
    ["subnets"],
    listQuery("subnets"),
  ),
  route(
    "subnet-detail",
    "GET",
    "/api/v1/subnets/{netuid}",
    "/metagraph/subnets/{netuid}.json",
    "Fetch per-subnet detail.",
    "standard",
    ["subnets"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "profiles",
    "GET",
    "/api/v1/profiles",
    "/metagraph/profiles.json",
    "List public-safe subnet profiles and completeness scores.",
    "standard",
    ["profiles", "subnets"],
    listQuery("profiles"),
  ),
  route(
    "subnet-profile",
    "GET",
    "/api/v1/subnets/{netuid}/profile",
    "/metagraph/profiles/{netuid}.json",
    "Fetch public-safe profile detail for one subnet.",
    "standard",
    ["profiles", "subnets"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-overview",
    "GET",
    "/api/v1/subnets/{netuid}/overview",
    "/metagraph/overview/{netuid}.json",
    "Fetch a composed overview (profile + health + curation + gaps + counts) for one subnet.",
    "standard",
    ["subnets", "profiles", "health"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "agent-catalog",
    "GET",
    "/api/v1/agent-catalog",
    "/metagraph/agent-catalog.json",
    "List subnets exposing callable services for AI agents (compact capability index).",
    "standard",
    ["agents", "subnets"],
  ),
  route(
    "agent-catalog-subnet",
    "GET",
    "/api/v1/agent-catalog/{netuid}",
    "/metagraph/agent-catalog/{netuid}.json",
    "Fetch the callable-services catalog for one subnet (each service with its schema + health).",
    "standard",
    ["agents", "subnets"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "surfaces",
    "GET",
    "/api/v1/surfaces",
    "/metagraph/surfaces.json",
    "List curated public surfaces.",
    "standard",
    ["surfaces"],
    listQuery("curated-surfaces"),
  ),
  route(
    "subnet-surfaces",
    "GET",
    "/api/v1/subnets/{netuid}/surfaces",
    "/metagraph/surfaces/{netuid}.json",
    "List curated public surfaces for one subnet.",
    "standard",
    ["surfaces", "subnets"],
    listQuery("curated-surfaces", { exclude: ["netuid"] }),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "endpoints",
    "GET",
    "/api/v1/endpoints",
    "/metagraph/endpoints.json",
    "List generalized endpoint resources and monitored public surfaces.",
    "short",
    ["endpoints"],
    listQuery("endpoints"),
  ),
  route(
    "subnet-endpoints",
    "GET",
    "/api/v1/subnets/{netuid}/endpoints",
    "/metagraph/endpoints/{netuid}.json",
    "List generalized endpoint resources for one subnet.",
    "short",
    ["endpoints", "subnets"],
    listQuery("endpoints", { exclude: ["netuid"] }),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "candidates",
    "GET",
    "/api/v1/candidates",
    "/metagraph/candidates.json",
    "List unpromoted candidate surfaces.",
    "standard",
    ["candidates"],
    listQuery("candidates"),
  ),
  route(
    "subnet-candidates",
    "GET",
    "/api/v1/subnets/{netuid}/candidates",
    "/metagraph/candidates/{netuid}.json",
    "List unpromoted candidate surfaces for one subnet.",
    "standard",
    ["candidates", "subnets"],
    listQuery("candidates", { exclude: ["netuid"] }),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "providers",
    "GET",
    "/api/v1/providers",
    "/metagraph/providers.json",
    "List providers and sources.",
    "standard",
    ["providers"],
    listQuery("providers"),
  ),
  route(
    "provider-detail",
    "GET",
    "/api/v1/providers/{slug}",
    "/metagraph/providers/{slug}.json",
    "Fetch per-provider detail.",
    "standard",
    ["providers"],
    [],
    [{ name: "slug", schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
  ),
  route(
    "provider-endpoints",
    "GET",
    "/api/v1/providers/{slug}/endpoints",
    "/metagraph/providers/{slug}/endpoints.json",
    "List endpoint resources for one provider or operator.",
    "short",
    ["providers", "endpoints"],
    listQuery("endpoints", { exclude: ["provider"] }),
    [{ name: "slug", schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
  ),
  route(
    "coverage",
    "GET",
    "/api/v1/coverage",
    "/metagraph/coverage.json",
    "Fetch registry coverage summary.",
    "standard",
    ["registry"],
  ),
  route(
    "coverage-depth",
    "GET",
    "/api/v1/coverage-depth",
    "/metagraph/coverage-depth.json",
    "Fetch the machine-usable coverage depth scorecard and ranked enrichment queue.",
    "standard",
    ["registry", "review", "api-dx"],
    listQuery("coverage-depth"),
  ),
  route(
    "economics",
    "GET",
    "/api/v1/economics",
    "/metagraph/economics.json",
    "List per-subnet validator and economic metrics (counts, stake, registration cost, alpha price, emission share). Default order is emission share descending. Filter by netuid/registration_allowed, search by name/slug, and sort with `sort=<field>&order=asc|desc` — the two are separate parameters (e.g. `?sort=total_stake_tao&order=desc`), NOT a combined `field:desc` token.",
    "standard",
    ["subnets"],
    listQuery("economics"),
  ),
  route(
    "economics-trends",
    "GET",
    "/api/v1/economics/trends",
    "/metagraph/economics/trends.json",
    "Fetch the network-wide economics time series (#1307): per UTC day across all subnets — total stake, stake-weighted + median alpha price, total validator/miner counts, and mean emission share — aggregated live from the daily subnet_snapshots D1 rollup (the same source the per-subnet /trajectory reads). ?window=7d|30d|90d|1y|all (default 30d). Served live (no static file); day_count:0 / days:[] when the rollup is cold.",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [],
  ),
  route(
    "registry-summary",
    "GET",
    "/api/v1/registry/summary",
    "/metagraph/registry-summary.json",
    "Fetch the registry-wide summary (completeness, top subnets, level counts, latest changes).",
    "standard",
    ["registry"],
  ),
  route(
    "lineage",
    "GET",
    "/api/v1/lineage",
    "/metagraph/lineage.json",
    "Fetch maintainer-approved cross-network subnet lineage (graduated subnets + the deploying-soon testnet pipeline).",
    "standard",
    ["registry", "multi-network"],
  ),
  route(
    "fixtures",
    "GET",
    "/api/v1/fixtures",
    "/metagraph/fixtures.json",
    "Fetch the index of captured live request/response fixtures (which surfaces carry a sanitized sample). Fetch one with get_fixture / GET /metagraph/fixtures/{surface_id}.json.",
    "standard",
    ["registry", "api-dx"],
  ),
  route(
    "agent-resources",
    "GET",
    "/api/v1/agent-resources",
    "/metagraph/agent-resources.json",
    "Fetch the AI-resources index: the copyable agent (/agent.md), the MCP server + its tools, the skill, llms.txt, OpenAPI, and the agent-facing APIs.",
    "standard",
    ["api-dx"],
  ),
  route(
    "curation",
    "GET",
    "/api/v1/curation",
    "/metagraph/curation.json",
    "Fetch curation states by subnet.",
    "standard",
    ["registry"],
    listQuery("curation"),
  ),
  route(
    "gaps",
    "GET",
    "/api/v1/gaps",
    "/metagraph/gaps.json",
    "Fetch interface gap report.",
    "standard",
    ["registry"],
    listQuery("gaps"),
  ),
  route(
    "review-gaps",
    "GET",
    "/api/v1/review/gaps",
    "/metagraph/review/gap-priorities.json",
    "Fetch contributor-targeted subnet gap priorities.",
    "standard",
    ["registry", "review"],
    listQuery("review-gap-priorities"),
  ),
  route(
    "subnet-gaps",
    "GET",
    "/api/v1/subnets/{netuid}/gaps",
    "/metagraph/review/gaps/{netuid}.json",
    "Fetch interface gap priorities and enrichment queue for one subnet.",
    "standard",
    ["registry", "review", "subnets"],
    listQuery("review-gap-priorities", { exclude: ["netuid"] }),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "review-profile-completeness",
    "GET",
    "/api/v1/review/profile-completeness",
    "/metagraph/review/profile-completeness.json",
    "Fetch profile completeness gaps for contributor targeting.",
    "standard",
    ["registry", "review", "profiles"],
    listQuery("profile-completeness"),
  ),
  route(
    "review-adapter-candidates",
    "GET",
    "/api/v1/review/adapter-candidates",
    "/metagraph/review/adapter-candidates.json",
    "Fetch subnets worth deeper adapter work.",
    "standard",
    ["adapters", "review"],
    listQuery("adapter-candidates"),
  ),
  route(
    "review-enrichment-queue",
    "GET",
    "/api/v1/review/enrichment-queue",
    "/metagraph/review/enrichment-queue.json",
    "Fetch the prioritized all-subnet enrichment queue.",
    "standard",
    ["registry", "review", "profiles"],
    listQuery("enrichment-queue"),
  ),
  route(
    "review-enrichment-evidence",
    "GET",
    "/api/v1/review/enrichment-evidence",
    "/metagraph/review/enrichment-evidence.json",
    "Fetch detailed candidate evidence behind the enrichment queue.",
    "standard",
    ["registry", "review", "profiles"],
    listQuery("enrichment-evidence"),
  ),
  route(
    "review-enrichment-targets",
    "GET",
    "/api/v1/review/enrichment-targets",
    "/metagraph/review/enrichment-targets.json",
    "Fetch contributor-ready enrichment targets grouped by missing surface kind and review route.",
    "standard",
    ["registry", "review", "profiles"],
    listQuery("enrichment-targets"),
  ),
  route(
    "health",
    "GET",
    "/api/v1/health",
    "/metagraph/health/summary.json",
    "Fetch global health summary.",
    "short",
    ["health"],
    listQuery("health-subnets"),
  ),
  route(
    "health-history",
    "GET",
    "/api/v1/health/history/{date}",
    "/metagraph/health/history/{date}.json",
    "Fetch compact daily health history.",
    "short",
    ["health"],
    listQuery("health-surfaces"),
    [
      {
        name: "date",
        schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
    ],
  ),
  route(
    "subnet-health",
    "GET",
    "/api/v1/subnets/{netuid}/health",
    "/metagraph/health/subnets/{netuid}.json",
    "Fetch health detail for one subnet.",
    "short",
    ["health", "subnets"],
    listQuery("health-surfaces", { exclude: ["netuid"] }),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "health-trends-bulk",
    "GET",
    "/api/v1/health/trends",
    "/metagraph/health/trends.json",
    "Fetch compact 7d/30d daily uptime and latency trends for all subnets (computed live from D1).",
    "short",
    ["health", "analytics"],
  ),
  route(
    "subnet-health-trends",
    "GET",
    "/api/v1/subnets/{netuid}/health/trends",
    "/metagraph/health/trends/{netuid}.json",
    "Fetch 7d/30d uptime and success-only latency trends (mean + p50/p95/p99 tail + healthy-sample count) per operational surface for one subnet (computed live from D1).",
    "short",
    ["health", "subnets"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-health-percentiles",
    "GET",
    "/api/v1/subnets/{netuid}/health/percentiles",
    "/metagraph/health/percentiles/{netuid}.json",
    "Fetch latency percentiles (p50/p95/p99) per operational surface for one subnet over a 7d or 30d window (computed live from D1).",
    "short",
    ["health", "subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-health-incidents",
    "GET",
    "/api/v1/subnets/{netuid}/health/incidents",
    "/metagraph/health/incidents/{netuid}.json",
    "Fetch SLA (uptime ratio) and reconstructed downtime incidents per operational surface for one subnet over a 7d or 30d window (computed live from D1).",
    "short",
    ["health", "subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-trajectory",
    "GET",
    "/api/v1/subnets/{netuid}/trajectory",
    "/metagraph/subnets/{netuid}/trajectory.json",
    "Fetch the week-over-week structural trajectory (completeness + surface/endpoint counts) for one subnet from daily snapshots (computed live from D1).",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-concentration",
    "GET",
    "/api/v1/subnets/{netuid}/concentration",
    "/metagraph/subnets/{netuid}/concentration.json",
    "Fetch stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for one subnet across per-UID, per-entity (coldkeys collapsed), and validator-only consensus-power lenses (computed live from the neurons D1 tier).",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-concentration-history",
    "GET",
    "/api/v1/subnets/{netuid}/concentration/history",
    "/metagraph/subnets/{netuid}/concentration/history.json",
    "Fetch the per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) for one subnet over a 7d/30d/90d window (computed live from the neuron_daily D1 rollup).",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-turnover",
    "GET",
    "/api/v1/subnets/{netuid}/turnover",
    "/metagraph/subnets/{netuid}/turnover.json",
    "Fetch validator-set & registration turnover (churn) for one subnet between a window's start and end snapshots — validators entered/exited + retention, UID deregistrations, and a 0-100 stability score (computed live from the neuron_daily D1 rollup).",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-metagraph",
    "GET",
    "/api/v1/subnets/{netuid}/metagraph",
    "/metagraph/subnets/{netuid}/metagraph.json",
    "Fetch the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) for one subnet, computed live from the neurons D1 tier. Add ?validator_permit=true for validators only.",
    "short",
    ["subnets", "analytics"],
    [{ name: "validator_permit", schema: { type: "string", enum: ["true"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-neuron",
    "GET",
    "/api/v1/subnets/{netuid}/neurons/{uid}",
    "/metagraph/subnets/{netuid}/neurons/{uid}.json",
    "Fetch a single neuron's metagraph state by UID, computed live from the neurons D1 tier.",
    "short",
    ["subnets", "analytics"],
    [],
    [
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
      { name: "uid", schema: { type: "integer", minimum: 0 } },
    ],
  ),
  route(
    "subnet-validators",
    "GET",
    "/api/v1/subnets/{netuid}/validators",
    "/metagraph/subnets/{netuid}/validators.json",
    "Fetch the validators (validator_permit) of one subnet ranked by stake, computed live from the neurons D1 tier.",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-events",
    "GET",
    "/api/v1/subnets/{netuid}/events",
    "/metagraph/subnets/{netuid}/events.json",
    "Fetch the first-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers), newest first, from the account_events D1 tier filtered by netuid. Optional ?kind= filter; ?limit (<=1000) / ?offset.",
    "short",
    ["subnets", "analytics"],
    [
      { name: "kind", schema: { type: "string" } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-neuron-history",
    "GET",
    "/api/v1/subnets/{netuid}/neurons/{uid}/history",
    "/metagraph/subnets/{netuid}/neurons/{uid}/history.json",
    "Fetch a UID's per-day metagraph history (stake, trust, consensus, incentive, dividends, emission, rank over time), computed live from the neuron_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
      { name: "uid", schema: { type: "integer", minimum: 0 } },
    ],
  ),
  route(
    "subnet-history",
    "GET",
    "/api/v1/subnets/{netuid}/history",
    "/metagraph/subnets/{netuid}/history.json",
    "Fetch a subnet's per-day aggregate history (neuron/validator counts + stake/emission totals) for sparklines, computed live from the neuron_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "account-summary",
    "GET",
    "/api/v1/accounts/{ss58}",
    "/metagraph/accounts/{ss58}.json",
    "Fetch a cross-subnet activity summary for one account (hotkey or coldkey): chain-event aggregates joined to its current subnet registrations + stake. Computed live from the account_events + neurons D1 tiers.",
    "short",
    ["accounts", "analytics"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-events",
    "GET",
    "/api/v1/accounts/{ss58}/events",
    "/metagraph/accounts/{ss58}/events.json",
    "Fetch the paginated first-party chain-event history for one account (hotkey or coldkey), newest first. Optional ?kind= filter; ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging (#1851).",
    "short",
    ["accounts", "analytics"],
    [
      { name: "kind", schema: { type: "string" } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-history",
    "GET",
    "/api/v1/accounts/{ss58}/history",
    "/metagraph/accounts/{ss58}/history.json",
    "Fetch the durable per-day activity series for one account, newest day first, from the hotkey-keyed account_events_daily rollup (#1854). An ss58 with no hotkey activity returns zero days, since the rollup is hotkey-attributed (unlike /events, which matches the hotkey or coldkey). ?netuid filters to one subnet; ?from / ?to are YYYY-MM-DD bounds; ?limit (<=1000) / ?offset.",
    "short",
    ["accounts", "analytics"],
    [
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "string", format: "date" } },
      { name: "to", schema: { type: "string", format: "date" } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-extrinsics",
    "GET",
    "/api/v1/accounts/{ss58}/extrinsics",
    "/metagraph/accounts/{ss58}/extrinsics.json",
    "Fetch the extrinsics this account signed (matched by signer), newest first, computed live from the extrinsics D1 tier. ?limit (<=1000) / ?offset.",
    "short",
    ["accounts", "analytics"],
    [
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-transfers",
    "GET",
    "/api/v1/accounts/{ss58}/transfers",
    "/metagraph/accounts/{ss58}/transfers.json",
    "Fetch the native-TAO Balances.Transfer feed for one account, newest first, computed live from the account_events D1 tier. ?direction=all|sent|received; ?limit (<=1000) / ?offset.",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "direction",
        schema: { type: "string", enum: ["all", "sent", "received"] },
      },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-counterparties",
    "GET",
    "/api/v1/accounts/{ss58}/counterparties",
    "/metagraph/accounts/{ss58}/counterparties.json",
    "Fetch the per-counterparty fund-flow rollup for one account — or, with ?counterparty=<ss58>, pair-level native-TAO transfer evidence for one relationship — computed live from the account_events D1 tier. ?limit (<=100).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "counterparty",
        schema: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{47,48}$" },
      },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-subnets",
    "GET",
    "/api/v1/accounts/{ss58}/subnets",
    "/metagraph/accounts/{ss58}/subnets.json",
    "Fetch the subnets where an account's hotkey is currently registered (its cross-subnet footprint), computed live from the neurons D1 tier.",
    "short",
    ["accounts", "subnets"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-balance",
    "GET",
    "/api/v1/accounts/{ss58}/balance",
    "/metagraph/accounts/{ss58}/balance.json",
    "Fetch the live TAO balance (free + reserved, in TAO) for one account, queried from the finney RPC at request time with 60s KV cache. Returns 400 on invalid ss58; balance_tao is null on RPC failure (200, consistent with blocks/extrinsics null-on-miss).",
    "short",
    ["accounts"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "blocks-feed",
    "GET",
    "/api/v1/blocks",
    "/metagraph/blocks.json",
    "Fetch the recent-block feed (newest first) for the block explorer; ?limit (<=100) / ?offset, or ?cursor= for stable keyset paging under head-of-chain inserts (#1851). A conjunctive (AND-ed) filter set (#1991) narrows the feed: ?author=<ss58>, ?spec_version=<n>, ?from / ?to (observed_at epoch-ms), ?block_start / ?block_end (height range), ?min_extrinsics / ?min_events (non-empty blocks). Computed live from the first-party blocks D1 tier (#1345).",
    "short",
    ["blocks", "analytics"],
    [
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
      { name: "author", schema: { type: "string" } },
      { name: "spec_version", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "integer", minimum: 0 } },
      { name: "to", schema: { type: "integer", minimum: 0 } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "min_extrinsics", schema: { type: "integer", minimum: 0 } },
      { name: "min_events", schema: { type: "integer", minimum: 0 } },
    ],
    [],
  ),
  route(
    "block-detail",
    "GET",
    "/api/v1/blocks/{ref}",
    "/metagraph/blocks/{ref}.json",
    "Fetch per-block detail by numeric block_number or 0x block_hash. Computed live from the first-party blocks D1 tier (#1345); 200 with block:null when cold/unknown.",
    "short",
    ["blocks", "analytics"],
    [],
    [{ name: "ref", schema: { type: "string" } }],
  ),
  route(
    "block-extrinsics",
    "GET",
    "/api/v1/blocks/{ref}/extrinsics",
    "/metagraph/blocks/{ref}/extrinsics.json",
    "Fetch the extrinsics in one block (by numeric block_number or 0x block_hash), in natural order; ?limit (<=100) / ?offset. Computed live from the first-party extrinsics D1 tier (#1845); 200 with extrinsics:[] when cold/unknown.",
    "short",
    ["blocks", "analytics"],
    [
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "ref", schema: { type: "string" } }],
  ),
  route(
    "block-events",
    "GET",
    "/api/v1/blocks/{ref}/events",
    "/metagraph/blocks/{ref}/events.json",
    "Fetch the decoded chain events in one block (by numeric block_number or 0x block_hash), in natural order; ?limit (<=1000) / ?offset. Computed live from the first-party account_events D1 tier filtered by block_number (#1852); 200 with events:[] when cold/unknown.",
    "short",
    ["blocks", "analytics"],
    [
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "ref", schema: { type: "string" } }],
  ),
  route(
    "chain-events-feed",
    "GET",
    "/api/v1/chain-events",
    "/metagraph/chain-events.json",
    "Fetch the recent all-events feed (newest first) from the Postgres-backed all-events tier (ADR 0013) — every raw pallet.method event, distinct from the curated account-attributed stream. ?pallet / ?method narrow by event id (1-64 ASCII identifier chars; ?method requires ?pallet unless ?block is set); ?block (+ optional ?extrinsic) scopes to one block or extrinsic; ?before is a block_number keyset cursor (exclusive); ?limit caps the page (<=200, default 50). Served live (no static file); empty (count:0, events:[]) before the all-events backfill runs.",
    "short",
    ["chain", "analytics"],
    [
      { name: "pallet", schema: { type: "string", maxLength: 64 } },
      { name: "method", schema: { type: "string", maxLength: 64 } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "extrinsic", schema: { type: "integer", minimum: 0 } },
      { name: "before", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } },
    ],
    [],
  ),
  route(
    "chain-events-stats",
    "GET",
    "/api/v1/chain-events/stats",
    "/metagraph/chain-events/stats.json",
    "Fetch the chain-activity aggregate — the pallet.method event distribution over the most recent N blocks — from the Postgres-backed all-events tier (ADR 0013). ?blocks sets the window (default 1000, capped 5000); activity is ordered by count descending (top 100). Backs the get_chain_activity MCP tool. Served live (no static file); empty (groups:0, activity:[]) before the all-events backfill runs.",
    "short",
    ["chain", "analytics"],
    [
      {
        name: "blocks",
        schema: { type: "integer", minimum: 1, maximum: 5000 },
      },
    ],
    [],
  ),
  route(
    "block-chain-events",
    "GET",
    "/api/v1/blocks/{ref}/chain-events",
    "/metagraph/blocks/{ref}/chain-events.json",
    "Fetch every raw pallet-level event in one block (by numeric block_number; event_index ascending) from the Postgres-backed all-events tier (ADR 0013). Distinct from /api/v1/blocks/{ref}/events (the curated account-attributed D1 stream). Served live (no static file); empty (count:0, events:[]) when the block is unknown or before the all-events backfill runs.",
    "short",
    ["blocks", "chain", "analytics"],
    [],
    [{ name: "ref", schema: { type: "string" } }],
  ),
  route(
    "extrinsics-feed",
    "GET",
    "/api/v1/extrinsics",
    "/metagraph/extrinsics.json",
    "Fetch the recent-extrinsic feed (newest first) for the block explorer; ?limit (<=100) / ?offset (or ?cursor= for stable keyset paging, #1851) and a conjunctive filter set (#1846): ?block=<n>, ?signer=, ?call_module=, ?call_function=, ?success=true|false, ?block_start/?block_end (block range), ?from/?to (observed_at epoch-ms range). Computed live from the first-party extrinsics D1 tier (#1345).",
    "short",
    ["extrinsics", "analytics"],
    [
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "signer", schema: { type: "string" } },
      { name: "call_module", schema: { type: "string" } },
      { name: "call_function", schema: { type: "string" } },
      { name: "success", schema: { type: "string", enum: ["true", "false"] } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "integer", minimum: 0 } },
      { name: "to", schema: { type: "integer", minimum: 0 } },
    ],
    [],
  ),
  route(
    "extrinsic-detail",
    "GET",
    "/api/v1/extrinsics/{hash}",
    "/metagraph/extrinsics/{hash}.json",
    "Fetch per-extrinsic detail by 0x extrinsic_hash OR the composite <block_number>-<extrinsic_index> id (the guaranteed-present identifier, since the hash is best-effort/nullable). Computed live from the first-party extrinsics D1 tier (#1345/#1848); 200 with extrinsic:null when cold/unknown/malformed.",
    "short",
    ["extrinsics", "analytics"],
    [],
    [{ name: "hash", schema: { type: "string" } }],
  ),
  route(
    "chain-activity",
    "GET",
    "/api/v1/chain/activity",
    "/metagraph/chain/activity.json",
    "Fetch daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d or 30d window, newest day first. Computed live from the first-party chain D1 tiers (#1987); schema-stable day_count:0/days:[] when the store is cold.",
    "short",
    ["chain", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [],
  ),
  route(
    "chain-calls",
    "GET",
    "/api/v1/chain/calls",
    "/metagraph/chain/calls.json",
    "Fetch the extrinsic call-mix breakdown (count + share per call_module, or call_module/call_function with group_by=module_function) over a 7d or 30d window, ordered by count. Computed live from the first-party extrinsics D1 tier (#1989); schema-stable call_count:0/calls:[] when cold.",
    "short",
    ["chain", "analytics"],
    [
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      {
        name: "group_by",
        schema: { type: "string", enum: ["module", "module_function"] },
      },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ],
    [],
  ),
  route(
    "chain-signers",
    "GET",
    "/api/v1/chain/signers",
    "/metagraph/chain/signers.json",
    "Fetch the windowed most-active-account leaderboard (signers ranked by extrinsic count, with total fees/tips + newest signed block) over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. Computed live from the first-party extrinsics D1 tier (#1990); schema-stable signer_count:0/signers:[] when cold.",
    "short",
    ["chain", "analytics"],
    [
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "call_module", schema: { type: "string", maxLength: 100 } },
    ],
    [],
  ),
  route(
    "chain-fees",
    "GET",
    "/api/v1/chain/fees",
    "/metagraph/chain/fees.json",
    "Fetch fee/tip market analytics — a per-UTC-day fee series (totals + averages) plus a windowed top-fee-payer list — over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. Computed live from the first-party extrinsics D1 tier (#1988); schema-stable day_count:0 + empty lists when cold.",
    "short",
    ["chain", "analytics"],
    [
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "call_module", schema: { type: "string", maxLength: 100 } },
    ],
    [],
  ),
  route(
    "subnet-uptime",
    "GET",
    "/api/v1/subnets/{netuid}/uptime",
    "/metagraph/subnets/{netuid}/uptime.json",
    "Fetch long-term daily uptime history per operational surface for one subnet over a 90d or 1y window (computed live from the surface_uptime_daily D1 rollup).",
    "short",
    ["health", "subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["90d", "1y"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "registry-leaderboards",
    "GET",
    "/api/v1/registry/leaderboards",
    "/metagraph/registry/leaderboards.json",
    "Fetch registry leaderboards computed live from D1 + registry projections + the economics tier. Operational boards: healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable. Economic opportunity boards (for miners/validators): open-slots, cheapest-registration, highest-emission, validator-headroom. Omit `board` for all boards.",
    "standard",
    ["registry", "analytics", "subnets"],
    [
      {
        name: "board",
        schema: {
          type: "string",
          enum: [
            "healthiest",
            "fastest-rpc",
            "most-complete",
            "most-enriched",
            "fastest-growing",
            "most-reliable",
            "open-slots",
            "cheapest-registration",
            "highest-emission",
            "validator-headroom",
          ],
        },
      },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ],
    [],
  ),
  route(
    "compare",
    "GET",
    "/api/v1/compare",
    "/metagraph/compare.json",
    "Compare several subnets side by side across the registry structure (completeness + surface counts), the live economics tier, and the live per-subnet health rollup — one call, requested order. `netuids` is a required comma-separated list of 1-128 subnet ids; `dimensions` selects a subset of structure,economics,health (default all). Composed live (no static file); for choosing between subnets without N separate detail/economics/health fetches.",
    "standard",
    ["registry", "subnets", "analytics"],
    [
      {
        name: "netuids",
        schema: {
          type: "string",
          maxLength: 767,
          pattern: "^\\d{1,5}(,\\d{1,5}){0,127}$",
        },
      },
      { name: "dimensions", schema: { type: "string" } },
    ],
    [],
  ),
  route(
    "rpc-usage",
    "GET",
    "/api/v1/rpc/usage",
    "/metagraph/rpc/usage.json",
    "Fetch RPC reverse-proxy usage analytics — request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets for heatmaps — over a 7d or 30d window (computed live from D1 telemetry).",
    "short",
    ["rpc", "analytics", "operations"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [],
  ),
  route(
    "freshness",
    "GET",
    "/api/v1/freshness",
    "/metagraph/freshness.json",
    "Fetch freshness and staleness state.",
    "short",
    ["operations"],
  ),
  route(
    "source-health",
    "GET",
    "/api/v1/source-health",
    "/metagraph/source-health.json",
    "Fetch upstream source health.",
    "short",
    ["operations"],
  ),
  route(
    "evidence",
    "GET",
    "/api/v1/evidence",
    "/metagraph/evidence-ledger.json",
    "Fetch public evidence ledger.",
    "standard",
    ["evidence"],
    listQuery("claims"),
  ),
  route(
    "subnet-evidence",
    "GET",
    "/api/v1/subnets/{netuid}/evidence",
    "/metagraph/evidence/{netuid}.json",
    "Fetch public evidence ledger claims for one subnet.",
    "standard",
    ["evidence", "subnets"],
    listQuery("claims"),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "changelog",
    "GET",
    "/api/v1/changelog",
    "/metagraph/changelog.json",
    "Fetch latest generated change summary.",
    "short",
    ["operations"],
  ),
  route(
    "source-snapshots",
    "GET",
    "/api/v1/source-snapshots",
    "/metagraph/source-snapshots.json",
    "Fetch source input hashes and counts.",
    "standard",
    ["operations"],
    listQuery("sources"),
  ),
  route(
    "rpc-endpoints",
    "GET",
    "/api/v1/rpc/endpoints",
    "/metagraph/rpc-endpoints.json",
    "Fetch Bittensor RPC endpoint status.",
    "short",
    ["rpc"],
    listQuery("endpoints"),
  ),
  route(
    "rpc-pools",
    "GET",
    "/api/v1/rpc/pools",
    "/metagraph/rpc/pools.json",
    "Fetch endpoint pool scores.",
    "short",
    ["rpc"],
  ),
  route(
    "endpoint-pools",
    "GET",
    "/api/v1/endpoint-pools",
    "/metagraph/endpoint-pools.json",
    "Fetch generalized endpoint pool scores.",
    "short",
    ["endpoints"],
    listQuery("endpoint-pools"),
  ),
  route(
    "endpoint-incidents",
    "GET",
    "/api/v1/endpoint-incidents",
    "/metagraph/endpoint-incidents.json",
    "Fetch probe-derived endpoint incidents.",
    "short",
    ["endpoints", "health"],
    listQuery("endpoint-incidents"),
  ),
  route(
    "incidents",
    "GET",
    "/api/v1/incidents",
    "/metagraph/incidents.json",
    "Fetch recent cross-subnet downtime incidents reconstructed from probe history over a 7d or 30d window (computed live from D1). Pair with /api/v1/health for the overall status summary.",
    "short",
    ["health", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
  ),
  route(
    "schemas",
    "GET",
    "/api/v1/schemas",
    "/metagraph/schemas/index.json",
    "Fetch captured schema index.",
    "standard",
    ["schemas"],
  ),
  route(
    "adapter",
    "GET",
    "/api/v1/adapters/{slug}",
    "/metagraph/adapters/{slug}.json",
    "Fetch adapter-backed public metrics.",
    "short",
    ["adapters"],
    [],
    [{ name: "slug", schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
  ),
  route(
    "search",
    "GET",
    "/api/v1/search",
    "/metagraph/search.json",
    "Fetch compact search index.",
    "standard",
    ["search"],
    listQuery("documents"),
  ),
  route(
    "search-index",
    "GET",
    "/api/v1/search-index",
    "/metagraph/search-index.json",
    "Fetch the slim search index — the same documents as /search without the per-document token blobs, for fast browser typeahead and listing.",
    "standard",
    ["search"],
    listQuery("documents"),
  ),
  route(
    "contracts",
    "GET",
    "/api/v1/contracts",
    "/metagraph/contracts.json",
    "Fetch artifact contract metadata.",
    "standard",
    ["contracts"],
  ),
  route(
    "openapi",
    "GET",
    "/api/v1/openapi.json",
    "/metagraph/openapi.json",
    "Fetch OpenAPI 3.1 contract.",
    "standard",
    ["contracts"],
  ),
  route(
    "build",
    "GET",
    "/api/v1/build",
    "/metagraph/build-summary.json",
    "Fetch generated build summary.",
    "short",
    ["operations"],
  ),
];

export function buildContractsArtifact(generatedAt) {
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    generated_at: generatedAt,
    name: "Metagraphed public backend artifact contract",
    primary_domain: PRIMARY_DOMAIN,
    status_domain: null,
    base_path: ARTIFACT_BASE_PATH,
    openapi_url: `${ARTIFACT_BASE_PATH}/openapi.json`,
    type_definitions_url: TYPE_DEFINITIONS_PATH,
    notes: [
      "Native Bittensor chain data is canonical for active subnet existence.",
      "Curated overlays are canonical for public interface metadata.",
      "Candidate surfaces are discovery records only and are not published as verified registry surfaces.",
      "Health and schema artifacts are operational observations, not protocol authority.",
    ],
    artifacts: PUBLIC_ARTIFACTS.map((entry) => ({
      id: entry.id,
      path: entry.path,
      description: entry.description,
      content_type: artifactContentType(entry.path),
      schema_ref: entry.schema_ref
        ? `#/components/schemas/${entry.schema_ref}`
        : null,
      contract_version: CONTRACT_VERSION,
      storage_tier: entry.storage_tier,
    })),
  };
}

export function buildApiIndexArtifact(generatedAt, contractsArtifact) {
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    generated_at: generatedAt,
    primary_domain: PRIMARY_DOMAIN,
    base_path: API_BASE_PATH,
    openapi_url: `${API_BASE_PATH}/openapi.json`,
    type_definitions_url: TYPE_DEFINITIONS_PATH,
    response_envelope: {
      schema_version: SCHEMA_VERSION,
      fields: ["ok", "data", "meta", "error"],
      success_schema_ref: "#/components/schemas/SuccessEnvelope",
      error_schema_ref: "#/components/schemas/ErrorEnvelope",
      notes:
        "Worker API routes wrap canonical /metagraph artifacts without changing artifact truth.",
    },
    routes: API_ROUTES.map((entry) => ({
      artifact_path: entry.artifact_path,
      cache: entry.cache,
      description: entry.description,
      id: entry.id,
      method: entry.method,
      path: entry.path,
      public: true,
      query_collection: entry.query_collection,
      query_filter_names: entry.query_filter_names,
      query_parameters: entry.query_parameters || [],
    })),
    artifact_contracts: contractsArtifact.artifacts.map((entry) => ({
      id: entry.id,
      path: entry.path,
      contract_version: entry.contract_version,
      schema_ref: entry.schema_ref,
      storage_tier: entry.storage_tier,
    })),
  };
}

export function buildOpenApiArtifact(generatedAt, componentSchemas) {
  if (!componentSchemas) {
    throw new Error(
      "buildOpenApiArtifact requires canonical component schemas from schemas/api-components.schema.json",
    );
  }

  const paths = {};
  for (const entry of API_ROUTES) {
    const openApiPath = entry.path;
    const responseSchema = {
      allOf: [
        { $ref: "#/components/schemas/SuccessEnvelope" },
        {
          type: "object",
          properties: {
            data: {
              $ref: `#/components/schemas/${schemaRefForArtifactPath(entry.artifact_path)}`,
            },
          },
        },
      ],
    };
    paths[openApiPath] = {
      ...(paths[openApiPath] || {}),
      [entry.method.toLowerCase()]: {
        operationId: entry.id.replace(
          /[^a-z0-9]+([a-z0-9])/gi,
          (_, character) => character.toUpperCase(),
        ),
        summary: entry.description,
        tags: entry.tags,
        parameters: [
          ...entry.path_parameters.map((parameter) => ({
            ...parameter,
            in: "path",
            required: true,
          })),
          ...entry.query_parameters.map((parameter) => ({
            ...parameter,
            in: "query",
            required: false,
          })),
        ],
        responses: {
          200: {
            description:
              "Canonical artifact wrapped in the Metagraphed API envelope.",
            headers: apiResponseHeaders(),
            content: {
              "application/json": {
                schema: responseSchema,
                // Deterministic worked example (schema-valid, no live data) so
                // Swagger UI + agents see a concrete response shape. Generated
                // from the schema; enforced by validate-openapi-examples.
                example: sampleFromSchema(responseSchema, componentSchemas),
              },
            },
          },
          304: {
            description: "ETag matched and the cached response is still valid.",
          },
          400: {
            description: "Query parameters were malformed or unsupported.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorEnvelope" },
              },
            },
          },
          404: {
            description: "Artifact or API route was not found.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorEnvelope" },
              },
            },
          },
          405: {
            description: "HTTP method is not supported.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorEnvelope" },
              },
            },
          },
          500: {
            description: "Unexpected backend error.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorEnvelope" },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Metagraphed API",
      version: CONTRACT_VERSION,
      description:
        "Public, read-only API over canonical Metagraphed registry artifacts for " +
        "Bittensor subnet interfaces. **No authentication** — every operation is an " +
        "unauthenticated GET. Responses use a stable JSON envelope " +
        "`{ ok, schema_version, data, meta }` (errors: `{ ok: false, error }`) and " +
        "carry `ETag` + `Cache-Control` for conditional caching. Rate-limited per " +
        "client. Multi-network: insert a `/{network}/` segment after `/api/v1/` " +
        "(mainnet is the default — omit it) to read testnet data, e.g. " +
        "`/api/v1/testnet/subnets`. Testnet exposes the subset of routes that have " +
        "data; `/api/v1/lineage` tracks which testnet subnets have graduated.",
    },
    servers: [
      {
        url: `https://${PRIMARY_DOMAIN}`,
        description:
          "Production (mainnet default; insert /testnet/ after /api/v1/ for testnet data)",
      },
    ],
    // The API is intentionally public + unauthenticated; an empty top-level
    // security requirement is the OpenAPI signal that no scheme applies (#743).
    security: [],
    paths,
    components: {
      schemas: {
        ...componentSchemas,
        GeneratedOpenApiMarker: {
          type: "object",
          properties: {
            generated_at: { const: generatedAt },
          },
        },
      },
      headers: {
        ETag: { schema: { type: "string" } },
        CacheControl: { schema: { type: "string" } },
        ContractVersion: { schema: { type: "string" } },
      },
    },
    "x-metagraphed": {
      schema_version: SCHEMA_VERSION,
      contract_version: CONTRACT_VERSION,
      generated_at: generatedAt,
      canonical_artifact_base_path: ARTIFACT_BASE_PATH,
      notes:
        "OpenAPI describes Worker response envelopes and canonical artifact payloads. Raw /metagraph JSON remains the reviewed source contract.",
    },
  };
}

export function artifactPathFromTemplate(template, params = {}) {
  return template
    .replace("{netuid}", String(params.netuid ?? ""))
    .replace("{uid}", String(params.uid ?? ""))
    .replace("{ss58}", String(params.ss58 ?? ""))
    .replace("{slug}", String(params.slug ?? ""))
    .replace("{date}", String(params.date ?? ""))
    .replace("{surface_id}", String(params.surface_id ?? ""))
    .replace("{ref}", String(params.ref ?? ""))
    .replace("{hash}", String(params.hash ?? ""));
}

export function compileRoutePattern(pathTemplate) {
  const tokenized = pathTemplate
    .replace(/\{netuid\}/g, "__METAGRAPH_NETUID__")
    .replace(/\{uid\}/g, "__METAGRAPH_UID__")
    .replace(/\{ss58\}/g, "__METAGRAPH_SS58__")
    .replace(/\{slug\}/g, "__METAGRAPH_SLUG__")
    .replace(/\{date\}/g, "__METAGRAPH_DATE__")
    .replace(/\{surface_id\}/g, "__METAGRAPH_SURFACE_ID__")
    // Block-explorer {ref} (#1345): a numeric block_number OR a 0x block_hash.
    .replace(/\{ref\}/g, "__METAGRAPH_REF__")
    // Block-explorer {hash} (#1345/#1848): a 0x extrinsic_hash OR
    // composite <block_number>-<extrinsic_index> ref.
    .replace(/\{hash\}/g, "__METAGRAPH_HASH__");
  const pattern = tokenized
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/__METAGRAPH_NETUID__/g, "(?<netuid>\\d+)")
    .replace(/__METAGRAPH_UID__/g, "(?<uid>\\d+)")
    .replace(/__METAGRAPH_SS58__/g, "(?<ss58>[1-9A-HJ-NP-Za-km-z]{47,48})")
    .replace(/__METAGRAPH_SLUG__/g, "(?<slug>[a-z0-9-]+)")
    .replace(/__METAGRAPH_DATE__/g, "(?<date>\\d{4}-\\d{2}-\\d{2})")
    .replace(/__METAGRAPH_SURFACE_ID__/g, "(?<surface_id>[a-z0-9-]+)")
    .replace(/__METAGRAPH_REF__/g, "(?<ref>\\d+|0x[0-9a-fA-F]{64})")
    .replace(/__METAGRAPH_HASH__/g, "(?<hash>0x[0-9a-fA-F]{64}|\\d+-\\d+)");
  return new RegExp(`^${pattern}\\/?$`);
}

function artifact(id, pathValue, description, schemaRef) {
  return {
    id,
    path: pathValue,
    description,
    schema_ref: schemaRef,
    storage_tier: artifactStorageTierForPath(pathValue),
  };
}

function artifactContentType(pathValue) {
  if (pathValue.endsWith(".d.ts")) {
    return "text/plain; charset=utf-8";
  }
  return "application/json";
}

function route(
  id,
  method,
  pathValue,
  artifactPath,
  description,
  cache,
  tags,
  queryParameters = [],
  pathParameters = [],
) {
  const querySpec = normalizeQueryParameters(queryParameters);
  return {
    id,
    method,
    path: pathValue,
    artifact_path: artifactPath,
    description,
    cache,
    tags,
    query_collection: querySpec.collection,
    query_filter_names: querySpec.filterNames,
    query_parameters: querySpec.parameters,
    path_parameters: pathParameters,
  };
}

function queryCollection(dataKey, options = {}) {
  return {
    data_key: dataKey,
    filters: options.filters || {},
    // CSV membership filters: param name -> the row field it matches against.
    // e.g. { netuids: "netuid" } makes `?netuids=1,7,74` return those rows.
    csv_filters: options.csvFilters || {},
    // Array-membership filters: param name -> the row array field(s) whose
    // union is tested for the value. e.g. { domain: ["categories",
    // "derived_categories"] } makes `?domain=inference` match either array.
    array_filters: options.arrayFilters || {},
    // Numeric range filters: each field F here accepts `min_F` and `max_F` query
    // params (inclusive bounds on the numeric row[F]). Generalizes the one-off
    // hand-rolled min_readiness the MCP list_subnets tool did.
    range_filters: options.rangeFilters || [],
    search_keys: options.search || [],
    sort_fields: options.sort || [],
  };
}

function enumSchema(values) {
  return { type: "string", enum: values };
}

function listQuery(collection, options = {}) {
  const config = API_QUERY_COLLECTIONS[collection];
  /* v8 ignore next 3 -- developer config invariant validated by OpenAPI/schema checks */
  if (!config) {
    throw new Error(`Unknown API query collection: ${collection}`);
  }

  const excluded = new Set(options.exclude || []);
  const filterParameters = Object.entries(config.filters)
    .map(([name, schema]) => ({ name, schema }))
    .filter((parameter) => !excluded.has(parameter.name));
  const searchParameters =
    config.search_keys.length > 0 ? [{ name: "q", schema: textSchema }] : [];
  // Each numeric range field F → a `min_F` + `max_F` inclusive-bound parameter.
  const rangeParameters = config.range_filters.flatMap((field) => [
    { name: `min_${field}`, schema: { type: "number" } },
    { name: `max_${field}`, schema: { type: "number" } },
  ]);
  // Each equality filter F → a `not_F` exclusion parameter accepting the same
  // values: `?not_F=v` returns the complement of `?F=v`.
  const negationParameters = filterParameters.map((parameter) => ({
    name: `not_${parameter.name}`,
    schema: parameter.schema,
  }));
  return {
    collection,
    filterNames: filterParameters.map((parameter) => parameter.name),
    parameters: [
      ...filterParameters,
      ...searchParameters,
      ...rangeParameters,
      ...negationParameters,
      {
        name: "fields",
        schema: fieldListSchema,
      },
      {
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: 1000 },
      },
      {
        name: "cursor",
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "sort",
        description:
          "Field to sort by — the bare field name only (e.g. `sort=total_stake_tao`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.",
        schema: { type: "string", enum: config.sort_fields },
      },
      {
        name: "order",
        description:
          "Sort direction for `sort`: `asc` or `desc` (default `desc`). This is a separate parameter from `sort` — e.g. `?sort=emission_share&order=desc`.",
        schema: { enum: ["asc", "desc"] },
      },
    ],
  };
}

function normalizeQueryParameters(queryParameters) {
  if (Array.isArray(queryParameters)) {
    return { collection: null, filterNames: [], parameters: queryParameters };
  }
  return {
    collection: queryParameters.collection || null,
    filterNames: queryParameters.filterNames || [],
    parameters: queryParameters.parameters || [],
  };
}

function schemaRefForArtifactPath(artifactPath) {
  const contract = PUBLIC_ARTIFACTS.find((entry) =>
    pathTemplatesMatch(entry.path, artifactPath),
  );
  /* v8 ignore next 5 -- developer config invariant validated by OpenAPI/schema checks */
  if (!contract) {
    throw new Error(
      `No public artifact contract maps API artifact ${artifactPath}`,
    );
  }
  /* v8 ignore next 3 -- developer config invariant validated by OpenAPI/schema checks */
  if (!contract.schema_ref) {
    throw new Error(`Public artifact ${contract.id} has no JSON schema ref`);
  }
  return contract.schema_ref;
}

function pathTemplatesMatch(contractPath, artifactPath) {
  if (contractPath === artifactPath) {
    return true;
  }
  const contractPattern = contractPath
    .replace("{netuid}", ":netuid")
    .replace("{slug}", ":slug")
    .replace("{date}", ":date")
    .replace("{surface_id}", ":surface_id");
  const artifactPattern = artifactPath
    .replace("{netuid}", ":netuid")
    .replace("{slug}", ":slug")
    .replace("{date}", ":date")
    .replace("{surface_id}", ":surface_id");
  return contractPattern === artifactPattern;
}

function apiResponseHeaders() {
  return {
    etag: { $ref: "#/components/headers/ETag" },
    "cache-control": { $ref: "#/components/headers/CacheControl" },
    "x-metagraph-contract-version": {
      $ref: "#/components/headers/ContractVersion",
    },
  };
}
