// Local TS types for Metagraphed API responses.
// Frontend is NOT contract authority — these are pragmatic shapes for what we
// render. Unknown extra fields are preserved via index signature.

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

export type CurationLevel =
  | "native"
  | "candidate-discovered"
  | "machine-verified"
  | "maintainer-reviewed"
  | "adapter-backed";

export type CoverageLevel = "native-only" | "manifested" | "probed";

export type HealthState = "ok" | "warn" | "down" | "unknown";

export interface Subnet {
  netuid: number;
  name?: string;
  symbol?: string;
  type?: "root" | "application";
  participants?: number;
  tempo?: number;
  registration_block?: number;
  mechanism_count?: number;
  curation_level?: CurationLevel;
  coverage_level?: CoverageLevel;
  surfaces_count?: number;
  candidates_count?: number;
  health?: HealthState;
  health_score?: number;
  freshness?: string; // iso
  updated_at?: string;
  website?: string;
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
  verified?: boolean;
  schema_url?: string;
  curation_level?: CurationLevel;
  updated_at?: string;
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
  authority?: "official" | "community" | "third-party" | string;
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
  title?: string;
  description?: string;
  suggested_action?: string;
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

/** Per-surface SLA + reconstructed downtime from /subnets/{n}/health/incidents. */
export interface SurfaceSla {
  surface_id: string;
  samples?: number;
  uptime_ratio?: number;
  incident_count?: number;
  downtime_ms?: number;
  incidents?: Array<{
    started_at?: number;
    ended_at?: number | null;
    [key: string]: unknown;
  }>;
}

/** One weekly structural snapshot from /subnets/{n}/trajectory. */
export interface TrajectoryPoint {
  date: string;
  completeness_score?: number;
  surface_count?: number;
  endpoint_count?: number;
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
