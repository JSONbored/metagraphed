// Per-account stake-movement (re-delegation) footprint: which subnets one account
// (coldkey) moved stake out of over a recent window, broken down per subnet and
// rolled up into a movement scorecard. Pure shaping (buildAccountStakeMoves) + a
// thin D1 loader (loadAccountStakeMoves); the Worker adds the REST envelope.
// Null-safe: a cold store or an empty window yields schema-stable zeros.
//
// This is the account-level companion of /api/v1/chain/stake-moves and
// /api/v1/subnets/{netuid}/stake-moves. StakeMoved relocates stake between
// hotkeys/subnets without unstaking, so this measures re-delegation churn, not net
// capital flow. The mover is the origin coldkey recorded on account_events.
//
// Price-at-tx enrichment (#4329/6.3): each subnet row also carries
// price_tao_at_last_move — the alpha price on the UTC day of that subnet's
// most recent move, from the daily subnet_snapshots rollup (pure route
// enrichment, no new table, no new capture). #4332's own text named
// "/accounts/{addr}/stake-moves and /transfers" as the two targets, but only
// half of that holds up: this route is netuid-scoped and alpha-denominated,
// so "price at the time" has somewhere to attach. /transfers
// (src/account-events.mjs's buildAccountTransfers) is native-TAO
// Balances.Transfer — it carries no netuid at all, so there is no subnet
// whose alpha price could apply; deliberately NOT enriched here (see that
// module's own comment). Daily granularity is what subnet_snapshots has
// today — a known precision limit against the exact intra-day/intra-window
// price at any single one of `movements` transactions, not a bug.

const DAY_MS = 24 * 60 * 60 * 1000;

export const STAKE_MOVED_EVENT_KIND = "StakeMoved";
export const ACCOUNT_STAKE_MOVES_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW = "30d";

function roundConcentration(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

function coerceEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value: unknown): string | null {
  const n = coerceEpochMs(value);
  return n == null ? null : new Date(n).toISOString();
}

// UTC YYYY-MM-DD for an epoch-ms timestamp — matches subnet_snapshots.snapshot_date's
// own "YYYY-MM-DD (UTC)" convention (migrations/0002_analytics.sql) exactly.
function utcDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A finite alpha_price_tao cell, or null when absent/blank/non-numeric. No
// rounding: this is a single stored snapshot value passed through, not a SUM
// accumulating float noise (unlike the amount aggregates elsewhere in this
// file), so there's no rao-precision cleanup to do.
function nullablePrice(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface AccountStakeMoveSubnet {
  netuid: number;
  movements: number;
  first_moved_at: string | null;
  last_moved_at: string | null;
  price_tao_at_last_move: number | null;
}

export interface AccountStakeMovesResult {
  schema_version: 1;
  address: string;
  window: string | null;
  total_movements: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountStakeMoveSubnet[];
}

export function buildAccountStakeMoves(
  rows: Array<Record<string, unknown>> | null | undefined,
  address: string,
  {
    window,
    priceByNetuidDate,
  }: {
    window?: string | null;
    priceByNetuidDate?: Map<string, number> | null;
  } = {},
): AccountStakeMovesResult {
  const list = Array.isArray(rows) ? rows : [];
  const perSubnet = new Map<
    number,
    { movements: number; firstMs: number | null; lastMs: number | null }
  >();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    if (netuid == null) continue;
    const movements = toCount(row?.movements);
    if (movements === 0) continue;
    const firstMs = coerceEpochMs(row?.first_observed);
    const lastMs = coerceEpochMs(row?.last_observed);
    const bucket = perSubnet.get(netuid) ?? {
      movements: 0,
      firstMs: null,
      lastMs: null,
    };
    bucket.movements += movements;
    if (
      firstMs != null &&
      (bucket.firstMs == null || firstMs < bucket.firstMs)
    ) {
      bucket.firstMs = firstMs;
    }
    if (lastMs != null && (bucket.lastMs == null || lastMs > bucket.lastMs)) {
      bucket.lastMs = lastMs;
    }
    perSubnet.set(netuid, bucket);
  }

  let totalMovements = 0;
  let squares = 0;
  const subnets: AccountStakeMoveSubnet[] = [];
  for (const [netuid, bucket] of perSubnet) {
    totalMovements += bucket.movements;
    squares += bucket.movements * bucket.movements;
    // Price-at-tx enrichment (#4332/6.3): the alpha price on the UTC day of
    // this subnet's most recent move within the window, from the daily
    // subnet_snapshots rollup. Daily granularity is what exists today — a
    // known precision limit (the exact intra-day price at any one of
    // `movements` transactions isn't tracked), not a bug. null when that
    // day has no snapshot yet (today's row before the daily cron runs) or
    // there was no move to date from.
    const lastMovedDate =
      bucket.lastMs == null ? null : utcDateFromMs(bucket.lastMs);
    const priceTaoAtLastMove =
      lastMovedDate == null
        ? null
        : (priceByNetuidDate?.get(`${netuid}:${lastMovedDate}`) ?? null);
    subnets.push({
      netuid,
      movements: bucket.movements,
      first_moved_at:
        bucket.firstMs == null ? null : new Date(bucket.firstMs).toISOString(),
      last_moved_at:
        bucket.lastMs == null ? null : new Date(bucket.lastMs).toISOString(),
      price_tao_at_last_move: priceTaoAtLastMove,
    });
  }
  subnets.sort((a, b) => b.movements - a.movements || a.netuid - b.netuid);

  const concentration =
    totalMovements > 0
      ? roundConcentration(squares / (totalMovements * totalMovements))
      : null;

  return {
    schema_version: 1,
    address,
    window: window ?? null,
    total_movements: totalMovements,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: subnets.length > 0 ? subnets[0].netuid : null,
    subnets,
  };
}

export async function loadAccountStakeMoves(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  address: string,
  {
    windowLabel = DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
  }: { windowLabel?: string } = {},
): Promise<{ data: AccountStakeMovesResult; generatedAt: string | null }> {
  const days =
    ACCOUNT_STAKE_MOVES_WINDOWS[windowLabel] ??
    ACCOUNT_STAKE_MOVES_WINDOWS[DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW];
  const cutoff = Date.now() - days * DAY_MS;
  const rows = await d1(
    "SELECT netuid, COUNT(*) AS movements, MIN(observed_at) AS first_observed, " +
      "MAX(observed_at) AS last_observed " +
      "FROM account_events INDEXED BY idx_account_events_coldkey " +
      "WHERE coldkey = ? AND event_kind = ? AND observed_at >= ? GROUP BY netuid",
    [address, STAKE_MOVED_EVENT_KIND, cutoff],
  );
  let latestObserved: number | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const observed = coerceEpochMs(row?.last_observed);
    if (
      observed != null &&
      (latestObserved == null || observed > latestObserved)
    ) {
      latestObserved = observed;
    }
  }
  const priceByNetuidDate = await loadAlphaPricesForLastMoves(d1, rows);
  return {
    data: buildAccountStakeMoves(rows, address, {
      window: windowLabel,
      priceByNetuidDate,
    }),
    generatedAt: toIso(latestObserved),
  };
}

// Batch-fetch subnet_snapshots.alpha_price_tao for the exact (netuid,
// last-moved-date) pairs this page's rows actually need — a small, bounded
// follow-up query (at most one row per distinct subnet the account touched
// in the window), not a JOIN folded into the account_events query above.
// That query is a deliberately engineered UNION-of-seeks (idx_account_events_
// coldkey) kept untouched here rather than risk its index-seek behavior
// under D1/SQLite's query planner. Returns a Map keyed "netuid:YYYY-MM-DD".
async function loadAlphaPricesForLastMoves(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  rows: Array<Record<string, unknown>> | null | undefined,
): Promise<Map<string, number>> {
  const netuids = new Set<number>();
  const dates = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = normalizedNetuid(row?.netuid);
    const lastMs = coerceEpochMs(row?.last_observed);
    if (netuid == null || lastMs == null) continue;
    netuids.add(netuid);
    dates.add(utcDateFromMs(lastMs));
  }
  const map = new Map<string, number>();
  if (netuids.size === 0 || dates.size === 0) return map;
  const netuidList = [...netuids];
  const dateList = [...dates];
  const netuidPlaceholders = netuidList.map(() => "?").join(",");
  const datePlaceholders = dateList.map(() => "?").join(",");
  const priceRows = await d1(
    `SELECT netuid, snapshot_date, alpha_price_tao FROM subnet_snapshots ` +
      `WHERE netuid IN (${netuidPlaceholders}) AND snapshot_date IN (${datePlaceholders})`,
    [...netuidList, ...dateList],
  );
  for (const row of Array.isArray(priceRows) ? priceRows : []) {
    const price = nullablePrice(row?.alpha_price_tao);
    if (price == null) continue;
    map.set(`${row.netuid}:${row.snapshot_date}`, price);
  }
  return map;
}
