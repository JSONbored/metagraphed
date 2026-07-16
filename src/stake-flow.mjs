// Net stake flow (capital in vs out) for one subnet over a recent window: how much
// TAO entered (StakeAdded) vs left (StakeRemoved), summed from the first-party
// account_events stream. Pure shaping (buildStakeFlow); the Worker / data-api
// Postgres tier supplies the rows and adds the REST envelope. Null-safe: a cold
// store or an empty window yields schema-stable zeros (never throws), matching
// the sibling live tiers (turnover, subnet events).
//
// The D1 loader (loadSubnetStakeFlow) was removed — account_events' D1 write path
// is retired and the table is dropped in production (#4772 / #4909 / #6016), so
// serving goes tryPostgresTier → schema-stable empty stub, never D1.
//
// The 7d/30d/90d windows match the set the concentration/history route already uses,
// keeping the per-subnet analytics windows consistent for the recent-capital-movement
// signal a flow view answers.

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

// A finite TAO aggregate cell, or null when absent/blank/non-numeric.
function nullableTao(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    const tao = nullableTao(row?.total_tao);
    if (tao == null) continue;
    if (kind === STAKE_ADDED_KIND) {
      stakedTao += tao;
      stakeEvents += toNumber(row?.event_count);
    } else if (kind === STAKE_REMOVED_KIND) {
      unstakedTao += tao;
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
