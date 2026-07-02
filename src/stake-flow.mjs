// Net stake flow (capital in vs out) for one subnet over a recent window: how much
// TAO entered (StakeAdded) vs left (StakeRemoved), summed from the first-party
// account_events stream. Pure shaping (buildStakeFlow) + a thin D1 loader
// (loadSubnetStakeFlow); the Worker adds the REST envelope. Null-safe: a cold store
// or an empty window yields schema-stable zeros (never throws), matching the sibling
// live tiers (turnover, subnet events).
//
// The 7d/30d/90d windows match the set the concentration/history route already uses,
// keeping the per-subnet analytics windows consistent for the recent-capital-movement
// signal a flow view answers.

const DAY_MS = 24 * 60 * 60 * 1000;

// The two account_events kinds that move stake: StakeAdded is capital entering the
// subnet, StakeRemoved is capital leaving. Both carry a positive amount_tao
// (migrations/0009_account_events.sql:21), so net flow = staked - unstaked.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

// Supported flow windows (label -> days), the same set the concentration/history
// route exposes. Mirrors the UPTIME_WINDOWS lookup pattern; an unsupported label is
// rejected by the handler with a 400.
export const STAKE_FLOW_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_STAKE_FLOW_WINDOW = "30d";

// direction narrows the stake-flow aggregate to one side: in = StakeAdded only,
// out = StakeRemoved only, all (or omitted) = both kinds summed as today.
export const STAKE_FLOW_DIRECTIONS = ["all", "in", "out"];
export const DEFAULT_STAKE_FLOW_DIRECTION = "all";

// 1 TAO = 1e9 rao. Summing many REAL amount_tao values accumulates IEEE-754 noise
// below the rao floor; round every TAO output to rao precision, the smallest real
// unit (the same rounding the turnover/account-summary scorecards apply).
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite
// number, defaulting to 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Convert an epoch-ms timestamp to an ISO string, or null when not finite. The
// REST meta.generated_at is string|null per the envelope contract, so the newest
// event's epoch-ms observed_at is rendered the same way account-events does (toIso).
function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Shape a subnet's StakeAdded/StakeRemoved aggregate into a stake-flow scorecard.
// `rows` is the GROUP BY event_kind result: at most one row per kind carrying
// total_tao (SUM amount_tao) and event_count (COUNT). Null-safe: no rows (cold
// store / empty window) yields zeroed totals, never throws.
export function buildStakeFlow(rows, netuid, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let stakedTao = 0;
  let unstakedTao = 0;
  let stakeEvents = 0;
  let unstakeEvents = 0;
  // Accumulate per kind so the shaper is robust to more than one row per kind,
  // not just the single-row-per-kind shape GROUP BY event_kind guarantees.
  for (const row of list) {
    const kind = row?.event_kind;
    if (kind === STAKE_ADDED_KIND) {
      stakedTao += toNumber(row?.total_tao);
      stakeEvents += toNumber(row?.event_count);
    } else if (kind === STAKE_REMOVED_KIND) {
      unstakedTao += toNumber(row?.total_tao);
      unstakeEvents += toNumber(row?.event_count);
    }
  }
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    total_staked_tao: roundTao(stakedTao),
    total_unstaked_tao: roundTao(unstakedTao),
    // Positive = net capital inflow over the window; negative = net outflow.
    net_flow_tao: roundTao(stakedTao - unstakedTao),
    stake_events: stakeEvents,
    unstake_events: unstakeEvents,
  };
}

// One subnet's net stake flow — sums StakeAdded/StakeRemoved amount_tao from
// account_events over the window (observed_at >= now - windowDays, epoch ms),
// grouped by kind, shaped with buildStakeFlow. The (netuid, event_kind) prefix of
// idx_account_events_netuid_kind (migrations/0024) seeks the two stake kinds; the
// observed_at window is a residual filter on that seek. Returns { data, generatedAt }
// where generatedAt is the newest event's observed_at as an ISO string (string|null
// per the envelope contract), so the REST meta reports provenance tied to the
// account_events stream. Cold/absent D1 -> zeroed totals + generatedAt null.
export async function loadSubnetStakeFlow(
  d1,
  netuid,
  {
    windowLabel = DEFAULT_STAKE_FLOW_WINDOW,
    direction = DEFAULT_STAKE_FLOW_DIRECTION,
  } = {},
) {
  const days =
    STAKE_FLOW_WINDOWS[windowLabel] ??
    STAKE_FLOW_WINDOWS[DEFAULT_STAKE_FLOW_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const kinds =
    direction === "in"
      ? [STAKE_ADDED_KIND]
      : direction === "out"
        ? [STAKE_REMOVED_KIND]
        : [STAKE_ADDED_KIND, STAKE_REMOVED_KIND];
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = await d1(
    "SELECT event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, " +
      "COUNT(*) AS event_count, MAX(observed_at) AS last_observed " +
      "FROM account_events " +
      `WHERE netuid = ? AND event_kind IN (${placeholders}) AND observed_at >= ? ` +
      "GROUP BY event_kind",
    [netuid, ...kinds, cutoff],
  );
  let latestObserved = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const observed = Number(row?.last_observed);
    if (
      Number.isFinite(observed) &&
      (latestObserved == null || observed > latestObserved)
    ) {
      latestObserved = observed;
    }
  }
  return {
    data: buildStakeFlow(rows, netuid, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
