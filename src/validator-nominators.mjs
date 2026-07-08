// Nominator list for one validator hotkey (#4334/7.2): who has staked to this
// validator (across every subnet it operates in), derived from the same
// StakeAdded/StakeRemoved account_events flow src/account-stake-flow.mjs
// already aggregates per-account — grouped by coldkey (the nominator) instead
// of by netuid, since here the hotkey is fixed and the question is WHO is
// behind it. No new capture: StakeAdded/StakeRemoved carry both hotkey
// (validator) and coldkey (staker) on every row (migrations/0009_account_events.sql).

const DAY_MS = 24 * 60 * 60 * 1000;

// Both carry a positive amount_tao (migrations/0009_account_events.sql), so
// net = staked - unstaked.
export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

// Same window set as account-stake-flow.mjs / the per-subnet stake-flow route.
export const NOMINATOR_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_NOMINATOR_WINDOW = "30d";

export const NOMINATOR_SORTS = ["net_staked", "gross_staked", "last_activity"];
export const DEFAULT_NOMINATOR_SORT = "net_staked";
export const NOMINATOR_LIMIT_DEFAULT = 20;
export const NOMINATOR_LIMIT_MAX = 100;

const RAO_PER_TAO = 1e9;
function roundTao(value) {
  /* v8 ignore next -- defensive: callers only pass finite toNumber-guarded sums */
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

// A finite TAO aggregate cell, or null when absent/blank/non-numeric. Blank D1
// cells coerce via Number("") -> 0; skip those rather than counting a
// phantom zero-TAO stake event (mirrors buildAccountStakeFlow/#3059).
function nullableTao(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function sortValue(nominator, sort) {
  if (sort === "gross_staked") return nominator.gross_staked_tao;
  if (sort === "last_activity") return nominator.last_observed_ms ?? -Infinity;
  return nominator.net_staked_tao;
}

// Shape a hotkey's per-(coldkey, event_kind) StakeAdded/StakeRemoved aggregate
// into a ranked nominator list. `rows` is the GROUP BY coldkey, event_kind
// result. Null-safe: no rows (cold store / empty window / no nominators)
// yields a zeroed, empty list — never throws, matching the sibling account
// tiers (stake-flow, counterparties).
export function buildValidatorNominators(
  rows,
  hotkey,
  {
    window,
    sort = DEFAULT_NOMINATOR_SORT,
    limit = NOMINATOR_LIMIT_DEFAULT,
    offset = 0,
  } = {},
) {
  const normalizedSort = NOMINATOR_SORTS.includes(sort)
    ? sort
    : DEFAULT_NOMINATOR_SORT;
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, NOMINATOR_LIMIT_MAX))
    : NOMINATOR_LIMIT_DEFAULT;
  const flooredOffset = Math.floor(Number(offset));
  const normalizedOffset =
    Number.isFinite(flooredOffset) && flooredOffset > 0 ? flooredOffset : 0;

  const perColdkey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const coldkey =
      typeof row?.coldkey === "string" && row.coldkey.length > 0
        ? row.coldkey
        : null;
    const kind = row?.event_kind;
    if (
      !coldkey ||
      (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND)
    ) {
      continue;
    }
    const tao = nullableTao(row?.total_tao);
    if (tao == null) continue;
    const bucket = perColdkey.get(coldkey) ?? {
      coldkey,
      staked_tao: 0,
      unstaked_tao: 0,
      event_count: 0,
      last_observed_ms: null,
    };
    if (kind === STAKE_ADDED_KIND) bucket.staked_tao += tao;
    else bucket.unstaked_tao += tao;
    bucket.event_count += Math.max(
      0,
      Math.trunc(Number(row?.event_count) || 0),
    );
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (bucket.last_observed_ms == null || observed > bucket.last_observed_ms)
    ) {
      bucket.last_observed_ms = observed;
    }
    perColdkey.set(coldkey, bucket);
  }

  const nominators = [...perColdkey.values()].map((bucket) => ({
    coldkey: bucket.coldkey,
    staked_tao: roundTao(bucket.staked_tao),
    unstaked_tao: roundTao(bucket.unstaked_tao),
    net_staked_tao: roundTao(bucket.staked_tao - bucket.unstaked_tao),
    gross_staked_tao: roundTao(bucket.staked_tao + bucket.unstaked_tao),
    event_count: bucket.event_count,
    last_observed_at: toIso(bucket.last_observed_ms),
    last_observed_ms: bucket.last_observed_ms,
  }));

  nominators.sort(
    (a, b) =>
      sortValue(b, normalizedSort) - sortValue(a, normalizedSort) ||
      a.coldkey.localeCompare(b.coldkey),
  );
  // last_observed_ms is an internal sort key, never part of the public shape.
  for (const nominator of nominators) delete nominator.last_observed_ms;

  return {
    schema_version: 1,
    hotkey,
    window: window ?? null,
    sort: normalizedSort,
    limit: normalizedLimit,
    offset: normalizedOffset,
    nominator_count: nominators.length,
    nominators: nominators.slice(
      normalizedOffset,
      normalizedOffset + normalizedLimit,
    ),
  };
}

// D1 read path shared by the REST handler (and, if ever needed, MCP tools).
// `d1` is a (sql, params) => Promise<rows[]> runner. `coldkey`, when supplied,
// narrows to a single nominator's own flow (an exact-match lookup, not a
// fuzzy search — SS58 addresses aren't typo-searched) instead of ranking the
// full set.
export async function loadValidatorNominators(
  d1,
  hotkey,
  { windowLabel = DEFAULT_NOMINATOR_WINDOW, sort, limit, offset, coldkey } = {},
) {
  const days =
    NOMINATOR_WINDOWS[windowLabel] ??
    NOMINATOR_WINDOWS[DEFAULT_NOMINATOR_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const params = [hotkey, STAKE_ADDED_KIND, STAKE_REMOVED_KIND, cutoff];
  let sql =
    "SELECT coldkey, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, " +
    "COUNT(*) AS event_count, MAX(observed_at) AS last_observed " +
    "FROM account_events INDEXED BY idx_account_events_hotkey " +
    "WHERE hotkey = ? AND event_kind IN (?, ?) AND observed_at >= ?";
  if (coldkey) {
    sql += " AND coldkey = ?";
    params.push(coldkey);
  }
  sql += " GROUP BY coldkey, event_kind";
  const rows = await d1(sql, params);
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
    data: buildValidatorNominators(rows, hotkey, {
      window: windowLabel,
      sort,
      limit,
      offset,
    }),
    generatedAt: toIso(latestObserved),
  };
}
