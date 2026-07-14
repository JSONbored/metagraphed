import { Link } from "@tanstack/react-router";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  TOP_ACTIVE_ACCOUNTS_LIST_CLASS,
  TOP_ACTIVE_ACCOUNT_LINK_CLASS,
  formatTopActiveShare,
  type TopActiveAccountRow,
} from "./top-active-accounts-ranking";

type TopActiveAccountRowLinkProps = {
  row: TopActiveAccountRow;
};

/**
 * Single ranked account row — account short-hash link + tx count + cohort share.
 * Replaces the duplicated BarMini + pill list pair on `/accounts` (#5315).
 */
export function TopActiveAccountRowLink({ row }: TopActiveAccountRowLinkProps) {
  const label = shortHash(row.ss58) ?? row.ss58;
  return (
    <Link
      to="/accounts/$ss58"
      params={{ ss58: row.ss58 }}
      title={row.ss58}
      className={TOP_ACTIVE_ACCOUNT_LINK_CLASS}
      data-testid="top-active-account-row"
      preload="intent"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-ink-muted">
        {formatNumber(row.txCount)} tx
        <span className="ml-2 text-ink-muted/70">{formatTopActiveShare(row.shareOfTop)}</span>
      </span>
    </Link>
  );
}

type TopActiveAccountsListProps = {
  rows: TopActiveAccountRow[];
};

export function TopActiveAccountsList({ rows }: TopActiveAccountsListProps) {
  return (
    <ul className={TOP_ACTIVE_ACCOUNTS_LIST_CLASS} data-testid="top-active-accounts-list">
      {rows.map((row) => (
        <li key={row.ss58}>
          <TopActiveAccountRowLink row={row} />
        </li>
      ))}
    </ul>
  );
}
