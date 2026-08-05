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
// TWO TIERS ANSWER THROUGH THIS ONE FORMATTER, and they cover different
// columns (#9469):
//
//   net_flow_7d/30d/90d  LIVE. src/top-holders-flow-tier.ts recomputes the
//                        cross-subnet stake-flow ranking (StakeAdded minus
//                        StakeRemoved over the window) from
//                        chain.account_events on a daily cron. Unlike the
//                        holdings columns net flow is signed -- a real net
//                        outflow is negative -- so it gets its own signed
//                        guard below.
//   free_tao             COMPOSED LIVE by src/top-holders-holdings.ts (#9502),
//   delegated_tao        in the same daily lane and from D1: free_tao out of
//   total_tao            `account_balances`, delegated_tao by pricing
//                        `nominator_positions` against the `hotkey_alpha` pool
//                        totals, total_tao as their sum ranked across the full
//                        tables. That module's header carries the pricing rule
//                        and why an unpriceable netuid is EXCLUDED from the sum
//                        rather than counted as zero.
//
//                        EACH IS GATED ON ITS OWN INPUT BEING PROVABLY
//                        COMPLETE, and total_tao on both, because a partial
//                        ledger does not produce a visibly broken ranking -- it
//                        produces a plausible wrong one. Until a producer's
//                        pass is recorded complete the column is DECLINED and
//                        src/top-holders-artifact.ts's one-shot 2026-08-02
//                        materialization keeps answering that sort with the
//                        real (if fixed-date) numbers it carries. So a frozen
//                        cell here is a statement about an input, not about
//                        this route: see src/account-balances-completeness.ts
//                        and src/hotkey-alpha-completeness.ts.
//
// A tier answers only the sorts it can genuinely rank and declines the rest,
// so neither tier's gaps drive an ordering. The holdings cells are therefore
// NULLABLE here: a flow-sorted page carries rows the frozen snapshot has
// never seen, and reporting `free_tao: 0` for one would read as "this account
// holds nothing" -- the confident wrong zero #9066/#9273/#9305 keep removing.
// Absent means absent; 0 is reserved for a measured zero.
//
// The staleness alarm for both tiers is
// src/top-holders-staleness-watchdog.ts.

type Row = Record<string, unknown>;

export const TOP_HOLDERS_SORTS = [
  "total_tao",
  "free_tao",
  "delegated_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
];
export const DEFAULT_TOP_HOLDERS_SORT = "total_tao";

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// A finite, non-negative holdings cell, or null when the tier that answered
// has no source for it. Distinguishing the two is the point: an ABSENT cell
// means "this tier cannot see this column" and must not rank or sum, while a
// present 0 is a measured zero and does both. Blank string is absent too --
// Number("") is 0, which is exactly the coercion that would turn a missing
// balance into a confident zero.
function nonNegativeOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Net flow can be genuinely negative (net outflow) -- nonNegativeOrNull's
// >= 0 guard would silently drop a real outflow, which is wrong here.
// Missing flow data must stay null (never coerce to 0) so sort keys can
// distinguish "confirmed zero movers" from "no flow row in the window".
function numberOrNullSigned(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface TopHoldersEntry {
  ss58: string;
  free_tao: number | null;
  delegated_tao: number | null;
  total_tao: number | null;
  net_flow_7d: number | null;
  net_flow_30d: number | null;
  net_flow_90d: number | null;
  last_updated: string | null;
  [key: string]: unknown;
}

function buildTopHoldersEntry(row: Row): TopHoldersEntry {
  const freeTao = nonNegativeOrNull(row?.free_tao);
  const delegatedTao = nonNegativeOrNull(row?.delegated_tao);
  return {
    ss58: row.ss58 as string,
    free_tao: freeTao,
    delegated_tao: delegatedTao,
    // Only a sum of two MEASURED addends is a total. If either side is absent
    // the sum would silently understate the account by the missing side, and
    // "5,448,995 TAO free" vs "0" is not a rounding difference.
    total_tao:
      freeTao === null || delegatedTao === null ? null : freeTao + delegatedTao,
    net_flow_7d: numberOrNullSigned(row?.net_flow_7d),
    net_flow_30d: numberOrNullSigned(row?.net_flow_30d),
    net_flow_90d: numberOrNullSigned(row?.net_flow_90d),
    last_updated: toIso(
      row?.captured_at == null ? null : Number(row.captured_at),
    ),
  };
}

export function compareTopHoldersSort(
  a: TopHoldersEntry,
  b: TopHoldersEntry,
  sortKey: string,
): number {
  const aVal = a[sortKey];
  const bVal = b[sortKey];
  // EVERY sort key is number | null now that a tier answers only the columns
  // it can see. typeof null === "object", so non-numbers sort last -- but a
  // page where the requested key is null on EVERY row degenerates to the
  // ss58 tie-break below, which is a lexicographic list wearing a ranking's
  // label. That is #9469's defect, and the fix is upstream: each tier
  // declines a sort it cannot rank (src/top-holders-flow-tier.ts) rather than
  // letting this comparator paper over it.
  const aNum = typeof aVal === "number";
  const bNum = typeof bVal === "number";
  if (aNum !== bNum) {
    if (aNum) return -1;
    return 1;
  }
  if (!aNum) return a.ss58.localeCompare(b.ss58);
  return (bVal as number) - (aVal as number) || a.ss58.localeCompare(b.ss58);
}

/** Shapes raw (ss58, captured_at, plus whatever columns the answering tier
 * has) rows into a paginated, sortable leaderboard: `free_tao`/
 * `delegated_tao` from the frozen holdings artifact, `net_flow_*` from the
 * live flow lane. A column the tier does not carry is absent from the row and
 * comes out null, never zero. Null-safe: no rows (cold store) yields a
 * schema-stable empty leaderboard. */
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
