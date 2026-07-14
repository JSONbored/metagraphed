/**
 * Ranking helpers for the Accounts index "Most active accounts" widget (#5315).
 *
 * Previously the page rendered both a `BarMini` chart and an identical pill
 * list of the same signers / tx counts. Keep a single navigable list so the
 * ranking is shown once with account + tx count clearly linked.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/5315
 */

/** How many top accounts the activity ranking shows. */
export const TOP_ACTIVE_ACCOUNTS_LIMIT = 12;

/** Window the `/api/v1/chain/signers` ranking covers (matches the query default). */
export const TOP_ACTIVE_ACCOUNTS_WINDOW_DAYS = 7;

export type TopActiveAccountInput = {
  signer: string;
  tx_count: number;
};

export type TopActiveAccountRow = {
  ss58: string;
  txCount: number;
  /** Share of the top-N cohort's tx total (0–1); useful for optional progress UI. */
  shareOfTop: number;
};

/**
 * Take the top `limit` signers (already ranked by tx_count desc from the API)
 * and attach cohort share so the list can optionally show intensity without a
 * second chart of the same ranking.
 */
export function buildTopActiveAccountRows(
  signers: readonly TopActiveAccountInput[],
  limit: number = TOP_ACTIVE_ACCOUNTS_LIMIT,
): TopActiveAccountRow[] {
  const top = signers.slice(0, Math.max(0, limit));
  const total = top.reduce((sum, s) => sum + Math.max(0, s.tx_count), 0);
  return top.map((s) => ({
    ss58: s.signer,
    txCount: s.tx_count,
    shareOfTop: total > 0 ? s.tx_count / total : 0,
  }));
}

/** Format a 0–1 share as a compact percentage for dense mono UI. */
export function formatTopActiveShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share >= 0.995) return "100%";
  return `${Math.round(share * 100)}%`;
}

/** Layout class tokens for the ranked list shell. */
export const TOP_ACTIVE_ACCOUNTS_LIST_CLASS = "flex flex-col gap-1.5";

export const TOP_ACTIVE_ACCOUNT_LINK_CLASS =
  "group flex w-full items-center justify-between gap-3 rounded border border-border bg-paper/40 px-3 py-2 font-mono text-[11px] text-ink-strong hover:border-ink/30 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 min-h-11";
