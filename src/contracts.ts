import { artifactStorageTierForPath } from "./artifact-storage.ts";
import { ROUTE_CSV_EXAMPLES } from "./csv-route-examples.ts";
import { DOMAIN_TAGS } from "./domain-tags.ts";
import { sampleFromSchema } from "./openapi-sample.ts";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_MAX,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
  VALIDATOR_ECONOMICS_LIMIT_DEFAULT,
  VALIDATOR_ECONOMICS_LIMIT_MAX,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
} from "./route-limits.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface QueryParameterSpec {
  name: string;
  description?: string;
  schema: unknown;
}

interface QueryCollectionSpec {
  collection?: string | null;
  csvResponse?: boolean;
  filterNames?: string[];
  parameters: QueryParameterSpec[];
}

type QueryParametersInput = QueryParameterSpec[] | QueryCollectionSpec;

interface RetirementInfo {
  code: string;
  http_status: number;
  message: string;
}

export const CONTRACT_VERSION = "2026-07-03.2";
export const SCHEMA_VERSION = 1;
// The API + artifacts are served from the api subdomain; the bare apex
// (metagraph.sh) is the metagraphed-ui UI. PRIMARY_DOMAIN drives the OpenAPI
// server URL and the consumer metadata in contracts.json / api-index.json.
export const PRIMARY_DOMAIN = "api.metagraph.sh";

/**
 * This repository's canonical URL, as published to consumers.
 *
 * One constant because it is published twice -- by the worker-computed MCP
 * server card and by the MCP Registry listing (server.json) -- and two
 * published descriptions of the same server disagreeing is the defect class
 * ADR 0027 exists about. scripts/validate-mcp.ts asserts the listing against
 * this rather than against a second literal.
 */
export const REPOSITORY_URL = "https://github.com/JSONbored/metagraphed";
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
// Free-text query params carry an explicit maxLength so an arbitrarily long
// value can't drive unbounded per-row scan work in searchRows / filter matching
// (#5544) — every other validated param already bounds its input. `q` is
// free-typed search prose (a generous 200-char ceiling); the exact-ish filters
// (provider, id, review_state, reason_codes) are structured tokens, bounded
// tighter at 100, in line with the existing pallet/method/call_module limits.
// SEARCH_TEXT_MAX_LENGTH is exported because the generic maxLength check in
// validateListQuery only iterates config.filters — `q` is a search param, not a
// filter, so workers/list-query.ts enforces its bound from this single source.
export const SEARCH_TEXT_MAX_LENGTH = 200;
const FILTER_TEXT_MAX_LENGTH = 100;
const searchTextSchema = { type: "string", maxLength: SEARCH_TEXT_MAX_LENGTH };
const filterTextSchema = { type: "string", maxLength: FILTER_TEXT_MAX_LENGTH };
const fieldListSchema = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$",
};

export const API_QUERY_COLLECTIONS = {
  candidates: queryCollection("candidates", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: filterTextSchema,
      state: enumSchema(QUERY_ENUMS.candidateState),
      // Same exact-match id filter as pools / endpoint-pools; confidence enum
      // matches profiles (#6242).
      id: filterTextSchema,
      confidence: enumSchema(["low", "medium", "high"]),
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
      // #6238: curation_level is already a sort target here and a real filter on
      // the sibling gaps collection; expose it as a filter too so callers can
      // narrow, not just order, by it. Same shared enum gaps uses.
      curation_level: enumSchema(QUERY_ENUMS.curationLevel),
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
      provider: filterTextSchema,
      // Same exact-match id filter as pools / endpoint-pools (#6242).
      id: filterTextSchema,
      // Server-side because the UI's own "auth required" / "public safe"
      // shortcuts were applying them CLIENT-side over one loaded page. With the
      // default page size of 25 against 3,494 surfaces, ?auth=required rendered
      // at most the auth rows inside the first 25 -- 6 of the 1,184 that match.
      // A filter that silently under-reports by 99% is worse than one that
      // errors, because it looks like it worked.
      auth_required: enumSchema(["true", "false"]),
      public_safe: enumSchema(["true", "false"]),
      rate_limited: enumSchema(["true", "false"]),
    },
    presenceFilters: { rate_limited: "rate_limit_notes" },
    sort: ["id", "kind", "name", "netuid", "provider"],
  }),
  documents: queryCollection("documents", {
    filters: {
      // Document *type* (subnet/surface/provider), distinct from surface
      // *kind* (openapi/website/sdk/...) — do not reuse QUERY_ENUMS.surfaceKind.
      type: enumSchema(["subnet", "surface", "provider"]),
      netuid: integerSchema,
    },
    search: ["title", "subtitle", "slug", "tokens"],
    sort: ["netuid", "slug", "title", "type"],
  }),
  economics: queryCollection("subnets", {
    filters: {
      netuid: integerSchema,
      registration_allowed: enumSchema(["true", "false"]),
    },
    search: ["name", "slug"],
    sort: [
      "alpha_fdv_tao",
      "alpha_market_cap_tao",
      "alpha_price_change_1d",
      "alpha_price_change_1h",
      "alpha_price_change_1m",
      "alpha_price_change_7d",
      "alpha_price_tao",
      "block",
      "emission_share",
      "max_stake_alpha",
      "max_uids",
      "max_validators",
      "miner_count",
      "miner_readiness",
      "name",
      "netuid",
      "open_slots",
      "registration_cost_tao",
      "subnet_volume_tao",
      "total_stake_alpha",
      "validator_count",
    ],
  }),
  endpoints: queryCollection("endpoints", {
    filters: {
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      layer: enumSchema(QUERY_ENUMS.endpointLayer),
      netuid: integerSchema,
      pool_eligible: enumSchema(["true", "false"]),
      provider: filterTextSchema,
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
    rangeFilters: ["latency_ms", "score"],
  }),
  "endpoint-pools": queryCollection("pools", {
    filters: {
      id: filterTextSchema,
      kind: enumSchema(["subtensor-rpc", "subtensor-wss", "archive"]),
    },
    sort: ["eligible_count", "endpoint_count", "id", "kind"],
    rangeFilters: ["eligible_count", "endpoint_count"],
  }),
  // #6570: rpc-pools is the Bittensor-RPC-scoped predecessor of the
  // generalized endpoint-pools collection above — same pools[] row shape,
  // same filter/sort/range surface, distinct artifact (rpc/pools.json).
  "rpc-pools": queryCollection("pools", {
    filters: {
      id: filterTextSchema,
      kind: enumSchema(["subtensor-rpc", "subtensor-wss", "archive"]),
    },
    sort: ["eligible_count", "endpoint_count", "id", "kind"],
    rangeFilters: ["eligible_count", "endpoint_count"],
  }),
  "endpoint-incidents": queryCollection("incidents", {
    filters: {
      netuid: integerSchema,
      kind: enumSchema(QUERY_ENUMS.surfaceKind),
      provider: filterTextSchema,
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
  // Global cross-subnet downtime ledger served by GET /api/v1/incidents (#6571):
  // the per-surface `surfaces` rollup formatGlobalIncidents produces, paginated
  // on top of the route's own `window` scope so callers can page/sort/filter a
  // 30-day list the same way the sibling endpoint-incidents route already does.
  incidents: queryCollection("surfaces", {
    filters: {
      netuid: integerSchema,
    },
    sort: ["downtime_ms", "incident_count", "netuid", "surface_id"],
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
      review_state: filterTextSchema,
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
      missing_kinds: enumSchema(QUERY_ENUMS.surfaceKind),
      review_state: filterTextSchema,
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
      reason_codes: filterTextSchema,
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
      reason_codes: filterTextSchema,
      review_state: filterTextSchema,
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
      reason_codes: filterTextSchema,
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
      provider: filterTextSchema,
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
      id: filterTextSchema,
      kind: enumSchema(["subtensor-rpc", "subtensor-wss", "archive"]),
    },
    sort: ["eligible_count", "endpoint_count", "id", "kind"],
    rangeFilters: ["eligible_count", "endpoint_count"],
  }),
  providers: queryCollection("providers", {
    filters: {
      id: filterTextSchema,
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
      "integration_readiness",
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
    // integration_readiness generalizes the one-off min_readiness the MCP
    // list_subnets tool exposes, so REST can rank/threshold by the same field.
    rangeFilters: [
      "block",
      "candidate_count",
      "integration_readiness",
      "mechanism_count",
      "participant_count",
      "probed_surface_count",
      "surface_count",
      "tempo",
    ],
  }),
};

// Every catalog entry carries a lifecycle status. `live` is the default and the
// overwhelming majority; `retired` means the route still exists but always
// refuses the read, so a consumer must not treat the entry as fetchable (#6358).
// Applied through the artifact() helper so the field cannot be forgotten on a
// new entry, and so the catalog can describe a retirement instead of silently
// dropping the artifact -- which would leave a consumer with a 410 and no
// explanation of where the data went.
export const ARTIFACT_STATUS_LIVE = "live";
export const ARTIFACT_STATUS_RETIRED = "retired";

// The current-state health artifacts (latest/summary/subnets/{netuid}) are
// retired on every network prefix by the live-only policy (#490/#498):
// workers/api.ts answers them with this exact code/status/message before any
// read is attempted, via RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN. Mirrored here
// verbatim so the catalog cannot drift from the runtime. Note this covers only
// those three -- health-history (/metagraph/health/history/{date}.json) is NOT
// matched by that pattern and is still served, so it stays live.
const RETIRED_CURRENT_HEALTH = {
  status: ARTIFACT_STATUS_RETIRED,
  retirement: {
    code: "retired_artifact",
    http_status: 410,
    message:
      "Current-state health artifacts are retired; use the live API health endpoints instead.",
  },
};

// Delivery: a catalog entry is either BACKED BY A FILE (the build writes it to
// public/metagraph or the R2 staging root, and the Worker serves that object) or
// COMPUTED LIVE per request from D1/KV/RPC with no file anywhere. Every
// such entry already said so in prose ("... no static file"), which meant the
// build could not act on it: scripts/validate-schemas.ts restated the same fact
// as its own hand-maintained id list, and a new computed route that nobody
// remembered to add there failed CI with a bare `ENOENT ...
// public/metagraph/<x>.json` naming neither the cause nor the list to edit.
// Applied through the artifact() helper like `status` above so the fact lives
// once, on the entry, where a new route's author is already typing.
const COMPUTED_LIVE = { computed: true };

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
    "Per-subnet validator and economic metrics from the chain: validator/miner counts, total + max stake, registration cost, alpha price, derived alpha market-cap and FDV proxies, price-weighted emission share, and on-chain registration block height. `emission_share` is the STAGE-1 PRICE SHARE of the v440 emission pipeline (alpha_price / sum of alpha_price), NOT the share of TAO a subnet receives: spec 440 separates the two by MinerBurned reweighting, the Hill emission gate, the SubnetEmissionEnabled filter, the alpha injection cap, and the liquidity balancer. See /api/v1/network/parameters for the gate parameters and docs/computed-metrics-methodology.md for the eight-stage decomposition.",
    "EconomicsArtifact",
  ),
  // --- The AI-native layer (ADR 0003), registered by #9092 -----------------
  // Live since the layer shipped and absent from this contract until now, so
  // openapi.json, the generated types, and every typed client were blind to
  // the three endpoints an agent would most want.
  artifact(
    "ask",
    "/metagraph/ai/ask.json",
    "A grounded natural-language answer over the registry, served live at POST /api/v1/ask (no static file -- the response answers one caller's question). Retrieval runs over the embedded surface/subnet corpus; the answer carries inline [n] markers resolved by `citations`, each naming the surface, its netuid/slug, its URL, and the retrieval score, so every claim is traceable to a registered surface rather than to the model. `context_count` is how many retrieved documents were in the context window and `model` names the generator, so an answer stays attributable. Returns 503 ai_unavailable on a deployment with no AI binding.",
    "AskArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "search-semantic",
    "/metagraph/ai/search-semantic.json",
    "Embedding-ranked discovery over the registry, served live at /api/v1/search/semantic (no static file). Matches by MEANING rather than by keyword, so it finds surfaces whose text never contains the query terms -- the complement to /api/v1/search, which is lexical. Each result carries its cosine `score`, what it is (`type`), the subnet (`netuid`/`slug`), a title/subtitle, the URL, and the surface's categories and service kinds. `model` names the embedding model so two runs can be told apart. Returns 503 ai_unavailable on a deployment with no AI binding.",
    "SemanticSearchArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "surface-verify",
    "/metagraph/surfaces/{surface_id}/verify.json",
    "A catalog-resolved liveness probe of ONE registered surface, served live at /api/v1/surfaces/{surface_id}/verify (no static file -- a stored verdict would be a stale one). Deliberately not arbitrary URL fetching: the caller names a surface the registry already knows and the Worker probes the URL it has on file, echoing the resolved identity (`surface_key`, `netuid`, `kind`, `url`, `provider`, `auth_required`) beside the outcome so a client can see exactly what was called on its behalf. `status`/`classification`/`callable` are the verdict, `latency_ms`/`status_code`/`error` the evidence, and `from_cache` says whether this was a fresh probe. 404 surface_not_found when no catalogued surface matches the id.",
    "SurfaceVerifyArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "emission-pipeline",
    "/metagraph/chain/emission-pipeline.json",
    "The v440 emission pipeline decomposed per subnet (#8744), served live at /api/v1/chain/emission-pipeline (no static file): stage 1's price share, MinerBurned, the post-burn weighted share, the post-Hill-gate share, SubnetEmissionEnabled, the final share of block emission actually received, the gate's give-or-take (gate_delta), distance to the bar measured against the WEIGHTED share, and the TAO split -- SubnetTaoInEmission (pool liquidity injection) vs SubnetExcessTao (chain buys), their total, and liquidity_fraction. Plus the network aggregate and the issuance-derived block emission. EVERY SHARE HERE IS RECONSTRUCTED, NOT READ: the chain publishes the inputs, not the decomposition, so each field carries its kind and source in `field_sources`, all values are pinned to `chain_state.block`, and the four pipeline identities are evaluated on the rows being served -- `verification.verified` false means the response is not defensible and should not be used. The TAO channels are point samples at that block; measured across 14 consecutive blocks they move a few rao and liquidity_fraction varies by ~1e-5, so there is no rollup. Returns 503 rather than a body when the capture carries no pinned block.",
    "EmissionPipelineArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "economics-trends",
    "/metagraph/economics/trends.json",
    "Network-wide economics time series (#1307) aggregated per UTC day across all subnets from the daily subnet_snapshots D1 rollup (the same source the per-subnet trajectory reads), served live at /api/v1/economics/trends; pass ?format=csv to download the per-day series as CSV (no static file).",
    "EconomicsTrendsArtifact",
    COMPUTED_LIVE,
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
    "FixtureArtifact",
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
    "Latest surface health snapshot. Retired: read the live API health endpoints instead.",
    "HealthLatestArtifact",
    { ...RETIRED_CURRENT_HEALTH, ...COMPUTED_LIVE },
  ),
  artifact(
    "health-summary",
    "/metagraph/health/summary.json",
    "Global and per-subnet health rollup. Retired: read the live API health endpoints instead.",
    "HealthSummaryArtifact",
    { ...RETIRED_CURRENT_HEALTH, ...COMPUTED_LIVE },
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
    "Per-subnet health payload for metagraph.sh consumers. Retired: read the live API health endpoints instead.",
    "HealthSubnetArtifact",
    { ...RETIRED_CURRENT_HEALTH, ...COMPUTED_LIVE },
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
    COMPUTED_LIVE,
  ),
  artifact(
    "health-trends-bulk",
    "/metagraph/health/trends.json",
    "Compact all-subnet 7d/30d daily uptime + success-only latency trend matrix (mean + healthy-sample count). Served live from D1 at /api/v1/health/trends (no static file).",
    "BulkHealthTrendsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "health-percentiles",
    "/metagraph/health/percentiles/{netuid}.json",
    "Latency percentiles (p50/p95/p99 + avg/min/max) per operational surface for one subnet, computed live from D1 at /api/v1/subnets/{netuid}/health/percentiles (no static file).",
    "HealthPercentilesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "health-incidents",
    "/metagraph/health/incidents/{netuid}.json",
    "SLA (uptime ratio) and reconstructed downtime incidents per operational surface for one subnet, computed live from D1 at /api/v1/subnets/{netuid}/health/incidents (no static file).",
    "HealthIncidentsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-trajectory",
    "/metagraph/subnets/{netuid}/trajectory.json",
    "Week-over-week structural trajectory (completeness + surface/endpoint counts) for one subnet from daily snapshots, served live from D1 at /api/v1/subnets/{netuid}/trajectory; pass ?format=csv to download the per-day series as CSV (no static file).",
    "SubnetTrajectoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-concentration",
    "/metagraph/subnets/{netuid}/concentration.json",
    "Stake & emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for one subnet across three lenses — per-UID, per-entity (coldkeys collapsed to the true control distribution), and validator-only consensus power — served live from the neurons D1 tier at /api/v1/subnets/{netuid}/concentration (no static file).",
    "SubnetConcentrationArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-performance",
    "/metagraph/subnets/{netuid}/performance.json",
    "Reward-distribution & score-spread metrics for one subnet: concentration of the actual rewards (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores — the reward-flow companion to concentration, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/performance (no static file).",
    "SubnetPerformanceArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-idle-stake",
    "/metagraph/subnets/{netuid}/idle-stake.json",
    "Stake delegated to a hotkey currently earning zero dividends for one subnet — dividends are the only stream delegated stake ever receives in dTAO, so a hotkey with no validator permit or a permit whose weight-setting output is currently zero pays every delegator nothing right now — served live from the neurons D1 tier at /api/v1/subnets/{netuid}/idle-stake (no static file).",
    "SubnetIdleStakeArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-performance-history",
    "/metagraph/subnets/{netuid}/performance/history.json",
    "Per-day reward-flow & trust trend (incentive/dividends Gini, Nakamoto coefficient, top-10% share, plus trust/consensus/validator_trust mean & median) over a 7d/30d/90d window for one subnet, served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/performance/history; pass ?format=csv to download the per-day series as CSV (no static file). The reward-flow twin of /concentration/history.",
    "SubnetPerformanceHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-concentration-history",
    "/metagraph/subnets/{netuid}/concentration/history.json",
    "Per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) over a 7d/30d/90d window for one subnet, served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/concentration/history; pass ?format=csv to download the per-day series as CSV (no static file).",
    "SubnetConcentrationHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-turnover",
    "/metagraph/subnets/{netuid}/turnover.json",
    "Validator-set & registration turnover (churn) for one subnet between a window's start and end snapshots — validators entered/exited + Jaccard retention, UID deregistrations, and a 0-100 stability score — served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/turnover (no static file).",
    "SubnetTurnoverArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-weights",
    "/metagraph/subnets/{netuid}/weights.json",
    "Validator weight-setting activity for one subnet over a 7d or 30d window — the distinct weight-setting validators, WeightsSet event count, and average updates per validator — served live from the account_events WeightsSet stream at /api/v1/subnets/{netuid}/weights (no static file). The per-subnet drill-in of /api/v1/chain/weights.",
    "SubnetWeightsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-weight-setters",
    "/metagraph/subnets/{netuid}/weights/setters.json",
    "Per-subnet weight-setter leaderboard over a 7d or 30d window — the individual validators behind /weights, each with its WeightsSet count, share of the subnet total, and first/last set time, ranked by activity — served live from the account_events WeightsSet stream at /api/v1/subnets/{netuid}/weights/setters (no static file). The setter-level drill-in of /api/v1/subnets/{netuid}/weights.",
    "SubnetWeightSettersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-serving",
    "/metagraph/subnets/{netuid}/serving.json",
    "Axon-serving announcement activity for one subnet over a 7d or 30d window — the distinct servers (hotkeys), AxonServed event count, and average announcements per server — served live from the account_events AxonServed stream at /api/v1/subnets/{netuid}/serving (no static file). The per-subnet drill-in of /api/v1/chain/serving.",
    "SubnetServingArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-prometheus",
    "/metagraph/subnets/{netuid}/prometheus.json",
    "Prometheus-endpoint serving activity for one subnet over a 7d or 30d window — the distinct exporters (hotkeys), PrometheusServed event count, and average announcements per exporter — read from the account_events PrometheusServed stream at /api/v1/subnets/{netuid}/prometheus (no static file) — that curation carries 0 of the 18,041 PrometheusServed events the chain emitted, so an empty card is marked `degraded` rather than published as a measured zero. The per-subnet drill-in of /api/v1/chain/prometheus and the telemetry-endpoint sibling of /api/v1/subnets/{netuid}/serving.",
    "SubnetPrometheusArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-stake-transfers",
    "/metagraph/subnets/{netuid}/stake-transfers.json",
    "Stake-transfer activity for one subnet over a 7d or 30d window — the distinct senders (accounts), StakeTransferred event count, and average transfers per sender — served live from the account_events StakeTransferred stream at /api/v1/subnets/{netuid}/stake-transfers (no static file). The per-subnet drill-in of /api/v1/chain/stake-transfers and the between-coldkeys sibling of /api/v1/subnets/{netuid}/stake-moves (within-account re-delegation churn); transfer_stake relocates staked alpha from one account to another on the same hotkey (origin leg only), so it moves ownership, not net capital.",
    "SubnetStakeTransfersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-stake-moves",
    "/metagraph/subnets/{netuid}/stake-moves.json",
    "Stake-movement (re-delegation) activity for one subnet over a 7d or 30d window — the distinct movers (accounts), StakeMoved event count, and average movements per mover — served live from the account_events StakeMoved stream at /api/v1/subnets/{netuid}/stake-moves (no static file). The per-subnet drill-in of /api/v1/chain/stake-moves and the re-delegation-churn sibling of /api/v1/subnets/{netuid}/stake-flow (net capital flow); move_stake relocates stake between hotkeys/subnets without unstaking, so it is churn, not flow.",
    "SubnetStakeMovesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-registrations",
    "/metagraph/subnets/{netuid}/registrations.json",
    "Neuron-registration activity for one subnet over a 7d or 30d window — the distinct registrants (hotkeys), NeuronRegistered event count, and average registrations per registrant — served live from the account_events NeuronRegistered stream at /api/v1/subnets/{netuid}/registrations (no static file). Raw registration demand, the account_events companion to the neuron_daily validator-set churn in /api/v1/subnets/{netuid}/turnover.",
    "SubnetRegistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-axon-removals",
    "/metagraph/subnets/{netuid}/axon-removals.json",
    "Axon-removal activity for one subnet over a 7d or 30d window — the distinct removers (hotkeys), AxonInfoRemoved event count, and average removals per remover — read from the account_events AxonInfoRemoved stream at /api/v1/subnets/{netuid}/axon-removals (no static file) — AxonInfoRemoved has never been emitted by the runtime, so an empty card is marked `degraded` rather than published as a measured zero. Raw axon-teardown activity, the removal-side companion to the AxonServed announcements in /api/v1/subnets/{netuid}/serving.",
    "SubnetAxonRemovalsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-deregistrations",
    "/metagraph/subnets/{netuid}/deregistrations.json",
    "Neuron-deregistration activity for one subnet over a 7d or 30d window — the distinct deregistered hotkeys, NeuronDeregistered event count, and average deregistrations per hotkey — DERIVED from UID reuse in the NeuronRegistered stream at /api/v1/subnets/{netuid}/deregistrations (no static file) — NeuronDeregistered has never been emitted by the runtime, so deregistration is read as a registration landing on a (netuid, uid) slot already held by a different hotkey; the payload's `derivation` block states how many window registrations had no observable previous holder, and `degraded` marks an answer nothing derived. Raw deregistration/eviction activity, the exit-side companion to the NeuronRegistered demand in /api/v1/subnets/{netuid}/registrations.",
    "SubnetDeregistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-stake-flow",
    "/metagraph/subnets/{netuid}/stake-flow.json",
    "Net stake flow for one subnet over a recent window (7d/30d/90d): total TAO staked (StakeAdded) vs unstaked (StakeRemoved), the net flow, and event counts, with optional ?direction=all|in|out to filter inflow or outflow only, summed live from the account_events stream at /api/v1/subnets/{netuid}/stake-flow (no static file).",
    "SubnetStakeFlowArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-stake-quote",
    "/metagraph/subnets/{netuid}/stake-quote.json",
    "Read-only constant-product stake/unstake slippage quote for one subnet (#5235): the expected alpha/TAO out, spot vs effective price (TAO per alpha), and price-impact percent for a swap of ?amount= in ?direction=stake|unstake, computed live from the subnet's economics-tier AMM pool reserves (tao_in_pool_tao, alpha_in_pool) at /api/v1/subnets/{netuid}/stake-quote (no static file). Pure math — no chain write, no custody — mirroring the chain's own constant-product swap and its InsufficientLiquidity guard (an amount over 1000× the relevant reserve is rejected with 422). The root subnet (netuid 0) has no AMM and returns a 1:1, zero-impact quote.",
    "SubnetStakeQuoteArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-validator-economics",
    "/metagraph/subnets/{netuid}/validator-economics.json",
    "What a validator permit costs on one subnet and whether holding one earns (#9323, #9327), computed live at /api/v1/subnets/{netuid}/validator-economics (no static file). Carries the permit floor (total_stake units needed to hold a validator permit, where total_stake is alpha + tao_weight * root — the quantity the chain threshold actually tests) and the earning floor (where the smallest permit-holder with dividends > 0 sits; median ~7x the permit floor, so a permit is not income), each priced in TAO against the subnet's live AMM pool reserves plus the registration burn. Also: validator set composition as three separate counts (permitted / active / earning — network-wide 1,523 / 1,137 / 1,117 on 2026-08-03), open slots, whether the cap actually binds (1 of 128 subnets), the take distribution across permit-holders including the full sorted vector, the emission-gate state and daily TAO inflow, and the live sudo-settable StakeThreshold/TaoWeight the floors were derived against. Root stake is not split, so root_tao_to_clear_threshold clears the threshold on every registered subnet at once. Every derived field is nullable and degrades with a stated degraded_reason rather than reporting a confident zero.",
    "SubnetValidatorEconomicsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-validator-economics-history",
    "/metagraph/subnets/{netuid}/validator-economics-history.json",
    "The OBSERVED validator-economics series for one subnet (#9326), computed live at /api/v1/subnets/{netuid}/validator-economics/history (no static file). A daily point carries the permit floor and earning floor in ALPHA — the smallest stake that actually held a permit, and that actually earned dividends, on that day — plus the validator set composition as three separate counts and the emission-gate state with daily TAO inflow, over a 7d/30d/90d window (default 30d). The floors are read off each snapshot rather than re-derived: StakeThreshold is sudo-settable, so re-running today's threshold against a historical day would report what the floor WOULD have been under today's rules and show a flat line across a governance change that actually moved it. TAO cost is deliberately excluded from the series — a historical cost needs the pool reserves as they were, priced at the time, and reconstructing one from today's reserves would be wrong; alpha floors are unambiguous and cost is a present-tense question the per-subnet route answers. `cap_binding` is likewise absent: subnet_snapshots carries no historical max_validators, and applying today's cap to an old snapshot would manufacture a transition that never happened.",
    "SubnetValidatorEconomicsHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "validator-economics-ranking",
    "/metagraph/validators/economics.json",
    "Every subnet ranked by what it costs to become an EARNING validator there (#9324), computed live at /api/v1/validators/economics (no static file). One row per subnet carrying the same fields as /api/v1/subnets/{netuid}/validator-economics, sortable by earning_floor_cost_tao (default, cheapest first), permit_floor_cost_tao, permit_to_earning_multiple, tao_inflow_per_day or validator_headroom, and filterable on emission_gate_open / cap_binding — omitting a filter means BOTH, which is not the same as false. Every subnet the ranking drops appears in `excluded` with a reason, so an omitted subnet is distinguishable from an absent one. Derived from ONE cross-subnet neuron scan plus one economics-artifact read plus two bulk D1 reads (latest registration burn per subnet, and min_childkey_take_ratio) rather than 128 per-subnet round trips. The registration burn was formerly omitted here because it existed only as a live per-subnet chain read with no cached tier; subnet_burn_history is that tier, so registration_cost_tao and the permit_entry_cost_tao / earning_entry_cost_tao it feeds now carry their real values in the ranking too, matching the per-subnet route. The burn still does not affect the ORDER — every sort key is a floor-cost or headroom measure — it is reported because the true entry cost is worth having, not because it ranks.",
    "ValidatorEconomicsRankingArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-alpha-volume",
    "/metagraph/subnets/{netuid}/volume.json",
    "Rolling 24h buy/sell alpha volume for one subnet (#4339/8.1): unsigned totals (never netted) in both alpha and TAO for StakeAdded (buy) vs StakeRemoved (sell), plus event counts, summed live from the same account_events stream as /api/v1/subnets/{netuid}/stake-flow (no static file). Also carries a buy/sell sentiment indicator (#4339/8.2) purely derived from the alpha totals: net_volume_alpha, a bounded sentiment_ratio, and a bullish/bearish/neutral label. Fixed 24h window, not OHLC/price data (#2589's trader-feature fence).",
    "SubnetAlphaVolumeArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-ohlc",
    "/metagraph/subnets/{netuid}/ohlc.json",
    "OHLC price/volume candlesticks for one subnet (#5655, Phase 1 of the OHLC epic #5304): open/high/low/close/volume candles bucketed by ?interval=1h|1d (default 1h), shaped from the raw StakeAdded/StakeRemoved account_events stream the same /volume and /stake-flow read (per-trade price = amount_tao / alpha_amount), no static file. ?days= bounds the lookback window (default 90, max 365). Empty buckets are gaps, never synthesized flat candles. Root (netuid 0) has no AMM pool (1:1 TAO, no price impact) and returns an empty, root_excluded series rather than a meaningless flat line. Extends metagraphed's original developer-explorer scope fence (#2589's OHLC exclusion) per #4302's maintainer decision.",
    "SubnetOhlcArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-movers",
    "/metagraph/subnets/movers.json",
    "Cross-subnet momentum leaderboard: every subnet ranked by its change in stake, emission, validator, and neuron count between a window's start and end snapshots, with each subnet's share of network stake/emission and a network aggregate summary, computed live from the neuron_daily D1 rollup at /api/v1/subnets/movers (no static file).",
    "SubnetMoversArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "global-validators",
    "/metagraph/validators.json",
    "Network-wide validator/operator leaderboard: validator-permit identities grouped across all current subnet memberships and ranked by subnet footprint, UID footprint, validator trust, or cross-subnet stake/emission totals, computed live from the neurons D1 tier at /api/v1/validators (no static file).",
    "GlobalValidatorsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "accounts-list",
    "/metagraph/accounts.json",
    "Site-wide accounts leaderboard: every currently-registered hotkey (miners included, not just validator_permit=1 ones) grouped across all current subnet memberships and ranked by subnet/UID footprint, cross-subnet stake/emission totals, or last activity, computed live from the neurons D1 tier at /api/v1/accounts (no static file). The collection-level counterpart to /api/v1/validators.",
    "AccountsListArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "top-holders",
    "/metagraph/top-holders.json",
    "Balance-based top-holder leaderboard: every account (coldkey) with a nonzero free balance and/or delegated stake position, ranked by total TAO (free + delegated) or by cross-subnet stake flow (StakeAdded - StakeRemoved over a 7d/30d/90d window, #6886/#6887), served at /api/v1/accounts/top-holders (no static file). The coldkey/balance-centric counterpart to /api/v1/accounts, which is hotkey/neuron-centric. TWO TIERS (#9469/#9502): the net_flow_7d/30d/90d ranking is LIVE, recomputed daily from chain.account_events by the top-holders-flow projection lane, so captured_at advances on those sorts. The same lane also composes free_tao/delegated_tao/total_tao from D1 -- free_tao from account_balances, delegated_tao by pricing nominator_positions against the hotkey_alpha (hotkey, netuid) pool totals, total_tao as their sum ranked across the full tables. Each holdings sort is served live ONLY while its producer's most recent pass is recorded COMPLETE, because ranking over a partially-loaded ledger returns the largest values PRESENT rather than the largest that EXIST -- a well-formed leaderboard quietly missing real top holders. While an input is unproven that sort DECLINES and answers instead from a FIXED materialization taken 2026-08-02 whose captured_at/last_updated do not advance. Which sorts are live is therefore a property of the current artifact, reported per response, not a fixed list. The holdings columns are null on a flow-ranked page, never zero.",
    "TopHoldersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "validator-detail",
    "/metagraph/validators/{hotkey}.json",
    "Cross-subnet detail for one validator identity: its validator_permit=1 rows aggregated across every subnet it operates in, computed live from the neurons D1 tier at /api/v1/validators/{hotkey} (no static file). The single-entity drill-in of /api/v1/validators.",
    "ValidatorDetailArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "validator-nominators",
    "/metagraph/validators/{hotkey}/nominators.json",
    "Nominator list for one validator: who has staked to it (across every subnet it operates in) over a 7d/30d/90d window, ranked by net/gross stake flow or recency, computed live from the account_events StakeAdded/StakeRemoved stream at /api/v1/validators/{hotkey}/nominators (no static file).",
    "ValidatorNominatorsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "validator-history",
    "/metagraph/validators/{hotkey}/history.json",
    "Cross-subnet staked-over-time + rewards-per-1000-TAO history for one validator: one point per snapshot_date, summed across every subnet it operates in that day, rolled up from the neuron_daily D1 tier at /api/v1/validators/{hotkey}/history (no static file).",
    "ValidatorHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-metagraph",
    "/metagraph/subnets/{netuid}/metagraph.json",
    "Per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) for one subnet, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/metagraph (no static file).",
    "SubnetMetagraphArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-neuron",
    "/metagraph/subnets/{netuid}/neurons/{uid}.json",
    "A single neuron's metagraph state by UID, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/neurons/{uid} (no static file).",
    "NeuronDetailArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-hyperparameters",
    "/metagraph/subnets/{netuid}/hyperparameters.json",
    "One subnet's consensus, economic, and governance hyperparameters (kappa, weight/activity settings, burn cost, liquid alpha, commit-reveal, yuma version, and more), refreshed daily and served live from the subnet_hyperparams D1 tier at /api/v1/subnets/{netuid}/hyperparameters (no static file).",
    "SubnetHyperparametersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-hyperparameters-history",
    "/metagraph/subnets/{netuid}/hyperparameters/history.json",
    "Append-only hyperparameter-change timeline for one subnet (subnet_hyperparams field snapshots on change), served live from the subnet_hyperparams_history D1 tier at /api/v1/subnets/{netuid}/hyperparameters/history; pass ?format=csv to download the page as CSV (no static file). Forward-only.",
    "SubnetHyperparamsHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-validators",
    "/metagraph/subnets/{netuid}/validators.json",
    "Validators (validator_permit) of one subnet ranked by stake, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/validators (no static file).",
    "SubnetValidatorsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-yield",
    "/metagraph/subnets/{netuid}/yield.json",
    "Per-UID emission yield (emission/stake return rate) for one subnet over the current metagraph snapshot, ranked high to low with a distribution summary (subnet aggregate yield, mean, p25/median/p75/p90 percentiles), a validator/miner split, and a per-UID above/below-median label, served live from the neurons D1 tier at /api/v1/subnets/{netuid}/yield; pass ?format=csv to download the ranked neuron rows as CSV (no static file).",
    "SubnetYieldArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-yield-history",
    "/metagraph/subnets/{netuid}/yield/history.json",
    "Per-day emission-yield distribution trend (subnet-wide return plus the mean/median/p25/p75/p90 of the per-UID emission-per-stake yields) over a 7d/30d/90d window for one subnet, served live from the neuron_daily D1 rollup at /api/v1/subnets/{netuid}/yield/history; pass ?format=csv to download the per-day series as CSV (no static file). The time-series companion to /yield and the return-rate twin of /concentration/history.",
    "SubnetYieldHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-events",
    "/metagraph/subnets/{netuid}/events.json",
    "First-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers), newest first, served live from the account_events D1 tier filtered by netuid at /api/v1/subnets/{netuid}/events; pass ?format=csv to download the page as CSV (no static file).",
    "SubnetEventsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-event-summary",
    "/metagraph/subnets/{netuid}/event-summary.json",
    "Windowed event summary for one subnet: account_events counts by kind and coarse category, distinct hotkey/coldkey counts, TAO/alpha sums where applicable, first/last evidence bounds, and a small newest-first evidence slice, served live from D1 at /api/v1/subnets/{netuid}/event-summary (no static file).",
    "SubnetEventSummaryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-neuron-history",
    "/metagraph/subnets/{netuid}/neurons/{uid}/history.json",
    "Per-UID daily metagraph history (stake/trust/emission/rank over time) for one UID, served live from the neuron_daily D1 rollup tier at /api/v1/subnets/{netuid}/neurons/{uid}/history (no static file).",
    "NeuronHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-history",
    "/metagraph/subnets/{netuid}/history.json",
    "Per-subnet daily aggregate history (neuron/validator counts + stake/emission totals) for one subnet, served live from the neuron_daily D1 rollup tier at /api/v1/subnets/{netuid}/history (no static file).",
    "SubnetHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-identity-history",
    "/metagraph/subnets/{netuid}/identity-history.json",
    "Append-only on-chain identity timeline for one subnet (SubnetIdentitiesV3 field snapshots on change), served from the frozen lakehouse export of subnet_identity_history at /api/v1/subnets/{netuid}/identity-history (no static file). The table is append-only and stops at the export -- no D1 table backs it and identity changes since are recorded nowhere -- so read observed_at on each entry as how current the answer is.",
    "SubnetIdentityHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-summary",
    "/metagraph/accounts/{ss58}.json",
    "Cross-subnet activity summary for one account (hotkey or coldkey): chain-event aggregates joined to current registrations, served live from D1 at /api/v1/accounts/{ss58} (no static file).",
    "AccountSummaryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-entities",
    "/metagraph/accounts/{ss58}/entities.json",
    "One address's community-contributed entity labels plus every subnet-ownership tie it has via the chain_events SubnetOwnerChanged stream (#6737-#6740) — either side of an automatic conviction-contest transfer, not genesis ownership. Served live from the entities.json artifact + chain_events at /api/v1/accounts/{ss58}/entities (no static file).",
    "AccountEntitiesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-events",
    "/metagraph/accounts/{ss58}/events.json",
    "Paginated first-party chain-event history for one account (hotkey or coldkey), served live from the account_events D1 tier at /api/v1/accounts/{ss58}/events; pass ?format=csv to download the page as CSV (no static file).",
    "AccountEventsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-history",
    "/metagraph/accounts/{ss58}/history.json",
    "Durable per-day activity series for one account (hotkey-keyed, newest day first), served live from the account_events_daily rollup at /api/v1/accounts/{ss58}/history (no static file).",
    "AccountHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-extrinsics",
    "/metagraph/accounts/{ss58}/extrinsics.json",
    "Paginated extrinsics this account signed (by signer), newest first, served live from the extrinsics D1 tier at /api/v1/accounts/{ss58}/extrinsics; pass ?format=csv to download the page as CSV (no static file).",
    "AccountExtrinsicsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-transfers",
    "/metagraph/accounts/{ss58}/transfers.json",
    "The native-TAO Balances.Transfer feed for one account (directional sent/received), served live from the account_events D1 tier at /api/v1/accounts/{ss58}/transfers; pass ?format=csv to download the page as CSV (no static file).",
    "AccountTransfersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-counterparties",
    "/metagraph/accounts/{ss58}/counterparties.json",
    "Per-counterparty fund-flow rollup for one account, with optional ?counterparty=<ss58> relationship evidence — native-TAO transfers from the account_events D1 tier at /api/v1/accounts/{ss58}/counterparties; pass ?format=csv to download the list-mode rollup as CSV (no static file).",
    "AccountCounterpartiesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-stake-flow",
    "/metagraph/accounts/{ss58}/stake-flow.json",
    "One account's StakeAdded vs StakeRemoved flow per subnet over a recent window (7d/30d/90d): per-subnet net and gross flow with a direction label, plus account totals, an HHI concentration of where the flow is focused, and the dominant subnet — summed live from the account_events D1 tier at /api/v1/accounts/{ss58}/stake-flow (no static file).",
    "AccountStakeFlowArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-stake-moves",
    "/metagraph/accounts/{ss58}/stake-moves.json",
    "One account's stake-movement (re-delegation) footprint per subnet over a recent window (7d/30d/90d): each subnet's StakeMoved count with the first/last movement timestamps and the alpha price on the day of the most recent move (from the daily subnet_snapshots rollup), plus account totals, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet — summed live from the account_events D1 tier at /api/v1/accounts/{ss58}/stake-moves (no static file). The account-level companion to /api/v1/chain/stake-moves and /api/v1/subnets/{netuid}/stake-moves, distinct from net capital flow in /api/v1/accounts/{ss58}/stake-flow.",
    "AccountStakeMovesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-deregistrations",
    "/metagraph/accounts/{ss58}/deregistrations.json",
    "One account's neuron-deregistration footprint per subnet over a recent window (7d/30d/90d): each subnet's NeuronDeregistered eviction count with the first/last eviction timestamps, plus account totals, an HHI concentration of where its deregistration activity is focused, and the dominant subnet — DERIVED from UID reuse — the slots where this account was the PREVIOUS holder — at /api/v1/accounts/{ss58}/deregistrations (no static file); NeuronDeregistered has never been emitted by the runtime, the payload's `derivation` block states the lower bound, and `degraded` marks an answer nothing derived (the 90d window is not precomputed). The eviction-side complement to /api/v1/accounts/{ss58}/registrations and the account-level companion to /api/v1/chain/deregistrations, distinct from /api/v1/accounts/{ss58}/subnets (current registration state).",
    "AccountDeregistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-prometheus",
    "/metagraph/accounts/{ss58}/prometheus.json",
    "One account's Prometheus-endpoint serving footprint per subnet over a recent window (7d/30d/90d): each subnet's PrometheusServed announcement count with the first/last announcement timestamps, plus account totals, an HHI concentration of where its telemetry activity is focused, and the dominant subnet — read from the account_events PrometheusServed stream at /api/v1/accounts/{ss58}/prometheus (no static file) — that curation carries 0 of the 18,041 PrometheusServed events the chain emitted, so an empty footprint is marked `degraded` rather than published as a measured zero. Operational activity (announcing a Prometheus telemetry endpoint) — the telemetry sibling of /api/v1/accounts/{ss58}/serving and the account-level companion to /api/v1/chain/prometheus, orthogonal to /api/v1/accounts/{ss58}/subnets (registration state).",
    "AccountPrometheusArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-axon-removals",
    "/metagraph/accounts/{ss58}/axon-removals.json",
    "One account's axon-removal footprint per subnet over a recent window (7d/30d/90d): each subnet's AxonInfoRemoved count with the first/last removal timestamps, plus account totals, an HHI concentration of where its teardown activity is focused, and the dominant subnet — read from the account_events AxonInfoRemoved stream at /api/v1/accounts/{ss58}/axon-removals (no static file) — AxonInfoRemoved has never been emitted by the runtime, so an empty footprint is marked `degraded` rather than published as a measured zero. The teardown-side complement to /api/v1/accounts/{ss58}/serving (axon announcements) and the account-level companion to /api/v1/chain/axon-removals, orthogonal to /api/v1/accounts/{ss58}/subnets (registration state).",
    "AccountAxonRemovalsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-serving",
    "/metagraph/accounts/{ss58}/serving.json",
    "One account's axon-serving footprint per subnet over a recent window (7d/30d/90d): each subnet's AxonServed announcement count with the first/last announcement timestamps, plus account totals, an HHI concentration of where its serving activity is focused, and the dominant subnet — summed live from the account_events D1 tier at /api/v1/accounts/{ss58}/serving (no static file). Operational activity (announcing an axon endpoint) — the account-level companion to /api/v1/chain/serving, orthogonal to /api/v1/accounts/{ss58}/subnets (registration state) and /api/v1/accounts/{ss58}/registrations (registration events).",
    "AccountServingArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-weight-setters",
    "/metagraph/accounts/{ss58}/weight-setters.json",
    "One account's (validator's) weight-setting footprint per subnet over a recent window (7d/30d): each subnet's WeightsSet count with the first/last set timestamps, plus account totals, an HHI concentration of where its weight-setting activity is focused, and the dominant subnet — summed live from the account_events D1 tier at /api/v1/accounts/{ss58}/weight-setters (no static file). Keyed on the hotkey (the validator submitting weights); the account-level companion to /api/v1/chain/weights/setters and /api/v1/subnets/{netuid}/weights/setters.",
    "AccountWeightSettersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-registrations",
    "/metagraph/accounts/{ss58}/registrations.json",
    "One account's neuron-registration footprint per subnet over a recent window (7d/30d/90d): each subnet's NeuronRegistered count with the first/last registration timestamps, plus account totals, an HHI concentration of where its registration activity is focused, and the dominant subnet — summed live from the account_events D1 tier at /api/v1/accounts/{ss58}/registrations (no static file). Windowed registration events (incl. re-registrations after a deregistration) — the account-level companion to /api/v1/chain/registrations, distinct from /api/v1/accounts/{ss58}/subnets (current registration state).",
    "AccountRegistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-subnets",
    "/metagraph/accounts/{ss58}/subnets.json",
    "The subnets where an account's hotkey is currently registered, served live from the neurons D1 tier at /api/v1/accounts/{ss58}/subnets (no static file).",
    "AccountSubnetsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-portfolio",
    "/metagraph/accounts/{ss58}/portfolio.json",
    "A wallet's cross-subnet neuron portfolio: each position's economics (stake, emission, rank, trust, incentive, dividends, role) and yield, plus aggregates (totals, subnet/validator counts, overall return, stake concentration) — richer than the /subnets registration footprint, computed live from the neurons D1 tier at /api/v1/accounts/{ss58}/portfolio (no static file).",
    "AccountPortfolioArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-positions",
    "/metagraph/accounts/{ss58}/positions.json",
    "This account's reconstructed nominator-side positions (#5233): what it holds delegated across every hotkey/subnet, distinct from account-portfolio's hotkey-scoped view (a pure delegator shows near-zero there). Computed live from nominator_positions (a share-fraction ledger) joined against the neurons D1 tier's stake_tao, served at /api/v1/accounts/{ss58}/positions (no static file). Root (netuid 0) stake is not covered -- see the artifact schema's own description.",
    "AccountPositionsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-subnet-position-history",
    "/metagraph/accounts/{ss58}/subnets/{netuid}/history.json",
    "One wallet's position on one subnet over time (the 'Alpha Holdings chart'): one point per snapshot_date with the position's economics (stake, emission, rank, trust, incentive, dividends, coldkey, role) and yield, served live from the account_position_daily D1 rollup tier at /api/v1/accounts/{ss58}/subnets/{netuid}/history (no static file).",
    "AccountPositionHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-identity",
    "/metagraph/accounts/{ss58}/identity.json",
    "Personal chain identity for one account (epic #4301/5.4), the latest-only account_identity D1 row served live at /api/v1/accounts/{ss58}/identity (no static file). has_identity is false for the common case of an account that never called set_identity.",
    "AccountIdentityArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-identity-history",
    "/metagraph/accounts/{ss58}/identity-history.json",
    "Append-only diff-tracking timeline for one account's personal chain identity (epic #4301/5.2), served live from the account_identity_history D1 tier at /api/v1/accounts/{ss58}/identity-history (no static file).",
    "AccountIdentityHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-balance",
    "/metagraph/accounts/{ss58}/balance.json",
    "Live TAO balance (free+reserved, in TAO) for a finney account, queried from the RPC at request time with 60s KV cache. balance_tao is null on RPC failure. (#1818)",
    "AccountBalanceArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-root-claim",
    "/metagraph/accounts/{ss58}/root-claim.json",
    "Live root-claim current state for a Finney ss58 account (#7229) — claim type, per-hotkey claimable rates, cumulative claimed, and thresholds — queried from the finney RPC at request time with 120s KV cache. claim_type/hotkeys null on RPC failure. Read-only; never submits claim_root.",
    "AccountRootClaimArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-children",
    "/metagraph/accounts/{ss58}/children.json",
    "Live child-hotkey delegation graph for one account (#6723, part of the child-hotkey delegation epic #6721) — every child hotkey this account currently delegates stake-weight to, per subnet, queried from the chain's own ChildKeys storage map at request time with 120s KV cache. subnets is null on RPC failure, distinct from a confirmed empty graph.",
    "AccountChildrenArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "account-parents",
    "/metagraph/accounts/{ss58}/parents.json",
    "Live parent-hotkey delegation graph for one account (#6723, part of epic #6721) — every hotkey currently delegating stake-weight to this account, per subnet, queried from the chain's own ParentKeys storage map at request time with 120s KV cache. subnets is null on RPC failure, distinct from a confirmed empty graph.",
    "AccountParentsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "evm-address-mapping",
    "/metagraph/evm/address/{h160}.json",
    "Live H160 -> SS58 address mapping for one EVM address (#6725/#6728), via the AddressMapping EVM precompile's addressMapping(address), queried from the finney RPC at request time with 1h KV cache (deterministic given h160, never changes). ss58 is null on RPC failure.",
    "EvmAddressMappingArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "sudo-key",
    "/metagraph/sudo/key.json",
    "The current Sudo::Key holder (#4310/2.4, re-scoped from the original Senate/Council membership framing — subtensor has no such pallet), queried from the finney RPC at request time with 1h KV cache (the key changes extremely rarely). hotkey is null on RPC failure or an unset sudo key. `field_sources` marks hotkey measured and names the storage item behind it (Sudo.Key).",
    "SudoKeyArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "network-parameters",
    "/metagraph/network/parameters.json",
    "Live global Subtensor protocol/governance parameters (#6343) — TaoWeight, StakeThreshold, PendingChildKeyCooldown — queried from the finney RPC at request time with 300s KV cache. Each field is independently null on its own RPC failure. READ `field_sources` BEFORE CITING ANY VALUE HERE: it labels every field measured (with the storage item behind it) or reconstructed (our arithmetic), and three are reconstructed. `block_emission_tao` and `block_emission_halvings` are derived from TotalIssuance, never read from the `BlockEmission` storage item, which is stale at 1.0 TAO (#8747). `emission_gate_exponent_effective` is the runtime default (3) whenever the storage item is unset, which is its current state on finney — that 3 comes from our source tree, not from chain.",
    "NetworkParametersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "randomness",
    "/metagraph/network/randomness.json",
    "Live drand randomness-beacon status (#6730/#6731) — LastStoredRound, OldestStoredRound — queried from the finney RPC at request time with 30s KV cache. A current-state snapshot, not a history feed. Each field is independently null on its own RPC failure. `field_sources` marks the two rounds measured (Drand.LastStoredRound / Drand.OldestStoredRound) and `stored_round_span` reconstructed — it is our subtraction of them, not a retention window the beacon publishes.",
    "RandomnessArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-recycled",
    "/metagraph/subnets/{netuid}/recycled.json",
    "Live cumulative TAO recycled for registration on one subnet (#4339/8.4), queried from the chain's own RAORecycledForRegistration storage map at request time with 600s KV cache — not an account_events/log-layer aggregation (empirically confirmed the burn amount isn't captured by any ingested event or extrinsic field). recycled_tao is null on RPC failure; a subnet with zero registrations reads back a real 0.",
    "SubnetRecycledArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-burn",
    "/metagraph/subnets/{netuid}/burn.json",
    "Live current registration/burn cost for one subnet (#6321) — the dynamic price between the static min_burn_tao/max_burn_tao bounds already in /subnets/{netuid}/hyperparameters, queried from the chain's own Burn storage map at request time with 120s KV cache (moves within minutes during registration bursts). burn_tao is null on RPC failure; a subnet with a genuinely zero burn cost reads back a real 0.",
    "SubnetBurnArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-burn-history",
    "/metagraph/subnets/{netuid}/burn-history.json",
    "One subnet's registration-cost series (#9402) — how SubtensorModule.Burn has moved, captured every 15 minutes into D1 from the same single-call chain read /chain/burn uses. The live routes answer 'what does it cost'; this answers 'is it getting more expensive', which is the question an operator deciding where and WHEN to register actually has. ?window=24h|7d|30d|90d (default 7d), newest first, bounded. change_tao/change_pct describe the movement across the RETURNED window and are null when there is nothing to compare against — a single point has no change, and a change from a zero base has no percentage. A subnet with no recorded prices returns an empty series, never a 404.",
    "SubnetBurnHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-holders",
    "/metagraph/subnets/{netuid}/holders.json",
    `Who owns one subnet's alpha (#9557) — the top coldkeys by alpha held on that netuid, with each holder's share of the subnet total, how many hotkeys they hold it through, and whole-subnet aggregates (distinct holder count, total measured alpha, top5/top10/top20 concentration). The reverse index of /accounts/{ss58}/positions, which reads the same ledger one coldkey (one account) at a time. Distinct from /subnets/{netuid}/concentration, which computes its scalars off neurons.stake_tao and therefore sees REGISTERED UIDs only: this reads nominator_positions, keyed on (coldkey, hotkey, netuid) whether or not the hotkey holds a UID on the subnet, so alpha staked to UNREGISTERED hotkeys is included — on netuid 74, 92 hotkeys carry positions and 10 are registered there. Valued as share_fraction x hotkey_alpha.total_alpha against ONE proven pool pass, and ranked in ALPHA rather than TAO: within a single subnet alpha is already a common unit, so there is no subnet_snapshots price join and none of its up-to-24h staleness. limit caps the returned rows (default ${SUBNET_HOLDERS_LIMIT_DEFAULT}, max ${SUBNET_HOLDERS_LIMIT_MAX}); the aggregates are computed across the FULL holder set and then sliced, never over the capped rows, because the top of a sum is not contained in the union of the tops of its addends. TWO STATES DECLINE rather than answer, both with holders:[] plus a degraded.reason and NULL counts: pool_totals_unproven while no hotkey_alpha pass is recorded complete (a partially loaded pool ledger silently UNDERPRICES holders rather than visibly dropping them, so the ranking would be plausible and wrong), and root_not_in_alpha_map for netuid 0, which SubtensorModule::Alpha does not cover at all. A zero in any count is therefore a measured zero, never a decline.`,
    "SubnetHoldersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "tao-usd",
    "/metagraph/network/tao-usd.json",
    "The TAO/USD index (#9609) -- the current USD price of one TAO with the derivation that produced it, plus the recent series. There is no TAO/USD pair on chain, so this is COMPOSED per ADR 0025 (src/tao-usd-index.ts): a LIQUIDITY-WEIGHTED median across qualifying wTAO/WETH pools, rejecting any pool more than 2% from the unweighted median, refusing to publish below a two-pool quorum, multiplied through an ETH/USDC anchor leg. Composed rather than read from a wTAO/USDC pool deliberately: measured 2026-07-31 all three such pools traded $81k/day combined against WETH/USDC's $118M, ~1,455x deeper, and the thin pools demonstrably misprice -- two well-priced hops beat one badly-priced one. `latest` carries the whole reading together (price, price_basis, eth_usd, block_number, pool_count and the per-pool breakdown) so the number and its audit trail always describe the same block. A NULL usd_per_tao is a STATED OUTCOME, not a gap: the producer writes price_basis `insufficient_pools` when the quorum was not met, and the schema enforces that pairing as a CHECK constraint -- read it as 'not priceable at that block', never as a zero price. ?window=1h|24h|7d|30d (default 24h), newest first, capped at 2000 points; change_usd/change_pct describe the movement across the RETURNED window over PRICED points only, and are null when there is nothing to compare against. point_count and priced_point_count are reported separately: a gap between them is how a window with unpriceable blocks announces itself. THE SERIES BEGINS 2026-08-02 and accrues about one point per minute, so a 30d window today returns everything that exists rather than a month -- `oldest_observed_at` says exactly how far back the answer reaches. Mainnet-only: wrapped TAO on Ethereum has no testnet counterpart.",
    "TaoUsdArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-holders",
    "/metagraph/chain/holders.json",
    `Every subnet ranked by how concentrated its alpha OWNERSHIP is (#9607) — per subnet: the distinct holder count, the measured alpha total, top1/top5/top10/top20 shares, and the largest holder's coldkey (an ss58 address). The cross-subnet companion to /subnets/{netuid}/holders, which answers this one subnet at a time and so costs 129 requests to compare the network. DISTINCT FROM /chain/concentration, which computes Gini/HHI/Nakamoto off neurons.stake_tao and therefore sees REGISTERED UIDs only — on netuid 74 that is 10 of the 92 hotkeys actually carrying positions. This reads the position ledger, so alpha parked on hotkeys holding no UID is measured rather than invisible, and the two routes disagree by design. ALPHA IS NEVER SUMMED ACROSS SUBNETS: each subnet's alpha is a different token, so total_alpha is reported per subnet and the network rollup carries only dimension-free facts — subnets measured, how many have a single account holding a majority, how many have exactly one holder, and the MEDIAN of the top-1 shares. A cross-subnet total requires pricing each subnet's alpha through its own alpha_price_tao first, which is what /accounts/top-holders does. ?sort=top1_share (default), top5_share, top10_share, top20_share, holder_count or total_alpha; a subnet whose share could not be computed sorts LAST rather than reading as the least concentrated. limit caps the returned subnets (default ${CHAIN_HOLDERS_LIMIT_DEFAULT}, max ${CHAIN_HOLDERS_LIMIT_MAX}) and the max sits above the subnet count so ranking the whole network is one request. DECLINES rather than answering while the hotkey_alpha pool ledger has no complete pass — an empty subnets array with degraded.reason pool_totals_unproven and a NULL subnet_count, never a zero one. Mainnet-only: neither source table carries a network dimension.`,
    "ChainHoldersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-burn",
    "/metagraph/chain/burn.json",
    "Every subnet's live registration/burn cost in ONE response, ranked cheapest-first (#9399). The cross-subnet companion to /subnets/{netuid}/burn, which answers the same question one subnet at a time — 129 requests to compare them all. Served from a single chain read: Burn is an Identity-hashed map, so every key is derivable from its netuid and state_queryStorageAt returns them together. 120s KV cache, matching the per-subnet route (burn moves within minutes during registration bursts). A subnet whose burn is a genuine 0 is included, not dropped. subnet_count is what the chain reports exists (TotalNetworks) and read_count is how many were actually read — a gap between them means the read was partial. NOTE: there is no separate validator-permit price; permits are granted by the StakeThreshold, not purchased.",
    "ChainBurnArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-ownership-history",
    "/metagraph/subnets/{netuid}/ownership-history.json",
    "Every ownership transfer one subnet has undergone (#6637, part of the conviction/ownership-contest tracker epic #4302) — see docs/conviction-lock-mechanism.md for the on-chain mechanism: a permissionless, conviction-weighted contest that runs continuously for every subnet, where ownership transfers automatically once a challenger's rolled conviction overtakes the incumbent owner's (no vote, no owner cooperation required). Records carry a `source`: `chain-event` (decoded from the chain_events SubnetOwnerChanged stream, block-stamped) or `owner-observation` (inferred from two consecutive owner captures, so observed_at is when the change was noticed and block_number is null). Served live from the all-events tier (ADR 0013), falling to the R2 lakehouse reader when that tier cannot answer, no static file. A subnet that has never changed hands returns an empty ownership_changes array, not an error.",
    "SubnetOwnershipHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-conviction",
    "/metagraph/subnets/{netuid}/conviction.json",
    "Live per-subnet conviction leaderboard (#6638, part of the conviction/ownership-contest tracker epic #4302) — who currently holds the most rolled conviction, i.e. how close the subnet is to an automatic ownership flip. Companion to subnet-ownership-history above (that's the event log of past flips; this is the current standings). Rolls the periodically-captured subnet_locks snapshot forward using the CURRENT live-queried unlock_rate/maturity_rate — never a hardcoded figure, both are independently governance-adjustable. Served live, no static file. A subnet with no active challengers/owner lock returns an empty leaderboard, not an error.",
    "SubnetConvictionArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-lease",
    "/metagraph/subnets/{netuid}/lease.json",
    "Live subnet-lease state (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717) — whether a subnet is currently under a lease and, if so, its terms, queried from the chain's own SubnetUidToLeaseId/SubnetLeases/AccumulatedLeaseDividends storage maps at request time with 120s KV cache. leased is null (not false) on RPC failure, distinct from a confirmed no-lease (leased:false).",
    "SubnetLeaseArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "crowdloans",
    "/metagraph/crowdloans.json",
    "Live Crowdloan-pallet state (#8696) — every crowdloan the chain has ever opened, with its terms (creator, deposit, cap, min contribution, end block, funds account, target address) and how much it raised, read from the pallet's own NextCrowdloanId/Crowdloans storage at request time with 120s KV cache. Served live, no static file. A crowdloan whose record was dissolved is omitted rather than returned as a null hole, so crowdloan_count can be lower than next_crowdloan_id.",
    "CrowdloansArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "crowdloan-detail",
    "/metagraph/crowdloans/{crowdloan_id}.json",
    "One crowdloan's live state (#8696), read from the Crowdloan pallet's Crowdloans storage map at request time with 120s KV cache. exists is null (not false) on RPC failure, distinct from a confirmed-absent id (exists:false) — an id can be legitimately absent because dissolve removes the record while NextCrowdloanId keeps counting.",
    "CrowdloanDetailArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-lease-history",
    "/metagraph/subnets/{netuid}/lease/history.json",
    "Every SubnetLeaseCreated/SubnetLeaseTerminated event one subnet has had (#6719, part of epic #6717), decoded from the account_events stream #6718 started capturing. Served live from the chain_events lakehouse table, no static file. A subnet that has never been leased returns an empty lease_events array, not an error.",
    "SubnetLeaseHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "blocks-feed",
    "/metagraph/blocks.json",
    "The recent-block feed (newest first) for the block explorer (#1345), served live from the first-party blocks D1 tier at /api/v1/blocks; pass ?format=csv to download the filtered block rows as CSV (no static file).",
    "BlocksFeedArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "blocks-summary",
    "/metagraph/blocks/summary.json",
    "Block-production analytics over recent blocks: inter-block time distribution, extrinsic/event throughput, block-author decentralization (concentration over each author's block count), and the spec-version spread — computed live from the blocks D1 tier at /api/v1/blocks/summary (no static file).",
    "BlocksSummaryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "block-detail",
    "/metagraph/blocks/{ref}.json",
    "Per-block detail (by numeric block_number or 0x block_hash) for the block explorer (#1345), served live from the first-party blocks D1 tier at /api/v1/blocks/{ref} (no static file).",
    "BlockDetailArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "block-extrinsics",
    "/metagraph/blocks/{ref}/extrinsics.json",
    "The extrinsics in one block (by numeric block_number or 0x block_hash), in natural order, served live from the first-party extrinsics D1 tier at /api/v1/blocks/{ref}/extrinsics (no static file).",
    "BlockExtrinsicsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "block-events",
    "/metagraph/blocks/{ref}/events.json",
    "The account-attributed events in one block (by numeric block_number or 0x block_hash), in natural order, served live at /api/v1/blocks/{ref}/events (no static file). A deliberate subset of /blocks/{ref}/chain-events, which carries the complete pallet-level stream.",
    "BlockEventsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-events-feed",
    "/metagraph/chain-events.json",
    "Recent all-events feed (newest first) from the chain_events lakehouse table, served live at /api/v1/chain-events; pass ?format=csv to download the page as CSV (no static file). Each page reads one bounded block window below its ceiling, so a short page still carries a continuation. Distinct from the curated account-attributed event stream.",
    "ChainEventsFeedArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "block-chain-events",
    "/metagraph/blocks/{ref}/chain-events.json",
    "Every raw pallet-level event in one block (event_index ascending), served live at /api/v1/blocks/{ref}/chain-events from the live-follow hot tier above the decode seam and the chain_events lakehouse at or below it (no static file). The complete stream the block header's event_count counts; /blocks/{ref}/events is its curated account-attributed subset.",
    "BlockChainEventsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-events-stats",
    "/metagraph/chain-events/stats.json",
    "Chain-activity aggregate (pallet.method event distribution over the most recent N blocks the decode lane has published) from the chain_events lakehouse table, served live at /api/v1/chain-events/stats (no static file) and consumed by the get_chain_activity MCP tool.",
    "ChainEventsStatsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "extrinsics-feed",
    "/metagraph/extrinsics.json",
    "The recent-extrinsic feed (newest first) for the block explorer (#1345), served live from the first-party extrinsics D1 tier at /api/v1/extrinsics; pass ?format=csv to download the filtered extrinsic rows as CSV (no static file).",
    "ExtrinsicsFeedArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "extrinsic-detail",
    "/metagraph/extrinsics/{hash}.json",
    "Per-extrinsic detail (by 0x extrinsic_hash OR the composite <block_number>-<extrinsic_index> id) for the block explorer (#1345/#1848), served live from the first-party extrinsics D1 tier at /api/v1/extrinsics/{hash} (no static file).",
    "ExtrinsicDetailArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "sudo-calls",
    "/metagraph/sudo.json",
    "The root-origin (Sudo pallet) call table (#4310/2.2) — subtensor has no Council/Senate, only Sudo, so this is the extrinsics feed hardcoded to call_module='Sudo'. Served live from the first-party extrinsics D1 tier at /api/v1/sudo; pass ?format=csv to download the filtered rows as CSV (no static file).",
    "ExtrinsicsFeedArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "governance-config-changes",
    "/metagraph/governance/config-changes.json",
    "Subtensor's own root-origin hyperparameter/network-config change feed (#4310/2.3, re-scoped from the original Council/Senate framing — subtensor has no such pallet) — the extrinsics feed hardcoded to call_module='AdminUtils'. Served live from the first-party extrinsics D1 tier at /api/v1/governance/config-changes; pass ?format=csv to download the filtered rows as CSV (no static file).",
    "ExtrinsicsFeedArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "network-capabilities",
    "/metagraph/networks.json",
    "The per-network capability matrix (#8699): for each addressable network, which route families it serves, which it does not, and which are partial. Derived at request time from the router's own mainnet-only predicate — never hand-maintained, because a wrong capability matrix is worse than none: it makes an agent confidently plan a call that 404s. Served live at /api/v1/networks (no static file), and reachable under every network prefix including /api/v1/local/networks, since this is how a caller learns what does 404.",
    "NetworkCapabilitiesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "runtime-versions",
    "/metagraph/runtime.json",
    "The spec-version transition timeline (#4316/3.1) — the earliest known block at each distinct runtime spec_version, ascending by block_number — computed live from the first-party blocks D1 tier at /api/v1/runtime (no static file).",
    "RuntimeVersionsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-activity",
    "/metagraph/chain/activity.json",
    "Daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d or 30d window for the block explorer (#1987), computed live from the first-party chain D1 tiers at /api/v1/chain/activity (no static file).",
    "ChainActivityArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-calls",
    "/metagraph/chain/calls.json",
    "Extrinsic call-mix breakdown (count + share per call_module / call_function) over a 7d or 30d window for the block explorer (#1989), computed live from the first-party extrinsics D1 tier at /api/v1/chain/calls (no static file).",
    "ChainCallsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-signers",
    "/metagraph/chain/signers.json",
    "Windowed most-active-account leaderboard (signers ranked by tx_count or total_fee_tao, with fees/tips + newest block) over a 7d or 30d window for the block explorer (#1990), computed live from the first-party extrinsics D1 tier at /api/v1/chain/signers (no static file).",
    "ChainSignersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-transfers",
    "/metagraph/chain/transfers.json",
    "Network-wide native-TAO transfer analytics over a 7d or 30d window: total Balances.Transfer volume + count, distinct senders/receivers, the top senders and receivers ranked by volume, and the top senders' share of total volume (a concentration signal), computed live from the account_events Transfer feed at /api/v1/chain/transfers (no static file).",
    "ChainTransfersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-transfer-pairs",
    "/metagraph/chain/transfer-pairs.json",
    "Network-wide directed native-TAO transfer-pair analytics over a 7d or 30d window: total pairable Balances.Transfer volume + count, unique sender/receiver pairs, returned pair count, top-pair share, and top sender -> receiver pairs ranked by volume or count, computed live from the account_events Transfer feed at /api/v1/chain/transfer-pairs; pass ?format=csv to download the ranked pairs as CSV (no static file).",
    "ChainTransferPairsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-stake-flow",
    "/metagraph/chain/stake-flow.json",
    "Network-wide cross-subnet capital flow over a 7d or 30d window: every subnet that moved stake in the window ranked by net StakeAdded minus StakeRemoved TAO (subnets with no stake events in the window are excluded), with per-subnet staked/unstaked/net/gross totals + a direction label, a network rollup, and a distribution of the per-subnet net flow, computed live from the account_events stake stream at /api/v1/chain/stake-flow (no static file).",
    "ChainStakeFlowArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-alpha-volume",
    "/metagraph/chain/alpha-volume.json",
    "Network-wide rolling 24h buy/sell alpha-volume leaderboard: every subnet that had StakeAdded (buy) or StakeRemoved (sell) volume in the last 24h ranked by total_volume_tao (subnets with no volume in the window are excluded), each subnet with the same buy/sell/total volume + sentiment scorecard as /api/v1/subnets/{netuid}/volume, plus a network rollup (with its own net/gross sentiment reading) and a distribution of the per-subnet total volume, computed live from the account_events stake stream at /api/v1/chain/alpha-volume (no static file). Fixed 24h window, not OHLC/price data (#2589's trader-feature fence).",
    "ChainAlphaVolumeArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-weights",
    "/metagraph/chain/weights.json",
    "Network-wide validator weight-setting activity over a 7d or 30d window across the subnets with observed weight-setting activity (subnets with no WeightsSet events are absent): each subnet's distinct weight-setting validators, WeightsSet event count, and average updates per validator ranked into a leaderboard, a network rollup with the true distinct setter count (not a per-subnet sum) and total events, and a distribution summary of the per-subnet update intensity (count, mean, min, p25, median, p75, p90, max), computed live from the account_events WeightsSet stream at /api/v1/chain/weights; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainWeightsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-weight-setters",
    "/metagraph/chain/weights/setters.json",
    "Network-wide weight-setter leaderboard over a 7d or 30d window: the individual validators driving consensus across every subnet, each with its total WeightsSet count (summed across every subnet it operates on), its share of the network total, and its first/last set time, ranked into a leaderboard (limit caps the page, default 20, max 100; distinct_setters always reports the true network-wide total). Computed live from the account_events WeightsSet stream at /api/v1/chain/weights/setters. The network-wide companion to /api/v1/subnets/{netuid}/weights/setters; pass ?format=csv to download the leaderboard as CSV (no static file).",
    "ChainWeightSettersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-serving",
    "/metagraph/chain/serving.json",
    "Network-wide axon-serving announcement activity over a 7d or 30d window across the subnets with observed serving activity (subnets with no AxonServed events are absent): each subnet's AxonServed event count, distinct servers (hotkeys announcing an axon), and average announcements per server ranked into a leaderboard, a network rollup with the true distinct server count (not a per-subnet sum) and total announcements, and a distribution summary of the per-subnet re-announcement intensity (count, mean, min, p25, median, p75, p90, max), computed live from the account_events AxonServed stream at /api/v1/chain/serving; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainServingArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-axon-removals",
    "/metagraph/chain/axon-removals.json",
    "Network-wide axon-removal activity over a 7d or 30d window across the subnets with observed removal activity (subnets with no AxonInfoRemoved events are absent): each subnet's AxonInfoRemoved event count, distinct removers (hotkeys removing an announced axon), and average removals per remover ranked into a leaderboard, a network rollup with the true distinct remover count (not a per-subnet sum) and total removals, and a distribution summary of the per-subnet re-teardown intensity (count, mean, min, p25, median, p75, p90, max), read from the account_events AxonInfoRemoved stream at /api/v1/chain/axon-removals — AxonInfoRemoved has never been emitted by the runtime, so an empty leaderboard is marked `degraded` rather than published as a measured zero. The teardown-side companion to the axon-announcement /api/v1/chain/serving and the network-wide companion to /api/v1/subnets/{netuid}/axon-removals; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainAxonRemovalsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-prometheus",
    "/metagraph/chain/prometheus.json",
    "Network-wide Prometheus-endpoint serving activity over a 7d or 30d window across the subnets with observed telemetry activity (subnets with no PrometheusServed events are absent): each subnet's PrometheusServed event count, distinct exporters (hotkeys announcing a Prometheus endpoint), and average announcements per exporter ranked into a leaderboard, a network rollup with the true distinct exporter count (not a per-subnet sum) and total announcements, and a distribution summary of the per-subnet re-announcement intensity (count, mean, min, p25, median, p75, p90, max), read from the account_events PrometheusServed stream at /api/v1/chain/prometheus — that curation carries 0 of the 18,041 PrometheusServed events the chain emitted, so an empty leaderboard is marked `degraded` rather than published as a measured zero. The telemetry-endpoint companion to the axon-endpoint /api/v1/chain/serving — which subnets run observability infrastructure; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainPrometheusArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-registrations",
    "/metagraph/chain/registrations.json",
    "Network-wide neuron-registration activity over a 7d or 30d window across the subnets with observed registration activity (subnets with no NeuronRegistered events are absent): each subnet's NeuronRegistered event count, distinct registrants (hotkeys), and average registrations per registrant ranked into a leaderboard, a network rollup with the true distinct registrant count (not a per-subnet sum) and total registrations, and a distribution summary of the per-subnet re-registration intensity (count, mean, min, p25, median, p75, p90, max), computed live from the account_events NeuronRegistered stream at /api/v1/chain/registrations. Raw registration demand — the account_events companion to the neuron_daily validator-set churn in /api/v1/chain/turnover (no static file).",
    "ChainRegistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-deregistrations",
    "/metagraph/chain/deregistrations.json",
    "Network-wide neuron-deregistration activity over a 7d or 30d window across the subnets with observed deregistration activity (subnets with no NeuronDeregistered events are absent): each subnet's NeuronDeregistered event count, distinct deregistered hotkeys, and average deregistrations per hotkey ranked into a leaderboard, a network rollup with the true distinct hotkey count (not a per-subnet sum) and total deregistrations, and a distribution summary of the per-subnet re-deregistration intensity (count, mean, min, p25, median, p75, p90, max), DERIVED from UID reuse in the NeuronRegistered stream by a scheduled projection at /api/v1/chain/deregistrations — NeuronDeregistered has never been emitted by the runtime, so deregistration is read as a registration landing on a (netuid, uid) slot already held by a different hotkey; the payload's `derivation` block states how many window registrations had no observable previous holder, and `degraded` marks an answer nothing derived. Raw deregistration/eviction activity — the exit-side companion to /api/v1/chain/registrations (no static file).",
    "ChainDeregistrationsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-stake-transfers",
    "/metagraph/chain/stake-transfers.json",
    "Network-wide stake-transfer activity over a 7d or 30d window across the subnets with observed transfer activity (subnets with no StakeTransferred events are absent): each subnet's StakeTransferred event count, distinct senders (coldkeys transferring stake), and average transfers per sender ranked into a leaderboard, a network rollup with the true distinct sender count (not a per-subnet sum) and total transfers, and a distribution summary of the per-subnet transfer intensity (count, mean, min, p25, median, p75, p90, max), computed live from the account_events StakeTransferred stream at /api/v1/chain/stake-transfers. The between-coldkeys companion to the within-account re-delegation churn of /api/v1/chain/stake-moves — transfer_stake relocates staked alpha from one account to another on the same hotkey (origin leg only), so it moves ownership, not net capital; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainStakeTransfersArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-stake-moves",
    "/metagraph/chain/stake-moves.json",
    "Network-wide stake-movement (re-delegation) activity over a 7d or 30d window across the subnets with observed movement activity (subnets with no StakeMoved events are absent): each subnet's StakeMoved event count, distinct movers (accounts relocating stake), and average movements per mover ranked into a leaderboard, a network rollup with the true distinct mover count (not a per-subnet sum) and total movements, and a distribution summary of the per-subnet re-move intensity (count, mean, min, p25, median, p75, p90, max), computed live from the account_events StakeMoved stream at /api/v1/chain/stake-moves. The re-delegation-churn companion to the net-capital-flow /api/v1/chain/stake-flow — move_stake relocates stake between hotkeys/subnets without unstaking, so it is churn, not flow; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainStakeMovesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-fees",
    "/metagraph/chain/fees.json",
    "Fee/tip market analytics (daily totals, averages and exact medians over signed extrinsics only, and a top-fee-payer list) over a 7d or 30d window for the block explorer (#1988), computed live from the first-party extrinsics D1 tier at /api/v1/chain/fees (no static file).",
    "ChainFeesArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-concentration",
    "/metagraph/chain/concentration.json",
    "Network-wide stake and emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) aggregated across all subnets' neurons over three lenses (per-UID, per-entity with coldkeys collapsed across subnets into the network control distribution, and validator-only consensus power), computed live from the neurons D1 tier at /api/v1/chain/concentration (no static file).",
    "ChainConcentrationArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-performance",
    "/metagraph/chain/performance.json",
    "Network-wide reward-distribution & score-spread metrics aggregated across all subnets' neurons: reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores, and the subnet_count the snapshot spans — the network-wide reward-flow companion to chain-concentration, computed live from the neurons D1 tier at /api/v1/chain/performance (no static file).",
    "ChainPerformanceArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-idle-stake",
    "/metagraph/chain/idle-stake.json",
    "Network-wide idle-stake rollup: every subnet's own idle-stake scorecard (stake delegated to a currently-zero-dividends hotkey) ranked by idle_stake_alpha descending, plus the network total — the idle-delegation companion to chain-performance, computed live from the neurons D1 tier at /api/v1/chain/idle-stake (no static file).",
    "ChainIdleStakeArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-identity-history",
    "/metagraph/chain/identity-history.json",
    `Network-wide recent subnet-identity-change feed (newest first) aggregated across all subnets: the most-recent SubnetIdentitiesV3 changes, each carrying the netuid it belongs to plus the same tracked identity fields as the per-subnet identity-history route, capped to a ?limit (default ${CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT}, max ${CHAIN_IDENTITY_HISTORY_LIMIT_MAX}) and reporting the distinct subnet_count the feed spans, computed from the frozen lakehouse export of subnet_identity_history at /api/v1/chain/identity-history (no static file).`,
    "ChainIdentityHistoryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "self-health",
    "/metagraph/self-health.json",
    "metagraphed's OWN uptime: a verdict scoped strictly to our own components (api / site / publish) plus each one's trailing-90-day daily uptime ratios and latest probe state, served from the self_health_daily lakehouse rollup at /api/v1/self-health (no static file). Days with no probe rows are ABSENT, never zero-filled -- a gap means we weren't measuring, not that we were down. Never mixes in third-party subnet-surface health, which is what /api/v1/health covers. The per-component current_ok/http_status/latency_ms/checked_at/note fields are NULL for now, and null here means UNMEASURED, not down: the per-check ticks were written by the indexer box's self-health poller, the box is decommissioned, and only the daily rollup survived it. Synthesizing a current reading from the last frozen tick would state a probe we did not take.",
    "SelfHealthArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-yield",
    "/metagraph/chain/yield.json",
    "Network-wide emission-yield (return rate) aggregated across all subnets' neurons: the aggregate network return (total emission / total stake), the same split by validator vs miner role, and the count/mean/median/min/max plus p10–p90 spread of the per-neuron emission/stake return, and the subnet_count the snapshot spans — the return-rate companion to chain-performance, computed live from the neurons D1 tier at /api/v1/chain/yield (no static file).",
    "ChainYieldArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "chain-turnover",
    "/metagraph/chain/turnover.json",
    "Network-wide validator-set turnover (churn) across all subnets between a window's start and end neuron_daily snapshots: each subnet's validators entered, exited, Jaccard retention, and a 0-100 stability score ranked into a leaderboard, a network rollup over the union of every subnet's validator hotkeys, and a distribution summary of the per-subnet stability scores (count, mean, min, p25, median, p75, p90, max), computed live from the neuron_daily D1 rollup at /api/v1/chain/turnover; pass ?format=csv to download the per-subnet leaderboard as CSV (no static file).",
    "ChainTurnoverArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "subnet-uptime",
    "/metagraph/subnets/{netuid}/uptime.json",
    "Long-term daily uptime history per operational surface for one subnet (90d/1y window), served live from the surface_uptime_daily D1 rollup (no static file).",
    "UptimeArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "global-incidents",
    "/metagraph/incidents.json",
    "Recent cross-subnet downtime incidents reconstructed from probe history over a 7d or 30d window, served live from D1 at /api/v1/incidents (no static file).",
    "GlobalIncidentsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "registry-leaderboards",
    "/metagraph/registry/leaderboards.json",
    "Registry leaderboards — operational (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable) and economic opportunity (open-slots, cheapest-registration, highest-emission, validator-headroom, biggest-alpha-gain-1d, biggest-alpha-gain-7d) — computed live from D1 + registry projections + the economics tier at /api/v1/registry/leaderboards (no static file).",
    "RegistryLeaderboardsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "compare",
    "/metagraph/compare.json",
    "Cross-subnet comparison — registry structure (completeness + surface counts), the live economics tier, and the live per-subnet health rollup placed side by side for the requested netuids in requested order — computed live from registry projections + the economics tier + D1 at /api/v1/compare (no static file).",
    "CompareArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "compare-validators",
    "/metagraph/compare/validators.json",
    "Several validators placed side by side for a stake/delegate decision (#6035/#6325): each hotkey's take rate, estimated APY, nominator count, on-chain identity, and cross-subnet stake/emission/trust aggregates, plus an optional single-subnet membership context — the validator equivalent of /api/v1/compare, computed live from the neurons tier at /api/v1/compare/validators (no static file). Mirrors the compare_validators MCP tool.",
    "CompareValidatorsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "domains",
    "/metagraph/domains.json",
    "Per-domain rollup overview (#6749): every domain/capability tag in the existing 14-tag taxonomy (src/domain-tags.ts), each with its member subnet count, total stake, total emission share (the sum of the stage-1 price shares, not TAO received), and within-domain emission concentration — computed live from the subnets index + economics tier at /api/v1/domains (no static file). The aggregation layer over ?domain=, not a new taxonomy.",
    "DomainsArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "domain-summary",
    "/metagraph/domains/{tag}/summary.json",
    "One domain/capability tag's own rollup: member subnet count, total stake, total emission share (the sum of the stage-1 price shares, not TAO received), and within-domain emission concentration — computed live from the subnets index + economics tier at /api/v1/domains/{tag}/summary (no static file). Single-tag drill-down from /api/v1/domains.",
    "DomainSummaryArtifact",
    COMPUTED_LIVE,
  ),
  artifact(
    "rpc-usage",
    "/metagraph/rpc/usage.json",
    "RPC reverse-proxy usage analytics (request volume, latency p50/p95, failover + error rate, cache-hit rate, per-endpoint distribution, and bounded time buckets) over a 7d/30d window, computed live from the rpc_proxy_events telemetry at /api/v1/rpc/usage (no static file).",
    "RpcUsageArtifact",
    COMPUTED_LIVE,
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

// The ids of every live-computed artifact, DERIVED from the entries above rather
// than restated anywhere. Consumers (scripts/validate-schemas.ts) ask this
// instead of keeping their own copy, so an id renamed on its entry can never
// leave a stale orphan behind in a second list.
const COMPUTED_ARTIFACT_IDS: ReadonlySet<string> = new Set(
  PUBLIC_ARTIFACTS.filter((entry) => entry.computed).map((entry) => entry.id),
);

// True when `artifactId` names an artifact whose route is computed live and
// writes no file on disk — so the build must not expect one for it.
export function isComputedArtifact(artifactId: string): boolean {
  return COMPUTED_ARTIFACT_IDS.has(artifactId);
}

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
    csvListQuery("subnets"),
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
    csvListQuery("profiles"),
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
    csvListQuery("curated-surfaces"),
  ),
  route(
    "subnet-surfaces",
    "GET",
    "/api/v1/subnets/{netuid}/surfaces",
    "/metagraph/surfaces/{netuid}.json",
    "List curated public surfaces for one subnet.",
    "standard",
    ["surfaces", "subnets"],
    csvListQuery("curated-surfaces", { exclude: ["netuid"] }),
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
    csvListQuery("endpoints"),
  ),
  route(
    "subnet-endpoints",
    "GET",
    "/api/v1/subnets/{netuid}/endpoints",
    "/metagraph/endpoints/{netuid}.json",
    "List generalized endpoint resources for one subnet.",
    "short",
    ["endpoints", "subnets"],
    csvListQuery("endpoints", { exclude: ["netuid"] }),
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
    csvListQuery("candidates"),
  ),
  route(
    "subnet-candidates",
    "GET",
    "/api/v1/subnets/{netuid}/candidates",
    "/metagraph/candidates/{netuid}.json",
    "List unpromoted candidate surfaces for one subnet.",
    "standard",
    ["candidates", "subnets"],
    csvListQuery("candidates", { exclude: ["netuid"] }),
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
    csvListQuery("providers"),
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
    csvListQuery("endpoints", { exclude: ["provider"] }),
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
    csvListQuery("coverage-depth"),
  ),
  route(
    "economics",
    "GET",
    "/api/v1/economics",
    "/metagraph/economics.json",
    "List per-subnet validator and economic metrics (counts, stake, registration cost, alpha price, alpha market-cap proxy, alpha FDV proxy, emission share, and registration block height). Default order is emission share descending — note that `emission_share` is the STAGE-1 PRICE SHARE of the v440 emission pipeline (alpha_price / sum of alpha_price), NOT the share of TAO a subnet receives: spec 440 separates the two by MinerBurned reweighting, the Hill emission gate, the SubnetEmissionEnabled filter, the alpha injection cap, and the liquidity balancer. See /api/v1/network/parameters for the gate parameters and docs/computed-metrics-methodology.md for the eight-stage decomposition. Filter by netuid/registration_allowed, search by name/slug, and sort with `sort=<field>&order=asc|desc` — the two are separate parameters (e.g. `?sort=alpha_market_cap_tao&order=desc` or `?sort=block&order=asc`), NOT a combined `field:desc` token.",
    "standard",
    ["subnets"],
    csvListQuery("economics"),
  ),
  // --- The AI-native layer (ADR 0003), registered by #9092 -----------------
  route(
    "ask",
    "POST",
    "/api/v1/ask",
    "/metagraph/ai/ask.json",
    'Ask a natural-language question about the registry and get a grounded answer with citations. POST a JSON body `{ question }`; the answer carries inline [n] markers resolved by `citations`, each naming the surface it came from, so every claim is traceable to a registered surface rather than to the model. Use this when the question is exploratory ("which subnets expose a public inference API?"); use /api/v1/search/semantic when you want the ranked matches themselves rather than prose. Mirrored by the `ask` MCP tool. Served live (no static file); 503 ai_unavailable where no AI binding is configured.',
    "short",
    ["search"],
    [],
    [],
    "AskRequest",
  ),
  route(
    "search-semantic",
    "GET",
    "/api/v1/search/semantic",
    "/metagraph/ai/search-semantic.json",
    "Search the registry by MEANING rather than by keyword: ?q= is embedded and ranked by cosine similarity, so it finds surfaces whose text never contains your terms. The complement to /api/v1/search, which is lexical -- reach for that one when you know the exact name. Each result carries its score, type, netuid/slug, title/subtitle, URL, categories, and service kinds; `model` names the embedding model. ?limit caps the list. Mirrored by the `semantic_search` MCP tool. Served live (no static file); 503 ai_unavailable where no AI binding is configured.",
    "short",
    ["search"],
    [
      { name: "q", schema: { type: "string" } },
      { name: "limit", schema: { type: "string" } },
    ],
    [],
  ),
  route(
    "surface-verify",
    "GET",
    "/api/v1/surfaces/{surface_id}/verify",
    "/metagraph/surfaces/{surface_id}/verify.json",
    "Probe ONE registered surface right now and report whether it is actually callable. Catalog-resolved, not arbitrary URL fetching: name a surface the registry knows and the Worker probes the URL it has on file, echoing the resolved identity (surface_key, netuid, kind, url, provider, auth_required) beside the verdict (status, classification, callable) and its evidence (latency_ms, status_code, error). `from_cache` says whether this was a fresh probe. Use it as the last step before integrating, after list_subnet_apis/get_api_schema. Mirrored by the `verify_integration` MCP tool. Served live (no static file); 404 surface_not_found when no catalogued surface matches.",
    "short",
    ["surfaces"],
    [],
    [{ name: "surface_id", schema: { type: "string" } }],
  ),
  route(
    "emission-pipeline",
    "GET",
    "/api/v1/chain/emission-pipeline",
    "/metagraph/chain/emission-pipeline.json",
    "Fetch the v440 emission pipeline decomposed per subnet (#8744): stage 1's price share, MinerBurned, the post-burn weighted share, the post-Hill-gate share, SubnetEmissionEnabled, the final share of block emission actually received, the gate's give-or-take (`gate_delta`), `distance_to_bar` measured against the WEIGHTED share (theta is computed over the post-burn distribution, so comparing stage 1 to it answers a question the gate does not ask), and the TAO split -- `tao_in_emission` (pool liquidity injection) vs `excess_tao` (chain buys), their `tao_total`, and `liquidity_fraction`. Plus the network aggregate and the issuance-derived block emission. EVERY SHARE IS RECONSTRUCTED, NOT READ: the chain publishes the inputs, not the decomposition. `field_sources` gives each field its kind (measured|reconstructed) and, for measurements, the storage item behind it; every value is pinned to `chain_state.block`; and the four pipeline identities are evaluated on the rows being served, so `verification.verified: false` means the response is not defensible and must not be used. `emission_enabled` is published rather than inferred because a deeply gated ENABLED subnet and a disabled one both read `final_share: 0`. The two TAO channels are point samples at that block -- measured across 14 consecutive blocks they move a few rao and `liquidity_fraction` varies by ~1e-5, so no rollup exists or is needed. ?netuid filters the subnet list and deliberately leaves the aggregate network-wide. Served live (no static file); 503 when the capture carries no pinned block, because an unverifiable decomposition is worse than none.",
    "short",
    ["subnets", "analytics"],
    {
      parameters: [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
    },
    [],
  ),
  route(
    "economics-trends",
    "GET",
    "/api/v1/economics/trends",
    "/metagraph/economics/trends.json",
    "Fetch the network-wide economics time series (#1307): per UTC day across all subnets — total stake, stake-weighted + median alpha price, total validator/miner counts, and mean emission share — aggregated live from the daily subnet_snapshots D1 rollup. `mean_emission_share` averages the stage-1 price share, so it inherits the same caveat: `emission_share` is the STAGE-1 PRICE SHARE of the v440 emission pipeline (alpha_price / sum of alpha_price), NOT the share of TAO a subnet receives: spec 440 separates the two by MinerBurned reweighting, the Hill emission gate, the SubnetEmissionEnabled filter, the alpha injection cap, and the liquidity balancer. See /api/v1/network/parameters for the gate parameters and docs/computed-metrics-methodology.md for the eight-stage decomposition. The rollup is the same source the per-subnet /trajectory reads. ?window=7d|30d|90d|1y|all (default 30d). Pass ?format=csv to download the per-day series as CSV. Served live (no static file); day_count:0 / days:[] when the rollup is cold.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ]),
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
    "Fetch the index of captured live request/response fixtures (which surfaces carry a sanitized sample). Fetch one with GET /api/v1/fixtures/{surface_id}, get_fixture, or GET /metagraph/fixtures/{surface_id}.json.",
    "standard",
    ["registry", "api-dx"],
  ),
  route(
    "fixture-detail",
    "GET",
    "/api/v1/fixtures/{surface_id}",
    "/metagraph/fixtures/{surface_id}.json",
    "Fetch one captured, sanitized live request/response fixture by surface id.",
    "standard",
    ["registry", "api-dx"],
    [],
    [
      {
        name: "surface_id",
        schema: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]*$",
        },
      },
    ],
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
    csvListQuery("review-gap-priorities"),
  ),
  route(
    "subnet-gaps",
    "GET",
    "/api/v1/subnets/{netuid}/gaps",
    "/metagraph/review/gaps/{netuid}.json",
    "Fetch interface gap priorities and enrichment queue for one subnet.",
    "standard",
    ["registry", "review", "subnets"],
    csvListQuery("review-gap-priorities", { exclude: ["netuid"] }),
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
    csvListQuery("profile-completeness"),
  ),
  route(
    "review-adapter-candidates",
    "GET",
    "/api/v1/review/adapter-candidates",
    "/metagraph/review/adapter-candidates.json",
    "Fetch subnets worth deeper adapter work.",
    "standard",
    ["adapters", "review"],
    csvListQuery("adapter-candidates"),
  ),
  route(
    "review-enrichment-queue",
    "GET",
    "/api/v1/review/enrichment-queue",
    "/metagraph/review/enrichment-queue.json",
    "Fetch the prioritized all-subnet enrichment queue.",
    "standard",
    ["registry", "review", "profiles"],
    csvListQuery("enrichment-queue"),
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
    "Fetch the week-over-week structural trajectory (completeness + surface/endpoint counts) for one subnet from daily snapshots (computed live from D1). Pass ?format=csv to download the per-day series as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([]),
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
    "subnet-performance",
    "GET",
    "/api/v1/subnets/{netuid}/performance",
    "/metagraph/subnets/{netuid}/performance.json",
    "Fetch reward-distribution & score-spread metrics for one subnet: reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores (computed live from the neurons D1 tier). The reward-flow companion to /concentration.",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-idle-stake",
    "GET",
    "/api/v1/subnets/{netuid}/idle-stake",
    "/metagraph/subnets/{netuid}/idle-stake.json",
    "Fetch stake delegated to a hotkey currently earning zero dividends for one subnet — dividends are the only stream delegated stake ever receives in dTAO, so this covers both no-permit and zero-weight-output hotkeys alike (computed live from the neurons D1 tier).",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-performance-history",
    "GET",
    "/api/v1/subnets/{netuid}/performance/history",
    "/metagraph/subnets/{netuid}/performance/history.json",
    "Fetch the per-day reward-flow & trust trend for one subnet over a 7d/30d/90d window: the incentive/dividends reward concentration (Gini, Nakamoto coefficient, top-10% share) plus the mean & median of the 0–1 trust, consensus, and validator_trust scores (computed live from the neuron_daily D1 rollup). The reward-flow twin of /concentration/history. Pass ?format=csv to download the per-day series as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-concentration-history",
    "GET",
    "/api/v1/subnets/{netuid}/concentration/history",
    "/metagraph/subnets/{netuid}/concentration/history.json",
    "Fetch the per-day stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share) for one subnet over a 7d/30d/90d window (computed live from the neuron_daily D1 rollup). Pass ?format=csv to download the per-day series as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-turnover",
    "GET",
    "/api/v1/subnets/{netuid}/turnover",
    "/metagraph/subnets/{netuid}/turnover.json",
    "Fetch validator-set & registration turnover (churn) for one subnet between a window's start and end snapshots — validators entered/exited + retention, UID deregistrations, and a 0-100 stability score. Add ?changes=true to include the entered/exited validator hotkeys and UID reassignment detail (computed live from the neuron_daily D1 rollup).",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
      { name: "changes", schema: { type: "string", enum: ["true"] } },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-weights",
    "GET",
    "/api/v1/subnets/{netuid}/weights",
    "/metagraph/subnets/{netuid}/weights.json",
    "Fetch validator weight-setting activity for one subnet over a 7d or 30d window: the distinct weight-setting validators, the WeightsSet event count, and the average updates per validator, computed live from the account_events WeightsSet stream. The per-subnet drill-in of GET /api/v1/chain/weights (which ranks only the top-N subnets and cannot be queried by netuid). Schema-stable zeroed card when the subnet has no WeightsSet events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-weight-setters",
    "GET",
    "/api/v1/subnets/{netuid}/weights/setters",
    "/metagraph/subnets/{netuid}/weights/setters.json",
    "Fetch the per-subnet weight-setter leaderboard over a 7d or 30d window: the individual validators behind /weights ranked by activity, each with its WeightsSet count, its share of the subnet's total weight-setting, and when it first and last set weights in the window, computed live from the account_events WeightsSet stream. The setter-level drill-in of GET /api/v1/subnets/{netuid}/weights (which reports only the aggregate and never names the setters). Schema-stable empty leaderboard when the subnet has no WeightsSet events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-serving",
    "GET",
    "/api/v1/subnets/{netuid}/serving",
    "/metagraph/subnets/{netuid}/serving.json",
    "Fetch axon-serving announcement activity for one subnet over a 7d or 30d window: the distinct servers (hotkeys), the AxonServed event count, and the average announcements per server, computed live from the account_events AxonServed stream. The per-subnet drill-in of GET /api/v1/chain/serving (which ranks only the top-N subnets and cannot be queried by netuid). Schema-stable zeroed card when the subnet has no AxonServed events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-prometheus",
    "GET",
    "/api/v1/subnets/{netuid}/prometheus",
    "/metagraph/subnets/{netuid}/prometheus.json",
    "Fetch Prometheus-endpoint serving activity for one subnet over a 7d or 30d window: the distinct exporters (hotkeys), the PrometheusServed event count, and the average announcements per exporter, read from the account_events PrometheusServed stream, which carries 0 of the 18,041 PrometheusServed events the chain emitted — an empty card is marked `degraded` rather than published as a measured zero. The per-subnet drill-in of GET /api/v1/chain/prometheus (which ranks only the top-N subnets and cannot be queried by netuid) and the telemetry-endpoint sibling of GET /api/v1/subnets/{netuid}/serving (axon endpoints). The zeroed card carries a `degraded` block whenever it is empty.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-stake-transfers",
    "GET",
    "/api/v1/subnets/{netuid}/stake-transfers",
    "/metagraph/subnets/{netuid}/stake-transfers.json",
    "Fetch stake-transfer activity for one subnet over a 7d or 30d window: the distinct senders (accounts), the StakeTransferred event count, and the average transfers per sender, computed live from the account_events StakeTransferred stream. The per-subnet drill-in of GET /api/v1/chain/stake-transfers (which ranks only the top-N subnets and cannot be queried by netuid) and the between-coldkeys sibling of GET /api/v1/subnets/{netuid}/stake-moves (within-account re-delegation churn) — transfer_stake relocates staked alpha from one account to another on the same hotkey (origin leg only), so it moves ownership, not net capital. Schema-stable zeroed card when the subnet has no StakeTransferred events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-stake-moves",
    "GET",
    "/api/v1/subnets/{netuid}/stake-moves",
    "/metagraph/subnets/{netuid}/stake-moves.json",
    "Fetch stake-movement (re-delegation) activity for one subnet over a 7d or 30d window: the distinct movers (accounts), the StakeMoved event count, and the average movements per mover, computed live from the account_events StakeMoved stream. The per-subnet drill-in of GET /api/v1/chain/stake-moves (which ranks only the top-N subnets and cannot be queried by netuid) and the re-delegation-churn sibling of GET /api/v1/subnets/{netuid}/stake-flow (net capital flow) — move_stake relocates stake between hotkeys/subnets without unstaking, so it is churn, not flow. Schema-stable zeroed card when the subnet has no StakeMoved events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-registrations",
    "GET",
    "/api/v1/subnets/{netuid}/registrations",
    "/metagraph/subnets/{netuid}/registrations.json",
    "Fetch neuron-registration activity for one subnet over a 7d or 30d window: the distinct registrants (hotkeys), the NeuronRegistered event count, and the average registrations per registrant, computed live from the account_events NeuronRegistered stream. Raw registration demand — the account_events companion to the neuron_daily validator-set churn in GET /api/v1/subnets/{netuid}/turnover (net snapshot change, not raw event volume). Schema-stable zeroed card when the subnet has no NeuronRegistered events in the window.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-axon-removals",
    "GET",
    "/api/v1/subnets/{netuid}/axon-removals",
    "/metagraph/subnets/{netuid}/axon-removals.json",
    "Fetch axon-removal activity for one subnet over a 7d or 30d window: the distinct removers (hotkeys), the AxonInfoRemoved event count, and the average removals per remover, read from the account_events AxonInfoRemoved stream, which the runtime has never populated — an empty card is marked `degraded` rather than published as a measured zero. Raw axon-teardown activity — the removal-side companion to the AxonServed announcements in GET /api/v1/subnets/{netuid}/serving (which counts axon announcements, not teardowns). The zeroed card carries a `degraded` block whenever it is empty.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-deregistrations",
    "GET",
    "/api/v1/subnets/{netuid}/deregistrations",
    "/metagraph/subnets/{netuid}/deregistrations.json",
    "Fetch neuron-deregistration activity for one subnet over a 7d or 30d window: the distinct deregistered hotkeys, the NeuronDeregistered event count, and the average deregistrations per hotkey, DERIVED from UID reuse in the NeuronRegistered stream (NeuronDeregistered has never been emitted by the runtime). Raw deregistration/eviction activity — the exit-side companion to the NeuronRegistered demand in GET /api/v1/subnets/{netuid}/registrations and the account_events companion to the neuron_daily churn in GET /api/v1/subnets/{netuid}/turnover (net snapshot change, not raw event volume). The card carries a `derivation` block stating how many window registrations had no observable previous holder, and a `degraded` block when nothing derived it.",
    "short",
    ["subnets", "analytics"],
    [{ name: "window", schema: { type: "string", enum: ["7d", "30d"] } }],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-stake-flow",
    "GET",
    "/api/v1/subnets/{netuid}/stake-flow",
    "/metagraph/subnets/{netuid}/stake-flow.json",
    "Fetch net stake flow for one subnet over a recent window: total TAO staked (StakeAdded) vs unstaked (StakeRemoved), the net flow, and the stake/unstake event counts, summed live from the account_events stream. ?direction=all|in|out filters to inflow (StakeAdded) or outflow (StakeRemoved) only; omitted defaults to all. Windows (7d/30d/90d) are bounded by the account_events retention.",
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "direction",
        schema: { type: "string", enum: ["all", "in", "out"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-alpha-volume",
    "GET",
    "/api/v1/subnets/{netuid}/volume",
    "/metagraph/subnets/{netuid}/volume.json",
    "Fetch the rolling 24h buy/sell alpha volume for one subnet: unsigned totals (never netted) in both alpha and TAO for StakeAdded (buy) vs StakeRemoved (sell), plus event counts, summed live from the same account_events stream as GET /api/v1/subnets/{netuid}/stake-flow. Also returns a buy/sell sentiment indicator derived from the alpha totals: net_volume_alpha, a bounded sentiment_ratio, and a bullish/bearish/neutral label. Fixed 24h window, no query params — a canonical market-depth figure, not OHLC/price data.",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-ohlc",
    "GET",
    "/api/v1/subnets/{netuid}/ohlc",
    "/metagraph/subnets/{netuid}/ohlc.json",
    "Fetch open/high/low/close/volume candles for one subnet's alpha price, bucketed by ?interval= (1h or 1d, default 1h) from the same account_events StakeAdded/StakeRemoved stream as GET /api/v1/subnets/{netuid}/volume — each row is one executed trade, price = amount_tao / alpha_amount. Open/high/low/close are the first/max/min/last trade price in the bucket; volume_alpha/volume_tao are summed amounts. ?days= bounds the lookback window (default 90, max 365). Empty buckets are omitted (a gap, not a synthesized flat candle). The root subnet (netuid 0) has no AMM pool — 1:1 TAO, no price impact — so it returns an empty candle array with root_excluded:true rather than a meaningless flat-line series.",
    "short",
    ["subnets", "analytics"],
    [
      { name: "interval", schema: { type: "string", enum: ["1h", "1d"] } },
      { name: "days", schema: { type: "integer", minimum: 1, maximum: 365 } },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-stake-quote",
    "GET",
    "/api/v1/subnets/{netuid}/stake-quote",
    "/metagraph/subnets/{netuid}/stake-quote.json",
    "Fetch a read-only constant-product stake/unstake slippage quote for one subnet: the expected alpha/TAO out, spot vs effective price (TAO per alpha), and price-impact percent for a swap of ?amount= in ?direction=stake|unstake (default stake), computed live from the subnet's economics-tier AMM pool reserves (tao_in_pool_tao, alpha_in_pool). Pure math — no chain write, no custody — mirroring the chain's own constant-product swap and its InsufficientLiquidity guard: an amount over 1000× the relevant reserve is rejected with 422. The root subnet (netuid 0) has no AMM and returns a 1:1, zero-impact quote.",
    "short",
    ["subnets", "analytics"],
    [
      { name: "amount", schema: { type: "number", exclusiveMinimum: 0 } },
      {
        name: "direction",
        schema: { type: "string", enum: ["stake", "unstake"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-validator-economics",
    "GET",
    "/api/v1/subnets/{netuid}/validator-economics",
    "/metagraph/subnets/{netuid}/validator-economics.json",
    "Fetch what it costs to become a validator on one subnet and whether a permit there earns: the permit floor and the earning floor (which differ by a median of ~7x — a permit is not income), the TAO to reach each priced against live AMM pool reserves plus the registration burn, how many validator slots are open, the commission (take) distribution across permit-holders, whether the emission gate is open and the daily TAO inflow, and the live StakeThreshold/TaoWeight the floors were computed against. Permitted, active and earning are returned as three separate counts because they are three different sets. Root stake counts toward the threshold on every registered subnet at once, so root_tao_to_clear_threshold is the cross-subnet alternative to the per-subnet alpha costs. Read-only and derived — no chain write, no custody; every derived field is nullable and degrades with a stated reason rather than a confident zero.",
    "short",
    ["subnets", "analytics", "validators"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-validator-economics-history",
    "GET",
    "/api/v1/subnets/{netuid}/validator-economics/history",
    "/metagraph/subnets/{netuid}/validator-economics-history.json",
    "Fetch whether validating on one subnet is getting cheaper or more expensive: a daily series of the observed permit floor and earning floor in alpha, the validator set composition as three separate counts, and the emission-gate state with daily TAO inflow, over a 7d/30d/90d window (default 30d), newest first. A floor that has doubled means the subnet is filling up and entering now buys a contested position; a falling earning floor means it is emptying out — the same snapshot value, opposite decisions. Set-composition drift is what usually explains a floor change, which is why both ship together. TAO cost is deliberately excluded: a historical cost needs the pool reserves as they were, and reconstructing one from today's reserves would be wrong.",
    "short",
    ["subnets", "analytics", "validators"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "validator-economics-ranking",
    "GET",
    "/api/v1/validators/economics",
    "/metagraph/validators/economics.json",
    `Fetch every subnet ranked by what it costs to become an EARNING validator there. One row per subnet with the same fields as /api/v1/subnets/{netuid}/validator-economics: the permit floor and the earning floor (which differ by a median of ~7x — a permit is not income), their TAO cost against live pool reserves, validator set composition as three separate counts, open slots, the take distribution, and the emission-gate state. Sort by earning_floor_cost_tao (default, cheapest first), permit_floor_cost_tao, permit_to_earning_multiple, tao_inflow_per_day or validator_headroom; filter on emission_gate_open or cap_binding, where omitting a filter means BOTH rather than false. limit caps the page (default ${VALIDATOR_ECONOMICS_LIMIT_DEFAULT}, max ${VALIDATOR_ECONOMICS_LIMIT_MAX}). Every subnet the ranking drops is returned in \`excluded\` with a reason. The registration burn is excluded from the ranking — it is a live per-subnet read and immaterial to the order; the per-subnet route reports the true entry cost.`,
    "short",
    ["validators", "subnets", "analytics"],
    [
      { name: "sort", schema: { type: "string" } },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: VALIDATOR_ECONOMICS_LIMIT_MAX,
        },
      },
      {
        name: "offset",
        schema: {
          type: "integer",
          minimum: 0,
          maximum: VALIDATOR_ECONOMICS_LIMIT_MAX,
        },
      },
      { name: "emission_gate_open", schema: { type: "boolean" } },
      { name: "cap_binding", schema: { type: "boolean" } },
    ],
    [],
  ),
  route(
    "subnet-movers",
    "GET",
    "/api/v1/subnets/movers",
    "/metagraph/subnets/movers.json",
    `Fetch the cross-subnet momentum leaderboard: every subnet ranked by its change in stake, emission, validator, and neuron count between the window's start and end neuron_daily snapshots, with start/end values, deltas, percentage changes, and each subnet's share of network stake/emission at the end. A network block totals stake/emission/validators across all subnets with gainer/loser/unchanged counts. Sort by stake (default), emission, validators, or neurons; limit caps the list (default ${MOVERS_LIMIT_DEFAULT}, max ${MOVERS_LIMIT_MAX}). Computed live from the neuron_daily D1 rollup.`,
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "sort",
        schema: {
          type: "string",
          enum: ["stake", "emission", "validators", "neurons"],
        },
      },
      {
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: MOVERS_LIMIT_MAX },
      },
    ]),
    [],
  ),
  route(
    "global-validators",
    "GET",
    "/api/v1/validators",
    "/metagraph/validators.json",
    `Fetch the network-wide validator/operator leaderboard: validator-permit identities grouped across all current subnet memberships, with trust metrics, cross-subnet stake/emission totals, stake dominance, and top membership rows. Sort by subnet_count (default), uid_count, avg_validator_trust, max_validator_trust, total_stake, total_emission, or stake_dominance; limit caps the list (default ${GLOBAL_VALIDATOR_LIMIT_DEFAULT}, max ${GLOBAL_VALIDATOR_LIMIT_MAX}). Computed live from the neurons D1 tier.`,
    "short",
    ["validators", "analytics"],
    csvRouteQuery([
      {
        name: "sort",
        schema: {
          type: "string",
          enum: [
            "avg_validator_trust",
            "max_validator_trust",
            "stake_dominance",
            "subnet_count",
            "total_emission",
            "total_stake",
            "uid_count",
          ],
        },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: GLOBAL_VALIDATOR_LIMIT_MAX,
        },
      },
    ]),
    [],
  ),
  route(
    "accounts-list",
    "GET",
    "/api/v1/accounts",
    "/metagraph/accounts.json",
    `Fetch the site-wide accounts leaderboard: every currently-registered hotkey (miners included, not just validator_permit=1 ones) grouped across all current subnet memberships, with cross-subnet stake/emission totals, stake dominance, a validator/miner UID breakdown, and top membership rows. Sort by total_stake (default), total_emission, subnet_count, uid_count, validator_count, stake_dominance, or last_active; limit caps the list (default ${ACCOUNTS_LIST_LIMIT_DEFAULT}, max ${ACCOUNTS_LIST_LIMIT_MAX}). Computed live from the neurons D1 tier. No 'Free'/spendable-balance or 'Total' column — no balance-tracking tier exists to source them from account_events/neurons.`,
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      {
        name: "sort",
        schema: {
          type: "string",
          enum: [
            "total_stake",
            "total_emission",
            "subnet_count",
            "uid_count",
            "validator_count",
            "stake_dominance",
            "last_active",
          ],
        },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: ACCOUNTS_LIST_LIMIT_MAX,
        },
      },
    ]),
    [],
  ),
  route(
    "top-holders",
    "GET",
    "/api/v1/accounts/top-holders",
    "/metagraph/top-holders.json",
    `Fetch the balance-based top-holder leaderboard: every account (coldkey) with a nonzero free balance and/or delegated stake position, with free/delegated/total TAO columns matching the taostats-style Account/Free/Delegated/Total benchmark /api/v1/accounts explicitly cannot derive. Sort by total_tao (default), free_tao, delegated_tao, or cross-subnet stake flow over a window (net_flow_7d, net_flow_30d, net_flow_90d, #6886/#6887); limit caps the list (default ${TOP_HOLDERS_LIMIT_DEFAULT}, max ${TOP_HOLDERS_LIMIT_MAX}). free_tao is sourced from a direct System::Account chain-state scan (not event-reconstructed, so it can't drift); delegated_tao is this account's own stake positions across every hotkey/subnet, VALUED IN TAO: every position is non-root and therefore denominated in its subnet's alpha token, so each is multiplied by that netuid's alpha_price_tao from the latest daily subnet_snapshots row before summing (#8803) -- a DAILY cadence, so the price can lag up to ~24h behind the live economics tier, and a netuid with no usable price is excluded from the sum rather than counted as zero. total_tao adds it to free_tao, which is valid because both are TAO; net_flow_* is StakeAdded minus StakeRemoved over the window -- a negative value is a real net outflow, not a missing value -- and null-valued rows sort last on the net_flow_* keys. TWO TIERS, SELECTED BY SORT (#9469/#9502). The net_flow_* sorts are LIVE: the top-holders-flow projection lane recomputes all three windows daily from chain.account_events, so captured_at advances and the ranking is a real one. The same lane composes the three holdings sorts from D1 -- free_tao from account_balances, delegated_tao by valuing each nominator_positions row as share_fraction x hotkey_alpha.total_alpha x that netuid's alpha_price_tao (#9502 captured the pool totals; neurons.stake_tao covers only hotkeys holding a UID on that exact subnet, 22.8% of position rows, so recomputing from it would drop real top holders out of the ranking), and total_tao as free + delegated ranked across the FULL tables rather than summed over the other two sorts' capped rows, since the top of a sum is not contained in the union of the tops of its addends. A holdings sort is served live ONLY while its producer's most recent pass is recorded COMPLETE: ranking over a partially-loaded ledger returns the largest values PRESENT rather than the largest that EXIST, which is a well-formed leaderboard quietly missing real top holders, and for the pool ledger a missing total silently UNDERPRICES rather than dropping a row. While an input is unproven that sort DECLINES and answers from a fixed materialization taken 2026-08-02 whose captured_at and last_updated do not advance -- an account that has moved TAO since is misreported and one first funded since is absent, so read that ranking as historical and use GET /api/v1/accounts/{ss58}/balance for the live per-account balance. Which sorts are currently live is a property of the artifact, not a fixed list. On a net_flow_*-sorted page the three holdings columns are null rather than zero, because a zero would assert an empty wallet.`,
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      {
        name: "sort",
        schema: {
          type: "string",
          enum: ["total_tao", "free_tao", "delegated_tao"],
        },
      },
      {
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: TOP_HOLDERS_LIMIT_MAX },
      },
    ]),
    [],
  ),
  route(
    "validator-detail",
    "GET",
    "/api/v1/validators/{hotkey}",
    "/metagraph/validators/{hotkey}.json",
    "Fetch cross-subnet detail for one validator identity: its validator_permit=1 rows aggregated across every subnet it operates in — cross-subnet totals (stake, emission, avg/max trust) plus a full per-subnet performance table. Computed live from the neurons D1 tier. Cold/absent hotkey (no validator-permit rows) returns a zeroed aggregate with an empty subnets array, never a 404.",
    "short",
    ["validators", "analytics"],
    [],
    [{ name: "hotkey", schema: { type: "string" } }],
  ),
  route(
    "validator-nominators",
    "GET",
    "/api/v1/validators/{hotkey}/nominators",
    "/metagraph/validators/{hotkey}/nominators.json",
    "Fetch the nominator list for one validator: who has staked to it (across every subnet it operates in) over a 7d/30d/90d window, each with staked/unstaked/net/gross TAO and last activity, ranked by net_staked (default), gross_staked, or last_activity. ?coldkey= narrows to one nominator's own flow (exact match). Summed live from the account_events StakeAdded/StakeRemoved stream. Cold/absent hotkey returns an empty list, never a 404.",
    "short",
    ["validators", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "sort",
        schema: {
          type: "string",
          enum: ["net_staked", "gross_staked", "last_activity"],
        },
      },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "coldkey", schema: { type: "string" } },
    ],
    [{ name: "hotkey", schema: { type: "string" } }],
  ),
  route(
    "validator-history",
    "GET",
    "/api/v1/validators/{hotkey}/history",
    "/metagraph/validators/{hotkey}/history.json",
    "Fetch cross-subnet staked-over-time + rewards-per-1000-TAO history for one validator: one point per day, summed across every subnet it operates in that day (stake/emission totals, subnet count, and a normalized reward rate), computed live from the neuron_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.",
    "short",
    ["validators", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [{ name: "hotkey", schema: { type: "string" } }],
  ),
  route(
    "subnet-metagraph",
    "GET",
    "/api/v1/subnets/{netuid}/metagraph",
    "/metagraph/subnets/{netuid}/metagraph.json",
    "Fetch the per-UID metagraph (stake, trust, consensus, incentive, dividends, emission, validator_permit, rank, axon) for one subnet, computed live from the neurons D1 tier. Add ?validator_permit=true for validators only. Narrow each row to the columns you need with ?fields=uid,hotkey — a comma-separated list of Neuron field names, validated against the published Neuron schema; an unsupported name is a 400. The full response is 256 rows x 17 fields (~95 KB on subnet 1), and ?fields=uid,hotkey is ~18 KB. CSV keeps its own fixed column set.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      { name: "validator_permit", schema: { type: "string", enum: ["true"] } },
      { name: "fields", schema: { type: "string" } },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-neuron",
    "GET",
    "/api/v1/subnets/{netuid}/neurons/{uid}",
    "/metagraph/subnets/{netuid}/neurons/{uid}.json",
    "Fetch a single neuron's metagraph state by UID, computed live from the neurons D1 tier. Narrow the row with ?fields=uid,hotkey — a comma-separated list of Neuron field names, validated against the published Neuron schema; an unsupported name is a 400.",
    "short",
    ["subnets", "analytics"],
    [{ name: "fields", schema: { type: "string" } }],
    [
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
      { name: "uid", schema: { type: "integer", minimum: 0 } },
    ],
  ),
  route(
    "subnet-hyperparameters",
    "GET",
    "/api/v1/subnets/{netuid}/hyperparameters",
    "/metagraph/subnets/{netuid}/hyperparameters.json",
    "Fetch one subnet's consensus, economic, and governance hyperparameters (kappa, weight/activity settings, burn cost, liquid alpha, commit-reveal, yuma version, and more), refreshed daily and computed live from the subnet_hyperparams D1 tier.",
    "short",
    ["subnets", "analytics"],
    [],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-hyperparameters-history",
    "GET",
    "/api/v1/subnets/{netuid}/hyperparameters/history",
    "/metagraph/subnets/{netuid}/hyperparameters/history.json",
    "Fetch the append-only hyperparameter-change timeline for one subnet (#4309): each entry is a subnet_hyperparams snapshot recorded when any hyperparameter changed. Forward-only (no pre-feature history). Newest first; ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging. Pass ?format=csv to download the page as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-validators",
    "GET",
    "/api/v1/subnets/{netuid}/validators",
    "/metagraph/subnets/{netuid}/validators.json",
    "Fetch the validators (validator_permit) of one subnet ranked by stake, computed live from the neurons D1 tier. Narrow each row to the columns you need with ?fields=hotkey,stake_tao — a comma-separated list of Neuron field names, validated against the published Neuron schema; an unsupported name is a 400. CSV keeps its own fixed column set.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([{ name: "fields", schema: { type: "string" } }]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-yield",
    "GET",
    "/api/v1/subnets/{netuid}/yield",
    "/metagraph/subnets/{netuid}/yield.json",
    "Fetch the per-UID emission yield (emission/stake return rate) for one subnet over the current metagraph snapshot, ranked high to low with a distribution summary (subnet aggregate yield, mean, p25/median/p75/p90 percentiles), a validator/miner split, and a per-UID above/below-median label, computed live from the neurons D1 tier. Pass ?format=csv to download the ranked neuron rows as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery(),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-yield-history",
    "GET",
    "/api/v1/subnets/{netuid}/yield/history",
    "/metagraph/subnets/{netuid}/yield/history.json",
    "Fetch the per-day emission-yield distribution trend for one subnet over a 7d/30d/90d window: the subnet-wide return plus the mean, median, and p25/p75/p90 of the per-UID emission-per-stake yields, one point per day (computed live from the neuron_daily D1 rollup). The time-series companion to /yield and the return-rate twin of /concentration/history. Pass ?format=csv to download the per-day series as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-events",
    "GET",
    "/api/v1/subnets/{netuid}/events",
    "/metagraph/subnets/{netuid}/events.json",
    "Fetch the first-party chain-event stream for one subnet (registrations, stake, weights, axon, delegation, lifecycle, transfers), newest first, from the account_events D1 tier filtered by netuid. Optional ?kind= filter and ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset. Pass ?format=csv to download the page as CSV.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      { name: "kind", schema: { type: "string" } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "subnet-event-summary",
    "GET",
    "/api/v1/subnets/{netuid}/event-summary",
    "/metagraph/subnets/{netuid}/event-summary.json",
    `Fetch a windowed event summary for one subnet: account_events counts by kind and coarse category, distinct hotkey/coldkey counts, TAO/alpha sums where applicable, first/last evidence bounds, plus a newest-first evidence slice. ?window=7d|30d|90d (default 30d); ?limit caps recent_events (default ${SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT}, max ${SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX}). Computed live from the account_events D1 tier.`,
    "short",
    ["subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
        },
      },
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
    "subnet-identity-history",
    "GET",
    "/api/v1/subnets/{netuid}/identity-history",
    "/metagraph/subnets/{netuid}/identity-history.json",
    "Fetch the append-only on-chain identity timeline for one subnet (#1647): each entry is a SubnetIdentitiesV3 snapshot recorded when any tracked field changed. Newest first; ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging. Pass ?format=csv to download the page as CSV. Served from the frozen lakehouse export of subnet_identity_history -- no D1 table backs this route, and the export stops where the capture did, so observed_at on each entry says how current it is.",
    "short",
    ["subnets", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "account-summary",
    "GET",
    "/api/v1/accounts/{ss58}",
    "/metagraph/accounts/{ss58}.json",
    "Fetch a cross-subnet activity summary for one account (hotkey or coldkey): chain-event aggregates joined to its current subnet registrations + stake. Computed live from the account_events lakehouse and the neurons tier -- the same rows /accounts/{ss58}/events and /accounts/{ss58}/subnets serve, so the three cannot disagree. A tier that exists and cannot answer declines with a typed 503 (account_summary_unavailable) rather than an all-zero card, which is indistinguishable from an account with no history.",
    "short",
    ["accounts", "analytics"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-entities",
    "GET",
    "/api/v1/accounts/{ss58}/entities",
    "/metagraph/accounts/{ss58}/entities.json",
    "Fetch one address's community-contributed entity labels plus every subnet-ownership tie it has via the chain_events SubnetOwnerChanged stream (#6737-#6740) — either side of an automatic conviction-contest transfer. Only tracks transfers, not genesis ownership.",
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
    "Fetch the paginated first-party chain-event history for one account (hotkey or coldkey), newest first. Optional ?kind= filter, ?netuid= to scope to one subnet, and ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging (#1851). Pass ?format=csv to download the page as CSV.",
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      { name: "kind", schema: { type: "string" } },
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
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
    "Fetch the extrinsics this account signed (matched by signer), newest first, computed live from the extrinsics D1 tier. Optional ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging. Pass ?format=csv to download the page as CSV.",
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-transfers",
    "GET",
    "/api/v1/accounts/{ss58}/transfers",
    "/metagraph/accounts/{ss58}/transfers.json",
    "Fetch the native-TAO Balances.Transfer feed for one account, newest first, computed live from the account_events D1 tier. ?direction=all|sent|received; optional ?block_start/?block_end (block-height range); ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging. Pass ?format=csv to download the page as CSV.",
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      {
        name: "direction",
        schema: { type: "string", enum: ["all", "sent", "received"] },
      },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-counterparties",
    "GET",
    "/api/v1/accounts/{ss58}/counterparties",
    "/metagraph/accounts/{ss58}/counterparties.json",
    "Fetch the per-counterparty fund-flow rollup for one account — or, with ?counterparty=<ss58>, pair-level native-TAO transfer evidence for one relationship — computed live from the account_events D1 tier. ?counterparty switches the route from ranked list mode into relationship drilldown mode; ?limit is 1-100, default 20 in list mode, and default 50 when ?counterparty is present. Pass ?format=csv to download the list-mode leaderboard as CSV; it's rejected alongside ?counterparty since the drilldown returns a single composite object, not rows.",
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      {
        name: "counterparty",
        schema: {
          type: "string",
          pattern: "^[1-9A-HJ-NP-Za-km-z]{47,48}$",
          description:
            "Optional second SS58 address: switch from the ranked counterparties list to one relationship drilldown (fund-flow totals plus recent transfer evidence). Must differ from ss58.",
        },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Max counterparties to return in list mode (default 20), or max transfer evidence rows in relationship drilldown mode when ?counterparty is present (default 50).",
        },
      },
    ]),
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-stake-flow",
    "GET",
    "/api/v1/accounts/{ss58}/stake-flow",
    "/metagraph/accounts/{ss58}/stake-flow.json",
    "Fetch one account's StakeAdded vs StakeRemoved flow per subnet over a recent window (7d/30d/90d): per-subnet net and gross flow with a direction label (accumulating/exiting/churning/idle), plus account totals, an HHI concentration of where the flow is focused, and the dominant subnet — summed live from the account_events D1 tier. ?direction=all|in|out filters to inflow (StakeAdded) or outflow (StakeRemoved) only; omitted defaults to all.",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "direction",
        schema: { type: "string", enum: ["all", "in", "out"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-stake-moves",
    "GET",
    "/api/v1/accounts/{ss58}/stake-moves",
    "/metagraph/accounts/{ss58}/stake-moves.json",
    "Fetch one account's stake-movement (re-delegation) footprint per subnet over a recent window (7d/30d/90d): each subnet's StakeMoved count with the first and last movement timestamps and the alpha price on the day of the most recent move (from the daily subnet_snapshots rollup), plus account totals, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet — summed live from the account_events D1 tier. The account-level companion to GET /api/v1/chain/stake-moves and GET /api/v1/subnets/{netuid}/stake-moves, distinct from net capital flow in GET /api/v1/accounts/{ss58}/stake-flow.",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-deregistrations",
    "GET",
    "/api/v1/accounts/{ss58}/deregistrations",
    "/metagraph/accounts/{ss58}/deregistrations.json",
    "Fetch one account's neuron-deregistration footprint per subnet over a recent window (7d/30d/90d): each subnet's NeuronDeregistered eviction count with the first and last eviction timestamps, plus account totals, an HHI concentration of where its deregistration activity is focused, and the dominant subnet — DERIVED from UID reuse (the slots where this account was the PREVIOUS holder); NeuronDeregistered has never been emitted by the runtime, the payload's `derivation` block states the lower bound, and `degraded` marks an answer nothing derived. The eviction-side complement to GET /api/v1/accounts/{ss58}/registrations and the account-level companion to GET /api/v1/chain/deregistrations, distinct from GET /api/v1/accounts/{ss58}/subnets (current registration state).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-prometheus",
    "GET",
    "/api/v1/accounts/{ss58}/prometheus",
    "/metagraph/accounts/{ss58}/prometheus.json",
    "Fetch one account's Prometheus-endpoint serving footprint per subnet over a recent window (7d/30d/90d): each subnet's PrometheusServed announcement count with the first and last announcement timestamps, plus account totals, an HHI concentration of where its telemetry activity is focused, and the dominant subnet — read from the account_events PrometheusServed stream, which carries 0 of the 18,041 PrometheusServed events the chain emitted; an empty footprint is marked `degraded` rather than published as a measured zero. Operational activity (announcing a Prometheus telemetry endpoint); the telemetry sibling of GET /api/v1/accounts/{ss58}/serving and the account-level companion to GET /api/v1/chain/prometheus, orthogonal to GET /api/v1/accounts/{ss58}/subnets (registration state).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-axon-removals",
    "GET",
    "/api/v1/accounts/{ss58}/axon-removals",
    "/metagraph/accounts/{ss58}/axon-removals.json",
    "Fetch one account's axon-removal footprint per subnet over a recent window (7d/30d/90d): each subnet's AxonInfoRemoved count with the first and last removal timestamps, plus account totals, an HHI concentration of where its teardown activity is focused, and the dominant subnet — read from the account_events AxonInfoRemoved stream, which the runtime has never populated; an empty footprint is marked `degraded` rather than published as a measured zero. The teardown-side complement to GET /api/v1/accounts/{ss58}/serving (axon announcements) and the account-level companion to GET /api/v1/chain/axon-removals, orthogonal to GET /api/v1/accounts/{ss58}/subnets (registration state).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-serving",
    "GET",
    "/api/v1/accounts/{ss58}/serving",
    "/metagraph/accounts/{ss58}/serving.json",
    "Fetch one account's axon-serving footprint per subnet over a recent window (7d/30d/90d): each subnet's AxonServed announcement count with the first and last announcement timestamps, plus account totals, an HHI concentration of where its serving activity is focused, and the dominant subnet — summed live from the account_events D1 tier. Operational activity (announcing an axon endpoint); the account-level companion to GET /api/v1/chain/serving, orthogonal to GET /api/v1/accounts/{ss58}/subnets (registration state) and GET /api/v1/accounts/{ss58}/registrations (registration events).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-weight-setters",
    "GET",
    "/api/v1/accounts/{ss58}/weight-setters",
    "/metagraph/accounts/{ss58}/weight-setters.json",
    "Fetch one account's (validator's) weight-setting footprint per subnet over a recent window (7d/30d): each subnet's WeightsSet count with the first and last set timestamps, plus account totals, an HHI concentration of where its weight-setting activity is focused, and the dominant subnet — summed live from the account_events D1 tier. Keyed on the hotkey (the validator submitting weights); the account-level companion to GET /api/v1/chain/weights/setters and GET /api/v1/subnets/{netuid}/weights/setters.",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d"] },
      },
    ],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-registrations",
    "GET",
    "/api/v1/accounts/{ss58}/registrations",
    "/metagraph/accounts/{ss58}/registrations.json",
    "Fetch one account's neuron-registration footprint per subnet over a recent window (7d/30d/90d): each subnet's NeuronRegistered count with the first and last registration timestamps, plus account totals, an HHI concentration of where its registration activity is focused, and the dominant subnet — summed live from the account_events D1 tier. Windowed registration events including re-registrations after a deregistration; the account-level companion to GET /api/v1/chain/registrations, distinct from GET /api/v1/accounts/{ss58}/subnets (current registration state).",
    "short",
    ["accounts", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
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
    "account-portfolio",
    "GET",
    "/api/v1/accounts/{ss58}/portfolio",
    "/metagraph/accounts/{ss58}/portfolio.json",
    "Fetch a wallet's cross-subnet neuron portfolio: each position's economics (stake, emission, rank, trust, incentive, dividends, role) and yield, plus aggregates (totals, subnet/validator counts, overall return, stake concentration). Richer than /subnets; computed live from the neurons D1 tier.",
    "short",
    ["accounts", "analytics"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-positions",
    "GET",
    "/api/v1/accounts/{ss58}/positions",
    "/metagraph/accounts/{ss58}/positions.json",
    "Fetch this account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from /portfolio's hotkey-scoped view. Computed live from nominator_positions joined against the neurons D1 tier. Root (netuid 0) stake is not covered.",
    "short",
    ["accounts", "analytics"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-subnet-position-history",
    "GET",
    "/api/v1/accounts/{ss58}/subnets/{netuid}/history",
    "/metagraph/accounts/{ss58}/subnets/{netuid}/history.json",
    "Fetch one wallet's position on one subnet over time (the 'Alpha Holdings chart'): one point per snapshot_date with the position's economics (stake, emission, rank, trust, incentive, dividends, coldkey, role) and yield, computed live from the account_position_daily D1 rollup tier. ?window=7d|30d|90d|1y|all.",
    "short",
    ["accounts", "subnets", "analytics"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d", "1y", "all"] },
      },
    ],
    [
      { name: "ss58", schema: { type: "string" } },
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
    ],
  ),
  route(
    "account-identity",
    "GET",
    "/api/v1/accounts/{ss58}/identity",
    "/metagraph/accounts/{ss58}/identity.json",
    "Fetch the latest-only personal chain identity for one account (epic #4301/5.4), computed live from the account_identity D1 tier. has_identity is false for the common case of an account that never called set_identity.",
    "short",
    ["accounts"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-identity-history",
    "GET",
    "/api/v1/accounts/{ss58}/identity-history",
    "/metagraph/accounts/{ss58}/identity-history.json",
    "Fetch the append-only diff-tracking timeline for one account's personal chain identity (epic #4301/5.2): each entry is a snapshot recorded when any tracked field changed. Newest first; ?limit (<=1000) / ?offset, or ?cursor= for stable keyset paging. Pass ?format=csv to download the page as CSV.",
    "short",
    ["accounts", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
    ]),
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
    "account-root-claim",
    "GET",
    "/api/v1/accounts/{ss58}/root-claim",
    "/metagraph/accounts/{ss58}/root-claim.json",
    "Fetch the live root-claim current state for one Finney ss58 account (#7229) — RootClaimType setting, per-hotkey RootClaimable rates, RootClaimed cumulative watermarks, and RootClaimableThreshold — queried from the finney RPC at request time with 120s KV cache. Returns 400 on invalid ss58; claim_type/hotkeys are null on RPC failure. Read-only display only; never submits claim_root or any other extrinsic.",
    "short",
    ["accounts"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-children",
    "GET",
    "/api/v1/accounts/{ss58}/children",
    "/metagraph/accounts/{ss58}/children.json",
    "Fetch the live child-hotkey delegation graph for one account (#6723, part of the child-hotkey delegation epic #6721) — every child hotkey this account currently delegates stake-weight to, per subnet, queried from the chain's own ChildKeys storage map at request time with 120s KV cache. subnets is null on RPC failure, distinct from a confirmed empty graph.",
    "short",
    ["accounts"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "account-parents",
    "GET",
    "/api/v1/accounts/{ss58}/parents",
    "/metagraph/accounts/{ss58}/parents.json",
    "Fetch the live parent-hotkey delegation graph for one account (#6723, part of epic #6721) — every hotkey currently delegating stake-weight to this account, per subnet, queried from the chain's own ParentKeys storage map at request time with 120s KV cache. subnets is null on RPC failure, distinct from a confirmed empty graph.",
    "short",
    ["accounts"],
    [],
    [{ name: "ss58", schema: { type: "string" } }],
  ),
  route(
    "evm-address-mapping",
    "GET",
    "/api/v1/evm/address/{h160}",
    "/metagraph/evm/address/{h160}.json",
    "Fetch the live H160 -> SS58 address mapping for one EVM address (#6725/#6728), via the AddressMapping EVM precompile's addressMapping(address), queried from the finney RPC at request time with 1h KV cache. ss58 is null on RPC failure.",
    "short",
    ["accounts"],
    [],
    [{ name: "h160", schema: { type: "string" } }],
  ),
  route(
    "sudo-key",
    "GET",
    "/api/v1/sudo/key",
    "/metagraph/sudo/key.json",
    "Fetch the current Sudo::Key holder, queried from the finney RPC at request time with 1h KV cache (re-scoped from the original Senate/Council membership framing — subtensor has no such pallet, #4310). hotkey is null on RPC failure or an unset sudo key. `field_sources` marks hotkey measured and names the storage item behind it (Sudo.Key).",
    "short",
    ["accounts"],
    [],
    [],
  ),
  route(
    "tao-usd",
    "GET",
    "/api/v1/network/tao-usd",
    "/metagraph/network/tao-usd.json",
    "Fetch the TAO/USD index. The TAO/USD index (#9609) -- the current USD price of one TAO with the derivation that produced it, plus the recent series. There is no TAO/USD pair on chain, so this is COMPOSED per ADR 0025 (src/tao-usd-index.ts): a LIQUIDITY-WEIGHTED median across qualifying wTAO/WETH pools, rejecting any pool more than 2% from the unweighted median, refusing to publish below a two-pool quorum, multiplied through an ETH/USDC anchor leg. Composed rather than read from a wTAO/USDC pool deliberately: measured 2026-07-31 all three such pools traded $81k/day combined against WETH/USDC's $118M, ~1,455x deeper, and the thin pools demonstrably misprice -- two well-priced hops beat one badly-priced one. `latest` carries the whole reading together (price, price_basis, eth_usd, block_number, pool_count and the per-pool breakdown) so the number and its audit trail always describe the same block. A NULL usd_per_tao is a STATED OUTCOME, not a gap: the producer writes price_basis `insufficient_pools` when the quorum was not met, and the schema enforces that pairing as a CHECK constraint -- read it as 'not priceable at that block', never as a zero price. ?window=1h|24h|7d|30d (default 24h), newest first, capped at 2000 points; change_usd/change_pct describe the movement across the RETURNED window over PRICED points only, and are null when there is nothing to compare against. point_count and priced_point_count are reported separately: a gap between them is how a window with unpriceable blocks announces itself. THE SERIES BEGINS 2026-08-02 and accrues about one point per minute, so a 30d window today returns everything that exists rather than a month -- `oldest_observed_at` says exactly how far back the answer reaches. Mainnet-only: wrapped TAO on Ethereum has no testnet counterpart.",
    "short",
    ["accounts"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["1h", "24h", "7d", "30d"] },
      },
    ],
    [],
  ),
  route(
    "network-parameters",
    "GET",
    "/api/v1/network/parameters",
    "/metagraph/network/parameters.json",
    "Fetch live global Subtensor protocol/governance parameters (#6343) — TaoWeight, StakeThreshold, PendingChildKeyCooldown — queried from the finney RPC at request time with 300s KV cache. Each field is independently null on its own RPC failure. READ `field_sources` BEFORE CITING ANY VALUE HERE: it labels every field measured (with the storage item behind it) or reconstructed (our arithmetic), and three are reconstructed. `block_emission_tao` and `block_emission_halvings` are derived from TotalIssuance, never read from the `BlockEmission` storage item, which is stale at 1.0 TAO (#8747). `emission_gate_exponent_effective` is the runtime default (3) whenever the storage item is unset, which is its current state on finney — that 3 comes from our source tree, not from chain.",
    "short",
    ["accounts"],
    [],
    [],
  ),
  route(
    "randomness",
    "GET",
    "/api/v1/network/randomness",
    "/metagraph/network/randomness.json",
    "Fetch the live drand randomness-beacon status (#6730/#6731) — LastStoredRound, OldestStoredRound — queried from the finney RPC at request time with 30s KV cache. A current-state snapshot, not a history feed. Each field is independently null on its own RPC failure. `field_sources` marks the two rounds measured (Drand.LastStoredRound / Drand.OldestStoredRound) and `stored_round_span` reconstructed — it is our subtraction of them, not a retention window the beacon publishes.",
    "short",
    ["accounts"],
    [],
    [],
  ),
  route(
    "subnet-recycled",
    "GET",
    "/api/v1/subnets/{netuid}/recycled",
    "/metagraph/subnets/{netuid}/recycled.json",
    "Fetch the live cumulative TAO recycled for registration on one subnet, queried from the chain's own RAORecycledForRegistration storage map at request time with 600s KV cache. recycled_tao is null on RPC failure; a subnet with zero registrations reads back a real 0.",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "subnet-burn",
    "GET",
    "/api/v1/subnets/{netuid}/burn",
    "/metagraph/subnets/{netuid}/burn.json",
    "Fetch the live current registration/burn cost for one subnet (#6321) — the dynamic price between the static min_burn_tao/max_burn_tao bounds already in /subnets/{netuid}/hyperparameters, queried from the chain's own Burn storage map at request time with 120s KV cache. burn_tao is null on RPC failure; a subnet with a genuinely zero burn cost reads back a real 0.",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "subnet-burn-history",
    "GET",
    "/api/v1/subnets/{netuid}/burn/history",
    "/metagraph/subnets/{netuid}/burn-history.json",
    "Fetch one subnet's registration-cost series. One subnet's registration-cost series (#9402) — how SubtensorModule.Burn has moved, captured every 15 minutes into D1 from the same single-call chain read /chain/burn uses. The live routes answer 'what does it cost'; this answers 'is it getting more expensive', which is the question an operator deciding where and WHEN to register actually has. ?window=24h|7d|30d|90d (default 7d), newest first, bounded. change_tao/change_pct describe the movement across the RETURNED window and are null when there is nothing to compare against — a single point has no change, and a change from a zero base has no percentage. A subnet with no recorded prices returns an empty series, never a 404.",
    "short",
    ["subnets"],
    [
      {
        name: "window",
        schema: { type: "string", enum: ["24h", "7d", "30d", "90d"] },
      },
    ],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "subnet-holders",
    "GET",
    "/api/v1/subnets/{netuid}/holders",
    "/metagraph/subnets/{netuid}/holders.json",
    `Fetch who owns one subnet's alpha (#9557) — the top coldkeys by alpha held on that netuid, with each holder's share of the subnet total, how many hotkeys they hold it through, and whole-subnet aggregates (distinct holder count, total measured alpha, top5/top10/top20 concentration). The reverse index of /accounts/{ss58}/positions, which reads the same ledger one coldkey (one account) at a time. Distinct from /subnets/{netuid}/concentration, which computes its scalars off neurons.stake_tao and therefore sees REGISTERED UIDs only: this reads nominator_positions, keyed on (coldkey, hotkey, netuid) whether or not the hotkey holds a UID on the subnet, so alpha staked to UNREGISTERED hotkeys is included — on netuid 74, 92 hotkeys carry positions and 10 are registered there, which is the part no other public source reaches without a full-chain map scan. Valued as share_fraction x hotkey_alpha.total_alpha against ONE proven pool pass, and ranked in ALPHA rather than TAO: within a single subnet alpha is already a common unit, so there is no subnet_snapshots price join and none of its up-to-24h staleness — multiply by the subnet's alpha_price_tao for TAO. limit caps the returned rows (default ${SUBNET_HOLDERS_LIMIT_DEFAULT}, max ${SUBNET_HOLDERS_LIMIT_MAX}); holder_count, total_alpha and the three concentration shares are computed across the FULL holder set and then sliced, never over the capped rows, because the top of a sum is not contained in the union of the tops of its addends. TWO STATES DECLINE rather than answer, both with holders:[] plus a degraded.reason and NULL counts: pool_totals_unproven while no hotkey_alpha pass is recorded complete (a partially loaded pool ledger silently UNDERPRICES holders rather than visibly dropping them, so the ranking would be plausible and wrong), and root_not_in_alpha_map for netuid 0, which SubtensorModule::Alpha does not cover at all. A zero in any count is therefore a measured zero, never a decline. Mainnet-only: neither source table carries a network dimension.`,
    "short",
    ["subnets"],
    [
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: SUBNET_HOLDERS_LIMIT_MAX,
        },
      },
    ],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "chain-holders",
    "GET",
    "/api/v1/chain/holders",
    "/metagraph/chain/holders.json",
    `Fetch every subnet ranked by alpha-ownership concentration. Every subnet ranked by how concentrated its alpha OWNERSHIP is (#9607) — per subnet: the distinct holder count, the measured alpha total, top1/top5/top10/top20 shares, and the largest holder's coldkey (an ss58 address). The cross-subnet companion to /subnets/{netuid}/holders, which answers this one subnet at a time and so costs 129 requests to compare the network. DISTINCT FROM /chain/concentration, which computes Gini/HHI/Nakamoto off neurons.stake_tao and therefore sees REGISTERED UIDs only — on netuid 74 that is 10 of the 92 hotkeys actually carrying positions. This reads the position ledger, so alpha parked on hotkeys holding no UID is measured rather than invisible, and the two routes disagree by design. ALPHA IS NEVER SUMMED ACROSS SUBNETS: each subnet's alpha is a different token, so total_alpha is reported per subnet and the network rollup carries only dimension-free facts — subnets measured, how many have a single account holding a majority, how many have exactly one holder, and the MEDIAN of the top-1 shares. A cross-subnet total requires pricing each subnet's alpha through its own alpha_price_tao first, which is what /accounts/top-holders does. ?sort=top1_share (default), top5_share, top10_share, top20_share, holder_count or total_alpha; a subnet whose share could not be computed sorts LAST rather than reading as the least concentrated. limit caps the returned subnets (default ${CHAIN_HOLDERS_LIMIT_DEFAULT}, max ${CHAIN_HOLDERS_LIMIT_MAX}) and the max sits above the subnet count so ranking the whole network is one request. DECLINES rather than answering while the hotkey_alpha pool ledger has no complete pass — an empty subnets array with degraded.reason pool_totals_unproven and a NULL subnet_count, never a zero one. Mainnet-only: neither source table carries a network dimension.`,
    "short",
    ["chain"],
    [
      {
        name: "sort",
        schema: {
          type: "string",
          enum: [
            "top1_share",
            "top5_share",
            "top10_share",
            "top20_share",
            "holder_count",
            "total_alpha",
          ],
        },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: CHAIN_HOLDERS_LIMIT_MAX,
        },
      },
    ],
    [],
  ),
  route(
    "chain-burn",
    "GET",
    "/api/v1/chain/burn",
    "/metagraph/chain/burn.json",
    "Fetch every subnet's live registration/burn cost in one response, ranked cheapest-first (#9399). Every subnet's live registration/burn cost in ONE response, ranked cheapest-first (#9399). The cross-subnet companion to /subnets/{netuid}/burn, which answers the same question one subnet at a time — 129 requests to compare them all. Served from a single chain read: Burn is an Identity-hashed map, so every key is derivable from its netuid and state_queryStorageAt returns them together. 120s KV cache, matching the per-subnet route (burn moves within minutes during registration bursts). A subnet whose burn is a genuine 0 is included, not dropped. subnet_count is what the chain reports exists (TotalNetworks) and read_count is how many were actually read — a gap between them means the read was partial. NOTE: there is no separate validator-permit price; permits are granted by the StakeThreshold, not purchased.",
    "short",
    ["chain"],
    [],
    [],
  ),
  route(
    "subnet-ownership-history",
    "GET",
    "/api/v1/subnets/{netuid}/ownership-history",
    "/metagraph/subnets/{netuid}/ownership-history.json",
    "Fetch every ownership transfer one subnet has undergone (#6637, part of the conviction/ownership-contest tracker epic #4302) — see docs/conviction-lock-mechanism.md for the on-chain mechanism: a permissionless, conviction-weighted contest that runs continuously for every subnet, where ownership transfers automatically once a challenger's rolled conviction overtakes the incumbent owner's (no vote, no owner cooperation required). Two sources, labelled per record by `source`: `chain-event` records are decoded from the chain_events SubnetOwnerChanged stream and carry the block that emitted them, while `owner-observation` records are inferred from two consecutive owner captures, so their observed_at is when the change was NOTICED and block_number is null. Both are needed because a subnet's owning account can change without that event ever being emitted. observed_through reports how far the observation source covers this subnet at all. Served live from the all-events tier (ADR 0013), falling to the R2 lakehouse reader when that tier cannot answer, no static file. A subnet that has never changed hands returns an empty ownership_changes array, not an error — that's the common case.",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "subnet-conviction",
    "GET",
    "/api/v1/subnets/{netuid}/conviction",
    "/metagraph/subnets/{netuid}/conviction.json",
    "Fetch the live per-subnet conviction leaderboard (#6638, part of the conviction/ownership-contest tracker epic #4302) — who currently holds the most rolled conviction, i.e. how close the subnet is to an automatic ownership flip. Companion to /ownership-history (that's the event log of past flips; this is the current standings). Rolls the current lock state forward using the CURRENT live-queried unlock_rate/maturity_rate — never a hardcoded figure, both are independently governance-adjustable and confirmed to differ from each other. Read from chain storage at request time, no static file. A subnet with no active challengers/owner lock returns an empty leaderboard, not an error — that's the common case.",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "subnet-lease",
    "GET",
    "/api/v1/subnets/{netuid}/lease",
    "/metagraph/subnets/{netuid}/lease.json",
    "Fetch the live subnet-lease state (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717) — whether a subnet is currently under a lease and, if so, its terms + accumulated-but-undistributed alpha dividends, queried from the chain's own SubnetUidToLeaseId/SubnetLeases/AccumulatedLeaseDividends storage maps at request time with 120s KV cache. leased is null (not false) on RPC failure, distinct from a confirmed no-lease (leased:false).",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "crowdloans",
    "GET",
    "/api/v1/crowdloans",
    "/metagraph/crowdloans.json",
    "List every crowdloan the chain has ever opened (#8696), with its terms and how much it raised, queried from the Crowdloan pallet's own NextCrowdloanId/Crowdloans storage at request time with 120s KV cache. Not paginated: the collection is bounded by NextCrowdloanId and fetched in one batched storage read. A dissolved crowdloan is omitted, so crowdloan_count can be lower than next_crowdloan_id. Every crowdloan on finney today is finalized, so this is a record of completed raises rather than a feed of open ones — read `finalized` and `end` rather than assuming liveness.",
    "short",
    ["chain"],
  ),
  route(
    "crowdloan-detail",
    "GET",
    "/api/v1/crowdloans/{crowdloan_id}",
    "/metagraph/crowdloans/{crowdloan_id}.json",
    "Fetch one crowdloan's live state (#8696) from the Crowdloan pallet's Crowdloans storage map at request time with 120s KV cache. exists is null (not false) on RPC failure, distinct from a confirmed-absent id (exists:false) — an id can be legitimately absent because dissolve removes the record while NextCrowdloanId keeps counting.",
    "short",
    ["chain"],
    [],
    [
      {
        name: "crowdloan_id",
        schema: { type: "integer", minimum: 0, maximum: 4294967295 },
      },
    ],
  ),
  route(
    "subnet-lease-history",
    "GET",
    "/api/v1/subnets/{netuid}/lease/history",
    "/metagraph/subnets/{netuid}/lease/history.json",
    "Fetch every SubnetLeaseCreated/SubnetLeaseTerminated event one subnet has had (#6719, part of epic #6717), decoded from the account_events stream #6718 started capturing. Served live from the chain_events lakehouse table, no static file. A subnet that has never been leased returns an empty lease_events array, not an error — that's the common case.",
    "short",
    ["subnets"],
    [],
    [
      {
        name: "netuid",
        schema: { type: "integer", minimum: 0, maximum: 65535 },
      },
    ],
  ),
  route(
    "blocks-feed",
    "GET",
    "/api/v1/blocks",
    "/metagraph/blocks.json",
    "Fetch the recent-block feed (newest first) for the block explorer; ?limit (<=100) / ?offset, or ?cursor= for stable keyset paging under head-of-chain inserts (#1851). A conjunctive (AND-ed) filter set (#1991) narrows the feed: ?author=<ss58>, ?spec_version=<n>, ?from / ?to (observed_at epoch-ms), ?block_start / ?block_end (height range), ?min_extrinsics / ?min_events (non-empty blocks). Pass ?format=csv to download the filtered block rows as CSV. Computed live from the first-party blocks D1 tier (#1345).",
    "short",
    ["blocks", "analytics"],
    csvRouteQuery([
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
    ]),
    [],
  ),
  route(
    "blocks-summary",
    "GET",
    "/api/v1/blocks/summary",
    "/metagraph/blocks/summary.json",
    "Fetch block-production analytics over recent blocks: inter-block time distribution, extrinsic/event throughput, block-author decentralization (concentration over each author's block count), and the spec-version spread. Precomputed by a cron from that network's decoded blocks; schema-stable zeroed card when the projection is cold.",
    "short",
    ["blocks", "analytics"],
    [],
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
    "Fetch the ACCOUNT-ATTRIBUTED events in one block (by numeric block_number or 0x block_hash), in natural order; ?limit (<=1000) / ?offset. This is the curated account_events projection -- a deliberate SUBSET of /api/v1/blocks/{ref}/chain-events (the complete pallet-level stream the block header's event_count counts), narrower by design rather than by loss. 200 with events:[] when cold/unknown.",
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
    "Fetch the recent all-events feed (newest first) from the chain_events lakehouse table — every raw pallet.method event, distinct from the curated account-attributed stream. ?pallet / ?method narrow by event id (1-64 ASCII identifier chars); ?block (+ optional ?extrinsic) scopes to one block or extrinsic; ?cursor is the lossless block_number.event_index keyset cursor and ?before is the legacy block_number-only cursor; ?limit caps the page (<=200, default 50). Pass ?format=csv to download the page as CSV. Each page reads one bounded block window below its ceiling, so a short page still carries a continuation rather than ending the feed. Served live, no static file.",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "pallet", schema: { type: "string", maxLength: 64 } },
      { name: "method", schema: { type: "string", maxLength: 64 } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "extrinsic", schema: { type: "integer", minimum: 0 } },
      {
        name: "cursor",
        schema: {
          type: "string",
          pattern: "^\\d+\\.\\d+$",
          maxLength: 33,
          description:
            "Opaque block_number.event_index cursor returned as next_cursor; both parts are non-negative safe integers.",
        },
      },
      { name: "before", schema: { type: "integer", minimum: 0 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } },
    ]),
    [],
  ),
  route(
    "chain-events-stats",
    "GET",
    "/api/v1/chain-events/stats",
    "/metagraph/chain-events/stats.json",
    "Fetch the chain-activity aggregate — the pallet.method event distribution over the most recent N blocks the decode lane has published — from the chain_events lakehouse table. ?blocks sets the window (default 1000, capped 5000); activity is ordered by count descending (top 100). Backs the get_chain_activity MCP tool. Served live, no static file.",
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
    "Fetch EVERY raw pallet-level event in one block (by numeric block_number; event_index ascending), served live from the live-follow hot tier above the decode seam and the chain_events lakehouse at or below it (no static file). This is the complete stream, so its count matches the block header's own event_count; /api/v1/blocks/{ref}/events is deliberately a SUBSET of it -- the curated account-attributed projection, which is smaller by design and not a loss. A block neither tier can read declines with a typed 503 (block_detail_unavailable) rather than an empty list, because count:0 is indistinguishable from a block that emitted nothing.",
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
    "Fetch the recent-extrinsic feed (newest first) for the block explorer; ?limit (<=100) / ?offset (or ?cursor= for stable keyset paging, #1851) and a conjunctive filter set (#1846): ?block=<n>, ?signer=, ?call_module=, ?call_function=, ?call_hash= (0x-prefixed 64-hex-char decoded call hash, requires ?call_module= to keep the JSON scan scoped — matches a Multisig approval chain's linked calls, #4322), ?success=true|false, ?block_start/?block_end (block range), ?from/?to (observed_at epoch-ms range). Pass ?format=csv to download the filtered extrinsic rows as CSV. Computed live from the first-party extrinsics D1 tier (#1345).",
    "short",
    ["extrinsics", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "signer", schema: { type: "string" } },
      { name: "call_module", schema: { type: "string" } },
      { name: "call_function", schema: { type: "string" } },
      {
        name: "call_hash",
        description:
          "Requires call_module so the decoded call-args JSON scan stays scoped.",
        schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      },
      { name: "success", schema: { type: "string", enum: ["true", "false"] } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "integer", minimum: 0 } },
      { name: "to", schema: { type: "integer", minimum: 0 } },
    ]),
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
    "sudo-calls",
    "GET",
    "/api/v1/sudo",
    "/metagraph/sudo.json",
    "Fetch the root-origin (Sudo pallet) call table, newest first — subtensor has no Council/Senate, so this is the extrinsics feed hardcoded to call_module='Sudo'. ?limit (<=100) / ?offset (or ?cursor= for stable keyset paging) and a conjunctive filter set: ?block=<n>, ?call_function=, ?success=true|false, ?block_start/?block_end (block range), ?from/?to (observed_at epoch-ms range). Pass ?format=csv to download the filtered rows as CSV. Computed live from the first-party extrinsics D1 tier (#4310/2.2).",
    "short",
    ["extrinsics", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "call_function", schema: { type: "string" } },
      { name: "success", schema: { type: "string", enum: ["true", "false"] } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "integer", minimum: 0 } },
      { name: "to", schema: { type: "integer", minimum: 0 } },
    ]),
    [],
  ),
  route(
    "governance-config-changes",
    "GET",
    "/api/v1/governance/config-changes",
    "/metagraph/governance/config-changes.json",
    "Fetch subtensor's own root-origin hyperparameter/network-config change feed, newest first — the extrinsics feed hardcoded to call_module='AdminUtils' (re-scoped from the original Council/Senate framing; subtensor has no such pallet). ?limit (<=100) / ?offset (or ?cursor= for stable keyset paging) and a conjunctive filter set: ?block=<n>, ?call_function= (e.g. sudo_set_tempo), ?success=true|false, ?block_start/?block_end (block range), ?from/?to (observed_at epoch-ms range). Pass ?format=csv to download the filtered rows as CSV. Computed live from the first-party extrinsics D1 tier (#4310/2.3).",
    "short",
    ["extrinsics", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", schema: { type: "integer", minimum: 0 } },
      { name: "cursor", schema: { type: "string" } },
      { name: "block", schema: { type: "integer", minimum: 0 } },
      { name: "call_function", schema: { type: "string" } },
      { name: "success", schema: { type: "string", enum: ["true", "false"] } },
      { name: "block_start", schema: { type: "integer", minimum: 0 } },
      { name: "block_end", schema: { type: "integer", minimum: 0 } },
      { name: "from", schema: { type: "integer", minimum: 0 } },
      { name: "to", schema: { type: "integer", minimum: 0 } },
    ]),
    [],
  ),
  route(
    "network-capabilities",
    "GET",
    "/api/v1/networks",
    "/metagraph/networks.json",
    'List every addressable network and what it actually serves. For each network: its canonical id, chain name, every accepted alias, and the route families it serves, does not serve, or serves partially. Answers "can I get chain data on testnet?" without making a request that fails. Reachable under every network prefix (/api/v1/networks, /api/v1/testnet/networks, /api/v1/local/networks) and identical on all of them — it is the one route that never 404s on any network, because it is how you find out what does.',
    "short",
    ["operations"],
  ),
  route(
    "runtime-versions",
    "GET",
    "/api/v1/runtime",
    "/metagraph/runtime.json",
    'Fetch the spec-version transition timeline — the earliest known block at each distinct runtime spec_version, ascending by block_number. A single aggregate over the whole retained blocks window, nothing to filter or paginate. Every block from genesis to head carries a spec_version reading, so coverage_from_block/coverage_from_at and coverage_gaps describe a complete timeline rather than bounding a partial one. Computed live from the first-party blocks tier (#4316/3.1, #9265). The `current` block (#8702) adds the forward-looking half: live mainnet/testnet spec versions, the latest subtensor release, and a derived pending_upgrade state of none / testnet_soaking / released_undeployed / unknown. Every field is independently null on its own upstream failure, and a missing reading yields "unknown" rather than "none" — the two are opposite answers. No deploy date is predicted anywhere in the payload: the foundation publishes no schedule. Pass ?format=csv to download the transition timeline as CSV (the current_spec_version + coverage_from_* rollup and the `current` block stay JSON-only).',
    "short",
    ["blocks", "analytics"],
    {
      csvResponse: true,
      parameters: [
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the transition timeline as text/csv; `json` (default) keeps the response envelope.",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-activity",
    "GET",
    "/api/v1/chain/activity",
    "/metagraph/chain/activity.json",
    "Fetch daily network-activity aggregates (extrinsic/event/block counts, success rate, unique signers) over a 7d or 30d window, newest day first. Computed live from the first-party chain D1 tiers (#1987); schema-stable day_count:0/days:[] when the store is cold.",
    "short",
    ["chain", "analytics"],
    {
      csvResponse: true,
      parameters: [
        { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the daily activity series as text/csv; `json` (default) keeps the response envelope.",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-calls",
    "GET",
    "/api/v1/chain/calls",
    "/metagraph/chain/calls.json",
    "Fetch the extrinsic call-mix breakdown (count + share per call_module, or call_module/call_function with group_by=module_function) over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. When scoped, total_extrinsics and share use the scoped module denominator. Computed live from the first-party extrinsics D1 tier (#1989); schema-stable call_count:0/calls:[] when cold.",
    "short",
    ["chain", "analytics"],
    {
      csvResponse: true,
      parameters: [
        { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
        {
          name: "group_by",
          schema: { type: "string", enum: ["module", "module_function"] },
        },
        {
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        { name: "call_module", schema: { type: "string", maxLength: 100 } },
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the call-mix rows as text/csv; `json` (default) keeps the response envelope.",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-signers",
    "GET",
    "/api/v1/chain/signers",
    "/metagraph/chain/signers.json",
    "Fetch the windowed most-active-account leaderboard (signers ranked by ?sort=tx_count or ?sort=total_fee_tao, with total fees/tips + newest signed block) over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. Computed live from the first-party extrinsics D1 tier (#1990); schema-stable signer_count:0/signers:[] when cold.",
    "short",
    ["chain", "analytics"],
    {
      csvResponse: true,
      parameters: [
        { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
        {
          name: "sort",
          schema: { type: "string", enum: ["tx_count", "total_fee_tao"] },
        },
        {
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        { name: "call_module", schema: { type: "string", maxLength: 100 } },
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the signer leaderboard as text/csv; `json` (default) keeps the response envelope.",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-transfers",
    "GET",
    "/api/v1/chain/transfers",
    "/metagraph/chain/transfers.json",
    "Fetch network-wide native-TAO transfer analytics over a 7d or 30d window: total Balances.Transfer volume + count, distinct senders/receivers, the top senders and receivers ranked by volume (?limit, <=100), and the top senders' share of total volume. Computed live from the account_events Transfer feed; schema-stable zeros + empty leaderboards when cold. Pass ?format=csv to download the top senders and receivers as one CSV tagged by a `direction` column (the totals + top_sender_share stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-transfer-pairs",
    "GET",
    "/api/v1/chain/transfer-pairs",
    "/metagraph/chain/transfer-pairs.json",
    "Fetch network-wide directed native-TAO transfer-pair analytics over a 7d or 30d window: total pairable Balances.Transfer volume + count, unique sender/receiver pairs, returned pair count, top-pair share, and top sender -> receiver pairs ranked by ?sort=volume or ?sort=count (?limit, <=100). Computed live from the account_events Transfer feed; schema-stable zeros + an empty pairs list when cold. Pass ?format=csv to download the ranked pairs as CSV (the totals + top_pair_share stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      {
        name: "sort",
        schema: { type: "string", enum: ["volume", "count"] },
      },
    ]),
    [],
  ),
  route(
    "chain-stake-flow",
    "GET",
    "/api/v1/chain/stake-flow",
    "/metagraph/chain/stake-flow.json",
    "Fetch network-wide cross-subnet capital flow over a 7d or 30d window: every subnet that moved stake in the window ranked by net StakeAdded minus StakeRemoved TAO (subnets with no stake events in the window are excluded) (biggest net inflow first, ?limit <=100), with per-subnet staked/unstaked/net/gross totals and a direction label, a network rollup, and a distribution (count, mean, min, p25, median, p75, p90, max) of the per-subnet net flow. Computed live from the account_events stake stream; schema-stable zeros + empty leaderboard when cold.",
    "short",
    ["chain", "analytics"],
    {
      csvResponse: true,
      parameters: [
        { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
        {
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the per-subnet capital-flow leaderboard as text/csv; `json` (default) keeps the response envelope (which also carries the network rollup + net-flow distribution).",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-alpha-volume",
    "GET",
    "/api/v1/chain/alpha-volume",
    "/metagraph/chain/alpha-volume.json",
    "Fetch the network-wide rolling 24h buy/sell alpha-volume leaderboard: every subnet that had StakeAdded (buy) or StakeRemoved (sell) volume in the last 24h (subnets with no volume are excluded) ranked by total_volume_tao (biggest market activity first, ?limit <=100), each with the same buy/sell/total volume + sentiment scorecard as GET /api/v1/subnets/{netuid}/volume, plus a network rollup (with its own net/gross sentiment reading) and a distribution (count, mean, min, p25, median, p75, p90, max) of the per-subnet total volume. Computed live from the account_events stream; schema-stable zeros + empty leaderboard when cold. Fixed 24h window (no ?window= param), matching the per-subnet route's own framing.",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-weights",
    "GET",
    "/api/v1/chain/weights",
    "/metagraph/chain/weights.json",
    "Fetch network-wide validator weight-setting activity over a 7d or 30d window across the subnets with observed weight-setting activity (subnets with no WeightsSet events are absent): a per-subnet leaderboard (distinct weight-setting validators, WeightsSet event count, and average updates per validator) ranked by total events, a network rollup with the true distinct setter count (a validator setting weights on several subnets counts once) and total events, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet update intensity. `limit` caps the leaderboard (default 20, max 100). Computed live from the account_events WeightsSet stream; schema-stable empty block when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-weight-setters",
    "GET",
    "/api/v1/chain/weights/setters",
    "/metagraph/chain/weights/setters.json",
    "Fetch the network-wide weight-setter leaderboard over a 7d or 30d window: the individual validators driving consensus across every subnet ranked by activity, each with its total WeightsSet count (summed across every subnet it operates on), its share of the network total, and its first/last set time. `limit` caps the returned page (default 20, max 100); `distinct_setters` always reports the true network-wide total regardless of `limit`. The network-wide companion to GET /api/v1/subnets/{netuid}/weights/setters. Computed live from the account_events WeightsSet stream; schema-stable empty leaderboard when cold. Pass ?format=csv to download the leaderboard as CSV.",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-serving",
    "GET",
    "/api/v1/chain/serving",
    "/metagraph/chain/serving.json",
    "Fetch network-wide axon-serving announcement activity over a 7d or 30d window across the subnets with observed serving activity (subnets with no AxonServed events are absent): a per-subnet leaderboard (AxonServed event count, distinct servers, and average announcements per server) ranked by total announcements, a network rollup with the true distinct server count (a hotkey announcing on several subnets counts once) and total announcements, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-announcement intensity. `limit` caps the leaderboard (default 20, max 100). Computed live from the account_events AxonServed stream; schema-stable empty block when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-axon-removals",
    "GET",
    "/api/v1/chain/axon-removals",
    "/metagraph/chain/axon-removals.json",
    "Fetch network-wide axon-removal activity over a 7d or 30d window across the subnets with observed removal activity (subnets with no AxonInfoRemoved events are absent): a per-subnet leaderboard (AxonInfoRemoved event count, distinct removers, and average removals per remover) ranked by total removals, a network rollup with the true distinct remover count (a hotkey removing an axon on several subnets counts once) and total removals, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-teardown intensity. `limit` caps the leaderboard (default 20, max 100). The teardown-side companion to the axon-announcement GET /api/v1/chain/serving and the network-wide companion to GET /api/v1/subnets/{netuid}/axon-removals. Read from the account_events AxonInfoRemoved stream, which the runtime has never populated; an empty block is marked `degraded` rather than published as a measured zero. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-prometheus",
    "GET",
    "/api/v1/chain/prometheus",
    "/metagraph/chain/prometheus.json",
    "Fetch network-wide Prometheus-endpoint serving activity over a 7d or 30d window across the subnets with observed telemetry activity (subnets with no PrometheusServed events are absent): a per-subnet leaderboard (PrometheusServed event count, distinct exporters, and average announcements per exporter) ranked by total announcements, a network rollup with the true distinct exporter count (a hotkey announcing on several subnets counts once) and total announcements, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-announcement intensity. `limit` caps the leaderboard (default 20, max 100). The telemetry-endpoint companion to the axon-endpoint GET /api/v1/chain/serving — which subnets run observability infrastructure. Read from the account_events PrometheusServed stream, which carries 0 of the 18,041 PrometheusServed events the chain emitted; an empty block is marked `degraded` rather than published as a measured zero. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-registrations",
    "GET",
    "/api/v1/chain/registrations",
    "/metagraph/chain/registrations.json",
    "Fetch network-wide neuron-registration activity over a 7d or 30d window across the subnets with observed registration activity (subnets with no NeuronRegistered events are absent): a per-subnet leaderboard (NeuronRegistered event count, distinct registrants, and average registrations per registrant) ranked by total registrations, a network rollup with the true distinct registrant count (a hotkey registering on several subnets counts once) and total registrations, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-registration intensity. `limit` caps the leaderboard (default 20, max 100). Raw registration demand — the account_events companion to the neuron_daily validator-set churn in GET /api/v1/chain/turnover. Computed live from the account_events NeuronRegistered stream; schema-stable empty block when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-deregistrations",
    "GET",
    "/api/v1/chain/deregistrations",
    "/metagraph/chain/deregistrations.json",
    "Fetch network-wide neuron-deregistration activity over a 7d or 30d window across the subnets with observed deregistration activity (subnets with no NeuronDeregistered events are absent): a per-subnet leaderboard (NeuronDeregistered event count, distinct deregistered hotkeys, and average deregistrations per hotkey) ranked by total deregistrations, a network rollup with the true distinct hotkey count (a hotkey deregistered on several subnets counts once) and total deregistrations, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-deregistration intensity. `limit` caps the leaderboard (default 20, max 100). Raw deregistration/eviction activity — the exit-side companion to GET /api/v1/chain/registrations and the account_events companion to the neuron_daily validator-set churn in GET /api/v1/chain/turnover. DERIVED from UID reuse in the NeuronRegistered stream by a scheduled projection (NeuronDeregistered has never been emitted by the runtime); the payload's `derivation` block states how many window registrations had no observable previous holder, and `degraded` marks an answer nothing derived. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-stake-transfers",
    "GET",
    "/api/v1/chain/stake-transfers",
    "/metagraph/chain/stake-transfers.json",
    "Fetch network-wide stake-transfer activity over a 7d or 30d window across the subnets with observed transfer activity (subnets with no StakeTransferred events are absent): a per-subnet leaderboard (StakeTransferred event count, distinct senders, and average transfers per sender) ranked by total transfers, a network rollup with the true distinct sender count (an account transferring stake out of several subnets counts once) and total transfers, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet transfer intensity. `limit` caps the leaderboard (default 20, max 100). The between-coldkeys companion to the within-account re-delegation churn of GET /api/v1/chain/stake-moves — transfer_stake relocates staked alpha from one account to another on the same hotkey (origin leg only), so it moves ownership, not net capital. Computed live from the account_events StakeTransferred stream; schema-stable empty block when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-stake-moves",
    "GET",
    "/api/v1/chain/stake-moves",
    "/metagraph/chain/stake-moves.json",
    "Fetch network-wide stake-movement (re-delegation) activity over a 7d or 30d window across the subnets with observed movement activity (subnets with no StakeMoved events are absent): a per-subnet leaderboard (StakeMoved event count, distinct movers, and average movements per mover) ranked by total movements, a network rollup with the true distinct mover count (an account moving stake out of several subnets counts once) and total movements, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet re-move intensity. `limit` caps the leaderboard (default 20, max 100). The re-delegation-churn companion to the net-capital-flow GET /api/v1/chain/stake-flow — move_stake relocates stake between hotkeys/subnets without unstaking, so it is churn, not flow. Computed live from the account_events StakeMoved stream; schema-stable empty block when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + intensity distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    ]),
    [],
  ),
  route(
    "chain-fees",
    "GET",
    "/api/v1/chain/fees",
    "/metagraph/chain/fees.json",
    "Fetch fee/tip market analytics — a per-UTC-day fee series (totals, plus averages and exact ordered-offset medians computed over signed extrinsics only) plus a windowed top-fee-payer list — over a 7d or 30d window, optionally scoped to one pallet with ?call_module=. extrinsic_count counts every extrinsic including unsigned inherents; signed_extrinsic_count is the denominator for the averages/medians. Computed live from the first-party extrinsics D1 tier (#1988); schema-stable day_count:0 + empty lists when cold.",
    "short",
    ["chain", "analytics"],
    {
      csvResponse: true,
      parameters: [
        { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
        {
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        { name: "call_module", schema: { type: "string", maxLength: 100 } },
        {
          name: "format",
          description:
            "Response format override. Use `csv` to download the daily fee series as text/csv; `json` (default) keeps the response envelope (which also carries top_fee_payers).",
          schema: { type: "string", enum: ["json", "csv"] },
        },
      ],
    },
    [],
  ),
  route(
    "chain-concentration",
    "GET",
    "/api/v1/chain/concentration",
    "/metagraph/chain/concentration.json",
    "Fetch network-wide stake and emission concentration metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) aggregated across all subnets' neurons over three lenses (per-UID, per-entity with coldkeys collapsed across subnets into the network control distribution, and validator-only consensus power), computed live from the neurons D1 tier; schema-stable nulls when cold.",
    "short",
    ["chain", "analytics"],
    [],
    [],
  ),
  route(
    "chain-performance",
    "GET",
    "/api/v1/chain/performance",
    "/metagraph/chain/performance.json",
    "Fetch network-wide reward-distribution & score-spread metrics aggregated across all subnets' neurons: reward concentration (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) for incentive across all neurons and dividends across validators, plus the p10–p90 spread of the 0–1 trust, consensus, and validator_trust scores, computed live from the neurons D1 tier; schema-stable nulls when cold.",
    "short",
    ["chain", "analytics"],
    [],
    [],
  ),
  route(
    "chain-idle-stake",
    "GET",
    "/api/v1/chain/idle-stake",
    "/metagraph/chain/idle-stake.json",
    "Fetch the network-wide idle-stake rollup: every subnet's own idle-stake scorecard (stake delegated to a currently-zero-dividends hotkey) ranked by idle_stake_alpha descending, plus the network total, computed live from the neurons D1 tier; schema-stable empty ranking when cold.",
    "short",
    ["chain", "analytics"],
    [],
    [],
  ),
  route(
    "chain-identity-history",
    "GET",
    "/api/v1/chain/identity-history",
    "/metagraph/chain/identity-history.json",
    `Fetch the network-wide recent subnet-identity-change feed (newest first) aggregated across all subnets: the most-recent SubnetIdentitiesV3 changes, each carrying the netuid it belongs to plus the same tracked identity fields as the per-subnet identity-history route, capped to ?limit (default ${CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT}, max ${CHAIN_IDENTITY_HISTORY_LIMIT_MAX}) and reporting the distinct subnet_count the feed spans, computed from the frozen lakehouse export of subnet_identity_history; schema-stable empty feed when cold.`,
    "short",
    ["chain", "analytics"],
    [
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
        },
      },
    ],
    [],
  ),
  route(
    "self-health",
    "GET",
    "/api/v1/self-health",
    "/metagraph/self-health.json",
    "metagraphed's OWN uptime: a verdict scoped strictly to our own components (api / site / publish) plus each one's trailing-90-day daily uptime ratios and latest probe state, served from the self_health_daily lakehouse rollup at /api/v1/self-health (no static file). Days with no probe rows are ABSENT, never zero-filled -- a gap means we weren't measuring, not that we were down. Never mixes in third-party subnet-surface health, which is what /api/v1/health covers. The per-component current_ok/http_status/latency_ms/checked_at/note fields are NULL for now, and null here means UNMEASURED, not down: the per-check ticks were written by the indexer box's self-health poller, the box is decommissioned, and only the daily rollup survived it. Synthesizing a current reading from the last frozen tick would state a probe we did not take.",
    "short",
    ["health"],
    [],
    [],
  ),
  route(
    "chain-yield",
    "GET",
    "/api/v1/chain/yield",
    "/metagraph/chain/yield.json",
    "Fetch network-wide emission-yield (return rate) aggregated across all subnets' neurons: the aggregate network return (total emission / total stake), the same split by validator vs miner role, and the count/mean/median/min/max plus p10–p90 spread of the per-neuron emission/stake return, computed live from the neurons D1 tier; schema-stable nulls when cold.",
    "short",
    ["chain", "analytics"],
    [],
    [],
  ),
  route(
    "chain-turnover",
    "GET",
    "/api/v1/chain/turnover",
    "/metagraph/chain/turnover.json",
    "Fetch network-wide validator-set turnover across all subnets between the window's start and end neuron_daily snapshots: a per-subnet leaderboard (validators entered, exited, Jaccard retention, and a 0-100 stability score) ranked by gross churn, a network rollup over the union of every subnet's validator hotkeys, and a distribution summary (count, mean, min, p25, median, p75, p90, max) of the per-subnet stability scores. Sort is fixed to most-volatile-first; limit caps the leaderboard (default 20, max 100). Computed live from the neuron_daily D1 rollup; schema-stable zeros when cold. Pass ?format=csv to download the per-subnet leaderboard as CSV (the network rollup + stability distribution stay JSON-only).",
    "short",
    ["chain", "analytics"],
    csvRouteQuery([
      {
        name: "window",
        schema: { type: "string", enum: ["7d", "30d", "90d"] },
      },
      {
        name: "limit",
        schema: {
          type: "integer",
          minimum: 1,
          maximum: CHAIN_TURNOVER_LIMIT_MAX,
        },
      },
    ]),
    [],
  ),
  route(
    "subnet-uptime",
    "GET",
    "/api/v1/subnets/{netuid}/uptime",
    "/metagraph/subnets/{netuid}/uptime.json",
    "Fetch long-term daily uptime history per operational surface for one subnet over a 90d or 1y window (computed live from the surface_uptime_daily D1 rollup). Pass `min_samples` to drop low-sample day rows (daily probe count below the threshold, including zero-sample 'unknown' days) from the history.",
    "short",
    ["health", "subnets", "analytics"],
    [
      { name: "window", schema: { type: "string", enum: ["90d", "1y"] } },
      { name: "min_samples", schema: { type: "integer", minimum: 0 } },
    ],
    [{ name: "netuid", schema: { type: "integer", minimum: 0 } }],
  ),
  route(
    "registry-leaderboards",
    "GET",
    "/api/v1/registry/leaderboards",
    "/metagraph/registry/leaderboards.json",
    "Fetch registry leaderboards computed live from D1 + registry projections + the economics tier. Operational boards: healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable. Economic opportunity boards (for miners/validators): open-slots, cheapest-registration, highest-emission, validator-headroom, biggest-alpha-gain-1d, biggest-alpha-gain-7d. Omit `board` for all boards.",
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
            "biggest-alpha-gain-1d",
            "biggest-alpha-gain-7d",
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
    "compare-validators",
    "GET",
    "/api/v1/compare/validators",
    "/metagraph/compare/validators.json",
    "Place several validators side by side for a stake/delegate decision: each hotkey's take rate, estimated APY, nominator count, on-chain identity, and cross-subnet stake/emission/trust aggregates. `hotkeys` is a required comma-separated list of 1-16 distinct SS58 validator addresses. `netuid` is an optional subnet context — when set, each validator also carries its membership row in that subnet (or null with no permit there). Composed live (no static file); the validator equivalent of /api/v1/compare.",
    "standard",
    ["validators", "analytics"],
    [
      {
        name: "hotkeys",
        schema: {
          type: "string",
          maxLength: 783,
          pattern:
            "^[1-9A-HJ-NP-Za-km-z]{47,48}(,[1-9A-HJ-NP-Za-km-z]{47,48}){0,15}$",
        },
      },
      { name: "netuid", schema: { type: "integer", minimum: 0 } },
    ],
    [],
  ),
  route(
    "domains",
    "GET",
    "/api/v1/domains",
    "/metagraph/domains.json",
    "Fetch the per-domain rollup overview: every domain/capability tag in the existing 14-tag taxonomy, each with its member subnet count, total stake, total emission share (the sum of the stage-1 price shares, not TAO received), and within-domain emission concentration. Computed live from the subnets index + economics tier (no static file). The aggregation layer over the existing ?domain= filter on /api/v1/subnets.",
    "standard",
    ["subnets", "analytics"],
    [],
    [],
  ),
  route(
    "domain-summary",
    "GET",
    "/api/v1/domains/{tag}/summary",
    "/metagraph/domains/{tag}/summary.json",
    "Fetch one domain/capability tag's own rollup: member subnet count, total stake, total emission share (the sum of the stage-1 price shares, not TAO received), and within-domain emission concentration. `tag` must be one of the 14 fixed domain tags (the same enum ?domain= validates on /api/v1/subnets). Computed live from the subnets index + economics tier (no static file).",
    "standard",
    ["subnets", "analytics"],
    [],
    [
      {
        name: "tag",
        schema: enumSchema(DOMAIN_TAGS),
      },
    ],
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
    listQuery("rpc-pools"),
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
    listQueryWith("incidents", [
      { name: "window", schema: { type: "string", enum: ["7d", "30d"] } },
    ]),
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

/**
 * Every HTTP method the registered routes actually use, derived from
 * {@link API_ROUTES} rather than listed (#9092).
 *
 * The route index publishes each route's method and constrains it against this
 * set. It was a hardcoded `"GET"` literal until POST /api/v1/ask was
 * registered -- the same "every route is a GET" assumption that lived in the
 * OpenAPI drift check and in validate-api's dispatcher, and that kept the
 * AI-native layer out of the contract. Deriving it means adding a route with a
 * new verb updates the constraint by construction.
 *
 * Sorted so the generated contract is stable regardless of declaration order.
 */
export const API_ROUTE_METHODS = [
  ...new Set(API_ROUTES.map((entry) => entry.method)),
].sort() as [string, ...string[]];

// ── feed routes (#8703) ─────────────────────────────────────────────────────
//
// The feed system (src/feeds.ts, #741) shipped complete and undocumented: no
// contract entry, no OpenAPI path, no autodiscovery tag. We built distribution
// infrastructure and then did not distribute it.
//
// WHY THIS IS A SEPARATE REGISTRY AND NOT MORE API_ROUTES ENTRIES. API_ROUTES
// is the ARTIFACT-BACKED route table: workers/api.ts derives its dispatcher
// from it (each entry resolves to an `artifact_path` it serves and wraps in the
// success envelope), and validate-api.ts asserts `checks.length ===
// API_ROUTES.length` over exactly that. Feeds are neither — they are rendered
// live from artifacts by a dedicated handler, and they emit RSS/Atom/JSON Feed
// documents with NO envelope at all. Adding them to API_ROUTES would register
// phantom artifact paths in the dispatcher and break the validator's invariant,
// to describe routes it cannot actually check. So they get their own list,
// surfaced in the contract artifact under `feeds` and in OpenAPI as their own
// paths.
//
// EVERY FAMILY src/feeds.ts SERVES MUST APPEAR HERE. tests/feed-contract.test.ts
// derives the expected set from parseFeedPath itself and fails if one is
// missing, so a future seventh feed cannot ship undocumented the way the first
// six did. That test is why this list is six entries and not the four the issue
// asked for: `watch` was already live and unlisted, and `upgrades` landed in
// #8702.

/** The three feed serializations, as content types. */
export const FEED_CONTENT_TYPES_BY_FORMAT = {
  rss: "application/rss+xml",
  atom: "application/atom+xml",
  json: "application/feed+json",
} as const;

/** Query parameters every feed family accepts. */
const FEED_COMMON_PARAMETERS = [
  {
    name: "tag",
    description:
      "Return only items carrying this tag (e.g. `upgrade`, `incident`, `subnet`). Exact match against the item's `tags` array.",
    schema: { type: "string" },
  },
  {
    name: "since",
    description:
      "Inclusive lower bound on item timestamps, as an ISO-8601 date (`2026-06-01`, a whole UTC day) or date-time with an explicit offset. Malformed values are a 400, never silently ignored.",
    schema: { type: "string" },
  },
  {
    name: "until",
    description:
      "Inclusive upper bound, same format as `since`. A bare date covers the whole named UTC day.",
    schema: { type: "string" },
  },
  {
    name: "limit",
    description: "Maximum items to return (1-50). Defaults to 50.",
    schema: { type: "integer", minimum: 1, maximum: 50 },
  },
];

function feedRoute(
  id: string,
  kind: string,
  pathValue: string,
  description: string,
  extra: {
    pathParameters?: Row[];
    queryParameters?: Row[];
  } = {},
) {
  return {
    id,
    // The FeedTarget kind parseFeedPath resolves this path to. The derived
    // contract test matches on this, not on the path string, so a path rename
    // cannot silently orphan an entry.
    kind,
    method: "GET",
    path: pathValue,
    description,
    cache: "medium",
    tags: ["feeds"],
    formats: ["rss", "atom", "json"],
    path_parameters: extra.pathParameters ?? [],
    query_parameters: [
      ...FEED_COMMON_PARAMETERS,
      ...(extra.queryParameters ?? []),
    ],
  };
}

export const FEED_ROUTES = [
  feedRoute(
    "feed-registry",
    "registry",
    "/api/v1/feeds/registry",
    'The site-wide "what changed" feed: subnets, surfaces, and coverage added, removed, renamed, or updated in the metagraphed registry, plus Bittensor runtime upgrade activity (#8702). Served as RSS 2.0, Atom 1.0, or JSON Feed 1.1 — append `.rss`/`.atom`/`.json`, or negotiate with the `Accept` header on the bare path. Use `?tag=upgrade` to narrow to runtime upgrades alone.',
  ),
  feedRoute(
    "feed-incidents",
    "incidents",
    "/api/v1/feeds/incidents",
    "Operational incidents across Bittensor subnet surfaces — probe-detected downtime only, never hand-authored. Same three serializations and window/tag filters as the registry feed.",
  ),
  feedRoute(
    "feed-gaps",
    "gaps",
    "/api/v1/feeds/gaps",
    "Ranked subnet enrichment targets: missing surfaces, contributor lanes, and the recommended next action for each. The contributor-facing view of registry coverage debt.",
  ),
  feedRoute(
    "feed-upgrades",
    "upgrades",
    "/api/v1/feeds/upgrades",
    "Bittensor runtime upgrade activity (#8702): subtensor releases, observed mainnet/testnet spec-version changes, and BIT documents. Reports observed states only — the foundation publishes no deploy schedule, so this feed carries what has happened and never when something will.",
  ),
  feedRoute(
    "feed-watch",
    "watch",
    "/api/v1/feeds/watch",
    "A personal watchlist feed built entirely from the URL: `?ids=s7,s64` selects subnets by netuid. Registry changes and incidents for the named entities only. There is no server-side subscription — anyone holding the URL sees which entities it tracks, so treat it as unlisted rather than private.",
    {
      queryParameters: [
        {
          name: "ids",
          description:
            "Comma-separated kind-prefixed entities: `s<netuid>` (subnet), `v<hotkey>` (validator), `a<ss58>` (account). Up to 50 per URL (WATCH_MAX_IDS in src/feeds.ts; more is a 413). Validator/account ids are accepted and counted toward that cap but produce no items yet — no change-tracking source exists for them.",
          schema: { type: "string" },
        },
      ],
    },
  ),
  feedRoute(
    "feed-subnet",
    "subnet",
    "/api/v1/feeds/subnets/{netuid}",
    "One subnet's combined feed: its registry changes and its surface incidents, merged chronologically. The per-subnet counterpart to the registry and incidents feeds.",
    {
      pathParameters: [
        {
          name: "netuid",
          description: "Subnet netuid.",
          schema: { type: "integer", minimum: 0 },
        },
      ],
    },
  ),
];

/** The network dimension, shared by the contract artifact and the API index. */
function networkContractBlock() {
  return {
    aliases: NETWORK_ALIASES,
    data_aliases: DATA_NETWORK_ALIASES,
    default: "mainnet",
    path_form: "/api/v1/{network}/...",
    note: "Omit the network segment for mainnet. `finney` aliases `mainnet` and `test` aliases `testnet`. `local` is served but hosts no registry data — it returns a setup pointer for a self-run node.",
    mainnet_only_route_count: MAINNET_ONLY_ROUTE_PATHS.length,
  };
}

/** The feed entries shared by the contract artifact and the API index. */
function feedContractEntries() {
  return FEED_ROUTES.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    method: entry.method,
    path: entry.path,
    description: entry.description,
    formats: entry.formats,
    content_types: entry.formats.map(
      (format) =>
        FEED_CONTENT_TYPES_BY_FORMAT[
          format as keyof typeof FEED_CONTENT_TYPES_BY_FORMAT
        ],
    ),
    public: true,
    path_parameters: entry.path_parameters,
    query_parameters: entry.query_parameters,
  }));
}

// ── network addressing (#8698) ──────────────────────────────────────────────
//
// Multi-network addressing has worked since it shipped — `/api/v1/testnet/...`
// serves testnet data — and openapi.json said nothing about it, so anyone
// generating a typed client from our published spec got one that could not
// address testnet and had no way to learn it existed.
//
// THE ALIAS LIST IS THE ROUTER'S. `NETWORK_ALIASES` below is consumed by both
// the spec generator here and workers/api.ts's own NETWORKS map, and
// tests/network-addressing.test.ts asserts they agree — so adding a network
// without updating the spec fails CI rather than shipping a spec that lies.
//
// WHY A PATH PARAMETER AND NOT A SERVER VARIABLE. Both are legal OpenAPI and
// the issue allows either. Our network segment sits INSIDE the path
// (`/api/v1/testnet/coverage`), while every path in this document already
// carries its own `/api/v1` prefix. Expressing it as a server variable would
// mean moving `/api/v1` out of all 178 paths and into `servers` — a breaking
// reshape of the whole document, and one that also changes every existing
// generated client's method paths. The `{network}` variant is additive: the
// mainnet paths keep their exact current form, and a client that wants testnet
// gets a second, explicitly-enumerated operation.
const NETWORK_ALIASES = ["finney", "local", "mainnet", "test", "testnet"];

// Aliases that address hosted registry DATA. `local` is deliberately excluded:
// it is a per-developer subtensor we cannot enumerate or host, and
// /api/v1/local/... returns a setup pointer rather than registry data.
// Advertising it here would tell a generated client it can fetch subnets from
// it, which is false. It stays served, and documented in prose, but it is not
// offered as a data-bearing target.
const DATA_NETWORK_ALIASES = ["finney", "mainnet", "test", "testnet"];

/**
 * Route templates served on mainnet only.
 *
 * DERIVED, NOT HAND-WRITTEN: produced by running workers/api.ts's own
 * isMainnetOnlyApiPath over every API_ROUTES template, and held to that by
 * tests/network-addressing.test.ts, which fails when the two disagree in
 * either direction. A hand-copied version of this list was wrong by 77 entries
 * on the first attempt, which is exactly why it is proven rather than trusted.
 *
 * 99 of 188 routes. #8700 took 19 out, in two steps.
 *
 * First the 13 LIVE chain-storage routes (burn, recycled, lease, crowdloans,
 * balance, root-claim, children, parents, sudo key, EVM address mapping,
 * network parameters, randomness): their storage keys are chain-agnostic
 * twox128 hashes and testnet runs the same runtime, so only the endpoint was
 * ever mainnet-specific.
 *
 * Then the 6 chain-HISTORY routes (blocks, extrinsics and their
 * sub-resources), once the decode lane began filling `chain_testnet` beside
 * `chain` and the cold-tier readers learned which namespace to read.
 *
 * What remains is mainnet-only because of the DATA behind it — the curated
 * registry, the AI indexes, the D1 hot tier, and the analytics and chain-events
 * families whose readers have no network dimension yet — which is a real
 * constraint rather than a hardcoded endpoint.
 */
export const MAINNET_ONLY_ROUTE_PATHS: readonly string[] = [
  // The AI-native layer (#9092). The embedded corpus and the retrieval index
  // are built from mainnet registry data, so a testnet-addressed question has
  // nothing to answer from. /api/v1/surfaces/{surface_id}/verify is NOT here:
  // it probes a URL off the surface record, which testnet has too.
  "/api/v1/ask",
  "/api/v1/search/semantic",
  // #9402: subnet_burn_history has no network dimension, so a testnet-addressed
  // request would be served MAINNET prices. Declared rather than silently wrong.
  "/api/v1/subnets/{netuid}/burn/history",
  // #9557: nominator_positions and hotkey_alpha are both written by mainnet-only
  // lanes and carry no network column, so a testnet-addressed request would be
  // served MAINNET holders. Same posture as /accounts/{ss58}/positions below,
  // which reads the first of those two tables.
  "/api/v1/subnets/{netuid}/holders",
  // #9607: the cross-subnet twin, reading the same two mainnet-only tables.
  "/api/v1/chain/holders",
  // #9609: wrapped TAO on Ethereum has no testnet counterpart, and the table
  // carries no network column.
  "/api/v1/network/tao-usd",
  "/api/v1/economics/trends",
  "/api/v1/health",
  "/api/v1/subnets/{netuid}/health",
  "/api/v1/health/trends",
  "/api/v1/subnets/{netuid}/health/trends",
  "/api/v1/subnets/{netuid}/health/percentiles",
  "/api/v1/subnets/{netuid}/health/incidents",
  "/api/v1/subnets/{netuid}/trajectory",
  "/api/v1/subnets/{netuid}/concentration",
  "/api/v1/subnets/{netuid}/performance",
  "/api/v1/subnets/{netuid}/idle-stake",
  "/api/v1/subnets/{netuid}/performance/history",
  "/api/v1/subnets/{netuid}/concentration/history",
  "/api/v1/subnets/{netuid}/turnover",
  "/api/v1/subnets/{netuid}/stake-flow",
  "/api/v1/subnets/{netuid}/volume",
  "/api/v1/subnets/{netuid}/ohlc",
  "/api/v1/subnets/{netuid}/stake-quote",
  // Mainnet-only by construction rather than policy: the floors are derived
  // against StakeThreshold, TaoWeight and Burn read out of finney storage at
  // request time, so a testnet-addressed question has nothing to answer from.
  "/api/v1/subnets/{netuid}/validator-economics",
  "/api/v1/subnets/{netuid}/validator-economics/history",
  "/api/v1/validators/economics",
  "/api/v1/subnets/movers",
  "/api/v1/validators",
  "/api/v1/accounts",
  "/api/v1/validators/{hotkey}",
  "/api/v1/validators/{hotkey}/nominators",
  "/api/v1/validators/{hotkey}/history",
  "/api/v1/subnets/{netuid}/metagraph",
  "/api/v1/subnets/{netuid}/neurons/{uid}",
  "/api/v1/subnets/{netuid}/hyperparameters",
  "/api/v1/subnets/{netuid}/validators",
  "/api/v1/subnets/{netuid}/yield",
  "/api/v1/subnets/{netuid}/yield/history",
  "/api/v1/subnets/{netuid}/events",
  "/api/v1/subnets/{netuid}/neurons/{uid}/history",
  "/api/v1/subnets/{netuid}/history",
  "/api/v1/subnets/{netuid}/identity-history",
  "/api/v1/accounts/{ss58}",
  "/api/v1/accounts/{ss58}/entities",
  "/api/v1/accounts/{ss58}/events",
  "/api/v1/accounts/{ss58}/history",
  "/api/v1/accounts/{ss58}/extrinsics",
  "/api/v1/accounts/{ss58}/transfers",
  "/api/v1/accounts/{ss58}/counterparties",
  "/api/v1/accounts/{ss58}/stake-flow",
  "/api/v1/accounts/{ss58}/stake-moves",
  "/api/v1/accounts/{ss58}/deregistrations",
  "/api/v1/accounts/{ss58}/prometheus",
  "/api/v1/accounts/{ss58}/axon-removals",
  "/api/v1/accounts/{ss58}/serving",
  "/api/v1/accounts/{ss58}/weight-setters",
  "/api/v1/accounts/{ss58}/registrations",
  "/api/v1/accounts/{ss58}/subnets",
  "/api/v1/accounts/{ss58}/portfolio",
  "/api/v1/accounts/{ss58}/positions",
  "/api/v1/accounts/{ss58}/subnets/{netuid}/history",
  "/api/v1/accounts/{ss58}/identity",
  "/api/v1/accounts/{ss58}/identity-history",
  "/api/v1/sudo",
  "/api/v1/governance/config-changes",
  "/api/v1/runtime",
  "/api/v1/chain/weights",
  "/api/v1/chain/weights/setters",
  "/api/v1/chain/serving",
  "/api/v1/chain/axon-removals",
  "/api/v1/chain/prometheus",
  "/api/v1/chain/concentration",
  "/api/v1/chain/performance",
  "/api/v1/chain/idle-stake",
  "/api/v1/chain/identity-history",
  "/api/v1/self-health",
  "/api/v1/chain/yield",
  "/api/v1/chain/turnover",
  "/api/v1/subnets/{netuid}/uptime",
  "/api/v1/registry/leaderboards",
  "/api/v1/compare",
  "/api/v1/compare/validators",
  "/api/v1/domains",
  "/api/v1/domains/{tag}/summary",
  "/api/v1/rpc/usage",
  "/api/v1/incidents",
];

// Parameters whose value space is finite and enumerable at build time. Anything
// else makes an artifact unbakeable BY DEFINITION rather than by effort -- the
// key space of {ref}/{ss58}/{hash}/{uid}/{h160} is every block, account,
// extrinsic and address that has ever existed.
const BOUNDED_ARTIFACT_PARAMS: ReadonlySet<string> = new Set(["netuid", "tag"]);

/**
 * Artifact path template -> the live route that answers it, for artifacts that
 * are computed live AND unbounded, i.e. the ones for which NO file is ever
 * written at any key.
 *
 * Both halves of that predicate matter. `computed` alone is not enough: a
 * computed artifact whose parameters are bounded ({netuid}, {tag}) IS baked to
 * R2 by scripts/bake-computed-artifacts.ts and must still be read from there.
 * It is the unbounded ones that no build can ever produce.
 *
 * DERIVED from the two contracts above rather than listed, for the same reason
 * COMPUTED_ARTIFACT_IDS is: a third hand-maintained list is how a route gets
 * renamed and leaves a stale orphan behind.
 */
const LIVE_ONLY_ARTIFACT_ROUTES: ReadonlyMap<string, string> = new Map(
  PUBLIC_ARTIFACTS.filter(
    (entry) =>
      entry.computed &&
      [...entry.path.matchAll(/\{(\w+)\}/g)].some(
        (m) => !BOUNDED_ARTIFACT_PARAMS.has(m[1]!),
      ),
  ).flatMap((entry) => {
    const live = API_ROUTES.find((r) => r.artifact_path === entry.path);
    return live ? [[entry.path, live.path] as [string, string]] : [];
  }),
);

/**
 * The live route serving this artifact path, when the artifact is computed live
 * with unbounded parameters -- otherwise null.
 *
 * A caller that gets a route back should NOT read R2 for the artifact: nothing
 * has ever written it, and nothing ever will. `/metagraph/blocks/{ref}.json` is
 * the case that made this worth having -- every request for it cost one R2
 * GetObject miss (two when the pointer names a run prefix) before answering the
 * 404 that was knowable without asking, and the site's own block pages link it,
 * so crawlers walk it continuously (#9485).
 */
export function liveOnlyArtifactRoute(artifactPath: string): string | null {
  return LIVE_ONLY_ARTIFACT_ROUTES.get(artifactPath) ?? null;
}

const MAINNET_ONLY_ROUTE_SET = new Set(MAINNET_ONLY_ROUTE_PATHS);

/** Is this route template mainnet-only? */
export function isMainnetOnlyRouteTemplate(path: string): boolean {
  return MAINNET_ONLY_ROUTE_SET.has(path);
}

/** The network-addressable form of a template, or null when there is none. */
export function networkVariantPath(path: string): string | null {
  if (!path.startsWith("/api/v1")) return null;
  if (isMainnetOnlyRouteTemplate(path)) return null;
  return `/api/v1/{network}${path.slice("/api/v1".length)}`;
}

export { NETWORK_ALIASES, DATA_NETWORK_ALIASES };

export function buildContractsArtifact(generatedAt: string) {
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
      // Lifecycle (#6358): a retired entry always refuses the read, so a
      // consumer must not treat it as fetchable. `retirement` carries the
      // response the route actually returns; it is null for a live artifact.
      status: entry.status,
      retirement: entry.retirement,
    })),
    // #8703: the feed system, in the machine-readable contract for the first
    // time. Deliberately its own key rather than folded in with the artifact
    // list -- a feed is rendered live and emits RSS/Atom/JSON Feed, not a
    // stored artifact wrapped in the success envelope, and an agent that
    // treated one like the other would parse XML as JSON.
    feeds: feedContractEntries(),
    // #8698: the network dimension belongs in BOTH machine-readable surfaces —
    // this contract (what MCP agents read) and the API index (what route
    // consumers read). They are generated from the same constants, so they
    // cannot disagree.
    networks: networkContractBlock(),
  };
}

export function buildApiIndexArtifact(
  generatedAt: string,
  contractsArtifact: ReturnType<typeof buildContractsArtifact>,
) {
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    generated_at: generatedAt,
    primary_domain: PRIMARY_DOMAIN,
    base_path: API_BASE_PATH,
    // The RAW artifact, not `${API_BASE_PATH}/openapi.json`.
    //
    // Both routes serve the spec, but the /api/v1 one wraps it in the standard success
    // envelope — correct per the envelope rule, and unusable as an OpenAPI document,
    // since the result has no top-level `openapi` key. This index advertised the
    // wrapped one while /api/v1/contracts advertised the raw one, so the two pointers
    // disagreed and the more prominent one broke every generator that followed it.
    openapi_url: `${ARTIFACT_BASE_PATH}/openapi.json`,
    type_definitions_url: TYPE_DEFINITIONS_PATH,
    response_envelope: {
      schema_version: SCHEMA_VERSION,
      fields: ["ok", "data", "meta", "error"],
      success_schema_ref: "#/components/schemas/SuccessEnvelope",
      error_schema_ref: "#/components/schemas/ErrorEnvelope",
      notes:
        "Worker API routes wrap canonical /metagraph artifacts without changing artifact truth.",
    },
    // #8703: the same feed entries the contract artifact carries, so the
    // agent-facing index and the contract cannot describe different feeds.
    feeds: feedContractEntries(),
    // #8698: the network dimension, so an MCP agent reading this contract
    // learns testnet exists and which routes it covers — the same facts the
    // OpenAPI document now carries, for the consumer that reads JSON instead.
    networks: networkContractBlock(),
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
      // #8698: per-route, so a consumer does not have to cross-reference a
      // separate list to know whether a route answers on testnet.
      mainnet_only: isMainnetOnlyRouteTemplate(entry.path),
      networks: isMainnetOnlyRouteTemplate(entry.path)
        ? ["mainnet"]
        : DATA_NETWORK_ALIASES,
    })),
    artifact_contracts: contractsArtifact.artifacts.map((entry) => ({
      id: entry.id,
      path: entry.path,
      contract_version: entry.contract_version,
      schema_ref: entry.schema_ref,
      storage_tier: entry.storage_tier,
      // Carried here too (#6358): this index is the agent-facing catalog, so it
      // must not advertise a retired artifact as fetchable either.
      status: entry.status,
      retirement: entry.retirement,
    })),
  };
}

/** The 200 response schema for a route: the success envelope, narrowed to the
 * route's own artifact component. Shared by the example registry below and the
 * path emitter, so the example a route ships is sampled from exactly the schema
 * that route advertises — not a second, separately-built copy of it. */
function openApiResponseSchemaForRoute(entry: (typeof API_ROUTES)[number]) {
  return {
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
}

// ── worked examples live in components.examples, not inline (#8763) ─────────
//
// Every operation ships a deterministic, schema-valid worked response example.
// Those examples are POINTED AT rather than inlined: each distinct one is
// written once into `components.examples`, and every media type that shows it
// carries `examples: { <name>: { $ref } }` instead of its own `example:` copy.
//
// WHY. An example is a PURE FUNCTION of the response schema
// (openApiExampleForRoute -> sampleFromSchema), so any two routes wrapping the
// same artifact component sample byte-identically — and a network-addressed
// variant (#8698) is an exact second copy of its base route's whole operation.
// Inlining meant serializing the same blob once per route that showed it: 335
// media types carrying 211 distinct examples, ~94 KB of duplicate JSON in a
// document we ask clients to download.
//
// `examples` is also the shape OpenAPI 3.1 prefers — singular `example` is
// deprecated — so this moves toward the standard rather than away from it, and
// it is the branch fumadocs-openapi's response renderer checks FIRST (it
// resolves each entry through its own `$ref` resolver before reading `.value`).
//
// NAMING. A JSON example is named for the artifact component it demonstrates
// (`CoverageArtifactResponse` for `CoverageArtifact`) because that is what it
// is — the sample of that schema — which keeps the name stable for exactly as
// long as the component is. Two components that happen to sample identically
// deliberately keep two entries: collapsing them would file `RpcPoolsArtifact`'s
// example under `EndpointPoolsArtifactResponse` and make the document lie about
// what the reader is looking at, to save 3 KB. A CSV example has no schema to
// be named after (`type: string` is the whole schema), so those group by
// content and take the alphabetically-first operationId in the group —
// alphabetical rather than route order, so adding a route can never silently
// rename an entry that already shipped.
const OPENAPI_EXAMPLES_REF_PREFIX = "#/components/examples/";

/** The `examples` map a media type carries in place of an inline `example`. */
function exampleRef(name: string) {
  return { [name]: { $ref: `${OPENAPI_EXAMPLES_REF_PREFIX}${name}` } };
}

type OpenApiExampleRegistry = {
  /** The `components.examples` block: one entry per distinct worked example. */
  examples: Row;
  /** Route id -> the `components.examples` key holding its JSON example. */
  jsonNameByRouteId: Map<string, string>;
  /** Route id -> the `components.examples` key holding its CSV example. */
  csvNameByRouteId: Map<string, string>;
};

/**
 * Build the hoisted example set for every route, before any path is emitted.
 *
 * Two passes rather than one because a CSV example cannot be named until its
 * whole content group is known — the name is the alphabetically-first
 * operationId that shows it, which is not knowable while still walking routes.
 *
 * `routes` is injectable so the collision guard below can be exercised: it is
 * reachable (see the guard's own comment), and a test proves it fires rather
 * than the code merely asserting it never will.
 */
export function buildOpenApiExampleRegistry(
  componentSchemas: Row,
  routes: readonly (typeof API_ROUTES)[number][] = API_ROUTES,
): OpenApiExampleRegistry {
  const examples: Row = {};
  const jsonNameByRouteId = new Map<string, string>();
  const csvNameByRouteId = new Map<string, string>();
  const csvOperationIdsByContent = new Map<string, string[]>();
  const csvContentByRouteId = new Map<string, string>();

  for (const entry of routes) {
    const name = `${schemaRefForArtifactPath(entry.artifact_path)}Response`;
    const value = openApiExampleForRoute(
      entry,
      openApiResponseSchemaForRoute(entry),
      componentSchemas,
    );
    const existing = examples[name] as { value: unknown } | undefined;
    // One component, one worked example. The sampler is deterministic, so two
    // routes on the same component disagreeing means the example stopped being
    // a function of the schema — a silent contract bug that would otherwise
    // surface as one route's example quietly overwriting another's.
    //
    // Reachable, not theoretical: openApiExampleForRoute overrides the sampled
    // value for `fixture-detail`, so a second route added on that same artifact
    // path would produce two different values under one name. Failing loudly
    // beats silently publishing whichever route was walked last.
    if (existing && JSON.stringify(existing.value) !== JSON.stringify(value)) {
      throw new Error(
        `OpenAPI example collision: ${name} was generated with two different values (route ${entry.id})`,
      );
    }
    examples[name] = { value };
    jsonNameByRouteId.set(entry.id, name);

    if (!entry.csv_response) {
      continue;
    }
    const csv = csvExampleForRoute(entry);
    const operationIds = csvOperationIdsByContent.get(csv);
    if (operationIds) {
      operationIds.push(openApiOperationId(entry.id));
    } else {
      csvOperationIdsByContent.set(csv, [openApiOperationId(entry.id)]);
    }
    csvContentByRouteId.set(entry.id, csv);
  }

  const csvNameByContent = new Map<string, string>();
  for (const [csv, operationIds] of csvOperationIdsByContent) {
    const first = [...operationIds].sort()[0] as string;
    const name = `${first.charAt(0).toUpperCase()}${first.slice(1)}Csv`;
    csvNameByContent.set(csv, name);
    examples[name] = { value: csv };
  }
  for (const [routeId, csv] of csvContentByRouteId) {
    csvNameByRouteId.set(routeId, csvNameByContent.get(csv) as string);
  }

  return { examples, jsonNameByRouteId, csvNameByRouteId };
}

/** The operationId for a route id — the same camelCase form every path emits. */
function openApiOperationId(routeId: string) {
  return routeId.replace(/[^a-z0-9]+([a-z0-9])/gi, (_, character: string) =>
    character.toUpperCase(),
  );
}

/**
 * Default descriptions for the query parameters that mean the same thing on
 * every route (#9131).
 *
 * 942 of the 1,327 query parameters we publish carried no description at all,
 * and they were not the obscure tail -- `limit` (134 operations), `cursor`
 * (77), `fields` (68) and `offset` had none, while `format` and `network` had
 * one on every single operation. The reason is mechanical: `format`'s were
 * hand-written inline, one per route, so the parameters nobody wanted to type
 * 134 times went undocumented.
 *
 * Writing them inline would mean ~480 more hand-maintained strings that go
 * stale the moment a behaviour changes -- the failure #9127 just fixed for the
 * `limit` ceiling. These parameters have one meaning, so they get one
 * description, applied at emit time to both parameter sites.
 *
 * An inline `description` always wins: a route that needs to say something
 * specific keeps saying it, and none of the existing 385 change.
 */
export const SHARED_QUERY_PARAMETER_DESCRIPTIONS: Record<
  string,
  (parameter: {
    schema?: { maximum?: number; minimum?: number; enum?: unknown[] };
  }) => string
> = {
  limit: (parameter) => {
    const maximum = parameter.schema?.maximum;
    // The ceiling is read off the parameter's own schema rather than restated,
    // so it follows route-limits.ts wherever a route sets a different one.
    return (
      "Maximum number of rows to return in one page" +
      (typeof maximum === "number" ? ` (at most ${maximum})` : "") +
      ". Routes differ in how they handle a larger value: some reject it with " +
      "400 `invalid_query`, others clamp to the maximum and answer 200. Read " +
      "the `limit` echoed in the response body rather than assuming the page " +
      "is the size you asked for."
    );
  },
  offset: () =>
    "Number of rows to skip before the page begins. Correct only in " +
    "combination with the page size the response actually returned -- prefer " +
    "`cursor` for anything beyond the first few pages, since a row inserted " +
    "mid-scan shifts every later offset.",
  cursor: () =>
    "Opaque keyset pagination token. Echo the `next_cursor` from the previous " +
    "response back VERBATIM -- it encodes an internal sort position, not a " +
    "row number, so it must never be constructed, incremented, parsed or " +
    "compared. Omit it for the first page; a response with no `next_cursor` " +
    "is the last page.",
  window: (parameter) => {
    const values = parameter.schema?.enum;
    // The allowed windows differ per route (7d/30d, +90d, +1y/all), so they
    // are read off the schema rather than restated -- the MEANING is what is
    // shared, and it is what was missing.
    return (
      "Trailing lookback window the response is computed over, ending at the " +
      "most recent data point rather than at today" +
      (Array.isArray(values) && values.length
        ? `. Accepts ${values.map((value) => `\`${String(value)}\``).join(", ")}`
        : "") +
      ". A longer window is not a superset of a shorter one -- rankings and " +
      "rates are recomputed over the whole window, not summed."
    );
  },
  netuid: () =>
    "Subnet id (netuid). `0` is the root subnet -- a stake-allocation " +
    "construct rather than a running subnet. It IS present in the registry " +
    "collections, but it is excluded from application-subnet counts, and " +
    "stake on it is denominated in TAO rather than in a subnet alpha token, " +
    "so its economics are not directly comparable to a running subnet's.",
  q: () =>
    "Free-text search query, matched case-insensitively against the " +
    "collection's indexed text fields. Whitespace-separated terms narrow the " +
    "result (AND), and an empty or whitespace-only value is treated as no " +
    "filter rather than as a search matching nothing.",
  fields: () =>
    "Comma-separated allow-list projecting the response's primary row " +
    "collection down to just these fields. A response carrying several " +
    "collections projects only the primary one -- the others keep their full " +
    "shape. An unrecognised field is a 400 `invalid_query` naming both the " +
    "field and the collection it was resolved against, rather than being " +
    "ignored.",
};

/**
 * One query parameter as OpenAPI emits it, with a shared description filled in
 * when the route did not give it one of its own.
 */
function withSharedParameterDescription<T extends object>(parameter: T): T {
  const spec = parameter as {
    name?: unknown;
    description?: unknown;
    schema?: { maximum?: number; minimum?: number; enum?: unknown[] };
  };
  if (typeof spec.name !== "string" || spec.description) return parameter;
  const shared = SHARED_QUERY_PARAMETER_DESCRIPTIONS[spec.name];
  return shared
    ? { ...parameter, description: shared({ schema: spec.schema }) }
    : parameter;
}

export function buildOpenApiArtifact(
  generatedAt: string,
  componentSchemas: Row | null,
) {
  if (!componentSchemas) {
    throw new Error(
      "buildOpenApiArtifact requires canonical component schemas from schemas/api-components.schema.json",
    );
  }

  const exampleRegistry = buildOpenApiExampleRegistry(componentSchemas);

  const paths: Row = {};
  for (const entry of API_ROUTES) {
    const openApiPath = entry.path;
    const responseSchema = openApiResponseSchemaForRoute(entry);
    const successContent = {
      "application/json": {
        schema: responseSchema,
        // Deterministic worked example (schema-valid, no live data) so
        // Swagger UI + agents see a concrete response shape. Generated
        // from the schema and hoisted into components.examples (see above);
        // enforced by validate-openapi-examples.
        examples: exampleRef(
          exampleRegistry.jsonNameByRouteId.get(entry.id) as string,
        ),
      },
      ...(entry.csv_response
        ? {
            "text/csv": {
              schema: { type: "string" },
              examples: exampleRef(
                exampleRegistry.csvNameByRouteId.get(entry.id) as string,
              ),
            },
          }
        : {}),
    };
    // #8698: a consumer must be able to tell from the SPEC ALONE that a route
    // does not exist on testnet, without issuing a request and reading a 404.
    const mainnetOnly = isMainnetOnlyRouteTemplate(entry.path);
    const networkExtension = mainnetOnly
      ? {
          "x-metagraphed-networks": ["mainnet"],
          "x-metagraphed-mainnet-only": true,
        }
      : { "x-metagraphed-networks": DATA_NETWORK_ALIASES };

    paths[openApiPath] = {
      ...(paths[openApiPath] || {}),
      [entry.method.toLowerCase()]: {
        ...networkExtension,
        operationId: openApiOperationId(entry.id),
        summary: entry.description,
        tags: entry.tags,
        parameters: [
          ...entry.path_parameters.map((parameter) => ({
            ...parameter,
            in: "path",
            required: true,
          })),
          ...entry.query_parameters.map((parameter) => ({
            ...withSharedParameterDescription(parameter),
            in: "query",
            required: false,
          })),
        ],
        // Omitted entirely rather than emitted empty for the 180 GET routes
        // that have none -- an empty requestBody is a claim, not an absence.
        ...(entry.request_body_schema
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      $ref: `#/components/schemas/${entry.request_body_schema}`,
                    },
                  },
                },
              },
            }
          : {}),
        responses: {
          200: {
            description: entry.csv_response
              ? csvResponseDescriptionForRoute(entry)
              : "Canonical artifact wrapped in the Metagraphed API envelope.",
            headers: apiResponseHeaders(),
            content: successContent,
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

    // #8698: the network-addressable twin. Same operation, one extra required
    // path parameter whose enum comes from the router's own alias set — so a
    // generated client can call GET /api/v1/testnet/coverage, which it
    // previously had no way to even discover.
    const variantPath = networkVariantPath(entry.path);
    if (variantPath) {
      const base = paths[openApiPath][entry.method.toLowerCase()];
      paths[variantPath] = {
        ...(paths[variantPath] || {}),
        [entry.method.toLowerCase()]: {
          ...base,
          operationId: `${base.operationId}ByNetwork`,
          summary: `${entry.description}`,
          description:
            "Network-addressed form of the route above. `mainnet`/`finney` return the same data as the unprefixed path; `testnet`/`test` return testnet data.",
          parameters: [
            {
              name: "network",
              in: "path",
              required: true,
              description:
                "Network to address. `mainnet` and `finney` are the same network, as are `testnet` and `test`.",
              schema: { type: "string", enum: DATA_NETWORK_ALIASES },
            },
            /* v8 ignore next -- defensive: `base` is the operation built above
               in this same loop, which always assigns `parameters` an array
               literal (empty when the route has no path/query parameters), and
               an empty array is truthy -- so the fallback is unreachable. It
               stays because spreading an absent `parameters` would throw, not
               degrade, if that construction ever became conditional. */
            ...(base.parameters || []),
          ],
        },
      };
    }
  }

  // #8703: the feed routes, modeled as their own paths.
  //
  // HOW THESE ARE MODELED, AND WHY. A feed response is NOT the success envelope
  // every API_ROUTES entry returns -- it is an RSS/Atom/JSON Feed document. So
  // these paths deliberately do not reference SuccessEnvelope, and their 200
  // content is the real media type with a `string` schema. OpenAPI 3.1 has no
  // way to describe an XML document's grammar short of inlining a schema that
  // would be fiction, and claiming `application/json` for an RSS body would be
  // worse than saying less: a generated client would parse XML as JSON.
  //
  // Each family emits FOUR paths: the bare path, which content-negotiates all
  // three serializations via `Accept`, plus one path per `.rss`/`.atom`/`.json`
  // suffix pinned to exactly one media type. Both are real, and the suffix form
  // is what feed readers actually request -- documenting only the negotiated
  // path would hide the URLs users paste, and documenting only the suffixes
  // would hide that `Accept` works at all.
  for (const feed of FEED_ROUTES) {
    const parameters = [
      ...feed.path_parameters.map((parameter) => ({
        ...parameter,
        in: "path",
        required: true,
      })),
      ...feed.query_parameters.map((parameter) => ({
        ...withSharedParameterDescription(parameter),
        in: "query",
        required: false,
      })),
    ];
    const feedResponses = (contentTypes: readonly string[]) => ({
      200: {
        description:
          "The feed document. Cached for 10 minutes and ETagged; a matching `If-None-Match` yields 304.",
        headers: apiResponseHeaders(),
        content: Object.fromEntries(
          contentTypes.map((contentType) => [
            contentType,
            { schema: { type: "string" } },
          ]),
        ),
      },
      304: {
        description: "ETag matched and the cached feed is still valid.",
      },
      400: {
        description:
          "A `since`/`until`/`limit`/`ids` parameter was malformed. Feeds reject these rather than ignoring them.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
    });

    const allContentTypes = feed.formats.map(
      (format) =>
        FEED_CONTENT_TYPES_BY_FORMAT[
          format as keyof typeof FEED_CONTENT_TYPES_BY_FORMAT
        ],
    );
    const operationId = (suffix: string) =>
      `${feed.id}${suffix}`.replace(/[^a-z0-9]+([a-z0-9])/gi, (_, character) =>
        character.toUpperCase(),
      );

    paths[feed.path] = {
      ...(paths[feed.path] || {}),
      get: {
        operationId: operationId(""),
        summary: feed.description,
        description:
          "Content-negotiated: send `Accept: application/rss+xml`, `application/atom+xml`, or `application/feed+json`. JSON Feed is the default when nothing matches.",
        tags: feed.tags,
        parameters,
        responses: feedResponses(allContentTypes),
      },
    };

    for (const format of feed.formats) {
      const contentType =
        FEED_CONTENT_TYPES_BY_FORMAT[
          format as keyof typeof FEED_CONTENT_TYPES_BY_FORMAT
        ];
      const suffixPath = `${feed.path}.${format}`;
      paths[suffixPath] = {
        ...(paths[suffixPath] || {}),
        get: {
          operationId: operationId(`-${format}`),
          summary: `${feed.description}`,
          description: `Always returns \`${contentType}\`, regardless of \`Accept\`.`,
          tags: feed.tags,
          parameters,
          responses: feedResponses([contentType]),
        },
      };
    }
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
      // Every worked response example, once each — referenced by the media
      // types above rather than repeated into them. See the naming note on
      // buildOpenApiExampleRegistry.
      examples: exampleRegistry.examples,
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

const FIXTURE_DETAIL_OPENAPI_EXAMPLE = {
  schema_version: 1,
  generated_at: "1970-01-01T00:00:00.000Z",
  surface_id: "7:subnet-api:new_v2",
  netuid: 7,
  subnet_slug: "allways",
  subnet_name: "AllWays",
  kind: "subnet-api",
  captured_at: "2026-06-16T12:00:00.000Z",
  request: { method: "GET", url: "https://api.all-ways.io/health" },
  response: {
    status: 200,
    content_type: "application/json",
    body: { ok: true },
  },
};

function openApiExampleForRoute(
  entry: (typeof API_ROUTES)[number],
  responseSchema: Row,
  componentSchemas: Row,
) {
  const example = sampleFromSchema(responseSchema, componentSchemas) as Row;
  if (entry.id !== "fixture-detail") {
    return example;
  }
  return {
    ...example,
    data: FIXTURE_DETAIL_OPENAPI_EXAMPLE,
    meta: {
      artifact_path: "/metagraph/fixtures/7:subnet-api:new_v2.json",
      cache: "standard",
      contract_version: CONTRACT_VERSION,
      generated_at: FIXTURE_DETAIL_OPENAPI_EXAMPLE.generated_at,
      published_at: null,
      source: "r2",
    },
  };
}

export function artifactPathFromTemplate(template: string, params: Row = {}) {
  return (
    template
      .replace("{netuid}", String(params.netuid ?? ""))
      .replace("{uid}", String(params.uid ?? ""))
      .replace("{ss58}", String(params.ss58 ?? ""))
      // {hotkey} shares compileRoutePattern's __METAGRAPH_SS58__ token, so the
      // compiled regex's named capture group is `ss58`, not `hotkey` — read
      // from params.ss58 here too, or a matched /validators/{hotkey} route
      // would always substitute an empty string.
      .replace("{hotkey}", String(params.ss58 ?? ""))
      .replace("{slug}", String(params.slug ?? ""))
      .replace("{date}", String(params.date ?? ""))
      .replace("{surface_id}", String(params.surface_id ?? ""))
      .replace("{ref}", String(params.ref ?? ""))
      .replace("{hash}", String(params.hash ?? ""))
      .replace("{tag}", String(params.tag ?? ""))
  );
}

export function compileRoutePattern(pathTemplate: string) {
  const tokenized = pathTemplate
    .replace(/\{netuid\}/g, "__METAGRAPH_NETUID__")
    .replace(/\{uid\}/g, "__METAGRAPH_UID__")
    // Crowdloan {crowdloan_id} (#8696): a u32 id, same numeric shape as
    // {uid}, kept as its own token since it indexes an unrelated collection.
    .replace(/\{crowdloan_id\}/g, "__METAGRAPH_CROWDLOAN_ID__")
    .replace(/\{ss58\}/g, "__METAGRAPH_SS58__")
    // {hotkey} (#4334/7.1) is structurally the same SS58 shape as {ss58} —
    // just a more self-documenting path-parameter name for a route that only
    // ever accepts a hotkey, not any account. Same character class/length.
    .replace(/\{hotkey\}/g, "__METAGRAPH_SS58__")
    .replace(/\{slug\}/g, "__METAGRAPH_SLUG__")
    .replace(/\{date\}/g, "__METAGRAPH_DATE__")
    .replace(/\{surface_id\}/g, "__METAGRAPH_SURFACE_ID__")
    // Block-explorer {ref} (#1345): a numeric block_number OR a 0x block_hash.
    .replace(/\{ref\}/g, "__METAGRAPH_REF__")
    // Block-explorer {hash} (#1345/#1848): a 0x extrinsic_hash OR
    // composite <block_number>-<extrinsic_index> ref.
    .replace(/\{hash\}/g, "__METAGRAPH_HASH__")
    // Domain rollup {tag} (#6749/#6750): one of the fixed 14 domain/capability
    // tags (src/domain-tags.ts) — same lowercase-hyphen shape as {slug}, kept
    // as its own token since it's a distinct, unrelated enum.
    .replace(/\{tag\}/g, "__METAGRAPH_TAG__")
    // EVM {h160} (#6725/#6728): a 20-byte 0x-prefixed hex address, distinct
    // from {ss58}/{hotkey}'s base58 shape.
    .replace(/\{h160\}/g, "__METAGRAPH_H160__");
  const pattern = tokenized
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/__METAGRAPH_NETUID__/g, "(?<netuid>\\d+)")
    .replace(/__METAGRAPH_UID__/g, "(?<uid>\\d+)")
    .replace(/__METAGRAPH_CROWDLOAN_ID__/g, "(?<crowdloan_id>\\d+)")
    .replace(/__METAGRAPH_SS58__/g, "(?<ss58>[1-9A-HJ-NP-Za-km-z]{47,48})")
    .replace(/__METAGRAPH_SLUG__/g, "(?<slug>[a-z0-9-]+)")
    .replace(/__METAGRAPH_DATE__/g, "(?<date>\\d{4}-\\d{2}-\\d{2})")
    .replace(
      /__METAGRAPH_SURFACE_ID__/g,
      "(?<surface_id>[A-Za-z0-9][A-Za-z0-9:._-]*)",
    )
    .replace(/__METAGRAPH_REF__/g, "(?<ref>\\d+|0x[0-9a-fA-F]{64})")
    .replace(/__METAGRAPH_HASH__/g, "(?<hash>0x[0-9a-fA-F]{64}|\\d+-\\d+)")
    .replace(/__METAGRAPH_TAG__/g, "(?<tag>[a-z-]+)")
    .replace(/__METAGRAPH_H160__/g, "(?<h160>0x[0-9a-fA-F]{40})");
  return new RegExp(`^${pattern}\\/?$`);
}

function artifact(
  id: string,
  pathValue: string,
  description: string,
  schemaRef: string | null,
  options: {
    status?: string;
    retirement?: RetirementInfo | null;
    computed?: boolean;
  } = {},
) {
  const {
    status = ARTIFACT_STATUS_LIVE,
    retirement = null,
    computed = false,
  } = options;
  return {
    id,
    path: pathValue,
    description,
    schema_ref: schemaRef,
    storage_tier: artifactStorageTierForPath(pathValue),
    status,
    // Null for a live artifact; for a retired one it mirrors the response the
    // route actually returns, so the catalog and the runtime cannot disagree.
    retirement,
    // True when the route is computed live per request and no file is ever
    // written for it (see COMPUTED_LIVE above). Build/validation concern only —
    // deliberately NOT emitted in contracts.json, where `storage_tier` already
    // tells a consumer where the bytes come from.
    computed,
  };
}

function artifactContentType(pathValue: string) {
  if (pathValue.endsWith(".d.ts")) {
    return "text/plain; charset=utf-8";
  }
  return "application/json";
}

function route(
  id: string,
  method: string,
  pathValue: string,
  artifactPath: string,
  description: string,
  cache: string,
  tags: string[],
  queryParameters: QueryParametersInput = [],
  pathParameters: Row[] = [],
  // #9092: the component name of a JSON request body, for the routes that take
  // one. Every route was GET until /api/v1/ask was registered, so nothing in
  // this contract could express a body -- and an operation whose body is
  // undocumented is worse than no entry at all when the body IS the input.
  requestBodySchema: string | null = null,
) {
  const querySpec = normalizeQueryParameters(queryParameters);
  return {
    id,
    method,
    path: pathValue,
    request_body_schema: requestBodySchema,
    artifact_path: artifactPath,
    description,
    cache,
    tags,
    query_collection: querySpec.collection,
    query_filter_names: querySpec.filterNames,
    query_parameters: querySpec.parameters,
    csv_response: querySpec.csvResponse,
    path_parameters: pathParameters,
  };
}

function queryCollection(dataKey: string, options: Row = {}) {
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
    // Presence filters: param name -> the row field whose PRESENCE it tests.
    // e.g. { rate_limited: "rate_limit_notes" } makes `?rate_limited=true`
    // return rows that document a limit and `=false` those that do not.
    //
    // A fourth filter kind rather than a derived boolean on the row, because
    // "has a rate limit" IS `rate_limit_notes != null` -- publishing both would
    // be two fields that can disagree. The engine already carries csv/array/
    // range kinds; presence is the one it was missing, and it is the reason
    // /apis had to filter this one client-side over a single page (#9117).
    presence_filters: options.presenceFilters || {},
    search_keys: options.search || [],
    sort_fields: options.sort || [],
  };
}

function enumSchema(values: readonly string[]) {
  return { type: "string", enum: values };
}

function listQuery(collection: string, options: { exclude?: string[] } = {}) {
  const config = (API_QUERY_COLLECTIONS as Record<string, Row>)[collection];
  /* v8 ignore next 3 -- developer config invariant validated by OpenAPI/schema checks */
  if (!config) {
    throw new Error(`Unknown API query collection: ${collection}`);
  }

  const excluded = new Set(options.exclude || []);
  const filterParameters = Object.entries(config.filters)
    .map(([name, schema]) => ({ name, schema }))
    .filter((parameter) => !excluded.has(parameter.name));
  const searchParameters =
    config.search_keys.length > 0
      ? [{ name: "q", schema: searchTextSchema }]
      : [];
  // Each numeric range field F → a `min_F` + `max_F` inclusive-bound parameter.
  const rangeParameters = config.range_filters.flatMap((field: string) => [
    { name: `min_${field}`, schema: { type: "number" } },
    { name: `max_${field}`, schema: { type: "number" } },
  ]);
  return {
    collection,
    filterNames: filterParameters.map((parameter) => parameter.name),
    parameters: [
      ...filterParameters,
      ...searchParameters,
      ...rangeParameters,
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
          "Field to sort by — the bare field name only (e.g. `sort=total_stake_alpha`). Pair with the separate `order` parameter to choose direction; a combined `field:desc` token is NOT supported.",
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

// A list-query spec (pagination/sort/filter) fronted by a set of route-specific
// query parameters the collection itself doesn't own — e.g. the incidents route's
// `window` scope (#6571). The extra parameters lead, then the standard list-query
// params, so `window` still reads first in the OpenAPI parameter list.
function listQueryWith(
  collection: string,
  extraParameters: QueryParameterSpec[],
) {
  const spec = listQuery(collection);
  return { ...spec, parameters: [...extraParameters, ...spec.parameters] };
}

function csvListQuery(
  collection: string,
  options: { exclude?: string[] } = {},
) {
  const spec = listQuery(collection, options);
  return {
    ...spec,
    csvResponse: true,
    parameters: [
      ...spec.parameters,
      {
        name: "format",
        description:
          "Response format override. Use `csv` to download the transformed list as text/csv; `json` keeps the default response envelope.",
        schema: { type: "string", enum: ["json", "csv"] },
      },
    ],
  };
}

function csvRouteQuery(parameters: QueryParameterSpec[] = []) {
  return {
    collection: null,
    filterNames: [],
    csvResponse: true,
    parameters: [
      ...parameters,
      {
        name: "format",
        description:
          "Response format override. Use `csv` to download the route rows as text/csv; `json` keeps the default response envelope.",
        schema: { type: "string", enum: ["json", "csv"] },
      },
    ],
  };
}

function csvExampleForRoute(entry: (typeof API_ROUTES)[number]) {
  const supplemental = ROUTE_CSV_EXAMPLES[entry.id];
  if (supplemental) return supplemental;
  if (entry.id === "subnet-movers") {
    return [
      "netuid,stake_start_tao,stake_end_tao,stake_delta_tao,stake_pct_change,emission_start_tao,emission_end_tao,emission_delta_tao,emission_pct_change,validators_start,validators_end,validators_delta,neurons_start,neurons_end,neurons_delta",
      "7,1000,1250,250,25,10,12,2,20,16,18,2,256,256,0",
    ].join("\r\n");
  }
  if (entry.id === "global-validators") {
    return [
      "hotkey,coldkey,coldkey_count,subnet_count,uid_count,total_stake_tao,total_emission_tao,stake_dominance,avg_validator_trust,max_validator_trust,latest_captured_at,latest_block_number,subnets",
      'hk_sample,ck_sample,1,3,3,1234.5,10.25,0.12,0.98,0.99,2026-07-03T00:00:00.000Z,8454388,"[{""netuid"":1,""uid"":0}]"',
    ].join("\r\n");
  }
  if (entry.id === "accounts-list") {
    return [
      "hotkey,coldkey,coldkey_count,subnet_count,uid_count,validator_count,miner_count,total_stake_tao,total_emission_tao,stake_dominance,latest_captured_at,latest_block_number,subnets",
      'hk_sample,ck_sample,1,3,3,1,2,1234.5,10.25,0.12,2026-07-03T00:00:00.000Z,8454388,"[{""netuid"":1,""uid"":0}]"',
    ].join("\r\n");
  }
  if (entry.id === "subnet-metagraph" || entry.id === "subnet-validators") {
    return [
      "uid,hotkey,coldkey,active,validator_permit,rank,trust,validator_trust,consensus,incentive,dividends,emission_tao,stake_tao,registered_at_block,is_immunity_period,axon",
      "0,hk_sample,ck_sample,true,true,1,0.5,0.99,0.4,0.1,0.2,22.1,1000.5,6702485,false,1.2.3.4:8091",
    ].join("\r\n");
  }
  if (entry.id === "economics-trends") {
    return [
      "snapshot_date,subnet_count,total_stake_alpha,alpha_price_tao_weighted,alpha_price_tao_median,validator_count,miner_count,mean_emission_share",
      "2026-06-02,129,1250000.5,0.03125,0.028,2048,28672,0.007752",
    ].join("\r\n");
  }
  if (entry.id === "subnet-trajectory") {
    return [
      "date,completeness_score,surface_count,endpoint_count,validator_count,miner_count,total_stake_alpha,alpha_price_tao,emission_share,tao_in_pool_tao,alpha_in_pool,alpha_out_pool,subnet_volume_tao",
      "2026-06-01,35,1,1,8,60,90,0.01,0.02,26707.57,2956464.98,2257199.02,798027.45",
    ].join("\r\n");
  }
  if (entry.id === "extrinsics-feed") {
    return [
      "extrinsic_id,block_number,signer,call_module,call_function,success",
      "8454388-2,8454388,5Signer,SubtensorModule,add_stake,true",
    ].join("\r\n");
  }
  if (entry.id === "sudo-calls") {
    return [
      "extrinsic_id,block_number,signer,call_module,call_function,success",
      "8454388-1,8454388,5SudoKey,Sudo,sudo,true",
    ].join("\r\n");
  }
  if (entry.id === "governance-config-changes") {
    return [
      "extrinsic_id,block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,fee_tao,tip_tao,observed_at",
      "8454388-3,8454388,3,0xhash_sample,5AdminKey,AdminUtils,sudo_set_tempo,true,0.000123,0,2026-07-03T00:00:00.000Z",
    ].join("\r\n");
  }
  if (entry.id === "chain-activity") {
    return [
      "day,block_count,extrinsic_count,event_count,successful_extrinsics,success_rate,unique_signers",
      "2026-07-01,7200,15000,42000,14950,0.9967,320",
    ].join("\r\n");
  }
  if (entry.id === "chain-calls") {
    // Default grouping (group_by=module) omits call_function; add ?group_by=
    // module_function for the call_module,call_function,count,share shape.
    return ["call_module,count,share", "SubtensorModule,8200,0.5467"].join(
      "\r\n",
    );
  }
  if (entry.id === "chain-signers") {
    return [
      "signer,tx_count,total_fee_tao,total_tip_tao,last_tx_block",
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY,1200,3.42,0,8454388",
    ].join("\r\n");
  }
  if (entry.id === "chain-fees") {
    return [
      "day,extrinsic_count,signed_extrinsic_count,total_fee_tao,avg_fee_tao,median_fee_tao,total_tip_tao,avg_tip_tao,median_tip_tao",
      "2026-07-01,15000,9200,42.5,0.004620,0.0025,0,0,0",
    ].join("\r\n");
  }
  if (entry.id === "chain-stake-flow") {
    // The row-shaped per-subnet leaderboard (data.subnets); the network rollup +
    // net_flow_distribution stay JSON-only, mirroring chain-fees' top_fee_payers.
    return [
      "netuid,total_staked_tao,total_unstaked_tao,net_flow_tao,gross_flow_tao,stake_events,unstake_events,direction",
      "1,100,30,70,130,5,2,inflow",
    ].join("\r\n");
  }
  if (entry.id === "chain-alpha-volume") {
    // The row-shaped per-subnet leaderboard (data.subnets); the network rollup +
    // volume_distribution stay JSON-only, mirroring chain-stake-flow.
    return [
      "netuid,buy_volume_alpha,sell_volume_alpha,total_volume_alpha,buy_volume_tao,sell_volume_tao,total_volume_tao,buy_count,sell_count,net_volume_alpha,sentiment_ratio,sentiment,vol_mcap_ratio",
      "1,700,300,1000,70,30,100,5,2,400,0.4,bullish,",
    ].join("\r\n");
  }
  if (entry.id === "blocks-feed") {
    return [
      "block_number,block_hash,parent_hash,author,extrinsic_count,event_count,spec_version,observed_at",
      "8454388,0xblock,0xparent,5Author,3,12,204,2026-07-03T00:00:00.000Z",
    ].join("\r\n");
  }
  if (entry.id === "account-extrinsics") {
    return [
      "extrinsic_id,block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,fee_tao,tip_tao,observed_at",
      "6702485-2,6702485,2,0xhash_sample,5F_sample,SubtensorModule,add_stake,true,0.000123,0,2026-06-02T00:00:00.000Z",
    ].join("\r\n");
  }
  if (entry.id === "account-transfers") {
    return [
      "block_number,event_index,from,to,amount_tao,direction,observed_at",
      "6702485,3,5F_sample,5G_sample,12.5,sent,2026-06-02T00:00:00.000Z",
    ].join("\r\n");
  }
  if (entry.id === "account-counterparties") {
    return [
      "address,sent_tao,received_tao,net_tao,transfer_count,last_block",
      "5G_sample,12.5,4.25,-8.25,3,6702485",
    ].join("\r\n");
  }
  return "netuid,name\r\n7,Allways";
}

function csvResponseDescriptionForRoute(entry: (typeof API_ROUTES)[number]) {
  if (entry.query_collection) {
    return "Canonical artifact wrapped in the Metagraphed API envelope, or the transformed list as text/csv when CSV is requested.";
  }
  return "Canonical artifact wrapped in the Metagraphed API envelope, or route rows as text/csv when CSV is requested.";
}

function normalizeQueryParameters(queryParameters: QueryParametersInput) {
  if (Array.isArray(queryParameters)) {
    return { collection: null, filterNames: [], parameters: queryParameters };
  }
  return {
    collection: queryParameters.collection || null,
    csvResponse: Boolean(queryParameters.csvResponse),
    filterNames: queryParameters.filterNames || [],
    parameters: queryParameters.parameters || [],
  };
}

function schemaRefForArtifactPath(artifactPath: string) {
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

function pathTemplatesMatch(contractPath: string, artifactPath: string) {
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
