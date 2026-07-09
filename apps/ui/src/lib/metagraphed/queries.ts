import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { apiFetch, type ApiResult, type QueryParams } from "./client";
import { getNetwork } from "./config";
import { blockRefPathSegment } from "./blocks";
import { extrinsicHashPathSegment } from "./extrinsics";
import { isValidSs58, ss58PathSegment } from "./accounts";
import { isSchemaDrift, normalizeDriftStatus } from "./schema-drift";
import type {
  AdapterSnapshot,
  AgentResource,
  AgentResources,
  AgentCatalogSummary,
  AgentCatalogDetail,
  AgentCatalogService,
  AgentReadiness,
  AgentCatalogBlocker,
  AskAnswerData,
  BulkHealthTrends,
  BulkHealthTrendSubnet,
  BulkHealthTrendPoint,
  HealthTrendDay,
  RegistrySummary,
  RegistrySummaryTopSubnet,
  CoverageDepth,
  CoverageDepthRow,
  CoverageDepthQueueRow,
  HealthHistory,
  HealthHistorySurface,
  SourceHealth,
  SourceHealthProvider,
  AccountAxonRemovals,
  AccountAxonRemovalsSubnet,
  AccountDeregistrations,
  AccountRegistrations,
  AccountRegistrationsSubnet,
  AccountDeregistrationsSubnet,
  AccountWeightSetters,
  AccountWeightSettersSubnet,
  AccountPrometheus,
  AccountPrometheusSubnet,
  AccountServing,
  AccountServingSubnet,
  AccountBalance,
  AccountDay,
  AccountEvent,
  AccountEventsPage,
  AccountHistory,
  AccountPortfolio,
  AccountStakeMoves,
  AccountStakeMovesSubnet,
  AccountRegistration,
  AccountSubnets,
  AccountSummary,
  PortfolioConcentration,
  PortfolioPosition,
  Block,
  ChainActivity,
  ChainActivityDay,
  ChainCalls,
  ChainStakeFlow,
  ChainStakeFlowDistribution,
  ChainStakeFlowNetwork,
  ChainStakeFlowSubnet,
  ChainStakeMoves,
  ChainTurnover,
  ChainTurnoverNetwork,
  ChainTurnoverSubnet,
  ChainStakeMovesDistribution,
  ChainStakeMovesNetwork,
  ChainStakeMovesSubnet,
  ChainCallEntry,
  ChainEventsStats,
  ChainEventsStatsEntry,
  ChainFees,
  ChainFeeDay,
  ChainFeePayer,
  ChainTransferPair,
  ChainTransferPairs,
  ChainStakeTransfers,
  ChainStakeTransferSubnet,
  ChainIntensityDistribution,
  ChainConcentration,
  ChainPerformance,
  ChainSigners,
  ChainSignerEntry,
  Extrinsic,
  ExtrinsicCallArg,
  SudoKey,
  Transfer,
  Candidate,
  Compare,
  CompareSubnet,
  BlockEvent,
  BlockEvents,
  BlockChainEvents,
  ChainEvent,
  ChainEventsFeed,
  Coverage,
  BlockExtrinsics,
  BlockTimeStats,
  BlockThroughput,
  BlocksSummary,
  CurationLevel,
  Endpoint,
  EndpointIncident,
  EvidenceItem,
  FlatSurfaceIncident,
  Fixture,
  FixtureIndexEntry,
  Freshness,
  Gap,
  GlobalIncident,
  GlobalIncidents,
  GlobalIncidentSurface,
  IncidentsFeed,
  FeedItem,
  HealthState,
  HealthStatus,
  HealthSummary,
  HealthTrends,
  HealthTrendSurface,
  HealthTrendWindow,
  LeaderboardBoardKey,
  LeaderboardRow,
  Leaderboards,
  Lineage,
  LineageLink,
  PrimaryAppSurface,
  ReadinessSummary,
  Provider,
  ProviderEndpointSummary,
  RpcPool,
  RpcEndpoint,
  RpcEndpointsData,
  RpcEndpointsSummary,
  RpcUsage,
  SchemaInfo,
  SemanticSearchResponse,
  Subnet,
  SubnetAxonRemovals,
  SubnetDeregistrations,
  SubnetStakeMoves,
  SubnetServing,
  SubnetPrometheus,
  SubnetEconomics,
  SubnetHistory,
  SubnetHistoryPoint,
  SubnetHyperparameters,
  SubnetHyperparametersDetail,
  SubnetIdentityHistory,
  SubnetWeightSetter,
  SubnetWeightSetters,
  SubnetWeights,
  SubnetTurnover,
  SubnetIdentityHistoryEntry,
  SubnetNeuronHistory,
  SubnetNeuronHistoryPoint,
  SubnetStakeTransfers,
  SubnetRegistrations,
  SubnetStakeFlow,
  SubnetMovers,
  SubnetMover,
  MetagraphNeuron,
  SubnetMetagraph,
  SubnetValidators,
  GlobalValidator,
  GlobalValidators,
  GlobalValidatorSort,
  GlobalValidatorSubnet,
  ValidatorDetail,
  ValidatorDetailSubnet,
  ValidatorNominatorEntry,
  ValidatorHistory,
  ValidatorHistoryPoint,
  SubnetNeuronSnapshot,
  ConcentrationMetrics,
  ScoreDistribution,
  SubnetConcentration,
  ConcentrationHistoryPoint,
  SubnetConcentrationHistory,
  SubnetPerformance,
  PerformanceHistoryPoint,
  SubnetPerformanceHistory,
  SubnetYield,
  SubnetYieldNeuron,
  YieldHistoryPoint,
  SubnetYieldHistory,
  SubnetProfile,
  SubnetOverview,
  Surface,
  SurfaceLatencyPercentiles,
  SurfaceSla,
  SurfaceSlaIncident,
  Trajectory,
  TrajectoryDelta,
  TrajectoryPoint,
  ReliabilityGrade,
  SurfaceUptime,
  SurfaceUptimeDay,
  Uptime,
} from "./types";

const STALE_SHORT = 30_000;
const STALE_MED = 60_000;
const STALE_LONG = 5 * 60_000;

const MAX_TRAJECTORY_POINTS = 104;
// /history + /neurons/{uid}/history are daily snapshots; an "all"/"1y" window can
// run ~365 points — cap a touch above a year so the sparklines stay bounded.
const MAX_HISTORY_POINTS = 400;
// A subnet has up to 256 neurons; cap a touch above to stay schema-stable if a
// future chain raises the max-UID ceiling.
const MAX_NEURON_ROWS = 512;
const MAX_UPTIME_SURFACES = 500;
const MAX_UPTIME_DAYS = 366;
const MAX_HEALTH_TREND_SURFACES = 500;
// Per-day points[] in a health-trend window are daily samples, not surfaces. Cap
// to the daily-window ceiling (matches MAX_HISTORY_POINTS) — a "1y" window holds
// ~366 days, so this is a safety bound rather than a routine truncation.
const MAX_HEALTH_TREND_DAYS = 400;
const MAX_ACCOUNT_EVENTS = 100;
const MAX_EXTRINSIC_CALL_ARGS = 64;
const MAX_EXTRINSIC_EVENTS = 100;
const MAX_EXTRINSIC_VALUE_DEPTH = 8;
const MAX_EXTRINSIC_COLLECTION_ENTRIES = 64;
const MAX_EXTRINSIC_STRING_LENGTH = 2_000;
const MAX_ACCOUNT_REGISTRATIONS = 100;
const MAX_ACCOUNT_POSITIONS = 256;
const MAX_ACCOUNT_STAKE_MOVES_SUBNETS = 128;
const MAX_ACCOUNT_HISTORY_DAYS = 180;
const MAX_ACCOUNT_DAY_EVENT_KINDS = 32;
const MAX_CHAIN_ACTIVITY_DAYS = 31;
const MAX_CHAIN_CALLS = 12;
const MAX_STAKE_FLOW_SUBNETS = 24;
const MAX_STAKE_MOVES_SUBNETS = 24;
const MAX_TURNOVER_SUBNETS = 24;
// The endpoint returns the top 100 pallet.method groups, busiest first.
const MAX_CHAIN_EVENT_GROUPS = 100;
const DEFAULT_CHAIN_EVENT_BLOCKS = 1000;
const MAX_CHAIN_SIGNERS = 20;
const MAX_CHAIN_FEE_DAYS = 31;
const MAX_CHAIN_FEE_PAYERS = 12;
const MAX_CHAIN_TRANSFER_PAIRS = 100;
const MAX_CHAIN_STAKE_TRANSFERS = 100;

function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Include the selected chain network so SSR mainnet data cannot hydrate into a testnet view. */
export const metagraphedQueryKey = (...parts: unknown[]) => [
  "metagraphed",
  { network: getNetwork().id },
  ...parts,
];

const k = metagraphedQueryKey;

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeEconomicsSubnets(value: unknown): SubnetEconomics[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item)) return [];

    const netuid = optionalNumber(item.netuid);
    if (netuid == null) return [];

    return [
      {
        ...item,
        netuid,
        name: optionalString(item.name),
        slug: optionalString(item.slug),
        emission_share: optionalNumber(item.emission_share),
        alpha_price_tao: optionalNumber(item.alpha_price_tao),
        validator_count: optionalNumber(item.validator_count),
        max_validators: optionalNumber(item.max_validators),
        miner_count: optionalNumber(item.miner_count),
        max_uids: optionalNumber(item.max_uids),
        total_stake_tao: optionalNumber(item.total_stake_tao),
        max_stake_tao: optionalNumber(item.max_stake_tao),
        subnet_volume_tao: optionalNumber(item.subnet_volume_tao),
        registration_cost_tao: optionalNumber(item.registration_cost_tao),
        alpha_market_cap_tao: optionalNumber(item.alpha_market_cap_tao),
        alpha_fdv_tao: optionalNumber(item.alpha_fdv_tao),
        registration_allowed: booleanValue(item.registration_allowed),
      } satisfies SubnetEconomics,
    ];
  });
}

/**
 * Normalize a list response. The API wraps lists as
 *   { ok, data: { <collection>: T[] }, meta }.
 * We tolerate both the wrapped form and a raw array.
 */
async function fetchList<T>(
  path: string,
  key: string,
  params?: QueryParams,
  signal?: AbortSignal,
): Promise<ApiResult<T[]>> {
  const res = await apiFetch<unknown>(path, { params, signal });
  const raw = res.data as unknown;
  let arr: T[] = [];
  if (Array.isArray(raw)) {
    arr = raw as T[];
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidate = obj[key];
    if (Array.isArray(candidate)) arr = candidate as T[];
    else {
      // Fallback: pick the first array-valued property.
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) {
          arr = v as T[];
          break;
        }
      }
    }
  }
  return { data: arr, meta: res.meta, url: res.url };
}

interface NormalizedFreshnessSource {
  name: string;
  last_seen?: string;
  stale: boolean;
  captured: boolean;
}

function freshnessSourceRecords(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (source): source is Record<string, unknown> =>
      !!source && typeof source === "object" && !Array.isArray(source),
  );
}

function finiteTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Canonical non-array object guard for untrusted API/JSON payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReliabilityGrade(raw: unknown): ReliabilityGrade | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    score: coerceFiniteNumber(raw.score),
    grade: coerceString(raw.grade),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    avg_latency_ms: coerceFiniteNumber(raw.avg_latency_ms),
    sample_count: coerceFiniteNumber(raw.sample_count),
    surface_count: coerceFiniteNumber(raw.surface_count),
  };
}

function normalizeTrajectoryDelta(raw: unknown): TrajectoryDelta | null {
  if (!isRecord(raw)) return null;
  return {
    from_date: coerceString(raw.from_date),
    to_date: coerceString(raw.to_date),
    completeness_score: coerceFiniteNumber(raw.completeness_score),
    surface_count: coerceFiniteNumber(raw.surface_count),
    endpoint_count: coerceFiniteNumber(raw.endpoint_count),
  };
}

function normalizeTrajectoryPoint(raw: unknown): TrajectoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    date: coerceString(raw.date) ?? "",
    completeness_score: coerceFiniteNumber(raw.completeness_score),
    surface_count: coerceFiniteNumber(raw.surface_count),
    endpoint_count: coerceFiniteNumber(raw.endpoint_count),
    alpha_price_tao: coerceFiniteNumber(raw.alpha_price_tao),
  };
}

function normalizeTrajectory(raw: Partial<Trajectory> | undefined): Trajectory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_TRAJECTORY_POINTS).flatMap((point) => {
        const normalized = normalizeTrajectoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  const deltas = isRecord(d.deltas)
    ? Object.fromEntries(
        Object.entries(d.deltas).map(([window, delta]) => [
          window,
          normalizeTrajectoryDelta(delta),
        ]),
      )
    : undefined;
  return {
    ...(d as object),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
    deltas,
  };
}

function normalizeSubnetHistoryPoint(raw: unknown): SubnetHistoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const snapshotDate = coerceString(raw.snapshot_date);
  if (!snapshotDate) return undefined;
  return {
    ...(raw as object),
    snapshot_date: snapshotDate,
    neuron_count: coerceFiniteNumber(raw.neuron_count),
    validator_count: coerceFiniteNumber(raw.validator_count),
    total_stake_tao: coerceFiniteNumber(raw.total_stake_tao),
    total_emission_tao: coerceFiniteNumber(raw.total_emission_tao),
  };
}

function normalizeSubnetHistory(netuid: number, raw: unknown): SubnetHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizeSubnetHistoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    window: coerceString(d.window),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
  };
}

function normalizeSubnetNeuronHistoryPoint(raw: unknown): SubnetNeuronHistoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const snapshotDate = coerceString(raw.snapshot_date);
  if (!snapshotDate) return undefined;
  return {
    ...(raw as object),
    snapshot_date: snapshotDate,
    emission_tao: coerceFiniteNumber(raw.emission_tao),
    incentive: coerceFiniteNumber(raw.incentive),
    consensus: coerceFiniteNumber(raw.consensus),
    dividends: coerceFiniteNumber(raw.dividends),
    stake_tao: coerceFiniteNumber(raw.stake_tao),
    rank: coerceFiniteNumber(raw.rank),
    validator_permit: booleanValue(raw.validator_permit),
  };
}

function normalizeSubnetNeuronHistory(
  netuid: number,
  uid: number,
  raw: unknown,
): SubnetNeuronHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizeSubnetNeuronHistoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    uid: coerceFiniteNumber(d.uid) ?? uid,
    window: coerceString(d.window),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
  };
}

function normalizeUptimeDay(raw: unknown): SurfaceUptimeDay | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    day: coerceString(raw.day) ?? "",
    samples: coerceFiniteNumber(raw.samples),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    avg_latency_ms: coerceFiniteNumber(raw.avg_latency_ms),
    status: coerceString(raw.status),
  };
}

function normalizeSurfaceUptime(raw: unknown): SurfaceUptime | undefined {
  if (!isRecord(raw)) return undefined;
  const surfaceId = coerceString(raw.surface_id);
  if (!surfaceId) return undefined;
  const days = Array.isArray(raw.days)
    ? raw.days.slice(-MAX_UPTIME_DAYS).flatMap((day) => {
        const normalized = normalizeUptimeDay(day);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(raw as object),
    surface_id: surfaceId,
    day_count: coerceFiniteNumber(raw.day_count) ?? days.length,
    samples: coerceFiniteNumber(raw.samples),
    uptime_ratio: coerceFiniteNumber(raw.uptime_ratio),
    reliability: normalizeReliabilityGrade(raw.reliability),
    days,
  };
}

function normalizeUptime(raw: Partial<Uptime> | undefined): Uptime {
  const d = isRecord(raw) ? raw : {};
  const surfaces = Array.isArray(d.surfaces)
    ? d.surfaces.slice(0, MAX_UPTIME_SURFACES).flatMap((surface) => {
        const normalized = normalizeSurfaceUptime(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    window: coerceString(d.window),
    reliability: normalizeReliabilityGrade(d.reliability),
    surfaces,
  };
}

function normalizeFreshnessSources(raw: unknown, now = Date.now()) {
  let staleCount = 0;
  let ageTotal = 0;
  let ageCount = 0;
  let maxAgeSeconds: number | undefined;

  const sources = freshnessSourceRecords(raw).map<NormalizedFreshnessSource>((s) => {
    const ts = finiteTimestamp(s.as_of) ?? finiteTimestamp(s.timestamp);
    const ageSec =
      ts !== undefined ? Math.max(0, Math.round((now - Date.parse(ts)) / 1000)) : undefined;

    if (ageSec !== undefined) {
      ageTotal += ageSec;
      ageCount += 1;
      maxAgeSeconds = maxAgeSeconds === undefined ? ageSec : Math.max(maxAgeSeconds, ageSec);
    }

    const staleAfterH = Number(s.stale_after_hours);
    const isStale =
      (typeof s.stale === "boolean" ? s.stale : false) ||
      (ageSec !== undefined && Number.isFinite(staleAfterH) && ageSec > staleAfterH * 3600) ||
      s.status === "stale" ||
      s.status === "expired";
    if (isStale) staleCount += 1;

    return {
      name: (s.id as string) || (s.name as string) || "source",
      last_seen: ts,
      stale: isStale,
      captured: s.status === "captured" || s.status === "ok",
    };
  });

  return {
    avgAgeSeconds: ageCount ? ageTotal / ageCount : undefined,
    maxAgeSeconds,
    staleCount,
    sources,
  };
}

/** Fetch detail and pick a known key, falling back to the whole payload. */
async function fetchDetail<T>(
  path: string,
  key: string,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const res = await apiFetch<unknown>(path, { signal });
  const raw = res.data as unknown;
  if (raw && typeof raw === "object" && key in (raw as object)) {
    return { data: (raw as Record<string, unknown>)[key] as T, meta: res.meta, url: res.url };
  }
  return { data: raw as T, meta: res.meta, url: res.url };
}

// The backend /api/v1/coverage uses chain-accurate field names; the UI's KPI
// tiles read friendlier aliases. Map the real fields onto the names the
// components expect (keeping the raw fields via spread). manifested_count is
// currently always 0, so fall through to the first-party surface count for the
// "manifested surfaces" tile rather than render a bare 0.
function normalizeCoverage(raw: unknown): Coverage {
  const d = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string) =>
    typeof d[key] === "number" && Number.isFinite(d[key]) ? d[key] : undefined;
  const manifestedCount = num("manifested_count");
  return {
    ...(d as object),
    netuids_total: num("netuids_total") ?? num("chain_subnet_count"),
    netuids_active: num("netuids_active") ?? num("application_subnet_count") ?? num("probed_count"),
    adapter_backed: num("adapter_backed") ?? num("first_party_subnet_count"),
    manifested:
      num("manifested") ??
      (manifestedCount === 0 ? undefined : manifestedCount) ??
      num("official_surface_count"),
    surfaces_total: num("surfaces_total") ?? num("official_surface_count") ?? num("surface_count"),
  } as Coverage;
}

export const coverageQuery = () =>
  queryOptions({
    queryKey: k("coverage"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/coverage", { signal });
      return { data: normalizeCoverage(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeLineageLink(value: unknown): LineageLink | null {
  if (!isRecord(value)) return null;
  const { mainnet_netuid: mainnetNetuid, testnet_netuid: testnetNetuid } = value;
  if (typeof mainnetNetuid !== "number" || typeof testnetNetuid !== "number") return null;

  return {
    mainnet_netuid: mainnetNetuid,
    mainnet_name: optionalString(value.mainnet_name),
    mainnet_slug: optionalString(value.mainnet_slug),
    testnet_netuid: testnetNetuid,
    testnet_name: optionalString(value.testnet_name),
    testnet_slug: optionalString(value.testnet_slug),
    matched_by: optionalString(value.matched_by),
  };
}

function normalizeLineage(data: Partial<Lineage> | undefined): Lineage {
  const d = isRecord(data) ? data : {};
  const links = Array.isArray(d.links)
    ? d.links.flatMap((link) => {
        const normalized = normalizeLineageLink(link);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    source_network: typeof d.source_network === "string" ? d.source_network : "source",
    target_network: typeof d.target_network === "string" ? d.target_network : "target",
    link_count: typeof d.link_count === "number" ? d.link_count : links.length,
    graduated_subnet_count:
      typeof d.graduated_subnet_count === "number" ? d.graduated_subnet_count : 0,
    testnet_only_count: typeof d.testnet_only_count === "number" ? d.testnet_only_count : 0,
    broken_link_count: typeof d.broken_link_count === "number" ? d.broken_link_count : 0,
    links,
  };
}

export const lineageQuery = () =>
  queryOptions({
    queryKey: k("lineage"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Lineage>>("/api/v1/lineage", { signal });
      return { data: normalizeLineage(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_LONG,
  });

// #1112: per-subnet on-chain economics. One artifact carries all subnets, so
// fetch once (shared cache) and the consumer finds its netuid.
export const economicsQuery = () =>
  queryOptions({
    queryKey: k("economics"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ subnets?: unknown }>("/api/v1/economics", {
        signal,
      });
      return { data: normalizeEconomicsSubnets(res.data?.subnets), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

const LEADERBOARD_BOARD_KEYS: LeaderboardBoardKey[] = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
];

function normalizeLeaderboardRow(raw: unknown): LeaderboardRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.netuid !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    netuid: r.netuid,
    slug: str(r.slug),
    name: str(r.name),
    uptime_ratio: num(r.uptime_ratio),
    surfaces_ok: num(r.surfaces_ok),
    surfaces_total: num(r.surfaces_total),
    avg_latency_ms: num(r.avg_latency_ms),
    latency_ms: num(r.latency_ms),
    completeness_score: num(r.completeness_score),
    surface_count: num(r.surface_count),
    operational_interface_count: num(r.operational_interface_count),
    completeness_delta: num(r.completeness_delta),
  };
}

function normalizeLeaderboards(raw: unknown): Leaderboards {
  const boards = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as Leaderboards;
  for (const key of LEADERBOARD_BOARD_KEYS) {
    const rows = Array.isArray(boards[key]) ? (boards[key] as unknown[]) : [];
    out[key] = rows
      .map(normalizeLeaderboardRow)
      .filter((row): row is LeaderboardRow => row !== null);
  }
  return out;
}

// #1111: registry leaderboards — five live, D1-computed boards (healthiest,
// fastest-rpc, most-complete, most-enriched, fastest-growing). One artifact carries
// all boards; the homepage discovery module renders the top rows of each.
function normalizeSubnetMover(raw: unknown): SubnetMover | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    stake_start_tao: coerceFiniteNumber(raw.stake_start_tao) ?? 0,
    stake_end_tao: coerceFiniteNumber(raw.stake_end_tao) ?? 0,
    stake_delta_tao: coerceFiniteNumber(raw.stake_delta_tao) ?? 0,
    stake_pct_change: coerceFiniteNumber(raw.stake_pct_change) ?? null,
    stake_share_pct: coerceFiniteNumber(raw.stake_share_pct) ?? null,
    emission_delta_tao: coerceFiniteNumber(raw.emission_delta_tao) ?? 0,
    validators_delta: coerceFiniteNumber(raw.validators_delta) ?? 0,
    neurons_delta: coerceFiniteNumber(raw.neurons_delta) ?? 0,
  };
}

// #3344: cross-subnet biggest-movers board from /api/v1/subnets/movers. Every
// numeric cell coerces defensively; a cold store or junk payload degrades to a
// schema-stable card (movers [], network null), never NaN.
export function normalizeSubnetMovers(raw: unknown): SubnetMovers {
  const d = isRecord(raw) ? raw : {};
  const movers = Array.isArray(d.movers)
    ? d.movers.flatMap((row) => {
        const normalized = normalizeSubnetMover(row);
        return normalized ? [normalized] : [];
      })
    : [];
  const net = isRecord(d.network) ? d.network : null;
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    window: firstString(d.window) ?? "30d",
    sort: firstString(d.sort) ?? "stake",
    subnet_count: firstFiniteNumber(d.subnet_count) ?? movers.length,
    network: net
      ? {
          gainers: firstFiniteNumber(net.gainers) ?? 0,
          losers: firstFiniteNumber(net.losers) ?? 0,
          unchanged: firstFiniteNumber(net.unchanged) ?? 0,
        }
      : null,
    movers,
  };
}

export interface SubnetMoversParams extends QueryParams {
  window?: string;
  sort?: string;
  limit?: number;
}

export const subnetMoversQuery = (params: SubnetMoversParams = {}) =>
  queryOptions({
    queryKey: k(
      "subnet-movers",
      params.window ?? "30d",
      params.sort ?? "stake",
      params.limit ?? 20,
    ),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetMovers>>("/api/v1/subnets/movers", {
        params,
        signal,
      });
      return { data: normalizeSubnetMovers(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

export const leaderboardsQuery = () =>
  queryOptions({
    queryKey: k("registry-leaderboards"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ boards?: unknown }>("/api/v1/registry/leaderboards", {
        signal,
      });
      return { data: normalizeLeaderboards(res.data?.boards), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

export const freshnessQuery = () =>
  queryOptions({
    queryKey: k("freshness"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/freshness", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const { sources: _summarySources, ...summaryWithoutSources } = summary;
      const normalized = normalizeFreshnessSources(d.sources);
      const merged: Freshness = {
        avg_age_seconds: normalized.avgAgeSeconds,
        max_age_seconds: normalized.maxAgeSeconds,
        stale_count: normalized.staleCount,
        sources: normalized.sources.map(({ name, last_seen, stale }) => ({
          name,
          last_seen,
          stale,
        })),
        ...summaryWithoutSources,
      };
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function normalizeHealthBlock(d: Record<string, unknown>): HealthSummary {
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const sc = (d.status_counts as Record<string, unknown> | undefined) ?? undefined;
  const cc = (d.classification_counts as Record<string, unknown> | undefined) ?? undefined;
  const ok = num(d.ok_count) ?? num(sc?.ok) ?? num(d.ok);
  const warn = num(d.degraded_count) ?? num(sc?.degraded) ?? num(d.warn);
  const down = num(d.failed_count) ?? num(sc?.failed) ?? num(d.down);
  const unknown =
    num(d.unknown_count) ?? num(sc?.unknown) ?? num(cc?.unsupported) ?? num(d.unknown);
  const total =
    num(d.surface_count) ??
    num(d.total) ??
    [ok, warn, down, unknown].reduce<number | undefined>(
      (acc, v) => (typeof v === "number" ? (acc ?? 0) + v : acc),
      undefined,
    );
  const uptime =
    num(d.uptime_24h) ??
    (typeof ok === "number" && typeof total === "number" && total > 0 ? ok / total : undefined);
  return {
    ...d,
    ok,
    warn,
    down,
    unknown,
    total,
    uptime_24h: uptime,
    generated_at: typeof d.generated_at === "string" ? d.generated_at : undefined,
  } as HealthSummary;
}

export const healthQuery = () =>
  queryOptions({
    queryKey: k("health"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const global = (d.global as Record<string, unknown> | undefined) ?? {};
      const merged = normalizeHealthBlock({ ...d, ...global });
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

// Per-subnet probe health, keyed by netuid. The /api/v1/subnets LIST rows carry
// only chain `status` ("active"), never probe health or last_checked — that
// lives in /api/v1/health `data.subnets[]` (one entry per probed subnet). The
// subnets table joins this map in so the Health + Updated columns (and the
// health filter) resolve; subnets with no probed surfaces have no entry and stay
// "unknown" (correct — there is nothing to probe).
export type SubnetHealthEntry = { health: HealthState; last_checked?: string };

export const subnetHealthMapQuery = () =>
  queryOptions({
    queryKey: k("subnet-health-map"),
    queryFn: async ({ signal }) => {
      const empty = { data: {} as Record<number, SubnetHealthEntry> };
      try {
        const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
        const d = isRecord(res.data) ? res.data : {};
        const subnets = Array.isArray(d.subnets) ? d.subnets : [];
        const map: Record<number, SubnetHealthEntry> = {};
        for (const sn of subnets) {
          if (!isRecord(sn)) continue;
          const netuid = sn.netuid;
          if (typeof netuid !== "number") continue;
          map[netuid] = {
            health: statusToHealth(sn.status) ?? "unknown",
            last_checked:
              typeof sn.last_checked === "string"
                ? sn.last_checked
                : typeof sn.last_ok === "string"
                  ? sn.last_ok
                  : undefined,
          };
        }
        return { data: map, meta: res.meta, url: res.url };
      } catch {
        return empty;
      }
    },
    staleTime: STALE_SHORT,
  });

export const sourceHealthQuery = () =>
  queryOptions({
    queryKey: k("source-health"),
    queryFn: async ({ signal }) => {
      // Use freshness.sources — the real per-source health/freshness signal.
      // (/api/v1/source-health returns providers, surfaced on /providers.)
      const res = await apiFetch<Record<string, unknown>>("/api/v1/freshness", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const rows = normalizeFreshnessSources(d.sources).sources.map((source) => {
        return {
          name: source.name,
          ok: source.captured ? true : source.stale ? false : undefined,
          last_seen: source.last_seen,
        } as { name: string; ok?: boolean; last_seen?: string };
      });
      return { data: rows, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

/* ===================== Theme C: registry & network-health depth ===================== */

// /api/v1/health/trends — BULK per-day health trend artifact (windows[range].subnets[].points[]).
// This is the REAL daily series; the per-subnet subnetHealthTrendsQuery is a different
// (surface-aggregate, no points[]) shape and must NOT be reused here.
function normalizeBulkTrendPoint(raw: unknown): BulkHealthTrendPoint | null {
  if (!isRecord(raw)) return null;
  const date = coerceString(raw.date);
  if (!date) return null;
  const uptime = raw.uptime_ratio;
  const latency = raw.avg_latency_ms;
  return {
    date,
    samples: optionalNumber(raw.samples),
    uptime_ratio: uptime == null ? null : optionalNumber(uptime),
    avg_latency_ms: latency == null ? null : optionalNumber(latency),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
  };
}

function normalizeBulkTrendSubnet(raw: unknown): BulkHealthTrendSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return null;
  const points = Array.isArray(raw.points)
    ? raw.points
        .slice(0, MAX_HEALTH_TREND_DAYS)
        .map(normalizeBulkTrendPoint)
        .filter((p): p is BulkHealthTrendPoint => p !== null)
    : [];
  return {
    netuid,
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    avg_latency_ms: optionalNumber(raw.avg_latency_ms),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
    points,
  };
}

function normalizeBulkHealthTrends(raw: unknown): BulkHealthTrends {
  const d = isRecord(raw) ? raw : {};
  const windowsRaw = isRecord(d.windows) ? d.windows : {};
  const windows: BulkHealthTrends["windows"] = {};
  for (const [range, value] of Object.entries(windowsRaw)) {
    if (!isRecord(value)) continue;
    const subnets = Array.isArray(value.subnets)
      ? value.subnets
          .map(normalizeBulkTrendSubnet)
          .filter((s): s is BulkHealthTrendSubnet => s !== null)
      : [];
    windows[range] = {
      days: optionalNumber(value.days),
      granularity: coerceString(value.granularity),
      subnet_count: optionalNumber(value.subnet_count),
      subnets,
    };
  }
  return {
    observed_at: coerceString(d.observed_at),
    schema_version: optionalNumber(d.schema_version),
    source: coerceString(d.source),
    windows,
  };
}

export const bulkHealthTrendsQuery = () =>
  queryOptions({
    queryKey: k("bulk-health-trends"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/health/trends", { signal });
      return {
        data: normalizeBulkHealthTrends(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<BulkHealthTrends>;
    },
    staleTime: STALE_MED,
  });

/**
 * Collapse all subnets' per-day points[] in one window into a single
 * sample-weighted per-day uptime series, oldest→newest. The weighting is by
 * `samples` so a high-traffic subnet's day isn't outvoted by a sparsely-probed
 * one. Days with no usable samples are skipped (no fabricated zeros).
 */
export function bulkTrendDays(window: BulkHealthTrendWindowLike | undefined): HealthTrendDay[] {
  if (!window) return [];
  const byDate = new Map<string, { upWeighted: number; samples: number; subnets: number }>();
  for (const sn of window.subnets ?? []) {
    for (const p of sn.points ?? []) {
      const ratio = p.uptime_ratio;
      if (ratio == null || !Number.isFinite(ratio)) continue;
      const samples = typeof p.samples === "number" && p.samples > 0 ? p.samples : 1;
      const entry = byDate.get(p.date) ?? { upWeighted: 0, samples: 0, subnets: 0 };
      entry.upWeighted += ratio * samples;
      entry.samples += samples;
      entry.subnets += 1;
      byDate.set(p.date, entry);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      date,
      uptime_ratio: e.samples > 0 ? e.upWeighted / e.samples : 0,
      samples: e.samples,
      subnet_count: e.subnets,
    }));
}

type BulkHealthTrendWindowLike = { subnets?: BulkHealthTrendSubnet[] };

// /api/v1/registry/summary
function numberRecord(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = optionalNumber(value);
    if (n != null) out[key] = n;
  }
  return out;
}

function normalizeRegistryTopSubnet(raw: unknown): RegistrySummaryTopSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    name: coerceString(raw.name),
    slug: coerceString(raw.slug),
    completeness_score: optionalNumber(raw.completeness_score),
    curation_level: coerceString(raw.curation_level),
    profile_level: coerceString(raw.profile_level),
  };
}

function normalizeRegistrySummary(raw: unknown): RegistrySummary {
  const d = isRecord(raw) ? raw : {};
  const coverage = isRecord(d.coverage) ? d.coverage : {};
  const dimRaw = isRecord(coverage.dimension_coverage) ? coverage.dimension_coverage : {};
  const dimension_coverage: RegistrySummary["coverage"]["dimension_coverage"] = {};
  for (const [key, value] of Object.entries(dimRaw)) {
    if (!isRecord(value)) continue;
    dimension_coverage[key] = {
      pct: optionalNumber(value.pct),
      present: optionalNumber(value.present),
    };
  }
  const top = Array.isArray(d.top_subnets)
    ? d.top_subnets
        .map(normalizeRegistryTopSubnet)
        .filter((r): r is RegistrySummaryTopSubnet => r !== null)
    : [];
  return {
    contract_version: coerceString(d.contract_version),
    generated_at: coerceString(d.generated_at),
    subnet_count: optionalNumber(d.subnet_count),
    counts: numberRecord(d.counts),
    curation_level_counts: numberRecord(d.curation_level_counts),
    profile_level_counts: numberRecord(d.profile_level_counts),
    coverage: {
      average_score: optionalNumber(coverage.average_score),
      median_score: optionalNumber(coverage.median_score),
      fully_complete_count: optionalNumber(coverage.fully_complete_count),
      fully_complete_pct: optionalNumber(coverage.fully_complete_pct),
      scored_subnet_count: optionalNumber(coverage.scored_subnet_count),
      score_distribution: numberRecord(coverage.score_distribution),
      dimension_coverage,
    },
    top_subnets: top,
  };
}

export const registrySummaryQuery = () =>
  queryOptions({
    queryKey: k("registry-summary"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/registry/summary", { signal });
      return {
        data: normalizeRegistrySummary(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<RegistrySummary>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/coverage-depth
function normalizeCoverageDepthRow(raw: unknown): CoverageDepthRow | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return null;
  const dimRaw = isRecord(raw.dimensions) ? raw.dimensions : {};
  return {
    netuid,
    name: coerceString(raw.name),
    slug: coerceString(raw.slug),
    tier: coerceString(raw.tier),
    agent_status: coerceString(raw.agent_status),
    blocker_level: coerceString(raw.blocker_level),
    score: optionalNumber(raw.score),
    readiness_score: optionalNumber(raw.readiness_score),
    priority_score: optionalNumber(raw.priority_score),
    completeness_score: optionalNumber(raw.completeness_score),
    curation_level: coerceString(raw.curation_level),
    profile_level: coerceString(raw.profile_level),
    subnet_type: coerceString(raw.subnet_type),
    recommended_next_action: coerceString(raw.recommended_next_action),
    top_gap_codes: stringArray(raw.top_gap_codes),
    dimensions: {
      ...dimRaw,
      surface_count: optionalNumber(dimRaw.surface_count),
      official_surface_count: optionalNumber(dimRaw.official_surface_count),
      service_count: optionalNumber(dimRaw.service_count),
      callable_service_count: optionalNumber(dimRaw.callable_service_count),
      schema_service_count: optionalNumber(dimRaw.schema_service_count),
      sdk_count: optionalNumber(dimRaw.sdk_count),
      example_count: optionalNumber(dimRaw.example_count),
      data_artifact_count: optionalNumber(dimRaw.data_artifact_count),
      candidate_count: optionalNumber(dimRaw.candidate_count),
      docs_url_present: booleanValue(dimRaw.docs_url_present),
      source_repo_present: booleanValue(dimRaw.source_repo_present),
      service_kinds: stringArray(dimRaw.service_kinds),
    },
  };
}

function normalizeCoverageDepthQueueRow(raw: unknown): CoverageDepthQueueRow | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  const rank = optionalNumber(raw.rank);
  if (netuid == null || rank == null) return null;
  return {
    rank,
    netuid,
    name: coerceString(raw.name),
    slug: coerceString(raw.slug),
    priority_score: optionalNumber(raw.priority_score),
    score: optionalNumber(raw.score),
    severity: coerceString(raw.severity),
    tier: coerceString(raw.tier),
    recommended_next_action: coerceString(raw.recommended_next_action),
    top_gap_codes: stringArray(raw.top_gap_codes),
  };
}

function normalizeCoverageDepth(raw: unknown): CoverageDepth {
  const d = isRecord(raw) ? raw : {};
  const rows = Array.isArray(d.rows)
    ? d.rows.map(normalizeCoverageDepthRow).filter((r): r is CoverageDepthRow => r !== null)
    : [];
  const queue = Array.isArray(d.ranked_queue)
    ? d.ranked_queue
        .map(normalizeCoverageDepthQueueRow)
        .filter((r): r is CoverageDepthQueueRow => r !== null)
    : [];
  return {
    contract_version: coerceString(d.contract_version),
    generated_at: coerceString(d.generated_at),
    subnet_count: optionalNumber(d.subnet_count),
    ranked_queue: queue,
    rows,
  };
}

export const coverageDepthQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("coverage-depth", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/coverage-depth", { params, signal });
      return {
        data: normalizeCoverageDepth(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<CoverageDepth>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/health/history/{date}
function normalizeHealthHistorySurface(raw: unknown): HealthHistorySurface | null {
  if (!isRecord(raw)) return null;
  return {
    surface_id: coerceString(raw.surface_id),
    netuid: optionalNumber(raw.netuid),
    provider: coerceString(raw.provider),
    kind: coerceString(raw.kind),
    status: coerceString(raw.status),
    classification: coerceString(raw.classification),
    latency_ms: raw.latency_ms == null ? null : optionalNumber(raw.latency_ms),
    status_code: raw.status_code == null ? null : optionalNumber(raw.status_code),
    last_checked: coerceString(raw.last_checked),
    last_ok: coerceString(raw.last_ok) ?? null,
    verified_at: coerceString(raw.verified_at),
    error_class: coerceString(raw.error_class) ?? null,
  };
}

function normalizeHealthHistory(raw: unknown): HealthHistory {
  const d = isRecord(raw) ? raw : {};
  const summary = isRecord(d.summary) ? d.summary : {};
  const surfaces = Array.isArray(d.surfaces)
    ? d.surfaces
        .map(normalizeHealthHistorySurface)
        .filter((s): s is HealthHistorySurface => s !== null)
    : [];
  return {
    date: coerceString(d.date),
    probe_started_at: coerceString(d.probe_started_at),
    probe_finished_at: coerceString(d.probe_finished_at),
    summary: {
      status_counts: numberRecord(summary.status_counts),
      classification_counts: numberRecord(summary.classification_counts),
      surface_count: optionalNumber(summary.surface_count),
    },
    surfaces,
  };
}

export const healthHistoryQuery = (date: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("health-history", date, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/health/history/${encodePathSegment(date)}`, {
        params,
        signal,
      });
      return {
        data: normalizeHealthHistory(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<HealthHistory>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/source-health — REAL provider rollup. NOTE: the legacy sourceHealthQuery
// (above) intentionally maps onto /api/v1/freshness; this one hits the actual endpoint.
function normalizeSourceHealthProvider(raw: unknown): SourceHealthProvider | null {
  if (!isRecord(raw)) return null;
  const id = coerceString(raw.id);
  if (!id) return null;
  return {
    id,
    name: coerceString(raw.name),
    kind: coerceString(raw.kind),
    authority: coerceString(raw.authority),
    status: coerceString(raw.status),
    endpoint_count: optionalNumber(raw.endpoint_count),
    rpc_endpoint_count: optionalNumber(raw.rpc_endpoint_count),
    candidate_count: optionalNumber(raw.candidate_count),
    verification_result_count: optionalNumber(raw.verification_result_count),
    classifications: numberRecord(raw.classifications),
  };
}

function normalizeSourceHealth(raw: unknown): SourceHealth {
  const d = isRecord(raw) ? raw : {};
  const summary = isRecord(d.summary) ? d.summary : {};
  const providers = Array.isArray(d.providers)
    ? d.providers
        .map(normalizeSourceHealthProvider)
        .filter((p): p is SourceHealthProvider => p !== null)
    : [];
  return {
    generated_at: coerceString(d.generated_at),
    providers,
    summary: {
      provider_count: optionalNumber(summary.provider_count),
      endpoint_count: optionalNumber(summary.endpoint_count),
      rpc_endpoint_count: optionalNumber(summary.rpc_endpoint_count),
      candidate_count: optionalNumber(summary.candidate_count),
      verification_result_count: optionalNumber(summary.verification_result_count),
      status_counts: numberRecord(summary.status_counts),
    },
  };
}

export const sourceHealthProvidersQuery = () =>
  queryOptions({
    queryKey: k("source-health-providers"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/source-health", { signal });
      return {
        data: normalizeSourceHealth(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SourceHealth>;
    },
    staleTime: STALE_MED,
  });

/* ===================== Theme C: agent-catalog (capability) ===================== */

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function normalizeAgentBlocker(raw: unknown): AgentCatalogBlocker | null {
  if (!isRecord(raw)) return null;
  return {
    code: coerceString(raw.code),
    field: coerceString(raw.field),
    message: coerceString(raw.message),
    next_action: coerceString(raw.next_action),
    severity: coerceString(raw.severity),
  };
}

function normalizeAgentReadiness(raw: unknown): AgentReadiness | undefined {
  if (!isRecord(raw)) return undefined;
  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.map(normalizeAgentBlocker).filter((b): b is AgentCatalogBlocker => b !== null)
    : undefined;
  return {
    status: coerceString(raw.status),
    blocker_level: coerceString(raw.blocker_level),
    blockers,
    missing_fields: stringArray(raw.missing_fields),
  };
}

// readiness_tier lives in two places by bucket: ready rows nest it under
// readiness.readiness_tier, blocked rows carry a flat readiness_tier.
function resolveReadinessTier(raw: Record<string, unknown>): string | undefined {
  const nested = isRecord(raw.readiness) ? coerceString(raw.readiness.readiness_tier) : undefined;
  return nested ?? coerceString(raw.readiness_tier);
}

function normalizeAgentCatalogReadiness(raw: unknown) {
  if (!isRecord(raw)) return undefined;
  const components = isRecord(raw.components)
    ? Object.fromEntries(
        Object.entries(raw.components).flatMap(([key, value]) =>
          typeof value === "boolean" ? [[key, value] as const] : [],
        ),
      )
    : undefined;
  return {
    score: optionalNumber(raw.score),
    readiness_tier: coerceString(raw.readiness_tier),
    components,
    readiness_verified: booleanValue(raw.readiness_verified),
  };
}

function normalizeAgentCatalogSummary(raw: unknown): AgentCatalogSummary | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    name: coerceString(raw.name),
    slug: coerceString(raw.slug),
    subnet_type: coerceString(raw.subnet_type),
    integration_readiness: optionalNumber(raw.integration_readiness),
    completeness_score: optionalNumber(raw.completeness_score),
    readiness_tier: resolveReadinessTier(raw),
    service_count: optionalNumber(raw.service_count),
    callable_count: optionalNumber(raw.callable_count),
    service_kinds: stringArray(raw.service_kinds),
    categories: stringArray(raw.categories),
    base_url: coerceString(raw.base_url),
    health: coerceString(raw.health),
    agent_readiness: normalizeAgentReadiness(raw.agent_readiness),
    readiness: normalizeAgentCatalogReadiness(raw.readiness),
  };
}

function normalizeAgentCatalogService(raw: unknown): AgentCatalogService | null {
  if (!isRecord(raw)) return null;
  const healthRaw = isRecord(raw.health) ? raw.health : undefined;
  const eligRaw = isRecord(raw.eligibility) ? raw.eligibility : undefined;
  return {
    kind: coerceString(raw.kind),
    capability: coerceString(raw.capability),
    description: coerceString(raw.description) ?? null,
    base_url: coerceString(raw.base_url),
    provider: coerceString(raw.provider),
    authority: coerceString(raw.authority),
    auth_required: booleanValue(raw.auth_required),
    auth_schemes: stringArray(raw.auth_schemes),
    health: healthRaw
      ? {
          status: coerceString(healthRaw.status),
          classification: coerceString(healthRaw.classification),
          latency_ms: optionalNumber(healthRaw.latency_ms),
          last_ok: coerceString(healthRaw.last_ok),
          last_checked: coerceString(healthRaw.last_checked),
          stale: booleanValue(healthRaw.stale),
          observed_by: coerceString(healthRaw.observed_by),
        }
      : undefined,
    eligibility: eligRaw
      ? {
          callable: booleanValue(eligRaw.callable),
          live_status: coerceString(eligRaw.live_status),
          reasons: stringArray(eligRaw.reasons),
        }
      : undefined,
    schema_url: coerceString(raw.schema_url) ?? null,
    surface_id: coerceString(raw.surface_id),
  };
}

export function normalizeAgentCatalogDetail(raw: unknown, netuid: number): AgentCatalogDetail {
  const base = normalizeAgentCatalogSummary(raw) ?? { netuid };
  const d = isRecord(raw) ? raw : {};
  const services = Array.isArray(d.services)
    ? d.services
        .map(normalizeAgentCatalogService)
        .filter((s): s is AgentCatalogService => s !== null)
    : [];
  return {
    ...base,
    netuid,
    services,
    examples: Array.isArray(d.examples) ? d.examples : [],
    example_count: optionalNumber(d.example_count),
    generated_at: coerceString(d.generated_at),
    operational_observed_at: coerceString(d.operational_observed_at),
    health_source: coerceString(d.health_source),
  };
}

/** Per-netuid agent-catalog capability map (mirrors subnetHealthMapQuery). Walks
 * both the ready `subnets[]` and `blocked_subnets[]` arrays into one keyed map so
 * the subnets list can join service-kind / readiness onto rows. */
export const agentCatalogMapQuery = () =>
  queryOptions({
    queryKey: k("agent-catalog-map"),
    queryFn: async ({ signal }) => {
      const empty = { data: {} as Record<number, AgentCatalogSummary> };
      try {
        const res = await apiFetch<Record<string, unknown>>("/api/v1/agent-catalog", { signal });
        const d = isRecord(res.data) ? res.data : {};
        const map: Record<number, AgentCatalogSummary> = {};
        for (const key of ["subnets", "blocked_subnets"] as const) {
          const arr = Array.isArray(d[key]) ? (d[key] as unknown[]) : [];
          for (const row of arr) {
            const norm = normalizeAgentCatalogSummary(row);
            if (norm) map[norm.netuid] = norm;
          }
        }
        return { data: map, meta: res.meta, url: res.url };
      } catch {
        return empty;
      }
    },
    staleTime: STALE_MED,
  });

export const agentCatalogDetailQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("agent-catalog-detail", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/agent-catalog/${netuid}`, { signal });
      return {
        data: normalizeAgentCatalogDetail(res.data, netuid),
        meta: res.meta,
        url: res.url,
      } as ApiResult<AgentCatalogDetail>;
    },
    staleTime: STALE_MED,
  });

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

export function normalizeSubnet(raw: unknown): Subnet {
  if (!raw || typeof raw !== "object") return raw as Subnet;
  const s = raw as Record<string, unknown>;
  return {
    ...(s as object),
    netuid: firstFiniteNumber(s.netuid) ?? (s.netuid as number),
    // `name` is the curated identity; fall back to the on-chain `native_name`
    // (a distinct field, not a legacy alias — both are emitted).
    name: firstString(s.name, s.native_name),
    type: firstString(s.subnet_type) as Subnet["type"] | undefined,
    // Output keys here (`participants`, `surfaces_count`, `candidates_count`)
    // are the aliases the UI reads; the API serves the canonical singulars.
    participants: firstFiniteNumber(s.participant_count),
    surfaces_count: firstFiniteNumber(s.surface_count),
    candidates_count: firstFiniteNumber(s.candidate_count),
    // chain `status` is "active" → "unknown" here; the real probe health is
    // joined from /api/v1/health in the table. Default to "unknown" (never
    // undefined) so the health filter matches unprobed rows.
    health: statusToHealth(s.health) ?? statusToHealth(s.status) ?? "unknown",
    // Output `icon_url` is sourced from the API's `logo_url` field.
    icon_url: firstString(s.icon_url, s.logo_url),
    // API key is website_url; the BrandIcon favicon fallback reads `website`.
    website: firstString(s.website_url),
    // API key is source_repo; the BrandIcon GitHub-avatar fallback reads `repo`
    // (CORS-clean + Worker-reachable — the most reliable icon source).
    repo: firstString(s.source_repo),
    updated_at: firstString(s.updated_at, s.last_checked, s.last_ok),
  } as Subnet;
}

export const subnetsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("subnets", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/subnets", "subnets", params, signal);
      return { ...res, data: res.data.map(normalizeSubnet) } as ApiResult<Subnet[]>;
    },
    staleTime: STALE_MED,
  });

export const subnetQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchDetail<unknown>(`/api/v1/subnets/${netuid}`, "subnet", signal);
      return { ...res, data: normalizeSubnet(res.data) } as ApiResult<Subnet>;
    },
    staleTime: STALE_MED,
  });

// Block explorer (chain-direct event poller). The list is offset-paginated and
// returns newest-first; the detail accepts a numeric block_number OR a 0x hash.
function normalizeBlock(raw: unknown): Block | null {
  if (!isRecord(raw)) return null;
  if (raw.block === null) return null;
  const wrapped = isRecord(raw.block) ? (raw.block as Record<string, unknown>) : null;
  const blockData = wrapped ?? raw;

  const blockNumber = firstFiniteNumber(blockData.block_number);
  const blockHash = firstString(blockData.block_hash);
  // A row is only meaningful with at least a number or a hash to key/link on.
  if (blockNumber == null && !blockHash) return null;

  const prevBlock = firstFiniteNumber(raw.prev_block_number);
  const nextBlock = firstFiniteNumber(raw.next_block_number);
  return {
    ...(blockData as object),
    block_number: blockNumber ?? (raw.block_number as number),
    block_hash: blockHash ?? "",
    parent_hash: firstString(blockData.parent_hash),
    author: typeof blockData.author === "string" ? blockData.author : null,
    extrinsic_count: firstFiniteNumber(blockData.extrinsic_count),
    event_count: firstFiniteNumber(blockData.event_count),
    observed_at: firstString(blockData.observed_at),
    prev_block_number: typeof prevBlock === "number" ? prevBlock : null,
    next_block_number: typeof nextBlock === "number" ? nextBlock : null,
  } as Block;
}

function normalizeBlockExtrinsic(raw: unknown): Extrinsic | null {
  return normalizeExtrinsic(raw);
}

function normalizeBlockExtrinsics(raw: unknown): BlockExtrinsics {
  const d = isRecord(raw) ? raw : {};
  const rows = Array.isArray(d.extrinsics)
    ? d.extrinsics.flatMap((x) => {
        const normalized = normalizeBlockExtrinsic(x);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    ref: firstString(d.ref),
    block_number: firstFiniteNumber(d.block_number) ?? null,
    extrinsic_count: firstFiniteNumber(d.extrinsic_count) ?? rows.length,
    limit: firstFiniteNumber(d.limit) ?? null,
    offset: firstFiniteNumber(d.offset) ?? null,
    extrinsics: rows,
  } satisfies BlockExtrinsics;
}

function normalizeBlockEvent(raw: unknown): BlockEvent | null {
  if (!isRecord(raw)) return null;
  const amount =
    firstFiniteNumber(raw.amount_tao) ??
    firstFiniteNumber(raw.amount) ??
    firstFiniteNumber(raw.alpha_amount);
  return {
    ...(raw as object),
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    event_index: firstFiniteNumber(raw.event_index) ?? null,
    event_kind: firstString(raw.event_kind) ?? null,
    hotkey: firstString(raw.hotkey),
    coldkey: firstString(raw.coldkey),
    netuid: firstFiniteNumber(raw.netuid),
    uid: firstFiniteNumber(raw.uid),
    amount_tao: amount,
    observed_at: firstString(raw.observed_at),
    extrinsic_index: firstFiniteNumber(raw.extrinsic_index),
    alpha_amount: amount,
  };
}

function normalizeBlockEvents(raw: unknown): BlockEvents {
  const d = isRecord(raw) ? raw : {};
  const rows = Array.isArray(d.events)
    ? d.events.flatMap((x) => {
        const normalized = normalizeBlockEvent(x);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    ref: firstString(d.ref),
    block_number: firstFiniteNumber(d.block_number) ?? null,
    event_count: firstFiniteNumber(d.event_count) ?? rows.length,
    limit: firstFiniteNumber(d.limit) ?? null,
    offset: firstFiniteNumber(d.offset) ?? null,
    events: rows,
  } satisfies BlockEvents;
}

// The Postgres-backed all-events tier (unlike the first-party D1 blocks/events/
// extrinsics tiers) serializes bigint columns (block_number, event_index,
// observed_at) as JSON strings rather than numbers, and the per-block route
// omits the (redundant, same for every row) block_number on each event —
// hence coerceFiniteNumber (not firstFiniteNumber) and the fallback below.
function normalizeChainEvent(raw: unknown, fallbackBlockNumber: number | null): ChainEvent | null {
  if (!isRecord(raw)) return null;
  const observedAtMs = coerceFiniteNumber(raw.observed_at);
  return {
    ...(raw as object),
    block_number: coerceFiniteNumber(raw.block_number) ?? fallbackBlockNumber,
    event_index: coerceFiniteNumber(raw.event_index) ?? null,
    pallet: firstString(raw.pallet) ?? null,
    method: firstString(raw.method) ?? null,
    args: raw.args === undefined ? null : sanitizeExtrinsicValue(raw.args),
    phase: firstString(raw.phase) ?? null,
    extrinsic_index: coerceFiniteNumber(raw.extrinsic_index) ?? null,
    observed_at: observedAtMs != null ? (epochMsToIso(observedAtMs) ?? null) : null,
  } satisfies ChainEvent;
}

function normalizeBlockChainEvents(raw: unknown): BlockChainEvents {
  const d = isRecord(raw) ? raw : {};
  const blockNumber = coerceFiniteNumber(d.block_number) ?? null;
  const rows = Array.isArray(d.events)
    ? d.events.flatMap((x) => {
        const normalized = normalizeChainEvent(x, blockNumber);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    block_number: blockNumber,
    count: coerceFiniteNumber(d.count) ?? rows.length,
    events: rows,
  } satisfies BlockChainEvents;
}

function normalizeChainEventsFeed(raw: unknown): ChainEventsFeed {
  const d = isRecord(raw) ? raw : {};
  const rows = Array.isArray(d.events)
    ? d.events.flatMap((x) => {
        const normalized = normalizeChainEvent(x, null);
        return normalized ? [normalized] : [];
      })
    : [];
  const nextCursor = firstString(d.next_cursor);
  return {
    ...(d as object),
    count: coerceFiniteNumber(d.count) ?? rows.length,
    next_cursor: nextCursor ?? null,
    next_before: coerceFiniteNumber(d.next_before) ?? null,
    events: rows,
  } satisfies ChainEventsFeed;
}

/** Recent blocks feed — newest first, offset-paginated (limit ≤ 100). */
export const blocksQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("blocks", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/blocks", "blocks", params, signal);
      const data = res.data.flatMap((row) => {
        const b = normalizeBlock(row);
        return b ? [b] : [];
      });
      return { ...res, data } as ApiResult<Block[]>;
    },
    // Blocks turn over fast once the poller is live — keep this short.
    staleTime: STALE_SHORT,
  });

/** Single block by numeric block_number or 0x block_hash. `null` when unknown/cold. */
export const blockQuery = (ref: string) =>
  queryOptions({
    queryKey: k("block", ref),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/blocks/${blockRefPathSegment(ref)}`, {
        signal,
      });
      return { ...res, data: normalizeBlock(res.data) } as ApiResult<Block | null>;
    },
    staleTime: STALE_SHORT,
  });

/** Single block by numeric block_number or 0x block_hash, with per-block extrinsics. */
export const blockExtrinsicsQuery = (ref: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("block-extrinsics", ref, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/blocks/${blockRefPathSegment(ref)}/extrinsics`, {
        params,
        signal,
      });
      return { ...res, data: normalizeBlockExtrinsics(res.data) } as ApiResult<BlockExtrinsics>;
    },
    staleTime: STALE_SHORT,
  });

/** Single block by numeric block_number or 0x block_hash, with decoded chain events. */
export const blockEventsQuery = (ref: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("block-events", ref, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/blocks/${blockRefPathSegment(ref)}/events`, {
        params,
        signal,
      });
      return { ...res, data: normalizeBlockEvents(res.data) } as ApiResult<BlockEvents>;
    },
    staleTime: STALE_SHORT,
  });

/**
 * Single block by numeric block_number or 0x block_hash, with every raw
 * pallet-level chain event from the Postgres-backed all-events tier — a
 * broader, decoded-args view than {@link blockEventsQuery}'s curated,
 * account-attributed stream. Takes no query params (the route accepts none).
 */
export const blockChainEventsQuery = (ref: string) =>
  queryOptions({
    queryKey: k("block-chain-events", ref),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(
        `/api/v1/blocks/${blockRefPathSegment(ref)}/chain-events`,
        { signal },
      );
      return {
        ...res,
        data: normalizeBlockChainEvents(res.data),
      } as ApiResult<BlockChainEvents>;
    },
    staleTime: STALE_SHORT,
  });

// Block-production summary (#3488): aggregate health of the recent-blocks window —
// inter-block time distribution, extrinsic/event throughput, block-author
// decentralization, and the runtime spec-version spread. Null-safe: a cold/absent
// store degrades to a schema-stable zeroed card (block_count 0, nested objects
// null), never a throw or 404.
function normalizeBlockTimeStats(raw: unknown): BlockTimeStats | null {
  if (!isRecord(raw)) return null;
  const count = coerceFiniteNumber(raw.count);
  // No interval to measure (< 2 consecutive blocks) → the whole block collapses.
  if (count == null || count === 0) return null;
  return {
    count,
    mean_ms: coerceFiniteNumber(raw.mean_ms) ?? 0,
    min_ms: coerceFiniteNumber(raw.min_ms) ?? 0,
    max_ms: coerceFiniteNumber(raw.max_ms) ?? 0,
    p50_ms: coerceFiniteNumber(raw.p50_ms) ?? 0,
    p90_ms: coerceFiniteNumber(raw.p90_ms) ?? 0,
  };
}

function normalizeBlockThroughput(raw: unknown): BlockThroughput | null {
  if (!isRecord(raw)) return null;
  const totalExtrinsics = coerceFiniteNumber(raw.total_extrinsics);
  const totalEvents = coerceFiniteNumber(raw.total_events);
  // Backend emits null on a cold store; a malformed all-null object collapses too.
  if (totalExtrinsics == null && totalEvents == null) return null;
  return {
    total_extrinsics: totalExtrinsics ?? 0,
    total_events: totalEvents ?? 0,
    mean_extrinsics_per_block: coerceFiniteNumber(raw.mean_extrinsics_per_block) ?? 0,
    mean_events_per_block: coerceFiniteNumber(raw.mean_events_per_block) ?? 0,
    max_extrinsics_in_block: coerceFiniteNumber(raw.max_extrinsics_in_block) ?? 0,
  };
}

export function normalizeBlocksSummary(raw: unknown): BlocksSummary {
  const d = isRecord(raw) ? raw : {};
  return {
    schema_version: coerceFiniteNumber(d.schema_version) ?? 1,
    block_count: coerceFiniteNumber(d.block_count) ?? 0,
    first_block: coerceFiniteNumber(d.first_block) ?? null,
    last_block: coerceFiniteNumber(d.last_block) ?? null,
    first_observed_at: coerceString(d.first_observed_at) ?? null,
    last_observed_at: coerceString(d.last_observed_at) ?? null,
    block_time: normalizeBlockTimeStats(d.block_time),
    throughput: normalizeBlockThroughput(d.throughput),
    distinct_authors: coerceFiniteNumber(d.distinct_authors) ?? 0,
    author_concentration: normalizeConcentrationMetricsOrNull(d.author_concentration),
    distinct_spec_versions: coerceFiniteNumber(d.distinct_spec_versions) ?? 0,
    latest_spec_version: coerceFiniteNumber(d.latest_spec_version) ?? null,
  };
}

/**
 * Block-production summary (#3488) — inter-block time, throughput, and
 * block-author decentralization over the recent-blocks window. Schema-stable
 * zeroed card on a cold store (never 404/throws).
 */
export const blocksSummaryQuery = () =>
  queryOptions({
    queryKey: k("blocks-summary"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/blocks/summary", { signal });
      return { ...res, data: normalizeBlocksSummary(res.data) } as ApiResult<BlocksSummary>;
    },
    // Block summary tracks the fast-moving blocks feed — keep this short.
    staleTime: STALE_SHORT,
  });

function normalizeExtrinsicCallArgs(raw: unknown): Extrinsic["call_args"] {
  if (Array.isArray(raw)) {
    return raw
      .slice(0, MAX_EXTRINSIC_CALL_ARGS)
      .filter(isRecord)
      .map(
        (arg) =>
          ({
            name: truncateString(firstString(arg.name)),
            value: sanitizeExtrinsicValue(arg.value),
          }) as ExtrinsicCallArg,
      );
  }

  if (isRecord(raw)) {
    return Object.fromEntries(
      Object.entries(raw)
        .slice(0, MAX_EXTRINSIC_CALL_ARGS)
        .map(([key, value]) => [truncateString(key) ?? key, sanitizeExtrinsicValue(value)]),
    );
  }

  return null;
}

function sanitizeExtrinsicValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_EXTRINSIC_VALUE_DEPTH) return "[Max depth exceeded]";

  seen.add(value);

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_EXTRINSIC_COLLECTION_ENTRIES)
      .map((entry) => sanitizeExtrinsicValue(entry, depth + 1, seen));
    if (value.length > MAX_EXTRINSIC_COLLECTION_ENTRIES) out.push("[Truncated]");
    seen.delete(value);
    return out;
  }

  const out = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_EXTRINSIC_COLLECTION_ENTRIES)
      .map(([key, entry]) => [
        truncateString(key) ?? key,
        sanitizeExtrinsicValue(entry, depth + 1, seen),
      ]),
  );
  if (Object.keys(value as Record<string, unknown>).length > MAX_EXTRINSIC_COLLECTION_ENTRIES) {
    out.__truncated = true;
  }
  seen.delete(value);
  return out;
}

function truncateString(value: string | null | undefined, limit = MAX_EXTRINSIC_STRING_LENGTH) {
  if (value == null) return value;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// Extrinsic (transaction) explorer — the block explorer's sibling feed. The list
// is offset-paginated and newest-first; the detail is keyed by 0x extrinsic_hash.
export function normalizeExtrinsic(raw: unknown, rawEvents?: unknown): Extrinsic | null {
  if (!isRecord(raw)) return null;
  const blockNumber = firstFiniteNumber(raw.block_number);
  const extrinsicHash = firstString(raw.extrinsic_hash);
  // A row needs at least a hash or a (block, index) coordinate to key/link on.
  const extrinsicIndex = firstFiniteNumber(raw.extrinsic_index);
  if (!extrinsicHash && (blockNumber == null || extrinsicIndex == null)) {
    return null;
  }

  const callArgs = normalizeExtrinsicCallArgs(raw.call_args);

  const eventsSource = Array.isArray(rawEvents)
    ? rawEvents
    : Array.isArray(raw.events)
      ? raw.events
      : [];

  const events = Array.isArray(eventsSource)
    ? eventsSource
        .slice(0, MAX_EXTRINSIC_EVENTS)
        .filter(isRecord)
        .map((event) => {
          return {
            block_number: firstFiniteNumber(event.block_number) ?? null,
            event_index: firstFiniteNumber(event.event_index) ?? null,
            event_kind: truncateString(firstString(event.event_kind)),
            hotkey: truncateString(firstString(event.hotkey)),
            coldkey: truncateString(firstString(event.coldkey)),
            netuid: firstFiniteNumber(event.netuid),
            uid: firstFiniteNumber(event.uid),
            amount_tao: firstFiniteNumber(event.amount_tao),
            observed_at: truncateString(firstString(event.observed_at)),
          } as AccountEvent;
        })
    : [];

  return {
    ...(raw as object),
    block_number: blockNumber ?? null,
    extrinsic_index: extrinsicIndex ?? null,
    extrinsic_hash: extrinsicHash ?? null,
    signer: firstString(raw.signer) ?? null,
    call_module: firstString(raw.call_module) ?? null,
    call_function: firstString(raw.call_function) ?? null,
    fee_tao: firstFiniteNumber(raw.fee_tao),
    tip_tao: firstFiniteNumber(raw.tip_tao),
    call_args: callArgs,
    events,
    success: typeof raw.success === "boolean" ? raw.success : null,
    observed_at: firstString(raw.observed_at),
  } as Extrinsic;
}

/** Recent extrinsics feed — newest first, offset-paginated (limit ≤ 100). */
export const extrinsicsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("extrinsics", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/extrinsics", "extrinsics", params, signal);
      const data = res.data.flatMap((row) => {
        const x = normalizeExtrinsic(row);
        return x ? [x] : [];
      });
      return { ...res, data } as ApiResult<Extrinsic[]>;
    },
    // Extrinsics turn over with every block once the poller is live.
    staleTime: STALE_SHORT,
  });

/** Single extrinsic by 0x extrinsic_hash. `null` when unknown/cold. */
export const extrinsicQuery = (hash: string) =>
  queryOptions({
    queryKey: k("extrinsic", hash),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/extrinsics/${extrinsicHashPathSegment(hash)}`, {
        signal,
      });
      const payload = res.data as unknown;
      const payloadRecord = isRecord(payload) ? payload : {};
      const rawExtrinsic =
        payloadRecord.extrinsic === null
          ? null
          : isRecord(payloadRecord.extrinsic)
            ? (payloadRecord.extrinsic as Record<string, unknown>)
            : payloadRecord;
      const events = Array.isArray(payloadRecord.events) ? payloadRecord.events : undefined;
      return {
        ...res,
        data: normalizeExtrinsic(rawExtrinsic, events),
      } as ApiResult<Extrinsic | null>;
    },
    staleTime: STALE_SHORT,
  });

/** Root-origin (Sudo) calls — the extrinsics feed hardcoded to call_module='Sudo' (#4310/2.2). */
export const sudoCallsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("sudo-calls", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/sudo", "extrinsics", params, signal);
      const data = res.data.flatMap((row) => {
        const x = normalizeExtrinsic(row);
        return x ? [x] : [];
      });
      return { ...res, data } as ApiResult<Extrinsic[]>;
    },
    staleTime: STALE_SHORT,
  });

/** AdminUtils config-change feed — the extrinsics feed hardcoded to call_module='AdminUtils' (#4310/2.3). */
export const governanceConfigChangesQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("governance-config-changes", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        "/api/v1/governance/config-changes",
        "extrinsics",
        params,
        signal,
      );
      const data = res.data.flatMap((row) => {
        const x = normalizeExtrinsic(row);
        return x ? [x] : [];
      });
      return { ...res, data } as ApiResult<Extrinsic[]>;
    },
    staleTime: STALE_SHORT,
  });

/** Current Sudo::Key holder, queried live from finney RPC (#4310/2.4). Rarely changes. */
export const sudoKeyQuery = () =>
  queryOptions({
    queryKey: k("sudo-key"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/sudo/key", { signal });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          hotkey: firstString(d.hotkey) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } as SudoKey,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SudoKey>;
    },
    staleTime: STALE_LONG,
  });

// Account explorer — cross-subnet activity for one hotkey/coldkey ss58. The
// /api/v1/accounts/{ss58} summary bundles the aggregate, registrations, and a
// recent-events sample (schema-stable zero for a cold/unknown account, never an
// error), so one query drives the whole detail page.
function normalizeAccountRegistration(raw: unknown): AccountRegistration | null {
  if (!isRecord(raw)) return null;
  const registration: AccountRegistration = {
    ...(raw as object),
    netuid: firstFiniteNumber(raw.netuid) ?? null,
    uid: firstFiniteNumber(raw.uid) ?? null,
    stake_tao: firstFiniteNumber(raw.stake_tao) ?? null,
    validator_permit: booleanValue(raw.validator_permit),
    active: booleanValue(raw.active),
  };
  return registration.netuid != null || registration.uid != null ? registration : null;
}

// One cross-subnet neuron position (#3491). Strict on render fields — object/junk
// economic cells coerce to null (never NaN or `[object Object]`), an unknown role
// drops to null — and a row with no numeric netuid is discarded.
export function normalizePortfolioPosition(raw: unknown): PortfolioPosition | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  const role = firstString(raw.role);
  return {
    ...(raw as object),
    netuid,
    uid: firstFiniteNumber(raw.uid) ?? null,
    role: role === "validator" || role === "miner" ? role : null,
    active: booleanValue(raw.active),
    stake_tao: firstFiniteNumber(raw.stake_tao) ?? null,
    emission_tao: firstFiniteNumber(raw.emission_tao) ?? null,
    rank: firstFiniteNumber(raw.rank) ?? null,
    trust: firstFiniteNumber(raw.trust) ?? null,
    incentive: firstFiniteNumber(raw.incentive) ?? null,
    dividends: firstFiniteNumber(raw.dividends) ?? null,
    yield: firstFiniteNumber(raw.yield) ?? null,
  };
}

// The portfolio's stake-concentration lens (#3491).
export function normalizePortfolioConcentration(raw: unknown): PortfolioConcentration | null {
  if (!isRecord(raw)) return null;
  const holders = firstFiniteNumber(raw.holders) ?? null;
  const gini = firstFiniteNumber(raw.gini) ?? null;
  const hhi_normalized = firstFiniteNumber(raw.hhi_normalized) ?? null;
  const nakamoto_coefficient = firstFiniteNumber(raw.nakamoto_coefficient) ?? null;
  // Cold / empty distribution: a zero-holder object, or one with no populated
  // lens fields (e.g. `{}` or all-null), is not a real concentration card — the
  // backend emits null there, and so do we (the ConcentrationMetrics
  // null-when-empty contract). Guards a malformed body from rendering a non-null
  // card built entirely from nulls.
  if (
    holders === 0 ||
    (holders == null && gini == null && hhi_normalized == null && nakamoto_coefficient == null)
  ) {
    return null;
  }
  return { ...(raw as object), holders, gini, hhi_normalized, nakamoto_coefficient };
}

function accountEventString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function normalizeAccountEvent(raw: unknown): AccountEvent | null {
  if (!isRecord(raw)) return null;

  const blockNumber = coerceFiniteNumber(raw.block_number);
  const eventIndex = coerceFiniteNumber(raw.event_index);
  const eventKind = accountEventString(raw.event_kind);

  if (blockNumber == null || eventIndex == null || !eventKind) return null;

  return {
    ...raw,
    block_number: blockNumber,
    event_index: eventIndex,
    event_kind: eventKind,
    hotkey: accountEventString(raw.hotkey) ?? null,
    coldkey: accountEventString(raw.coldkey) ?? null,
    netuid: coerceFiniteNumber(raw.netuid) ?? null,
    uid: coerceFiniteNumber(raw.uid) ?? null,
    amount_tao: coerceFiniteNumber(raw.amount_tao) ?? null,
    alpha_amount: coerceFiniteNumber(raw.alpha_amount) ?? null,
    extrinsic_index: coerceFiniteNumber(raw.extrinsic_index) ?? null,
    observed_at: accountEventString(raw.observed_at),
  };
}

function normalizeAccountEvents(raw: unknown, limit = MAX_ACCOUNT_EVENTS): AccountEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((event) => {
      const normalized = normalizeAccountEvent(event);
      return normalized ? [normalized] : [];
    })
    .slice(0, limit);
}

export function normalizeAccountSummary(raw: unknown, ss58: string): AccountSummary {
  const d = isRecord(raw) ? raw : {};
  const eventKinds = Array.isArray(d.event_kinds)
    ? d.event_kinds
        .filter(isRecord)
        .map((kind) => ({
          kind: firstString(kind.kind) ?? "",
          count: firstFiniteNumber(kind.count) ?? 0,
        }))
        .filter((kind) => kind.kind)
    : [];
  return {
    ...(d as object),
    ss58: firstString(d.ss58) ?? ss58,
    event_count: firstFiniteNumber(d.event_count) ?? 0,
    subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
    first_block: firstFiniteNumber(d.first_block) ?? null,
    last_block: firstFiniteNumber(d.last_block) ?? null,
    first_seen_at: firstString(d.first_seen_at) ?? null,
    last_seen_at: firstString(d.last_seen_at) ?? null,
    event_kinds: eventKinds,
    registrations: Array.isArray(d.registrations)
      ? d.registrations.slice(0, MAX_ACCOUNT_REGISTRATIONS).flatMap((registration) => {
          const normalized = normalizeAccountRegistration(registration);
          return normalized ? [normalized] : [];
        })
      : [],
    recent_events: normalizeAccountEvents(d.recent_events),
  } as AccountSummary;
}

function normalizeAccountDay(raw: unknown): AccountDay | undefined {
  if (!isRecord(raw)) return undefined;
  const day = firstString(raw.day);
  if (!day) return undefined;
  return {
    ...(raw as object),
    day,
    netuid: firstFiniteNumber(raw.netuid) ?? null,
    event_count: firstFiniteNumber(raw.event_count) ?? 0,
    event_kinds: stringArrayFromUnknown(raw.event_kinds, MAX_ACCOUNT_DAY_EVENT_KINDS),
    first_block: firstFiniteNumber(raw.first_block) ?? null,
    last_block: firstFiniteNumber(raw.last_block) ?? null,
  } as AccountDay;
}

export function normalizeAccountHistory(raw: unknown, ss58: string): AccountHistory {
  const d = isRecord(raw) ? raw : {};
  const days = Array.isArray(d.days)
    ? d.days.slice(0, MAX_ACCOUNT_HISTORY_DAYS).flatMap((day) => {
        const normalized = normalizeAccountDay(day);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ...(d as object),
    ss58: firstString(d.ss58) ?? ss58,
    day_count: firstFiniteNumber(d.day_count) ?? days.length,
    limit: firstFiniteNumber(d.limit) ?? null,
    offset: firstFiniteNumber(d.offset) ?? null,
    days,
  } as AccountHistory;
}

/** Cross-subnet activity summary for one account by ss58. */
export const accountQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}`, {
        signal,
      });
      return {
        data: normalizeAccountSummary(res.data, ss58),
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountSummary>;
    },
    staleTime: STALE_SHORT,
  });

export interface AccountHistoryParams extends QueryParams {
  netuid?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Per-day hotkey activity for one account from /api/v1/accounts/{ss58}/history. */
export const accountHistoryQuery = (ss58: string, params: AccountHistoryParams = {}) =>
  queryOptions({
    queryKey: k(
      "account-history",
      ss58,
      params.netuid ?? null,
      params.from ?? null,
      params.to ?? null,
      params.limit ?? null,
      params.offset ?? null,
    ),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/history`, {
        params,
        signal,
      });
      return {
        data: normalizeAccountHistory(res.data, ss58),
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountHistory>;
    },
    staleTime: STALE_MED,
  });

/**
 * Live TAO balance (free + reserved) for one account, queried from the finney
 * RPC at request time (60s server-side KV cache). Separate from accountQuery so
 * a slow/failed RPC never blocks the rest of the entity page; balance_tao is
 * null on RPC failure.
 */
export const accountBalanceQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-balance", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/balance`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          balance_tao: firstFiniteNumber(d.balance_tao) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } as AccountBalance,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountBalance>;
    },
    staleTime: STALE_SHORT,
  });

/** Extrinsics this account signed (by signer), newest-first (#264). */
export const accountExtrinsicsQuery = (ss58: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("account-extrinsics", ss58, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/extrinsics`,
        "extrinsics",
        params,
        signal,
      );
      const data = res.data.flatMap((row) => {
        const x = normalizeExtrinsic(row);
        return x ? [x] : [];
      });
      return { ...res, data } as ApiResult<Extrinsic[]>;
    },
    staleTime: STALE_SHORT,
  });

/** One native-TAO Balances.Transfer row → a clean directional Transfer. */
function normalizeTransfer(raw: unknown): Transfer | null {
  if (!isRecord(raw)) return null;
  const blockNumber = firstFiniteNumber(raw.block_number);
  const eventIndex = firstFiniteNumber(raw.event_index);
  if (blockNumber == null && eventIndex == null) return null;
  const direction = firstString(raw.direction);
  return {
    block_number: blockNumber ?? null,
    event_index: eventIndex ?? null,
    from: firstString(raw.from) ?? null,
    to: firstString(raw.to) ?? null,
    amount_tao: firstFiniteNumber(raw.amount_tao) ?? null,
    direction: direction === "sent" || direction === "received" ? direction : null,
    observed_at: firstString(raw.observed_at) ?? null,
  };
}

/** Native-TAO transfer feed for one account (directional), newest-first (#264). */
export const accountTransfersQuery = (ss58: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("account-transfers", ss58, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/transfers`,
        "transfers",
        params,
        signal,
      );
      const data = res.data.flatMap((row) => {
        const t = normalizeTransfer(row);
        return t ? [t] : [];
      });
      return { ...res, data } as ApiResult<Transfer[]>;
    },
    staleTime: STALE_SHORT,
  });

export interface AccountEventsParams extends QueryParams {
  /** Filter to one event_kind (e.g. "StakeAdded"). */
  kind?: string;
  limit?: number;
  offset?: number;
}

/**
 * Paginated first-party chain-event feed for one account (#266). The body
 * carries event_count + next_cursor (keyset token at end-of-page), so we read
 * res.data directly rather than via fetchList. Offset pagination mirrors the
 * sibling account feeds; the optional ?kind filter narrows to one event kind.
 */
export const accountEventsQuery = (ss58: string, params: AccountEventsParams = {}) =>
  queryOptions({
    queryKey: k(
      "account-events",
      ss58,
      params.kind ?? null,
      params.limit ?? null,
      params.offset ?? null,
    ),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/events`, {
        params,
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const events = normalizeAccountEvents(d.events, params.limit ?? MAX_ACCOUNT_EVENTS);
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          event_count: firstFiniteNumber(d.event_count) ?? events.length,
          limit: firstFiniteNumber(d.limit) ?? null,
          offset: firstFiniteNumber(d.offset) ?? null,
          next_cursor: firstString(d.next_cursor) ?? null,
          events,
        } as AccountEventsPage,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountEventsPage>;
    },
    staleTime: STALE_SHORT,
  });

/**
 * Cross-subnet footprint for one account from /api/v1/accounts/{ss58}/subnets
 * (#266) — netuid-ordered registrations, reusing the summary's registration
 * normalizer. Turns over slowly relative to the event feed, so STALE_MED.
 */
export const accountSubnetsQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-subnets", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/subnets`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const subnets = Array.isArray(d.subnets)
        ? d.subnets.slice(0, MAX_ACCOUNT_REGISTRATIONS).flatMap((registration) => {
            const normalized = normalizeAccountRegistration(registration);
            return normalized ? [normalized] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? subnets.length,
          subnets,
        } as AccountSubnets,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountSubnets>;
    },
    staleTime: STALE_MED,
  });

// #3491: the economics-rich companion to accountSubnetsQuery — every neuron
// position under this hotkey with stake/emission/yield, plus wallet aggregates.
// Non-blocking on the entity page; a cold wallet returns an empty positions[].
function normalizeAccountStakeMovesSubnet(raw: unknown): AccountStakeMovesSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    movements: coerceFiniteNumber(raw.movements) ?? 0,
    first_moved_at: firstString(raw.first_moved_at) ?? null,
    last_moved_at: firstString(raw.last_moved_at) ?? null,
  };
}

export const accountStakeMovesQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-stake-moves", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/stake-moves`, {
        params: { window: "30d" },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const subnets = Array.isArray(d.subnets)
        ? d.subnets.slice(0, MAX_ACCOUNT_STAKE_MOVES_SUBNETS).flatMap((row) => {
            const n = normalizeAccountStakeMovesSubnet(row);
            return n ? [n] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.address) ?? ss58,
          window: firstString(d.window) ?? "30d",
          total_movements: firstFiniteNumber(d.total_movements) ?? 0,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? subnets.length,
          concentration: firstFiniteNumber(d.concentration) ?? null,
          dominant_netuid: firstFiniteNumber(d.dominant_netuid) ?? null,
          subnets,
        } as AccountStakeMoves,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountStakeMoves>;
    },
    staleTime: STALE_MED,
  });

export const accountPortfolioQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-portfolio", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/portfolio`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const positions = Array.isArray(d.positions)
        ? d.positions.slice(0, MAX_ACCOUNT_POSITIONS).flatMap((position) => {
            const normalized = normalizePortfolioPosition(position);
            return normalized ? [normalized] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          captured_at: firstString(d.captured_at) ?? null,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? positions.length,
          position_count: firstFiniteNumber(d.position_count) ?? positions.length,
          validator_count: firstFiniteNumber(d.validator_count) ?? 0,
          miner_count: firstFiniteNumber(d.miner_count) ?? 0,
          total_stake_tao: firstFiniteNumber(d.total_stake_tao) ?? null,
          total_emission_tao: firstFiniteNumber(d.total_emission_tao) ?? null,
          overall_yield: firstFiniteNumber(d.overall_yield) ?? null,
          stake_concentration: normalizePortfolioConcentration(d.stake_concentration),
          positions,
        } as AccountPortfolio,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountPortfolio>;
    },
    staleTime: STALE_MED,
  });

function normalizeAccountAxonRemovalsSubnet(raw: unknown): AccountAxonRemovalsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    removals: firstFiniteNumber(raw.removals) ?? 0,
    first_removed_at: firstString(raw.first_removed_at) ?? null,
    last_removed_at: firstString(raw.last_removed_at) ?? null,
  };
}

// Per-account axon-removal (teardown) footprint over a 7d/30d/90d window. A flat
// summary card — total removals + distinct subnets — from the account_events
// AxonInfoRemoved stream. Every numeric cell coerces defensively: counts fall
// through to 0 and concentration to null on a cold store or junk.
export function normalizeAccountAxonRemovals(ss58: string, raw: unknown): AccountAxonRemovals {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountAxonRemovalsSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_removals: firstFiniteNumber(rec.total_removals) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountAxonRemovalsQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-axon-removals", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountAxonRemovals>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/axon-removals`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountAxonRemovals(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeAccountRegistrationsSubnet(raw: unknown): AccountRegistrationsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    registrations: firstFiniteNumber(raw.registrations) ?? 0,
    first_registered_at: firstString(raw.first_registered_at) ?? null,
    last_registered_at: firstString(raw.last_registered_at) ?? null,
  };
}

// Per-account registration (NeuronRegistered) footprint over a 7d/30d/90d window
// (#3730). A flat summary card — total registrations + distinct subnets — from the
// account_events NeuronRegistered stream. Coerces defensively: counts fall through
// to 0 and concentration to null on a cold store or junk.
export function normalizeAccountRegistrations(ss58: string, raw: unknown): AccountRegistrations {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountRegistrationsSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_registrations: firstFiniteNumber(rec.total_registrations) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountRegistrationsQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-registrations", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountRegistrations>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/registrations`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountRegistrations(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeAccountDeregistrationsSubnet(raw: unknown): AccountDeregistrationsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    deregistrations: firstFiniteNumber(raw.deregistrations) ?? 0,
    first_deregistered_at: firstString(raw.first_deregistered_at) ?? null,
    last_deregistered_at: firstString(raw.last_deregistered_at) ?? null,
  };
}

// Per-account deregistration (eviction) footprint over a 7d/30d/90d window. A flat
// summary card — total deregistrations + distinct subnets — from the account_events
// NeuronDeregistered stream. Every numeric cell coerces defensively: counts fall
// through to 0 and concentration to null on a cold store or junk.
export function normalizeAccountDeregistrations(
  ss58: string,
  raw: unknown,
): AccountDeregistrations {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountDeregistrationsSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_deregistrations: firstFiniteNumber(rec.total_deregistrations) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountDeregistrationsQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-deregistrations", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountDeregistrations>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/deregistrations`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountDeregistrations(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeAccountWeightSettersSubnet(raw: unknown): AccountWeightSettersSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    weight_sets: firstFiniteNumber(raw.weight_sets) ?? 0,
    first_set_at: firstString(raw.first_set_at) ?? null,
    last_set_at: firstString(raw.last_set_at) ?? null,
  };
}

// Per-account weight-setting (WeightsSet) footprint over a 7d/30d window — total
// weight sets + per-subnet breakdown from the account_events stream. Every
// numeric cell coerces defensively: counts fall through to 0 and concentration
// to null on a cold store or junk.
export function normalizeAccountWeightSetters(ss58: string, raw: unknown): AccountWeightSetters {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountWeightSettersSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_weight_sets: firstFiniteNumber(rec.total_weight_sets) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountWeightSettersQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-weight-setters", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountWeightSetters>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/weight-setters`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountWeightSetters(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeAccountServingSubnet(raw: unknown): AccountServingSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    announcements: firstFiniteNumber(raw.announcements) ?? 0,
    first_served_at: firstString(raw.first_served_at) ?? null,
    last_served_at: firstString(raw.last_served_at) ?? null,
  };
}

export function normalizeAccountServing(ss58: string, raw: unknown): AccountServing {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountServingSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_announcements: firstFiniteNumber(rec.total_announcements) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountServingQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-serving", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountServing>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/serving`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountServing(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeAccountPrometheusSubnet(raw: unknown): AccountPrometheusSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    announcements: firstFiniteNumber(raw.announcements) ?? 0,
    first_announced_at: firstString(raw.first_announced_at) ?? null,
    last_announced_at: firstString(raw.last_announced_at) ?? null,
  };
}

export function normalizeAccountPrometheus(ss58: string, raw: unknown): AccountPrometheus {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((row) => {
        const normalized = normalizeAccountPrometheusSubnet(row);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    address: firstString(rec.address) ?? ss58,
    window: firstString(rec.window) ?? null,
    total_announcements: firstFiniteNumber(rec.total_announcements) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    concentration: firstFiniteNumber(rec.concentration) ?? null,
    dominant_netuid: firstFiniteNumber(rec.dominant_netuid) ?? null,
    subnets,
  };
}

export const accountPrometheusQuery = (ss58: string, window = "30d") =>
  queryOptions({
    queryKey: k("account-prometheus", ss58, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountPrometheus>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/prometheus`,
        { params: { window }, signal },
      );
      return {
        data: normalizeAccountPrometheus(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// ---- Chain analytics dashboard (#266, epic #1986) -------------------------
// Display-only views over the live /api/v1/chain/* aggregates. Treat rows as
// untrusted display data so malformed canonical responses cannot crash SSR.

type ChainWindow = "7d" | "30d";

function normalizeChainActivityDay(raw: unknown): ChainActivityDay | null {
  if (!isRecord(raw)) return null;
  const day = firstString(raw.day);
  const blockCount = coerceFiniteNumber(raw.block_count);
  const extrinsicCount = coerceFiniteNumber(raw.extrinsic_count);
  const eventCount = coerceFiniteNumber(raw.event_count);
  const successfulExtrinsics = coerceFiniteNumber(raw.successful_extrinsics);
  const uniqueSigners = coerceFiniteNumber(raw.unique_signers);
  if (
    !day ||
    blockCount == null ||
    extrinsicCount == null ||
    eventCount == null ||
    successfulExtrinsics == null ||
    uniqueSigners == null
  ) {
    return null;
  }
  return {
    day,
    block_count: blockCount,
    extrinsic_count: extrinsicCount,
    event_count: eventCount,
    successful_extrinsics: successfulExtrinsics,
    success_rate: coerceFiniteNumber(raw.success_rate) ?? null,
    unique_signers: uniqueSigners,
  };
}

function normalizeChainCallEntry(raw: unknown): ChainCallEntry | null {
  if (!isRecord(raw)) return null;
  const callModule = firstString(raw.call_module);
  const count = coerceFiniteNumber(raw.count);
  if (!callModule || count == null) return null;
  return {
    call_module: callModule,
    call_function: firstString(raw.call_function) ?? null,
    count,
    share: coerceFiniteNumber(raw.share) ?? null,
  };
}

function normalizeChainSignerEntry(raw: unknown): ChainSignerEntry | null {
  if (!isRecord(raw)) return null;
  const signer = firstString(raw.signer);
  const txCount = coerceFiniteNumber(raw.tx_count);
  const totalFeeTao = coerceFiniteNumber(raw.total_fee_tao);
  const totalTipTao = coerceFiniteNumber(raw.total_tip_tao);
  if (
    !signer ||
    !isValidSs58(signer) ||
    txCount == null ||
    totalFeeTao == null ||
    totalTipTao == null
  ) {
    return null;
  }
  return {
    signer: signer.trim(),
    tx_count: txCount,
    total_fee_tao: totalFeeTao,
    total_tip_tao: totalTipTao,
    last_tx_block: coerceFiniteNumber(raw.last_tx_block) ?? null,
  };
}

function normalizeChainFeeDay(raw: unknown): ChainFeeDay | null {
  if (!isRecord(raw)) return null;
  const day = firstString(raw.day);
  const extrinsicCount = coerceFiniteNumber(raw.extrinsic_count);
  const totalFeeTao = coerceFiniteNumber(raw.total_fee_tao);
  const totalTipTao = coerceFiniteNumber(raw.total_tip_tao);
  if (!day || extrinsicCount == null || totalFeeTao == null || totalTipTao == null) return null;
  return {
    day,
    extrinsic_count: extrinsicCount,
    total_fee_tao: totalFeeTao,
    avg_fee_tao: coerceFiniteNumber(raw.avg_fee_tao) ?? null,
    total_tip_tao: totalTipTao,
    avg_tip_tao: coerceFiniteNumber(raw.avg_tip_tao) ?? null,
  };
}

function normalizeChainFeePayer(raw: unknown): ChainFeePayer | null {
  if (!isRecord(raw)) return null;
  const signer = firstString(raw.signer);
  const totalFeeTao = coerceFiniteNumber(raw.total_fee_tao);
  const totalTipTao = coerceFiniteNumber(raw.total_tip_tao);
  const extrinsicCount = coerceFiniteNumber(raw.extrinsic_count);
  if (
    !signer ||
    !isValidSs58(signer) ||
    totalFeeTao == null ||
    totalTipTao == null ||
    extrinsicCount == null
  ) {
    return null;
  }
  return {
    signer: signer.trim(),
    total_fee_tao: totalFeeTao,
    total_tip_tao: totalTipTao,
    extrinsic_count: extrinsicCount,
  };
}

function normalizeChainRows<T>(
  raw: unknown,
  max: number,
  normalize: (row: unknown) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).flatMap((row) => {
    const normalized = normalize(row);
    return normalized ? [normalized] : [];
  });
}

export const chainActivityQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-activity", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/activity", {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          day_count: firstFiniteNumber(d.day_count) ?? 0,
          days: normalizeChainRows(d.days, MAX_CHAIN_ACTIVITY_DAYS, normalizeChainActivityDay),
        } as ChainActivity,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainActivity>;
    },
    staleTime: STALE_SHORT,
  });

export const chainCallsQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-calls", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/calls", {
        params: { window, limit: 12 },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          group_by: firstString(d.group_by) ?? "module",
          observed_at: firstString(d.observed_at) ?? null,
          total_extrinsics: firstFiniteNumber(d.total_extrinsics) ?? 0,
          call_count: firstFiniteNumber(d.call_count) ?? 0,
          calls: normalizeChainRows(d.calls, MAX_CHAIN_CALLS, normalizeChainCallEntry),
        } as ChainCalls,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainCalls>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainEventsStatsEntry(raw: unknown): ChainEventsStatsEntry | null {
  if (!isRecord(raw)) return null;
  const pallet = firstString(raw.pallet);
  const count = coerceFiniteNumber(raw.count);
  if (!pallet || count == null) return null;
  return {
    pallet,
    method: firstString(raw.method) ?? null,
    count,
  };
}

// #3489: raw all-events tier pallet.method distribution from
// /api/v1/chain-events/stats — the raw-tier sibling of chainCallsQuery's D1
// /chain/calls aggregate. Takes a block window (default 1000, capped 5000
// server-side); returns the distinct group count and the busiest-first rows.
// A cold store (before the all-events backfill) yields groups: 0, activity: [].
export const chainEventsStatsQuery = (blocks: number = DEFAULT_CHAIN_EVENT_BLOCKS) =>
  queryOptions({
    queryKey: k("chain-events-stats", blocks),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain-events/stats", {
        params: { blocks },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          window_blocks: firstFiniteNumber(d.window_blocks) ?? blocks,
          groups: firstFiniteNumber(d.groups) ?? 0,
          activity: normalizeChainRows(
            d.activity,
            MAX_CHAIN_EVENT_GROUPS,
            normalizeChainEventsStatsEntry,
          ),
        } as ChainEventsStats,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainEventsStats>;
    },
    staleTime: STALE_SHORT,
  });

export const chainSignersQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-signers", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/signers", {
        params: { window, limit: 20 },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          signer_count: firstFiniteNumber(d.signer_count) ?? 0,
          signers: normalizeChainRows(d.signers, MAX_CHAIN_SIGNERS, normalizeChainSignerEntry),
        } as ChainSigners,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainSigners>;
    },
    staleTime: STALE_SHORT,
  });

export const chainFeesQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-fees", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/fees", {
        params: { window, limit: 12 },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          day_count: firstFiniteNumber(d.day_count) ?? 0,
          daily: normalizeChainRows(d.daily, MAX_CHAIN_FEE_DAYS, normalizeChainFeeDay),
          top_fee_payers: normalizeChainRows(
            d.top_fee_payers,
            MAX_CHAIN_FEE_PAYERS,
            normalizeChainFeePayer,
          ),
        } as ChainFees,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainFees>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainTransferPair(raw: unknown): ChainTransferPair | null {
  if (!isRecord(raw)) return null;
  const from = firstString(raw.from);
  const to = firstString(raw.to);
  if (!from || !to) return null;
  return {
    from,
    to,
    volume_tao: firstFiniteNumber(raw.volume_tao) ?? 0,
    transfer_count: firstFiniteNumber(raw.transfer_count) ?? 0,
    last_block: firstFiniteNumber(raw.last_block) ?? null,
    last_observed_at: firstString(raw.last_observed_at) ?? null,
  };
}

function normalizeChainTransferPairSort(raw: unknown): "volume" | "count" {
  return raw === "count" ? "count" : "volume";
}

// #3476: network-wide directed native-TAO transfer-pair corridors over a 7d/30d
// window — the data layer for a sender→receiver flow/sankey view on the explorer.
// Every numeric cell coerces defensively: counts fall through to 0, shares/averages
// to null (never NaN), and malformed pair rows are dropped on a cold store or junk.
export function normalizeChainTransferPairs(raw: unknown): ChainTransferPairs {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    sort: normalizeChainTransferPairSort(rec.sort),
    total_volume_tao: firstFiniteNumber(rec.total_volume_tao) ?? 0,
    transfer_count: firstFiniteNumber(rec.transfer_count) ?? 0,
    unique_pairs: firstFiniteNumber(rec.unique_pairs) ?? 0,
    pair_count: firstFiniteNumber(rec.pair_count) ?? 0,
    top_pair_share: firstFiniteNumber(rec.top_pair_share) ?? null,
    pairs: normalizeChainRows(rec.pairs, MAX_CHAIN_TRANSFER_PAIRS, normalizeChainTransferPair),
  };
}

export const chainTransferPairsQuery = (
  window = "30d",
  limit = 25,
  sort: "volume" | "count" = "volume",
) =>
  queryOptions({
    queryKey: k("chain-transfer-pairs", window, limit, sort),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainTransferPairs>>("/api/v1/chain/transfer-pairs", {
        params: { window, limit, sort },
        signal,
      });
      return {
        data: normalizeChainTransferPairs(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeChainStakeTransferSubnet(raw: unknown): ChainStakeTransferSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_senders: firstFiniteNumber(raw.distinct_senders) ?? 0,
    transfers: firstFiniteNumber(raw.transfers) ?? 0,
    transfers_per_sender: firstFiniteNumber(raw.transfers_per_sender) ?? null,
  };
}

function normalizeChainIntensityDistribution(raw: unknown): ChainIntensityDistribution | null {
  if (!isRecord(raw)) return null;
  const count = firstFiniteNumber(raw.count);
  if (count == null) return null;
  return {
    count,
    mean: firstFiniteNumber(raw.mean) ?? 0,
    min: firstFiniteNumber(raw.min) ?? 0,
    p25: firstFiniteNumber(raw.p25) ?? 0,
    median: firstFiniteNumber(raw.median) ?? 0,
    p75: firstFiniteNumber(raw.p75) ?? 0,
    p90: firstFiniteNumber(raw.p90) ?? 0,
    max: firstFiniteNumber(raw.max) ?? 0,
  };
}

// #3467: network-wide stake-transfer leaderboard over a 7d/30d window — the
// between-coldkeys sibling of /api/v1/chain/stake-moves (within-account
// re-delegation churn). Every numeric cell coerces defensively: counts fall
// through to 0, averages to null (never NaN), and malformed subnet rows are
// dropped on a cold store or junk.
export function normalizeChainStakeTransfers(raw: unknown): ChainStakeTransfers {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_senders: firstFiniteNumber(networkRec.distinct_senders) ?? 0,
      transfers: firstFiniteNumber(networkRec.transfers) ?? 0,
      transfers_per_sender: firstFiniteNumber(networkRec.transfers_per_sender) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(
      rec.subnets,
      MAX_CHAIN_STAKE_TRANSFERS,
      normalizeChainStakeTransferSubnet,
    ),
  };
}

export const chainStakeTransfersQuery = (window = "7d", limit = 20) =>
  queryOptions({
    queryKey: k("chain-stake-transfers", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainStakeTransfers>>("/api/v1/chain/stake-transfers", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainStakeTransfers(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeChainStakeFlowNetwork(raw: unknown): ChainStakeFlowNetwork | null {
  if (!isRecord(raw)) return null;
  return {
    total_staked_tao: coerceFiniteNumber(raw.total_staked_tao) ?? 0,
    total_unstaked_tao: coerceFiniteNumber(raw.total_unstaked_tao) ?? 0,
    net_flow_tao: coerceFiniteNumber(raw.net_flow_tao) ?? 0,
    gross_flow_tao: coerceFiniteNumber(raw.gross_flow_tao) ?? 0,
    stake_events: coerceFiniteNumber(raw.stake_events) ?? 0,
    unstake_events: coerceFiniteNumber(raw.unstake_events) ?? 0,
    gaining: coerceFiniteNumber(raw.gaining) ?? 0,
    losing: coerceFiniteNumber(raw.losing) ?? 0,
    flat: coerceFiniteNumber(raw.flat) ?? 0,
  };
}

function normalizeChainStakeFlowDistribution(raw: unknown): ChainStakeFlowDistribution | null {
  if (!isRecord(raw)) return null;
  return {
    count: coerceFiniteNumber(raw.count) ?? 0,
    mean: coerceFiniteNumber(raw.mean) ?? null,
    min: coerceFiniteNumber(raw.min) ?? null,
    p25: coerceFiniteNumber(raw.p25) ?? null,
    median: coerceFiniteNumber(raw.median) ?? null,
    p75: coerceFiniteNumber(raw.p75) ?? null,
    p90: coerceFiniteNumber(raw.p90) ?? null,
    max: coerceFiniteNumber(raw.max) ?? null,
  };
}

function normalizeChainStakeFlowSubnet(raw: unknown): ChainStakeFlowSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    total_staked_tao: coerceFiniteNumber(raw.total_staked_tao) ?? 0,
    total_unstaked_tao: coerceFiniteNumber(raw.total_unstaked_tao) ?? 0,
    net_flow_tao: coerceFiniteNumber(raw.net_flow_tao) ?? 0,
    gross_flow_tao: coerceFiniteNumber(raw.gross_flow_tao) ?? 0,
    stake_events: coerceFiniteNumber(raw.stake_events) ?? 0,
    unstake_events: coerceFiniteNumber(raw.unstake_events) ?? 0,
    direction: firstString(raw.direction) ?? "balanced",
  };
}

export const chainStakeFlowQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-stake-flow", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/stake-flow", {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
          network: normalizeChainStakeFlowNetwork(d.network),
          net_flow_distribution: normalizeChainStakeFlowDistribution(d.net_flow_distribution),
          subnets: normalizeChainRows(
            d.subnets,
            MAX_STAKE_FLOW_SUBNETS,
            normalizeChainStakeFlowSubnet,
          ),
        } as ChainStakeFlow,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainStakeFlow>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainStakeMovesNetwork(raw: unknown): ChainStakeMovesNetwork | null {
  if (!isRecord(raw)) return null;
  return {
    distinct_movers: coerceFiniteNumber(raw.distinct_movers) ?? 0,
    movements: coerceFiniteNumber(raw.movements) ?? 0,
    movements_per_mover: coerceFiniteNumber(raw.movements_per_mover) ?? 0,
  };
}

function normalizeChainStakeMovesDistribution(raw: unknown): ChainStakeMovesDistribution | null {
  if (!isRecord(raw)) return null;
  return {
    count: coerceFiniteNumber(raw.count) ?? 0,
    mean: coerceFiniteNumber(raw.mean) ?? null,
    min: coerceFiniteNumber(raw.min) ?? null,
    p25: coerceFiniteNumber(raw.p25) ?? null,
    median: coerceFiniteNumber(raw.median) ?? null,
    p75: coerceFiniteNumber(raw.p75) ?? null,
    p90: coerceFiniteNumber(raw.p90) ?? null,
    max: coerceFiniteNumber(raw.max) ?? null,
  };
}

function normalizeChainStakeMovesSubnet(raw: unknown): ChainStakeMovesSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_movers: coerceFiniteNumber(raw.distinct_movers) ?? 0,
    movements: coerceFiniteNumber(raw.movements) ?? 0,
    movements_per_mover: coerceFiniteNumber(raw.movements_per_mover) ?? 0,
  };
}

export const chainStakeMovesQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-stake-moves", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/stake-moves", {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
          network: normalizeChainStakeMovesNetwork(d.network),
          intensity_distribution: normalizeChainStakeMovesDistribution(d.intensity_distribution),
          subnets: normalizeChainRows(
            d.subnets,
            MAX_STAKE_MOVES_SUBNETS,
            normalizeChainStakeMovesSubnet,
          ),
        } as ChainStakeMoves,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainStakeMoves>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainTurnoverNetwork(raw: unknown): ChainTurnoverNetwork | null {
  if (!isRecord(raw)) return null;
  return {
    validators_start: coerceFiniteNumber(raw.validators_start) ?? 0,
    validators_end: coerceFiniteNumber(raw.validators_end) ?? 0,
    validators_entered: coerceFiniteNumber(raw.validators_entered) ?? 0,
    validators_exited: coerceFiniteNumber(raw.validators_exited) ?? 0,
    validator_retention: coerceFiniteNumber(raw.validator_retention) ?? null,
    stability_score: coerceFiniteNumber(raw.stability_score) ?? null,
  };
}

function normalizeChainTurnoverSubnet(raw: unknown): ChainTurnoverSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    validators_start: coerceFiniteNumber(raw.validators_start) ?? 0,
    validators_end: coerceFiniteNumber(raw.validators_end) ?? 0,
    validators_entered: coerceFiniteNumber(raw.validators_entered) ?? 0,
    validators_exited: coerceFiniteNumber(raw.validators_exited) ?? 0,
    validator_retention: coerceFiniteNumber(raw.validator_retention) ?? null,
    stability_score: coerceFiniteNumber(raw.stability_score) ?? null,
  };
}

export const chainTurnoverQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-turnover", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/turnover", {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          start_date: firstString(d.start_date) ?? null,
          end_date: firstString(d.end_date) ?? null,
          comparable: d.comparable === true,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
          network: normalizeChainTurnoverNetwork(d.network),
          subnets: normalizeChainRows(
            d.subnets,
            MAX_TURNOVER_SUBNETS,
            normalizeChainTurnoverSubnet,
          ),
        } as ChainTurnover,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainTurnover>;
    },
    staleTime: STALE_SHORT,
  });

const READINESS_COMPONENT_KEYS = [
  "has_callable_api",
  "callable_now",
  "documented",
  "auth_clarity",
  "profile_complete",
  "active_lifecycle",
] as const;

function normalizeReadiness(raw: unknown): ReadinessSummary | undefined {
  if (!isRecord(raw)) return undefined;

  const componentsRaw = raw.components;
  let components: Record<string, boolean> | undefined;

  if (isRecord(componentsRaw)) {
    const normalizedComponents: Record<string, boolean> = {};
    for (const key of READINESS_COMPONENT_KEYS) {
      if (typeof componentsRaw[key] === "boolean") {
        normalizedComponents[key] = componentsRaw[key];
      }
    }
    if (Object.keys(normalizedComponents).length > 0) {
      components = normalizedComponents;
    }
  }

  const readiness: ReadinessSummary = {};
  if (typeof raw.score === "number") readiness.score = raw.score;
  if (typeof raw.readiness_version === "number")
    readiness.readiness_version = raw.readiness_version;
  if (components) readiness.components = components;

  return Object.keys(readiness).length > 0 ? readiness : undefined;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function normalizeSubnetProfile(raw: unknown, netuid: number): SubnetProfile {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const profile = (root.profile as Record<string, unknown> | undefined) ?? {};
  const subnet = (root.subnet as Record<string, unknown> | undefined) ?? {};
  const links = (profile.primary_links as Record<string, unknown> | undefined) ?? {};
  const completenessObj = profile.completeness as Record<string, unknown> | undefined;
  const score =
    (typeof completenessObj?.score === "number" ? (completenessObj.score as number) : undefined) ??
    (typeof profile.completeness_score === "number"
      ? (profile.completeness_score as number)
      : undefined);
  const completenessRatio =
    typeof score === "number" ? Math.max(0, Math.min(1, score / 100)) : undefined;
  const curation = (subnet.curation as Record<string, unknown> | undefined) ?? {};
  const gaps =
    (subnet.gaps as Record<string, unknown> | undefined) ??
    (root.gaps as Record<string, unknown> | undefined) ??
    {};

  // `primary_links` emits the canonical *_url / source_repo names only; the
  // `subnet.*` reads are a cross-source fallback (a different object that
  // carries the same canonical names), not a legacy alias.
  const website = pickStr(links.website_url, subnet.website_url);
  const docs = pickStr(links.docs_url, subnet.docs_url);
  const repo = pickStr(links.source_repo, subnet.source_repo);
  const dashboard = pickStr(links.dashboard_url, subnet.dashboard_url);

  const status = statusToHealth((subnet.status as string) ?? (profile.status as string));

  return {
    netuid: (subnet.netuid as number) ?? (profile.netuid as number) ?? netuid,
    name: pickStr(profile.name, subnet.name, subnet.native_name, profile.native_name),
    slug: pickStr(profile.slug, subnet.slug, subnet.native_slug),
    native_name: pickStr(subnet.native_name, profile.native_name),
    icon_url: pickStr(profile.icon_url as string, subnet.logo_url as string),
    symbol: pickStr(subnet.symbol),
    description: pickStr(subnet.notes, profile.notes),
    notes: pickStr(subnet.notes, profile.notes),
    subnet_type: pickStr(subnet.subnet_type, profile.subnet_type),
    categories: stringArrayFromUnknown(profile.categories ?? subnet.categories),
    block: subnet.block as number | undefined,
    registered_at_block: subnet.registered_at_block as number | undefined,
    tempo: subnet.tempo as number | undefined,
    participants: subnet.participant_count as number,
    mechanism_count: subnet.mechanism_count as number | undefined,
    // links
    website,
    homepage: website,
    docs,
    repo,
    dashboard,
    primary_links: { website, docs, repo, dashboard },
    // curation
    curation_level:
      (profile.curation_level as CurationLevel) ??
      (subnet.curation_level as CurationLevel) ??
      ((curation.level as CurationLevel) || undefined),
    coverage_level: subnet.coverage_level as SubnetProfile["coverage_level"],
    review_state: pickStr(profile.review_state, curation.review_state as string),
    reviewed_at: pickStr(curation.reviewed_at as string),
    confidence: pickStr(profile.confidence as string),
    completeness: completenessRatio,
    completeness_score: score,
    integration_readiness:
      typeof profile.integration_readiness === "number"
        ? (profile.integration_readiness as number)
        : undefined,
    readiness: normalizeReadiness(profile.readiness),
    // counts
    surface_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    surfaces_count: (profile.surface_count as number) ?? (subnet.surface_count as number),
    endpoint_count: (profile.endpoint_count as number) ?? (subnet.probed_surface_count as number),
    candidate_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    candidates_count: (profile.candidate_count as number) ?? (subnet.candidate_count as number),
    monitored_endpoint_count: profile.monitored_endpoint_count as number | undefined,
    operational_interface_kinds: stringArrayFromUnknown(profile.operational_interface_kinds),
    supported_interface_kinds: stringArrayFromUnknown(
      profile.supported_interface_kinds ?? gaps.supported_kinds,
    ),
    missing_kinds: stringArrayFromUnknown(gaps.missing_kinds ?? profile.missing_operational),
    gap_notes: stringArrayFromUnknown(gaps.gap_notes),
    primary_app_surface: profile.primary_app_surface as PrimaryAppSurface | undefined,
    // embedded
    surfaces: (root.surfaces as Surface[]) ?? [],
    endpoints: (root.endpoints as Endpoint[]) ?? [],
    candidate_surfaces: (root.candidate_surfaces as Candidate[]) ?? [],
    health: status,
  } as SubnetProfile;
}

export const subnetProfileQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-profile", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/profile`, { signal });
      return {
        data: normalizeSubnetProfile(res.data, netuid),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetProfile>;
    },
    staleTime: STALE_MED,
  });

export const subnetSurfacesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-surfaces", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/surfaces`,
        "surfaces",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeSurface) } as ApiResult<Surface[]>;
    },
    staleTime: STALE_MED,
  });

// #748: which surfaces carry a captured request/response sample (index), and
// the full sanitized sample for one surface (detail, fetched lazily on expand).
export const fixturesIndexQuery = () =>
  queryOptions({
    queryKey: k("fixtures-index"),
    queryFn: async ({ signal }) =>
      fetchList<FixtureIndexEntry>("/api/v1/fixtures", "fixtures", undefined, signal),
    staleTime: STALE_LONG,
  });

export const fixtureDetailQuery = (surfaceId: string) =>
  queryOptions({
    queryKey: k("fixture-detail", surfaceId),
    queryFn: async ({ signal }) =>
      apiFetch<Fixture>(`/metagraph/fixtures/${encodePathSegment(surfaceId)}.json`, { signal }),
    staleTime: STALE_LONG,
  });

export const subnetEndpointsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-endpoints", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/endpoints`,
        "endpoints",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

export const subnetHealthQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-health", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/subnets/${netuid}/health`, {
        signal,
      });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const summary = (d.summary as Record<string, unknown> | undefined) ?? {};
      const merged = normalizeHealthBlock({ ...d, ...summary });
      return { data: merged, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

/**
 * First-party chain-event stream for one subnet (#1345 block explorer):
 * registrations, stake, weights, axon, delegation, lifecycle, transfers —
 * newest first, from the account_events tier filtered by netuid. Schema-stable
 * zero for a cold/unknown subnet.
 */
// #3342: per-subnet stake-flow scorecard — net capital movement (staked in /
// unstaked out / signed net) over the window. A cold store returns all-zero
// totals (never 404); the normalizer coerces every numeric to 0, never NaN.
export function normalizeSubnetStakeFlow(netuid: number, raw: unknown): SubnetStakeFlow {
  const d = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    window: firstString(d.window) ?? "30d",
    total_staked_tao: coerceFiniteNumber(d.total_staked_tao) ?? 0,
    total_unstaked_tao: coerceFiniteNumber(d.total_unstaked_tao) ?? 0,
    net_flow_tao: coerceFiniteNumber(d.net_flow_tao) ?? 0,
    stake_events: firstFiniteNumber(d.stake_events) ?? 0,
    unstake_events: firstFiniteNumber(d.unstake_events) ?? 0,
  };
}

export const subnetStakeFlowQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-stake-flow", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetStakeFlow>>(`/api/v1/subnets/${netuid}/stake-flow`, {
        params: { window },
        signal,
      });
      return { data: normalizeSubnetStakeFlow(netuid, res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

export const subnetEventsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-events", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/subnets/${netuid}/events?limit=100`,
        { signal },
      );
      const d = (res.data ?? {}) as Record<string, unknown>;
      const events = normalizeAccountEvents(d.events);
      return {
        data: {
          netuid,
          event_count: firstFiniteNumber(d.event_count) ?? events.length,
          events,
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

function normalizeSurfaceLatencyPercentile(raw: unknown): SurfaceLatencyPercentiles | undefined {
  if (!isRecord(raw) || typeof raw.surface_id !== "string") return undefined;

  const latency = isRecord(raw.latency_ms) ? raw.latency_ms : {};
  return {
    surface_id: raw.surface_id,
    samples: optionalNumber(raw.samples),
    latency_ms: {
      p50: optionalNumber(latency.p50),
      p95: optionalNumber(latency.p95),
      p99: optionalNumber(latency.p99),
      avg: optionalNumber(latency.avg),
      min: optionalNumber(latency.min),
      max: optionalNumber(latency.max),
    },
  };
}

function normalizeSurfaceLatencyPercentiles(raw: unknown): SurfaceLatencyPercentiles[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((surface) => {
    const normalized = normalizeSurfaceLatencyPercentile(surface);
    return normalized ? [normalized] : [];
  });
}

export function normalizeSurfaceSla(raw: unknown): SurfaceSla | undefined {
  if (!isRecord(raw) || typeof raw.surface_id !== "string") return undefined;

  return {
    surface_id: raw.surface_id,
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    incident_count: optionalNumber(raw.incident_count),
    downtime_ms: optionalNumber(raw.downtime_ms),
    // Drop malformed elements (null / strings / non-objects) so downstream
    // flattenSurfaceIncidents can safely read inc.started_at etc. without
    // throwing on a single bad element and crashing the whole operational view.
    incidents: Array.isArray(raw.incidents)
      ? (raw.incidents.filter(isRecord) as SurfaceSlaIncident[])
      : undefined,
  };
}

function normalizeSurfaceSlas(raw: unknown): SurfaceSla[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((surface) => {
    const normalized = normalizeSurfaceSla(surface);
    return normalized ? [normalized] : [];
  });
}

// #1114: per-surface latency distribution (p50/p95/p99) over a 7d/30d window,
// computed live from D1.
export const subnetHealthPercentilesQuery = (netuid: number, window = "7d") =>
  queryOptions({
    queryKey: k("subnet-health-percentiles", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ surfaces?: unknown }>(
        `/api/v1/subnets/${netuid}/health/percentiles`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSurfaceLatencyPercentiles(res.data?.surfaces),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

// #1114: per-surface SLA (uptime ratio) + reconstructed downtime incidents over
// a 7d/30d window, computed live from D1.
export const subnetHealthIncidentsQuery = (netuid: number, window = "7d") =>
  queryOptions({
    queryKey: k("subnet-health-incidents", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ surfaces?: unknown }>(
        `/api/v1/subnets/${netuid}/health/incidents`,
        { params: { window }, signal },
      );
      return { data: normalizeSurfaceSlas(res.data?.surfaces), meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
  });

function epochMsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * Flatten the per-surface SLA rows from {@link subnetHealthIncidentsQuery} into
 * a single chronological list of downtime windows, newest-first. Each window is
 * tagged with its owning surface_id and has epoch-ms timestamps converted to ISO
 * strings (for TimeAgo / date rendering). The upstream payload carries no id,
 * severity, or message per incident — these are reconstructed failure windows —
 * so severity is fixed to "high" and identity comes from surface_id + start.
 */
export function flattenSurfaceIncidents(slas: SurfaceSla[]): FlatSurfaceIncident[] {
  const out: FlatSurfaceIncident[] = [];
  for (const sla of slas) {
    for (const inc of sla.incidents ?? []) {
      out.push({
        surface_id: sla.surface_id,
        started_at: epochMsToIso(inc.started_at),
        ended_at: inc.ended_at == null ? null : (epochMsToIso(inc.ended_at) ?? null),
        duration_ms: typeof inc.duration_ms === "number" ? inc.duration_ms : undefined,
        failed_samples: typeof inc.failed_samples === "number" ? inc.failed_samples : undefined,
        severity: "high",
      });
    }
  }
  return out.sort((a, b) => {
    const at = a.started_at ? Date.parse(a.started_at) : 0;
    const bt = b.started_at ? Date.parse(b.started_at) : 0;
    return bt - at;
  });
}

// #1115: weekly structural trajectory (completeness / surface / endpoint counts
// over time) from D1 snapshots.
export const subnetTrajectoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-trajectory", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Trajectory>>(`/api/v1/subnets/${netuid}/trajectory`, {
        signal,
      });
      return { data: normalizeTrajectory(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_LONG,
  });

// #1115: long-range daily uptime history + reliability grade per surface, over a
// 90d/1y window.
export const subnetUptimeQuery = (netuid: number, window = "90d") =>
  queryOptions({
    queryKey: k("subnet-uptime", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<Uptime>>(`/api/v1/subnets/${netuid}/uptime`, {
        params: { window },
        signal,
      });
      return { data: normalizeUptime(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// One subnet's consensus/economic/governance hyperparameters (#4307/1.4),
// refreshed daily from the subnet_hyperparams D1 tier. Cold/absent snapshot ->
// hyperparameters: null, never an error.
function normalizeSubnetHyperparameters(raw: unknown): SubnetHyperparameters | null {
  if (!isRecord(raw)) return null;
  return {
    kappa_ratio: firstFiniteNumber(raw.kappa_ratio) ?? null,
    immunity_period: firstFiniteNumber(raw.immunity_period) ?? null,
    min_allowed_weights: firstFiniteNumber(raw.min_allowed_weights) ?? null,
    max_weight_limit_ratio: firstFiniteNumber(raw.max_weight_limit_ratio) ?? null,
    tempo: firstFiniteNumber(raw.tempo) ?? null,
    weights_version: firstFiniteNumber(raw.weights_version) ?? null,
    weights_rate_limit: firstFiniteNumber(raw.weights_rate_limit) ?? null,
    activity_cutoff: firstFiniteNumber(raw.activity_cutoff) ?? null,
    activity_cutoff_factor: firstFiniteNumber(raw.activity_cutoff_factor) ?? null,
    registration_allowed: booleanValue(raw.registration_allowed) ?? false,
    target_regs_per_interval: firstFiniteNumber(raw.target_regs_per_interval) ?? null,
    min_burn_tao: firstFiniteNumber(raw.min_burn_tao) ?? null,
    max_burn_tao: firstFiniteNumber(raw.max_burn_tao) ?? null,
    burn_half_life: firstFiniteNumber(raw.burn_half_life) ?? null,
    burn_increase_mult: firstFiniteNumber(raw.burn_increase_mult) ?? null,
    bonds_moving_avg_raw: firstFiniteNumber(raw.bonds_moving_avg_raw) ?? null,
    max_regs_per_block: firstFiniteNumber(raw.max_regs_per_block) ?? null,
    serving_rate_limit: firstFiniteNumber(raw.serving_rate_limit) ?? null,
    max_validators: firstFiniteNumber(raw.max_validators) ?? null,
    commit_reveal_period: firstFiniteNumber(raw.commit_reveal_period) ?? null,
    commit_reveal_enabled: booleanValue(raw.commit_reveal_enabled) ?? false,
    alpha_high_ratio: firstFiniteNumber(raw.alpha_high_ratio) ?? null,
    alpha_low_ratio: firstFiniteNumber(raw.alpha_low_ratio) ?? null,
    liquid_alpha_enabled: booleanValue(raw.liquid_alpha_enabled) ?? false,
    alpha_sigmoid_steepness: firstFiniteNumber(raw.alpha_sigmoid_steepness) ?? null,
    yuma_version: firstFiniteNumber(raw.yuma_version) ?? null,
    subnet_is_active: booleanValue(raw.subnet_is_active) ?? false,
    transfers_enabled: booleanValue(raw.transfers_enabled) ?? false,
    bonds_reset_enabled: booleanValue(raw.bonds_reset_enabled) ?? false,
    user_liquidity_enabled: booleanValue(raw.user_liquidity_enabled) ?? false,
    owner_cut_enabled: booleanValue(raw.owner_cut_enabled) ?? false,
    owner_cut_auto_lock_enabled: booleanValue(raw.owner_cut_auto_lock_enabled) ?? false,
    min_childkey_take_ratio: firstFiniteNumber(raw.min_childkey_take_ratio) ?? null,
  };
}

export const subnetHyperparametersQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-hyperparameters", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/hyperparameters`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: firstFiniteNumber(d.schema_version) ?? undefined,
          netuid,
          captured_at: firstString(d.captured_at) ?? null,
          block_number: firstFiniteNumber(d.block_number) ?? null,
          hyperparameters: normalizeSubnetHyperparameters(d.hyperparameters),
        } as SubnetHyperparametersDetail,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetHyperparametersDetail>;
    },
    staleTime: STALE_MED,
  });

// #1302: per-subnet on-chain history — daily neuron/validator counts, total
// stake and emission over a 7d/30d/90d/1y/all window, from the D1 snapshot store.
export const subnetHistoryQuery = (netuid: number, window = "90d") =>
  queryOptions({
    queryKey: k("subnet-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetHistory>>(`/api/v1/subnets/${netuid}/history`, {
        params: { window },
        signal,
      });
      return { data: normalizeSubnetHistory(netuid, res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// One observed on-chain SubnetIdentitiesV3 snapshot (#1647). Operator-controlled
// untrusted data: every field but the stable `identity_hash` coerces to null on
// junk, and a row without an identity_hash (the keyset anchor) is discarded.
export function normalizeSubnetIdentityHistoryEntry(
  raw: unknown,
): SubnetIdentityHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const identityHash = firstString(raw.identity_hash);
  if (identityHash == null) return null;
  return {
    identity_hash: identityHash,
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
    subnet_name: firstString(raw.subnet_name) ?? null,
    symbol: firstString(raw.symbol) ?? null,
    description: firstString(raw.description) ?? null,
    github_repo: firstString(raw.github_repo) ?? null,
    subnet_url: firstString(raw.subnet_url) ?? null,
    logo_url: firstString(raw.logo_url) ?? null,
    discord: firstString(raw.discord) ?? null,
  };
}

const MAX_SUBNET_IDENTITY_HISTORY_ENTRIES = 1000;

function normalizeSubnetIdentityHistory(netuid: number, raw: unknown): SubnetIdentityHistory {
  const rec = isRecord(raw) ? raw : {};
  const entries = (Array.isArray(rec.entries) ? rec.entries : [])
    .map(normalizeSubnetIdentityHistoryEntry)
    .filter((entry): entry is SubnetIdentityHistoryEntry => entry != null)
    .slice(0, MAX_SUBNET_IDENTITY_HISTORY_ENTRIES);
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    entry_count: firstFiniteNumber(rec.entry_count) ?? entries.length,
    entries,
    limit: firstFiniteNumber(rec.limit) ?? null,
    offset: firstFiniteNumber(rec.offset) ?? null,
    next_cursor: firstString(rec.next_cursor) ?? null,
  };
}

// #1647: append-only on-chain identity timeline for one subnet (newest first),
// from the subnet_identity_history D1 tier. No paging params surfaced yet — the
// default page (limit<=1000) is enough for the profile tab that consumes this.
export const subnetIdentityHistoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-identity-history", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetIdentityHistory>>(
        `/api/v1/subnets/${netuid}/identity-history`,
        { signal },
      );
      return {
        data: normalizeSubnetIdentityHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// One validator's weight-setting row (#1657). Identified by hotkey or uid — a row
// with neither is dropped; the count falls through to 0 and share to null on junk.
export function normalizeSubnetWeightSetter(raw: unknown): SubnetWeightSetter | null {
  if (!isRecord(raw)) return null;
  const hotkey = firstString(raw.hotkey) ?? null;
  const uid = firstFiniteNumber(raw.uid) ?? null;
  if (hotkey == null && uid == null) return null;
  return {
    hotkey,
    uid,
    weight_sets: firstFiniteNumber(raw.weight_sets) ?? 0,
    share: firstFiniteNumber(raw.share) ?? null,
    first_set_at: firstString(raw.first_set_at) ?? null,
    last_set_at: firstString(raw.last_set_at) ?? null,
  };
}

const MAX_SUBNET_WEIGHT_SETTERS = 256;

function normalizeSubnetWeightSetters(netuid: number, raw: unknown): SubnetWeightSetters {
  const rec = isRecord(raw) ? raw : {};
  const setters = (Array.isArray(rec.setters) ? rec.setters : [])
    .map(normalizeSubnetWeightSetter)
    .filter((setter): setter is SubnetWeightSetter => setter != null)
    .slice(0, MAX_SUBNET_WEIGHT_SETTERS);
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_setters: firstFiniteNumber(rec.distinct_setters) ?? 0,
    weight_sets: firstFiniteNumber(rec.weight_sets) ?? 0,
    setter_count: firstFiniteNumber(rec.setter_count) ?? setters.length,
    setters,
  };
}

// #1657: per-subnet weight-setters leaderboard over a 7d/30d window — the
// individual validators behind the subnet's WeightsSet activity, newest first.
export const subnetWeightSettersQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-weight-setters", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetWeightSetters>>(
        `/api/v1/subnets/${netuid}/weights/setters`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetWeightSetters(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1657: per-subnet axon-removal (teardown) activity over a 7d/30d window. A flat
// summary card — count/distinct-remover/average — from the account_events
// AxonInfoRemoved stream. Every numeric cell coerces defensively: counts fall
// through to 0 and the average to null (never NaN) on a cold store or junk.
export function normalizeSubnetAxonRemovals(netuid: number, raw: unknown): SubnetAxonRemovals {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_removers: firstFiniteNumber(rec.distinct_removers) ?? 0,
    removals: firstFiniteNumber(rec.removals) ?? 0,
    removals_per_remover: firstFiniteNumber(rec.removals_per_remover) ?? null,
  };
}

export const subnetAxonRemovalsQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-axon-removals", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetAxonRemovals>>(
        `/api/v1/subnets/${netuid}/axon-removals`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetAxonRemovals(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// Per-subnet stake-movement (re-delegation) activity over a 7d/30d window. A flat
// summary card — count/distinct-mover/average — from the account_events
// StakeMoved stream. Every numeric cell coerces defensively: counts fall through
// to 0 and the average to null (never NaN) on a cold store or junk.
export function normalizeSubnetStakeMoves(netuid: number, raw: unknown): SubnetStakeMoves {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_movers: firstFiniteNumber(rec.distinct_movers) ?? 0,
    movements: firstFiniteNumber(rec.movements) ?? 0,
    movements_per_mover: firstFiniteNumber(rec.movements_per_mover) ?? null,
  };
}

export const subnetStakeMovesQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-stake-moves", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetStakeMoves>>(
        `/api/v1/subnets/${netuid}/stake-moves`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetStakeMoves(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #3484: per-subnet stake-transfer activity over a 7d/30d window. A flat summary
// card — StakeTransferred event count/distinct-sender/average — from the
// account_events transfer_stake stream. Every numeric cell coerces defensively:
// counts fall through to 0 and the average to null (never NaN) on a cold store or junk.
export function normalizeSubnetStakeTransfers(netuid: number, raw: unknown): SubnetStakeTransfers {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_senders: firstFiniteNumber(rec.distinct_senders) ?? 0,
    transfers: firstFiniteNumber(rec.transfers) ?? 0,
    transfers_per_sender: firstFiniteNumber(rec.transfers_per_sender) ?? null,
  };
}

export const subnetStakeTransfersQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-stake-transfers", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetStakeTransfers>>(
        `/api/v1/subnets/${netuid}/stake-transfers`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetStakeTransfers(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// Per-subnet axon-serving announcement activity over a 7d/30d window.
export function normalizeSubnetServing(netuid: number, raw: unknown): SubnetServing {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_servers: firstFiniteNumber(rec.distinct_servers) ?? 0,
    announcements: firstFiniteNumber(rec.announcements) ?? 0,
    announcements_per_server: firstFiniteNumber(rec.announcements_per_server) ?? null,
  };
}

export const subnetServingQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-serving", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetServing>>(`/api/v1/subnets/${netuid}/serving`, {
        params: { window },
        signal,
      });
      return {
        data: normalizeSubnetServing(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// Per-subnet Prometheus-endpoint serving activity over a 7d/30d window.
export function normalizeSubnetPrometheus(netuid: number, raw: unknown): SubnetPrometheus {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_exporters: firstFiniteNumber(rec.distinct_exporters) ?? 0,
    announcements: firstFiniteNumber(rec.announcements) ?? 0,
    announcements_per_exporter: firstFiniteNumber(rec.announcements_per_exporter) ?? null,
  };
}

export const subnetPrometheusQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-prometheus", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetPrometheus>>(
        `/api/v1/subnets/${netuid}/prometheus`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetPrometheus(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1657: per-subnet neuron-registration event volume over a 7d/30d window. A flat
// summary card from the account_events NeuronRegistered stream; counts fall
// through to 0 and the average to null (never NaN) on a cold store or junk cell.
export function normalizeSubnetRegistrations(netuid: number, raw: unknown): SubnetRegistrations {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_registrants: firstFiniteNumber(rec.distinct_registrants) ?? 0,
    registrations: firstFiniteNumber(rec.registrations) ?? 0,
    registrations_per_registrant: firstFiniteNumber(rec.registrations_per_registrant) ?? null,
  };
}

export const subnetRegistrationsQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-registrations", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetRegistrations>>(
        `/api/v1/subnets/${netuid}/registrations`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetRegistrations(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1657: per-subnet neuron-deregistration (eviction) event volume over a 7d/30d
// window — the eviction-side complement of the registrations card above.
export function normalizeSubnetDeregistrations(
  netuid: number,
  raw: unknown,
): SubnetDeregistrations {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_deregistered_hotkeys: firstFiniteNumber(rec.distinct_deregistered_hotkeys) ?? 0,
    deregistrations: firstFiniteNumber(rec.deregistrations) ?? 0,
    deregistrations_per_hotkey: firstFiniteNumber(rec.deregistrations_per_hotkey) ?? null,
  };
}

export const subnetDeregistrationsQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-deregistrations", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetDeregistrations>>(
        `/api/v1/subnets/${netuid}/deregistrations`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetDeregistrations(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// Per-subnet aggregate weight-setting activity over a 7d/30d window.
export function normalizeSubnetWeights(netuid: number, raw: unknown): SubnetWeights {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_setters: firstFiniteNumber(rec.distinct_setters) ?? 0,
    weight_sets: firstFiniteNumber(rec.weight_sets) ?? 0,
    sets_per_setter: firstFiniteNumber(rec.sets_per_setter) ?? null,
  };
}

export const subnetWeightsQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-weights", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetWeights>>(`/api/v1/subnets/${netuid}/weights`, {
        params: { window },
        signal,
      });
      return {
        data: normalizeSubnetWeights(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// Per-subnet validator-set & registration turnover (churn) scorecard: diffs the
// window's start/end neuron_daily snapshots. `comparable: false` on a cold store
// or single-snapshot window — ratio/score fields stay null rather than zeroed.
export function normalizeSubnetTurnover(netuid: number, raw: unknown): SubnetTurnover {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    start_date: firstString(rec.start_date) ?? null,
    end_date: firstString(rec.end_date) ?? null,
    comparable: rec.comparable === true,
    validators_start: firstFiniteNumber(rec.validators_start) ?? 0,
    validators_end: firstFiniteNumber(rec.validators_end) ?? 0,
    validators_entered: firstFiniteNumber(rec.validators_entered) ?? 0,
    validators_exited: firstFiniteNumber(rec.validators_exited) ?? 0,
    validator_retention: firstFiniteNumber(rec.validator_retention) ?? null,
    neurons_start: firstFiniteNumber(rec.neurons_start) ?? 0,
    neurons_end: firstFiniteNumber(rec.neurons_end) ?? 0,
    uids_deregistered: firstFiniteNumber(rec.uids_deregistered) ?? 0,
    neuron_retention: firstFiniteNumber(rec.neuron_retention) ?? null,
    stability_score: firstFiniteNumber(rec.stability_score) ?? null,
  };
}

export const subnetTurnoverQuery = (netuid: number, window = "30d") =>
  queryOptions({
    queryKey: k("subnet-turnover", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetTurnover>>(`/api/v1/subnets/${netuid}/turnover`, {
        params: { window },
        signal,
      });
      return {
        data: normalizeSubnetTurnover(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1302: per-UID on-chain history — daily emission/incentive/consensus/dividends/
// stake/rank for a single neuron over a window, from the D1 snapshot store.
export const subnetNeuronHistoryQuery = (netuid: number, uid: number, window = "90d") =>
  queryOptions({
    queryKey: k("subnet-neuron-history", netuid, uid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetNeuronHistory>>(
        `/api/v1/subnets/${netuid}/neurons/${uid}/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetNeuronHistory(netuid, uid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// ---- Subnet economic depth (metagraph / validators / concentration) --------
// Live metagraph-snapshot tier. Inactive UIDs carry null rank/axon/emission, so
// every per-neuron field is guarded null-safe and falls through to undefined.

/** Normalize one neuron row; null/missing optional fields collapse to undefined. */
function normalizeMetagraphNeuron(raw: unknown): MetagraphNeuron | undefined {
  if (!isRecord(raw)) return undefined;
  const uid = coerceFiniteNumber(raw.uid);
  if (uid == null) return undefined;
  return {
    ...(raw as object),
    uid,
    hotkey: coerceString(raw.hotkey),
    coldkey: coerceString(raw.coldkey),
    active: booleanValue(raw.active),
    validator_permit: booleanValue(raw.validator_permit),
    rank: coerceFiniteNumber(raw.rank) ?? null,
    trust: coerceFiniteNumber(raw.trust),
    validator_trust: coerceFiniteNumber(raw.validator_trust),
    consensus: coerceFiniteNumber(raw.consensus),
    incentive: coerceFiniteNumber(raw.incentive),
    dividends: coerceFiniteNumber(raw.dividends),
    emission_tao: coerceFiniteNumber(raw.emission_tao),
    stake_tao: coerceFiniteNumber(raw.stake_tao),
    registered_at_block: coerceFiniteNumber(raw.registered_at_block),
    is_immunity_period: booleanValue(raw.is_immunity_period),
    axon: coerceString(raw.axon) ?? null,
  };
}

function normalizeNeuronRows(raw: unknown): MetagraphNeuron[] {
  return Array.isArray(raw)
    ? raw.slice(0, MAX_NEURON_ROWS).flatMap((n) => {
        const normalized = normalizeMetagraphNeuron(n);
        return normalized ? [normalized] : [];
      })
    : [];
}

function normalizeSubnetMetagraph(netuid: number, raw: unknown): SubnetMetagraph {
  const d = isRecord(raw) ? raw : {};
  const neurons = normalizeNeuronRows(d.neurons);
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    neuron_count: coerceFiniteNumber(d.neuron_count) ?? neurons.length,
    captured_at: coerceString(d.captured_at),
    block_number: coerceFiniteNumber(d.block_number),
    neurons,
  };
}

function normalizeSubnetValidators(netuid: number, raw: unknown): SubnetValidators {
  const d = isRecord(raw) ? raw : {};
  const validators = normalizeNeuronRows(d.validators);
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    validator_count: coerceFiniteNumber(d.validator_count) ?? validators.length,
    captured_at: coerceString(d.captured_at),
    block_number: coerceFiniteNumber(d.block_number),
    validators,
  };
}

const GLOBAL_VALIDATOR_SORTS: GlobalValidatorSort[] = [
  "avg_validator_trust",
  "max_validator_trust",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
];

function normalizeGlobalValidatorSubnet(raw: unknown): GlobalValidatorSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  const uid = coerceFiniteNumber(raw.uid);
  if (netuid == null || uid == null) return null;
  return {
    netuid,
    uid,
    stake_tao: coerceFiniteNumber(raw.stake_tao) ?? 0,
    emission_tao: coerceFiniteNumber(raw.emission_tao) ?? 0,
    validator_trust:
      raw.validator_trust == null ? null : (coerceFiniteNumber(raw.validator_trust) ?? null),
  };
}

function normalizeGlobalValidator(raw: unknown): GlobalValidator | null {
  if (!isRecord(raw)) return null;
  const hotkey = coerceString(raw.hotkey);
  if (!hotkey) return null;
  const subnets = Array.isArray(raw.subnets)
    ? raw.subnets.flatMap((subnet) => {
        const normalized = normalizeGlobalValidatorSubnet(subnet);
        return normalized ? [normalized] : [];
      })
    : [];
  const nullableNum = (value: unknown): number | null =>
    value == null ? null : (coerceFiniteNumber(value) ?? null);
  return {
    hotkey,
    coldkey: typeof raw.coldkey === "string" ? raw.coldkey : null,
    coldkey_count: coerceFiniteNumber(raw.coldkey_count) ?? 0,
    subnet_count: coerceFiniteNumber(raw.subnet_count) ?? 0,
    uid_count: coerceFiniteNumber(raw.uid_count) ?? 0,
    total_stake_tao: coerceFiniteNumber(raw.total_stake_tao) ?? 0,
    total_emission_tao: coerceFiniteNumber(raw.total_emission_tao) ?? 0,
    avg_validator_trust: nullableNum(raw.avg_validator_trust),
    max_validator_trust: nullableNum(raw.max_validator_trust),
    stake_dominance: nullableNum(raw.stake_dominance),
    latest_captured_at: typeof raw.latest_captured_at === "string" ? raw.latest_captured_at : null,
    latest_block_number: nullableNum(raw.latest_block_number),
    subnets,
  };
}

export function normalizeGlobalValidators(raw: unknown): GlobalValidators {
  const d = isRecord(raw) ? raw : {};
  const sortRaw = coerceString(d.sort);
  const sort = GLOBAL_VALIDATOR_SORTS.includes(sortRaw as GlobalValidatorSort)
    ? (sortRaw as GlobalValidatorSort)
    : "subnet_count";
  const validators = Array.isArray(d.validators)
    ? d.validators.flatMap((validator) => {
        const normalized = normalizeGlobalValidator(validator);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: coerceFiniteNumber(d.schema_version),
    sort,
    limit: coerceFiniteNumber(d.limit) ?? validators.length,
    validator_count: coerceFiniteNumber(d.validator_count) ?? validators.length,
    captured_at: coerceString(d.captured_at),
    block_number: coerceFiniteNumber(d.block_number),
    validators,
  };
}

function normalizeNeuronSnapshot(netuid: number, uid: number, raw: unknown): SubnetNeuronSnapshot {
  const d = isRecord(raw) ? raw : {};
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    uid: coerceFiniteNumber(d.uid) ?? uid,
    captured_at: coerceString(d.captured_at),
    block_number: coerceFiniteNumber(d.block_number),
    neuron: normalizeMetagraphNeuron(d.neuron),
  };
}

function normalizeConcentrationMetrics(raw: unknown): ConcentrationMetrics | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    holders: coerceFiniteNumber(raw.holders),
    total: coerceFiniteNumber(raw.total),
    gini: coerceFiniteNumber(raw.gini),
    hhi: coerceFiniteNumber(raw.hhi),
    hhi_normalized: coerceFiniteNumber(raw.hhi_normalized),
    nakamoto_coefficient: coerceFiniteNumber(raw.nakamoto_coefficient),
    top_1pct_share: coerceFiniteNumber(raw.top_1pct_share),
    top_5pct_share: coerceFiniteNumber(raw.top_5pct_share),
    top_10pct_share: coerceFiniteNumber(raw.top_10pct_share),
    top_20pct_share: coerceFiniteNumber(raw.top_20pct_share),
    entropy: coerceFiniteNumber(raw.entropy),
    entropy_normalized: coerceFiniteNumber(raw.entropy_normalized),
  };
}

// Nullable concentration lens: backend emits null on cold/empty stores; malformed
// all-null objects must not become a non-null card (ConcentrationMetrics contract).
export function normalizeConcentrationMetricsOrNull(raw: unknown): ConcentrationMetrics | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;
  const holders = coerceFiniteNumber(raw.holders);
  const gini = coerceFiniteNumber(raw.gini);
  const hhi = coerceFiniteNumber(raw.hhi);
  const hhi_normalized = coerceFiniteNumber(raw.hhi_normalized);
  const nakamoto_coefficient = coerceFiniteNumber(raw.nakamoto_coefficient);
  if (
    holders === 0 ||
    (holders == null &&
      gini == null &&
      hhi == null &&
      hhi_normalized == null &&
      nakamoto_coefficient == null)
  ) {
    return null;
  }
  return normalizeConcentrationMetrics(raw) ?? null;
}

export function normalizeScoreDistributionOrNull(raw: unknown): ScoreDistribution | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;
  const count = coerceFiniteNumber(raw.count);
  if (count == null || count === 0) return null;
  return {
    count,
    mean: coerceFiniteNumber(raw.mean) ?? null,
    min: coerceFiniteNumber(raw.min) ?? null,
    max: coerceFiniteNumber(raw.max) ?? null,
    p10: coerceFiniteNumber(raw.p10) ?? null,
    p25: coerceFiniteNumber(raw.p25) ?? null,
    p50: coerceFiniteNumber(raw.p50) ?? null,
    p75: coerceFiniteNumber(raw.p75) ?? null,
    p90: coerceFiniteNumber(raw.p90) ?? null,
  };
}

export function normalizeChainConcentration(raw: unknown): ChainConcentration {
  const d = isRecord(raw) ? raw : {};
  return {
    schema_version: coerceFiniteNumber(d.schema_version) ?? 1,
    subnet_count: coerceFiniteNumber(d.subnet_count) ?? 0,
    neuron_count: coerceFiniteNumber(d.neuron_count) ?? 0,
    entity_count: coerceFiniteNumber(d.entity_count) ?? 0,
    uids_per_entity: coerceFiniteNumber(d.uids_per_entity) ?? null,
    captured_at: coerceString(d.captured_at) ?? null,
    stake: normalizeConcentrationMetricsOrNull(d.stake),
    emission: normalizeConcentrationMetricsOrNull(d.emission),
    entity_stake: normalizeConcentrationMetricsOrNull(d.entity_stake),
    entity_emission: normalizeConcentrationMetricsOrNull(d.entity_emission),
    validator_stake: normalizeConcentrationMetricsOrNull(d.validator_stake),
  };
}

export function normalizeChainPerformance(raw: unknown): ChainPerformance {
  const d = isRecord(raw) ? raw : {};
  return {
    schema_version: coerceFiniteNumber(d.schema_version) ?? 1,
    subnet_count: coerceFiniteNumber(d.subnet_count) ?? 0,
    neuron_count: coerceFiniteNumber(d.neuron_count) ?? 0,
    validator_count: coerceFiniteNumber(d.validator_count),
    active_count: coerceFiniteNumber(d.active_count),
    captured_at: coerceString(d.captured_at) ?? null,
    incentive: normalizeConcentrationMetricsOrNull(d.incentive),
    dividends: normalizeConcentrationMetricsOrNull(d.dividends),
    trust: normalizeScoreDistributionOrNull(d.trust),
    consensus: normalizeScoreDistributionOrNull(d.consensus),
    validator_trust: normalizeScoreDistributionOrNull(d.validator_trust),
  };
}

function normalizeSubnetConcentration(netuid: number, raw: unknown): SubnetConcentration {
  const d = isRecord(raw) ? raw : {};
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    neuron_count: coerceFiniteNumber(d.neuron_count),
    entity_count: coerceFiniteNumber(d.entity_count),
    uids_per_entity: coerceFiniteNumber(d.uids_per_entity),
    captured_at: coerceString(d.captured_at),
    stake: normalizeConcentrationMetrics(d.stake),
    emission: normalizeConcentrationMetrics(d.emission),
    entity_stake: normalizeConcentrationMetrics(d.entity_stake),
    entity_emission: normalizeConcentrationMetrics(d.entity_emission),
    validator_stake: normalizeConcentrationMetrics(d.validator_stake),
  };
}

function normalizeConcentrationHistoryPoint(raw: unknown): ConcentrationHistoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const snapshotDate = coerceString(raw.snapshot_date);
  if (!snapshotDate) return undefined;
  // Nullable-by-design: the early window has no stake metrics yet — keep null
  // (not undefined) so the chart can render a gap rather than dropping the day.
  const nullableNum = (v: unknown): number | null => coerceFiniteNumber(v) ?? null;
  return {
    ...(raw as object),
    snapshot_date: snapshotDate,
    neuron_count: coerceFiniteNumber(raw.neuron_count),
    stake_gini: nullableNum(raw.stake_gini),
    stake_nakamoto_coefficient: nullableNum(raw.stake_nakamoto_coefficient),
    stake_top_10pct_share: nullableNum(raw.stake_top_10pct_share),
    emission_gini: nullableNum(raw.emission_gini),
    emission_nakamoto_coefficient: nullableNum(raw.emission_nakamoto_coefficient),
    emission_top_10pct_share: nullableNum(raw.emission_top_10pct_share),
  };
}

function normalizeSubnetConcentrationHistory(
  netuid: number,
  raw: unknown,
): SubnetConcentrationHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizeConcentrationHistoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    window: coerceString(d.window),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
  };
}

/** Full metagraph snapshot — all neurons with stake/emission/rank/trust/permit. */
export const subnetMetagraphQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-metagraph", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetMetagraph>>(`/api/v1/subnets/${netuid}/metagraph`, {
        signal,
      });
      return {
        data: normalizeSubnetMetagraph(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetMetagraph>;
    },
    staleTime: STALE_SHORT,
  });

/** Pre-filtered + ranked validator set (permitted neurons, stake-sorted). */
export const subnetValidatorsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-validators", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetValidators>>(
        `/api/v1/subnets/${netuid}/validators`,
        { signal },
      );
      return {
        data: normalizeSubnetValidators(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetValidators>;
    },
    staleTime: STALE_SHORT,
  });

/** Network-wide validator/operator leaderboard grouped by hotkey. */
export const validatorsQuery = ({
  sort = "subnet_count",
  limit = 20,
}: { sort?: GlobalValidatorSort; limit?: number } = {}) =>
  queryOptions({
    queryKey: k("global-validators", sort, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<GlobalValidators>>("/api/v1/validators", {
        params: { sort, limit },
        signal,
      });
      return {
        data: normalizeGlobalValidators(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<GlobalValidators>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeValidatorDetailSubnet(raw: unknown): ValidatorDetailSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  const uid = firstFiniteNumber(raw.uid);
  if (netuid == null || uid == null) return null;
  return {
    netuid,
    uid,
    hotkey: firstString(raw.hotkey) ?? null,
    coldkey: firstString(raw.coldkey) ?? null,
    active: booleanValue(raw.active) ?? null,
    validator_permit: booleanValue(raw.validator_permit) ?? false,
    rank: firstFiniteNumber(raw.rank) ?? null,
    trust: firstFiniteNumber(raw.trust) ?? null,
    validator_trust: firstFiniteNumber(raw.validator_trust) ?? null,
    consensus: firstFiniteNumber(raw.consensus) ?? null,
    incentive: firstFiniteNumber(raw.incentive) ?? null,
    dividends: firstFiniteNumber(raw.dividends) ?? null,
    emission_tao: firstFiniteNumber(raw.emission_tao) ?? null,
    stake_tao: firstFiniteNumber(raw.stake_tao) ?? null,
    registered_at_block: firstFiniteNumber(raw.registered_at_block) ?? null,
    is_immunity_period: booleanValue(raw.is_immunity_period) ?? null,
    axon: firstString(raw.axon) ?? null,
  };
}

/** Cross-subnet validator detail — a validator's rows joined across every subnet
 * they operate in (#4335/7.1). Schema-stable: a cold/unknown hotkey resolves to
 * a zeroed aggregate rather than an error, so this never throws on a bad hotkey. */
export const validatorDetailQuery = (hotkey: string) =>
  queryOptions({
    queryKey: k("validator-detail", hotkey),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/validators/${ss58PathSegment(hotkey)}`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const subnets = Array.isArray(d.subnets)
        ? d.subnets.flatMap((row) => {
            const s = normalizeValidatorDetailSubnet(row);
            return s ? [s] : [];
          })
        : [];
      return {
        data: {
          hotkey: firstString(d.hotkey) ?? hotkey,
          coldkey: firstString(d.coldkey) ?? null,
          coldkey_count: firstFiniteNumber(d.coldkey_count) ?? 0,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
          total_stake_tao: firstFiniteNumber(d.total_stake_tao) ?? 0,
          total_emission_tao: firstFiniteNumber(d.total_emission_tao) ?? 0,
          avg_validator_trust: firstFiniteNumber(d.avg_validator_trust) ?? null,
          max_validator_trust: firstFiniteNumber(d.max_validator_trust) ?? null,
          captured_at: firstString(d.captured_at) ?? null,
          block_number: firstFiniteNumber(d.block_number) ?? null,
          subnets,
        } as ValidatorDetail,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ValidatorDetail>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeValidatorNominator(raw: unknown): ValidatorNominatorEntry | null {
  if (!isRecord(raw)) return null;
  const coldkey = firstString(raw.coldkey);
  if (!coldkey) return null;
  return {
    coldkey,
    staked_tao: firstFiniteNumber(raw.staked_tao) ?? 0,
    unstaked_tao: firstFiniteNumber(raw.unstaked_tao) ?? 0,
    net_staked_tao: firstFiniteNumber(raw.net_staked_tao) ?? 0,
    gross_staked_tao: firstFiniteNumber(raw.gross_staked_tao) ?? 0,
    event_count: firstFiniteNumber(raw.event_count) ?? 0,
    last_observed_at: firstString(raw.last_observed_at) ?? null,
  };
}

/** Nominator list + search for one validator, derived from stake-delegation
 * account_events (#4336/7.2). Offset-paginated, newest/largest-first per `sort`. */
export const validatorNominatorsQuery = (hotkey: string, params?: QueryParams) =>
  queryOptions({
    queryKey: k("validator-nominators", hotkey, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/validators/${ss58PathSegment(hotkey)}/nominators`,
        "nominators",
        params,
        signal,
      );
      const data = res.data.flatMap((row) => {
        const n = normalizeValidatorNominator(row);
        return n ? [n] : [];
      });
      return { ...res, data } as ApiResult<ValidatorNominatorEntry[]>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeValidatorHistoryPoint(raw: unknown): ValidatorHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const snapshotDate = firstString(raw.snapshot_date);
  if (!snapshotDate) return null;
  return {
    snapshot_date: snapshotDate,
    subnet_count: firstFiniteNumber(raw.subnet_count) ?? null,
    total_stake_tao: firstFiniteNumber(raw.total_stake_tao) ?? null,
    total_emission_tao: firstFiniteNumber(raw.total_emission_tao) ?? null,
    rewards_per_1000_tao: firstFiniteNumber(raw.rewards_per_1000_tao) ?? null,
  };
}

/** Daily staked-over-time + rewards-per-1000-TAO series for one validator,
 * reusing the neuron_daily rollup (#4337/7.3). */
export const validatorHistoryQuery = (hotkey: string, window: string) =>
  queryOptions({
    queryKey: k("validator-history", hotkey, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/validators/${ss58PathSegment(hotkey)}/history`, {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const points = Array.isArray(d.points)
        ? d.points.flatMap((row) => {
            const p = normalizeValidatorHistoryPoint(row);
            return p ? [p] : [];
          })
        : [];
      return {
        data: {
          hotkey: firstString(d.hotkey) ?? hotkey,
          window: firstString(d.window) ?? null,
          point_count: firstFiniteNumber(d.point_count) ?? points.length,
          points,
        } as ValidatorHistory,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ValidatorHistory>;
    },
    staleTime: STALE_SHORT,
  });

/** Single-neuron snapshot for the drill-in detail card. */
export const subnetNeuronQuery = (netuid: number, uid: number) =>
  queryOptions({
    queryKey: k("subnet-neuron", netuid, uid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetNeuronSnapshot>>(
        `/api/v1/subnets/${netuid}/neurons/${uid}`,
        { signal },
      );
      return {
        data: normalizeNeuronSnapshot(netuid, uid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetNeuronSnapshot>;
    },
    staleTime: STALE_SHORT,
  });

/** Stake/emission concentration metrics (Gini, HHI, Nakamoto, top-pct shares). */
export const subnetConcentrationQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-concentration", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetConcentration>>(
        `/api/v1/subnets/${netuid}/concentration`,
        { signal },
      );
      return {
        data: normalizeSubnetConcentration(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetConcentration>;
    },
    staleTime: STALE_MED,
  });

/** Daily concentration drift (stake/emission Gini, Nakamoto, top-10% share). */
export const subnetConcentrationHistoryQuery = (
  netuid: number,
  window: "7d" | "30d" | "90d" = "30d",
) =>
  queryOptions({
    queryKey: k("subnet-concentration-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetConcentrationHistory>>(
        `/api/v1/subnets/${netuid}/concentration/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetConcentrationHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetConcentrationHistory>;
    },
    staleTime: STALE_MED,
  });

/** Network-wide stake/emission concentration (Gini, HHI, Nakamoto, entity lenses). */
export const chainConcentrationQuery = () =>
  queryOptions({
    queryKey: k("chain-concentration"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainConcentration>>("/api/v1/chain/concentration", {
        signal,
      });
      return {
        data: normalizeChainConcentration(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainConcentration>;
    },
    staleTime: STALE_MED,
  });

/** Network-wide reward-distribution & trust/consensus score spread. */
export const chainPerformanceQuery = () =>
  queryOptions({
    queryKey: k("chain-performance"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainPerformance>>("/api/v1/chain/performance", {
        signal,
      });
      return {
        data: normalizeChainPerformance(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainPerformance>;
    },
    staleTime: STALE_MED,
  });

// #3477: reward-distribution + score-spread for one subnet — the reward-flow
// twin of the stake/emission concentration above. /performance reuses the same
// ConcentrationMetrics scorecard (Gini/HHI/Nakamoto/top-share) over incentive +
// dividends, and adds the 0-1 trust/consensus/validator_trust score spread.
function normalizeScoreDistribution(raw: unknown): ScoreDistribution | undefined {
  if (!isRecord(raw)) return undefined;
  const nullableNum = (v: unknown): number | null => coerceFiniteNumber(v) ?? null;
  return {
    count: coerceFiniteNumber(raw.count),
    mean: nullableNum(raw.mean),
    min: nullableNum(raw.min),
    max: nullableNum(raw.max),
    p10: nullableNum(raw.p10),
    p25: nullableNum(raw.p25),
    p50: nullableNum(raw.p50),
    p75: nullableNum(raw.p75),
    p90: nullableNum(raw.p90),
  };
}

function normalizeSubnetPerformance(netuid: number, raw: unknown): SubnetPerformance {
  const d = isRecord(raw) ? raw : {};
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    neuron_count: coerceFiniteNumber(d.neuron_count),
    active_count: coerceFiniteNumber(d.active_count),
    validator_count: coerceFiniteNumber(d.validator_count),
    captured_at: coerceString(d.captured_at),
    incentive: normalizeConcentrationMetrics(d.incentive),
    dividends: normalizeConcentrationMetrics(d.dividends),
    trust: normalizeScoreDistribution(d.trust),
    consensus: normalizeScoreDistribution(d.consensus),
    validator_trust: normalizeScoreDistribution(d.validator_trust),
  };
}

function normalizePerformanceHistoryPoint(raw: unknown): PerformanceHistoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const snapshotDate = coerceString(raw.snapshot_date);
  if (!snapshotDate) return undefined;
  // Nullable-by-design: the early window has no reward metrics yet — keep null
  // (not undefined) so the chart can render a gap rather than dropping the day.
  const nullableNum = (v: unknown): number | null => coerceFiniteNumber(v) ?? null;
  return {
    ...(raw as object),
    snapshot_date: snapshotDate,
    neuron_count: coerceFiniteNumber(raw.neuron_count),
    active_count: coerceFiniteNumber(raw.active_count),
    validator_count: coerceFiniteNumber(raw.validator_count),
    incentive_gini: nullableNum(raw.incentive_gini),
    incentive_nakamoto_coefficient: nullableNum(raw.incentive_nakamoto_coefficient),
    incentive_top_10pct_share: nullableNum(raw.incentive_top_10pct_share),
    dividends_gini: nullableNum(raw.dividends_gini),
    dividends_nakamoto_coefficient: nullableNum(raw.dividends_nakamoto_coefficient),
    dividends_top_10pct_share: nullableNum(raw.dividends_top_10pct_share),
    trust_mean: nullableNum(raw.trust_mean),
    trust_median: nullableNum(raw.trust_median),
    consensus_mean: nullableNum(raw.consensus_mean),
    consensus_median: nullableNum(raw.consensus_median),
    validator_trust_mean: nullableNum(raw.validator_trust_mean),
    validator_trust_median: nullableNum(raw.validator_trust_median),
  };
}

function normalizeSubnetPerformanceHistory(netuid: number, raw: unknown): SubnetPerformanceHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizePerformanceHistoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    window: coerceString(d.window),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
  };
}

/** Reward-distribution scorecard (incentive/dividends concentration + trust/consensus spread). */
export const subnetPerformanceQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-performance", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetPerformance>>(
        `/api/v1/subnets/${netuid}/performance`,
        { signal },
      );
      return {
        data: normalizeSubnetPerformance(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetPerformance>;
    },
    staleTime: STALE_MED,
  });

/** Daily reward-flow drift (incentive/dividends Gini/Nakamoto/top-10%, trust/consensus mean/median). */
export const subnetPerformanceHistoryQuery = (
  netuid: number,
  window: "7d" | "30d" | "90d" = "30d",
) =>
  queryOptions({
    queryKey: k("subnet-performance-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetPerformanceHistory>>(
        `/api/v1/subnets/${netuid}/performance/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetPerformanceHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetPerformanceHistory>;
    },
    staleTime: STALE_MED,
  });

// #3478: per-UID emission yield (emission/stake return) for one subnet — the
// return-rate twin of /concentration + /performance. A distribution summary
// (subnet aggregate, mean, p25/median/p75/p90), a validator/miner split, and the
// per-UID ranked rows, plus the daily distribution trend from /yield/history.
function normalizeSubnetYieldNeuron(raw: unknown): SubnetYieldNeuron | undefined {
  if (!isRecord(raw)) return undefined;
  const uid = coerceFiniteNumber(raw.uid);
  if (uid == null) return undefined;
  const vs = raw.vs_median;
  return {
    uid,
    hotkey: coerceString(raw.hotkey) ?? null,
    role: raw.role === "validator" ? "validator" : "miner",
    stake_tao: coerceFiniteNumber(raw.stake_tao) ?? 0,
    emission_tao: coerceFiniteNumber(raw.emission_tao) ?? 0,
    yield: coerceFiniteNumber(raw.yield) ?? null,
    vs_median: vs === "above" || vs === "below" || vs === "at" ? vs : null,
  };
}

function normalizeSubnetYield(netuid: number, raw: unknown): SubnetYield {
  const d = isRecord(raw) ? raw : {};
  const nullableNum = (v: unknown): number | null => coerceFiniteNumber(v) ?? null;
  const neurons = Array.isArray(d.neurons)
    ? d.neurons.slice(0, MAX_NEURON_ROWS).flatMap((n) => {
        const normalized = normalizeSubnetYieldNeuron(n);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    captured_at: coerceString(d.captured_at),
    block_number: coerceFiniteNumber(d.block_number),
    neuron_count: coerceFiniteNumber(d.neuron_count) ?? neurons.length,
    validator_count: coerceFiniteNumber(d.validator_count),
    miner_count: coerceFiniteNumber(d.miner_count),
    total_stake_tao: coerceFiniteNumber(d.total_stake_tao),
    total_emission_tao: coerceFiniteNumber(d.total_emission_tao),
    subnet_yield: nullableNum(d.subnet_yield),
    mean_yield: nullableNum(d.mean_yield),
    median_yield: nullableNum(d.median_yield),
    p25_yield: nullableNum(d.p25_yield),
    p75_yield: nullableNum(d.p75_yield),
    p90_yield: nullableNum(d.p90_yield),
    neurons,
  };
}

function normalizeYieldHistoryPoint(raw: unknown): YieldHistoryPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const snapshotDate = coerceString(raw.snapshot_date);
  if (!snapshotDate) return undefined;
  const nullableNum = (v: unknown): number | null => coerceFiniteNumber(v) ?? null;
  return {
    ...(raw as object),
    snapshot_date: snapshotDate,
    neuron_count: coerceFiniteNumber(raw.neuron_count),
    validator_count: coerceFiniteNumber(raw.validator_count),
    yield_count: coerceFiniteNumber(raw.yield_count),
    subnet_yield: nullableNum(raw.subnet_yield),
    mean_yield: nullableNum(raw.mean_yield),
    median_yield: nullableNum(raw.median_yield),
    p25_yield: nullableNum(raw.p25_yield),
    p75_yield: nullableNum(raw.p75_yield),
    p90_yield: nullableNum(raw.p90_yield),
  };
}

function normalizeSubnetYieldHistory(netuid: number, raw: unknown): SubnetYieldHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizeYieldHistoryPoint(point);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    window: coerceString(d.window),
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    points,
  };
}

/** Per-UID emission-yield snapshot (distribution summary, validator/miner split, ranked rows). */
export const subnetYieldQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-yield", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetYield>>(`/api/v1/subnets/${netuid}/yield`, {
        signal,
      });
      return {
        data: normalizeSubnetYield(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetYield>;
    },
    staleTime: STALE_MED,
  });

/** Daily emission-yield distribution drift (subnet/mean/median/percentile yields). */
export const subnetYieldHistoryQuery = (netuid: number, window: "7d" | "30d" | "90d" = "30d") =>
  queryOptions({
    queryKey: k("subnet-yield-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetYieldHistory>>(
        `/api/v1/subnets/${netuid}/yield/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetYieldHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetYieldHistory>;
    },
    staleTime: STALE_MED,
  });

function normalizeCompareSubnet(raw: unknown): CompareSubnet | undefined {
  if (!isRecord(raw)) return undefined;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return undefined;

  const structure = isRecord(raw.structure)
    ? {
        completeness_score: optionalNumber(raw.structure.completeness_score),
        surface_count: optionalNumber(raw.structure.surface_count),
        operational_interface_count: optionalNumber(raw.structure.operational_interface_count),
      }
    : undefined;

  const economics = isRecord(raw.economics)
    ? {
        ...raw.economics,
        registration_cost_tao: optionalNumber(raw.economics.registration_cost_tao),
        registration_allowed: booleanValue(raw.economics.registration_allowed),
        open_slots: optionalNumber(raw.economics.open_slots),
        emission_share: optionalNumber(raw.economics.emission_share),
        alpha_price_tao: optionalNumber(raw.economics.alpha_price_tao),
        validator_count: optionalNumber(raw.economics.validator_count),
        miner_count: optionalNumber(raw.economics.miner_count),
        total_stake_tao: optionalNumber(raw.economics.total_stake_tao),
        miner_readiness: optionalNumber(raw.economics.miner_readiness),
      }
    : undefined;

  const health = isRecord(raw.health)
    ? {
        surface_count: optionalNumber(raw.health.surface_count),
        ok_count: optionalNumber(raw.health.ok_count),
        avg_latency_ms: optionalNumber(raw.health.avg_latency_ms),
      }
    : undefined;

  return {
    netuid,
    name: optionalString(raw.name),
    slug: optionalString(raw.slug),
    found: raw.found === true,
    structure,
    economics,
    health,
  };
}

export function normalizeCompare(raw: unknown): Compare {
  const d = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(d.subnets)
    ? d.subnets.flatMap((subnet) => {
        const normalized = normalizeCompareSubnet(subnet);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    dimensions: Array.isArray(d.dimensions)
      ? d.dimensions.filter((v): v is string => typeof v === "string")
      : [],
    requested_netuids: Array.isArray(d.requested_netuids)
      ? d.requested_netuids.filter((v): v is number => typeof v === "number")
      : [],
    subnets,
    observed_at: optionalString(d.observed_at),
    source: optionalString(d.source),
  };
}

/**
 * Composed side-by-side comparison for up to 128 netuids in one request. Fuses
 * registry structure + on-chain economics + live probe health per subnet, so the
 * compare drawer can render its grid from a single call instead of fanning out a
 * profile + health request per selected netuid.
 */
export const compareQuery = (netuids: number[]) =>
  queryOptions({
    queryKey: k(
      "compare",
      [...netuids].sort((a, b) => a - b),
    ),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/compare", {
        params: { netuids: netuids.join(",") },
        signal,
      });
      return { data: normalizeCompare(res.data), meta: res.meta, url: res.url };
    },
    enabled: netuids.length > 0,
    staleTime: STALE_SHORT,
  });

// #1124 port: per-window health trends. NB the live API returns each window as an
// aggregate snapshot with a per-surface breakdown (`surfaces[]`), not a `points[]`
// series — consumers wanting a daily time-series should use subnetUptimeQuery instead.
export const subnetHealthTrendsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-health-trends", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ windows?: unknown }>(`/api/v1/subnets/${netuid}/health/trends`, {
        signal,
      });
      return { data: normalizeHealthTrends(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function normalizeHealthTrendLatency(raw: unknown): HealthTrendSurface["latency_ms"] {
  if (!isRecord(raw)) return undefined;
  return {
    p50: optionalNumber(raw.p50),
    p95: optionalNumber(raw.p95),
    p99: optionalNumber(raw.p99),
  };
}

function normalizeHealthTrendSurface(raw: unknown): HealthTrendSurface | undefined {
  if (!isRecord(raw)) return undefined;
  const surfaceId = coerceString(raw.surface_id);
  if (!surfaceId) return undefined;

  return {
    ...(raw as object),
    surface_id: surfaceId,
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    avg_latency_ms: optionalNumber(raw.avg_latency_ms),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
    latency_ms: normalizeHealthTrendLatency(raw.latency_ms),
  };
}

function normalizeHealthTrendWindow(raw: unknown): HealthTrendWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.slice(0, MAX_HEALTH_TREND_SURFACES).flatMap((surface) => {
        const normalized = normalizeHealthTrendSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    ...(raw as object),
    samples: optionalNumber(raw.samples),
    uptime_ratio: optionalNumber(raw.uptime_ratio),
    latency_sample_count: optionalNumber(raw.latency_sample_count),
    surfaces,
  };
}

function normalizeHealthTrends(raw: unknown): HealthTrends {
  const d = isRecord(raw) ? raw : {};
  const windows = isRecord(d.windows)
    ? Object.fromEntries(
        Object.entries(d.windows).flatMap(([range, window]) => {
          const normalized = normalizeHealthTrendWindow(window);
          return normalized ? [[range, normalized]] : [];
        }),
      )
    : {};
  return { windows };
}

export function sortedHealthTrendSurfaces(window: HealthTrendWindow | undefined) {
  const surfaces = Array.isArray(window?.surfaces)
    ? window.surfaces.slice(0, MAX_HEALTH_TREND_SURFACES).flatMap((surface) => {
        const normalized = normalizeHealthTrendSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return surfaces.sort((a, b) => (a.uptime_ratio ?? 1) - (b.uptime_ratio ?? 1));
}

/**
 * Extract honest per-surface distribution series from a health-trends window.
 *
 * The window has no time dimension — it is an aggregate snapshot with a
 * per-surface breakdown — so these are distributions ACROSS surfaces (worst
 * uptime first), not time-series. Use them for spread sparklines, never for a
 * "trend over time". Returns empty arrays when the window has no surfaces.
 */
export function trendSurfaceSeries(window: HealthTrendWindow | undefined): {
  uptimePct: number[];
  p50: number[];
  p95: number[];
} {
  const surfaces = sortedHealthTrendSurfaces(window);
  const finite = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v);
  return {
    uptimePct: surfaces
      .map((s) => (finite(s.uptime_ratio) ? s.uptime_ratio * 100 : null))
      .filter((v): v is number => v != null),
    p50: surfaces
      .map((s) => (finite(s.latency_ms?.p50) ? s.latency_ms!.p50! : (s.avg_latency_ms ?? null)))
      .filter((v): v is number => v != null && Number.isFinite(v)),
    p95: surfaces.map((s) => s.latency_ms?.p95).filter((v): v is number => finite(v)),
  };
}

// Candidate rows carry `review_notes` (not `notes`) and a nested
// `verification.verified_at` (no top-level `discovered_at`).
function normalizeCandidate(raw: unknown): Candidate {
  if (!raw || typeof raw !== "object") return raw as Candidate;
  const c = raw as Record<string, unknown>;
  const verification = (c.verification as Record<string, unknown> | undefined) ?? {};
  return {
    ...(c as object),
    notes: (c.notes as string) ?? (c.review_notes as string),
    discovered_at:
      (c.discovered_at as string) ??
      (verification.verified_at as string) ??
      (c.observed_at as string),
  } as Candidate;
}

export const subnetCandidatesQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-candidates", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/subnets/${netuid}/candidates`,
        "candidates",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeCandidate) } as ApiResult<Candidate[]>;
    },
    staleTime: STALE_LONG,
  });

/**
 * Strict next-cursor extractor. The API has historically returned cursors as
 * strings or numbers; defend against bad shapes (objects, booleans, NaN,
 * empty strings) and against echoes of the cursor we just sent (a common
 * server bug that would cause an infinite "load more" loop).
 *
 * Returns:
 *   { cursor: string } — valid, fetch can continue
 *   { cursor: null }   — explicit end of list
 *   { invalid: true }  — API returned something but we can't trust it
 */
export function validateNextCursor(
  meta: ApiResult<unknown>["meta"],
  sentCursor: string | undefined,
): { cursor: string | null; invalid?: boolean } {
  const p = (meta?.pagination ?? {}) as { next_cursor?: unknown };
  const raw = p.next_cursor ?? (meta as Record<string, unknown> | undefined)?.next_cursor;
  if (raw === undefined || raw === null) return { cursor: null };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { cursor: null };
    if (sentCursor && trimmed === sentCursor) {
      if (import.meta.env?.DEV)
        console.warn("[metagraphed] next_cursor echoes sent cursor; stopping pagination");
      return { cursor: null, invalid: true };
    }
    return { cursor: trimmed };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const s = String(raw);
    if (sentCursor && s === sentCursor) return { cursor: null, invalid: true };
    return { cursor: s };
  }
  if (import.meta.env?.DEV) console.warn("[metagraphed] next_cursor has unexpected shape:", raw);
  return { cursor: null, invalid: true };
}

/** Pages on the infinite query carry the validation flag for the UI. */
type InfinitePage<T> = ApiResult<T[]> & { cursorInvalid?: boolean };

async function fetchInfinitePage<T>(
  path: string,
  key: string,
  baseParams: QueryParams,
  pageParam: string,
  signal?: AbortSignal,
): Promise<InfinitePage<T>> {
  const params: QueryParams = { ...baseParams };
  if (pageParam) params.cursor = pageParam;
  const res = await fetchList<T>(path, key, params, signal);
  const v = validateNextCursor(res.meta, pageParam || undefined);
  // Stash the validated cursor in meta so getNextPageParam can read it
  // without re-running validation.
  const meta = { ...(res.meta ?? {}), _next_cursor: v.cursor };
  return { ...res, meta, cursorInvalid: v.invalid };
}

/** Read the validated next cursor stashed on infinite-list meta by fetchInfinitePage. */
export function getNextPageParam(last: { meta?: Record<string, unknown> }): string | undefined {
  const nc = last.meta?._next_cursor as string | null | undefined;
  return nc ?? undefined;
}

function validateFeedNextCursor(
  nextCursor: string | null | undefined,
  sentCursor: string | undefined,
): { cursor: string | null; invalid?: boolean } {
  if (nextCursor === undefined || nextCursor === null) return { cursor: null };
  const trimmed = nextCursor.trim();
  if (!trimmed) return { cursor: null };
  if (sentCursor && trimmed === sentCursor) {
    if (import.meta.env?.DEV)
      console.warn("[metagraphed] next_cursor echoes sent cursor; stopping pagination");
    return { cursor: null, invalid: true };
  }
  return { cursor: trimmed };
}

async function fetchChainEventsInfinitePage(
  baseParams: QueryParams,
  pageParam: string,
  signal?: AbortSignal,
): Promise<InfinitePage<ChainEvent>> {
  const params: QueryParams = { ...baseParams, limit: baseParams.limit ?? 50 };
  if (pageParam) params.cursor = pageParam;
  const res = await apiFetch<unknown>("/api/v1/chain-events", { params, signal });
  const feed = normalizeChainEventsFeed(res.data);
  const v = validateFeedNextCursor(feed.next_cursor, pageParam || undefined);
  const meta = { ...(res.meta ?? {}), _next_cursor: v.cursor };
  return { data: feed.events, meta, url: res.url, cursorInvalid: v.invalid };
}

/** Cursor-paginated all-events feed — newest block/event first. */
export const chainEventsInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
  infiniteQueryOptions({
    queryKey: k("chain-events-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) =>
      fetchChainEventsInfinitePage(baseParams, pageParam as string, signal),
    getNextPageParam,
    staleTime: STALE_SHORT,
  });

/** Alias for {@link chainEventsInfiniteQuery} — raw /api/v1/chain-events paginator. */
export const chainEventsQuery = chainEventsInfiniteQuery;

/** Server-driven cursor-paginated subnets. */
export const subnetsInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
  infiniteQueryOptions({
    queryKey: k("subnets-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchInfinitePage<unknown>(
        "/api/v1/subnets",
        "subnets",
        baseParams,
        pageParam as string,
        signal,
      );
      return { ...page, data: page.data.map(normalizeSubnet) } as typeof page;
    },
    getNextPageParam,
    staleTime: STALE_MED,
  });

/** Server-driven cursor-paginated surfaces. */
export const surfacesInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
  infiniteQueryOptions({
    queryKey: k("surfaces-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchInfinitePage<unknown>(
        "/api/v1/surfaces",
        "surfaces",
        baseParams,
        pageParam as string,
        signal,
      );
      // Normalize on the infinite-query path so provider_slug, curation_level
      // (from authority), provider, last_verified_at, and the provider filter
      // are populated — same mapping the non-paginated surfacesQuery applies.
      return { ...page, data: page.data.map(normalizeSurface) } as InfinitePage<Surface>;
    },
    getNextPageParam,
    staleTime: STALE_MED,
  });

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return undefined;
}

/**
 * Presentation adapter for the canonical contract health enum
 * ({@link HealthStatus} = `ok | degraded | failed | unknown`) → the UI's 4-state
 * {@link HealthState} (`ok | warn | down | unknown`). This is the single, tested
 * place the two enums are reconciled (degraded→warn, failed→down): #1758.
 *
 * `satisfies` ties the mapping table to the contract enum, so adding a backend
 * HealthStatus member becomes a compile error here (the unit test additionally
 * asserts every member is covered).
 */
const HEALTH_STATUS_TO_STATE = {
  ok: "ok",
  degraded: "warn",
  failed: "down",
  unknown: "unknown",
} satisfies Record<HealthStatus, HealthState>;

export function healthStatusToState(status: HealthStatus): HealthState {
  return HEALTH_STATUS_TO_STATE[status];
}

/**
 * Tolerant variant for raw, untyped API payloads: maps the canonical enum via
 * {@link healthStatusToState}, plus a few non-contract classification/legacy
 * strings the older endpoints still emit. Returns undefined for non-strings so
 * callers can fall through to a default.
 */
export function statusToHealth(v: unknown): HealthState | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "ok" || v === "degraded" || v === "failed" || v === "unknown") {
    return healthStatusToState(v);
  }
  // Non-canonical strings (live-probe classifications + already-mapped UI states)
  // some legacy responses still carry.
  if (v === "live") return "ok";
  if (v === "warn" || v === "redirected" || v === "transient") return "warn";
  if (v === "down" || v === "unsupported") return "down";
  return "unknown";
}

function normalizeEndpoint(raw: unknown): Endpoint {
  if (!raw || typeof raw !== "object") return raw as Endpoint;
  const e = raw as Record<string, unknown>;
  return {
    ...(e as object),
    id: asString(e.id) ?? "",
    health: (e.health as HealthState) ?? statusToHealth(e.status) ?? "unknown",
    provider_slug: asString(e.provider_slug) ?? asString(e.provider) ?? asString(e.operator),
    archive:
      (e.archive as boolean | undefined) ??
      (e.archive_support as boolean | undefined) ??
      (e.archive_capable as boolean | undefined),
    last_probed_at:
      asString(e.last_probed_at) ?? asString(e.last_checked) ?? asString(e.observed_at),
  } as Endpoint;
}

function normalizeSurface(raw: unknown): Surface {
  if (!raw || typeof raw !== "object") return raw as Surface;
  const s = raw as Record<string, unknown>;
  return {
    ...(s as object),
    // Per-surface payloads carry `authority` (official | registry-observed |
    // community | native-chain) — the real trust signal — but not curation_level.
    // Surface it as the chip level so surfaces don't all read "candidate-discovered".
    curation_level: (s.curation_level as CurationLevel) ?? (s.authority as CurationLevel),
    provider_slug: (s.provider_slug as string) ?? (s.provider as string),
  } as Surface;
}

function isHealthState(v: unknown): v is HealthState {
  return v === "ok" || v === "warn" || v === "down" || v === "unknown";
}

function normalizeIncident(raw: unknown): EndpointIncident {
  if (!raw || typeof raw !== "object") return raw as EndpointIncident;
  const i = raw as Record<string, unknown>;
  // API uses lifecycle state="active|resolved" and a separate
  // status="failed|degraded|ok". Some responses already use the frontend
  // contract state="ok|warn|down|unknown", so preserve those health states.
  const sev = i.severity as string | undefined;
  const sevHealth: HealthState | undefined =
    sev === "critical" ? "down" : sev === "warning" ? "warn" : undefined;
  const stateHealth =
    statusToHealth(i.status) ??
    sevHealth ??
    (isHealthState(i.state) ? i.state : undefined) ??
    "unknown";
  const ended = i.state === "resolved" || i.resolved_at;
  return {
    ...(i as object),
    id: asString(i.id) ?? "",
    endpoint_id: asString(i.endpoint_id),
    state: stateHealth,
    message: asString(i.message) ?? asString(i.reason),
    started_at: asString(i.started_at) ?? asString(i.detected_at) ?? asString(i.observed_at),
    ended_at:
      asString(i.ended_at) ?? asString(i.resolved_at) ?? (ended ? asString(i.last_checked) : null),
  } as EndpointIncident;
}

export const endpointsQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("endpoints", params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/endpoints", "endpoints", params, signal);
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

// Pool rows are { id, kind, endpoint_count, eligible_count, best_endpoint_id,
// endpoints[] }; the pools table reads name/members_count/proxy_enabled/
// archive_capable. Derive those from the real fields (region is not modelled,
// stays "—"). archive_capable = any member endpoint supports archive; a pool is
// proxy-eligible when it has eligible endpoints.
function normalizePool(raw: unknown): RpcPool {
  if (!raw || typeof raw !== "object") return raw as RpcPool;
  const p = raw as Record<string, unknown>;
  const endpoints = Array.isArray(p.endpoints) ? p.endpoints.filter(isRecord) : [];
  return {
    ...(p as object),
    id: asString(p.id) ?? "",
    name: asString(p.name) ?? asString(p.id) ?? asString(p.kind),
    members_count: (p.members_count as number) ?? (p.endpoint_count as number) ?? endpoints.length,
    proxy_enabled:
      (p.proxy_enabled as boolean) ??
      (typeof p.eligible_count === "number" && (p.eligible_count as number) > 0),
    archive_capable:
      (p.archive_capable as boolean) ?? endpoints.some((e) => e.archive_support === true),
  } as RpcPool;
}

export const rpcPoolsQuery = () =>
  queryOptions({
    queryKey: k("rpc-pools"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/rpc/pools", "pools", undefined, signal);
      return { ...res, data: res.data.map(normalizePool) } as ApiResult<RpcPool[]>;
    },
    staleTime: STALE_MED,
  });

function normalizeRpcEndpoint(raw: unknown): RpcEndpoint | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id);
  if (!id) return undefined;
  return { ...(raw as object), id } as RpcEndpoint;
}

function normalizeRpcEndpointsSummary(raw: unknown): RpcEndpointsSummary | null {
  return isRecord(raw) ? (raw as RpcEndpointsSummary) : null;
}

// /api/v1/rpc/endpoints — the base-layer Subtensor RPC/WSS registry
// (RpcEndpointsArtifact: a summary rollup alongside the endpoint list).
// Unlike the other `fetchList`-based queries on this page, this artifact's
// `summary` sibling field would be silently dropped by `fetchList` (which
// only extracts the keyed array) — verified live: `summary` lives in the
// artifact body next to `endpoints`, not in the response envelope's `meta`
// (only `generated_at` round-trips through `meta`, matching `rpcPoolsQuery`'s
// `data.meta?.generated_at` freshness read). So this unwraps the keyed
// object itself, mirroring `fetchList`'s own array-extraction, to keep both.
export const rpcEndpointsQuery = () =>
  queryOptions({
    queryKey: k("rpc-endpoints"),
    queryFn: async ({ signal }): Promise<ApiResult<RpcEndpointsData>> => {
      const res = await apiFetch<unknown>("/api/v1/rpc/endpoints", { signal });
      const body = isRecord(res.data) ? res.data : {};
      const endpoints = Array.isArray(body.endpoints)
        ? body.endpoints.map(normalizeRpcEndpoint).filter((e): e is RpcEndpoint => e != null)
        : [];
      const summary = normalizeRpcEndpointsSummary(body.summary);
      return { ...res, data: { endpoints, summary } };
    },
    staleTime: STALE_MED,
  });

// /api/v1/rpc/usage returns a single analytics object (not a list), like the
// global incident ledger. Cold/unmigrated D1 already yields a schema-stable
// zeroed payload server-side; this normaliser just hardens against missing
// fields so a partial response can't crash the proxy panel.
function normalizeRpcUsage(raw: unknown): RpcUsage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (r.summary && typeof r.summary === "object" ? r.summary : {}) as Record<
    string,
    unknown
  >;
  const lat = (s.latency_ms && typeof s.latency_ms === "object" ? s.latency_ms : {}) as Record<
    string,
    unknown
  >;
  return {
    window: (r.window as string | null) ?? null,
    observed_at: (r.observed_at as string | null) ?? null,
    source: (r.source as string) ?? "rpc-proxy",
    summary: {
      total_requests: finiteNumber(s.total_requests),
      ok_requests: finiteNumber(s.ok_requests),
      error_requests: finiteNumber(s.error_requests),
      error_rate: finiteOptionalNumber(s.error_rate) ?? null,
      failover_requests: finiteNumber(s.failover_requests),
      failover_rate: finiteOptionalNumber(s.failover_rate) ?? null,
      cache_hits: finiteNumber(s.cache_hits),
      cache_hit_rate: finiteOptionalNumber(s.cache_hit_rate) ?? null,
      latency_ms: {
        p50: finiteOptionalNumber(lat.p50) ?? null,
        p95: finiteOptionalNumber(lat.p95) ?? null,
        avg: finiteOptionalNumber(lat.avg) ?? null,
      },
    },
    endpoints: Array.isArray(r.endpoints)
      ? r.endpoints.flatMap((endpoint, index) => {
          const normalized = normalizeRpcUsageEndpoint(endpoint, index);
          return normalized ? [normalized] : [];
        })
      : [],
    networks: Array.isArray(r.networks)
      ? r.networks.flatMap((network) => {
          const normalized = normalizeRpcUsageNetwork(network);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function normalizeRpcUsageEndpoint(
  raw: unknown,
  index: number,
): RpcUsage["endpoints"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  return {
    rank: finiteNumber(e.rank, index + 1),
    endpoint_id: typeof e.endpoint_id === "string" ? e.endpoint_id : null,
    provider: typeof e.provider === "string" ? e.provider : null,
    requests: finiteNumber(e.requests),
    ok_requests: finiteNumber(e.ok_requests),
    error_rate: finiteOptionalNumber(e.error_rate) ?? null,
    avg_latency_ms: finiteOptionalNumber(e.avg_latency_ms) ?? null,
  };
}

function normalizeRpcUsageNetwork(raw: unknown): RpcUsage["networks"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const n = raw as Record<string, unknown>;
  const network = typeof n.network === "string" ? n.network : "unknown";
  return {
    network,
    requests: finiteNumber(n.requests),
    ok_requests: finiteNumber(n.ok_requests),
    error_rate: finiteOptionalNumber(n.error_rate) ?? null,
  };
}

export const rpcUsageQuery = (window = "7d") =>
  queryOptions({
    queryKey: k("rpc-usage", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/rpc/usage", { params: { window }, signal });
      return { ...res, data: normalizeRpcUsage(res.data) } as ApiResult<RpcUsage>;
    },
    staleTime: STALE_SHORT,
  });

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const AGENT_RESOURCE_KINDS = new Set(["agent", "skill", "index", "contract", "api", "data"]);

function normalizeAgentResource(raw: unknown, index: number): AgentResource | undefined {
  const r = recordValue(raw);
  const id = stringValue(r.id, `resource-${index}`);
  const title = stringValue(r.title);
  const url = stringValue(r.url);
  if (!title || !url) return undefined;

  const kind = stringValue(r.kind);
  return {
    id,
    kind: AGENT_RESOURCE_KINDS.has(kind) ? kind : "api",
    title,
    url,
  };
}

function normalizeAgentResources(raw: unknown): AgentResources {
  const d = recordValue(raw);
  const copyableAgent = recordValue(d.copyable_agent);
  const mcp = recordValue(d.mcp);
  const summary = recordValue(d.summary);
  const tools = Array.isArray(mcp.tools)
    ? mcp.tools
        .map((tool) => {
          const t = recordValue(tool);
          return { name: stringValue(t.name), title: stringValue(t.title) || undefined };
        })
        .filter((tool) => tool.name)
    : [];
  const resources = Array.isArray(d.resources)
    ? d.resources.flatMap((resource, index) => {
        const normalized = normalizeAgentResource(resource, index);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    generated_at: stringValue(d.generated_at) || null,
    published_at: stringValue(d.published_at) || null,
    copyable_agent: {
      title: stringValue(copyableAgent.title),
      description: stringValue(copyableAgent.description),
      url: stringValue(copyableAgent.url),
    },
    mcp: {
      endpoint: stringValue(mcp.endpoint),
      install: stringValue(mcp.install),
      server_card: stringValue(mcp.server_card),
      transport: stringValue(mcp.transport, "MCP"),
      tools,
    },
    summary: {
      callable_service_count: finiteNumber(summary.callable_service_count),
      subnet_count: finiteNumber(summary.subnet_count),
    },
    resources,
  };
}

// /api/v1/agent-resources — the machine-readable index of every AI surface
// (MCP, agent.md, llms.txt, openapi, catalog, datasets, …). Single object.
export const agentResourcesQuery = () =>
  queryOptions({
    queryKey: k("agent-resources"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/agent-resources", { signal });
      return { ...res, data: normalizeAgentResources(res.data) } as ApiResult<AgentResources>;
    },
    staleTime: STALE_MED,
  });

// POST /api/v1/ask — grounded Q&A over the registry. User-triggered on submit,
// not a passive fetch-on-mount GET, so this is a plain typed helper for a
// component's own useMutation to call (see ask-box.tsx), not a
// queryOptions/useSuspenseQuery pair — matching the verify-surface-button.tsx
// imperative-POST precedent.
export async function askQuestion(question: string, signal?: AbortSignal): Promise<AskAnswerData> {
  const res = await apiFetch<AskAnswerData>("/api/v1/ask", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    },
    signal,
  });
  return res.data;
}

export const endpointIncidentsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-incidents"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        "/api/v1/endpoint-incidents",
        "incidents",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeIncident) } as ApiResult<EndpointIncident[]>;
    },
    staleTime: STALE_SHORT,
  });

/**
 * Global, cross-subnet incident ledger (/api/v1/incidents) — recent downtime
 * reconstructed from probe history, grouped by surface, over a 7d/30d window.
 * Broader than endpoint-incidents (which is RPC-only); powers the /status page.
 */
export const globalIncidentsQuery = (window: string) =>
  queryOptions({
    queryKey: k("incidents", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/incidents", { params: { window }, signal });
      return { ...res, data: normalizeGlobalIncidents(res.data) } as ApiResult<GlobalIncidents>;
    },
    staleTime: STALE_SHORT,
  });

/**
 * Incidents JSON Feed (/api/v1/feeds/incidents.json) — machine-readable
 * subscription stream for probe-detected downtime across subnet surfaces.
 */
export const incidentsFeedQuery = () =>
  queryOptions({
    queryKey: k("feeds", "incidents"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/feeds/incidents.json", { signal });
      return { ...res, data: normalizeIncidentsFeed(res.data) } as ApiResult<IncidentsFeed>;
    },
    staleTime: STALE_MED,
  });

function normalizeFeedItem(raw: unknown): FeedItem | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!r) return undefined;
  const id = pickStr(r.id);
  if (!id) return undefined;
  const tags = Array.isArray(r.tags)
    ? r.tags.flatMap((tag) => {
        const s = pickStr(tag);
        return s ? [s] : [];
      })
    : [];
  return {
    id,
    url: pickStr(r.url),
    title: pickStr(r.title),
    content_text: pickStr(r.content_text),
    date_published: pickStr(r.date_published) ?? null,
    tags: tags.length > 0 ? tags : undefined,
  };
}

function normalizeIncidentsFeed(raw: unknown): IncidentsFeed {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(r.items)
    ? r.items.flatMap((item) => {
        const normalized = normalizeFeedItem(item);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    version: pickStr(r.version),
    title: pickStr(r.title),
    home_page_url: pickStr(r.home_page_url),
    feed_url: pickStr(r.feed_url),
    description: pickStr(r.description),
    items,
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteEpochMs(value: unknown): number | undefined {
  const n = finiteNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return undefined;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : undefined;
}

function normalizeGlobalIncident(raw: unknown): GlobalIncident | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!r) return undefined;
  const started_at = finiteEpochMs(r.started_at) ?? 0;
  const ended_at = finiteEpochMs(r.ended_at) ?? 0;
  return {
    started_at,
    ended_at,
    duration_ms: finiteNumber(r.duration_ms),
    failed_samples: finiteOptionalNumber(r.failed_samples),
  };
}

function normalizeGlobalIncidentSurface(raw: unknown): GlobalIncidentSurface | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!r) return undefined;
  const incidents = Array.isArray(r.incidents)
    ? r.incidents.flatMap((incident) => {
        const normalized = normalizeGlobalIncident(incident);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: finiteNumber(r.netuid),
    surface_id: pickStr(r.surface_id) ?? "",
    incident_count: finiteNumber(r.incident_count, incidents.length),
    downtime_ms: finiteNumber(r.downtime_ms),
    incidents,
  };
}

function normalizeGlobalIncidents(raw: unknown): GlobalIncidents {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary =
    r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : {};
  const surfaces = Array.isArray(r.surfaces)
    ? r.surfaces.flatMap((surface) => {
        const normalized = normalizeGlobalIncidentSurface(surface);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    window: pickStr(r.window) ?? null,
    observed_at: pickStr(r.observed_at) ?? null,
    source: pickStr(r.source),
    summary: {
      incident_count: finiteNumber(summary.incident_count),
      affected_surface_count: finiteNumber(summary.affected_surface_count, surfaces.length),
    },
    surfaces,
  };
}

function normalizeProviderListItem(raw: unknown): Provider {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const slug = pickStr(r.slug, r.id) ?? "";
  const website = pickStr(r.website_url, r.website, r.homepage);
  const docs = pickStr(r.docs_url, r.docs);
  const repo = pickStr(r.github_url, r.repo, r.repository);
  return {
    ...r,
    slug,
    name: pickStr(r.name) ?? slug,
    kind: pickStr(r.kind),
    authority: pickStr(r.authority),
    homepage: website,
    website,
    docs,
    repo,
    // Curated/backfilled provider logo → BrandIcon's iconUrl (mirrors subnets).
    icon_url: (r.icon_url as Provider["icon_url"]) ?? (r.logo_url as string),
    notes: pickStr(r.notes, r.public_notes),
    // API returns snake_case singular (endpoint_count / surface_count / subnet_count).
    // Normalize to the plural _count fields used by all consumers.
    endpoints_count:
      (r.endpoint_count as number | undefined) ?? (r.endpoints_count as number | undefined),
    surfaces_count:
      (r.surface_count as number | undefined) ?? (r.surfaces_count as number | undefined),
    subnet_count: r.subnet_count as number | undefined,
  } as Provider;
}

export const providersQuery = () =>
  queryOptions({
    queryKey: k("providers"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/providers", "providers", undefined, signal);
      return { ...res, data: res.data.map(normalizeProviderListItem) } as ApiResult<Provider[]>;
    },
    staleTime: STALE_MED,
  });

/**
 * Per-provider tally of surfaces / endpoints / subnets, keyed by provider slug.
 * These counts ride along on each /api/v1/providers list row
 * (endpoint_count / surface_count / subnet_count, normalized to the *_count
 * fields by `normalizeProviderListItem`), so consumers derive this map from the
 * providers query itself rather than re-fetching the surfaces + endpoints
 * collections.
 */
export type ProviderCounts = {
  surfaces: number;
  endpoints: number;
  subnets: number;
};

export function normalizeProvider(raw: unknown, slug: string): Provider {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const inner = (root.provider as Record<string, unknown> | undefined) ?? root;
  const summary = (root.endpoint_summary as Record<string, unknown> | undefined) ?? undefined;
  const website = pickStr(inner.website_url, inner.homepage, inner.website);
  const docs = pickStr(inner.docs_url, inner.docs);
  return {
    // Spread raw fields FIRST so the normalized/computed fields below win on
    // collision (mirrors normalizeProviderListItem). Spreading `...inner` last
    // let raw nulls (e.g. name: null) clobber the slug fallback → blank names.
    ...inner,
    slug: (inner.id as string) ?? (inner.slug as string) ?? slug,
    name: pickStr(inner.name) ?? slug,
    kind: pickStr(inner.kind),
    authority: pickStr(inner.authority),
    homepage: website,
    website,
    docs,
    notes: pickStr(inner.notes),
    endpoint_summary: summary as ProviderEndpointSummary | undefined,
    // Normalize singular API field names (endpoint_count / surface_count) to
    // plural _count fields so all consumers use the same key regardless of
    // whether the data came from the list or detail endpoint.
    endpoints_count:
      (inner.endpoint_count as number | undefined) ??
      (summary?.endpoint_count as number | undefined),
    surfaces_count:
      (inner.surface_count as number | undefined) ?? (inner.surfaces_count as number | undefined),
    generated_at: pickStr(root.generated_at as string, inner.generated_at as string),
    icon_url: (inner.icon_url as Provider["icon_url"]) ?? (inner.logo_url as string),
  } as Provider;
}

export const providerQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider", slug),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/providers/${encodePathSegment(slug)}`, {
        signal,
      });
      return {
        data: normalizeProvider(res.data, slug),
        meta: res.meta,
        url: res.url,
      } as ApiResult<Provider>;
    },
    staleTime: STALE_MED,
  });

export const providerEndpointsQuery = (slug: string) =>
  queryOptions({
    queryKey: k("provider-endpoints", slug),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        `/api/v1/providers/${encodePathSegment(slug)}/endpoints`,
        "endpoints",
        undefined,
        signal,
      );
      return { ...res, data: res.data.map(normalizeEndpoint) } as ApiResult<Endpoint[]>;
    },
    staleTime: STALE_MED,
  });

// /api/v1/gaps returns per-subnet gap PROFILES
// ({ netuid, name, slug, coverage_level, curation_level, gaps: { missing_kinds,
// gap_notes, supported_kinds } }), not flat gap records. Reshape each subnet that
// has missing surface kinds into a single displayable gap card.
function stringArrayFromUnknown(value: unknown, limit?: number): string[] {
  if (!Array.isArray(value)) return [];
  const items = limit == null ? value : value.slice(0, limit);
  return items.flatMap((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    return [];
  });
}

const GAP_SEVERITY_MAP = {
  critical: "high",
  warning: "medium",
  info: "low",
} satisfies Record<string, Gap["severity"]>;

function gapSeverityFromUnknown(value: unknown, fallback: Gap["severity"]): Gap["severity"] {
  if (typeof value !== "string") return fallback;
  return Object.hasOwn(GAP_SEVERITY_MAP, value)
    ? GAP_SEVERITY_MAP[value as keyof typeof GAP_SEVERITY_MAP]
    : fallback;
}

export function normalizeGap(raw: unknown): Gap {
  const r = (raw ?? {}) as Record<string, unknown>;
  const g = (r.gaps as Record<string, unknown> | undefined) ?? {};
  const missing = stringArrayFromUnknown(g.missing_kinds);
  const notes = stringArrayFromUnknown(g.gap_notes);
  const netuid = r.netuid as number | undefined;
  const name = (r.name as string) ?? (netuid != null ? `SN${netuid}` : "subnet");
  const core = missing.filter((kind) => kind === "openapi" || kind === "subnet-api").length;
  const severityFallback: Gap["severity"] =
    core >= 1 && missing.length >= 3 ? "high" : missing.length >= 2 ? "medium" : "low";
  const severity = gapSeverityFromUnknown(r.gap_severity, severityFallback);
  return {
    id: (r.slug as string) ?? `gap-${netuid}`,
    netuid,
    category: (r.curation_level as string) ?? (r.coverage_level as string),
    severity,
    gap_priority: typeof r.gap_priority === "number" ? r.gap_priority : undefined,
    title: `${name} — ${missing.length} missing surface${missing.length === 1 ? "" : "s"}`,
    description: missing.length ? `Missing: ${missing.join(", ")}` : undefined,
    suggested_action: notes[0],
    // Preserve the raw arrays so consumers (e.g. the missing-kinds glance) can
    // bind to the real per-row missing kinds instead of parsing the description.
    missing_kinds: missing,
    gap_notes: notes,
  } as Gap;
}

export const gapsQuery = () =>
  queryOptions({
    queryKey: k("gaps"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/gaps", "gaps", undefined, signal);
      // Only surface subnets that actually have missing kinds.
      const rows = res.data.map(normalizeGap).filter((gap) => Boolean(gap.description));
      return { ...res, data: rows } as ApiResult<Gap[]>;
    },
    staleTime: STALE_LONG,
  });

export const reviewProfileCompletenessQuery = () =>
  queryOptions({
    queryKey: k("review-profile-completeness"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/profile-completeness",
        "profiles",
        undefined,
        signal,
      );
      // API exposes completeness_score (0-100); the UI bars expect a 0-1 ratio.
      const rows = res.data.map((r) => ({
        netuid: r.netuid as number,
        name: r.name as string | undefined,
        completeness:
          typeof r.completeness === "number"
            ? (r.completeness as number)
            : typeof r.completeness_score === "number"
              ? (r.completeness_score as number) / 100
              : undefined,
        missing: stringArrayFromUnknown(r.missing_required ?? r.gap_reasons),
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

export const reviewAdapterCandidatesQuery = () =>
  queryOptions({
    queryKey: k("review-adapter-candidates"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/adapter-candidates",
        "candidates",
        undefined,
        signal,
      );
      // API rows: { netuid, name, slug, suggested_next_action, priority_score,
      // recommended_adapter_kind, reason_codes, ... }. Map to the fields the UI
      // reads (reason/score); the historical reason/score keys are not present.
      const rows = res.data.map((r) => ({
        netuid: r.netuid as number | undefined,
        name: r.name as string | undefined,
        slug: r.slug as string | undefined,
        reason:
          (r.reason as string) ??
          (r.suggested_next_action as string) ??
          (r.recommended_adapter_kind as string),
        score:
          typeof r.score === "number"
            ? (r.score as number)
            : typeof r.priority_score === "number"
              ? (r.priority_score as number)
              : undefined,
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

export const reviewEnrichmentQueueQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-queue"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/enrichment-queue",
        "queue",
        undefined,
        signal,
      );
      // API rows: { name, slug, netuid, priority_score, contribution_hint, ... }.
      const rows = res.data.map((r) => ({
        id: (r.slug as string) ?? (r.name as string) ?? String(r.netuid ?? ""),
        netuid: r.netuid as number | undefined,
        priority:
          (r.priority as string) ??
          (typeof r.priority_score === "number"
            ? String(Math.round(r.priority_score as number))
            : undefined),
        note:
          (r.note as string) ?? (r.contribution_hint as string) ?? (r.recommended_action as string),
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

function normalizeSchema(raw: unknown): SchemaInfo {
  if (!raw || typeof raw !== "object") return raw as SchemaInfo;
  const s = raw as Record<string, unknown>;
  const snap = (s.snapshot as Record<string, unknown> | undefined) ?? {};
  const drift = normalizeDriftStatus(s.drift_status) ?? normalizeDriftStatus(snap.drift_status);
  return {
    ...(s as object),
    id:
      (s.id as string) ??
      (s.surface_id as string) ??
      `${(s.netuid as number) ?? "?"}-${(s.path as string) ?? (s.url as string) ?? "schema"}`,
    name: (snap.title as string) ?? (s.name as string) ?? (s.surface_id as string),
    url: (s.schema_url as string) ?? (s.url as string) ?? (s.surface_url as string),
    netuid: (s.netuid as number) ?? (snap.netuid as number),
    surface_id: (s.surface_id as string) ?? (snap.surface_id as string),
    drift_status: drift,
    // A "new" schema has no previous published version to diff against, so it is
    // a baseline, not drift — counting it as drift made every fresh snapshot read
    // as "drifting". It surfaces as its own state (drift_status === "new").
    drift: isSchemaDrift(drift),
    artifact_path: s.path as string | undefined,
    hash: typeof s.hash === "string" ? s.hash : undefined,
    previous_hash: typeof s.previous_hash === "string" ? s.previous_hash : undefined,
    status: s.status as string | undefined,
    updated_at:
      (s.observed_at as string) ??
      (snap.observed_at as string) ??
      (s.generated_at as string) ??
      (snap.generated_at as string),
  } as SchemaInfo;
}

export const schemasQuery = () =>
  queryOptions({
    queryKey: k("schemas"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/schemas", "schemas", undefined, signal);
      return { ...res, data: res.data.map(normalizeSchema) } as ApiResult<SchemaInfo[]>;
    },
    staleTime: STALE_MED,
  });

/**
 * Schemas filtered down to a single netuid. The profile envelope doesn't
 * currently expose schema drift, so we join against /api/v1/schemas here
 * until the upstream payload grows native drift fields.
 */
export const subnetSchemasQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-schemas", netuid),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/schemas", "schemas", undefined, signal);
      const all = res.data.map(normalizeSchema);
      const mine = all.filter((s) => s.netuid === netuid);
      return { ...res, data: mine } as ApiResult<SchemaInfo[]>;
    },
    staleTime: STALE_MED,
  });

export const contractsQuery = () =>
  queryOptions({
    queryKey: k("contracts"),
    queryFn: ({ signal }) =>
      // /api/v1/contracts nests the per-artifact contract metadata under
      // `data.artifacts` (each: id, description, path, content_type, storage_tier).
      fetchList<{
        id: string;
        description?: string;
        path?: string;
        content_type?: string;
        storage_tier?: string;
      }>("/api/v1/contracts", "artifacts", undefined, signal),
    staleTime: STALE_LONG,
  });

export const evidenceQuery = (params?: QueryParams) =>
  queryOptions({
    queryKey: k("evidence", params ?? {}),
    queryFn: ({ signal }) =>
      fetchList<EvidenceItem>("/api/v1/evidence", "evidence", params, signal),
    staleTime: STALE_LONG,
  });

export type SubnetGapsView = {
  netuid: number;
  missing_kinds: string[];
  gap_notes: string[];
  suggested_next_action?: string;
};

/** Normalize GET /api/v1/subnets/{netuid}/gaps for the subnet Gaps tab (#3348). */
export function normalizeSubnetGaps(raw: unknown): SubnetGapsView | null {
  if (!isRecord(raw)) return null;
  const netuid = optionalNumber(raw.netuid);
  if (netuid == null) return null;
  const priorities = Array.isArray(raw.priorities) ? raw.priorities : [];
  const primary = isRecord(priorities[0]) ? priorities[0] : null;
  const missing_kinds = stringArrayFromUnknown(primary?.missing_kinds);
  const suggested_next_action = optionalString(primary?.suggested_next_action);
  const gap_notes = suggested_next_action ? [suggested_next_action] : [];
  return { netuid, missing_kinds, gap_notes, suggested_next_action };
}

export const subnetGapsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-gaps", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/gaps`, { signal });
      const data = normalizeSubnetGaps(res.data);
      if (!data) throw new Error("Invalid subnet gaps response");
      return { ...res, data };
    },
    staleTime: STALE_MED,
  });

// The composed SubnetOverviewArtifact's sub-objects (profile/health/curation/
// gaps) are already reviewed, schema-valid payloads in their own right — this
// only needs enough fidelity to render the summary strip (#3346), not a full
// re-typed mirror of each sub-schema, so profile/health/curation/gaps pass
// through as loose records (matching the existing SubnetOverview interface).
export function normalizeSubnetOverview(raw: unknown, netuid: number): SubnetOverview {
  const root = isRecord(raw) ? raw : {};
  const counts = isRecord(root.counts) ? root.counts : {};
  return {
    netuid: optionalNumber(root.netuid) ?? netuid,
    name: optionalString(root.name),
    slug: optionalString(root.slug),
    status: optionalString(root.status),
    profile: isRecord(root.profile) ? root.profile : undefined,
    health: isRecord(root.health) ? root.health : undefined,
    curation: isRecord(root.curation) ? root.curation : undefined,
    gaps: isRecord(root.gaps) ? root.gaps : undefined,
    gap_priorities: Array.isArray(root.gap_priorities) ? root.gap_priorities : [],
    counts: {
      surfaces: optionalNumber(counts.surfaces) ?? 0,
      endpoints: optionalNumber(counts.endpoints) ?? 0,
      candidates: optionalNumber(counts.candidates) ?? 0,
    },
  };
}

export const subnetOverviewQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-overview", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/overview`, { signal });
      return {
        ...res,
        data: normalizeSubnetOverview(res.data, netuid),
      } as ApiResult<SubnetOverview>;
    },
    staleTime: STALE_MED,
  });

type ChangelogEntry = { id: string; at?: string; title?: string; kind?: string };

function normalizeChangelogEntries(raw: unknown[]): ChangelogEntry[] {
  return raw.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];

    const id = optionalString(entry.id)?.trim() || `entry-${index}`;
    const title = optionalString(entry.title)?.trim() || id;

    return [
      {
        id,
        title,
        at: finiteTimestamp(entry.at),
        kind: optionalString(entry.kind)?.trim(),
      },
    ];
  });
}

export const changelogQuery = () =>
  queryOptions({
    queryKey: k("changelog"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/changelog", "entries", undefined, signal);
      return { ...res, data: normalizeChangelogEntries(res.data) };
    },
    staleTime: STALE_LONG,
  });

export const searchQuery = (q: string, limit = 20) =>
  queryOptions({
    queryKey: k("search-index", q, limit),
    // Typeahead uses the slim /search-index (the same documents, ranking, and q/limit
    // filtering as /search, but without the per-document token blobs) for a lighter,
    // faster browser round-trip on every keystroke (#3490).
    queryFn: ({ signal }) =>
      fetchList<{ id: string; kind?: string; title?: string; url?: string }>(
        "/api/v1/search-index",
        "documents",
        { q, limit },
        signal,
      ),
    enabled: q.trim().length > 0,
    staleTime: STALE_SHORT,
  });

// Vector-similarity fallback for the keyword-only /api/v1/search-index above.
// Response is a single object with `results` nested inside (not a bare list or
// a { <collection>: T[] } wrapper), so this builds directly on apiFetch rather
// than the fetchList list-unwrapping helper.
export const semanticSearchQuery = (q: string, limit = 10, types?: string[]) =>
  queryOptions({
    queryKey: k("search-semantic", q, limit, types ?? []),
    queryFn: ({ signal }) =>
      apiFetch<SemanticSearchResponse>("/api/v1/search/semantic", {
        params: { q, limit, type: types },
        signal,
      }),
    enabled: q.trim().length > 0,
    staleTime: STALE_SHORT,
  });

export const buildQuery = () =>
  queryOptions({
    queryKey: k("build"),
    queryFn: ({ signal }) =>
      apiFetch<{ version?: string; built_at?: string; features?: Record<string, boolean> }>(
        "/api/v1/build",
        { signal },
      ),
    staleTime: STALE_LONG,
  });

export const adapterQuery = (slug: string) =>
  queryOptions({
    queryKey: k("adapter", slug),
    queryFn: ({ signal }) =>
      apiFetch<AdapterSnapshot>(`/api/v1/adapters/${encodePathSegment(slug)}`, {
        signal,
      }),
    staleTime: STALE_MED,
  });
