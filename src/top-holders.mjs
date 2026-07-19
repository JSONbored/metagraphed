// Balance-based top-holder leaderboard (#6741/#6743) -- the coldkey/balance-
// centric counterpart to src/accounts-list.mjs (hotkey/neuron-centric,
// explicitly missing the Free/Total columns this route exists to add — see
// that module's own header). Sourced from account_balances (a direct
// System::Account chain-state scan, scripts/fetch-account-balances.py) and
// nominator_positions x neurons (this coldkey's own total delegated stake
// positions, the SAME computation GET /api/v1/accounts/:ss58/positions
// already does per-account, aggregated across every account here). An
// account can appear from either source alone.

export const TOP_HOLDERS_SORTS = ["total_tao", "free_tao", "delegated_tao"];
export const DEFAULT_TOP_HOLDERS_SORT = "total_tao";
export const TOP_HOLDERS_LIMIT_DEFAULT = 20;
export const TOP_HOLDERS_LIMIT_MAX = 100;

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildTopHoldersEntry(row) {
  const freeTao = numberOrZero(row?.free_tao);
  const delegatedTao = numberOrZero(row?.delegated_tao);
  return {
    ss58: row.ss58,
    free_tao: freeTao,
    delegated_tao: delegatedTao,
    total_tao: freeTao + delegatedTao,
    last_updated: toIso(
      row?.captured_at == null ? null : Number(row.captured_at),
    ),
  };
}

/** Shapes raw (ss58, free_tao, delegated_tao, captured_at) rows -- one per
 * account from either account_balances or the nominator_positions/neurons
 * aggregate -- into a paginated, sortable leaderboard. Null-safe: no rows
 * (cold store) yields a schema-stable empty leaderboard. */
export function buildTopHoldersList(
  rows,
  { sort = DEFAULT_TOP_HOLDERS_SORT, limit = TOP_HOLDERS_LIMIT_DEFAULT } = {},
) {
  const normalizedSort = TOP_HOLDERS_SORTS.includes(sort)
    ? sort
    : DEFAULT_TOP_HOLDERS_SORT;
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, TOP_HOLDERS_LIMIT_MAX))
    : TOP_HOLDERS_LIMIT_DEFAULT;

  let latestCapturedAt = null;
  const accounts = (Array.isArray(rows) ? rows : [])
    .filter((row) => typeof row?.ss58 === "string" && row.ss58.length > 0)
    .map((row) => {
      const capturedAt =
        row?.captured_at == null ? null : Number(row.captured_at);
      if (Number.isFinite(capturedAt) && capturedAt > 0) {
        if (latestCapturedAt == null || capturedAt > latestCapturedAt) {
          latestCapturedAt = capturedAt;
        }
      }
      return buildTopHoldersEntry(row);
    })
    .sort(
      (a, b) =>
        b[normalizedSort] - a[normalizedSort] || a.ss58.localeCompare(b.ss58),
    );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    account_count: accounts.length,
    accounts: accounts.slice(0, normalizedLimit),
  };
}
