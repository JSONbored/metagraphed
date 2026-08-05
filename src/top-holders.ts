// Page-size ceiling, single-sourced in route-limits.ts so the contract's
// published `maximum` and this route's enforcement cannot drift (#9127).
import {
  TOP_HOLDERS_LIMIT_DEFAULT,
  TOP_HOLDERS_LIMIT_MAX,
} from "./route-limits.ts";
export { TOP_HOLDERS_LIMIT_DEFAULT, TOP_HOLDERS_LIMIT_MAX };
// Balance-based top-holder leaderboard (#6741/#6743) -- the coldkey/balance-
// centric counterpart to src/accounts-list.ts (hotkey/neuron-centric,
// explicitly missing the Free/Total columns this route exists to add — see
// that module's own header). Sourced from account_balances (a direct
// System::Account chain-state scan,
// apps/indexer-rs/src/bin/poller/jobs/account_balances.rs) and
// nominator_positions x neurons (this coldkey's own total delegated stake
// positions, the SAME computation GET /api/v1/accounts/:ss58/positions
// already does per-account, aggregated across every account here). An
// account can appear from either source alone.
//
// This route also used to publish net_flow_7d/30d/90d (#6886/#6887), a
// cross-subnet stake-flow ranking read from the wallet_flow_daily rollup.
// That rollup was a POSTGRES table and did not survive the box being
// destroyed (#9193) -- there is no D1 migration for it, so the three fields
// could only ever be null and their three sort keys silently degraded to
// ss58 order. Withdrawn in #9461; the underlying events survive in the
// lakehouse (chain.account_events), so rebuilding the rollup is a separate
// project, not a reason to keep advertising an unfillable field.

type Row = Record<string, unknown>;

export const TOP_HOLDERS_SORTS = ["total_tao", "free_tao", "delegated_tao"];
export const DEFAULT_TOP_HOLDERS_SORT = "total_tao";

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

interface TopHoldersEntry {
  ss58: string;
  free_tao: number;
  delegated_tao: number;
  total_tao: number;
  last_updated: string | null;
  [key: string]: unknown;
}

function buildTopHoldersEntry(row: Row): TopHoldersEntry {
  const freeTao = numberOrZero(row?.free_tao);
  const delegatedTao = numberOrZero(row?.delegated_tao);
  return {
    ss58: row.ss58 as string,
    free_tao: freeTao,
    delegated_tao: delegatedTao,
    total_tao: freeTao + delegatedTao,
    last_updated: toIso(
      row?.captured_at == null ? null : Number(row.captured_at),
    ),
  };
}

// Every sort key is one of TOP_HOLDERS_SORTS, and all three are produced by
// numberOrZero/their sum -- so both sides are always finite numbers and there
// is no null rank to model. The null-last branch this used to carry existed
// only for the withdrawn net_flow_* keys (#9461); reintroducing a nullable
// sort key means reintroducing it deliberately, not inheriting it.
export function compareTopHoldersSort(
  a: TopHoldersEntry,
  b: TopHoldersEntry,
  sortKey: string,
): number {
  const aVal = a[sortKey] as number;
  const bVal = b[sortKey] as number;
  return bVal - aVal || a.ss58.localeCompare(b.ss58);
}

/** Shapes raw (ss58, free_tao, delegated_tao, captured_at) rows -- one per
 * account from either account_balances or the nominator_positions/neurons
 * aggregate -- into a paginated, sortable leaderboard. Null-safe: no rows
 * (cold store) yields a schema-stable empty leaderboard. */
export function buildTopHoldersList(
  rows: Row[] | null | undefined,
  {
    sort = DEFAULT_TOP_HOLDERS_SORT,
    limit = TOP_HOLDERS_LIMIT_DEFAULT,
  }: { sort?: string; limit?: unknown } = {},
): Row {
  const normalizedSort = TOP_HOLDERS_SORTS.includes(sort)
    ? sort
    : DEFAULT_TOP_HOLDERS_SORT;
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, TOP_HOLDERS_LIMIT_MAX))
    : TOP_HOLDERS_LIMIT_DEFAULT;

  let latestCapturedAt: number | null = null;
  const accounts = (Array.isArray(rows) ? rows : [])
    .filter((row) => typeof row?.ss58 === "string" && row.ss58.length > 0)
    .map((row) => {
      const capturedAt =
        row?.captured_at == null ? null : Number(row.captured_at);
      if (capturedAt != null && Number.isFinite(capturedAt) && capturedAt > 0) {
        if (latestCapturedAt == null || capturedAt > latestCapturedAt) {
          latestCapturedAt = capturedAt;
        }
      }
      return buildTopHoldersEntry(row);
    })
    .sort((a, b) => compareTopHoldersSort(a, b, normalizedSort));

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    account_count: accounts.length,
    accounts: accounts.slice(0, normalizedLimit),
  };
}
