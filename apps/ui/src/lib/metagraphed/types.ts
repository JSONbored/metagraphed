// Type entrypoint for the Metagraphed API.
//
// The wire contract is owned by the backend and published as
// `@jsonbored/metagraphed` (generated from the OpenAPI document). That package
// is the single source of truth for response *shapes*; this file re-exports
// those contract types and layers the UI's own *normalized render* shapes on
// top. A contract change therefore surfaces here as a compile error rather than
// drifting silently (issue #1758).
//
// Two axes live in this file:
//   1. Contract types — re-exported from the package under `Api*`-prefixed
//      aliases (or their canonical enum names). Do NOT hand-edit these; bump the
//      package to pick up contract changes.
//   2. UI render shapes — the post-`normalize*` views the data layer
//      (`queries.ts`) produces for components. These deliberately rename/flatten
//      wire fields (e.g. the wire `EndpointResource.status` becomes the UI
//      `Endpoint.health`, `operator` becomes `provider_slug`) and stay local.
//      Where a render shape mirrors a contract field it is tied back to the
//      package type via a `satisfies`/assignment assertion so the link is
//      compile-time enforced.

import type {
  AdapterSnapshot as ApiAdapterSnapshot,
  ApiComponents,
  ApiEnvelope as ContractApiEnvelope,
  ApiPaths,
  ApiSchema,
  CandidateSurface as ApiCandidateSurface,
  EndpointPool as ApiEndpointPool,
  EndpointResource as ApiEndpointResource,
  ErrorEnvelope as ContractErrorEnvelope,
  EvidenceClaim as ApiEvidenceClaim,
  HealthSummary as ApiHealthSummary,
  HealthSurface as ApiHealthSurface,
  Provider as ApiProvider,
  SubnetDetail as ApiSubnetDetail,
  SubnetIndexEntry as ApiSubnetIndexEntry,
  SuccessEnvelope as ContractSuccessEnvelope,
  Surface as ApiSurface,
} from "@jsonbored/metagraphed";

// --- Contract re-exports (the source of truth) --------------------------------
// Wire response shapes, generated from the backend OpenAPI document. Consume
// these when you need the exact contract; the UI render shapes below are derived
// views over them. Renamed to `Api*` so the canonical names stay free for the
// normalized UI shapes that components already import.
export type {
  ApiAdapterSnapshot,
  ApiCandidateSurface,
  ApiComponents,
  ApiEndpointPool,
  ApiEndpointResource,
  ApiEvidenceClaim,
  ApiHealthSummary,
  ApiHealthSurface,
  ApiPaths,
  ApiProvider,
  ApiSchema,
  ApiSubnetDetail,
  ApiSubnetIndexEntry,
  ApiSurface,
  ContractApiEnvelope,
  ContractErrorEnvelope,
  ContractSuccessEnvelope,
};

// Canonical enums, sourced from the contract so the UI can never invent a
// member the backend doesn't emit (the root cause of the `authority` /
// `HealthStatus` drifts fixed in #1758).
export type Authority = ApiSchema<"Authority">;
export type HealthStatus = ApiSchema<"HealthStatus">;
export type SurfaceKind = ApiSchema<"SurfaceKind">;
export type Classification = ApiSchema<"Classification">;

export interface ApiPagination {
  collection?: string;
  total?: number;
  returned?: number;
  limit?: number;
  cursor?: string | number | null;
  next_cursor?: string | number | null;
  sort?: string | null;
  order?: "asc" | "desc";
}

export interface ApiMeta {
  artifact_path?: string;
  cache?: string;
  contract_version?: string;
  generated_at?: string;
  source?: string;
  stale?: boolean;
  cursor?: string | number | null;
  next_cursor?: string | number | null;
  prev_cursor?: string | number | null;
  count?: number;
  total?: number;
  pagination?: ApiPagination;
  [key: string]: unknown;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  meta?: ApiMeta;
  error?: { code?: string; message?: string; [key: string]: unknown };
}

// Sourced from the contract (was hand-maintained). If the backend adds/renames a
// curation tier the assertion below stops compiling, forcing this to track it.
export type CurationLevel = ApiSchema<"CurationLevel">;

// Display/placement metadata (e.g. a featured-pilot homepage slot) — distinct
// from CurationLevel above, which is a trust signal only and never drives
// placement (docs/adr/0008-subnet-data-model.md, #5171).
export type SubnetPartnership = ApiSchema<"PartnershipMetadata">;

// CoverageLevel has no contract counterpart — it is a UI-only rollup label.
export type CoverageLevel = "native-only" | "manifested" | "probed";

/**
 * UI presentation health enum (4 states, mapped for the traffic-light UI). The
 * canonical wire enum is {@link HealthStatus} (`ok | degraded | failed |
 * unknown`); this collapses it for display via the explicit, tested
 * `statusToHealth` adapter in `queries.ts` (degraded→warn, failed→down). Keeping
 * the two enums distinct — rather than the previous silent string-literal drift
 * — means the presentation mapping is one auditable function instead of ad-hoc
 * conversions scattered across normalizers (#1758).
 */
export type HealthState = "ok" | "warn" | "down" | "unknown";

export interface Subnet {
  netuid: number;
  slug?: string;
  name?: string;
  symbol?: string;
  type?: "root" | "application";
  // Wire field the /api/v1/subnets list already returns (SubnetIndexEntry),
  // typed here so the #6270 root filter reads it without casting through the
  // index signature below.
  subnet_type?: "root" | "application" | string;
  participants?: number;
  tempo?: number;
  // registered_at_block/block (the current snapshot block, for #6643's
  // age-in-days estimate) are the real wire field names (SubnetIndexEntry) --
  // `registration_block` never matched anything the API actually returns.
  registered_at_block?: number;
  block?: number;
  mechanism_count?: number;
  curation_level?: CurationLevel;
  coverage_level?: CoverageLevel;
  partnership?: SubnetPartnership | null;
  surfaces_count?: number;
  candidates_count?: number;
  health?: HealthState;
  health_score?: number;
  freshness?: string; // iso
  updated_at?: string;
  website?: string;
  repo?: string;
  icon_url?: string | { light: string; dark?: string };
  [key: string]: unknown;
}

export interface PrimaryLinks {
  website?: string;
  docs?: string;
  repo?: string;
  dashboard?: string;
  icon_url?: string | { light: string; dark?: string };
}

export interface PrimaryAppSurface {
  id?: string;
  kind?: string;
  name?: string;
  provider?: string;
  url?: string;
}

/** Backend integration-readiness breakdown (data.profile.readiness). */
export interface ReadinessSummary {
  score?: number;
  readiness_version?: number;
  components?: Record<string, boolean>;
}

export interface SubnetProfile extends Subnet {
  // identity
  slug?: string;
  native_name?: string;
  description?: string;
  subnet_type?: string;
  categories?: string[];
  block?: number;
  registered_at_block?: number;
  // links (flattened)
  website?: string;
  homepage?: string;
  docs?: string;
  repo?: string;
  dashboard?: string;
  primary_links?: PrimaryLinks;
  // curation
  curation_level?: CurationLevel;
  coverage_level?: CoverageLevel;
  review_state?: string;
  reviewed_at?: string;
  confidence?: string;
  completeness?: number; // 0..1
  completeness_score?: number; // 0..100
  // readiness (the backend integration_readiness score + its component breakdown)
  integration_readiness?: number; // 0..100
  readiness?: ReadinessSummary;
  // counts
  surface_count?: number;
  endpoint_count?: number;
  candidate_count?: number;
  monitored_endpoint_count?: number;
  operational_interface_kinds?: string[];
  supported_interface_kinds?: string[];
  missing_kinds?: string[];
  gap_notes?: string[];
  primary_app_surface?: PrimaryAppSurface;
  // embedded
  surfaces?: Surface[];
  endpoints?: Endpoint[];
  candidate_surfaces?: Candidate[];
  providers?: Provider[];
  notes?: string;
  [key: string]: unknown;
}

export interface Surface {
  id: string;
  netuid?: number;
  kind?: string; // api | docs | dashboard | repo | sse | data | sdk | example
  name?: string;
  url?: string;
  provider?: string;
  provider_slug?: string;
  auth_required?: boolean;
  public_safe?: boolean;
  /** Free-text note describing a rate limit, when the surface documents one. */
  rate_limit_notes?: string | null;
  verified?: boolean;
  schema_url?: string;
  curation_level?: CurationLevel;
  updated_at?: string;
  // Per-surface payload fields from /surfaces and /subnets/{n}/surfaces. The
  // contract {@link Authority} enum is official | provider-claimed | community |
  // registry-observed; `| string` tolerates legacy/extra values on this render
  // shape.
  authority?: Authority | string;
  // Per-surface HUMAN review/governance state (#1676): community-submitted →
  // maintainer-reviewed | rejected. Distinct from probe-derived health/freshness.
  review?: { state?: string; submitted_by?: string; submitted_at?: string };
  last_verified_at?: string | null;
  stale?: boolean;
  subnet_name?: string;
  subnet_slug?: string;
  [key: string]: unknown;
}

// Captured request/response fixtures (#748). The index lists which surfaces
// carry a sanitized sample; the detail is the full sanitized request/response.
export interface FixtureIndexEntry {
  surface_id: string;
  netuid?: number;
  subnet_slug?: string | null;
  kind?: string;
  captured_at?: string | null;
  response_status?: number | null;
}

export interface Fixture {
  surface_id?: string;
  netuid?: number;
  kind?: string;
  captured_at?: string | null;
  request?: { method?: string; url?: string | null };
  response?: { status?: number | null; content_type?: string | null; body?: unknown };
  [key: string]: unknown;
}

export interface Endpoint {
  id: string;
  netuid?: number;
  kind?: string; // rpc | wss | archive | api | sse | grpc
  url?: string;
  provider?: string;
  provider_slug?: string;
  region?: string;
  archive?: boolean;
  pool?: string;
  pool_eligible?: boolean;
  health?: HealthState;
  latency_ms?: number;
  last_probed_at?: string;
  [key: string]: unknown;
}

export interface RpcPool {
  id: string;
  name?: string;
  proxy_enabled?: boolean;
  members_count?: number;
  archive_capable?: boolean;
  region?: string;
  [key: string]: unknown;
}

/** One row from GET /api/v1/rpc/endpoints — the base-layer Subtensor RPC/WSS registry (RpcEndpoint schema). */
export interface RpcEndpoint {
  id: string;
  kind?: string; // subtensor-rpc | subtensor-wss
  url?: string;
  provider?: string;
  netuid?: number;
  subnet_name?: string;
  subnet_slug?: string;
  status?: string; // ok | degraded | failed | unknown
  classification?: string; // live | redirected | auth-required | dead | unsafe | unsupported | rate-limited
  network?: string;
  chain?: string;
  archive_support?: boolean | null;
  latency_ms?: number | null;
  latest_block?: number | null;
  auth_required?: boolean;
  authority?: string;
  health_source?: string;
  health_stale?: boolean;
  last_ok?: string | null;
  last_checked?: string | null;
  observed_at?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

/** Roll-up counts accompanying GET /api/v1/rpc/endpoints (RpcEndpointsArtifact.summary). */
export interface RpcEndpointsSummary {
  endpoint_count?: number;
  archive_supported_count?: number;
  by_kind?: Record<string, number>;
  by_provider?: Record<string, number>;
  by_status?: Record<string, number>;
  [key: string]: unknown;
}

/** The unwrapped GET /api/v1/rpc/endpoints payload — the endpoint list plus its summary rollup. */
export interface RpcEndpointsData {
  endpoints: RpcEndpoint[];
  summary: RpcEndpointsSummary | null;
}

export interface EndpointIncident {
  id: string;
  endpoint_id?: string;
  netuid?: number;
  state?: HealthState;
  message?: string;
  started_at?: string;
  ended_at?: string | null;
  [key: string]: unknown;
}

/** One served-endpoint row from /api/v1/rpc/usage (proxy request distribution). */
export interface RpcUsageEndpoint {
  rank: number;
  endpoint_id: string | null;
  provider: string | null;
  requests: number;
  ok_requests: number;
  error_rate: number | null;
  avg_latency_ms: number | null;
}

/** Per-network proxy volume from /api/v1/rpc/usage. */
export interface RpcUsageNetwork {
  network: string;
  requests: number;
  ok_requests: number;
  error_rate: number | null;
}

/** /api/v1/rpc/usage — reverse-proxy usage analytics over a 7d/30d window. */
export interface RpcUsage {
  window?: string | null;
  observed_at?: string | null;
  source?: string;
  summary: {
    total_requests: number;
    ok_requests: number;
    error_requests: number;
    error_rate: number | null;
    failover_requests: number;
    failover_rate: number | null;
    cache_hits: number;
    cache_hit_rate: number | null;
    latency_ms: { p50: number | null; p95: number | null; avg: number | null };
  };
  endpoints: RpcUsageEndpoint[];
  networks: RpcUsageNetwork[];
}

/** One machine-readable resource from /api/v1/agent-resources. */
export interface AgentResource {
  id: string;
  kind: string; // agent | skill | index | contract | api | data
  title: string;
  url: string;
}

/** /api/v1/agent-resources — the machine-readable index of metagraphed's AI surfaces. */
export interface AgentResources {
  generated_at?: string | null;
  published_at?: string | null;
  copyable_agent: { title: string; description: string; url: string };
  mcp: {
    endpoint: string;
    install: string;
    server_card: string;
    transport: string;
    tools: { name: string; title?: string }[];
  };
  summary: { callable_service_count: number; subnet_count: number };
  resources: AgentResource[];
}

/** One grounding source backing an /api/v1/ask answer. */
export interface AskCitation {
  ref: number;
  score: number;
  title: string | null;
  netuid: number | null;
  slug: string | null;
  url: string | null;
}

/** Response payload for POST /api/v1/ask — a grounded Q&A answer + its citations. */
export interface AskAnswerData {
  question: string;
  answer: string;
  context_count: number;
  model: string;
  citations: AskCitation[];
}

/** One reconstructed downtime window from /api/v1/incidents (epoch-ms timestamps). */
export interface GlobalIncident {
  started_at: number;
  ended_at: number;
  duration_ms: number;
  failed_samples?: number;
}

/** A surface with one or more incidents in the window (global incident ledger). */
export interface GlobalIncidentSurface {
  netuid: number;
  surface_id: string;
  incident_count: number;
  downtime_ms: number;
  incidents: GlobalIncident[];
}

/** /api/v1/incidents — recent cross-subnet downtime reconstructed from probe history. */
export interface GlobalIncidents {
  window?: string | null;
  observed_at?: string | null;
  source?: string;
  summary?: { incident_count?: number; affected_surface_count?: number };
  surfaces: GlobalIncidentSurface[];
}

/** One JSON Feed 1.1 item from /api/v1/feeds/* endpoints. */
export interface FeedItem {
  id: string;
  url?: string;
  title?: string;
  content_text?: string;
  date_published?: string | null;
  tags?: string[];
}

/** JSON Feed body from GET /api/v1/feeds/incidents.json. */
export interface IncidentsFeed {
  version?: string;
  title?: string;
  home_page_url?: string;
  feed_url?: string;
  description?: string;
  items: FeedItem[];
}

export interface ProviderEndpointSummary {
  endpoint_count?: number;
  monitored_count?: number;
  pool_eligible_count?: number;
  by_kind?: Record<string, number>;
  by_status?: Record<string, number>;
  by_layer?: Record<string, number>;
  by_publication_state?: Record<string, number>;
}

export interface Provider {
  slug: string;
  name?: string;
  kind?: string; // team | infra | docs | registry | community
  homepage?: string;
  website?: string;
  docs?: string;
  repo?: string;
  notes?: string;
  // Sourced from the contract {@link Authority} enum (official | provider-claimed
  // | community | registry-observed). The UI previously invented a nonexistent
  // "third-party" member and omitted the real provider-claimed / registry-observed
  // values; tying it to the package fixes that drift (#1758). `| string` is kept
  // because this is a normalized render shape that tolerates as-yet-unseen values.
  authority?: Authority | string;
  endpoints_count?: number;
  surfaces_count?: number;
  endpoint_summary?: ProviderEndpointSummary;
  generated_at?: string;
  icon_url?: string | { light: string; dark?: string };
  [key: string]: unknown;
}

export interface Candidate {
  id: string;
  netuid?: number;
  kind?: string;
  url?: string;
  source?: string;
  discovered_at?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface Gap {
  id: string;
  netuid?: number;
  category?: string;
  severity?: "low" | "medium" | "high";
  /** Served by the API as a numeric priority score (higher = more urgent). */
  gap_priority?: number;
  title?: string;
  description?: string;
  suggested_action?: string;
  /** Raw per-row missing surface kinds from /api/v1/gaps → data.gaps[].gaps.missing_kinds. */
  missing_kinds?: string[];
  gap_notes?: string[];
  [key: string]: unknown;
}

// #3356: the priority-scored per-subnet gap board from GET /api/v1/review/gaps
// (artifact /metagraph/review/gap-priorities.json) -- distinct from Gap above,
// which is sourced from the unrelated /api/v1/gaps interface-facet dataset.
export interface ReviewGapPriority {
  netuid?: number;
  name?: string;
  curation_level?: CurationLevel | string;
  priority_score?: number;
  missing_kinds?: string[];
  surface_count?: number;
  candidate_count?: number;
  verified_candidate_count?: number;
  [key: string]: unknown;
}

export interface HealthSummary {
  total?: number;
  ok?: number;
  warn?: number;
  down?: number;
  unknown?: number;
  uptime_24h?: number;
  generated_at?: string;
  [key: string]: unknown;
}

export interface CoverageDimension {
  pct?: number;
  present?: number;
}

export interface CoverageCompleteness {
  average_score?: number;
  median_score?: number;
  fully_complete_count?: number;
  fully_complete_pct?: number;
  scored_subnet_count?: number;
  /** Per-dimension coverage (docs, openapi, subnet-api, sse, …). */
  dimension_coverage?: Record<string, CoverageDimension>;
  /** Score buckets → subnet count (0-24, 25-49, 50-74, 75-99, 100). */
  score_distribution?: Record<string, number>;
}

export interface Coverage {
  netuids_total?: number;
  netuids_active?: number;
  manifested?: number;
  surfaces_total?: number;
  probed?: number;
  native_only?: number;
  adapter_backed?: number;
  completeness?: CoverageCompleteness;
  [key: string]: unknown;
}

export interface Freshness {
  avg_age_seconds?: number;
  max_age_seconds?: number;
  stale_count?: number;
  sources?: Array<{ name: string; last_seen?: string; stale?: boolean }>;
  [key: string]: unknown;
}

export interface SchemaInfo {
  id: string;
  name?: string;
  url?: string;
  netuid?: number;
  surface_id?: string;
  drift?: boolean;
  drift_status?: string;
  status?: string;
  hash?: string;
  previous_hash?: string;
  artifact_path?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface EvidenceItem {
  id: string;
  netuid?: number;
  source?: string;
  url?: string;
  recorded_at?: string;
  note?: string;
  [key: string]: unknown;
}

export interface AdapterSnapshot {
  slug: string;
  netuid?: number;
  generated_at?: string;
  metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LineageLink {
  mainnet_netuid: number;
  mainnet_name?: string;
  mainnet_slug?: string;
  testnet_netuid: number;
  testnet_name?: string;
  testnet_slug?: string;
  /** How the pair was matched, e.g. "chain_name" or "github_repo". */
  matched_by?: string;
}

export interface Lineage {
  source_network: string;
  target_network: string;
  link_count: number;
  graduated_subnet_count: number;
  testnet_only_count: number;
  broken_link_count: number;
  links: LineageLink[];
}

/** The five D1-computed registry leaderboards from /api/v1/registry/leaderboards. */
export type LeaderboardBoardKey =
  "healthiest" | "fastest-rpc" | "most-complete" | "most-enriched" | "fastest-growing";

/**
 * One ranked subnet in a leaderboard. Every row carries netuid/slug/name; only
 * the metric field relevant to its board is populated (e.g. `uptime_ratio` for
 * `healthiest`, `latency_ms` for `fastest-rpc`).
 */
export interface LeaderboardRow {
  netuid: number;
  slug?: string;
  name?: string;
  uptime_ratio?: number; // healthiest (0–1)
  surfaces_ok?: number; // healthiest
  surfaces_total?: number; // healthiest
  avg_latency_ms?: number; // healthiest
  latency_ms?: number; // fastest-rpc
  completeness_score?: number; // most-complete (0–100)
  surface_count?: number; // most-enriched
  operational_interface_count?: number; // most-enriched
  completeness_delta?: number; // fastest-growing (points)
}

export type Leaderboards = Record<LeaderboardBoardKey, LeaderboardRow[]>;

/** Result of an on-demand re-probe via /api/v1/surfaces/{id}/verify. */
export interface VerifyResult {
  status?: HealthState | string;
  classification?: string;
  latency_ms?: number;
  status_code?: number;
  verified_at?: string;
  from_cache?: boolean;
}

/** Per-surface latency distribution from /subnets/{n}/health/percentiles. */
export interface SurfaceLatencyPercentiles {
  surface_id: string;
  samples?: number;
  latency_ms?: {
    p50?: number;
    p95?: number;
    p99?: number;
    avg?: number;
    min?: number;
    max?: number;
  };
}

/**
 * One reconstructed downtime window inside a {@link SurfaceSla}. The API emits
 * epoch-ms timestamps and a duration; it does NOT carry an id, severity, or
 * message (these are derived downtime windows, not labeled incidents).
 */
export interface SurfaceSlaIncident {
  started_at?: number;
  ended_at?: number | null;
  duration_ms?: number;
  failed_samples?: number;
  [key: string]: unknown;
}

/** Per-surface SLA + reconstructed downtime from /subnets/{n}/health/incidents. */
export interface SurfaceSla {
  surface_id: string;
  samples?: number;
  uptime_ratio?: number;
  incident_count?: number;
  downtime_ms?: number;
  incidents?: SurfaceSlaIncident[];
}

/**
 * A flattened per-surface downtime window — one {@link SurfaceSlaIncident}
 * lifted out of its {@link SurfaceSla} row, tagged with the owning surface_id
 * and normalized to ISO timestamps for display. Severity is always "down"
 * because the source only reconstructs failure windows (no severity field
 * exists upstream).
 */
export interface FlatSurfaceIncident {
  surface_id: string;
  /** ISO string (converted from epoch-ms) for TimeAgo / date rendering. */
  started_at?: string;
  /** ISO string, or null when the incident is still open. */
  ended_at?: string | null;
  duration_ms?: number;
  failed_samples?: number;
  /** Derived, not from the API: these are reconstructed downtime windows. */
  severity: "high";
}

/** One weekly structural snapshot from /subnets/{n}/trajectory. */
export interface TrajectoryPoint {
  date: string;
  completeness_score?: number;
  surface_count?: number;
  endpoint_count?: number;
  alpha_price_tao?: number;
}

export interface TrajectoryDelta {
  from_date?: string;
  to_date?: string;
  completeness_score?: number;
  surface_count?: number;
  endpoint_count?: number;
}

export interface Trajectory {
  point_count?: number;
  points: TrajectoryPoint[];
  deltas?: Record<string, TrajectoryDelta | null>;
}

/** Composed subnet overview from /api/v1/subnets/{netuid}/overview (#1124 port). */
export interface SubnetOverview {
  netuid: number;
  name?: string;
  slug?: string;
  status?: string;
  profile?: Record<string, unknown>;
  health?: Record<string, unknown>;
  curation?: Record<string, unknown>;
  gaps?: Record<string, unknown>;
  gap_priorities?: unknown[];
  counts?: Record<string, number>;
  [key: string]: unknown;
}

/**
 * Health trend windows from /api/v1/subnets/{netuid}/health/trends.
 *
 * NB the live API returns each window as an aggregate snapshot with a
 * per-surface breakdown (`surfaces[]`) — NOT a `points[]` time-series. Each
 * surface carries its window-level uptime ratio + latency percentiles. For an
 * actual daily time-series, use subnetUptimeQuery (surfaces[].days[]) instead.
 */
export interface HealthTrendLatency {
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface HealthTrendSurface {
  surface_id: string;
  samples?: number;
  uptime_ratio?: number; // 0–1
  avg_latency_ms?: number;
  latency_sample_count?: number;
  latency_ms?: HealthTrendLatency;
}

export interface HealthTrendWindow {
  samples?: number;
  uptime_ratio?: number; // 0–1, aggregate across surfaces
  latency_sample_count?: number;
  surfaces?: HealthTrendSurface[];
  [key: string]: unknown;
}

export interface HealthTrends {
  windows: Record<string, HealthTrendWindow>;
}

/** Reliability grade (A–F) + score for a surface or the whole subnet. */
export interface ReliabilityGrade {
  score?: number;
  grade?: string;
  uptime_ratio?: number;
  avg_latency_ms?: number;
  sample_count?: number;
  surface_count?: number;
}

export interface SurfaceUptimeDay {
  day: string;
  samples?: number;
  uptime_ratio?: number;
  avg_latency_ms?: number;
  status?: string;
}

export interface SurfaceUptime {
  surface_id: string;
  day_count?: number;
  samples?: number;
  uptime_ratio?: number;
  reliability?: ReliabilityGrade;
  days: SurfaceUptimeDay[];
}

/** Long-range daily uptime history from /subnets/{n}/uptime?window=90d|1y. */
export interface Uptime {
  window?: string;
  reliability?: ReliabilityGrade;
  surfaces: SurfaceUptime[];
}

/**
 * One indexed block from the chain-direct event poller.
 * Source: /api/v1/blocks (list) and /api/v1/blocks/{ref} (detail). Newest first.
 * `author` is nullable (some blocks carry no resolved author).
 */
export interface Block {
  block_number: number;
  block_hash: string;
  parent_hash?: string;
  author?: string | null;
  extrinsic_count?: number;
  event_count?: number;
  observed_at?: string; // iso
  prev_block_number?: number | null;
  next_block_number?: number | null;
  [key: string]: unknown;
}

/** Block-local extrinsics payload from /api/v1/blocks/{ref}/extrinsics. */
export interface BlockExtrinsics {
  ref?: string | null;
  block_number?: number | null;
  extrinsic_count?: number;
  limit?: number | null;
  offset?: number | null;
  extrinsics: Extrinsic[];
  [key: string]: unknown;
}

/** Decoded chain event payload from /api/v1/blocks/{ref}/events. */
export interface BlockEvent {
  block_number: number | null;
  event_index: number | null;
  event_kind: string | null;
  hotkey?: string | null;
  coldkey?: string | null;
  netuid?: number | null;
  uid?: number | null;
  amount_tao?: number | null;
  observed_at?: string | null;
  extrinsic_index?: number | null;
  alpha_amount?: number | null;
  [key: string]: unknown;
}

export interface BlockEvents {
  ref?: string | null;
  block_number?: number | null;
  event_count?: number;
  limit?: number | null;
  offset?: number | null;
  events: BlockEvent[];
  [key: string]: unknown;
}

/**
 * One raw pallet-level chain event from /api/v1/blocks/{ref}/chain-events —
 * every decoded event in the block (not filtered to account-attributed rows
 * like {@link BlockEvent}), with the runtime pallet.method id and full args.
 */
export interface ChainEvent {
  block_number: number | null;
  event_index: number | null;
  pallet: string | null;
  method: string | null;
  args?: unknown;
  phase?: string | null;
  extrinsic_index?: number | null;
  observed_at?: string | null; // iso
  [key: string]: unknown;
}

/** Decoded chain-events payload from /api/v1/blocks/{ref}/chain-events. */
export interface BlockChainEvents {
  block_number: number | null;
  count: number;
  events: ChainEvent[];
  [key: string]: unknown;
}

/** Paginated all-events feed from /api/v1/chain-events (Postgres tier). */
export interface ChainEventsFeed {
  count: number;
  events: ChainEvent[];
  next_cursor?: string | null;
  next_before?: number | null;
  [key: string]: unknown;
}

/**
 * Inter-block time distribution (ms) from /api/v1/blocks/summary — null when
 * fewer than two consecutive blocks are in the window (no interval to measure).
 */
export interface BlockTimeStats {
  count: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  p90_ms: number;
}

/** Extrinsic/event throughput over the summary window — null on a cold store. */
export interface BlockThroughput {
  total_extrinsics: number;
  total_events: number;
  mean_extrinsics_per_block: number;
  mean_events_per_block: number;
  max_extrinsics_in_block: number;
}

/**
 * Block-production summary from /api/v1/blocks/summary (#3488): aggregate health
 * of the recent-blocks window — inter-block time, throughput, block-author
 * decentralization, and the runtime spec-version spread. A cold/absent store
 * degrades to a schema-stable zeroed card (block_count 0, nested objects null).
 */
export interface BlocksSummary {
  schema_version?: number;
  block_count: number;
  first_block: number | null;
  last_block: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  block_time: BlockTimeStats | null;
  throughput: BlockThroughput | null;
  distinct_authors: number;
  // Block-authorship decentralization — the same Gini/HHI/Nakamoto scorecard as
  // the stake/emission tiers, computed over each author's block count.
  author_concentration: ConcentrationMetrics | null;
  distinct_spec_versions: number;
  latest_spec_version: number | null;
  [key: string]: unknown;
}

export interface ExtrinsicCallArg {
  name?: string | null;
  value?: unknown;
  [key: string]: unknown;
}

/** One extrinsic (transaction) from /api/v1/extrinsics, newest-first. */
export interface Extrinsic {
  block_number: number | null;
  extrinsic_index: number | null;
  extrinsic_hash: string | null;
  signer?: string | null;
  call_module?: string | null;
  call_function?: string | null;
  fee_tao?: number | null;
  tip_tao?: number | null;
  call_args?: ExtrinsicCallArg[] | Record<string, unknown> | null;
  call_args_total?: number | null;
  events?: AccountEvent[];
  events_total?: number;
  success?: boolean | null;
  observed_at?: string; // iso
  [key: string]: unknown;
}

/** One native-TAO Balances.Transfer for an account (directional, newest-first). */
export interface Transfer {
  block_number: number | null;
  event_index: number | null;
  from: string | null;
  to: string | null;
  amount_tao: number | null;
  direction: "sent" | "received" | null;
  observed_at?: string | null; // iso
  [key: string]: unknown;
}

/** A hotkey's current registration on one subnet. */
export interface AccountRegistration {
  netuid: number | null;
  uid: number | null;
  stake_tao?: number | null;
  validator_permit?: boolean;
  active?: boolean;
  [key: string]: unknown;
}

/** One first-party chain event for an account (newest-first). */
export interface AccountEvent {
  block_number: number | null;
  event_index: number | null;
  event_kind: string | null;
  hotkey?: string | null;
  coldkey?: string | null;
  netuid?: number | null;
  uid?: number | null;
  amount_tao?: number | null;
  alpha_amount?: number | null;
  extrinsic_index?: number | null;
  observed_at?: string;
  [key: string]: unknown;
}

/**
 * One keyset page of an account's first-party chain events from
 * /api/v1/accounts/{ss58}/events. `next_cursor` lives in the body (not meta)
 * and is null at end-of-window.
 */
export interface AccountEventsPage {
  ss58: string;
  event_count: number;
  limit?: number | null;
  offset?: number | null;
  next_cursor?: string | null;
  events: AccountEvent[];
  [key: string]: unknown;
}

/**
 * Cross-subnet footprint for one account from /api/v1/accounts/{ss58}/subnets.
 * Same registration shape as the summary, ordered by netuid ascending.
 */
export interface AccountSubnets {
  ss58: string;
  subnet_count: number;
  subnets: AccountRegistration[];
  [key: string]: unknown;
}

/** Per-subnet AxonInfoRemoved row in /api/v1/accounts/{ss58}/axon-removals. */
export interface AccountAxonRemovalsSubnet {
  netuid: number;
  removals: number;
  first_removed_at: string | null;
  last_removed_at: string | null;
}

/**
 * One account's axon-removal (teardown) footprint over a 7d/30d/90d window, from
 * /api/v1/accounts/{ss58}/axon-removals — the account-level companion to
 * /api/v1/subnets/{netuid}/axon-removals. Zeroed when the account had no
 * AxonInfoRemoved events in the window.
 */
export interface AccountAxonRemovals {
  schema_version: number;
  address: string;
  window: string | null;
  total_removals: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountAxonRemovalsSubnet[];
}

/** Per-subnet NeuronDeregistered row in /api/v1/accounts/{ss58}/deregistrations. */
export interface AccountDeregistrationsSubnet {
  netuid: number;
  deregistrations: number;
  first_deregistered_at: string | null;
  last_deregistered_at: string | null;
}

/**
 * One account's deregistration (eviction) footprint over a 7d/30d/90d window, from
 * /api/v1/accounts/{ss58}/deregistrations — the account-level companion to
 * /api/v1/subnets/{netuid}/deregistrations. Zeroed when the account had no
 * NeuronDeregistered events in the window.
 */
export interface AccountDeregistrations {
  schema_version: number;
  address: string;
  window: string | null;
  total_deregistrations: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountDeregistrationsSubnet[];
}

export interface AccountRegistrationsSubnet {
  netuid: number;
  registrations: number;
  first_registered_at: string | null;
  last_registered_at: string | null;
}

/** Per-account registration (NeuronRegistered) footprint over a window (#3730). */
export interface AccountRegistrations {
  schema_version: number;
  address: string;
  window: string | null;
  total_registrations: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountRegistrationsSubnet[];
}

/** Per-subnet WeightsSet row in /api/v1/accounts/{ss58}/weight-setters. */
export interface AccountWeightSettersSubnet {
  netuid: number;
  weight_sets: number;
  first_set_at: string | null;
  last_set_at: string | null;
}

/**
 * One account's (validator's) weight-setting footprint over a 7d/30d window, from
 * /api/v1/accounts/{ss58}/weight-setters — the account-level companion to
 * /api/v1/subnets/{netuid}/weights/setters. Zeroed when the account had no
 * WeightsSet events in the window.
 */
export interface AccountWeightSetters {
  schema_version: number;
  address: string;
  window: string | null;
  total_weight_sets: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountWeightSettersSubnet[];
}

/** Per-subnet AxonServed row in /api/v1/accounts/{ss58}/serving. */
export interface AccountServingSubnet {
  netuid: number;
  announcements: number;
  first_served_at: string | null;
  last_served_at: string | null;
}

/**
 * One account's axon-serving footprint over a 7d/30d/90d window, from
 * /api/v1/accounts/{ss58}/serving — the account-level companion to
 * /api/v1/subnets/{netuid}/serving. Zeroed when the account had no AxonServed
 * events in the window.
 */
export interface AccountServing {
  schema_version: number;
  address: string;
  window: string | null;
  total_announcements: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountServingSubnet[];
}

/** Per-subnet PrometheusServed row in /api/v1/accounts/{ss58}/prometheus. */
export interface AccountPrometheusSubnet {
  netuid: number;
  announcements: number;
  first_announced_at: string | null;
  last_announced_at: string | null;
}

/**
 * One account's Prometheus-endpoint serving footprint over a 7d/30d/90d window,
 * from /api/v1/accounts/{ss58}/prometheus — the account-level companion to
 * /api/v1/subnets/{netuid}/prometheus. Zeroed when cold.
 */
export interface AccountPrometheus {
  schema_version: number;
  address: string;
  window: string | null;
  total_announcements: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountPrometheusSubnet[];
}

/**
 * One neuron position a wallet holds on a subnet, from
 * /api/v1/accounts/{ss58}/portfolio: its economics plus emission/stake yield.
 * Score cells are null when absent; `yield` is null with zero stake.
 */
export interface PortfolioPosition {
  netuid: number;
  uid: number | null;
  role: "validator" | "miner" | null;
  active?: boolean;
  stake_tao: number | null;
  emission_tao: number | null;
  rank: number | null;
  trust: number | null;
  incentive: number | null;
  dividends: number | null;
  /** Emission-per-stake return (a fraction; null with zero stake). */
  yield: number | null;
  [key: string]: unknown;
}

/**
 * Stake-concentration lens over a wallet's per-subnet stake (Gini / normalized
 * HHI / Nakamoto coefficient), from the portfolio's `stake_concentration`. Null
 * when the wallet holds no stake (a cold or all-zero distribution).
 */
export interface PortfolioConcentration {
  holders: number | null;
  gini: number | null;
  hhi_normalized: number | null;
  nakamoto_coefficient: number | null;
  [key: string]: unknown;
}

/**
 * A wallet's cross-subnet neuron portfolio from /api/v1/accounts/{ss58}/portfolio:
 * every position's economics + yield plus wallet-level aggregates (totals, role
 * counts, overall return, stake concentration). Richer than the registrations-only
 * AccountSubnets footprint.
 */
export interface AccountStakeMovesSubnet {
  netuid: number;
  movements: number;
  first_moved_at?: string | null;
  last_moved_at?: string | null;
  /** Alpha price (TAO) on the UTC day of last_moved_at, from the daily
   * subnet_snapshots rollup (#4332/6.3). Null when that day has no snapshot
   * yet or there was no move. Daily granularity, not the exact intra-day
   * price of any one movement -- a known precision limit, not a bug. */
  price_tao_at_last_move?: number | null;
}
export interface AccountStakeMoves {
  ss58: string;
  window: string;
  total_movements: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountStakeMovesSubnet[];
  [key: string]: unknown;
}
/** One counterparty row in /api/v1/accounts/{ss58}/counterparties (list mode). */
export interface AccountCounterparty {
  address: string;
  sent_tao: number | null;
  received_tao: number | null;
  net_tao: number | null;
  transfer_count: number | null;
  last_block: number | null;
}
/**
 * #3340: /api/v1/accounts/{ss58}/counterparties (list mode) — the fund-flow
 * leaderboard of the addresses this account transacts with, by volume.
 */
export interface AccountCounterparties {
  ss58: string;
  counterparty_count: number;
  transfers_scanned: number | null;
  scan_capped: boolean | null;
  total_sent_tao: number | null;
  total_received_tao: number | null;
  counterparties: AccountCounterparty[];
  [key: string]: unknown;
}
/** One per-subnet stake/unstake flow row in /accounts/{ss58}/stake-flow. */
export interface AccountStakeFlowSubnet {
  netuid: number;
  staked_tao: number | null;
  unstaked_tao: number | null;
  net_flow_tao: number | null;
  gross_flow_tao: number | null;
  flow_ratio: number | null;
  direction: string | null;
  stake_events: number | null;
  unstake_events: number | null;
}
/**
 * #3341: /api/v1/accounts/{ss58}/stake-flow — per-account staking-behavior
 * scorecard (net/gross flow, direction, concentration) + a per-subnet breakdown
 * over a 7d|30d|90d window.
 */
export interface AccountStakeFlow {
  ss58: string;
  window: string;
  total_staked_tao: number | null;
  total_unstaked_tao: number | null;
  net_flow_tao: number | null;
  gross_flow_tao: number | null;
  direction: string | null;
  concentration: number | null;
  dominant_netuid: number | null;
  subnet_count: number;
  subnets: AccountStakeFlowSubnet[];
  [key: string]: unknown;
}
export interface AccountPortfolio {
  ss58: string;
  captured_at?: string | null;
  subnet_count: number;
  position_count: number;
  validator_count: number;
  miner_count: number;
  total_stake_tao: number | null;
  total_emission_tao: number | null;
  overall_yield: number | null;
  stake_concentration: PortfolioConcentration | null;
  positions: PortfolioPosition[];
  [key: string]: unknown;
}

/**
 * One reconstructed nominator-side (coldkey) position from
 * buildAccountPositions (src/account-nominator-positions.mjs) -- share_fraction
 * is dimensionless (the coldkey's share of that hotkey+netuid's total stake),
 * not a snapshotted TAO figure; stake_tao is derived by multiplying it against
 * the live neurons stake_tao at read time.
 */
export interface AccountPosition {
  hotkey: string;
  netuid: number;
  share_fraction: number;
  stake_tao: number;
}

/**
 * #5233: /api/v1/accounts/{ss58}/positions -- the coldkey-scoped counterpart to
 * AccountPortfolio (hotkey-scoped). Sourced from nominator_positions, populated
 * by a daily/weekly full-chain scan (scripts/fetch-validator-nominator-counts.py)
 * -- NOT a live query. Root (netuid 0) has zero coverage: SubtensorModule::Alpha
 * carries no root data (root is TAO-denominated 1:1, no alpha pool). Treat
 * captured_at as a staleness label for UI display, never as authoritative for a
 * fund-safety decision.
 */
export interface AccountPositions {
  ss58: string;
  captured_at: string | null;
  position_count: number;
  total_stake_tao: number;
  positions: AccountPosition[];
  [key: string]: unknown;
}

/** Cross-subnet activity summary for one account from /api/v1/accounts/{ss58}. */
export interface AccountSummary {
  ss58: string;
  event_count: number;
  subnet_count: number;
  first_block?: number | null;
  last_block?: number | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  event_kinds: Array<{ kind: string; count: number }>;
  registrations: AccountRegistration[];
  recent_events: AccountEvent[];
  [key: string]: unknown;
}

/** Personal (coldkey) on-chain identity for one account (#4324/5.1), from
 * /api/v1/accounts/{ss58}/identity — distinct from subnet identity and from
 * the validator directory's coldkey-identity join. has_identity is false
 * (every field null) for the common case: an account that never called
 * set_identity. Schema-stable, never a 404. */
export interface AccountIdentity {
  schema_version: number;
  account: string;
  has_identity: boolean;
  name: string | null;
  url: string | null;
  github: string | null;
  image: string | null;
  discord: string | null;
  description: string | null;
  additional: string | null;
  captured_at: string | null;
}

/** One hotkey-keyed daily activity row from /api/v1/accounts/{ss58}/history. */
export interface AccountDay {
  day: string;
  netuid: number | null;
  event_count: number;
  event_kinds: string[];
  first_block?: number | null;
  last_block?: number | null;
  [key: string]: unknown;
}

/** Per-day activity history for one account from /api/v1/accounts/{ss58}/history. */
export interface AccountHistory {
  ss58: string;
  day_count: number;
  limit?: number | null;
  offset?: number | null;
  days: AccountDay[];
  [key: string]: unknown;
}

/** Live TAO balance for an account from /api/v1/accounts/{ss58}/balance. */
export interface AccountBalance {
  ss58: string;
  /** Free + reserved balance in TAO; null when the RPC lookup failed. */
  balance_tao: number | null;
  queried_at?: string | null;
}

/** Current Sudo::Key holder from /api/v1/sudo/key. Null hotkey = unset or RPC failure. */
export interface SudoKey {
  hotkey: string | null;
  queried_at?: string | null;
}

/** Current global Subtensor protocol/governance parameters from
 * /api/v1/network/parameters (#6343). Each field is independently null on
 * its own RPC failure -- never coerced to 0/false, so a real zero value
 * (e.g. tao_weight legitimately at 0) stays distinguishable from a failed
 * read (#6997). */
export interface NetworkParameters {
  tao_weight: number | null;
  stake_threshold_tao: number | null;
  pending_childkey_cooldown_blocks: number | null;
  queried_at: string | null;
}

/** One spec-version transition from /api/v1/runtime (#4316/3.1). */
export interface RuntimeTransition {
  spec_version: number | null;
  block_number: number | null;
  observed_at: string | null;
}

/** Spec-version upgrade history from /api/v1/runtime. See that route's own docs
 * for coverage_from_*'s "earliest reading this endpoint can see" caveat — it is
 * not a guarantee the network never upgraded before that point. */
export interface RuntimeVersionHistory {
  transitions: RuntimeTransition[];
  transition_count: number;
  current_spec_version: number | null;
  coverage_from_block: number | null;
  coverage_from_at: string | null;
}

/** Per-subnet on-chain economics from /api/v1/economics. */
export interface SubnetEconomics {
  netuid: number;
  name?: string;
  slug?: string;
  emission_share?: number;
  alpha_price_tao?: number;
  validator_count?: number;
  max_validators?: number;
  miner_count?: number;
  max_uids?: number;
  total_stake_tao?: number;
  max_stake_tao?: number;
  subnet_volume_tao?: number;
  registration_cost_tao?: number;
  registration_allowed?: boolean;
  /** Proxy metrics (#3361): alpha_price × total_stake, and alpha_price × ALPHA_MAX_SUPPLY. */
  alpha_market_cap_tao?: number;
  alpha_fdv_tao?: number;
  [key: string]: unknown;
}

/**
 * One subnet row from the composed /api/v1/compare endpoint, which fuses
 * registry structure + on-chain economics + live probe health per netuid in a
 * single request. `found` is false (and the dimension blocks null) for netuids
 * the registry does not know; `health` is null when the subnet has no probed
 * surfaces. The compare endpoint carries no curation tier.
 */
export interface CompareStructure {
  completeness_score?: number; // 0–100
  surface_count?: number;
  operational_interface_count?: number;
}

export interface CompareEconomics {
  registration_cost_tao?: number;
  registration_allowed?: boolean;
  open_slots?: number;
  emission_share?: number;
  alpha_price_tao?: number;
  validator_count?: number;
  miner_count?: number;
  total_stake_tao?: number;
  miner_readiness?: number;
  [key: string]: unknown;
}

export interface CompareHealth {
  surface_count?: number;
  ok_count?: number;
  avg_latency_ms?: number;
}

export interface CompareSubnet {
  netuid: number;
  name?: string;
  slug?: string;
  found: boolean;
  structure?: CompareStructure;
  economics?: CompareEconomics;
  health?: CompareHealth;
}

export interface Compare {
  dimensions: string[];
  requested_netuids: number[];
  subnets: CompareSubnet[];
  observed_at?: string;
  source?: string;
}

/** One daily on-chain snapshot from /subnets/{n}/history. */
export interface SubnetHistoryPoint {
  snapshot_date: string;
  neuron_count?: number;
  validator_count?: number;
  total_stake_tao?: number;
  total_emission_tao?: number;
  [key: string]: unknown;
}

/** Per-subnet on-chain history from /api/v1/subnets/{netuid}/history. */
export interface SubnetHistory {
  netuid: number;
  window?: string;
  point_count?: number;
  points: SubnetHistoryPoint[];
}

/**
 * One observed on-chain SubnetIdentitiesV3 snapshot for a subnet (#1647), from
 * /api/v1/subnets/{netuid}/identity-history. Operator-controlled untrusted data —
 * every field but the stable `identity_hash` may be null.
 */
export interface SubnetIdentityHistoryEntry {
  identity_hash: string;
  block_number: number | null;
  observed_at: string | null;
  subnet_name: string | null;
  symbol: string | null;
  description: string | null;
  github_repo: string | null;
  subnet_url: string | null;
  logo_url: string | null;
  discord: string | null;
}

/** One network-wide subnet-identity change from GET /api/v1/chain/identity-history — a SubnetIdentityHistoryEntry plus its netuid. */
export interface ChainIdentityChange extends SubnetIdentityHistoryEntry {
  netuid: number;
}

/**
 * Network-wide feed of recent subnet-identity changes (#3474) from
 * GET /api/v1/chain/identity-history — the most recent SubnetIdentitiesV3 edits
 * (name / symbol / description / URL / logo) across every subnet, newest first.
 * Zeroed with an empty changes list when none have been observed.
 */
export interface ChainIdentityHistory {
  schema_version: number;
  count: number;
  subnet_count: number;
  changes: ChainIdentityChange[];
}

/** One subnet's consensus, economic, and governance hyperparameters (#4307/1.4).
 * *_ratio fields are 0..1 ratios; min_burn_tao/max_burn_tao are TAO floats;
 * bonds_moving_avg_raw is the raw on-chain integer (not yet ratio-converted). */
export interface SubnetHyperparameters {
  kappa_ratio: number | null;
  immunity_period: number | null;
  min_allowed_weights: number | null;
  max_weight_limit_ratio: number | null;
  tempo: number | null;
  weights_version: number | null;
  weights_rate_limit: number | null;
  activity_cutoff: number | null;
  activity_cutoff_factor: number | null;
  registration_allowed: boolean;
  target_regs_per_interval: number | null;
  min_burn_tao: number | null;
  max_burn_tao: number | null;
  burn_half_life: number | null;
  burn_increase_mult: number | null;
  bonds_moving_avg_raw: number | null;
  max_regs_per_block: number | null;
  serving_rate_limit: number | null;
  max_validators: number | null;
  commit_reveal_period: number | null;
  commit_reveal_enabled: boolean;
  alpha_high_ratio: number | null;
  alpha_low_ratio: number | null;
  liquid_alpha_enabled: boolean;
  alpha_sigmoid_steepness: number | null;
  yuma_version: number | null;
  subnet_is_active: boolean;
  transfers_enabled: boolean;
  bonds_reset_enabled: boolean;
  user_liquidity_enabled: boolean;
  owner_cut_enabled: boolean;
  owner_cut_auto_lock_enabled: boolean;
  min_childkey_take_ratio: number | null;
}

/** Envelope from GET /api/v1/subnets/{netuid}/hyperparameters — hyperparameters
 * is null on a cold/absent snapshot, never a 404. */
export interface SubnetHyperparametersDetail {
  schema_version?: number;
  netuid: number;
  captured_at?: string | null;
  block_number?: number | null;
  hyperparameters: SubnetHyperparameters | null;
}

/** One historic hyperparameter snapshot in a subnet's append-only change
 * timeline, from GET /api/v1/subnets/{netuid}/hyperparameters/history. */
export interface SubnetHyperparamsHistoryEntry {
  block_number: number | null;
  observed_at: string | null;
  hyperparameters: SubnetHyperparameters | null;
  hyperparams_hash: string;
}

/** Append-only hyperparameter-change timeline for one subnet, newest first. */
export interface SubnetHyperparamsHistory {
  schema_version: number;
  netuid: number;
  entry_count: number;
  entries: SubnetHyperparamsHistoryEntry[];
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
}

/** Read-only constant-product stake/unstake slippage quote for one subnet
 * (#5235), from GET /api/v1/subnets/{netuid}/stake-quote?amount=&direction=.
 * Pure math against the subnet's AMM pool reserves — no chain write, no
 * custody. tao_in_pool_tao/alpha_in_pool are null for the root subnet
 * (netuid 0, which has no AMM and returns a 1:1 zero-impact quote instead). */
export interface SubnetStakeQuote {
  schema_version: number;
  netuid: number;
  direction: "stake" | "unstake";
  amount: number;
  expected_out: number;
  expected_out_unit: "alpha" | "tao";
  spot_price_tao: number;
  effective_price_tao: number;
  price_impact_pct: number;
  tao_in_pool_tao: number | null;
  alpha_in_pool: number | null;
  is_root: boolean;
}

/** The live cumulative TAO recycled for registration on one subnet (#4339/8.4),
 * from GET /api/v1/subnets/{netuid}/recycled — queried live from the chain's
 * RAORecycledForRegistration storage map (600s KV cache). recycled_tao is
 * null only on RPC failure (schema-stable), a real 0 for zero registrations. */
export interface SubnetRecycled {
  schema_version: number;
  netuid: number;
  recycled_tao: number | null;
  queried_at: string | null;
}

/** Idle stake for one subnet (#6789 backend, #6994 UI): stake delegated to a
 *  hotkey currently earning zero dividends. idle_stake_tao is null only on a
 *  cold/absent snapshot; a real 0 means no idle stake. */
export interface SubnetIdleStake {
  schema_version: number;
  netuid: number;
  captured_at: string | null;
  neuron_count: number;
  idle_neuron_count: number;
  idle_stake_tao: number | null;
}

/** One subnet's row in the network-wide idle-stake rollup. */
export interface ChainIdleStakeSubnet {
  netuid: number;
  neuron_count: number;
  idle_neuron_count: number;
  idle_stake_tao: number | null;
}

/** Network-wide idle-stake rollup (GET /api/v1/chain/idle-stake). */
export interface ChainIdleStake {
  schema_version: number;
  captured_at: string | null;
  subnet_count: number;
  total_idle_stake_tao: number | null;
  subnets: ChainIdleStakeSubnet[];
}

/** Append-only on-chain identity timeline for one subnet (#1647), newest first. */
export interface SubnetIdentityHistory {
  schema_version: number;
  netuid: number;
  entry_count: number;
  entries: SubnetIdentityHistoryEntry[];
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
}

/**
 * Per-subnet validator weight-setting activity over a 7d/30d window, from
 * /api/v1/subnets/{netuid}/weights — aggregate WeightsSet counts (distinct
 * setters, total sets, average). Zeroed when the subnet had no WeightsSet
 * events in the window. Setter-level drill-in lives at /weights/setters.
 */
export interface SubnetWeights {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_setters: number;
  weight_sets: number;
  sets_per_setter: number | null;
}

/** One validator's weight-setting activity for a subnet over the window (#1657). */
export interface SubnetWeightSetter {
  hotkey: string | null;
  uid: number | null;
  weight_sets: number;
  share: number | null;
  first_set_at: string | null;
  last_set_at: string | null;
}

/** One validator's network-wide weight-setting activity over the window (#3470). */
export interface ChainWeightSetter extends SubnetWeightSetter {
  /** Subnet scope for uid-only setters; null when a network-wide hotkey identifies the setter. */
  netuid: number | null;
}

/**
 * Per-subnet weight-setters leaderboard over a 7d/30d window (#1657), from
 * /api/v1/subnets/{netuid}/weights/setters — the individual validators behind the
 * subnet's WeightsSet activity, ranked by weight-set count. Zeroed when cold.
 */
export interface SubnetWeightSetters {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_setters: number;
  weight_sets: number;
  setter_count: number;
  setters: SubnetWeightSetter[];
}

/**
 * Network-wide weight-setters leaderboard over a 7d/30d window (#3470), from
 * GET /api/v1/chain/weights/setters — validators ranked by WeightsSet count
 * across every subnet. Zeroed when cold.
 */
export interface ChainWeightSetters {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  distinct_setters: number;
  weight_sets: number;
  setter_count: number;
  setters: ChainWeightSetter[];
}

/**
 * Per-subnet axon-removal (teardown) activity over a 7d/30d window (#1657), from
 * /api/v1/subnets/{netuid}/axon-removals — the removal-side complement of the
 * AxonServed announcement activity in /subnets/{netuid}/serving. Zeroed when the
 * subnet had no AxonInfoRemoved events in the window.
 */
export interface SubnetAxonRemovals {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_removers: number;
  removals: number;
  removals_per_remover: number | null;
}

/**
 * Per-subnet stake-movement (re-delegation) activity over a 7d/30d window, from
 * /api/v1/subnets/{netuid}/stake-moves — the per-subnet drill-in of chain
 * stake-moves. Zeroed when the subnet had no StakeMoved events in the window.
 */
export interface SubnetStakeMoves {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_movers: number;
  movements: number;
  movements_per_mover: number | null;
}

/**
 * Per-subnet stake-transfer activity over a 7d/30d window (#3484), from
 * /api/v1/subnets/{netuid}/stake-transfers — the per-subnet drill-in of
 * /api/v1/chain/stake-transfers and the between-accounts sibling of
 * /subnets/{netuid}/stake-moves (transfer_stake relocates staked alpha between
 * accounts on the same hotkey; origin leg only). Zeroed when the subnet had no
 * StakeTransferred events in the window.
 */
export interface SubnetStakeTransfers {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_senders: number;
  transfers: number;
  transfers_per_sender: number | null;
}

/**
 * Per-subnet axon-serving announcement activity over a 7d/30d window, from
 * /api/v1/subnets/{netuid}/serving. Zeroed when the subnet had no AxonServed
 * events in the window.
 */
export interface SubnetServing {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_servers: number;
  announcements: number;
  announcements_per_server: number | null;
}

/**
 * Per-subnet Prometheus-endpoint serving activity over a 7d/30d window, from
 * /api/v1/subnets/{netuid}/prometheus. Zeroed when the subnet had no
 * PrometheusServed events in the window.
 */
export interface SubnetPrometheus {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_exporters: number;
  announcements: number;
  announcements_per_exporter: number | null;
}

/**
 * Per-subnet neuron-registration event volume over a 7d/30d window (#1657), from
 * /api/v1/subnets/{netuid}/registrations — raw NeuronRegistered activity, distinct
 * from the turnover snapshot-diff. Zeroed when the subnet had none in the window.
 */
export interface SubnetRegistrations {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_registrants: number;
  registrations: number;
  registrations_per_registrant: number | null;
}

/** Per-subnet stake-flow scorecard from /api/v1/subnets/{netuid}/stake-flow (#3342). */
export interface SubnetStakeFlow {
  schema_version: number;
  netuid: number;
  window: string;
  total_staked_tao: number;
  total_unstaked_tao: number;
  net_flow_tao: number;
  stake_events: number;
  unstake_events: number;
}

/** Rolling 24h buy/sell alpha volume for one subnet, from
 * /api/v1/subnets/{netuid}/volume (#4339/8.1). Unsigned (buy + sell, never
 * netted); fixed 24h window, no ?window= param. */
export interface SubnetAlphaVolume {
  schema_version: number;
  netuid: number;
  window: string;
  buy_volume_alpha: number;
  sell_volume_alpha: number;
  total_volume_alpha: number;
  buy_volume_tao: number;
  sell_volume_tao: number;
  total_volume_tao: number;
  buy_count: number;
  sell_count: number;
  net_volume_alpha: number;
  sentiment_ratio: number | null;
  sentiment: "bullish" | "bearish" | "neutral";
  vol_mcap_ratio: number | null;
}

/** Network-wide rollup of every subnet's 24h buy/sell alpha volume, the
 * "network mood" signal (#6642) -- net_volume_alpha / gross, same
 * sentiment_ratio/sentiment math as one subnet's own SubnetAlphaVolume,
 * just summed across the whole network first. */
export interface ChainAlphaVolumeNetwork {
  buy_volume_alpha: number;
  sell_volume_alpha: number;
  total_volume_alpha: number;
  buy_volume_tao: number;
  sell_volume_tao: number;
  total_volume_tao: number;
  buy_count: number;
  sell_count: number;
  net_volume_alpha: number;
  sentiment_ratio: number | null;
  sentiment: "bullish" | "bearish" | "neutral";
}

/** Spread of per-subnet total_volume_tao across every subnet with volume in
 * the window; null when no subnet had volume. */
export interface ChainAlphaVolumeDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

/** Network-wide rolling 24h buy/sell alpha-volume leaderboard from
 * /api/v1/chain/alpha-volume -- the network mood gauge (#6642) reads only
 * `network`; `subnets`/`volume_distribution` exist for the (not yet built)
 * full leaderboard view. */
export interface ChainAlphaVolume {
  schema_version: number;
  window: string;
  observed_at: string | null;
  subnet_count: number;
  network: ChainAlphaVolumeNetwork;
  volume_distribution: ChainAlphaVolumeDistribution | null;
  subnets: SubnetAlphaVolume[];
}

/** One open/high/low/close/volume candle from /api/v1/subnets/{netuid}/ohlc. */
export interface SubnetOhlcCandle {
  bucket_start: number;
  bucket_start_iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_alpha: number;
  volume_tao: number;
  event_count: number;
}

/** OHLC price/volume candlesticks for one subnet (#5655), bucketed by
 * ?interval=1h|1d from the account_events StakeAdded/StakeRemoved stream.
 * Root (netuid 0) has no AMM pool and always carries root_excluded:true with
 * an empty candles array rather than a meaningless flat-line series. */
export interface SubnetOhlc {
  schema_version: number;
  netuid: number;
  interval: "1h" | "1d";
  candles: SubnetOhlcCandle[];
  root_excluded: boolean;
}

/** One hotkey's current standing in a subnet's ownership contest (#6638),
 * rolled forward to the query time. locked_mass/conviction are raw alpha
 * units (rao-scale, /1e9 for whole alpha) -- conviction is the exponentially
 * smoothed integral of locked_mass, what actually determines the contest. */
export interface SubnetConvictionEntry {
  hotkey: string;
  is_owner: boolean;
  locked_mass: number;
  conviction: number;
}

/** Live per-subnet ownership-contest leaderboard from
 * /api/v1/subnets/{netuid}/conviction (#6638). king is the top-ranked
 * hotkey by rolled conviction (or null if the leaderboard is empty -- most
 * subnets have no active challengers). unlock_rate/maturity_rate are the
 * live governance values the roll-forward used, never a hardcoded figure. */
export interface SubnetConviction {
  schema_version: number;
  netuid: number;
  queried_at_block: number | null;
  unlock_rate: number | null;
  maturity_rate: number | null;
  king: string | null;
  count: number;
  leaderboard: SubnetConvictionEntry[];
}

/** One automatic ownership transfer, decoded from a chain_events
 * SubnetOwnerChanged row (#6637). old_coldkey/new_coldkey are SS58-encoded. */
export interface SubnetOwnershipChange {
  netuid: number | null;
  old_coldkey: string | null;
  new_coldkey: string | null;
  block_number: number | null;
  observed_at: string | null;
}

/** Every automatic ownership transfer one subnet has undergone, from
 * /api/v1/subnets/{netuid}/ownership-history (#6637). A subnet that has
 * never changed hands returns an empty list, not an error -- the common
 * case, per docs/conviction-lock-mechanism.md's permissionless contest. */
export interface SubnetOwnershipHistory {
  schema_version: number;
  netuid: number;
  event_pallet: string;
  event_method: string;
  count: number;
  ownership_changes: SubnetOwnershipChange[];
}

/**
 * Terms of one active subnet lease from GET /api/v1/subnets/{netuid}/lease
 * (#6993 / #6719). beneficiary/coldkey/hotkey are SS58. end_block is null
 * for a perpetual lease. accumulated_dividends_alpha is null only when that
 * sub-read failed independently.
 */
export interface SubnetLeaseTerms {
  lease_id: number;
  beneficiary: string;
  coldkey: string;
  hotkey: string;
  emissions_share_percent: number;
  end_block: number | null;
  netuid: number;
  cost_tao: number;
  accumulated_dividends_alpha: number | null;
}

/**
 * Live subnet-lease state (#6993). `leased: null` is RPC failure — distinct
 * from confirmed no-lease (`leased: false`). `lease` may be null while
 * `leased: true` when terms couldn't be decoded this request (retry).
 */
export interface SubnetLeaseState {
  schema_version: number;
  netuid: number;
  leased: boolean | null;
  lease: SubnetLeaseTerms | null;
  queried_at: string | null;
}

/** One SubnetLeaseCreated/SubnetLeaseTerminated event (#6718). */
export interface SubnetLeaseEvent {
  event_kind: string | null;
  beneficiary: string | null;
  block_number: number | null;
  observed_at: string | null;
}

/**
 * Lease-created/terminated event log from
 * GET /api/v1/subnets/{netuid}/lease/history (#6993). Never-leased → empty list.
 */
export interface SubnetLeaseHistory {
  schema_version: number;
  netuid: number;
  event_pallet: string;
  event_kinds: string[];
  count: number;
  lease_events: SubnetLeaseEvent[];
}

/** One subnet's movement over the comparison window on the /subnets/movers board. */
export interface SubnetMover {
  netuid: number;
  stake_start_tao: number;
  stake_end_tao: number;
  stake_delta_tao: number;
  stake_pct_change: number | null;
  stake_share_pct: number | null;
  emission_delta_tao: number;
  validators_delta: number;
  neurons_delta: number;
}

/** Network-wide gainer/loser tallies accompanying the movers board. */
export interface SubnetMoversNetwork {
  gainers: number;
  losers: number;
  unchanged: number;
}

/**
 * Cross-subnet biggest-movers board from /api/v1/subnets/movers (#3344): subnets
 * ranked by how much their stake/emission/validator set changed over a window.
 * A cold/absent store degrades to a schema-stable card (movers [], network null).
 */
export interface SubnetMovers {
  schema_version: number;
  window: string;
  sort: string;
  subnet_count: number;
  network: SubnetMoversNetwork | null;
  movers: SubnetMover[];
}

/**
 * Per-subnet neuron-deregistration (eviction) event volume over a 7d/30d window
 * (#1657), from /api/v1/subnets/{netuid}/deregistrations — the eviction-side
 * complement of {@link SubnetRegistrations}. Zeroed when cold.
 */
export interface SubnetDeregistrations {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  distinct_deregistered_hotkeys: number;
  deregistrations: number;
  deregistrations_per_hotkey: number | null;
}

/** One event-category aggregate in a subnet's windowed event-summary rollup. */
export interface SubnetEventCategorySummary {
  category: string;
  event_count: number;
  kind_count: number;
  amount_tao: number;
  alpha_amount: number;
  first_block: number | null;
  last_block: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
}

/**
 * Windowed on-chain event-summary rollup for one subnet, from
 * /api/v1/subnets/{netuid}/event-summary (#3486) — the dashboard-friendly
 * companion to the raw per-event feed the Activity tab renders. Zeroed/empty
 * when the account_events tier is cold, never an error.
 */
export interface SubnetEventSummary {
  schema_version: number;
  netuid: number;
  window: string | null;
  observed_at: string | null;
  total_events: number;
  kind_count: number;
  category_count: number;
  limit: number;
  categories: SubnetEventCategorySummary[];
}

/**
 * Validator-set & registration turnover scorecard for one subnet, from
 * /api/v1/subnets/{netuid}/turnover — diffs the window's start/end
 * `neuron_daily` snapshots. `comparable: false` on a cold store or a
 * single-snapshot window; the ratio/score fields are null in that case, not
 * zeroed (a zero would read as flawless retention).
 */
export interface SubnetTurnover {
  schema_version: number;
  netuid: number;
  window: string | null;
  start_date: string | null;
  end_date: string | null;
  comparable: boolean;
  validators_start: number;
  validators_end: number;
  validators_entered: number;
  validators_exited: number;
  validator_retention: number | null;
  neurons_start: number;
  neurons_end: number;
  uids_deregistered: number;
  neuron_retention: number | null;
  stability_score: number | null;
}

/** One daily per-UID snapshot from /subnets/{n}/neurons/{uid}/history. */
export interface SubnetNeuronHistoryPoint {
  snapshot_date: string;
  emission_tao?: number;
  incentive?: number;
  consensus?: number;
  dividends?: number;
  stake_tao?: number;
  rank?: number;
  validator_permit?: boolean;
  [key: string]: unknown;
}

/** Per-UID on-chain history from /api/v1/subnets/{netuid}/neurons/{uid}/history. */
export interface SubnetNeuronHistory {
  netuid: number;
  uid: number;
  window?: string;
  point_count?: number;
  points: SubnetNeuronHistoryPoint[];
}

// ---- Subnet economic depth: metagraph / validators / concentration ----------
//
// Render shapes for the live metagraph-snapshot tier:
//   - /subnets/{n}/metagraph      → the full neuron table
//   - /subnets/{n}/validators     → pre-filtered + ranked validators (same row)
//   - /subnets/{n}/neurons/{uid}  → a single neuron snapshot
//   - /subnets/{n}/concentration  → stake/emission distribution metrics
//   - /subnets/{n}/concentration/history → daily Gini/Nakamoto/top-share drift
// Every per-neuron field is optional + nullable: the snapshot fills rank/axon/
// emission with null for inactive UIDs, so consumers must be null-safe.

/** One neuron row from /subnets/{n}/metagraph (and /validators, /neurons/{uid}). */
export interface MetagraphNeuron {
  uid: number;
  hotkey?: string;
  coldkey?: string;
  active?: boolean;
  validator_permit?: boolean;
  rank?: number | null;
  trust?: number;
  validator_trust?: number;
  consensus?: number;
  incentive?: number;
  dividends?: number;
  emission_tao?: number;
  stake_tao?: number;
  registered_at_block?: number;
  is_immunity_period?: boolean;
  axon?: string | null;
  /** Validator commission (0..1 fraction) — only set on /validators rows, absent elsewhere. */
  take?: number | null;
  /** DB-toggled maintainer pin (#5166) — a disclosed sponsored placement, not a
   * trust signal. Only set on /validators rows, absent elsewhere. */
  featured?: boolean;
  [key: string]: unknown;
}

/** The full metagraph snapshot from /api/v1/subnets/{netuid}/metagraph. */
export interface SubnetMetagraph {
  netuid: number;
  neuron_count?: number;
  captured_at?: string;
  block_number?: number;
  neurons: MetagraphNeuron[];
}

/** The pre-filtered/ranked validator set from /api/v1/subnets/{netuid}/validators. */
export interface SubnetValidators {
  netuid: number;
  validator_count?: number;
  captured_at?: string;
  block_number?: number;
  validators: MetagraphNeuron[];
}

/** Supported sort keys for GET /api/v1/validators. */
export type GlobalValidatorSort =
  | "avg_validator_trust"
  | "max_validator_trust"
  | "stake_dominance"
  | "subnet_count"
  | "total_emission"
  | "total_stake"
  | "uid_count";

/** One current subnet membership in the network-wide validator leaderboard. */
export interface GlobalValidatorSubnet {
  netuid: number;
  uid: number;
  stake_tao: number;
  emission_tao: number;
  validator_trust: number | null;
}

/** Self-declared on-chain identity for a validator's primary coldkey (#5234). */
export interface ColdkeyIdentity {
  has_identity: boolean;
  name: string | null;
  url: string | null;
  github: string | null;
  image: string | null;
  discord: string | null;
  description: string | null;
  additional: string | null;
  captured_at: string | null;
}

/** One validator/operator row grouped by hotkey across subnet memberships. */
export interface GlobalValidator {
  hotkey: string;
  /** DB-toggled maintainer pin (#5166) — always present, moves the row to the front of the default (unsorted) view. */
  featured: boolean;
  coldkey: string | null;
  /** Primary coldkey's self-declared identity (#5234); null when coldkey is null. */
  coldkey_identity: ColdkeyIdentity | null;
  coldkey_count: number;
  subnet_count: number;
  uid_count: number;
  /** Validator take/commission (#2548), 0..1 fraction kept from delegator rewards. */
  take: number | null;
  total_stake_tao: number;
  root_stake_tao: number;
  alpha_stake_tao: number;
  total_emission_tao: number;
  /** Distinct coldkeys currently staking to this hotkey, network-wide (#2549). Null when the low-frequency source table has no row for this hotkey yet. */
  nominator_count: number | null;
  /** Estimated annualized yield (#2551) — a stake-weighted blend across every subnet membership with a known tempo. See apy_estimate_eligible_subnet_count. Null when no membership resolved a tempo. */
  apy_estimate: number | null;
  /** Count of subnet memberships that contributed to apy_estimate, out of subnet_count total (#2551). */
  apy_estimate_eligible_subnet_count: number;
  avg_validator_trust: number | null;
  max_validator_trust: number | null;
  stake_dominance: number | null;
  latest_captured_at: string | null;
  latest_block_number: number | null;
  subnets: GlobalValidatorSubnet[];
}

/** Network-wide validator leaderboard from GET /api/v1/validators. */
export interface GlobalValidators {
  schema_version?: number;
  sort: GlobalValidatorSort;
  limit: number;
  validator_count: number;
  captured_at?: string;
  block_number?: number;
  validators: GlobalValidator[];
}

/**
 * One validator projected to the stake-decision fields by
 * /api/v1/compare/validators (#6325/#6998) — take rate, estimated APY,
 * nominator count, identity, plus the cross-subnet aggregates that give those
 * numbers context. Every field except hotkey is null when the neurons tier has
 * no row for that hotkey.
 */
export interface CompareValidator {
  hotkey: string;
  coldkey: string | null;
  coldkey_identity: ColdkeyIdentity | null;
  take: number | null;
  apy_estimate: number | null;
  apy_estimate_eligible_subnet_count: number | null;
  nominator_count: number | null;
  total_stake_tao: number | null;
  total_emission_tao: number | null;
  avg_validator_trust: number | null;
  max_validator_trust: number | null;
  subnet_count: number | null;
  /** Membership row in the optional netuid context, null without one (or no permit there). */
  subnet_context: GlobalValidatorSubnet | null;
}

/** Validator-side comparison from GET /api/v1/compare/validators (#6325). */
export interface CompareValidators {
  netuid: number | null;
  validator_count: number;
  validators: CompareValidator[];
}

/** One per-subnet membership row from /api/v1/validators/{hotkey} (#4335, 7.1). */
export interface ValidatorDetailSubnet {
  netuid: number;
  uid: number;
  hotkey?: string | null;
  coldkey?: string | null;
  active?: boolean | null;
  validator_permit: boolean;
  rank?: number | null;
  trust?: number | null;
  validator_trust?: number | null;
  consensus?: number | null;
  incentive?: number | null;
  dividends?: number | null;
  emission_tao?: number | null;
  stake_tao?: number | null;
  registered_at_block?: number | null;
  is_immunity_period?: boolean | null;
  axon?: string | null;
}

/** Cross-subnet validator detail from GET /api/v1/validators/{hotkey} (#4335, 7.1).
 * Schema-stable: a cold/unknown hotkey returns 200 with a zeroed aggregate, never 404. */
export interface ValidatorDetail {
  schema_version?: number;
  hotkey: string;
  coldkey: string | null;
  coldkey_identity: ColdkeyIdentity | null;
  coldkey_count: number;
  subnet_count: number;
  take: number | null;
  nominator_count: number | null;
  total_stake_tao: number;
  /** Stake on netuid 0 (root), TAO-denominated 1:1, no AMM/price exposure (#2550). */
  root_stake_tao: number;
  /** total_stake_tao minus root_stake_tao — the alpha-token-denominated legs. */
  alpha_stake_tao: number;
  total_emission_tao: number;
  avg_validator_trust: number | null;
  max_validator_trust: number | null;
  captured_at?: string | null;
  block_number?: number | null;
  subnets: ValidatorDetailSubnet[];
}

/** One nominator row from /api/v1/validators/{hotkey}/nominators (#4336, 7.2). */
export interface ValidatorNominatorEntry {
  coldkey: string;
  staked_tao: number;
  unstaked_tao: number;
  net_staked_tao: number;
  gross_staked_tao: number;
  event_count: number;
  last_observed_at?: string | null;
}

/** One daily snapshot from /api/v1/validators/{hotkey}/history (#4337, 7.3). */
export interface ValidatorHistoryPoint {
  snapshot_date: string;
  subnet_count?: number | null;
  total_stake_tao?: number | null;
  total_emission_tao?: number | null;
  /** Null when stake is 0/absent for the day (division by zero avoided server-side). */
  rewards_per_1000_tao?: number | null;
}

/** Daily stake/rewards history from GET /api/v1/validators/{hotkey}/history (#4337, 7.3). */
export interface ValidatorHistory {
  schema_version?: number;
  hotkey: string;
  window?: string | null;
  point_count: number;
  points: ValidatorHistoryPoint[];
}

/** One daily snapshot of an account's position on one subnet, from
 * /api/v1/accounts/{ss58}/subnets/{netuid}/history (#4329/6.2 -- the "Alpha
 * Holdings chart"). Same per-position field shape as AccountPortfolio's
 * positions[] entries, plus the date/capture stamp. */
export interface AccountPositionHistoryPoint {
  snapshot_date: string;
  captured_at?: string | null;
  uid: number | null;
  coldkey: string | null;
  role: "validator" | "miner";
  active: boolean;
  stake_tao: number | null;
  emission_tao: number | null;
  rank: number | null;
  trust: number | null;
  incentive: number | null;
  dividends: number | null;
  /** Null when stake is 0/absent for the day (division by zero avoided server-side). */
  yield: number | null;
}

/** Daily per-position history from GET /api/v1/accounts/{ss58}/subnets/{netuid}/history (#4329/6.2). */
export interface AccountPositionHistory {
  schema_version?: number;
  ss58: string;
  netuid: number;
  window?: string | null;
  point_count: number;
  points: AccountPositionHistoryPoint[];
}

/** A single neuron snapshot from /api/v1/subnets/{netuid}/neurons/{uid}. */
export interface SubnetNeuronSnapshot {
  netuid: number;
  uid: number;
  captured_at?: string;
  block_number?: number;
  neuron?: MetagraphNeuron;
}

/** One distribution metric block (stake / emission / entity_* / validator_*). */
export interface ConcentrationMetrics {
  holders?: number;
  total?: number;
  gini?: number;
  hhi?: number;
  hhi_normalized?: number;
  nakamoto_coefficient?: number;
  top_1pct_share?: number;
  top_5pct_share?: number;
  top_10pct_share?: number;
  top_20pct_share?: number;
  entropy?: number;
  entropy_normalized?: number;
}

/** Percentile spread of a 0–1 score across neurons (trust / consensus / validator_trust). */
export interface ScoreDistribution {
  count?: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  p10?: number | null;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
}

/** Concentration metrics from /api/v1/subnets/{netuid}/concentration. */
export interface SubnetConcentration {
  netuid: number;
  neuron_count?: number;
  entity_count?: number;
  uids_per_entity?: number;
  captured_at?: string;
  stake?: ConcentrationMetrics;
  emission?: ConcentrationMetrics;
  entity_stake?: ConcentrationMetrics;
  entity_emission?: ConcentrationMetrics;
  validator_stake?: ConcentrationMetrics;
}

/** One daily concentration-history point from /concentration/history. */
export interface ConcentrationHistoryPoint {
  snapshot_date: string;
  neuron_count?: number;
  stake_gini?: number | null;
  stake_nakamoto_coefficient?: number | null;
  stake_top_10pct_share?: number | null;
  emission_gini?: number | null;
  emission_nakamoto_coefficient?: number | null;
  emission_top_10pct_share?: number | null;
  [key: string]: unknown;
}

/** Concentration drift from /api/v1/subnets/{netuid}/concentration/history. */
export interface SubnetConcentrationHistory {
  netuid: number;
  window?: string;
  point_count?: number;
  points: ConcentrationHistoryPoint[];
}

/** Reward-distribution & score-spread metrics from /api/v1/subnets/{netuid}/performance. */
export interface SubnetPerformance {
  netuid: number;
  neuron_count?: number;
  active_count?: number;
  validator_count?: number;
  captured_at?: string;
  incentive?: ConcentrationMetrics;
  dividends?: ConcentrationMetrics;
  trust?: ScoreDistribution;
  consensus?: ScoreDistribution;
  validator_trust?: ScoreDistribution;
}

/** One daily performance-history point from /performance/history. */
export interface PerformanceHistoryPoint {
  snapshot_date: string;
  neuron_count?: number;
  active_count?: number;
  validator_count?: number;
  incentive_gini?: number | null;
  incentive_nakamoto_coefficient?: number | null;
  incentive_top_10pct_share?: number | null;
  dividends_gini?: number | null;
  dividends_nakamoto_coefficient?: number | null;
  dividends_top_10pct_share?: number | null;
  trust_mean?: number | null;
  trust_median?: number | null;
  consensus_mean?: number | null;
  consensus_median?: number | null;
  validator_trust_mean?: number | null;
  validator_trust_median?: number | null;
  [key: string]: unknown;
}

/** Reward-flow drift from /api/v1/subnets/{netuid}/performance/history. */
export interface SubnetPerformanceHistory {
  netuid: number;
  window?: string;
  point_count?: number;
  points: PerformanceHistoryPoint[];
}

/** One per-UID emission-yield row from /api/v1/subnets/{netuid}/yield. */
export interface SubnetYieldNeuron {
  uid: number;
  hotkey: string | null;
  role: "validator" | "miner";
  stake_tao: number;
  emission_tao: number;
  yield: number | null;
  vs_median: "above" | "below" | "at" | null;
}

/** Per-UID emission-yield snapshot from /api/v1/subnets/{netuid}/yield. */
export interface SubnetYield {
  netuid: number;
  captured_at?: string;
  block_number?: number;
  neuron_count?: number;
  validator_count?: number;
  miner_count?: number;
  total_stake_tao?: number;
  total_emission_tao?: number;
  subnet_yield?: number | null;
  mean_yield?: number | null;
  median_yield?: number | null;
  p25_yield?: number | null;
  p75_yield?: number | null;
  p90_yield?: number | null;
  neurons: SubnetYieldNeuron[];
}

/** One daily yield-distribution point from /yield/history. */
export interface YieldHistoryPoint {
  snapshot_date: string;
  neuron_count?: number;
  validator_count?: number;
  yield_count?: number;
  subnet_yield?: number | null;
  mean_yield?: number | null;
  median_yield?: number | null;
  p25_yield?: number | null;
  p75_yield?: number | null;
  p90_yield?: number | null;
  [key: string]: unknown;
}

/** Emission-yield drift from /api/v1/subnets/{netuid}/yield/history. */
export interface SubnetYieldHistory {
  netuid: number;
  window?: string;
  point_count?: number;
  points: YieldHistoryPoint[];
}

// --- Compile-time contract enforcement ---------------------------------------
//
// These are type-only assertions (zero runtime cost). They tie this file's UI
// render shapes + enum mappings back to the published contract, so a backend
// contract change that this file hasn't tracked becomes a `tsc` error instead of
// a silent drift (the failure mode #1758 set out to close). To see them bite,
// edit one of the expected unions below and run `npm run typecheck`.

/** Assert two types are mutually assignable (i.e. structurally equal). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Assert `Child` is assignable to `Parent` (a subset relation). */
type Extends<Child, Parent> = Child extends Parent ? true : false;

/** Compiles only when the assertion type resolves to exactly `true`. */
type Assert<T extends true> = T;

// The UI's CurationLevel must stay byte-for-byte the contract enum — this is a
// pure re-export, so equality both proves the alias is wired up and breaks if a
// future package bump changes the member set.
type _CurationLevelMatchesContract = Assert<Equals<CurationLevel, ApiSchema<"CurationLevel">>>;

// The canonical health enum the presentation mapping (`statusToHealth`) consumes.
// If the backend adds/renames a HealthStatus member, the adapter's exhaustive
// test fails AND this anchor confirms the source enum moved.
type _HealthStatusMatchesContract = Assert<Equals<HealthStatus, ApiSchema<"HealthStatus">>>;

// `Provider.authority` is now sourced from the contract Authority enum (the
// `third-party` drift fix). Asserting the contract enum is assignable to the
// field's type proves every real authority value is representable — i.e. we did
// not narrow away a backend member.
type _AuthorityRepresentable = Assert<Extends<Authority, NonNullable<Provider["authority"]>>>;
type _SurfaceAuthorityRepresentable = Assert<Extends<Authority, NonNullable<Surface["authority"]>>>;

// The render shapes read specific wire fields off the contract types; these
// assertions fail to compile if the backend renames/removes the consumed field,
// pinning the normalizers in `queries.ts` to the contract.
//   - normalizeEndpoint maps the wire `status` (HealthStatus) → UI `health`.
type _EndpointStatusIsHealthStatus = Assert<Equals<ApiEndpointResource["status"], HealthStatus>>;
//   - normalizeSurface reads the wire `authority` to derive the chip level.
type _SurfaceWireHasAuthority = Assert<Extends<ApiSurface["authority"], Authority>>;
//   - the per-surface health probe carries the canonical status enum.
type _HealthSurfaceStatusIsHealthStatus = Assert<Equals<ApiHealthSurface["status"], HealthStatus>>;

// Reference the assertion aliases so `noUnusedLocals` / eslint don't strip them;
// `satisfies true` re-checks each at the value level for good measure.
export const __contractAssertions = {
  curationLevel: true as _CurationLevelMatchesContract,
  healthStatus: true as _HealthStatusMatchesContract,
  authorityRepresentable: true as _AuthorityRepresentable,
  surfaceAuthorityRepresentable: true as _SurfaceAuthorityRepresentable,
  endpointStatusIsHealthStatus: true as _EndpointStatusIsHealthStatus,
  surfaceWireHasAuthority: true as _SurfaceWireHasAuthority,
  healthSurfaceStatusIsHealthStatus: true as _HealthSurfaceStatusIsHealthStatus,
} satisfies Record<string, true>;

// ---- Chain analytics dashboard (epic #1986) -------------------------------

export interface ChainActivityDay {
  day: string;
  block_count: number;
  extrinsic_count: number;
  event_count: number;
  successful_extrinsics: number;
  success_rate: number | null;
  unique_signers: number;
}
export interface ChainActivity {
  schema_version: number;
  window: string;
  observed_at: string | null;
  day_count: number;
  days: ChainActivityDay[];
}
// #3365: network-wide economics rollup (subnet_snapshots, not the chain-indexer
// tables the rest of the explorer page reads from).
export interface EconomicsTrendsDay {
  snapshot_date: string;
  subnet_count: number;
  total_stake_tao: number | null;
  alpha_price_tao_weighted: number | null;
  alpha_price_tao_median: number | null;
  validator_count: number | null;
  miner_count: number | null;
  mean_emission_share: number | null;
}
export interface EconomicsTrends {
  schema_version: number;
  window: string | null;
  day_count: number;
  days: EconomicsTrendsDay[];
}
export interface ChainCallEntry {
  call_module: string;
  call_function: string | null;
  count: number;
  share: number | null;
}
export interface ChainCalls {
  schema_version: number;
  window: string;
  group_by: string;
  observed_at: string | null;
  total_extrinsics: number;
  call_count: number;
  calls: ChainCallEntry[];
}

// #3489: raw all-events tier (ADR 0013) pallet.method distribution from
// GET /api/v1/chain-events/stats — the raw-tier counterpart to ChainCalls
// (the D1 /chain/calls aggregate). No schema_version/observed_at envelope; the
// endpoint returns the block window it scanned, the distinct pallet.method
// group count, and the count-descending activity rows.
export interface ChainEventsStatsEntry {
  pallet: string;
  method: string | null;
  count: number;
}
export interface ChainEventsStats {
  window_blocks: number;
  groups: number;
  activity: ChainEventsStatsEntry[];
}
export interface ChainStakeFlowNetwork {
  total_staked_tao: number;
  total_unstaked_tao: number;
  net_flow_tao: number;
  gross_flow_tao: number;
  stake_events: number;
  unstake_events: number;
  gaining: number;
  losing: number;
  flat: number;
}
export interface ChainStakeFlowDistribution {
  count: number;
  mean: number | null;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}
export interface ChainStakeFlowSubnet {
  netuid: number;
  total_staked_tao: number;
  total_unstaked_tao: number;
  net_flow_tao: number;
  gross_flow_tao: number;
  stake_events: number;
  unstake_events: number;
  direction: string;
}
export interface ChainStakeFlow {
  schema_version: number;
  window: string;
  observed_at: string | null;
  subnet_count: number;
  network: ChainStakeFlowNetwork | null;
  net_flow_distribution: ChainStakeFlowDistribution | null;
  subnets: ChainStakeFlowSubnet[];
}
export interface ChainTurnoverNetwork {
  validators_start: number;
  validators_end: number;
  validators_entered: number;
  validators_exited: number;
  validator_retention: number | null;
  stability_score: number | null;
}
export interface ChainTurnoverSubnet {
  netuid: number;
  validators_start: number;
  validators_end: number;
  validators_entered: number;
  validators_exited: number;
  validator_retention: number | null;
  stability_score: number | null;
}
export interface ChainTurnover {
  schema_version: number;
  window: string;
  start_date: string | null;
  end_date: string | null;
  comparable: boolean;
  subnet_count: number;
  network: ChainTurnoverNetwork | null;
  subnets: ChainTurnoverSubnet[];
}
export interface ChainStakeMovesNetwork {
  distinct_movers: number;
  movements: number;
  movements_per_mover: number;
}
export interface ChainStakeMovesDistribution {
  count: number;
  mean: number | null;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}
export interface ChainStakeMovesSubnet {
  netuid: number;
  distinct_movers: number;
  movements: number;
  movements_per_mover: number;
}
export interface ChainStakeMoves {
  schema_version: number;
  window: string;
  observed_at: string | null;
  subnet_count: number;
  network: ChainStakeMovesNetwork | null;
  intensity_distribution: ChainStakeMovesDistribution | null;
  subnets: ChainStakeMovesSubnet[];
}
export interface ChainSignerEntry {
  signer: string;
  tx_count: number;
  total_fee_tao: number;
  total_tip_tao: number;
  last_tx_block: number | null;
}
export interface ChainSigners {
  schema_version: number;
  window: string;
  observed_at: string | null;
  signer_count: number;
  signers: ChainSignerEntry[];
}
// #3475: network-wide native-TAO transfer-volume leaderboard -- distinct from
// ChainTransferPairs (#3476, directed sender->receiver corridors).
export interface ChainTransferEntry {
  address: string;
  volume_tao: number;
  transfer_count: number;
}
export interface ChainTransfers {
  schema_version: number;
  window: string;
  observed_at: string | null;
  total_volume_tao: number;
  transfer_count: number;
  unique_senders: number;
  unique_receivers: number;
  top_sender_share: number | null;
  top_senders: ChainTransferEntry[];
  top_receivers: ChainTransferEntry[];
}
export interface ChainFeeDay {
  day: string;
  extrinsic_count: number;
  total_fee_tao: number;
  avg_fee_tao: number | null;
  total_tip_tao: number;
  avg_tip_tao: number | null;
}
export interface ChainFeePayer {
  signer: string;
  total_fee_tao: number;
  total_tip_tao: number;
  extrinsic_count: number;
}
export interface ChainFees {
  schema_version: number;
  window: string;
  observed_at: string | null;
  day_count: number;
  daily: ChainFeeDay[];
  top_fee_payers: ChainFeePayer[];
}

/** One directed sender→receiver pair on the chain transfer-pairs leaderboard (#3476). */
export interface ChainTransferPair {
  from: string;
  to: string;
  volume_tao: number;
  transfer_count: number;
  last_block: number | null;
  last_observed_at: string | null;
}

/**
 * Network-wide directed native-TAO transfer-pair analytics over a 7d/30d window
 * (#3476), from GET /api/v1/chain/transfer-pairs — top sender→receiver corridors
 * ranked by volume or count, plus window rollup (unique pairs, top-pair share).
 * Zeroed with an empty pairs list when the store is cold.
 */
export interface ChainTransferPairs {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  sort: "volume" | "count";
  total_volume_tao: number;
  transfer_count: number;
  unique_pairs: number;
  pair_count: number;
  top_pair_share: number | null;
  pairs: ChainTransferPair[];
}

/** One subnet's row on the network-wide stake-transfer leaderboard (#3467). */
export interface ChainStakeTransferSubnet {
  netuid: number;
  distinct_senders: number;
  transfers: number;
  transfers_per_sender: number | null;
}

/** Network-wide stake-transfer rollup — true distinct-sender count (not a per-subnet sum) + total transfers. */
export interface ChainStakeTransferNetwork {
  distinct_senders: number;
  transfers: number;
  transfers_per_sender: number | null;
}

/** Distribution summary of per-subnet transfer intensity (count, mean, min, p25, median, p75, p90, max). */
export interface ChainIntensityDistribution {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

/**
 * Network-wide stake-transfer leaderboard over a 7d/30d window (#3467), from
 * GET /api/v1/chain/stake-transfers — subnets ranked by StakeTransferred event
 * count, distinct senders, and transfers per sender, plus the true network-wide
 * distinct-sender rollup and a distribution summary of the per-subnet transfer
 * intensity. The between-coldkeys sibling of /api/v1/chain/stake-moves
 * (within-account re-delegation churn). Zeroed with an empty subnets list when
 * the store is cold.
 */
export interface ChainStakeTransfers {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainStakeTransferNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainStakeTransferSubnet[];
}

/** One subnet's row on the network-wide axon-teardown ("churn") leaderboard (#3464). */
export interface ChainAxonRemovalSubnet {
  netuid: number;
  distinct_removers: number;
  removals: number;
  removals_per_remover: number | null;
}

/** Network-wide axon-teardown rollup — true distinct-remover count (not a per-subnet sum) + total removals. */
export interface ChainAxonRemovalNetwork {
  distinct_removers: number;
  removals: number;
  removals_per_remover: number | null;
}

/**
 * Network-wide axon-teardown ("churn") leaderboard over a 7d/30d window (#3464),
 * from GET /api/v1/chain/axon-removals — the teardown-side complement of the
 * serving leaderboard: subnets ranked by AxonInfoRemoved event count, plus the
 * true network-wide distinct-remover rollup and a distribution summary of the
 * per-subnet teardown intensity. Zeroed with an empty subnets list when the
 * store is cold.
 */
export interface ChainAxonRemovals {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainAxonRemovalNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainAxonRemovalSubnet[];
}

/** One subnet's row on the network-wide neuron-deregistration leaderboard (#3466). */
export interface ChainDeregistrationsSubnet {
  netuid: number;
  distinct_deregistered_hotkeys: number;
  deregistrations: number;
  deregistrations_per_hotkey: number | null;
}

/** Network-wide deregistration rollup — true distinct-hotkey count (not a per-subnet sum) + total deregistrations. */
export interface ChainDeregistrationsNetwork {
  distinct_deregistered_hotkeys: number;
  deregistrations: number;
  deregistrations_per_hotkey: number | null;
}

/**
 * Network-wide neuron-deregistration activity over a 7d/30d window (#3466), from
 * GET /api/v1/chain/deregistrations — subnets ranked by NeuronDeregistered event count,
 * plus the true network-wide distinct-hotkey rollup and a distribution summary of
 * per-subnet re-deregistration intensity. Zeroed with an empty subnets list when cold.
 */
export interface ChainDeregistrations {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainDeregistrationsNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainDeregistrationsSubnet[];
}

/** One subnet's row on the network-wide weight-setting activity leaderboard. */
export interface ChainWeightsSubnet {
  netuid: number;
  distinct_setters: number;
  weight_sets: number;
  sets_per_setter: number | null;
}

/** Network-wide weight-setting rollup — true distinct-setter count (not a per-subnet sum) + total WeightsSet events. */
export interface ChainWeightsNetwork {
  distinct_setters: number;
  weight_sets: number;
  sets_per_setter: number | null;
}

/**
 * Network-wide validator weight-setting activity over a 7d/30d window, from
 * GET /api/v1/chain/weights — subnets ranked by WeightsSet event count, plus the true
 * network-wide distinct-setter rollup and a distribution summary of per-subnet update
 * intensity (WeightsSet events per validator). Zeroed with an empty subnets list when cold.
 */
export interface ChainWeights {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainWeightsNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainWeightsSubnet[];
}

/** One subnet's row on the network-wide axon-serving leaderboard (#3463). */
export interface ChainServingSubnet {
  netuid: number;
  distinct_servers: number;
  announcements: number;
  announcements_per_server: number | null;
}

/** Network-wide axon-serving rollup from GET /api/v1/chain/serving. */
export interface ChainServingNetwork {
  distinct_servers: number;
  announcements: number;
  announcements_per_server: number | null;
}

/**
 * Network-wide axon-serving activity over a 7d/30d window (#3463), from
 * GET /api/v1/chain/serving — subnets ranked by AxonServed announcement volume,
 * plus the true network-wide distinct-server rollup and intensity distribution.
 * Zeroed when cold.
 */
export interface ChainServing {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainServingNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainServingSubnet[];
}

/** One subnet's row on the network-wide Prometheus-telemetry leaderboard (#3463). */
export interface ChainPrometheusSubnet {
  netuid: number;
  distinct_exporters: number;
  announcements: number;
  announcements_per_exporter: number | null;
}

/** Network-wide Prometheus-telemetry rollup from GET /api/v1/chain/prometheus. */
export interface ChainPrometheusNetwork {
  distinct_exporters: number;
  announcements: number;
  announcements_per_exporter: number | null;
}

/**
 * Network-wide Prometheus-endpoint telemetry over a 7d/30d window (#3463), from
 * GET /api/v1/chain/prometheus — subnets ranked by PrometheusServed announcement
 * volume, plus the true network-wide distinct-exporter rollup and intensity
 * distribution. Zeroed when cold.
 */
export interface ChainPrometheus {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainPrometheusNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainPrometheusSubnet[];
}

/** One subnet's row on the network-wide neuron-registration leaderboard (#3465). */
export interface ChainRegistrationsSubnet {
  netuid: number;
  distinct_registrants: number;
  registrations: number;
  registrations_per_registrant: number | null;
}

/** Network-wide registration rollup — true distinct-registrant count (not a per-subnet sum) + total registrations. */
export interface ChainRegistrationsNetwork {
  distinct_registrants: number;
  registrations: number;
  registrations_per_registrant: number | null;
}

/**
 * Network-wide neuron-registration activity over a 7d/30d window (#3465), from
 * GET /api/v1/chain/registrations — subnets ranked by NeuronRegistered event count,
 * plus the true network-wide distinct-registrant rollup and a distribution summary of
 * per-subnet re-registration intensity. Zeroed with an empty subnets list when cold.
 */
export interface ChainRegistrations {
  schema_version: number;
  window: string | null;
  observed_at: string | null;
  subnet_count: number;
  network: ChainRegistrationsNetwork;
  intensity_distribution: ChainIntensityDistribution | null;
  subnets: ChainRegistrationsSubnet[];
}

/** Network-wide stake/emission concentration from GET /api/v1/chain/concentration. */
export interface ChainConcentration {
  schema_version: number;
  subnet_count: number;
  neuron_count: number;
  entity_count: number;
  uids_per_entity: number | null;
  captured_at: string | null;
  stake: ConcentrationMetrics | null;
  emission: ConcentrationMetrics | null;
  entity_stake: ConcentrationMetrics | null;
  entity_emission: ConcentrationMetrics | null;
  validator_stake: ConcentrationMetrics | null;
}

/** Network-wide reward-distribution & score spread from GET /api/v1/chain/performance. */
export interface ChainPerformance {
  schema_version: number;
  subnet_count: number;
  neuron_count: number;
  validator_count?: number;
  active_count?: number;
  captured_at: string | null;
  incentive: ConcentrationMetrics | null;
  dividends: ConcentrationMetrics | null;
  trust: ScoreDistribution | null;
  consensus: ScoreDistribution | null;
  validator_trust: ScoreDistribution | null;
}

/** Per-neuron emission/stake return distribution summary within GET /api/v1/chain/yield. */
export interface ChainYieldDistribution {
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

/**
 * Network-wide emission-yield aggregate (#3472) from GET /api/v1/chain/yield —
 * the return-rate companion to /chain/performance: total emission over total
 * stake (network-wide and split by validator/miner role), plus the per-neuron
 * return distribution. Yields are null when no neuron has both stake and
 * emission; distribution is null on a cold snapshot.
 */
export interface ChainYield {
  schema_version: number;
  subnet_count: number;
  neuron_count: number;
  validator_count: number;
  miner_count: number;
  captured_at: string | null;
  total_stake_tao: number;
  total_emission_tao: number;
  network_yield: number | null;
  validator_yield: number | null;
  miner_yield: number | null;
  distribution: ChainYieldDistribution | null;
}

/* ===================== Theme C: registry & network-health depth ===================== */

/**
 * /api/v1/health/trends — the BULK per-day health trend artifact. Distinct from
 * the per-subnet /api/v1/subnets/{netuid}/health/trends shape (HealthTrendWindow):
 * this one carries `windows[range].subnets[].points[]`, one real point per day.
 */
export interface BulkHealthTrendPoint {
  date: string; // YYYY-MM-DD
  samples?: number;
  uptime_ratio?: number | null; // 0–1
  avg_latency_ms?: number | null;
  latency_sample_count?: number;
  [key: string]: unknown;
}

export interface BulkHealthTrendSubnet {
  netuid: number;
  samples?: number;
  uptime_ratio?: number;
  avg_latency_ms?: number;
  latency_sample_count?: number;
  points: BulkHealthTrendPoint[];
  [key: string]: unknown;
}

export interface BulkHealthTrendWindow {
  days?: number;
  granularity?: string;
  subnet_count?: number;
  subnets: BulkHealthTrendSubnet[];
  [key: string]: unknown;
}

export interface BulkHealthTrends {
  observed_at?: string;
  schema_version?: number;
  source?: string;
  windows: Record<string, BulkHealthTrendWindow>;
}

/** One per-day aggregate distilled from all subnets' points[] for a window. */
export interface HealthTrendDay {
  date: string;
  uptime_ratio: number; // 0–1, sample-weighted mean across subnets
  samples: number;
  subnet_count: number;
}

/** /api/v1/registry/summary — counts, distributions, and a top-subnet leaderboard. */
export interface RegistrySummaryDimension {
  pct?: number;
  present?: number;
}

export interface RegistrySummaryTopSubnet {
  netuid: number;
  name?: string;
  slug?: string;
  completeness_score?: number;
  curation_level?: string;
  profile_level?: string;
}

export interface RegistrySummary {
  contract_version?: string;
  generated_at?: string;
  subnet_count?: number;
  counts: Record<string, number>;
  curation_level_counts: Record<string, number>;
  profile_level_counts: Record<string, number>;
  coverage: {
    average_score?: number;
    median_score?: number;
    fully_complete_count?: number;
    fully_complete_pct?: number;
    scored_subnet_count?: number;
    score_distribution: Record<string, number>;
    dimension_coverage: Record<string, RegistrySummaryDimension>;
  };
  top_subnets: RegistrySummaryTopSubnet[];
}

/** /api/v1/coverage-depth — per-subnet dimension counts + a ranked enrichment queue. */
export interface CoverageDepthDimensions {
  surface_count?: number;
  official_surface_count?: number;
  service_count?: number;
  callable_service_count?: number;
  schema_service_count?: number;
  schema_missing_count?: number;
  sdk_count?: number;
  example_count?: number;
  data_artifact_count?: number;
  candidate_count?: number;
  candidate_operational_count?: number;
  fixture_available_count?: number;
  docs_url_present?: boolean;
  source_repo_present?: boolean;
  provider_claimed_surface_count?: number;
  registry_observed_surface_count?: number;
  service_kinds?: string[];
  fixture_status_counts?: Record<string, number>;
  [key: string]: unknown;
}

export interface CoverageDepthRow {
  netuid: number;
  name?: string;
  slug?: string;
  tier?: string;
  agent_status?: string;
  blocker_level?: string;
  score?: number;
  readiness_score?: number;
  priority_score?: number;
  completeness_score?: number;
  curation_level?: string;
  profile_level?: string;
  subnet_type?: string;
  recommended_next_action?: string;
  top_gap_codes?: string[];
  dimensions: CoverageDepthDimensions;
  [key: string]: unknown;
}

export interface CoverageDepthQueueRow {
  rank: number;
  netuid: number;
  name?: string;
  slug?: string;
  priority_score?: number;
  score?: number;
  severity?: string;
  tier?: string;
  recommended_next_action?: string;
  top_gap_codes?: string[];
}

export interface CoverageDepth {
  contract_version?: string;
  generated_at?: string;
  subnet_count?: number;
  ranked_queue: CoverageDepthQueueRow[];
  rows: CoverageDepthRow[];
}

/** /api/v1/health/history/{date} — one day's per-surface probe snapshot. */
export interface HealthHistorySurface {
  surface_id?: string;
  netuid?: number;
  provider?: string;
  kind?: string;
  status?: string; // ok | degraded | failed | unknown
  classification?: string;
  latency_ms?: number | null;
  status_code?: number | null;
  last_checked?: string;
  last_ok?: string | null;
  verified_at?: string;
  error_class?: string | null;
  [key: string]: unknown;
}

export interface HealthHistory {
  date?: string;
  probe_started_at?: string;
  probe_finished_at?: string;
  summary: {
    status_counts: Record<string, number>;
    classification_counts: Record<string, number>;
    surface_count?: number;
  };
  surfaces: HealthHistorySurface[];
}

/** /api/v1/source-health — per-provider verification + status rollup. */
export interface SourceHealthProvider {
  id: string;
  name?: string;
  kind?: string;
  authority?: string;
  status?: string; // ok | degraded | failed | unknown
  endpoint_count?: number;
  rpc_endpoint_count?: number;
  candidate_count?: number;
  verification_result_count?: number;
  classifications?: Record<string, number>;
  [key: string]: unknown;
}

export interface SourceHealth {
  generated_at?: string;
  providers: SourceHealthProvider[];
  summary: {
    provider_count?: number;
    endpoint_count?: number;
    rpc_endpoint_count?: number;
    candidate_count?: number;
    verification_result_count?: number;
    status_counts: Record<string, number>;
  };
}

/* ===================== Theme C: agent-catalog (capability) ===================== */

export interface AgentCatalogBlocker {
  code?: string;
  field?: string;
  message?: string;
  next_action?: string;
  severity?: string;
}

export interface AgentReadiness {
  status?: string;
  blocker_level?: string;
  blockers?: AgentCatalogBlocker[];
  missing_fields?: string[];
  [key: string]: unknown;
}

export interface AgentCatalogServiceHealth {
  status?: string;
  classification?: string;
  latency_ms?: number;
  last_ok?: string;
  last_checked?: string;
  stale?: boolean;
  observed_by?: string;
}

export interface AgentCatalogService {
  kind?: string; // subnet-api | openapi | sse | data-artifact
  capability?: string;
  description?: string | null;
  base_url?: string;
  provider?: string;
  authority?: string;
  auth_required?: boolean;
  auth_schemes?: string[];
  health?: AgentCatalogServiceHealth;
  eligibility?: { callable?: boolean; live_status?: string; reasons?: string[] };
  schema_url?: string | null;
  surface_id?: string;
  [key: string]: unknown;
}

export interface AgentCatalogReadiness {
  score?: number;
  readiness_tier?: string;
  components?: Record<string, boolean>;
  readiness_verified?: boolean;
  [key: string]: unknown;
}

/** A row in the /api/v1/agent-catalog list (ready or blocked bucket). */
export interface AgentCatalogSummary {
  netuid: number;
  name?: string;
  slug?: string;
  subnet_type?: string;
  integration_readiness?: number;
  completeness_score?: number;
  readiness_tier?: string;
  service_count?: number;
  callable_count?: number;
  service_kinds?: string[];
  categories?: string[];
  base_url?: string;
  health?: string;
  agent_readiness?: AgentReadiness;
  readiness?: AgentCatalogReadiness;
}

/** /api/v1/agent-catalog/{netuid} detail (services + examples). */
export interface AgentCatalogDetail extends AgentCatalogSummary {
  services?: AgentCatalogService[];
  examples?: unknown[];
  example_count?: number;
  generated_at?: string;
  operational_observed_at?: string;
  health_source?: string;
}

/** A single vector-similarity hit from /api/v1/search/semantic. */
export interface SemanticSearchResult {
  score: number;
  type: string | null;
  netuid: number | null;
  slug: string | null;
  title: string | null;
  subtitle: string | null;
  url: string | null;
  categories: string[];
  service_kinds: string[];
}

/** /api/v1/search/semantic response envelope. */
export interface SemanticSearchResponse {
  query: string;
  count: number;
  results: SemanticSearchResult[];
  model: string;
}

/** Change-feed webhook subscription filters — both narrow, both optional. */
export interface WebhookSubscriptionFilters {
  netuids?: number[];
  kinds?: Array<"subnets" | "artifacts">;
}

/** Rolled-up delivery health for a subscription, from GET .../webhooks/subscriptions/{id}. */
export interface WebhookDeliveryStatus {
  status: "ok" | "retrying" | "dead_letter";
  pending: number;
  dead_letter: number;
  last_failure?: {
    event_id?: string;
    attempts?: number;
    reason?: string;
    status_code?: number;
    state?: string;
    last_attempt_at?: string;
    next_attempt_at?: string | null;
  } | null;
}

/**
 * POST /api/v1/webhooks/subscriptions response. `secret` is returned exactly
 * once here — GET never echoes it back.
 */
export interface WebhookSubscriptionCreated {
  id: string;
  url: string;
  filters: WebhookSubscriptionFilters;
  secret: string;
  active: boolean;
  created_at: string;
  delivery: {
    method: string;
    content_type: string;
    signature_header: string;
    signature_algorithm: string;
    event_id_header: string;
    idempotency_header: string;
    note: string;
  };
}

/** GET /api/v1/webhooks/subscriptions/{id} response — no secret. */
export interface WebhookSubscriptionView {
  id: string;
  url: string;
  filters: WebhookSubscriptionFilters;
  created_at: string | null;
  active: boolean;
  delivery: WebhookDeliveryStatus;
}

/**
 * POST /api/v1/alerts/triggers response (#4984 Part 1). `owner_token` is
 * returned exactly once here — GET/PATCH never echo it back, matching the
 * webhook subscription secret's own once-only convention.
 */
export interface AlertTriggerCreated {
  id: string;
  name: string | null;
  table_filter: string[] | null;
  netuid: number | null;
  event_kind: string | null;
  account: string | null;
  min_amount_tao: number | null;
  channel: "webhook" | "email" | "telegram" | "discord";
  destination: string;
  active: boolean;
  created_at: string | null;
  updated_at: string | null;
  last_matched_at: string | null;
  match_count: number;
  owner_token: string;
}
