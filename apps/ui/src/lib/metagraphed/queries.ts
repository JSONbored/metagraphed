import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { apiFetch, ApiError, type ApiResult, type QueryParams } from "./client";
import { getNetwork } from "./config";
import { blockRefPathSegment } from "./blocks";
import { extrinsicHashPathSegment } from "./extrinsics";
import { isValidSs58, ss58PathSegment } from "./accounts";
import { isSchemaDrift, normalizeDriftStatus } from "./schema-drift";
import { isUsableTimestamp } from "./format";
import {
  serializeOperatorRows,
  operatorNominatorCount,
  shortKey,
  type OperatorRow,
  type SerializedOperatorRow,
} from "./validator-operators";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";
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
  AccountIdentity,
  AccountDay,
  AccountEvent,
  AccountEventsPage,
  AccountCounterparties,
  AccountDelegationGraph,
  AccountDelegationSubnet,
  AccountEntities,
  AccountEntityLabel,
  AccountOwnershipTie,
  AccountCounterparty,
  AccountStakeFlow,
  AccountStakeFlowSubnet,
  AccountHistory,
  AccountPortfolio,
  AccountPosition,
  AccountPositions,
  AccountStakeMoves,
  AccountStakeMovesSubnet,
  AccountRegistration,
  AccountSubnets,
  AccountSummary,
  AccountHolderDirectory,
  AccountHolderDirectoryEntry,
  AccountListEntry,
  PortfolioConcentration,
  PortfolioPosition,
  Block,
  ChainActivity,
  ChainActivityDay,
  EconomicsTrends,
  EconomicsTrendsDay,
  ChainCalls,
  ChainIdentityHistory,
  ChainIdentityChange,
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
  ChainTransferEntry,
  ChainTransfers,
  ChainStakeTransfers,
  ChainStakeTransferSubnet,
  ChainAxonRemovals,
  ChainAxonRemovalSubnet,
  ChainDeregistrations,
  ChainDeregistrationsSubnet,
  ChainWeights,
  ChainWeightsSubnet,
  ChainRegistrations,
  ChainRegistrationsSubnet,
  ChainServing,
  ChainServingSubnet,
  ChainPrometheus,
  ChainPrometheusSubnet,
  ChainIntensityDistribution,
  ChainConcentration,
  ChainPerformance,
  ChainYield,
  ChainYieldDistribution,
  ChainSigners,
  ChainWeightSetters,
  ChainWeightSetter,
  ChainSignerEntry,
  Extrinsic,
  ExtrinsicCallArg,
  SudoKey,
  NetworkParameters,
  RuntimeTransition,
  EmissionPipeline,
  EmissionPipelineSubnet,
  EmissionPipelineCheck,
  EmissionPipelineFieldSource,
  RuntimeVersionHistory,
  Transfer,
  Candidate,
  Compare,
  CompareSubnet,
  CompareValidator,
  CompareValidators,
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
  ReviewGapPriority,
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
  Domain,
  DomainConcentration,
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
  EvmAddressMappingResponse,
  SearchResolveResponse,
  SemanticSearchResponse,
  Subnet,
  SubnetAxonRemovals,
  SubnetDeregistrations,
  SubnetEventCategorySummary,
  SubnetEventKindSummary,
  SubnetEventSummary,
  SubnetStakeMoves,
  SubnetServing,
  SubnetPrometheus,
  SubnetEconomics,
  SubnetHistory,
  SubnetHistoryPoint,
  SubnetHyperparameters,
  SubnetHyperparametersDetail,
  SubnetHyperparamsHistory,
  SubnetHyperparamsHistoryEntry,
  SubnetStakeQuote,
  SubnetRecycled,
  SubnetRevenue,
  SubnetRevenueArtifact,
  RevenueBasis,
  RevenueEmission,
  RevenueProvenance,
  RevenueSource,
  RevenueVerificationCheck,
  ChainRevenueCoverage,
  RevenueWindow,
  SubnetIdleStake,
  ChainIdleStake,
  ChainIdleStakeSubnet,
  AccountIdentityHistory,
  AccountIdentityHistoryEntry,
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
  SubnetAlphaVolume,
  ChainAlphaVolume,
  ChainAlphaVolumeNetwork,
  ChainAlphaVolumeDistribution,
  SubnetOhlc,
  SubnetOhlcCandle,
  SubnetConviction,
  SubnetConvictionEntry,
  SubnetHolderEntry,
  SubnetHolders,
  SubnetOwnershipHistory,
  SubnetLeaseState,
  SubnetLifecycleEntry,
  SubnetValidatorEconomics,
  SubnetValidatorEconomicsPoint,
  SubnetDeregistrationHistory,
  SubnetDeregistrationHistoryPoint,
  SubnetEmissionPipelineHistory,
  SubnetEmissionPipelinePoint,
  SubnetSurfaceChange,
  RegistryPipeline,
  PipelineSample,
  SourceSnapshot,
  Crowdloan,
  FixtureLookup,
  TopHolders,
  TopHolder,
  RootClaim,
  ValidatorEconomics,
  ValidatorEconomicsRow,
  ExcludedSubnet,
  DomainSummary,
  IndexerLag,
  FailureReasons,
  FailureReason,
  EmissionChanges,
  EmissionChange,
  RandomnessStatus,
  ChainBurn,
  ChainBurnSubnet,
  ChainHolders,
  ChainHolderSubnet,
  NetworkConcentrationSubnets,
  NetworkConcentrationSubnet,
  NetworkConcentrationHistory,
  NetworkConcentrationHistoryPoint,
  DeregistrationStanding,
  SubnetLeaseTerms,
  SubnetLeaseHistory,
  SubnetLeaseEvent,
  SubnetOwnershipChange,
  SubnetMovers,
  SubnetMover,
  MetagraphNeuron,
  SubnetMetagraph,
  SubnetValidators,
  GlobalValidator,
  GlobalValidators,
  GlobalValidatorSort,
  GlobalValidatorSubnet,
  OperatorValidator,
  ValidatorDetail,
  ValidatorDetailSubnet,
  ColdkeyIdentity,
  ValidatorNominatorEntry,
  ValidatorHistory,
  ValidatorHistoryPoint,
  AccountPositionHistory,
  AccountPositionHistoryPoint,
  SubnetNeuronSnapshot,
  ConcentrationMetrics,
  ScoreDistribution,
  SubnetConcentration,
  ConcentrationHistoryPoint,
  SubnetBurnHistory,
  SubnetConcentrationHistory,
  SubnetPerformance,
  PerformanceHistoryPoint,
  SubnetPerformanceHistory,
  SubnetYield,
  SubnetYieldNeuron,
  YieldHistoryPoint,
  SubnetEmissionSplitHistory,
  SubnetMinerFairness,
  SubnetOwnerCapture,
  SubnetTreasury,
  SubnetCostToParticipate,
  EmissionSplitPoint,
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
  SelfHealth,
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
const MAX_ECONOMICS_TRENDS_DAYS = 31;
const MAX_CHAIN_CALLS = 12;
const MAX_STAKE_FLOW_SUBNETS = 24;
const MAX_STAKE_MOVES_SUBNETS = 24;
const MAX_TURNOVER_SUBNETS = 24;
// The endpoint returns the top 100 pallet.method groups, busiest first.
const MAX_CHAIN_EVENT_GROUPS = 100;
const DEFAULT_CHAIN_EVENT_BLOCKS = 1000;
const MAX_CHAIN_SIGNERS = 20;
const MAX_CHAIN_TRANSFERS = 20;
const MAX_CHAIN_WEIGHT_SETTERS = 20;
const MAX_CHAIN_IDENTITY_CHANGES = 200;
const MAX_CHAIN_FEE_DAYS = 31;
const MAX_CHAIN_FEE_PAYERS = 12;
const MAX_CHAIN_TRANSFER_PAIRS = 100;
const MAX_CHAIN_STAKE_TRANSFERS = 100;
const MAX_CHAIN_AXON_REMOVALS = 100;
const MAX_CHAIN_DEREGISTRATIONS = 100;
const MAX_CHAIN_WEIGHTS = 100;
const MAX_CHAIN_REGISTRATIONS = 100;
const MAX_CHAIN_SERVING = 100;
const MAX_CHAIN_PROMETHEUS = 100;

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
        // ALPHA, not TAO. /api/v1/economics serves `total_stake_alpha` and
        // has no `total_stake_tao` at all -- 0 of 129 rows carried one when
        // this was checked against production (2026-08-23), so the old
        // mapping resolved to undefined on every subnet and every reader of
        // it rendered a dash. There is no honest conversion to add here: the
        // TAO value of a subnet's alpha stake needs that subnet's price, and
        // multiplying it in silently would publish a derived number as a
        // measured one.
        total_stake_alpha: optionalNumber(item.total_stake_alpha),
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

export function normalizeFreshnessSources(raw: unknown, now = Date.now()) {
  let staleCount = 0;
  let ageTotal = 0;
  let ageCount = 0;
  let maxAgeSeconds: number | undefined;

  const sources = freshnessSourceRecords(raw).map<NormalizedFreshnessSource>((s) => {
    const candidate = finiteTimestamp(s.as_of) ?? finiteTimestamp(s.timestamp);
    // Apply the same pre-2000 placeholder exclusion isUsableTimestamp enforces,
    // so a "1970-01-01T00:00:00.000Z" registry placeholder isn't fed as a
    // multi-decade age into the freshness/staleness domain (staleCount,
    // avgAgeSeconds, maxAgeSeconds) the UI renders.
    const ts = isUsableTimestamp(candidate) ? candidate : undefined;
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
/** The three fields a composition or a name lookup needs from an economics row. */
const ECONOMICS_IDENTITY_FIELDS = ["netuid", "name", "emission_share"] as const;

const ECONOMICS_DIRECTORY_FIELDS = [
  "netuid",
  "name",
  "emission_share",
  "total_stake_alpha",
  "alpha_price_tao",
  "alpha_price_change_7d",
  "alpha_price_change_1m",
  "validator_count",
  "subnet_volume_tao",
] as const;

const ECONOMICS_DETAIL_FIELDS = [
  "netuid",
  "name",
  "emission_share",
  "total_stake_alpha",
  "alpha_price_tao",
  "max_uids",
  "miner_count",
  "validator_count",
  "registration_allowed",
  "owner_coldkey",
  "owner_hotkey",
] as const;

type EconomicsFields = "all" | "detail" | "directory" | "identity";

const ECONOMICS_FIELDS: Record<Exclude<EconomicsFields, "all">, readonly string[]> = {
  detail: ECONOMICS_DETAIL_FIELDS,
  directory: ECONOMICS_DIRECTORY_FIELDS,
  identity: ECONOMICS_IDENTITY_FIELDS,
};

/**
 * @param fields `"all"` for the full row or a named route projection. Named
 * projections are sent to the API, not merely removed after download.
 *
 * The response is 129 rows of ~45 fields, and a page that only composes
 * emission share inlines the whole thing as SSR dehydration -- 176 KB of the
 * home page's 211 KiB for three fields per row (#11618). Same reasoning and
 * same shape as `validatorsQuery`'s `subnets` / `identity` flags; it is part
 * of the query KEY so two callers asking for different shapes cannot share a
 * cache entry and read rows that are missing a field.
 */
export const economicsQuery = ({ fields = "all" }: { fields?: EconomicsFields } = {}) =>
  queryOptions({
    queryKey: k("economics", fields),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ subnets?: unknown }>("/api/v1/economics", {
        params: fields === "all" ? undefined : { fields: ECONOMICS_FIELDS[fields].join(",") },
        signal,
      });
      const rows = normalizeEconomicsSubnets(res.data?.subnets);
      return {
        data:
          fields === "all"
            ? rows
            : rows.map((row) =>
                Object.fromEntries(ECONOMICS_FIELDS[fields].map((field) => [field, row[field]])),
              ),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetEconomics[]>;
    },
    staleTime: STALE_MED,
  });

const LEADERBOARD_BOARD_KEYS: LeaderboardBoardKey[] = [
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
];

function normalizeLeaderboardRow(raw: unknown): LeaderboardRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.netuid !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
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
    score: num(r.score),
    grade: str(r.grade),
    sample_count: num(r.sample_count),
    open_slots: num(r.open_slots),
    max_uids: num(r.max_uids),
    registration_cost_tao: num(r.registration_cost_tao),
    registration_allowed: bool(r.registration_allowed),
    emission_share: num(r.emission_share),
    total_stake_alpha: num(r.total_stake_alpha),
    validator_count: num(r.validator_count),
    miner_count: num(r.miner_count),
    validator_headroom: num(r.validator_headroom),
    max_validators: num(r.max_validators),
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

// #1111: registry leaderboards — live, store-computed boards. Six operational
// (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing,
// most-reliable) and four economic-opportunity (open-slots,
// cheapest-registration, highest-emission, validator-headroom). One artifact
// carries all boards; the homepage discovery module renders the top rows of a
// subset, and /leaderboards surfaces them all (#6995).
function normalizeSubnetMover(raw: unknown): SubnetMover | null {
  if (!isRecord(raw)) return null;
  const netuid = coerceFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    stake_start_alpha: coerceFiniteNumber(raw.stake_start_alpha) ?? 0,
    stake_end_alpha: coerceFiniteNumber(raw.stake_end_alpha) ?? 0,
    stake_delta_alpha: coerceFiniteNumber(raw.stake_delta_alpha) ?? 0,
    stake_pct_change: coerceFiniteNumber(raw.stake_pct_change) ?? null,
    stake_share_pct: coerceFiniteNumber(raw.stake_share_pct) ?? null,
    emission_start_alpha: coerceFiniteNumber(raw.emission_start_alpha) ?? 0,
    emission_end_alpha: coerceFiniteNumber(raw.emission_end_alpha) ?? 0,
    emission_delta_alpha: coerceFiniteNumber(raw.emission_delta_alpha) ?? 0,
    // `?? null`, not `?? 0`: a subnet with no emission at the start of the
    // window has no percentage change, and zero would read as "unchanged".
    emission_pct_change: coerceFiniteNumber(raw.emission_pct_change) ?? null,
    emission_share_pct: coerceFiniteNumber(raw.emission_share_pct) ?? null,
    validators_start: coerceFiniteNumber(raw.validators_start) ?? 0,
    validators_end: coerceFiniteNumber(raw.validators_end) ?? 0,
    validators_delta: coerceFiniteNumber(raw.validators_delta) ?? 0,
    neurons_start: coerceFiniteNumber(raw.neurons_start) ?? 0,
    neurons_end: coerceFiniteNumber(raw.neurons_end) ?? 0,
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
    start_date: firstString(d.start_date) ?? null,
    end_date: firstString(d.end_date) ?? null,
    covered_days: coerceFiniteNumber(d.covered_days) ?? null,
    requested_days: coerceFiniteNumber(d.requested_days) ?? null,
    window_truncated: d.window_truncated === true,
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

// #6996: per-domain rollup over the 14-tag capability taxonomy from
// /api/v1/domains — member subnets, total stake/emission, and within-domain
// emission concentration. Every numeric cell coerces defensively so a cold
// store never produces NaN in the UI.
function normalizeDomainConcentration(raw: unknown): DomainConcentration | undefined {
  if (!isRecord(raw)) return undefined;
  const num = (v: unknown) => coerceFiniteNumber(v) ?? undefined;
  return {
    holders: num(raw.holders),
    gini: num(raw.gini),
    hhi: num(raw.hhi),
    hhi_normalized: num(raw.hhi_normalized),
    nakamoto_coefficient: num(raw.nakamoto_coefficient),
    top_1pct_share: num(raw.top_1pct_share),
    top_5pct_share: num(raw.top_5pct_share),
    top_10pct_share: num(raw.top_10pct_share),
    top_20pct_share: num(raw.top_20pct_share),
    entropy: num(raw.entropy),
    entropy_normalized: num(raw.entropy_normalized),
  };
}

export function normalizeDomains(raw: unknown): Domain[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.domains)
      ? raw.domains
      : [];
  return list.flatMap((row) => {
    if (!isRecord(row) || typeof row.domain !== "string") return [];
    const netuids = Array.isArray(row.netuids)
      ? row.netuids.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
    return [
      {
        domain: row.domain,
        subnet_count: coerceFiniteNumber(row.subnet_count) ?? netuids.length,
        netuids,
        total_stake_tao: coerceFiniteNumber(row.total_stake_tao) ?? undefined,
        total_emission_share: coerceFiniteNumber(row.total_emission_share) ?? undefined,
        emission_concentration: normalizeDomainConcentration(row.emission_concentration),
      },
    ];
  });
}

export const domainsQuery = () =>
  queryOptions({
    queryKey: k("domains"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ domains?: unknown }>("/api/v1/domains", { signal });
      return { data: normalizeDomains(res.data?.domains), meta: res.meta, url: res.url };
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

/**
 * GET /api/v1/self-health (#8318/#8250) -- metagraphed's OWN uptime.
 *
 * Distinct from healthQuery above, which rolls up THIRD-PARTY subnet surfaces.
 * Conflating the two is what made /status show a red "Partial outage" banner
 * because 3 of 617 someone-else's endpoints were down.
 *
 * `retry: 0` and a non-suspending caller: until this route is deployed it
 * 404s, and the page must degrade to "we can't tell" rather than error.
 */
export const selfHealthQuery = () =>
  queryOptions({
    queryKey: k("self-health"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<SelfHealth>("/api/v1/self-health", { signal });
      return { data: res.data, meta: res.meta, url: res.url };
    },
    staleTime: STALE_SHORT,
    retry: 0,
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
      const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
      const d = res.data;
      if (!isRecord(d) || !Array.isArray(d.subnets)) {
        throw new Error("Subnet surface health returned an invalid response.");
      }
      const subnets = d.subnets;
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

/**
 * GET /api/v1/health, keeping the PER-SUBNET rows (#11625).
 *
 * `healthQuery` above merges the response's `global` block up to the top level
 * and hands back a flat `HealthSummary` — which is what a header badge wants
 * and is not what a page listing 122 subnets by uptime can use. Same request,
 * same cache cost; this one keeps `subnets[]`.
 */
export const healthSubnetsQuery = () =>
  queryOptions({
    queryKey: k("health-subnets"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/health", { signal });
      const d = (res.data ?? {}) as Record<string, unknown>;
      return {
        ...res,
        data: {
          global: isRecord(d.global) ? (d.global as Record<string, unknown>) : {},
          subnets: Array.isArray(d.subnets) ? (d.subnets as Record<string, unknown>[]) : [],
          observed_at: firstString(d.operational_observed_at) ?? firstString(d.generated_at),
        },
      };
    },
    staleTime: STALE_SHORT,
  });

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
    service_kinds:
      Array.isArray(raw.service_kinds) &&
      raw.service_kinds.every((kind) => typeof kind === "string")
        ? raw.service_kinds
        : undefined,
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
      const res = await apiFetch<Record<string, unknown>>("/api/v1/agent-catalog", { signal });
      const d = res.data;
      if (
        !isRecord(d) ||
        !Array.isArray(d.subnets) ||
        (d.blocked_subnets !== undefined && !Array.isArray(d.blocked_subnets))
      ) {
        throw new Error("Subnet API specifications returned an invalid response.");
      }
      const map: Record<number, AgentCatalogSummary> = {};
      for (const key of ["subnets", "blocked_subnets"] as const) {
        const arr = Array.isArray(d[key]) ? (d[key] as unknown[]) : [];
        for (const row of arr) {
          const norm = normalizeAgentCatalogSummary(row);
          if (norm) map[norm.netuid] = norm;
        }
      }
      return { data: map, meta: res.meta, url: res.url };
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

/**
 * The distribution block, normalized like every other field beside it.
 *
 * `isRecord(x) ? (x as unknown as ChainAlphaVolumeDistribution) : null` proved
 * only that the value was an object and then claimed eight required numbers
 * about it. Every one of those is rendered into a percentile chart, so a
 * missing `p90` from a partial upstream response reached the axis as
 * `undefined` rather than the null this function was built to return.
 */
function normalizeChainAlphaVolumeDistribution(raw: unknown): ChainAlphaVolumeDistribution | null {
  if (!isRecord(raw)) return null;
  const count = firstFiniteNumber(raw.count);
  const mean = firstFiniteNumber(raw.mean);
  const min = firstFiniteNumber(raw.min);
  const p25 = firstFiniteNumber(raw.p25);
  const median = firstFiniteNumber(raw.median);
  const p75 = firstFiniteNumber(raw.p75);
  const p90 = firstFiniteNumber(raw.p90);
  const max = firstFiniteNumber(raw.max);
  // All or nothing: a half-populated distribution plots a chart with gaps that
  // read as real zeroes.
  if (
    count === undefined ||
    mean === undefined ||
    min === undefined ||
    p25 === undefined ||
    median === undefined ||
    p75 === undefined ||
    p90 === undefined ||
    max === undefined
  ) {
    return null;
  }
  return { count, mean, min, p25, median, p75, p90, max };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

export function normalizeSubnet(raw: unknown): Subnet {
  if (!raw || typeof raw !== "object") return raw as Subnet;
  const s = raw as Record<string, unknown>;
  // Dropped, not merely unread: `github_commits_weekly` is 52 weekly objects
  // per subnet and measured 74 KB of the 331 KB that /subnets inlines into
  // the document as SSR dehydration -- 22% of the page, for a field the app
  // stopped rendering when the subnet dossier's dev-activity panel went
  // (#11612). `github_languages` is another 7 KB with the same story. Same
  // reasoning as validatorsQuery's `subnets: false` (#11315): the fetch
  // happens during SSR and never crosses the user's wire, so the only cost
  // left is the copy the browser parses.
  const { github_commits_weekly: _weekly, github_languages: _languages, ...rest } = s;
  return {
    ...(rest as object),
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

/**
 * One-shot ceiling for "every active subnet" reads (#8248).
 *
 * /api/v1/subnets has no server-side sort and the registry is ~129 subnets, so
 * the page fetches the whole set once and works over it client-side. Shared so
 * the registry table and the crawlable index cannot drift onto two different
 * limits and disagree about what "every subnet" means.
 */
// Re-exported from its new home so every existing importer keeps working.
// Moved because server.ts needs it too and cannot import this module.
export { SUBNETS_ALL_LIMIT } from "./subnet-list-limit";

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
  const subnetIds = Array.isArray(blockData.subnet_ids)
    ? [
        ...new Set(
          blockData.subnet_ids.flatMap((value) => {
            const netuid = firstFiniteNumber(value);
            return netuid == null || netuid < 0 ? [] : [netuid];
          }),
        ),
      ].sort((left, right) => left - right)
    : [];
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
    decode_status:
      blockData.decode_status === "pending" || blockData.decode_status === "complete"
        ? blockData.decode_status
        : "unavailable",
    native_transfer_tao: firstFiniteNumber(blockData.native_transfer_tao),
    stake_flow_tao: firstFiniteNumber(blockData.stake_flow_tao),
    economic_activity_tao: firstFiniteNumber(blockData.economic_activity_tao),
    fee_tao: firstFiniteNumber(blockData.fee_tao),
    tip_tao: firstFiniteNumber(blockData.tip_tao),
    issuance_tao: firstFiniteNumber(blockData.issuance_tao),
    subnet_ids: subnetIds,
    economic_activity_usd: firstFiniteNumber(blockData.economic_activity_usd),
    usd_per_tao: firstFiniteNumber(blockData.usd_per_tao),
    tao_usd_block: firstFiniteNumber(blockData.tao_usd_block),
    tao_usd_observed_at: firstString(blockData.tao_usd_observed_at),
    tao_usd_basis: firstString(blockData.tao_usd_basis),
    tao_usd_unavailable: firstString(blockData.tao_usd_unavailable),
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

export function normalizeBlockEvent(raw: unknown): BlockEvent | null {
  if (!isRecord(raw)) return null;
  return {
    ...(raw as object),
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    event_index: firstFiniteNumber(raw.event_index) ?? null,
    event_kind: firstString(raw.event_kind) ?? null,
    hotkey: firstString(raw.hotkey),
    coldkey: firstString(raw.coldkey),
    netuid: firstFiniteNumber(raw.netuid),
    uid: firstFiniteNumber(raw.uid),
    amount_tao: firstFiniteNumber(raw.amount_tao) ?? firstFiniteNumber(raw.amount) ?? null,
    observed_at: firstString(raw.observed_at),
    extrinsic_index: firstFiniteNumber(raw.extrinsic_index),
    alpha_amount: firstFiniteNumber(raw.alpha_amount) ?? null,
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

// Deliberately tolerant of both wire shapes for the bigint-ish fields
// (block_number, event_index, observed_at). The Postgres-era all-events tier
// serialized them as JSON strings and omitted the (redundant) block_number on
// each row of the per-block route; the lakehouse tier serving it today sends
// numbers and includes block_number — verified against a live response. Both
// are accepted rather than pinned to the current one, hence coerceFiniteNumber
// (not firstFiniteNumber) and the fallback below.
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

/**
 * Offset-paginated extrinsics for one immutable block.
 *
 * A block can contain more than the endpoint's 100-row page ceiling. The
 * detail route used to issue one `limit=100` request and silently stop there,
 * even when the block header reported a larger exact count. Keep the first
 * request byte-for-byte compatible with the existing cache key (no explicit
 * `offset=0`), then walk subsequent pages by the exact number already shown.
 */
export const blockExtrinsicsInfiniteQuery = (
  ref: string,
  pageSize = 100,
  knownTotal?: number | null,
) =>
  infiniteQueryOptions({
    // `knownTotal` only improves termination; it does not identify different
    // data. Keeping it out of the key lets an intent-prefetched first page be
    // reused when the block record later supplies its exact count.
    queryKey: k("block-extrinsics-infinite", ref, pageSize),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const offset = pageParam as number;
      const params: QueryParams = {
        limit: pageSize,
        ...(offset > 0 ? { offset } : {}),
      };
      const res = await apiFetch<unknown>(`/api/v1/blocks/${blockRefPathSegment(ref)}/extrinsics`, {
        params,
        signal,
      });
      return {
        ...res,
        data: normalizeBlockExtrinsics(res.data),
      } as ApiResult<BlockExtrinsics>;
    },
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((count, page) => count + page.data.extrinsics.length, 0);
      if (last.data.extrinsics.length < pageSize) return undefined;
      // The subresource's `extrinsic_count` is the number in THIS PAGE (100,
      // then 62 for a 162-call block), not the block total. Only the header's
      // count can terminate an exactly-full page without an extra empty read.
      if (typeof knownTotal === "number" && Number.isFinite(knownTotal) && shown >= knownTotal) {
        return undefined;
      }
      return shown;
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

/** Lossless, offset-paginated account-attributed effects for one block. */
export const blockEventsInfiniteQuery = (ref: string, pageSize = 100) =>
  infiniteQueryOptions({
    queryKey: k("block-events-infinite", ref, pageSize),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const offset = pageParam as number;
      const res = await apiFetch<unknown>(`/api/v1/blocks/${blockRefPathSegment(ref)}/events`, {
        params: { limit: pageSize, ...(offset > 0 ? { offset } : {}) },
        signal,
      });
      return { ...res, data: normalizeBlockEvents(res.data) } as ApiResult<BlockEvents>;
    },
    getNextPageParam: (last, pages) => {
      if (last.data.events.length < pageSize) return undefined;
      return pages.reduce((count, page) => count + page.data.events.length, 0);
    },
    staleTime: STALE_SHORT,
  });

/**
 * Single block by numeric block_number or 0x block_hash, with every raw
 * pallet-level chain event from the lakehouse all-events tier — a
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

function countExtrinsicCallArgs(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (isRecord(raw)) return Object.keys(raw).length;
  return null;
}

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
  const callArgsTotal = countExtrinsicCallArgs(raw.call_args);

  const eventsSource = Array.isArray(rawEvents)
    ? rawEvents
    : Array.isArray(raw.events)
      ? raw.events
      : [];

  const eventsTotal = eventsSource.length;

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
            amount_tao: firstFiniteNumber(event.amount_tao) ?? null,
            alpha_amount: firstFiniteNumber(event.alpha_amount) ?? null,
            extrinsic_index: firstFiniteNumber(event.extrinsic_index) ?? null,
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
    call_args_total: callArgsTotal,
    events,
    events_total: eventsTotal,
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

// #6997: current global Subtensor protocol/governance parameters. Each field
// independently defaults to null (never 0/false) on a missing/non-numeric
// value, matching the REST route's own "each field is independently null on
// its own RPC failure" contract -- a real zero must stay distinguishable
// from a failed read.
export const networkParametersQuery = () =>
  queryOptions({
    queryKey: k("network-parameters"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/network/parameters", { signal });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          tao_weight: firstFiniteNumber(d.tao_weight) ?? null,
          stake_threshold_tao: firstFiniteNumber(d.stake_threshold_tao) ?? null,
          pending_childkey_cooldown_blocks:
            firstFiniteNumber(d.pending_childkey_cooldown_blocks) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } as NetworkParameters,
        meta: res.meta,
        url: res.url,
      } as ApiResult<NetworkParameters>;
    },
    staleTime: STALE_LONG,
  });

// #8745 / #8744: the v440 emission pipeline. Every numeric field defaults to
// null rather than 0 -- a subnet outside the pipeline (root, never-emitted)
// genuinely has NO final share, and rendering that as 0 would make it
// indistinguishable from a subnet the gate zeroed, which is a different fact
// about the chain. `emission_enabled` is the one field that defaults to a
// value (false): it is published, not reconstructed, and a missing boolean
// here would leave every row's most load-bearing state unrenderable.
function normalizeEmissionPipelineSubnet(raw: unknown): EmissionPipelineSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    ineligible_reason: firstString(raw.ineligible_reason) ?? null,
    emission_share: firstFiniteNumber(raw.emission_share) ?? null,
    miner_burned: firstFiniteNumber(raw.miner_burned) ?? null,
    weighted_share: firstFiniteNumber(raw.weighted_share) ?? null,
    gated_share: firstFiniteNumber(raw.gated_share) ?? null,
    emission_enabled: raw.emission_enabled === true,
    final_share: firstFiniteNumber(raw.final_share) ?? null,
    gate_delta: firstFiniteNumber(raw.gate_delta) ?? null,
    distance_to_bar: firstFiniteNumber(raw.distance_to_bar) ?? null,
    tao_in_emission: firstFiniteNumber(raw.tao_in_emission) ?? null,
    excess_tao: firstFiniteNumber(raw.excess_tao) ?? null,
    tao_total: firstFiniteNumber(raw.tao_total) ?? null,
    liquidity_fraction: firstFiniteNumber(raw.liquidity_fraction) ?? null,
    alpha_in_emission: firstFiniteNumber(raw.alpha_in_emission) ?? null,
    alpha_out_emission: firstFiniteNumber(raw.alpha_out_emission) ?? null,
  };
}

function normalizeEmissionPipelineCheck(raw: unknown): EmissionPipelineCheck | null {
  if (!isRecord(raw)) return null;
  const name = firstString(raw.name);
  if (name == null) return null;
  return { name, ok: raw.ok === true, detail: firstString(raw.detail) ?? null };
}

function normalizeEmissionPipelineFieldSources(
  raw: unknown,
): Record<string, EmissionPipelineFieldSource> {
  if (!isRecord(raw)) return {};
  const out: Record<string, EmissionPipelineFieldSource> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    // Anything not explicitly "measured" is treated as reconstructed. That is
    // the safe direction: over-claiming a value as read-from-chain when it was
    // derived is the failure this provenance field exists to prevent.
    out[field] = {
      kind: value.kind === "measured" ? "measured" : "reconstructed",
      storage: firstString(value.storage) ?? null,
    };
  }
  return out;
}

export function normalizeEmissionPipeline(raw: unknown): EmissionPipeline {
  const d = isRecord(raw) ? raw : {};
  const chainState = isRecord(d.chain_state) ? d.chain_state : {};
  const aggregate = isRecord(d.aggregate) ? d.aggregate : {};
  const verification = isRecord(d.verification) ? d.verification : {};
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    chain_state: {
      block: firstFiniteNumber(chainState.block) ?? null,
      block_hash: firstString(chainState.block_hash) ?? null,
      emission_bar_quantile: firstFiniteNumber(chainState.emission_bar_quantile) ?? null,
      emission_gate_bar: firstFiniteNumber(chainState.emission_gate_bar) ?? null,
      emission_gate_exponent: firstFiniteNumber(chainState.emission_gate_exponent) ?? null,
      total_issuance_tao: firstFiniteNumber(chainState.total_issuance_tao) ?? null,
    },
    block_emission_tao: firstFiniteNumber(d.block_emission_tao) ?? null,
    block_emission_halvings: firstFiniteNumber(d.block_emission_halvings) ?? null,
    subnets: Array.isArray(d.subnets)
      ? d.subnets.flatMap((row) => {
          const subnet = normalizeEmissionPipelineSubnet(row);
          return subnet ? [subnet] : [];
        })
      : [],
    aggregate: {
      eligible_count: firstFiniteNumber(aggregate.eligible_count) ?? null,
      disabled_count: firstFiniteNumber(aggregate.disabled_count) ?? null,
      tao_in_emission: firstFiniteNumber(aggregate.tao_in_emission) ?? null,
      excess_tao: firstFiniteNumber(aggregate.excess_tao) ?? null,
      tao_total: firstFiniteNumber(aggregate.tao_total) ?? null,
      liquidity_fraction: firstFiniteNumber(aggregate.liquidity_fraction) ?? null,
      total_final_share: firstFiniteNumber(aggregate.total_final_share) ?? null,
    },
    verification: {
      // Absent verification is UNVERIFIED, never assumed good: this flag gates
      // whether the page may present the numbers as fact.
      verified: verification.verified === true,
      checks: Array.isArray(verification.checks)
        ? verification.checks.flatMap((row) => {
            const check = normalizeEmissionPipelineCheck(row);
            return check ? [check] : [];
          })
        : [],
      subnet_share_tolerance: firstFiniteNumber(verification.subnet_share_tolerance) ?? null,
      aggregate_tolerance_rao: firstString(verification.aggregate_tolerance_rao) ?? null,
    },
    field_sources: normalizeEmissionPipelineFieldSources(d.field_sources),
  };
}

/**
 * The v440 emission-pipeline decomposition (#8745). One request serves both
 * the network view and any single subnet's panel — the payload is ~130 rows,
 * so filtering client-side beats a second round trip, and the aggregate is
 * network-wide regardless of any `netuid` filter anyway.
 *
 * STALE_MED, not STALE_SHORT: the underlying capture is pinned to one block by
 * a periodic economics job, so polling faster than that only re-fetches the
 * same pinned sample.
 */
export const emissionPipelineQuery = () =>
  queryOptions({
    queryKey: k("chain-emission-pipeline"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/emission-pipeline", { signal });
      return {
        data: normalizeEmissionPipeline(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<EmissionPipeline>;
    },
    staleTime: STALE_MED,
  });

function normalizeRuntimeTransition(raw: unknown): RuntimeTransition | null {
  if (!isRecord(raw)) return null;
  const specVersion = firstFiniteNumber(raw.spec_version);
  const blockNumber = firstFiniteNumber(raw.block_number);
  if (specVersion == null || blockNumber == null) return null;
  return {
    spec_version: specVersion,
    block_number: blockNumber,
    observed_at: firstString(raw.observed_at) ?? null,
  };
}

/** Spec-version upgrade timeline from the `blocks` store tier (#4316/3.1). Small,
 * bounded dataset (runtime upgrades are rare) — no pagination params. */
export const runtimeVersionHistoryQuery = () =>
  queryOptions({
    queryKey: k("runtime-version-history"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/runtime", { signal });
      const d = isRecord(res.data) ? res.data : {};
      const transitions = Array.isArray(d.transitions)
        ? d.transitions.flatMap((row) => {
            const t = normalizeRuntimeTransition(row);
            return t ? [t] : [];
          })
        : [];
      return {
        data: {
          transitions,
          transition_count: firstFiniteNumber(d.transition_count) ?? transitions.length,
          current_spec_version: firstFiniteNumber(d.current_spec_version) ?? null,
          coverage_from_block: firstFiniteNumber(d.coverage_from_block) ?? null,
          coverage_from_at: firstString(d.coverage_from_at) ?? null,
        } as RuntimeVersionHistory,
        meta: res.meta,
        url: res.url,
      } as ApiResult<RuntimeVersionHistory>;
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
    stake_alpha: firstFiniteNumber(raw.stake_alpha) ?? null,
    emission_alpha: firstFiniteNumber(raw.emission_alpha) ?? null,
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
    // #8369: coerced explicitly rather than riding the `...raw` spread, so a
    // numeric string from the wire can't reach the formatter as a string.
    price_at_tx: coerceFiniteNumber(raw.price_at_tx) ?? null,
    price_basis:
      raw.price_basis === "trade_exact" || raw.price_basis === "root_no_pool"
        ? raw.price_basis
        : null,
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

/**
 * Personal (coldkey) on-chain identity for one account (#4324/5.1), from
 * account_identity via Postgres, with a frozen fallback. has_identity is false
 * for the common case — most accounts never call set_identity — so every
 * field but `account`/`has_identity` stays null rather than erroring.
 */
export const accountIdentityQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-identity", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/identity`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: firstFiniteNumber(d.schema_version) ?? 1,
          account: firstString(d.account) ?? ss58,
          has_identity: booleanValue(d.has_identity) ?? false,
          name: firstString(d.name) ?? null,
          url: firstString(d.url) ?? null,
          github: firstString(d.github) ?? null,
          image: firstString(d.image) ?? null,
          discord: firstString(d.discord) ?? null,
          description: firstString(d.description) ?? null,
          additional: firstString(d.additional) ?? null,
          captured_at: firstString(d.captured_at) ?? null,
        } as AccountIdentity,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountIdentity>;
    },
    staleTime: STALE_MED,
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

// #3340: fund-flow leaderboard — the addresses this account transacts with most
// (by volume), from the already-live /api/v1/accounts/{ss58}/counterparties
// (list mode). Structured-object response, so it mirrors accountSubnetsQuery's
// apiFetch + isRecord + per-row normalize shape (not a bare fetchList).
function normalizeCounterparty(raw: unknown): AccountCounterparty | null {
  if (!isRecord(raw)) return null;
  const address = firstString(raw.address);
  if (!address) return null;
  return {
    address,
    sent_tao: firstFiniteNumber(raw.sent_tao) ?? null,
    received_tao: firstFiniteNumber(raw.received_tao) ?? null,
    net_tao: firstFiniteNumber(raw.net_tao) ?? null,
    transfer_count: firstFiniteNumber(raw.transfer_count) ?? null,
    last_block: firstFiniteNumber(raw.last_block) ?? null,
  };
}

export const accountCounterpartiesQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-counterparties", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/counterparties`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const counterparties = Array.isArray(d.counterparties)
        ? d.counterparties.flatMap((row) => {
            const c = normalizeCounterparty(row);
            return c ? [c] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          counterparty_count: firstFiniteNumber(d.counterparty_count) ?? counterparties.length,
          transfers_scanned: firstFiniteNumber(d.transfers_scanned) ?? null,
          scan_capped: booleanValue(d.scan_capped),
          total_sent_tao: firstFiniteNumber(d.total_sent_tao) ?? null,
          total_received_tao: firstFiniteNumber(d.total_received_tao) ?? null,
          counterparties,
        } as AccountCounterparties,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountCounterparties>;
    },
    staleTime: STALE_MED,
  });

// #6723: live child/parent-hotkey delegation graph — the counterpart hotkeys
// this account delegates stake-weight to (children) or receives it from
// (parents), per subnet. Shared normalizer for both /accounts/{ss58}/children
// and /parents, which differ only in the per-entry counterpart field name
// ("child" vs "parent"). Preserves the backend's `subnets: null` tri-state (live
// RPC failed) distinctly from `subnets: []` (genuinely no delegations) so the UI
// can render "temporarily unavailable" separately from a cold wallet.
function normalizeDelegationSubnets(
  raw: unknown,
  counterpartKey: "child" | "parent",
): AccountDelegationSubnet[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((subnet) => {
    if (!isRecord(subnet)) return [];
    const netuid = firstFiniteNumber(subnet.netuid);
    if (netuid == null) return [];
    const entries = Array.isArray(subnet.entries)
      ? subnet.entries.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const counterpart = firstString(entry[counterpartKey]);
          if (!counterpart) return [];
          return [
            {
              counterpart,
              proportion: firstString(entry.proportion) ?? null,
              proportion_fraction: firstFiniteNumber(entry.proportion_fraction) ?? null,
            },
          ];
        })
      : [];
    // Drop a subnet that lost every entry to malformed rows — an empty
    // entries[] would render as a blank group with no edges.
    if (entries.length === 0) return [];
    return [{ netuid, entries }];
  });
}

function delegationGraphQuery(
  ss58: string,
  route: "children" | "parents",
  counterpartKey: "child" | "parent",
) {
  return queryOptions({
    queryKey: k(`account-${route}`, ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/${route}`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          account: firstString(d.account) ?? ss58,
          subnets: normalizeDelegationSubnets(d.subnets, counterpartKey),
          queried_at: firstString(d.queried_at) ?? null,
        } as AccountDelegationGraph,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountDelegationGraph>;
    },
    staleTime: STALE_MED,
  });
}

export const accountChildrenQuery = (ss58: string) =>
  delegationGraphQuery(ss58, "children", "child");

export const accountParentsQuery = (ss58: string) =>
  delegationGraphQuery(ss58, "parents", "parent");

// #6740: community entity labels + subnet-ownership ties for one address, from
// /api/v1/accounts/{ss58}/entities. Structured-object response with two arrays;
// both degrade to [] on a cold/unknown address (never throws).
function normalizeEntityLabel(raw: unknown): AccountEntityLabel | null {
  if (!isRecord(raw)) return null;
  return {
    name: firstString(raw.name) ?? null,
    category: firstString(raw.category) ?? null,
    notes: firstString(raw.notes) ?? null,
    source_urls: Array.isArray(raw.source_urls)
      ? raw.source_urls.flatMap((u) => {
          const s = firstString(u);
          return s ? [s] : [];
        })
      : [],
  };
}

function normalizeOwnershipTie(raw: unknown): AccountOwnershipTie | null {
  if (!isRecord(raw)) return null;
  const role = firstString(raw.role);
  const netuid = firstFiniteNumber(raw.netuid);
  const block = firstFiniteNumber(raw.block_number);
  if (role == null && netuid == null && block == null) return null;
  return {
    netuid: netuid ?? null,
    role: role ?? null,
    block_number: block ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
  };
}

export const accountEntitiesQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-entities", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/entities`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const labels = Array.isArray(d.labels)
        ? d.labels.flatMap((row) => {
            const l = normalizeEntityLabel(row);
            return l ? [l] : [];
          })
        : [];
      const ownershipTies = Array.isArray(d.ownership_ties)
        ? d.ownership_ties.flatMap((row) => {
            const t = normalizeOwnershipTie(row);
            return t ? [t] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          labels,
          ownership_tie_count: firstFiniteNumber(d.ownership_tie_count) ?? ownershipTies.length,
          ownership_ties: ownershipTies,
        } as AccountEntities,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountEntities>;
    },
    staleTime: STALE_MED,
  });

// #3341: per-account staking-behavior scorecard — net/gross flow, a direction
// label, concentration, and a per-subnet stake/unstake breakdown over a window,
// from the already-live /api/v1/accounts/{ss58}/stake-flow. Structured-object
// response, so it mirrors accountSubnetsQuery's apiFetch + isRecord + per-row
// normalize shape.
function normalizeStakeFlowSubnet(raw: unknown): AccountStakeFlowSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    staked_tao: firstFiniteNumber(raw.staked_tao) ?? null,
    unstaked_tao: firstFiniteNumber(raw.unstaked_tao) ?? null,
    net_flow_tao: firstFiniteNumber(raw.net_flow_tao) ?? null,
    gross_flow_tao: firstFiniteNumber(raw.gross_flow_tao) ?? null,
    flow_ratio: firstFiniteNumber(raw.flow_ratio) ?? null,
    direction: firstString(raw.direction) ?? null,
    stake_events: firstFiniteNumber(raw.stake_events) ?? null,
    unstake_events: firstFiniteNumber(raw.unstake_events) ?? null,
  };
}

export const accountStakeFlowQuery = (
  ss58: string,
  params?: { window?: "7d" | "30d" | "90d"; direction?: "in" | "out" },
) =>
  queryOptions({
    queryKey: k("account-stake-flow", ss58, params ?? {}),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/stake-flow`, {
        params,
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const subnets = Array.isArray(d.subnets)
        ? d.subnets.flatMap((row) => {
            const s = normalizeStakeFlowSubnet(row);
            return s ? [s] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          window: firstString(d.window) ?? params?.window ?? "30d",
          total_staked_tao: firstFiniteNumber(d.total_staked_tao) ?? null,
          total_unstaked_tao: firstFiniteNumber(d.total_unstaked_tao) ?? null,
          net_flow_tao: firstFiniteNumber(d.net_flow_tao) ?? null,
          gross_flow_tao: firstFiniteNumber(d.gross_flow_tao) ?? null,
          direction: firstString(d.direction) ?? null,
          concentration: firstFiniteNumber(d.concentration) ?? null,
          dominant_netuid: firstFiniteNumber(d.dominant_netuid) ?? null,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? subnets.length,
          subnets,
        } as AccountStakeFlow,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountStakeFlow>;
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
    price_tao_at_last_move: firstFiniteNumber(raw.price_tao_at_last_move) ?? null,
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

function normalizeAccountPositionHistoryPoint(raw: unknown): AccountPositionHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const snapshotDate = firstString(raw.snapshot_date);
  if (!snapshotDate) return null;
  return {
    snapshot_date: snapshotDate,
    captured_at: firstString(raw.captured_at) ?? null,
    uid: coerceFiniteNumber(raw.uid) ?? null,
    coldkey: firstString(raw.coldkey) ?? null,
    role: raw.role === "validator" ? "validator" : "miner",
    active: raw.active === true,
    stake_tao: firstFiniteNumber(raw.stake_tao) ?? null,
    emission_tao: firstFiniteNumber(raw.emission_tao) ?? null,
    rank: firstFiniteNumber(raw.rank) ?? null,
    trust: firstFiniteNumber(raw.trust) ?? null,
    incentive: firstFiniteNumber(raw.incentive) ?? null,
    dividends: firstFiniteNumber(raw.dividends) ?? null,
    yield: firstFiniteNumber(raw.yield) ?? null,
  };
}

/** Daily position history for one account on one subnet -- the "Alpha
 * Holdings chart" (#4329/6.2/6.4): stake/emission/yield over time, reusing
 * the account_position_daily rollup. */
export const accountPositionHistoryQuery = (ss58: string, netuid: number, window: string) =>
  queryOptions({
    queryKey: k("account-position-history", ss58, netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/subnets/${netuid}/history`,
        { params: { window }, signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const points = Array.isArray(d.points)
        ? d.points.flatMap((row) => {
            const p = normalizeAccountPositionHistoryPoint(row);
            return p ? [p] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          netuid: coerceFiniteNumber(d.netuid) ?? netuid,
          window: firstString(d.window) ?? null,
          point_count: firstFiniteNumber(d.point_count) ?? points.length,
          points,
        } as AccountPositionHistory,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountPositionHistory>;
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

export function normalizeAccountPosition(raw: unknown): AccountPosition | null {
  if (!isRecord(raw)) return null;
  const hotkey = firstString(raw.hotkey);
  const netuid = firstFiniteNumber(raw.netuid);
  const shareFraction = firstFiniteNumber(raw.share_fraction);
  const stakeTao = firstFiniteNumber(raw.stake_tao);
  if (!hotkey || netuid == null || shareFraction == null || stakeTao == null) return null;
  return { hotkey, netuid, share_fraction: shareFraction, stake_tao: stakeTao };
}

/**
 * #5233: the coldkey-scoped counterpart to accountPortfolioQuery. NOT a live
 * query -- see AccountPositions' own doc comment (types.ts) for the
 * daily/weekly-scan + zero-root-coverage caveats. Callers using this to
 * prefill a stake/unstake "Max" amount must surface captured_at as a
 * staleness label, and must not offer Max at all for netuid 0.
 */
export const accountPositionsQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-positions", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/accounts/${ss58PathSegment(ss58)}/positions`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const positions = Array.isArray(d.positions)
        ? d.positions.slice(0, MAX_ACCOUNT_POSITIONS).flatMap((position) => {
            const normalized = normalizeAccountPosition(position);
            return normalized ? [normalized] : [];
          })
        : [];
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          captured_at: firstString(d.captured_at) ?? null,
          position_count: firstFiniteNumber(d.position_count) ?? positions.length,
          total_stake_alpha: firstFiniteNumber(d.total_stake_alpha) ?? 0,
          positions,
        } as AccountPositions,
        meta: res.meta,
        url: res.url,
      } as ApiResult<AccountPositions>;
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

// #3365: network-wide economics rollup day. Distinct source (subnet_snapshots)
// from the chain-indexer days above, so only `snapshot_date` is required —
// every metric is independently null-able (a day can have subnets reporting
// counts but no price, etc.), mirroring the backend's per-metric null-safety.
function normalizeEconomicsTrendsDay(raw: unknown): EconomicsTrendsDay | null {
  if (!isRecord(raw)) return null;
  const snapshotDate = firstString(raw.snapshot_date);
  const subnetCount = coerceFiniteNumber(raw.subnet_count);
  if (!snapshotDate || subnetCount == null) return null;
  return {
    snapshot_date: snapshotDate,
    subnet_count: subnetCount,
    total_stake_alpha: coerceFiniteNumber(raw.total_stake_alpha) ?? null,
    alpha_price_tao_weighted: coerceFiniteNumber(raw.alpha_price_tao_weighted) ?? null,
    alpha_price_tao_median: coerceFiniteNumber(raw.alpha_price_tao_median) ?? null,
    validator_count: coerceFiniteNumber(raw.validator_count) ?? null,
    miner_count: coerceFiniteNumber(raw.miner_count) ?? null,
    mean_emission_share: coerceFiniteNumber(raw.mean_emission_share) ?? null,
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
    signed_extrinsic_count: coerceFiniteNumber(raw.signed_extrinsic_count) ?? null,
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

// #3365: network-wide economics rollup (GET /api/v1/economics/trends), a distinct
// data source (subnet_snapshots) from the chain-indexer series above. The endpoint
// itself accepts a wider window vocabulary (7d/30d/90d/1y/all); this reuses
// ChainWindow ("7d" | "30d") to match the explorer page's existing window toggle
// rather than introducing a second, unused range.
export const economicsTrendsQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("economics-trends", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/economics/trends", {
        params: { window },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window: firstString(d.window) ?? window,
          day_count: firstFiniteNumber(d.day_count) ?? 0,
          days: normalizeChainRows(d.days, MAX_ECONOMICS_TRENDS_DAYS, normalizeEconomicsTrendsDay),
        } as EconomicsTrends,
        meta: res.meta,
        url: res.url,
      } as ApiResult<EconomicsTrends>;
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

function normalizeChainIdentityChange(raw: unknown): ChainIdentityChange | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    identity_hash: firstString(raw.identity_hash) ?? "",
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

// #3474: network-wide feed of recent subnet-identity changes, newest first.
// Malformed rows (no netuid) drop out; a cold store yields an empty list.
export function normalizeChainIdentityHistory(raw: unknown): ChainIdentityHistory {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    count: firstFiniteNumber(rec.count) ?? 0,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    changes: normalizeChainRows(
      rec.changes,
      MAX_CHAIN_IDENTITY_CHANGES,
      normalizeChainIdentityChange,
    ),
  };
}

/** Network-wide feed of recent subnet-identity changes (name/symbol/etc. edits). */
export const chainIdentityHistoryQuery = (limit = 10) =>
  queryOptions({
    queryKey: k("chain-identity-history", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainIdentityHistory>>("/api/v1/chain/identity-history", {
        params: { limit },
        signal,
      });
      return {
        data: normalizeChainIdentityHistory(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainIdentityHistory>;
    },
    staleTime: STALE_MED,
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
// /api/v1/chain-events/stats — the raw-tier sibling of chainCallsQuery's store
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

// #3475: network-wide native-TAO transfer-volume leaderboard -- separate
// top-senders/top-receivers rankings, distinct from chainTransferPairsQuery's
// directed sender->receiver corridors (#3476, a different endpoint/shape).
function normalizeChainTransferEntry(raw: unknown): ChainTransferEntry | null {
  if (!isRecord(raw)) return null;
  const address = firstString(raw.address);
  const volumeTao = coerceFiniteNumber(raw.volume_tao);
  const transferCount = coerceFiniteNumber(raw.transfer_count);
  if (!address || !isValidSs58(address) || volumeTao == null || transferCount == null) {
    return null;
  }
  return {
    address: address.trim(),
    volume_tao: volumeTao,
    transfer_count: transferCount,
  };
}

export const chainTransfersQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-transfers", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/transfers", {
        params: { window, limit: 25 },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: 1,
          window,
          observed_at: firstString(d.observed_at) ?? null,
          total_volume_tao: firstFiniteNumber(d.total_volume_tao) ?? 0,
          transfer_count: firstFiniteNumber(d.transfer_count) ?? 0,
          unique_senders: firstFiniteNumber(d.unique_senders) ?? 0,
          unique_receivers: firstFiniteNumber(d.unique_receivers) ?? 0,
          top_sender_share: firstFiniteNumber(d.top_sender_share) ?? null,
          top_senders: normalizeChainRows(
            d.top_senders,
            MAX_CHAIN_TRANSFERS,
            normalizeChainTransferEntry,
          ),
          top_receivers: normalizeChainRows(
            d.top_receivers,
            MAX_CHAIN_TRANSFERS,
            normalizeChainTransferEntry,
          ),
        } as ChainTransfers,
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainTransfers>;
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainWeightSetters(raw: unknown, window: ChainWindow): ChainWeightSetters {
  const rec = isRecord(raw) ? raw : {};
  const setters = (Array.isArray(rec.setters) ? rec.setters : [])
    .map((row) => {
      const setter = normalizeSubnetWeightSetter(row);
      if (!setter) return null;
      const rec = isRecord(row) ? row : {};
      return { ...setter, netuid: setter.hotkey ? null : (firstFiniteNumber(rec.netuid) ?? null) };
    })
    .filter((setter): setter is ChainWeightSetter => setter != null)
    .slice(0, MAX_CHAIN_WEIGHT_SETTERS);
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? window,
    observed_at: firstString(rec.observed_at) ?? null,
    distinct_setters: firstFiniteNumber(rec.distinct_setters) ?? 0,
    weight_sets: firstFiniteNumber(rec.weight_sets) ?? 0,
    setter_count: firstFiniteNumber(rec.setter_count) ?? setters.length,
    setters,
  };
}

export const chainWeightSettersQuery = (window: ChainWindow = "7d") =>
  queryOptions({
    queryKey: k("chain-weight-setters", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/chain/weights/setters", {
        params: { window, limit: 20 },
        signal,
      });
      return {
        data: normalizeChainWeightSetters(res.data, window),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainWeightSetters>;
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
    median: firstFiniteNumber(raw.p50) ?? 0,
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

function normalizeChainAxonRemovalSubnet(raw: unknown): ChainAxonRemovalSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_removers: firstFiniteNumber(raw.distinct_removers) ?? 0,
    removals: firstFiniteNumber(raw.removals) ?? 0,
    removals_per_remover: firstFiniteNumber(raw.removals_per_remover) ?? null,
  };
}

// #3464: network-wide axon-teardown ("churn") leaderboard over a 7d/30d window —
// the teardown-side complement of the serving leaderboard. Every numeric cell
// coerces defensively: counts fall through to 0, averages to null (never NaN),
// and malformed subnet rows are dropped on a cold store or junk.
export function normalizeChainAxonRemovals(raw: unknown): ChainAxonRemovals {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_removers: firstFiniteNumber(networkRec.distinct_removers) ?? 0,
      removals: firstFiniteNumber(networkRec.removals) ?? 0,
      removals_per_remover: firstFiniteNumber(networkRec.removals_per_remover) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(
      rec.subnets,
      MAX_CHAIN_AXON_REMOVALS,
      normalizeChainAxonRemovalSubnet,
    ),
  };
}

export const chainAxonRemovalsQuery = (window = "7d", limit = 20) =>
  queryOptions({
    queryKey: k("chain-axon-removals", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainAxonRemovals>>("/api/v1/chain/axon-removals", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainAxonRemovals(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeChainDeregistrationsSubnet(raw: unknown): ChainDeregistrationsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_deregistered_hotkeys: firstFiniteNumber(raw.distinct_deregistered_hotkeys) ?? 0,
    deregistrations: firstFiniteNumber(raw.deregistrations) ?? 0,
    deregistrations_per_hotkey: firstFiniteNumber(raw.deregistrations_per_hotkey) ?? null,
  };
}

function normalizeChainRegistrationsSubnet(raw: unknown): ChainRegistrationsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_registrants: firstFiniteNumber(raw.distinct_registrants) ?? 0,
    registrations: firstFiniteNumber(raw.registrations) ?? 0,
    registrations_per_registrant: firstFiniteNumber(raw.registrations_per_registrant) ?? null,
  };
}

// #3465: network-wide neuron-registration leaderboard over a 7d/30d window — the
// entry-side twin of /api/v1/chain/deregistrations. Every numeric cell coerces
// defensively: counts fall through to 0, averages to null (never NaN), and
// malformed subnet rows are dropped on a cold store or junk.
export function normalizeChainRegistrations(raw: unknown): ChainRegistrations {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_registrants: firstFiniteNumber(networkRec.distinct_registrants) ?? 0,
      registrations: firstFiniteNumber(networkRec.registrations) ?? 0,
      registrations_per_registrant:
        firstFiniteNumber(networkRec.registrations_per_registrant) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(
      rec.subnets,
      MAX_CHAIN_REGISTRATIONS,
      normalizeChainRegistrationsSubnet,
    ),
  };
}

export const chainRegistrationsQuery = (window: ChainWindow = "7d", limit = 100) =>
  queryOptions({
    queryKey: k("chain-registrations", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainRegistrations>>("/api/v1/chain/registrations", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainRegistrations(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeChainServingSubnet(raw: unknown): ChainServingSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_servers: firstFiniteNumber(raw.distinct_servers) ?? 0,
    announcements: firstFiniteNumber(raw.announcements) ?? 0,
    announcements_per_server: firstFiniteNumber(raw.announcements_per_server) ?? null,
  };
}

// #3463: network-wide axon-serving leaderboard over a 7d/30d window.
export function normalizeChainServing(raw: unknown): ChainServing {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_servers: firstFiniteNumber(networkRec.distinct_servers) ?? 0,
      announcements: firstFiniteNumber(networkRec.announcements) ?? 0,
      announcements_per_server: firstFiniteNumber(networkRec.announcements_per_server) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(rec.subnets, MAX_CHAIN_SERVING, normalizeChainServingSubnet),
  };
}

export const chainServingQuery = (window: ChainWindow = "7d", limit = 20) =>
  queryOptions({
    queryKey: k("chain-serving", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainServing>>("/api/v1/chain/serving", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainServing(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

function normalizeChainPrometheusSubnet(raw: unknown): ChainPrometheusSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_exporters: firstFiniteNumber(raw.distinct_exporters) ?? 0,
    announcements: firstFiniteNumber(raw.announcements) ?? 0,
    announcements_per_exporter: firstFiniteNumber(raw.announcements_per_exporter) ?? null,
  };
}

// #3463: network-wide Prometheus-telemetry leaderboard over a 7d/30d window.
export function normalizeChainPrometheus(raw: unknown): ChainPrometheus {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_exporters: firstFiniteNumber(networkRec.distinct_exporters) ?? 0,
      announcements: firstFiniteNumber(networkRec.announcements) ?? 0,
      announcements_per_exporter: firstFiniteNumber(networkRec.announcements_per_exporter) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(rec.subnets, MAX_CHAIN_PROMETHEUS, normalizeChainPrometheusSubnet),
  };
}

export const chainPrometheusQuery = (window: ChainWindow = "7d", limit = 20) =>
  queryOptions({
    queryKey: k("chain-prometheus", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainPrometheus>>("/api/v1/chain/prometheus", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainPrometheus(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

// #3466: network-wide neuron-deregistration leaderboard over a 7d/30d window — the
// exit-side twin of /api/v1/chain/registrations. Every numeric cell coerces defensively:
// counts fall through to 0, averages to null (never NaN), and malformed subnet rows are
// dropped on a cold store or junk.
export function normalizeChainDeregistrations(raw: unknown): ChainDeregistrations {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_deregistered_hotkeys:
        firstFiniteNumber(networkRec.distinct_deregistered_hotkeys) ?? 0,
      deregistrations: firstFiniteNumber(networkRec.deregistrations) ?? 0,
      deregistrations_per_hotkey: firstFiniteNumber(networkRec.deregistrations_per_hotkey) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(
      rec.subnets,
      MAX_CHAIN_DEREGISTRATIONS,
      normalizeChainDeregistrationsSubnet,
    ),
  };
}

export const chainDeregistrationsQuery = (window: ChainWindow = "7d", limit = 100) =>
  queryOptions({
    queryKey: k("chain-deregistrations", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainDeregistrations>>("/api/v1/chain/deregistrations", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainDeregistrations(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeChainWeightsSubnet(raw: unknown): ChainWeightsSubnet | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return null;
  return {
    netuid,
    distinct_setters: firstFiniteNumber(raw.distinct_setters) ?? 0,
    weight_sets: firstFiniteNumber(raw.weight_sets) ?? 0,
    sets_per_setter: firstFiniteNumber(raw.sets_per_setter) ?? null,
  };
}

// Network-wide validator weight-setting leaderboard over a 7d/30d window — the account_events
// WeightsSet twin of /api/v1/chain/deregistrations. Every numeric cell coerces defensively:
// counts fall through to 0, the per-setter average to null (never NaN), and malformed subnet
// rows are dropped on a cold store or junk.
export function normalizeChainWeights(raw: unknown): ChainWeights {
  const rec = isRecord(raw) ? raw : {};
  const networkRec = isRecord(rec.network) ? rec.network : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    network: {
      distinct_setters: firstFiniteNumber(networkRec.distinct_setters) ?? 0,
      weight_sets: firstFiniteNumber(networkRec.weight_sets) ?? 0,
      sets_per_setter: firstFiniteNumber(networkRec.sets_per_setter) ?? null,
    },
    intensity_distribution: normalizeChainIntensityDistribution(rec.intensity_distribution),
    subnets: normalizeChainRows(rec.subnets, MAX_CHAIN_WEIGHTS, normalizeChainWeightsSubnet),
  };
}

// limit is the leaderboard page size (the endpoint's own default); MAX_CHAIN_WEIGHTS is a separate
// defensive ceiling on the normalized array, not the request size.
export const chainWeightsQuery = (window: ChainWindow = "7d", limit = 20) =>
  queryOptions({
    queryKey: k("chain-weights", window, limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainWeights>>("/api/v1/chain/weights", {
        params: { window, limit },
        signal,
      });
      return {
        data: normalizeChainWeights(res.data),
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
    median: coerceFiniteNumber(raw.p50) ?? null,
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
    median: coerceFiniteNumber(raw.p50) ?? null,
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

  // Probe health is overlay-only (`subnetHealthMapQuery` / `subnetHealthQuery`).
  // Never map chain lifecycle `status` ("active") through statusToHealth — that
  // collides with HealthState and left page pills stuck on "unknown" (#5332).
  const probeHealth =
    statusToHealth(subnet.health) ?? statusToHealth(profile.health) ?? statusToHealth(root.health);

  return {
    netuid: (subnet.netuid as number) ?? (profile.netuid as number) ?? netuid,
    name: pickStr(profile.name, subnet.name, subnet.native_name, profile.native_name),
    slug: pickStr(profile.slug, subnet.slug, subnet.native_slug),
    native_name: pickStr(subnet.native_name, profile.native_name),
    icon_url: pickStr(profile.icon_url as string, subnet.logo_url as string),
    symbol: pickStr(subnet.symbol),
    // #8363: copy-paste bug -- description was reading subnet.notes (curator
    // review-provenance text, e.g. "Reviewed overlay for SN8 Vanta using...")
    // instead of the subnet's own description field, so the masthead's lede
    // paragraph showed internal curation notes as if they were the product
    // description. derived_description (scripts/build-artifacts.ts) is the
    // existing, intentionally-separate notes-derived fallback for the ~28
    // subnets with no real description -- a short blurb, not raw provenance.
    description: pickStr(subnet.description, profile.derived_description),
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
    // dev activity (#8379) — present on both `profile` and the embedded
    // `subnet` sub-object (mergeSubnet's own spread, #6639); prefer `profile`,
    // fall back to `subnet` for older cached payloads mid-rollout.
    github_last_push_at:
      pickStr(profile.github_last_push_at as string, subnet.github_last_push_at as string) ?? null,
    github_stars:
      typeof profile.github_stars === "number"
        ? (profile.github_stars as number)
        : typeof subnet.github_stars === "number"
          ? (subnet.github_stars as number)
          : null,
    github_unreachable: Boolean(profile.github_unreachable ?? subnet.github_unreachable),
    // embedded
    surfaces: (root.surfaces as Surface[]) ?? [],
    endpoints: (root.endpoints as Endpoint[]) ?? [],
    candidate_surfaces: (root.candidate_surfaces as Candidate[]) ?? [],
    // Optional only when the profile payload itself carries probe health; page
    // chrome should prefer useSubnetProbeHealth / resolveSubnetProbeHealth.
    health: probeHealth,
  } as SubnetProfile;
}

export const subnetProfileQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-profile", netuid),
    queryFn: async ({ signal }) => {
      // The page reads identity, links, counts, and descriptive metadata from
      // `profile`/`subnet`. Surfaces, endpoints, and candidates each have their
      // own independently cached section query below. Asking the profile
      // endpoint for all seven sections made SN19's request 115 KB instead of
      // 8 KB and then dehydrated three duplicate collections into the HTML.
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/profile`, {
        params: { sections: "profile,subnet" },
        signal,
      });
      const profile = normalizeSubnetProfile(res.data, netuid);
      return {
        // The production projection omits these already. Explicitly omit them
        // here too so an older server or the pathname-only E2E fixture cannot
        // put duplicate collections back into SSR dehydration.
        data: {
          ...profile,
          candidate_surfaces: undefined,
          endpoints: undefined,
          surfaces: undefined,
        },
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

// #4339/8.1: rolling 24h buy/sell alpha volume scorecard, summed live from the
// same account_events stream as stake-flow. A cold store returns all-zero
// totals (never 404); sentiment_ratio/vol_mcap_ratio stay null rather than 0
// when their inputs are unavailable (0 is a real "no lean"/"no data" value).
function normalizeSubnetAlphaVolume(netuid: number, raw: unknown): SubnetAlphaVolume {
  const d = isRecord(raw) ? raw : {};
  const sentiment = firstString(d.sentiment);
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    window: firstString(d.window) ?? "24h",
    buy_volume_alpha: coerceFiniteNumber(d.buy_volume_alpha) ?? 0,
    sell_volume_alpha: coerceFiniteNumber(d.sell_volume_alpha) ?? 0,
    total_volume_alpha: coerceFiniteNumber(d.total_volume_alpha) ?? 0,
    buy_volume_tao: coerceFiniteNumber(d.buy_volume_tao) ?? 0,
    sell_volume_tao: coerceFiniteNumber(d.sell_volume_tao) ?? 0,
    total_volume_tao: coerceFiniteNumber(d.total_volume_tao) ?? 0,
    buy_count: firstFiniteNumber(d.buy_count) ?? 0,
    sell_count: firstFiniteNumber(d.sell_count) ?? 0,
    net_volume_alpha: coerceFiniteNumber(d.net_volume_alpha) ?? 0,
    sentiment_ratio: coerceFiniteNumber(d.sentiment_ratio) ?? null,
    sentiment: sentiment === "bullish" || sentiment === "bearish" ? sentiment : "neutral",
    vol_mcap_ratio: coerceFiniteNumber(d.vol_mcap_ratio) ?? null,
  };
}

// GET /api/v1/subnets/{netuid}/volume (#4339/8.1): rolling 24h buy vs sell
// alpha volume, unsigned (buy + sell, never netted) — a market-depth figure,
// distinct from the cumulative subnet_volume_tao already shown in economics.
export const subnetAlphaVolumeQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-alpha-volume", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetAlphaVolume>>(`/api/v1/subnets/${netuid}/volume`, {
        signal,
      });
      return { data: normalizeSubnetAlphaVolume(netuid, res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// Network-wide rollup of the same sentiment_ratio/sentiment reading
// normalizeSubnetAlphaVolume computes per-subnet, just summed across the
// whole network first (#6642's "network mood" gauge). A cold store returns
// zeroed totals + a "neutral" reading, never throws.
function normalizeChainAlphaVolumeNetwork(raw: unknown): ChainAlphaVolumeNetwork {
  const d = isRecord(raw) ? raw : {};
  const sentiment = firstString(d.sentiment);
  return {
    buy_volume_alpha: coerceFiniteNumber(d.buy_volume_alpha) ?? 0,
    sell_volume_alpha: coerceFiniteNumber(d.sell_volume_alpha) ?? 0,
    total_volume_alpha: coerceFiniteNumber(d.total_volume_alpha) ?? 0,
    buy_volume_tao: coerceFiniteNumber(d.buy_volume_tao) ?? 0,
    sell_volume_tao: coerceFiniteNumber(d.sell_volume_tao) ?? 0,
    total_volume_tao: coerceFiniteNumber(d.total_volume_tao) ?? 0,
    buy_count: firstFiniteNumber(d.buy_count) ?? 0,
    sell_count: firstFiniteNumber(d.sell_count) ?? 0,
    net_volume_alpha: coerceFiniteNumber(d.net_volume_alpha) ?? 0,
    sentiment_ratio: coerceFiniteNumber(d.sentiment_ratio) ?? null,
    sentiment: sentiment === "bullish" || sentiment === "bearish" ? sentiment : "neutral",
  };
}

export function normalizeChainAlphaVolume(raw: unknown): ChainAlphaVolume {
  const d = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    window: firstString(d.window) ?? "24h",
    observed_at: firstString(d.observed_at) ?? null,
    subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
    network: normalizeChainAlphaVolumeNetwork(d.network),
    volume_distribution: normalizeChainAlphaVolumeDistribution(d.volume_distribution),
    subnets: Array.isArray(d.subnets) ? (d.subnets as SubnetAlphaVolume[]) : [],
  };
}

// GET /api/v1/chain/alpha-volume (#4339/8.2): network-wide rolling 24h
// buy/sell alpha volume, ranked by total_volume_tao -- the network.sentiment_ratio/
// sentiment fields are the "network mood" gauge's data source (#6642), reused
// as-is rather than recomputed client-side.
export const chainAlphaVolumeQuery = () =>
  queryOptions({
    queryKey: k("chain-alpha-volume"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainAlphaVolume>>("/api/v1/chain/alpha-volume", {
        signal,
      });
      return { data: normalizeChainAlphaVolume(res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// A finite candle field, or 0 -- matches normalizeSubnetAlphaVolume's own
// "0 is a real value" convention for volume/count fields (unlike
// sentiment_ratio/vol_mcap_ratio, which stay null to distinguish "no data"
// from "genuinely zero").
export function normalizeSubnetOhlcCandle(raw: unknown): SubnetOhlcCandle | null {
  if (!isRecord(raw)) return null;
  const bucketStart = firstFiniteNumber(raw.bucket_start);
  if (bucketStart == null) return null;
  return {
    bucket_start: bucketStart,
    bucket_start_iso: firstString(raw.bucket_start_iso) ?? new Date(bucketStart).toISOString(),
    open: coerceFiniteNumber(raw.open) ?? 0,
    high: coerceFiniteNumber(raw.high) ?? 0,
    low: coerceFiniteNumber(raw.low) ?? 0,
    close: coerceFiniteNumber(raw.close) ?? 0,
    volume_alpha: coerceFiniteNumber(raw.volume_alpha) ?? 0,
    volume_tao: coerceFiniteNumber(raw.volume_tao) ?? 0,
    event_count: firstFiniteNumber(raw.event_count) ?? 0,
  };
}

// Cold/absent store, an empty window, or root (netuid 0) all yield a
// schema-stable empty candles array -- never throws. A malformed individual
// candle row is dropped rather than poisoning the whole series.
export function normalizeSubnetOhlc(netuid: number, _interval: string, raw: unknown): SubnetOhlc {
  const d = isRecord(raw) ? raw : {};
  const candles = Array.isArray(d.candles)
    ? d.candles.map(normalizeSubnetOhlcCandle).filter((c): c is SubnetOhlcCandle => c != null)
    : [];
  const normalizedInterval = d.interval === "1d" ? "1d" : "1h";
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    interval: normalizedInterval,
    candles,
    root_excluded: d.root_excluded === true || netuid === 0,
  };
}

export interface SubnetOhlcParams {
  interval?: "1h" | "1d";
  /** Lookback window in days (server clamps to [1, 365], default 90). */
  days?: number;
}

// GET /api/v1/subnets/{netuid}/ohlc (#5655): open/high/low/close/volume
// candles from the same account_events stream /volume reads, bucketed by
// ?interval=. Root (netuid 0) always normalizes to root_excluded:true with
// an empty series, matching the server's own short-circuit.
export const subnetOhlcQuery = (netuid: number, params: SubnetOhlcParams = {}) => {
  const interval = params.interval ?? "1h";
  return queryOptions({
    queryKey: k("subnet-ohlc", netuid, interval, params.days ?? null),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetOhlc>>(`/api/v1/subnets/${netuid}/ohlc`, {
        params: { interval, days: params.days },
        signal,
      });
      return {
        data: normalizeSubnetOhlc(netuid, interval, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });
};

// A well-formed leaderboard entry, or null to drop a malformed row rather
// than poisoning the whole leaderboard -- mirrors normalizeSubnetOhlcCandle.
export function normalizeSubnetConvictionEntry(raw: unknown): SubnetConvictionEntry | null {
  if (!isRecord(raw)) return null;
  const hotkey = firstString(raw.hotkey);
  if (!hotkey) return null;
  return {
    hotkey,
    is_owner: raw.is_owner === true,
    locked_mass: coerceFiniteNumber(raw.locked_mass) ?? 0,
    conviction: coerceFiniteNumber(raw.conviction) ?? 0,
  };
}

// Cold/absent store or a subnet with no active challengers both yield a
// schema-stable empty leaderboard -- never throws, matching the OHLC/volume
// live-tier convention.
export function normalizeSubnetConviction(netuid: number, raw: unknown): SubnetConviction {
  const d = isRecord(raw) ? raw : {};
  const leaderboard = Array.isArray(d.leaderboard)
    ? d.leaderboard
        .map(normalizeSubnetConvictionEntry)
        .filter((e): e is SubnetConvictionEntry => e != null)
    : [];
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    queried_at_block: firstFiniteNumber(d.queried_at_block) ?? null,
    unlock_rate: firstFiniteNumber(d.unlock_rate) ?? null,
    maturity_rate: firstFiniteNumber(d.maturity_rate) ?? null,
    king: firstString(d.king) ?? null,
    count: firstFiniteNumber(d.count) ?? leaderboard.length,
    leaderboard,
  };
}

// GET /api/v1/subnets/{netuid}/conviction (#6638): live ownership-contest
// leaderboard, rolled forward to query time using the current governance
// UnlockRate/MaturityRate. Most subnets have no active challengers, so an
// empty leaderboard is the common case, not an error.
export const subnetConvictionQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-conviction", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetConviction>>(
        `/api/v1/subnets/${netuid}/conviction`,
        { signal },
      );
      return { data: normalizeSubnetConviction(netuid, res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// A well-formed holder row, or null to drop a malformed one rather than
// poisoning the whole leaderboard -- mirrors normalizeSubnetConvictionEntry.
//
// `alpha` defaults to 0 because a row that reached here named a coldkey, and a
// holder with an unreadable amount is still a holder. The two SHARE fields do
// NOT default: null means "no share to state" (the subnet's measured total is
// zero) and 0 would claim the holder owns none of it.
export function normalizeSubnetHolderEntry(raw: unknown): SubnetHolderEntry | null {
  if (!isRecord(raw)) return null;
  const coldkey = firstString(raw.coldkey);
  if (!coldkey) return null;
  return {
    coldkey,
    alpha: coerceFiniteNumber(raw.alpha) ?? 0,
    share_of_total: firstFiniteNumber(raw.share_of_total) ?? null,
    hotkey_count: firstFiniteNumber(raw.hotkey_count) ?? null,
  };
}

// Cold/absent store, a DECLINE, and a subnet with genuinely no holders all
// yield a schema-stable card -- never throws.
//
// THE AGGREGATES STAY NULL WHEN THEY ARE NULL. `?? 0` on any of them would turn
// "we could not rank this subnet" into "this subnet has 0 holders holding 0
// alpha", which is the exact confusion the route's `degraded` block exists to
// prevent, recreated one layer up. `degraded` is preserved verbatim for the
// same reason: it is the only thing distinguishing a decline from a
// measurement, since both carry an empty `holders`.
export function normalizeSubnetHolders(netuid: number, raw: unknown): SubnetHolders {
  const d = isRecord(raw) ? raw : {};
  const holders = Array.isArray(d.holders)
    ? d.holders.map(normalizeSubnetHolderEntry).filter((e): e is SubnetHolderEntry => e != null)
    : [];
  const c = isRecord(d.concentration) ? d.concentration : {};
  const reason = isRecord(d.degraded) ? firstString(d.degraded.reason) : null;
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    limit: firstFiniteNumber(d.limit) ?? null,
    holder_count: firstFiniteNumber(d.holder_count) ?? null,
    total_alpha: firstFiniteNumber(d.total_alpha) ?? null,
    concentration: {
      top5_share: firstFiniteNumber(c.top5_share) ?? null,
      top10_share: firstFiniteNumber(c.top10_share) ?? null,
      top20_share: firstFiniteNumber(c.top20_share) ?? null,
    },
    captured_at: firstString(d.captured_at) ?? null,
    positions_captured_at: firstString(d.positions_captured_at) ?? null,
    holders,
    degraded: reason ? { reason } : null,
  };
}

// GET /api/v1/subnets/{netuid}/holders (#9557): who owns this subnet's alpha,
// ranked by alpha held, INCLUDING alpha staked to hotkeys that hold no UID on
// the subnet -- the part /concentration cannot see, since it reads registered
// UIDs' stake. Declines rather than serving an empty ranking while the pool
// ledger is unproven, so `degraded` has to survive normalization.
export const subnetHoldersQuery = (netuid: number, limit?: number) =>
  queryOptions({
    queryKey: k("subnet-holders", netuid, limit ?? null),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetHolders>>(`/api/v1/subnets/${netuid}/holders`, {
        params: limit == null ? undefined : { limit: String(limit) },
        signal,
      });
      return { data: normalizeSubnetHolders(netuid, res.data), meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

// A well-formed ownership-change row, or null to drop a malformed row rather
// than poisoning the whole history -- mirrors normalizeSubnetOhlcCandle.
export function normalizeSubnetOwnershipChange(raw: unknown): SubnetOwnershipChange | null {
  if (!isRecord(raw)) return null;
  if (raw.old_coldkey == null && raw.new_coldkey == null && raw.block_number == null) return null;
  return {
    netuid: firstFiniteNumber(raw.netuid) ?? null,
    old_coldkey: firstString(raw.old_coldkey) ?? null,
    new_coldkey: firstString(raw.new_coldkey) ?? null,
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
  };
}

// Cold/absent store or a subnet that has never changed hands both yield a
// schema-stable empty history -- never throws, matching the OHLC/volume
// live-tier convention.
export function normalizeSubnetOwnershipHistory(
  netuid: number,
  raw: unknown,
): SubnetOwnershipHistory {
  const d = isRecord(raw) ? raw : {};
  const changes = Array.isArray(d.ownership_changes)
    ? d.ownership_changes
        .map(normalizeSubnetOwnershipChange)
        .filter((c): c is SubnetOwnershipChange => c != null)
    : [];
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    event_pallet: firstString(d.event_pallet) ?? "SubtensorModule",
    event_method: firstString(d.event_method) ?? "SubnetOwnerChanged",
    count: firstFiniteNumber(d.count) ?? changes.length,
    ownership_changes: changes,
  };
}

// GET /api/v1/subnets/{netuid}/ownership-history (#6637): every automatic
// ownership transfer this subnet has undergone, oldest first. A subnet that
// has never changed hands is the common case, not an error.
export const subnetOwnershipHistoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-ownership-history", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetOwnershipHistory>>(
        `/api/v1/subnets/${netuid}/ownership-history`,
        { signal },
      );
      return {
        data: normalizeSubnetOwnershipHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeSubnetLeaseTerms(raw: unknown): SubnetLeaseTerms | null {
  if (!isRecord(raw)) return null;
  const leaseId = firstFiniteNumber(raw.lease_id);
  const beneficiary = firstString(raw.beneficiary);
  const coldkey = firstString(raw.coldkey);
  const hotkey = firstString(raw.hotkey);
  const netuid = firstFiniteNumber(raw.netuid);
  if (leaseId == null || !beneficiary || !coldkey || !hotkey || netuid == null) return null;
  return {
    lease_id: leaseId,
    beneficiary,
    coldkey,
    hotkey,
    emissions_share_percent: firstFiniteNumber(raw.emissions_share_percent) ?? 0,
    end_block: firstFiniteNumber(raw.end_block) ?? null,
    netuid,
    cost_tao: coerceFiniteNumber(raw.cost_tao) ?? 0,
    // Preserve null (sub-read failure) — never coerce to 0.
    accumulated_dividends_alpha: coerceFiniteNumber(raw.accumulated_dividends_alpha) ?? null,
  };
}

// #6993: live lease state. `leased: null` means RPC failure (distinct from
// confirmed no-lease). Missing/junk `leased` also degrades to null so we
// never invent a "not leased" signal from a broken payload.
export function normalizeSubnetLeaseState(netuid: number, raw: unknown): SubnetLeaseState {
  const d = isRecord(raw) ? raw : {};
  const leasedRaw = d.leased;
  const leased: boolean | null = leasedRaw === true || leasedRaw === false ? leasedRaw : null;
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    leased,
    lease: normalizeSubnetLeaseTerms(d.lease),
    queried_at: firstString(d.queried_at) ?? null,
  };
}

/**
 * What it costs to hold a validator permit on this subnet, and to earn (#10300).
 *
 * PERMIT AND EARNING ARE DIFFERENT THRESHOLDS and the gap between them is the
 * point: holding a permit does not mean earning, so the route publishes both
 * floors and the multiple between them rather than one "validator cost".
 */
export const subnetValidatorEconomicsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-validator-economics", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/subnets/${netuid}/validator-economics`,
        { signal },
      );
      return {
        data: normalizeSubnetValidatorEconomics(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/** The same thresholds over time, so a reader sees which way they are moving. */
export const subnetValidatorEconomicsHistoryQuery = (netuid: number, window: string) =>
  queryOptions({
    queryKey: k("subnet-validator-economics-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ points?: unknown }>(
        `/api/v1/subnets/${netuid}/validator-economics/history?window=${encodeURIComponent(window)}`,
        { signal },
      );
      const raw = isRecord(res.data) ? res.data.points : null;
      const points = (Array.isArray(raw) ? raw : [])
        .map(normalizeValidatorEconomicsPoint)
        .filter((p): p is SubnetValidatorEconomicsPoint => p !== null);
      return { data: points, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function normalizeSubnetValidatorEconomics(raw: unknown): SubnetValidatorEconomics | null {
  if (!isRecord(raw)) return null;
  const composition = isRecord(raw.composition) ? raw.composition : {};
  const takes = isRecord(raw.takes) ? raw.takes : {};
  return {
    netuid: firstFiniteNumber(raw.netuid) ?? null,
    permit_floor_cost_tao: firstFiniteNumber(raw.permit_floor_cost_tao) ?? null,
    earning_floor_cost_tao: firstFiniteNumber(raw.earning_floor_cost_tao) ?? null,
    permit_to_earning_multiple: firstFiniteNumber(raw.permit_to_earning_multiple) ?? null,
    max_validators: firstFiniteNumber(raw.max_validators) ?? null,
    validator_slots_open: firstFiniteNumber(raw.validator_slots_open) ?? null,
    // Three DIFFERENT sets, never collapsed: permitted, active and earning
    // answer "how many validators does this subnet have" three defensible ways.
    permitted: firstFiniteNumber(composition.permitted) ?? null,
    active: firstFiniteNumber(composition.active) ?? null,
    earning: firstFiniteNumber(composition.earning) ?? null,
    median_take: firstFiniteNumber(takes.median) ?? null,
    // `cap_binding` is the one that changes what a reader should do: slots open
    // is meaningless when the cap is what is holding entry back.
    cap_binding: typeof raw.cap_binding === "boolean" ? raw.cap_binding : null,
  };
}

function normalizeValidatorEconomicsPoint(raw: unknown): SubnetValidatorEconomicsPoint | null {
  if (!isRecord(raw)) return null;
  // A point with no date cannot be placed on a timeline, so it is dropped
  // rather than rendered at an arbitrary position.
  const date = firstString(raw.snapshot_date);
  if (date === null || date === undefined) return null;
  return {
    snapshot_date: date,
    permit_floor_alpha: firstFiniteNumber(raw.permit_floor_alpha) ?? null,
    earning_floor_alpha: firstFiniteNumber(raw.earning_floor_alpha) ?? null,
    validators_permitted: firstFiniteNumber(raw.validators_permitted) ?? null,
    validators_earning: firstFiniteNumber(raw.validators_earning) ?? null,
    emission_gate_open: typeof raw.emission_gate_open === "boolean" ? raw.emission_gate_open : null,
  };
}

/**
 * The registry's own intake pipeline (#10300).
 *
 * `/api/v1/candidates`, `/api/v1/curation`, `/api/v1/profiles` and
 * `/api/v1/source-snapshots` were all published and rendered nowhere. They are
 * the four stages of how a surface gets into this registry, and #10300's point
 * about them is the one that matters: "no page exists" and "no page should
 * exist" are indistinguishable from outside. This is the page.
 *
 * ## THE COUNT DOES NOT COME FROM AN ARRAY LENGTH
 *
 * `/api/v1/candidates` is 3.6MB unlimited, and it accepts `?limit=` -- but NO
 * total survives the trim. The response is `{candidates, generated_at, notes,
 * schema_version}`, so a limited fetch counted by `candidates.length` silently
 * reports the LIMIT as the total. Fetching it whole just to count it would be
 * 3.6MB for one number, and adding a limit later would quietly make that number
 * wrong -- the exact "confident wrong figure" this whole panel is about.
 *
 * So the total comes from `source-snapshots`, whose `summary.candidate_count`
 * is server-computed (2,184, verified equal to the full array on 2026-08-10) in
 * a 17KB payload, and the list routes are fetched BOUNDED as samples. Nothing
 * here derives a total from a list it truncated.
 */
const PIPELINE_SAMPLE = 12;

export const registryPipelineQuery = () =>
  queryOptions({
    queryKey: k("registry-pipeline"),
    queryFn: async ({ signal }) => {
      // Four independent reads. `allSettled`, not `all`: one stage being
      // unavailable must not blank the other three -- a pipeline view whose
      // whole point is showing where things stall would be useless if any
      // stalled stage took the view down with it.
      const [candidates, curation, profiles, snapshots] = await Promise.allSettled([
        apiFetch<Record<string, unknown>>(`/api/v1/candidates?limit=${PIPELINE_SAMPLE}`, {
          signal,
        }),
        apiFetch<Record<string, unknown>>("/api/v1/curation", { signal }),
        apiFetch<Record<string, unknown>>(`/api/v1/profiles?limit=${PIPELINE_SAMPLE}`, { signal }),
        apiFetch<Record<string, unknown>>("/api/v1/source-snapshots", { signal }),
      ]);
      const body = (r: PromiseSettledResult<{ data: unknown }>): Record<string, unknown> =>
        r.status === "fulfilled" && isRecord(r.value.data) ? r.value.data : {};
      const ok = (r: PromiseSettledResult<unknown>) => r.status === "fulfilled";

      const cand = body(candidates);
      const cur = body(curation);
      const prof = body(profiles);
      const snap = body(snapshots);
      const snapSummary = isRecord(snap.summary) ? snap.summary : {};

      // Curation is fetched WHOLE (158KB) because `gap_total` is a sum over
      // every curated subnet -- a sum over a truncated list is not a smaller
      // sum, it is a wrong one.
      const curationRows = Array.isArray(cur.curation) ? cur.curation : [];

      return {
        data: {
          candidates_reachable: ok(candidates),
          // From the SERVER's own total, never from the sample above.
          candidate_count: firstFiniteNumber(snapSummary.candidate_count) ?? null,
          recent_candidates: (Array.isArray(cand.candidates) ? cand.candidates : [])
            .map((raw): PipelineSample | null => {
              if (!isRecord(raw)) return null;
              const id = firstString(raw.id);
              if (!id) return null;
              return {
                id,
                name: firstString(raw.name) ?? firstString(raw.subnet_name) ?? null,
                detail: firstString(raw.state) ?? null,
              };
            })
            .filter((c): c is PipelineSample => c !== null),
          curation_reachable: ok(curation),
          curated_subnet_count: curationRows.length,
          // TWO LADDERS, not one. `coverage_level` is how much we have;
          // `curation_level` is how much of it a human has vouched for. A
          // subnet can be rich and unvouched, or thin and fully reviewed.
          gap_total: curationRows.reduce(
            (n, c) => n + (isRecord(c) ? (firstFiniteNumber(c.gap_count) ?? 0) : 0),
            0,
          ),
          profiles_reachable: ok(profiles),
          recent_profiles: (Array.isArray(prof.profiles) ? prof.profiles : [])
            .map((raw): PipelineSample | null => {
              if (!isRecord(raw)) return null;
              const netuid = firstFiniteNumber(raw.netuid);
              if (netuid === undefined) return null;
              const score = firstFiniteNumber(raw.completeness_score);
              return {
                id: `sn-${netuid}`,
                name: firstString(raw.name) ?? `SN${netuid}`,
                // ALREADY A PERCENTAGE (0-100, measured 25..97 across a live
                // sample on 2026-08-10), not a 0..1 ratio like every other
                // share on this API. Multiplying by 100 here rendered
                // "9000% complete" -- caught by checking a real payload rather
                // than assuming this field matched its neighbours.
                detail: score === undefined ? null : `${Math.round(score)}% complete`,
              };
            })
            .filter((p): p is PipelineSample => p !== null),
          snapshots_reachable: ok(snapshots),
          source_count: firstFiniteNumber(snapSummary.source_count) ?? null,
          verification_result_count:
            firstFiniteNumber(snapSummary.verification_result_count) ?? null,
          sources: (Array.isArray(snap.sources) ? snap.sources : [])
            .map((raw): SourceSnapshot | null => {
              if (!isRecord(raw)) return null;
              const id = firstString(raw.id);
              if (!id) return null;
              return {
                id,
                kind: firstString(raw.kind) ?? null,
                // The hash is what makes a snapshot auditable rather than
                // merely dated -- two captures with the same hash saw the same
                // bytes, which a timestamp alone cannot tell you.
                hash: firstString(raw.hash) ?? null,
                captured_at: firstString(raw.captured_at) ?? null,
                record_count: firstFiniteNumber(raw.record_count) ?? null,
              };
            })
            .filter((s): s is SourceSnapshot => s !== null),
          generated_at: firstString(snap.generated_at) ?? firstString(cand.generated_at) ?? null,
        } satisfies RegistryPipeline,
        meta: undefined,
        url: undefined,
      };
    },
    staleTime: STALE_LONG,
  });

/**
 * Every crowdloan on chain (#10300).
 *
 * `percent_raised` and `finalized` are separate states and the panel must not
 * conflate them: a crowdloan at 100% that has not been finalized has met its
 * cap but not settled, which is a different thing to be looking at than one
 * that has.
 */
export const crowdloansQuery = () =>
  queryOptions({
    queryKey: k("crowdloans"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/crowdloans", { signal });
      const d = isRecord(res.data) ? res.data : {};
      const crowdloans = (Array.isArray(d.crowdloans) ? d.crowdloans : [])
        .map(normalizeCrowdloan)
        .filter((c): c is Crowdloan => c !== null);
      return {
        data: {
          crowdloan_count: firstFiniteNumber(d.crowdloan_count) ?? crowdloans.length,
          crowdloans,
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * One crowdloan by id (#10300).
 *
 * `exists` is published in the BODY at 200 rather than signalled as a 404,
 * because "there is no crowdloan 47" is a fact about the chain, not a failed
 * request. The panel renders that as an answer instead of an error.
 */
export const crowdloanQuery = (id: number) =>
  queryOptions({
    queryKey: k("crowdloan", id),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/crowdloans/${id}`, { signal });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          crowdloan_id: firstFiniteNumber(d.crowdloan_id) ?? id,
          exists: d.exists === true,
          crowdloan: normalizeCrowdloan(d.crowdloan),
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeCrowdloan(raw: unknown): Crowdloan | null {
  if (!isRecord(raw)) return null;
  const id = firstFiniteNumber(raw.crowdloan_id);
  if (id === undefined) return null;
  return {
    crowdloan_id: id,
    creator: firstString(raw.creator) ?? null,
    cap_tao: firstFiniteNumber(raw.cap_tao) ?? null,
    raised_tao: firstFiniteNumber(raw.raised_tao) ?? null,
    percent_raised: firstFiniteNumber(raw.percent_raised) ?? null,
    contributors_count: firstFiniteNumber(raw.contributors_count) ?? null,
    end: firstFiniteNumber(raw.end) ?? null,
    // Met the cap and SETTLED are different states.
    finalized: raw.finalized === true,
    // Whether the raised funds execute a call on release. A crowdloan that
    // dispatches is doing something a plain transfer is not.
    has_dispatch_call: raw.has_dispatch_call === true,
    target_address: firstString(raw.target_address) ?? null,
  };
}

/**
 * One surface's captured fixture (#10300).
 *
 * A fixture that is MISSING says why -- the list route publishes a `status` and
 * a `reason` per surface, and "we never captured this" is a different fact from
 * "the capture failed with a 500". The lookup returns the artifact when it
 * exists and the stated absence when it does not, rather than an error either
 * way.
 */
export const fixtureQuery = (surfaceId: string) =>
  queryOptions({
    queryKey: k("fixture", surfaceId),
    queryFn: async ({ signal }) => {
      try {
        const res = await apiFetch<Record<string, unknown>>(
          `/api/v1/fixtures/${encodeURIComponent(surfaceId)}`,
          { signal },
        );
        const d = isRecord(res.data) ? res.data : {};
        return {
          data: {
            surface_id: surfaceId,
            available: true,
            captured_at: firstString(d.captured_at) ?? null,
            response_status: firstFiniteNumber(d.response_status) ?? null,
            reason: null,
          } satisfies FixtureLookup,
          meta: res.meta,
          url: res.url,
        };
      } catch (err) {
        // An absent fixture is an ANSWER, not a failure. The route 404s on a
        // surface it never captured, and surfacing that as a thrown error
        // would make "we have not captured this yet" indistinguishable from
        // "the API is broken" -- which is the exact confusion #10222 fixed for
        // lane health.
        const status = err instanceof ApiError ? err.status : null;
        if (status === 404) {
          return {
            data: {
              surface_id: surfaceId,
              available: false,
              captured_at: null,
              response_status: null,
              reason: "No fixture has been captured for this surface.",
            } satisfies FixtureLookup,
            meta: undefined,
            url: undefined,
          };
        }
        throw err;
      }
    },
    staleTime: STALE_LONG,
    retry: false,
  });

/**
 * The network-wide TAO holder leaderboard (#10300).
 *
 * `free_tao`, `delegated_tao` and `total_tao` are three different positions,
 * and the net flows come in three windows because they can disagree -- an
 * account can be growing over 7d while shrinking over 90d, and showing one
 * window would let a short bounce read as a trend.
 */
export const topHoldersQuery = (limit = 25) =>
  queryOptions({
    queryKey: k("accounts-top-holders", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/accounts/top-holders?limit=${limit}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const accounts = (Array.isArray(d.accounts) ? d.accounts : [])
        .map((raw): TopHolder | null => {
          if (!isRecord(raw)) return null;
          const ss58 = firstString(raw.ss58);
          if (!ss58) return null;
          return {
            ss58,
            free_tao: firstFiniteNumber(raw.free_tao) ?? null,
            delegated_tao: firstFiniteNumber(raw.delegated_tao) ?? null,
            total_tao: firstFiniteNumber(raw.total_tao) ?? null,
            net_flow_7d: firstFiniteNumber(raw.net_flow_7d) ?? null,
            net_flow_30d: firstFiniteNumber(raw.net_flow_30d) ?? null,
            net_flow_90d: firstFiniteNumber(raw.net_flow_90d) ?? null,
          };
        })
        .filter((a): a is TopHolder => a !== null);
      return {
        data: {
          account_count: firstFiniteNumber(d.account_count) ?? null,
          captured_at: firstString(d.captured_at) ?? null,
          accounts,
        } satisfies TopHolders,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * One account's root-claim state (#10300).
 *
 * `field_sources` is carried through rather than dropped, because it says the
 * hotkey list is RECONSTRUCTED while the claim type is MEASURED. Those are
 * different confidences: one was read from chain storage, the other inferred,
 * and rendering them identically would present an inference as a reading.
 */
export const accountRootClaimQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-root-claim", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/accounts/${encodeURIComponent(ss58)}/root-claim`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const claim = isRecord(d.claim_type) ? d.claim_type : {};
      const sources = isRecord(d.field_sources) ? d.field_sources : {};
      const hotkeySource = isRecord(sources.hotkeys) ? sources.hotkeys : {};
      return {
        data: {
          ss58: firstString(d.ss58) ?? ss58,
          claim_kind: firstString(claim.kind) ?? null,
          hotkeys: (Array.isArray(d.hotkeys) ? d.hotkeys : [])
            .map((h) => firstString(h))
            .filter((h): h is string => h !== undefined),
          // "reconstructed" vs "measured" -- an inference is not a reading.
          hotkeys_source: firstString(hotkeySource.kind) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } satisfies RootClaim,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Validator entry economics ranked across subnets (#10300).
 *
 * `excluded` rides along with a reason per subnet. A leaderboard that silently
 * drops the subnets it could not rank reports a subset as the whole -- and the
 * reasons are the interesting part, because "excluded because it has no
 * validators" and "excluded because the read failed" are different facts.
 */
export const validatorEconomicsQuery = (limit = 25) =>
  queryOptions({
    queryKey: k("validators-economics", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/validators/economics?limit=${limit}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const rows = (Array.isArray(d.rows) ? d.rows : [])
        .map((raw): ValidatorEconomicsRow | null => {
          if (!isRecord(raw)) return null;
          const netuid = firstFiniteNumber(raw.netuid);
          if (netuid === undefined) return null;
          return {
            netuid,
            permit_floor_cost_tao: firstFiniteNumber(raw.permit_floor_cost_tao) ?? null,
            earning_floor_cost_tao: firstFiniteNumber(raw.earning_floor_cost_tao) ?? null,
            permit_to_earning_multiple: firstFiniteNumber(raw.permit_to_earning_multiple) ?? null,
            validator_slots_open: firstFiniteNumber(raw.validator_slots_open) ?? null,
            cap_binding: typeof raw.cap_binding === "boolean" ? raw.cap_binding : null,
            emission_gate_open:
              typeof raw.emission_gate_open === "boolean" ? raw.emission_gate_open : null,
            degraded_reason: firstString(raw.degraded_reason) ?? null,
          };
        })
        .filter((r): r is ValidatorEconomicsRow => r !== null);
      const excluded = (Array.isArray(d.excluded) ? d.excluded : [])
        .map((raw): ExcludedSubnet | null => {
          if (!isRecord(raw)) return null;
          const netuid = firstFiniteNumber(raw.netuid);
          if (netuid === undefined) return null;
          return { netuid, reason: firstString(raw.reason) ?? null };
        })
        .filter((e): e is ExcludedSubnet => e !== null);
      return {
        data: {
          total: firstFiniteNumber(d.total) ?? rows.length,
          tao_weight: firstFiniteNumber(d.tao_weight) ?? null,
          stake_threshold_units: firstFiniteNumber(d.stake_threshold_units) ?? null,
          rows,
          excluded,
        } satisfies ValidatorEconomics,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Registration and deregistration across every subnet (#10300).
 *
 * The network-wide sibling of `/subnets/{netuid}/lifecycle`, and it carries the
 * same `predates_capture` flag for the same reason: every subnet alive when the
 * lane first ran was registered before we were watching, so its row has no
 * block and saying so is the only honest rendering.
 */
export const chainSubnetLifecycleQuery = (limit = 30) =>
  queryOptions({
    queryKey: k("chain-subnet-lifecycle", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/chain/subnet-lifecycle?limit=${limit}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const entries = (Array.isArray(d.entries) ? d.entries : [])
        .map(normalizeSubnetLifecycleEntry)
        .filter((e): e is SubnetLifecycleEntry => e !== null);
      return {
        data: {
          entry_count: firstFiniteNumber(d.entry_count) ?? entries.length,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? null,
          entries,
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * One domain's rollup (#10300).
 *
 * `/api/v1/domains/{tag}/summary` -- the per-domain detail behind the rollup
 * table, carrying the emission concentration that the list view has no room
 * for.
 */
export const domainSummaryQuery = (tag: string) =>
  queryOptions({
    queryKey: k("domain-summary", tag),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/domains/${encodeURIComponent(tag)}/summary`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const conc = isRecord(d.emission_concentration) ? d.emission_concentration : {};
      return {
        data: {
          domain: firstString(d.domain) ?? tag,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? null,
          netuids: (Array.isArray(d.netuids) ? d.netuids : [])
            .map((n) => firstFiniteNumber(n))
            .filter((n): n is number => n !== undefined),
          total_stake_tao: firstFiniteNumber(d.total_stake_tao) ?? null,
          total_emission_share: firstFiniteNumber(d.total_emission_share) ?? null,
          emission_gini: firstFiniteNumber(conc.gini) ?? null,
          emission_nakamoto_coefficient: firstFiniteNumber(conc.nakamoto_coefficient) ?? null,
        } satisfies DomainSummary,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_LONG,
  });

/**
 * How current our own capture is (#10300).
 *
 * `head_age_ms` and `write_latency_ms` measure DIFFERENT things and the panel
 * must not blur them: latency is how long a block takes to land once we start
 * writing it, age is how far behind the chain head we are. A lane that stopped
 * an hour ago still reports excellent latency for the blocks it did write --
 * fast is not the same as current, and only the age says which.
 */
export const chainIndexerLagQuery = () =>
  queryOptions({
    queryKey: k("chain-indexer-lag"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/chain/indexer-lag", { signal });
      const d = isRecord(res.data) ? res.data : {};
      const w = isRecord(d.window) ? d.window : {};
      const lat = isRecord(d.write_latency_ms) ? d.write_latency_ms : {};
      return {
        data: {
          block_count: firstFiniteNumber(d.block_count) ?? null,
          head_age_ms: firstFiniteNumber(d.head_age_ms) ?? null,
          measured_at: firstString(d.measured_at) ?? null,
          oldest_block: firstFiniteNumber(w.oldest_block) ?? null,
          newest_block: firstFiniteNumber(w.newest_block) ?? null,
          newest_observed_at: firstString(w.newest_observed_at) ?? null,
          latency_p50_ms: firstFiniteNumber(lat.p50) ?? null,
          latency_p95_ms: firstFiniteNumber(lat.p95) ?? null,
          latency_p99_ms: firstFiniteNumber(lat.p99) ?? null,
          latency_max_ms: firstFiniteNumber(lat.max) ?? null,
        } satisfies IndexerLag,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
  });

/**
 * Why health probes fail, and whether the mix is moving (#10300).
 *
 * `share` and `failure_share` have DIFFERENT denominators -- one is the
 * classification's share of every check, the other its share of the failing
 * ones -- and `is_failure` marks the classifications that are not failures at
 * all. Reading any of the three as the others turns a healthy mix into an
 * alarming one.
 */
export const healthFailureReasonsQuery = (window: string) =>
  queryOptions({
    queryKey: k("health-failure-reasons", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/health/failure-reasons?window=${encodeURIComponent(window)}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const reasons = (Array.isArray(d.reasons) ? d.reasons : [])
        .map((raw): FailureReason | null => {
          if (!isRecord(raw)) return null;
          const classification = firstString(raw.classification);
          if (!classification) return null;
          return {
            classification,
            // Unknown is NOT a failure. Defaulting the unknown direction to
            // "this is a failure" would inflate the failing mix with rows the
            // API never claimed were failures.
            is_failure: raw.is_failure === true,
            checks: firstFiniteNumber(raw.checks) ?? null,
            share: firstFiniteNumber(raw.share) ?? null,
            failure_share: firstFiniteNumber(raw.failure_share) ?? null,
          };
        })
        .filter((r): r is FailureReason => r !== null);
      return {
        data: {
          window: firstString(d.window) ?? null,
          days_covered: firstFiniteNumber(d.days_covered) ?? null,
          total_checks: firstFiniteNumber(d.total_checks) ?? null,
          failing_checks: firstFiniteNumber(d.failing_checks) ?? null,
          failure_rate: firstFiniteNumber(d.failure_rate) ?? null,
          reasons,
        } satisfies FailureReasons,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * The emission-gate change log (#10300).
 *
 * `predates_capture_count` is published beside `change_count` because a change
 * older than capture carries a NULL block. Rendering those as block 0 would
 * date every pre-capture change to genesis, and dropping them would understate
 * how often the gate has moved.
 */
export const emissionChangesQuery = (limit = 25) =>
  queryOptions({
    queryKey: k("emission-changes", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/chain/governance/emission-changes?limit=${limit}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const changes = (Array.isArray(d.changes) ? d.changes : [])
        .map((raw): EmissionChange | null => {
          if (!isRecord(raw)) return null;
          const kind = firstString(raw.kind);
          if (!kind) return null;
          return {
            kind,
            observed_at: firstString(raw.observed_at) ?? null,
            // NULLABLE ON PURPOSE -- see the note above.
            block_number: firstFiniteNumber(raw.block_number) ?? null,
            predates_capture: raw.predates_capture === true,
            param: firstString(raw.param) ?? null,
            value: firstString(raw.value) ?? firstFiniteNumber(raw.value)?.toString() ?? null,
            previous_value:
              firstString(raw.previous_value) ??
              firstFiniteNumber(raw.previous_value)?.toString() ??
              null,
          };
        })
        .filter((c): c is EmissionChange => c !== null);
      return {
        data: {
          change_count: firstFiniteNumber(d.change_count) ?? changes.length,
          predates_capture_count: firstFiniteNumber(d.predates_capture_count) ?? null,
          latest_change_at: firstString(d.latest_change_at) ?? null,
          changes,
        } satisfies EmissionChanges,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Which drand rounds the chain still stores (#10300).
 *
 * `stored_round_span` is the operative number, not `last_stored_round`.
 * Commit-reveal verifies a reveal against the round it was timelocked to, and
 * a round that has aged out of storage can no longer be checked -- so how far
 * back storage reaches is what decides whether an old reveal is still
 * verifiable, and the newest round says nothing about that.
 */
export const networkRandomnessQuery = () =>
  queryOptions({
    queryKey: k("network-randomness"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/network/randomness", { signal });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          last_stored_round: firstFiniteNumber(d.last_stored_round) ?? null,
          oldest_stored_round: firstFiniteNumber(d.oldest_stored_round) ?? null,
          stored_round_span: firstFiniteNumber(d.stored_round_span) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } satisfies RandomnessStatus,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * What it costs to register, across every subnet (#10300).
 *
 * `subnet_count` and `read_count` are DIFFERENT numbers: the first is how many
 * subnets exist, the second how many were actually read for this answer. A
 * spread computed over a partial read is a real answer about a subset, and
 * presenting it as "the network" would be the confident-zero mistake in its
 * cheapest form.
 */
export const chainBurnQuery = () =>
  queryOptions({
    queryKey: k("chain-burn"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/chain/burn", { signal });
      const d = isRecord(res.data) ? res.data : {};
      const subnets = (Array.isArray(d.subnets) ? d.subnets : [])
        .map((raw): ChainBurnSubnet | null => {
          if (!isRecord(raw)) return null;
          const netuid = firstFiniteNumber(raw.netuid);
          if (netuid === undefined) return null;
          return { netuid, burn_tao: firstFiniteNumber(raw.burn_tao) ?? null };
        })
        .filter((s): s is ChainBurnSubnet => s !== null);
      return {
        data: {
          subnet_count: firstFiniteNumber(d.subnet_count) ?? null,
          // NOT defaulted to subnet_count. That default would assert full
          // coverage, which is the single claim this field exists to check.
          read_count: firstFiniteNumber(d.read_count) ?? null,
          cheapest_burn_tao: firstFiniteNumber(d.cheapest_burn_tao) ?? null,
          dearest_burn_tao: firstFiniteNumber(d.dearest_burn_tao) ?? null,
          median_burn_tao: firstFiniteNumber(d.median_burn_tao) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
          subnets,
        } satisfies ChainBurn,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Who holds the alpha, across every subnet (#10300).
 *
 * TWO capture stamps, kept apart. `captured_at` is when the subnet set was
 * read; `positions_captured_at` is when the holder positions were. They can
 * differ, and showing one as "the" timestamp would date a holder distribution
 * by when its subnet list was refreshed.
 */
export const chainHoldersQuery = (limit = 20) =>
  queryOptions({
    queryKey: k("chain-holders", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/chain/holders?limit=${limit}`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const net = isRecord(d.network) ? d.network : {};
      const subnets = (Array.isArray(d.subnets) ? d.subnets : [])
        .map((raw): ChainHolderSubnet | null => {
          if (!isRecord(raw)) return null;
          const netuid = firstFiniteNumber(raw.netuid);
          if (netuid === undefined) return null;
          return {
            netuid,
            holder_count: firstFiniteNumber(raw.holder_count) ?? null,
            total_alpha: firstFiniteNumber(raw.total_alpha) ?? null,
            top_holder: firstString(raw.top_holder) ?? null,
            top1_share: firstFiniteNumber(raw.top1_share) ?? null,
            top5_share: firstFiniteNumber(raw.top5_share) ?? null,
            top10_share: firstFiniteNumber(raw.top10_share) ?? null,
          };
        })
        .filter((s): s is ChainHolderSubnet => s !== null);
      return {
        data: {
          subnet_count: firstFiniteNumber(d.subnet_count) ?? null,
          subnets_measured: firstFiniteNumber(net.subnets_measured) ?? null,
          // A subnet whose alpha sits with ONE account. Published separately
          // from "majority holder" because they are different severities.
          subnets_with_single_holder: firstFiniteNumber(net.subnets_with_single_holder) ?? null,
          subnets_with_majority_holder: firstFiniteNumber(net.subnets_with_majority_holder) ?? null,
          median_top1_share: firstFiniteNumber(net.median_top1_share) ?? null,
          captured_at: firstString(d.captured_at) ?? null,
          positions_captured_at: firstString(d.positions_captured_at) ?? null,
          subnets,
        } satisfies ChainHolders,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Concentration ranked per subnet (#10300).
 *
 * `unmeasured` rides along per subnet, and `measured_subnet_count` beside
 * `subnet_count`, because a subnet with no concentration reading is not a
 * subnet with even distribution -- and a ranking that silently drops the
 * unmeasured ones reports a leaderboard over a subset as one over the network.
 */
export const chainConcentrationSubnetsQuery = (limit = 20) =>
  queryOptions({
    queryKey: k("chain-concentration-subnets", limit),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/chain/concentration/subnets?limit=${limit}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const net = isRecord(d.network) ? d.network : {};
      const subnets = (Array.isArray(d.subnets) ? d.subnets : [])
        .map((raw): NetworkConcentrationSubnet | null => {
          if (!isRecord(raw)) return null;
          const netuid = firstFiniteNumber(raw.netuid);
          if (netuid === undefined) return null;
          return {
            netuid,
            gini: firstFiniteNumber(raw.gini) ?? null,
            nakamoto_coefficient: firstFiniteNumber(raw.nakamoto_coefficient) ?? null,
            top_1pct_share: firstFiniteNumber(raw.top_1pct_share) ?? null,
            holders: firstFiniteNumber(raw.holders) ?? null,
            // Unknown counts as UNMEASURED, never as measured. Defaulting the
            // unknown direction to "we looked" is how a gap becomes a finding.
            unmeasured: raw.unmeasured === true || raw.unmeasured === undefined,
          };
        })
        .filter((s): s is NetworkConcentrationSubnet => s !== null);
      return {
        data: {
          lens: firstString(d.lens) ?? null,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? null,
          measured_subnet_count: firstFiniteNumber(d.measured_subnet_count) ?? null,
          median_gini: firstFiniteNumber(net.median_gini) ?? null,
          median_nakamoto_coefficient: firstFiniteNumber(net.median_nakamoto_coefficient) ?? null,
          single_holder_subnet_count: firstFiniteNumber(net.single_holder_subnet_count) ?? null,
          captured_at: firstString(d.captured_at) ?? null,
          subnets,
        } satisfies NetworkConcentrationSubnets,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

/**
 * Network concentration drift (#10300).
 *
 * `builder_versions` is the load-bearing field. Points computed by different
 * builder versions are different computations, so a trend drawn across a
 * version change is a comparison between two definitions rather than a movement
 * in the thing being measured. The route publishes every version present in the
 * window so a reader can see when that has happened.
 */
export const chainConcentrationHistoryQuery = (window: string) =>
  queryOptions({
    queryKey: k("chain-concentration-history", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/chain/concentration/history?window=${encodeURIComponent(window)}`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const points = (Array.isArray(d.points) ? d.points : [])
        .map((raw): NetworkConcentrationHistoryPoint | null => {
          if (!isRecord(raw)) return null;
          const day = firstString(raw.day);
          if (!day) return null;
          const stake = isRecord(raw.stake) ? raw.stake : {};
          return {
            day,
            builder_version: firstFiniteNumber(raw.builder_version) ?? null,
            neuron_count: firstFiniteNumber(raw.neuron_count) ?? null,
            subnet_count: firstFiniteNumber(raw.subnet_count) ?? null,
            gini: firstFiniteNumber(stake.gini) ?? null,
            nakamoto_coefficient: firstFiniteNumber(stake.nakamoto_coefficient) ?? null,
            top_1pct_share: firstFiniteNumber(stake.top_1pct_share) ?? null,
          };
        })
        .filter((p): p is NetworkConcentrationHistoryPoint => p !== null);
      return {
        data: {
          window: firstString(d.window) ?? null,
          point_count: firstFiniteNumber(d.point_count) ?? points.length,
          oldest_day: firstString(d.oldest_day) ?? null,
          newest_day: firstString(d.newest_day) ?? null,
          builder_versions: (Array.isArray(d.builder_versions) ? d.builder_versions : [])
            .map((v) => firstFiniteNumber(v))
            .filter((v): v is number => v !== undefined),
          points,
        } satisfies NetworkConcentrationHistory,
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_LONG,
  });

/**
 * The emission pipeline over time (#10300).
 *
 * `point_count` and `distinct_observations` are DIFFERENT numbers, and the gap
 * between them is the whole reason this surface publishes both. A day whose
 * `repeats_previous_observation` is true carried the previous reading forward
 * rather than measuring a new one -- so a flat stretch of the series can mean
 * "the pipeline did not move" or "the lane did not run", and only this flag
 * tells the two apart. Charting every point as a measurement would render the
 * second as the first.
 */
export const subnetEmissionPipelineHistoryQuery = (netuid: number, window: string) =>
  queryOptions({
    queryKey: k("subnet-emission-pipeline-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/subnets/${netuid}/emission-pipeline/history?window=${encodeURIComponent(window)}`,
        { signal },
      );
      return {
        data: normalizeEmissionPipelineHistory(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeEmissionPipelineHistory(raw: unknown): SubnetEmissionPipelineHistory {
  const d = isRecord(raw) ? raw : {};
  const points = (Array.isArray(d.points) ? d.points : [])
    .map(normalizeEmissionPipelinePoint)
    .filter((p): p is SubnetEmissionPipelinePoint => p !== null);
  return {
    netuid: firstFiniteNumber(d.netuid) ?? null,
    window: firstString(d.window) ?? null,
    point_count: firstFiniteNumber(d.point_count) ?? points.length,
    // NOT defaulted to point_count. Falling back to the number of points would
    // assert every day was independently observed, which is the one claim this
    // field exists to let a reader check.
    distinct_observations: firstFiniteNumber(d.distinct_observations) ?? null,
    oldest_day: firstString(d.oldest_day) ?? null,
    newest_day: firstString(d.newest_day) ?? null,
    first_captured_day: firstString(d.first_captured_day) ?? null,
    points,
  };
}

/**
 * One subnet's deregistration-rank trajectory (#10296).
 *
 * The current standing is already on this page. This is the SHAPE of it over
 * time, which is the thing a subnet owner can act on: rank 94 says almost
 * nothing, "94, was 71 a month ago" says a great deal.
 *
 * Same `point_count` / `distinct_observations` contract as the pipeline series
 * above, and for a sharper reason here -- a rank that was not re-measured looks
 * exactly like a rank that held steady, and the second is reassuring where the
 * first is not.
 */
export const subnetDeregistrationHistoryQuery = (netuid: number, window: string) =>
  queryOptions({
    queryKey: k("subnet-deregistration-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/subnets/${netuid}/deregistration-ranking/history?window=${encodeURIComponent(window)}`,
        { signal },
      );
      return {
        data: normalizeDeregistrationHistory(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeDeregistrationHistory(raw: unknown): SubnetDeregistrationHistory {
  const d = isRecord(raw) ? raw : {};
  const points = (Array.isArray(d.points) ? d.points : [])
    .map(normalizeDeregistrationHistoryPoint)
    .filter((p): p is SubnetDeregistrationHistoryPoint => p !== null);
  return {
    netuid: firstFiniteNumber(d.netuid) ?? null,
    window: firstString(d.window) ?? null,
    point_count: firstFiniteNumber(d.point_count) ?? points.length,
    // NOT defaulted to point_count -- see the pipeline normalizer above for
    // why that fallback asserts the one thing this field exists to let a
    // reader check.
    distinct_observations: firstFiniteNumber(d.distinct_observations) ?? null,
    oldest_day: firstString(d.oldest_day) ?? null,
    newest_day: firstString(d.newest_day) ?? null,
    first_captured_day: firstString(d.first_captured_day) ?? null,
    points,
  };
}

function normalizeDeregistrationHistoryPoint(
  raw: unknown,
): SubnetDeregistrationHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const day = firstString(raw.day);
  if (!day) return null;
  return {
    day,
    pinned_block: firstFiniteNumber(raw.pinned_block) ?? null,
    repeats_previous_observation:
      typeof raw.repeats_previous_observation === "boolean"
        ? raw.repeats_previous_observation
        : null,
    captured_at: firstString(raw.captured_at) ?? null,
    // Null here is MEANINGFUL when `immune` is true -- an immune subnet holds
    // no position -- so it is carried through rather than defaulted.
    rank: firstFiniteNumber(raw.rank) ?? null,
    immune: typeof raw.immune === "boolean" ? raw.immune : null,
    blocks_until_prunable: firstFiniteNumber(raw.blocks_until_prunable) ?? null,
    ranked_count: firstFiniteNumber(raw.ranked_count) ?? null,
    immune_count: firstFiniteNumber(raw.immune_count) ?? null,
    comparison_price: firstFiniteNumber(raw.comparison_price) ?? null,
    moving_price: firstFiniteNumber(raw.moving_price) ?? null,
    next_to_deregister: firstFiniteNumber(raw.next_to_deregister) ?? null,
    next_to_deregister_comparison_price:
      firstFiniteNumber(raw.next_to_deregister_comparison_price) ?? null,
  };
}

function normalizeEmissionPipelinePoint(raw: unknown): SubnetEmissionPipelinePoint | null {
  if (!isRecord(raw)) return null;
  const day = firstString(raw.day);
  if (!day) return null;
  return {
    day,
    pipeline_block: firstFiniteNumber(raw.pipeline_block) ?? null,
    // A carried-forward day, not a fresh reading. Defaulting the unknown
    // direction to `false` would silently promote it to a measurement.
    repeats_previous_observation:
      typeof raw.repeats_previous_observation === "boolean"
        ? raw.repeats_previous_observation
        : null,
    captured_at: firstString(raw.captured_at) ?? null,
    emission_share: firstFiniteNumber(raw.emission_share) ?? null,
    alpha_price_tao: firstFiniteNumber(raw.alpha_price_tao) ?? null,
    tao_in_pool_tao: firstFiniteNumber(raw.tao_in_pool_tao) ?? null,
    tao_in_emission_tao: firstFiniteNumber(raw.tao_in_emission_tao) ?? null,
    miner_burned_fraction: firstFiniteNumber(raw.miner_burned_fraction) ?? null,
    emission_enabled: typeof raw.emission_enabled === "boolean" ? raw.emission_enabled : null,
  };
}

/**
 * A subnet's surface audit trail (#10300).
 *
 * Newest first. Every row is an `action` on a `surface_id` at a `recorded_at`,
 * with the `source_commit` that carried it -- which is what makes this an audit
 * trail rather than a changelog: a claim about a surface can be traced to the
 * commit that made it.
 */
export const subnetSurfaceHistoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-surface-history", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(
        `/api/v1/subnets/${netuid}/surface-history`,
        { signal },
      );
      const d = isRecord(res.data) ? res.data : {};
      const changes = (Array.isArray(d.changes) ? d.changes : [])
        .map(normalizeSurfaceChange)
        .filter((c): c is SubnetSurfaceChange => c !== null);
      return {
        data: {
          // `change_count` and `surface_count` are different: one surface can
          // change many times, so collapsing them would overstate breadth.
          change_count: firstFiniteNumber(d.change_count) ?? changes.length,
          surface_count: firstFiniteNumber(d.surface_count) ?? null,
          latest_change_at: firstString(d.latest_change_at) ?? null,
          changes,
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_LONG,
  });

function normalizeSurfaceChange(raw: unknown): SubnetSurfaceChange | null {
  if (!isRecord(raw)) return null;
  const surfaceId = firstString(raw.surface_id);
  const action = firstString(raw.action);
  if (!surfaceId || !action) return null;
  return {
    surface_id: surfaceId,
    action,
    kind: firstString(raw.kind) ?? null,
    url: firstString(raw.url) ?? null,
    name: firstString(raw.name) ?? null,
    source_commit: firstString(raw.source_commit) ?? null,
    recorded_at: firstString(raw.recorded_at) ?? null,
  };
}

/**
 * One subnet's registration/deregistration timeline (#10262).
 *
 * Newest first. A subnet with no recorded event returns an empty list at 200 --
 * absence of events is a real answer, distinct from an unknown netuid (404).
 */
export const subnetLifecycleQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-lifecycle", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ entries?: unknown }>(`/api/v1/subnets/${netuid}/lifecycle`, {
        signal,
      });
      const raw = isRecord(res.data) ? res.data.entries : null;
      const entries = (Array.isArray(raw) ? raw : [])
        .map(normalizeSubnetLifecycleEntry)
        .filter((e): e is SubnetLifecycleEntry => e !== null);
      return { data: entries, meta: res.meta, url: res.url };
    },
    staleTime: STALE_MED,
  });

function normalizeSubnetLifecycleEntry(raw: unknown): SubnetLifecycleEntry | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid) ?? null;
  const event = firstString(raw.event);
  if (netuid === null || !event) return null;
  return {
    netuid,
    event,
    // NULLABLE ON PURPOSE. A transition older than capture has no block, and
    // coercing it to 0 would claim it happened at genesis.
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
    predates_capture: raw.predates_capture === true,
  };
}

/**
 * This subnet's place in the chain's pruning order, or null if it has none
 * (#10285).
 *
 * The route answers network-wide; this picks the one entry out of `ranked` OR
 * `immune`. Those two lists are disjoint and a subnet in neither is not a
 * pruning candidate at all -- root, most obviously.
 */
export const subnetDeregistrationStandingQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-dereg-standing", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/chain/deregistration-ranking", {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const pick = (list: unknown) =>
        (Array.isArray(list) ? list : [])
          .map(normalizeDeregistrationStanding)
          .find((e) => e?.netuid === netuid) ?? null;
      return {
        data: {
          standing: pick(d.ranked) ?? pick(d.immune),
          ranked_count: firstFiniteNumber(d.ranked_count) ?? null,
          immune_count: firstFiniteNumber(d.immune_count) ?? null,
          next_to_deregister: firstFiniteNumber(d.next_to_deregister) ?? null,
        },
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeDeregistrationStanding(raw: unknown): DeregistrationStanding | null {
  if (!isRecord(raw)) return null;
  const netuid = firstFiniteNumber(raw.netuid) ?? null;
  if (netuid === null) return null;
  return {
    netuid,
    // null iff immune -- see the type's note; not interchangeable with 0.
    rank: firstFiniteNumber(raw.rank) ?? null,
    comparison_price: firstFiniteNumber(raw.comparison_price) ?? null,
    moving_price: firstFiniteNumber(raw.moving_price) ?? null,
    registered_at_block: firstFiniteNumber(raw.registered_at_block) ?? null,
    subnet_mechanism: firstFiniteNumber(raw.subnet_mechanism) ?? null,
    immune: raw.immune === true,
    immune_until_block: firstFiniteNumber(raw.immune_until_block) ?? null,
    blocks_until_prunable: firstFiniteNumber(raw.blocks_until_prunable) ?? null,
  };
}

export const subnetLeaseQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-lease", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetLeaseState>>(`/api/v1/subnets/${netuid}/lease`, {
        signal,
      });
      return {
        data: normalizeSubnetLeaseState(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

function normalizeSubnetLeaseEvent(raw: unknown): SubnetLeaseEvent | null {
  if (!isRecord(raw)) return null;
  return {
    event_kind: firstString(raw.event_kind) ?? null,
    beneficiary: firstString(raw.beneficiary) ?? null,
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
  };
}

export function normalizeSubnetLeaseHistory(netuid: number, raw: unknown): SubnetLeaseHistory {
  const d = isRecord(raw) ? raw : {};
  const events = Array.isArray(d.lease_events)
    ? d.lease_events.map(normalizeSubnetLeaseEvent).filter((e): e is SubnetLeaseEvent => e != null)
    : [];
  const kinds = Array.isArray(d.event_kinds)
    ? d.event_kinds.filter((k): k is string => typeof k === "string" && k.length > 0)
    : [];
  return {
    schema_version: firstFiniteNumber(d.schema_version) ?? 1,
    netuid: firstFiniteNumber(d.netuid) ?? netuid,
    event_pallet: firstString(d.event_pallet) ?? "SubtensorModule",
    event_kinds: kinds,
    count: firstFiniteNumber(d.count) ?? events.length,
    lease_events: events,
  };
}

export const subnetLeaseHistoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-lease-history", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetLeaseHistory>>(
        `/api/v1/subnets/${netuid}/lease/history`,
        { signal },
      );
      return {
        data: normalizeSubnetLeaseHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

export interface SubnetEventsParams {
  /** Filter to one event_kind (e.g. "StakeAdded"). */
  kind?: string;
}

export const subnetEventsQuery = (netuid: number, params: SubnetEventsParams = {}) =>
  queryOptions({
    queryKey: k("subnet-events", netuid, params.kind ?? null),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/subnets/${netuid}/events`, {
        params: { limit: 100, kind: params.kind },
        signal,
      });
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
// computed live from the store.
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
// a 7d/30d window, computed live from the store.
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
// over time) from the stored snapshots.
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
// refreshed daily from the subnet_hyperparams store. Cold/absent snapshot ->
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

// #4309/1.6: one historic hyperparameter snapshot in a subnet's append-only
// change timeline. Discarded (like the sibling identity-history normalizer)
// when the stable `hyperparams_hash` keyset anchor is missing.
function normalizeSubnetHyperparamsHistoryEntry(
  raw: unknown,
): SubnetHyperparamsHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const hash = firstString(raw.hyperparams_hash);
  if (hash == null) return null;
  return {
    block_number: firstFiniteNumber(raw.block_number) ?? null,
    observed_at: firstString(raw.observed_at) ?? null,
    hyperparameters: normalizeSubnetHyperparameters(raw.hyperparameters),
    hyperparams_hash: hash,
  };
}

const MAX_SUBNET_HYPERPARAMS_HISTORY_ENTRIES = 1000;

function normalizeSubnetHyperparamsHistory(netuid: number, raw: unknown): SubnetHyperparamsHistory {
  const rec = isRecord(raw) ? raw : {};
  const entries = (Array.isArray(rec.entries) ? rec.entries : [])
    .map(normalizeSubnetHyperparamsHistoryEntry)
    .filter((entry): entry is SubnetHyperparamsHistoryEntry => entry != null)
    .slice(0, MAX_SUBNET_HYPERPARAMS_HISTORY_ENTRIES);
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

// GET /api/v1/subnets/{netuid}/hyperparameters/history (#4309/1.6): append-only
// hyperparameter-change timeline for one subnet, newest first, from the
// subnet_hyperparams_history Postgres tier. Forward-only — rows only exist
// from when the diff-on-change write started running.
export const subnetHyperparamsHistoryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-hyperparams-history", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetHyperparamsHistory>>(
        `/api/v1/subnets/${netuid}/hyperparameters/history`,
        { signal },
      );
      return {
        data: normalizeSubnetHyperparamsHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #5235: read-only constant-product stake/unstake slippage quote for one
// subnet, computed live against the subnet's AMM pool reserves. Unlike the
// other subnet queries above, this one is user-input-driven (a free-text
// amount): `enabled` gates on a valid positive amount so no request fires
// for an empty/zero/negative field, and errors (400 invalid_amount, 422
// insufficient_liquidity) are left to propagate as an ApiError for the
// caller to render, rather than swallowed into a schema-stable zero --
// unlike the other subnet endpoints, a failed quote has no meaningful
// zero-value fallback to show the user.
export const subnetStakeQuoteQuery = (
  netuid: number,
  amount: number,
  direction: "stake" | "unstake",
) =>
  queryOptions({
    queryKey: k("subnet-stake-quote", netuid, amount, direction),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/stake-quote`, {
        params: { amount, direction },
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: firstFiniteNumber(d.schema_version) ?? 1,
          netuid: firstFiniteNumber(d.netuid) ?? netuid,
          direction: d.direction === "unstake" ? "unstake" : "stake",
          amount: coerceFiniteNumber(d.amount) ?? amount,
          expected_out: coerceFiniteNumber(d.expected_out) ?? 0,
          expected_out_unit: d.expected_out_unit === "tao" ? "tao" : "alpha",
          spot_price_tao: coerceFiniteNumber(d.spot_price_tao) ?? 0,
          effective_price_tao: coerceFiniteNumber(d.effective_price_tao) ?? 0,
          price_impact_pct: coerceFiniteNumber(d.price_impact_pct) ?? 0,
          tao_in_pool_tao: coerceFiniteNumber(d.tao_in_pool_tao) ?? null,
          alpha_in_pool: coerceFiniteNumber(d.alpha_in_pool) ?? null,
          is_root: booleanValue(d.is_root) ?? false,
        } as SubnetStakeQuote,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetStakeQuote>;
    },
    enabled: Number.isFinite(amount) && amount > 0,
    staleTime: STALE_SHORT,
  });

// #10488: one subnet's declared wallets. `owner` is chain-derived and flagged
// as such; every other role carries the source_urls that prove it, so a UI can
// render the evidence beside the claim rather than asserting it bare.
export const subnetWalletsQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-wallets", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/wallets`, {
        signal,
      });
      return {
        data: isRecord(res.data) ? res.data : {},
        meta: res.meta,
        url: res.url,
      } as ApiResult<Record<string, unknown>>;
    },
    staleTime: STALE_MED,
  });

// #10488: the owner-cut accrual and its disposition. `unresolved` is a
// first-class bucket and may be the majority state -- a UI must render it
// plainly rather than as a warning, and never as 0.
export const subnetOwnerCutQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-owner-cut", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/owner-cut`, { signal });
      return {
        data: isRecord(res.data) ? res.data : {},
        meta: res.meta,
        url: res.url,
      } as ApiResult<Record<string, unknown>>;
    },
    staleTime: STALE_MED,
  });

const REVENUE_PROVENANCES = new Set<RevenueProvenance>([
  "chain-verified",
  "probe-derived",
  "operator-attested",
  "third-party-reported",
  "proxy-only",
  "none",
]);

function nonNegativeInteger(value: unknown): number | null {
  const number = coerceFiniteNumber(value);
  return number != null && Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = nonNegativeInteger(value);
  return number != null && number > 0 ? number : null;
}

function normalizeRevenueProvenance(value: unknown): RevenueProvenance | null {
  const provenance = coerceString(value);
  return provenance && REVENUE_PROVENANCES.has(provenance as RevenueProvenance)
    ? (provenance as RevenueProvenance)
    : null;
}

function normalizeRevenueBasis(raw: unknown): RevenueBasis | null {
  if (!isRecord(raw)) return null;
  return {
    tao: coerceFiniteNumber(raw.tao) ?? null,
    usd: coerceFiniteNumber(raw.usd) ?? null,
  };
}

function normalizeRevenueEmission(raw: unknown): RevenueEmission {
  const data = isRecord(raw) ? raw : {};
  const alternates = isRecord(data.alternates) ? data.alternates : {};
  return {
    basis: data.basis === "tao_total" ? "tao_total" : null,
    tao: coerceFiniteNumber(data.tao) ?? null,
    usd: coerceFiniteNumber(data.usd) ?? null,
    alternates: {
      alpha_out_priced: normalizeRevenueBasis(alternates.alpha_out_priced),
      owner_take: normalizeRevenueBasis(alternates.owner_take),
    },
  };
}

function normalizeRevenueSource(raw: unknown): RevenueSource | null {
  if (!isRecord(raw)) return null;
  const surfaceId = coerceString(raw.surface_id);
  if (!surfaceId) return null;
  const supersedes = Array.isArray(raw.supersedes)
    ? raw.supersedes.flatMap((value) => {
        const id = coerceString(value);
        return id ? [id] : [];
      })
    : undefined;
  const periodsObserved = nonNegativeInteger(raw.periods_observed);
  const periodsExpected = nonNegativeInteger(raw.periods_expected);
  return {
    surface_id: surfaceId,
    provenance: normalizeRevenueProvenance(raw.provenance),
    currency: coerceString(raw.currency) ?? null,
    grain: coerceString(raw.grain) ?? null,
    ...(supersedes ? { supersedes } : {}),
    amount_usd: coerceFiniteNumber(raw.amount_usd) ?? null,
    // Do not turn a malformed/missing flag into "excluded". The UI needs a
    // third state for unknown evidence, separate from a real false.
    contributes: booleanValue(raw.contributes) ?? null,
    excluded_reason: coerceString(raw.excluded_reason) ?? null,
    ...(periodsObserved != null ? { periods_observed: periodsObserved } : {}),
    ...(periodsExpected != null ? { periods_expected: periodsExpected } : {}),
    ...(coerceString(raw.response_hash) ? { response_hash: coerceString(raw.response_hash) } : {}),
    ...(coerceString(raw.observed_at) ? { observed_at: coerceString(raw.observed_at) } : {}),
  };
}

function normalizeRevenueVerificationCheck(raw: unknown): RevenueVerificationCheck | null {
  if (!isRecord(raw)) return null;
  const name = coerceString(raw.name);
  if (!name) return null;
  return {
    name,
    ok: booleanValue(raw.ok) ?? null,
    detail: coerceString(raw.detail) ?? null,
  };
}

function normalizeRevenueVerification(raw: unknown): SubnetRevenue["verification"] {
  const data = isRecord(raw) ? raw : {};
  return {
    verified: booleanValue(data.verified) ?? null,
    checks: Array.isArray(data.checks)
      ? data.checks.flatMap((check) => {
          const normalized = normalizeRevenueVerificationCheck(check);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

/**
 * Revenue data is evidence data: a null ratio means no readable revenue was
 * observed, not a zero. Normalize every nullable value at the boundary so a
 * card cannot accidentally coerce the normal absence case into a claim.
 */
export function normalizeSubnetRevenue(raw: unknown, fallbackNetuid: number): SubnetRevenue {
  const data = isRecord(raw) ? raw : {};
  const sources = Array.isArray(data.sources)
    ? data.sources.flatMap((source) => {
        const normalized = normalizeRevenueSource(source);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: nonNegativeInteger(data.netuid) ?? fallbackNetuid,
    window_days: positiveInteger(data.window_days),
    emission: normalizeRevenueEmission(data.emission),
    revenue_usd: coerceFiniteNumber(data.revenue_usd) ?? null,
    provenance: normalizeRevenueProvenance(data.provenance),
    searched_at: coerceString(data.searched_at) ?? null,
    coverage_ratio: coerceFiniteNumber(data.coverage_ratio) ?? null,
    subsidy_multiple: coerceFiniteNumber(data.subsidy_multiple) ?? null,
    sources,
    verification: normalizeRevenueVerification(data.verification),
  };
}

/** /api/v1/subnets/{netuid}/revenue's outer artifact. */
export function normalizeSubnetRevenueArtifact(
  raw: unknown,
  fallbackNetuid: number,
): SubnetRevenueArtifact {
  const data = isRecord(raw) ? raw : {};
  const netuid = nonNegativeInteger(data.netuid) ?? fallbackNetuid;
  return {
    schema_version: positiveInteger(data.schema_version) ?? 1,
    generated_at: coerceString(data.generated_at) ?? null,
    netuid,
    revenue: normalizeSubnetRevenue(data.revenue, netuid),
  };
}

/** /api/v1/chain/revenue-coverage's complete, intentionally non-sparse list. */
export function normalizeChainRevenueCoverage(raw: unknown): ChainRevenueCoverage {
  const data = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(data.subnets)
    ? data.subnets.flatMap((subnet) => {
        if (!isRecord(subnet)) return [];
        const netuid = nonNegativeInteger(subnet.netuid);
        return netuid == null ? [] : [normalizeSubnetRevenue(subnet, netuid)];
      })
    : [];
  return {
    schema_version: positiveInteger(data.schema_version) ?? 1,
    generated_at: coerceString(data.generated_at) ?? null,
    window_days: positiveInteger(data.window_days),
    observed_count: nonNegativeInteger(data.observed_count),
    subnet_count: nonNegativeInteger(data.subnet_count),
    subnets,
  };
}

// #10447: one subnet's external revenue against the TAO the network emits to
// it. coverage_ratio and subsidy_multiple stay NULL when revenue is not
// observed — 127 of 129 subnets are in that state, and coercing null to 0 here
// would render every one of them as "0% covered", which is a false claim about
// each. An observed 0 is a different value and survives as a real 0.
export const subnetRevenueQuery = (netuid: number, window: RevenueWindow = "1d") =>
  queryOptions({
    queryKey: k("subnet-revenue", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/revenue`, {
        params: { window },
        signal,
      });
      return {
        data: normalizeSubnetRevenueArtifact(res.data, netuid),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetRevenueArtifact>;
    },
    staleTime: STALE_MED,
  });

// #10447: every subnet's coverage in one response. Subnets with no observed
// revenue are included with null ratios rather than dropped — omitting them
// would make the covered set look like the whole network.
export const chainRevenueCoverageQuery = (window: RevenueWindow = "1d") =>
  queryOptions({
    queryKey: k("chain-revenue-coverage", window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/chain/revenue-coverage`, {
        params: { window },
        signal,
      });
      return {
        data: normalizeChainRevenueCoverage(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainRevenueCoverage>;
    },
    staleTime: STALE_MED,
  });

// #4339/8.4: the live cumulative TAO recycled for registration on one subnet,
// queried live from the chain (600s KV cache on the backend) — a single
// snapshot, no pagination. recycled_tao stays null on RPC failure rather than
// coercing to 0, since 0 is a real, distinct value (zero registrations ever).
export const subnetRecycledQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-recycled", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/recycled`, { signal });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: firstFiniteNumber(d.schema_version) ?? 1,
          netuid: firstFiniteNumber(d.netuid) ?? netuid,
          recycled_tao: coerceFiniteNumber(d.recycled_tao) ?? null,
          queried_at: firstString(d.queried_at) ?? null,
        } as SubnetRecycled,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetRecycled>;
    },
    staleTime: STALE_MED,
  });

/** Per-subnet idle stake (#6994): stake delegated to a hotkey earning zero
 *  dividends. Flat snapshot, no window param. */
export const subnetIdleStakeQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-idle-stake", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>(`/api/v1/subnets/${netuid}/idle-stake`, {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      return {
        data: {
          schema_version: firstFiniteNumber(d.schema_version) ?? 1,
          netuid: firstFiniteNumber(d.netuid) ?? netuid,
          captured_at: firstString(d.captured_at) ?? null,
          neuron_count: firstFiniteNumber(d.neuron_count) ?? 0,
          idle_neuron_count: firstFiniteNumber(d.idle_neuron_count) ?? 0,
          idle_stake_alpha: coerceFiniteNumber(d.idle_stake_alpha) ?? null,
        } as SubnetIdleStake,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetIdleStake>;
    },
    staleTime: STALE_MED,
  });

function normalizeChainIdleStakeSubnet(raw: unknown): ChainIdleStakeSubnet | undefined {
  if (!isRecord(raw)) return undefined;
  const netuid = firstFiniteNumber(raw.netuid);
  if (netuid == null) return undefined;
  return {
    netuid,
    neuron_count: firstFiniteNumber(raw.neuron_count) ?? 0,
    idle_neuron_count: firstFiniteNumber(raw.idle_neuron_count) ?? 0,
    idle_stake_alpha: coerceFiniteNumber(raw.idle_stake_alpha) ?? null,
  };
}

export function normalizeChainIdleStake(raw: unknown): ChainIdleStake {
  const rec = isRecord(raw) ? raw : {};
  const subnets = Array.isArray(rec.subnets)
    ? rec.subnets.flatMap((s) => {
        const normalized = normalizeChainIdleStakeSubnet(s);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    captured_at: firstString(rec.captured_at) ?? null,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? subnets.length,
    total_idle_stake_alpha: coerceFiniteNumber(rec.total_idle_stake_alpha) ?? null,
    subnets,
  };
}

/** Network-wide idle-stake rollup (#6994), sorted by idle_stake_tao desc. */
export const chainIdleStakeQuery = () =>
  queryOptions({
    queryKey: k("chain-idle-stake"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainIdleStake>>("/api/v1/chain/idle-stake", {
        signal,
      });
      return {
        data: normalizeChainIdleStake(res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1302: per-subnet on-chain history — daily neuron/validator counts, total
// stake and emission over a 7d/30d/90d/1y/all window, from the snapshot store.
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

/** One account identity revision. Dropped when it carries no hash: that is the
 * only field identifying a revision, so a row without it cannot be keyed or
 * de-duplicated against its neighbours. */
export function normalizeAccountIdentityHistoryEntry(
  raw: unknown,
): AccountIdentityHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const identity_hash = firstString(raw.identity_hash);
  if (!identity_hash) return null;
  return {
    identity_hash,
    observed_at: firstString(raw.observed_at) ?? null,
    name: firstString(raw.name) ?? null,
    url: firstString(raw.url) ?? null,
    github: firstString(raw.github) ?? null,
    image: firstString(raw.image) ?? null,
    discord: firstString(raw.discord) ?? null,
    description: firstString(raw.description) ?? null,
    additional: firstString(raw.additional) ?? null,
  };
}

function normalizeAccountIdentityHistory(ss58: string, raw: unknown): AccountIdentityHistory {
  const rec = isRecord(raw) ? raw : {};
  const entries = Array.isArray(rec.entries)
    ? rec.entries
        .map(normalizeAccountIdentityHistoryEntry)
        .filter((e): e is AccountIdentityHistoryEntry => e !== null)
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    account: firstString(rec.account) ?? ss58,
    // The SERVED count, not the parsed length, when the payload states one --
    // they differ exactly when a row was dropped above, and flattening that to
    // the survivors would hide the drop.
    entry_count: firstFiniteNumber(rec.entry_count) ?? entries.length,
    entries,
    limit: firstFiniteNumber(rec.limit) ?? null,
    offset: firstFiniteNumber(rec.offset) ?? null,
    next_cursor: firstString(rec.next_cursor) ?? null,
  };
}

/** Append-only on-chain identity timeline for one account (#10517), newest
 * first. Published since #1647's account sibling and rendered nowhere -- its
 * only mention anywhere in apps/ui was a row in a docs table. */
export const accountIdentityHistoryQuery = (ss58: string) =>
  queryOptions({
    queryKey: k("account-identity-history", ss58),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<AccountIdentityHistory>>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/identity-history`,
        { signal },
      );
      return {
        data: normalizeAccountIdentityHistory(ss58, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_MED,
  });

// #1647: append-only on-chain identity timeline for one subnet (newest first),
// from the subnet_identity_history store tier. No paging params surfaced yet — the
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

// #3486: windowed on-chain event-summary rollup for one subnet — total event
// count plus per-category/per-kind aggregates over a 7d/30d/90d window. The
// dashboard-friendly companion to the raw per-event feed the Activity tab
// renders; consolidates what would otherwise be several per-kind calls.
function normalizeSubnetEventCategory(raw: unknown): SubnetEventCategorySummary | null {
  if (!isRecord(raw)) return null;
  return {
    category: firstString(raw.category) ?? "other",
    event_count: firstFiniteNumber(raw.event_count) ?? 0,
    kind_count: firstFiniteNumber(raw.kind_count) ?? 0,
    amount_tao: firstFiniteNumber(raw.amount_tao) ?? 0,
    alpha_amount: firstFiniteNumber(raw.alpha_amount) ?? 0,
    first_block: firstFiniteNumber(raw.first_block) ?? null,
    last_block: firstFiniteNumber(raw.last_block) ?? null,
    first_observed_at: firstString(raw.first_observed_at) ?? null,
    last_observed_at: firstString(raw.last_observed_at) ?? null,
  };
}

function normalizeSubnetEventKind(raw: unknown): SubnetEventKindSummary | null {
  if (!isRecord(raw)) return null;
  const kind = firstString(raw.event_kind);
  if (!kind) return null;
  return {
    event_kind: kind,
    category: firstString(raw.category) ?? "other",
    event_count: firstFiniteNumber(raw.event_count) ?? 0,
    hotkey_count: firstFiniteNumber(raw.hotkey_count) ?? 0,
    coldkey_count: firstFiniteNumber(raw.coldkey_count) ?? 0,
    amount_tao: firstFiniteNumber(raw.amount_tao) ?? 0,
    alpha_amount: firstFiniteNumber(raw.alpha_amount) ?? 0,
    first_block: firstFiniteNumber(raw.first_block) ?? null,
    last_block: firstFiniteNumber(raw.last_block) ?? null,
    first_observed_at: firstString(raw.first_observed_at) ?? null,
    last_observed_at: firstString(raw.last_observed_at) ?? null,
  };
}

export function normalizeSubnetEventSummary(netuid: number, raw: unknown): SubnetEventSummary {
  const rec = isRecord(raw) ? raw : {};
  const categories = Array.isArray(rec.categories)
    ? rec.categories.flatMap((c) => {
        const normalized = normalizeSubnetEventCategory(c);
        return normalized ? [normalized] : [];
      })
    : [];
  const eventKinds = Array.isArray(rec.event_kinds)
    ? rec.event_kinds.flatMap((k) => {
        const normalized = normalizeSubnetEventKind(k);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    netuid: firstFiniteNumber(rec.netuid) ?? netuid,
    window: firstString(rec.window) ?? null,
    observed_at: firstString(rec.observed_at) ?? null,
    total_events: firstFiniteNumber(rec.total_events) ?? 0,
    kind_count: firstFiniteNumber(rec.kind_count) ?? 0,
    category_count: firstFiniteNumber(rec.category_count) ?? 0,
    limit: firstFiniteNumber(rec.limit) ?? 0,
    categories,
    event_kinds: eventKinds,
  };
}

export const subnetEventSummaryQuery = (netuid: number, window = "7d") =>
  queryOptions({
    queryKey: k("subnet-event-summary", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetEventSummary>>(
        `/api/v1/subnets/${netuid}/event-summary`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetEventSummary(netuid, res.data),
        meta: res.meta,
        url: res.url,
      };
    },
    staleTime: STALE_SHORT,
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
// stake/rank for a single neuron over a window, from the snapshot store.
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
    take: coerceFiniteNumber(raw.take) ?? null,
    // Only /validators rows carry this (#5166); booleanValue already maps an
    // absent/non-boolean cell to undefined, so metagraph/neuron-detail rows
    // (which never send it) keep the field genuinely absent, not a false.
    featured: booleanValue(raw.featured),
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

// The /api/v1/validators route's own published sort enum (#10994).
const GLOBAL_VALIDATOR_SORTS = QUERY_PARAMETER_ENUMS["/api/v1/validators"].sort;

function normalizeColdkeyIdentity(raw: unknown): ColdkeyIdentity | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;
  return {
    has_identity: booleanValue(raw.has_identity) ?? false,
    name: firstString(raw.name) ?? null,
    url: firstString(raw.url) ?? null,
    github: firstString(raw.github) ?? null,
    image: firstString(raw.image) ?? null,
    discord: firstString(raw.discord) ?? null,
    description: firstString(raw.description) ?? null,
    additional: firstString(raw.additional) ?? null,
    captured_at: firstString(raw.captured_at) ?? null,
  };
}

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
    // Always present on the wire (#5166); this builder has no `...raw`
    // spread, so it must be listed explicitly or it silently vanishes.
    featured: booleanValue(raw.featured) ?? false,
    coldkey: typeof raw.coldkey === "string" ? raw.coldkey : null,
    coldkey_identity: normalizeColdkeyIdentity(raw.coldkey_identity),
    coldkey_count: coerceFiniteNumber(raw.coldkey_count) ?? 0,
    subnet_count: coerceFiniteNumber(raw.subnet_count) ?? 0,
    uid_count: coerceFiniteNumber(raw.uid_count) ?? 0,
    take: nullableNum(raw.take),
    total_stake_tao: coerceFiniteNumber(raw.total_stake_tao) ?? 0,
    root_stake_tao: coerceFiniteNumber(raw.root_stake_tao) ?? 0,
    alpha_stake_tao: coerceFiniteNumber(raw.alpha_stake_tao) ?? 0,
    total_emission_tao: coerceFiniteNumber(raw.total_emission_tao) ?? 0,
    nominator_count: nullableNum(raw.nominator_count),
    apy_estimate: nullableNum(raw.apy_estimate),
    apy_estimate_eligible_subnet_count:
      coerceFiniteNumber(raw.apy_estimate_eligible_subnet_count) ?? 0,
    avg_validator_trust: nullableNum(raw.avg_validator_trust),
    max_validator_trust: nullableNum(raw.max_validator_trust),
    // On the wire since the leaderboard shipped, and dropped here until now --
    // this builder is an allowlist, so a field the API returns is invisible to
    // the entire UI unless it is named. That is why the table could not offer
    // realized return at all.
    realized_return_1d: nullableNum(raw.realized_return_1d),
    realized_return_1w: nullableNum(raw.realized_return_1w),
    realized_return_1m: nullableNum(raw.realized_return_1m),
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

/**
 * One registration-cost series.
 *
 * Every field the generated artifact declares is required, so the normalizer
 * supplies a defined value for each rather than widening the type to optional:
 * a partial wire body is a degraded read, and the tile should render a dash
 * from a null rather than branch on `undefined` at every use.
 */
export function normalizeSubnetBurnHistory(netuid: number, raw: unknown): SubnetBurnHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const p = isRecord(point) ? point : null;
        const burn = p ? coerceFiniteNumber(p.burn_tao) : null;
        const at = p ? coerceString(p.observed_at) : undefined;
        // A point with no price is not a zero-cost registration -- 0 is a real
        // burn (netuid 76 reads a true zero), so an unreadable sample is
        // dropped rather than charted as the cheapest point in the series.
        return burn != null && at ? [{ burn_tao: burn, observed_at: at }] : [];
      })
    : [];
  return {
    schema_version: coerceFiniteNumber(d.schema_version) ?? 1,
    netuid: coerceFiniteNumber(d.netuid) ?? netuid,
    window: coerceString(d.window) ?? null,
    point_count: coerceFiniteNumber(d.point_count) ?? points.length,
    current_burn_tao: coerceFiniteNumber(d.current_burn_tao) ?? null,
    change_tao: coerceFiniteNumber(d.change_tao) ?? null,
    change_pct: coerceFiniteNumber(d.change_pct) ?? null,
    points,
  };
}

/** Registration-cost (SubtensorModule.Burn) series for one subnet. */
export const subnetBurnHistoryQuery = (
  netuid: number,
  window: "24h" | "7d" | "30d" | "90d" = "7d",
) =>
  queryOptions({
    queryKey: k("subnet-burn-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetBurnHistory>>(
        `/api/v1/subnets/${netuid}/burn/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetBurnHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetBurnHistory>;
    },
    staleTime: STALE_MED,
  });

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

/**
 * Network-wide validator/operator leaderboard grouped by hotkey.
 *
 * `subnets` — the per-subnet breakdown array — is **66% of every row** (1,090
 * of 1,641 bytes, measured 2026-08-15) and most callers never read it. Passing
 * `subnets: false` drops it during normalization, which keeps it out of the
 * react-query cache and therefore out of the SSR dehydration inlined into the
 * document (#11315).
 *
 * That is the whole cost being paid: `/validators` rendered **50** rows while
 * dehydrating **1,447**, and the resulting 983 KB of inline JSON is decompressed,
 * parsed and deserialised on the main thread of whatever phone loaded the page.
 * The API has no field projection (`?fields=` answers 400), and the fetch itself
 * happens during SSR, so it never crosses the user's wire — dropping the array
 * client-side removes the part the user actually pays for.
 *
 * It is part of the query KEY on purpose: two callers asking for different
 * shapes must not share a cache entry, or whichever ran second would read rows
 * that are missing a field it needs.
 */
export function projectOperatorValidator(validator: GlobalValidator): OperatorValidator {
  return {
    hotkey: validator.hotkey,
    coldkey: validator.coldkey,
    coldkey_count: validator.coldkey_count,
    coldkey_identity:
      validator.coldkey_identity === null
        ? null
        : {
            has_identity: validator.coldkey_identity.has_identity,
            name: validator.coldkey_identity.name,
          },
    subnet_count: validator.subnet_count,
    uid_count: validator.uid_count,
    take: validator.take,
    total_stake_tao: validator.total_stake_tao,
    total_emission_tao: validator.total_emission_tao,
    nominator_count: validator.nominator_count,
    apy_estimate: validator.apy_estimate,
    stake_dominance: validator.stake_dominance,
    subnets: [],
  };
}

export const validatorsQuery = <Projection extends "full" | "operator" = "full">({
  sort = "subnet_count",
  limit = 20,
  subnets = true,
  identity = true,
  projection = "full" as Projection,
}: {
  sort?: GlobalValidatorSort;
  limit?: number;
  subnets?: boolean;
  /**
   * Keep the whole `coldkey_identity` object, or narrow it to the two fields
   * a ranked list reads.
   *
   * Same cost and same fix as `subnets` above: the identity carries nine
   * fields (url, github, image, discord, description, additional, captured_at
   * beyond the name), most of them null and none of them rendered by a hub
   * that only needs "does this key declare a brand, and what is it". Across
   * 1,036 keys that was ~150 KB of the ~1,390 KiB /validators inlines as SSR
   * dehydration (#11616).
   */
  identity?: boolean;
  /** Keep only fields the operator directory and peer ranking actually read. */
  projection?: Projection;
} = {}) =>
  queryOptions({
    queryKey: k("global-validators", sort, limit, subnets, identity, projection),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<GlobalValidators>>("/api/v1/validators", {
        params: { sort, limit },
        signal,
      });
      const data = normalizeGlobalValidators(res.data);
      const projected =
        projection === "operator"
          ? { ...data, validators: data.validators.map(projectOperatorValidator) }
          : subnets && identity
            ? data
            : {
                ...data,
                validators: data.validators.map((v) => ({
                  ...v,
                  ...(subnets ? {} : { subnets: [] }),
                  ...(identity || v.coldkey_identity === null
                    ? {}
                    : {
                        coldkey_identity: {
                          has_identity: v.coldkey_identity.has_identity,
                          name: v.coldkey_identity.name,
                          url: null,
                          github: null,
                          image: null,
                          discord: null,
                          description: null,
                          additional: null,
                          captured_at: null,
                        },
                      }),
                })),
              };
      return {
        data: projected,
        meta: res.meta,
        url: res.url,
      } as ApiResult<
        GlobalValidators<Projection extends "operator" ? OperatorValidator : GlobalValidator>
      >;
    },
    staleTime: STALE_SHORT,
  });

export interface ValidatorOperatorDirectory {
  operators: SerializedOperatorRow[];
  hotkey_count: number;
  captured_at: string | null;
}

export function normalizeValidatorOperatorDirectory(raw: unknown): ValidatorOperatorDirectory {
  const data = isRecord(raw) ? raw : {};
  const rows: OperatorRow[] = Array.isArray(data.operators)
    ? data.operators.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const primaryHotkey = firstString(entry.primary_hotkey);
        if (!primaryHotkey) return [];
        const identityName = firstString(entry.identity_name) ?? null;
        const totalStakeTao = coerceFiniteNumber(entry.total_stake_tao) ?? 0;
        const takeMin = coerceFiniteNumber(entry.take_min) ?? null;
        const takeMax = coerceFiniteNumber(entry.take_max) ?? null;
        const children = Array.isArray(entry.hotkeys)
          ? entry.hotkeys.flatMap((child) => {
              if (!isRecord(child)) return [];
              const childHotkey = firstString(child.hotkey);
              if (!childHotkey) return [];
              return [
                {
                  hotkey: childHotkey,
                  totalStakeTao: coerceFiniteNumber(child.total_stake_tao) ?? 0,
                  take: coerceFiniteNumber(child.take) ?? null,
                },
              ];
            })
          : [];
        const keys =
          children.length > 0
            ? children
            : [{ hotkey: primaryHotkey, totalStakeTao, take: takeMin }];
        const keyCount = coerceFiniteNumber(entry.hotkey_count) ?? keys.length;
        return [
          {
            key: firstString(entry.operator_id) ?? `hotkey:${primaryHotkey}`,
            name: identityName ?? shortKey(primaryHotkey),
            named: identityName !== null,
            keys,
            keyCount,
            primaryHotkey,
            coldkey: firstString(entry.coldkey) ?? null,
            totalStakeTao,
            totalEmissionTao: coerceFiniteNumber(entry.total_emission_tao) ?? 0,
            nominators: operatorNominatorCount(
              coerceFiniteNumber(entry.nominator_count) ?? null,
              Math.max(keyCount, keys.length),
            ),
            memberships: coerceFiniteNumber(entry.membership_count) ?? 0,
            uidCount: coerceFiniteNumber(entry.uid_count) ?? 0,
            takeMin,
            takeMax,
            apyEstimate: coerceFiniteNumber(entry.apy_estimate) ?? null,
            dominance: coerceFiniteNumber(entry.stake_dominance) ?? null,
          },
        ];
      })
    : [];
  return {
    operators: serializeOperatorRows(rows),
    hotkey_count: coerceFiniteNumber(data.validator_count) ?? 0,
    captured_at: firstString(data.captured_at)?.trim() || null,
  };
}

/**
 * The network-wide directory in the shape `/validators` actually renders.
 *
 * The data API now aggregates the rich per-hotkey leaderboard before this
 * request crosses the service boundary. The query still serializes the
 * readable operator objects into field-name-free tuples before React Query
 * dehydrates them, keeping both the upstream response and the HTML compact.
 */
export const validatorOperatorDirectoryQuery = () =>
  queryOptions({
    queryKey: k("validator-operator-directory"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/validators/operators", { signal });
      return {
        data: normalizeValidatorOperatorDirectory(res.data),
        meta: res.meta,
        url: res.url,
      } satisfies ApiResult<ValidatorOperatorDirectory>;
    },
    staleTime: STALE_SHORT,
  });

// #8252: site-wide accounts leaderboard -- the collection-level counterpart
// to validatorsQuery above, generalized to every registered hotkey (miners
// included) rather than just validator_permit=1 rows. Same aggregate row
// shape minus the validator-only take/APY/nominator fields.
function normalizeAccountListEntry(raw: unknown): AccountListEntry | null {
  if (!isRecord(raw)) return null;
  const hotkey = firstString(raw.hotkey);
  if (!hotkey) return null;
  return {
    hotkey,
    coldkey: firstString(raw.coldkey) ?? null,
    coldkey_count: coerceFiniteNumber(raw.coldkey_count) ?? 0,
    subnet_count: coerceFiniteNumber(raw.subnet_count) ?? 0,
    uid_count: coerceFiniteNumber(raw.uid_count) ?? 0,
    validator_count: coerceFiniteNumber(raw.validator_count) ?? 0,
    miner_count: coerceFiniteNumber(raw.miner_count) ?? 0,
    total_stake_tao: coerceFiniteNumber(raw.total_stake_tao) ?? 0,
    total_emission_tao: coerceFiniteNumber(raw.total_emission_tao) ?? 0,
    stake_dominance: coerceFiniteNumber(raw.stake_dominance) ?? null,
    latest_captured_at: firstString(raw.latest_captured_at) ?? null,
    latest_block_number: coerceFiniteNumber(raw.latest_block_number) ?? null,
  };
}

function normalizeAccountHolderDirectoryEntry(raw: unknown): AccountHolderDirectoryEntry | null {
  const account = normalizeAccountListEntry(raw);
  if (!account) return null;
  return {
    hotkey: account.hotkey,
    coldkey: account.coldkey,
    subnet_count: account.subnet_count,
    uid_count: account.uid_count,
    total_stake_tao: account.total_stake_tao,
    total_emission_tao: account.total_emission_tao,
    stake_dominance: account.stake_dominance,
  };
}

export function normalizeAccountHolderDirectory(raw: unknown): AccountHolderDirectory {
  const data = isRecord(raw) ? raw : {};
  const rankings = isRecord(data.rankings) ? data.rankings : {};
  const normalizeRanking = (value: unknown): AccountHolderDirectoryEntry[] =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const normalized = normalizeAccountHolderDirectoryEntry(entry);
          return normalized ? [normalized] : [];
        })
      : [];
  return {
    schema_version: coerceFiniteNumber(data.schema_version),
    captured_at: coerceString(data.captured_at),
    block_number: coerceFiniteNumber(data.block_number),
    account_count: coerceFiniteNumber(data.account_count) ?? 0,
    limit: coerceFiniteNumber(data.limit) ?? 0,
    priced_registered_stake_tao: coerceFiniteNumber(data.priced_registered_stake_tao) ?? 0,
    rankings: {
      stake: normalizeRanking(rankings.stake),
      emission: normalizeRanking(rankings.emission),
      reach: normalizeRanking(rankings.reach),
    },
  };
}

export const accountHolderDirectoryQuery = () =>
  queryOptions({
    queryKey: k("account-holder-directory"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/accounts/directory", { signal });
      return {
        data: normalizeAccountHolderDirectory(res.data),
        meta: res.meta,
        url: res.url,
      } satisfies ApiResult<AccountHolderDirectory>;
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
    emission_alpha: firstFiniteNumber(raw.emission_alpha) ?? null,
    stake_alpha: firstFiniteNumber(raw.stake_alpha) ?? null,
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
          coldkey_identity: normalizeColdkeyIdentity(d.coldkey_identity),
          coldkey_count: firstFiniteNumber(d.coldkey_count) ?? 0,
          subnet_count: firstFiniteNumber(d.subnet_count) ?? 0,
          take: firstFiniteNumber(d.take) ?? null,
          nominator_count: firstFiniteNumber(d.nominator_count) ?? null,
          total_stake_tao: firstFiniteNumber(d.total_stake_tao) ?? 0,
          root_stake_tao: firstFiniteNumber(d.root_stake_tao) ?? 0,
          alpha_stake_tao: firstFiniteNumber(d.alpha_stake_tao) ?? 0,
          total_emission_tao: firstFiniteNumber(d.total_emission_tao) ?? 0,
          avg_validator_trust: firstFiniteNumber(d.avg_validator_trust) ?? null,
          apy_estimate: firstFiniteNumber(d.apy_estimate) ?? null,
          apy_estimate_eligible_subnet_count:
            firstFiniteNumber(d.apy_estimate_eligible_subnet_count) ?? 0,
          realized_return_1d: firstFiniteNumber(d.realized_return_1d) ?? null,
          realized_return_1w: firstFiniteNumber(d.realized_return_1w) ?? null,
          realized_return_1m: firstFiniteNumber(d.realized_return_1m) ?? null,
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

function normalizeChainYieldDistribution(raw: unknown): ChainYieldDistribution | null {
  if (!isRecord(raw)) return null;
  const count = firstFiniteNumber(raw.count);
  if (count == null) return null;
  return {
    count,
    mean: firstFiniteNumber(raw.mean) ?? 0,
    median: firstFiniteNumber(raw.p50) ?? 0,
    min: firstFiniteNumber(raw.min) ?? 0,
    max: firstFiniteNumber(raw.max) ?? 0,
    p10: firstFiniteNumber(raw.p10) ?? 0,
    p25: firstFiniteNumber(raw.p25) ?? 0,
    p75: firstFiniteNumber(raw.p75) ?? 0,
    p90: firstFiniteNumber(raw.p90) ?? 0,
  };
}

// #3472: network-wide emission-yield aggregate — the return-rate companion to
// /chain/performance. Counts coerce to 0; the three role yields fall through to
// null (never NaN) when no neuron has both stake and emission.
export function normalizeChainYield(raw: unknown): ChainYield {
  const rec = isRecord(raw) ? raw : {};
  return {
    schema_version: firstFiniteNumber(rec.schema_version) ?? 1,
    subnet_count: firstFiniteNumber(rec.subnet_count) ?? 0,
    neuron_count: firstFiniteNumber(rec.neuron_count) ?? 0,
    validator_count: firstFiniteNumber(rec.validator_count) ?? 0,
    miner_count: firstFiniteNumber(rec.miner_count) ?? 0,
    captured_at: firstString(rec.captured_at) ?? null,
    total_stake_alpha: firstFiniteNumber(rec.total_stake_alpha) ?? 0,
    total_emission_alpha: firstFiniteNumber(rec.total_emission_alpha) ?? 0,
    network_yield: firstFiniteNumber(rec.network_yield) ?? null,
    validator_yield: firstFiniteNumber(rec.validator_yield) ?? null,
    miner_yield: firstFiniteNumber(rec.miner_yield) ?? null,
    distribution: normalizeChainYieldDistribution(rec.distribution),
  };
}

/** Network-wide emission-yield aggregate — return rate split by validator/miner role. */
export const chainYieldQuery = () =>
  queryOptions({
    queryKey: k("chain-yield"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<ChainYield>>("/api/v1/chain/yield", {
        signal,
      });
      return {
        data: normalizeChainYield(res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<ChainYield>;
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
    total_stake_alpha: coerceFiniteNumber(d.total_stake_alpha),
    total_emission_alpha: coerceFiniteNumber(d.total_emission_alpha),
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

function normalizeEmissionSplitPoint(raw: unknown): EmissionSplitPoint | null {
  if (!isRecord(raw)) return null;
  const date = coerceString(raw.snapshot_date);
  if (!date) return null;
  return {
    snapshot_date: date,
    validator_count: coerceFiniteNumber(raw.validator_count),
    miner_count: coerceFiniteNumber(raw.miner_count),
    earning_validator_count: coerceFiniteNumber(raw.earning_validator_count),
    earning_miner_count: coerceFiniteNumber(raw.earning_miner_count),
    // `?? null`, not `?? 0`: an unpriceable or un-emitted day publishes null,
    // and a zero here would read as "validators received none of it".
    validator_share_of_uid: coerceFiniteNumber(raw.validator_share_of_uid) ?? null,
    miner_share_of_uid: coerceFiniteNumber(raw.miner_share_of_uid) ?? null,
    owner_share: coerceFiniteNumber(raw.owner_share) ?? null,
    validator_share: coerceFiniteNumber(raw.validator_share) ?? null,
    miner_share: coerceFiniteNumber(raw.miner_share) ?? null,
    total_alpha: coerceFiniteNumber(raw.total_alpha) ?? null,
    owner_alpha: coerceFiniteNumber(raw.owner_alpha) ?? null,
    validator_alpha: coerceFiniteNumber(raw.validator_alpha) ?? null,
    miner_alpha: coerceFiniteNumber(raw.miner_alpha) ?? null,
    burned_alpha: coerceFiniteNumber(raw.burned_alpha) ?? null,
  };
}

function normalizeSubnetEmissionSplitHistory(
  netuid: number,
  raw: unknown,
): SubnetEmissionSplitHistory {
  const d = isRecord(raw) ? raw : {};
  const points = Array.isArray(d.points)
    ? d.points.slice(-MAX_HISTORY_POINTS).flatMap((point) => {
        const normalized = normalizeEmissionSplitPoint(point);
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

/** Per-day emission split by recipient class — owner / validator / miner. */
export const subnetEmissionSplitHistoryQuery = (
  netuid: number,
  window: "7d" | "30d" | "90d" = "30d",
) =>
  queryOptions({
    queryKey: k("subnet-emission-split-history", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetEmissionSplitHistory>>(
        `/api/v1/subnets/${netuid}/emission-split/history`,
        { params: { window }, signal },
      );
      return {
        data: normalizeSubnetEmissionSplitHistory(netuid, res.data),
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetEmissionSplitHistory>;
    },
    staleTime: STALE_MED,
  });

/** Whether a subnet's registered miners actually earn, over the series (#10931). */
export const subnetMinerFairnessQuery = (netuid: number, window: "7d" | "30d" | "90d" = "30d") =>
  queryOptions({
    queryKey: k("subnet-miner-fairness", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetMinerFairness>>(
        `/api/v1/subnets/${netuid}/miner-fairness`,
        { params: { window }, signal },
      );
      return {
        data: {
          netuid,
          window: res.data?.window,
          days_covered: res.data?.days_covered ?? 0,
          point_count: res.data?.point_count ?? 0,
          points: Array.isArray(res.data?.points) ? res.data.points : [],
          miner_uid_count: res.data?.miner_uid_count ?? 0,
          persistence: res.data?.persistence ?? null,
          entity_count: res.data?.entity_count ?? 0,
          uids_per_entity: res.data?.uids_per_entity ?? null,
          concentration: res.data?.concentration ?? null,
        } as SubnetMinerFairness,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetMinerFairness>;
    },
    staleTime: STALE_MED,
  });

/** What a subnet says it takes to participate, and what entry costs (#10932). */
export const subnetCostToParticipateQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-cost-to-participate", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetCostToParticipate>>(
        `/api/v1/subnets/${netuid}/cost-to-participate`,
        { signal },
      );
      return {
        data: {
          netuid,
          entry_cost: res.data?.entry_cost ?? {
            registration_cost_tao: null,
            validator_permit_floor_tao: null,
            validator_earning_floor_tao: null,
          },
          declarations_read: res.data?.declarations_read ?? 0,
          // NOT `?? {}` with empty specs. A missing declaration is null, and an
          // empty spec object would render as a row of dashes that reads like
          // "declared, and needs nothing".
          declared_compute: res.data?.declared_compute ?? {
            miner: null,
            validator: null,
            evidence: null,
          },
          declarations: Array.isArray(res.data?.declarations) ? res.data.declarations : [],
          earnings: res.data?.earnings ?? null,
          not_modelled: Array.isArray(res.data?.not_modelled) ? res.data.not_modelled : [],
        } as SubnetCostToParticipate,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetCostToParticipate>;
    },
    staleTime: STALE_MED,
  });

/** What a subnet's own source declares it allocates to a treasury (#10933). */
export const subnetTreasuryQuery = (netuid: number) =>
  queryOptions({
    queryKey: k("subnet-treasury", netuid),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetTreasury>>(`/api/v1/subnets/${netuid}/treasury`, {
        signal,
      });
      return {
        data: {
          netuid,
          repos_read: res.data?.repos_read ?? 0,
          reviewed_count: res.data?.reviewed_count ?? 0,
          pending_review_count: res.data?.pending_review_count ?? 0,
          declared_share: res.data?.declared_share ?? null,
          observed_share: res.data?.observed_share ?? null,
          // NOT `?? false`. Null is "not compared" and false is "they
          // disagree" — coalescing would accuse a team over an unread repo.
          declared_matches_observed: res.data?.declared_matches_observed ?? null,
          readings: Array.isArray(res.data?.readings) ? res.data.readings : [],
        } as SubnetTreasury,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetTreasury>;
    },
    staleTime: STALE_MED,
  });

/** How much of a subnet's emission reaches its owner — L1 + L2 (#10929). */
export const subnetOwnerCaptureQuery = (netuid: number, window: "7d" | "30d" | "90d" = "30d") =>
  queryOptions({
    queryKey: k("subnet-owner-capture", netuid, window),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Partial<SubnetOwnerCapture>>(
        `/api/v1/subnets/${netuid}/owner-capture`,
        { params: { window }, signal },
      );
      return {
        data: {
          netuid,
          window: res.data?.window,
          owner_coldkey: res.data?.owner_coldkey ?? null,
          point_count: res.data?.point_count ?? 0,
          points: Array.isArray(res.data?.points) ? res.data.points : [],
          owner_uid_count: res.data?.owner_uid_count ?? null,
          owner_uids: Array.isArray(res.data?.owner_uids) ? res.data.owner_uids : [],
          // NOT defaulted away. An empty blind-spot list would render a capture
          // figure with nothing stating what it cannot see, which is the one
          // shape this surface must never produce.
          blind_spots: Array.isArray(res.data?.blind_spots) ? res.data.blind_spots : [],
        } as SubnetOwnerCapture,
        meta: res.meta,
        url: res.url,
      } as ApiResult<SubnetOwnerCapture>;
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

function normalizeCompareValidator(raw: unknown): CompareValidator | null {
  if (!isRecord(raw)) return null;
  const hotkey = coerceString(raw.hotkey);
  if (!hotkey) return null;
  const nullableNum = (value: unknown): number | null =>
    value == null ? null : (coerceFiniteNumber(value) ?? null);
  return {
    hotkey,
    coldkey: coerceString(raw.coldkey) ?? null,
    coldkey_identity: normalizeColdkeyIdentity(raw.coldkey_identity),
    take: nullableNum(raw.take),
    apy_estimate: nullableNum(raw.apy_estimate),
    apy_estimate_eligible_subnet_count: nullableNum(raw.apy_estimate_eligible_subnet_count),
    nominator_count: nullableNum(raw.nominator_count),
    total_stake_tao: nullableNum(raw.total_stake_tao),
    total_emission_tao: nullableNum(raw.total_emission_tao),
    avg_validator_trust: nullableNum(raw.avg_validator_trust),
    max_validator_trust: nullableNum(raw.max_validator_trust),
    subnet_count: nullableNum(raw.subnet_count),
    subnet_context: normalizeGlobalValidatorSubnet(raw.subnet_context),
  };
}

export function normalizeCompareValidators(raw: unknown): CompareValidators {
  const d = isRecord(raw) ? raw : {};
  const validators = Array.isArray(d.validators)
    ? d.validators.flatMap((validator) => {
        const normalized = normalizeCompareValidator(validator);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    netuid: d.netuid == null ? null : (coerceFiniteNumber(d.netuid) ?? null),
    validator_count: coerceFiniteNumber(d.validator_count) ?? validators.length,
    validators,
  };
}

/**
 * Validator-side comparison (#6325/#6998): each selected hotkey's take rate,
 * estimated APY, nominator count, identity, and cross-subnet aggregates in one
 * request — the validator equivalent of compareQuery above, so the validators
 * compare drawer renders its grid from a single call instead of a
 * validator-detail request per selected hotkey. `netuid` is the route's
 * optional subnet-context parameter: when set, each row also carries that
 * validator's membership in that one subnet (subnet_context).
 */
export const compareValidatorsQuery = (hotkeys: string[], netuid?: number) =>
  queryOptions({
    queryKey: k("compare-validators", [...hotkeys].sort(), netuid ?? null),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/compare/validators", {
        // buildUrl drops undefined params, so netuid only reaches the URL when set.
        params: { hotkeys: hotkeys.join(","), netuid },
        signal,
      });
      return { data: normalizeCompareValidators(res.data), meta: res.meta, url: res.url };
    },
    enabled: hotkeys.length > 0,
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

/**
 * Cursor-paginated first-party events for ONE account, newest first.
 *
 * The account page reads its whole activity stream through this rather than
 * the bounded `accountEventsQuery`: the three tabs it replaced (Transfers,
 * Activity, Extrinsics) were filtered views of this one feed, and a reader
 * who scrolls past the first page should not hit a wall (#11614).
 */
export const accountEventsInfiniteQuery = (ss58: string, baseParams: QueryParams = {}) =>
  infiniteQueryOptions({
    queryKey: k("account-events-infinite", ss58, baseParams),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      fetchInfinitePage<AccountEvent>(
        `/api/v1/accounts/${ss58PathSegment(ss58)}/events`,
        "events",
        baseParams,
        pageParam,
        signal,
      ),
    getNextPageParam,
    staleTime: STALE_SHORT,
  });

/** Alias for {@link chainEventsInfiniteQuery} — raw /api/v1/chain-events paginator. */
export const chainEventsQuery = chainEventsInfiniteQuery;

/**
 * A single bounded, newest-first page of /api/v1/chain-events with no
 * pagination machinery — for small previews (metagraphed#8359) that just want
 * "the latest N", optionally pallet/method-filtered (e.g. Balances.Transfer).
 */
export const recentChainEventsQuery = (baseParams: QueryParams = {}) =>
  queryOptions({
    queryKey: k("chain-events-recent", baseParams),
    queryFn: async ({ signal }) => {
      const page = await fetchChainEventsInfinitePage(baseParams, "", signal);
      return page.data;
    },
    staleTime: STALE_SHORT,
  });

/** Server-driven cursor-paginated subnets. */
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

/**
 * Fields the API sends on every endpoint row that this app reads NOWHERE
 * (#11326).
 *
 * `normalizeEndpoint` spreads the raw row, so anything the API adds survives
 * into the react-query cache and therefore into the SSR dehydration inlined in
 * the document. `/apis/endpoints` fetches the whole catalogue — **3,372 rows** —
 * which is why it is the heaviest page on the site at **4,948 KB uncompressed**
 * in production, nearly 4x /validators.
 *
 * Each name below was checked across the whole of apps/ui: zero references
 * outside queries.ts and types.ts, and none is declared on `Endpoint`. Fields
 * that ARE read somewhere — `source_urls`, `rate_limit_notes`,
 * `classification` — are deliberately absent from this list and still pass
 * through.
 *
 * This is dead data, not a per-query projection: there is no caller for whom
 * these are live, so unlike `validatorsQuery`'s `subnets` option this needs no
 * cache-key split. Re-check with a grep before adding to it.
 */
const UNREAD_ENDPOINT_FIELDS = [
  "monitoring_policy",
  "method_support",
  "method_tested",
  "score_reasons",
  "pool_eligibility_reasons",
] as const;

function normalizeEndpoint(raw: unknown): Endpoint {
  if (!raw || typeof raw !== "object") return raw as Endpoint;
  const e = raw as Record<string, unknown>;
  const lean: Record<string, unknown> = { ...e };
  for (const field of UNREAD_ENDPOINT_FIELDS) delete lean[field];
  return {
    ...(lean as object),
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
  const netuidRaw = i.netuid;
  const netuid =
    typeof netuidRaw === "number" && Number.isInteger(netuidRaw)
      ? netuidRaw
      : typeof netuidRaw === "string" && /^\d+$/.test(netuidRaw)
        ? Number(netuidRaw)
        : undefined;
  return {
    ...(i as object),
    id: asString(i.id) ?? "",
    endpoint_id: asString(i.endpoint_id),
    netuid,
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

/**
 * The /api/v1/endpoints response's own `summary` block (#11623).
 *
 * `fetchList` returns the ROWS and drops everything beside them, so the fleet
 * counters — `endpoint_count`, `monitored_count`, `by_status` — are not
 * reachable from `endpointsQuery`. Counting them off a page of rows would be
 * wrong twice over: the endpoint caps `limit` at 1,000 against a 3,391-row
 * fleet, and the directory sends its facets to the server, so the rows in hand
 * are a filtered slice by design. One cheap request for the real numbers.
 */
export const endpointsSummaryQuery = () =>
  queryOptions({
    queryKey: k("endpoints-summary"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/endpoints", {
        params: { limit: 1 },
        signal,
      });
      const data = isRecord(res.data) ? res.data : {};
      const summary = isRecord(data.summary) ? data.summary : {};
      return {
        ...res,
        data: {
          endpoint_count: firstFiniteNumber(summary.endpoint_count) ?? 0,
          monitored_count: firstFiniteNumber(summary.monitored_count) ?? 0,
          by_status: isRecord(summary.by_status)
            ? (summary.by_status as Record<string, number>)
            : {},
          observed_at: firstString(data.operational_observed_at) ?? firstString(data.generated_at),
        },
      };
    },
    staleTime: STALE_MED,
  });

/** Cursor-paginated endpoints, for the directory's own server-side facets. */
export const endpointsInfiniteQuery = (baseParams: QueryParams = {}, initialCursor = "") =>
  infiniteQueryOptions({
    queryKey: k("endpoints-infinite", baseParams, initialCursor),
    initialPageParam: initialCursor,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchInfinitePage<unknown>(
        "/api/v1/endpoints",
        "endpoints",
        baseParams,
        pageParam as string,
        signal,
      );
      return { ...page, data: page.data.map(normalizeEndpoint) } as InfinitePage<Endpoint>;
    },
    getNextPageParam,
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

export const endpointPoolsQuery = () =>
  queryOptions({
    queryKey: k("endpoint-pools"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>("/api/v1/endpoint-pools", "pools", undefined, signal);
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
// global incident ledger. A cold store already yields a schema-stable
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
  const install = stringValue(r.install);
  return {
    id,
    kind: AGENT_RESOURCE_KINDS.has(kind) ? kind : "api",
    title,
    url,
    ...(install ? { install } : {}),
  };
}

export function normalizeAgentResources(raw: unknown): AgentResources {
  const d = recordValue(raw);
  const copyableAgent = recordValue(d.copyable_agent);
  const mcp = recordValue(d.mcp);
  const summary = recordValue(d.summary);
  const coreEndpoint = stringValue(mcp.core_endpoint);
  const recommendedEndpoint = stringValue(mcp.recommended_endpoint);
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
      ...(coreEndpoint ? { core_endpoint: coreEndpoint } : {}),
      endpoint: stringValue(mcp.endpoint),
      install: stringValue(mcp.install),
      ...(recommendedEndpoint ? { recommended_endpoint: recommendedEndpoint } : {}),
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
 * Resolved-only endpoint incidents, newest-first (metagraphed#8355).
 *
 * A DIFFERENT query from endpointIncidentsQuery above, not a client-side
 * filter over it: that one is the ops-console feed (incident-strip,
 * endpoints-priority-strip, network-pulse-band, the /health and /endpoints
 * pages) and deliberately shows every state, active included -- that's the
 * whole point of an ops incident view. The "What changed" digest wants the
 * opposite: "this surface recovered" is a real change worth reporting,
 * "this surface is currently timing out" is operational noise that belongs
 * on /status and the ops console, not competing with registry/identity/
 * runtime changes for the reader's attention. `state: "resolved"` is a
 * server-side filter (not fetched-then-hidden) so the digest never has to
 * download the whole active-incident set just to throw most of it away.
 */
export const resolvedEndpointIncidentsQuery = (limit = 25) =>
  queryOptions({
    queryKey: k("endpoint-incidents", { state: "resolved", limit }),
    queryFn: async ({ signal }) => {
      const res = await fetchList<unknown>(
        "/api/v1/endpoint-incidents",
        "incidents",
        { state: "resolved", sort: "detected_at", order: "desc", limit },
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
  const repo = pickStr(inner.github_url, inner.repo, inner.repository);
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
    repo,
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

// #3355: the per-target enrichment board — distinct from the per-subnet
// enrichment-queue rollup above. GET /api/v1/review/enrichment-targets, flat
// `targets` list (the `groups`/`summary` wrapper is out of scope).
export const reviewEnrichmentTargetsQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-targets"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/enrichment-targets",
        "targets",
        undefined,
        signal,
      );
      // API rows: { netuid, name, target_type, target_action, priority_score,
      // missing_kinds, recommended_action, contribution_prompt, ... }.
      const rows = res.data.map((r) => ({
        id:
          (r.target_id as string) ??
          `${(r.slug as string) ?? String(r.netuid ?? "")}-${(r.target_type as string) ?? ""}`,
        netuid: r.netuid as number | undefined,
        name: r.name as string | undefined,
        targetType: (r.target_type as string) ?? (r.kind as string),
        targetAction: r.target_action as string | undefined,
        priority:
          typeof r.priority_score === "number"
            ? String(Math.round(r.priority_score as number))
            : undefined,
        note:
          (Array.isArray(r.missing_kinds) && r.missing_kinds.length > 0
            ? (r.missing_kinds as string[]).join(", ")
            : undefined) ??
          (r.recommended_action as string) ??
          (r.contribution_prompt as string),
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

// #3354: the per-subnet evidence behind the enrichment queue -- distinct from
// the enrichment-queue rollup and the enrichment-targets board above (per the
// MCP tool description, "distinct from list_enrichment_queue"). GET
// /api/v1/review/enrichment-evidence, flat `entries` list.
export const reviewEnrichmentEvidenceQuery = () =>
  queryOptions({
    queryKey: k("review-enrichment-evidence"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/enrichment-evidence",
        "entries",
        undefined,
        signal,
      );
      // API rows: { netuid, name, slug, lane, evidence_action, missing_kinds,
      // direct_submission_kinds, priority_score, ... }.
      const rows = res.data.map((r) => ({
        id: (r.slug as string) ?? (r.name as string) ?? String(r.netuid ?? ""),
        netuid: r.netuid as number | undefined,
        name: r.name as string | undefined,
        lane: r.lane as string | undefined,
        evidenceAction: r.evidence_action as string | undefined,
        missingKinds: Array.isArray(r.missing_kinds) ? (r.missing_kinds as string[]) : [],
        directSubmissionKinds: Array.isArray(r.direct_submission_kinds)
          ? (r.direct_submission_kinds as string[])
          : [],
        priority:
          typeof r.priority_score === "number"
            ? String(Math.round(r.priority_score as number))
            : undefined,
      }));
      return { ...res, data: rows };
    },
    staleTime: STALE_LONG,
  });

// #11227: the attribution sweep's REVIEW QUEUE -- addresses found in the text
// of pages subnets publish, which no human has judged yet.
//
// DISTINCT FROM EVERY OTHER BOARD ON THIS PAGE, and the difference is not the
// dataset but the CLAIM. The enrichment and gap boards say "this subnet is
// missing something we can go and add". This one says "this string looked like
// an address on that page" -- it is a lead, and rendering it as an attribution
// is the exact error src/attribution-sweep.ts refuses to make. Which is why
// `sourceUrl` is carried on every row and rendered as a link: the review is
// opening it.
//
// `reviewableCount` is read off the payload rather than from `rows.length`.
// The array is trimmed by the route's `?limit=`, so counting it would report
// the limit as the population -- the defect the older registry list routes
// carry, and one this route publishes a real total specifically to avoid.
export const reviewAttributionCandidatesQuery = () =>
  queryOptions({
    queryKey: k("review-attribution-candidates"),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Record<string, unknown>>("/api/v1/review/attribution-candidates", {
        signal,
      });
      const d = isRecord(res.data) ? res.data : {};
      const rows = (Array.isArray(d.candidates) ? d.candidates : [])
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const ss58 = firstString(raw.ss58);
          const sourceUrl = firstString(raw.source_url);
          const netuid = firstFiniteNumber(raw.netuid);
          if (!ss58 || !sourceUrl || netuid == null) return null;
          return {
            id: `${netuid}:${ss58}:${sourceUrl}`,
            netuid,
            ss58,
            sourceUrl,
            firstSeen: firstString(raw.first_seen) ?? null,
            lastSeen: firstString(raw.last_seen) ?? null,
            sourceAddressCount: firstFiniteNumber(raw.source_address_count) ?? null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      return {
        ...res,
        data: rows,
        // NOT defaulted to rows.length -- see the note above.
        reviewableCount: firstFiniteNumber(d.reviewable_count) ?? null,
        suppressedCount: firstFiniteNumber(d.suppressed_count) ?? null,
        suppressedSourceCount: firstFiniteNumber(d.suppressed_source_count) ?? null,
        listingAddressCap: firstFiniteNumber(d.listing_address_cap) ?? null,
      };
    },
    staleTime: STALE_LONG,
  });

// #3356: the priority-scored per-subnet gap board -- distinct from gapsQuery()
// (/api/v1/gaps, the interface-facet dataset already on this page) and from
// the enrichment-queue/-targets/-evidence sections above. GET
// /api/v1/review/gaps, flat `priorities` list.
export const reviewGapPrioritiesQuery = () =>
  queryOptions({
    queryKey: k("review-gap-priorities"),
    queryFn: async ({ signal }) => {
      const res = await fetchList<Record<string, unknown>>(
        "/api/v1/review/gaps",
        "priorities",
        undefined,
        signal,
      );
      // API rows: { netuid, name, curation_level, priority_score, missing_kinds,
      // surface_count, verified_candidate_count, candidate_count, ... }.
      const rows: ReviewGapPriority[] = res.data.map((r) => ({
        netuid: r.netuid as number | undefined,
        name: r.name as string | undefined,
        curation_level: r.curation_level as CurationLevel | string | undefined,
        priority_score: r.priority_score as number | undefined,
        missing_kinds: Array.isArray(r.missing_kinds) ? (r.missing_kinds as string[]) : [],
        surface_count: r.surface_count as number | undefined,
        candidate_count: r.candidate_count as number | undefined,
        verified_candidate_count: r.verified_candidate_count as number | undefined,
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

// Vector-similarity fallback for the keyword-only /api/v1/search-index above.
// Response is a single object with `results` nested inside (not a bare list or
// a { <collection>: T[] } wrapper), so this builds directly on apiFetch rather
// than the fetchList list-unwrapping helper.
/**
 * What did the user paste (metagraphed-infra#362)?
 *
 * Deliberately SEPARATE from semanticSearchQuery and safe to run alongside it:
 * this route is deterministic, needs no AI binding, and answers from the shape
 * of the query alone -- so an explorer's most common search never waits on, or
 * pays for, an embedding.
 *
 * `staleTime: Infinity` because the answer is a pure function of the query. The
 * same string resolves to the same destinations forever; there is nothing on
 * the server that can change it.
 */
export const searchResolveQuery = (q: string) =>
  queryOptions({
    queryKey: k("search-resolve", q),
    queryFn: ({ signal }) =>
      apiFetch<SearchResolveResponse>("/api/v1/search/resolve", {
        params: { q },
        signal,
      }),
    enabled: q.trim().length > 0,
    staleTime: Infinity,
  });

/**
 * The ss58 an EVM address maps to (metagraphed-infra#373).
 *
 * WHY THE UI DOES THE LOOKUP. `/api/v1/search/resolve` recognises an H160 from
 * its shape alone and points here, deliberately without resolving it: the
 * resolver is lookup-free so that every OTHER identifier shape stays an instant
 * answer. Turning the mapping into a destination is a second request, and this
 * is where it belongs.
 *
 * `staleTime: Infinity` because an EVM->ss58 mapping is set once on-chain and
 * does not change.
 */
export const evmAddressMappingQuery = (h160: string) =>
  queryOptions({
    queryKey: k("evm-address", h160),
    queryFn: ({ signal }) =>
      apiFetch<EvmAddressMappingResponse>(
        `/api/v1/evm/address/${encodeURIComponent(h160.trim())}`,
        { signal },
      ),
    enabled: h160.trim().length > 0,
    staleTime: Infinity,
  });

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

/**
 * #8372: the whole curated-nametag registry in ONE request, indexed by ss58.
 *
 * Deliberately not per-address (accountEntitiesQuery above is the per-address
 * shape, for the account-detail Entity section): inline resolution runs on
 * every address in a table, so a per-address query would mean 50 requests to
 * render one page of transfers. The artifact is a small curated set, changes
 * only when a registry PR merges, and is served from the same artifact tier
 * everything else reads -- so one long-cached fetch backs every
 * AddressDisplay on the page.
 */
export const nametagIndexQuery = () =>
  queryOptions({
    queryKey: k("nametag-index"),
    queryFn: async ({ signal }): Promise<Map<string, AccountEntityLabel>> => {
      const res = await apiFetch<unknown>("/metagraph/entities.json", { signal });
      const d = isRecord(res.data) ? res.data : {};
      const rows = Array.isArray(d.entities) ? d.entities : [];
      const index = new Map<string, AccountEntityLabel>();
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const ss58 = firstString(row.ss58);
        const label = normalizeEntityLabel(row);
        // A row with no address, or with no name to show, can't resolve
        // anything -- skip rather than seeding an entry that would always
        // fall through to the truncated form anyway.
        if (!ss58 || !label?.name) continue;
        index.set(ss58, label);
      }
      return index;
    },
    staleTime: STALE_LONG,
  });
