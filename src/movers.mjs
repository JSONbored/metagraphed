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
export const MOVERS_SORTS = ["stake", "emission", "validators", "neurons"];
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

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null
// explicitly so a null netuid is skipped rather than coerced to subnet 0
// (Number(null) === 0). Mirrors normalizedNetuid in account-stake-flow.mjs.
function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
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

// Sum a boundary map's stake, emission, and validator counts across every subnet — the
// single source the dominance-share denominator and the network summary totals derive
// from, so both stay consistent as more network-level fields are added.
function sumBoundary(map) {
  let stake = 0;
  let emission = 0;
  let validators = 0;
  for (const v of map.values()) {
    stake += v.stake;
    emission += v.emission;
    validators += v.validators;
  }
  return { stake, emission, validators };
}

const SORT_KEY = {
  stake: "stake_delta_tao",
  emission: "emission_delta_tao",
  validators: "validators_delta",
  neurons: "neurons_delta",
};

// A subnet's share (%) of a network total, rounded to 2dp. Null when the total is
// 0 or non-finite (share of nothing is undefined) — mirrors pctChange's null contract.
function pctShare(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0)
    return null;
  const pct = Math.round((part / total) * 100 * 100) / 100;
  // A sub-total share must not round up to a flat 100 while other subnets still
  // hold stake/emission — that would report a lone subnet as owning the whole
  // network. Clamp to the largest 2dp value below 100, the same anti-overstatement
  // guard formatUptimePercent and chain-transfer-pairs' top_pair_share apply. Only
  // a genuine part === total (single-subnet network) keeps an exact 100.
  return pct >= 100 && part < total ? 99.99 : pct;
}

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
  // Network end totals for the dominance shares: each subnet's stake/emission as a
  // percentage of the whole network at the window's end snapshot. Summed over EVERY
  // subnet (not just the returned page) so the share denominator is the true total.
  const endTotals = sumBoundary(endMap);
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
      // Dominance: this subnet's share of network stake at the end snapshot.
      stake_share_pct: pctShare(e.stake, endTotals.stake),
      emission_start_tao: roundTao(s.emission),
      emission_end_tao: roundTao(e.emission),
      emission_delta_tao: roundTao(e.emission - s.emission),
      emission_pct_change: pctChange(s.emission, e.emission),
      emission_share_pct: pctShare(e.emission, endTotals.emission),
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

// Network-wide aggregate context for the leaderboard: total stake/emission/validator
// counts at each boundary plus their deltas, and how many subnets gained, lost, or held
// flat on the ACTIVE sort metric. Totals sum the RAW boundary aggregates and round once at
// the end (not a sum of already-rounded per-subnet fields), so no rao drift accumulates
// across subnets. Gainer/loser/unchanged counts cover the full ranked set (every subnet),
// so they stay network-wide even though the response caps `movers` to `limit`. Empty
// boundaries (cold or single-snapshot store) yield an all-zero summary, never throws.
function buildNetworkSummary(ranked, sortDeltaKey, startRows, endRows) {
  const start = sumBoundary(indexByNetuid(startRows));
  const end = sumBoundary(indexByNetuid(endRows));
  let gainers = 0;
  let losers = 0;
  let unchanged = 0;
  for (const m of ranked) {
    const delta = m[sortDeltaKey];
    if (delta > 0) gainers += 1;
    else if (delta < 0) losers += 1;
    else unchanged += 1;
  }
  return {
    total_stake_start_tao: roundTao(start.stake),
    total_stake_end_tao: roundTao(end.stake),
    total_stake_delta_tao: roundTao(end.stake - start.stake),
    total_emission_start_tao: roundTao(start.emission),
    total_emission_end_tao: roundTao(end.emission),
    total_emission_delta_tao: roundTao(end.emission - start.emission),
    total_validators_start: start.validators,
    total_validators_end: end.validators,
    total_validators_delta: end.validators - start.validators,
    gainers,
    losers,
    unchanged,
  };
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
    network: buildNetworkSummary(
      ranked,
      SORT_KEY[normalizedSort],
      comparable ? startRows : [],
      comparable ? endRows : [],
    ),
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
