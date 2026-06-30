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

// 1 TAO = 1e9 rao. Summing many REAL amount_tao values accumulates IEEE-754 noise
// below the rao floor; round every TAO output to rao precision, the smallest real
// unit (the same rounding the turnover/account-summary scorecards apply).
const RAO_PER_TAO = 1e9;
function roundTao(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 SUM()/COUNT() cell (number, numeric string, or null) to a finite
// number, defaulting to 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  for (const row of list) {
    const kind = row?.event_kind;
    if (kind === STAKE_ADDED_KIND) {
      stakedTao = toNumber(row?.total_tao);
      stakeEvents = toNumber(row?.event_count);
    } else if (kind === STAKE_REMOVED_KIND) {
      unstakedTao = toNumber(row?.total_tao);
      unstakeEvents = toNumber(row?.event_count);
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
// observed_at window is a residual filter on that seek. Cold/absent D1 -> zeroed totals.
export async function loadSubnetStakeFlow(
  d1,
  netuid,
  { windowLabel = DEFAULT_STAKE_FLOW_WINDOW } = {},
) {
  const days =
    STAKE_FLOW_WINDOWS[windowLabel] ??
    STAKE_FLOW_WINDOWS[DEFAULT_STAKE_FLOW_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, " +
      "COUNT(*) AS event_count FROM account_events " +
      "WHERE netuid = ? AND event_kind IN (?, ?) AND observed_at >= ? " +
      "GROUP BY event_kind",
    [netuid, STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff],
  );
  return buildStakeFlow(rows, netuid, { window: windowLabel });
}
