// Nominator list for one validator hotkey (#4334/7.2): who has staked to this
// validator (across every subnet it operates in), derived from the same
// StakeAdded/StakeRemoved account_events flow src/account-stake-flow.mjs
// already aggregates per-account — grouped by coldkey (the nominator) instead
// of by netuid, since here the hotkey is fixed and the question is WHO is
// behind it. No new capture: StakeAdded/StakeRemoved carry both hotkey
// (validator) and coldkey (staker) on every row (migrations/0009_account_events.sql).

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

// Shape a hotkey's StakeAdded/StakeRemoved aggregate into a ranked nominator
// list. `rows` can be either the legacy GROUP BY coldkey,event_kind shape used
// by unit tests or the SQL-paginated GROUP BY coldkey shape returned by the D1
// read path. Null-safe: no rows (cold store / empty window / no nominators)
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
    totalCount,
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
    if (!coldkey) continue;
    const kind = row?.event_kind;
    const bucket = perColdkey.get(coldkey) ?? {
      coldkey,
      staked_tao: 0,
      unstaked_tao: 0,
      event_count: 0,
      last_observed_ms: null,
    };
    if (kind == null) {
      const staked = nullableTao(row?.staked_tao);
      const unstaked = nullableTao(row?.unstaked_tao);
      if (staked == null && unstaked == null) continue;
      bucket.staked_tao += staked ?? 0;
      bucket.unstaked_tao += unstaked ?? 0;
    } else {
      if (kind !== STAKE_ADDED_KIND && kind !== STAKE_REMOVED_KIND) {
        continue;
      }
      const tao = nullableTao(row?.total_tao);
      if (tao == null) continue;
      if (kind === STAKE_ADDED_KIND) bucket.staked_tao += tao;
      else bucket.unstaked_tao += tao;
    }
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
    nominator_count:
      totalCount == null
        ? nominators.length
        : Math.max(0, Math.trunc(Number(totalCount))) || 0,
    nominators:
      totalCount == null
        ? nominators.slice(normalizedOffset, normalizedOffset + normalizedLimit)
        : nominators,
  };
}

// #4772 D1 retirement: loadValidatorNominators (the D1 loader that read the
// account_events StakeAdded/StakeRemoved stream) was removed here -- that D1 write
// path is retired and the `account_events` table is dropped in production, so a live
// D1 query would always miss. Serving now goes tryPostgresTier -> buildValidatorNominators([...
// ], hotkey, {...}), never D1. See src/graphql.mjs's validator_nominators resolver and
// src/mcp-server.mjs's get_validator_nominators tool for the call sites.
