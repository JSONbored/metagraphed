// Live network-wide Prometheus-endpoint serving activity from the account_events PrometheusServed
// stream: a per-subnet leaderboard plus a network rollup and intensity distribution. Pure shaping
// (buildChainPrometheus) + a thin D1 loader (loadChainPrometheus); the field semantics live in
// schemas/components/05-subnets.schema.json (ChainPrometheusArtifact). The telemetry-endpoint
// companion to the axon-endpoint /chain/serving: PrometheusServed announces the metrics endpoint a
// neuron exposes (which subnets run observability infrastructure), read from the same account_events
// [netuid, hotkey] tuple AxonServed uses.

const DAY_MS = 24 * 60 * 60 * 1000;

// The account_events kind emitted when a neuron announces its Prometheus telemetry endpoint on a subnet.
export const PROMETHEUS_EVENT_KIND = "PrometheusServed";

export const CHAIN_PROMETHEUS_LIMIT_DEFAULT = 20;
export const CHAIN_PROMETHEUS_LIMIT_MAX = 100;

// Supported lookback windows (label -> days), matching the REST route's analytics
// window set (7d/30d, default 7d). Kept next to the loader so the MCP tool's input
// schema and runtime validation cannot drift from the endpoint.
export const CHAIN_PROMETHEUS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_PROMETHEUS_WINDOW = "7d";

// Round an announcements-per-exporter ratio to a stable precision (2dp). Always finite and
// non-negative here (events / distinct hotkeys, with the divisor guarded below).
function round(value, dp = 2) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null AND a
// blank/whitespace-only string explicitly so neither is silently coerced to subnet 0
// (Number(null), Number(""), and Number("  ") all === 0); a malformed row must be skipped,
// never counted as netuid 0.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Newest epoch-ms observed_at, or null when not finite/absent — rendered as ISO for the
// envelope's generated_at, the same way account-events does.
function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Average PrometheusServed events per distinct hotkey — the subnet's re-announcement intensity
// (1.0 means each exporter announced once; higher means repeated announcements). A subnet with
// no exporters has no defined intensity (null) rather than a divide-by-zero.
function announcementsPerExporter(announcements, exporters) {
  if (exporters <= 0) return null;
  return round(announcements / exporters);
}

// Nearest-rank percentile of a NON-EMPTY ascending numeric array (deterministic, no
// interpolation). Only called from intensityDistribution, which short-circuits an empty set to
// null before reaching here.
function percentile(ascending, p) {
  const rank = Math.ceil((p / 100) * ascending.length);
  return ascending[Math.min(rank, ascending.length) - 1];
}

// Conventional median of a NON-EMPTY ascending numeric array: the middle value for an odd count,
// the mean of the two middle values for an even count (so an even count returns the average of the
// two middles, not the lower-middle a nearest-rank p50 gives). The averaging form needs no odd/even
// branch — for an odd count the two indices coincide and it returns that middle value unchanged.
// Matches median() in chain-yield.mjs / subnet-yield.mjs so a `median` field is the same statistic
// across the API. Reached only after intensityDistribution's empty short-circuit.
function median(ascending) {
  const mid = (ascending.length - 1) / 2;
  return round((ascending[Math.floor(mid)] + ascending[Math.ceil(mid)]) / 2);
}

// Spread of the per-subnet re-announcement intensity across every subnet with Prometheus activity:
// count, mean, and min / p25 / median / p75 / p90 / max. Null when no subnet saw an announcement.
function intensityDistribution(values) {
  /* v8 ignore next -- defensive: only called with one value per subnet, and the builder returns
     the empty block (distribution null) before this runs when there are no subnets */
  if (values.length === 0) return null;
  const ascending = [...values].sort((a, b) => a - b);
  const sum = ascending.reduce((total, value) => total + value, 0);
  return {
    count: ascending.length,
    mean: round(sum / ascending.length),
    min: ascending[0],
    p25: percentile(ascending, 25),
    median: median(ascending),
    p75: percentile(ascending, 75),
    p90: percentile(ascending, 90),
    max: ascending[ascending.length - 1],
  };
}

const EMPTY_NETWORK = {
  distinct_exporters: 0,
  announcements: 0,
  announcements_per_exporter: null,
};

// Shape the network-wide Prometheus scorecard from the per-subnet account_events aggregate.
// `subnetRows` carries one row per netuid (COUNT(*) announcements, COUNT(DISTINCT hotkey)
// distinct_exporters). `networkDistinct` carries the true network-wide distinct hotkey count (a
// hotkey announcing on several subnets counts once, so this is NOT the sum of the per-subnet
// distinct_exporters) plus the newest observed_at. `limit` caps the leaderboard; subnet_count and
// the distribution span every subnet with observed Prometheus activity (subnets with no
// PrometheusServed events in the window are absent). Null-safe: no rows yields the empty block.
export function buildChainPrometheus(
  subnetRows,
  { window, limit = CHAIN_PROMETHEUS_LIMIT_DEFAULT, networkDistinct } = {},
) {
  const list = Array.isArray(subnetRows) ? subnetRows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(1, Math.min(flooredLimit, CHAIN_PROMETHEUS_LIMIT_MAX))
    : CHAIN_PROMETHEUS_LIMIT_DEFAULT;
  const observedAt = toIso(networkDistinct?.newest_observed);

  const empty = {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: 0,
    network: { ...EMPTY_NETWORK },
    intensity_distribution: null,
    subnets: [],
  };
  if (list.length === 0) return empty;

  // Merge by netuid so a malformed direct caller passing duplicate rows for a subnet sums rather
  // than double-counting (the SQL loader GROUPs BY netuid, so production rows are unique per
  // subnet; this keeps the pure builder correct outside that path).
  const perNetuid = new Map();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const exporters = toCount(row?.distinct_exporters);
    if (exporters === 0) continue; // no exporters announced: not a telemetry surface
    const bucket = perNetuid.get(netuid) ?? { exporters: 0, announcements: 0 };
    bucket.exporters += exporters;
    bucket.announcements += toCount(row?.announcements);
    perNetuid.set(netuid, bucket);
  }
  if (perNetuid.size === 0) return empty;

  const subnets = [];
  let totalAnnouncements = 0;
  for (const [netuid, bucket] of perNetuid) {
    subnets.push({
      netuid,
      distinct_exporters: bucket.exporters,
      announcements: bucket.announcements,
      announcements_per_exporter: announcementsPerExporter(
        bucket.announcements,
        bucket.exporters,
      ),
    });
    totalAnnouncements += bucket.announcements;
  }
  // Most active Prometheus subnets first (by total PrometheusServed events), tie-broken by netuid.
  subnets.sort(
    (a, b) => b.announcements - a.announcements || a.netuid - b.netuid,
  );

  const networkExporters = toCount(networkDistinct?.distinct_exporters);
  const network = {
    distinct_exporters: networkExporters,
    announcements: totalAnnouncements,
    announcements_per_exporter: announcementsPerExporter(
      totalAnnouncements,
      networkExporters,
    ),
  };

  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: observedAt,
    subnet_count: subnets.length,
    network,
    // Distribution of per-subnet re-announcement intensity over EVERY subnet (not just the
    // returned page), so the spread is network-wide even when `limit` truncates the leaderboard.
    intensity_distribution: intensityDistribution(
      subnets.map((subnet) => subnet.announcements_per_exporter),
    ),
    subnets: subnets.slice(0, normalizedLimit),
  };
}

// Network-wide Prometheus-serving activity, computed live: read the account_events PrometheusServed
// stream over the window (observed_at >= now - windowDays, epoch ms), first as a single network
// aggregate (true distinct exporters + newest observed_at, bounded by idx_account_events_observed)
// and then grouped by netuid for the per-subnet leaderboard, and shape with buildChainPrometheus.
// The newest-observed probe doubles as the cold-store guard: a null MAX(observed_at) skips the
// per-subnet read. The handler resolves windowLabel/windowDays from analyticsWindow (7d/30d).
// Cold/absent store -> the schema-stable empty block.
export async function loadChainPrometheus(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const networkRows = await d1(
    "SELECT COUNT(DISTINCT hotkey) AS distinct_exporters, " +
      "MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [PROMETHEUS_EVENT_KIND, cutoff],
  );
  const networkDistinct = networkRows?.[0] ?? null;
  let subnetRows = [];
  if (networkDistinct?.newest_observed != null) {
    subnetRows = await d1(
      "SELECT netuid, COUNT(*) AS announcements, COUNT(DISTINCT hotkey) AS distinct_exporters " +
        "FROM account_events WHERE event_kind = ? AND observed_at >= ? GROUP BY netuid " +
        "ORDER BY announcements DESC, netuid ASC",
      [PROMETHEUS_EVENT_KIND, cutoff],
    );
  }
  return buildChainPrometheus(subnetRows, {
    window: windowLabel,
    limit,
    networkDistinct,
  });
}
