// Local TS types for Metagraphed API responses.
// Frontend is NOT contract authority — these are pragmatic shapes for what we
// render. Unknown extra fields are preserved via index signature.

export interface ApiPagination {
  collection?: string;
  total?: number;
  returned?: number;
  limit?: number;
  cursor?: number;
  next_cursor?: number;
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
  cursor?: string | null;
  next_cursor?: string | null;
  prev_cursor?: string | null;
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
  [key: string]: unknown;
}

export interface PrimaryLinks {
  website?: string;
  docs?: string;
  repo?: string;
  dashboard?: string;
}

export interface PrimaryAppSurface {
  id?: string;
  kind?: string;
  name?: string;
  provider?: string;
  url?: string;
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

export interface Coverage {
  netuids_total?: number;
  netuids_active?: number;
  manifested?: number;
  probed?: number;
  native_only?: number;
  adapter_backed?: number;
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
