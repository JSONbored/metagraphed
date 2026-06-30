// Cross-subnet momentum ("movers"): rank every subnet by how much its stake, emission,
// and validator set changed between a window's start and end neuron_daily snapshots.
// Pure shaping (computeMovers/buildMovers) + a thin D1 loader (loadSubnetMovers); the
// Worker adds the REST envelope. Null-safe: a cold store or a single snapshot yields an
// empty movers list (never throws), matching the sibling live tiers (turnover, history).
//
// Reads the neuron_daily rollup the refresh-metagraph cron lands daily. The route's scans
// filter on snapshot_date first (the window-boundary MIN/MAX and the two-day aggregate), so
// the date-first idx_neuron_daily_date_netuid_agg (migrations/0030) covers them.

// Supported comparison windows (label -> days): the 7d/30d/90d set the concentration scorecards use.
export const MOVERS_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_MOVERS_WINDOW = "30d";

// Rankable metrics: the signed delta to sort the leaderboard by.
export const MOVERS_SORTS = ["stake", "emission", "validators"];
export const DEFAULT_MOVERS_SORT = "stake";

export const MOVERS_LIMIT_DEFAULT = 20;
export const MOVERS_LIMIT_MAX = 100;

// 1 TAO = 1e9 rao. Round every TAO output to rao precision; IEEE-754 noise below the rao
// floor is artifact (mirrors the rounding the turnover/history scorecards apply).
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  return Math.round(toNumber(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite number,
// defaulting to 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A non-negative integer netuid, or null for a malformed cell.
function normalizedNetuid(value) {
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// Percentage change start -> end, rounded to 2dp. Null when start is 0 (growth from
// nothing is undefined) or either side is non-finite.
function pctChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0)
    return null;
  return Math.round(((end - start) / start) * 100 * 100) / 100;
}

// Index per-subnet aggregate rows (one row per netuid for a single snapshot_date) into a
// Map netuid -> { neurons, validators, stake, emission }.
function indexByNetuid(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    map.set(netuid, {
      neurons: toNumber(row?.neuron_count),
      validators: toNumber(row?.validator_count),
      stake: toNumber(row?.total_stake_tao),
      emission: toNumber(row?.total_emission_tao),
    });
  }
  return map;
}

const ZERO = { neurons: 0, validators: 0, stake: 0, emission: 0 };

const SORT_KEY = {
  stake: "stake_delta_tao",
  emission: "emission_delta_tao",
  validators: "validators_delta",
};

// Build the per-subnet mover scorecards from the start + end snapshot aggregates and rank
// them by the chosen metric's signed delta (biggest gainers first, biggest losers last),
// tie-broken by netuid for a stable order. Returns ALL subnets (the handler caps to limit).
export function computeMovers(
  startRows,
  endRows,
  { sort = DEFAULT_MOVERS_SORT } = {},
) {
  const startMap = indexByNetuid(startRows);
  const endMap = indexByNetuid(endRows);
  const netuids = new Set([...startMap.keys(), ...endMap.keys()]);
  const movers = [];
  for (const netuid of netuids) {
    const s = startMap.get(netuid) ?? ZERO;
    const e = endMap.get(netuid) ?? ZERO;
    movers.push({
      netuid,
      stake_start_tao: roundTao(s.stake),
      stake_end_tao: roundTao(e.stake),
      stake_delta_tao: roundTao(e.stake - s.stake),
      stake_pct_change: pctChange(s.stake, e.stake),
      emission_start_tao: roundTao(s.emission),
      emission_end_tao: roundTao(e.emission),
      emission_delta_tao: roundTao(e.emission - s.emission),
      emission_pct_change: pctChange(s.emission, e.emission),
      validators_start: s.validators,
      validators_end: e.validators,
      validators_delta: e.validators - s.validators,
      neurons_start: s.neurons,
      neurons_end: e.neurons,
      neurons_delta: e.neurons - s.neurons,
    });
  }
  const key = SORT_KEY[sort] ?? SORT_KEY[DEFAULT_MOVERS_SORT];
  movers.sort((a, b) => b[key] - a[key] || a.netuid - b.netuid);
  return movers;
}

// Shape the cross-subnet movers leaderboard. Null-safe: missing/equal boundary dates (cold
// store or a single snapshot) yield an empty list, never throws.
export function buildMovers(
  startRows,
  endRows,
  {
    window,
    startDate,
    endDate,
    sort = DEFAULT_MOVERS_SORT,
    limit = MOVERS_LIMIT_DEFAULT,
  } = {},
) {
  // Normalize sort/window so the artifact is always schema-valid even for direct
  // callers: computeMovers silently falls back to stake for an unknown sort, so the
  // returned sort must reflect that, and an unknown window resolves to the default.
  const normalizedSort = MOVERS_SORTS.includes(sort)
    ? sort
    : DEFAULT_MOVERS_SORT;
  const normalizedWindow =
    window == null
      ? null
      : MOVERS_WINDOWS[window]
        ? window
        : DEFAULT_MOVERS_WINDOW;
  // Clamp limit to a whole number in [0, MOVERS_LIMIT_MAX] so a direct caller cannot make
  // slice() behave oddly with a non-integer, negative, or over-max value (the HTTP layer
  // already validates 1..MOVERS_LIMIT_MAX; this keeps the pure builder's contract aligned).
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, MOVERS_LIMIT_MAX))
    : MOVERS_LIMIT_DEFAULT;
  const comparable =
    startDate != null && endDate != null && startDate !== endDate;
  const ranked = comparable
    ? computeMovers(startRows, endRows, { sort: normalizedSort })
    : [];
  return {
    schema_version: 1,
    window: normalizedWindow,
    start_date: startDate ?? null,
    end_date: endDate ?? null,
    sort: normalizedSort,
    subnet_count: ranked.length,
    movers: ranked.slice(0, normalizedLimit),
  };
}

// Cross-subnet movers leaderboard, computed live: resolve the window's global boundary
// snapshot_dates (MIN over the cutoff, MAX), read every subnet's aggregate at those two
// days (GROUP BY netuid, snapshot_date; the date-first idx_neuron_daily_date_netuid_agg
// covers both the boundary scan and this aggregate), shape with buildMovers. Cold/absent
// or single-snapshot D1 -> empty movers.
export async function loadSubnetMovers(
  d1,
  {
    windowLabel = DEFAULT_MOVERS_WINDOW,
    sort = DEFAULT_MOVERS_SORT,
    limit = MOVERS_LIMIT_DEFAULT,
  } = {},
) {
  const days =
    MOVERS_WINDOWS[windowLabel] ?? MOVERS_WINDOWS[DEFAULT_MOVERS_WINDOW];
  // Anchor the window to the newest STORED snapshot (date() relative to MAX(snapshot_date)),
  // not the worker's wall clock, so a lagging, restored, or historical D1 store still compares
  // its real boundary snapshots instead of returning empty when the data trails "now".
  const bounds = await d1(
    "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date " +
      "FROM neuron_daily " +
      "WHERE snapshot_date >= (SELECT date(MAX(snapshot_date), ?) FROM neuron_daily)",
    [`-${days} days`],
  );
  const startDate = bounds?.[0]?.start_date ?? null;
  const endDate = bounds?.[0]?.end_date ?? null;
  let startRows = [];
  let endRows = [];
  if (startDate != null && endDate != null && startDate !== endDate) {
    const rows = await d1(
      "SELECT netuid, snapshot_date, COUNT(*) AS neuron_count, " +
        "SUM(validator_permit) AS validator_count, " +
        "SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao " +
        "FROM neuron_daily WHERE snapshot_date IN (?, ?) GROUP BY netuid, snapshot_date",
      [startDate, endDate],
    );
    const list = Array.isArray(rows) ? rows : [];
    startRows = list.filter((row) => row?.snapshot_date === startDate);
    endRows = list.filter((row) => row?.snapshot_date === endDate);
  }
  return buildMovers(startRows, endRows, {
    window: windowLabel,
    startDate,
    endDate,
    sort,
    limit,
  });
}
