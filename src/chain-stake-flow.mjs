// Network-wide net stake flow (capital in vs out) over a recent window: how much
// TAO entered (StakeAdded) vs left (StakeRemoved) across the whole chain, summed
// from the first-party account_events stream. Pure shaping (buildChainStakeFlow) +
// a thin D1 loader (loadChainStakeFlow); the Worker adds the REST envelope. The
// network-level companion of the per-subnet /accounts/{ss58}/stake-flow routes.
// Null-safe: a cold store or an empty window yields schema-stable zeros (never
// throws), matching the sibling stake-flow tiers.

import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
  DEFAULT_STAKE_FLOW_DIRECTION,
} from "./stake-flow.mjs";

export {
  STAKE_FLOW_WINDOWS,
  DEFAULT_STAKE_FLOW_WINDOW,
  DEFAULT_STAKE_FLOW_DIRECTION,
} from "./stake-flow.mjs";
export {
  STAKE_FLOW_DIRECTIONS,
} from "./stake-flow.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceEpochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value) {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// Shape the network StakeAdded/StakeRemoved aggregate into a stake-flow scorecard.
// `rows` is the GROUP BY event_kind result. Null-safe on cold/empty input.
export function buildChainStakeFlow(rows, { window } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let stakedTao = 0;
  let unstakedTao = 0;
  let stakeEvents = 0;
  let unstakeEvents = 0;
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
    window: window ?? null,
    total_staked_tao: roundTao(stakedTao),
    total_unstaked_tao: roundTao(unstakedTao),
    net_flow_tao: roundTao(stakedTao - unstakedTao),
    stake_events: stakeEvents,
    unstake_events: unstakeEvents,
  };
}

// Network-wide net stake flow — sums StakeAdded/StakeRemoved amount_tao from
// account_events over the window (observed_at >= now - windowDays), grouped by kind.
// Returns { data, generatedAt } where generatedAt is the newest event's observed_at
// as an ISO string. Cold/absent D1 -> zeroed totals + generatedAt null.
export async function loadChainStakeFlow(
  d1,
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
      `WHERE event_kind IN (${placeholders}) AND observed_at >= ? ` +
      "GROUP BY event_kind",
    [...kinds, cutoff],
  );
  let latestObserved = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (latestObserved == null || observed > latestObserved)
    ) {
      latestObserved = observed;
    }
  }
  return {
    data: buildChainStakeFlow(rows, { window: windowLabel }),
    generatedAt: toIso(latestObserved),
  };
}
